const { HubConnectionBuilder } = require("../web/node_modules/@microsoft/signalr/dist/cjs/index.js");
const API = process.env.QA_API || "http://127.0.0.1:15340";
const run = "p8ss-" + Date.now().toString(36);
let pass = 0, fail = 0; const bad = [];
function ok(n, c, e) { if (c) { pass++; console.log("  ok - " + n); } else { fail++; bad.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
async function req(method, path, body, headers) {
  const r = await fetch(API + path, { method, headers: { "content-type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} return { status: r.status, json: j, text: t };
}
const B = (t) => (t ? { Authorization: "Bearer " + t } : {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await sleep(250); }
  return false;
}
(async () => {
  console.log("strict-signalr run=" + run + " api=" + API);
  const pw = "TestPassword123!";
  const adminE = run + "-admin@example.com", guestE = run + "-guest@example.com", ctrlE = run + "-ctrl@example.com", strE = run + "-str@example.com", otherE = run + "-other@example.com";
  const ar = await req("POST", "/api/auth/register", { email: adminE, password: pw }); ok("admin-reg", ar.status === 201 && ar.json && ar.json.token, ar.status + " " + ar.text.slice(0, 120));
  const gr = await req("POST", "/api/auth/register", { email: guestE, password: pw }); ok("guest-reg", gr.status === 201 && gr.json && gr.json.token, gr.status + " " + gr.text.slice(0, 120));
  const cr = await req("POST", "/api/auth/register", { email: ctrlE, password: pw }); ok("ctrl-reg", cr.status === 201 && cr.json && cr.json.token, cr.status + " " + cr.text.slice(0, 120));
  const sr = await req("POST", "/api/auth/register", { email: strE, password: pw }); ok("str-reg", sr.status === 201, sr.status + " " + sr.text.slice(0, 120));
  const or = await req("POST", "/api/auth/register", { email: otherE, password: pw }); ok("other-reg", or.status === 201, or.status + " " + or.text.slice(0, 120));
  const adminT = ar.json.token, guestT = gr.json.token, ctrlT = cr.json.token, strT = sr.json.token, otherT = or.json.token;
  const b = await req("POST", "/api/boards", { name: run + "-b" }, B(adminT)); ok("board-create", b.status === 201 && b.json && b.json.id, b.status + " " + b.text.slice(0, 160));
  const bid = b.json.id;
  const m1 = await req("POST", "/api/boards/" + bid + "/meetings", { title: "m1", brief: "b" }, B(adminT)); const mid1 = m1.json.id; ok("m1-create", m1.status === 201 && mid1, m1.status + " " + m1.text.slice(0, 120));
  const m2 = await req("POST", "/api/boards/" + bid + "/meetings", { title: "m2", brief: "b" }, B(adminT)); const mid2 = m2.json.id; ok("m2-create", m2.status === 201 && mid2, m2.status + " " + m2.text.slice(0, 120));
  let gg = await req("POST", "/api/boards/" + bid + "/grants", { userKey: guestE, access: "discuss", meetingId: mid1 }, B(adminT)); ok("grant-guest-m1", gg.status === 201, gg.status + " " + gg.text.slice(0, 160));
  let gc = await req("POST", "/api/boards/" + bid + "/grants", { userKey: ctrlE, access: "contribute", meetingId: mid1 }, B(adminT)); ok("grant-ctrl-m1", gc.status === 201, gc.status + " " + gc.text.slice(0, 160));
  let go = await req("POST", "/api/boards/" + bid + "/grants", { userKey: otherE, access: "discuss", meetingId: mid2 }, B(adminT)); ok("grant-other-m2", go.status === 201, go.status + " " + go.text.slice(0, 160));
  const mk = (tok) => new HubConnectionBuilder().withUrl(API + "/hubs/board", { accessTokenFactory: () => tok }).build();
  const d1 = mk(guestT); await d1.start(); let f1 = false; try { await d1.invoke("JoinMeeting", mid2); } catch { f1 = true; } ok("deny-other-meeting-separate-conn", f1, "guest joined M2"); try { await d1.stop(); } catch {}
  const d2 = mk(guestT); await d2.start(); let f2 = false; try { await d2.invoke("JoinBoard", bid); } catch { f2 = true; } ok("deny-board-group-separate-conn", f2, "guest joined board"); try { await d2.stop(); } catch {}
  const d3 = mk(strT); await d3.start(); let f3 = false; try { await d3.invoke("JoinMeeting", mid1); } catch { f3 = true; } ok("deny-stranger-separate-conn", f3, "stranger joined"); try { await d3.stop(); } catch {}
  const d4 = mk("00".repeat(32)); let f4 = false; try { await d4.start(); await d4.invoke("JoinMeeting", mid1); } catch { f4 = true; } ok("invalid-token-denied", f4, "bogus token joined (labeled invalid, NOT natural expiry)"); try { await d4.stop(); } catch {}
  const guestMsgs = []; const ctrlMsgs = []; let guestRevoked = 0; let guestClosed = false;
  const g = mk(guestT); const c = mk(ctrlT);
  g.on("message", (m) => guestMsgs.push(m)); g.on("access-revoked", () => { guestRevoked++; }); g.onclose(() => { guestClosed = true; });
  c.on("message", (m) => ctrlMsgs.push(m));
  await g.start(); await g.invoke("JoinMeeting", mid1); ok("guest-join-live", true);
  await c.start(); await c.invoke("JoinMeeting", mid1); ok("control-join-live", true);
  await req("POST", "/api/meetings/" + mid1 + "/messages", { content: "owner hello" }, B(adminT));
  const mem1 = await req("GET", "/api/me/memberships", undefined, B(guestT));
  const rows1 = Array.isArray(mem1.json) ? mem1.json : [];
  const row1 = rows1.find((x) => (x.meetingId || x.MeetingId) === mid1);
  ok("durable-membership-created", mem1.status === 200 && !!row1 && row1.active !== false, mem1.status + " " + mem1.text.slice(0, 200));
  const joinedAt1 = row1 && (row1.joinedAt || row1.JoinedAt);
  const allMem = await req("GET", "/api/boards/" + bid + "/memberships", undefined, B(adminT));
  const dupes = Array.isArray(allMem.json) ? allMem.json.filter((x) => ((x.meetingId || x.MeetingId) === mid1) && (((x.userKey || x.UserKey) || "").toLowerCase() === guestE)) : [];
  ok("durable-membership-unique", dupes.length === 1, "rows=" + dupes.length);
  await g.stop();
  await sleep(800);
  const memDisc = await req("GET", "/api/me/memberships", undefined, B(guestT));
  ok("disconnect-preserves-membership", memDisc.status === 200 && (Array.isArray(memDisc.json) ? memDisc.json : []).some((x) => (x.meetingId || x.MeetingId) === mid1), memDisc.text.slice(0, 160));
  const gR = mk(guestT); const guestMsgs2 = []; gR.on("message", (m) => guestMsgs2.push(m)); gR.on("access-revoked", () => { guestRevoked++; }); gR.onclose(() => { guestClosed = true; });
  await gR.start(); await gR.invoke("JoinMeeting", mid1); ok("reconnect-join-ok", true);
  const mem2 = await req("GET", "/api/me/memberships", undefined, B(guestT));
  const row2 = (Array.isArray(mem2.json) ? mem2.json : []).find((x) => (x.meetingId || x.MeetingId) === mid1);
  ok("reconnect-preserves-joinedAt", !!row2 && (row2.joinedAt || row2.JoinedAt) === joinedAt1, "before=" + joinedAt1 + " after=" + ((row2 && (row2.joinedAt || row2.JoinedAt)) || "none"));
  try { await gR.stop(); } catch {}
  const g2 = mk(guestT); const gm2 = []; let gr2 = 0; let gc2 = false;
  g2.on("message", (m) => gm2.push(m)); g2.on("access-revoked", () => { gr2++; }); g2.onclose(() => { gc2 = true; });
  const c2 = mk(ctrlT); const cm2 = []; c2.on("message", (m) => cm2.push(m));
  await g2.start(); await g2.invoke("JoinMeeting", mid1);
  await c2.start(); await c2.invoke("JoinMeeting", mid1);
  const preMark = "pre-" + run;
  await req("POST", "/api/meetings/" + mid1 + "/messages", { content: preMark }, B(adminT));
  ok("positive-delivery-guest", await waitFor(async () => gm2.length >= 1, 8000), "guest got " + gm2.length);
  ok("positive-delivery-control", await waitFor(async () => cm2.length >= 1, 8000), "control got " + cm2.length);
  const gBefore = gm2.length, cBefore = cm2.length;
  const grants = await req("GET", "/api/boards/" + bid + "/grants", undefined, B(adminT));
  const tgt = (Array.isArray(grants.json) ? grants.json : []).find((x) => ((x.userKey || x.UserKey) || "").toLowerCase() === guestE && ((x.meetingId || x.MeetingId) === mid1));
  ok("grant-found", !!tgt, "grants=" + (Array.isArray(grants.json) ? grants.json.length : "?"));
  const delG = tgt ? await req("DELETE", "/api/grants/" + (tgt.id || tgt.Id), undefined, B(adminT)) : { status: 0, text: "no-target" };
  ok("grant-delete-204", delG.status === 204, delG.status + " " + (delG.text || "").slice(0, 120));
  ok("revoke-event-guest", await waitFor(async () => gr2 >= 1, 10000), "revoked events=" + gr2);
  ok("revoke-disconnects-guest", await waitFor(async () => gc2 === true, 10000), "closed=" + gc2);
  const postMark = "post-" + run;
  await req("POST", "/api/meetings/" + mid1 + "/messages", { content: postMark }, B(adminT));
  await sleep(3000);
  ok("revoked-conn-no-delivery", gm2.length === gBefore, "guest " + gBefore + "->" + gm2.length);
  ok("control-still-receives", cm2.length > cBefore, "control " + cBefore + "->" + cm2.length);
  const restAfter = await req("GET", "/api/meetings/" + mid1 + "/messages?take=5", undefined, B(guestT));
  ok("revoked-rest-403", restAfter.status === 403, restAfter.status + " " + restAfter.text.slice(0, 120));
  let rejoinDenied = false; const gj = mk(guestT);
  try { await gj.start(); await gj.invoke("JoinMeeting", mid1); } catch { rejoinDenied = true; } finally { try { await gj.stop(); } catch {} }
  ok("revoked-rejoin-denied", rejoinDenied, "rejoin succeeded");
  try { await g2.stop(); } catch {} try { await c2.stop(); } catch {}
  await req("POST", "/api/boards/" + bid + "/grants", { userKey: guestE, access: "discuss", meetingId: mid1 }, B(adminT));
  await req("POST", "/api/boards/" + bid + "/grants", { userKey: guestE, access: "discuss", meetingId: mid2 }, B(adminT));
  const rj1 = await req("POST", "/api/meetings/" + mid1 + "/join", {}, B(guestT));
  ok("regrant-explicit-join-mid1", rj1.status === 200, rj1.status + " " + rj1.text.slice(0,160));
  const rj2 = await req("POST", "/api/meetings/" + mid2 + "/join", {}, B(guestT));
  ok("regrant-explicit-join-mid2", rj2.status === 200, rj2.status + " " + rj2.text.slice(0,160));
  const multiMsgs = []; let multiClosed = false;
  const multi = mk(guestT);
  multi.on("message", (m) => multiMsgs.push(m)); multi.onclose(() => { multiClosed = true; });
  const soloA = mk(guestT); const soloB = mk(guestT);
  await multi.start(); await multi.invoke("JoinMeeting", mid1); await multi.invoke("JoinMeeting", mid2);
  await soloA.start(); await soloA.invoke("JoinMeeting", mid1);
  await soloB.start(); await soloB.invoke("JoinMeeting", mid1);
  await req("POST", "/api/meetings/" + mid1 + "/messages", { content: "multi-pre1" }, B(adminT));
  await req("POST", "/api/meetings/" + mid2 + "/messages", { content: "multi-pre2" }, B(adminT));
  await sleep(3000);
  const preCount = multiMsgs.length;
  ok("multi-both-delivered", preCount >= 2, "got " + preCount);
  const grants2 = await req("GET", "/api/boards/" + bid + "/grants", undefined, B(adminT));
  const tgt1 = (Array.isArray(grants2.json) ? grants2.json : []).find((x) => (((x.userKey || x.UserKey) || "").toLowerCase() === guestE) && ((x.meetingId || x.MeetingId) === mid1));
  if (tgt1) await req("DELETE", "/api/grants/" + (tgt1.id || tgt1.Id), undefined, B(adminT));
  const revokedAll = await waitFor(async () => multiClosed, 10000);
  ok("multi-no-survivor", revokedAll && multiMsgs.length === preCount, "closed=" + multiClosed + " pre=" + preCount + " post=" + multiMsgs.length);
  try { await multi.stop(); } catch {} try { await soloA.stop(); } catch {} try { await soloB.stop(); } catch {}
  await req("POST", "/api/boards/" + bid + "/grants", { userKey: guestE, access: "discuss", meetingId: mid1 }, B(adminT));
  const lvMsgs = []; let lvRev = 0; let lvClosed = false;
  const lv = mk(guestT);
  lv.on("message", (m) => lvMsgs.push(m)); lv.on("access-revoked", () => { lvRev++; }); lv.onclose(() => { lvClosed = true; });
  await lv.start(); await lv.invoke("JoinMeeting", mid1); ok("leave-live-join", true);
  const leaveR = await req("POST", "/api/meetings/" + mid1 + "/leave", {}, B(guestT));
  ok("live-explicit-leave-200", leaveR.status === 200, leaveR.status + " " + leaveR.text.slice(0, 120));
  ok("leave-terminates-live", await waitFor(async () => lvRev >= 1 || lvClosed, 10000), "rev=" + lvRev + " closed=" + lvClosed);
  const lvRejoin = mk(guestT); let lvDenied = false;
  try { await lvRejoin.start(); await lvRejoin.invoke("JoinMeeting", mid1); } catch { lvDenied = true; } finally { try { await lvRejoin.stop(); } catch {} }
  ok("leave-rejoin-denied", lvDenied, "rejoin after leave succeeded");
  const lvRest = await req("GET", "/api/meetings/" + mid1 + "/messages?take=5", undefined, B(guestT));
  ok("leave-rest-403", lvRest.status === 403, lvRest.status + " " + lvRest.text.slice(0, 120));
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
  try { await lv.stop(); } catch {} try { await c.stop(); } catch {} try { await g.stop(); } catch {}
  console.log("FINAL pass=" + pass + " fail=" + fail);
  if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("HARNESS-ERROR " + (e && e.stack || e)); process.exit(2); });