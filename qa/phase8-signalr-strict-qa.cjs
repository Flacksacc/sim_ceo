const { HubConnectionBuilder } = require("../web/node_modules/@microsoft/signalr/dist/cjs/index.js");
const API = process.env.QA_API || "http://127.0.0.1:15340";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:15342";
const EXPECTED_API = "http://127.0.0.1:15340";
const EXPECTED_FAKE = "http://127.0.0.1:15342";
const run = "p8ss-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1000000).toString(36);
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
async function waitFor(fn, ms, label) {
  const cap = Math.min(ms, remaining()); const t0 = Date.now();
  while (Date.now() - t0 < cap) { try { if (await fn()) return true; } catch {} await sleep(150); }
  return false;
}
const allConns = new Set();
function track(c) { allConns.add(c); return c; }
async function closeAll() { for (const c of Array.from(allConns)) { try { await c.stop(); } catch {} } allConns.clear(); }
async function main() {
  if (API !== EXPECTED_API) fatalGate("QA_API must be exactly " + EXPECTED_API + " got " + API);
  try {
    const u = new URL(API);
    if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || u.port !== "15340") fatalGate("QA_API must be exact loopback 15340");
  } catch (e) { fatalGate("QA_API URL parse failed"); }
  if (FAKE !== EXPECTED_FAKE) fatalGate("QA_FAKE must be exactly " + EXPECTED_FAKE + " got " + FAKE);
  const pgdb = process.env.QA_PGDB || "";
  const expDb = process.env.QA_EXPECTED_DB || "";
  if (pgdb && pgdb.indexOf("primary_phase8_") !== 0) fatalGate("QA_PGDB must start with primary_phase8_");
  if (expDb && expDb.indexOf("primary_phase8_") !== 0) fatalGate("QA_EXPECTED_DB must start with primary_phase8_");
  if (expDb && pgdb && expDb !== pgdb) fatalGate("QA_PGDB must equal QA_EXPECTED_DB");
  if (!run || run.length < 12) fatalGate("fresh scope run id too short");
  console.log("strict-signalr run=" + run + " api=" + API + " fake=" + FAKE);
  let st0 = null;
  try { st0 = await req("GET", "/api/auth/status"); } catch (e) { fatalGate("owned instance status unreachable"); }
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
  const adminE = run + "-admin@example.com", guestE = run + "-guest@example.com", ctrlE = run + "-ctrl@example.com", strE = run + "-str@example.com", otherE = run + "-other@example.com";
  const ar = await req("POST", "/api/auth/register", { email: adminE, password: pw });
  ok("admin-reg", ar.status === 201 && ar.json && ar.json.token, ar.status + " " + ar.text.slice(0, 120));
  const gr = await req("POST", "/api/auth/register", { email: guestE, password: pw });
  ok("guest-reg", gr.status === 201 && gr.json && gr.json.token, gr.status + " " + gr.text.slice(0, 120));
  const cr = await req("POST", "/api/auth/register", { email: ctrlE, password: pw });
  ok("ctrl-reg", cr.status === 201 && cr.json && cr.json.token, cr.status + " " + cr.text.slice(0, 120));
  const sr = await req("POST", "/api/auth/register", { email: strE, password: pw });
  ok("str-reg", sr.status === 201 && sr.json && sr.json.token, sr.status + " " + sr.text.slice(0, 120));
  const orr = await req("POST", "/api/auth/register", { email: otherE, password: pw });
  ok("other-reg", orr.status === 201 && orr.json && orr.json.token, orr.status + " " + orr.text.slice(0, 120));
  if (!ar.json.token || !gr.json.token || !cr.json.token || !sr.json.token || !orr.json.token) fatalGate("bearer tokens missing");
  const toks = [ar.json.token, gr.json.token, cr.json.token, sr.json.token, orr.json.token];
  if (new Set(toks).size !== 5) fatalGate("bearer tokens must be distinct");
  ok("gate-bearer-distinct", true);
  const adminT = ar.json.token, guestT = gr.json.token, ctrlT = cr.json.token, strT = sr.json.token, otherT = orr.json.token;
  const b = await req("POST", "/api/boards", { name: run + "-b" }, B(adminT));
  ok("board-create", b.status === 201 && b.json && b.json.id, b.status + " " + b.text.slice(0, 160));
  if (!b.json || !b.json.id) fatalGate("board setup failed");
  const bid = b.json.id;
  const m1 = await req("POST", "/api/boards/" + bid + "/meetings", { title: "m1", brief: "b" }, B(adminT));
  const mid1 = m1.json && m1.json.id; ok("m1-create", m1.status === 201 && mid1, m1.status + " " + m1.text.slice(0, 120));
  const m2 = await req("POST", "/api/boards/" + bid + "/meetings", { title: "m2", brief: "b" }, B(adminT));
  const mid2 = m2.json && m2.json.id; ok("m2-create", m2.status === 201 && mid2, m2.status + " " + m2.text.slice(0, 120));
  if (!mid1 || !mid2) fatalGate("meeting setup failed");
  const gg = await req("POST", "/api/boards/" + bid + "/grants", { userKey: guestE, access: "discuss", meetingId: mid1 }, B(adminT));
  ok("grant-guest-m1", gg.status === 201, gg.status + " " + gg.text.slice(0, 160));
  const gc = await req("POST", "/api/boards/" + bid + "/grants", { userKey: ctrlE, access: "contribute", meetingId: mid1 }, B(adminT));
  ok("grant-ctrl-m1", gc.status === 201, gc.status + " " + gc.text.slice(0, 160));
  const go = await req("POST", "/api/boards/" + bid + "/grants", { userKey: otherE, access: "discuss", meetingId: mid2 }, B(adminT));
  ok("grant-other-m2", go.status === 201, go.status + " " + go.text.slice(0, 160));
  if (gg.status !== 201 || gc.status !== 201 || go.status !== 201) fatalGate("grant setup incomplete");
  ok("gate-setup-complete", true);
  const mk = (tok) => track(new HubConnectionBuilder().withUrl(API + "/hubs/board", { accessTokenFactory: () => tok }).build());
  const d1 = mk(guestT); await d1.start(); let f1 = false; try { await d1.invoke("JoinMeeting", mid2); } catch { f1 = true; } ok("deny-other-meeting-separate-conn", f1, "guest joined M2"); try { await d1.stop(); } catch {}
  const d2 = mk(guestT); await d2.start(); let f2 = false; try { await d2.invoke("JoinBoard", bid); } catch { f2 = true; } ok("deny-board-group-separate-conn", f2, "guest joined board"); try { await d2.stop(); } catch {}
  const d3 = mk(strT); await d3.start(); let f3 = false; try { await d3.invoke("JoinMeeting", mid1); } catch { f3 = true; } ok("deny-stranger-separate-conn", f3, "stranger joined"); try { await d3.stop(); } catch {}
  const d4 = mk("00".repeat(32)); let f4 = false; try { await d4.start(); await d4.invoke("JoinMeeting", mid1); } catch { f4 = true; } ok("invalid-token-denied", f4, "bogus token joined"); try { await d4.stop(); } catch {}
  const gAmsgs = []; let gArev = 0; let gAclosed = false;
  const gA = mk(guestT); gA.on("message", (m) => gAmsgs.push(m)); gA.on("access-revoked", () => { gArev++; }); gA.onclose(() => { gAclosed = true; });
  const gBmsgs = []; let gBrev = 0; let gBclosed = false;
  const gB = mk(guestT); gB.on("message", (m) => gBmsgs.push(m)); gB.on("access-revoked", () => { gBrev++; }); gB.onclose(() => { gBclosed = true; });
  const cMsgs = []; let cClosed = false;
  const cC = mk(ctrlT); cC.on("message", (m) => cMsgs.push(m)); cC.onclose(() => { cClosed = true; });
  const oMsgs = [];
  const oC = mk(otherT); oC.on("message", (m) => oMsgs.push(m));
  const multiMsgs = []; let multiRev = 0; let multiClosed = false;
  const multi = mk(guestT); multi.on("message", (m) => multiMsgs.push(m)); multi.on("access-revoked", () => { multiRev++; }); multi.onclose(() => { multiClosed = true; });
  await gA.start(); await gA.invoke("JoinMeeting", mid1); ok("guestA-join-live", true);
  await gB.start(); await gB.invoke("JoinMeeting", mid1); ok("guestB-join-live", true);
  await cC.start(); await cC.invoke("JoinMeeting", mid1); ok("control-join-live", true);
  await oC.start(); await oC.invoke("JoinMeeting", mid2); ok("unrelated-join-live", true);
  await multi.start(); await multi.invoke("JoinMeeting", mid1); await multi.invoke("JoinMeeting", mid2); ok("multi-join-both", true);
  const pre1 = "pre1-" + run;
  const post1 = await req("POST", "/api/meetings/" + mid1 + "/messages", { content: pre1 }, B(adminT));
  ok("post-pre1-201", post1.status === 201 && post1.json && post1.json.Sequence, post1.status + " " + post1.text.slice(0, 160));
  const seq1 = post1.json && post1.json.Sequence;
  const pre2 = "pre2-" + run;
  const post2 = await req("POST", "/api/meetings/" + mid2 + "/messages", { content: pre2 }, B(adminT));
  ok("post-pre2-201", post2.status === 201 && post2.json && post2.json.Sequence, post2.status + " " + post2.text.slice(0, 160));
  const seq2 = post2.json && post2.json.Sequence;
  function hasMarker(arr, seq, content) {
    for (const m of arr) {
      const s = m && (m.Sequence !== undefined ? m.Sequence : (m.sequence !== undefined ? m.sequence : (m.Seq !== undefined ? m.Seq : null)));
      const c = m && (m.Content !== undefined ? m.Content : (m.content !== undefined ? m.content : null));
      if (s === seq && c === content) return true;
    }
    return false;
  }
  ok("positive-guestA-exact", await waitFor(async () => hasMarker(gAmsgs, seq1, pre1), 10000), "guestA missing seq " + seq1);
  ok("positive-guestB-exact", await waitFor(async () => hasMarker(gBmsgs, seq1, pre1), 10000), "guestB missing seq " + seq1);
  ok("positive-multi-m1-exact", await waitFor(async () => hasMarker(multiMsgs, seq1, pre1), 10000), "multi missing m1");
  ok("positive-multi-m2-exact", await waitFor(async () => hasMarker(multiMsgs, seq2, pre2), 10000), "multi missing m2");
  ok("positive-control-exact", await waitFor(async () => hasMarker(cMsgs, seq1, pre1), 10000), "control missing");
  ok("positive-unrelated-exact", await waitFor(async () => hasMarker(oMsgs, seq2, pre2), 10000), "unrelated missing");
  const grants = await req("GET", "/api/boards/" + bid + "/grants", undefined, B(adminT));
  ok("grant-list-200", grants.status === 200, grants.status + " " + grants.text.slice(0, 120));
  const tgt = (Array.isArray(grants.json) ? grants.json : []).find((x) => (((x.userKey || x.UserKey) || "").toLowerCase() === guestE) && ((x.meetingId || x.MeetingId) === mid1));
  ok("grant-found", !!tgt, "grants=" + (Array.isArray(grants.json) ? grants.json.length : "?"));
  if (!tgt) fatalGate("revoke target missing");
  const gAbefore = gAmsgs.length, gBbefore = gBmsgs.length, mBefore = multiMsgs.length, cBefore = cMsgs.length;
  const delG = await req("DELETE", "/api/grants/" + (tgt.id || tgt.Id), undefined, B(adminT));
  ok("grant-delete-204", delG.status === 204, delG.status + " " + delG.text.slice(0, 120));
  if (delG.status !== 204) fatalGate("grant delete must be 204");
  const postMark = "post-" + run;
  const postAfter = await req("POST", "/api/meetings/" + mid1 + "/messages", { content: postMark }, B(adminT));
  ok("post-after-delete-201", postAfter.status === 201 && postAfter.json && postAfter.json.Sequence, postAfter.status + " " + postAfter.text.slice(0, 160));
  const seqAfter = postAfter.json && postAfter.json.Sequence;
  const revA = await waitFor(async () => gArev >= 1, remaining());
  const closeA = await waitFor(async () => gAclosed === true, remaining());
  ok("revokeA-event-AND-closed", revA && closeA, "rev=" + gArev + " closed=" + gAclosed);
  const revB = await waitFor(async () => gBrev >= 1, remaining());
  const closeB = await waitFor(async () => gBclosed === true, remaining());
  ok("revokeB-event-AND-closed", revB && closeB, "rev=" + gBrev + " closed=" + gBclosed);
  const revM = await waitFor(async () => multiRev >= 1, remaining());
  const closeM = await waitFor(async () => multiClosed === true, remaining());
  ok("revokeMulti-event-AND-closed", revM && closeM, "rev=" + multiRev + " closed=" + multiClosed);
  await sleep(1500);
  ok("revoked-guestA-zero", gAmsgs.length === gAbefore && !hasMarker(gAmsgs, seqAfter, postMark), "before=" + gAbefore + " after=" + gAmsgs.length);
  ok("revoked-guestB-zero", gBmsgs.length === gBbefore && !hasMarker(gBmsgs, seqAfter, postMark), "before=" + gBbefore + " after=" + gBmsgs.length);
  ok("revoked-multi-zero", multiMsgs.length === mBefore && !hasMarker(multiMsgs, seqAfter, postMark), "before=" + mBefore + " after=" + multiMsgs.length);
  ok("control-still-receives-exact", await waitFor(async () => hasMarker(cMsgs, seqAfter, postMark), remaining()), "control missing seq " + seqAfter);
  const restAfter = await req("GET", "/api/meetings/" + mid1 + "/messages?take=5", undefined, B(guestT));
  ok("revoked-rest-403", restAfter.status === 403, restAfter.status + " " + restAfter.text.slice(0, 120));
  if (restAfter.status !== 403) fatalGate("revoked REST must be 403");
  const gj = mk(guestT);
  let rejoinDenied = false;
  try { await gj.start(); await gj.invoke("JoinMeeting", mid1); } catch { rejoinDenied = true; } finally { try { await gj.stop(); } catch {} }
  ok("revoked-rejoin-denied", rejoinDenied, "rejoin succeeded");
  try { await gA.stop(); } catch {} try { await gB.stop(); } catch {} try { await multi.stop(); } catch {}
  const rg1 = await req("POST", "/api/boards/" + bid + "/grants", { userKey: guestE, access: "discuss", meetingId: mid1 }, B(adminT));
  ok("regrant-m1-201", rg1.status === 201, rg1.status + " " + rg1.text.slice(0, 160));
  const rg2 = await req("POST", "/api/boards/" + bid + "/grants", { userKey: guestE, access: "discuss", meetingId: mid2 }, B(adminT));
  ok("regrant-m2-201", rg2.status === 201, rg2.status + " " + rg2.text.slice(0, 160));
  const rj1 = await req("POST", "/api/meetings/" + mid1 + "/join", {}, B(guestT));
  ok("regrant-explicit-join-mid1-200", rj1.status === 200, rj1.status + " " + rj1.text.slice(0, 160));
  if (rj1.status !== 200) fatalGate("explicit join mid1 must be 200");
  const rj2 = await req("POST", "/api/meetings/" + mid2 + "/join", {}, B(guestT));
  ok("regrant-explicit-join-mid2-200", rj2.status === 200, rj2.status + " " + rj2.text.slice(0, 160));
  if (rj2.status !== 200) fatalGate("explicit join mid2 must be 200");
  const memAfterJoin = await req("GET", "/api/me/memberships", undefined, B(guestT));
  ok("membership-read-200", memAfterJoin.status === 200, memAfterJoin.status + " " + memAfterJoin.text.slice(0, 120));
  const rowsJoin = Array.isArray(memAfterJoin.json) ? memAfterJoin.json : [];
  const r1 = rowsJoin.find((x) => (x.meetingId || x.MeetingId) === mid1);
  const r2 = rowsJoin.find((x) => (x.meetingId || x.MeetingId) === mid2);
  ok("membership-mid1-id-not-empty", !!r1 && !!((r1.id || r1.Id)), "missing m1 id");
  ok("membership-mid2-id-not-empty", !!r2 && !!((r2.id || r2.Id)), "missing m2 id");
  ok("membership-mid1-active", !!r1 && (r1.active !== false) && !!(r1.joinedAt || r1.JoinedAt), "inactive");
  const mAmsgs = []; let mArev = 0; let mAclosed = false;
  const mA = mk(guestT); mA.on("message", (m) => mAmsgs.push(m)); mA.on("access-revoked", () => { mArev++; }); mA.onclose(() => { mAclosed = true; });
  const mBmsgs = []; let mBrev = 0; let mBclosed = false;
  const mB = mk(guestT); mB.on("message", (m) => mBmsgs.push(m)); mB.on("access-revoked", () => { mBrev++; }); mB.onclose(() => { mBclosed = true; });
  const mCmsgs = []; let mCrev = 0; let mCclosed = false;
  const mC = mk(guestT); mC.on("message", (m) => mCmsgs.push(m)); mC.on("access-revoked", () => { mCrev++; }); mC.onclose(() => { mCclosed = true; });
  const c2msgs = []; const c2 = mk(ctrlT); c2.on("message", (m) => c2msgs.push(m));
  await mA.start(); await mA.invoke("JoinMeeting", mid1);
  await mB.start(); await mB.invoke("JoinMeeting", mid1);
  await mC.start(); await mC.invoke("JoinMeeting", mid1); await mC.invoke("JoinMeeting", mid2);
  await c2.start(); await c2.invoke("JoinMeeting", mid1);
  const mpre = "multi2-" + run;
  const mpost = await req("POST", "/api/meetings/" + mid1 + "/messages", { content: mpre }, B(adminT));
  const mseq = mpost.json && mpost.json.Sequence;
  ok("multi-post-201", mpost.status === 201 && mseq, mpost.status + " " + mpost.text.slice(0, 120));
  ok("multi-A-exact", await waitFor(async () => hasMarker(mAmsgs, mseq, mpre), remaining()), "mA missing");
  ok("multi-B-exact", await waitFor(async () => hasMarker(mBmsgs, mseq, mpre), remaining()), "mB missing");
  ok("multi-C-exact", await waitFor(async () => hasMarker(mCmsgs, mseq, mpre), remaining()), "mC missing");
  ok("multi-control-exact", await waitFor(async () => hasMarker(c2msgs, mseq, mpre), remaining()), "c2 missing");
  const grants2 = await req("GET", "/api/boards/" + bid + "/grants", undefined, B(adminT));
  const tgt1 = (Array.isArray(grants2.json) ? grants2.json : []).find((x) => (((x.userKey || x.UserKey) || "").toLowerCase() === guestE) && ((x.meetingId || x.MeetingId) === mid1));
  ok("multi-grant-found", !!tgt1, "missing");
  const mAbef = mAmsgs.length, mBbef = mBmsgs.length, mCbef = mCmsgs.length, c2bef = c2msgs.length;
  const del2 = await req("DELETE", "/api/grants/" + (tgt1.id || tgt1.Id), undefined, B(adminT));
  ok("multi-grant-delete-204", del2.status === 204, del2.status + " " + del2.text.slice(0, 120));
  const mpostMark = "mpost-" + run;
  const mpostAfter = await req("POST", "/api/meetings/" + mid1 + "/messages", { content: mpostMark }, B(adminT));
  const mseqAfter = mpostAfter.json && mpostAfter.json.Sequence;
  ok("multi-post-after-201", mpostAfter.status === 201 && mseqAfter, mpostAfter.status + " " + mpostAfter.text.slice(0, 120));
  const rA = await waitFor(async () => mArev >= 1, remaining()); const cA = await waitFor(async () => mAclosed === true, remaining());
  ok("multi-A-event-AND-closed", rA && cA, "rev=" + mArev + " closed=" + mAclosed);
  const rB = await waitFor(async () => mBrev >= 1, remaining()); const cB = await waitFor(async () => mBclosed === true, remaining());
  ok("multi-B-event-AND-closed", rB && cB, "rev=" + mBrev + " closed=" + mBclosed);
  const rC = await waitFor(async () => mCrev >= 1, remaining()); const cC2 = await waitFor(async () => mCclosed === true, remaining());
  ok("multi-C-event-AND-closed", rC && cC2, "rev=" + mCrev + " closed=" + mCclosed);
  await sleep(1200);
  ok("multi-A-zero", mAmsgs.length === mAbef && !hasMarker(mAmsgs, mseqAfter, mpostMark), "leak A");
  ok("multi-B-zero", mBmsgs.length === mBbef && !hasMarker(mBmsgs, mseqAfter, mpostMark), "leak B");
  ok("multi-C-zero", mCmsgs.length === mCbef && !hasMarker(mCmsgs, mseqAfter, mpostMark), "leak C");
  ok("multi-control-receives", await waitFor(async () => hasMarker(c2msgs, mseqAfter, mpostMark), remaining()), "control missing after");
  try { await mA.stop(); } catch {} try { await mB.stop(); } catch {} try { await mC.stop(); } catch {} try { await c2.stop(); } catch {}
  const rg3 = await req("POST", "/api/boards/" + bid + "/grants", { userKey: guestE, access: "discuss", meetingId: mid1 }, B(adminT));
  ok("leave-setup-regrant-201", rg3.status === 201, rg3.status + " " + rg3.text.slice(0, 120));
  const lvMsgs = []; let lvRev = 0; let lvClosed = false;
  const lv = mk(guestT); lv.on("message", (m) => lvMsgs.push(m)); lv.on("access-revoked", () => { lvRev++; }); lv.onclose(() => { lvClosed = true; });
  await lv.start(); await lv.invoke("JoinMeeting", mid1); ok("leave-live-join", true);
  const lvBef = lvMsgs.length;
  const leaveR = await req("POST", "/api/meetings/" + mid1 + "/leave", {}, B(guestT));
  ok("live-explicit-leave-200", leaveR.status === 200, leaveR.status + " " + leaveR.text.slice(0, 120));
  if (leaveR.status !== 200) fatalGate("leave must be 200");
  const leaveMark = "leavemark-" + run;
  const leavePost = await req("POST", "/api/meetings/" + mid1 + "/messages", { content: leaveMark }, B(adminT));
  const leaveSeq = leavePost.json && leavePost.json.Sequence;
  const lvR = await waitFor(async () => lvRev >= 1, remaining());
  const lvC = await waitFor(async () => lvClosed === true, remaining());
  ok("leave-event-AND-closed", lvR && lvC, "rev=" + lvRev + " closed=" + lvClosed);
  await sleep(1200);
  ok("leave-exact-zero", lvMsgs.length === lvBef && !hasMarker(lvMsgs, leaveSeq, leaveMark), "leak after leave");
  const otherAfterLeave = await req("GET", "/api/meetings/" + mid2 + "/messages?take=5", undefined, B(guestT));
  ok("same-user-other-grant-usable", otherAfterLeave.status === 200, otherAfterLeave.status + " " + otherAfterLeave.text.slice(0, 120));
  const lvOther = mk(guestT); let lvOtherOk = false;
  try { await lvOther.start(); await lvOther.invoke("JoinMeeting", mid2); lvOtherOk = true; } catch {} finally { try { await lvOther.stop(); } catch {} }
  ok("same-user-other-hub-usable", lvOtherOk, "other grant hub denied after leave");
  const lvRejoin = mk(guestT); let lvDenied = false;
  try { await lvRejoin.start(); await lvRejoin.invoke("JoinMeeting", mid1); } catch { lvDenied = true; } finally { try { await lvRejoin.stop(); } catch {} }
  ok("leave-rejoin-denied", lvDenied, "rejoin after leave succeeded");
  const lvRest = await req("GET", "/api/meetings/" + mid1 + "/messages?take=5", undefined, B(guestT));
  ok("leave-rest-403", lvRest.status === 403, lvRest.status + " " + lvRest.text.slice(0, 120));
  if (lvRest.status !== 403) fatalGate("leave REST must be 403");
  const lvMem = await req("GET", "/api/me/memberships", undefined, B(guestT));
  ok("leave-membership-gone", lvMem.status === 200 && !(Array.isArray(lvMem.json) ? lvMem.json : []).some((x) => (x.meetingId || x.MeetingId) === mid1), lvMem.text.slice(0, 160));
  const admMem = await req("GET", "/api/boards/" + bid + "/memberships", undefined, B(adminT));
  const admRow = (Array.isArray(admMem.json) ? admMem.json : []).find((x) => ((x.meetingId || x.MeetingId) === mid1) && ((((x.userKey || x.UserKey)) || "").toLowerCase() === guestE));
  ok("leave-membership-inactive-stamped", !!admRow && admRow.active !== true && !!(admRow.leftAt || admRow.LeftAt), JSON.stringify(admRow).slice(0, 200));
  await req("POST", "/api/auth/logout", {}, B(guestT));
  const relog = await req("POST", "/api/auth/login", { email: guestE, password: pw });
  ok("relogin-ok", relog.status === 200 && relog.json && relog.json.token, relog.status + " " + relog.text.slice(0, 120));
  const guestT2 = relog.json.token;
  const afterLogin = await req("GET", "/api/meetings/" + mid1 + "/messages?take=5", undefined, B(guestT2));
  ok("reload-login-no-resurrection", afterLogin.status === 403, afterLogin.status + " " + afterLogin.text.slice(0, 160));
  const afterMem = await req("GET", "/api/me/memberships", undefined, B(guestT2));
  ok("reload-login-no-membership", afterMem.status === 200 && !(Array.isArray(afterMem.json) ? afterMem.json : []).some((x) => (x.meetingId || x.MeetingId) === mid1), afterMem.text.slice(0, 160));
  const lj = mk(guestT2); let ljDenied = false;
  try { await lj.start(); await lj.invoke("JoinMeeting", mid1); } catch { ljDenied = true; } finally { try { await lj.stop(); } catch {} }
  ok("reload-login-hub-denied", ljDenied, "hub resurrected after login");
  await req("POST", "/api/boards/" + bid + "/repair-access", {}, B(adminT));
  const repRest = await req("GET", "/api/meetings/" + mid1 + "/messages?take=5", undefined, B(guestT2));
  ok("repair-no-resurrection", repRest.status === 403, repRest.status + " " + repRest.text.slice(0, 160));
  const otherRead = await req("GET", "/api/meetings/" + mid2 + "/messages?take=5", undefined, B(otherT));
  ok("unrelated-grant-preserved", otherRead.status === 200, otherRead.status + " " + otherRead.text.slice(0, 160));
  const ctrlRead = await req("GET", "/api/meetings/" + mid1 + "/messages?take=5", undefined, B(ctrlT));
  ok("control-grant-preserved", ctrlRead.status === 200, ctrlRead.status + " " + ctrlRead.text.slice(0, 120));
  try { await lv.stop(); } catch {} try { await cC.stop(); } catch {} try { await oC.stop(); } catch {} try { await gA.stop(); } catch {} try { await gB.stop(); } catch {} try { await multi.stop(); } catch {}
  console.log("FINAL pass=" + pass + " fail=" + fail);
  if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
  process.exitCode = fail === 0 ? 0 : 1;
}
(async () => {
  try { await main(); } catch (e) {
    if (process.exitCode !== 2) { console.log("HARNESS-ERROR " + (e && e.stack || e)); process.exitCode = 2; }
  } finally { try { await closeAll(); } catch {} }
})();
