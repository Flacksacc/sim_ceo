// SimCEO Phase 9 usage-accounting QA. Deterministic; talks only to the API
// under test (default http://127.0.0.1:5096) which itself points at the
// isolated fake provider (default http://127.0.0.1:5196).
// Unique owned data per run (qa-<run>-*); never touches other boards.
// Exit nonzero on any failure; prints PASS/FAIL counts.
import crypto from "node:crypto";
const API = process.env.QA_API || "http://127.0.0.1:5096";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:5196";
async function setMsMode(mode) {
  const r = await fetch(FAKE + "/__qa/ms-mode?mode=" + mode);
  ok("msmode-" + mode, r.status === 200, String(r.status));
}
async function postTranscribe(mid, fname) {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }), fname || "mic.webm");
  const rr = await fetch(API + "/api/meetings/" + mid + "/transcribe", { method: "POST", headers: { "x-user": "owner" }, body: form });
  const tx = await rr.text();
  let jj = null; try { jj = tx ? JSON.parse(tx) : null; } catch { jj = null; }
  return { status: rr.status, text: tx, json: jj };
}
const args = process.argv.slice(2);
function argValEarly(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length && !String(args[i + 1]).startsWith("--") ? args[i + 1] : undefined;
}
const TAG = argValEarly("--tag") || "mem";
const run = "qa-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; } else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
async function req(method, path, body, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 30000);
  try {
    const headers = { "x-user": "owner", ...(opts.headers || {}) };
    let b; let ct = {};
    if (body !== undefined && body instanceof FormData) { b = body; }
    else if (body !== undefined) { b = JSON.stringify(body); ct = { "content-type": "application/json" }; }
    const r = await fetch(API + path, { method, signal: ctl.signal, headers: { ...ct, ...headers }, body: b });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const get = (p, o) => req("GET", p, undefined, o);
const post = (p, b, o) => req("POST", p, b, o);
const guid = () => crypto.randomUUID();
async function makeBoard(name) {
  const r = await post("/api/boards", { name, mission: run + " mission", stage: "qa" });
  ok("create-board-" + name, r.status === 201 && (r.json?.id || r.json?.Id), r.status + " " + String(r.text).slice(0, 160));
  return r.json?.id || r.json?.Id;
}
async function makeMeeting(bid, brief) {
  const r = await post("/api/boards/" + bid + "/meetings", { title: run + " mtg", brief: brief || "qa brief" });
  ok("create-meeting", r.status === 201 && (r.json?.id || r.json?.Id), r.status + " " + String(r.text).slice(0, 160));
  return r.json?.id || r.json?.Id;
}
async function usageRows(qs) {
  const r = await get("/api/usage?summary=true&limit=2000&" + qs);
  ok("usage-summary-200-" + qs.slice(0, 40), r.status === 200 && Array.isArray(r.json?.rows), r.status + " " + String(r.text).slice(0, 200));
  return r.json;
}
async function modelRows(qs) {
  const r = await get("/api/models/calls?summary=true&limit=2000&" + qs);
  ok("modelcalls-summary-200-" + qs.slice(0, 40), r.status === 200 && Array.isArray(r.json?.rows), r.status + " " + String(r.text).slice(0, 200));
  return r.json;
}
console.log("phase9 usage-accounting QA tag=" + TAG + " api=" + API + " run=" + run);
// 0. backward compat: array responses preserved
{
  const r = await get("/api/usage?limit=5");
  ok("usage-array-compat", r.status === 200 && Array.isArray(r.json), r.status + " " + String(r.text).slice(0, 160));
  const m = await get("/api/models/calls?limit=5");
  ok("modelcalls-array-compat", m.status === 200 && Array.isArray(m.json), m.status + " " + String(m.text).slice(0, 160));
}
// 1. installation baseline + permissions
{
  const r = await get("/api/usage?summary=true&limit=5");
  ok("usage-install-owner-200", r.status === 200 && r.json?.scope === "installation", r.status + " " + String(r.text).slice(0, 200));
  ok("usage-pricing-basis", r.status === 200 && r.json?.pricingBasis?.checkedDate === "2026-11-02", JSON.stringify(r.json?.pricingBasis).slice(0, 200));
  ok("usage-storage-labeled", r.status === 200 && (r.json?.storage === "postgres-durable" || r.json?.storage === "memory-session-lifetime"), String(r.json?.storage));
  const anon = await req("GET", "/api/usage?limit=5", undefined, { headers: { "x-user": "stranger-no-grant" } });
  ok("usage-install-stranger-denied", anon.status === 403, String(anon.status));
}
// 2. successful chat (audition, installation Unallocated hidden)
let auditBase = 0;
{
  const before = await usageRows("");
  auditBase = before?.total || 0;
  const r = await post("/api/auditions", { question: run + " audition ok", profileJson: JSON.stringify({ fictional: true, name: "QA" }) });
  ok("audition-ok-200", r.status === 200 && typeof r.json?.answer === "string" && r.json.answer.length > 0, r.status + " " + String(r.text).slice(0, 200));
  const after = await usageRows("");
  const fresh = (after?.rows || []).filter((u) => (u.note || "").includes("qa-") || true).slice(0, 5);
  ok("audition-one-usage", (after?.total || 0) === auditBase + 1, "before=" + auditBase + " after=" + after?.total);
  const row = (after?.rows || [])[0] || {};
  ok("audition-cost-known", row.cost != null && Number(row.cost) > 0, JSON.stringify(row).slice(0, 300));
  ok("audition-status-succeeded", row.status === "succeeded", String(row.status));
  ok("audition-unallocated", (row.allocationLabel === "Unallocated" || row.boardId == null), JSON.stringify(row).slice(0, 300));
  ok("audition-hidden", row.hiddenPurpose === true || row.kind === "audition", JSON.stringify(row).slice(0, 200));
  ok("audition-no-prompt-leak", !JSON.stringify(row).includes(run + " audition ok"), "prompt must not be stored");
  const m = await modelRows("");
  const mrow = (m?.rows || [])[0] || {};
  ok("audition-modelcall-one", (m?.total || 0) >= 1 && mrow.purpose === "audition", JSON.stringify(mrow).slice(0, 300));
  ok("audition-ids-match", row.id && mrow.id && String(row.id) === String(mrow.id), row.id + " vs " + mrow.id);
}
// 3. failed chat (HTTP 500 -> failed unknown, ONE event)
{
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/auditions", { question: "QA-HTTP500 " + run, profileJson: "{}" });
  ok("audition-fail-502", r.status === 502, String(r.status));
  const after = await usageRows("");
  ok("audition-fail-one-event", (after?.total || 0) === before + 1, "before=" + before + " after=" + after?.total);
  const row = (after?.rows || [])[0] || {};
  ok("audition-fail-status", row.status === "failed", String(row.status));
  ok("audition-fail-unknown-cost", row.cost == null && row.unknownCost === true, JSON.stringify(row).slice(0, 300));
}
// 4. truncated billed (finish length)
{
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/auditions", { question: "QA-TRUNCATE " + run, profileJson: "{}" });
  ok("audition-trunc-502", r.status === 502, String(r.status) + " " + String(r.text).slice(0, 160));
  const after = await usageRows("");
  ok("audition-trunc-one", (after?.total || 0) === before + 1, "before=" + before + " after=" + after?.total);
  const row = (after?.rows || [])[0] || {};
  ok("audition-trunc-status", row.status === "truncated", String(row.status));
  ok("audition-trunc-billed", row.cost != null && Number(row.cost) > 0, JSON.stringify(row).slice(0, 300));
}
// 5. no-usage unknown
{
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/auditions", { question: "QA-NOUSAGE " + run, profileJson: "{}" });
  ok("audition-nouses-200-success-unknown", r.status === 200, String(r.status));
  const after = await usageRows("");
  ok("audition-nouses-one", (after?.total || 0) === before + 1, "before=" + before);
  const row = (after?.rows || [])[0] || {};
  ok("audition-nouses-unknown", row.status === "succeeded" && row.cost == null && row.unknownCost === true, JSON.stringify(row).slice(0, 300));
}
// 6. cached token rate (real gateway, not parser)
{
  const r = await post("/api/auditions", { question: "QA-CACHED " + run, profileJson: "{}" });
  ok("audition-cached-200", r.status === 200, String(r.status));
  const after = await usageRows("purpose=audition");
  const row = (after?.rows || []).find((u) => Number(u.cachedInputTokens) > 0) || {};
  ok("audition-cached-tokens", Number(row.cachedInputTokens) === 40 && Number(row.inputTokens) === 100, JSON.stringify(row).slice(0, 300));
  const expected = 60 / 1e6 * 1.25 + 40 / 1e6 * 0.15 + 50 / 1e6 * 4.25;
  ok("audition-cached-cost", Math.abs(Number(row.cost) - expected) < 1e-9, "got=" + row.cost + " want=" + expected);
}
// 7. meeting transcribe ONE event + missing duration unknown
const bid = await makeBoard(run + "-b1");
const mid = await makeMeeting(bid, "phase9 brief");
{
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }), "mic.webm");
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
  let r;
  try {
    r = await fetch(API + "/api/meetings/" + mid + "/transcribe", { method: "POST", headers: { "x-user": "owner" }, body: form, signal: ctl.signal }).then(async (rr) => { const tx = await rr.text(); let jj = null; try { jj = tx ? JSON.parse(tx) : null; } catch { jj = null; } return { status: rr.status, text: tx, json: jj }; });
  } finally { clearTimeout(t); }
  ok("transcribe-200", r.status === 201 && (r.json?.transcript || "").includes("qa transcript"), r.status + " " + String(r.text).slice(0, 200));
  const mu = await usageRows("meetingId=" + mid);
  ok("transcribe-meeting-one", (mu?.total || 0) === 1, "total=" + mu?.total);
  const row = (mu?.rows || [])[0] || {};
  ok("transcribe-unknown-duration", row.cost == null && row.status === "unknown", JSON.stringify(row).slice(0, 300));
  ok("transcribe-allocated", row.allocationLabel === "Allocated" && String(row.boardId).toLowerCase() === String(bid).toLowerCase(), JSON.stringify(row).slice(0, 300));
  const mm = await modelRows("meetingId=" + mid);
  ok("transcribe-modelcall-one", (mm?.total || 0) === 1, "total=" + mm?.total);
  ok("transcribe-ids-match", String(row.id) === String((mm?.rows || [])[0]?.id), row.id + " vs " + (mm?.rows || [])[0]?.id);
}
// 7b. official audioDurationMs file field bills floor seconds (8240ms -> 8s)
{
  await setMsMode("official");
  const midx = await makeMeeting(bid, "asr official");
  const r = await postTranscribe(midx);
  ok("transcribe-official-200", r.status === 201 && (r.json?.transcript || "").includes("qa transcript"), r.status + " " + String(r.text).slice(0, 200));
  const mu = await usageRows("meetingId=" + midx);
  ok("transcribe-official-one", (mu?.total || 0) === 1, "total=" + mu?.total);
  const row = (mu?.rows || [])[0] || {};
  const want = 8 / 3600 * 0.18;
  ok("transcribe-official-cost", row.cost != null && Math.abs(Number(row.cost) - want) < 1e-9 && row.status === "succeeded", JSON.stringify(row).slice(0, 300));
  ok("transcribe-official-ids", String(row.id) === String((await modelRows("meetingId=" + midx))?.rows?.[0]?.id), "ids differ");
  await setMsMode("absent");
}
// 7c. subsecond duration floors to 0s: known 0, not unknown
{
  await setMsMode("subsecond");
  const midx = await makeMeeting(bid, "asr subsecond");
  const r = await postTranscribe(midx);
  ok("transcribe-subsecond-200", r.status === 201, r.status + " " + String(r.text).slice(0, 200));
  const mu = await usageRows("meetingId=" + midx);
  ok("transcribe-subsecond-one", (mu?.total || 0) === 1, "total=" + mu?.total);
  const row = (mu?.rows || [])[0] || {};
  ok("transcribe-subsecond-known-zero", row.cost !== null && Number(row.cost) === 0 && row.status === "succeeded", JSON.stringify(row).slice(0, 300));
  await setMsMode("absent");
}
// 7d. legacy event field audioProcessedMs stays compatible
{
  await setMsMode("processed");
  const midx = await makeMeeting(bid, "asr legacy");
  const r = await postTranscribe(midx);
  ok("transcribe-legacy-200", r.status === 201, r.status + " " + String(r.text).slice(0, 200));
  const mu = await usageRows("meetingId=" + midx);
  ok("transcribe-legacy-one", (mu?.total || 0) === 1, "total=" + mu?.total);
  const row = (mu?.rows || [])[0] || {};
  const want = 5 / 3600 * 0.18;
  ok("transcribe-legacy-cost", row.cost != null && Math.abs(Number(row.cost) - want) < 1e-9 && row.status === "succeeded", JSON.stringify(row).slice(0, 300));
  await setMsMode("absent");
}
// 7e. HTTP 429 is documented nonbillable: failed with known zero
{
  const midx = await makeMeeting(bid, "asr 429");
  const before = ((await usageRows("meetingId=" + midx))?.total || 0);
  const r = await postTranscribe(midx, "QA-429.webm");
  ok("transcribe-429-502", r.status === 502 && String(r.text).includes("429"), r.status + " " + String(r.text).slice(0, 200));
  const mu = await usageRows("meetingId=" + midx);
  ok("transcribe-429-one", (mu?.total || 0) === before + 1, "total=" + mu?.total);
  const row = (mu?.rows || [])[0] || {};
  ok("transcribe-429-known-zero", row.cost !== null && Number(row.cost) === 0 && row.status === "failed", JSON.stringify(row).slice(0, 300));
}
// 7f. HTTP 500 stays unknown (no usage observable)
{
  const midx = await makeMeeting(bid, "asr 500");
  const before = ((await usageRows("meetingId=" + midx))?.total || 0);
  const r = await postTranscribe(midx, "QA-500-ASR.webm");
  ok("transcribe-500-502", r.status === 502, String(r.status));
  const mu = await usageRows("meetingId=" + midx);
  ok("transcribe-500-one", (mu?.total || 0) === before + 1, "total=" + mu?.total);
  const row = (mu?.rows || [])[0] || {};
  ok("transcribe-500-unknown", row.cost == null && row.status === "failed", JSON.stringify(row).slice(0, 300));
}
// 8. board scope includes meeting row; other board excluded; installation totals include unallocated
{
  const beforeInstall = await usageRows("");
  const installTotal = beforeInstall?.total || 0;
  const boardRows = await usageRows("boardId=" + bid);
  ok("board-scope-includes-meeting", (boardRows?.total || 0) >= 1, "total=" + boardRows?.total);
  const bid2 = await makeBoard(run + "-b2");
  const other = await usageRows("boardId=" + bid2);
  ok("board-scope-excludes-others", (other?.total || 0) === 0, "total=" + other?.total);
  const install2 = await usageRows("");
  ok("install-includes-unallocated", (install2?.summary?.unallocated || 0) >= 1, JSON.stringify(install2?.summary));
  ok("install-includes-allocated", (install2?.summary?.allocated || 0) >= 1, JSON.stringify(install2?.summary));
  const meetOtherBoard = await get("/api/usage?summary=true&boardId=" + bid2 + "&meetingId=" + mid);
  ok("board-meeting-mismatch-400", meetOtherBoard.status === 400, String(meetOtherBoard.status));
}
// 9. multi-image ONE event, cost per returned
{
  const q = await post("/api/roster/quick", { accountId: guid(), name: run + "-img", description: "image helper for " + run });
  ok("roster-quick-201", q.status === 201, q.status + " " + String(q.text).slice(0, 200));
  const rid = q.json?.id || q.json?.Id;
  const before = (await usageRows(""))?.total || 0;
  const mbefore = (await modelRows(""))?.total || 0;
  const r = await post("/api/roster/" + rid + "/image/generate", { count: 2, prompt: run + " portrait" });
  ok("image-generate-200", r.status === 200 && Array.isArray(r.json) && r.json.length === 2, r.status + " " + String(r.text).slice(0, 200));
  const after = (await usageRows(""))?.total || 0;
  const mafter = (await modelRows(""))?.total || 0;
  ok("image-one-usage", after === before + 1, "before=" + before + " after=" + after);
  ok("image-one-modelcall", mafter === mbefore + 1, "before=" + mbefore + " after=" + mafter);
  const latest = (await usageRows("purpose=image-generate"))?.rows?.[0] || {};
  ok("image-cost-returned", Math.abs(Number(latest.cost) - 0.02) < 1e-9, "cost=" + latest.cost);
  ok("image-unallocated", latest.allocationLabel === "Unallocated" || latest.boardId == null, JSON.stringify(latest).slice(0, 300));
}
// 9b. undecodable payload: failed with unknown cost, never fabricated zero
{
  const q = await post("/api/roster/quick", { accountId: guid(), name: run + "-imgbad", description: "image helper for " + run });
  const rid = q.json?.id || q.json?.Id;
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/roster/" + rid + "/image/generate", { count: 2, prompt: "QA-IMG-MALFORMED " + run });
  ok("image-malformed-502", r.status === 502, String(r.status));
  const after = (await usageRows(""))?.total || 0;
  ok("image-malformed-one", after === before + 1, "before=" + before + " after=" + after);
  const row = (await usageRows("purpose=image-generate"))?.rows?.[0] || {};
  ok("image-malformed-unknown", row.cost == null && row.status === "failed", JSON.stringify(row).slice(0, 300));
}
// 9c. valid empty data is known zero
{
  const q = await post("/api/roster/quick", { accountId: guid(), name: run + "-imgempty", description: "image helper for " + run });
  const rid = q.json?.id || q.json?.Id;
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/roster/" + rid + "/image/generate", { count: 2, prompt: "QA-IMG-EMPTY " + run });
  ok("image-empty-200", r.status === 200 && Array.isArray(r.json) && r.json.length === 0, r.status + " " + String(r.text).slice(0, 120));
  const after = (await usageRows(""))?.total || 0;
  ok("image-empty-one", after === before + 1, "before=" + before + " after=" + after);
  const row = (await usageRows("purpose=image-generate"))?.rows?.[0] || {};
  ok("image-empty-known-zero", row.cost !== null && Number(row.cost) === 0 && row.status === "succeeded", JSON.stringify(row).slice(0, 300));
}
// 9d. mixed valid+malformed+URL: failed with unknown TOTAL (never successful known subset)
{
  const q = await post("/api/roster/quick", { accountId: guid(), name: run + "-imgmix", description: "image helper for " + run });
  const rid = q.json?.id || q.json?.Id;
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/roster/" + rid + "/image/generate", { count: 4, prompt: "QA-IMG-MIXED " + run });
  ok("image-mixed-502", r.status === 502, r.status + " " + String(r.text).slice(0, 160));
  const after = (await usageRows(""))?.total || 0;
  ok("image-mixed-one", after === before + 1, "before=" + before + " after=" + after);
  const row = (await usageRows("purpose=image-generate"))?.rows?.[0] || {};
  ok("image-mixed-unknown-total", row.cost == null && (row.status === "failed" || row.status === "unknown"), JSON.stringify(row).slice(0, 300));
}
// 9e. requested-vs-returned mismatch: 4 requested, 1 returned
{
  const q = await post("/api/roster/quick", { accountId: guid(), name: run + "-imgpart", description: "image helper for " + run });
  const rid = q.json?.id || q.json?.Id;
  const r = await post("/api/roster/" + rid + "/image/generate", { count: 4, prompt: "QA-IMG-PARTIAL " + run });
  ok("image-partial-200", r.status === 200 && Array.isArray(r.json) && r.json.length === 1, r.status + " " + String(r.text).slice(0, 120));
  const row = (await usageRows("purpose=image-generate"))?.rows?.[0] || {};
  ok("image-partial-cost", row.cost != null && Math.abs(Number(row.cost) - 0.01) < 1e-9, "cost=" + row.cost);
}
// 9f. URL-only valid returned unit: known cost preserved, actionable local delivery failure
{
  const q = await post("/api/roster/quick", { accountId: guid(), name: run + "-imgurl", description: "image helper for " + run });
  const rid = q.json?.id || q.json?.Id;
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/roster/" + rid + "/image/generate", { count: 2, prompt: "QA-IMG-URL " + run });
  ok("image-url-delivery-fails", r.status === 502 && !String(r.text).includes("qa.example"), r.status + " " + String(r.text).slice(0, 200));
  const after = (await usageRows(""))?.total || 0;
  ok("image-url-one", after === before + 1, "before=" + before + " after=" + after);
  const row = (await usageRows("purpose=image-generate"))?.rows?.[0] || {};
  ok("image-url-known-cost", row.cost != null && Math.abs(Number(row.cost) - 0.01) < 1e-9 && row.status === "failed", JSON.stringify(row).slice(0, 300));
}
// 9g. missing data property: unknown, not zero
{
  const q = await post("/api/roster/quick", { accountId: guid(), name: run + "-imgnodata", description: "image helper for " + run });
  const rid = q.json?.id || q.json?.Id;
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/roster/" + rid + "/image/generate", { count: 2, prompt: "QA-IMG-NODATA " + run });
  ok("image-nodata-502", r.status === 502, String(r.status));
  const after = (await usageRows(""))?.total || 0;
  ok("image-nodata-one", after === before + 1, "before=" + before + " after=" + after);
  const row = (await usageRows("purpose=image-generate"))?.rows?.[0] || {};
  ok("image-nodata-unknown", row.cost == null && row.status === "unknown", JSON.stringify(row).slice(0, 300));
}
// 10. responses grounded via ai-draft (hidden research, search costs, no prompt leak)
{
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/roster/ai-draft", { accountId: guid(), name: run + "-dossier", role: "Strategist", focus: run + " focus" });
  ok("aidraft-201", r.status === 201, r.status + " " + String(r.text).slice(0, 200));
  const after = (await usageRows(""))?.total || 0;
  ok("aidraft-two-events", after === before + 2, "before=" + before + " after=" + after);
  const g = (await usageRows("purpose=advisor-research"))?.rows?.[0] || {};
  ok("research-hidden-shown", (g.kind === "advisor-research") && g.hiddenPurpose === true, JSON.stringify(g).slice(0, 300));
  ok("research-searches", Number(g.searchCalls) >= 1 && g.ranSearch === true, JSON.stringify(g).slice(0, 300));
  ok("research-cost-known", g.cost != null && Number(g.cost) > 0, JSON.stringify(g).slice(0, 300));
  ok("research-no-prompt-leak", !JSON.stringify(g).includes(run + " focus"), "research focus must not be stored");
}
// 10b. responses HTTP error preserves billed usage when present
{
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/roster/ai-draft", { accountId: guid(), name: run + "-derr", role: "Strategist", focus: "QA-RESEARCHERR-USAGE " + run });
  ok("researcherr-usage-502", r.status === 502, String(r.status));
  const after = (await usageRows(""))?.total || 0;
  ok("researcherr-usage-one", after === before + 1, "before=" + before + " after=" + after);
  const row = (await usageRows("purpose=advisor-research"))?.rows?.[0] || {};
  ok("researcherr-usage-unobservable-total", row.status === "failed" && row.cost == null && row.unknownCost === true && Number(row.inputTokens) === 40 && Number(row.outputTokens) === 10 && Number(row.searchCalls) === 0, JSON.stringify(row).slice(0, 400));
  ok("researcherr-provider-id", (row.providerCallId || "") === "qa-resp-failed-1", String(row.providerCallId));
}
// 10c. responses HTTP error without usage stays unknown
{
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/roster/ai-draft", { accountId: guid(), name: run + "-derr2", role: "Strategist", focus: "QA-RESEARCHERR " + run });
  ok("researcherr-502", r.status === 502, String(r.status));
  const after = (await usageRows(""))?.total || 0;
  ok("researcherr-one", after === before + 1, "before=" + before + " after=" + after);
  const row = (await usageRows("purpose=advisor-research"))?.rows?.[0] || {};
  ok("researcherr-unknown", row.cost == null && row.status === "failed", JSON.stringify(row).slice(0, 300));
}
// 10d. non-completed responses keep observable search charges
{
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/roster/ai-draft", { accountId: guid(), name: run + "-dinc", role: "Strategist", focus: "QA-RESP-INCOMPLETE " + run });
  ok("incomplete-502", r.status === 502, String(r.status));
  const after = (await usageRows(""))?.total || 0;
  ok("incomplete-one", after === before + 1, "before=" + before + " after=" + after);
  const row = (await usageRows("purpose=advisor-research"))?.rows?.[0] || {};
  ok("incomplete-unobservable-total", row.status === "incomplete" && row.cost == null && row.unknownCost === true, JSON.stringify(row).slice(0, 400));
}
// 10e. missing responses usage stays unknown (searches still observed)
{
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/roster/ai-draft", { accountId: guid(), name: run + "-dnousage", role: "Strategist", focus: "QA-RESP-NOUSAGE " + run });
  ok("nousage-502", r.status === 502, String(r.status));
  const after = (await usageRows(""))?.total || 0;
  ok("nousage-one", after === before + 1, "before=" + before + " after=" + after);
  const row = (await usageRows("purpose=advisor-research"))?.rows?.[0] || {};
  ok("nousage-unknown", row.cost == null && row.status === "unknown" && Number(row.searchCalls) >= 1, JSON.stringify(row).slice(0, 300));
}
// 3b. long HTTP error body preserves trailing billed usage (parse before truncation)
{
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/auditions", { question: "QA-HTTP500-LONG " + run, profileJson: "{}" });
  ok("long-502", r.status === 502, String(r.status));
  const after = (await usageRows(""))?.total || 0;
  ok("long-one", (after || 0) === before + 1, "before=" + before + " after=" + after);
  const row = (await usageRows("purpose=audition"))?.rows?.[0] || {};
  const want = 120 / 1e6 * 1.25 + 16 / 1e6 * 4.25;
  ok("long-billed", row.status === "failed" && row.cost != null && Math.abs(Number(row.cost) - want) < 1e-9, JSON.stringify(row).slice(0, 300));
  ok("long-provider-id", (row.providerCallId || "") === "qa-long-billed-1", String(row.providerCallId));
  ok("long-no-leak", !JSON.stringify(row).includes("xxxx"), "error text must not leak");
}
// 3c. id-only HTTP error preserves observable id with unknown TOTAL
{
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/auditions", { question: "QA-HTTP500-IDONLY " + run, profileJson: "{}" });
  ok("idonly-502", r.status === 502, String(r.status));
  const after = (await usageRows(""))?.total || 0;
  ok("idonly-one", (after || 0) === before + 1, "before=" + before + " after=" + after);
  const row = (await usageRows("purpose=audition"))?.rows?.[0] || {};
  ok("idonly-unknown", row.cost == null && row.status === "failed" && (row.providerCallId || "") === "qa-only-id-9", JSON.stringify(row).slice(0, 300));
}
// 3d. invalid usage values are unknown, never negative or clamped known bills
{
  for (const tag of ["QA-USAGE-NEG", "QA-USAGE-CACHEOVER", "QA-USAGE-BADTYPE", "QA-USAGE-CONFLICT", "QA-USAGE-CACHED-CONFLICT", "QA-USAGE-BROKEN-DETAILS"]) {
    const before = (await usageRows(""))?.total || 0;
    const r = await post("/api/auditions", { question: tag + " " + run, profileJson: "{}" });
    ok("invalid-" + tag + "-200-success-unknown", r.status === 200, String(r.status) + " " + String(r.text).slice(0, 160));
    const after = (await usageRows(""))?.total || 0;
    ok("invalid-" + tag + "-one", (after || 0) === before + 1, "before=" + before);
    const row = (await usageRows("purpose=audition"))?.rows?.[0] || {};
    const nonNeg = row.cost == null || Number(row.cost) >= 0;
    ok("invalid-" + tag + "-unknown", row.cost == null && row.status === "succeeded" && nonNeg, JSON.stringify(row).slice(0, 300));
  }
}
// 10f. failed responses with observable search bills tokens + search
{
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/roster/ai-draft", { accountId: guid(), name: run + "-dsearch", role: "Strategist", focus: "QA-RESEARCHERR-SEARCH " + run });
  ok("researcherr-search-502", r.status === 502, String(r.status));
  const after = (await usageRows(""))?.total || 0;
  ok("researcherr-search-one", (after || 0) === before + 1, "before=" + before + " after=" + after);
  const row = (await usageRows("purpose=advisor-research"))?.rows?.[0] || {};
  const want = 40 / 1e6 * 1.25 + 10 / 1e6 * 4.25 + 1 / 1000 * 2.50;
  ok("researcherr-search-billed", row.status === "failed" && row.cost != null && Math.abs(Number(row.cost) - want) < 1e-9 && Number(row.searchCalls) === 1, JSON.stringify(row).slice(0, 400));
  ok("researcherr-search-id", (row.providerCallId || "") === "qa-resp-failed-search-1", String(row.providerCallId));
}
// 10g. long failed responses preserve trailing usage + search
{
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/roster/ai-draft", { accountId: guid(), name: run + "-dlong", role: "Strategist", focus: "QA-RESEARCHERR-LONG " + run });
  ok("researcherr-long-502", r.status === 502, String(r.status));
  const after = (await usageRows(""))?.total || 0;
  ok("researcherr-long-one", (after || 0) === before + 1, "before=" + before + " after=" + after);
  const row = (await usageRows("purpose=advisor-research"))?.rows?.[0] || {};
  const want = 30 / 1e6 * 1.25 + 5 / 1e6 * 4.25 + 1 / 1000 * 2.50;
  ok("researcherr-long-billed", row.status === "failed" && row.cost != null && Math.abs(Number(row.cost) - want) < 1e-9, JSON.stringify(row).slice(0, 400));
  ok("researcherr-long-id", (row.providerCallId || "") === "qa-resp-long-1", String(row.providerCallId));
}
// 10h. id-only failed responses preserve id with unknown TOTAL
{
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/roster/ai-draft", { accountId: guid(), name: run + "-didonly", role: "Strategist", focus: "QA-RESEARCHERR-IDONLY " + run });
  ok("researcherr-idonly-502", r.status === 502, String(r.status));
  const after = (await usageRows(""))?.total || 0;
  ok("researcherr-idonly-one", (after || 0) === before + 1, "before=" + before + " after=" + after);
  const row = (await usageRows("purpose=advisor-research"))?.rows?.[0] || {};
  ok("researcherr-idonly-unknown", row.cost == null && row.status === "failed" && (row.providerCallId || "") === "qa-resp-only-id-7", JSON.stringify(row).slice(0, 300));
}
// 10i. explicit empty output proves 0 searches: TOTAL known (tokens only)
{
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/roster/ai-draft", { accountId: guid(), name: run + "-dempty", role: "Strategist", focus: "QA-RESEARCHERR-EMPTY-OUTPUT " + run });
  ok("empty-output-502", r.status === 502, String(r.status));
  const row = (await usageRows("purpose=advisor-research"))?.rows?.[0] || {};
  const want = 40 / 1e6 * 1.25 + 10 / 1e6 * 4.25;
  ok("empty-output-known", row.status === "failed" && row.cost != null && Math.abs(Number(row.cost) - want) < 1e-9 && Number(row.searchCalls) === 0, JSON.stringify(row).slice(0, 400));
  ok("empty-output-id", (row.providerCallId || "") === "qa-resp-empty-1", String(row.providerCallId));
}
// 10j. null output is unobservable: TOTAL null
{
  const r = await post("/api/roster/ai-draft", { accountId: guid(), name: run + "-dnull", role: "Strategist", focus: "QA-RESEARCHERR-NULL-OUTPUT " + run });
  ok("null-output-502", r.status === 502, String(r.status));
  const row = (await usageRows("purpose=advisor-research"))?.rows?.[0] || {};
  ok("null-output-unknown", row.cost == null && (row.providerCallId || "") === "qa-resp-null-1", JSON.stringify(row).slice(0, 300));
}
// 10k. malformed output entries conceal search: TOTAL null (fail-closed)
{
  const r = await post("/api/roster/ai-draft", { accountId: guid(), name: run + "-dmal", role: "Strategist", focus: "QA-RESEARCHERR-MALFORMED-OUTPUT " + run });
  ok("mal-output-502", r.status === 502, String(r.status));
  const row = (await usageRows("purpose=advisor-research"))?.rows?.[0] || {};
  ok("mal-output-unknown", row.cost == null && (row.providerCallId || "") === "qa-resp-mal-1", JSON.stringify(row).slice(0, 300));
}
// 10l. canary markers absent from API error and ledgers; billing preserved
{
  const r = await post("/api/roster/ai-draft", { accountId: guid(), name: run + "-dcan", role: "Strategist", focus: "QA-RESEARCHERR-CANARY " + run });
  ok("canary-502", r.status === 502, String(r.status));
  ok("canary-redacted", !String(r.text).includes("QA-CANARY"), String(r.text).slice(0, 300));
  const row = (await usageRows("purpose=advisor-research"))?.rows?.[0] || {};
  ok("canary-ledger-clean", !JSON.stringify(row).includes("QA-CANARY"), JSON.stringify(row).slice(0, 300));
  ok("canary-known", row.cost != null && (row.providerCallId || "") === "qa-resp-canary-1", JSON.stringify(row).slice(0, 300));
}
// 10m. oversized body stops at bound: one unknown pair, safe error
{
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/roster/ai-draft", { accountId: guid(), name: run + "-d over", role: "Strategist", focus: "QA-RESEARCHERR-OVERSIZED " + run });
  ok("oversized-502", r.status === 502, String(r.status));
  const after = (await usageRows(""))?.total || 0;
  ok("oversized-one", (after || 0) === before + 1, "before=" + before + " after=" + after);
  const row = (await usageRows("purpose=advisor-research"))?.rows?.[0] || {};
  ok("oversized-unknown", row.cost == null, JSON.stringify(row).slice(0, 300));
}
// 3e. chat canary redacted, billing preserved
{
  const r = await post("/api/auditions", { question: "QA-HTTP500-CANARY " + run, profileJson: "{}" });
  ok("chat-canary-502", r.status === 502, String(r.status));
  ok("chat-canary-redacted", !String(r.text).includes("QA-CANARY"), String(r.text).slice(0, 300));
  const row = (await usageRows("purpose=audition"))?.rows?.[0] || {};
  ok("chat-canary-ledger-clean", !JSON.stringify(row).includes("QA-CANARY"), JSON.stringify(row).slice(0, 300));
  ok("chat-canary-id", (row.providerCallId || "") === "qa-canary-1", String(row.providerCallId));
}
// 3f. chat oversized: one unknown pair
{
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/auditions", { question: "QA-HTTP500-OVERSIZED " + run, profileJson: "{}" });
  ok("chat-oversized-502", r.status === 502, String(r.status));
  const after = (await usageRows(""))?.total || 0;
  ok("chat-oversized-one", (after || 0) === before + 1, "before=" + before);
  const row = (await usageRows("purpose=audition"))?.rows?.[0] || {};
  ok("chat-oversized-unknown", row.cost == null, JSON.stringify(row).slice(0, 300));
}
// 9h. hello-base64 is NOT a verifiable image: unknown + id preserved
{
  const q = await post("/api/roster/quick", { accountId: guid(), name: run + "-imghello", description: "image helper for " + run });
  const rid = q.json?.id || q.json?.Id;
  const r = await post("/api/roster/" + rid + "/image/generate", { count: 1, prompt: "QA-IMG-HELLO " + run });
  ok("img-hello-502", r.status === 502, String(r.status));
  const row = (await usageRows("purpose=image-generate"))?.rows?.[0] || {};
  ok("img-hello-unknown", row.cost == null && (row.providerCallId || "") === "qa-img-hello-1", JSON.stringify(row).slice(0, 300));
}
// 9i. malformed URI is invalid: unknown + id preserved
{
  const q = await post("/api/roster/quick", { accountId: guid(), name: run + "-imgbadurl", description: "image helper for " + run });
  const rid = q.json?.id || q.json?.Id;
  const r = await post("/api/roster/" + rid + "/image/generate", { count: 1, prompt: "QA-IMG-BADURL " + run });
  ok("img-badurl-502", r.status === 502, String(r.status));
  const row = (await usageRows("purpose=image-generate"))?.rows?.[0] || {};
  ok("img-badurl-unknown", row.cost == null && (row.providerCallId || "") === "qa-img-badurl-1", JSON.stringify(row).slice(0, 300));
}
// 9j. valid PNG + valid URL => partial local delivery failure with known bill (never partial success)
{
  const q = await post("/api/roster/quick", { accountId: guid(), name: run + "-imgpngurl", description: "image helper for " + run });
  const rid = q.json?.id || q.json?.Id;
  const before = (await usageRows(""))?.total || 0;
  const r = await post("/api/roster/" + rid + "/image/generate", { count: 2, prompt: "QA-IMG-PNGURL " + run });
  ok("img-pngurl-502", r.status === 502, String(r.status));
  const after = (await usageRows(""))?.total || 0;
  ok("img-pngurl-one", after === before + 1, "before=" + before + " after=" + after);
  const row = (await usageRows("purpose=image-generate"))?.rows?.[0] || {};
  ok("img-pngurl-known", row.cost != null && Math.abs(Number(row.cost) - 0.02) < 1e-9 && row.status === "failed" && (row.providerCallId || "") === "qa-img-pngurl-1", JSON.stringify(row).slice(0, 300));
}
// 9k. image HTTP error preserves id with unknown bill
{
  const q = await post("/api/roster/quick", { accountId: guid(), name: run + "-imgidonly", description: "image helper for " + run });
  const rid = q.json?.id || q.json?.Id;
  const r = await post("/api/roster/" + rid + "/image/generate", { count: 1, prompt: "QA-IMG-IDONLY " + run });
  ok("img-idonly-502", r.status === 502, String(r.status));
  const row = (await usageRows("purpose=image-generate"))?.rows?.[0] || {};
  ok("img-idonly-unknown", row.cost == null && (row.providerCallId || "") === "qa-img-failed-7", JSON.stringify(row).slice(0, 300));
}
// 12. invalid dates 400 on both routes; valid date filters work
{
  for (const bad of ["not-a-date", "2026-13-01", "2026-02-30"]) {
    const ru = await get("/api/usage?summary=true&day=" + encodeURIComponent(bad));
    ok("usage-badday-400-" + bad, ru.status === 400, String(ru.status));
    const rm = await get("/api/models/calls?summary=true&day=" + encodeURIComponent(bad));
    ok("modelcalls-badday-400-" + bad, rm.status === 400, String(rm.status));
  }
  const rf = await get("/api/usage?summary=true&from=2026-05-10&to=2026-05-01");
  ok("usage-range-400", rf.status === 400, String(rf.status));
  const rfm = await get("/api/models/calls?summary=true&from=2026-05-10&to=2026-05-01");
  ok("modelcalls-range-400", rfm.status === 400, String(rfm.status));
  const okDay = await get("/api/usage?summary=true&day=2000-01-01");
  ok("usage-valid-day-200", okDay.status === 200 && (okDay.json?.total ?? -1) === 0, okDay.status + " " + String(okDay.text).slice(0, 120));
  const okDayM = await get("/api/models/calls?summary=true&day=2000-01-01");
  ok("modelcalls-valid-day-200", okDayM.status === 200 && (okDayM.json?.total ?? -1) === 0, okDayM.status + " " + String(okDayM.text).slice(0, 120));
}
// 13. backend tag strict: storage must match requested mode
{
  const r = await get("/api/usage?summary=true&limit=5");
  const expectPg = TAG === "pg" ? "postgres-durable" : "memory-session-lifetime";
  ok("tag-storage-strict-" + TAG, r.status === 200 && r.json?.storage === expectPg, String(r.json?.storage) + " want " + expectPg);
}
// 14. exact IDs: nonempty GUID, no fallback-OR masks
{
  const u = (await usageRows(""))?.rows?.[0] || {};
  const m = (await modelRows(""))?.rows?.[0] || {};
  const guidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  ok("exact-usage-guid", typeof u.id === "string" && guidRe.test(u.id), String(u.id));
  ok("exact-modelcall-guid", typeof m.id === "string" && guidRe.test(m.id), String(m.id));
  ok("allocation-exact", ["Allocated", "Unallocated", "Missing"].includes(u.allocationLabel), String(u.allocationLabel));
  ok("hidden-exact", typeof u.hiddenPurpose === "boolean", String(u.hiddenPurpose));
}
// 11. capped/blocked provider calls are pre-dispatch: 402 adds no ledger/usage event
{
  const put = await req("PUT", "/api/spending", { monthlyCapUsd: 0, mode: "block" });
  ok("spend-cap-set", put.status === 200, String(put.status));
  const before = (await usageRows(""))?.total || 0;
  const r = await req("POST", "/api/auditions", { question: run + " capped", profileJson: "{}" }, { headers: { "x-user": "stranger-cap-nogrant" } });
  ok("capped-402", r.status === 402, r.status + " " + String(r.text).slice(0, 160));
  const after = (await usageRows(""))?.total || 0;
  ok("capped-no-event", after === before, "before=" + before + " after=" + after);
  const put2 = await req("PUT", "/api/spending", { monthlyCapUsd: null, mode: "warn" });
  ok("spend-cap-reset", put2.status === 200, String(put2.status));
}
console.log("phase9 usage-accounting: pass=" + pass + " fail=" + fail + (fail ? " FAILURES: " + failures.join(" | ") : ""));
process.exit(fail ? 1 : 0);
