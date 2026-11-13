// Cloudflare Worker for the whiteboard.
// - Board: one Durable Object per board. Keeps items, pictures, roles and bans in SQLite and relays
//   live changes over WebSockets. Every write is checked against the sender's role here.
// - Registry: a single Durable Object with the owner's password, login sessions, the list of boards
//   and site settings.
import { DurableObject } from "cloudflare:workers";
import INDEX_HTML from "../public/index.html";
import ADMIN_HTML from "../public/admin.html";
import HOME_HTML from "../public/home.html";
import THEME_JS from "../public/theme.js";
import FAVICON_SVG from "../public/favicon.svg";

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const CLIENT_RE = /^[A-Za-z0-9_-]{16,64}$/;
const KINDS = new Set(["stroke", "line", "arrow", "rect", "ellipse", "text", "note", "image"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_ITEMS = 20000;
const MAX_IMAGE_BYTES = 1_900_000;        // one SQLite row holds up to 2 MB
const MAX_BOARD_IMAGE_BYTES = 200_000_000;
const SESSION_DAYS = 30;
const COLORS = ["#d2462f", "#2c63c9", "#2f8a4a", "#b0569e", "#e08a1e", "#1c8a8a", "#7a4cc2", "#c2410c"];
const ROLES = new Set(["editor", "viewer"]);

/* ---------- helpers ---------- */
const enc = new TextEncoder();
const num = v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e7;
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomId = bytes => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256 = async s => b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return b64url(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 100000 }, key, 256));
}
function safeEqual(a, b) {
  a = String(a); b = String(b);
  let r = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return r === 0;
}
const cleanName = (v, fallback) => (String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60)) || fallback;
const SEC_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "same-origin", "x-frame-options": "DENY" };
const html = body => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...SEC_HEADERS } });
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
function getCookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}
const sessionCookie = (sid, maxAge) => `sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

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
    Object.assign(out, { x: d.x, y: d.y, w: d.w, h: d.h, src: d.src });
    delete out.c;
  } else {
    if (![d.x1, d.y1, d.x2, d.y2].every(num)) return null;
    Object.assign(out, { x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, w: num(d.w) ? Math.min(Math.max(d.w, 0.5), 80) : 4 });
  }
  return out;
}

/* ---------- worker: routing and owner API ---------- */
const registry = env => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
const boardStub = (env, id) => env.BOARD.get(env.BOARD.idFromName(id));
async function call(stub, path, body) {
  const r = await stub.fetch("https://internal" + path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  if (r.status >= 500) throw new Error("storage unavailable: " + path);
  return r.json();
}
async function isAdmin(env, req) {
  const sid = getCookie(req, "sid");
  if (!sid || !/^[A-Za-z0-9_-]{20,64}$/.test(sid)) return false;
  return !!(await call(registry(env), "/session", { sid })).admin;
}
const ipHash = (env, req) => sha256((req.headers.get("cf-connecting-ip") || "") + "|" + (env.SETUP_TOKEN || "board"));
// Forward a browser request to a board with trusted headers that the browser cannot set itself.
async function toBoard(env, req, board, admin) {
  const h = new Headers(req.headers);
  for (const k of ["x-admin", "x-ip"]) h.delete(k);
  h.set("x-admin", admin ? "1" : "0");
  h.set("x-ip", await ipHash(env, req));
  return boardStub(env, board).fetch(new Request(req, { headers: h }));
}

const UNAVAILABLE_HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Доска временно недоступна</title><meta http-equiv="refresh" content="60">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f4;color:#1d2420;font:16px/1.55 system-ui,sans-serif;padding:16px}
@media (prefers-color-scheme:dark){body{background:#171b19;color:#e7ebe6}}main{max-width:420px;text-align:center}h1{font-size:24px;margin:0 0 8px}p{margin:0;opacity:.75}</style></head>
<body><main><h1>Доска временно недоступна</h1><p>Сервер перегружен или достиг дневного лимита. Страница обновится сама через минуту.</p></main></body></html>`;

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      console.error("request failed", new URL(request.url).pathname, e && e.message);
      const p = new URL(request.url).pathname;
      if (p.startsWith("/api/") || p.startsWith("/img/")) return json({ error: "unavailable" }, 503, { "retry-after": "60" });
      if (p === "/ws" && request.headers.get("Upgrade") === "websocket") {
        // tell the page why, so it waits calmly instead of retrying every few seconds
        const { 0: client, 1: server } = new WebSocketPair();
        server.accept();
        server.send(JSON.stringify({ type: "kicked", reason: "unavailable" }));
        server.close(4503, "unavailable");
        return new Response(null, { status: 101, webSocket: client });
      }
      return new Response(UNAVAILABLE_HTML, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "retry-after": "60", "cache-control": "no-store" } });
    }
  },
};

async function route(request, env) {
  {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;
    const sameOrigin = (request.headers.get("origin") || url.origin) === url.origin;

    if (p === "/healthz") return new Response("ok");
    if (p === "/favicon.svg") return new Response(FAVICON_SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
    if (p === "/theme.js") return new Response(THEME_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
    if (p === "/admin" || p === "/admin/") return html(ADMIN_HTML);
    if (/^\/b\/[A-Za-z0-9_-]{1,40}\/?$/.test(p)) return html(INDEX_HTML);

    if (p === "/") {
      if (await isAdmin(env, request)) return Response.redirect(url.origin + "/admin", 302);
      const st = await call(registry(env), "/state");
      if (st.createPolicy === "all") return Response.redirect(url.origin + "/b/" + randomId(6), 302);
      return html(HOME_HTML);
    }

    if (p === "/ws") {
      const board = url.searchParams.get("board");
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      if (!board || !ID_RE.test(board)) return new Response("Bad board id", { status: 400 });
      // the owner's cookie only counts when the page itself is on this site
      const admin = sameOrigin && request.headers.get("origin") ? await isAdmin(env, request) : false;
      return toBoard(env, request, board, admin);
    }

    const img = /^\/img\/([A-Za-z0-9_-]{1,40})(?:\/([A-Za-z0-9_-]{1,40}))?$/.exec(p);
    if (img) {
      if (method === "GET" && img[2]) return boardStub(env, img[1]).fetch(request);
      if (method === "POST" && !img[2]) {
        if (!sameOrigin) return json({ error: "forbidden" }, 403);
        if (Number(request.headers.get("content-length") || 0) > MAX_IMAGE_BYTES) return json({ error: "too_large" }, 413);
        return toBoard(env, request, img[1], await isAdmin(env, request));
      }
      return new Response("Not allowed", { status: 405 });
    }

    if (p === "/api/export" || p === "/api/export-board" || p === "/api/import") {
      const key = request.headers.get("x-migrate-key") || "";
      if (!env.SETUP_TOKEN || !safeEqual(key, env.SETUP_TOKEN)) return json({ error: "forbidden" }, 403);
      if (p === "/api/export") return json(await call(registry(env), "/export", {}));
      if (p === "/api/export-board") {
        const id = url.searchParams.get("id") || "";
        if (!ID_RE.test(id)) return json({ error: "bad_id" }, 400);
        return json(await call(boardStub(env, id), "/internal/export", {}));
      }
      if (method !== "POST") return json({ error: "method" }, 405);
      const data = await request.json();
      if (data.registry) await call(registry(env), "/import", data.registry);
      let n = 0;
      for (const b of data.boards || []) { if (ID_RE.test(b.id || "")) { await call(boardStub(env, b.id), "/internal/import", b); n++; } }
      return json({ ok: true, boards: n });
    }

    if (p.startsWith("/api/")) {
      if (method !== "GET" && !sameOrigin) return json({ error: "forbidden" }, 403);
      let body = {};
      if (method !== "GET" && method !== "DELETE") { try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); } }
      const R = registry(env);

      if (p === "/api/state" && method === "GET") {
        const st = await call(R, "/state");
        return json({ adminSet: st.adminSet, createPolicy: st.createPolicy, isAdmin: await isAdmin(env, request) });
      }
      if (p === "/api/setup" && method === "POST") {
        const r = await call(R, "/setup", { token: String(body.token || ""), password: String(body.password || "") });
        if (!r.sid) return json(r, 400);
        return json({ ok: true }, 200, { "set-cookie": sessionCookie(r.sid, SESSION_DAYS * 86400) });
      }
      if (p === "/api/login" && method === "POST") {
        const r = await call(R, "/login", { password: String(body.password || ""), ip: await ipHash(env, request) });
        if (!r.sid) return json(r, r.error === "locked" ? 429 : 401);
        return json({ ok: true }, 200, { "set-cookie": sessionCookie(r.sid, SESSION_DAYS * 86400) });
      }
      if (p === "/api/logout" && method === "POST") {
        const sid = getCookie(request, "sid");
        if (sid) await call(R, "/logout", { sid });
        return json({ ok: true }, 200, { "set-cookie": sessionCookie("x", 0) });
      }

      // everything below is for the owner only
      if (!(await isAdmin(env, request))) return json({ error: "unauthorized" }, 401);

      if (p === "/api/password" && method === "POST") {
        const r = await call(R, "/password", { old: String(body.old || ""), password: String(body.password || "") });
        return json(r, r.ok ? 200 : 400);
      }
      if (p === "/api/settings" && method === "POST") {
        return json(await call(R, "/settings", { createPolicy: body.createPolicy === "all" ? "all" : "admin" }));
      }
      if (p === "/api/boards" && method === "GET") {
        const { boards } = await call(R, "/boards/list");
        const withStats = await Promise.all(boards.slice(0, 300).map(async b => {
          try { return { ...b, ...(await call(boardStub(env, b.id), "/internal/stats")) }; } catch { return b; }
        }));
        return json({ boards: withStats.filter(b => !b.deleted) });
      }
      if (p === "/api/boards" && method === "POST") {
        const id = randomId(6), name = cleanName(body.name, "Новая доска");
        await call(boardStub(env, id), "/internal/init", { id, name });
        return json({ id, name });
      }
      const bm = /^\/api\/boards\/([A-Za-z0-9_-]{1,40})$/.exec(p);
      if (bm && method === "PATCH") {
        const patch = {};
        if (body.name !== undefined) patch.name = cleanName(body.name, "Доска");
        if (body.access !== undefined) patch.access = body.access === "view" ? "view" : "edit";
        return json(await call(boardStub(env, bm[1]), "/internal/settings", patch));
      }
      if (bm && method === "DELETE") {
        await call(boardStub(env, bm[1]), "/internal/wipe", {});
        await call(R, "/boards/remove", { id: bm[1] });
        return json({ ok: true });
      }
      return json({ error: "not_found" }, 404);
    }

    return new Response("Не найдено", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

/* ---------- Registry: owner, sessions, board list, settings ---------- */
export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    if (env.SIMULATE_OUTAGE === "1") throw new Error("Exceeded allowed rows read in Durable Objects free tier. (simulated)");
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS fails (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL);`);
  }
  get(k) {
    if (!this.kvCache) this.kvCache = new Map();
    if (this.kvCache.has(k)) return this.kvCache.get(k);
    const r = this.sql.exec("SELECT value FROM kv WHERE key = ?", k).toArray()[0];
    const v = r ? JSON.parse(r.value) : null;
    this.kvCache.set(k, v);
    return v;
  }
  put(k, v) { this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", k, JSON.stringify(v)); if (this.kvCache) this.kvCache.set(k, v); }
  async newSession() {
    const sid = randomId(24);
    this.sql.exec("DELETE FROM sessions WHERE expires < ?", Date.now());
    this.sql.exec("INSERT INTO sessions (id, expires) VALUES (?, ?)", await sha256(sid), Date.now() + SESSION_DAYS * 86400e3);
    return sid;
  }
  async fetch(request) {
    try { return await this.handle(request); }
    catch (e) { console.error("registry failed", e && e.message); return json({ error: "unavailable" }, 503); }
  }
  async handle(request) {
    const p = new URL(request.url).pathname;
    const b = request.method === "POST" ? await request.json() : {};
    switch (p) {
      case "/state": return json({ adminSet: !!this.get("pwd"), createPolicy: this.get("createPolicy") || "admin" });
      case "/setup": {
        if (this.get("pwd")) return json({ error: "already_set" });
        if (!this.env.SETUP_TOKEN || !safeEqual(b.token, this.env.SETUP_TOKEN)) return json({ error: "bad_token" });
        if (String(b.password).length < 8) return json({ error: "short_password" });
        const salt = randomId(16);
        this.put("pwd", { salt, hash: await pbkdf2(b.password, salt) });
        return json({ sid: await this.newSession() });
      }
      case "/login": {
        const pwd = this.get("pwd");
        if (!pwd) return json({ error: "not_set" });
        const now = Date.now();
        const f = this.sql.exec("SELECT n, until FROM fails WHERE ip = ?", b.ip).toArray()[0];
        if (f && f.until > now) return json({ error: "locked", retryIn: Math.ceil((f.until - now) / 60000) });
        if (!safeEqual(await pbkdf2(String(b.password), pwd.salt), pwd.hash)) {
          const n = (f ? f.n : 0) + 1;
          this.sql.exec("INSERT OR REPLACE INTO fails (ip, n, until) VALUES (?, ?, ?)", b.ip, n >= 5 ? 0 : n, n >= 5 ? now + 10 * 60e3 : 0);
          return json({ error: "wrong_password" });
        }
        this.sql.exec("DELETE FROM fails WHERE ip = ?", b.ip);
        return json({ sid: await this.newSession() });
      }
      case "/session": {
        const r = this.sql.exec("SELECT expires FROM sessions WHERE id = ?", await sha256(String(b.sid))).toArray()[0];
        return json({ admin: !!r && r.expires > Date.now() });
      }
      case "/logout": this.sql.exec("DELETE FROM sessions WHERE id = ?", await sha256(String(b.sid))); return json({ ok: true });
      case "/password": {
        const pwd = this.get("pwd");
        if (!pwd || !safeEqual(await pbkdf2(String(b.old), pwd.salt), pwd.hash)) return json({ error: "wrong_password" });
        if (String(b.password).length < 8) return json({ error: "short_password" });
        const salt = randomId(16);
        this.put("pwd", { salt, hash: await pbkdf2(b.password, salt) });
        return json({ ok: true });
      }
      case "/settings": this.put("createPolicy", b.createPolicy === "all" ? "all" : "admin"); return json({ ok: true, createPolicy: this.get("createPolicy") });
      case "/boards/list": return json({ boards: this.sql.exec("SELECT id, name, created FROM boards ORDER BY created DESC").toArray() });
      case "/boards/add": this.sql.exec("INSERT OR IGNORE INTO boards (id, name, created) VALUES (?, ?, ?)", b.id, cleanName(b.name, "Доска"), Date.now()); return json({ ok: true });
      case "/boards/rename": this.sql.exec("UPDATE boards SET name = ? WHERE id = ?", cleanName(b.name, "Доска"), b.id); return json({ ok: true });
      case "/boards/remove": this.sql.exec("DELETE FROM boards WHERE id = ?", b.id); return json({ ok: true });
      case "/export": return json({ pwd: this.get("pwd"), createPolicy: this.get("createPolicy"), boards: this.sql.exec("SELECT id, name, created FROM boards").toArray() });
      case "/import": {
        if (b.pwd && b.pwd.salt && b.pwd.hash) this.put("pwd", b.pwd);
        if (b.createPolicy) this.put("createPolicy", b.createPolicy === "all" ? "all" : "admin");
        for (const x of b.boards || []) this.sql.exec("INSERT OR REPLACE INTO boards (id, name, created) VALUES (?, ?, ?)", x.id, cleanName(x.name, "Доска"), Number(x.created) || Date.now());
        return json({ ok: true });
      }
    }
    return json({ error: "not_found" }, 404);
  }
}

/* ---------- Board ---------- */
const isManager = role => role === "admin" || role === "owner";
export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    if (env.SIMULATE_OUTAGE === "1") throw new Error("Exceeded allowed rows read in Durable Objects free tier. (simulated)");
    this.sql = ctx.storage.sql;
    if (env.DEBUG_ROWS === "1") {
      const exec = this.sql.exec.bind(this.sql); this.rowsRead = 0;
      this.sql = { exec: (...a) => { const c = exec(...a); const arr = c.toArray(); this.rowsRead += c.rowsRead; return Object.assign(arr, { toArray: () => arr, one: () => arr[0] }); } };
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS roles (client TEXT PRIMARY KEY, role TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bans (id TEXT PRIMARY KEY, client TEXT NOT NULL, ip TEXT NOT NULL, name TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS bans_client ON bans (client);`);
    this.meta = {};
    for (const r of this.sql.exec("SELECT key, value FROM meta")) this.meta[r.key] = JSON.parse(r.value);
    this.budget = new Map();
    this.warned = new Map();
    this.cache = null;   // id -> item JSON, loaded once while people are on the board
    // Counts are kept as numbers. Counting rows on every change read the whole board each time
    // and used up the daily read limit of the free plan.
    if (typeof this.meta.count !== "number") this.setMeta("count", this.sql.exec("SELECT COUNT(*) AS n FROM items").one().n);
    if (typeof this.meta.imgBytes !== "number") this.setMeta("imgBytes", this.sql.exec("SELECT COALESCE(SUM(size), 0) AS n FROM images").one().n);
  }
  loadCache() {
    if (!this.cache) {
      this.cache = new Map();
      for (const row of this.sql.exec("SELECT id, data FROM items")) this.cache.set(row.id, row.data);
      if (this.cache.size !== this.meta.count) this.setMeta("count", this.cache.size);
    }
    return this.cache;
  }
  itemsJson() {
    let out = "{", first = true;
    for (const [id, data] of this.loadCache()) { out += (first ? "" : ",") + JSON.stringify(id) + ":" + data; first = false; }
    return out + "}";
  }

  /* settings and roles */
  setMeta(k, v) { this.meta[k] = v; this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", k, JSON.stringify(v)); }
  hasContent() { return (this.meta.count || 0) > 0; }
  info() { return { name: this.meta.name || "Общая доска", access: this.meta.access || "edit" }; }
  async init(id, name, owner) {
    this.setMeta("id", id); this.setMeta("name", cleanName(name, "Доска")); this.setMeta("access", "edit");
    this.setMeta("owner", owner || null); this.setMeta("created", Date.now()); this.setMeta("deleted", false);
    await call(registry(this.env), "/boards/add", { id, name: this.meta.name });
  }
  roleFor(a) {
    if (a.admin) return "admin";
    if (this.meta.owner && a.client === this.meta.owner) return "owner";
    const r = this.sql.exec("SELECT role FROM roles WHERE client = ?", a.client).toArray()[0];
    if (r) return r.role;
    return (this.meta.access || "edit") === "edit" ? "editor" : "viewer";
  }
  // bans follow the person's browser, not the network: people on one Wi-Fi share an address
  banned(client) { return this.sql.exec("SELECT 1 FROM bans WHERE client = ?", client).toArray().length > 0; }
  banList() { return this.sql.exec("SELECT id, name, at FROM bans ORDER BY at DESC").toArray(); }
  sockets() { return this.ctx.getWebSockets().map(ws => ({ ws, meta: ws.deserializeAttachment() })).filter(s => s.meta); }
  peers(except) {
    return this.sockets().filter(s => s.ws !== except).map(({ meta: m }) => ({ peer: m.peer, name: m.name, color: m.color, role: m.role }));
  }
  broadcast(msg, except) {
    const s = typeof msg === "string" ? msg : JSON.stringify(msg);
    for (const w of this.ctx.getWebSockets()) { if (w === except) continue; try { w.send(s); } catch {} }
  }
  toManagers(msg) {
    const s = JSON.stringify(msg);
    for (const { ws, meta } of this.sockets()) if (isManager(meta.role)) { try { ws.send(s); } catch {} }
  }
  // recompute everyone's role after a settings or role change and tell whoever changed
  refreshRoles() {
    for (const { ws, meta } of this.sockets()) {
      const role = this.roleFor(meta);
      if (role !== meta.role) {
        meta.role = role; ws.serializeAttachment(meta);
        try { ws.send(JSON.stringify({ type: "you", role, bans: isManager(role) ? this.banList() : undefined })); } catch {}
      }
    }
    this.broadcast({ type: "peers", peers: this.peers() });
  }
  applySettings(patch) {
    if (patch.name !== undefined) {
      this.setMeta("name", cleanName(patch.name, "Доска"));
      this.ctx.waitUntil(call(registry(this.env), "/boards/rename", { id: this.meta.id, name: this.meta.name }).catch(() => {}));
    }
    if (patch.access === "edit" || patch.access === "view") this.setMeta("access", patch.access);
    this.broadcast({ type: "board", board: this.info() });
    this.refreshRoles();
    return { ok: true, ...this.info() };
  }
  wipe() {
    this.broadcast({ type: "kicked", reason: "deleted" });
    for (const w of this.ctx.getWebSockets()) { try { w.close(4004, "deleted"); } catch {} }
    for (const t of ["items", "images", "roles", "bans", "meta"]) this.sql.exec(`DELETE FROM ${t}`);
    this.meta = {}; this.cache = null;
    this.setMeta("deleted", true); this.setMeta("count", 0); this.setMeta("imgBytes", 0);
  }
  reject(reason) {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    server.send(JSON.stringify({ type: "kicked", reason }));
    server.close(4003, reason);
    return new Response(null, { status: 101, webSocket: client });
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/internal/")) return await this.internal(request, url.pathname);
      if (url.pathname.startsWith("/img/")) return await this.image(request, url);
      return await this.connect(request, url);
    } catch (e) {
      console.error("board failed", url.pathname, e && e.message);
      if (request.headers.get("Upgrade") === "websocket") return this.reject("unavailable");
      return json({ error: "unavailable" }, 503);
    }
  }

  async internal(request, path) {
    const b = request.method === "POST" ? await request.json() : {};
    if (path === "/internal/stats") {
      return json({ ...this.info(), online: this.ctx.getWebSockets().length, items: this.meta.count || 0, rowsRead: this.rowsRead,
        created: this.meta.created || null, deleted: !!this.meta.deleted, hasOwner: !!this.meta.owner });
    }
    if (path === "/internal/init") { if (!this.meta.created) await this.init(b.id, b.name, null); return json({ ok: true }); }
    if (path === "/internal/settings") return json(this.applySettings(b));
    if (path === "/internal/wipe") { this.wipe(); return json({ ok: true }); }
    if (path === "/internal/export") {
      const items = this.sql.exec("SELECT id, data FROM items").toArray();
      const hasImages = (this.meta.imgBytes || 0) > 0 || items.some(r => r.data.includes('"kind":"image"'));
      return json({ meta: this.meta, hasImages, items: hasImages ? [] : items,
        roles: this.sql.exec("SELECT client, role FROM roles").toArray(), bans: this.sql.exec("SELECT id, client, ip, name, at FROM bans").toArray() });
    }
    if (path === "/internal/import") {
      for (const t of ["items", "images", "roles", "bans", "meta"]) this.sql.exec(`DELETE FROM ${t}`);
      this.meta = {}; this.cache = null;
      for (const [k, v] of Object.entries(b.meta || {})) this.setMeta(k, v);
      for (const r of b.items || []) this.sql.exec("INSERT OR REPLACE INTO items (id, data) VALUES (?, ?)", r.id, r.data);
      for (const r of b.roles || []) this.sql.exec("INSERT OR REPLACE INTO roles (client, role) VALUES (?, ?)", r.client, r.role);
      for (const r of b.bans || []) this.sql.exec("INSERT OR REPLACE INTO bans (id, client, ip, name, at) VALUES (?, ?, ?, ?, ?)", r.id, r.client, r.ip || "", r.name, r.at);
      this.setMeta("count", (b.items || []).length); this.setMeta("imgBytes", 0);
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  }

  async connect(request, url) {
    const board = url.searchParams.get("board");
    const admin = request.headers.get("x-admin") === "1";
    let client = url.searchParams.get("client") || "";
    if (!CLIENT_RE.test(client)) client = "anon-" + randomId(12);

    if (this.meta.deleted && !admin) return this.reject("deleted");
    if (!this.meta.created) {
      if (this.hasContent()) await this.init(board, "Общая доска", null);           // boards made before owners existed
      else if (admin) await this.init(board, "Новая доска", null);
      else {
        const st = await call(registry(this.env), "/state");
        if (st.createPolicy !== "all") return this.reject("notfound");
        await this.init(board, "Новая доска", client);                             // whoever opens a fresh link owns it
      }
    }
    if (!admin && this.banned(client)) return this.reject("banned");

    const { 0: pair, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const used = new Set(this.peers().map(p => p.color));
    const meta = {
      peer: randomId(5), client, admin, board,
      name: cleanName(url.searchParams.get("name"), "Гость").slice(0, 32),
      color: COLORS.find(c => !used.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)],
    };
    meta.role = this.roleFor(meta);
    server.serializeAttachment(meta);
    const head = JSON.stringify({ type: "init", you: meta.peer, color: meta.color, role: meta.role, board: this.info(),
      peers: this.peers(), bans: isManager(meta.role) ? this.banList() : undefined });
    server.send(head.slice(0, -1) + ',"items":' + this.itemsJson() + "}");
    this.broadcast({ type: "peers", peers: this.peers() }, server);
    return new Response(null, { status: 101, webSocket: pair });
  }

  async image(request, url) {
    const [, , board, id] = url.pathname.split("/");
    if (request.method === "GET") {
      const row = this.sql.exec("SELECT type, data FROM images WHERE id = ?", id).toArray()[0];
      if (!row) return new Response("Not found", { status: 404 });
      return new Response(row.data, { headers: { "content-type": row.type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
    }
    const admin = request.headers.get("x-admin") === "1";
    const client = request.headers.get("x-client-id") || "";
    if (this.meta.deleted || !this.meta.created) return json({ error: "no_board" }, 404);
    if (!admin && (!CLIENT_RE.test(client) || this.banned(client))) return json({ error: "forbidden" }, 403);
    if (this.roleFor({ admin, client }) === "viewer") return json({ error: "view_only" }, 403);
    const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) return json({ error: "bad_type" }, 415);
    const buf = await request.arrayBuffer();
    if (!buf.byteLength) return json({ error: "empty" }, 400);
    if (buf.byteLength > MAX_IMAGE_BYTES) return json({ error: "too_large" }, 413);
    if ((this.meta.imgBytes || 0) + buf.byteLength > MAX_BOARD_IMAGE_BYTES) return json({ error: "board_full" }, 507);
    const newId = randomId(9);
    this.sql.exec("INSERT INTO images (id, type, size, data) VALUES (?, ?, ?, ?)", newId, type, buf.byteLength, buf);
    this.setMeta("imgBytes", (this.meta.imgBytes || 0) + buf.byteLength);
    return json({ src: `/img/${board}/${newId}` });
  }

  allow(ws) {
    const now = Date.now();
    let b = this.budget.get(ws);
    if (!b || now - b.t > 1000) { b = { t: now, n: 0 }; this.budget.set(ws, b); }
    return ++b.n <= 240;
  }
  viewOnly(ws) {
    const now = Date.now();
    if (now - (this.warned.get(ws) || 0) < 3000) return;
    this.warned.set(ws, now);
    try { ws.send(JSON.stringify({ type: "error", message: "Сейчас вы можете только смотреть." })); } catch {}
  }
  findPeer(peer) { return this.sockets().find(s => s.meta.peer === peer); }

  async webSocketMessage(ws, raw) {
    try { await this.message(ws, raw); }
    catch (e) {
      console.error("message failed", e && e.message);
      const now = Date.now();
      if (now - (this.warned.get(ws) || 0) > 5000) {
        this.warned.set(ws, now);
        try { ws.send(JSON.stringify({ type: "error", message: "Сервер временно не сохраняет изменения. Попробуйте чуть позже." })); } catch {}
      }
    }
  }
  async message(ws, raw) {
    if (typeof raw !== "string" || raw.length > 512 * 1024 || !this.allow(ws)) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object") return;
    const meta = ws.deserializeAttachment() || {};
    const role = meta.role, canEdit = role && role !== "viewer";
    switch (m.type) {
      case "set": {
        if (!canEdit) return this.viewOnly(ws);
        if (typeof m.id !== "string" || !ID_RE.test(m.id)) return;
        const item = cleanItem(m.data, meta.board); if (!item) return;
        // one-row lookup unless the board is already in memory; never read the whole board for one change
        const exists = this.cache ? this.cache.has(m.id) : this.sql.exec("SELECT 1 FROM items WHERE id = ?", m.id).toArray().length > 0;
        if (!exists && (this.meta.count || 0) >= MAX_ITEMS) {
          ws.send(JSON.stringify({ type: "error", message: "Доска переполнена" })); return;
        }
        const data = JSON.stringify(item);
        this.sql.exec("INSERT OR REPLACE INTO items (id, data) VALUES (?, ?)", m.id, data);
        if (this.cache) this.cache.set(m.id, data);
        if (!exists) this.setMeta("count", (this.meta.count || 0) + 1);
        this.broadcast('{"type":"set","id":' + JSON.stringify(m.id) + ',"data":' + data + "}", ws);
        break;
      }
      case "del": {
        if (!canEdit) return this.viewOnly(ws);
        if (typeof m.id !== "string") return;
        const exists = this.cache ? this.cache.has(m.id) : this.sql.exec("SELECT 1 FROM items WHERE id = ?", m.id).toArray().length > 0;
        if (!exists) return;
        this.sql.exec("DELETE FROM items WHERE id = ?", m.id);
        if (this.cache) this.cache.delete(m.id);
        this.setMeta("count", Math.max(0, (this.meta.count || 0) - 1));
        this.broadcast({ type: "del", id: m.id }, ws);
        break;
      }
      case "clear": {
        if (!isManager(role)) return;
        this.sql.exec("DELETE FROM items");
        this.sql.exec("DELETE FROM images");
        if (this.cache) this.cache.clear();
        this.setMeta("count", 0); this.setMeta("imgBytes", 0);
        this.broadcast({ type: "clear" }, ws);
        break;
      }
      case "draft": {
        if (!canEdit) return;
        if (typeof m.id !== "string" || !ID_RE.test(m.id)) return;
        if (m.end) { this.broadcast({ type: "draft", id: m.id, end: true }, ws); return; }
        const src = m.d && typeof m.d === "object" ? m.d : null;
        if (!src || !["stroke", "line", "arrow", "rect", "ellipse"].includes(src.kind)) return;
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
        meta.name = cleanName(m.name, "Гость").slice(0, 32);
        ws.serializeAttachment(meta);
        this.broadcast({ type: "peers", peers: this.peers() });
        break;
      }
      case "admin": {
        if (!isManager(role)) return;
        const target = typeof m.peer === "string" ? this.findPeer(m.peer) : null;
        // nobody can act on the site owner, and a board's creator cannot be managed by anyone but the owner
        const protectedTarget = t => !t || t.ws === ws || t.meta.admin || (t.meta.role === "owner" && role !== "admin");
        if (m.op === "role") {
          if (protectedTarget(target) || !ROLES.has(m.role)) return;
          this.sql.exec("INSERT OR REPLACE INTO roles (client, role) VALUES (?, ?)", target.meta.client, m.role);
          this.refreshRoles();
        } else if (m.op === "kick" || m.op === "ban") {
          if (protectedTarget(target)) return;
          if (m.op === "ban") {
            this.sql.exec("INSERT INTO bans (id, client, ip, name, at) VALUES (?, ?, ?, ?, ?)", randomId(6), target.meta.client, "", target.meta.name, Date.now());
          }
          const victims = this.sockets().filter(s => s.ws === target.ws || (m.op === "ban" && !s.meta.admin && !isManager(s.meta.role) && s.meta.client === target.meta.client));
          for (const v of victims) {
            try { v.ws.send(JSON.stringify({ type: "kicked", reason: m.op === "ban" ? "banned" : "kicked" })); v.ws.close(4001, m.op); } catch {}
          }
          this.broadcast({ type: "peers", peers: this.peers().filter(p => !victims.some(v => v.meta.peer === p.peer)) });
          if (m.op === "ban") this.toManagers({ type: "bans", bans: this.banList() });
        } else if (m.op === "unban") {
          this.sql.exec("DELETE FROM bans WHERE id = ?", String(m.id || ""));
          this.toManagers({ type: "bans", bans: this.banList() });
        } else if (m.op === "settings") {
          const patch = {};
          if (m.name !== undefined) patch.name = m.name;
          if (m.access !== undefined) patch.access = m.access;
          if (m.resetRoles) this.sql.exec("DELETE FROM roles");
          this.applySettings(patch);
        } else if (m.op === "delete") {
          this.ctx.waitUntil(call(registry(this.env), "/boards/remove", { id: this.meta.id }).catch(() => {}));
          this.wipe();
        }
        break;
      }
    }
  }

  async webSocketClose(ws, code) {
    this.budget.delete(ws); this.warned.delete(ws);
    if (this.ctx.getWebSockets().filter(w => w !== ws).length === 0) this.cache = null;
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch {}
    this.broadcast({ type: "peers", peers: this.peers(ws) }, ws);
  }
  async webSocketError(ws) {
    this.budget.delete(ws); this.warned.delete(ws);
    this.broadcast({ type: "peers", peers: this.peers(ws) }, ws);
  }
}
