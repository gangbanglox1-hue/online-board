// Node.js server for the board: same code as on Cloudflare, data in SQLite files.
// Env: PORT (default 3000), HOST (default 127.0.0.1), DATA_DIR, SETUP_TOKEN, TRUST_PROXY=1 behind Caddy.
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { WebSocketServer } from "ws";
import { Namespace, attachSocket } from "./shim.mjs";
import worker, { Board, Registry } from "./dist/worker.mjs";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

const env = { SETUP_TOKEN: process.env.SETUP_TOKEN || "" };
env.BOARD = new Namespace(Board, path.join(DATA_DIR, "boards"), () => env);
env.REGISTRY = new Namespace(Registry, path.join(DATA_DIR, "registry"), () => env);

function toRequest(req) {
  const proto = TRUST_PROXY && req.headers["x-forwarded-proto"] ? String(req.headers["x-forwarded-proto"]).split(",")[0] : "http";
  const url = `${proto}://${req.headers.host || "localhost"}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith(":")) continue;
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x)); else if (v !== undefined) headers.set(k, v);
  }
  const ip = TRUST_PROXY && req.headers["x-forwarded-for"] ? String(req.headers["x-forwarded-for"]).split(",")[0].trim() : req.socket.remoteAddress || "";
  headers.set("cf-connecting-ip", ip);
  const hasBody = !["GET", "HEAD"].includes(req.method);
  return new Request(url, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: hasBody ? "half" : undefined });
}

const server = http.createServer(async (req, res) => {
  try {
    const r = await worker.fetch(toRequest(req), env);
    const headers = {};
    r.headers.forEach((v, k) => { if (k !== "set-cookie") headers[k] = v; });
    const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (cookies.length) headers["set-cookie"] = cookies;
    res.writeHead(r.status, headers);
    if (r.body && req.method !== "HEAD") Readable.fromWeb(r.body).pipe(res); else res.end();
  } catch (e) {
    console.error("request failed", req.url, e?.message);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Ошибка сервера");
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on("upgrade", async (req, socket, head) => {
  try {
    const r = await worker.fetch(toRequest(req), env);
    const client = r.webSocket;
    if (r.status !== 101 || !client) { socket.end(`HTTP/1.1 ${r.status} Error\r\nConnection: close\r\n\r\n`); return; }
    const board = new URL(req.url, "http://x").searchParams.get("board") || "";
    wss.handleUpgrade(req, socket, head, real => {
      real.isAlive = true;
      real.on("pong", () => { real.isAlive = true; });
      attachSocket(env.BOARD, board, client.peer, real);
    });
  } catch (e) {
    console.error("upgrade failed", e?.message);
    socket.destroy();
  }
});
// drop connections that silently went away (phones going to sleep, lost Wi-Fi)
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch {} }
}, 30000).unref();

server.listen(PORT, HOST, () => console.log(`Доска запущена на http://${HOST}:${PORT}, данные в ${DATA_DIR}`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.close(); process.exit(0); });
