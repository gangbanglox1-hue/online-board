// Self-hosted variant: Node.js server with the same protocol as src/worker.js.
// Static files + WebSocket sync + JSON/file persistence.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_ITEMS = 20000;
const MAX_MSG = 512 * 1024;
const MAX_IMAGE_BYTES = 1_900_000;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const KINDS = new Set(["stroke", "line", "arrow", "rect", "ellipse", "text", "note", "image"]);
const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const COLORS = ["#d2462f", "#2c63c9", "#2f8a4a", "#b0569e", "#e08a1e", "#1c8a8a", "#7a4cc2", "#c2410c"];

fs.mkdirSync(DATA_DIR, { recursive: true });
const randomId = n => crypto.randomBytes(n).toString("base64url");

/* ---------- boards in memory, flushed to disk ---------- */
const boards = new Map();
function getBoard(id) {
  let b = boards.get(id);
  if (b) return b;
  b = { items: new Map(), clients: new Set(), timer: null };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, id + ".json"), "utf8"));
    for (const [k, v] of Object.entries(raw.items || {})) b.items.set(k, v);
  } catch {}
  boards.set(id, b);
  return b;
}
function scheduleSave(id, b) { clearTimeout(b.timer); b.timer = setTimeout(() => saveNow(id, b), 800); }
function saveNow(id, b) {
  clearTimeout(b.timer); b.timer = null;
  const file = path.join(DATA_DIR, id + ".json");
  try { fs.writeFileSync(file + ".tmp", JSON.stringify({ items: Object.fromEntries(b.items) })); fs.renameSync(file + ".tmp", file); }
  catch (e) { console.error("save failed", id, e.message); }
}
function unloadIfIdle(id, b) { if (b.clients.size) return; if (b.timer) saveNow(id, b); boards.delete(id); }

/* ---------- validation ---------- */
const num = v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e7;
function cleanItem(d, board) {
  if (!d || typeof d !== "object" || !KINDS.has(d.kind)) return null;
  const out = { kind: d.kind, c: String(d.c || "ink").slice(0, 20), t: num(d.t) ? d.t : Date.now() };
  if (d.kind === "stroke") {
    if (!Array.isArray(d.p) || d.p.length < 2 || d.p.length > 14000 || !d.p.every(num)) return null;
    out.p = d.p; out.w = num(d.w) ? Math.min(Math.max(d.w, 0.5), 80) : 4; if (d.hl) out.hl = true;
  } else if (d.kind === "text" || d.kind === "note") {
    if (!num(d.x) || !num(d.y)) return null;
    out.x = d.x; out.y = d.y; out.text = String(d.text || "").slice(0, 1000);
    if (d.kind === "text") out.s = ["S", "M", "L"].includes(d.s) ? d.s : "M";
    if (d.kind === "text" && num(d.fs)) out.fs = Math.min(Math.max(Math.round(d.fs), 8), 200);
  } else if (d.kind === "image") {
    if (![d.x, d.y, d.w, d.h].every(num) || d.w <= 0 || d.h <= 0) return null;
    const m = /^\/img\/([A-Za-z0-9_-]{1,40})\/([A-Za-z0-9_-]{1,40})$/.exec(String(d.src || ""));
    if (!m || m[1] !== board) return null;
    Object.assign(out, { x: d.x, y: d.y, w: d.w, h: d.h, src: d.src }); delete out.c;
  } else {
    if (![d.x1, d.y1, d.x2, d.y2].every(num)) return null;
    Object.assign(out, { x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, w: num(d.w) ? Math.min(Math.max(d.w, 0.5), 80) : 4 });
  }
  return out;
}

/* ---------- HTTP ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
function sendFile(res, file, type, cache) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Не найдено"); return; }
    res.writeHead(200, { "content-type": type || TYPES[path.extname(file)] || "application/octet-stream", "cache-control": cache || "no-cache", "x-content-type-options": "nosniff" });
    res.end(buf);
  });
}
function json(res, status, obj) { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);
  if (p === "/healthz") { res.writeHead(200); res.end("ok"); return; }
  if (p === "/") { res.writeHead(302, { location: "/b/" + randomId(6) }); res.end(); return; }
  if (/^\/b\/[A-Za-z0-9_-]{1,40}\/?$/.test(p)) { sendFile(res, path.join(PUBLIC_DIR, "index.html")); return; }
  const img = /^\/img\/([A-Za-z0-9_-]{1,40})(?:\/([A-Za-z0-9_-]{1,40}))?$/.exec(p);
  if (img) {
    const dir = path.join(DATA_DIR, "img", img[1]);
    if (req.method === "GET" && img[2]) {
      const ext = Object.values(IMAGE_TYPES).find(e => fs.existsSync(path.join(dir, img[2] + "." + e)));
      if (!ext) { res.writeHead(404); res.end(); return; }
      const type = Object.keys(IMAGE_TYPES).find(k => IMAGE_TYPES[k] === ext);
      sendFile(res, path.join(dir, img[2] + "." + ext), type, "public, max-age=31536000, immutable"); return;
    }
    if (req.method === "POST" && !img[2]) {
      const type = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (!IMAGE_TYPES[type]) { json(res, 415, { error: "bad_type" }); return; }
      const chunks = []; let size = 0, aborted = false;
      req.on("data", c => { size += c.length; if (size > MAX_IMAGE_BYTES) { aborted = true; json(res, 413, { error: "too_large" }); req.destroy(); } else chunks.push(c); });
      req.on("end", () => {
        if (aborted) return;
        if (!size) { json(res, 400, { error: "empty" }); return; }
        const id = randomId(9);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFile(path.join(dir, id + "." + IMAGE_TYPES[type]), Buffer.concat(chunks), err => {
          if (err) json(res, 500, { error: "write_failed" }); else json(res, 200, { src: `/img/${img[1]}/${id}` });
        });
      });
      return;
    }
    res.writeHead(405); res.end(); return;
  }
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
  sendFile(res, file);
});

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_MSG });
function broadcast(b, msg, except) {
  const s = JSON.stringify(msg);
  for (const c of b.clients) if (c !== except && c.readyState === 1) c.send(s);
}
const peerList = b => [...b.clients].map(c => ({ peer: c.peer, name: c.name, color: c.color }));

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const boardId = url.searchParams.get("board");
  if (!boardId || !ID_RE.test(boardId)) { ws.close(1008, "bad board"); return; }
  const b = getBoard(boardId);
  const used = new Set([...b.clients].map(c => c.color));
  ws.peer = randomId(5);
  ws.name = String(url.searchParams.get("name") || "Гость").slice(0, 32) || "Гость";
  ws.color = COLORS.find(c => !used.has(c)) || COLORS[b.clients.size % COLORS.length];
  ws.alive = true; ws.budget = 240;
  b.clients.add(ws);
  ws.send(JSON.stringify({ type: "init", items: Object.fromEntries(b.items), you: ws.peer, color: ws.color, peers: peerList(b) }));
  broadcast(b, { type: "peers", peers: peerList(b) });

  ws.on("pong", () => { ws.alive = true; });
  ws.on("message", raw => {
    if (--ws.budget < 0) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object") return;
    switch (m.type) {
      case "set": {
        if (typeof m.id !== "string" || !ID_RE.test(m.id)) return;
        const item = cleanItem(m.data, boardId); if (!item) return;
        if (!b.items.has(m.id) && b.items.size >= MAX_ITEMS) { ws.send(JSON.stringify({ type: "error", message: "Доска переполнена" })); return; }
        b.items.set(m.id, item); scheduleSave(boardId, b);
        broadcast(b, { type: "set", id: m.id, data: item }, ws);
        break;
      }
      case "del":
        if (typeof m.id !== "string" || !b.items.delete(m.id)) return;
        scheduleSave(boardId, b); broadcast(b, { type: "del", id: m.id }, ws);
        break;
      case "clear":
        b.items.clear(); scheduleSave(boardId, b);
        fs.rm(path.join(DATA_DIR, "img", boardId), { recursive: true, force: true }, () => {});
        broadcast(b, { type: "clear" }, ws);
        break;
      case "draft": {
        if (typeof m.id !== "string" || !ID_RE.test(m.id)) return;
        if (m.end) { broadcast(b, { type: "draft", id: m.id, end: true }, ws); return; }
        const s = m.d && typeof m.d === "object" ? m.d : null;
        if (!s || !["stroke", "line", "arrow", "rect", "ellipse"].includes(s.kind)) return;
        const d = { kind: s.kind, c: String(s.c || "ink").slice(0, 20), w: num(s.w) ? Math.min(Math.max(s.w, 0.5), 80) : 4 };
        if (s.hl) d.hl = true;
        if (s.kind !== "stroke") { if (![s.x1, s.y1, s.x2, s.y2].every(num)) return; Object.assign(d, { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 }); }
        const p = Array.isArray(m.p) ? m.p.filter(num).slice(0, 14000) : undefined;
        broadcast(b, { type: "draft", id: m.id, d, from: Number.isInteger(m.from) ? m.from : 0, p }, ws);
        break;
      }
      case "cursor": {
        const cur = m.cur && num(m.cur.x) && num(m.cur.y) ? { x: m.cur.x, y: m.cur.y } : null;
        broadcast(b, { type: "cursor", peer: ws.peer, cur }, ws);
        break;
      }
      case "name":
        ws.name = String(m.name || "Гость").slice(0, 32) || "Гость";
        broadcast(b, { type: "peers", peers: peerList(b) });
        break;
    }
  });
  ws.on("close", () => { b.clients.delete(ws); broadcast(b, { type: "peers", peers: peerList(b) }); unloadIfIdle(boardId, b); });
});

setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
}, 15000).unref();
setInterval(() => { for (const ws of wss.clients) ws.budget = 240; }, 1000).unref();

function shutdown() { for (const [id, b] of boards) if (b.timer) saveNow(id, b); process.exit(0); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
server.listen(PORT, () => console.log(`Доска запущена: http://localhost:${PORT}`));
