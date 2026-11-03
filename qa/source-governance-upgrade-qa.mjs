import crypto from "node:crypto";
import { spawn, execSync, execFileSync } from "node:child_process";
import fs from "fs";
const API = "http://127.0.0.1:5095";
const FAKE_PORT = 5195;
const OUT = ".tmp/source-governance-upgrade-result.txt";
fs.mkdirSync(".tmp", { recursive: true });
fs.writeFileSync(OUT, "START upgrade " + new Date().toISOString() + "\n");
let pass = 0, fail = 0; const failures = [];
function ok(n, c, e) { if (c) { pass++; fs.appendFileSync(OUT, "PASS " + n + "\n"); } else { fail++; failures.push(n + (e ? " :: " + e : "")); fs.appendFileSync(OUT, "FAIL " + n + (e ? " :: " + e : "") + "\n"); console.log("FAIL " + n + (e ? " :: " + e : "")); } }
async function req(m, p, b, o = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), o.timeout || 20000);
  try { const r = await fetch(API + p, { method: m, signal: ctl.signal, headers: { "content-type": "application/json", "x-user": "owner" }, body: b === undefined ? undefined : JSON.stringify(b) }); const tx = await r.text(); let js = null; try { js = tx ? JSON.parse(tx) : null; } catch { } return { status: r.status, json: js, text: tx }; } finally { clearTimeout(t); }
}
const get = (p, o) => req("GET", p, undefined, o);
const post = (p, b, o) => req("POST", p, b, o);
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitHealth(t) { const t0 = Date.now(); while (Date.now() - t0 < t) { try { const r = await fetch(API + "/health", { signal: AbortSignal.timeout(3000) }); if (r.ok) return true; } catch { } await sleep(500); } return false; }
function startApi(dll, db, log, instance) {
  const env = { META_API_KEY: "dummy", META_API_BASE: "http://127.0.0.1:" + FAKE_PORT, HINDSIGHT_URL: "", ASPNETCORE_URLS: API, USE_POSTGRES: "1", CONNECTIONSTRINGS__APP: "Host=127.0.0.1;Port=15435;Database=" + db + ";Username=simceo;Password=simceo-dev-only", SIMCEO_INSTANCE: instance };
  const out = fs.openSync(log, "w");
  return spawn("dotnet", [dll], { env: { ...process.env, ...env }, stdio: ["ignore", out, out] });
}
async function stopProc(p, label) {
  if (!p) return true;
  try { p.kill(); } catch { }
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) { if (p.exitCode !== null || p.signalCode !== null) return true; await sleep(250); }
  ok("proc-stop-" + label, false, "owned process did not exit; leaving for owner inspection (no blind kill)");
  return false;
}
function sh(cmd) { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
// 0. resolve 94d read-only (no checkout, no mutation)
let sha = "";
try { sha = sh("git rev-parse --verify 94d5ce0").trim(); } catch (e) { ok("old-sha", false, String(e).slice(0, 200)); }
ok("old-sha", /^[0-9a-f]{40}$/.test(sha), sha);
fs.appendFileSync(OUT, "OLD_SHA " + sha + "\n");
// 1. archive 94d server sources to OWN tmp (read-only git)
try {
  if (fs.existsSync(".tmp/old94d")) fs.rmSync(".tmp/old94d", { recursive: true, force: true });
  fs.mkdirSync(".tmp/old94d", { recursive: true });
  sh("git archive 94d5ce0 server/SimCEO.Api server/SimCEO.Postgres -o .tmp/old94d.tar");
  sh("tar -xf .tmp/old94d.tar -C .tmp/old94d");
  ok("archive-extract", fs.existsSync(".tmp/old94d/server/SimCEO.Api/SimCEO.Api.csproj"), "missing csproj");
} catch (e) { ok("archive-extract", false, String(e).slice(0, 300)); }
// 2. build OLD api
try {
  sh("dotnet build .tmp/old94d/server/SimCEO.Api/SimCEO.Api.csproj -v q --nologo");
  ok("old-build", fs.existsSync(".tmp/old94d/server/SimCEO.Api/bin/Debug/net10.0/SimCEO.Api.dll"), "no old dll");
} catch (e) { ok("old-build", false, String(e).slice(0, 500)); }
// 3. fresh disposable DB in OWN container
const DB = "sgqa_up94d";
try { sh("docker exec simceo-source-qa-pg psql -U simceo -d postgres -c \"DROP DATABASE IF EXISTS " + DB + ";\""); } catch { }
try { sh("docker exec simceo-source-qa-pg psql -U simceo -d postgres -c \"CREATE DATABASE " + DB + ";\""); ok("up-db", true); } catch (e) { ok("up-db", false, String(e).slice(0, 200)); }
// 4. boot OLD api on OWN port
let oldApi = startApi(".tmp/old94d/server/SimCEO.Api/bin/Debug/net10.0/SimCEO.Api.dll", DB, ".tmp/sg-upgrade-old.log", "old94d");
ok("old-api-up", await waitHealth(60000), "old api did not come up");
{
  const b = await (await fetch(API + "/api/backend")).json();
  ok("old-backend-pg", (b.mode || b.Mode) === "postgres", JSON.stringify(b));
  const rv = await get("/api/boards/00000000-0000-0000-0000-000000000000/sources/review");
  ok("old-no-review-endpoint", rv.status === 404 || rv.status === 405, "status=" + rv.status);
}
// 5. seed legacy rows through OLD http (exact ids recorded)
const markA = "legacy upgrade body alpha " + crypto.randomUUID();
const markP = "legacy upgrade body pending " + crypto.randomUUID();
let b = await post("/api/boards", { name: "up94d-" + Date.now() });
const ubid = b.json.id; ok("up-board", b.status === 201 && !!ubid, b.status + " " + b.text.slice(0, 200));
let m = await post("/api/boards/" + ubid + "/meetings", { title: "up-m1" });
const umid = m.json.id; ok("up-meeting", !!umid, m.status + " " + m.text.slice(0, 200));
async function oldupload(fn, content) {
  const fd = new FormData(); fd.append("file", new Blob([content], { type: "text/plain" }), fn); fd.append("scope", "board");
  const r = await fetch(API + "/api/boards/" + ubid + "/sources/upload", { method: "POST", headers: { "x-user": "owner" }, body: fd });
  const tx = await r.text(); let js = null; try { js = JSON.parse(tx); } catch { } return { status: r.status, json: js, text: tx };
}
const ua = await oldupload("legacy-upgrade.txt", markA);
const usid = ua.json.id || ua.json.Id;
ok("up-upload-approved-candidate", ua.status === 201 && !!usid, ua.status + " " + ua.text.slice(0, 300));
const up2 = await oldupload("pending-upgrade.txt", markP);
const psid = up2.json.id || up2.json.Id;
ok("up-upload-pending", up2.status === 201 && !!psid, up2.status + " " + up2.text.slice(0, 300));
const ap = await post("/api/sources/" + usid + "/approve", {});
ok("up-old-approve", ap.status === 200 && (ap.json.approved === true || ap.json.Approved === true), ap.status + " " + ap.text.slice(0, 300));
fs.appendFileSync(OUT, "SEED board=" + ubid + " meeting=" + umid + " approvedSrc=" + usid + " pendingSrc=" + psid + "\n");
// 6. stop OLD api by exact owned handle; verify port freed
ok("old-stop", await stopProc(oldApi, "old-api"));
await sleep(2000);
ok("old-port-freed", !(await waitHealth(4000)), "port still answering after old stop");
// 7. boot NEW api on same DB
let api = startApi("server/SimCEO.Api/bin/Debug/net10.0/SimCEO.Api.dll", DB, ".tmp/sg-upgrade-api.log", "source-gov-qa");
ok("new-api-up", await waitHealth(60000), "new api did not come up");
{
  const h = await (await fetch(API + "/health")).json();
  ok("new-identity", (h.instance || h.Instance) === "source-gov-qa", JSON.stringify(h));
  const bk = await (await fetch(API + "/api/backend")).json();
  ok("new-backend-pg", (bk.mode || bk.Mode) === "postgres", JSON.stringify(bk));
}
if (pass > 0) {
  const g = await get("/api/boards/" + ubid + "/sources/review");
  ok("new-review-200", g.status === 200, g.status + " " + g.text.slice(0, 300));
  const famA = (g.json || []).find((x) => (x.familyKey || x.FamilyKey || "").includes("legacy-upgrade.txt"));
  const famP = (g.json || []).find((x) => (x.familyKey || x.FamilyKey || "").includes("pending-upgrade.txt"));
  ok("legacy-approved-preserved", !!famA && (famA.versions[0].reviewState || famA.versions[0].ReviewState) === "approved", JSON.stringify(famA).slice(0, 500));
  ok("legacy-family-backfilled", !!famA && ((famA.familyKey || famA.FamilyKey) || "").includes("legacy-upgrade.txt"), JSON.stringify(famA).slice(0, 200));
  ok("legacy-pending-stays-pending", !!famP && (famP.versions[0].reviewState || famP.versions[0].ReviewState) === "pending", JSON.stringify(famP).slice(0, 400));
  const ix0 = await get("/api/sources/" + usid + "/index");
  ok("legacy-not-eligible-until-index", ix0.status === 200 && (ix0.json.eligible === false || ix0.json.Eligible === false), JSON.stringify(ix0.json).slice(0, 300));
  const ri = await post("/api/sources/" + usid + "/reindex", {});
  ok("legacy-reindex-200", ri.status === 200, ri.status + " " + ri.text.slice(0, 300));
  const secs = await get("/api/sources/" + usid + "/sections");
  ok("legacy-sections", secs.status === 200 && secs.json.sections.length > 0 && secs.json.sections[0].text.includes("legacy upgrade body alpha"), JSON.stringify(secs.json).slice(0, 400));
  const ix1 = await get("/api/sources/" + usid + "/index");
  ok("legacy-eligible-after-index", ix1.status === 200 && (ix1.json.eligible === true || ix1.json.Eligible === true), JSON.stringify(ix1.json).slice(0, 300));
  const rc = await get("/api/boards/" + ubid + "/recall?q=legacy+upgrade+alpha&take=8");
  ok("legacy-recall-hit", JSON.stringify(rc.json).includes("legacy-upgrade.txt"), JSON.stringify(rc.json).slice(0, 400));
  const h0 = await get("/api/sources/" + usid + "/history");
  ok("legacy-history", h0.status === 200 && h0.json.length >= 1 && h0.json.some((e) => ((e.action || e.Action) || "").includes("reindex") && String(e.sourceId || e.SourceId) === String(usid)), JSON.stringify(h0.json).slice(0, 300));
  // head pinning on upgraded data: excluding current leaves no fallback
  const ex = await post("/api/sources/" + usid + "/exclude", {});
  ok("legacy-exclude", ex.status === 200, ex.status + " " + ex.text.slice(0, 200));
  const g2 = await get("/api/boards/" + ubid + "/sources/review");
  const famA2 = (g2.json || []).find((x) => (x.familyKey || x.FamilyKey || "").includes("legacy-upgrade.txt"));
  ok("legacy-exclude-no-fallback", !!famA2 && famA2.hasCurrent === false, JSON.stringify(famA2).slice(0, 300));
  await post("/api/sources/" + usid + "/restore", {});
  // restart NEW api, same DB
  ok("new-stop", await stopProc(api, "new-api-1"));
  await sleep(2500);
  api = startApi("server/SimCEO.Api/bin/Debug/net10.0/SimCEO.Api.dll", DB, ".tmp/sg-upgrade-api2.log", "source-gov-qa");
  ok("new-restart-up", await waitHealth(60000), "restart failed");
  if (api) {
    const s2 = await get("/api/sources/" + usid + "/sections");
    ok("upgrade-sections-survive-restart", s2.status === 200 && s2.json.sections.length === secs.json.sections.length && s2.json.sections[0].text === secs.json.sections[0].text, "len mismatch");
    const g3 = await get("/api/boards/" + ubid + "/sources/review");
    const famA3 = (g3.json || []).find((x) => (x.familyKey || x.FamilyKey || "").includes("legacy-upgrade.txt"));
    ok("upgrade-current-survives-restart", !!famA3 && famA3.hasCurrent === true, JSON.stringify(famA3).slice(0, 300));
  }
}
fs.appendFileSync(OUT, "DONE pass=" + pass + " fail=" + fail + " failures=" + JSON.stringify(failures) + "\n");
try { await stopProc(api, "final"); } catch { }
try { await stopProc(oldApi, "old-final"); } catch { }
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 500);