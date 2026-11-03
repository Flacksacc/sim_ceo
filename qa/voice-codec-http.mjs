import { makeWavMono16, wavStats } from "./voice-wav.mjs";
const API = process.env.QA_API || "http://127.0.0.1:5125";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:5225";
let pass = 0, fail = 0;
const failures = [];
// Fourth repair: voice HTTP QA owns loopback API 5125 + fake 5225 only.
// Refuse user/dev ports before any dispatch.
for (const [v, port, label] of [[API, 5125, "api"], [FAKE, 5225, "fake"]]) {
  let u = null;
  try { u = new URL(v); } catch { u = null; }
  // Bracket-tolerant loopback: URL keeps IPv6 brackets in hostname.
  const host = u ? String(u.hostname).replace(/^\[/, "").replace(/\]$/, "") : "";
  const loop = !!u && (host === "127.0.0.1" || host === "localhost" || host === "::1");
  const rooted = !!u && u.pathname === "/";
  const protoOk = !!u && u.protocol === "http:";
  const secrets = !!u && (u.username !== "" || u.password !== "" || (u.search !== "" && u.search !== "?") || u.hash !== "");
  if (!u || !loop || !rooted || !protoOk || secrets || Number(u.port) !== port || /:(5080|5173)\b/.test(String(v))) {
    console.log("  FAIL " + label + "-owns-port :: must be http loopback :" + port + " root no-userinfo/query/fragment (raw value withheld)");
    process.exit(2);
  }
}
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
  const keys = r.json ? Object.keys(r.json).sort() : [];
  ok("fake-counts-shape", r.status === 200 && r.json && typeof r.json.transcribe === "number" && JSON.stringify(keys) === JSON.stringify(["chat", "images", "responses", "transcribe"]), "status=" + r.status + " " + String(r.text).slice(0, 160));
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
// Server-scoped voice ledgers: filtered server-side by meeting AND purpose,
// so the returned arrays are COMPLETE by scope (no cap heuristic needed).
async function scopedVoiceCalls(tag) {
  return await requireArray(API + "/api/models/calls?meetingId=" + mid + "&purpose=voice-transcribe", tag);
}
async function scopedVoiceUsage(tag) {
  return await requireArray(API + "/api/usage?meetingId=" + mid + "&purpose=voice-transcribe", tag);
}
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_GUID = "00000000-0000-0000-0000-000000000000";
function guidOk(v) { return typeof v === "string" && GUID_RE.test(v) && v.toLowerCase() !== ZERO_GUID; }
// Pinned fixture basis + expected cost for the controlled 2s fake transcript.
// Fake always returns audioProcessedMs=2000, so VoiceCost = floor(2s)*0.18/3600 = 0.0001.
const PINNED_VOICE_BASIS = "est:https://dev.meta.ai/docs/speech-to-text@2026-11-02; 0.18/hour on FLOOR(whole billed seconds); duration source: official file audioDurationMs first, compatible event audioProcessedMs/audio_processed_ms/durationMs retained; absent duration => unknown (never 0); subsecond floors to known 0; HTTP 429 and pre-transcript rejection nonbillable known 0; estimate not invoice";
const EXPECTED_VOICE_COST = 0.0001;
function costMatchesExpected(c) { return typeof c === "number" && Math.abs(c - EXPECTED_VOICE_COST) < 1e-9; }
function assertScopedComplete(tag, arr, cap) {
  ok(tag + "-complete-below-cap", Array.isArray(arr) && arr.length < cap, "len=" + (arr && arr.length) + " cap=" + cap);
}
// Complete-array pairing: each positive adds EXACTLY ONE row to each scoped
// ledger, with the SAME nonempty nonzero GUID, purpose, scope, status, cost,
// basis, and model on both rows.
function pairVoiceLedgers(tag, u0, u1, c0, c1) {
  ok(tag + "-usage-plus-1", u1.length === u0.length + 1, u0.length + "->" + u1.length);
  ok(tag + "-calls-plus-1", c1.length === c0.length + 1, c0.length + "->" + c1.length);
  // Completeness: scoped arrays below endpoint caps (usage 500, calls 200)
  // prove the visible arrays are the whole ledgers, not capped false passes.
  assertScopedComplete(tag + "-usage", u0, 500);
  assertScopedComplete(tag + "-usage", u1, 500);
  assertScopedComplete(tag + "-calls", c0, 200);
  assertScopedComplete(tag + "-calls", c1, 200);
  const uIds = new Set(u0.map((x) => x.id ?? x.Id));
  const cIds = new Set(c0.map((x) => x.id ?? x.Id));
  const addedU = u1.filter((x) => !uIds.has(x.id ?? x.Id));
  const addedC = c1.filter((x) => !cIds.has(x.id ?? x.Id));
  ok(tag + "-usage-one-new", addedU.length === 1, JSON.stringify(addedU.map((x) => x.id ?? x.Id)));
  ok(tag + "-calls-one-new", addedC.length === 1, JSON.stringify(addedC.map((x) => x.id ?? x.Id)));
  const uid = addedU.length ? (addedU[0].id ?? addedU[0].Id) : "";
  const cid = addedC.length ? (addedC[0].id ?? addedC[0].Id) : "";
  ok(tag + "-same-guid", !!uid && uid === cid, "usage=" + uid + " calls=" + cid);
  ok(tag + "-guid-nonzero", guidOk(uid) && guidOk(cid), "guid=" + uid);
  // SEVENTH: retained prior rows FULLFIELD unchanged (not length+new IDs
  // only): every pre-existing row must still exist with identical full JSON.
  {
    const m1 = new Map(u1.map((x) => [x.id ?? x.Id, JSON.stringify(x)]));
    const m0miss = u0.filter((x) => !m1.has(x.id ?? x.Id));
    const m0chg = u0.filter((x) => m1.has(x.id ?? x.Id) && m1.get(x.id ?? x.Id) !== JSON.stringify(x));
    ok(tag + "-usage-retained", m0miss.length === 0 && m0chg.length === 0, "miss=" + m0miss.length + " chg=" + m0chg.length);
    const n1 = new Map(c1.map((x) => [x.id ?? x.Id, JSON.stringify(x)]));
    const n0miss = c0.filter((x) => !n1.has(x.id ?? x.Id));
    const n0chg = c0.filter((x) => n1.has(x.id ?? x.Id) && n1.get(x.id ?? x.Id) !== JSON.stringify(x));
    ok(tag + "-calls-retained", n0miss.length === 0 && n0chg.length === 0, "miss=" + n0miss.length + " chg=" + n0chg.length);
  }
  if (addedU.length && addedC.length) {
    const u = addedU[0], c = addedC[0];
    const uKind = u.kind ?? u.Kind, cPurpose = c.purpose ?? c.Purpose;
    ok(tag + "-purpose", uKind === "voice-transcribe" && cPurpose === "voice-transcribe", uKind + "/" + cPurpose);
    const uMid = u.meetingId ?? u.MeetingId, cMid = c.meetingId ?? c.MeetingId;
    const uBid = u.boardId ?? u.BoardId, cBid = c.boardId ?? c.BoardId;
    ok(tag + "-scope", String(uMid) === String(mid) && String(cMid) === String(mid) && String(uBid) === String(bid) && String(cBid) === String(bid), "u=" + uMid + "/" + uBid + " c=" + cMid + "/" + cBid);
    const uSt = u.status ?? u.Status, cSt = c.status ?? c.Status;
    ok(tag + "-status", uSt === "succeeded" && cSt === "succeeded", uSt + "/" + cSt);
    {
      const uc = u.cost ?? u.Cost, cc = c.cost ?? c.Cost;
      ok(tag + "-cost-equal", uc === cc && uc !== null && uc !== undefined, "u=" + uc + " c=" + cc);
      ok(tag + "-cost-expected", costMatchesExpected(Number(uc)) && costMatchesExpected(Number(cc)), "u=" + uc + " c=" + cc + " expected=" + EXPECTED_VOICE_COST);
      ok(tag + "-cost-nonnegative", Number(uc) >= 0 && Number(cc) >= 0, "u=" + uc + " c=" + cc);
    }
    const uB = u.costBasis ?? u.CostBasis, cB = c.costBasis ?? c.CostBasis;
    ok(tag + "-basis", typeof uB === "string" && uB.length > 0 && uB === cB, String(uB).slice(0, 80));
    ok(tag + "-basis-pinned", uB === PINNED_VOICE_BASIS && cB === PINNED_VOICE_BASIS, String(uB).slice(0, 80));
    const uM = u.model ?? u.Model, cM = c.model ?? c.Model;
    ok(tag + "-model", uM === "muse-voice-transcribe-1.0" && cM === "muse-voice-transcribe-1.0", uM + "/" + cM);
  } else {
    ok(tag + "-purpose", false, "missing added rows");
    ok(tag + "-scope", false, "missing added rows");
    ok(tag + "-status", false, "missing added rows");
    ok(tag + "-cost", false, "missing added rows");
    ok(tag + "-basis", false, "missing added rows");
    ok(tag + "-model", false, "missing added rows");
  }
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
  const su0 = await scopedVoiceUsage("valid16-usage0");
  const sc0 = await scopedVoiceCalls("valid16-calls0");
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
  const su1 = await scopedVoiceUsage("valid16-usage1");
  const sc1 = await scopedVoiceCalls("valid16-calls1");
  pairVoiceLedgers("valid16", su0, su1, sc0, sc1);
}
{
  const wav = makeWavMono16(24000, 1.0, 440);
  const c0 = await counts();
  const u0 = await usageVoiceScoped();
  const su0b = await scopedVoiceUsage("valid24-usage0");
  const sc0b = await scopedVoiceCalls("valid24-calls0");
  const r = await postTranscribe(mid, wav, "note.wav", "audio/wav");
  ok("valid24-201", r.status === 201, r.status + " " + r.text.slice(0, 200));
  const c1 = await counts();
  ok("valid24-provider-hit", (c1.transcribe || 0) === (c0.transcribe || 0) + 1, JSON.stringify(c1));
  const last = await jget(FAKE + "/__last-transcribe");
  ok("valid24-fresh-hit", last.json && last.json.n === c1.transcribe && last.json.sampleRate === 24000, JSON.stringify(last.json).slice(0, 300));
  const u1 = await usageVoiceScoped();
  ok("valid24-metered-scoped", u1 === u0 + 1, "usage " + u0 + "->" + u1);
  const su1b = await scopedVoiceUsage("valid24-usage1");
  const sc1b = await scopedVoiceCalls("valid24-calls1");
  pairVoiceLedgers("valid24", su0b, su1b, sc0b, sc1b);
}
// SIXTH strict-identity counterexamples: malformed GUIDs, equal-but-wrong
// costs/bases must FAIL the real pairing predicates (not pass by equality).
{
  const malformed = "not-a-guid-123";
  ok("cx-malformed-guid-fails", guidOk(malformed) === false, malformed);
  const shortHex = "abc123";
  ok("cx-short-guid-fails", guidOk(shortHex) === false, shortHex);
  ok("cx-zero-guid-fails", guidOk("00000000-0000-0000-0000-000000000000") === false, "zero guid");
  const goodGuid = "11111111-2222-3333-4444-555555555555";
  ok("cx-good-guid-passes", guidOk(goodGuid) === true, goodGuid);
  // Equal negative costs must FAIL (strict nonnegative + expected).
  const negCost = -0.0001;
  ok("cx-equal-negative-cost-fails", !(negCost >= 0 && costMatchesExpected(negCost)), "cost=" + negCost);
  // Equal wrong positive costs must FAIL (exact fixture cost required).
  const wrongCost = 0.0002;
  ok("cx-equal-wrong-cost-fails", !costMatchesExpected(wrongCost), "cost=" + wrongCost);
  // Equal wrong bases must FAIL (pinned basis required).
  const wrongBasis = "est:wrong-basis";
  ok("cx-equal-wrong-basis-fails", wrongBasis !== PINNED_VOICE_BASIS, wrongBasis);
  ok("cx-pinned-basis-shape", PINNED_VOICE_BASIS.includes("speech-to-text@2026-11-02") && PINNED_VOICE_BASIS.includes("0.18/hour"), PINNED_VOICE_BASIS.slice(0, 80));
}
// ACTUAL controlled failure ledger pair: owned fake fails once (502), the
// REAL API records one failed usage + one failed ModelCall with the SAME id,
// failed status, same pinned basis, and unknown (null) cost for 5xx.
{
  const wav = makeWavMono16(16000, 0.5, 440);
  const c0 = await counts();
  const suF0 = await scopedVoiceUsage("fail502-usage0");
  const scF0 = await scopedVoiceCalls("fail502-calls0");
  assertScopedComplete("fail502-usage0", suF0, 500);
  assertScopedComplete("fail502-calls0", scF0, 200);
  {
    const fr = await fetch(FAKE + "/__fail-next-transcribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: 502, body: "qa controlled failure" }) });
    ok("fail502-fake-armed", fr.status === 200, "status=" + fr.status);
  }
  const r = await postTranscribe(mid, wav, "mic.wav", "audio/wav");
  ok("fail502-502", r.status === 502, r.status + " " + r.text.slice(0, 200));
  const c1 = await counts();
  ok("fail502-provider-hit", (c1.transcribe || 0) === (c0.transcribe || 0) + 1, JSON.stringify(c1));
  const suF1 = await scopedVoiceUsage("fail502-usage1");
  const scF1 = await scopedVoiceCalls("fail502-calls1");
  assertScopedComplete("fail502-usage1", suF1, 500);
  assertScopedComplete("fail502-calls1", scF1, 200);
  ok("fail502-usage-plus-1", suF1.length === suF0.length + 1, suF0.length + "->" + suF1.length);
  ok("fail502-calls-plus-1", scF1.length === scF0.length + 1, scF0.length + "->" + scF1.length);
  {
    const uIds = new Set(suF0.map((x) => x.id ?? x.Id));
    const cIds = new Set(scF0.map((x) => x.id ?? x.Id));
    const au = suF1.filter((x) => !uIds.has(x.id ?? x.Id));
    const ac = scF1.filter((x) => !cIds.has(x.id ?? x.Id));
    const uid = au.length ? (au[0].id ?? au[0].Id) : "";
    const cid = ac.length ? (ac[0].id ?? ac[0].Id) : "";
    ok("fail502-same-guid", au.length === 1 && ac.length === 1 && !!uid && uid === cid, "usage=" + uid + " calls=" + cid);
    ok("fail502-guid-strict", guidOk(uid) && guidOk(cid), "guid=" + uid);
    // SEVENTH: failed pairs carry the same Board+Meeting scope/purpose
    // checks as positives (meeting filtering alone must not pass a wrong
    // BoardId), plus FULLFIELD retained-row preservation on BOTH ledgers.
    {
      const m1u = new Map(suF1.map((x) => [x.id ?? x.Id, JSON.stringify(x)]));
      const m0missU = suF0.filter((x) => !m1u.has(x.id ?? x.Id));
      const m0chgU = suF0.filter((x) => m1u.has(x.id ?? x.Id) && m1u.get(x.id ?? x.Id) !== JSON.stringify(x));
      ok("fail502-usage-retained", m0missU.length === 0 && m0chgU.length === 0, "miss=" + m0missU.length + " chg=" + m0chgU.length);
      const m1c = new Map(scF1.map((x) => [x.id ?? x.Id, JSON.stringify(x)]));
      const m0missC = scF0.filter((x) => !m1c.has(x.id ?? x.Id));
      const m0chgC = scF0.filter((x) => m1c.has(x.id ?? x.Id) && m1c.get(x.id ?? x.Id) !== JSON.stringify(x));
      ok("fail502-calls-retained", m0missC.length === 0 && m0chgC.length === 0, "miss=" + m0missC.length + " chg=" + m0chgC.length);
    }
    if (au.length && ac.length) {
      const uKindF = au[0].kind ?? au[0].Kind, cPurposeF = ac[0].purpose ?? ac[0].Purpose;
      ok("fail502-purpose", uKindF === "voice-transcribe" && cPurposeF === "voice-transcribe", uKindF + "/" + cPurposeF);
      const uMidF = au[0].meetingId ?? au[0].MeetingId, cMidF = ac[0].meetingId ?? ac[0].MeetingId;
      const uBidF = au[0].boardId ?? au[0].BoardId, cBidF = ac[0].boardId ?? ac[0].BoardId;
      ok("fail502-scope", String(uMidF) === String(mid) && String(cMidF) === String(mid) && String(uBidF) === String(bid) && String(cBidF) === String(bid), "u=" + uMidF + "/" + uBidF + " c=" + cMidF + "/" + cBidF);
      const uSt = au[0].status ?? au[0].Status, cSt = ac[0].status ?? ac[0].Status;
      ok("fail502-status-failed", uSt === "failed" && cSt === "failed", uSt + "/" + cSt);
      const uc = ("cost" in au[0]) ? au[0].cost : au[0].Cost, cc = ("cost" in ac[0]) ? ac[0].cost : ac[0].Cost;
      ok("fail502-cost-null-unknown", uc === null && cc === null, "u=" + uc + " c=" + cc);
      const uB = au[0].costBasis ?? au[0].CostBasis, cB = ac[0].costBasis ?? ac[0].CostBasis;
      ok("fail502-basis-pinned", uB === PINNED_VOICE_BASIS && cB === PINNED_VOICE_BASIS, String(uB).slice(0, 80));
      const uM = au[0].model ?? au[0].Model, cM = ac[0].model ?? ac[0].Model;
      ok("fail502-model", uM === "muse-voice-transcribe-1.0" && cM === "muse-voice-transcribe-1.0", uM + "/" + cM);
    } else {
      ok("fail502-purpose", false, "missing added rows");
      ok("fail502-scope", false, "missing added rows");
      ok("fail502-status-failed", false, "missing added rows");
      ok("fail502-cost-null-unknown", false, "missing added rows");
      ok("fail502-basis-pinned", false, "missing added rows");
      ok("fail502-model", false, "missing added rows");
    }
  }
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
  // Exclusive fresh owned API process + strictly-below-cap lengths BEFORE
  // every negative prove the compared arrays are the complete ledgers
  // (usage cap 500, calls cap 200). Scoped arrays below caps are complete
  // by scope; global arrays below caps are complete overall.
  const calls0 = await callsArr(name + "-calls0");
  ok(name + "-ledger-complete", calls0.length < 200, "len=" + calls0.length);
  const usage0full = await requireArray(API + "/api/usage?meetingId=" + mid, name + "-usage0full");
  ok(name + "-usage-complete", usage0full.length < 500, "len=" + usage0full.length);
  const calls0Body = JSON.stringify(calls0);
  const scN0 = await scopedVoiceCalls(name + "-scoped-calls0");
  const scN0Body = JSON.stringify(scN0);
  const suN0 = await scopedVoiceUsage(name + "-scoped-usage0");
  const suN0Body = JSON.stringify(suN0);
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
  const usage1full = await requireArray(API + "/api/usage?meetingId=" + mid, name + "-usage1full");
  ok(name + "-usage-still-complete", usage1full.length < 500, "len=" + usage1full.length);
  ok(name + "-no-usage-rows", JSON.stringify(usage1full) === JSON.stringify(usage0full), "usage changed");
  const scN1 = await scopedVoiceCalls(name + "-scoped-calls1");
  ok(name + "-no-scoped-voice-calls", JSON.stringify(scN1) === scN0Body, "scoped voice calls changed");
  const suN1 = await scopedVoiceUsage(name + "-scoped-usage1");
  ok(name + "-no-scoped-voice-usage", JSON.stringify(suN1) === suN0Body, "scoped voice usage changed");
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
