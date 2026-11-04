const API = process.env.QA_API || "http://127.0.0.1:15441";
const run = process.env.QA_RUN || "p8pg-mw00f8zl";
let pass = 0, fail = 0; const bad = [];
function ok(n, c, e) { if (c) pass++; else { fail++; bad.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
async function req(method, path, body, headers) {
  const r = await fetch(API + path, { method, headers: { "content-type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} return { status: r.status, json: j, text: t };
}
(async () => {
  console.log("repair-pg2 run=" + run + " api=" + API);
  const pw = "TestPassword123!";
  const B = (t) => ({ Authorization: "Bearer " + t });
  const admE = run + "-pgadmin@example.com", gE = run + "-pgguest@example.com";
  // sessions are memory-only: old tokens must be dead
  const st = await req("GET", "/api/auth/status"); ok("pg-secure-after-restart", st.json?.authRequired === true, st.text.slice(0, 160));
  // account relogin works (durable accounts)
  const rl = await req("POST", "/api/auth/login", { email: admE, password: pw });
  ok("pg-admin-relogin", rl.status === 200 && rl.json?.token, rl.status + " " + rl.text.slice(0, 160));
  const adminT = rl.json?.token;
  const gl = await req("POST", "/api/auth/login", { email: gE, password: pw });
  ok("pg-guest-relogin", gl.status === 200 && gl.json?.token, gl.status + " " + gl.text.slice(0, 160));
  const guestT = gl.json?.token;
  // grants/memberships/board persisted: find board via list
  const boards = await req("GET", "/api/boards", undefined, B(adminT));
  const bname = run + "-pgb";
  const found = (Array.isArray(boards.json) ? boards.json : []).find((x) => (x.name || x.Name) === bname);
  ok("pg-board-persisted", !!found, "boards=" + JSON.stringify((boards.json || []).length));
  const bid = found?.id || found?.Id;
  const grants = await req("GET", `/api/boards/${bid}/grants`, undefined, B(adminT));
  const gg = (Array.isArray(grants.json) ? grants.json : []).find((g) => (g.userKey || g.UserKey) === gE);
  ok("pg-grant-persisted", !!gg, grants.text.slice(0, 200));
  const mid = gg?.meetingId || gg?.MeetingId;
  const gm = await req("GET", `/api/meetings/${mid}/messages?take=5`, undefined, B(guestT));
  ok("pg-guest-access-after-relogin", gm.status === 200, gm.status + " " + gm.text.slice(0, 160));
  // revoke, restart again happens outside; here assert revoke works on PG
  if (gg) { const del = await req("DELETE", `/api/grants/${gg.id || gg.Id}`, undefined, B(adminT)); ok("pg-revoke", del.status === 204 || del.status === 200, del.status + " " + del.text.slice(0, 120)); }
  const denied = await req("GET", `/api/meetings/${mid}/messages?take=5`, undefined, B(guestT));
  ok("pg-revoked-denied", denied.status === 403, denied.status + " " + denied.text.slice(0, 160));
  try { require("fs").writeFileSync(require("path").join(__dirname, "..", ".tmp", "pg-meeting.json"), JSON.stringify({ run, bid, mid })); } catch {}
  console.log(`FINAL pass=${pass} fail=${fail} BID=${bid} MID=${mid}`);
  if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("HARNESS-ERROR " + (e && e.stack || e)); process.exit(2); });
