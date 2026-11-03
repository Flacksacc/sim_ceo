const API = process.env.QA_API || "http://127.0.0.1:5097";
const run = "p8rv-" + Date.now().toString(36);
let pass = 0, fail = 0; const bad = [];
function ok(n, c, e) { if (c) pass++; else { fail++; bad.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
async function req(method, p, body, headers) {
  const r = await fetch(API + p, { method, headers: { "content-type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} return { status: r.status, json: j, text: t };
}
(async () => {
  console.log("revoke-scope test api=" + API + " run=" + run);
  const pw = "TestPassword123!";
  const B = (t) => ({ Authorization: "Bearer " + t });
  const owE = run + "-owner@example.com", uE = run + "-u@example.com";
  const ow = await req("POST", "/api/auth/register", { email: owE, password: pw });
  const ur = await req("POST", "/api/auth/register", { email: uE, password: pw });
  const ownerT = ow.json.token;
  let userT = ur.json.token;
  const b = await req("POST", "/api/boards", { name: run + "-b" }, B(ownerT));
  const bid = b.json.id;
  const m1 = await req("POST", `/api/boards/${bid}/meetings`, { title: "m1", brief: "b" }, B(ownerT));
  const m2 = await req("POST", `/api/boards/${bid}/meetings`, { title: "m2", brief: "b" }, B(ownerT));
  const mid1 = m1.json.id, mid2 = m2.json.id;
  // user gets M1 + M2 meeting grants + board-wide grant (explicit)
  await req("POST", `/api/boards/${bid}/grants`, { userKey: uE, access: "discuss", meetingId: mid1 }, B(ownerT));
  await req("POST", `/api/boards/${bid}/grants`, { userKey: uE, access: "read", meetingId: mid2 }, B(ownerT));
  await req("POST", `/api/boards/${bid}/grants`, { userKey: uE, access: "contribute" }, B(ownerT));
  const inv = await req("POST", `/api/boards/${bid}/invites`, { email: uE, role: "guest", meetingId: mid1 }, B(ownerT));
  const invId = inv.json.id || inv.json.Id;
  const acc = await req("POST", `/api/invites/${invId}/accept`, {}, B(userT));
  ok("revoke-setup-accept", acc.status === 200, acc.status + " " + acc.text.slice(0, 160));
  // default (meeting) revoke of the M1 invite: M1 grant gone, M2 + board-wide survive
  const rv = await req("POST", `/api/invites/${invId}/revoke`, {}, B(ownerT));
  ok("revoke-meeting-200", rv.status === 200, rv.status + " " + rv.text.slice(0, 160));
  const g1 = await req("GET", `/api/boards/${bid}/grants`, undefined, B(ownerT));
  const mine = (Array.isArray(g1.json) ? g1.json : []).filter((g) => (g.userKey || g.UserKey) === uE);
  const hasM1 = mine.some((g) => (g.meetingId || g.MeetingId) === mid1);
  const hasM2 = mine.some((g) => (g.meetingId || g.MeetingId) === mid2);
  const hasBoard = mine.some((g) => !(g.meetingId || g.MeetingId));
  ok("revoke-m1-gone", !hasM1, JSON.stringify(mine.map((g) => g.meetingId || g.MeetingId)));
  ok("revoke-m2-kept", hasM2, "meeting-only revoke must not touch other meetings");
  ok("revoke-board-kept", hasBoard, "default revoke must not touch board-wide grants");
  const m1viaBoard = await req("GET", `/api/meetings/${mid1}/messages?take=5`, undefined, B(userT));
  ok("revoke-m1-board-grant-reads", m1viaBoard.status === 200, String(m1viaBoard.status));
  const vE = run + "-v@example.com";
  const vreg = await req("POST", "/api/auth/register", { email: vE, password: pw });
  const vT = vreg.json.token;
  const vinv = await req("POST", `/api/boards/${bid}/invites`, { email: vE, role: "guest", meetingId: mid1 }, B(ownerT));
  const vinvId = vinv.json.id || vinv.json.Id;
  const vacc = await req("POST", `/api/invites/${vinvId}/accept`, {}, B(vT));
  ok("revoke-v-setup-accept", vacc.status === 200, vacc.status + " " + vacc.text.slice(0, 160));
  const vrv = await req("POST", `/api/invites/${vinvId}/revoke`, {}, B(ownerT));
  ok("revoke-v-200", vrv.status === 200, vrv.status + " " + vrv.text.slice(0, 160));
  const vden2 = await req("GET", `/api/meetings/${mid1}/messages?take=5`, undefined, B(vT));
  ok("revoke-m1-denied", vden2.status === 403, vden2.status);
  // explicit board-wide revoke removes everything for the user
  const inv2 = await req("POST", `/api/boards/${bid}/invites`, { email: uE, role: "guest", meetingId: mid2 }, B(ownerT));
  const invId2 = inv2.json.id || inv2.json.Id;
  await req("POST", `/api/invites/${invId2}/accept`, {}, B(userT));
  const rvb = await req("POST", `/api/invites/${invId2}/revoke?scope=board`, {}, B(ownerT));
  ok("revoke-board-200", rvb.status === 200, rvb.status + " " + rvb.text.slice(0, 160));
  const g2 = await req("GET", `/api/boards/${bid}/grants`, undefined, B(ownerT));
  const mine2 = (Array.isArray(g2.json) ? g2.json : []).filter((g) => (g.userKey || g.UserKey) === uE);
  ok("revoke-board-clears-all", mine2.length === 0, JSON.stringify(mine2.length));
  console.log("FINAL pass=" + pass + " fail=" + fail);
  if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("HARNESS-ERROR " + (e && e.stack || e)); process.exit(2); });
