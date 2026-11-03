import crypto from "node:crypto";
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import fs from "fs";

// Deterministic governance race/fault matrix (Phase 6 findings 1-7, 9).
// Runs the SAME suite on memory AND on a fresh disposable Postgres DB so the
// full matrix — not just persistence sampling — is proved on both backends.
// Barrier tests fire truly concurrent requests; assertions accept every legal
// serialization but reject mixed/partial states, stale restorations, and
// silent no-ops. The storage-fault probe (PG only) injects a meeting-flush
// failure after a staged source change and requires full rollback + restart
// survival. Memory has no transaction unit, so the fault probe is PG-only
// (documented limit) while every other probe runs on both backends.
const API = "http://127.0.0.1:5095";
const FAKE_PORT = 5195;
const HIND_PORT = 5198;
const EXT_PORT = 5194;
const INSTANCE = "source-gov-qa";
const OUT = ".tmp/source-governance-concurrency-result.txt";
const pgcs = (db) => "Host=127.0.0.1;Port=15435;Database=" + db + ";Username=simceo;Password=simceo-dev-only";
fs.mkdirSync(".tmp", { recursive: true });
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; fs.appendFileSync(OUT, "PASS " + name + "\n"); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); fs.appendFileSync(OUT, "FAIL " + name + (extra ? " :: " + extra : "") + "\n"); console.log("FAIL " + name + (extra ? " :: " + extra : "")); }
}
async function req(method, path, body, o = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), o.timeout || 30000);
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
  return spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", out, out] });
}
async function stopProc(p, label) {
  if (!p) return true;
  try { p.kill(); } catch { }
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    if (p.exitCode !== null || p.signalCode !== null) return true;
    await sleep(250);
  }
  ok("proc-stop-" + label, false, "owned process did not exit; leaving for owner inspection (no blind kill)");
  return false;
}
function readBody(rq) {
  return new Promise((resolve) => { let b = ""; rq.on("data", (c) => { b += c; }); rq.on("end", () => resolve(b)); });
}
// ---- owned stubs: hindsight (empty) + extractor (slow, for stale windows)
const hind = http.createServer((rq, rs) => { rs.writeHead(200, { "content-type": "application/json" }); rs.end(JSON.stringify([])); });
const ext = http.createServer(async (rq, rs) => {
  const u = new URL(rq.url || "/", "http://x");
  if (u.pathname === "/v1/convert/file" && rq.method === "POST") {
    await readBody(rq);
    await sleep(2500); // hold the extraction await open so a second reindex
    // reservation starts before the first one commits (stale window).
    rs.writeHead(200, { "content-type": "application/json" });
    rs.end(JSON.stringify({ md_content: "# Slow converted\n\nSlow extractor body for stale-window probe." }));
    return;
  }
  rs.writeHead(404); rs.end();
});
async function listenChecked(server, port, label) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  }).catch((e) => { ok("port-free-" + label, false, String(e && e.message || e)); throw e; });
  ok("port-free-" + label, true);
}
function startApi(pgDb, log) {
  const env = { META_API_KEY: "dummy-qa-key", META_API_BASE: "http://127.0.0.1:" + FAKE_PORT, HINDSIGHT_URL: "http://127.0.0.1:" + HIND_PORT, EXTRACTOR_URL: "http://127.0.0.1:" + EXT_PORT, SIMCEO_INSTANCE: INSTANCE, ASPNETCORE_URLS: API };
  if (pgDb) { env.USE_POSTGRES = "1"; env.CONNECTIONSTRINGS__APP = pgcs(pgDb); }
  return startProc("dotnet", ["server/SimCEO.Api/bin/Debug/net10.0/SimCEO.Api.dll"], env, log);
}
async function newBoard(tag) {
  const b = await post("/api/boards", { name: "sg-conc-" + tag + "-" + Date.now() });
  return b.json.id;
}
async function newMeeting(bid, title) {
  const m = await post("/api/boards/" + bid + "/meetings", { title: title || "m" });
  return m.json.id;
}
function famOf(groups, needle) {
  return (groups || []).find((x) => ((x.familyKey || x.FamilyKey) || "").includes(needle));
}
async function suite(tag) {
  // --- 1. approve-vs-reject barrier: exactly one legal transition wins ---
  {
    const bid = await newBoard(tag + "-ar");
    const up = await upload(bid, "barrier.txt", "barrier body " + crypto.randomUUID(), "board");
    const id = sidOf(up);
    const [a, b] = await Promise.all([
      post("/api/sources/" + id + "/approve", {}),
      post("/api/sources/" + id + "/reject", {}),
    ]);
    const st = [a.status, b.status].sort((x, y) => x - y);
    ok(tag + "-barrier-200-409", st[0] === 200 && st[1] === 409, a.status + "/" + b.status + " " + (a.text || b.text).slice(0, 200));
    const h = await get("/api/sources/" + id + "/history");
    const acts = (h.json || []).map((e) => e.action || e.Action);
    const transitions = acts.filter((x) => x === "approve" || x === "reject");
    ok(tag + "-barrier-single-transition", transitions.length === 1, JSON.stringify(acts));
    const g = await get("/api/boards/" + bid + "/sources/review");
    const fam = famOf(g.json, "barrier.txt");
    const rs = fam.versions[0].reviewState || fam.versions[0].ReviewState;
    if (transitions[0] === "approve") ok(tag + "-barrier-winner-consistent", rs === "approved", rs);
    else ok(tag + "-barrier-winner-consistent", rs === "rejected", rs);
  }
  // --- 2. supersede: promotion order, stale approval rejected, no silent noop ---
  {
    const bid = await newBoard(tag + "-sup");
    const u1 = await upload(bid, "sup.txt", "sup v1 " + crypto.randomUUID(), "board");
    const v1 = sidOf(u1);
    await post("/api/sources/" + v1 + "/approve", {});
    const u2 = await upload(bid, "sup.txt", "sup v2 " + crypto.randomUUID(), "board");
    const v2 = sidOf(u2);
    const u3 = await upload(bid, "sup.txt", "sup v3 " + crypto.randomUUID(), "board");
    const v3 = sidOf(u3);
    ok(tag + "-versions-123", u1.json.version === 1 && u2.json.version === 2 && u3.json.version === 3, JSON.stringify([u1.json.version, u2.json.version, u3.json.version]));
    const r2 = await post("/api/sources/" + v2 + "/approve", {});
    ok(tag + "-approve-v2", r2.status === 200, r2.status + " " + r2.text.slice(0, 200));
    const r3 = await post("/api/sources/" + v3 + "/approve", {});
    ok(tag + "-approve-v3", r3.status === 200, r3.status + " " + r3.text.slice(0, 200));
    const r1 = await post("/api/sources/" + v1 + "/approve", {});
    ok(tag + "-superseded-v1-409", r1.status === 409, r1.status + " " + r1.text.slice(0, 200));
    const r2b = await post("/api/sources/" + v2 + "/approve", {});
    ok(tag + "-superseded-v2-409-noop", r2b.status === 409, r2b.status + " " + r2b.text.slice(0, 200));
  }
  // --- 3. concurrent upload burst: versions unique, no reuse, head pinned ---
  {
    const bid = await newBoard(tag + "-burst");
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => upload(bid, "burst.txt", "burst body " + i + " " + crypto.randomUUID(), "board")));
    ok(tag + "-burst-all-201", results.every((x) => x.status === 201), results.map((x) => x.status).join(","));
    const vers = results.map((x) => x.json.version).sort((a, b) => a - b);
    ok(tag + "-burst-versions-1-10", JSON.stringify(vers) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), JSON.stringify(vers));
    const top = results.reduce((a, b) => (a.json.version > b.json.version ? a : b));
    const ra = await post("/api/sources/" + sidOf(top) + "/approve", {});
    ok(tag + "-burst-approve-top", ra.status === 200, ra.status + " " + ra.text.slice(0, 200));
    const g = await get("/api/boards/" + bid + "/sources/review");
    const fam = famOf(g.json, "burst.txt");
    ok(tag + "-burst-head-10", String(fam.currentId || fam.CurrentId).toLowerCase() === String(sidOf(top)).toLowerCase(), JSON.stringify(fam.currentId || fam.CurrentId));
  }
  // --- 4. scope-vs-approve barrier: scope edits are ALWAYS denied ---
  // Immutable family (deny-and-upload): a scope PATCH is rejected 409 even
  // when raced against approval, with an actionable upload-in-destination
  // message. The row keeps its board scope and the approve outcome stands.
  {
    const bid = await newBoard(tag + "-mv");
    const mid2 = await newMeeting(bid, "mv-m2");
    const up = await upload(bid, "moveme.txt", "moveme body " + crypto.randomUUID(), "board");
    const id = sidOf(up);
    const [mv, ap] = await Promise.all([
      patch("/api/sources/" + id, { scope: "meeting", meetingId: mid2 }),
      post("/api/sources/" + id + "/approve", {}),
    ]);
    ok(tag + "-mvap-no-500", mv.status !== 500 && ap.status !== 500, mv.status + "/" + ap.status);
    ok(tag + "-mvap-deny-409", mv.status === 409, mv.status + " " + (mv.text || "").slice(0, 200));
    ok(tag + "-mvap-deny-actionable", (mv.text || "").toLowerCase().includes("upload"), (mv.text || "").slice(0, 200));
    ok(tag + "-mvap-approve-200", ap.status === 200, ap.status + " " + (ap.text || "").slice(0, 200));
    const g = await get("/api/boards/" + bid + "/sources/review");
    const all = (g.json || []).flatMap((x) => x.versions || x.Versions || []);
    const row = all.find((x) => String(x.id || x.Id).toLowerCase() === String(id).toLowerCase());
    const rrs = (row.reviewState || row.ReviewState || "").toLowerCase();
    const scope = row.scope || row.Scope;
    ok(tag + "-mvap-end-approved-board", rrs === "approved" && scope === "board", "review=" + rrs + " scope=" + scope);
    const h = await get("/api/sources/" + id + "/history");
    const acts = (h.json || []).map((e) => e.action || e.Action);
    ok(tag + "-mvap-history", acts.includes("approve") && !acts.some((a) => String(a).toLowerCase().includes("scope")), JSON.stringify(acts));
    // Sequential denied scope edit after approval: still 409, state unchanged.
    const mv2 = await patch("/api/sources/" + id, { scope: "meeting", meetingId: mid2 });
    ok(tag + "-mvap-deny-after-approve", mv2.status === 409, mv2.status + " " + (mv2.text || "").slice(0, 200));
    const g2 = await get("/api/boards/" + bid + "/sources/review");
    const all2 = (g2.json || []).flatMap((x) => x.versions || x.Versions || []);
    const row2 = all2.find((x) => String(x.id || x.Id).toLowerCase() === String(id).toLowerCase());
    ok(tag + "-mvap-still-board", (row2.scope || row2.Scope) === "board" && String(row2.reviewState || row2.ReviewState).toLowerCase() === "approved",
      JSON.stringify(row2).slice(0, 300));
    // Deny-and-upload: the destination scope accepts a fresh pending version.
    const re = await upload(bid, "moveme.txt", "moveme body destination " + crypto.randomUUID(), "meeting", mid2);
    ok(tag + "-mvap-reupload-201", re.status === 201, re.status + " " + (re.text || "").slice(0, 200));
    ok(tag + "-mvap-reupload-v1-newfamily", (re.json.version ?? re.json.Version) === 1, JSON.stringify(re.json).slice(0, 200));
    const g3 = await get("/api/boards/" + bid + "/sources/review");
    const fams = (g3.json || []).filter((x) => ((x.familyKey || x.FamilyKey) || "").includes("moveme.txt"));
    ok(tag + "-mvap-two-families", fams.length === 2, "families=" + fams.length);
  }
  // --- 5. stale index completion: delayed extraction overlaps a second ---
  // --- reservation; exactly one commits, the stale one is discarded. ---
  {
    const bid = await newBoard(tag + "-stale");
    const fd = new FormData();
    fd.append("file", new Blob(["stale pdf body " + crypto.randomUUID()], { type: "text/plain" }), "stale.pdf");
    fd.append("scope", "board");
    const rr = await fetch(API + "/api/boards/" + bid + "/sources/upload", { method: "POST", headers: { "x-user": "owner" }, body: fd });
    const uj = await rr.json();
    const id = uj.id || uj.Id;
    ok(tag + "-stale-upload-201", rr.status === 201, rr.status);
    await post("/api/sources/" + id + "/approve", {});
    const [r1, r2] = await Promise.all([
      post("/api/sources/" + id + "/reindex", {}, { timeout: 60000 }),
      post("/api/sources/" + id + "/reindex", {}, { timeout: 60000 }),
    ]);
    const sts = [r1.status, r2.status].sort((a, b) => a - b);
    ok(tag + "-stale-200-409", sts[0] === 200 && sts[1] === 409, r1.status + "/" + r2.status + " " + (r1.text || "").slice(0, 200) + " | " + (r2.text || "").slice(0, 200));
    const loser = r1.status === 409 ? r1 : r2;
    ok(tag + "-stale-flagged", (loser.json && (loser.json.stale === true || loser.json.Stale === true)) === true, JSON.stringify(loser.json).slice(0, 300));
    const idx = await get("/api/sources/" + id + "/index");
    ok(tag + "-stale-final-eligible", idx.json.eligible === true || idx.json.Eligible === true, JSON.stringify(idx.json).slice(0, 300));
    const rv = await get("/api/boards/" + bid + "/sources/review");
    const fam = famOf(rv.json, "stale.pdf");
    ok(tag + "-stale-review-approved", (fam.versions[0].reviewState || fam.versions[0].ReviewState) === "approved", JSON.stringify(fam.versions[0]).slice(0, 300));
  }
  // --- 5b. restore-epoch index race: a reservation started before a ---
  // --- restore is discarded after it (epoch changed), never committed. ---
  {
    const bid = await newBoard(tag + "-rx");
    const fd = new FormData();
    fd.append("file", new Blob(["restore race pdf body " + crypto.randomUUID()], { type: "text/plain" }), "racer.pdf");
    fd.append("scope", "board");
    const rr = await fetch(API + "/api/boards/" + bid + "/sources/upload", { method: "POST", headers: { "x-user": "owner" }, body: fd });
    const rtext = await rr.text();
    ok(tag + "-rx-upload-201", rr.status === 201, rr.status + " " + rtext.slice(0, 200));
    const uj = JSON.parse(rtext);
    const id = uj.id || uj.Id;
    await post("/api/sources/" + id + "/approve", {});
    const bk = await get("/api/backup");
    ok(tag + "-rx-backup-200", bk.status === 200 && bk.json.snapshot, bk.status + "");
    const snapObj = JSON.parse(bk.json.snapshot);
    const snapHash = crypto.createHash("sha256").update(JSON.stringify(snapObj), "utf8").digest("hex");
    const pre = await get("/api/sources/" + id + "/sections");
    const preText = JSON.stringify((pre.json.sections || pre.json.Sections || []).map((x) => x.text ?? x.Text));
    const preGen = pre.json.indexGeneration ?? pre.json.IndexGeneration;
    const r1p = post("/api/sources/" + id + "/reindex", {}, { timeout: 60000 });
    await sleep(400); // slow extractor holds the window open; reservation committed
    const rs = await post("/api/backup/restore", { snapshot: JSON.stringify(snapObj), hash: snapHash });
    ok(tag + "-rx-restore-200", rs.status === 200, rs.status + " " + (rs.text || "").slice(0, 200));
    const r1 = await r1p;
    ok(tag + "-rx-stale-409", r1.status === 409, r1.status + " " + (r1.text || "").slice(0, 200));
    ok(tag + "-rx-stale-flag", (r1.json && (r1.json.stale === true || r1.json.Stale === true)) === true, JSON.stringify(r1.json).slice(0, 200));
    const postQx = await get("/api/sources/" + id + "/sections");
    ok(tag + "-rx-sections-unchanged", JSON.stringify((postQx.json.sections || postQx.json.Sections || []).map((x) => x.text ?? x.Text)) === preText, (JSON.stringify(postQx.json).slice(0, 200)));
    const r2 = await post("/api/sources/" + id + "/reindex", {}, { timeout: 60000 });
    ok(tag + "-rx-reindex-200", r2.status === 200, r2.status + " " + (r2.text || "").slice(0, 200));
    const post3 = await get("/api/sources/" + id + "/sections");
    ok(tag + "-rx-gen-advanced", (post3.json.indexGeneration ?? post3.json.IndexGeneration) > preGen, preGen + " vs " + (post3.json.indexGeneration ?? post3.json.IndexGeneration));
  }
  // --- 6. malformed restore graph: rejected before any mutation ---
  {
    const bid = await newBoard(tag + "-mal");
    const up = await upload(bid, "keep.txt", "keep body " + crypto.randomUUID(), "board");
    const id = sidOf(up);
    await post("/api/sources/" + id + "/approve", {});
    const before = await get("/api/boards/" + bid + "/sources/review");
    const beforeCount = (before.json || []).length;
    const bk = await get("/api/backup");
    ok(tag + "-mal-backup-200", bk.status === 200 && bk.json.snapshot, bk.status + "");
    const snap = JSON.parse(bk.json.snapshot);
    const secs = snap.sections || snap.Sections;
    if (Array.isArray(secs)) secs.push(null);
    else { if (snap.sections) snap.sections = [null]; else snap.Sections = [null]; }
    const snapHash = crypto.createHash("sha256").update(JSON.stringify(snap), "utf8").digest("hex");
    const bad = await post("/api/backup/restore", { snapshot: JSON.stringify(snap), hash: snapHash });
    ok(tag + "-mal-restore-422", bad.status === 422, bad.status + " " + bad.text.slice(0, 300));
    const after = await get("/api/boards/" + bid + "/sources/review");
    ok(tag + "-mal-unchanged-count", (after.json || []).length === beforeCount, (after.json || []).length + " vs " + beforeCount);
    const idx = await get("/api/sources/" + id + "/index");
    ok(tag + "-mal-still-eligible", idx.json.eligible === true || idx.json.Eligible === true, JSON.stringify(idx.json).slice(0, 300));
    // Mismatched section hash is equally rejected without mutation.
    const bk2 = await get("/api/backup");
    const snap2 = JSON.parse(bk2.json.snapshot);
    const s2 = snap2.sections || snap2.Sections;
    const mine = s2.find((x) => x && String(x.sourceId || x.SourceId).toLowerCase() === String(id).toLowerCase());
    if (mine) { if (mine.contentHash !== undefined) mine.contentHash = "0".repeat(64); else mine.ContentHash = "0".repeat(64); }
    const h2 = crypto.createHash("sha256").update(JSON.stringify(snap2), "utf8").digest("hex");
    const bad2 = await post("/api/backup/restore", { snapshot: JSON.stringify(snap2), hash: h2 });
    ok(tag + "-mal-hash-422", bad2.status === 422, bad2.status + " " + bad2.text.slice(0, 300));
    const idx2 = await get("/api/sources/" + id + "/index");
    ok(tag + "-mal-hash-unchanged", idx2.json.eligible === true || idx2.json.Eligible === true, JSON.stringify(idx2.json).slice(0, 300));
  }
  // --- 7. restore-removal: a dropped family stays gone, no revival ---
  {
    const bid = await newBoard(tag + "-rm");
    const goneMark = "gone family body " + crypto.randomUUID();
    const up = await upload(bid, "gone.txt", goneMark, "board");
    const id = sidOf(up);
    await post("/api/sources/" + id + "/approve", {});
    const bk = await get("/api/backup");
    const snap = JSON.parse(bk.json.snapshot);
    const strip = (arr) => (Array.isArray(arr) ? arr.filter((x) => x && String(x.id || x.Id).toLowerCase() !== String(id).toLowerCase()) : arr);
    const stripSrc = (arr) => (Array.isArray(arr) ? arr.filter((x) => x && String(x.sourceId || x.SourceId).toLowerCase() !== String(id).toLowerCase()) : arr);
    if (snap.sources) snap.sources = strip(snap.sources); else snap.Sources = strip(snap.Sources);
    if (snap.sections) snap.sections = stripSrc(snap.sections); else if (snap.Sections) snap.Sections = stripSrc(snap.Sections);
    if (snap.heads) snap.heads = (snap.heads || []).filter((x) => x); // heads keyed by family; drop ours below by family match
    const famNeedle = "gone.txt";
    const keepHead = (x) => x && !String(x.familyKey || x.FamilyKey || "").includes(famNeedle);
    if (snap.heads) snap.heads = snap.heads.filter(keepHead); else if (snap.Heads) snap.Heads = snap.Heads.filter(keepHead);
    if (snap.events) snap.events = stripSrc(snap.events); else if (snap.Events) snap.Events = stripSrc(snap.Events);
    if (snap.blobs) delete snap.blobs[id];
    const h = crypto.createHash("sha256").update(JSON.stringify(snap), "utf8").digest("hex");
    const rr = await post("/api/backup/restore", { snapshot: JSON.stringify(snap), hash: h });
    ok(tag + "-rm-restore-200", rr.status === 200, rr.status + " " + rr.text.slice(0, 300));
    const g = await get("/api/boards/" + bid + "/sources/review");
    ok(tag + "-rm-group-gone", !famOf(g.json, "gone.txt"), JSON.stringify(g.json).slice(0, 300));
    const rec = await get("/api/boards/" + bid + "/recall?q=gone+family&take=8");
    ok(tag + "-rm-recall-absent", !JSON.stringify(rec.json).includes(goneMark), JSON.stringify(rec.json).slice(0, 300));
  }
  // --- 7b. two-version removal: deleting the current version fails ---
  // --- closed (no fallback, no silent promotion), whether or not the ---
  // --- stale head is also dropped. Whole-family removal stays legal. ---
  {
    const bid = await newBoard(tag + "-rm2");
    const up1 = await upload(bid, "tworm.txt", "tworm v1 " + crypto.randomUUID(), "board");
    const id1 = sidOf(up1);
    await post("/api/sources/" + id1 + "/approve", {});
    const up2 = await upload(bid, "tworm.txt", "tworm v2 " + crypto.randomUUID(), "board");
    const id2 = sidOf(up2);
    await post("/api/sources/" + id2 + "/approve", {});
    const bk = await get("/api/backup");
    const mkRemoval = (dropHead) => {
      const snap = JSON.parse(bk.json.snapshot);
      const strip = (arr) => (Array.isArray(arr) ? arr.filter((x) => x && String(x.id || x.Id).toLowerCase() !== String(id2).toLowerCase()) : arr);
      const stripSrc = (arr) => (Array.isArray(arr) ? arr.filter((x) => x && String(x.sourceId || x.SourceId).toLowerCase() !== String(id2).toLowerCase()) : arr);
      if (snap.sources) snap.sources = strip(snap.sources); else snap.Sources = strip(snap.Sources);
      if (snap.sections) snap.sections = stripSrc(snap.sections); else if (snap.Sections) snap.Sections = stripSrc(snap.Sections);
      if (snap.events) snap.events = stripSrc(snap.events); else if (snap.Events) snap.Events = stripSrc(snap.Events);
      if (blobsOf(snap)[String(id2)]) delete blobsOf(snap)[String(id2)];
      if (dropHead) {
        const keepHead = (x) => x && !String(x.familyKey || x.FamilyKey || "").includes("tworm.txt");
        if (snap.heads) snap.heads = snap.heads.filter(keepHead); else if (snap.Heads) snap.Heads = snap.Heads.filter(keepHead);
      }
      return snap;
    };
    const blobsOf = (snap) => snap.blobs || snap.Blobs || {};
    const hashOf = (snap) => crypto.createHash("sha256").update(JSON.stringify(snap), "utf8").digest("hex");
    const noHead = mkRemoval(true);
    const rNoHead = await post("/api/backup/restore", { snapshot: JSON.stringify(noHead), hash: hashOf(noHead) });
    ok(tag + "-rm2-nohead-422", rNoHead.status === 422, rNoHead.status + " " + (rNoHead.text || "").slice(0, 300));
    const gA = await get("/api/boards/" + bid + "/sources/review");
    const famA = famOf(gA.json, "tworm.txt");
    ok(tag + "-rm2-still-v2-current", !!famA && String(famA.currentId || famA.CurrentId).toLowerCase() === String(id2).toLowerCase(), JSON.stringify(famA).slice(0, 300));
    const keepHead = mkRemoval(false);
    const rKeepHead = await post("/api/backup/restore", { snapshot: JSON.stringify(keepHead), hash: hashOf(keepHead) });
    ok(tag + "-rm2-dangling-422", rKeepHead.status === 422, rKeepHead.status + " " + (rKeepHead.text || "").slice(0, 300));
    const gB = await get("/api/boards/" + bid + "/sources/review");
    const famB = famOf(gB.json, "tworm.txt");
    ok(tag + "-rm2-still-v2-current-2", !!famB && String(famB.currentId || famB.CurrentId).toLowerCase() === String(id2).toLowerCase(), JSON.stringify(famB).slice(0, 300));
    const idxB = await get("/api/sources/" + id2 + "/index");
    ok(tag + "-rm2-v2-still-eligible", idxB.json.eligible === true || idxB.json.Eligible === true, JSON.stringify(idxB.json).slice(0, 200));
  }
  // --- 8. destination auth: read-only denied writes; meeting-only grants ---
  // --- cannot move scope (narrow board authority), but can review in-scope.
  {
    const bid = await newBoard(tag + "-perm");
    const mid = await newMeeting(bid, "perm-m");
    const up = await upload(bid, "perm.txt", "perm body " + crypto.randomUUID(), "board");
    const id = sidOf(up);
    const mu = await upload(bid, "permmeet.txt", "perm meeting body " + crypto.randomUUID(), "meeting", mid);
    const mid2 = sidOf(mu);
    const gr = await post("/api/boards/" + bid + "/grants", { userKey: "reader", access: "read" });
    ok(tag + "-perm-grant-read", gr.status === 201, gr.status + " " + gr.text.slice(0, 200));
    const gm = await post("/api/boards/" + bid + "/grants", { userKey: "meetaide", access: "contribute", meetingId: mid });
    ok(tag + "-perm-grant-meet", gm.status === 201, gm.status + " " + gm.text.slice(0, 200));
    const denied = await post("/api/sources/" + id + "/approve", {}, { headers: { "x-user": "reader" } });
    ok(tag + "-perm-read-deny-approve", denied.status === 403, denied.status + " " + denied.text.slice(0, 200));
    const deniedPatch = await patch("/api/sources/" + id, { excluded: true }, { headers: { "x-user": "reader" } });
    ok(tag + "-perm-read-deny-patch", deniedPatch.status === 403, deniedPatch.status + " " + deniedPatch.text.slice(0, 200));
    const readOk = await get("/api/boards/" + bid + "/recall?q=perm&take=8", { headers: { "x-user": "reader" } });
    ok(tag + "-perm-read-recall-200", readOk.status === 200, readOk.status + "");
    const meetMove = await patch("/api/sources/" + id, { scope: "meeting", meetingId: mid }, { headers: { "x-user": "meetaide" } });
    ok(tag + "-perm-meet-deny-move", meetMove.status === 409, meetMove.status + " " + meetMove.text.slice(0, 200));
    ok(tag + "-perm-meet-deny-actionable", (meetMove.text || "").toLowerCase().includes("upload"), (meetMove.text || "").slice(0, 200));
    const meetAp = await post("/api/sources/" + mid2 + "/approve", {}, { headers: { "x-user": "meetaide" } });
    ok(tag + "-perm-meet-approve-inscope", meetAp.status === 200, meetAp.status + " " + meetAp.text.slice(0, 200));
    const still = await get("/api/sources/" + id + "/index");
    ok(tag + "-perm-board-untouched", still.status === 200, still.status + "");
  }
}

async function probeSuite(tag) {
  // Storage-failure atomicity via the standalone code-only backend seam
  // (qa/SourceGovernanceProbe): armed commit failure during approve AND
  // policy must throw with zero state change, verified through fresh reads
  // plus a simulated restart; disarmed work then persists and survives a
  // second restart. No shipping HTTP fault surface is used.
  try {
    const out = execSync("dotnet qa/SourceGovernanceProbe/bin/Debug/net10.0/SourceGovernanceProbe.dll", { timeout: 120000 }).toString();
    const m = out.match(/PROBE pass=(\d+) fail=(\d+)/);
    const pp = m ? parseInt(m[1], 10) : 0, ff = m ? parseInt(m[2], 10) : 999;
    ok(tag + "-probe-pass-" + pp, ff === 0 && pp >= 20, out.slice(-600));
  } catch (e) {
    ok(tag + "-probe-pass-0", false, String((e && e.stdout) || e).slice(-600));
  }
}

fs.writeFileSync(OUT, "START concurrency " + new Date().toISOString() + "\n");
{
  const up = await (async () => {
    try {
      const r = await fetch(API + "/health", { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch { return false; }
  })();
  if (up) {
    ok("preflight-ports-free", false, API + " already answers; refusing to hijack a foreign instance");
    process.exit(1);
  } else ok("preflight-ports-free", true);
}
await listenChecked(hind, HIND_PORT, "hind5198");
await listenChecked(ext, EXT_PORT, "ext5194");
const fake = startProc("node", ["qa/fake-provider.mjs", "--port", String(FAKE_PORT)], {}, ".tmp/sg-conc-fake.log");
await sleep(1500);
let memApi = startApi(null, ".tmp/sg-conc-mem.log");
ok("mem-api-up", await waitHealth(30000), "memory api did not come up");
if (await waitHealth(2000)) {
  if (await assertIdentity("memory", "mem")) await suite("mem");
  await stopProc(memApi, "mem-api");
  await sleep(2000);
}
const DB = "sgqa_conc";
try { execSync("docker exec simceo-source-qa-pg psql -U simceo -d postgres -c \"DROP DATABASE IF EXISTS " + DB + ";\""); } catch (e) { ok("pg-drop", false, String(e).slice(0, 200)); }
try { execSync("docker exec simceo-source-qa-pg psql -U simceo -d postgres -c \"CREATE DATABASE " + DB + ";\""); ok("pg-create", true); } catch (e) { ok("pg-create", false, String(e).slice(0, 200)); }
let pgApi = startApi(DB, ".tmp/sg-conc-pg.log");
ok("pg-api-up", await waitHealth(60000), "pg api did not come up");
if (await waitHealth(2000)) {
  if (await assertIdentity("postgres", "pg")) await suite("pg");
  await stopProc(pgApi, "pg-api");
  await sleep(2500);
  await probeSuite("seam");
}
fs.appendFileSync(OUT, "DONE pass=" + pass + " fail=" + fail + " failures=" + JSON.stringify(failures) + "\n");
try { fake.kill(); } catch { }
hind.close(); ext.close();
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 500);
