// Scoped Secretary capable fake for Records Phase 5 one-document review.
// Loopback only. Implements the OpenAI chat completions envelope the Secretary requires.
// Known markers: SECRETARY-NOTE, SECRETARY-BRIEFING, SECRETARY-AMBIGUOUS.
// No other routes. Primary owns lifecycle. Refuses non loopback binds by construction.
import crypto from "node:crypto";
import http from "node:http";
const argIdx = process.argv.indexOf("--port");
const PORT = Number(argIdx >= 0 ? process.argv[argIdx + 1] : 15322);
const BOOT = crypto.randomUUID();
const counts = { chat: 0 };
const promptLog = [];
function readBody(req) {
  return new Promise((resolve) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => resolve(b)); });
}
function envelope(content) {
  return { id: "qa-" + Date.now(), choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
}
function secretaryContent(prompt) {
  const seg = prompt.includes("RAW OWNER INPUT:") ? prompt.slice(prompt.lastIndexOf("RAW OWNER INPUT:")) : prompt;
  if (seg.includes("SECRETARY-AMBIGUOUS") && !prompt.includes("OWNER ANSWER")) return JSON.stringify({ kind: "question", question: "QA clarification: what budget range applies?" });
  if (prompt.includes("OWNER ANSWER")) return JSON.stringify({ kind: "note", title: "QA secretary note", body: "QA provisional note body for testing after clarification." });
  if (seg.includes("SECRETARY-BRIEFING")) return JSON.stringify({ kind: "briefing", title: "QA briefing", body: "QA briefing body with grounded support." });
  return JSON.stringify({ kind: "note", title: "QA secretary note", body: "QA provisional note body for testing." });
}
function health() {
  return { ok: true, fake: "records5-scoped", boot: BOOT, port: PORT };
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/__health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(health()));
    return;
  }
  if (req.method === "GET" && url.pathname === "/__counts") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(counts));
    return;
  }
  if (req.method === "GET" && url.pathname === "/__log") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(promptLog.slice(-50)));
    return;
  }
  if (req.method === "DELETE" && url.pathname === "/__log") {
    promptLog.length = 0;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/chat/completions") {
    let raw = ""; try { raw = await readBody(req); } catch { raw = ""; }
    let body = {}; try { body = JSON.parse(raw); } catch { body = {}; }
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const prompt = msgs.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    counts.chat++;
    try { promptLog.push({ t: Date.now(), len: prompt.length, prompt: prompt.slice(0, 4000) }); if (promptLog.length > 200) promptLog.splice(0, promptLog.length - 200); } catch {}
    let content = "";
    if (/board secretary/i.test(prompt) || /OWNER REQUEST/i.test(prompt) || /OWNER QUESTION/i.test(prompt)) content = secretaryContent(prompt);
    else if (/Reply with exactly YES or NO/.test(prompt)) content = "YES - directly relevant.";
    else if (/YOUR TURN/.test(prompt)) content = "QA advisor reply with a clear position. [stance: Agrees]";
    else content = "QA default text.";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(envelope(content)));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "unknown route" }));
});
server.listen(PORT, "127.0.0.1", () => { console.log("records5 fake on 127.0.0.1:" + PORT); });
