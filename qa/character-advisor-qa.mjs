// Character-advisor QA: proves the 7 reviewed findings fixed, end to end.
// Talks only to the API under test (QA_API) pointed at the fake provider;
// fake prompt log (QA_FAKE/__log) proves what the model actually consumed.
// No model self-ratings are used as proof anywhere.
// The timeout/deadline legs need a second API with a short research deadline:
// this script spawns and kills its OWN timeout API child (no human services
// touched). Requires QA_API_DLL = absolute path to the tested SimCEO.Api.dll.
import { spawn } from "node:child_process";
const API = process.env.QA_API || "http://127.0.0.1:5159";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:5252";
const API_DLL = process.env.QA_API_DLL || "";
const run = "cqa-" + Date.now().toString(36);
let pass = 0, fail = 0; const failures = [];
function hasAnswer(j) { return !!j && typeof j === "object" && ("answer" in j); }
function ok(name, cond, extra) { if (cond) pass++; else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); } }
async function reqBase(base, method, path, body, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), opts.timeout || 30000);
  try {
    const r = await fetch(base + path, { method, signal: opts.signal || ctl.signal,
      headers: { "content-type": "application/json", "x-user": opts.user || "owner", ...(opts.headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const req = (m, p, b, o) => reqBase(API, m, p, b, o);
const get = (p, o) => req("GET", p, undefined, o);
const post = (p, b, o) => req("POST", p, b, o);
const put = (p, b, o) => req("PUT", p, b, o);
const guid = () => globalThis.crypto.randomUUID();
const camel = (o, k) => { if (!o || typeof o !== "object") return undefined; if (k in o) return o[k]; const lo = k.toLowerCase(); for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key]; return undefined; };
const ACCT = guid();
const U2 = "qa-u2-" + run;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
async function uploadPortrait(rid, user, apiBase) {
  const base = apiBase || API;
  const form = new FormData(); form.append("file", new Blob([PNG], { type: "image/png" }), "qa.png");
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(base + "/api/roster/" + rid + "/image/upload", { method: "POST", signal: ctl.signal, headers: { "x-user": user || "owner" }, body: form });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
async function fakeLog() { const r = await fetch(FAKE + "/__log"); return r.json(); }
async function fakeLogClear() { await fetch(FAKE + "/__log", { method: "DELETE" }); }
async function waitForLog(pred, timeoutMs, label) {
  const end = Date.now() + (timeoutMs || 20000);
  while (Date.now() < end) {
    try {
      const log = await fakeLog();
      if (log.some(pred)) return true;
    } catch { }
    await new Promise((r) => setTimeout(r, 250));
  }
  ok("waitlog-" + (label || "x"), false, "prompt never dispatched");
  return false;
}
async function getEntry(rid, apiBase) {
  const r = await reqBase(apiBase || API, "GET", "/api/roster?accountId=" + ACCT, undefined, {});
  const row = (r.json || []).find((x) => String(camel(x.entry || x, "id") || "").toLowerCase() === String(rid).toLowerCase());
  return camel(row, "entry") || row || null;
}
async function getProfile(rid, apiBase) {
  const e = await getEntry(rid, apiBase);
  try { return JSON.parse(camel(e, "profileJson") || "{}"); } catch { return {}; }
}
async function makeBoard(name) {
  const r = await post("/api/boards", { name, mission: run + " mission", stage: "qa" });
  ok("board-" + name, r.status === 201 && camel(r.json, "id"), r.status + " " + r.text.slice(0, 160));
  return camel(r.json, "id");
}
async function readyAdvisor(boardId, role, seedRid) {
  let rid = seedRid;
  if (!rid) {
    const q = await post("/api/roster/quick", { accountId: ACCT, name: run + "-" + role, description: role + " helping with " + run + " port operations." });
    if (q.status !== 201) return { error: "quick:" + q.status + " " + q.text.slice(0, 200) };
    rid = camel(q.json, "id");
  }
  const up = await uploadPortrait(rid);
  if (up.status !== 201) return { error: "upload:" + up.status + " " + up.text.slice(0, 200) };
  const imgs = await get("/api/roster/" + rid + "/images");
  const imgId = camel(imgs.json?.[0], "id");
  const rev = await post("/api/images/" + imgId + "/review", { decision: "accept" });
  if (rev.status !== 200) return { error: "review:" + rev.status + " " + rev.text.slice(0, 200) };
  const cp = await post("/api/roster/" + rid + "/copy", { boardId, boardRole: role });
  if (cp.status !== 201) return { error: "copy:" + cp.status + " " + cp.text.slice(0, 200) };
  const aid = camel(cp.json, "id");
  const ap = await post("/api/boards/" + boardId + "/advisors/" + aid + "/approve", {});
  if (ap.status !== 200) return { error: "approve:" + ap.status + " " + ap.text.slice(0, 200) };
  return { rid, aid };
}
async function approveAgain(boardId, aid) {
  const sy = await post("/api/boards/" + boardId + "/advisors/" + aid + "/sync-roster", {});
  if (sy.status !== 200) return "sync:" + sy.status + " " + sy.text.slice(0, 200);
  const ap = await post("/api/boards/" + boardId + "/advisors/" + aid + "/approve", {});
  if (ap.status !== 200) return "approve:" + ap.status + " " + ap.text.slice(0, 200);
  return null;
}
let timeoutApi = null;
let timeoutBase = "";
async function spawnTimeoutApi() {
  if (!API_DLL) { ok("timeout-api-dll", false, "QA_API_DLL (absolute path to tested SimCEO.Api.dll) is required"); return null; }
  const port = 5171;
  try {
    const pre = await fetch("http://127.0.0.1:" + port + "/health", { signal: AbortSignal.timeout(3000) });
    if (pre.ok) { ok("timeout-api-port", false, "port 5171 already in use; refusing to disturb it"); return null; }
  } catch { }
  const child = spawn("dotnet", [API_DLL], { env: { ...process.env, META_API_BASE: FAKE.replace(/\/$/, "") , META_API_KEY: "qa-key", ASPNETCORE_URLS: "http://127.0.0.1:" + port, SIMCEO_RESEARCH_DEADLINE_SEC: "4" }, stdio: "ignore", windowsHide: true });
  timeoutBase = "http://127.0.0.1:" + port;
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    try {
      const r = await fetch(timeoutBase + "/health", { signal: AbortSignal.timeout(3000) });
      if (r.ok) { timeoutApi = child; return timeoutBase; }
    } catch { }
    await new Promise((r) => setTimeout(r, 500));
  }
  try { child.kill(); } catch { }
  ok("timeout-api-spawn", false, "own timeout API child never became healthy");
  return null;
}
async function killTimeoutApi() {
  if (!timeoutApi) return;
  try { timeoutApi.kill(); } catch { }
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (timeoutApi.exitCode !== null || timeoutApi.signalCode) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  timeoutApi = null;
}
process.on("exit", () => { try { timeoutApi && timeoutApi.kill(); } catch { } });
// ---------- 1: seed + save validation ----------
console.log("1: seed + save validation");
const seed = await post("/api/roster/quick", { accountId: ACCT, name: "Harbor Master Hana", description: "Runs harbor traffic and berth scheduling for a busy container port. Writes documentation examples and port operations guides for harbor training.", background: "Twenty years directing harbor pilots through storm seasons.", sourceUrls: ["https://example.com/"] });
ok("seed-201", seed.status === 201, seed.status + " " + seed.text.slice(0, 200));
const hanaRid = camel(seed.json, "id");
const hanaProfile = JSON.parse(camel(seed.json, "profileJson") || "{}");
ok("seed-3keys", ["contributionCriteria", "reasoningApproach", "responseStyle"].every((k) => typeof hanaProfile[k] === "string" && hanaProfile[k].includes("Seed (pending research)")), JSON.stringify(Object.keys(hanaProfile)).slice(0, 200));
ok("seed-inputs-persisted", (camel(seed.json, "researchInputsJson") || "").includes("example.com"), (camel(seed.json, "researchInputsJson") || "").slice(0, 160));
const badUrl = await post("/api/roster/quick", { accountId: ACCT, name: "Bad Url", description: "long enough description here.", sourceUrls: ["ftp://example.com/x"] });
ok("seed-badurl-400", badUrl.status === 400, badUrl.status + " " + badUrl.text.slice(0, 160));
const manyUrls = await post("/api/roster/quick", { accountId: ACCT, name: "Many Urls", description: "long enough description here.", sourceUrls: ["https://a.example/1", "https://a.example/2", "https://a.example/3", "https://a.example/4", "https://a.example/5", "https://a.example/6"] });
ok("seed-manyurls-400", manyUrls.status === 400, manyUrls.status + " " + manyUrls.text.slice(0, 160));
const overProfile = JSON.stringify({ fictional: true, contributionCriteria: "C".repeat(2001), reasoningApproach: "ok reasoning", responseStyle: "ok style" });
const overSave = await put("/api/roster/" + hanaRid, { profileJson: overProfile });
ok("save-oversize-para-400", overSave.status === 400 && overSave.text.includes("contributionCriteria") && overSave.text.includes("2001"), overSave.status + " " + overSave.text.slice(0, 200));
const longDesc = "D".repeat(4000);
const longSeed = await post("/api/roster/quick", { accountId: ACCT, name: "Long Desc Len", description: longDesc });
const longProf = JSON.parse(camel(longSeed.json, "profileJson") || "{}");
ok("seed-longdesc-valid", longSeed.status === 201 && (longProf.contributionCriteria || "").length <= 2000 && (longProf.contributionCriteria || "").includes("see full description") && (camel(longSeed.json, "description") || "").length === 4000, (longProf.contributionCriteria || "").length + " chars");
const objSave = await put("/api/roster/" + hanaRid, { profileJson: { fictional: true, contributionCriteria: "Seed obj-form check.", reasoningApproach: "Seed obj-form reason.", responseStyle: "Seed obj-form style." } });
ok("save-object-form-200", objSave.status === 200, objSave.status + " " + objSave.text.slice(0, 200));
const reSeed = await getProfile(hanaRid);
ok("save-object-form-roundtrip", reSeed.contributionCriteria === "Seed obj-form check.", JSON.stringify(reSeed).slice(0, 160));

// ---------- 2: research grounded compile (strict fetch + dossier assert) ----------
console.log("2: research grounded compile");
const res = await post("/api/roster/" + hanaRid + "/research", { focus: "harbor logistics" }, { timeout: 170000 });
ok("research-200", res.status === 200, res.status + " " + res.text.slice(0, 300));
const draft = res.json?.draftProfile || res.json?.DraftProfile;
ok("research-3paras", draft && draft.contributionCriteria?.includes("QA-CRITERIA for Harbor Master Hana") && draft.reasoningApproach?.includes("QA-REASON for Harbor Master Hana") && draft.responseStyle?.includes("QA-STYLE for Harbor Master Hana"), (draft === undefined ? "undefined" : JSON.stringify(draft)).slice(0, 300));
ok("research-draftstatus-done", (res.json?.draftStatus || res.json?.DraftStatus) === "done", res.text.slice(0, 200));
const rget = await get("/api/roster/" + hanaRid + "/research");
ok("research-get-done", rget.json?.stage === "done" && rget.json?.draftStatus === "done" && rget.json?.running === false && !!rget.json?.researchedAt, rget.text.slice(0, 300));
ok("research-version-bump", rget.json?.version >= 2, rget.text.slice(0, 200));
const hanaResearchedAt = rget.json?.researchedAt;
const exRefs = res.json?.evidenceRefs || [];
const exEntry = exRefs.find((e) => (e.url || e.Url || "").includes("example.com"));
ok("research-ownerurl-tracked", !!exEntry && (exEntry.ownerSupplied ?? exEntry.OwnerSupplied) === true, (exEntry ? JSON.stringify(exEntry) : "missing").slice(0, 300));
const excerp = exEntry?.excerpt || exEntry?.Excerpt || "";
ok("research-fetch-succeeded", !!excerp, "owner URL must actually fetch (no conditional pass): " + (exEntry ? JSON.stringify(exEntry) : "missing").slice(0, 200));
{
  const log = await fakeLog();
  const respInputs = log.filter((e) => e.path === "responses").map((e) => e.full).join("\n");
  ok("research-fetch-grounded", respInputs.includes(excerp.slice(0, 60)), "excerpt not found in grounded prompt");
  const compileCalls = log.filter((e) => e.path === "chat" && (e.full || "").includes("COMPILE-CHARACTER-PARAGRAPHS"));
  ok("research-compile-dossier", compileCalls.length >= 1 && compileCalls.every((c) => c.full.includes("Dossier") && c.full.includes("QA grounded claim line one")), "compile calls=" + compileCalls.length);
}
// ---------- 3: F1 save preserves pinned research (no endless loop) ----------
console.log("3: F1 save preserves pinned research");
const bid = await makeBoard(run + "-meet");
await post("/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Lead" });
const ha = await readyAdvisor(bid, "Harbormaster", hanaRid);
ok("hana-board-ready", !ha.error, ha.error || "");
const coleSeed = await post("/api/roster/quick", { accountId: ACCT, name: "Customs Auditor Cole", description: "Audits customs declarations and tariff compliance at the same port." });
const coleRid = camel(coleSeed.json, "id");
const ca = await readyAdvisor(bid, "Customs", coleRid);
ok("cole-board-ready", !ca.error, ca.error || "");
const padC = " Harbor detail: pilots, tugs, tide windows, storm routing, berth priority, queue fairness, night ops, fog signals.";
const padR = " Reasoning detail: compare options, check assumptions, demand evidence, challenge unsupported premises, agree when supported.";
const padS = " Style detail: terse on radio, formal in reports, blunt about risk, diplomatic with crew, detailed when evidence allows.";
const editedProfile = JSON.stringify({ fictional: true, name: "Harbor Master Hana", contributionCriteria: "QA-CRITERIA-EDITED harbor revised: contributes storm-routing and tug scheduling; abstains on tariffs." + padC.repeat(9) + " END-CRIT-1", reasoningApproach: "QA-REASON-EDITED: decides from live berth telemetry; challenges queue-jumping." + padR.repeat(9) + " END-REAS-1", responseStyle: "QA-STYLE-EDITED: terse on radio, formal in reports." + padS.repeat(10) + " END-STYLE-1" });
const save = await put("/api/roster/" + hanaRid, { profileJson: editedProfile });
ok("save-200", save.status === 200, save.status + " " + save.text.slice(0, 200));
ok("save-version-bump", (camel(save.json, "version") ?? 0) > rget.json.version, save.text.slice(0, 200));
const reload = await getEntry(hanaRid);
ok("save-reload-profile", (camel(reload, "profileJson") || "").includes("QA-CRITERIA-EDITED"), (camel(reload, "profileJson") || "").slice(0, 160));
const rsave = await get("/api/roster/" + hanaRid + "/research");
ok("save-preserves-proof", rsave.json?.draftStatus === "saved" && !!rsave.json?.researchedAt && (rsave.json?.evidenceCount ?? 0) >= 1 && JSON.stringify(rsave.json?.researchJson || "").includes("savedProfileHash"), rsave.text.slice(0, 400));
ok("save-no-rerun", rsave.json?.researchedAt === hanaResearchedAt, "researchedAt changed without rerun");
const comp = await get("/api/roster/" + hanaRid + "/completeness");
ok("save-complete", comp.json?.complete === true, comp.text.slice(0, 200));
const syncErr = await approveAgain(bid, ha.aid, hanaRid);
ok("hana-reapproved-no-rerun", !syncErr, syncErr || "");
const ivSeed = await post("/api/roster/quick", { accountId: ACCT, name: "Invalidate Ivan", description: "Subject-change invalidation probe advisor." });
const ivanRid = camel(ivSeed.json, "id");
await uploadPortrait(ivanRid);
const ivImgs = await get("/api/roster/" + ivanRid + "/images");
await post("/api/images/" + camel(ivImgs.json?.[0], "id") + "/review", { decision: "accept" });
const ivRes = await post("/api/roster/" + ivanRid + "/research", { focus: "harbor logistics" }, { timeout: 170000 });
ok("ivan-research-done", ivRes.status === 200 && (ivRes.json?.draftStatus) === "done", ivRes.status + " " + ivRes.text.slice(0, 200));
const ivSave = await put("/api/roster/" + ivanRid, { name: "Invalidate Ivan Renamed" });
ok("ivan-rename-200", ivSave.status === 200, ivSave.status + " " + ivSave.text.slice(0, 160));
const ivGet = await get("/api/roster/" + ivanRid + "/research");
ok("ivan-invalidated", ivGet.json?.running === false && (ivGet.json?.researchedAt ?? null) === null && (ivGet.json?.stage === "interrupted"), ivGet.text.slice(0, 300));
const ivBoard = await makeBoard(run + "-inv");
const ivCp = await post("/api/roster/" + ivanRid + "/copy", { boardId: ivBoard, boardRole: "Ivan" });
ok("ivan-copy-blocked", ivCp.status === 409 && ivCp.text.toLowerCase().includes("research"), ivCp.status + " " + ivCp.text.slice(0, 200));

// ---------- 4: meeting bid+reply consume full paragraphs ----------
console.log("4: meeting behavior full paragraphs");
const mid = await post("/api/boards/" + bid + "/meetings", { title: run + " mtg", brief: "Port congestion and tariff review." });
const midId = camel(mid.json, "id");
ok("meeting-created", mid.status === 201 && midId, mid.status + " " + mid.text.slice(0, 160));
await post("/api/meetings/" + midId + "/messages", { sender: "lead", content: "How do we clear the berth backlog before Friday?" });
await fakeLogClear();
const run1 = await post("/api/meetings/" + midId + "/run", { prompt: "berth backlog question" }, { timeout: 120000 });
ok("run1-200", run1.status === 200, run1.status + " " + run1.text.slice(0, 300));
ok("run1-published", (run1.json?.published?.length || 0) >= 1, run1.text.slice(0, 300));
const log1 = await fakeLog();
const bids = log1.filter((e) => e.bid);
const drafts = log1.filter((e) => e.draft);
ok("run1-bids-logged", bids.length >= 2, "bids=" + bids.length);
const hanaBid = bids.find((b) => b.full.includes("Harbor Master Hana"));
const coleBid = bids.find((b) => b.full.includes("Customs Auditor Cole"));
ok("bid-hana-full", !!hanaBid && hanaBid.full.includes("Contribution criteria:") && hanaBid.full.includes("Reasoning approach:") && hanaBid.full.includes("Response style:") && hanaBid.full.includes("END-CRIT-1") && hanaBid.full.includes("END-REAS-1") && hanaBid.full.includes("END-STYLE-1"), (hanaBid?.full || "").slice(-200));
ok("bid-cole-full", !!coleBid && coleBid.full.includes("Contribution criteria:") && coleBid.full.includes("Customs Auditor Cole"), (coleBid?.full || "").slice(0, 200));
ok("bid-per-advisor", !!hanaBid && !!coleBid && !hanaBid.full.includes("Customs Auditor Cole") && !coleBid.full.includes("Harbor Master Hana"), "bid packets must be per-character");
ok("reply-all3-labels", drafts.length >= 1 && drafts.every((d) => d.full.includes("Contribution criteria:") && d.full.includes("Reasoning approach:") && d.full.includes("Response style:")), "drafts=" + drafts.length);
ok("reply-hana-endmarkers", drafts.some((d) => d.full.includes("END-CRIT-1") && d.full.includes("END-REAS-1") && d.full.includes("END-STYLE-1")), "drafts=" + drafts.length);
// ---------- 5: F3 essential question incl. continue-run lead message ----------
console.log("5: F3 essential question");
const midQ = camel((await post("/api/boards/" + bid + "/meetings", { title: run + " mtg-q", brief: "Question probe." })).json, "id");
await post("/api/meetings/" + midQ + "/messages", { sender: "lead", content: "Unrelated opener about catering for the crew." });
const longQ = "Berth backlog question: which vessels get priority at dawn? " + "Consider tide windows, tug availability, pilot shifts, fog risk, union hours. ".repeat(18) + " DECISIVE: should we hold the outer anchorage overnight? TAIL-7734";
await fakeLogClear();
const runQ = await post("/api/meetings/" + midQ + "/run", { prompt: longQ }, { timeout: 120000 });
ok("runQ-200", runQ.status === 200, runQ.status + " " + runQ.text.slice(0, 200));
const logQ = await fakeLog();
const draftsQ = logQ.filter((e) => e.draft);
ok("runQ-essential", draftsQ.length >= 1 && draftsQ.every((d) => d.full.includes("CURRENT REQUEST") && d.full.includes("TAIL-7734") && d.full.includes("which vessels get priority at dawn?")), "drafts=" + draftsQ.length);
const midQ2 = camel((await post("/api/boards/" + bid + "/meetings", { title: run + " mtg-q2", brief: "Continue probe." })).json, "id");
const leadLong = "Lead question for the board: should we reroute the evening tide convoy around the northern shoal markers? " + "Harbor context and pilot rotation notes. ".repeat(20) + " DECISIVE LEAD TAIL-8871";
await post("/api/meetings/" + midQ2 + "/messages", { sender: "lead", content: leadLong });
await fakeLogClear();
const runQ2 = await post("/api/meetings/" + midQ2 + "/run", { prompt: "Continue the discussion." }, { timeout: 120000 });
ok("runQ2-200", runQ2.status === 200, runQ2.status + " " + runQ2.text.slice(0, 200));
const logQ2 = await fakeLog();
const draftsQ2 = logQ2.filter((e) => e.draft);
const bidsQ2 = logQ2.filter((e) => e.bid);
ok("runQ2-lead-essential", draftsQ2.length >= 1 && draftsQ2.every((d) => d.full.includes("TAIL-8871") && d.full.includes("LATEST LEAD MESSAGE")), "drafts=" + draftsQ2.length);
ok("runQ2-bid-lead", bidsQ2.length >= 1 && bidsQ2.every((b) => b.full.includes("TAIL-8871")), "bids=" + bidsQ2.length);

// ---------- 6: stale mid-run edit discards pending output ----------
console.log("6: stale mid-run edit discards pending output");
const mid2 = camel((await post("/api/boards/" + bid + "/meetings", { title: run + " mtg2", brief: "Stale window." })).json, "id");
await post("/api/meetings/" + mid2 + "/messages", { sender: "lead", content: "Routine berth question." });
await fakeLogClear();
const slowRun = post("/api/meetings/" + mid2 + "/run", { prompt: "QA-SLEEP:6000 stale window question" }, { timeout: 120000 });
await waitForLog((e) => e.bid && (e.full || "").includes("stale window question"), 20000, "stale-bid");
const hanaCur = await getProfile(hanaRid);
hanaCur.contributionCriteria = "QA-CRITERIA-STALE947: changed mid-run, must not publish old output.";
hanaCur.reasoningApproach = "QA-REASON-STALE947.";
hanaCur.responseStyle = "QA-STYLE-STALE947.";
const saveMid = await put("/api/roster/" + hanaRid, { profileJson: JSON.stringify(hanaCur) });
ok("stale-midrun-save", saveMid.status === 200, saveMid.status + " " + saveMid.text.slice(0, 160));
const slowRes = await slowRun;
ok("stale-run-200", slowRes.status === 200, slowRes.status + " " + slowRes.text.slice(0, 300));
const yieldedReasons = (slowRes.json?.yielded || []).map((y) => (y.reason || y.Reason || "") + ":" + (y.advisor || y.Advisor || ""));
const hanaYield = yieldedReasons.find((s) => s.includes("Harbormaster"));
ok("stale-hana-discarded", !!hanaYield && /stale-profile|stale-context|not-eligible|reapproval-required/.test(hanaYield), JSON.stringify(yieldedReasons).slice(0, 400));
const colePublished = (slowRes.json?.published || []).filter((p) => (p.advisorName || p.AdvisorName || "").includes("Customs"));
ok("stale-cole-unaffected", colePublished.length === 1, slowRes.text.slice(0, 300));
const syncErr2 = await approveAgain(bid, ha.aid, hanaRid);
ok("hana-reapproved2", !syncErr2, syncErr2 || "");
// ---------- 7: F2 chat post-await guards (race-free) ----------
console.log("7: F2 chat edit/archive/revoke/restore discard stale output");
async function chatSeed(name) {
  const q = await post("/api/roster/quick", { accountId: ACCT, name, description: name + " helps with chat guard probes, long enough." });
  return camel(q.json, "id");
}
const chatEditRid = await chatSeed("Chat Edit Ed");
const chatSlowEdit = post("/api/roster/" + chatEditRid + "/chat", { message: "QA-SLEEP:6000 advise on berths please" }, { timeout: 60000 });
await waitForLog((e) => e.path === "chat" && (e.full || "").includes("advise on berths please"), 20000, "chat-edit-dispatch");
const chatProf = await getProfile(chatEditRid);
chatProf.contributionCriteria = "Edited mid-chat criteria.";
await put("/api/roster/" + chatEditRid, { profileJson: JSON.stringify(chatProf) });
const chatEditRes = await chatSlowEdit;
ok("chat-edit-409", chatEditRes.status === 409 && chatEditRes.text.includes("stale"), chatEditRes.status + " " + chatEditRes.text.slice(0, 200));
const chatArchRid = await chatSeed("Chat Archive Al");
const chatSlowArch = post("/api/roster/" + chatArchRid + "/chat", { message: "QA-SLEEP:6000 advise on tides please" }, { timeout: 60000 });
await waitForLog((e) => e.path === "chat" && (e.full || "").includes("advise on tides please"), 20000, "chat-arch-dispatch");
await post("/api/roster/" + chatArchRid + "/archive", { archived: true });
const chatArchRes = await chatSlowArch;
ok("chat-archive-409", chatArchRes.status === 409 && chatArchRes.text.includes("archived"), chatArchRes.status + " " + chatArchRes.text.slice(0, 200));
const revBoard = await makeBoard(run + "-revoke");
const revSeed = await chatSeed("Chat Revoke Rae");
await uploadPortrait(revSeed);
const revImgs = await get("/api/roster/" + revSeed + "/images");
await post("/api/images/" + camel(revImgs.json?.[0], "id") + "/review", { decision: "accept" });
const revCp = await post("/api/roster/" + revSeed + "/copy", { boardId: revBoard, boardRole: "Rae" });
ok("revoke-copy-201", revCp.status === 201, revCp.status + " " + revCp.text.slice(0, 160));
const grant = await post("/api/boards/" + revBoard + "/grants", { userKey: U2, access: "read" });
ok("revoke-grant-201", grant.status === 201, grant.status + " " + grant.text.slice(0, 160));
const grantId = camel(grant.json, "id");
const preChat = await post("/api/roster/" + revSeed + "/chat", { message: "Hello, can you hear me?" }, { user: U2 });
ok("revoke-prechat-200", preChat.status === 200, preChat.status + " " + preChat.text.slice(0, 160));
const chatSlowRev = post("/api/roster/" + revSeed + "/chat", { message: "QA-SLEEP:6000 advise on fog signals" }, { user: U2, timeout: 60000 });
await waitForLog((e) => e.path === "chat" && (e.full || "").includes("advise on fog signals"), 20000, "chat-revoke-dispatch");
await req("DELETE", "/api/grants/" + grantId, undefined, {});
const chatRevRes = await chatSlowRev;
ok("chat-revoke-403", chatRevRes.status === 403, chatRevRes.status + " " + chatRevRes.text.slice(0, 200));
const rstSeed = await chatSeed("Chat Restore Ren");
const bk = await get("/api/backup");
ok("backup-200", bk.status === 200 && bk.json?.snapshot, bk.status + " " + bk.text.slice(0, 120));
const chatSlowRst = post("/api/roster/" + rstSeed + "/chat", { message: "QA-SLEEP:6000 advise on night ops" }, { timeout: 60000 });
await waitForLog((e) => e.path === "chat" && (e.full || "").includes("advise on night ops"), 20000, "chat-restore-dispatch");
const rst = await post("/api/backup/restore", { snapshot: bk.json.snapshot, hash: bk.json.hash });
ok("restore-200", rst.status === 200, rst.status + " " + rst.text.slice(0, 200));
const chatRstRes = await chatSlowRst;
ok("chat-restore-409", chatRstRes.status === 409 && chatRstRes.text.includes("restored") && !hasAnswer(chatRstRes.json), chatRstRes.status + " " + chatRstRes.text.slice(0, 200));
// ---------- 8: F2 audition guards + string/object inline ----------
console.log("8: F2 audition guards");
const audSlow = post("/api/auditions", { rosterId: hanaRid, question: "QA-SLEEP:6000 how do you handle a tariff dispute?" }, { timeout: 60000 });
await waitForLog((e) => e.path === "chat" && (e.full || "").includes("AUDITION") && (e.full || "").includes("tariff dispute"), 20000, "aud-dispatch");
{
  const cur = await getProfile(hanaRid);
  cur.responseStyle = (cur.responseStyle || "") + " Audition-race tweak.";
  await put("/api/roster/" + hanaRid, { profileJson: JSON.stringify(cur) });
}
const audEditRes = await audSlow;
ok("audition-edit-409", audEditRes.status === 409 && audEditRes.text.includes("stale"), audEditRes.status + " " + audEditRes.text.slice(0, 200));
const audArchSeed = await chatSeed("Audition Archive Ana");
const audSlowArch = post("/api/auditions", { rosterId: audArchSeed, question: "QA-SLEEP:6000 audition while archived?" }, { timeout: 60000 });
await waitForLog((e) => e.path === "chat" && (e.full || "").includes("audition while archived"), 20000, "aud-arch-dispatch");
await post("/api/roster/" + audArchSeed + "/archive", { archived: true });
const audArchRes = await audSlowArch;
ok("audition-archive-409", audArchRes.status === 409 && audArchRes.text.includes("archived"), audArchRes.status + " " + audArchRes.text.slice(0, 200));
const audRevSeed = await chatSeed("Audition Revoke Ari");
const audBoard = await makeBoard(run + "-audrev");
await uploadPortrait(audRevSeed);
const audRevImgs = await get("/api/roster/" + audRevSeed + "/images");
await post("/api/images/" + camel(audRevImgs.json?.[0], "id") + "/review", { decision: "accept" });
const audRevCp = await post("/api/roster/" + audRevSeed + "/copy", { boardId: audBoard, boardRole: "Ari" });
ok("audition-revoke-copy-201", audRevCp.status === 201, audRevCp.status + " " + audRevCp.text.slice(0, 160));
const audGrant = await post("/api/boards/" + audBoard + "/grants", { userKey: U2, access: "read" });
const audGrantId = camel(audGrant.json, "id");
const audSlowRev = post("/api/auditions", { rosterId: audRevSeed, question: "QA-SLEEP:6000 audition while revoked?" }, { user: U2, timeout: 60000 });
await waitForLog((e) => e.path === "chat" && (e.full || "").includes("audition while revoked"), 20000, "aud-revoke-dispatch");
await req("DELETE", "/api/grants/" + audGrantId, undefined, {});
const audRevRes = await audSlowRev;
ok("audition-revoke-403", audRevRes.status === 403, audRevRes.status + " " + audRevRes.text.slice(0, 200));
const audRstSeed = await chatSeed("Audition Restore Ara");
const bk2 = await get("/api/backup");
const audSlowRst = post("/api/auditions", { rosterId: audRstSeed, question: "QA-SLEEP:6000 audition across restore?" }, { timeout: 60000 });
await waitForLog((e) => e.path === "chat" && (e.full || "").includes("audition across restore"), 20000, "aud-restore-dispatch");
await post("/api/backup/restore", { snapshot: bk2.json.snapshot, hash: bk2.json.hash });
const audRstRes = await audSlowRst;
ok("audition-restore-409", audRstRes.status === 409 && audRstRes.text.includes("restored") && !hasAnswer(audRstRes.json), audRstRes.status + " " + audRstRes.text.slice(0, 200));
const audSyncErr = await approveAgain(bid, ha.aid, hanaRid);
ok("hana-reapproved3", !audSyncErr, audSyncErr || "");
const aud = await post("/api/auditions", { rosterId: hanaRid, question: "How do you handle a tariff dispute?" });
ok("audition-200", aud.status === 200 && aud.json?.answer, aud.status + " " + aud.text.slice(0, 200));
const logA = await fakeLog();
ok("audition-uses-full", logA.filter((e) => e.path === "chat").some((c) => c.full.includes("AUDITION") && c.full.includes("Contribution criteria:") && c.full.includes("QA-CRITERIA-STALE947")), "audlog checked");
const strInline = JSON.stringify({ fictional: true, name: "Inline Str", contributionCriteria: "MARKER-STR-CRIT contributes here.", reasoningApproach: "MARKER-STR-REAS reasons thus.", responseStyle: "MARKER-STR-STYLE responds so." });
const audStr = await post("/api/auditions", { profileJson: strInline, question: "Inline string-form probe?" });
ok("audition-string-200", audStr.status === 200 && audStr.json?.answer, audStr.status + " " + audStr.text.slice(0, 200));
const objInline = { fictional: true, name: "Inline Obj", contributionCriteria: "MARKER-OBJ-CRIT contributes here.", reasoningApproach: "MARKER-OBJ-REAS reasons thus.", responseStyle: "MARKER-OBJ-STYLE responds so." };
const audObj = await post("/api/auditions", { profileJson: objInline, question: "Inline object-form probe?" });
ok("audition-object-200", audObj.status === 200 && audObj.json?.answer, audObj.status + " " + audObj.text.slice(0, 200));
const logAO = await fakeLog();
ok("audition-string-parsed", logAO.filter((e) => e.path === "chat").some((c) => c.full.includes("AUDITION") && c.full.includes("MARKER-STR-CRIT") && c.full.includes("MARKER-STR-REAS") && c.full.includes("MARKER-STR-STYLE")), "string-form not parsed");
ok("audition-object-parsed", logAO.filter((e) => e.path === "chat").some((c) => c.full.includes("AUDITION") && c.full.includes("MARKER-OBJ-CRIT") && c.full.includes("MARKER-OBJ-REAS") && c.full.includes("MARKER-OBJ-STYLE")), "object-form not parsed");
// ---------- 9: F5 terminal failure stays terminal ----------
console.log("9: F5 terminal states");
const seedF = await post("/api/roster/quick", { accountId: ACCT, name: "Fail Case Freda", description: "A test advisor for failure paths and pending states." });
const fredaRid = camel(seedF.json, "id");
const rfail = await post("/api/roster/" + fredaRid + "/research", { focus: "QA-RESEARCHERR boom" }, { timeout: 170000 });
ok("research-fail-502", rfail.status === 502, rfail.status + " " + rfail.text.slice(0, 200));
const gfail = await get("/api/roster/" + fredaRid + "/research");
ok("research-fail-terminal", gfail.json?.running === false && (gfail.json?.researchedAt ?? null) === null && gfail.json?.draftStatus === "failed" && gfail.json?.stage === "failed", gfail.text.slice(0, 300));
const seedC = await post("/api/roster/quick", { accountId: ACCT, name: "Compile Case Cora", description: "A test advisor for compile failure paths." });
const coraRid = camel(seedC.json, "id");
const cfail = await post("/api/roster/" + coraRid + "/research", { focus: "QA-COMPILEERR boom" }, { timeout: 170000 });
ok("compile-fail-502", cfail.status === 502, cfail.status + " " + cfail.text.slice(0, 200));
const gcfail = await get("/api/roster/" + coraRid + "/research");
ok("compile-fail-terminal", gcfail.json?.running === false && (gcfail.json?.researchedAt ?? null) === null && gcfail.json?.draftStatus === "failed" && gcfail.json?.stage === "failed", gcfail.text.slice(0, 300));
const seedX = await post("/api/roster/quick", { accountId: ACCT, name: "Cancel Case Xio", description: "A test advisor for cancel paths." });
const xioRid = camel(seedX.json, "id");
const ctl = new AbortController(); setTimeout(() => ctl.abort(), 1500);
const cres = await post("/api/roster/" + xioRid + "/research", { focus: "QA-SLEEP:8000 cancel probe" }, { timeout: 60000, signal: ctl.signal }).catch((e) => ({ status: -1, text: String(e).slice(0, 120) }));
ok("cancel-aborted", cres.status === -1 || cres.status === 499, JSON.stringify(cres).slice(0, 160));
let xget = null;
for (let i = 0; i < 25; i++) { await new Promise((r) => setTimeout(r, 1000)); xget = await get("/api/roster/" + xioRid + "/research"); if (!xget.json?.running) break; }
ok("cancel-terminal", xget && xget.json?.running === false && (xget.json?.researchedAt ?? null) === null && xget.json?.draftStatus === "failed" && xget.json?.stage === "failed", JSON.stringify(xget?.json).slice(0, 300));
const intrRes = await post("/api/roster/" + hanaRid + "/research", { focus: "x" }, { user: "intruder" });
ok("research-intruder-denied", intrRes.status === 403, intrRes.status + " " + intrRes.text.slice(0, 160));
const intrProf = JSON.stringify({ fictional: true, contributionCriteria: "x", reasoningApproach: "y", responseStyle: "z" });
const intrPut = await put("/api/roster/" + hanaRid, { profileJson: intrProf }, { user: "intruder" });
ok("put-intruder-403", intrPut.status === 403, intrPut.status + " " + intrPut.text.slice(0, 160));

// ---------- 10: F7 ungrounded stays incomplete, attach allowed, approve blocked ----------
console.log("10: F7 unsupported research");
const seedU = await post("/api/roster/quick", { accountId: ACCT, name: "Ungrounded Uma", description: "No-search grounding probe advisor.", sourceUrls: ["https://no-such-host-xyz.invalid/a", "https://also-missing-xyz.invalid/b"] });
const umaRid = camel(seedU.json, "id");
const ures = await post("/api/roster/" + umaRid + "/research", { focus: "QA-NOSEARCH unsupported probe" }, { timeout: 170000 });
ok("unsupported-200", ures.status === 200 && (ures.json?.draftStatus) === "unsupported", ures.status + " " + ures.text.slice(0, 300));
const uget = await get("/api/roster/" + umaRid + "/research");
ok("unsupported-terminal", uget.json?.running === false && (uget.json?.researchedAt ?? null) === null && uget.json?.stage === "unsupported" && !!uget.json?.draftProfile?.contributionCriteria && uget.json?.evidenceCount === 0, uget.text.slice(0, 400));
const uFetch = uget.json?.sources || uget.json?.evidenceRefs || [];
ok("unsupported-fetch-honest", uFetch.length === 2 && uFetch.every((s) => (s.fetched ?? s.Fetched) === false), JSON.stringify(uFetch).slice(0, 300));
await uploadPortrait(umaRid);
const uImgs = await get("/api/roster/" + umaRid + "/images");
await post("/api/images/" + camel(uImgs.json?.[0], "id") + "/review", { decision: "accept" });
const uBoard = await makeBoard(run + "-unsup");
const uCp = await post("/api/roster/" + umaRid + "/copy", { boardId: uBoard, boardRole: "Uma" });
ok("unsupported-copy-stages", uCp.status === 201, uCp.status + " " + uCp.text.slice(0, 200));
const uAp = await post("/api/boards/" + uBoard + "/advisors/" + camel(uCp.json, "id") + "/approve", {});
ok("unsupported-approve-blocked", uAp.status === 409 && uAp.text.toLowerCase().includes("evidence"), uAp.status + " " + uAp.text.slice(0, 300));
// ---------- 11: F6 persisted inputs incl. background sync + sourceUrls PUT ----------
console.log("11: F6 persisted inputs");
const bigBg = "B".repeat(4000);
const fiveUrls = ["https://no-such-1.invalid/x", "https://no-such-2.invalid/x", "https://no-such-3.invalid/x", "https://no-such-4.invalid/x", "https://no-such-5.invalid/x"];
const seedW = await post("/api/roster/quick", { accountId: ACCT, name: "Inputs Ivan", description: "Input persistence probe advisor, long enough.", background: bigBg, sourceUrls: fiveUrls });
const wRid = camel(seedW.json, "id");
ok("inputs-seed-4000", (camel(seedW.json, "researchInputsJson") || "").length > 4000, "inputs not persisted full");
const wfail = await post("/api/roster/" + wRid + "/research", { focus: "QA-RESEARCHERR inputs probe" }, { timeout: 170000 });
ok("inputs-fail-502", wfail.status === 502, wfail.status + " " + wfail.text.slice(0, 160));
const wget = await get("/api/roster/" + wRid + "/research");
ok("inputs-survive", wget.json?.inputs?.background?.length === 4000 && (wget.json?.inputs?.sourceUrls || []).length === 5 && wget.json?.stage === "failed" && wget.json?.running === false, JSON.stringify({ bg: wget.json?.inputs?.background?.length, urls: (wget.json?.inputs?.sourceUrls || []).length, stage: wget.json?.stage }).slice(0, 200));
const wretry = await post("/api/roster/" + wRid + "/research", { focus: "inputs retry clean probe" }, { timeout: 170000 });
ok("inputs-retry-200", wretry.status === 200 && (wretry.json?.draftStatus) === "done", wretry.status + " " + wretry.text.slice(0, 300));
const wRefs = wretry.json?.evidenceRefs || [];
ok("inputs-reused", fiveUrls.every((u) => wRefs.some((e) => (e.url || "") === u && (e.ownerSupplied ?? false) === true)), JSON.stringify(wRefs.map((e) => e.url)).slice(0, 300));
const wlog = await fakeLog();
ok("inputs-bg-used", wlog.filter((e) => e.path === "responses").some((e) => e.full.includes("B".repeat(60))), "background not found in dossier prompt");
const seedB = await post("/api/roster/quick", { accountId: ACCT, name: "Bg Sync Bea", description: "Background sync probe advisor, long enough.", background: "BG-OLD background seed text here.", sourceUrls: ["https://example.com/"] });
const bRid = camel(seedB.json, "id");
const bgProf = await getProfile(bRid);
bgProf.background = "BG-NEW background after explicit edit.";
const bgSave = await put("/api/roster/" + bRid, { profileJson: JSON.stringify(bgProf) });
ok("bgsync-save-200", bgSave.status === 200, bgSave.status + " " + bgSave.text.slice(0, 160));
const bGet = await get("/api/roster/" + bRid + "/research");
ok("bgsync-inputs", bGet.json?.inputs?.background === "BG-NEW background after explicit edit.", JSON.stringify(bGet.json?.inputs).slice(0, 200));
const bRes = await post("/api/roster/" + bRid + "/research", { focus: "bg sync probe" }, { timeout: 170000 });
ok("bgsync-research-200", bRes.status === 200, bRes.status + " " + bRes.text.slice(0, 200));
const bLog = await fakeLog();
ok("bgsync-uses-new", bLog.filter((e) => e.path === "responses").some((e) => e.full.includes("BG-NEW background after explicit edit")) && !bLog.filter((e) => e.path === "responses").some((e) => e.full.includes("BG-OLD background seed text")), "dossier used stale background");
const bAtGet = await get("/api/roster/" + bRid + "/research");
const bAt = bAtGet.json?.researchedAt;
const bProf2 = await getProfile(bRid);
bProf2.contributionCriteria = "BG-PARA-EDIT-1 keeps identity.";
bProf2.reasoningApproach = "BG-PARA-EDIT-2 keeps identity.";
bProf2.responseStyle = "BG-PARA-EDIT-3 keeps identity.";
const bSave2 = await put("/api/roster/" + bRid, { profileJson: JSON.stringify(bProf2) });
ok("bgpara-save-200", bSave2.status === 200, bSave2.status + " " + bSave2.text.slice(0, 160));
const bGet2 = await get("/api/roster/" + bRid + "/research");
ok("bgpara-proof-intact", bGet2.json?.draftStatus === "saved" && !!bGet2.json?.researchedAt && bGet2.json?.researchedAt === bAt, JSON.stringify(bGet2.json).slice(0, 300));
ok("bgpara-inputs-exact", bGet2.json?.inputs?.background === "BG-NEW background after explicit edit." && JSON.stringify(bGet2.json?.inputs?.sourceUrls || []) === JSON.stringify(["https://example.com/"]), JSON.stringify(bGet2.json?.inputs).slice(0, 200));
// B0 canonical vs B1 researched divergence: paragraph-only full-profile save preserves exact B1 inputs + proof; retry uses B1.
const pvSeed = await post("/api/roster/quick", { accountId: ACCT, name: "Persist Vera", description: "Vera probe advisor.", background: "B0-CANONICAL background seed text." });
const vRid = camel(pvSeed.json, "id");
const vRes = await post("/api/roster/" + vRid + "/research", { background: "B1 documentation-domain background with illustrated examples for Vera.", sourceUrls: ["https://example.com/"], focus: "vera focus probe" }, { timeout: 170000 });
ok("persistvol-research-200", vRes.status === 200 && vRes.json?.draftStatus === "done", vRes.status + " " + (vRes.text || "").slice(0, 300));
const vAtGet = await get("/api/roster/" + vRid + "/research");
const vAt = vAtGet.json?.researchedAt;
ok("persistvol-inputs-b1", vAtGet.json?.inputs?.background === "B1 documentation-domain background with illustrated examples for Vera." && JSON.stringify(vAtGet.json?.inputs?.sourceUrls || []) === JSON.stringify(["https://example.com/"]) && vAtGet.json?.inputs?.focus === "vera focus probe", JSON.stringify(vAtGet.json?.inputs).slice(0, 300));
const vProf = await getProfile(vRid);
vProf.contributionCriteria = "VERA-PARA-1 keeps identity.";
vProf.reasoningApproach = "VERA-PARA-2 keeps identity.";
vProf.responseStyle = "VERA-PARA-3 keeps identity.";
const vSave = await put("/api/roster/" + vRid, { profileJson: JSON.stringify(vProf) });
ok("persistvol-save-200", vSave.status === 200, vSave.status + " " + vSave.text.slice(0, 160));
const vGet2 = await get("/api/roster/" + vRid + "/research");
ok("persistvol-proof-intact", vGet2.json?.draftStatus === "saved" && !!vGet2.json?.researchedAt && vGet2.json?.researchedAt === vAt, JSON.stringify(vGet2.json).slice(0, 300));
ok("persistvol-inputs-exact", vGet2.json?.inputs?.background === "B1 documentation-domain background with illustrated examples for Vera." && JSON.stringify(vGet2.json?.inputs?.sourceUrls || []) === JSON.stringify(["https://example.com/"]) && vGet2.json?.inputs?.focus === "vera focus probe", JSON.stringify(vGet2.json?.inputs).slice(0, 300));
await fakeLogClear();
const vRetry = await post("/api/roster/" + vRid + "/research", {}, { timeout: 170000 });
ok("persistvol-retry-200", vRetry.status === 200 && vRetry.json?.draftStatus === "done", vRetry.status + " " + (vRetry.text || "").slice(0, 300));
const vLog = await fakeLog();
ok("persistvol-retry-b1", vLog.filter((e) => e.path === "responses").some((e) => (e.full || "").includes("B1 documentation-domain background")) && !vLog.filter((e) => e.path === "responses").some((e) => (e.full || "").includes("B0-CANONICAL")), "retry must research persisted B1, not stale canonical B0");
const seedS = await post("/api/roster/quick", { accountId: ACCT, name: "Urls Uma2", description: "Source URL PUT probe advisor, long enough." });
const sRid = camel(seedS.json, "id");
const suPut = await put("/api/roster/" + sRid, { sourceUrls: ["https://put-one.example/x", "https://put-two.example/x"] });
ok("putsurls-200", suPut.status === 200, suPut.status + " " + suPut.text.slice(0, 200));
const suGet = await get("/api/roster/" + sRid + "/research");
ok("putsurls-persisted", JSON.stringify(suGet.json?.inputs?.sourceUrls || []) === JSON.stringify(["https://put-one.example/x", "https://put-two.example/x"]), JSON.stringify(suGet.json?.inputs).slice(0, 200));
const suBad = await put("/api/roster/" + sRid, { sourceUrls: ["ftp://bad.example/x"] });
ok("putsurls-badurl-400", suBad.status === 400, suBad.status + " " + suBad.text.slice(0, 160));
// ---------- 12: deadline + abort per model call (own spawned timeout API) ----------
console.log("12: deadline + abort per model call (own timeout API)");
const tBase = await spawnTimeoutApi();
if (tBase) {
  async function treq(m, p, b, o) { return reqBase(tBase, m, p, b, o); }
  async function deadlineCase(name, focus) {
    const s = await treq("POST", "/api/roster/quick", { accountId: ACCT, name: "Deadline " + name + " " + run, description: "Deadline probe advisor, long enough." }, { timeout: 30000 });
    const rid = camel(s.json, "id");
    const r = await treq("POST", "/api/roster/" + rid + "/research", { focus }, { timeout: 60000 });
    const g = await treq("GET", "/api/roster/" + rid + "/research", undefined, {});
    ok(name + "-504", r.status === 504, r.status + " " + r.text.slice(0, 200));
    ok(name + "-terminal", g.json?.running === false && (g.json?.researchedAt ?? null) === null && g.json?.draftStatus === "failed" && g.json?.stage === "failed", JSON.stringify(g.json).slice(0, 200));
  }
  await deadlineCase("timeout-dossier", "QA-SLEEP-R:8000 deadline dossier probe");
  await deadlineCase("timeout-compile", "QA-SLEEP-C:8000 deadline compile probe");
  async function abortCase(name, focus, atMs) {
    const s = await treq("POST", "/api/roster/quick", { accountId: ACCT, name: "Abort " + name + " " + run, description: "Abort probe advisor, long enough." }, { timeout: 30000 });
    const rid = camel(s.json, "id");
    const ctl2 = new AbortController(); setTimeout(() => ctl2.abort(), atMs);
    const r = await treq("POST", "/api/roster/" + rid + "/research", { focus }, { timeout: 60000, signal: ctl2.signal }).catch((e) => ({ status: -1, text: String(e).slice(0, 120) }));
    let g = null;
    for (let i = 0; i < 20; i++) { await new Promise((rr) => setTimeout(rr, 1000)); g = await treq("GET", "/api/roster/" + rid + "/research", undefined, {}); if (!g.json?.running) break; }
    ok(name + "-499", r.status === -1 || r.status === 499, JSON.stringify(r).slice(0, 160));
    ok(name + "-terminal", g && g.json?.running === false && (g.json?.researchedAt ?? null) === null && g.json?.draftStatus === "failed", JSON.stringify(g?.json).slice(0, 200));
  }
  await abortCase("abort-dossier", "QA-SLEEP-R:8000 abort dossier probe", 1500);
  await abortCase("abort-compile", "QA-SLEEP-C:8000 abort compile probe", 2500);
  await killTimeoutApi();
} else {
  console.log("12: skipped (timeout API child could not start)");
}

// ---------- 13: long chat/audition questions keep full behavior + tail ----------
console.log("13: long chat/audition questions");
const lqSeed = await post("/api/roster/quick", { accountId: ACCT, name: "Long Q Lonnie", description: "Long-question probe advisor, long enough." });
const lqRid = camel(lqSeed.json, "id");
const lqProf = await getProfile(lqRid);
lqProf.contributionCriteria = "LONNIE-CRIT " + "detail ".repeat(250) + " END-LQ-CRIT";
lqProf.reasoningApproach = "LONNIE-REAS " + "reason ".repeat(250) + " END-LQ-REAS";
lqProf.responseStyle = "LONNIE-STYLE " + "style ".repeat(250) + " END-LQ-STYLE";
for (const k of ["contributionCriteria", "reasoningApproach", "responseStyle"]) ok("longq-para-valid-" + k, lqProf[k].length > 1500 && lqProf[k].length <= 2000, k + "=" + lqProf[k].length);
const lqSave = await put("/api/roster/" + lqRid, { profileJson: JSON.stringify(lqProf) });
ok("longq-save-200", lqSave.status === 200, lqSave.status + " " + lqSave.text.slice(0, 200));
const lqOver = Object.assign({}, lqProf, { contributionCriteria: "X".repeat(2001) });
const lqOverSave = await put("/api/roster/" + lqRid, { profileJson: JSON.stringify(lqOver) });
ok("longq-oversize-400", lqOverSave.status === 400 && lqOverSave.text.includes("contributionCriteria"), lqOverSave.status + " " + lqOverSave.text.slice(0, 200));
const longChatQ = "Long chat question: should we proceed? " + "Context line. ".repeat(150) + " DECISIVE CHAT TAIL-5541";
await fakeLogClear();
const longChat = await post("/api/roster/" + lqRid + "/chat", { message: longChatQ }, { timeout: 60000 });
ok("longchat-200", longChat.status === 200 && longChat.json?.answer, longChat.status + " " + longChat.text.slice(0, 200));
const logLQ = await fakeLog();
ok("longchat-whole", logLQ.filter((e) => e.path === "chat").some((c) => !c.bid && !c.draft && c.full.includes("END-LQ-CRIT") && c.full.includes("END-LQ-REAS") && c.full.includes("END-LQ-STYLE") && c.full.includes("TAIL-5541")), "long chat prompt incomplete");
const longAudQ = "Long audition question: assess the risk. " + "Background line. ".repeat(150) + " DECISIVE AUDITION TAIL-6642";
const longAud = await post("/api/auditions", { rosterId: lqRid, question: longAudQ }, { timeout: 60000 });
ok("longaud-200", longAud.status === 200 && longAud.json?.answer, longAud.status + " " + longAud.text.slice(0, 200));
const logLA = await fakeLog();
ok("longaud-whole", logLA.filter((e) => e.path === "chat").some((c) => c.full.includes("AUDITION") && c.full.includes("END-LQ-CRIT") && c.full.includes("END-LQ-REAS") && c.full.includes("END-LQ-STYLE") && c.full.includes("TAIL-6642")), "long audition prompt incomplete");

// ---------- 14: review boundary - exact history lengths under dev-aware budget ----------
console.log("14: exact history + developer budget boundary");
const bndSeed = await post("/api/roster/quick", { accountId: ACCT, name: "N", description: "Boundary probe advisor with a short description." });
const bndRid = camel(bndSeed.json, "id");
const bProf = await getProfile(bRid);
bProf.contributionCriteria = "B-CRIT " + "x".repeat(1982) + " END-B-CRIT";
bProf.reasoningApproach = "B-REAS " + "y".repeat(1982) + " END-B-REAS";
bProf.responseStyle = "B-STYLE " + "z".repeat(1980) + " END-B-STYLE";
for (const k of ["contributionCriteria", "reasoningApproach", "responseStyle"]) ok("bound-para-2000-" + k, bProf[k].length === 2000, k + "=" + bProf[k].length);
const bSave = await put("/api/roster/" + bndRid, { profileJson: JSON.stringify(bProf) });
ok("bound-save-200", bSave.status === 200, bSave.status + " " + bSave.text.slice(0, 200));
const bMsg = "Boundary message: should we proceed? " + "M".repeat(3935) + " DECISIVE BOUNDARY TAIL-9911";
ok("bound-msg-4000", bMsg.length === 4000, "msg=" + bMsg.length);
const bHist = [740, 800, 800, 800, 800, 800, 800].map((n, i) => ({ role: i % 2 ? "lead" : "advisor", content: "H".repeat(n) }));
await fakeLogClear();
const bChat = await post("/api/roster/" + bndRid + "/chat", { message: bMsg, history: bHist }, { timeout: 60000 });
ok("bound-chat-200", bChat.status === 200 && bChat.json?.answer, bChat.status + " " + bChat.text.slice(0, 200));
const bndLog = await fakeLog();
ok("bound-chat-whole", bndLog.filter((e) => e.path === "chat").some((c) => !c.bid && !c.draft && c.full.includes("END-B-CRIT") && c.full.includes("END-B-REAS") && c.full.includes("END-B-STYLE") && c.full.includes("TAIL-9911")), "boundary chat prompt incomplete");
// ---------- 15: inline validation, PUT bounds, max-focus compile ----------
console.log("15: inline validation + PUT bounds + max-focus compile");
const probeQ = "Is this valid " + run + "?";
const malArr = await post("/api/auditions", { profileJson: [], question: probeQ }, { timeout: 60000 });
ok("inline-array-400", malArr.status === 400 && malArr.text.includes("JSON object"), malArr.status + " " + malArr.text.slice(0, 200));
const malStr = await post("/api/auditions", { profileJson: "{not json", question: probeQ }, { timeout: 60000 });
ok("inline-malformed-400", malStr.status === 400 && malStr.text.includes("JSON object"), malStr.status + " " + malStr.text.slice(0, 200));
const malOver = await post("/api/auditions", { profileJson: JSON.stringify({ fictional: true, contributionCriteria: "X".repeat(2001), reasoningApproach: "ok reason", responseStyle: "ok style" }), question: probeQ }, { timeout: 60000 });
ok("inline-oversize-400", malOver.status === 400 && malOver.text.includes("contributionCriteria"), malOver.status + " " + malOver.text.slice(0, 200));
const logAfter15 = await fakeLog();
ok("inline-no-dispatch", !JSON.stringify(logAfter15).includes(probeQ), "rejected input reached the model");
const overName = await put("/api/roster/" + hanaRid, { name: "N".repeat(17000) });
ok("put-oversize-name-400", overName.status === 400 && overName.text.includes("120"), overName.status + " " + overName.text.slice(0, 200));
const overDesc = await put("/api/roster/" + hanaRid, { description: "D".repeat(4001) });
ok("put-oversize-desc-400", overDesc.status === 400 && overDesc.text.includes("4000"), overDesc.status + " " + overDesc.text.slice(0, 200));
const overBgProf = await getProfile(hanaRid);
overBgProf.background = "B".repeat(4001);
const overBg = await put("/api/roster/" + hanaRid, { profileJson: JSON.stringify(overBgProf) });
ok("put-oversize-bg-400", overBg.status === 400 && overBg.text.includes("background"), overBg.status + " " + overBg.text.slice(0, 200));
const fSeed = await post("/api/roster/quick", { accountId: ACCT, name: "Focus Max Fiona", description: "Max focus compile probe advisor, long enough here.", background: "Fiona background text here.", sourceUrls: ["https://example.com/"] });
const fRid = camel(fSeed.json, "id");
const fRes = await post("/api/roster/" + fRid + "/research", { focus: "F".repeat(2000) }, { timeout: 170000 });
ok("maxfocus-200", fRes.status === 200 && fRes.json?.draftStatus === "done", fRes.status + " " + (fRes.text || "").slice(0, 300));
ok("maxfocus-3paras", !!(fRes.json?.draftProfile?.contributionCriteria && fRes.json?.draftProfile?.reasoningApproach && fRes.json?.draftProfile?.responseStyle), JSON.stringify(fRes.json?.draftProfile).slice(0, 200));
// ---------- 16: seed tail beyond char 200 + final-guard races ----------
console.log("16: seed tail + final-guard races");
const tailDesc = "Seed tail probe base. " + "Harbor detail filler text. ".repeat(10) + "ABSTAIN-CONDITION-TAIL-6621: never approve night transits without two tugs.";
ok("tail-desc-gt200", tailDesc.indexOf("ABSTAIN-CONDITION-TAIL-6621") > 200, "cond at " + tailDesc.indexOf("ABSTAIN-CONDITION-TAIL-6621"));
const tSeed = await post("/api/roster/quick", { accountId: ACCT, name: "Seed Tail Sadie", description: tailDesc });
const tRid = camel(tSeed.json, "id");
await fakeLogClear();
const tChat = await post("/api/roster/" + tRid + "/chat", { message: "Should we run tonight?" }, { timeout: 60000 });
ok("tail-chat-200", tChat.status === 200 && tChat.json?.answer, tChat.status + " " + tChat.text.slice(0, 200));
const tLog = await fakeLog();
ok("tail-chat-whole", tLog.some((e) => e.path === "chat" && !e.bid && !e.draft && e.full.includes("ABSTAIN-CONDITION-TAIL-6621")), "seed tail missing from chat prompt");
const tAud = await post("/api/auditions", { rosterId: tRid, question: "Assess a night transit." }, { timeout: 60000 });
ok("tail-aud-200", tAud.status === 200 && tAud.json?.answer, tAud.status + " " + tAud.text.slice(0, 200));
const tLog2 = await fakeLog();
ok("tail-aud-whole", tLog2.some((e) => e.path === "chat" && (e.full || "").includes("AUDITION") && (e.full || "").includes("ABSTAIN-CONDITION-TAIL-6621")), "seed tail missing from audition prompt");
await uploadPortrait(tRid);
const tImgs = await get("/api/roster/" + tRid + "/images");
await post("/api/images/" + camel(tImgs.json?.[0], "id") + "/review", { decision: "accept" });
const tBoard = await makeBoard(run + "-tail");
const tCp = await post("/api/roster/" + tRid + "/copy", { boardId: tBoard, boardRole: "Tail" });
ok("tail-copy-201", tCp.status === 201, tCp.status + " " + tCp.text.slice(0, 200));
const tAp = await post("/api/boards/" + tBoard + "/advisors/" + camel(tCp.json, "id") + "/approve", {});
ok("tail-approve-200", tAp.status === 200, tAp.status + " " + tAp.text.slice(0, 200));
const tMt = await post("/api/boards/" + tBoard + "/meetings", { title: run + " tail mtg", brief: "Tail probe." });
const tMid = camel(tMt.json, "id");
await post("/api/meetings/" + tMid + "/messages", { sender: "lead", content: "Should we approve the night transit schedule?" });
await fakeLogClear();
const tRun = await post("/api/meetings/" + tMid + "/run", { prompt: "night transit decision" }, { timeout: 120000 });
ok("tail-run-200", tRun.status === 200, tRun.status + " " + tRun.text.slice(0, 200));
const tLog3 = await fakeLog();
ok("tail-bid-whole", tLog3.filter((e) => e.bid).some((b) => (b.full || "").includes("ABSTAIN-CONDITION-TAIL-6621")), "seed tail missing from bid");
ok("tail-reply-whole", tLog3.filter((e) => e.draft).some((d) => (d.full || "").includes("ABSTAIN-CONDITION-TAIL-6621")), "seed tail missing from reply");
for (let ri = 0; ri < 3; ri++) {
  const rSeed = await chatSeed("Race Reed " + ri);
  const rSlow = post("/api/roster/" + rSeed + "/chat", { message: "QA-SLEEP:6000 race probe " + ri }, { timeout: 60000 });
  await waitForLog((e) => e.path === "chat" && (e.full || "").includes("race probe " + ri), 20000, "race-dispatch-" + ri);
  const rProf = await getProfile(rSeed);
  rProf.contributionCriteria = "Race edit " + ri + ".";
  await put("/api/roster/" + rSeed, { profileJson: JSON.stringify(rProf) });
  const rRes = await rSlow;
  ok("race-edit-409-" + ri, rRes.status === 409 && !hasAnswer(rRes.json), rRes.status + " " + rRes.text.slice(0, 200));
}

console.log("character-advisor-qa: pass=" + pass + " fail=" + fail);
if (fail && failures.length) { console.log("FAILURES:"); for (const f of failures) console.log(" - " + f); }
await killTimeoutApi();
process.exit(fail ? 1 : 0);
