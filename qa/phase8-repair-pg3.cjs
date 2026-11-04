const API = process.env.QA_API || "http://127.0.0.1:15441";
const run = process.env.QA_RUN || "p8pg-mw00f8zl";
let pass = 0, fail = 0; const bad = [];
function ok(n, c, e) { if (c) pass++; else { fail++; bad.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
async function req(method, path, body, headers) {
  const r = await fetch(API + path, { method, headers: { "content-type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} return { status: r.status, json: j, text: t };
}
(async () => {
  console.log("repair-pg3 run=" + run);
  const pw = "TestPassword123!";
  const B = (t) => ({ Authorization: "Bearer " + t });
  const gl = await req("POST", "/api/auth/login", { email: run + "-pgguest@example.com", password: pw });
  ok("pg3-guest-relogin", gl.status === 200 && gl.json?.token, gl.status + " " + gl.text.slice(0, 120));
  const al = await req("POST", "/api/auth/login", { email: run + "-pgadmin@example.com", password: pw });
  const adminT = al.json?.token, guestT = gl.json?.token;
  const boards = await req("GET", "/api/boards", undefined, B(adminT));
  const found = (Array.isArray(boards.json) ? boards.json : []).find((x) => (x.name || x.Name) === run + "-pgb");
  const bid = found?.id || found?.Id;
  const grants = await req("GET", `/api/boards/${bid}/grants`, undefined, B(adminT));
  const stillOut = (Array.isArray(grants.json) ? grants.json : []).filter((g) => (g.userKey || g.UserKey) === run + "-pgguest@example.com");
  ok("pg3-revoked-stays-revoked", stillOut.length === 0, JSON.stringify(stillOut.length));
  const gm = await req("GET", "/api/boards", undefined, B(guestT));
  console.log("pg3 guest boards=" + JSON.stringify((gm.json || []).length));
  let mid = null;
  try { mid = require("../.tmp/pg-meeting.json").mid; } catch {}
  if (mid) {
    const denied = await req("GET", `/api/meetings/${mid}/messages?take=5`, undefined, B(guestT));
    ok("pg3-exact-meeting-denied", denied.status === 403, denied.status + " " + denied.text.slice(0, 160));
    const mems = await req("GET", `/api/boards/${bid}/memberships`, undefined, B(adminT));
    const mine = (Array.isArray(mems.json) ? mems.json : []).filter((x) => ((x.userKey || x.UserKey) || "").toLowerCase() === (run + "-pgguest@example.com") && ((x.meetingId || x.MeetingId) === mid));
    ok("pg3-membership-present", mine.length > 0, "rows=" + mine.length);
    ok("pg3-membership-not-active", mine.length > 0 && mine.every((x) => (x.active ?? x.Active) === false), JSON.stringify(mine.map((x) => x.active ?? x.Active)));
  } else { ok("pg3-exact-meeting-denied", false, "no recorded meeting id"); }
  console.log(`FINAL pass=${pass} fail=${fail}`);
  if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("HARNESS-ERROR " + (e && e.stack || e)); process.exit(2); });
