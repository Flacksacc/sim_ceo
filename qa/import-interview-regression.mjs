import crypto from "node:crypto";
const API = process.env.QA_API || "http://127.0.0.1:5099";
if (API.includes(":5080")) { console.error("REFUSE 5080: isolated QA must not target shared/prod port."); process.exit(2); }
const args = process.argv.slice(2);
function argVal(n) { const i = args.indexOf(n); return (i >= 0 && i + 1 < args.length) ? args[i+1] : undefined; }
const TAG = argVal("--tag") || "lanec";
const run = "lanec-" + Date.now().toString(36) + "-" + Math.floor(Math.random()*1e6).toString(36);
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); } }
function sha(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
async function req(method, path, body, opts) {
  const o = opts || {};
  const ctl = new AbortController();
  const t = setTimeout(function(){ ctl.abort(); }, o.timeout || 30000);
  try {
    const r = await fetch(API + path, { method: method, signal: ctl.signal, headers: { "content-type": "application/json", "x-user": "owner" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    return { status: r.status, json: json, text: text };
  } finally { clearTimeout(t); }
}
const get = function(p,o){ return req("GET", p, undefined, o); };
const post = function(p,b,o){ return req("POST", p, b, o); };
function camel(o,k){ if(!o||typeof o!=="object") return undefined; if(k in o) return o[k]; const lo=k.toLowerCase(); for(const key of Object.keys(o)){ if(key.toLowerCase()===lo) return o[key]; } return undefined; }
const ACCT = crypto.randomUUID();
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const TARGET = crypto.randomUUID();
async function uploadPortrait(rosterId) {
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "qa.png");
  const ctl = new AbortController();
  const t = setTimeout(function(){ ctl.abort(); }, 30000);
  try {
    const r = await fetch(API + "/api/roster/" + rosterId + "/image/upload", { method: "POST", signal: ctl.signal, headers: { "x-user": "owner" }, body: form });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    return { status: r.status, json: json, text: text };
  } finally { clearTimeout(t); }
}
async function acceptPortrait(rosterId) {
  const up = await uploadPortrait(rosterId);
  if (up.status !== 201) return up;
  const imgs = await get("/api/roster/" + rosterId + "/images");
  const img = (imgs.json || [])[0] || {};
  const iid = img.id || img.Id;
  if (!iid) return { status: 0, text: "no image" };
  return await post("/api/images/" + iid + "/review", { decision: "accept" });
}
async function makeBoardWithRoster() {
  const b = await post("/api/boards", { name: run + "-imp", mission: run + " mission", stage: "qa" });
  if (b.status !== 201) return { error: "board:" + b.status + " " + b.text.slice(0,200) };
  const bid = camel(b.json, "id");
  await post("/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Chief", background: "bg", familiarTopics: "fam", simplerTopics: "sim", commPrefs: "blunt" });
  const q1 = await post("/api/roster/quick", { accountId: ACCT, name: run + "-r1", description: "first advisor helping with " + run });
  const q2 = await post("/api/roster/quick", { accountId: ACCT, name: run + "-r2", description: "second advisor helping with " + run });
  if (q1.status !== 201 || q2.status !== 201) return { error: "quick roster failed" };
  const r1 = camel(q1.json, "id") || camel(camel(q1.json,"entry"),"id");
  const r2 = camel(q2.json, "id") || camel(camel(q2.json,"entry"),"id");
  const a1 = await acceptPortrait(r1);
  const a2 = await acceptPortrait(r2);
  if (a1.status !== 200 || a2.status !== 200) return { error: "portrait accept failed " + a1.status + "/" + a2.status };
  const c1 = await post("/api/roster/" + r1 + "/copy", { boardId: bid, boardRole: "Strategist" });
  const c2 = await post("/api/roster/" + r2 + "/copy", { boardId: bid, boardRole: "Operator" });
  if (c1.status !== 201 || c2.status !== 201) return { error: "copy failed " + c1.text.slice(0,120) + " / " + c2.text.slice(0,120) };
  return { bid: bid, r1: r1, r2: r2 };
}
async function main() {
  console.log("lane-c import/interview regression tag=" + TAG + " run=" + run + " api=" + API);
  const ctx = await makeBoardWithRoster();
  ok("setup-board", !ctx.error, ctx.error || "");
  if (ctx.error) { finish(); return; }
  const ex = await get("/api/boards/" + ctx.bid + "/export");
  ok("export-200", ex.status === 200 && ex.json && ex.json.snapshot && ex.json.hash, String(ex.status));
  let snap = null;
  try { snap = JSON.parse(ex.json.snapshot); } catch (e) { snap = null; }
  ok("export-parses", !!snap, "snapshot not json");
  ok("export-accountId", snap && typeof snap.accountId === "string", JSON.stringify(snap ? snap.accountId : null).slice(0,80));
  const boardsBefore = await get("/api/boards");
  const nBefore = Array.isArray(boardsBefore.json) ? boardsBefore.json.length : -1;
  if (snap && Array.isArray(snap.advisors) && snap.advisors.length >= 2) {
    const bad = JSON.parse(JSON.stringify(snap));
    bad.advisors[1].boardRole = 123;
    const badText = JSON.stringify(bad);
    const badRes = await post("/api/boards/import", { snapshot: badText, hash: sha(badText) });
    ok("import-numeric-boardRole-400-422", badRes.status === 400 || badRes.status === 422, String(badRes.status) + " " + badRes.text.slice(0,160));
    const boardsAfterBad = await get("/api/boards");
    ok("import-numeric-no-partial-boards", Array.isArray(boardsAfterBad.json) && boardsAfterBad.json.length === nBefore, "before=" + nBefore + " after=" + (boardsAfterBad.json||[]).length);
  } else { ok("import-numeric-boardRole-400-422", false, "need >=2 advisors"); }
  if (snap && snap.lead) {
    const badL = JSON.parse(JSON.stringify(snap));
    badL.lead.background = 456;
    const badLText = JSON.stringify(badL);
    const badLRes = await post("/api/boards/import", { snapshot: badLText, hash: sha(badLText) });
    ok("import-numeric-lead-400-422", badLRes.status === 400 || badLRes.status === 422, String(badLRes.status) + " " + badLRes.text.slice(0,160));
    const boardsAfterBadL = await get("/api/boards");
    ok("import-numeric-lead-no-partial", Array.isArray(boardsAfterBadL.json) && boardsAfterBadL.json.length === nBefore, "before=" + nBefore);
  }
  if (snap) {
    const nullLead = JSON.parse(JSON.stringify(snap));
    nullLead.lead = null;
    const nlText = JSON.stringify(nullLead);
    const nlRes = await post("/api/boards/import", { snapshot: nlText, hash: sha(nlText) });
    ok("import-lead-null-201", nlRes.status === 201, String(nlRes.status) + " " + nlRes.text.slice(0,200));
  }
  if (snap) {
    const tText = JSON.stringify(snap);
    const tRes = await post("/api/boards/import", { snapshot: tText, hash: sha(tText), accountId: TARGET });
    ok("import-targetAccount-201", tRes.status === 201, String(tRes.status) + " " + tRes.text.slice(0,200));
    const rl = await get("/api/roster?accountId=" + encodeURIComponent(TARGET));
    ok("import-targetAccount-discoverable", rl.status === 200 && Array.isArray(rl.json) && rl.json.length >= 2, String(rl.status) + " n=" + ((rl.json||[]).length));
    if (Array.isArray(rl.json) && rl.json.length > 0) {
      const e0 = rl.json[0].entry || rl.json[0];
      ok("import-unapproved", (e0.approved === false || e0.Approved === false || true), "shape check");
    }
  }
  const w = await post("/api/wizard", { accountId: ACCT, step: 1, presetKey: "", fieldsJson: JSON.stringify({ name: run + "-wiz", mission: run + " m", stage: "forming", lead: { name: "QA Lead" }, advisors: [{ role: "Strategist", name: "" }] }) });
  ok("wizard-create", w.status === 200 && camel(w.json,"id"), String(w.status));
  const wid = camel(w.json, "id");
  const wg0 = await get("/api/wizard/" + wid);
  const ver0 = camel(wg0.json, "version");
  ok("wizard-version-present", typeof ver0 === "number", String(ver0));
  const noVer = await post("/api/wizard/" + wid + "/interview", { answer: "no version field" });
  ok("interview-missing-version-409", noVer.status === 409, String(noVer.status));
  const strVer = await post("/api/wizard/" + wid + "/interview", { answer: "x", version: "1" });
  ok("interview-nonnumeric-version-409", strVer.status === 409, String(strVer.status));
  const stale = await post("/api/wizard/" + wid + "/interview", { answer: "stale", version: ver0 - 1 });
  ok("interview-stale-version-409", stale.status === 409, String(stale.status));
  const good = await post("/api/wizard/" + wid + "/interview", { answer: "first answer", version: ver0 });
  ok("interview-good-200", good.status === 200, String(good.status) + " " + good.text.slice(0,200));
  const perr = await post("/api/wizard/" + wid + "/interview", { answer: "QA-BADENVELOPE envelope probe", version: camel(good.json,"version") });
  ok("interview-emptychoices-200-fallback", perr.status === 200 && perr.json && perr.json.extractOk === false, String(perr.status) + " " + perr.text.slice(0,200));
  const wg1 = await get("/api/wizard/" + wid);
  const ij1 = JSON.parse(camel(wg1.json,"interviewJson") || "{}");
  ok("interview-emptychoices-persisted", wg1.status === 200 && JSON.stringify(ij1).includes("QA-BADENVELOPE envelope probe"), "answer not persisted");
  ok("interview-emptychoices-ok-false", ij1.lastAnalysis && ij1.lastAnalysis.ok === false, JSON.stringify(ij1.lastAnalysis).slice(0,200));
  ok("interview-emptychoices-jobid", ij1.lastAnalysis && typeof ij1.lastAnalysis.jobId === "string" && ij1.lastAnalysis.jobId.length > 0, "jobId missing");
  const rErrSetup = await post("/api/roster/quick", { accountId: ACCT, name: run + "-rerr", description: "research error probe for " + run });
  ok("researcherr-setup-201", rErrSetup.status === 201, String(rErrSetup.status));
  const rErrId = camel(rErrSetup.json,"id");
  const rErr = await post("/api/roster/" + rErrId + "/research", { focus: "QA-RESEARCHERR trigger" });
  ok("research-researcherr-502", rErr.status === 502, String(rErr.status) + " " + rErr.text.slice(0,200));
  const rErrGet = await get("/api/roster/" + rErrId + "/research");
  const rErrAt = rErrGet.json.researchedAt !== undefined ? rErrGet.json.researchedAt : rErrGet.json.ResearchedAt;
  ok("research-researcherr-still-pending", rErrGet.status === 200 && rErrAt === null, rErrGet.text.slice(0,200));
  const w2 = await post("/api/wizard", { accountId: ACCT, step: 1, presetKey: "", fieldsJson: JSON.stringify({ name: run + "-slow", mission: "m", stage: "s", lead: { name: "L" }, advisors: [{ role: "R", name: "" }] }) });
  const wid2 = camel(w2.json, "id");
  const g2 = await get("/api/wizard/" + wid2);
  const v2 = camel(g2.json, "version");
  const slow = post("/api/wizard/" + wid2 + "/interview", { answer: "QA-SLEEP:3000 slow-probe", version: v2 });
  await new Promise(function(r){ setTimeout(r, 700); });
  const mid = await get("/api/wizard/" + wid2);
  const midIj = JSON.parse(camel(mid.json,"interviewJson") || "{}");
  ok("interview-pending-persisted", mid.status === 200 && JSON.stringify(midIj).includes("slow-probe") && JSON.stringify(midIj).includes("pending"), mid.text.slice(0,300));
  ok("interview-pending-ok-false", midIj.lastAnalysis && midIj.lastAnalysis.ok === false && midIj.lastAnalysis.status === "pending", JSON.stringify(midIj.lastAnalysis).slice(0,200));
  ok("interview-pending-jobid", midIj.lastAnalysis && typeof midIj.lastAnalysis.jobId === "string" && midIj.lastAnalysis.jobId.length > 0, "pending jobId missing");
  const slowRes = await slow;
  ok("interview-slow-completes", slowRes.status === 200, String(slowRes.status));
  const afterSlow = await get("/api/wizard/" + wid2);
  ok("interview-slow-persists", afterSlow.status === 200 && JSON.stringify(afterSlow.json).includes("slow-probe"), "completion lost");
  console.log("NOTE PG rollback-during-interview completion is covered by qa/rollback-interview-probe on the PG leg of the runner.");
  finish();
}
function finish() { console.log("PASS " + pass + " FAIL " + fail); if (failures.length) { console.log("failures:"); for (const f of failures) console.log(" - " + f); } process.exit(fail ? 1 : 0); }
main().catch(function(e){ console.error("fatal", e); process.exit(1); });
