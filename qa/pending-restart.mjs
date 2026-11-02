// qa/pending-restart.mjs — PROCESS-RESTART while research+interview pending (TEST-ONLY, QA-owned).
// Author-only artifact for review#17 (not covered by completed-answer checks). Main QA worker owns
// runtime; this file performs NO API execution/restarts and manages NO services/containers.
// Usage (hooked by a separate integration task, NOT by this authoring worker):
//   QA_API=http://127.0.0.1:5100 node qa/pending-restart.mjs --write   (before parent restart)
//   QA_API=http://127.0.0.1:5100 node qa/pending-restart.mjs --verify  (after parent restart)
// Requires: QA_API default 5100, REFUSE 5080, /api/backend mode postgres, fake provider :5199
// (already protocol-supports QA-SLEEP token). Research needs NO portrait; upload none.
// --write: unique account/roster/wizard with valid typed fields, version queried actual (never
// hardcoded 1, store actual). Sends research focus QA-SLEEP:14000 and interview answer
// QA-SLEEP:14000+nonce WITHOUT awaiting completion, polls GET bounded until BOTH durable pending
// exact, persists actual IDs/jobIDs/versions/pendingQuestion/answer+original turncount to
// .tmp/pending-restart-state.json, exits 0 deliberately while calls still pending. Node socket
// closure alone must NOT be assumed server cancellation; parent immediately kills owned API 5100
// and restarts. Old completed response after process kill cannot persist (parent proves PID
// replaced). NO source hooks/SQL. If pending cannot be observed, fail nonzero with no PASS.
// --verify (after parent restart): requires PG, verifies EXACT pending metadata/answer/question/
// version persisted BEFORE RETRY, retries research with normal focus (must not 409 permanent
// busy; truthful new job complete/evidence) and retries interview with answer EMPTY at persisted
// version to reanalyze existing last turn WITHOUT duplicating answer (actual WizardGuide
// supports: whitespace answer adds no turn, updates last turn analysis), completes extractOk true,
// pending resolved, same answer/turncount, question/version persist via GET. Bounded 60s, no fake
// pass/skip. Saved metadata has no API secret. Exit nonzero if expected statuses fail.
// Actual contracts read from server/SimCEO.Api/Work/RosterEndpoints.cs,
// server/SimCEO.Api/Work/Endpoints.cs (/api/wizard POST/GET), WizardGuide.cs (interview pending
// lastAnalysis {ok:false,status:pending,jobId,at,turn} vs completed {ok,at,error,jobId} with NO
// status field; POST response carries analysis STRING plus turns and NO lastAnalysis), Entities.cs
// (RosterEntry {ResearchRequested,ResearchJobId,ResearchedAt,EvidenceCount,Version}).
// Portable Node stdlib only (node:crypto, node:fs, global fetch).
import crypto from "node:crypto";
import fs from "node:fs";
const API = process.env.QA_API || "http://127.0.0.1:5100";
if (API.includes(":5080")) { console.error("REFUSE 5080: isolated QA_API required (default 5100)."); process.exit(2); }
const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const VERIFY = args.includes("--verify");
const STATE_FILE = ".tmp/pending-restart-state.json";
const SLEEP_MS = 14000;
let fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { console.log("  ok " + name); }
  else { fail++; const m = name + (extra ? " :: " + extra : ""); failures.push(m); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
function camel(o, k) {
  if (!o || typeof o !== "object") return undefined;
  if (k in o) return o[k];
  const lo = k.toLowerCase();
  for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key];
  return undefined;
}
async function req(method, path, body, ms) {
  const timeout = ms || 30000;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(API + path, {
      method, signal: ctl.signal,
      headers: { "content-type": "application/json", "x-user": "owner" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const get = (p, ms) => req("GET", p, undefined, ms);
const post = (p, b, ms) => req("POST", p, b, ms);
function parseInterviewJsonString(s) { try { return JSON.parse(s || "{}"); } catch { return null; } }
function getInterviewJson(draftJson) {
  const raw = camel(draftJson, "interviewJson");
  if (typeof raw !== "string") return null;
  return parseInterviewJsonString(raw);
}
function pendingInterviewSnapshot(ij) {
  if (!ij || typeof ij !== "object") return null;
  const la = ij.lastAnalysis;
  if (!la || typeof la !== "object") return null;
  if (la.status !== "pending" || la.ok !== false) return null;
  if (typeof la.jobId !== "string" || !la.jobId) return null;
  if (typeof ij.pendingQuestion !== "string" || !ij.pendingQuestion) return null;
  if (!Array.isArray(ij.turns)) return null;
  return { jobId: la.jobId, turns: ij.turns, pendingQuestion: ij.pendingQuestion, at: la.at, turn: la.turn };
}
function findTurnWith(turns, token) {
  if (!Array.isArray(turns)) return null;
  return turns.find((t) => t && typeof t.answer === "string" && t.answer.includes(token)) || null;
}
async function requirePostgresBackend() {
  const be = await get("/api/backend", 15000);
  const mode = be.json ? (be.json.mode || be.json.Mode) : undefined;
  ok("backend-postgres", be.status === 200 && mode === "postgres", "status=" + be.status + " mode=" + mode + " " + be.text.slice(0, 160));
  return fail === 0;
}
async function runWrite() {
  console.log("pending-restart --write vs " + API);
  if (!(await requirePostgresBackend())) { console.log("WRITE FAIL (" + failures.length + ")"); process.exit(1); }
  const run = "pr-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
  const nonce = crypto.randomBytes(4).toString("hex");
  const rosterAcct = crypto.randomUUID();
  const wizAcct = crypto.randomUUID();
  const rosterName = run + "-adv";
  const rosterDesc = "pending-restart roster probe for " + run + " with sufficient detail";
  const answerToken = "pending-restart-" + run + "-" + nonce;
  const researchFocus = "QA-SLEEP:" + SLEEP_MS + " pending-restart-research-" + run + "-" + nonce;
  const interviewAnswer = "QA-SLEEP:" + SLEEP_MS + " " + answerToken;
  // Unique roster with valid typed fields (quick: accountId guid-string, name non-empty, description >=5).
  const q = await post("/api/roster/quick", { accountId: rosterAcct, name: rosterName, description: rosterDesc }, 15000);
  ok("write-roster-quick-201", q.status === 201 && !!camel(q.json, "id"), "status=" + q.status + " " + q.text.slice(0, 200));
  if (fail) { console.log("WRITE FAIL"); process.exit(1); }
  const rid = camel(q.json, "id");
  // Unique wizard with valid typed fields (accountId guid-string, step number, presetKey string, fieldsJson string).
  const fields = { name: run + "-wizboard", mission: run + " mission", stage: "forming", lead: { name: "QA Lead" }, advisors: [{ role: "Strategist", name: "" }] };
  const w = await post("/api/wizard", { accountId: wizAcct, step: 1, presetKey: "", fieldsJson: JSON.stringify(fields) }, 15000);
  ok("write-wizard-create-200", (w.status === 200 || w.status === 201) && !!camel(w.json, "id"), "status=" + w.status + " " + w.text.slice(0, 200));
  if (fail) { console.log("WRITE FAIL"); process.exit(1); }
  const wid = camel(w.json, "id");
  // Query ACTUAL wizard version via GET (never hardcode 1).
  const g0 = await get("/api/wizard/" + wid, 15000);
  ok("write-wizard-get-200", g0.status === 200, "status=" + g0.status);
  if (fail) { console.log("WRITE FAIL"); process.exit(1); }
  const actualVersion = camel(g0.json, "version");
  ok("write-wizard-version-actual", typeof actualVersion === "number" && actualVersion > 0, "version=" + JSON.stringify(actualVersion));
  if (fail) { console.log("WRITE FAIL"); process.exit(1); }
  // Fire BOTH slow calls WITHOUT awaiting completion. Long timeouts keep sockets open until we exit.
  const researchP = post("/api/roster/" + rid + "/research", { focus: researchFocus }, 60000);
  researchP.catch(() => {});
  const interviewP = post("/api/wizard/" + wid + "/interview", { answer: interviewAnswer, version: actualVersion }, 60000);
  interviewP.catch(() => {});
  // Poll GET bounded until BOTH durable pending exact.
  const deadline = Date.now() + 15000;
  let rosterPending = null;
  let wizPending = null;
  let wizGet = null;
  while (Date.now() < deadline) {
    // Roster pending via list GET (entry carries ResearchRequested/ResearchJobId/ResearchedAt/EvidenceCount).
    try {
      const rl = await get("/api/roster?accountId=" + encodeURIComponent(rosterAcct), 10000);
      if (rl.status === 200 && Array.isArray(rl.json)) {
        const row = rl.json.find((e) => { const en = e.entry || e.Entry || e; const id = en.id || en.Id; return String(id) === String(rid); });
        const entry = row ? (row.entry || row.Entry || row) : null;
        if (entry) {
          const req2 = camel(entry, "researchRequested");
          const jid = camel(entry, "researchJobId");
          const at = camel(entry, "researchedAt");
          const ev = camel(entry, "evidenceCount");
          const ver = camel(entry, "version");
          if (req2 === true && typeof jid === "string" && jid && at === null && ev === 0) {
            rosterPending = { jobId: jid, version: ver, requested: req2, researchedAt: at, evidenceCount: ev };
          }
        }
      }
    } catch {}
    // Interview pending via wizard GET interviewJson.
    try {
      const wg = await get("/api/wizard/" + wid, 10000);
      if (wg.status === 200) {
        const ij = getInterviewJson(wg.json);
        const snap = pendingInterviewSnapshot(ij);
        if (snap) {
          const turn = findTurnWith(snap.turns, answerToken);
          if (turn) { wizPending = snap; wizGet = wg; }
        }
      }
    } catch {}
    if (rosterPending && wizPending) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  ok("write-roster-pending-exact", !!rosterPending, "need ResearchRequested true + ResearchJobId nonempty + ResearchedAt null + EvidenceCount 0");
  ok("write-interview-pending-exact", !!wizPending, "need lastAnalysis.status pending + ok false + job nonempty + answer turn exact");
  if (!rosterPending || !wizPending) { console.log("WRITE FAIL (" + failures.length + "): " + failures.join(" | ")); process.exit(1); }
  // Re-read wizard GET for exact persisted version/question/turncount to persist.
  const wgFinal = await get("/api/wizard/" + wid, 10000);
  const ijFinal = getInterviewJson(wgFinal.json);
  const snapFinal = pendingInterviewSnapshot(ijFinal);
  const finalVersion = camel(wgFinal.json, "version");
  const finalQuestion = ijFinal ? ijFinal.pendingQuestion : undefined;
  const finalTurnCount = Array.isArray(ijFinal.turns) ? ijFinal.turns.length : -1;
  ok("write-wizard-version-persisted", finalVersion === camel((wizGet || wgFinal).json, "version"), "get=" + finalVersion);
  ok("write-question-nonempty", typeof finalQuestion === "string" && finalQuestion.length > 0, String(finalQuestion).slice(0, 120));
  ok("write-turncount", finalTurnCount > 0 && findTurnWith(ijFinal.turns, answerToken), "turns=" + finalTurnCount);
  if (fail) { console.log("WRITE FAIL"); process.exit(1); }
  const state = {
    kind: "pending-restart",
    api: API,
    run, nonce,
    rosterAcct, wizAcct,
    rosterId: rid,
    rosterVersion: rosterPending.version,
    researchJobId: rosterPending.jobId,
    researchFocus,
    wizardId: wid,
    wizardPendingVersion: finalVersion,
    interviewJobId: snapFinal.jobId,
    pendingQuestion: finalQuestion,
    answer: interviewAnswer,
    answerToken,
    originalTurnCount: finalTurnCount,
    createdAt: new Date().toISOString(),
  };
  // Saved metadata must carry no API secret.
  const stateText = JSON.stringify(state, null, 2);
  if (/META_API|API_KEY|Authorization|Bearer\s+[A-Za-z0-9_\-]{8,}/i.test(stateText)) {
    ok("write-no-secret", false, "state must not contain API secret");
    console.log("WRITE FAIL"); process.exit(1);
  }
  try { fs.mkdirSync(".tmp", { recursive: true }); fs.writeFileSync(STATE_FILE, stateText); }
  catch (e) { ok("write-state-file", false, String((e && e.message) || e)); console.log("WRITE FAIL"); process.exit(1); }
  ok("write-state-persisted", true, "");
  console.log("WRITE PASS run=" + run + " roster=" + rid + " wizard=" + wid + " rjob=" + rosterPending.jobId + " ijob=" + snapFinal.jobId + " v=" + finalVersion);
  // Exit 0 deliberately while research+interview calls still pending. Node socket closure alone
  // must NOT be assumed server cancellation; parent immediately kills owned API 5100 and restarts.
  // Old completed response after process kill cannot persist (parent proves PID replaced).
  process.exit(0);
}
async function runVerify() {
  console.log("pending-restart --verify vs " + API);
  const t0 = Date.now();
  const BOUND_MS = 60000;
  if (!(await requirePostgresBackend())) { console.log("VERIFY FAIL"); process.exit(1); }
  if (!fs.existsSync(STATE_FILE)) { ok("verify-state-exists", false, "missing " + STATE_FILE + "; run --write before restart first"); console.log("VERIFY FAIL"); process.exit(1); }
  let st = null;
  try { st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { ok("verify-state-parse", false, String((e && e.message) || e)); console.log("VERIFY FAIL"); process.exit(1); }
  const need = ["rosterId", "wizardId", "researchJobId", "wizardPendingVersion", "interviewJobId", "pendingQuestion", "answer", "answerToken", "originalTurnCount", "rosterAcct", "rosterVersion"];
  for (const k of need) ok("verify-state-has-" + k, st[k] !== undefined && st[k] !== null && st[k] !== "", "missing " + k);
  if (fail) { console.log("VERIFY FAIL"); process.exit(1); }
  ok("verify-no-secret", !/META_API|API_KEY/i.test(JSON.stringify(st)), "state must have no API secret");
  if (fail) { console.log("VERIFY FAIL"); process.exit(1); }
  // Verify EXACT pending metadata BEFORE RETRY (roster).
  const rl = await get("/api/roster?accountId=" + encodeURIComponent(st.rosterAcct), 15000);
  ok("verify-roster-list-200", rl.status === 200 && Array.isArray(rl.json), "status=" + rl.status);
  let entry = null;
  if (rl.status === 200 && Array.isArray(rl.json)) {
    const row = rl.json.find((e) => { const en = e.entry || e.Entry || e; return String(en.id || en.Id) === String(st.rosterId); });
    entry = row ? (row.entry || row.Entry || row) : null;
  }
  ok("verify-roster-found", !!entry, "roster " + st.rosterId + " missing after restart");
  if (entry) {
    ok("verify-roster-requested", camel(entry, "researchRequested") === true, "got " + JSON.stringify(camel(entry, "researchRequested")));
    ok("verify-roster-jobid", camel(entry, "researchJobId") === st.researchJobId, "got " + JSON.stringify(camel(entry, "researchJobId")) + " want " + st.researchJobId);
    ok("verify-roster-researchedAt-null", camel(entry, "researchedAt") === null, "got " + JSON.stringify(camel(entry, "researchedAt")));
    ok("verify-roster-evidence-0", camel(entry, "evidenceCount") === 0, "got " + JSON.stringify(camel(entry, "evidenceCount")));
    ok("verify-roster-version", camel(entry, "version") === st.rosterVersion, "got " + JSON.stringify(camel(entry, "version")) + " want " + st.rosterVersion);
  }
  // Verify EXACT pending metadata BEFORE RETRY (wizard).
  const wg = await get("/api/wizard/" + st.wizardId, 15000);
  ok("verify-wizard-get-200", wg.status === 200, "status=" + wg.status);
  const ij = getInterviewJson(wg.json);
  const gv = camel(wg.json, "version");
  ok("verify-wizard-version", gv === st.wizardPendingVersion, "got " + gv + " want " + st.wizardPendingVersion);
  ok("verify-wizard-question", !!ij && ij.pendingQuestion === st.pendingQuestion, "got " + String(ij && ij.pendingQuestion).slice(0, 120));
  const vturn = ij ? findTurnWith(ij.turns, st.answerToken) : null;
  ok("verify-wizard-answer", !!vturn && vturn.answer === st.answer, "answer turn missing/exact mismatch");
  ok("verify-wizard-turncount", !!ij && Array.isArray(ij.turns) && ij.turns.length === st.originalTurnCount, "got " + (ij && ij.turns && ij.turns.length));
  const vla = ij ? ij.lastAnalysis : null;
  ok("verify-wizard-pending", !!vla && vla.status === "pending" && vla.ok === false, JSON.stringify(vla).slice(0, 200));
  ok("verify-wizard-jobid", !!vla && vla.jobId === st.interviewJobId, "got " + String(vla && vla.jobId) + " want " + st.interviewJobId);
  if (fail) { console.log("VERIFY FAIL (" + failures.length + "): " + failures.join(" | ")); process.exit(1); }
  if (Date.now() - t0 > BOUND_MS) { ok("verify-bound", false, "pre-retry checks exceeded 60s"); console.log("VERIFY FAIL"); process.exit(1); }
  // Retry research with NORMAL focus: must NOT 409 permanent busy (orphaned live job is retryable).
  const retryFocus = "pending-restart retry normal " + st.nonce + " " + Date.now().toString(36);
  const rr = await post("/api/roster/" + st.rosterId + "/research", { focus: retryFocus }, 55000);
  ok("verify-research-retry-not-409-busy", rr.status === 200, "status=" + rr.status + " " + rr.text.slice(0, 300));
  if (rr.status !== 200) { console.log("VERIFY FAIL"); process.exit(1); }
  const refs = camel(rr.json, "evidenceRefs") || camel(rr.json, "evidenceRef");
  const claims = camel(rr.json, "claims");
  ok("verify-research-new-complete", Array.isArray(refs) && refs.length >= 1 && Array.isArray(claims) && claims.length > 0, "refs=" + JSON.stringify(refs).slice(0, 200));
  // Truthful new job complete/evidence via GET.
  const rg = await get("/api/roster/" + st.rosterId + "/research", 15000);
  const rgAt = rg.json ? (rg.json.researchedAt !== undefined ? rg.json.researchedAt : rg.json.ResearchedAt) : undefined;
  ok("verify-research-get-complete", rg.status === 200 && rgAt !== null && rgAt !== undefined, "status=" + rg.status + " at=" + JSON.stringify(rgAt));
  const rl2 = await get("/api/roster?accountId=" + encodeURIComponent(st.rosterAcct), 15000);
  const row2 = (rl2.json || []).find((e) => { const en = e.entry || e.Entry || e; return String(en.id || en.Id) === String(st.rosterId); });
  const entry2 = row2 ? (row2.entry || row2.Entry || row2) : null;
  ok("verify-research-evidence-persisted", !!entry2 && camel(entry2, "evidenceCount") > 0 && camel(entry2, "researchedAt") !== null, JSON.stringify(entry2 ? { ev: camel(entry2, "evidenceCount"), at: camel(entry2, "researchedAt"), job: camel(entry2, "researchJobId") } : null).slice(0, 300));
  ok("verify-research-job-cleared", !!entry2 && camel(entry2, "researchJobId") === "", "job=" + JSON.stringify(entry2 && camel(entry2, "researchJobId")));
  if (Date.now() - t0 > BOUND_MS) { ok("verify-bound-research", false, "exceeded 60s"); console.log("VERIFY FAIL"); process.exit(1); }
  // Retry interview with answer EMPTY at persisted version: reanalyze existing last turn WITHOUT duplicating.
  const wgPre = await get("/api/wizard/" + st.wizardId, 15000);
  const preVer = camel(wgPre.json, "version");
  ok("verify-interview-still-pending-version", preVer === st.wizardPendingVersion, "got " + preVer + " want " + st.wizardPendingVersion);
  const ir = await post("/api/wizard/" + st.wizardId + "/interview", { answer: "", version: preVer }, 55000);
  ok("verify-interview-retry-200", ir.status === 200, "status=" + ir.status + " " + ir.text.slice(0, 300));
  if (ir.status !== 200) { console.log("VERIFY FAIL"); process.exit(1); }
  ok("verify-interview-extractOk-true", camel(ir.json, "extractOk") === true, "extractOk=" + JSON.stringify(camel(ir.json, "extractOk")) + " err=" + JSON.stringify(camel(ir.json, "extractError")));
  const irTurns = camel(ir.json, "turns");
  ok("verify-interview-no-duplicate", Array.isArray(irTurns) && irTurns.length === st.originalTurnCount, "turns=" + (irTurns && irTurns.length) + " want " + st.originalTurnCount);
  const irTurn = findTurnWith(irTurns, st.answerToken);
  ok("verify-interview-same-answer", !!irTurn && irTurn.answer === st.answer, "answer changed/duplicated");
  const irQ = camel(ir.json, "pendingQuestion") || camel(ir.json, "question");
  const irVer = camel(ir.json, "version");
  ok("verify-interview-question", typeof irQ === "string" && irQ.length > 0, String(irQ).slice(0, 120));
  ok("verify-interview-version", typeof irVer === "number" && irVer > preVer, "ver=" + irVer);
  // Persisted GET must match completion response.
  const wgAfter = await get("/api/wizard/" + st.wizardId, 15000);
  const ijAfter = getInterviewJson(wgAfter.json);
  const afterVer = camel(wgAfter.json, "version");
  ok("verify-interview-version-persist-get", afterVer === irVer, "get=" + afterVer + " resp=" + irVer);
  ok("verify-interview-question-persist-get", !!ijAfter && ijAfter.pendingQuestion === irQ, "get=" + String(ijAfter && ijAfter.pendingQuestion).slice(0, 120));
  ok("verify-interview-turncount-persist-get", !!ijAfter && Array.isArray(ijAfter.turns) && ijAfter.turns.length === st.originalTurnCount, "get turns=" + (ijAfter && ijAfter.turns && ijAfter.turns.length));
  const afterTurn = ijAfter ? findTurnWith(ijAfter.turns, st.answerToken) : null;
  ok("verify-interview-answer-persist-get", !!afterTurn && afterTurn.answer === st.answer, "persisted answer mismatch");
  const ala = ijAfter ? ijAfter.lastAnalysis : null;
  ok("verify-interview-pending-resolved", !!ala && ala.status !== "pending", JSON.stringify(ala).slice(0, 300));
  ok("verify-interview-ok-true", !!ala && ala.ok === true, JSON.stringify(ala).slice(0, 200));
  if (Date.now() - t0 > BOUND_MS) { ok("verify-bound-total", false, "verify exceeded 60s"); }
  if (fail) { console.log("VERIFY FAIL (" + failures.length + "): " + failures.join(" | ")); process.exit(1); }
  console.log("VERIFY PASS run=" + st.run + " research-ev=" + (entry2 && camel(entry2, "evidenceCount")) + " interview-turns=" + st.originalTurnCount + " v=" + afterVer);
  process.exit(0);
}
if (WRITE === VERIFY) { console.error("Usage: QA_API=http://127.0.0.1:5100 node qa/pending-restart.mjs --write | --verify"); process.exit(2); }
if (WRITE) await runWrite();
else await runVerify();
