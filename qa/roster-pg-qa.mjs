import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Native Postgres behavioral QA (isolated NEW database on 127.0.0.1:15441).
// Run: SIMCEO_PG_SUPER="Host=127.0.0.1;Port=15441;Database=simceo;Username=simceo;Password=qa-only;Timeout=15" node qa/roster-pg-qa.mjs
// Creates rosterqa_http_<stamp>, runs API (15973) + fake (15974) against it,
// proves attach/chat + kill/restart persistence + backup/restore, then DROPS it.
// Never touches existing DBs/volumes.
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))) + path.sep;
const SUPER = process.env.SIMCEO_PG_SUPER || "";
// Negative-path probe (no services, no real PG): SIMCEO_PGQA_NEGATIVE="drop-fail" mocks a
// failing owned-DB DROP; "keyring-fail" mocks the removal syscall so the REAL verified
// keyring cleanup fails. Both exercise the ACTUAL finally/report path below.
const _realRmSync = fs.rmSync.bind(fs);
if (process.env.SIMCEO_PGQA_NEGATIVE === "keyring-fail") fs.rmSync = () => { throw new Error("SIMCEO_PGQA_NEGATIVE mocked keyring removal failure"); };
const NEG = process.env.SIMCEO_PGQA_NEGATIVE || "";
const API = "http://127.0.0.1:15973";
const FAKE = "http://127.0.0.1:15974";
let pass = 0, fail = 0;
const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; bad.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
async function req(method, p, body, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 60000);
  try {
    const headers = {};
    let b;
    if (body !== undefined && !(body instanceof FormData)) { headers["content-type"] = "application/json"; b = JSON.stringify(body); }
    else if (body instanceof FormData) b = body;
    const r = await fetch(API + p, { method, signal: ctl.signal, headers, body: b });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const get = (p, o) => req("GET", p, undefined, o);
const post = (p, b, o) => req("POST", p, b, o);
const put = (p, b, o) => req("PUT", p, b, o);
function psql(sql) {
  if (NEG) {
    if (/DROP\s+DATABASE/i.test(sql) && NEG === "drop-fail") throw new Error("SIMCEO_PGQA_NEGATIVE mocked drop failure (simulated held connection)");
    return;
  }
  const Q = String.fromCharCode(39);
  const ps = '$nlog = "$HOME/.nuget/packages/microsoft.extensions.logging.abstractions/10.0.0/lib/net10.0/Microsoft.Extensions.Logging.Abstractions.dll"; $ndiag = "$HOME/.nuget/packages/system.diagnostics.diagnosticsource/10.0.1/lib/net10.0/System.Diagnostics.DiagnosticSource.dll"; Add-Type -Path $nlog; Add-Type -Path $ndiag; Add-Type -Path "$HOME/.nuget/packages/npgsql/10.0.3/lib/net10.0/Npgsql.dll"; $c = New-Object Npgsql.NpgsqlConnection(' + Q + SUPER + Q + '); $c.Open(); $cmd = $c.CreateCommand(); $cmd.CommandText = ' + Q + sql + Q + '; $cmd.ExecuteNonQuery() | Out-Null; $c.Close();';
  execFileSync("pwsh", ["-NoProfile", "-Command", ps], { stdio: "pipe", timeout: 60000, windowsHide: true });
}
async function waitUp(url, secs) {
  const end = Date.now() + secs * 1000;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await sleep(1000);
  }
  return false;
}
function apiDll() { return path.join(ROOT, "server/SimCEO.Api/bin/Debug/net10.0/SimCEO.Api.dll"); }
function startApi(conn, keyring) {
  const env = { ...process.env, ASPNETCORE_URLS: "http://127.0.0.1:15973", META_API_BASE: FAKE, META_API_KEY: "qa-key", SIMCEO_INSTANCE: "roster-pg-qa", WIKI_KEYRING_DIR: keyring, USE_POSTGRES: "1", ConnectionStrings__App: conn };
  return spawn("dotnet", [apiDll()], { env, stdio: "ignore", windowsHide: true });
}
async function waitPortClosed(port, secs = 30) {
  const end = Date.now() + secs * 1000;
  while (Date.now() < end) {
    try { await fetch(`http://127.0.0.1:${port}/health`); } catch { return true; }
    await sleep(500);
  }
  return false;
}
async function waitExit(proc, secs = 30) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return true;
  const end = Date.now() + secs * 1000;
  while (Date.now() < end) {
    if (proc.exitCode !== null || proc.signalCode !== null) return true;
    await sleep(250);
  }
  return proc.exitCode !== null || proc.signalCode !== null;
}
function rmDirVerified(dir, prefix) {
  try {
    const base = path.resolve(os.tmpdir()) + path.sep;
    const full = path.resolve(dir);
    if (!full.startsWith(base)) return false;
    if (path.basename(full).indexOf(prefix) !== 0) return false;
    fs.rmSync(full, { recursive: true, force: true });
    return true;
  } catch { return false; }
}
async function main() {
  if (!SUPER && !NEG) { console.log("SKIP roster-pg-qa: SIMCEO_PG_SUPER not set"); process.exit(0); }
  const db = "rosterqa_http_" + Date.now().toString(36);
  psql(`CREATE DATABASE "${db}"`);
  console.log("  db=" + db);
  const conn = `Host=127.0.0.1;Port=15441;Database=${db};Username=simceo;Password=qa-only;Timeout=15`;
  const fake = NEG ? null : spawn(process.execPath, [path.join(ROOT, "qa/fake-provider.mjs"), "--port", "15974"], { stdio: "ignore", windowsHide: true });
  const keyring = fs.mkdtempSync(path.join(os.tmpdir(), "roster-pgqa-keyring-"));
  let api = NEG ? null : startApi(conn, keyring);
  const ownDb = db;

  try {
    if (!NEG) {
    ok("fake up", await waitUp(FAKE + "/__health", 30));
    ok("pg api up", await waitUp(API + "/health", 150));
    const be = await get("/api/backend");
    ok("backend postgres mode", be.json && be.json.mode === "postgres", JSON.stringify(be.json));
    const board = await post("/api/boards", { name: "PG HTTP Board" });
    ok("board created", board.status === 201, board.status);
    const bid = board.json.id;
    const q = await post("/api/roster/quick", { accountId: "00000000-0000-0000-0000-000000000001", name: "PG HTTP Advisor", description: "Persistent advisor with sufficient text." });
    const rid = q.json.id;
    const fd = new FormData();
    fd.append("file", new Blob([PNG], { type: "image/png" }), "p.png");
    const upj = await post(`/api/roster/${rid}/image/upload`, fd);
    ok("portrait accepted on PG", (await post(`/api/images/${upj.json.id}/review`, { decision: "accept" })).status === 200);
    const a = await post(`/api/boards/${bid}/advisors`, { rosterEntryId: rid, boardRole: "PG Seat" });
    ok("attached on PG", a.status === 201, a.status);
    const aid = a.json.id;
    ok("approved on PG", (await post(`/api/boards/${bid}/advisors/${aid}/approve`, {})).status === 200);
    const chat = await post(`/api/roster/${rid}/chat`, { message: "persist me" });
    ok("roster chat on PG", chat.status === 200 && chat.json.rosterId === rid, chat.status);
    // kill + restart with fresh-instance proof (direct DLL child PID): the old
    // process must exit AND its port must close before the new instance boots;
    // a healthy URL alone is not accepted as restart proof.
    const oldPid = api.pid;
    api.kill();
    const oldExited = await waitExit(api, 30);
    ok("old pg api exited", oldExited, "old pid " + oldPid);
    const portClosed = await waitPortClosed(15973, 30);
    ok("old pg api port closed", portClosed, "port 15973 still serving");
    api = startApi(conn, keyring);
    const newPid = api.pid;
    ok("pg api restarted as new instance", !!newPid && newPid !== oldPid, `old=${oldPid} new=${newPid}`);
    ok("restarted instance healthy", await waitUp(API + "/health", 150));
    const list = await get(`/api/boards/${bid}/advisors`);
    const row = (list.json || []).find((x) => x.id === aid);
    ok("link + canonical projection survive restart", row && row.rosterName === "PG HTTP Advisor" && row.stale === false, JSON.stringify(row).slice(0, 200));
    const chat2 = await post(`/api/roster/${rid}/chat`, { message: "again" });
    ok("chat works after restart", chat2.status === 200, chat2.status);
    const bk = await get("/api/backup");
    const snap = JSON.parse(bk.json.snapshot);
    ok("backup on PG", snap.version === 4 && snap.advisors.some((x) => x.Id === aid), snap.advisors.length);
    const rs = await post("/api/backup/restore", { snapshot: bk.json.snapshot, hash: bk.json.hash }, { timeout: 120000 });
    ok("restore roundtrip on PG", rs.status === 200, rs.status + " " + rs.text.slice(0, 160));
    const plan = await post("/api/admin/roster-reconcile/plan", { idempotencyKey: "pg-http" });
    ok("reconcile clean on PG", plan.status === 200 && (plan.json.orphans || []).length === 0, JSON.stringify((plan.json.orphans || []).map((o) => o.reason)));
    await put(`/api/roster/${rid}`, { description: "PG mutation-after-plan bump with sufficient text." });
    const planM = await post("/api/admin/roster-reconcile/plan", { idempotencyKey: "pg-mut" });
    await put(`/api/roster/${rid}`, { description: "PG second mutation invalidating reviewed plan text here." });
    const staleA = await post("/api/admin/roster-reconcile/apply", { idempotencyKey: "pg-mut", planHash: planM.json.planHash });
    ok("mutated PG plan refused with fresh hash", staleA.status === 409 && staleA.json && staleA.json.freshPlanHash && staleA.json.freshPlanHash !== planM.json.planHash, staleA.status);
    const freshA = await post("/api/admin/roster-reconcile/apply", { idempotencyKey: "pg-mut", planHash: staleA.json.freshPlanHash });
    ok("fresh PG plan applies after re-review", freshA.status === 200 && (freshA.json.applied || []).some((s) => s.startsWith("repin:")), freshA.status);
    const replayPG = await post("/api/admin/roster-reconcile/apply", { idempotencyKey: "pg-mut", planHash: staleA.json.freshPlanHash });
    ok("PG idempotent replay no-op", replayPG.status === 200 && (replayPG.json.applied || []).length === 0, replayPG.status);
    const regA = await post("/api/auth/register", { email: "admin@x.test", password: "0123456789ab" });
    ok("PG admin registered", regA.status === 200 || regA.status === 201, regA.status);
    const loginA = await post("/api/auth/login", { email: "admin@x.test", password: "0123456789ab" });
    const tokA = loginA.json && loginA.json.token;
    const secPlan = await fetch(API + "/api/admin/roster-reconcile/plan", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tokA }, body: JSON.stringify({ idempotencyKey: "pg-sec" }) }).then(async (r) => ({ status: r.status }));
    ok("PG secure admin may reconcile", secPlan.status === 200, secPlan.status);
    const regB = await post("/api/auth/register", { email: "bob@x.test", password: "0123456789ab" });
    const loginB = await post("/api/auth/login", { email: "bob@x.test", password: "0123456789ab" });
    const tokB = loginB.json && loginB.json.token;
    const secPlanB = await fetch(API + "/api/admin/roster-reconcile/plan", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tokB }, body: JSON.stringify({ idempotencyKey: "pg-sec" }) }).then(async (r) => ({ status: r.status }));
    ok("PG secure non-admin denied reconcile", secPlanB.status === 403, secPlanB.status);
    } else {
      console.log("  negative-path probe (no services spawned): " + NEG);
    }
  } finally {
    try { api.kill(); } catch {}
    try { fake.kill(); } catch {}
    await sleep(2000);
    const keyringRemoved = rmDirVerified(keyring, "roster-pgqa-keyring-");
    if (NEG === "keyring-fail") { fs.rmSync = _realRmSync; rmDirVerified(keyring, "roster-pgqa-keyring-"); }
    if (!keyringRemoved) { fail++; bad.push("cleanup: owned temp keyring removal failed: " + keyring); }
    try { if (ownDb) { psql(`DROP DATABASE "${ownDb}"`); console.log("  dropped=" + ownDb); } } catch (e) { fail++; bad.push("cleanup: owned db drop failed: " + ownDb + " :: " + (e && e.message || e)); }
  }
  console.log(fail === 0 ? `\nPASS roster-pg-qa (${pass} checks)` : `\nFAIL roster-pg-qa (${fail})\n` + bad.join("\n"));
  process.exit(fail === 0 ? 0 : 1);
}
try { await main(); } catch (e) { console.log("  FAIL harness :: " + (e && e.stack || e)); process.exit(1); }
