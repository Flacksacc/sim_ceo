const API = process.env.QA_API || "http://127.0.0.1:5197";
const ids = require("../.tmp/legacy94-ids.json");
const run = "legacy94";
let pass = 0, fail = 0; const bad = [];
function ok(n, c, e) { if (c) pass++; else { fail++; bad.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
async function req(method, path, body, headers) {
  const r = await fetch(API + path, { method, headers: { "content-type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} return { status: r.status, json: j, text: t };
}
(async () => {
  console.log("legacy94 upgrade test api=" + API);
  const B = (t) => ({ Authorization: "Bearer " + t });
  const st0 = await req("GET", "/api/auth/status");
  ok("legacy-secure-pre", st0.json?.authRequired === true, st0.text.slice(0, 200));
  const al = await req("POST", "/api/auth/login", { email: ids.alpha.email, password: ids.pw });
  ok("legacy-alpha-login", al.status === 200 && al.json?.token, al.status + " " + al.text.slice(0, 160));
  const bl = await req("POST", "/api/auth/login", { email: ids.beta.email, password: ids.pw });
  ok("legacy-beta-login", bl.status === 200 && bl.json?.token, bl.status + " " + bl.text.slice(0, 160));
  const gl = await req("POST", "/api/auth/login", { email: ids.gamma.email, password: ids.pw });
  ok("legacy-gamma-login", gl.status === 200 && gl.json?.token, gl.status + " " + gl.text.slice(0, 160));
  const adminT = al.json?.token;
  const st = await req("GET", "/api/auth/status");
  ok("legacy-secure", st.json?.authRequired === true, st.text.slice(0, 200));
  ok("legacy-admin-alpha", (st.json?.admin || "").toLowerCase() === ids.alpha.email, st.text.slice(0, 200));
  ok("legacy-accounts", st.json?.accountCount === 3, st.text.slice(0, 200));
  const boards = await req("GET", "/api/boards", undefined, B(adminT));
  const found = (Array.isArray(boards.json) ? boards.json : []).find((x) => (x.id || x.Id) === ids.boardId);
  ok("legacy-board-visible", !!found, "boards=" + JSON.stringify((boards.json || []).length));
  const grants = await req("GET", `/api/boards/${ids.boardId}/grants`, undefined, B(adminT));
  const gl2 = Array.isArray(grants.json) ? grants.json : [];
  const betaGrants = gl2.filter((g) => (g.userKey || g.UserKey || "").toLowerCase() === ids.beta.email);
  const widened = betaGrants.filter((g) => !(g.meetingId || g.MeetingId));
  ok("legacy-widened-removed", widened.length === 0, JSON.stringify(betaGrants.map((g) => g.meetingId || g.MeetingId)));
  const scoped = betaGrants.filter((g) => (g.meetingId || g.MeetingId) === ids.legacyMid);
  ok("legacy-scoped-grant", scoped.length === 1 && ((scoped[0].access || scoped[0].Access) === "discuss"), JSON.stringify(scoped.length));
  const gammaGrants = gl2.filter((g) => (g.userKey || g.UserKey || "").toLowerCase() === ids.gamma.email);
  ok("legacy-legit-intact", gammaGrants.length === 1 && !(gammaGrants[0].meetingId || gammaGrants[0].MeetingId), JSON.stringify(gammaGrants.length));
  const ros = await req("GET", "/api/roster?accountId=00000000-0000-0000-0000-000000000000", undefined, B(adminT));
  const entries = Array.isArray(ros.json) ? ros.json : [];
  const own = entries.find((e) => ((e.entry || e).id || (e.entry || e).Id) === ids.rosOwner);
  const blk = entries.find((e) => ((e.entry || e).id || (e.entry || e).Id) === ids.rosBlank);
  const ow = (own?.entry || own || {});
  ok("legacy-roster-owner-adopted", ow.OwnerKey === ids.alpha.email || ow.ownerKey === ids.alpha.email, JSON.stringify(ow.OwnerKey || ow.ownerKey));
  console.log(`FINAL pass=${pass} fail=${fail}`);
  if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("HARNESS-ERROR " + (e && e.stack || e)); process.exit(2); });
