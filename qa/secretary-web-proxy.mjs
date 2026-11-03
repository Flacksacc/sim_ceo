
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const API = process.env.QA_API || "http://127.0.0.1:5113";
const PORT = Number(process.env.QA_WEB_PORT || "5191");
const DIST = process.env.QA_DIST || "web/dist";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2" };
function send(res, code, type, body) { res.writeHead(code, { "content-type": type }); res.end(body); }
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || "/", "http://x");
  if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/hubs/")) {
    try {
      let bdy = undefined;
      if (req.method !== "GET" && req.method !== "HEAD") { bdy = await new Promise((resolve) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => resolve(b)); }); }
      const fwd = { "content-type": req.headers["content-type"] || "application/json" };
      if (req.headers["x-user"]) fwd["x-user"] = req.headers["x-user"];
      if (req.headers["authorization"]) fwd["authorization"] = req.headers["authorization"];
      const r = await fetch(API + u.pathname + u.search, { method: req.method, headers: fwd, body: bdy });
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json" });
      res.end(buf);
      return;
    } catch (e) { send(res, 502, "application/json", JSON.stringify({ error: String(e) })); return; }
  }
  let p = u.pathname === "/" ? "/index.html" : u.pathname;
  p = path.normalize(p).replace(/^(\.\.[\/\\])+/, "");
  let f = path.join(DIST, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, "index.html");
  const ext = path.extname(f).toLowerCase();
  try { const data = fs.readFileSync(f); send(res, 200, MIME[ext] || "application/octet-stream", data); } catch { send(res, 404, "text/plain", "not found"); }
});
server.listen(PORT, "127.0.0.1", () => console.log("web proxy on " + PORT + " to " + API));
