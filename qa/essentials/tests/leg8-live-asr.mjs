// leg8: LIVE provider gate (OFF by default): small bounded Meta TEXT response
// + REAL spoken-WAV ASR through the ACTUAL app routes (needs API+PG; runner
// managed leg; no fake needed for provider calls).
// Arms ONLY when ESS_QA_LIVE=1 AND META_API_KEY is present in THIS child env
// (the runner forwards the primary-supplied app key ONLY to the leg8 API +
// leg env, captured-then-stripped so nothing else inherits it). The leg reads
// the key from process env ONLY, never from files, never the inherited
// coding-profile key; it never logs secrets, full env, or provider request
// headers. No image calls, no new services. Windows TTS synthesizes the real
// spoken WAV (never claim a live hardware mic). Small bounded model text +
// one short utterance; ledger checks + source identity; owned exclusive DB
// and lifecycle (runner drops the DB in cleanup); no user 5080/data writes.
// The paid gate is NEVER run by QA itself: without explicit arming this leg
// SKIPs with exit 0. Exit nonzero on ANY failure once armed.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeCtx, API, get, post, camel, mustArray, registerOrLogin, waitFor, ledgerSnapshot, newPairsComplete, priorRowsIntact, sha256 } from "../helpers/essentials-http.mjs";
import { wavStats } from "../../voice-wav.mjs";

const ctx = makeCtx("leg8");
const ART = process.env.ESS_QA_ARTIFACT_DIR || ".";
const run = "ess8-" + Date.now().toString(36);
const writeArt = (name, obj) => {
  try { fs.writeFileSync(path.join(ART, name), typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)); }
  catch (e) { ctx.ok("artifact-" + name, false, String(e).slice(0, 160)); }
};

if (process.env.ESS_QA_LIVE !== "1") {
  console.log("ESSENTIALS-leg8 SKIP (OFF default; arm ONLY with ESS_QA_LIVE=1 plus the primary-supplied app key via runner child env; QA never runs the paid gate itself)");
  process.exit(0);
}
const liveKeyPresent = !!process.env.META_API_KEY;
ctx.ok("live-key-present", liveKeyPresent, "META_API_KEY present in child env (value never logged)");
if (!liveKeyPresent) { ctx.ok("live-key-required", false, "armed but no key; primary supplies the app key via child env AFTER deterministic final builds"); process.exit(ctx.verdict()); }

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
async function uploadPortrait(token, rosterId) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "qa.png");
    const r = await fetch(API + "/api/roster/" + rosterId + "/image/upload", { method: "POST", signal: ctl.signal, headers: { authorization: "Bearer " + token }, body: form });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}

// QA-owned narrow PCM resampler: 22.05kHz mono 16-bit (Windows TTS default)
// -> strict 16kHz mono 16-bit WAV the app accepts. Linear interpolation,
// deterministic, no external tools. Parses RIFF honestly; refuses non-PCM.
function resamplePcm16Mono(raw, outRate) {
  const u16 = (o) => raw[o] | (raw[o + 1] << 8);
  const u32 = (o) => (raw[o] | (raw[o + 1] << 8) | (raw[o + 2] << 16) | (raw[o + 3] << 24)) >>> 0;
  const str = (o, n) => String.fromCharCode(...raw.subarray(o, o + n));
  if (str(0, 4) !== "RIFF" || str(8, 4) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let pos = 12, inRate = 0, ch = 0, bits = 0, fmt = 0, data = null;
  while (pos + 8 <= raw.length) {
    const id = str(pos, 4), size = u32(pos + 4);
    if (id === "fmt ") { fmt = u16(pos + 8); ch = u16(pos + 10); inRate = u32(pos + 12); bits = u16(pos + 22); }
    else if (id === "data") { data = raw.subarray(pos + 8, pos + 8 + size); }
    pos += 8 + size + (size % 2);
  }
  if (fmt !== 1 || ch !== 1 || bits !== 16 || !data) throw new Error("TTS raw must be PCM16 mono (fmt=" + fmt + " ch=" + ch + " bits=" + bits + ")");
  const nIn = Math.floor(data.length / 2);
  const nOut = Math.floor(nIn * outRate / inRate);
  const out = Buffer.alloc(44 + nOut * 2);
  out.write("RIFF", 0); out.writeUInt32LE(36 + nOut * 2, 4); out.write("WAVE", 8);
  out.write("fmt ", 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(outRate, 24); out.writeUInt32LE(outRate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36); out.writeUInt32LE(nOut * 2, 40);
  const s = (i) => { const v = data[i * 2] | (data[i * 2 + 1] << 8); return v >= 32768 ? v - 65536 : v; };
  for (let i = 0; i < nOut; i++) {
    const p = (i * inRate) / outRate;
    const i0 = Math.min(Math.floor(p), nIn - 2);
    const f = Math.min(Math.max(p - i0, 0), 1);
    const v = Math.round(s(i0) * (1 - f) + s(i0 + 1) * f);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), 44 + i * 2);
  }
  return out;

// QA-owned TTS synthesis (Windows Speech): real spoken words rendered with
// the installed desktop voice to a WAV file, then honestly resampled to the
// strict 16kHz mono 16-bit shape the app accepts. No hardware mic is claimed.
function synthSpeech(text, wavPath) {
  const rawPath = wavPath + ".raw22k.wav";
  const ps1 = path.join(ART, "tts-synth.ps1");
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$synth.SetOutputToWaveFile('" + rawPath.replace(/'/g, "''") + "')",
    "$synth.Speak('" + text.replace(/'/g, "''") + "')",
    "$synth.Dispose()",
    "Write-Output 'TTS-DONE'",
  ].join("\r\n");
  fs.writeFileSync(ps1, script);
  const out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { windowsHide: true, timeout: 120000, encoding: "utf8", stdio: "pipe" });
  if (!String(out).includes("TTS-DONE")) throw new Error("TTS synthesis produced no completion marker");
  const raw = fs.readFileSync(rawPath);
  const strict = resamplePcm16Mono(raw, 16000);
  fs.writeFileSync(wavPath, strict);
  fs.rmSync(rawPath);
}
}


try {
  const tokA = await registerOrLogin(ctx, post, run + "-live@qa.local", "qa-live-1-pw12");
  ctx.ok("token-present", !!tokA, "live user registered");
  // READY setup (proven helper flow): secretary/run/transcribe refuse
  // incomplete setup, so the live gate proves them on a valid board.
  const b = await post("/api/boards", { name: run + "-board", mission: run + " mission", stage: "forming" }, { token: tokA });
  ctx.ok("setup-board", b.status === 201 && !!camel(b.json, "id"), "status=" + b.status);
  const bid = camel(b.json, "id");
  const ld = await post("/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Chief", background: "bg", familiarTopics: "fam", simplerTopics: "sim", commPrefs: "direct" }, { token: tokA });
  ctx.ok("setup-lead", ld.status === 200, "status=" + ld.status);
  const q = await post("/api/roster/quick", { accountId: "00000000-0000-0000-0000-000000000000", name: run + "-adv", description: "advisor helping with " + run + " strategy work" }, { token: tokA });
  ctx.ok("setup-advisor-quick", q.status === 201, "status=" + q.status);
  const rid = camel(q.json, "id");
  const up = await uploadPortrait(tokA, rid);
  ctx.ok("setup-portrait", up.status === 201, "status=" + up.status);
  const imgs = mustArray(ctx, "setup-images", await get("/api/roster/" + rid + "/images", { token: tokA }));
  const rev = await post("/api/images/" + camel(imgs[0], "id") + "/review", { decision: "accept" }, { token: tokA });
  ctx.ok("setup-accept", rev.status === 200, "status=" + rev.status);
  const cp = await post("/api/roster/" + rid + "/copy", { boardId: bid, boardRole: "Strategist" }, { token: tokA });
  ctx.ok("setup-copy", cp.status === 201, "status=" + cp.status + " " + String(cp.text).slice(0, 160));
  const ap = await post("/api/boards/" + bid + "/advisors/" + camel(cp.json, "id") + "/approve", {}, { token: tokA });
  ctx.ok("setup-approve", ap.status === 200, "status=" + ap.status);
  const m = await post("/api/boards/" + bid + "/meetings", { title: run + " meeting", brief: "live asr gate" }, { token: tokA });
  ctx.ok("setup-meeting", m.status === 201 && !!camel(m.json, "id"), "status=" + m.status);
  const mid = camel(m.json, "id");

  // --- small bounded TEXT response through the real provider ---
  const ledT0 = await ledgerSnapshot(ctx, "text0", tokA, mid);
  const t0 = Date.now();
  const r = await post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "In one sentence, what is the single most important next step for this board?" }, { token: tokA, timeout: 180000 });
  const tMs = Date.now() - t0;
  ctx.ok("live-text-200", r.status === 200, "status=" + r.status + " ms=" + tMs + " " + String(r.text).slice(0, 200));
  writeArt("live-text.json", { ms: tMs, body: String(r.text).slice(0, 2000) });
  const wT = await waitFor("live-text-pairs", async () => {
    const after = await ledgerSnapshot(ctx, "live-text-wait", tokA, mid);
    const s = newPairsComplete(ledT0.calls, ledT0.usage, after.calls, after.usage);
    if (!s.ok || s.pairs.length < 1) return { done: false, note: s.note };
    return { done: true, value: { after, pairs: s.pairs } };
  }, { timeoutMs: 120000 });
  ctx.ok("live-text-pairs-complete", wT.ok, String(wT.last || "").slice(0, 200));
  if (!wT.ok) throw new Error("live text pairs never completed");
  for (const p of wT.value.pairs) {
    ctx.ok("live-text-pair-status-" + camel(p.call, "purpose"), String(camel(p.call, "status")) === "succeeded", "status=" + camel(p.call, "status"));
    ctx.ok("live-text-pair-source-" + camel(p.call, "purpose"), !!camel(p.call, "model") && String(camel(p.call, "meetingId")) === String(mid), "model=" + camel(p.call, "model") + " mid set");
    ctx.ok("live-text-pair-scope-" + camel(p.call, "purpose"), String(camel(p.row, "meetingId")) === String(mid), "usage scope set");
  }
  ctx.ok("live-text-prior-intact", priorRowsIntact(ledT0.calls, wT.value.after.calls) && priorRowsIntact(ledT0.usage, wT.value.after.usage), "rows preserved");

  // --- REAL spoken WAV through the actual app transcribe route ---
  const spoken = "The board approved the charter for the eastern route";
  const wavPath = path.join(ART, "live-spoken.wav");
  synthSpeech(spoken, wavPath);
  const wavBuf = fs.readFileSync(wavPath);
  ctx.ok("tts-wav-bounds", wavBuf.length > 10000 && wavBuf.length < 4 * 1024 * 1024, "bytes=" + wavBuf.length);
  const st = wavStats(wavBuf);
  ctx.ok("tts-wav-strict", st.found && st.sampleRate === 16000 && st.channels === 1 && st.bits === 16 && st.rms > 200, JSON.stringify(st).slice(0, 200));
  ctx.ok("tts-wav-spoken", st.nz > 1000, "non-silent samples present (real synthesized speech, no hardware mic claimed)");
  writeArt("live-tts.json", { bytes: wavBuf.length, stats: st, sha256: sha256(wavBuf) });
  const ctl = new AbortController();
  const tt = setTimeout(() => ctl.abort(), 180000);
  let tr = null;
  try {
    const form = new FormData();
    form.append("audio", new Blob([wavBuf], { type: "audio/wav" }), "spoken.wav");
    const rr = await fetch(API + "/api/meetings/" + mid + "/transcribe", { method: "POST", signal: ctl.signal, headers: { authorization: "Bearer " + tokA }, body: form });
    const text = await rr.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    tr = { status: rr.status, json, text };
  } finally { clearTimeout(tt); }
  ctx.ok("live-asr-201", tr.status === 201, "status=" + tr.status + " " + String(tr.text).slice(0, 300));
  const transcript = String((tr.json && (camel(tr.json, "transcript") || camel(tr.json, "Transcript"))) || "");
  ctx.ok("live-asr-nonempty", transcript.trim().length > 0, "transcript=" + transcript.slice(0, 200));
  const keys = ["board", "approved", "charter", "eastern", "route"];
  const hits = keys.filter((k) => transcript.toLowerCase().includes(k));
  ctx.ok("live-asr-spoken-words", hits.length >= 2, "keyword hits=" + hits.length + "/5 [" + hits.join(",") + "] transcript=" + transcript.slice(0, 200));
  writeArt("live-transcript.txt", "SPOKEN=" + spoken + "\nTRANSCRIPT=" + transcript + "\n");
  const wV = await waitFor("live-asr-pair", async () => {
    const after = await ledgerSnapshot(ctx, "live-asr-wait", tokA, mid);
    const s = newPairsComplete(wT.value.after.calls, wT.value.after.usage, after.calls, after.usage);
    if (!s.ok || s.pairs.length !== 1) return { done: false, note: s.note };
    return { done: true, value: { after, pair: s.pairs[0] } };
  }, { timeoutMs: 120000 });
  ctx.ok("live-asr-pair-complete", wV.ok, String(wV.last || "").slice(0, 200));
  if (!wV.ok) throw new Error("live asr pair never completed");
  const pv = wV.value.pair;
  ctx.ok("live-asr-pair-status", String(camel(pv.call, "status")) === "succeeded", "status=" + camel(pv.call, "status"));
  ctx.ok("live-asr-pair-purpose", String(camel(pv.call, "purpose")) === "voice-transcribe" && String(camel(pv.row, "kind")) === "voice-transcribe", "purpose=" + camel(pv.call, "purpose"));
  ctx.ok("live-asr-pair-source", !!camel(pv.call, "model") && String(camel(pv.call, "meetingId")) === String(mid), "model=" + camel(pv.call, "model"));
  ctx.ok("live-asr-prior-intact", priorRowsIntact(wT.value.after.calls, wV.value.after.calls) && priorRowsIntact(wT.value.after.usage, wV.value.after.usage), "rows preserved");
  // Provider surface used by THIS leg is exactly the two intended routes:
  // discussion/run (chat) and transcribe (asr). No image calls, no new
  // services: every new meeting-scoped pair purpose is accounted for.
  {
    const calls = mustArray(ctx, "live-calls-final", await get("/api/models/calls?limit=200&meetingId=" + mid, { token: tokA }));
    const ours = calls.filter((c) => ![...wT.value.after.calls, ...wV.value.after.calls].some((b) => String(camel(b, "id")) === String(camel(c, "id"))));
    void ours;
    const purposes = wT.value.pairs.map((p) => String(camel(p.call, "purpose"))).concat([String(camel(pv.call, "purpose"))]).sort().join(",");
    ctx.ok("live-purposes-exact", purposes === "advisor-bid,advisor-reply,voice-transcribe", "purposes=" + purposes);
  }
  // The draft turn is creator-private and exact.
  {
    const turns = mustArray(ctx, "live-turns", await get("/api/meetings/" + mid + "/voice", { token: tokA }));
    const mine = turns.find((x) => String(camel(x, "transcript") || "") === transcript);
    ctx.ok("live-turn-exact", !!mine, "turn present with exact transcript, count=" + turns.length);
  }
} catch (e) {
  ctx.ok("leg8-fatal", false, String((e && e.message) || e).slice(0, 400));
}

process.exit(ctx.verdict());
