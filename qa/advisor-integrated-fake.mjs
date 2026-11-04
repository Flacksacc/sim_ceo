// qa/advisor-integrated-fake.mjs - integrated fake for advisor-integrated QA ONLY (never shipped).
// F10 holds contract (851-final, CODE ONLY doc): __hold/__release/__holds retain overlap-A/B through
// observations; /chat completions awaits the held overlap marker up to 120s so backend rows stay
// live deterministically (both-live ONE snapshot, A-terminal/B-live ONE snapshot while B HELD until
// App consumption of its delivered /activity payload). No auto-expire inside the test window. Combines deterministic research compile (COMPILE-CHARACTER-PARAGRAPHS echoing name), YOUR TURN/bid pacing, and structured secretary JSON echoing the owned run marker. Reuses research 3-paragraph outputs + chat logs + QA-SLEEP pacing from qa/fake-provider and structured secretary schema from qa/secretary-fake. Primary starts it on 15302; this file never runs services itself.
import http from "node:http";
import { findDelimiters } from "./voice-multipart.mjs";
import fs from "node:fs";
import crypto from "node:crypto";

const argIdx = process.argv.indexOf("--port");
const PORT = Number(argIdx >= 0 ? process.argv[argIdx + 1] : 5199);
let seq = 0;
const counts = { chat: 0, responses: 0, transcribe: 0, images: 0 };
const promptLog = [];
const overlapHolds = { A: false, B: false };
const overlapWaiters = { A: [], B: [] };
function overlapHold(which) { if (which === "A") overlapHolds.A = true; else if (which === "B") overlapHolds.B = true; }
function overlapRelease(which) { const ws = (which === "A" ? overlapWaiters.A : which === "B" ? overlapWaiters.B : null); if (!ws) return false; if (which === "A") overlapHolds.A = false; else overlapHolds.B = false; while (ws.length > 0) { const fn = ws.shift(); try { fn(); } catch {} } return true; }
function overlapWait(which, timeoutMs) { if (which !== "A" && which !== "B") return Promise.resolve(); if (!overlapHolds[which]) return Promise.resolve(); const cap = Math.max(1000, Math.min(120000, Number(timeoutMs) || 120000)); return new Promise((resolve) => { const to = setTimeout(() => { try { const arr = overlapWaiters[which]; const ix = arr.indexOf(done); if (ix >= 0) arr.splice(ix, 1); } catch {} resolve(); }, cap); const done = () => { clearTimeout(to); resolve(); }; overlapWaiters[which].push(done); }); }
function overlapMarkerOf(prompt) { const t = String(prompt || ""); if (t.indexOf("overlap-A") >= 0) return "A"; if (t.indexOf("overlap-B") >= 0) return "B"; return ""; }
const DRAFT_SLEEP_ONLY = process.env.QA_DRAFT_SLEEP_ONLY === "1";
function isBidPrompt(p) { return /Reply with exactly YES or NO/.test(p || ""); }
function gateWait(text, kind) { const w = sleepMsOf(text, kind); return (DRAFT_SLEEP_ONLY && isBidPrompt(text)) ? 0 : w; }
function logPrompt(path, text) {
  try {
    promptLog.push({ t: Date.now(), path, draft: /YOUR TURN/.test(text || ""), bid: isBidPrompt(text || ""), sleep: sleepMsOf(text || ""), len: (text || "").length, full: (text || "").slice(0, 200000) });
    if (promptLog.length > 500) promptLog.splice(0, promptLog.length - 500);
  } catch { }
}
let lastTranscribe = { n: 0, bytes: 0, foundRiff: false, validWav: false, sampleRate: 0, channels: 0, bits: 0, dataBytes: 0, encoding: "", audioSha256: "", partNames: [], wavError: "" };

function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sleepMsOf(text, kind) {
  const t = text || "";
  if (kind) { const km = new RegExp("QA-SLEEP-" + kind + ":([0-9]+)").exec(t); if (km) return Math.min(Number(km[1]), 15000); }
  const m = /QA-SLEEP:([0-9]+)/.exec(t);
  return m ? Math.min(Number(m[1]), 15000) : 0;
}
function chatContent(prompt) {
  // Secretary structured JSON (Secretary.cs Parse: JSON object kind/title/body or question). Echoes owned run marker for correlation.
  if (prompt.includes("board secretary") || prompt.includes("OWNER REQUEST") || prompt.includes("OWNER QUESTION")) {
    var rawIdx = prompt.lastIndexOf("RAW OWNER INPUT:");
    var rawSeg = rawIdx >= 0 ? prompt.slice(rawIdx) : prompt;
    var briefIdx = prompt.lastIndexOf("BRIEFING TOPIC:");
    if (briefIdx >= 0) rawSeg = prompt.slice(briefIdx);
    var ansIdx = prompt.lastIndexOf("OWNER ANSWER:");
    if (ansIdx >= 0) {
      var origIdx = prompt.indexOf("ORIGINAL:", ansIdx);
      rawSeg = origIdx >= 0 ? prompt.slice(ansIdx, origIdx) : prompt.slice(ansIdx);
    }
    var runTok = /aiqa-[a-z0-9-]+/.exec(rawSeg || "") || /aiqa-[a-z0-9-]+/.exec(prompt || "") || [];
    var tok = runTok[0] || "";
    var echoSuffix = tok ? " [" + tok + "]" : "";
    if (rawSeg.includes("SECRETARY-BAD")) return { envelope: { choices: [] } };
    if (rawSeg.includes("SECRETARY-PLAIN")) return { content: "just some plain text, not json" };
    if (rawSeg.includes("SECRETARY-FENCED")) return { content: "```json\n{\"kind\":\"note\",\"title\":\"t\",\"body\":\"b\"}\n```" };
    if (rawSeg.includes("SECRETARY-ARRAY")) return { content: "[1,2,3]" };
    if (rawSeg.includes("SECRETARY-UNKNOWN")) return { content: JSON.stringify({ kind: "mystery", title: "t", body: "b" }) };
    if (rawSeg.includes("SECRETARY-CONTRADICTORY")) return { content: JSON.stringify({ kind: "note", title: "t", body: "b", question: "q?" }) };
    if (rawSeg.includes("SECRETARY-EMPTYBODY")) return { content: JSON.stringify({ kind: "note", title: "t", body: "" }) };
    if (rawSeg.includes("SECRETARY-SECOND-QUESTION")) return { content: JSON.stringify({ kind: "question", question: "QA second clarification?" }) };
    if (prompt.includes("CLARIFIED:") || prompt.includes("OWNER ANSWER")) {
      return { content: JSON.stringify({ kind: "note", title: "QA secretary note", body: "QA provisional note body for testing after clarification." + echoSuffix }) };
    }
    if (rawSeg.includes("SECRETARY-AMBIGUOUS")) return { content: JSON.stringify({ kind: "question", question: "QA clarification: what budget range applies?" }) };
    if (rawSeg.includes("SECRETARY-BRIEFING")) return { content: JSON.stringify({ kind: "briefing", title: "QA briefing", body: "QA briefing body with grounded support." + echoSuffix }) };
    return { content: JSON.stringify({ kind: "note", title: "QA secretary note", body: "QA provisional note body for testing." + echoSuffix }) };
  }
  if (prompt.includes("QA-ECHO-UTF8")) return { content: prompt };
  if (prompt.includes("Reply with exactly YES or NO")) {
    if (prompt.includes("QA-BIDERR")) return { status: 500, body: "qa bid failure" };
    return { content: prompt.includes("QA-NO") ? "NO - not relevant to this prompt." : "YES - directly relevant." };
  }
  if (prompt.includes("YOUR TURN")) {
    if (prompt.includes("QA-REPLYERR")) return { status: 500, body: "qa reply failure" };
    if (prompt.includes("QA-ABSTAIN")) return { content: "ABSTAIN" };
    return { content: "QA advisor reply with a clear position. [stance: Agrees]" };
  }
  if (prompt.includes("You guide Sim CEO board setup")) {
    if (prompt.includes("QA-REPLYERR")) return { status: 500, body: "qa interview failure" };
    if (prompt.includes("QA-BADENVELOPE")) return { envelope: { choices: [] } };
    if (prompt.includes("QA-BADJSON")) return { content: "this is not json at all {{{" };
    return {
      content: JSON.stringify({
        analysis: "QA analysis recorded.",
        updates: {},
        nextQuestion: "QA next question: what is missing?",
      }),
    };
  }
  if (prompt.includes("onboarding guide")) {
    return {
      content: JSON.stringify({ suggestion: "QA suggestion.", nextQuestion: "QA next?", fields: {} }),
    };
  }
  // Character-advisor compile: deterministic 3-paragraph JSON echoing the
  // researched name so QA can prove the draft round-trips into storage.
  if (prompt.includes("COMPILE-CHARACTER-PARAGRAPHS")) {
    if (prompt.includes("QA-COMPILEERR")) return { status: 500, body: "qa compile failure" };
    const nm = /character "([^"]+)"/.exec(prompt || "") || [];
    const who = nm[1] || "QA character";
    return { content: JSON.stringify({
      contributionCriteria: "QA-CRITERIA for " + who + ": contributes fleet logistics and port risk; abstains without port data.",
      reasoningApproach: "QA-REASON for " + who + ": compares options against port evidence; agrees when supported, challenges unsupported premises; never invents credentials.",
      responseStyle: "QA-STYLE for " + who + ": blunt about port risk, diplomatic with crew; detailed when evidence allows.",
    }) };
  }
  if (prompt.includes("Reply with exactly: OK")) return { content: "OK" };
  return { content: "QA provisional text." };
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(contentType || "");
  if (!m) return null;
  const boundary = (m[1] || m[2] || "").trim();
  if (!boundary) return null;
  // Strict shared scanner: closing `--boundary--` lines must be complete
  // (optional padding then CRLF/end); longer suffixes stay payload.
  const delims = findDelimiters(buf, boundary);
  const parts = [];
  for (let d = 0; d < delims.length; d++) {
    if (delims[d].close) break;
    const next = delims[d + 1];
    if (!next) break;
    const bodyStart = delims[d].head;
    let bodyEnd = next.at - 2;
    if (bodyEnd < bodyStart) bodyEnd = bodyStart;
    const s = buf.subarray(bodyStart, bodyEnd);
    const sep = s.indexOf(Buffer.from("\r\n\r\n"));
    if (sep < 0) continue;
    const head = s.subarray(0, sep).toString("latin1");
    const body = s.subarray(sep + 4);
    const m1 = /name\s*=\s*"?([^";\r\n]+)"?/.exec(head);
    const m2 = /filename\s*=\s*"?([^";\r\n]+)"?/.exec(head);
    parts.push({ name: m1 ? m1[1].trim() : "", filename: m2 ? m2[1].trim() : "", headers: head, body });
  }
  return { boundary, parts };
}


function validateWavBytes(wav) {
  const fail = (msg) => ({ valid: false, error: msg });
  if (!wav || wav.length < 44) return { ...fail("too-small"), valid: false };
  if (wav.toString("ascii", 0, 4) !== "RIFF") return { ...fail("no-riff"), valid: false };
  if (wav.toString("ascii", 8, 12) !== "WAVE") return { ...fail("no-wave"), valid: false };
  const riffSize = wav.readUInt32LE(4);
  if (riffSize !== wav.length - 8) return { ...fail("riff-size"), valid: false };
  let off = 12;
  let fmtFound = false;
  let dataFound = false;
  let af = 0, ch = 0, sr = 0, bits = 0, dsize = 0, dstart = -1;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    const total = 8 + size + (size % 2);
    if (off + total > wav.length) return { ...fail("bounds"), valid: false };
    if (id === "fmt ") {
      if (fmtFound) return { ...fail("dup-fmt"), valid: false };
      if (size < 16) return { ...fail("fmt-small"), valid: false };
      af = wav.readUInt16LE(off + 8);
      ch = wav.readUInt16LE(off + 10);
      sr = wav.readUInt32LE(off + 12);
      const br = wav.readUInt32LE(off + 16);
      const ba = wav.readUInt16LE(off + 20);
      bits = wav.readUInt16LE(off + 22);
      if (af !== 1 || ch !== 1 || bits !== 16 || (sr !== 16000 && sr !== 24000)) return { ...fail("fmt-props"), ch, sr, bits, af, valid: false };
      if (ba !== 2 || br !== sr * 2) return { ...fail("align"), valid: false };
      fmtFound = true;
    } else if (id === "data") {
      if (dataFound) return { ...fail("dup-data"), valid: false };
      dataFound = true;
      dsize = size; dstart = off + 8;
      if (dsize === 0) return { ...fail("empty"), valid: false };
      if (dsize % 2 !== 0) return { ...fail("odd"), valid: false };
    }
    off += total;
  }
  if (off !== wav.length) return { ...fail("trailing"), valid: false };
  if (!fmtFound || !dataFound) return { ...fail("missing"), valid: false };
  const frames = dsize / 2;
  if (frames > 300 * sr) return { ...fail("too-long"), valid: false };
  if (dstart < 0 || dstart + dsize > wav.length) return { ...fail("bounds"), valid: false };
  const total = Math.floor(Math.min(dsize / 2, sr * 10));
  let s2 = 0, nn = 0, z = 0, pv = 0;
  for (let i = 0; i < total; i++) {
    const sv = wav.readInt16LE(dstart + i * 2);
    s2 += sv * sv;
    if (sv !== 0) nn++;
    const sg = sv > 0 ? 1 : sv < 0 ? -1 : 0;
    if (i > 0 && sg !== 0 && pv !== 0 && sg !== pv) z++;
    if (sg !== 0) pv = sg;
  }
  const rms = total ? Math.sqrt(s2 / total) : 0;
  const dur = dsize / (sr * 2);
  const freq = total ? (z * sr) / (2 * total) : 0;
  return { valid: af === 1 && ch === 1 && bits === 16, ch, sr, bits, dsize, rms: Math.round(rms), nz: nn, zc: z, durSec: Math.round(dur * 100) / 100, freqEst: Math.round(freq) };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  if (req.method === "GET" && url.pathname === "/__health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, fake: true }));
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
  if (req.method === "GET" && url.pathname === "/__last-transcribe") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(lastTranscribe));
    return;
  }
  const rawBuf = await readRaw(req);
  if (req.method === "POST" && url.pathname === "/__hold") {
    let which = "";
    try { const bj = rawBuf.length ? JSON.parse(rawBuf.toString("utf8")) : {}; which = String(bj.which || ""); } catch { which = ""; }
    if (which !== "A" && which !== "B") { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "which must be A or B" })); return; }
    overlapHold(which);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, held: which, holds: overlapHolds }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/__release") {
    let which = "";
    try { const bj = rawBuf.length ? JSON.parse(rawBuf.toString("utf8")) : {}; which = String(bj.which || ""); } catch { which = ""; }
    if (which !== "A" && which !== "B") { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "which must be A or B" })); return; }
    overlapRelease(which);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, released: which, holds: overlapHolds }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/__holds") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ holds: overlapHolds, queuedA: overlapWaiters.A.length, queuedB: overlapWaiters.B.length }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/chat/completions") {
    counts.chat++;
    let body = {};
    try { body = rawBuf.length ? JSON.parse(rawBuf.toString("utf8")) : {}; } catch { body = {}; }
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    const prompt = msgs.map((m) => m.content).join("\n") || "";
    logPrompt("chat", prompt);
    const marker = overlapMarkerOf(prompt);
    if (marker) { try { await overlapWait(marker, 120000); } catch {} }
    const wait = gateWait(prompt, "C");
    if (wait) await sleep(wait);
    const out = chatContent(prompt);
    if (out.envelope) {
      seq++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Object.assign({ id: "qa-chat-" + seq, usage: { prompt_tokens: 10, completion_tokens: 10 } }, out.envelope)));
      return;
    }
    if (out.status) {
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: out.body }));
      return;
    }
    seq++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "qa-chat-" + seq,
      choices: [{ message: { role: "assistant", content: out.content } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/responses") {
    counts.responses++;
    let body = {};
    try { body = rawBuf.length ? JSON.parse(rawBuf.toString("utf8")) : {}; } catch { body = {}; }
    const input = typeof body?.input === "string" ? body.input : "";
    if (input.includes("QA-RESEARCHERR")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa research failure" }));
      return;
    }
    logPrompt("responses", input);
    if (/QA-SLEEP(-R)?:/.test(input)) await sleep(gateWait(input, "R"));
    seq++;
    const noSearch = input.includes("QA-NOSEARCH");
    const output = [
      { type: "message", content: [{ type: "output_text", text: "FACT | QA grounded claim line one about port risk || EVIDENCE: https://qa.example/s1 :: \"QA excerpt one.\"\nINTERPRETATION | QA grounded interpretation line two about crew || EVIDENCE: https://qa.example/s2 :: \"QA excerpt two.\"\nUNSUPPORTED | QA_UNVERIFIED_ONLY_SENTINEL has no evidence." }] },
    ];
    if (!noSearch) {
      output.unshift({
        type: "web_search_call",
        results: [
          { url: "https://qa.example/s1", title: "QA source one", snippet: "QA excerpt one. QA_CITATION_ONLY_SENTINEL unrelated context." },
          { url: "https://qa.example/s2", title: "QA source two", snippet: "QA excerpt two. QA_CITATION_ONLY_SECOND unrelated context." },
        ],
      });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "qa-resp-" + seq,
      output,
      usage: { input_tokens: 20, output_tokens: 20 },
    }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/asr/transcribe") {
    counts.transcribe++;
    try {
      const ctype = String(req.headers["content-type"] || "");
      const mp = parseMultipart(rawBuf, ctype);
      let audioBytes = null;
      let enc = "";
      let partNames = [];
      if (mp) {
        partNames = mp.parts.map((p) => p.name);
        for (const p of mp.parts) {
          if (p.name === "request") {
            try {
              const rj = JSON.parse(p.body.toString("utf8"));
              if (rj && typeof rj.audioEncoding === "string") enc = rj.audioEncoding;
              else if (rj && rj.model) enc = "";
            } catch { /* ignore */ }
          }
          if (p.name === "audio") audioBytes = p.body;
        }
      }
      let valid = false, sr = 0, ch = 0, bits = 0, dataBytes = 0, rms = 0, nz = 0, zc = 0, dur = 0, freq = 0, wavError = "";
      if (audioBytes) {
        const v = validateWavBytes(audioBytes);
        valid = !!v.valid;
        sr = v.sr || 0; ch = v.ch || 0; bits = v.bits || 0; dataBytes = v.dsize || 0;
        rms = v.rms || 0; nz = v.nz || 0; zc = v.zc || 0; dur = v.durSec || 0; freq = v.freqEst || 0;
        wavError = v.error || "";
      } else {
        wavError = "no-audio-part";
      }
      const sha = audioBytes ? crypto.createHash("sha256").update(audioBytes).digest("hex").slice(0, 16) : "";
      lastTranscribe = { n: counts.transcribe, bytes: rawBuf.length, audioBytes: audioBytes ? audioBytes.length : 0, foundRiff: !!audioBytes && audioBytes.indexOf(Buffer.from("RIFF")) >= 0, validWav: valid, sampleRate: sr, channels: ch, bits, dataBytes, encoding: enc, rms, nz, zc, durSec: dur, freqEst: freq, audioSha256: sha, partNames, wavError };
    } catch { /* keep last */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ transcript: "qa transcript", text: "qa transcript", audioProcessedMs: 2000 }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/images/generations") {
    counts.images++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }] }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "qa: unknown route " + url.pathname }));
});

server.listen(PORT, "127.0.0.1", () => console.log("qa fake provider on 127.0.0.1:" + PORT));
