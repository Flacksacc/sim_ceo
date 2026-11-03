import crypto from "node:crypto";
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import fs from "fs";

const API = "http://127.0.0.1:5095";
const FAKE_PORT = 5195;
const HIND_PORT = 5198;
const EXT_PORT = 5194;
const INSTANCE = "source-gov-qa";
const OUT = ".tmp/source-governance-qa-result.txt";
const pgcs = (db) => "Host=127.0.0.1;Port=15435;Database=" + db + ";Username=simceo;Password=simceo-dev-only";
fs.mkdirSync(".tmp", { recursive: true });
fs.writeFileSync(OUT, "START " + new Date().toISOString() + "\n");

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; fs.appendFileSync(OUT, "PASS " + name + "\n"); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); fs.appendFileSync(OUT, "FAIL " + name + (extra ? " :: " + extra : "") + "\n"); console.log("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}
async function req(method, path, body, o = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), o.timeout || 20000);
  try {
    const r = await fetch(API + path, { method, signal: ctl.signal, headers: { "content-type": "application/json", "x-user": "owner", ...(o.headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const get = (p, o) => req("GET", p, undefined, o);
const post = (p, b, o) => req("POST", p, b, o);
const put = (p, b, o) => req("PUT", p, b, o);
const patch = (p, b, o) => req("PATCH", p, b, o);
async function upload(boardId, filename, content, scope, meetingId) {
  const fd = new FormData();
  fd.append("file", new Blob([content], { type: "text/plain" }), filename);
  if (scope) fd.append("scope", scope);
  if (meetingId) fd.append("meetingId", meetingId);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(API + "/api/boards/" + boardId + "/sources/upload", { method: "POST", signal: ctl.signal, headers: { "x-user": "owner" }, body: fd });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const sidOf = (u) => (u.json.id || u.json.Id);
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function stateIs(s) { const t = String(s == null ? "" : s).trim().toLowerCase(); const map = { awaitingbrief: "0", active: "1", yielded: "2", paused: "3", wrappingup: "4" }; for (let k = 1; k < arguments.length; k++) { const n = arguments[k]; if (t === n || t === map[n]) return true; } return false; }
async function waitHealth(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(API + "/health", { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch { }
    await sleep(500);
  }
  return false;
}
async function assertIdentity(expectMode, tag) {
  let inst = null, mode = null;
  try {
    const h = await (await fetch(API + "/health")).json();
    inst = h.instance || h.Instance || null;
    const b = await (await fetch(API + "/api/backend")).json();
    mode = b.mode || b.Mode || null;
  } catch (e) { ok(tag + "-identity-probe", false, String(e)); return false; }
  ok(tag + "-identity-instance", inst === INSTANCE, "instance=" + inst);
  ok(tag + "-identity-mode-" + expectMode, mode === expectMode, "mode=" + mode);
  return inst === INSTANCE && mode === expectMode;
}
function startProc(cmd, args, env, logFile) {
  const out = fs.openSync(logFile, "w");
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", out, out] });
  return p;
}
async function stopProc(p, label) {
  if (!p) return true;
  try { p.kill(); } catch { }
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (p.exitCode !== null || p.signalCode !== null) return true;
    await sleep(250);
  }
  ok("proc-stop-" + label, false, "process did not exit; leaving for owner inspection (no blind kill)");
  return false;
}
function readBody(rq) {
  return new Promise((resolve) => { let b = ""; rq.on("data", (c) => { b += c; }); rq.on("end", () => resolve(b)); });
}

// ---- owned hindsight stub (injectable source hits; default: unresolvable evil + benign note)
let hindInjected = null;
const hind = http.createServer(async (rq, rs) => {
  const u = new URL(rq.url || "/", "http://x");
  if (u.pathname === "/__inject" && rq.method === "POST") {
    try { hindInjected = JSON.parse(await readBody(rq)).hits ?? null; } catch { hindInjected = null; }
    rs.writeHead(200, { "content-type": "application/json" }); rs.end(JSON.stringify({ ok: true })); return;
  }
  if (u.pathname === "/search") {
    const hits = hindInjected ?? [
      { kind: "source", ref: crypto.randomUUID(), text: "evil external source claim", score: 999 },
      { kind: "note", ref: "ext-note-1", text: "public note about " + (u.searchParams.get("q") || ""), score: 1 },
    ];
    rs.writeHead(200, { "content-type": "application/json" }); rs.end(JSON.stringify(hits)); return;
  }
  rs.writeHead(404); rs.end();
});
async function hindInject(hits) {
  await fetch("http://127.0.0.1:" + HIND_PORT + "/__inject", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hits }) });
}

// ---- owned extractor stub (docling shape; flippable ok/fail for retry-loss tests)
let extMode = "ok";
const ext = http.createServer(async (rq, rs) => {
  const u = new URL(rq.url || "/", "http://x");
  if (u.pathname === "/__mode" && rq.method === "POST") {
    try { extMode = JSON.parse(await readBody(rq)).mode || "ok"; } catch { }
    rs.writeHead(200, { "content-type": "application/json" }); rs.end(JSON.stringify({ mode: extMode })); return;
  }
  if (u.pathname === "/v1/convert/file" && rq.method === "POST") {
    await readBody(rq);
    if (extMode !== "ok") { rs.writeHead(500, { "content-type": "application/json" }); rs.end(JSON.stringify({ error: "qa extractor failure" })); return; }
    rs.writeHead(200, { "content-type": "application/json" });
    rs.end(JSON.stringify({ md_content: "# Converted stub\n\nExtractor stub body for retry-loss probe." }));
    return;
  }
  rs.writeHead(404); rs.end();
});
async function extModeSet(tag, m) {
  const er = await fetch("http://127.0.0.1:" + EXT_PORT + "/__mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: m }) });
  const ej = await er.json().catch(() => null);
  ok(tag + "-ext-mode-" + m, er.status === 200 && ej && ej.mode === m, er.status + " " + JSON.stringify(ej));
}
async function listenChecked(server, port, label) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  }).catch((e) => { ok("port-free-" + label, false, String(e && e.message || e)); throw e; });
  ok("port-free-" + label, true);
}
await listenChecked(hind, HIND_PORT, "hind5198");
await listenChecked(ext, EXT_PORT, "ext5194");

let fake = startProc("node", ["qa/fake-provider.mjs", "--port", String(FAKE_PORT)], {}, ".tmp/sg-fake.log");
await sleep(1500);
async function startApi(pgDb, log) {
  const env = { META_API_KEY: "dummy-qa-key", META_API_BASE: "http://127.0.0.1:" + FAKE_PORT, HINDSIGHT_URL: "http://127.0.0.1:" + HIND_PORT, EXTRACTOR_URL: "http://127.0.0.1:" + EXT_PORT, SIMCEO_INSTANCE: INSTANCE, ASPNETCORE_URLS: API };
  if (pgDb) { env.USE_POSTGRES = "1"; env.CONNECTIONSTRINGS__APP = pgcs(pgDb); }
  const p = startProc("dotnet", ["server/SimCEO.Api/bin/Debug/net10.0/SimCEO.Api.dll"], env, log);
  const up = await waitHealth(30000);
  return { proc: p, up };
}
let api = await startApi(null, ".tmp/sg-api.log");
ok("mem-api-memory-up", api.up, "api did not come up (memory)");
if (!api.up) { fs.appendFileSync(OUT, "ABORT no api\nDONE pass=" + pass + " fail=" + fail + "\n"); hind.close(); ext.close(); try { fake.kill(); } catch { } process.exit(1); }
await suite("mem", "memory");
await stopProc(api.proc, "mem-api");
await sleep(2000);
try { execSync("docker exec simceo-source-qa-pg psql -U simceo -d postgres -c \"DROP DATABASE IF EXISTS sgqa_mainpg;\""); } catch (e) { ok("pg-drop", false, String(e).slice(0, 200)); }
try { execSync("docker exec simceo-source-qa-pg psql -U simceo -d postgres -c \"CREATE DATABASE sgqa_mainpg;\""); ok("pg-create", true); } catch (e) { ok("pg-create", false, String(e).slice(0, 200)); }
api = await startApi("sgqa_mainpg", ".tmp/sg-api-pg.log");
ok("pg-api-pg-up", api.up, "pg api did not come up");
if (!api.up) { fs.appendFileSync(OUT, "ABORT no pg api\nDONE pass=" + pass + " fail=" + fail + "\n"); hind.close(); ext.close(); try { fake.kill(); } catch { } process.exit(1); }
await suite("pg", "postgres");

async function suite(tag, expectMode) {
  if (!await assertIdentity(expectMode, tag)) { ok(tag + "-abort-identity", false, "backend identity mismatch"); return; }
  await extModeSet(tag, "ok");
  try { await fetch("http://127.0.0.1:" + HIND_PORT + "/__inject", { method: "POST", headers: { "content-type": "application/json" }, body: "{\"hits\":null}" }); } catch { }
// --- setup board + meetings ---
let r = await post("/api/boards", { name: "sg-qa-" + Date.now() });
ok(tag + "-board-create", r.status === 201 && r.json && r.json.id, r.status + " " + r.text.slice(0, 200));
const bid = r.json.id;
r = await post("/api/boards/" + bid + "/meetings", { title: "m1" });
const mid1 = r.json.id;
r = await post("/api/boards/" + bid + "/meetings", { title: "m2" });
const mid2 = r.json.id;
ok(tag + "-meetings-created", !!mid1 && !!mid2, JSON.stringify([mid1, mid2]));

// --- version promotion, head retention, supersede ---
const txt1 = "alpha evidence about solar arrays " + crypto.randomUUID();
let u = await upload(bid, "evidence.txt", txt1, "board");
ok(tag + "-upload-v1-pending", u.status === 201 && (u.json.reviewState === "pending" || u.json.ReviewState === "pending"), u.status + " " + u.text.slice(0, 300));
const v1 = sidOf(u);
let g = await get("/api/boards/" + bid + "/sources/review");
let fam = (g.json || []).find((x) => (x.familyKey || x.FamilyKey || "").includes("evidence.txt"));
ok(tag + "-review-group-v1", !!fam && fam.versions.length === 1, JSON.stringify(g.json).slice(0, 300));
r = await post("/api/sources/" + v1 + "/approve", {});
ok(tag + "-approve-v1", r.status === 200 && (r.json.reviewState === "approved" || r.json.ReviewState === "approved"), r.status + " " + r.text.slice(0, 300));
g = await get("/api/boards/" + bid + "/sources/review");
fam = (g.json || []).find((x) => (x.familyKey || x.FamilyKey || "").includes("evidence.txt"));
ok(tag + "-current-v1", !!fam && fam.hasCurrent === true, JSON.stringify(fam).slice(0, 400));
const txt2 = "beta evidence about solar arrays revised " + crypto.randomUUID();
u = await upload(bid, "Evidence.TXT", txt2, "board");
ok(tag + "-upload-v2-normalized-pending", u.status === 201, u.status + " " + u.text.slice(0, 300));
const v2 = sidOf(u);
ok(tag + "-v2-version-2", (u.json.version === 2 || u.json.Version === 2), JSON.stringify(u.json).slice(0, 300));
g = await get("/api/boards/" + bid + "/sources/review");
fam = (g.json || []).find((x) => (x.familyKey || x.FamilyKey || "").includes("evidence.txt"));
const curAfterV2 = fam.currentId || fam.CurrentId;
ok(tag + "-v2-pending-retains-v1", !!fam && String(curAfterV2).toLowerCase() === String(v1).toLowerCase(), JSON.stringify(fam).slice(0, 400));
r = await post("/api/sources/" + v2 + "/reject", {});
ok(tag + "-reject-v2", r.status === 200, r.status + " " + r.text.slice(0, 300));
g = await get("/api/boards/" + bid + "/sources/review");
fam = (g.json || []).find((x) => (x.familyKey || x.FamilyKey || "").includes("evidence.txt"));
const curAfterReject = fam.currentId || fam.CurrentId;
ok(tag + "-rejected-v2-retains-v1", String(curAfterReject).toLowerCase() === String(v1).toLowerCase(), JSON.stringify(fam).slice(0, 400));
const txt3 = "gamma evidence " + crypto.randomUUID();
u = await upload(bid, "evidence.txt", txt3, "board");
const v3 = sidOf(u);
r = await post("/api/sources/" + v3 + "/approve", {});
ok(tag + "-approve-v3-displaces", r.status === 200, r.status + " " + r.text.slice(0, 300));
g = await get("/api/boards/" + bid + "/sources/review");
fam = (g.json || []).find((x) => (x.familyKey || x.FamilyKey || "").includes("evidence.txt"));
const curAfterV3 = fam.currentId || fam.CurrentId;
ok(tag + "-v3-current", String(curAfterV3).toLowerCase() === String(v3).toLowerCase(), JSON.stringify(fam).slice(0, 400));
r = await post("/api/sources/" + v1 + "/approve", {});
ok(tag + "-old-head-superseded", r.status === 409, r.status + " " + r.text.slice(0, 300));
r = await post("/api/sources/" + v3 + "/exclude", {});
ok(tag + "-exclude-current", r.status === 200 || r.status === 201, r.status + " " + r.text.slice(0, 200));
g = await get("/api/boards/" + bid + "/sources/review");
fam = (g.json || []).find((x) => (x.familyKey || x.FamilyKey || "").includes("evidence.txt"));
ok(tag + "-excluded-no-fallback", !!fam && fam.hasCurrent === false, JSON.stringify(fam).slice(0, 400));
// No-fallback recall: NONE of the family version texts may leak (not just a substring pair).
let rec = await get("/api/boards/" + bid + "/recall?q=solar&take=8");
const recText = JSON.stringify(rec.json);
ok(tag + "-recall-excluded-absent-all-versions",
  rec.status === 200 && !recText.includes(txt1) && !recText.includes(txt2) && !recText.includes(txt3),
  recText.slice(0, 500));
r = await post("/api/sources/" + v3 + "/restore", {});
ok(tag + "-restore-current", r.status === 200, r.status + " " + r.text.slice(0, 200));
g = await get("/api/boards/" + bid + "/sources/review");
fam = (g.json || []).find((x) => (x.familyKey || x.FamilyKey || "").includes("evidence.txt"));
const curAfterRestore = fam.currentId || fam.CurrentId;
ok(tag + "-restore-current-again", String(curAfterRestore).toLowerCase() === String(v3).toLowerCase(), JSON.stringify(fam).slice(0, 400));
// --- review state machine via PATCH (rejected is terminal via edit) ---
const txtR = "patch sm probe " + crypto.randomUUID();
u = await upload(bid, "patchsm.txt", txtR, "board");
const vsm = sidOf(u);
r = await post("/api/sources/" + vsm + "/reject", {});
ok(tag + "-sm-reject", r.status === 200, r.status + " " + r.text.slice(0, 200));
r = await patch("/api/sources/" + vsm, { approved: true });
ok(tag + "-sm-rejected-approve-409", r.status === 409, r.status + " " + r.text.slice(0, 300));
r = await patch("/api/sources/" + vsm, { approved: false });
ok(tag + "-sm-rejected-unapprove-409", r.status === 409, r.status + " " + r.text.slice(0, 300));
g = await get("/api/boards/" + bid + "/sources/review");
fam = (g.json || []).find((x) => (x.familyKey || x.FamilyKey || "").includes("patchsm.txt"));
ok(tag + "-sm-still-rejected", !!fam && fam.versions[0].reviewState === "rejected", JSON.stringify(fam).slice(0, 300));
r = await patch("/api/sources/" + vsm, { excluded: true });
ok(tag + "-sm-rejected-exclude-ok", r.status === 200, r.status + " " + r.text.slice(0, 200));

// --- scope collision + identity pinning (P1 #2) ---
const txtA = "collision board text " + crypto.randomUUID();
u = await upload(bid, "same.txt", txtA, "board");
const vA = sidOf(u);
await post("/api/sources/" + vA + "/approve", {});
const txtB = "collision meeting text " + crypto.randomUUID();
u = await upload(bid, "same.txt", txtB, "meeting", mid1);
const vB = sidOf(u);
await post("/api/sources/" + vB + "/approve", {});
r = await patch("/api/sources/" + vA, { scope: "meeting", meetingId: mid1 });
ok(tag + "-scope-collision-409", r.status === 409, r.status + " " + r.text.slice(0, 400));
g = await get("/api/boards/" + bid + "/sources/review");
const famA = (g.json || []).find((x) => (x.familyKey || x.FamilyKey || "").includes("same.txt") && ((x.scope || x.Scope) === "board"));
const famB = (g.json || []).find((x) => (x.familyKey || x.FamilyKey || "").includes("same.txt") && ((x.scope || x.Scope) === "meeting"));
ok(tag + "-scope-families-intact", !!famA && !!famB && (famA.versions[0].reviewState || famA.versions[0].ReviewState) === "approved" && (famB.versions[0].reviewState || famB.versions[0].ReviewState) === "approved", JSON.stringify(g.json).slice(0, 600));
// scope edits are immutable (deny-and-upload): even an EMPTY destination
// family is denied 409 with an actionable message; approval stays put.
r = await patch("/api/sources/" + vA, { scope: "meeting", meetingId: mid2 });
ok(tag + "-scope-move-empty-denied-409", r.status === 409, r.status + " " + r.text.slice(0, 400));
ok(tag + "-scope-move-empty-actionable", (r.text || "").toLowerCase().includes("upload"), r.text.slice(0, 400));
g = await get("/api/boards/" + bid + "/sources/review");
const famA2 = (g.json || []).find((x) => (x.familyKey || x.FamilyKey || "").includes("same.txt") && ((x.scope || x.Scope) === "board"));
ok(tag + "-scope-board-family-still-approved", !!famA2 && (famA2.versions[0].reviewState || famA2.versions[0].ReviewState) === "approved", JSON.stringify(famA2 || null).slice(0, 400));
// deny-and-upload: the destination scope accepts the same file as a new v1 family.
u = await upload(bid, "same.txt", "collision destination text " + crypto.randomUUID(), "meeting", mid2);
ok(tag + "-scope-reupload-201", u.status === 201, u.status + " " + (u.text || "").slice(0, 200));
ok(tag + "-scope-reupload-v1", (u.json.version ?? u.json.Version) === 1, JSON.stringify(u.json).slice(0, 200));
g = await get("/api/boards/" + bid + "/sources/review");
const sameFams = (g.json || []).filter((x) => ((x.familyKey || x.FamilyKey) || "").includes("same.txt"));
ok(tag + "-scope-three-families", sameFams.length === 3, "families=" + sameFams.length);
// legacy tolerance: bare unparsable meetingId with no scope change is a 200 no-op.
r = await patch("/api/sources/" + vA, { meetingId: "not-a-guid" });
ok(tag + "-scope-bad-meetingid-ignored-200", r.status === 200, r.status + " " + r.text.slice(0, 200));

// --- meeting upload requires a chosen meeting (P2 #6) ---
{
  const fd = new FormData();
  fd.append("file", new Blob(["no meeting chosen"], { type: "text/plain" }), "nomeet.txt");
  fd.append("scope", "meeting");
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const rr = await fetch(API + "/api/boards/" + bid + "/sources/upload", { method: "POST", signal: ctl.signal, headers: { "x-user": "owner" }, body: fd });
    const tt = await rr.text();
    ok(tag + "-meeting-upload-without-meeting-400", rr.status === 400, rr.status + " " + tt.slice(0, 300));
  } finally { clearTimeout(t); }
}

// --- reindex keeps pending pending; reports real reviewUnchanged ---
const txtP = "pending reindex probe " + crypto.randomUUID();
u = await upload(bid, "pending-reindex.txt", txtP, "board");
const vp = sidOf(u);
let idx0 = await get("/api/sources/" + vp + "/index");
const gen0 = idx0.json.generation ?? idx0.json.Generation ?? 0;
r = await post("/api/sources/" + vp + "/reindex", {});
ok(tag + "-reindex-pending-stays-pending", r.status === 200 && ((r.json.doc && (r.json.doc.reviewState === "pending" || r.json.doc.ReviewState === "pending")) && (r.json.reviewUnchanged === true || r.json.ReviewUnchanged === true)), JSON.stringify(r.json).slice(0, 400));
let idx1 = await get("/api/sources/" + vp + "/index");
ok(tag + "-reindex-gen-inc", (idx1.json.generation ?? idx1.json.Generation ?? 0) > gen0, JSON.stringify(idx1.json).slice(0, 300));
let secs = await get("/api/sources/" + vp + "/sections");
ok(tag + "-sections-exact", secs.status === 200 && Array.isArray(secs.json.sections) && secs.json.sections.length > 0 && secs.json.sections[0].text.includes("pending reindex probe"), JSON.stringify(secs.json).slice(0, 500));

// --- inline creation: server-owned origin + server-computed hash (P2 #11) ---
const fakeRes = crypto.randomUUID();
r = await post("/api/boards/" + bid + "/sources", { fileName: "inline-spoof.txt", origin: "wiki", resourceId: fakeRes, contentHash: "spoof", extractionJson: "{\"status\":\"ok\",\"markdown\":\"# Inline\\n\\nInline body probe " + crypto.randomUUID() + "\",\"error\":null}" });
ok(tag + "-inline-create-201", r.status === 201, r.status + " " + r.text.slice(0, 300));
ok(tag + "-inline-origin-forced", (r.json.origin || r.json.Origin) === "upload", JSON.stringify(r.json).slice(0, 300));
ok(tag + "-inline-resource-cleared", (r.json.resourceId || r.json.ResourceId) == null, JSON.stringify(r.json).slice(0, 300));
ok(tag + "-inline-hash-server", (r.json.contentHash || r.json.ContentHash) !== "spoof" && ((r.json.contentHash || r.json.ContentHash) || "").length === 64, JSON.stringify(r.json).slice(0, 300));
const vInline = r.json.id || r.json.Id;
r = await put("/api/boards/" + bid + "/source-policy", { blockedTypes: "", mode: "wikiOnly" });
ok(tag + "-policy-wikiOnly", r.status === 200, r.status + " " + r.text.slice(0, 200));
let ix = await get("/api/sources/" + vInline + "/index");
ok(tag + "-inline-wikionly-ineligible", ix.status === 200 && (ix.json.eligible === false || ix.json.Eligible === false), JSON.stringify(ix.json).slice(0, 300));
u = await upload(bid, "blocked-by-policy.txt", "hello", "board");
ok(tag + "-wikionly-denies-upload", u.status === 415, u.status + " " + u.text.slice(0, 200));
r = await post("/api/boards/" + bid + "/sources", { fileName: "inline2.txt", extractionJson: "{}" });
ok(tag + "-wikionly-denies-inline", r.status === 415, r.status + " " + r.text.slice(0, 200));
r = await put("/api/boards/" + bid + "/source-policy", { blockedTypes: "exe", mode: "allowAll" });
ok(tag + "-policy-allowAll-exe", r.status === 200, r.status + " " + r.text.slice(0, 200));
u = await upload(bid, "evil.EXE", "mz", "board");
ok(tag + "-blocked-ext-case", u.status === 415, u.status + " " + u.text.slice(0, 200));
u = await upload(bid, "doc.pdf.exe", "mz2", "board");
ok(tag + "-blocked-double-ext", u.status === 415, u.status + " " + u.text.slice(0, 200));
r = await put("/api/boards/" + bid + "/source-policy", { blockedTypes: "", mode: "allowAll" });
ok(tag + "-policy-reset", r.status === 200, r.status + " " + r.text.slice(0, 200));
// --- retry eligibility loss pauses work (P2 #12), via owned extractor stub ---
await extModeSet(tag, "ok");
const txtR2 = "retry loss probe body " + crypto.randomUUID();
{
  const fd = new FormData();
  fd.append("file", new Blob([txtR2], { type: "text/plain" }), "paper.pdf");
  fd.append("scope", "board");
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  var upPdf = null;
  try {
    const rr = await fetch(API + "/api/boards/" + bid + "/sources/upload", { method: "POST", signal: ctl.signal, headers: { "x-user": "owner" }, body: fd });
    const tt = await rr.text(); let jj = null; try { jj = JSON.parse(tt); } catch { }
    upPdf = { status: rr.status, json: jj, text: tt };
  } finally { clearTimeout(t); }
}
ok(tag + "-retryLoss-upload-201", upPdf.status === 201, upPdf.status + " " + upPdf.text.slice(0, 300));
const vRL = upPdf.json.id || upPdf.json.Id;
r = await post("/api/sources/" + vRL + "/approve", {});
ok(tag + "-retryLoss-approve", r.status === 200, r.status + " " + r.text.slice(0, 300));
let rlIdx = await get("/api/sources/" + vRL + "/index");
ok(tag + "-retryLoss-eligible-before", rlIdx.status === 200 && (rlIdx.json.eligible === true || rlIdx.json.Eligible === true), JSON.stringify(rlIdx.json).slice(0, 300));
let rlRec = await get("/api/boards/" + bid + "/recall?q=Extractor+stub+body&take=8");
ok(tag + "-retryLoss-recall-hit", JSON.stringify(rlRec.json).includes("paper.pdf"), JSON.stringify(rlRec.json).slice(0, 400));
await post("/api/meetings/" + mid1, {});
await patch("/api/meetings/" + mid1, { brief: "retry loss brief" });
await post("/api/meetings/" + mid1 + "/resume", {});
let mtgs0 = await get("/api/boards/" + bid + "/meetings");
let mRL0 = (mtgs0.json || []).find((m) => (m.id || m.Id) === mid1);
const genRL0 = mRL0.generation ?? mRL0.Generation ?? 0;
await extModeSet(tag, "fail");
r = await post("/api/sources/" + vRL + "/retry", {});
ok(tag + "-retryLoss-retry-200", r.status === 200, r.status + " " + r.text.slice(0, 400));
ok(tag + "-retryLoss-reported", (r.json.eligibilityLost === true || r.json.EligibilityLost === true), JSON.stringify(r.json).slice(0, 400));
ok(tag + "-retryLoss-review-kept", (r.json.review || r.json.Review) === "approved" || ((r.json.doc || {}).reviewState || (r.json.doc || {}).ReviewState) === "approved", JSON.stringify(r.json).slice(0, 400));
let mtgs1 = await get("/api/boards/" + bid + "/meetings");
let mRL1 = (mtgs1.json || []).find((m) => (m.id || m.Id) === mid1);
const stRL1 = String(mRL1.state || mRL1.State || "");
const genRL1 = mRL1.generation ?? mRL1.Generation ?? 0;
ok(tag + "-retryLoss-paused", stateIs(stRL1, "paused"), "state=" + stRL1);
ok(tag + "-retryLoss-gen-inc", genRL1 > genRL0, genRL0 + "->" + genRL1);
let rlRec2 = await get("/api/boards/" + bid + "/recall?q=Extractor+stub+body&take=8");
ok(tag + "-retryLoss-recall-gone", !JSON.stringify(rlRec2.json).includes("paper.pdf"), JSON.stringify(rlRec2.json).slice(0, 400));
let rlIxFail = await get("/api/sources/" + vRL + "/index");
ok(tag + "-retryLoss-index-false", rlIxFail.status === 200 && (rlIxFail.json.eligible === false || rlIxFail.json.Eligible === false), JSON.stringify(rlIxFail.json).slice(0, 300));
await extModeSet(tag, "ok");
r = await post("/api/sources/" + vRL + "/reindex", {});
ok(tag + "-retryLoss-reindex-recovers", r.status === 200, r.status + " " + r.text.slice(0, 300));
let rlIxBack = await get("/api/sources/" + vRL + "/index");
ok(tag + "-retryLoss-index-true", rlIxBack.status === 200 && (rlIxBack.json.eligible === true || rlIxBack.json.Eligible === true), JSON.stringify(rlIxBack.json).slice(0, 300));
let rlRec3 = await get("/api/boards/" + bid + "/recall?q=Extractor+stub+body&take=8");
ok(tag + "-retryLoss-recall-back", JSON.stringify(rlRec3.json).includes("paper.pdf"), JSON.stringify(rlRec3.json).slice(0, 400));
// --- extractor-down upload never becomes completed raw-byte evidence ---
await extModeSet(tag, "fail");
{
  const fd = new FormData();
  fd.append("file", new Blob(["%PDF-1.4 printable binary-ish body " + crypto.randomUUID()], { type: "text/plain" }), "down.pdf");
  fd.append("scope", "board");
  const ctl = new AbortController(); const t2 = setTimeout(() => ctl.abort(), 20000);
  let upD = null;
  try {
    const rr = await fetch(API + "/api/boards/" + bid + "/sources/upload", { method: "POST", signal: ctl.signal, headers: { "x-user": "owner" }, body: fd });
    const tt = await rr.text(); let jj = null; try { jj = JSON.parse(tt); } catch { }
    upD = { status: rr.status, json: jj, text: tt };
  } finally { clearTimeout(t2); }
  // Fail closed: either the upload is rejected outright, or it lands
  // index-failed (never completed/eligible from raw bytes).
  const downFailed = upD.status !== 201 || ((upD.json.indexState || upD.json.IndexState || "").toLowerCase() === "failed");
  ok(tag + "-extdown-no-completed", upD.status === 500 || downFailed, upD.status + " " + (upD.text || "").slice(0, 300));
  if (upD.status === 201 && upD.json && (upD.json.id || upD.json.Id)) {
    const did = upD.json.id || upD.json.Id;
    const dIdx = await get("/api/sources/" + did + "/index");
    ok(tag + "-extdown-ineligible", dIdx.status === 200 && (dIdx.json.eligible === false || dIdx.json.Eligible === false), JSON.stringify(dIdx.json).slice(0, 300));
    const dSec = await get("/api/sources/" + did + "/sections");
    ok(tag + "-extdown-no-sections", dSec.status === 200 && (dSec.json.sections || dSec.json.Sections || []).length === 0, JSON.stringify(dSec.json).slice(0, 300));
  } else {
    ok(tag + "-extdown-ineligible", true);
    ok(tag + "-extdown-no-sections", true);
  }
}
await extModeSet(tag, "ok");

// --- meeting scoping: hit, miss, no board leak ---
const txtM = "meeting-only secret " + crypto.randomUUID();
u = await upload(bid, "meeting-note.txt", txtM, "meeting", mid1);
ok(tag + "-meeting-upload", u.status === 201, u.status + " " + u.text.slice(0, 300));
const vm = sidOf(u);
await post("/api/sources/" + vm + "/approve", {});
let recM1 = await get("/api/boards/" + bid + "/recall?q=meeting-only+secret&take=8&meetingId=" + mid1);
ok(tag + "-meeting-recall-hit", JSON.stringify(recM1.json).includes("meeting-note.txt"), JSON.stringify(recM1.json).slice(0, 400));
let recM2 = await get("/api/boards/" + bid + "/recall?q=meeting-only+secret&take=8&meetingId=" + mid2);
ok(tag + "-meeting-recall-scoped", !JSON.stringify(recM2.json).includes("meeting-note.txt"), JSON.stringify(recM2.json).slice(0, 400));
let recB = await get("/api/boards/" + bid + "/recall?q=meeting-only+secret&take=8");
ok(tag + "-board-recall-no-leak", !JSON.stringify(recB.json).includes("meeting-note.txt") && !JSON.stringify(recB.json).includes(txtM), JSON.stringify(recB.json).slice(0, 400));
const txtRaw = "raw-bypass-probe " + crypto.randomUUID();
u = await upload(bid, "rawprobe.txt", txtRaw, "board");
let recRaw = await get("/api/boards/" + bid + "/recall?q=raw-bypass-probe&take=8");
ok(tag + "-raw-pending-bypass-closed", !JSON.stringify(recRaw.json).includes("rawprobe.txt") && !JSON.stringify(recRaw.json).includes(txtRaw), JSON.stringify(recRaw.json).slice(0, 400));

// --- forged caller excerpts are resolved from sections (P2 #10) ---
const forged = "TOTALLY FABRICATED QUOTE never in the document " + crypto.randomUUID();
r = await post("/api/boards/" + bid + "/directions", { text: "Adopt probe direction", scope: "meeting", meetingId: mid1, evidence: [{ kind: "source", ref: v3, excerpt: forged }] });
ok(tag + "-direction-with-evidence-201", r.status === 201, r.status + " " + r.text.slice(0, 300));
{
  const ej = JSON.parse(r.json.evidenceJson || r.json.EvidenceJson || "[]");
  const ex0 = (ej[0] && (ej[0].excerpt || ej[0].Excerpt)) || "";
  // Exact expected quotation: the resolved excerpt must equal the persisted
  // canonical section text for v3 — not merely "not the forgery".
  const v3secs = await get("/api/sources/" + v3 + "/sections");
  const v3rows = (v3secs.json.sections || v3secs.json.Sections || []).slice().sort((a, b) => (a.ordinal ?? a.Ordinal) - (b.ordinal ?? b.Ordinal)).slice(0, 6);
  let expectCanon = v3rows.map((x) => { const hd = x.heading ?? x.Heading ?? ""; const tx = x.text ?? x.Text ?? ""; return ((hd && String(hd).trim()) ? "## " + hd + "\n" : "") + tx; }).join("\n\n").trim();
  if (expectCanon.length > 600) expectCanon = expectCanon.slice(0, 600) + "…";
  ok(tag + "-direction-excerpt-canonical", ex0.length > 0 && !ex0.includes("TOTALLY FABRICATED QUOTE") && ex0 === expectCanon, "got=" + ex0.slice(0, 200) + " want=" + expectCanon.slice(0, 200));
}

// --- external recall: visibility + canonical text + REMOTE PROOF (P1 #3) ---
// Local recall alone already contains every eligible doc, so a "contains
// canonical text" assertion proves nothing about the remote path: it passes
// with every remote hit dropped. These controls pin a distinctive remote
// score (local keyword scores are small single digits) and require the
// merged top hit to carry it; dropping all remote hits must fail the same
// assertion. Remote text itself must never surface (canonical re-resolution).
await hindInject([{ kind: "source", ref: vm, text: "EVIL FORGED REMOTE TEXT", score: 888 }]);
let recX1 = await get("/api/boards/" + bid + "/recall?q=meeting-only&take=8");
ok(tag + "-external-meeting-leak-board", !JSON.stringify(recX1.json).includes("meeting-note.txt") && !JSON.stringify(recX1.json).includes("EVIL FORGED REMOTE TEXT"), JSON.stringify(recX1.json).slice(0, 600));
let recX2 = await get("/api/boards/" + bid + "/recall?q=meeting-only&take=1&meetingId=" + mid1);
{
  const hits = recX2.json || [];
  const top = hits[0] || {};
  const topScore = top.score ?? top.Score ?? -1;
  const topRef = top.ref ?? top.Ref ?? "";
  const topText = top.text ?? top.Text ?? "";
  ok(tag + "-external-meeting-remote-proved", recX2.status === 200 && topScore === 888 && String(topRef).includes("meeting-note.txt") && String(topText).includes("meeting-only secret") && !String(topText).includes("EVIL FORGED REMOTE TEXT"), JSON.stringify(recX2.json).slice(0, 600));
}
await hindInject([]);
let recX2d = await get("/api/boards/" + bid + "/recall?q=meeting-only&take=1&meetingId=" + mid1);
{
  const hits = recX2d.json || [];
  const topScore = ((hits[0] || {}).score ?? (hits[0] || {}).Score ?? -1);
  ok(tag + "-external-meeting-drop-remote-fails", recX2d.status === 200 && topScore !== 888, "topScore=" + topScore);
}
await hindInject([{ kind: "source", ref: v3, text: "EVIL FORGED REMOTE TEXT 2", score: 777 }]);
let recX3 = await get("/api/boards/" + bid + "/recall?q=gamma&take=1");
{
  const hits = recX3.json || [];
  const top = hits[0] || {};
  const topScore = top.score ?? top.Score ?? -1;
  const topRef = top.ref ?? top.Ref ?? "";
  const topText = top.text ?? top.Text ?? "";
  ok(tag + "-external-board-remote-proved", recX3.status === 200 && topScore === 777 && String(topRef).includes("evidence.txt") && !String(topText).includes("EVIL FORGED REMOTE TEXT 2") && String(topText).length > 0, JSON.stringify(recX3.json).slice(0, 600));
}
await hindInject([]);
let recX3d = await get("/api/boards/" + bid + "/recall?q=gamma&take=1");
{
  const hits = recX3d.json || [];
  const topScore = ((hits[0] || {}).score ?? (hits[0] || {}).Score ?? -1);
  ok(tag + "-external-board-drop-remote-fails", recX3d.status === 200 && topScore !== 777, "topScore=" + topScore);
}
await hindInject(null);
let recExt = await get("/api/boards/" + bid + "/recall?q=solar&take=8");
ok(tag + "-external-unresolved-dropped", recExt.status === 200 && !JSON.stringify(recExt.json).includes("evil external source claim"), JSON.stringify(recExt.json).slice(0, 600));
// --- policy change pauses + bumps generation; context excludes revoked ---
await post("/api/meetings/" + mid2, {});
await patch("/api/meetings/" + mid2, { brief: "pause probe brief" });
await post("/api/meetings/" + mid2 + "/resume", {});
let mtgsA = await get("/api/boards/" + bid + "/meetings");
let mA = (mtgsA.json || []).find((m) => (m.id || m.Id) === mid2);
const genA0 = mA.generation ?? mA.Generation ?? 0;
const stateA0 = String(mA.state || mA.State || "");
ok(tag + "-resume-active", stateIs(stateA0, "active"), "state=" + stateA0);
r = await put("/api/boards/" + bid + "/source-policy", { blockedTypes: "txt", mode: "allowAll" });
ok(tag + "-policy-change-200", r.status === 200, r.status + " " + r.text.slice(0, 200));
let mtgsB = await get("/api/boards/" + bid + "/meetings");
let mB = (mtgsB.json || []).find((m) => (m.id || m.Id) === mid2);
const genB1 = mB.generation ?? mB.Generation ?? 0;
const stateB1 = String(mB.state || mB.State || "");
ok(tag + "-meeting-paused-after-policy", stateIs(stateB1, "paused"), "state=" + stateB1);
ok(tag + "-meeting-gen-inc-after-policy", genB1 > genA0, genA0 + "->" + genB1);
let ctx = await get("/api/boards/" + bid + "/context");
ok(tag + "-context-shape", ctx.status === 200 && (ctx.json.total ?? ctx.json.Total ?? 0) > 0, JSON.stringify(ctx.json).slice(0, 300));
r = await put("/api/boards/" + bid + "/source-policy", { blockedTypes: "", mode: "allowAll" });
ok(tag + "-policy-reset-2", r.status === 200, r.status + " " + r.text.slice(0, 200));

// --- config export/import preserves SourcePolicyMode (P2 #8) ---
r = await put("/api/boards/" + bid + "/source-policy", { blockedTypes: "exe, zip", mode: "wikiOnly" });
ok(tag + "-policy-wiki-pre-export", r.status === 200, r.status + " " + r.text.slice(0, 200));
let exp = await get("/api/boards/" + bid + "/export");
ok(tag + "-config-export-200", exp.status === 200 && exp.json.snapshot && exp.json.hash, exp.status + " " + exp.text.slice(0, 200));
{
  const snapDoc = JSON.parse(exp.json.snapshot);
  const snapMode = snapDoc.board.sourcePolicyMode ?? snapDoc.board.SourcePolicyMode ?? null;
  ok(tag + "-config-export-carries-policy", snapMode === "wikiOnly", "mode=" + snapMode);
}
let imp = await post("/api/boards/import", { snapshot: exp.json.snapshot, hash: exp.json.hash });
ok(tag + "-config-import-201", imp.status === 201 && imp.json.board && imp.json.board.id, imp.status + " " + imp.text.slice(0, 400));
const impBid = imp.json.board.id || imp.json.board.Id;
let impPol = await get("/api/boards/" + impBid + "/source-policy");
ok(tag + "-config-import-policy-roundtrip", impPol.status === 200 && (impPol.json.mode || impPol.json.Mode) === "wikiOnly", JSON.stringify(impPol.json));
ok(tag + "-config-import-blocked-roundtrip", impPol.status === 200 && (impPol.json.blockedTypes || impPol.json.BlockedTypes || "").includes("exe"), JSON.stringify(impPol.json));
r = await put("/api/boards/" + bid + "/source-policy", { blockedTypes: "", mode: "allowAll" });
ok(tag + "-policy-reset-3", r.status === 200, r.status + " " + r.text.slice(0, 200));

// --- invalid section graph via backup tamper: fail closed, then reindex ---
let bk = await get("/api/backup");
ok(tag + "-backup-200", bk.status === 200 && bk.json.snapshot, bk.status + " " + bk.text.slice(0, 200));
{
  const snap = JSON.parse(bk.json.snapshot);
  const secs = snap.sections || snap.Sections || [];
  const targetIdx = secs.findIndex((s) => ((s.sourceId || s.SourceId) || "").toLowerCase() === String(v3).toLowerCase());
  ok(tag + "-backup-has-v3-sections", targetIdx >= 0, "sections=" + secs.length);
  const kept = secs.filter((s) => ((s.sourceId || s.SourceId) || "").toLowerCase() !== String(v3).toLowerCase());
  if (snap.sections) snap.sections = kept; else snap.Sections = kept;
  const tampered = JSON.stringify(snap);
  const tamperHash = crypto.createHash("sha256").update(tampered, "utf8").digest("hex");
  const rr = await post("/api/backup/restore", { snapshot: tampered, hash: tamperHash });
  ok(tag + "-tampered-restore-200", rr.status === 200, rr.status + " " + rr.text.slice(0, 300));
}
let tIdx = await get("/api/sources/" + v3 + "/index");
ok(tag + "-tampered-ineligible", tIdx.status === 200 && (tIdx.json.eligible === false || tIdx.json.Eligible === false), JSON.stringify(tIdx.json).slice(0, 400));
let tRec = await get("/api/boards/" + bid + "/recall?q=gamma+evidence&take=8");
ok(tag + "-tampered-recall-absent", !JSON.stringify(tRec.json).includes(txt3), JSON.stringify(tRec.json).slice(0, 400));
r = await post("/api/sources/" + v3 + "/reindex", {});
ok(tag + "-tampered-reindex-200", r.status === 200, r.status + " " + r.text.slice(0, 300));
let tRec2 = await get("/api/boards/" + bid + "/recall?q=gamma+evidence&take=8");
ok(tag + "-tampered-reindex-recovers", JSON.stringify(tRec2.json).includes("evidence.txt"), JSON.stringify(tRec2.json).slice(0, 400));

fs.appendFileSync(OUT, tag + "-MID pass=" + pass + " fail=" + fail + "\n");
// --- legacy backup restore: Approved=true without ReviewState (P2 #9) ---
{
  const legBid = crypto.randomUUID();
  const legSid = crypto.randomUUID();
  const rejSid = crypto.randomUUID();
  const legBody = "legacy body text for migration probe " + crypto.randomUUID();
  const now = new Date().toISOString();
  const snap = {
    version: 2, at: now,
    boards: [{ id: legBid, name: "legacy-board", mission: "", stage: "", archived: false, activeConfig: false, draftJson: "{}", activeJson: "{}", leadProfileVersion: 0, retainAudio: false, blockedTypes: "", sourcePolicyMode: "allowAll", discussionPolicy: "balanced", dataUse: "contributor", createdAt: now }],
    roster: [], advisors: [], meetings: [], messages: {}, notes: [], drafts: [],
    sources: [
      { id: legSid, boardId: legBid, fileName: "legacy.txt", contentHash: "aaa", version: 1, approved: true, excluded: false, scope: "board", meetingId: null, extractionJson: "{}", original: null, createdAt: now },
      { id: rejSid, boardId: legBid, fileName: "rej.txt", contentHash: "bbb", version: 1, approved: false, excluded: false, reviewState: "rejected", scope: "board", meetingId: null, extractionJson: "{}", original: null, createdAt: now },
    ],
    blobs: { [legSid]: Buffer.from(legBody, "utf8").toString("base64"), [rejSid]: "" },
    leads: [], grants: [], invites: [], images: [], wizardDrafts: [], sections: [], heads: [], events: [],
  };
  const snapText = JSON.stringify(snap);
  const snapHash = crypto.createHash("sha256").update(snapText, "utf8").digest("hex");
  const rr = await post("/api/backup/restore", { snapshot: snapText, hash: snapHash });
  ok(tag + "-legacy-restore-200", rr.status === 200, rr.status + " " + rr.text.slice(0, 300));
  const gl = await get("/api/boards/" + legBid + "/sources/review");
  const legFam = (gl.json || []).find((x) => (x.familyKey || x.FamilyKey || "").includes("legacy.txt"));
  const rejFam = (gl.json || []).find((x) => (x.familyKey || x.FamilyKey || "").includes("rej.txt"));
  ok(tag + "-legacy-approved-preserved", !!legFam && (legFam.versions[0].reviewState || legFam.versions[0].ReviewState) === "approved" && (legFam.versions[0].approved === true || legFam.versions[0].Approved === true), String(JSON.stringify(legFam)).slice(0, 400));
  ok(tag + "-legacy-family-backfilled", !!legFam && ((legFam.familyKey || legFam.FamilyKey) || "").includes("legacy.txt"), JSON.stringify(legFam).slice(0, 200));
  ok(tag + "-legacy-explicit-rejected-kept", !!rejFam && (rejFam.versions[0].reviewState || rejFam.versions[0].ReviewState) === "rejected" && (rejFam.versions[0].approved === false || rejFam.versions[0].Approved === false), JSON.stringify(rejFam).slice(0, 400));
  const rl = await post("/api/sources/" + legSid + "/reindex", {});
  ok(tag + "-legacy-reindex-200", rl.status === 200, rl.status + " " + rl.text.slice(0, 300));
  const rsec = await get("/api/sources/" + legSid + "/sections");
  ok(tag + "-legacy-sections-from-blob", rsec.status === 200 && rsec.json.sections.length > 0 && rsec.json.sections[0].text.includes("legacy body text for migration probe"), JSON.stringify(rsec.json).slice(0, 400));
  const rcur = await get("/api/boards/" + legBid + "/sources/review");
  const legFam2 = (rcur.json || []).find((x) => (x.familyKey || x.FamilyKey || "").includes("legacy.txt"));
  ok(tag + "-legacy-current-after-index", !!legFam2 && legFam2.hasCurrent === true, JSON.stringify(legFam2).slice(0, 400));
}

}

// --- PG persistence + restart (continues on the suite pg api) ---
if (await assertIdentity("postgres", "pg-restart")) {
  let rb = await post("/api/boards", { name: "sg-pg-" + Date.now() });
  const pgbid = rb.json.id;
  const upg = await upload(pgbid, "persist.txt", "persist sections probe " + crypto.randomUUID(), "board");
  const vpg = sidOf(upg);
  await post("/api/sources/" + vpg + "/approve", {});
  await post("/api/sources/" + vpg + "/reindex", {});
  const s0 = await get("/api/sources/" + vpg + "/sections");
  ok("pg-sections", s0.status === 200 && s0.json.sections.length > 0, JSON.stringify(s0.json).slice(0, 300));
  const h0 = await get("/api/sources/" + vpg + "/history");
  ok("pg-history", h0.status === 200 && h0.json.length >= 3, JSON.stringify(h0.json).slice(0, 300));
  const i0 = await get("/api/sources/" + vpg + "/index");
  ok("pg-eligible", i0.status === 200 && (i0.json.eligible === true || i0.json.Eligible === true), JSON.stringify(i0.json).slice(0, 300));
  await stopProc(api.proc, "pg-api-1");
  await sleep(2500);
  api = await startApi("sgqa_mainpg", ".tmp/sg-api-pg2.log");
  ok("api-pg-restart", api.up, "restart failed");
  if (api.up && await assertIdentity("postgres")) {
    const s1 = await get("/api/sources/" + vpg + "/sections");
    ok("sections-survive-restart", s1.status === 200 && s1.json.sections.length === s0.json.sections.length && s1.json.sections[0].text === s0.json.sections[0].text, JSON.stringify(s1.json).slice(0, 400));
    const h1 = await get("/api/sources/" + vpg + "/history");
    ok("history-survive-restart", h1.status === 200 && h1.json.length === h0.json.length, "len " + (h1.json || []).length + " vs " + (h0.json || []).length);
    const i1 = await get("/api/sources/" + vpg + "/index");
    ok("eligible-survive-restart", i1.status === 200 && (i1.json.eligible === true || i1.json.Eligible === true), JSON.stringify(i1.json).slice(0, 300));
  }
}

fs.appendFileSync(OUT, "DONE pass=" + pass + " fail=" + fail + " failures=" + JSON.stringify(failures) + "\n");
await stopProc(api.proc, "final-api");
try { fake.kill(); } catch { }
hind.close(); ext.close();
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 500);
