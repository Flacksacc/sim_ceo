// qa/advisor-claim-endpoint-fake.mjs - CLAIM-ENDPOINT isolated fake (Muse sole-QA author only).
// Loopback-only provider fake for qa/advisor-claim-endpoint-qa.mjs on 127.0.0.1:15502.
// NEVER shipped, never referenced by production. Captures delivered prompts,
// returns MIXED supported fact + supported interpretation + second fact sharing
// the fact URL (distinct passage) + URI-identity variants (wrong path case,
// trailing slash, query-value case with OTHER distinct quotes) + host-case
// variant (same quote, canonical retain) + one unsupported note with no evidence.
// Character Owner-sources branch returns per-SID (S1..S5) facts citing SID with
// exact quotes matching its own web_search_call snippets, proving SID->FULL URL.
// Unsupported branch (input contains CLAIMENDPOINT-UNSUPPORTED) returns only an
// unsupported line with no web_search_call, so ai-draft/character orchestration
// commits draftStatus unsupported via the REAL Atomic path.
// Marker echo: input CLMEP-[USC]-<run> is echoed into dossier lines and the
// response id (qa-claimresp-*-<marker>-<seq>) so QA correlates same-flow
// dossier/profile/compiler logs, responseIds, and ordering without joining flows.
// No paid network, no fetch bypass, no SSRF logic here.
import http from "node:http";
const argIdx = process.argv.indexOf("--port");
const PORT = Number(argIdx >= 0 ? process.argv[argIdx + 1] : 15502);
const FACT_URL = "https://qa.example/EndpointFact";
const FACT_QUOTE = "QA endpoint fact passage alpha.";
const FACT_QUOTE2 = "QA endpoint second fact passage gamma.";
const INTERP_URL = "https://qa.example/EndpointInterp?src=qa";
const INTERP_QUOTE = "QA endpoint interp passage beta.";
const WRONG_PATH_URL = "https://qa.example/endpointfact";
const WRONG_PATH_QUOTE = "QA endpoint wrongpath distinct passage omega.";
const SLASH_URL = "https://qa.example/EndpointFact/";
const SLASH_QUOTE = "QA endpoint slash distinct passage sigma.";
const QUERYCASE_URL = "https://qa.example/EndpointInterp?src=QA";
const QUERYCASE_QUOTE = "QA endpoint querycase distinct passage tau.";
const HOSTCASE_URL = "https://QA.EXAMPLE/EndpointFact";
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
function extractMarker(input) {
  try {
    const m = /CLMEP-[USC]-[a-z0-9]+/.exec(input || "");
    return m ? m[0] : "";
  } catch { return ""; }
}
function sidUrlsFromInput(input) {
  const out = [];
  try {
    const re = /\[S(\d+)\]\s+(https?:\/\/[^\s]+)/g;
    let m;
    while ((m = re.exec(input || "")) !== null) {
      const sid = "S" + m[1];
      let u = (m[2] || "").trim().replace(/[|,;)\]]+$/, "");
      if (u) out.push({ sid, url: u });
      if (out.length >= 5) break;
    }
  } catch {}
  return out;
}
function aiDossierText(marker) {
  const mk = marker ? " " + marker : "";
  return [
    "FACT | QA endpoint harbor fact alpha" + mk + " || EVIDENCE: " + FACT_URL + " :: \"" + FACT_QUOTE + "\"",
    "INTERPRETATION | QA endpoint crew interpretation beta" + mk + " || EVIDENCE: " + INTERP_URL + " :: \"" + INTERP_QUOTE + "\"",
    "FACT | QA endpoint second harbor fact gamma" + mk + " || EVIDENCE: " + FACT_URL + " :: \"" + FACT_QUOTE2 + "\"",
    "FACT | QA endpoint wrongpath fact" + mk + " || EVIDENCE: " + WRONG_PATH_URL + " :: \"" + WRONG_PATH_QUOTE + "\"",
    "FACT | QA endpoint slash fact" + mk + " || EVIDENCE: " + SLASH_URL + " :: \"" + SLASH_QUOTE + "\"",
    "INTERPRETATION | QA endpoint querycase inference" + mk + " || EVIDENCE: " + QUERYCASE_URL + " :: \"" + QUERYCASE_QUOTE + "\"",
    "FACT | QA endpoint hostcase fact" + mk + " || EVIDENCE: " + HOSTCASE_URL + " :: \"" + FACT_QUOTE + "\"",
    UNSUPPORTED_TEXT + mk,
  ].join("\n");
}
function aiCitations() {
  return [
    { url: FACT_URL, title: "QA endpoint fact source", snippet: FACT_QUOTE },
    { url: INTERP_URL, title: "QA endpoint interp source", snippet: INTERP_QUOTE },
    { url: FACT_URL, title: "QA endpoint fact source", snippet: FACT_QUOTE2 },
    { url: WRONG_PATH_URL, title: "QA endpoint wrongpath source", snippet: WRONG_PATH_QUOTE },
    { url: SLASH_URL, title: "QA endpoint slash source", snippet: SLASH_QUOTE },
    { url: QUERYCASE_URL, title: "QA endpoint querycase source", snippet: QUERYCASE_QUOTE },
    { url: HOSTCASE_URL, title: "QA endpoint fact source", snippet: FACT_QUOTE },
  ];
}
function sidDossierText(sids, marker) {
  const mk = marker ? " " + marker : "";
  const lines = sids.map(({ sid }) => "FACT | QA endpoint SID fact " + sid + mk + " || EVIDENCE: " + sid + " :: \"QA endpoint SID passage for " + sid + mk + ".\"");
  lines.push(UNSUPPORTED_TEXT + mk);
  return lines.join("\n");
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
    const marker = extractMarker(input);
    const mks = marker ? "-" + marker : "";
    let seq = Date.now() % 1000000;
    if (input.includes("CLAIMENDPOINT-UNSUPPORTED")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "qa-claimresp-u" + mks + "-" + seq,
        output: [{ type: "message", content: [{ type: "output_text", text: UNSUPPORTED_TEXT + (marker ? " " + marker : "") }] }],
        usage: { input_tokens: 20, output_tokens: 10 },
      }));
      return;
    }
    if (input.includes("Owner sources")) {
      const sids = sidUrlsFromInput(input);
      const use = sids.length ? sids : [{ sid: "S1", url: FACT_URL }];
      const results = use.map(({ url, sid }) => ({ url, title: "QA endpoint SID source " + sid, snippet: "QA endpoint SID passage for " + sid + (marker ? " " + marker : "") + "." }));
      const output = [
        { type: "web_search_call", results },
        { type: "message", content: [{ type: "output_text", text: sidDossierText(use, marker) }] },
      ];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "qa-claimresp-c" + mks + "-" + seq, output, usage: { input_tokens: 20, output_tokens: 30 } }));
      return;
    }
    const output = [
      { type: "web_search_call", results: aiCitations() },
      { type: "message", content: [{ type: "output_text", text: aiDossierText(marker) }] },
    ];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "qa-claimresp-s" + mks + "-" + seq, output, usage: { input_tokens: 20, output_tokens: 30 } }));
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
