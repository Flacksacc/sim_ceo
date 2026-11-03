import crypto from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "fs";
const API = "http://127.0.0.1:5095";
const FAKE_PORT = 5195;
const HIND_PORT = 5198;
const INSTANCE = "source-gov-qa";
const OUT = ".tmp/source-governance-extra-result.txt";
fs.mkdirSync(".tmp", { recursive: true });
fs.writeFileSync(OUT, "START extra " + new Date().toISOString() + "\n");
let pass = 0, fail = 0;
const failures = [];
function ok(n, c, e) { if (c) { pass++; fs.appendFileSync(OUT, "PASS " + n + "\n"); } else { fail++; failures.push(n + (e ? " :: " + e : "")); fs.appendFileSync(OUT, "FAIL " + n + (e ? " :: " + e : "") + "\n"); console.log("FAIL " + n + (e ? " :: " + e : "")); } }
async function req(m, p, b, o = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), o.timeout || 30000);
  try {
    const r = await fetch(API + p, { method: m, signal: ctl.signal, headers: { "content-type": "application/json", "x-user": "owner", ...(o.headers || {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
    const tx = await r.text(); let js = null; try { js = tx ? JSON.parse(tx) : null; } catch { }
    return { status: r.status, json: js, text: tx };
  } finally { clearTimeout(t); }
}
const get = (p, o) => req("GET", p, undefined, o);
const post = (p, b, o) => req("POST", p, b, o);
const put = (p, b, o) => req("PUT", p, b, o);
const patch = (p, b, o) => req("PATCH", p, b, o);
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function stateIs(s) { const t = String(s == null ? "" : s).trim().toLowerCase(); const map = { awaitingbrief: "0", active: "1", yielded: "2", paused: "3", wrappingup: "4" }; for (let k = 1; k < arguments.length; k++) { const n = arguments[k]; if (t === n || t === map[n]) return true; } return false; }
async function waitHealth(t) { const t0 = Date.now(); while (Date.now() - t0 < t) { try { const r = await fetch(API + "/health", { signal: AbortSignal.timeout(3000) }); if (r.ok) return true; } catch { } await sleep(500); } return false; }
function startProc(c, a, e, l) { const o = fs.openSync(l, "w"); const p = spawn(c, a, { env: { ...process.env, ...e }, stdio: ["ignore", o, o] }); return p; }
async function stopProc(p, label) {
  if (!p) return true;
  try { p.kill(); } catch { }
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) { if (p.exitCode !== null || p.signalCode !== null) return true; await sleep(250); }
  ok("proc-stop-" + label, false, "process did not exit; leaving for owner inspection (no blind kill)");
  return false;
}
async function upload(bid, fn, content, scope, mid) {
  const fd = new FormData(); fd.append("file", new Blob([content], { type: "text/plain" }), fn);
  if (scope) fd.append("scope", scope); if (mid) fd.append("meetingId", mid);
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try { const r = await fetch(API + "/api/boards/" + bid + "/sources/upload", { method: "POST", signal: ctl.signal, headers: { "x-user": "owner" }, body: fd }); const tx = await r.text(); let js = null; try { js = JSON.parse(tx); } catch { } return { status: r.status, json: js, text: tx }; } finally { clearTimeout(t); }
}
async function fakeLog() {
  try { const r = await fetch("http://127.0.0.1:" + FAKE_PORT + "/__log"); return await r.json(); } catch { return []; }
}
async function fakeLogReset() {
  try { await fetch("http://127.0.0.1:" + FAKE_PORT + "/__log", { method: "DELETE" }); } catch { }
}
async function waitDraftLatch(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const log = await fakeLog();
    if (log.some((e) => e.draft && e.sleep > 0)) return true;
    await sleep(200);
  }
  return false;
}
async function waitBriefLatch(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const log = await fakeLog();
    if (log.some((e) => !e.bid && e.sleep > 0)) return true;
    await sleep(200);
  }
  return false;
}
const hind = http.createServer((rq, rs) => { rs.writeHead(200, { "content-type": "application/json" }); rs.end(JSON.stringify([])); });
await new Promise((res, rej) => { hind.once("error", rej); hind.listen(HIND_PORT, "127.0.0.1", res); }).catch((e) => { ok("hind-port", false, String(e)); throw e; });
let fake = startProc("node", ["qa/fake-provider.mjs", "--port", String(FAKE_PORT)], { QA_DRAFT_SLEEP_ONLY: "1" }, ".tmp/sg-extra-fake.log");
await sleep(1500);
let api = startProc("dotnet", ["server/SimCEO.Api/bin/Debug/net10.0/SimCEO.Api.dll"], { META_API_KEY: "dummy-qa-key", META_API_BASE: "http://127.0.0.1:" + FAKE_PORT, HINDSIGHT_URL: "http://127.0.0.1:" + HIND_PORT, SIMCEO_INSTANCE: INSTANCE, ASPNETCORE_URLS: API }, ".tmp/sg-extra-api.log");
ok("extra-api-up", await waitHealth(30000), "no api");
{
  const h = await (await fetch(API + "/health")).json();
  ok("extra-identity", (h.instance || h.Instance) === INSTANCE, JSON.stringify(h));
}
async function setupBoard(tag) {
  const b = await post("/api/boards", { name: "sg-extra-" + tag + "-" + Date.now() });
  const bid = b.json.id;
  await post("/api/boards/" + bid + "/lead", { name: "Lead", roleLabel: "CEO", background: "b", familiarTopics: "f", simplerTopics: "s", commPrefs: "c" });
  const ACCT = crypto.randomUUID();
  const q = await post("/api/roster/quick", { accountId: ACCT, name: "adv-" + tag + "-" + Date.now(), description: "strategist helping" });
  const rid = q.json.id || q.json.entry?.id;
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  {
    const fd = new FormData(); fd.append("file", new Blob([PNG], { type: "image/png" }), "qa.png");
    await fetch(API + "/api/roster/" + rid + "/image/upload", { method: "POST", headers: { "x-user": "owner" }, body: fd });
  }
  const imgs = await get("/api/roster/" + rid + "/images");
  await post("/api/images/" + imgs.json[0].id + "/review", { decision: "accept" });
  const cp = await post("/api/roster/" + rid + "/copy", { boardId: bid, boardRole: "Strategist" });
  const aid = cp.json.id;
  await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
  return { bid, aid };
}
async function meetingState(bid, mid) {
  const ms = await get("/api/boards/" + bid + "/meetings");
  const m = (ms.json || []).find((x) => (x.id || x.Id) === mid);
  return { state: String(m.state || m.State || ""), gen: m.generation ?? m.Generation ?? 0 };
}
async function messages(bid, mid) {
  const r = await get("/api/meetings/" + mid + "/messages?take=100");
  return r.json || [];
}
// --- CASE 1: exclusion during an observed evidence-bearing draft ---
{
  const { bid } = await setupBoard("excl");
  const m = await post("/api/boards/" + bid + "/meetings", { title: "m-slow" });
  const mid = m.json.id;
  await patch("/api/meetings/" + mid, { brief: "slow brief" });
  // Sleep marker lives ONLY in the source text: bids carry no sources, drafts do.
  const up = await upload(bid, "slow.txt", "slow evidence alpha QA-SLEEP:4000 " + crypto.randomUUID(), "board");
  const sid = up.json.id;
  await post("/api/sources/" + sid + "/approve", {});
  await post("/api/meetings/" + mid + "/resume", {});
  let st0 = await meetingState(bid, mid);
  ok("case1-resumed", stateIs(st0.state, "active"), st0.state);
  // Control run first: no invalidation -> publishes.
  const ctl = await post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "control question, no sleep" }, { timeout: 60000 });
  const ctlMsgs = await messages(bid, mid);
  ok("case1-control-publishes", ctl.status === 200 && (Array.isArray(ctl.json.published ?? ctl.json.Published) ? (ctl.json.published ?? ctl.json.Published).length : 0) >= 1 && ctlMsgs.length >= 1, ctl.status + " " + (ctl.text || "").slice(0, 300));
  // New owner turn: the control run consumed this turn's advisor reply, so open
  // a fresh turn before the slow run or no draft request would be issued.
  const lead2 = await post("/api/meetings/" + mid + "/messages", { content: "follow-up question about alpha" });
  ok("case1-new-turn", lead2.status === 201, lead2.status + " " + lead2.text.slice(0, 200));
  const msgsBase = await messages(bid, mid);
  const seqBefore = msgsBase.map((x) => x.sequence ?? x.Sequence);
  await fakeLogReset();
  const runP = post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "slow question about alpha" }, { timeout: 60000 });
  ok("case1-draft-observed", await waitDraftLatch(25000), "no evidence-bearing draft request reached the provider");
  const genBefore = (await meetingState(bid, mid)).gen;
  const ex = await post("/api/sources/" + sid + "/exclude", {});
  ok("case1-exclude-200", ex.status === 200, ex.status + " " + ex.text.slice(0, 200));
  let runR;
  try { runR = await runP; } catch (e) { runR = { status: 0, text: String(e), json: null }; }
  const msgsAfter = await messages(bid, mid);
  const seqAfter = msgsAfter.map((x) => x.sequence ?? x.Sequence);
  ok("case1-slow-discarded", (runR.status === 200 && (Array.isArray(runR.json.published ?? runR.json.Published) ? (runR.json.published ?? runR.json.Published).length : -1) === 0) || (runR.status === 409 && /paused|discard|interrupt/i.test(runR.text || "")), runR.status + " " + (runR.text || JSON.stringify(runR.json)).slice(0, 500));
  ok("case1-history-unchanged", JSON.stringify(seqAfter) === JSON.stringify(seqBefore), JSON.stringify(seqBefore) + " vs " + JSON.stringify(seqAfter));
  const st1 = await meetingState(bid, mid);
  ok("case1-paused", stateIs(st1.state, "paused"), st1.state);
  ok("case1-gen-inc", st1.gen > genBefore, genBefore + "->" + st1.gen);
  const cx = await get("/api/boards/" + bid + "/context");
  ok("case1-context-empty", (cx.json.approved ?? cx.json.Approved) === 0, JSON.stringify(cx.json).slice(0, 300));
}
// --- CASE 2: policy change during an observed draft (separate run) ---
{
  const { bid } = await setupBoard("pol");
  const m = await post("/api/boards/" + bid + "/meetings", { title: "m-pol" });
  const mid = m.json.id;
  await patch("/api/meetings/" + mid, { brief: "policy brief" });
  const up = await upload(bid, "polslow.txt", "policy evidence beta QA-SLEEP:4000 " + crypto.randomUUID(), "board");
  const sid = up.json.id;
  await post("/api/sources/" + sid + "/approve", {});
  await post("/api/meetings/" + mid + "/resume", {});
  await fakeLogReset();
  const runP = post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "policy slow question" }, { timeout: 60000 });
  ok("case2-draft-observed", await waitDraftLatch(25000), "no draft latch");
  const genBefore = (await meetingState(bid, mid)).gen;
  const msgsBefore = await messages(bid, mid);
  const pol = await put("/api/boards/" + bid + "/source-policy", { blockedTypes: "", mode: "wikiOnly" });
  ok("case2-policy-200", pol.status === 200, pol.status + " " + pol.text.slice(0, 200));
  let runR;
  try { runR = await runP; } catch (e) { runR = { status: 0, text: String(e), json: null }; }
  const msgsAfter = await messages(bid, mid);
  ok("case2-slow-discarded", (runR.status === 200 && (Array.isArray(runR.json.published ?? runR.json.Published) ? (runR.json.published ?? runR.json.Published).length : -1) === 0) || (runR.status === 409 && /paused|discard|interrupt/i.test(runR.text || "")), runR.status + " " + (runR.text || JSON.stringify(runR.json)).slice(0, 500));
  ok("case2-no-new-messages", msgsAfter.length === msgsBefore.length, msgsBefore.length + " vs " + msgsAfter.length);
  const st1 = await meetingState(bid, mid);
  ok("case2-paused", stateIs(st1.state, "paused"), st1.state);
  ok("case2-gen-inc", st1.gen > genBefore, genBefore + "->" + st1.gen);
}
// --- CASE 3: briefing invalidated during generation is discarded (409, no note) ---
{
  const { bid } = await setupBoard("brief");
  const m = await post("/api/boards/" + bid + "/meetings", { title: "m-brief" });
  const mid = m.json.id;
  await patch("/api/meetings/" + mid, { brief: "briefing brief" });
  const up = await upload(bid, "brief.txt", "briefing evidence QA-SLEEP:4000 " + crypto.randomUUID(), "board");
  const sid = up.json.id;
  await post("/api/sources/" + sid + "/approve", {});
  await post("/api/meetings/" + mid + "/resume", {});
  const notes0 = await get("/api/meetings/" + mid + "/notes?kind=briefing");
  const n0 = (notes0.json || []).length;
  await fakeLogReset();
  const briefP = post("/api/meetings/" + mid + "/briefings", { topic: "QA-SLEEP:4000 slow briefing topic" }, { timeout: 60000 });
  ok("case3-brief-observed", await waitBriefLatch(25000), "no briefing provider request observed");
  const ex = await post("/api/sources/" + sid + "/exclude", {});
  ok("case3-exclude-200", ex.status === 200, ex.status + " " + ex.text.slice(0, 200));
  let briefR;
  try { briefR = await briefP; } catch (e) { briefR = { status: 0, text: String(e), json: null }; }
  ok("case3-brief-discarded-409", briefR.status === 409 && /discard/i.test(briefR.text || ""), briefR.status + " " + (briefR.text || "").slice(0, 300));
  const notes1 = await get("/api/meetings/" + mid + "/notes?kind=briefing");
  ok("case3-no-note-stored", (notes1.json || []).length === n0, n0 + " vs " + (notes1.json || []).length);
  const st1 = await meetingState(bid, mid);
  ok("case3-paused", stateIs(st1.state, "paused"), st1.state);
}
fs.appendFileSync(OUT, "DONE pass=" + pass + " fail=" + fail + " failures=" + JSON.stringify(failures) + "\n");
await stopProc(api, "extra-api");
try { fake.kill(); } catch { }
hind.close();
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 500);