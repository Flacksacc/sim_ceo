// qa/rollback-interview-probe.mjs — focused PG rollback-during-interview probe (TEST-ONLY).
// Proves a real PostgreSQL fault inside the import Atomic Save cannot detach/drop a
// slow interview's completed persisted state (review finding 1). NOT run by this worker;
// for later primary execution behind the shared-QA barrier. No production test hook.
// Usage:
//   QA_API=http://127.0.0.1:5100 node qa/rollback-interview-probe.mjs
//   QA_API=http://127.0.0.1:5100 node qa/rollback-interview-probe.mjs --verify
// Requires: backend marker postgres, owned container simceo-qa-pg only, fake :5199 sleep.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

const API = process.env.QA_API || "http://127.0.0.1:5100";
if (API.includes(":5080")) { console.error("REFUSE 5080: isolated QA must not target shared/prod port."); process.exit(2); }
const CONTAINER = "simceo-qa-pg";
if (!CONTAINER.startsWith("simceo-qa") || CONTAINER !== "simceo-qa-pg") { console.error("REFUSE container: only simceo-qa-pg."); process.exit(2); }
const VERIFY = process.argv.includes("--verify");
const STATE_FILE = ".tmp/rollback-interview-state.json";
const nonce = crypto.randomBytes(4).toString("hex");
const MARKER = "QA_ROLLBACK_" + nonce.toUpperCase();
const BADNAME = "QA-ROLLBACK-PROBE-" + nonce;
const FN = "qa_rb_" + nonce + "_fn";
const TRG = "qa_rb_" + nonce + "_trg";
const ACCT = crypto.randomUUID();
let cleanupTbl = null;
let failures = [];
const ok = (n, c, x) => { console.log((c ? "  ok " : "  FAIL ") + n + (c || !x ? "" : " :: " + x)); if (!c) failures.push(n + (x ? " :: " + x : "")); };
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const H = { "content-type": "application/json", "x-user": "owner" };
async function req(method, path, body, ms = 30000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(API + path, { method, signal: ctl.signal, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const get = (p, ms) => req("GET", p, undefined, ms);
const post = (p, b, ms) => req("POST", p, b, ms);
const camel = (o, k) => { if (!o || typeof o !== "object") return undefined; if (k in o) return o[k]; const lo = k.toLowerCase(); for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key]; return undefined; };
function docker(args, input) { return spawnSync("docker", args, { input, encoding: "utf8", windowsHide: true, timeout: 30000 }); }
function psql1(c_args, sql) { const r = docker(["exec", "-i", CONTAINER, "psql", "-U", "simceo", "-d", "simceo", ...c_args, sql], undefined); return (r.stdout || "") + (r.stderr || ""); }
const q1 = (sql) => psql1(["-tAc"], sql).trim();
function sqlCount(tbl, name) { return q1('SELECT count(*) FROM ' + tbl + ' WHERE "Name" = \'' + name.replaceAll("'", "''") + '\'').trim(); }
function discoverTable() {
  const raw = q1("SELECT table_schema || '.' || table_name FROM information_schema.tables WHERE lower(table_name) IN ('boards','board') AND table_schema NOT IN ('pg_catalog','information_schema') LIMIT 1");
  const first = raw.split(/\s+/).filter(Boolean)[0] || "";
  if (!first) return null;
  const [sch, tab] = first.includes(".") ? first.split(".") : ["public", first];
  return '"' + sch.replaceAll('"', "") + '"."' + tab.replaceAll('"', "") + '"';
}
function installFault(tbl) {
  const ddlFn = 'CREATE OR REPLACE FUNCTION ' + FN + '() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."Name" = \'' + BADNAME + '\' THEN RAISE EXCEPTION \'' + MARKER + ' import trigger fired\' USING ERRCODE=\'P0001\'; END IF; RETURN NEW; END; $$;';
  const ddlTrg = 'DROP TRIGGER IF EXISTS ' + TRG + ' ON ' + tbl + '; CREATE TRIGGER ' + TRG + ' BEFORE INSERT ON ' + tbl + ' FOR EACH ROW EXECUTE FUNCTION ' + FN + '();';
  const a = docker(["exec", "-i", CONTAINER, "psql", "-U", "simceo", "-d", "simceo", "-v", "ON_ERROR_STOP=1", "-q", "-c", ddlFn], undefined);
  if (a.status !== 0) return "function ddl failed: " + ((a.stderr || "") + (a.stdout || "")).slice(0, 300);
  const b = docker(["exec", "-i", CONTAINER, "psql", "-U", "simceo", "-d", "simceo", "-v", "ON_ERROR_STOP=1", "-q", "-c", ddlTrg], undefined);
  if (b.status !== 0) return "trigger ddl failed: " + ((b.stderr || "") + (b.stdout || "")).slice(0, 300);
  return null;
}
function dropFault(tbl) {
  try { docker(["exec", "-i", CONTAINER, "psql", "-U", "simceo", "-d", "simceo", "-q", "-c", "DROP TRIGGER IF EXISTS " + TRG + " ON " + tbl + ";"], undefined); } catch {}
  try { docker(["exec", "-i", CONTAINER, "psql", "-U", "simceo", "-d", "simceo", "-q", "-c", "DROP FUNCTION IF EXISTS " + FN + "();"], undefined); } catch {}
}
// Actual persisted interviewJson contract (WizardGuide.cs, read-only): turns:[{question,answer,at,analysis}],
// pending persist -> lastAnalysis {ok:false,status:"pending",jobId,at,turn}; completed persist ->
// lastAnalysis {ok,at,error,jobId} (NO status/analysis fields). Interview POST response carries
// analysis as a STRING plus turns, and NO lastAnalysis property.
function parseIj(resp) { try { return JSON.parse(camel(resp.json, "interviewJson") || "{}"); } catch { return null; } }
// Fail-closed pending gate: parsed interviewJson must show status=="pending", ok===false, a
// non-empty jobId, AND a turn whose answer holds the token. Raw text matching is insufficient:
// "pending" also matches pendingQuestion text after completion.
function pendingSnapshot(ij, token) {
  if (!ij || typeof ij !== "object") return null;
  const la = ij.lastAnalysis;
  if (!la || typeof la !== "object") return null;
  if (la.status !== "pending" || la.ok !== false) return null;
  if (typeof la.jobId !== "string" || !la.jobId) return null;
  const turns = Array.isArray(ij.turns) ? ij.turns : [];
  if (!turns.some((t) => t && typeof t.answer === "string" && t.answer.includes(token))) return null;
  return { jobId: la.jobId };
}
function turnFor(ij, token) {
  const turns = ij && Array.isArray(ij.turns) ? ij.turns : [];
  return turns.find((t) => t && typeof t.answer === "string" && t.answer.includes(token)) || null;
}
function boundedLogs(since) { return docker(["logs", "--since", since, "--tail", "500", CONTAINER], undefined); }
function logsText(r) { return ((r && r.stdout) || "") + ((r && r.stderr) || ""); }
const normNull = (v) => (v === undefined ? null : v);
async function main() {
  console.log("rollback-interview probe nonce=" + nonce + " api=" + API + (VERIFY ? " mode=verify" : " mode=run"));
  if (VERIFY) {
    if (!fs.existsSync(STATE_FILE)) { console.error("missing state file " + STATE_FILE); process.exit(1); }
    const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const be = await get("/api/backend"); ok("backend-postgres", be.status === 200 && be.json && be.json.mode === "postgres", be.text.slice(0, 160));
    const g = await get("/api/wizard/" + st.draftId); ok("verify-draft-200", g.status === 200, String(g.status));
    const gv = camel(g.json, "version"), ij = parseIj(g);
    ok("verify-version", gv === st.version, gv + " vs " + st.version);
    ok("verify-question", !!ij && ij.pendingQuestion === st.question, String(ij && ij.pendingQuestion).slice(0, 120));
    const vt = ij && turnFor(ij, st.answerToken);
    ok("verify-answer", !!vt, "answer token persisted");
    ok("verify-analysis-exact", !!vt && vt.analysis === st.analysis, "completed turn analysis differs across restart");
    const vla = (ij && ij.lastAnalysis) || {};
    ok("verify-lastanalysis-job", vla.jobId === st.lastJobId, String(vla.jobId));
    ok("verify-lastanalysis-ok", vla.ok === st.lastOk, String(vla.ok));
    ok("verify-lastanalysis-error", normNull(vla.error) === normNull(st.lastError), JSON.stringify(vla).slice(0, 200));
    ok("verify-pending-resolved", vla.status !== "pending", JSON.stringify(vla).slice(0, 200));
    const tbl = discoverTable(); ok("verify-table", !!tbl, "boards table not found");
    if (tbl) ok("verify-rolled-back", sqlCount(tbl, st.badName) === "0", "count=" + sqlCount(tbl, st.badName));
    ok("verify-marker-logs", logsText(boundedLogs(st.logStart)).includes(st.marker), "unique SQL trigger marker absent in bounded docker logs");
    console.log(failures.length ? "PROBE FAIL (" + failures.length + ")" : "PROBE PASS"); process.exit(failures.length ? 1 : 0);
  }
  const logStart = new Date().toISOString();
  let tbl = null, wid = null;
  try {
    const be = await get("/api/backend"); ok("backend-postgres", be.status === 200 && be.json && be.json.mode === "postgres", be.text.slice(0, 200));
    if (failures.length) throw new Error("backend gate");
    const insp = docker(["inspect", CONTAINER], undefined); ok("container-owned", insp.status === 0, "simceo-qa-pg missing");
    tbl = discoverTable(); cleanupTbl = tbl; ok("table-found", !!tbl, "no Boards table via information_schema");
    if (!tbl) throw new Error("no table");
    ok("fault-install", !installFault(tbl), "ddl failed");
    const b = await post("/api/boards", { name: "rb-src-" + nonce, mission: "rollback probe source", stage: "qa" });
    ok("src-board-201", b.status === 201 && camel(b.json, "id"), String(b.status) + " " + b.text.slice(0, 160));
    const srcId = camel(b.json, "id");
    const ex = await get("/api/boards/" + srcId + "/export"); ok("export-200", ex.status === 200 && ex.json && ex.json.snapshot, String(ex.status));
    const snap = JSON.parse(ex.json.snapshot); snap.lead = null; snap.board.name = BADNAME;
    const badText = JSON.stringify(snap), badHash = sha(badText);
    const w = await post("/api/wizard", { accountId: ACCT, step: 1, presetKey: "", fieldsJson: JSON.stringify({ name: "rb-wiz-" + nonce, mission: "rollback probe", stage: "qa", lead: { name: "L" }, advisors: [{ role: "Strategist", name: "" }] }) });
    ok("wizard-create", (w.status === 200 || w.status === 201) && camel(w.json, "id"), String(w.status));
    wid = camel(w.json, "id");
    const g0 = await get("/api/wizard/" + wid); const v0 = camel(g0.json, "version");
    ok("wizard-version", typeof v0 === "number", String(v0));
    const token = "slow-probe-" + nonce;
    const ivP = post("/api/wizard/" + wid + "/interview", { answer: "QA-SLEEP:2500 " + token, version: v0 }, 60000);
    let pendJob = "";
    for (let i = 0; i < 40 && !pendJob; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const snapP = pendingSnapshot(parseIj(await get("/api/wizard/" + wid)), token);
      if (snapP) pendJob = snapP.jobId;
    }
    ok("interview-pending-durable", !!pendJob, "answer turn + pending lastAnalysis(status=pending,ok=false,jobId) not durably saved before fault");
    if (!pendJob) throw new Error("pending gate not observed; refusing to fire SQL fault");
    const imp = await post("/api/boards/import", { snapshot: badText, hash: badHash });
    ok("import-500", imp.status === 500, String(imp.status) + " " + (imp.text || "").slice(0, 200));
    ok("trigger-marker-logs", logsText(boundedLogs(logStart)).includes(MARKER), "unique SQL trigger marker absent in bounded docker logs; body=" + (imp.text || "").slice(0, 160));
    ok("rolled-back-count-0", sqlCount(tbl, BADNAME) === "0", "count=" + sqlCount(tbl, BADNAME));
    const iv = await ivP; ok("interview-200", iv.status === 200, String(iv.status) + " " + (iv.text || "").slice(0, 200));
    const ivVer = camel(iv.json, "version"), ivQ = camel(iv.json, "question") || camel(iv.json, "pendingQuestion");
    const ivAnalysis = camel(iv.json, "analysis");
    const ivExtractOk = camel(iv.json, "extractOk"), ivExtractError = camel(iv.json, "extractError");
    ok("interview-analysis-string", typeof ivAnalysis === "string" && ivAnalysis.length > 0, String(iv.status));
    const fin = await get("/api/wizard/" + wid); const finIj = parseIj(fin);
    ok("version-matches-get", camel(fin.json, "version") === ivVer, camel(fin.json, "version") + " vs " + ivVer);
    ok("question-matches-get", !!finIj && finIj.pendingQuestion === ivQ, String(finIj && finIj.pendingQuestion).slice(0, 120));
    const finTurn = finIj && turnFor(finIj, token);
    ok("answer-persisted", !!finTurn, "completion lost after rollback");
    ok("analysis-exact", !!finTurn && finTurn.analysis === ivAnalysis, "completed turn analysis differs from completion response");
    const finLa = (finIj && finIj.lastAnalysis) || {};
    ok("pending-resolved", finLa.status !== "pending", JSON.stringify(finLa).slice(0, 200));
    ok("job-continuity", finLa.jobId === pendJob, String(finLa.jobId));
    ok("lastanalysis-ok", finLa.ok === ivExtractOk, String(finLa.ok));
    ok("lastanalysis-error", normNull(finLa.error) === normNull(ivExtractError), JSON.stringify(finLa).slice(0, 200));
    if (failures.length) throw new Error("run checks failed; state not persisted");
    fs.mkdirSync(".tmp", { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ draftId: wid, version: ivVer, question: finIj.pendingQuestion, answerToken: token, analysis: ivAnalysis, lastJobId: finLa.jobId, lastOk: finLa.ok, lastError: normNull(finLa.error), extractOk: ivExtractOk, extractError: normNull(ivExtractError), badName: BADNAME, nonce, marker: MARKER, table: tbl, logStart, api: API }, null, 2));
  } catch (e) { failures.push("exception :: " + (e && e.message)); console.log("  FAIL exception :: " + (e && e.message)); }
  finally { if (cleanupTbl) dropFault(cleanupTbl); }
  console.log(failures.length ? "PROBE FAIL (" + failures.length + "): " + failures.join(" | ") : "PROBE PASS nonce=" + nonce);
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.error("fatal", e); try { if (cleanupTbl) dropFault(cleanupTbl); } catch {} process.exit(1); });