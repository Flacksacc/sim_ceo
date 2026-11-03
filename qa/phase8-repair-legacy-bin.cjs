const API = process.env.QA_API || "http://127.0.0.1:5197";
const ids = require("../.tmp/legacybin-ids.json");
let pass = 0, fail = 0; const bad = [];
function ok(n, c, e) { if (c) pass++; else { fail++; bad.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
async function req(method, p, body, headers) {
  const r = await fetch(API + p, { method, headers: { "content-type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} return { status: r.status, json: j, text: t };
}
(async () => {
  console.log("legacy-bin upgrade test api=" + API + " run=" + ids.run);
  const B = (t) => ({ Authorization: "Bearer " + t });
  const st = await req("GET", "/api/auth/status");
  ok("bin-secure", st.json?.authRequired === true, st.text.slice(0, 200));
  const al = await req("POST", "/api/auth/login", { email: ids.alpha, password: ids.pw });
  const bl = await req("POST", "/api/auth/login", { email: ids.beta, password: ids.pw });
  const gl = await req("POST", "/api/auth/login", { email: ids.gamma, password: ids.pw });
  ok("bin-alpha-login", al.status === 200 && al.json?.token, al.status + " " + al.text.slice(0, 120));
  ok("bin-beta-login", bl.status === 200 && bl.json?.token, bl.status + " " + bl.text.slice(0, 120));
  ok("bin-gamma-login", gl.status === 200 && gl.json?.token, gl.status + " " + gl.text.slice(0, 120));
  const adminT = al.json?.token, betaT = bl.json?.token;
  const st2 = await req("GET", "/api/auth/status");
  ok("bin-admin-alpha", (st2.json?.admin || "").toLowerCase() === ids.alpha, st2.text.slice(0, 200));
  const grants = await req("GET", `/api/boards/${ids.boardId}/grants`, undefined, B(adminT));
  const gl2 = Array.isArray(grants.json) ? grants.json : [];
  const betaScoped = gl2.filter((g) => (g.userKey || g.UserKey || "").toLowerCase() === ids.beta && ((g.meetingId || g.MeetingId) === ids.meetingId));
  ok("bin-scoped-grant", betaScoped.length === 1 && ((betaScoped[0].access || betaScoped[0].Access) === "discuss"), JSON.stringify(betaScoped.length));
  const betaWide = gl2.filter((g) => (g.userKey || g.UserKey || "").toLowerCase() === ids.beta && !(g.meetingId || g.MeetingId));
  ok("bin-no-blind-delete", betaWide.length === 1, "widened board grant preserved for explicit narrowing, count=" + betaWide.length);
  const gammaG = gl2.filter((g) => (g.userKey || g.UserKey || "").toLowerCase() === ids.gamma);
  ok("bin-legit-intact", gammaG.length === 1 && !(gammaG[0].meetingId || gammaG[0].MeetingId), JSON.stringify(gammaG.length));
  const mem = await req("GET", `/api/boards/${ids.boardId}/memberships`, undefined, B(adminT));
  const mm = Array.isArray(mem.json) ? mem.json : [];
  const betaMem = mm.filter((x) => ((x.userKey || x.UserKey) || "").toLowerCase() === ids.beta && ((x.meetingId || x.MeetingId) === ids.meetingId));
  ok("bin-membership-active", betaMem.length === 1 && (betaMem[0].active ?? betaMem[0].Active) === true, JSON.stringify(betaMem.length));
  const ros = await req("GET", "/api/roster?accountId=00000000-0000-0000-0000-000000000000", undefined, B(adminT));
  const entries = Array.isArray(ros.json) ? ros.json : [];
  const e1 = entries.find((e) => ((e.entry || e).id || (e.entry || e).Id) === ids.rosOwner);
  const e2 = entries.find((e) => ((e.entry || e).id || (e.entry || e).Id) === ids.rosBlankSrc);
  const o1 = ((e1 || {}).entry || e1 || {}); const o2 = ((e2 || {}).entry || e2 || {});
  ok("bin-roster-owner-adopted", (o1.OwnerKey || o1.ownerKey) === ids.alpha, JSON.stringify(o1.OwnerKey || o1.ownerKey));
  ok("bin-roster-blank-adopted", (o2.OwnerKey || o2.ownerKey) === ids.alpha, JSON.stringify(o2.OwnerKey || o2.ownerKey));
  const wz = await req("GET", `/api/wizard/${ids.wizId}`, undefined, B(adminT));
  ok("bin-wizard-adopted", wz.status === 200 && (wz.json?.OwnerKey === ids.alpha || wz.json?.ownerKey === ids.alpha), wz.status + " " + wz.text.slice(0, 160));
  const vlist = await req("GET", `/api/meetings/${ids.meetingId}/voice`, undefined, B(betaT));
  const grows = Array.isArray(vlist.json) ? vlist.json : [];
  ok("bin-voice-no-leak", vlist.status === 200 && !grows.some((x) => (x.Id || x.id) === ids.voiceId), vlist.status + " rows=" + grows.length);
  const vf = await req("POST", `/api/voice/${ids.voiceId}/finalize`, { transcript: "hijack" }, B(betaT));
  ok("bin-voice-finalize-denied", vf.status === 403, vf.status + " " + vf.text.slice(0, 120));
  const gm = await req("GET", `/api/meetings/${ids.meetingId}/messages?take=5`, undefined, B(betaT));
  ok("bin-meeting-continuity", gm.status === 200, gm.status + " " + gm.text.slice(0, 120));
  console.log(`FINAL pass=${pass} fail=${fail}`);
  if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("HARNESS-ERROR " + (e && e.stack || e)); process.exit(2); });
