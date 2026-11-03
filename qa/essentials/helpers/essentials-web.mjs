// Owned static web server for leg6 (Muse-owned). Serves the ACTUAL production
// dist build and proxies /api + /hubs to the owned QA API with canonical
// headers. NEVER injects a default x-user/owner identity: the browser sends
// whatever the app sends (Bearer from localStorage after real login).
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

const args = process.argv.slice(2);
function argVal(n) { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : ""; }
const DIR = argVal("--dir");
const PORT = Number(argVal("--port") || "5194");
const APIT = argVal("--api") || "http://127.0.0.1:5142";
if (!DIR || !fs.existsSync(path.join(DIR, "index.html"))) { console.error("web: dist dir missing index.html: " + DIR); process.exit(2); }
const apiUrl = new URL(APIT);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".map": "application/json", ".txt": "text/plain; charset=utf-8" };

function forwardHeaders(incoming) {
  const h = {};
  for (const [k, v] of Object.entries(incoming)) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "connection" || lk === "content-length") continue;
    h[lk] = v;
  }
  // Canonical origin/proxy headers; the app transport already sends Bearer.
  // No default x-user is ever injected here.
  h["x-forwarded-host"] = "127.0.0.1:" + PORT;
  h["x-forwarded-proto"] = "http";
  h["x-forwarded-for"] = "127.0.0.1";
  return h;
}

function proxyHttp(req, res) {
  const isHttps = apiUrl.protocol === "https:";
  const lib = isHttps ? https : http;
  const headers = forwardHeaders(req.headers);
  const opts = {
    protocol: apiUrl.protocol, hostname: apiUrl.hostname, port: apiUrl.port || (isHttps ? 443 : 80),
    method: req.method, path: req.url, headers,
  };
  const up = lib.request(opts, (ur) => {
    res.writeHead(ur.statusCode || 502, ur.headers);
    ur.pipe(res);
  });
  up.on("error", () => { try { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "web-proxy: api unreachable" })); } catch {} });
  up.setTimeout(60000, () => { try { up.destroy(); } catch {} });
  req.pipe(up);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  if (u.pathname === "/__health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, web: "essentials" })); return; }
  if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/hubs/")) { proxyHttp(req, res); return; }
  let rel = decodeURIComponent(u.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  rel = rel.replace(/^\/+/, "");
  let file = path.join(DIR, rel);
  if (!file.startsWith(DIR)) { res.writeHead(403); res.end("forbidden"); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIR, "index.html");
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

// WebSocket upgrade passthrough for /hubs (SignalR): raw socket pipe, no
// inspection, no identity injection.
server.on("upgrade", (req, sock, head) => {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  if (!u.pathname.startsWith("/hubs/") && !u.pathname.startsWith("/api/")) { try { sock.destroy(); } catch {} return; }
  const target = net.connect({ host: apiUrl.hostname, port: Number(apiUrl.port) || 80 }, () => {
    const lines = [req.method + " " + req.url + " HTTP/" + req.httpVersion];
    for (const [k, v] of Object.entries(forwardHeaders(req.headers))) lines.push(k + ": " + v);
    lines.push("", "");
    try { target.write(lines.join("\r\n")); } catch {}
    if (head && head.length) try { target.write(head); } catch {}
    sock.pipe(target);
    target.pipe(sock);
  });
  const kill = () => { try { sock.destroy(); } catch {} try { target.destroy(); } catch {} };
  target.on("error", kill);
  sock.on("error", kill);
});

server.listen(PORT, "127.0.0.1", () => console.log("qa essentials web on 127.0.0.1:" + PORT + " dir=" + DIR + " api=" + APIT));