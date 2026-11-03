// leg5: voice dictation essentials on REAL handlers (needs API+fake+PG).
// Strict WAV valid/reject matrix (reuses proven `qa/voice-wav.mjs`),
// draft-only exact bytes, creator-private, finalize-once + 409, ARMED 502:
// the failed attempt bills exactly ONE FAILED pair when the provider was
// dispatched (shared nonzero GUID, status failed, prior rows intact -- never
// a zero-ledger expectation for real HTTP 502), then a FRESH retry bills
// exactly ONE successful pair. Correlated wait (API/proxy/ledger done, not
// the fake pre-completion counter) + ID-set compare (OrderByDescending(At):
// never last-row-as-new). Exit nonzero on ANY failure. Secure-mode safe
// (Bearer everywhere). No mic, no live providers.
import { makeWavMono16, wavStats } from "../../voice-wav.mjs";
import { makeCtx, API, get, post, camel, mustArray, registerOrLogin, digest, fakeJson, waitFor, ledgerSnapshot, sharedNewId, priorRowsIntact } from "../helpers/essentials-http.mjs";

const ctx = makeCtx("leg5");
const run = "ess5-" + Date.now().toString(36);
const tokA = await registerOrLogin(ctx, post, run + "-va@qa.local", "qa-va-1-pw12");
const tokB = await registerOrLogin(ctx, post, run + "-vb@qa.local", "qa-vb-1-pw12");
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
  const arr = mustArray(ctx, "usage-scoped", await get("/api/usage?meetingId=" + mid + "&purpose=voice-transcribe", { token: tokA }));
  return arr.filter((x) => String(camel(x, "kind") || "") === "voice-transcribe").length;
}
async function callsVoiceScoped() {
  const arr = mustArray(ctx, "calls-scoped", await get("/api/models/calls?limit=200&meetingId=" + mid + "&purpose=voice-transcribe", { token: tokA }));
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
  ctx.ok("valid24-201", r24.status === 201, "status=" + r24.status + " " + String(r.text).slice(0, 200));
}

// --- rejects: no provider hit, no usage, no model calls ---
async function expectReject(name, buf, filename, ctype) {
  const c0 = await fakeJson("/__counts");
  const u0 = await usageVoiceScoped();
  const calls0 = await callsVoiceScoped();
  const body0 = JSON.stringify(calls0);
  const r = await transcribe(mid, buf, filename, ctype, tokA);
  ctx.ok(name + "-4xx", r.status >= 400 && r.status < 500, "status=" + r.status + " " + String(r.text).slice(0, 160));
  const c1 = await fakeJson("/__counts");
  ctx.ok(name + "-no-provider", (c1.json.transcribe | 0) === (c0.json.transcribe | 0), JSON.stringify(c1.json));
  const u1 = await usageVoiceScoped();
  ctx.ok(name + "-no-usage", u1 === u0, "usage " + u0 + "->" + u1);
  const calls1 = await callsVoiceScoped();
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
  ctx.ok("voice-draft-exact", !!found && String(camel(found, "transcript") || camel(found, "partial")) === draftText, found ? JSON.stringify(found).slice(0, 300) : "draft missing");
  const gr = await post("/api/boards/" + bid + "/grants", { meetingId: null, userKey: run + "-vb@qa.local", access: "read" }, { token: tokA });
  ctx.ok("voice-grant-reader", gr.status === 201 || gr.status === 200, "status=" + gr.status + " " + String(gr.text).slice(0, 160));
  const other = mustArray(ctx, "voice-list-other", await get("/api/meetings/" + mid + "/voice", { token: tokB }));
  ctx.ok("voice-draft-private", !other.some((x) => String(camel(x, "transcript") || camel(x, "partial") || "").includes(run)), "other-len=" + other.length);
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

// --- held 502: armed fake failure bills ONE FAILED pair (dispatched), then
// fresh retry bills exactly ONE successful pair; prior rows intact ---
{
  const arm = await fakeJson("/__ess/arm", { method: "POST", body: { route: "transcribe", times: 1, status: 502 } });
  ctx.ok("fake-armed", arm.status === 200, "status=" + arm.status + " " + String(arm.text).slice(0, 120));
  const ledH0 = await ledgerSnapshot(ctx, "held-before", tokA, mid);
  const cH0 = await fakeJson("/__counts");
  const wav = makeWavMono16(16000, 0.5, 440);
  const held = await transcribe(mid, wav, "held.wav", "audio/wav", tokA);
  ctx.ok("held-502", held.status === 502, "status=" + held.status + " " + String(held.text).slice(0, 200));
  const cH = await fakeJson("/__counts");
  ctx.ok("held-provider-dispatched", (cH.json.transcribe | 0) === (cH0.json.transcribe | 0) + 1, JSON.stringify(cH.json));
  // Correlated wait: the FAILED pair (API + proxy + both ledgers) must land.
  const wH = await waitFor("held-failed-pair", async () => {
    const after = await ledgerSnapshot(ctx, "held-wait", tokA, mid);
    const s = sharedNewId(ledH0.calls, ledH0.usage, after.calls, after.usage);
    if (!s.ok) return { done: false, note: s.note };
    return { done: true, value: { after, shared: s } };
  }, { timeoutMs: 60000 });
  ctx.ok("held-failed-pair-correlated", wH.ok, String(wH.last || "").slice(0, 200));
  if (!wH.ok) throw new Error("held failed pair never correlated: " + wH.last);
  const { after: ledH1, shared: sH } = wH.value;
  ctx.ok("held-pair-shared-guid", !!sH.id && sH.id !== "00000000-0000-0000-0000-000000000000", "id=" + sH.id);
  ctx.ok("held-pair-status-failed", String(camel(sH.call, "status")) === "failed" && String(camel(sH.row, "status")) === "failed", "call=" + camel(sH.call, "status") + " usage=" + camel(sH.row, "status"));
  ctx.ok("held-pair-purpose", String(camel(sH.call, "purpose")) === "voice-transcribe" && String(camel(sH.row, "kind")) === "voice-transcribe", "call=" + camel(sH.call, "purpose"));
  ctx.ok("held-pair-scope", String(camel(sH.call, "meetingId")) === String(mid) && String(camel(sH.row, "meetingId")) === String(mid), "mid=" + mid);
  ctx.ok("held-prior-intact", priorRowsIntact(ledH0.calls, ledH1.calls) && priorRowsIntact(ledH0.usage, ledH1.usage), "calls " + ledH0.calls.length + "->" + ledH1.calls.length);
  // Fresh retry after the fault clears: exactly one NEW successful pair,
  // prior rows (incl. the failed pair) byte-intact below actual caps.
  const retry = await transcribe(mid, wav, "held.wav", "audio/wav", tokA);
  ctx.ok("retry-201", retry.status === 201, "status=" + retry.status + " " + String(retry.text).slice(0, 200));
  const wR = await waitFor("retry-success-pair", async () => {
    const after = await ledgerSnapshot(ctx, "retry-wait", tokA, mid);
    const s = sharedNewId(ledH1.calls, ledH1.usage, after.calls, after.usage);
    if (!s.ok) return { done: false, note: s.note };
    return { done: true, value: { after, shared: s } };
  }, { timeoutMs: 60000 });
  ctx.ok("retry-pair-correlated", wR.ok, String(wR.last || "").slice(0, 200));
  if (!wR.ok) throw new Error("retry pair never correlated: " + wR.last);
  const { after: ledR, shared: sR } = wR.value;
  ctx.ok("retry-pair-shared-guid", !!sR.id && sR.id !== sH.id, "retry=" + sR.id + " held=" + sH.id);
  ctx.ok("retry-pair-status-succeeded", String(camel(sR.call, "status")) === "succeeded" && String(camel(sR.row, "status")) === "succeeded", "status=" + camel(sR.call, "status"));
  ctx.ok("retry-prior-intact", priorRowsIntact(ledH1.calls, ledR.calls) && priorRowsIntact(ledH1.usage, ledR.usage), "calls " + ledH1.calls.length + "->" + ledR.calls.length);
  const reset = await fakeJson("/__ess/reset", { method: "POST", body: {} });
  ctx.ok("fake-reset", reset.status === 200, "status=" + reset.status);
}

process.exit(ctx.verdict());