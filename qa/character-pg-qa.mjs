// Native PostgreSQL proof: fresh schema, upgrade (missing column), restart
// persistence, kill-restart orphan recovery, backup/restore. Uses the EXISTING
// QA postgres at 15441 only, with fresh UNIQUE databases per run. Spawns and
// kills ONLY its own API children. No Docker, no human DBs, no global cleanup.
import { spawn, execFile } from "node:child_process";
import net from "node:net";
const API = process.env.PG_API || "http://127.0.0.1:5174";
const FAKE = process.env.PG_FAKE || "http://127.0.0.1:5252";
const API_DLL = process.env.PG_API_DLL || "";
const PGHOST = "127.0.0.1"; const PGPORT = 15441; const PGUSER = "simceo"; const PGPASS = "qa-only";
const run = "cpg" + Date.now().toString(36).replace(/[^a-z0-9]/g, "");
let pass = 0, fail = 0; const failures = [];
function ok(name, cond, extra) { if (cond) pass++; else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); } }
function pyesc(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function pgSql(db, sql) {
  return new Promise((resolve) => {
    const code = "import psycopg,json,sys,base64\ncon=psycopg.connect(host=" + pyesc(PGHOST) + ",port=" + PGPORT + ",dbname=" + pyesc(db) + ",user=" + pyesc(PGUSER) + ",password=" + pyesc(PGPASS) + ",autocommit=True,connect_timeout=10)\ncur=con.cursor()\ncur.execute(base64.b64decode(\"" + Buffer.from(sql, "utf8").toString("base64") + "\").decode(\"utf-8\"))\ntry:\n rows=cur.fetchall()\n print(json.dumps([list(r) for r in rows]))\nexcept Exception:\n print(json.dumps([]))";
    execFile("python", ["-c", code], { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, err: String(err).slice(0, 200), out: String(stdout || "") + String(stderr || "") });
      else resolve({ ok: true, out: String(stdout || "").trim() });
    });
  });
}
async function pgDbExists(db) {
  const r = await pgSql("simceo", "SELECT 1 FROM pg_database WHERE datname=" + pyesc(db));
  return r.ok && r.out.includes("1");
}
async function reqBase(base, method, path, body, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), opts.timeout || 30000);
  try {
    const r = await fetch(base + path, { method, signal: ctl.signal, headers: { "content-type": "application/json", "x-user": opts.user || "owner" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
let pgChild = null;
async function spawnPgApi(db, port, extraEnv) {
  const env = { ...process.env, USE_POSTGRES: "1", CONNECTIONSTRINGS__APP: "Host=" + PGHOST + ";Port=" + PGPORT + ";Database=" + db + ";Username=" + PGUSER + ";Password=" + PGPASS, META_API_BASE: FAKE, META_API_KEY: "qa-key", ASPNETCORE_URLS: "http://127.0.0.1:" + port, ...(extraEnv || {}) };
  try {
    const pre = await fetch("http://127.0.0.1:" + port + "/health", { signal: AbortSignal.timeout(3000) });
    if (pre.ok) { ok("pg-port-free-" + port, false, "port busy, refusing to disturb"); return null; }
  } catch { }
  if (await tcpListening(port)) { ok("pg-port-tcp-busy-" + port, false, "port has a TCP listener, refusing to disturb"); return null; }
  const child = spawn("dotnet", [API_DLL], { env, stdio: "ignore", windowsHide: true });
  const base = "http://127.0.0.1:" + port;
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    try {
      const r = await fetch(base + "/health", { signal: AbortSignal.timeout(3000) });
      if (r.ok) return { child, base, port };
    } catch { }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  try { child.kill(); } catch { }
  ok("pg-spawn-" + port, false, "own PG API child never became healthy");
  return null;
}
async function killChild(h) {
  if (!h) return;
  try { h.child.kill(); } catch { }
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (h.child.exitCode !== null || h.child.signalCode) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (h && h.port) {
    const pend = Date.now() + 20000;
    while (Date.now() < pend) {
      if (!(await tcpListening(h.port))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
process.on("exit", () => { try { pgChild && pgChild.child.kill(); } catch { } });
function tcpListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    const done = (v) => { try { s.destroy(); } catch (e) {} resolve(v); };
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
    s.setTimeout(3000, () => done(false));
  });
}
function portOf(url, fallback) { try { const u = new URL(url); const p = Number(u.port); return Number.isFinite(p) && p > 0 ? p : fallback; } catch (e) { return fallback; } }
const FRESH_PORT = portOf(API, 5174);
const UPG_PORT = Number(process.env.PG_UPG_PORT) || FRESH_PORT + 1;
const DL_PORT = Number(process.env.PG_DL_PORT) || UPG_PORT + 1;
const createdDbs = [];
async function dropDb(db) { try { await pgSql("simceo", "DROP DATABASE IF EXISTS \"" + db + "\""); } catch (e) {} }
async function cleanupAll() {
  const ch = pgChild; pgChild = null;
  if (ch) await killChild(ch);
  for (const db of createdDbs.splice(0)) await dropDb(db);
}
process.on("unhandledRejection", async (e) => { console.log("unhandled rejection; cleaning up owned children/DBs"); try { await cleanupAll(); } catch (ee) {} process.exit(1); });
async function fakeLog() { return (await fetch(FAKE + "/__log")).json(); }
async function fakeLogClear() { await fetch(FAKE + "/__log", { method: "DELETE" }); }
async function waitForLog(pred, timeoutMs, label) {
  const end = Date.now() + (timeoutMs || 30000);
  while (Date.now() < end) {
    try { const log = await fakeLog(); if (log.some(pred)) return true; } catch { }
    await new Promise((r) => setTimeout(r, 300));
  }
  ok("waitlog-" + (label || "x"), false, "prompt never dispatched");
  return false;
}
async function pgTableCols(db, table) {
  const r = await pgSql(db, "SELECT column_name FROM information_schema.columns WHERE table_name=" + pyesc(table) + " ORDER BY 1");
  try { return JSON.parse(r.out || "[]").map((x) => x[0]); } catch { return []; }
}
if (!API_DLL) { console.log("PG_API_DLL (absolute path to tested SimCEO.Api.dll) is required"); process.exit(2); }
async function pgEntry(apiBase, acct, rid) {
  const lr = await reqBase(apiBase, "GET", "/api/roster?accountId=" + acct, undefined, {});
  const row = (lr.json || []).find((x) => { const e = x.entry || x || {}; return String(e.id || e.Id || "") === String(rid); });
  return row ? (row.entry || row) : null;
}
async function pgProfile(apiBase, acct, rid) {
  const e = await pgEntry(apiBase, acct, rid);
  try { return JSON.parse((e || {}).profileJson || (e || {}).ProfileJson || "{}"); } catch (err) { return {}; }
}

// ---------- 1: fresh DB startup + full flow persisted ----------
console.log("pg1: fresh database startup + full flow");
const freshDb = "charpg_fresh_" + run;
{
  const mk = await pgSql("simceo", "CREATE DATABASE \"" + freshDb + "\"");
  ok("pg-fresh-createdb", mk.ok, mk.out.slice(0, 200));
  if (mk.ok) createdDbs.push(freshDb);
}
const cols0 = await pgTableCols(freshDb, "RosterEntries");
ok("pg-fresh-nouser-table-yet", cols0.length === 0, JSON.stringify(cols0));
pgChild = null;
const fresh = await spawnPgApi(freshDb, FRESH_PORT, {});
ok("pg-fresh-startup", !!fresh, "own PG API failed to start on fresh DB (startup regression)");
if (fresh) pgChild = fresh;
if (!fresh) { console.log("character-pg-qa: pass=" + pass + " fail=" + fail); await cleanupAll(); process.exit(1); }
const FAPI = fresh.base;
const cols1 = await pgTableCols(freshDb, "RosterEntries");
ok("pg-fresh-inputs-column", cols1.includes("ResearchInputsJson"), JSON.stringify(cols1));
const ACCT = globalThis.crypto.randomUUID();
const fq = (m, p, b, o) => reqBase(FAPI, m, p, b, o);
const seed = await fq("POST", "/api/roster/quick", { accountId: ACCT, name: "PG Fresh Fiona", description: "Native PG persistence probe advisor; teaches reserved documentation-domain practices using the Example Domain illustration for harbor training guides.", background: "PG-BG-FRESH background text.", sourceUrls: ["https://example.com/"] });
ok("pg-seed-201", seed.status === 201, seed.status + " " + seed.text.slice(0, 160));
const fRid = (seed.json || {}).id || (seed.json || {}).Id;
const fres = await fq("POST", "/api/roster/" + fRid + "/research", { focus: "pg fresh probe" }, { timeout: 170000 });
ok("pg-research-200", fres.status === 200 && fres.json?.draftStatus === "done", fres.status + " " + (fres.text || "").slice(0, 200));
const fRefs = fres.json?.evidenceRefs || [];
ok("pg-research-fetched", fRefs.some((e) => (e.fetched ?? e.Fetched) === true && String(e.url || e.Url || "").includes("example.com")), JSON.stringify(fRefs).slice(0, 300));
const fProf = await pgProfile(FAPI, ACCT, fRid);
fProf.contributionCriteria = "PG-EDITED-CRIT persists across restart.";
fProf.reasoningApproach = "PG-EDITED-REAS persists across restart.";
fProf.responseStyle = "PG-EDITED-STYLE persists across restart.";
const fSave = await fq("PUT", "/api/roster/" + fRid, { profileJson: JSON.stringify(fProf) });
ok("pg-save-200", fSave.status === 200, fSave.status + " " + (fSave.text || "").slice(0, 160));
const fGet = await fq("GET", "/api/roster/" + fRid + "/research", undefined, {});
ok("pg-saved-state", fGet.json?.draftStatus === "saved" && !!fGet.json?.researchedAt && (fGet.json?.inputs?.background || "").includes("PG-BG-FRESH"), JSON.stringify(fGet.json).slice(0, 300));
// ---------- 2: restart persistence (kill + new process, same DB) ----------
console.log("pg2: restart persistence");
const freshPid = fresh.child.pid;
await killChild(fresh);
pgChild = null;
const fresh2 = await spawnPgApi(freshDb, FRESH_PORT, {});
ok("pg-restart-startup", !!fresh2, "restarted PG API failed to start");
if (!fresh2) { console.log("character-pg-qa: pass=" + pass + " fail=" + fail); await cleanupAll(); process.exit(1); }
pgChild = fresh2;
ok("pg-restart-newpid", fresh2.child.pid !== freshPid, "restarted API has same PID as killed child (stale listener?)");
const FAPI2 = fresh2.base;
const fq2 = (m, p, b, o) => reqBase(FAPI2, m, p, b, o);
const rAfter = await fq2("GET", "/api/roster/" + fRid + "/research", undefined, {});
ok("pg-restart-state", rAfter.json?.draftStatus === "saved" && !!rAfter.json?.researchedAt && (rAfter.json?.inputs?.background || "").includes("PG-BG-FRESH") && (rAfter.json?.inputs?.sourceUrls || []).length === 1, JSON.stringify(rAfter.json).slice(0, 300));
const lrAfter = await fq2("GET", "/api/roster?accountId=" + ACCT, undefined, {});
const rowAfter = await pgEntry(FAPI2, ACCT, fRid);
ok("pg-restart-profile", JSON.stringify(((rowAfter || {}).entry || rowAfter || {}).profileJson || "").includes("PG-EDITED-CRIT"), "saved paragraphs lost across restart");
const rProfAfter = await pgProfile(FAPI2, ACCT, fRid);
ok("pg-restart-all3", (rProfAfter.contributionCriteria || "").includes("PG-EDITED-CRIT") && (rProfAfter.reasoningApproach || "").includes("PG-EDITED-REAS") && (rProfAfter.responseStyle || "").includes("PG-EDITED-STYLE"), JSON.stringify(rProfAfter).slice(0, 200));
ok("pg-restart-inputs-exact", rAfter.json?.inputs?.background === "PG-BG-FRESH background text." && JSON.stringify(rAfter.json?.inputs?.sourceUrls || []) === JSON.stringify(["https://example.com/"]), JSON.stringify(rAfter.json?.inputs).slice(0, 300));

// ---------- 3: orphan kill mid-research -> interrupted, retry works ----------
console.log("pg3: orphan kill mid-research");
const seedO = await fq2("POST", "/api/roster/quick", { accountId: ACCT, name: "PG Orphan Otto", description: "Orphan recovery probe advisor, long enough description." });
const oRid = (seedO.json || {}).id || (seedO.json || {}).Id;
await fakeLogClear();
const orphanRun = fq2("POST", "/api/roster/" + oRid + "/research", { focus: "QA-SLEEP-R:9000 orphan probe dossier" }, { timeout: 120000 });
orphanRun.catch(() => ({}));
await waitForLog((e) => e.path === "responses" && (e.full || "").includes("orphan probe dossier"), 30000, "orphan-dispatch");
const fresh2Pid = fresh2.child.pid;
await killChild(fresh2);
pgChild = null;
const fresh3 = await spawnPgApi(freshDb, FRESH_PORT, {});
ok("pg-orphan-restart", !!fresh3, "restart after kill failed");
if (!fresh3) { console.log("character-pg-qa: pass=" + pass + " fail=" + fail); await cleanupAll(); process.exit(1); }
pgChild = fresh3;
ok("pg-orphan-newpid", fresh3.child.pid !== fresh2Pid, "post-kill API has same PID as killed child (stale listener?)");
const FAPI3 = fresh3.base;
const fq3 = (m, p, b, o) => reqBase(FAPI3, m, p, b, o);
let og = null;
for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 1000)); og = await fq3("GET", "/api/roster/" + oRid + "/research", undefined, {}); if (!og.json?.running) break; }
ok("pg-orphan-interrupted", og && og.json?.running === false && (og.json?.researchedAt ?? null) === null && og.json?.stage === "interrupted", JSON.stringify(og?.json).slice(0, 300));
const oRetry = await fq3("POST", "/api/roster/" + oRid + "/research", { focus: "orphan retry clean" }, { timeout: 170000 });
ok("pg-orphan-retry-200", oRetry.status === 200 && (oRetry.json?.draftStatus === "done" || oRetry.json?.draftStatus === "unsupported"), oRetry.status + " " + (oRetry.text || "").slice(0, 200));
// ---------- 4: backup / restore on PG ----------
console.log("pg4: backup restore");
const bk = await fq3("GET", "/api/backup", undefined, {});
ok("pg-backup-200", bk.status === 200 && bk.json?.snapshot, bk.status + " " + (bk.text || "").slice(0, 120));
const extraSeed = await fq3("POST", "/api/roster/quick", { accountId: ACCT, name: "PG Extra Evan", description: "Backup-restore probe advisor, long enough." });
const extraRid = (extraSeed.json || {}).id || (extraSeed.json || {}).Id;
const rst = await fq3("POST", "/api/backup/restore", { snapshot: bk.json.snapshot, hash: bk.json.hash });
ok("pg-restore-200", rst.status === 200, rst.status + " " + (rst.text || "").slice(0, 200));
const lrPost = await fq3("GET", "/api/roster?accountId=" + ACCT, undefined, {});
const idsPost = (lrPost.json || []).map((x) => { const e = x.entry || x || {}; return String(e.id || e.Id || ""); });
ok("pg-restore-removed-extra", !idsPost.includes(String(extraRid)), idsPost.join(",").slice(0, 200));
ok("pg-restore-kept-prior", idsPost.includes(String(fRid)), idsPost.join(",").slice(0, 200));
const rPost = await fq3("GET", "/api/roster/" + fRid + "/research", undefined, {});
ok("pg-restore-proof-intact", rPost.json?.draftStatus === "saved" && !!rPost.json?.researchedAt, JSON.stringify(rPost.json).slice(0, 200));
await killChild(fresh3);
pgChild = null;
// ---------- 5: bounded research deadline on native PG ----------
console.log("pg5: bounded deadline");
const dl = await spawnPgApi(freshDb, DL_PORT, { SIMCEO_RESEARCH_DEADLINE_SEC: "4" });
ok("pg-deadline-startup", !!dl, "deadline PG API failed to start");
if (!dl) { console.log("character-pg-qa: pass=" + pass + " fail=" + fail); await cleanupAll(); process.exit(1); }
pgChild = dl;
const DAPI = dl.base;
const dq = (m, p, b, o) => reqBase(DAPI, m, p, b, o);
const dSeed = await dq("POST", "/api/roster/quick", { accountId: ACCT, name: "PG Deadline Dee", description: "Bounded deadline probe advisor, long enough description." });
const dRid = (dSeed.json || {}).id || (dSeed.json || {}).Id;
const dRes = await dq("POST", "/api/roster/" + dRid + "/research", { focus: "QA-SLEEP-R:8000 deadline dossier probe" }, { timeout: 60000 });
ok("pg-deadline-504", dRes.status === 504, dRes.status + " " + (dRes.text || "").slice(0, 200));
const dGet = await dq("GET", "/api/roster/" + dRid + "/research", undefined, {});
ok("pg-deadline-terminal", dGet.json?.running === false && (dGet.json?.researchedAt ?? null) === null && dGet.json?.draftStatus === "failed" && dGet.json?.stage === "failed", JSON.stringify(dGet.json).slice(0, 300));
await killChild(dl);
pgChild = null;
// ---------- 0: upgrade path (old schema without ResearchInputsJson) ----------
console.log("pg0: upgrade from pre-column schema");
const upgDb = "charpg_upg_" + run;
const OLD_CREATE = "CREATE TABLE IF NOT EXISTS \"RosterEntries\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"AccountId\" uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000', \"Type\" integer NOT NULL DEFAULT 0, \"Name\" text NOT NULL DEFAULT '', \"Description\" text NOT NULL DEFAULT '', \"ProfileJson\" text NOT NULL DEFAULT '{}' , \"Version\" integer NOT NULL DEFAULT 1, \"Archived\" boolean NOT NULL DEFAULT false, \"Tags\" text NOT NULL DEFAULT '', \"OwnerKey\" text NOT NULL DEFAULT '', \"ResearchJson\" text NOT NULL DEFAULT '{}' , \"ResearchedAt\" timestamp with time zone, \"ResearchRequested\" boolean NOT NULL DEFAULT false, \"EvidenceCount\" integer NOT NULL DEFAULT 0, \"ResearchJobId\" text NOT NULL DEFAULT '', \"ResearchBaseVersion\" integer NOT NULL DEFAULT 0, \"UpdatedAt\" timestamp with time zone NOT NULL DEFAULT now())";
{
  const mk = await pgSql("simceo", "CREATE DATABASE \"" + upgDb + "\"");
  ok("pg-upg-createdb", mk.ok, mk.out.slice(0, 200));
  if (mk.ok) createdDbs.push(upgDb);
  const ct = await pgSql(upgDb, OLD_CREATE);
  ok("pg-upg-oldschema", ct.ok, ct.out.slice(0, 200));
  const colsPre = await pgTableCols(upgDb, "RosterEntries");
  ok("pg-upg-column-missing", !colsPre.includes("ResearchInputsJson"), JSON.stringify(colsPre));
  const oldId = "11111111-2222-3333-4444-555555555555";
  const oldProf = JSON.stringify({ fictional: true, name: "Old Schema Otto", contributionCriteria: "OTTO-CRIT legacy row.", reasoningApproach: "OTTO-REAS legacy row.", responseStyle: "OTTO-STYLE legacy row." });
  const oldRes = JSON.stringify({ draftStatus: "done", draftProfile: { contributionCriteria: "OTTO-CRIT", reasoningApproach: "OTTO-REAS", responseStyle: "OTTO-STYLE" }, evidenceRefs: [], version: 1 });
  const ins = await pgSql(upgDb, "INSERT INTO \"RosterEntries\" (\"Id\",\"AccountId\",\"Type\",\"Name\",\"Description\",\"ProfileJson\",\"Version\",\"Archived\",\"Tags\",\"OwnerKey\",\"ResearchJson\",\"ResearchedAt\",\"ResearchRequested\",\"EvidenceCount\",\"ResearchJobId\",\"ResearchBaseVersion\") VALUES ('" + oldId + "','" + ACCT + "',0,'Old Schema Otto','Legacy row from pre-column schema.','" + oldProf.replace(/'/g, "''") + "',2,false,'','owner'," + "'" + oldRes.replace(/'/g, "''") + "',now(),true,1,'',1)");
  ok("pg-upg-oldrow", ins.ok, ins.out.slice(0, 200));
}
const upg = await spawnPgApi(upgDb, UPG_PORT, {});
ok("pg-upg-startup", !!upg, "new server failed to start on old schema (upgrade regression)");
if (!upg) { console.log("character-pg-qa: pass=" + pass + " fail=" + fail); await cleanupAll(); process.exit(1); }
pgChild = upg;
const UAPI = upg.base;
const uq = (m, p, b, o) => reqBase(UAPI, m, p, b, o);
const colsPost = await pgTableCols(upgDb, "RosterEntries");
ok("pg-upg-column-added", colsPost.includes("ResearchInputsJson"), JSON.stringify(colsPost));
const uList = await uq("GET", "/api/roster?accountId=" + ACCT, undefined, {});
const uRow = (uList.json || []).find((x) => String(((x.entry || x || {}).id || (x.entry || x || {}).Id) || "") === "11111111-2222-3333-4444-555555555555");
const uEntry = uRow ? (uRow.entry || uRow) : null;
ok("pg-upg-oldrow-readable", !!uEntry && (uEntry.researchInputsJson ?? uEntry.ResearchInputsJson) === "{}", JSON.stringify(uEntry).slice(0, 200));
const uRes = await uq("GET", "/api/roster/11111111-2222-3333-4444-555555555555/research", undefined, {});
ok("pg-upg-oldproof-intact", uRes.json?.stage === "done" && !!uRes.json?.researchedAt && (uRes.json?.draftProfile?.contributionCriteria || "").includes("OTTO-CRIT"), JSON.stringify(uRes.json).slice(0, 300));
const uRe = await uq("POST", "/api/roster/11111111-2222-3333-4444-555555555555/research", { focus: "upgrade rerun probe" }, { timeout: 170000 });
ok("pg-upg-rerun-200", uRe.status === 200, uRe.status + " " + (uRe.text || "").slice(0, 200));
const uReStatus = uRe.json?.draftStatus ?? uRe.json?.DraftStatus;
ok("pg-upg-rerun-terminal", ["done", "unsupported", "failed"].includes(uReStatus), uRe.status + " " + (uRe.text || "").slice(0, 200));
await cleanupAll();
console.log("character-pg-qa: pass=" + pass + " fail=" + fail);
if (fail && failures.length) { console.log("FAILURES:"); for (const f of failures) console.log(" - " + f); }
process.exit(fail ? 1 : 0);
