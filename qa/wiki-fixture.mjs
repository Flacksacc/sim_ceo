
// Local Wiki.js 2.x fixture. Fixed queries only; never mutations.
// Token selects scenario; every request is logged JSONL with redacted auth.
// Control: GET /__control?mode=<name>&singleDelayMs=N&listDelayMs=N
import http from "node:http";
import fs from "node:fs";
const port = parseInt(process.argv[2] || "5201", 10);
const logPath = process.argv[3] || ".tmp/wiki-qa-requests.jsonl";
try { fs.mkdirSync(".tmp", { recursive: true }); } catch {}
try { fs.mkdirSync(logPath.split("/").slice(0, -1).join("/") || ".tmp", { recursive: true }); } catch {}
try { fs.writeFileSync(logPath, ""); } catch {}
let mode = "normal";
let singleDelayMs = 0;
let listDelayMs = 0;
let holdSingles = false;
const pendingSingles = [];
const basePages = [
  { id: 11, path: "/guides/alpha", locale: "en", title: "Alpha", content: "# Alpha\n\nAlpha handbook text for retrieval.", contentType: "markdown", updatedAt: "2026-01-01T00:00:00Z", tags: ["handbook", "public"] },
  { id: 12, path: "/guides/beta", locale: "en", title: "Beta", content: "# Beta\n\nBeta runbook text for retrieval.", contentType: "markdown", updatedAt: "2026-01-01T00:00:00Z", tags: ["handbook"] },
];
function pagesFor(scenario) {
  if (scenario === "empty") return [];
  if (scenario === "deleted") return [{ ...basePages[0] }];
  if (scenario === "duplicate") return [
    { id: 31, path: "/guides/dup", locale: "en", title: "DupA", content: "dup a", contentType: "markdown", updatedAt: "2026-01-01T00:00:00Z", tags: [] },
    { id: 32, path: "/guides/dup", locale: "en", title: "DupB", content: "dup b", contentType: "markdown", updatedAt: "2026-01-01T00:00:00Z", tags: [] },
  ];
  if (scenario === "newhash") return basePages.map((p) => p.id === 11 ? { ...p, content: "# Alpha\n\nAlpha handbook REVISED content v2." } : { ...p });
  if (scenario === "toomany") {
    const arr = [];
    for (let i = 0; i < 102; i++) arr.push({ id: 100 + i, path: "/bulk/p" + i, locale: "en", title: "P" + i, content: "text " + i, contentType: "markdown", updatedAt: "2026-01-01T00:00:00Z", tags: [] });
    return arr;
  }
  if (scenario === "oversize") {
    return [{ id: 21, path: "/guides/huge", locale: "en", title: "Huge", content: "X".repeat(300 * 1024), contentType: "markdown", updatedAt: "2026-01-01T00:00:00Z", tags: [] }];
  }
  if (scenario === "trio") {
    return basePages.map((p) => ({ ...p })).concat([
      { id: 13, path: "/guides/gamma", locale: "en", title: "Gamma", content: "# Gamma\n\nGamma text.", contentType: "markdown", updatedAt: "2026-01-03T00:00:00Z", tags: ["handbook"] },
    ]);
  }
  if (scenario === "fail-single-13") {
    return basePages.map((p) => ({ ...p })).concat([
      { id: 13, path: "/guides/gamma", locale: "en", title: "Gamma", content: "# Gamma\n\nGamma text.", contentType: "markdown", updatedAt: "2026-01-03T00:00:00Z", tags: ["handbook"] },
    ]);
  }
  if (scenario === "white-content") {
    return basePages.map((p) => ({ ...p, content: "   \n   " }));
  }
  if (scenario === "fat") {
    const arr = [];
    for (let i = 0; i < 14; i++) arr.push({ id: 40 + i, path: "/fat/p" + i, locale: "en", title: "F" + i, content: "Y".repeat(600 * 1024), contentType: "markdown", updatedAt: "2026-01-01T00:00:00Z", tags: ["keep"] });
    return arr;
  }
  return basePages.map((p) => ({ ...p }));
}
function log(entry) {
  try { fs.appendFileSync(logPath, JSON.stringify(entry) + "\n"); } catch {}
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, fixture: "wiki", mode }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/__connections") {
    server.getConnections((err, count) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ connections: err ? -1 : count }));
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/__release") {
    const pending = pendingSingles.splice(0, pendingSingles.length);
    holdSingles = false;
    for (const p of pending) { try { p(); } catch {} }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ released: pending.length, mode }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/__control") {
    const m = url.searchParams.get("mode");
    if (m) { mode = m; holdSingles = false; pendingSingles.length = 0; }
    const sd = url.searchParams.get("singleDelayMs");
    if (sd !== null) singleDelayMs = parseInt(sd, 10) || 0;
    const ld = url.searchParams.get("listDelayMs");
    if (ld !== null) listDelayMs = parseInt(ld, 10) || 0;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ mode, singleDelayMs, listDelayMs }));
    return;
  }
  if (req.method !== "POST" || url.pathname !== "/graphql") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 2 * 1024 * 1024) req.destroy(); });
  req.on("end", () => {
    const auth = req.headers["authorization"] || "";
    const token = String(auth).replace(/^Bearer\s+/i, "").trim();
    const scenario = token.startsWith("scenario-") ? token.slice("scenario-".length) : mode;
    let parsed;
    try { parsed = JSON.parse(body); }
    catch {
      log({ t: new Date().toISOString(), op: "parse-error", hasAuth: !!auth, query: body.slice(0, 120) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("this is not json{{{");
      return;
    }
    const query = String(parsed.query || "");
    const vars = parsed.variables || {};
    const isList = query.includes("pages") && query.includes("list");
    const isSingle = query.includes("pages") && query.includes("single");
    const isMutation = /mutation\b/i.test(query);
    log({
      t: new Date().toISOString(),
      op: isList ? "pages.list" : isSingle ? "pages.single" : "unknown",
      query: query.slice(0, 800),
      variables: vars,
      hasAuth: !!auth,
      authPrefix: auth ? String(auth).slice(0, 7) : "",
      host: String(req.headers.host || ""),
      tokenTag: token.startsWith("qa-barrier-") ? token : "",
      scenario,
      isMutation,
    });
    if (isMutation) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "mutations are disabled in this fixture" }] }));
      return;
    }
    if (scenario === "redirect") {
      res.writeHead(301, { location: "http://localhost:9/evil" });
      res.end();
      return;
    }
    if (!isList && !isSingle) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "unknown operation" }] }));
      return;
    }
    if (!auth) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "unauthorized" }] }));
      return;
    }
    if (scenario === "forbidden") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "forbidden: manage:pages required" }] }));
      return;
    }
    if (scenario === "malformed") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{\"data\": {\"pages\": ");
      return;
    }
    if (scenario === "token-echo") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "Wiki GraphQL error: Authorization: Bearer " + token }] }));
      return;
    }
    if (scenario === "graphql-error") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "boom-graphql" }] }));
      return;
    }
    if (scenario === "http500") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
      return;
    }
    if (scenario === "stall-body") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{\"data\": {\"pages\": {\"single\": ");
      return;
    }
    const finish = (payload) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (isList) {
      const respond = () => {
        if (scenario === "timeout-list") return;
        const pages = pagesFor(scenario);
        finish({ data: { pages: { list: pages.map((p) => ({ id: p.id, path: p.path, locale: p.locale, title: p.title, tags: p.tags })) } } });
      };
      if (listDelayMs > 0) setTimeout(respond, listDelayMs);
      else if (scenario === "timeout-list") { }
      else respond();
      return;
    }
    if (isSingle) {
      if (holdSingles || scenario === "hold-fail" || scenario === "hold-ok") {
        holdSingles = true;
        pendingSingles.push(() => {
          if (scenario === "hold-fail") {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "held failure released" }));
            return;
          }
          const id = vars && typeof vars.id === "number" ? vars.id : -1;
          const pages = pagesFor("normal");
          const found = pages.find((p) => p.id === id) || pages[0];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: { pages: { single: { id: found.id, path: found.path, locale: found.locale, title: found.title, content: found.content, contentType: found.contentType, updatedAt: found.updatedAt, tags: found.tags.map((tg) => ({ tag: tg })) } } } }));
        });
        return;
      }
      const respond = () => {
        if (scenario === "timeout-single") return;
        if (scenario === "fail-single-13") {
          const id = vars && typeof vars.id === "number" ? vars.id : -1;
          if (id === 13) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "single 13 failed" }));
            return;
          }
        }
        const id = vars && typeof vars.id === "number" ? vars.id : -1;
        const pages = pagesFor(scenario);
        // Fat singles fail the fresh rule recheck (locale mismatch) AFTER their
        // bytes count toward the aggregate bound (F13).
        if (scenario === "fat") {
          const ff = pages.find((pp) => pp.id === id) || pages[0];
          const fat = { ...ff, locale: "xx" };
          finish({ data: { pages: { single: { id: fat.id, path: fat.path, locale: fat.locale, title: fat.title, content: fat.content, contentType: fat.contentType, updatedAt: fat.updatedAt, tags: fat.tags.map((tg) => ({ tag: tg })) } } } });
          return;
        }
        if (scenario === "id-mismatch") {
          finish({ data: { pages: { single: { id: 999, path: "/guides/alpha", locale: "en", title: "Alpha", content: "wrong id", contentType: "markdown", updatedAt: "2026-01-01T00:00:00Z", tags: [{ tag: "handbook" }] } } } });
          return;
        }
        if (scenario === "string-tags") {
          finish({ data: { pages: { single: { id, path: "/guides/alpha", locale: "en", title: "Alpha", content: "x", contentType: "markdown", updatedAt: "2026-01-01T00:00:00Z", tags: ["handbook"] } } } });
          return;
        }
        if (scenario === "missing-content") {
          finish({ data: { pages: { single: { id, path: "/guides/alpha", locale: "en", title: "Alpha", contentType: "markdown", updatedAt: "2026-01-01T00:00:00Z", tags: [] } } } });
          return;
        }
        if (scenario === "empty-content") {
          finish({ data: { pages: { single: { id, path: "/guides/alpha", locale: "en", title: "Alpha", content: "", contentType: "markdown", updatedAt: "2026-01-01T00:00:00Z", tags: [] } } } });
          return;
        }
        let found = pages.find((p) => p.id === id);
        if (!found) { finish({ data: { pages: { single: null } } }); return; }
        if (scenario === "changed" && id === 11) found = { ...found, tags: ["other"], locale: "fr" };
        finish({ data: { pages: { single: { id: found.id, path: found.path, locale: found.locale, title: found.title, content: found.content, contentType: found.contentType, updatedAt: found.updatedAt, tags: found.tags.map((t) => ({ tag: t })) } } } });
      };
      if (singleDelayMs > 0) setTimeout(respond, singleDelayMs);
      else if (scenario === "timeout-single") { }
      else respond();
      return;
    }
  });
});
server.listen(port, () => console.log("wiki-fixture on " + port));
