// qa/advisor-claim-endpoint-fake.mjs - CLAIM-ENDPOINT isolated fake (Muse sole-QA author only).
// Loopback-only provider fake for qa/advisor-claim-endpoint-qa.mjs on 127.0.0.1:15502.
// NEVER shipped, never referenced by production. Captures delivered prompts,
// returns MIXED supported fact + supported interpretation + second fact sharing
// the fact URL (distinct passage) + one unsupported note with no evidence.
// Each supported line has a DISTINCT exact quote+URL relationship.
// Unsupported branch (input contains CLAIMENDPOINT-UNSUPPORTED) returns only an
// unsupported line with no web_search_call, so ai-draft/character orchestration
// commits draftStatus unsupported via the REAL Atomic path.
// No paid network, no fetch bypass, no SSRF logic here.
import http from "node:http";
const argIdx = process.argv.indexOf("--port");
const PORT = Number(argIdx >= 0 ? process.argv[argIdx + 1] : 15502);
const FACT_URL = "https://qa.example/EndpointFact";
const FACT_QUOTE = "QA endpoint fact passage alpha.";
const FACT_QUOTE2 = "QA endpoint second fact passage gamma.";
const INTERP_URL = "https://qa.example/EndpointInterp?src=qa";
const INTERP_QUOTE = "QA endpoint interp passage beta.";
const UNSUPPORTED_TEXT = "QA endpoint unsupported speculation delta with no evidence.";
const counts = { chat: 0, responses: 0, images: 0 };
const promptLog = [];
function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
function logPrompt(path, text) {
  try {
    promptLog.push({ t: Date.now(), path, len: (text || "").length, full: (text || "").slice(0, 200000) });
    if (promptLog.length > 500) promptLog.splice(0, promptLog.length - 500);
  } catch {}
}
function supportedDossierText() {
  return [
    "FACT | QA endpoint harbor fact alpha || EVIDENCE: " + FACT_URL + " :: \"" + FACT_QUOTE + "\"",
    "INTERPRETATION | QA endpoint crew interpretation beta || EVIDENCE: " + INTERP_URL + " :: \"" + INTERP_QUOTE + "\"",
    "FACT | QA endpoint second harbor fact gamma || EVIDENCE: " + FACT_URL + " :: \"" + FACT_QUOTE2 + "\"",
    UNSUPPORTED_TEXT,
  ].join("\n");
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  if (req.method === "GET" && url.pathname === "/__health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, fake: "claim-endpoint" }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/__log") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(promptLog));
    return;
  }
  if (req.method === "DELETE" && url.pathname === "/__log") {
    promptLog.length = 0;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/__counts") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(counts));
    return;
  }
  const rawBuf = await readRaw(req);
  if (req.method === "POST" && url.pathname === "/responses") {
    counts.responses++;
    let body = {};
    try { body = rawBuf.length ? JSON.parse(rawBuf.toString("utf8")) : {}; } catch { body = {}; }
    const input = typeof body?.input === "string" ? body.input : "";
    logPrompt("responses", input);
    let seq = Date.now() % 1000000;
    if (input.includes("CLAIMENDPOINT-UNSUPPORTED")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "qa-claimresp-u" + seq,
        output: [{ type: "message", content: [{ type: "output_text", text: UNSUPPORTED_TEXT }] }],
        usage: { input_tokens: 20, output_tokens: 10 },
      }));
      return;
    }
    const output = [
      {
        type: "web_search_call",
        results: [
          { url: FACT_URL, title: "QA endpoint fact source", snippet: FACT_QUOTE },
          { url: INTERP_URL, title: "QA endpoint interp source", snippet: INTERP_QUOTE },
          { url: FACT_URL, title: "QA endpoint fact source", snippet: FACT_QUOTE2 },
        ],
      },
      { type: "message", content: [{ type: "output_text", text: supportedDossierText() }] },
    ];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "qa-claimresp-s" + seq, output, usage: { input_tokens: 20, output_tokens: 30 } }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/chat/completions") {
    counts.chat++;
    let body = {};
    try { body = rawBuf.length ? JSON.parse(rawBuf.toString("utf8")) : {}; } catch { body = {}; }
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    const prompt = msgs.map((m) => m.content).join("\n") || "";
    logPrompt("chat", prompt);
    let content;
    if (prompt.includes("COMPILE-CHARACTER-PARAGRAPHS")) {
      const nm = /character "([^"]+)"/.exec(prompt || "") || [];
      const who = nm[1] || "QA character";
      content = JSON.stringify({
        contributionCriteria: "QA-CRITERIA for " + who + ": contributes fleet logistics and port risk; abstains without port data.",
        reasoningApproach: "QA-REASON for " + who + ": compares options against port evidence; agrees when supported, challenges unsupported premises; never invents credentials.",
        responseStyle: "QA-STYLE for " + who + ": blunt about port risk, diplomatic with crew; detailed when evidence allows.",
      });
    } else {
      content = JSON.stringify({
        background: "QA endpoint fictional advisor background; no real employment, degrees, licenses, or endorsements claimed.",
        strengths: ["harbor risk surfacing", "crew coordination", "structured comparison"],
        methods: ["assumption check", "options comparison", "next-step proposal"],
        evidenceNeeded: ["approved board sources", "board-lead brief"],
        limits: ["defers outside specialty", "abstains without evidence", "never claims real employment, degrees, licenses, endorsements"],
        collaboration: "direct, concise, cites evidence",
      });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "qa-claimchat-" + Date.now(), choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/images/generations") {
    counts.images++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }] }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "claim-endpoint fake: unknown route " + url.pathname }));
});
server.listen(PORT, "127.0.0.1", () => console.log("claim-endpoint fake on 127.0.0.1:" + PORT));
