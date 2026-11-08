// Cloudflare Worker + Durable Object version of the board server.
// Same WebSocket protocol as server.js, so public/index.html works with both.
import { DurableObject } from "cloudflare:workers";

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const KINDS = new Set(["stroke", "line", "arrow", "rect", "ellipse", "text", "note"]);
const MAX_ITEMS = 20000;
const COLORS = ["#d2462f", "#2c63c9", "#2f8a4a", "#b0569e", "#e08a1e", "#1c8a8a", "#7a4cc2", "#c2410c"];

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
function randomId(bytes) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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
      const stub = env.BOARD.get(env.BOARD.idFromName(board));
      return stub.fetch(request);
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
    this.budget = new Map();
  }

  peers(except) {
    return this.ctx.getWebSockets().filter(w => w !== except).map(w => w.deserializeAttachment()).filter(Boolean)
      .map(({ peer, name, color }) => ({ peer, name, color }));
  }
  broadcast(msg, except, skipClosing) {
    const s = JSON.stringify(msg);
    for (const w of this.ctx.getWebSockets()) {
      if (w === except || w === skipClosing) continue;
      try { w.send(s); } catch {}
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const count = this.ctx.getWebSockets().length;
    const meta = {
      peer: randomId(5),
      name: (String(url.searchParams.get("name") || "Гость").slice(0, 32)) || "Гость",
      color: COLORS[(count - 1) % COLORS.length],
    };
    server.serializeAttachment(meta);
    const items = {};
    for (const row of this.sql.exec("SELECT id, data FROM items")) items[row.id] = JSON.parse(row.data);
    server.send(JSON.stringify({ type: "init", items, you: meta.peer, color: meta.color, peers: this.peers() }));
    this.broadcast({ type: "peers", peers: this.peers() }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  allow(ws) {
    const now = Date.now();
    let b = this.budget.get(ws);
    if (!b || now - b.t > 1000) { b = { t: now, n: 0 }; this.budget.set(ws, b); }
    return ++b.n <= 200;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 512 * 1024 || !this.allow(ws)) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object") return;
    const meta = ws.deserializeAttachment() || {};
    switch (m.type) {
      case "set": {
        if (typeof m.id !== "string" || !ID_RE.test(m.id)) return;
        const item = cleanItem(m.data); if (!item) return;
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
        this.broadcast({ type: "clear" }, ws);
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
