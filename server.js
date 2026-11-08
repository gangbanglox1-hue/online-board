// Collaborative whiteboard server: static files + WebSocket sync + JSON persistence.
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
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const KINDS = new Set(["stroke", "line", "arrow", "rect", "ellipse", "text", "note"]);

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- boards in memory, flushed to disk ---------- */
const boards = new Map(); // id -> { items: Map, clients: Set, dirty, timer }
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
function scheduleSave(id, b) {
  clearTimeout(b.timer);
  b.timer = setTimeout(() => saveNow(id, b), 800);
}
function saveNow(id, b) {
  clearTimeout(b.timer); b.timer = null;
  const file = path.join(DATA_DIR, id + ".json");
  const tmp = file + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify({ items: Object.fromEntries(b.items) }));
    fs.renameSync(tmp, file);
  } catch (e) { console.error("save failed", id, e.message); }
}
function unloadIfIdle(id, b) {
  if (b.clients.size) return;
  if (b.timer) saveNow(id, b);
  boards.delete(id);
}

/* ---------- validation ---------- */
const num = v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e7;
function cleanItem(d) {
  if (!d || typeof d !== "object" || !KINDS.has(d.kind)) return null;
  const out = { kind: d.kind, c: String(d.c || "ink").slice(0, 20), t: num(d.t) ? d.t : Date.now() };
  if (typeof d.by === "string") out.by = d.by.slice(0, 40);
  if (d.kind === "stroke") {
    if (!Array.isArray(d.p) || d.p.length < 2 || d.p.length > 8000 || !d.p.every(num)) return null;
    out.p = d.p; out.w = num(d.w) ? Math.min(Math.max(d.w, 0.5), 80) : 4; if (d.hl) out.hl = true;
  } else if (d.kind === "text" || d.kind === "note") {
    if (!num(d.x) || !num(d.y)) return null;
    out.x = d.x; out.y = d.y; out.text = String(d.text || "").slice(0, 1000);
    if (d.kind === "text") out.s = ["S", "M", "L"].includes(d.s) ? d.s : "M";
  } else {
    if (![d.x1, d.y1, d.x2, d.y2].every(num)) return null;
    Object.assign(out, { x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, w: num(d.w) ? Math.min(Math.max(d.w, 0.5), 80) : 4 });
  }
  return out;
}

/* ---------- HTTP ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Не найдено"); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(buf);
  });
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);
  if (p === "/healthz") { res.writeHead(200); res.end("ok"); return; }
  if (p === "/") {
    const id = crypto.randomBytes(6).toString("base64url");
    res.writeHead(302, { location: "/b/" + id }); res.end(); return;
  }
  if (/^\/b\/[A-Za-z0-9_-]{1,40}\/?$/.test(p)) { sendFile(res, path.join(PUBLIC_DIR, "index.html")); return; }
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
  sendFile(res, file);
});

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_MSG });
const COLORS = ["#d2462f", "#2c63c9", "#2f8a4a", "#b0569e", "#e08a1e", "#1c8a8a", "#7a4cc2", "#c2410c"];

function broadcast(b, msg, except) {
  const s = JSON.stringify(msg);
  for (const c of b.clients) if (c !== except && c.readyState === 1) c.send(s);
}
function peerList(b) { return [...b.clients].map(c => ({ peer: c.peer, name: c.name, color: c.color })); }

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const boardId = url.searchParams.get("board");
  if (!boardId || !ID_RE.test(boardId)) { ws.close(1008, "bad board"); return; }
  const b = getBoard(boardId);
  ws.peer = crypto.randomBytes(5).toString("hex");
  ws.name = String(url.searchParams.get("name") || "Гость").slice(0, 32) || "Гость";
  ws.color = COLORS[b.clients.size % COLORS.length];
  ws.alive = true;
  ws.budget = 200; // simple rate limit: messages per second
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
        const item = cleanItem(m.data); if (!item) return;
        if (!b.items.has(m.id) && b.items.size >= MAX_ITEMS) { ws.send(JSON.stringify({ type: "error", message: "Доска переполнена" })); return; }
        b.items.set(m.id, item); scheduleSave(boardId, b);
        broadcast(b, { type: "set", id: m.id, data: item }, ws);
        break;
      }
      case "del": {
        if (typeof m.id !== "string" || !b.items.delete(m.id)) return;
        scheduleSave(boardId, b);
        broadcast(b, { type: "del", id: m.id }, ws);
        break;
      }
      case "clear": {
        b.items.clear(); scheduleSave(boardId, b);
        broadcast(b, { type: "clear" }, ws);
        break;
      }
      case "cursor": {
        const cur = m.cur && num(m.cur.x) && num(m.cur.y) ? { x: m.cur.x, y: m.cur.y } : null;
        broadcast(b, { type: "cursor", peer: ws.peer, cur }, ws);
        break;
      }
      case "name": {
        ws.name = String(m.name || "Гость").slice(0, 32) || "Гость";
        broadcast(b, { type: "peers", peers: peerList(b) });
        break;
      }
    }
  });
  ws.on("close", () => {
    b.clients.delete(ws);
    broadcast(b, { type: "peers", peers: peerList(b) });
    unloadIfIdle(boardId, b);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    ws.budget = 200;
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
}, 15000).unref();
setInterval(() => { for (const ws of wss.clients) ws.budget = 200; }, 1000).unref();

function shutdown() { for (const [id, b] of boards) if (b.timer) saveNow(id, b); process.exit(0); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);

server.listen(PORT, () => console.log(`Доска запущена: http://localhost:${PORT}`));
