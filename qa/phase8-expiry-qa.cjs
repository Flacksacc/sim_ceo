const { HubConnectionBuilder } = require("../web/node_modules/@microsoft/signalr/dist/cjs/index.js");
const fs = require("fs");
const path = require("path");
const API = process.env.QA_API || "http://127.0.0.1:15340";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:15342";
const MODE = (process.env.QA_MODE || "setup").trim();
const runEnv = process.env.QA_RUN || "";
const run = runEnv ? runEnv : ("p8xp-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1000000).toString(36));
let pass = 0, fail = 0; const bad = [];
function ok(n, c, e) { if (c) { pass++; console.log("  ok - " + n); } else { fail++; bad.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
function fatalGate(msg) { console.log("FATAL-GATE " + msg); process.exitCode = 2; throw new Error(msg); }
const T0 = Date.now(); const BUDGET = 150000;
function remaining() { return Math.max(2000, BUDGET - (Date.now() - T0)); }
async function req(method, path, body, headers) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(API + path, { method, signal: ctl.signal, headers: { "content-type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} return { status: r.status, json: j, text: t };
  } finally { clearTimeout(tm); }
}
const B = (t) => (t ? { Authorization: "Bearer " + t } : {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const cap = Math.min(ms, remaining()); const t0 = Date.now();
  while (Date.now() - t0 < cap) { try { if (await fn()) return true; } catch {} await sleep(150); }
  return false;
}
const allConns = new Set();
function track(c) { allConns.add(c); return c; }
async function closeAll() { for (const c of Array.from(allConns)) { try { await c.stop(); } catch {} } allConns.clear(); }
async function main() {
  if (API !== "http://127.0.0.1:15340") fatalGate("QA_API must be exactly 127.0.0.1:15340 got " + API);
  try { const u = new URL(API); if (u.hostname !== "127.0.0.1" || u.port !== "15340") fatalGate("QA_API loopback 15340 required"); } catch { fatalGate("QA_API parse failed"); }
  if (FAKE !== "http://127.0.0.1:15342") fatalGate("QA_FAKE must be exactly 127.0.0.1:15342 got " + FAKE);
  const pgdb = process.env.QA_PGDB || "";
  const expDb = process.env.QA_EXPECTED_DB || "";
  if (!pgdb && MODE === "setup") console.log("note - QA_PGDB empty in setup; primary provides fresh primary_phase8_ db");
  if (pgdb && pgdb.indexOf("primary_phase8_") !== 0) fatalGate("QA_PGDB must start with primary_phase8_");
  if (expDb && expDb.indexOf("primary_phase8_") !== 0) fatalGate("QA_EXPECTED_DB must start with primary_phase8_");
  if (expDb && pgdb && expDb !== pgdb) fatalGate("QA_PGDB must equal QA_EXPECTED_DB");
  if (!run || run.length < 12) fatalGate("fresh scope run id too short");
  if (MODE !== "setup" && MODE !== "recheck") fatalGate("QA_MODE must be setup or recheck");
  console.log("expiry-qa run=" + run + " mode=" + MODE + " api=" + API + " fake=" + FAKE);
  let st0 = null;
  try { st0 = await req("GET", "/api/auth/status"); } catch { fatalGate("owned instance status unreachable"); }
  if (!st0 || st0.status !== 200) fatalGate("owned instance status must be 200 before auth");
  ok("gate-instance-status-200", true);
  let fakeOk = false;
  try {
    const fr = await fetch(FAKE + "/__log", { method: "GET" });
    const ft = await fr.text(); let fj = null; try { fj = ft ? JSON.parse(ft) : null; } catch {}
    if (fr.status === 200 && Array.isArray(fj)) fakeOk = true;
  } catch {}
  if (!fakeOk) fatalGate("fake provenance must be reachable array at " + FAKE + "/__log");
  ok("gate-fake-provenance", true);
  const pw = "TestPassword123!";
  const adminE = run + "-admin@example.com", guestE = run + "-guest@example.com", ctrlE = run + "-ctrl@example.com";
  const manifestPath = path.join(__dirname, "proof", "phase8-expiry-manifest.json");
  if (MODE === "recheck") {
    let man = null;
    try { man = JSON.parse(fs.readFileSync(manifestPath, "utf-8")); } catch { fatalGate("recheck manifest missing"); }
    ok("recheck-manifest-present", !!man && !!man.run && !!man.bid && !!man.mid, "manifest incomplete");
    if (!man || !man.run) fatalGate("recheck manifest invalid");
    const ar = await req("POST", "/api/auth/login", { email: man.adminE, password: pw });
    ok("recheck-admin-relogin", ar.status === 200 && ar.json && ar.json.token, ar.status + " " + ar.text.slice(0, 120));
    const gr = await req("POST", "/api/auth/login", { email: man.guestE, password: pw });
    ok("recheck-guest-relogin", gr.status === 200 && gr.json && gr.json.token, gr.status + " " + gr.text.slice(0, 120));
    const adminT = ar.json.token, guestT = gr.json.token;
    const boards = await req("GET", "/api/boards", undefined, B(adminT));
    const found = (Array.isArray(boards.json) ? boards.json : []).find((x) => (x.name || x.Name) === man.bname);
    ok("recheck-board-persisted", !!found, "boards=" + JSON.stringify((boards.json || []).length));
    const grants = await req("GET", "/api/boards/" + man.bid + "/grants", undefined, B(adminT));
    const rows = Array.isArray(grants.json) ? grants.json : [];
    ok("recheck-grants-shape", grants.status === 200, grants.status + " " + grants.text.slice(0, 120));
    console.log("FINAL pass=" + pass + " fail=" + fail);
    if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
    process.exitCode = fail === 0 ? 0 : 1;
    return;
  }
  const ar = await req("POST", "/api/auth/register", { email: adminE, password: pw });
  ok("admin-reg", ar.status === 201 && ar.json && ar.json.token, ar.status + " " + ar.text.slice(0, 120));
  const gr = await req("POST", "/api/auth/register", { email: guestE, password: pw });
  ok("guest-reg", gr.status === 201 && gr.json && gr.json.token, gr.status + " " + gr.text.slice(0, 120));
  const cr = await req("POST", "/api/auth/register", { email: ctrlE, password: pw });
  ok("ctrl-reg", cr.status === 201 && cr.json && cr.json.token, cr.status + " " + cr.text.slice(0, 120));
  if (!ar.json.token || !gr.json.token || !cr.json.token) fatalGate("bearer tokens missing");
  const adminT = ar.json.token, guestT = gr.json.token, ctrlT = cr.json.token;
  const b = await req("POST", "/api/boards", { name: run + "-b" }, B(adminT));
  ok("board-create", b.status === 201 && b.json && b.json.id, b.status + " " + b.text.slice(0, 160));
  if (!b.json || !b.json.id) fatalGate("board setup failed");
  const bid = b.json.id; const bname = run + "-b";
  const m = await req("POST", "/api/boards/" + bid + "/meetings", { title: "m1", brief: "b" }, B(adminT));
  const mid = m.json && m.json.id; ok("meeting-create", m.status === 201 && mid, m.status + " " + m.text.slice(0, 120));
  if (!mid) fatalGate("meeting setup failed");
  const gg = await req("POST", "/api/boards/" + bid + "/grants", { userKey: guestE, access: "discuss", meetingId: mid }, B(adminT));
  ok("grant-guest", gg.status === 201, gg.status + " " + gg.text.slice(0, 160));
  const gc = await req("POST", "/api/boards/" + bid + "/grants", { userKey: ctrlE, access: "contribute", meetingId: mid }, B(adminT));
  ok("grant-ctrl", gc.status === 201, gc.status + " " + gc.text.slice(0, 160));
  if (gg.status !== 201 || gc.status !== 201) fatalGate("grant setup incomplete");
  ok("gate-setup-complete", true);
  const mk = (tok) => track(new HubConnectionBuilder().withUrl(API + "/hubs/board", { accessTokenFactory: () => tok }).build());
  const gMsgs = []; let gRev = 0; let gClosed = false;
  const gC = mk(guestT); gC.on("message", (mm) => gMsgs.push(mm)); gC.on("access-revoked", () => { gRev++; }); gC.onclose(() => { gClosed = true; });
  const cMsgs = [];
  const cC = mk(ctrlT); cC.on("message", (mm) => cMsgs.push(mm));
  await gC.start(); await gC.invoke("JoinMeeting", mid); ok("guest-join-live", true);
  await cC.start(); await cC.invoke("JoinMeeting", mid); ok("control-join-live", true);
  const pre = "pre-" + run;
  const post = await req("POST", "/api/meetings/" + mid + "/messages", { content: pre }, B(adminT));
  ok("post-pre-201", post.status === 201 && post.json && post.json.Sequence, post.status + " " + post.text.slice(0, 160));
  const seq = post.json && post.json.Sequence;
  function hasMarker(arr, s, c) {
    for (const mm of arr) {
      const ss = mm && (mm.Sequence !== undefined ? mm.Sequence : (mm.sequence !== undefined ? mm.sequence : null));
      const cc = mm && (mm.Content !== undefined ? mm.Content : (mm.content !== undefined ? mm.content : null));
      if (ss === s && cc === c) return true;
    }
    return false;
  }
  ok("positive-guest-exact", await waitFor(async () => hasMarker(gMsgs, seq, pre), 10000), "guest missing");
  ok("positive-control-exact", await waitFor(async () => hasMarker(cMsgs, seq, pre), 10000), "control missing");
  const mem = await req("GET", "/api/me/memberships", undefined, B(guestT));
  ok("membership-read-200", mem.status === 200, mem.status + " " + mem.text.slice(0, 120));
  const mrow = (Array.isArray(mem.json) ? mem.json : []).find((x) => (x.meetingId || x.MeetingId) === mid);
  ok("membership-row-present", !!mrow, "missing");
  const rowId = mrow && (mrow.id || mrow.Id);
  const joinedAt = mrow && (mrow.joinedAt || mrow.JoinedAt);
  ok("membership-id-not-empty", !!rowId, "missing id");
  ok("membership-joinedAt-present", !!joinedAt, "missing joinedAt");
  const grantsNow = await req("GET", "/api/boards/" + bid + "/grants", undefined, B(adminT));
  const grows = Array.isArray(grantsNow.json) ? grantsNow.json : [];
  const man = { run: run, mode: "setup", bid: bid, mid: mid, bname: bname, adminE: adminE, guestE: guestE, ctrlE: ctrlE, membershipId: rowId, joinedAt: joinedAt, grants: grows.map((x) => ({ id: (x.id || x.Id), userKey: (x.userKey || x.UserKey), access: (x.access || x.Access), meetingId: (x.meetingId || x.MeetingId) })), createdAt: new Date().toISOString() };
  try { fs.writeFileSync(manifestPath, JSON.stringify(man, null, 2), "utf-8"); ok("manifest-written", true); } catch (e) { ok("manifest-written", false, String(e).slice(0, 160)); }
  console.log("EXPIRY-UNPROVEN-SESSIONS-MEMORY-ONLY sessions are memory-only with 14-day lifetime and no clock seam; no SQL session table exists for QA UPDATE; publisher suppress before sweep and natural expiry revoke cannot be proven without waiting 14 days or adding a production seam (frozen). Positive delivery and membership durability above are proven; expiry revoke and 401 remain unproven until primary provides a supported expiry path.");
  try { await gC.stop(); } catch {} try { await cC.stop(); } catch {}
  console.log("FINAL pass=" + pass + " fail=" + fail);
  if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
  process.exitCode = fail === 0 ? 0 : 1;
}
(async () => {
  try { await main(); } catch (e) {
    if (process.exitCode !== 2) { console.log("HARNESS-ERROR " + (e && e.stack || e)); process.exitCode = 2; }
  } finally { try { await closeAll(); } catch {} }
})();
