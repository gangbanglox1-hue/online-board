// Cloudflare Worker + Durable Object: one Durable Object per board keeps its items and pictures
// in SQLite and relays live changes over WebSockets.
import { DurableObject } from "cloudflare:workers";

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const KINDS = new Set(["stroke", "line", "arrow", "rect", "ellipse", "text", "note", "image"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_ITEMS = 20000;
const MAX_IMAGE_BYTES = 1_900_000;        // one SQLite row holds up to 2 MB
const MAX_BOARD_IMAGE_BYTES = 200_000_000;
const COLORS = ["#d2462f", "#2c63c9", "#2f8a4a", "#b0569e", "#e08a1e", "#1c8a8a", "#7a4cc2", "#c2410c"];

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
  } else if (d.kind === "image") {
    if (![d.x, d.y, d.w, d.h].every(num) || d.w <= 0 || d.h <= 0) return null;
    const m = /^\/img\/([A-Za-z0-9_-]{1,40})\/([A-Za-z0-9_-]{1,40})$/.exec(String(d.src || ""));
    if (!m || m[1] !== board) return null;
    Object.assign(out, { x: d.x, y: d.y, w: d.w, h: d.h, src: d.src });
    delete out.c;
  } else {
    if (![d.x1, d.y1, d.x2, d.y2].every(num)) return null;
    Object.assign(out, { x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, w: num(d.w) ? Math.min(Math.max(d.w, 0.5), 80) : 4 });
  }
  return out;
}
function randomId(bytes) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p === "/healthz") return new Response("ok");
    if (p === "/") return Response.redirect(url.origin + "/b/" + randomId(6), 302);
    if (p === "/ws") {
      const board = url.searchParams.get("board");
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      if (!board || !ID_RE.test(board)) return new Response("Bad board id", { status: 400 });
      return env.BOARD.get(env.BOARD.idFromName(board)).fetch(request);
    }
    const img = /^\/img\/([A-Za-z0-9_-]{1,40})(?:\/([A-Za-z0-9_-]{1,40}))?$/.exec(p);
    if (img) {
      const board = img[1];
      if (request.method === "POST" && !img[2]) {
        const len = Number(request.headers.get("content-length") || 0);
        if (len > MAX_IMAGE_BYTES) return json({ error: "too_large" }, 413);
      } else if (!(request.method === "GET" && img[2])) return new Response("Not allowed", { status: 405 });
      return env.BOARD.get(env.BOARD.idFromName(board)).fetch(request);
    }
    if (/^\/b\/[A-Za-z0-9_-]{1,40}\/?$/.test(p)) {
      const res = await env.ASSETS.fetch(new Request(url.origin + "/index.html"));
      return new Response(res.body, { status: res.status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }
    if (p === "/index.html") return Response.redirect(url.origin + "/", 302);
    return env.ASSETS.fetch(request);
  },
};

export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL)");
    this.budget = new Map();
  }

  peers(except) {
    return this.ctx.getWebSockets().filter(w => w !== except).map(w => w.deserializeAttachment()).filter(Boolean)
      .map(({ peer, name, color }) => ({ peer, name, color }));
  }
  broadcast(msg, except) {
    const s = typeof msg === "string" ? msg : JSON.stringify(msg);
    for (const w of this.ctx.getWebSockets()) {
      if (w === except) continue;
      try { w.send(s); } catch {}
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/img/")) return this.image(request, url);

    const board = url.searchParams.get("board");
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const used = new Set(this.peers().map(p => p.color));
    const meta = {
      peer: randomId(5),
      name: (String(url.searchParams.get("name") || "Гость").slice(0, 32)) || "Гость",
      color: COLORS.find(c => !used.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)],
      board,
    };
    server.serializeAttachment(meta);
    const items = {};
    for (const row of this.sql.exec("SELECT id, data FROM items")) items[row.id] = JSON.parse(row.data);
    server.send(JSON.stringify({ type: "init", items, you: meta.peer, color: meta.color, peers: this.peers() }));
    this.broadcast({ type: "peers", peers: this.peers() }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async image(request, url) {
    const [, , board, id] = url.pathname.split("/");
    if (request.method === "GET") {
      const row = this.sql.exec("SELECT type, data FROM images WHERE id = ?", id).toArray()[0];
      if (!row) return new Response("Not found", { status: 404 });
      return new Response(row.data, { headers: {
        "content-type": row.type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff",
      } });
    }
    const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) return json({ error: "bad_type" }, 415);
    const buf = await request.arrayBuffer();
    if (!buf.byteLength) return json({ error: "empty" }, 400);
    if (buf.byteLength > MAX_IMAGE_BYTES) return json({ error: "too_large" }, 413);
    const total = this.sql.exec("SELECT COALESCE(SUM(size), 0) AS n FROM images").one().n;
    if (total + buf.byteLength > MAX_BOARD_IMAGE_BYTES) return json({ error: "board_full" }, 507);
    const newId = randomId(9);
    this.sql.exec("INSERT INTO images (id, type, size, data) VALUES (?, ?, ?, ?)", newId, type, buf.byteLength, buf);
    return json({ src: `/img/${board}/${newId}` });
  }

  allow(ws) {
    const now = Date.now();
    let b = this.budget.get(ws);
    if (!b || now - b.t > 1000) { b = { t: now, n: 0 }; this.budget.set(ws, b); }
    return ++b.n <= 240;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 512 * 1024 || !this.allow(ws)) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object") return;
    const meta = ws.deserializeAttachment() || {};
    switch (m.type) {
      case "set": {
        if (typeof m.id !== "string" || !ID_RE.test(m.id)) return;
        const item = cleanItem(m.data, meta.board); if (!item) return;
        const exists = this.sql.exec("SELECT 1 FROM items WHERE id = ?", m.id).toArray().length > 0;
        if (!exists && this.sql.exec("SELECT COUNT(*) AS n FROM items").one().n >= MAX_ITEMS) {
          ws.send(JSON.stringify({ type: "error", message: "Доска переполнена" })); return;
        }
        this.sql.exec("INSERT OR REPLACE INTO items (id, data) VALUES (?, ?)", m.id, JSON.stringify(item));
        this.broadcast({ type: "set", id: m.id, data: item }, ws);
        break;
      }
      case "del": {
        if (typeof m.id !== "string") return;
        this.sql.exec("DELETE FROM items WHERE id = ?", m.id);
        this.broadcast({ type: "del", id: m.id }, ws);
        break;
      }
      case "clear": {
        this.sql.exec("DELETE FROM items");
        this.sql.exec("DELETE FROM images");
        this.broadcast({ type: "clear" }, ws);
        break;
      }
      case "draft": {
        if (typeof m.id !== "string" || !ID_RE.test(m.id)) return;
        if (m.end) { this.broadcast({ type: "draft", id: m.id, end: true }, ws); return; }
        const src = m.d && typeof m.d === "object" ? m.d : null;
        if (!src || !KINDS.has(src.kind) || src.kind === "image" || src.kind === "note" || src.kind === "text") return;
        const d = { kind: src.kind, c: String(src.c || "ink").slice(0, 20), w: num(src.w) ? Math.min(Math.max(src.w, 0.5), 80) : 4 };
        if (src.hl) d.hl = true;
        if (src.kind !== "stroke") { if (![src.x1, src.y1, src.x2, src.y2].every(num)) return; Object.assign(d, { x1: src.x1, y1: src.y1, x2: src.x2, y2: src.y2 }); }
        const p = Array.isArray(m.p) ? m.p.filter(num).slice(0, 14000) : undefined;
        this.broadcast({ type: "draft", id: m.id, d, from: Number.isInteger(m.from) ? m.from : 0, p }, ws);
        break;
      }
      case "cursor": {
        const cur = m.cur && num(m.cur.x) && num(m.cur.y) ? { x: m.cur.x, y: m.cur.y } : null;
        this.broadcast({ type: "cursor", peer: meta.peer, cur }, ws);
        break;
      }
      case "name": {
        meta.name = String(m.name || "Гость").slice(0, 32) || "Гость";
        ws.serializeAttachment(meta);
        this.broadcast({ type: "peers", peers: this.peers() });
        break;
      }
    }
  }

  async webSocketClose(ws, code) {
    this.budget.delete(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch {}
    this.broadcast({ type: "peers", peers: this.peers(ws) }, ws);
  }
  async webSocketError(ws) {
    this.budget.delete(ws);
    this.broadcast({ type: "peers", peers: this.peers(ws) }, ws);
  }
}
