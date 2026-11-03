// leg5: voice dictation essentials on REAL handlers (needs API+fake+PG).
// Strict WAV valid/reject matrix, draft-only transcript before Send, exact
// draft bytes, creator privacy, finalize once + 409, held-502 (armed fake)
// with no pair, then fresh retry with exactly one BOTH-ledger pair.
// Reuses the proven WAV builder at qa/voice-wav.mjs. Exit nonzero on ANY
// failure. Secure-mode safe (Bearer everywhere). No mic, no live providers.
import { makeWavMono16, wavStats } from "../../voice-wav.mjs";
import { makeCtx, API, get, post, camel, mustArray, registerOrLogin, digest, fakeJson } from "../helpers/essentials-http.mjs";

const ctx = makeCtx("leg5");
const run = "ess5-" + Date.now().toString(36);
const tokA = await registerOrLogin(ctx, post, run + "-va@qa.local", "qa-va-1");
const tokB = await registerOrLogin(ctx, post, run + "-vb@qa.local", "qa-vb-1");
ctx.ok("tokens-present", !!tokA && !!tokB, "digests=" + digest(tokA) + "/" + digest(tokB));

const b = await post("/api/boards", { name: run + "-board", mission: run + " mission", stage: "forming" }, { token: tokA });
ctx.ok("setup-board", b.status === 201 && !!camel(b.json, "id"), "status=" + b.status);
const bid = camel(b.json, "id");
const m = await post("/api/boards/" + bid + "/meetings", { title: run + " meeting", brief: "voice essentials" }, { token: tokA });
ctx.ok("setup-meeting", m.status === 201 && !!camel(m.json, "id"), "status=" + m.status);
const mid = camel(m.json, "id");

async function transcribe(midV, buf, filename, ctype, token) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 60000);
  try {
    const form = new FormData();
    form.append("audio", new Blob([buf], { type: ctype }), filename);
    const r = await fetch(API + "/api/meetings/" + midV + "/transcribe", { method: "POST", signal: ctl.signal, headers: { authorization: "Bearer " + token }, body: form });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
async function usageVoiceScoped() {
  const arr = mustArray(ctx, "usage-scoped", await get("/api/usage?meetingId=" + mid, { token: tokA }));
  return arr.filter((x) => String(camel(x, "kind") || "") === "voice-transcribe").length;
}
async function callsArr() {
  const arr = mustArray(ctx, "calls", await get("/api/models/calls?limit=200", { token: tokA }));
  ctx.ok("calls-complete-window", arr.length < 200, "len=" + arr.length);
  return arr;
}

// --- strict WAV: valid 16k + 24k accepted with real PCM audio ---
{
  const wav = makeWavMono16(16000, 1.0, 440);
  const st = wavStats(wav);
  ctx.ok("wav16-shape", st.found && st.sampleRate === 16000 && st.channels === 1 && st.bits === 16, JSON.stringify(st).slice(0, 160));
  ctx.ok("wav16-audio", st.rms > 1000 && st.nz > 1000, "rms=" + Math.round(st.rms));
  const r = await transcribe(mid, wav, "mic.wav", "audio/wav", tokA);
  ctx.ok("valid16-201", r.status === 201, "status=" + r.status + " " + String(r.text).slice(0, 200));
  ctx.ok("valid16-transcript", r.json && (camel(r.json, "transcript") === "qa transcript"), String(r.text).slice(0, 160));
  const wav24 = makeWavMono16(24000, 1.0, 440);
  const r24 = await transcribe(mid, wav24, "note.wav", "audio/wav", tokA);
  ctx.ok("valid24-201", r24.status === 201, "status=" + r24.status + " " + String(r24.text).slice(0, 200));
}

// --- rejects: no provider hit, no usage, no model calls ---
async function expectReject(name, buf, filename, ctype) {
  const c0 = await fakeJson("/__counts");
  const u0 = await usageVoiceScoped();
  const calls0 = await callsArr();
  const body0 = JSON.stringify(calls0);
  const r = await transcribe(mid, buf, filename, ctype, tokA);
  ctx.ok(name + "-4xx", r.status >= 400 && r.status < 500, "status=" + r.status + " " + String(r.text).slice(0, 160));
  const c1 = await fakeJson("/__counts");
  ctx.ok(name + "-no-provider", (c1.json.transcribe | 0) === (c0.json.transcribe | 0), JSON.stringify(c1.json));
  const u1 = await usageVoiceScoped();
  ctx.ok(name + "-no-usage", u1 === u0, "usage " + u0 + "->" + u1);
  const calls1 = await callsArr();
  ctx.ok(name + "-no-model-calls", JSON.stringify(calls1) === body0, "calls changed");
}
{
  const good = makeWavMono16(16000, 0.5, 440);
  const badRiff = Buffer.from(good); badRiff.write("XXXX", 0);
  await expectReject("bad-riff", badRiff, "mic.wav", "audio/wav");
  const trunc = Buffer.from(good.slice(0, 20));
  await expectReject("truncated", trunc, "mic.wav", "audio/wav");
  const stereo = Buffer.from(good);
  stereo.writeUInt16LE(2, 22); stereo.writeUInt32LE(16000 * 2 * 2, 28); stereo.writeUInt16LE(4, 32);
  await expectReject("stereo", stereo, "mic.wav", "audio/wav");
  const empty = Buffer.alloc(0);
  await expectReject("empty", empty, "mic.wav", "audio/wav");
  const webm = Buffer.from("this is not wav, fake webm payload 12345");
  await expectReject("webm-bytes", webm, "mic.webm", "audio/webm");
}

// --- draft-only transcript before Send: exact bytes, creator-private ---
const draftText = "draft note  " + run + "  caf\u00e9 \u4e2d\u6587\twith-tab";
let turnId = "";
{
  const d = await post("/api/meetings/" + mid + "/voice", { partial: draftText, retainAudio: false }, { token: tokA });
  ctx.ok("voice-draft-201", d.status === 201 && !!camel(d.json, "id"), "status=" + d.status + " " + String(d.text).slice(0, 200));
  turnId = camel(d.json, "id");
  ctx.ok("voice-draft-state", String(camel(d.json, "state") || camel(d.json, "State") || "draft") === "draft", String(d.text).slice(0, 160));
  const mine = mustArray(ctx, "voice-list-mine", await get("/api/meetings/" + mid + "/voice", { token: tokA }));
  const found = mine.find((x) => String(camel(x, "id")) === String(turnId));
  ctx.ok("voice-draft-exact", !!found && String(camel(found, "transcript") || camel(found, "partial")) === draftText, JSON.stringify(found).slice(0, 300));
  // Unsent draft is creator-private: another user must not see it.
  const other = mustArray(ctx, "voice-list-other", await get("/api/meetings/" + mid + "/voice", { token: tokB }));
  ctx.ok("voice-draft-private", !other.some((x) => String(camel(x, "transcript") || camel(x, "partial") || "").includes(run)), "other-len=" + other.length);
  // Draft-only: nothing posted as a meeting message yet.
  const msgs = mustArray(ctx, "messages-before-send", await get("/api/meetings/" + mid + "/messages?take=100", { token: tokA }));
  ctx.ok("draft-not-sent", !msgs.some((x) => String(camel(x, "content") || "").includes(draftText)), "len=" + msgs.length);
}

// --- finalize once posts the message; second finalize 409 ---
{
  const f = await post("/api/voice/" + turnId + "/finalize", { transcript: draftText }, { token: tokA });
  ctx.ok("finalize-200", f.status === 200, "status=" + f.status + " " + String(f.text).slice(0, 200));
  const msgs = mustArray(ctx, "messages-after-send", await get("/api/meetings/" + mid + "/messages?take=100", { token: tokA }));
  ctx.ok("finalize-posted-exact", msgs.some((x) => String(camel(x, "content") || "") === draftText), "len=" + msgs.length);
  const f2 = await post("/api/voice/" + turnId + "/finalize", { transcript: draftText }, { token: tokA });
  ctx.ok("finalize-again-409", f2.status === 409, "status=" + f2.status + " " + String(f2.text).slice(0, 160));
}

// --- held 502: armed fake failure -> API 502, no pair; fresh retry -> one pair ---
{
  const arm = await fakeJson("/__ess/arm", { method: "POST", body: { route: "transcribe", times: 1, status: 502 } });
  ctx.ok("fake-armed", arm.status === 200, "status=" + arm.status + " " + String(arm.text).slice(0, 120));
  const c0 = await fakeJson("/__counts");
  const u0 = await usageVoiceScoped();
  const calls0 = await callsArr();
  const body0 = JSON.stringify(calls0);
  const wav = makeWavMono16(16000, 0.5, 440);
  const held = await transcribe(mid, wav, "held.wav", "audio/wav", tokA);
  ctx.ok("held-502", held.status === 502, "status=" + held.status + " " + String(held.text).slice(0, 200));
  const uH = await usageVoiceScoped();
  ctx.ok("held-no-usage", uH === u0, "usage " + u0 + "->" + uH);
  const callsH = await callsArr();
  ctx.ok("held-no-model-calls", JSON.stringify(callsH) === body0, "calls changed");
  const cH = await fakeJson("/__counts");
  ctx.ok("held-provider-hit", (cH.json.transcribe | 0) === (c0.json.transcribe | 0) + 1, JSON.stringify(cH.json));
  // Fresh retry after the fault clears: exactly one new pair, prior rows intact.
  const retry = await transcribe(mid, wav, "held.wav", "audio/wav", tokA);
  ctx.ok("retry-201", retry.status === 201, "status=" + retry.status + " " + String(retry.text).slice(0, 200));
  const u1 = await usageVoiceScoped();
  ctx.ok("retry-one-usage", u1 === u0 + 1, "usage " + u0 + "->" + u1);
  const calls1 = await callsArr();
  ctx.ok("retry-one-call", calls1.length === calls0.length + 1, "before=" + calls0.length + " after=" + calls1.length);
  ctx.ok("retry-prior-rows-intact", JSON.stringify(calls1.slice(0, calls0.length)) === body0, "prior rows changed");
  const reset = await fakeJson("/__ess/reset", { method: "POST", body: {} });
  ctx.ok("fake-reset", reset.status === 200, "status=" + reset.status);
}

process.exit(ctx.verdict());