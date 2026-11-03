import { makeWavMono16, wavStats } from "./voice-wav.mjs";
const API = process.env.QA_API || "http://127.0.0.1:5115";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:5206";
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
async function jget(url) {
  const r = await fetch(url, { headers: { "x-user": "owner" } });
  const t = await r.text();
  let j = null;
  try { j = t ? JSON.parse(t) : null; } catch { j = null; }
  return { status: r.status, json: j, text: t };
}
async function requireArray(url, label) {
  const r = await jget(url);
  const isArr = r.status === 200 && Array.isArray(r.json);
  ok(label + "-shape", isArr, "status=" + r.status + " body=" + String(r.text).slice(0, 200));
  if (!isArr) throw new Error(label + " ledger shape invalid");
  return r.json;
}
async function postTranscribe(mid, buf, filename, ctype) {
  const form = new FormData();
  form.append("audio", new Blob([buf], { type: ctype }), filename);
  const r = await fetch(API + "/api/meetings/" + mid + "/transcribe", {
    method: "POST", headers: { "x-user": "owner" }, body: form,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, json, text };
}
const run = "v-" + Date.now().toString(36);
const b = await (await fetch(API + "/api/boards", { method: "POST", headers: { "content-type": "application/json", "x-user": "owner" }, body: JSON.stringify({ name: run + "-b", mission: run + " mission", stage: "qa" }) })).json();
const bid = b.id || b.Id;
ok("seed-board", !!bid, JSON.stringify(b).slice(0, 200));
const m = await (await fetch(API + "/api/boards/" + bid + "/meetings", { method: "POST", headers: { "content-type": "application/json", "x-user": "owner" }, body: JSON.stringify({ title: run + " mtg", brief: "voice qa brief" }) })).json();
const mid = m.id || m.Id;
ok("seed-meeting", !!mid, JSON.stringify(m).slice(0, 200));
async function counts() {
  const r = await jget(FAKE + "/__counts");
  ok("fake-counts-shape", r.status === 200 && r.json && typeof r.json.transcribe === "number", "status=" + r.status + " " + String(r.text).slice(0, 160));
  return r.json;
}
async function usageVoiceScoped() {
  const arr = await requireArray(API + "/api/usage?meetingId=" + mid, "usage-scoped");
  return arr.filter((x) => ((x.kind ?? x.Kind) || "") === "voice-transcribe").length;
}
async function callsArr(label) {
  // Unrestricted-ledger proof requires the returned array to be COMPLETE:
  // the endpoint caps at 200 rows, so a length strictly below 200 proves the
  // visible array is the whole ledger and equality is not a capped false pass.
  const arr = await requireArray(API + "/api/models/calls", label || "calls");
  return arr;
}
async function callsShape() {
  const arr = await requireArray(API + "/api/models/calls", "calls");
  if (arr.length > 0) {
    const e = arr[0];
    const hasModel = (e.model !== undefined || e.Model !== undefined) && (e.purpose !== undefined || e.Purpose !== undefined);
    ok("calls-entry-shape", hasModel, JSON.stringify(e).slice(0, 200));
  } else {
    ok("calls-entry-shape", true);
  }
  return arr;
}
{
  const wav = makeWavMono16(16000, 1.0, 440);
  const st = wavStats(wav);
  ok("wav16-header", st.found && st.sampleRate === 16000 && st.channels === 1 && st.bits === 16, JSON.stringify(st).slice(0, 200));
  ok("wav16-audio", st.rms > 1000 && st.nz > 1000, "rms=" + Math.round(st.rms) + " nz=" + st.nz);
  const c0 = await counts();
  const u0 = await usageVoiceScoped();
  { const echoPrompt = "QA-ECHO-UTF8 caf\u00e9 \u4e2d\u6587"; const er = await fetch(FAKE + "/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: echoPrompt }] }) }); const et = await er.text(); let ej = null; try { ej = et ? JSON.parse(et) : null; } catch { ej = null; } const echoBack = ej && ej.choices && ej.choices[0] && ej.choices[0].message ? ej.choices[0].message.content : ""; ok("fake-utf8-echo", er.status === 200 && typeof echoBack === "string" && echoBack.includes("caf\u00e9") && echoBack.includes("\u4e2d\u6587"), er.status + " " + String(et).slice(0, 200)); }
await callsShape();
  const r = await postTranscribe(mid, wav, "mic.wav", "audio/wav");
  ok("valid16-201", r.status === 201, r.status + " " + r.text.slice(0, 200));
  ok("valid16-transcript", r.json && (r.json.transcript || r.json.Transcript) === "qa transcript", r.text.slice(0, 200));
  const c1 = await counts();
  ok("valid16-provider-hit", (c1.transcribe || 0) === (c0.transcribe || 0) + 1, JSON.stringify(c1));
  const last = await jget(FAKE + "/__last-transcribe");
  ok("valid16-fake-shape", last.status === 200 && last.json && typeof last.json.n === "number", "status=" + last.status);
  ok("valid16-fresh-hit", last.json && last.json.n === c1.transcribe, "n=" + (last.json && last.json.n) + " counts=" + c1.transcribe);
  ok("valid16-fake-wav", last.json && last.json.validWav === true && last.json.sampleRate === 16000, JSON.stringify(last.json).slice(0, 300));
  ok("valid16-fake-encoding", last.json && String(last.json.encoding || "").toUpperCase() === "WAV", JSON.stringify(last.json).slice(0, 200));
  ok("valid16-fake-parts", last.json && Array.isArray(last.json.partNames) && last.json.partNames.includes("audio") && last.json.partNames.includes("request"), JSON.stringify(last.json && last.json.partNames));
  const u1 = await usageVoiceScoped();
  ok("valid16-metered-scoped", u1 === u0 + 1, "usage " + u0 + "->" + u1);
}
{
  const wav = makeWavMono16(24000, 1.0, 440);
  const c0 = await counts();
  const u0 = await usageVoiceScoped();
  const r = await postTranscribe(mid, wav, "note.wav", "audio/wav");
  ok("valid24-201", r.status === 201, r.status + " " + r.text.slice(0, 200));
  const c1 = await counts();
  ok("valid24-provider-hit", (c1.transcribe || 0) === (c0.transcribe || 0) + 1, JSON.stringify(c1));
  const last = await jget(FAKE + "/__last-transcribe");
  ok("valid24-fresh-hit", last.json && last.json.n === c1.transcribe && last.json.sampleRate === 24000, JSON.stringify(last.json).slice(0, 300));
  const u1 = await usageVoiceScoped();
  ok("valid24-metered-scoped", u1 === u0 + 1, "usage " + u0 + "->" + u1);
}
function withRiffDelta(buf, delta) {
  const b = Buffer.from(buf);
  b.writeUInt32LE(b.readUInt32LE(4) + delta, 4);
  return b;
}
function appendTrailing(bad) {
  const good = makeWavMono16(16000, 0.5, 440);
  const extra = Buffer.from(bad, "ascii");
  const out = Buffer.concat([good, extra]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}
function junkMissingPad() {
  const good = makeWavMono16(16000, 0.5, 440);
  const dataIdx = good.indexOf(Buffer.from("data"));
  const head = good.subarray(0, dataIdx);
  const dataChunk = good.subarray(dataIdx);
  const junk = Buffer.alloc(8 + 1);
  junk.write("JUNK", 0);
  junk.writeUInt32LE(1, 4);
  junk[8] = 65;
  const out = Buffer.concat([head, junk, dataChunk]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}
function duplicateData() {
  const good = makeWavMono16(16000, 0.5, 440);
  const dup = Buffer.alloc(8 + 2);
  dup.write("data", 0);
  dup.writeUInt32LE(2, 4);
  dup.writeInt16LE(100, 8);
  const out = Buffer.concat([good, dup]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}
function duplicateFmt() {
  const good = makeWavMono16(16000, 0.5, 440);
  const fmtChunk = good.subarray(12, 36);
  const rest = good.subarray(36);
  const head = good.subarray(0, 12);
  const out = Buffer.concat([head, fmtChunk, fmtChunk, rest]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}
function maxDurPlusOneFrame() {
  const sr = 16000;
  const n = sr * 300 + 1;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(1000, 44 + i * 2);
  return buf;
}
async function expectReject(name, buf, filename, ctype, wantStatus) {
  const c0 = await counts();
  const u0 = await usageVoiceScoped();
  // Exclusive fresh owned API process + strictly-below-cap length BEFORE
  // every negative proves the compared array is the complete ledger.
  const calls0 = await callsArr(name + "-calls0");
  ok(name + "-ledger-complete", calls0.length < 200, "len=" + calls0.length);
  const calls0Body = JSON.stringify(calls0);
  const r = await postTranscribe(mid, buf, filename, ctype);
  const is4xx = r.status >= 400 && r.status < 500;
  ok(name + "-4xx", is4xx && (wantStatus ? r.status === wantStatus : true), r.status + " " + r.text.slice(0, 160));
  const c1 = await counts();
  ok(name + "-no-provider", (c1.transcribe || 0) === (c0.transcribe || 0), JSON.stringify(c1));
  const last = await jget(FAKE + "/__last-transcribe");
  ok(name + "-no-fresh-hit", !last.json || last.json.n === (c0.transcribe || 0), "lastN=" + (last.json && last.json.n) + " base=" + c0.transcribe);
  const u1 = await usageVoiceScoped();
  ok(name + "-no-usage", u1 === u0, "usage " + u0 + "->" + u1);
  const calls1 = await callsArr(name + "-calls1");
  ok(name + "-ledger-still-complete", calls1.length < 200, "len=" + calls1.length);
  ok(name + "-no-model-calls", JSON.stringify(calls1) === calls0Body, "calls changed");
}

{
  const good = makeWavMono16(16000, 0.5, 440);
  const badRiff = Buffer.from(good); badRiff.write("XXXX", 0);
  await expectReject("bad-riff", badRiff, "mic.wav", "audio/wav", 400);
  const trunc = Buffer.from(good.slice(0, 20));
  await expectReject("truncated", trunc, "mic.wav", "audio/wav", 400);
  const floatWav = Buffer.from(good); floatWav.writeUInt16LE(3, 20);
  await expectReject("float-fmt", floatWav, "mic.wav", "audio/wav", 400);
  const stereo = Buffer.from(good);
  stereo.writeUInt16LE(2, 22); stereo.writeUInt32LE(16000 * 2 * 2, 28); stereo.writeUInt16LE(4, 32);
  await expectReject("stereo", stereo, "mic.wav", "audio/wav", 400);
  const rate8k = Buffer.from(good); rate8k.writeUInt32LE(8000, 24); rate8k.writeUInt32LE(8000 * 2, 28);
  await expectReject("rate-8k", rate8k, "mic.wav", "audio/wav", 400);
  const oddBounded = Buffer.from(good);
  const ds = oddBounded.readUInt32LE(40);
  oddBounded.writeUInt32LE(ds - 1, 40);
  await expectReject("odd-data", oddBounded, "mic.wav", "audio/wav", 400);
  const webm = Buffer.from("this is not wav, it is a fake webm payload 12345");
  await expectReject("webm-bytes", webm, "mic.webm", "audio/webm", 400);
  const empty = Buffer.alloc(0);
  await expectReject("empty", empty, "mic.wav", "audio/wav", 400);
  const corrupt = Buffer.from(good); corrupt.writeUInt32LE(0xFFFFFF, 16);
  await expectReject("chunk-bounds", corrupt, "mic.wav", "audio/wav", 400);
  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 65);
  await expectReject("oversize", big, "mic.wav", "audio/wav", 400);
  await expectReject("riff-minus-1", withRiffDelta(good, -1), "mic.wav", "audio/wav", 400);
  await expectReject("riff-plus-1", withRiffDelta(good, 1), "mic.wav", "audio/wav", 400);
  await expectReject("trailing-bad", appendTrailing("BAD"), "mic.wav", "audio/wav", 400);
  await expectReject("junk-missing-pad", junkMissingPad(), "mic.wav", "audio/wav", 400);
  await expectReject("dup-data", duplicateData(), "mic.wav", "audio/wav", 400);
  await expectReject("dup-fmt", duplicateFmt(), "mic.wav", "audio/wav", 400);
  await expectReject("maxdur-plus-1-frame", maxDurPlusOneFrame(), "mic.wav", "audio/wav", 400);
}
await callsShape();
console.log(fail === 0 ? "VOICEHTTP PASS " + pass : "VOICEHTTP FAIL pass=" + pass + " fail=" + fail);
for (const f of failures) console.log(" - " + f);
process.exit(fail === 0 ? 0 : 1);
