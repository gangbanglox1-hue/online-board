// Runs the Cloudflare Worker code (src/worker.js) on a plain Node.js server.
// Provides the few Cloudflare APIs it uses: Durable Objects with SQLite storage,
// hibernatable WebSockets (WebSocketPair, acceptWebSocket, attachments) and 101 responses.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export class DurableObject {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}

/* ---------- WebSockets ---------- */
export class ShimSocket {
  constructor() { this.peer = null; this.real = null; this.queue = []; this.closed = false; this.attachment = null; this.ctx = null; }
  send(data) {
    if (this.closed) return;
    if (this.real) { if (this.real.readyState === 1) this.real.send(data); }
    else this.queue.push(["send", data]);
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    if (this.real) { try { this.real.close(code, String(reason).slice(0, 120)); } catch {} }
    else this.queue.push(["close", code, reason]);
  }
  accept() {}
  serializeAttachment(v) { this.attachment = v === undefined ? null : structuredClone(v); }
  deserializeAttachment() { return this.attachment === null ? null : structuredClone(this.attachment); }
}
class WebSocketPair {
  constructor() { const c = new ShimSocket(), s = new ShimSocket(); c.peer = s; s.peer = c; this[0] = c; this[1] = s; }
}
globalThis.WebSocketPair = WebSocketPair;

// Node's Response refuses status 101; the worker returns one to hand over a WebSocket.
const NativeResponse = globalThis.Response;
class ShimResponse extends NativeResponse {
  constructor(body, init) {
    if (init && init.status === 101) { super(null, { ...init, status: 200 }); this._ws = init.webSocket || null; this._upgrade = true; }
    else super(body, init);
  }
  get status() { return this._upgrade ? 101 : super.status; }
  get webSocket() { return this._ws || null; }
}
globalThis.Response = ShimResponse;

/* ---------- SQLite with the Durable Object `sql.exec` interface ---------- */
class Sql {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.stmts = new Map();
  }
  exec(query, ...params) {
    const multi = !params.length && query.trim().replace(/;\s*$/, "").includes(";");
    if (multi) { this.db.exec(query); return cursor([]); }
    let st = this.stmts.get(query);
    if (!st) { st = this.db.prepare(query); this.stmts.set(query, st); }
    const args = params.map(p => p instanceof ArrayBuffer ? new Uint8Array(p) : p === undefined ? null : typeof p === "boolean" ? Number(p) : p);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) {
      const rows = st.all(...args).map(r => {
        const o = { ...r };
        for (const k in o) if (o[k] instanceof Uint8Array) o[k] = o[k].buffer.slice(o[k].byteOffset, o[k].byteOffset + o[k].byteLength);
        return o;
      });
      return cursor(rows);
    }
    const info = st.run(...args);
    return cursor([], Number(info.changes || 0));
  }
}
function cursor(rows, written = 0) {
  return {
    toArray: () => rows,
    one: () => { if (rows.length !== 1) throw new Error("Expected exactly one row"); return rows[0]; },
    [Symbol.iterator]: () => rows[Symbol.iterator](),
    rowsRead: rows.length, rowsWritten: written,
  };
}

/* ---------- Durable Object namespaces ---------- */
class Ctx {
  constructor(file) { this.sockets = new Set(); this.storage = { sql: new Sql(file) }; this.obj = null; }
  acceptWebSocket(ws) { ws.ctx = this; ws.hibernatable = true; this.sockets.add(ws); }
  getWebSockets() { return [...this.sockets]; }
  waitUntil(p) { Promise.resolve(p).catch(e => console.error("background task failed", e?.message)); }
}
export class Namespace {
  constructor(cls, dir, getEnv) { this.cls = cls; this.dir = dir; this.getEnv = getEnv; this.objects = new Map(); fs.mkdirSync(dir, { recursive: true }); }
  idFromName(name) { return String(name); }
  object(id) {
    let o = this.objects.get(id);
    if (!o) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("bad object id");
      const ctx = new Ctx(path.join(this.dir, id + ".sqlite"));
      o = new this.cls(ctx, this.getEnv());
      ctx.obj = o;
      this.objects.set(id, o);
    }
    return o;
  }
  get(id) {
    // calls into one object run one at a time, like Cloudflare's input gates
    return { fetch: (input, init) => this.run(id, () => this.object(id).fetch(input instanceof Request ? input : new Request(input, init))) };
  }
  run(id, fn) {
    const o = this.object(id);
    const prev = o.__queue || Promise.resolve();
    const next = prev.then(fn, fn);
    o.__queue = next.catch(() => {});
    return next;
  }
}

// Connect a real `ws` socket to the object side of a WebSocketPair.
export function attachSocket(ns, id, server, real) {
  server.real = real;
  for (const [op, a, b] of server.queue.splice(0)) {
    if (op === "send") { if (real.readyState === 1) real.send(a); }
    else { try { real.close(a, String(b || "").slice(0, 120)); } catch {} }
  }
  real.on("message", (data, isBinary) => {
    if (!server.hibernatable || server.closed) return;
    const msg = isBinary ? data : data.toString();
    ns.run(id, () => server.ctx.obj.webSocketMessage(server, msg)).catch(e => console.error("message handler failed", e?.message));
  });
  const gone = (code, reason) => {
    if (!server.ctx || !server.ctx.sockets.has(server)) return;
    const wasClosed = server.closed;
    server.closed = true;
    ns.run(id, async () => {
      try { await server.ctx.obj.webSocketClose(server, code || 1006, reason || "", true); }
      finally { server.ctx.sockets.delete(server); }
    }).catch(e => console.error("close handler failed", e?.message));
    if (!wasClosed) { try { real.terminate(); } catch {} }
  };
  real.on("close", (code, reason) => gone(code, reason?.toString()));
  real.on("error", () => gone(1006, ""));
}
