// Essentials-owned deterministic fake provider (Muse-authored).
// Lineage: mirrors qa/fake-provider.mjs response shapes (chat completions,
// /responses grounded research, /asr/transcribe WAV accounting) and the
// secretary branch of qa/secretary-fake.mjs. Adds ONLY an arming endpoint
// for owned held-fault proofs:
//   POST /__ess/arm   { route: "transcribe"|"chat"|"responses", times: N, status: 500|502 }
//   POST /__ess/reset
// Opt-in only: the API under test points here via META_API_BASE.
// No network calls leave this process; every response is scripted.
// Nothing here is provider proof; it is a fault-injection harness.
import http from "node:http";
import crypto from "node:crypto";

const argIdx = process.argv.indexOf("--port");
const PORT = Number(argIdx >= 0 && process.argv[argIdx + 1] ? process.argv[argIdx + 1] : 5242);
let seq = 0;
const counts = { chat: 0, responses: 0, transcribe: 0, images: 0 };
const promptLog = [];
const arm = { transcribe: [], chat: [], responses: [] };
let lastTranscribe = { n: 0, validWav: false, sampleRate: 0, audioSha256: "", partNames: [], wavError: "" };

function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sleepMsOf(text) {
  const m = /QA-SLEEP:(\d+)/.exec(text || "");
  return m ? Math.min(Number(m[1]), 15000) : 0;
}
function isBidPrompt(p) { return /Reply with exactly YES or NO/.test(p || ""); }
function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function promptText(body) {
  const msgs = body && Array.isArray(body.messages) ? body.messages : [];
  return msgs.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
}
function logPrompt(path, text) {
  try {
    promptLog.push({ t: Date.now(), path, draft: /YOUR TURN/.test(text || ""), bid: isBidPrompt(text || ""), len: (text || "").length, prompt: (text || "").slice(0, 20000) });
    if (promptLog.length > 300) promptLog.splice(0, promptLog.length - 300);
  } catch { /* ignore */ }
}
// Minimal WAV probe: RIFF/WAVE, PCM16 mono, known rate; returns fields only.
function probeWav(b) {
  if (!b || b.length < 44) return { valid: false, error: "too-short" };
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") return { valid: false, error: "not-riff-wave" };
  if (b.readUInt16LE(20) !== 1) return { valid: false, error: "not-pcm" };
  const ch = b.readUInt16LE(22);
  const sr = b.readUInt32LE(24);
  const bits = b.readUInt16LE(34);
  if (ch !== 1) return { valid: false, error: "not-mono" };
  if (bits !== 16) return { valid: false, error: "not-16bit" };
  if (sr !== 16000 && sr !== 24000 && sr !== 48000) return { valid: false, error: "bad-rate" };
  return { valid: true, sampleRate: sr };
}
// Minimal multipart parser (audio + request parts only), bounded 60MiB.
function parseMultipart(buf, ctype) {
  const m = /boundary=(?:"([^"]+)"|([^\s;]+))/.exec(String(ctype || ""));
  const boundary = m ? (m[1] || m[2]) : "";
  if (!boundary || buf.length > 60 * 1024 * 1024) return null;
  const parts = [];
  const delim = Buffer.from("--" + boundary);
  let start = 0;
  const idxs = [];
  let p = buf.indexOf(delim, start);
  while (p >= 0) { idxs.push(p); start = p + delim.length; p = buf.indexOf(delim, start); }
  for (let i = 0; i + 1 < idxs.length; i++) {
    let seg = buf.subarray(idxs[i] + delim.length, idxs[i + 1]);
    if (seg.subarray(seg.length - 2).toString() === "--") seg = seg.subarray(0, seg.length - 2);
    const hs = seg.indexOf(Buffer.from("\r\n\r\n"));
    if (hs < 0) continue;
    const htxt = seg.subarray(0, hs).toString("utf8");
    const nm = /name="([^"]+)"/.exec(htxt);
    parts.push({ name: nm ? nm[1] : "", body: seg.subarray(hs + 4, seg.length - 2) });
  }
  return { parts };
}
function chatContent(prompt) {
  if (/(board secretary|OWNER REQUEST|OWNER QUESTION)/.test(prompt || "")) {
    const ri = String(prompt).lastIndexOf("RAW OWNER INPUT:");
    const rawSeg = ri >= 0 ? String(prompt).slice(ri) : String(prompt);
    if (rawSeg.includes("SECRETARY-BAD")) return { envelope: { choices: [] } };
    if (rawSeg.includes("SECRETARY-PLAIN")) return { content: "just some plain text, not json" };
    if (rawSeg.includes("SECRETARY-UNKNOWN")) return { content: JSON.stringify({ kind: "mystery", title: "t", body: "b" }) };
    if (rawSeg.includes("SECRETARY-SECOND-QUESTION")) return { content: JSON.stringify({ kind: "question", question: "QA second clarification?" }) };
    if (String(prompt).includes("CLARIFIED:") || String(prompt).includes("OWNER ANSWER")) {
      if (rawSeg.includes("SECRETARY-SECOND-QUESTION") || String(prompt).includes("SECRETARY-SECOND-QUESTION")) return { content: JSON.stringify({ kind: "question", question: "QA second clarification?" }) };
      return { content: JSON.stringify({ kind: "note", title: "QA secretary note", body: "QA provisional note body for testing after clarification." }) };
    }
    if (rawSeg.includes("SECRETARY-NOTE")) return { content: JSON.stringify({ kind: "note", title: "QA secretary note", body: "QA provisional note body for testing." }) };
    if (rawSeg.includes("SECRETARY-AMBIGUOUS")) return { content: JSON.stringify({ kind: "question", question: "QA clarify budget scope?" }) };
    return { content: JSON.stringify({ kind: "note", title: "QA secretary note", body: "QA provisional note body for testing." }) };
  }
  if (/(You guide Sim CEO board setup)/.test(prompt || "")) {
    if (prompt.includes("QA-REPLYERR")) return { status: 500, body: "qa interview failure" };
    if (prompt.includes("QA-BADJSON")) return { content: "this is not json at all {{{" };
    return { content: JSON.stringify({ updates: {}, done: true }) };
  }
  if (isBidPrompt(prompt || "")) {
    if (prompt.includes("QA-BIDERR")) return { status: 500, body: "qa bid failure" };
    return { content: prompt.includes("QA-NO") ? "NO - not relevant to this prompt." : "YES - directly relevant." };
  }
  if (/YOUR TURN/.test(prompt || "")) {
    if (prompt.includes("QA-REPLYERR")) return { status: 500, body: "qa reply failure" };
    if (prompt.includes("QA-ABSTAIN")) return { content: "ABSTAIN" };
    return { content: "QA advisor reply. [stance: Agrees]" };
  }
  if (/Reply with exactly: OK/.test(prompt || "")) return { content: "OK" };
  if (prompt.includes("QA-ECHO-UTF8")) return { content: String(prompt) };
  if (/onboarding guide/.test(prompt || "")) return { content: JSON.stringify({ guide: "qa guide", steps: [] }) };
  return { content: "QA provisional text." };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const rawBuf = await readRaw(req);
  if (req.method === "GET" && url.pathname === "/__health") return json(res, 200, { ok: true, fake: "essentials" });
  if (req.method === "GET" && url.pathname === "/__counts") return json(res, 200, counts);
  if (req.method === "GET" && url.pathname === "/__last-transcribe") return json(res, 200, lastTranscribe);
  if (req.method === "GET" && url.pathname === "/__log") return json(res, 200, promptLog);
  if (req.method === "DELETE" && url.pathname === "/__log") { promptLog.length = 0; return json(res, 200, { ok: true }); }
  if (req.method === "POST" && url.pathname === "/__ess/arm") {
    let b = {};
    try { b = rawBuf.length ? JSON.parse(rawBuf.toString("utf8")) : {}; } catch { b = {}; }
    const route = String(b.route || "");
    const times = Math.max(1, Math.min(10, Number(b.times || 1)));
    const status = Number(b.status || 500);
    if (!arm[route]) return json(res, 400, { error: "unknown route" });
    for (let i = 0; i < times; i++) arm[route].push(status);
    return json(res, 200, { ok: true, armed: arm[route].length });
  }
  if (req.method === "POST" && url.pathname === "/__ess/reset") {
    arm.transcribe.length = 0; arm.chat.length = 0; arm.responses.length = 0;
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/chat/completions") {
    counts.chat++;
    if (arm.chat.length) {
      const st = arm.chat.shift();
      res.writeHead(st, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa armed chat failure" }));
      return;
    }
    let body = {};
    try { body = rawBuf.length ? JSON.parse(rawBuf.toString("utf8")) : {}; } catch { body = {}; }
    const text = promptText(body);
    logPrompt("chat", text);
    const sm = sleepMsOf(text);
    if (sm) await sleep(sm);
    seq++;
    const out = chatContent(text);
    if (out.status) {
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: out.body }));
      return;
    }
    if (out.envelope) return json(res, 200, Object.assign({ id: "qa-ess-" + seq, usage: { prompt_tokens: 10, completion_tokens: 10 } }, out.envelope));
    return json(res, 200, { id: "qa-ess-" + seq, choices: [{ message: { role: "assistant", content: out.content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  }
  if (req.method === "POST" && url.pathname === "/responses") {
    counts.responses++;
    if (arm.responses.length) {
      const st = arm.responses.shift();
      res.writeHead(st, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa armed research failure" }));
      return;
    }
    let body = {};
    try { body = rawBuf.length ? JSON.parse(rawBuf.toString("utf8")) : {}; } catch { body = {}; }
    const input = typeof body.input === "string" ? body.input : "";
    if (input.includes("QA-RESEARCHERR")) return json(res, 500, { error: "qa research failure" });
    logPrompt("responses", input);
    const sm = sleepMsOf(input);
    if (sm) await sleep(sm);
    seq++;
    const output = [{ type: "message", content: [{ type: "output_text", text: "QA grounded claim line one.\nQA grounded claim line two." }] }];
    if (!input.includes("QA-NOSEARCH")) {
      output.unshift({ type: "web_search_call", results: [{ url: "https://qa.example/s1", title: "QA source one", snippet: "QA excerpt one." }, { url: "https://qa.example/s2", title: "QA source two", snippet: "QA excerpt two." }] });
    }
    return json(res, 200, { id: "qa-ess-resp-" + seq, output, usage: { input_tokens: 20, output_tokens: 20 } });
  }
  if (req.method === "POST" && url.pathname === "/asr/transcribe") {
    counts.transcribe++;
    if (arm.transcribe.length) {
      const st = arm.transcribe.shift();
      res.writeHead(st, { "content-type": "text/plain" });
      res.end("qa armed transcribe failure");
      return;
    }
    try {
      const mp = parseMultipart(rawBuf, String(req.headers["content-type"] || ""));
      let audioBytes = null;
      const partNames = mp ? mp.parts.map((p) => p.name) : [];
      if (mp) for (const p of mp.parts) if (p.name === "audio") audioBytes = p.body;
      let probe = { valid: false, sampleRate: 0, error: audioBytes ? "probe-failed" : "no-audio-part" };
      if (audioBytes) {
        const v = probeWav(audioBytes);
        probe = { valid: !!v.valid, sampleRate: v.sampleRate || 0, error: v.error || "" };
      }
      lastTranscribe = { n: counts.transcribe, validWav: probe.valid, sampleRate: probe.sampleRate, audioSha256: audioBytes ? crypto.createHash("sha256").update(audioBytes).digest("hex").slice(0, 16) : "", partNames, wavError: probe.error || "" };
    } catch { /* keep last */ }
    return json(res, 200, { transcript: "qa transcript", text: "qa transcript", audioProcessedMs: 2000 });
  }
  if (req.method === "POST" && url.pathname === "/images/generations") {
    counts.images++;
    return json(res, 200, { data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }] });
  }
  return json(res, 404, { error: "qa-ess: unknown route " + url.pathname });
});

server.listen(PORT, "127.0.0.1", () => console.log("qa essentials fake on 127.0.0.1:" + PORT));