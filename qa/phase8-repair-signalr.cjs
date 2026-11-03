const { HubConnectionBuilder } = require("../web/node_modules/@microsoft/signalr/dist/cjs/index.js");
const API = process.env.QA_API || "http://127.0.0.1:5097";
const run = "p8rs-" + Date.now().toString(36);
let pass = 0, fail = 0; const bad = [];
function ok(n, c, e) { if (c) pass++; else { fail++; bad.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
async function req(method, path, body, headers) {
  const r = await fetch(API + path, { method, headers: { "content-type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} return { status: r.status, json: j, text: t };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  console.log("repair-signalr run=" + run + " api=" + API);
  const pw = "TestPassword123!";
  const adminE = run + "-admin@example.com", guestE = run + "-guest@example.com", strE = run + "-str@example.com";
  const B = (t) => ({ Authorization: "Bearer " + t });
  const ar = await req("POST", "/api/auth/register", { email: adminE, password: pw }); ok("admin-reg", ar.status === 201 && ar.json?.token, ar.status + " " + ar.text.slice(0, 120));
  const gr = await req("POST", "/api/auth/register", { email: guestE, password: pw }); ok("guest-reg", gr.status === 201 && gr.json?.token, gr.status + " " + gr.text.slice(0, 120));
  const sr = await req("POST", "/api/auth/register", { email: strE, password: pw }); ok("str-reg", sr.status === 201 && sr.json?.token, sr.status + " " + sr.text.slice(0, 120));
  const adminT = ar.json.token, guestT = gr.json.token, strT = sr.json.token;
  const b = await req("POST", "/api/boards", { name: run + "-b" }, B(adminT)); const bid = b.json.id;
  const m1 = await req("POST", `/api/boards/${bid}/meetings`, { title: "m1", brief: "b" }, B(adminT)); const mid1 = m1.json.id;
  const m2 = await req("POST", `/api/boards/${bid}/meetings`, { title: "m2", brief: "b" }, B(adminT)); const mid2 = m2.json.id;
  await req("POST", `/api/boards/${bid}/grants`, { userKey: guestE, access: "discuss", meetingId: mid1 }, B(adminT));
  const conn = (tok) => new HubConnectionBuilder().withUrl(API + "/hubs/board", { accessTokenFactory: () => tok }).withAutomaticReconnect().build();
  // denial cases on SEPARATE connections (never touch the live client)
  {
    const d1 = conn(guestT); await d1.start(); let denied = false;
    try { await d1.invoke("JoinMeeting", mid2); } catch { denied = true; }
    ok("deny-other-meeting-separate-conn", denied, "guest joined M2");
    try { await d1.stop(); } catch {}
    const d2 = conn(guestT); await d2.start(); let bdenied = false;
    try { await d2.invoke("JoinBoard", bid); } catch { bdenied = true; }
    ok("deny-board-group-separate-conn", bdenied, "guest joined broad board group");
    try { await d2.stop(); } catch {}
    const d3 = conn(strT); await d3.start(); let sdenied = false;
    try { await d3.invoke("JoinMeeting", mid1); } catch { sdenied = true; }
    ok("deny-stranger-separate-conn", sdenied, "stranger joined");
    try { await d3.stop(); } catch {}
  }
  // live authorized clients: guest + admin control on M1
  const guestMsgs = [], ctrlMsgs = []; let guestRevoked = 0;
  const g = conn(guestT); const c = conn(adminT);
  g.on("message", (m) => guestMsgs.push(m)); g.on("access-revoked", () => guestRevoked++);
  c.on("message", (m) => ctrlMsgs.push(m));
  await g.start(); await g.invoke("JoinMeeting", mid1); ok("guest-join-live", true);
  await c.start(); await c.invoke("JoinMeeting", mid1); ok("control-join-live", true);
  // positive observation BEFORE revocation
  await req("POST", `/api/meetings/${mid1}/messages`, { content: "pre-revoke ping" }, B(adminT));
  await sleep(2500);
  ok("positive-delivery-guest", guestMsgs.length >= 1, "guest got " + guestMsgs.length);
  ok("positive-delivery-control", ctrlMsgs.length >= 1, "control got " + ctrlMsgs.length);
  const gBefore = guestMsgs.length, cBefore = ctrlMsgs.length;
  // revoke: delete grant (board admin path)
  const grants = await req("GET", `/api/boards/${bid}/grants`, undefined, B(adminT));
  const gg = (grants.json || []).find((x) => x.userKey === guestE && x.meetingId === mid1);
  ok("grant-found", !!gg, JSON.stringify((grants.json || []).length));
  if (gg) await req("DELETE", `/api/grants/${gg.id}`, undefined, B(adminT));
  await sleep(2500);
  ok("revoke-event-guest", guestRevoked >= 1, "revoked events=" + guestRevoked);
  // publish again: SAME guest conn must NOT receive; control MUST
  await req("POST", `/api/meetings/${mid1}/messages`, { content: "post-revoke ping" }, B(adminT));
  await sleep(2500);
  ok("revoked-conn-no-delivery", guestMsgs.length === gBefore, `guest ${gBefore}->${guestMsgs.length}`);
  ok("control-still-receives", ctrlMsgs.length > cBefore, `control ${cBefore}->${ctrlMsgs.length}`);
  const restAfter = await req("GET", `/api/meetings/${mid1}/messages?take=5`, undefined, B(guestT));
  ok("revoked-rest-403", restAfter.status === 403, restAfter.status + " " + restAfter.text.slice(0, 120));
  let rejoinDenied = false; const g2 = conn(guestT);
  try { await g2.start(); await g2.invoke("JoinMeeting", mid1); } catch { rejoinDenied = true; } finally { try { await g2.stop(); } catch {} }
  ok("revoked-rejoin-denied", rejoinDenied, "rejoin succeeded");
  try { await g.stop(); } catch {} try { await c.stop(); } catch {}
  // multi-join: one connection joins M1 and M2; revoke M1; no subscription may survive
  await req("POST", `/api/boards/${bid}/grants`, { userKey: guestE, access: "discuss", meetingId: mid1 }, B(adminT));
  await req("POST", `/api/boards/${bid}/grants`, { userKey: guestE, access: "discuss", meetingId: mid2 }, B(adminT));
  const gmMsgs = []; let gmClosed = false;
  const gm = conn(guestT);
  gm.on("message", (m) => gmMsgs.push(m));
  gm.onclose(() => { gmClosed = true; });
  try {
    await gm.start(); await gm.invoke("JoinMeeting", mid1); await gm.invoke("JoinMeeting", mid2);
    await req("POST", `/api/meetings/${mid1}/messages`, { content: "multi pre1" }, B(adminT));
    await req("POST", `/api/meetings/${mid2}/messages`, { content: "multi pre2" }, B(adminT));
    await sleep(2500);
    const preCount = gmMsgs.length;
    ok("multi-both-delivered", preCount >= 2, "got " + preCount);
    const grants2 = await req("GET", `/api/boards/${bid}/grants`, undefined, B(adminT));
    const gg1 = (grants2.json || []).find((x) => x.userKey === guestE && x.meetingId === mid1);
    await req("DELETE", `/api/grants/${gg1.id}`, undefined, B(adminT));
    await sleep(2500);
    await req("POST", `/api/meetings/${mid1}/messages`, { content: "multi post1" }, B(adminT));
    await req("POST", `/api/meetings/${mid2}/messages`, { content: "multi post2" }, B(adminT));
    await sleep(2500);
    ok("multi-no-survivor", gmMsgs.length === preCount, `pre=${preCount} post=${gmMsgs.length} (whole-principal abort closes all scopes)`);
    await req("POST", `/api/boards/${bid}/grants`, { userKey: guestE, access: "discuss", meetingId: mid1 }, B(adminT));
    await req("POST", `/api/boards/${bid}/grants`, { userKey: guestE, access: "discuss", meetingId: mid2 }, B(adminT));
  } finally { try { await gm.stop(); } catch {} }
  // logout revokes live + token: re-grant, join, logout, rejoin must fail
  await req("POST", `/api/boards/${bid}/grants`, { userKey: guestE, access: "discuss", meetingId: mid1 }, B(adminT));
  const g3 = conn(guestT); await g3.start(); await g3.invoke("JoinMeeting", mid1); ok("regrant-join", true);
  const g3Msgs = []; let g3Closed = false, g3Revoked = 0;
  g3.on("message", (m) => g3Msgs.push(m));
  g3.onclose(() => { g3Closed = true; });
  g3.on("access-revoked", () => { g3Revoked++; });
  const c2 = conn(adminT); await c2.start(); await c2.invoke("JoinMeeting", mid1);
  const c2Msgs = []; c2.on("message", (m) => c2Msgs.push(m));
  await req("POST", `/api/meetings/${mid1}/messages`, { content: "pre-logout ping" }, B(adminT));
  await sleep(2000);
  const g3Pre = g3Msgs.length, c2Pre = c2Msgs.length;
  ok("logout-pre-both", g3Pre >= 1 && c2Pre >= 1, `g3=${g3Pre} c2=${c2Pre}`);
  await req("POST", "/api/auth/logout", {}, B(guestT));
  await sleep(2500);
  ok("logout-aborts-conn", g3Closed || g3Revoked >= 1, `closed=${g3Closed} revoked=${g3Revoked}`);
  await req("POST", `/api/meetings/${mid1}/messages`, { content: "post-logout ping" }, B(adminT));
  await sleep(2500);
  ok("logout-same-client-no-delivery", g3Msgs.length === g3Pre, `g3 ${g3Pre}->${g3Msgs.length}`);
  ok("logout-control-receives", c2Msgs.length > c2Pre, `c2 ${c2Pre}->${c2Msgs.length}`);
  try { await c2.stop(); } catch {}
  let afterLogoutDenied = false; const g4 = conn(guestT);
  try { await g4.start(); await g4.invoke("JoinMeeting", mid1); } catch { afterLogoutDenied = true; } finally { try { await g4.stop(); } catch {} }
  ok("logout-rejoin-denied", afterLogoutDenied, "old token still joins after logout");
  const restLogout = await req("GET", `/api/meetings/${mid1}/messages?take=5`, undefined, B(guestT));
  ok("logout-rest-401", restLogout.status === 401, restLogout.status + " " + restLogout.text.slice(0, 120));
  try { await g3.stop(); } catch {}
  console.log(`FINAL pass=${pass} fail=${fail}`);
  if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("HARNESS-ERROR " + (e && e.stack || e)); process.exit(2); });
