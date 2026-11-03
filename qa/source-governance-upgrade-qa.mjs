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
} // 5. seed legacy rows through OLD http: TWO approved versions of one family plus one pending file; exact ids, bodies, client-side hashes recorded
const markA1 = "legacy upgrade body v1 " + crypto.randomUUID();
const markA2 = "legacy upgrade body alpha v2 " + crypto.randomUUID();
const markP = "legacy upgrade body pending " + crypto.randomUUID();
const hashOf = (t) => crypto.createHash("sha256").update(t, "utf8").digest("hex");
let b = await post("/api/boards", { name: "up94d-" + Date.now() });
const ubid = b.json.id; ok("up-board", b.status === 201 && !!ubid, b.status + " " + b.text.slice(0, 200));
let m = await post("/api/boards/" + ubid + "/meetings", { title: "up-m1" });
const umid = m.json.id; ok("up-meeting", !!umid, m.status + " " + m.text.slice(0, 200));
async function oldupload(fn, content) {
  const fd = new FormData(); fd.append("file", new Blob([content], { type: "text/plain" }), fn); fd.append("scope", "board");
  const r = await fetch(API + "/api/boards/" + ubid + "/sources/upload", { method: "POST", headers: { "x-user": "owner" }, body: fd });
  const tx = await r.text(); let js = null; try { js = JSON.parse(tx); } catch { } return { status: r.status, json: js, text: tx };
}
const ua1 = await oldupload("legacy-upgrade.txt", markA1);
const usid1 = ua1.json.id || ua1.json.Id;
ok("up-upload-v1", ua1.status === 201 && !!usid1, ua1.status + " " + ua1.text.slice(0, 300));
const ua2 = await oldupload("legacy-upgrade.txt", markA2);
const usid2 = ua2.json.id || ua2.json.Id;
ok("up-upload-v2", ua2.status === 201 && !!usid2, ua2.status + " " + ua2.text.slice(0, 300));
ok("up-versions-12", (ua1.json.version ?? ua1.json.Version) === 1 && (ua2.json.version ?? ua2.json.Version) === 2, JSON.stringify([ua1.json.version, ua2.json.version]));
const up2 = await oldupload("pending-upgrade.txt", markP);
const psid = up2.json.id || up2.json.Id;
ok("up-upload-pending", up2.status === 201 && !!psid, up2.status + " " + up2.text.slice(0, 300));
const ap1 = await post("/api/sources/" + usid1 + "/approve", {});
ok("up-old-approve-v1", ap1.status === 200 && (ap1.json.approved === true || ap1.json.Approved === true), ap1.status + " " + ap1.text.slice(0, 300));
const ap2 = await post("/api/sources/" + usid2 + "/approve", {});
ok("up-old-approve-v2", ap2.status === 200 && (ap2.json.approved === true || ap2.json.Approved === true), ap2.status + " " + ap2.text.slice(0, 300));
fs.appendFileSync(OUT, "SEED board=" + ubid + " meeting=" + umid + " v1=" + usid1 + " v2=" + usid2 + " pendingSrc=" + psid + "\n");
// 5b. colliding legacy shapes through OLD http (predecessor-produced): the
// old inline endpoint always assigns version 1 with no family keys, so two
// same-name inline creates plus a path-prefixed twin are three v1 rows that
// canonicalize to ONE family. Distinct CreatedAt (spaced writes) makes the
// deterministic order exact: earliest keeps v1, later dups move above max.
async function oldinline(fn, content) {
  const r = await post("/api/boards/" + ubid + "/sources", { fileName: fn, contentHash: hashOf(content), origin: "upload", scope: "board", extractionJson: "{}" });
  const js = r.json || {};
  return { status: r.status, id: js.id || js.Id, text: r.text };
}
const markC1 = "collision body first " + crypto.randomUUID();
const markC2 = "collision body second " + crypto.randomUUID();
const markC3 = "collision body path twin " + crypto.randomUUID();
const ci1 = await oldinline("collision.txt", markC1);
ok("up-collide-inline-1", ci1.status === 201 && !!ci1.id, ci1.status + " " + (ci1.text || "").slice(0, 200));
await sleep(150);
const ci2 = await oldinline("collision.txt", markC2);
ok("up-collide-inline-2", ci2.status === 201 && !!ci2.id && ci2.id !== ci1.id, ci2.status + " " + (ci2.text || "").slice(0, 200));
await sleep(150);
const ci3 = await oldinline("docs/collision.txt", markC3);
ok("up-collide-inline-path", ci3.status === 201 && !!ci3.id, ci3.status + " " + (ci3.text || "").slice(0, 200));
fs.appendFileSync(OUT, "SEED-COLLIDE c1=" + ci1.id + " c2=" + ci2.id + " c3=" + ci3.id + "\n");
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
// 8. exact multi-version migration proof (replaces the old single-row block)
if (pass > 0) {
  // Direct reindex of BOTH legacy approved rows BEFORE any migration-
  // triggering GET (no /review, /sources, /context, /recall first). The
  // startup bootstrap must already have established the deterministic head;
  // reindex order (v1 first) must not affect head selection.
  const ri1 = await post("/api/sources/" + usid1 + "/reindex", {});
  ok("legacy-reindex-v1-first-200", ri1.status === 200, ri1.status + " " + ri1.text.slice(0, 300));
  const ri2 = await post("/api/sources/" + usid2 + "/reindex", {});
  ok("legacy-reindex-v2-200", ri2.status === 200, ri2.status + " " + ri2.text.slice(0, 300));
  const rip = await post("/api/sources/" + psid + "/reindex", {});
  ok("legacy-reindex-pending-200", rip.status === 200, rip.status + " " + rip.text.slice(0, 300));
  const g = await get("/api/boards/" + ubid + "/sources/review");
  ok("new-review-200", g.status === 200, g.status + " " + g.text.slice(0, 300));
  const famA = (g.json || []).find((x) => ((x.familyKey || x.FamilyKey) || "").includes("legacy-upgrade.txt"));
  const famP = (g.json || []).find((x) => ((x.familyKey || x.FamilyKey) || "").includes("pending-upgrade.txt"));
  ok("legacy-two-versions", !!famA && famA.versions.length === 2, "versions=" + (famA ? famA.versions.length : "none"));
  const vrow = (id) => famA.versions.find((x) => String(x.id || x.Id).toLowerCase() === String(id).toLowerCase());
  const r1 = vrow(usid1), r2 = vrow(usid2);
  ok("legacy-ids-exact", !!r1 && !!r2, "rows=" + JSON.stringify((famA.versions || []).map((x) => x.id || x.Id)));
  ok("legacy-versions-1-2", (r1.version ?? r1.Version) === 1 && (r2.version ?? r2.Version) === 2, JSON.stringify([r1.version, r2.version]));
  ok("legacy-approved-both", (r1.reviewState || r1.ReviewState) === "approved" && (r2.reviewState || r2.ReviewState) === "approved", JSON.stringify([r1.reviewState, r2.reviewState]));
  ok("legacy-head-is-v2", String(famA.currentId || famA.CurrentId).toLowerCase() === String(usid2).toLowerCase(), "currentId=" + (famA.currentId || famA.CurrentId));

  // Collision migration: three legacy v1 rows canonicalize to one family
  // with deterministic versions 1,2,3 in creation order; every document,
  // hash, and history row survives; unique indexes now enforce identity.
  const gC = await get("/api/boards/" + ubid + "/sources/review");
  const famC = (gC.json || []).find((x) => ((x.familyKey || x.FamilyKey) || "").includes("collision.txt"));
  ok("collide-family-one", !!famC, JSON.stringify((gC.json || []).map((x) => x.familyKey || x.FamilyKey)).slice(0, 300));
  const cvers = (famC ? famC.versions || famC.Versions || [] : []).slice().sort((a, b2) => (a.version ?? a.Version) - (b2.version ?? b2.Version));
  ok("collide-versions-123", cvers.length === 3 && (cvers[0].version ?? cvers[0].Version) === 1 && (cvers[1].version ?? cvers[1].Version) === 2 && (cvers[2].version ?? cvers[2].Version) === 3,
    JSON.stringify(cvers.map((x) => [x.id || x.Id, x.version ?? x.Version])).slice(0, 300));
  ok("collide-order-creation", String(cvers[0].id || cvers[0].Id).toLowerCase() === String(ci1.id).toLowerCase()
    && String(cvers[1].id || cvers[1].Id).toLowerCase() === String(ci2.id).toLowerCase()
    && String(cvers[2].id || cvers[2].Id).toLowerCase() === String(ci3.id).toLowerCase(),
    JSON.stringify(cvers.map((x) => x.id || x.Id)).slice(0, 300));
  const chash = cvers.map((x) => x.contentHash || x.ContentHash).sort();
  ok("collide-hashes-preserved", JSON.stringify(chash) === JSON.stringify([hashOf(markC1), hashOf(markC2), hashOf(markC3)].sort()),
    JSON.stringify(chash).slice(0, 300));
  const hc = await get("/api/sources/" + ci2.id + "/history");
  ok("collide-migrate-event", hc.status === 200 && (hc.json || []).some((e) => (e.action || e.Action) === "migrate-version"),
    JSON.stringify(hc.json).slice(0, 300));
  try {
    const ix = sh("docker exec simceo-source-qa-pg psql -U simceo -d " + DB + " -tAc \"SELECT indexname FROM pg_indexes WHERE tablename='Sources' AND indexname='UX_Sources_FamilyVersion'\"").trim();
    ok("collide-unique-index-sources", ix === "UX_Sources_FamilyVersion", ix);
    const ixh = sh("docker exec simceo-source-qa-pg psql -U simceo -d " + DB + " -tAc \"SELECT indexname FROM pg_indexes WHERE tablename='SourceHeads' AND indexname='UX_SourceHeads_Family'\"").trim();
    ok("collide-unique-index-heads", ixh === "UX_SourceHeads_Family", ixh);
  } catch (e) { ok("collide-unique-index-check", false, String(e).slice(0, 300)); }
  ok("legacy-v2-is-current", (r2.isCurrent ?? r2.IsCurrent) === true && (r1.isCurrent ?? r1.IsCurrent) === false, "v1current=" + (r1.isCurrent ?? r1.IsCurrent) + " v2current=" + (r2.isCurrent ?? r2.IsCurrent));
  ok("legacy-pending-stays-pending", !!famP && (famP.versions[0].reviewState || famP.versions[0].ReviewState) === "pending", JSON.stringify(famP).slice(0, 400));
  // Exact bodies, hashes, generations for both versions.
  const s1 = await get("/api/sources/" + usid1 + "/sections");
  const s2 = await get("/api/sources/" + usid2 + "/sections");
  const t1 = (s1.json.sections || []).map((x) => x.text ?? x.Text ?? "").join("");
  const t2 = (s2.json.sections || []).map((x) => x.text ?? x.Text ?? "").join("");
  ok("legacy-v1-body-exact", s1.status === 200 && t1 === markA1, "got=" + t1.slice(0, 120));
  ok("legacy-v2-body-exact", s2.status === 200 && t2 === markA2, "got=" + t2.slice(0, 120));
  ok("legacy-v1-hash-exact", (s1.json.contentHash || s1.json.ContentHash) === hashOf(markA1), "got=" + (s1.json.contentHash || s1.json.ContentHash));
  ok("legacy-v2-hash-exact", (s2.json.contentHash || s2.json.ContentHash) === hashOf(markA2), "got=" + (s2.json.contentHash || s2.json.ContentHash));
  ok("legacy-gen-1", (s1.json.indexGeneration ?? s1.json.IndexGeneration) === 1 && (s2.json.indexGeneration ?? s2.json.IndexGeneration) === 1, JSON.stringify([s1.json.indexGeneration, s2.json.indexGeneration]));
  const sp = await get("/api/sources/" + psid + "/sections");
  const tp = (sp.json.sections || []).map((x) => x.text ?? x.Text ?? "").join("");
  ok("legacy-pending-body-exact", sp.status === 200 && tp === markP, "got=" + tp.slice(0, 120));
  // Eligibility: v2 (head) eligible; v1 (superseded, same family) not —
  // no shared eligibility across versions; pending file not eligible.
  const ix2 = await get("/api/sources/" + usid2 + "/index");
  ok("legacy-v2-eligible", ix2.status === 200 && (ix2.json.eligible === true || ix2.json.Eligible === true), JSON.stringify(ix2.json).slice(0, 300));
  const ix1 = await get("/api/sources/" + usid1 + "/index");
  ok("legacy-v1-superseded-ineligible", ix1.status === 200 && (ix1.json.eligible === false || ix1.json.Eligible === false), JSON.stringify(ix1.json).slice(0, 300));
  const ixp = await get("/api/sources/" + psid + "/index");
  ok("legacy-pending-ineligible", ixp.status === 200 && (ixp.json.eligible === false || ixp.json.Eligible === false), JSON.stringify(ixp.json).slice(0, 300));
  // Recall proves head selection: v2 text hits, v1 text and pending absent.
  const rc = await get("/api/boards/" + ubid + "/recall?q=legacy+upgrade&take=8");
  const rcText = JSON.stringify(rc.json);
  ok("legacy-recall-v2-hit", rc.status === 200 && rcText.includes(markA2) && rcText.includes("legacy-upgrade.txt"), rcText.slice(0, 400));
  ok("legacy-recall-v1-absent", !rcText.includes(markA1), rcText.slice(0, 400));
  ok("legacy-recall-pending-absent", !rcText.includes(markP), rcText.slice(0, 400));
  const h0 = await get("/api/sources/" + usid2 + "/history");
  ok("legacy-history", h0.status === 200 && h0.json.length >= 1 && h0.json.some((e) => ((e.action || e.Action) || "").includes("reindex") && String(e.sourceId || e.SourceId) === String(usid2)), JSON.stringify(h0.json).slice(0, 300));
  // Head pinning on upgraded data: excluding the current head leaves no
  // fallback to the older approved version; restore revives exactly v2.
  const ex = await post("/api/sources/" + usid2 + "/exclude", {});
  ok("legacy-exclude", ex.status === 200, ex.status + " " + ex.text.slice(0, 200));
  const g2 = await get("/api/boards/" + ubid + "/sources/review");
  const famA2 = (g2.json || []).find((x) => ((x.familyKey || x.FamilyKey) || "").includes("legacy-upgrade.txt"));
  ok("legacy-exclude-no-fallback", !!famA2 && famA2.hasCurrent === false, JSON.stringify(famA2).slice(0, 300));
  const rcx = await get("/api/boards/" + ubid + "/recall?q=legacy+upgrade&take=8");
  ok("legacy-exclude-recall-gone", !JSON.stringify(rcx.json).includes(markA2), JSON.stringify(rcx.json).slice(0, 400));
  await post("/api/sources/" + usid2 + "/restore", {});
  const g2b = await get("/api/boards/" + ubid + "/sources/review");
  const famA2b = (g2b.json || []).find((x) => ((x.familyKey || x.FamilyKey) || "").includes("legacy-upgrade.txt"));
  ok("legacy-restore-current-v2", !!famA2b && String(famA2b.currentId || famA2b.CurrentId).toLowerCase() === String(usid2).toLowerCase(), JSON.stringify(famA2b).slice(0, 300));
  // restart NEW api, same DB: exact sections, hashes, head survive.
  ok("new-stop", await stopProc(api, "new-api-1"));
  await sleep(2500);
  api = startApi("server/SimCEO.Api/bin/Debug/net10.0/SimCEO.Api.dll", DB, ".tmp/sg-upgrade-api2.log", "source-gov-qa");
  ok("new-restart-up", await waitHealth(60000), "restart failed");
  if (api) {
    const s2b = await get("/api/sources/" + usid2 + "/sections");
    const t2b = (s2b.json.sections || []).map((x) => x.text ?? x.Text ?? "").join("");
    ok("upgrade-sections-survive-restart", s2b.status === 200 && t2b === markA2, "got=" + t2b.slice(0, 120));
    ok("upgrade-hash-survives-restart", (s2b.json.contentHash || s2b.json.ContentHash) === hashOf(markA2), "got=" + (s2b.json.contentHash || s2b.json.ContentHash));
    const g3 = await get("/api/boards/" + ubid + "/sources/review");
    const famA3 = (g3.json || []).find((x) => ((x.familyKey || x.FamilyKey) || "").includes("legacy-upgrade.txt"));
    const g4 = await get("/api/boards/" + ubid + "/sources/review");
    const famC4 = (g4.json || []).find((x) => ((x.familyKey || x.FamilyKey) || "").includes("collision.txt"));
    const cvers4 = (famC4 ? famC4.versions || famC4.Versions || [] : []).map((x) => x.version ?? x.Version).sort();
    ok("collide-survives-restart", !!famC4 && JSON.stringify(cvers4) === "[1,2,3]", JSON.stringify(cvers4));
    ok("upgrade-current-survives-restart", !!famA3 && String(famA3.currentId || famA3.CurrentId).toLowerCase() === String(usid2).toLowerCase() && famA3.hasCurrent === true, JSON.stringify(famA3).slice(0, 300));
    const ixb = await get("/api/sources/" + usid2 + "/index");
    ok("upgrade-eligible-survives-restart", ixb.status === 200 && (ixb.json.eligible === true || ixb.json.Eligible === true), JSON.stringify(ixb.json).slice(0, 300));
  }
}
// removal of the current version fails closed: dropping usid2 (and its
// head) while approved v1 survives is not a state the feature can create,
// so restore rejects 422 with zero state change; v2 stays current. A
// restart retains the exact pre-removal graph.
{
  const bk = await get("/api/backup");
  const mkNoV2 = () => {
    const snap = JSON.parse(bk.json.snapshot);
    const strip = (arr) => (Array.isArray(arr) ? arr.filter((x) => x && String(x.id || x.Id).toLowerCase() !== String(usid2).toLowerCase()) : arr);
    const stripSrc = (arr) => (Array.isArray(arr) ? arr.filter((x) => x && String(x.sourceId || x.SourceId).toLowerCase() !== String(usid2).toLowerCase()) : arr);
    if (snap.sources) snap.sources = strip(snap.sources); else snap.Sources = strip(snap.Sources);
    if (snap.sections) snap.sections = stripSrc(snap.sections); else if (snap.Sections) snap.Sections = stripSrc(snap.Sections);
    if (snap.events) snap.events = stripSrc(snap.events); else if (snap.Events) snap.Events = stripSrc(snap.Events);
    const keepHead = (x) => x && !String(x.familyKey || x.FamilyKey || "").includes("legacy-upgrade.txt");
    if (snap.heads) snap.heads = snap.heads.filter(keepHead); else if (snap.Heads) snap.Heads = snap.Heads.filter(keepHead);
    return snap;
  };
  const noV2 = mkNoV2();
  const hNoV2 = crypto.createHash("sha256").update(JSON.stringify(noV2), "utf8").digest("hex");
  const rNoV2 = await post("/api/backup/restore", { snapshot: JSON.stringify(noV2), hash: hNoV2 });
  ok("up-removal-current-422", rNoV2.status === 422, rNoV2.status + " " + (rNoV2.text || "").slice(0, 300));
  const gR = await get("/api/boards/" + ubid + "/sources/review");
  const famR = (gR.json || []).find((x) => ((x.familyKey || x.FamilyKey) || "").includes("legacy-upgrade.txt"));
  ok("up-removal-still-v2", !!famR && String(famR.currentId || famR.CurrentId).toLowerCase() === String(usid2).toLowerCase()
    && (famR.versions || famR.Versions || []).length >= 2, JSON.stringify(famR).slice(0, 300));
  ok("up-removal-no-fallback", !!famR && (famR.versions || famR.Versions || []).every((x) => (x.version ?? x.Version) !== 1 || (x.isCurrent ?? x.IsCurrent) !== true),
    JSON.stringify((famR.versions || famR.Versions || []).map((x) => [x.version ?? x.Version, x.isCurrent ?? x.IsCurrent])));
  ok("up-removal-stop", await stopProc(api, "new-api-2"));
  await sleep(2500);
  api = startApi("server/SimCEO.Api/bin/Debug/net10.0/SimCEO.Api.dll", DB, ".tmp/sg-upgrade-api3.log", "source-gov-qa");
  ok("up-removal-restart-up", await waitHealth(60000), "restart failed");
  if (api) {
    const gR2 = await get("/api/boards/" + ubid + "/sources/review");
    const famR2 = (gR2.json || []).find((x) => ((x.familyKey || x.FamilyKey) || "").includes("legacy-upgrade.txt"));
    ok("up-removal-survives-restart", !!famR2 && String(famR2.currentId || famR2.CurrentId).toLowerCase() === String(usid2).toLowerCase()
      && (famR2.versions || famR2.Versions || []).length >= 2, JSON.stringify(famR2).slice(0, 300));
  }
}
fs.appendFileSync(OUT, "DONE pass=" + pass + " fail=" + fail + " failures=" + JSON.stringify(failures) + "\n");
try { await stopProc(api, "final"); } catch { }
try { await stopProc(oldApi, "old-final"); } catch { }
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 500);
