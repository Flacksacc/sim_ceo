import crypto from "node:crypto";
const API = process.env.QA_API || "http://127.0.0.1:5208";
if (API.includes(":5173") || API.includes(":5080") || API.includes(":15180")) { console.log("FATAL refuse human/test ports " + API); process.exit(1); }
const run = "ps-" + Date.now().toString(36);
let pass = 0, fail = 0;
const bad = [];
function ok(n, c, e) { if (c) { pass++; console.log("  ok " + n); } else { fail++; bad.push(n); console.log("  FAIL " + n + (e ? " :: " + String(e).slice(0, 300) : "")); } }
async function req(method, path, body, headers) {
  const r = await fetch(API + path, { method, headers: Object.assign({ "content-type": "application/json" }, headers || {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: r.status, json, text };
}
const get = (p, h) => req("GET", p, undefined, h);
const post = (p, b, h) => req("POST", p, b, h);
const alice = "qa-" + run + "-a@example.com", bob = "qa-" + run + "-b@example.com", pw = "0123456789abCD!x";
const ra = await post("/api/auth/register", { email: alice, password: pw });
ok("reg-alice", ra.status === 201 && ra.json && ra.json.token, String(ra.status));
const rb = await post("/api/auth/register", { email: bob, password: pw });
ok("reg-bob", rb.status === 201 && rb.json && rb.json.token, String(rb.status));
const AH = (t) => ({ Authorization: "Bearer " + t });
const tokA = ra.json.token, tokB = rb.json.token;
const g0 = await get("/api/profile", AH(tokA));
ok("get-empty-404", g0.status === 404, String(g0.status));
const P1 = { name: "Ada Default", roleLabel: "Board Lead", background: "BG-" + run, familiarTopics: "Fam", simplerTopics: "Simp", commPrefs: "Custom-" + run, version: 0 };
const s1 = await post("/api/profile", P1, AH(tokA));
ok("save-v1", s1.status === 200 && s1.json && s1.json.version === 1, s1.status + " " + s1.text.slice(0, 160));
const g1 = await get("/api/profile", AH(tokA));
ok("get-v1", g1.status === 200 && g1.json.name === "Ada Default" && g1.json.commPrefs === "Custom-" + run && g1.json.background === "BG-" + run, g1.status + " " + g1.text.slice(0, 200));
const gb = await get("/api/profile", AH(tokB));
ok("bob-isolated-404", gb.status === 404, String(gb.status));
const stale = await post("/api/profile", Object.assign({}, P1, { version: 0 }), AH(tokA));
ok("stale-409", stale.status === 409, String(stale.status));
const s2 = await post("/api/profile", Object.assign({}, P1, { version: 1, commPrefs: "Custom2-" + run }), AH(tokA));
ok("save-v2", s2.status === 200 && s2.json.version === 2, s2.status + " " + s2.text.slice(0, 160));
async function makeBoard(tok, tag) {
  const w = await post("/api/wizard", { step: 4, presetKey: "", fieldsJson: JSON.stringify({ name: run + tag, mission: run + " mission", stage: "qa", advisors: [{ role: "Strategist", name: run + tag + "-adv" }] }) }, AH(tok));
  if (!(w.status === 200 || w.status === 201) || !w.json || !w.json.id) return { error: "wiz:" + w.status };
  const cr = await post("/api/wizard/" + w.json.id + "/create", {}, AH(tok));
  if (!(cr.status === 200 || cr.status === 201)) return { error: "create:" + cr.status + " " + cr.text.slice(0, 120) };
  const j = cr.json || {};
  const id = j.boardId || j.boardID || j.id || j.Id || (j.board && (j.board.id || j.board.Id)) || null;
  if (!id) return { error: "noid:" + JSON.stringify(j).slice(0, 120) };
  return { id };
}
const bA = await makeBoard(tokA, "-ab");
ok("board-a-created", !!bA.id, bA.error || String(bA.id));
const la = await get("/api/boards/" + bA.id + "/lead", AH(tokA));
ok("board-inherits-default", la.status === 200 && la.json.name === "Ada Default" && la.json.commPrefs === "Custom2-" + run, la.status + " " + la.text.slice(0, 200));
const ov = await post("/api/boards/" + bA.id + "/lead", { name: "Board Own", roleLabel: "CEO", background: "ob", familiarTopics: "of", simplerTopics: "os", commPrefs: "oc", version: la.json.version }, AH(tokA));
ok("explicit-override", ov.status === 200 && ov.json.name === "Board Own", ov.status + " " + ov.text.slice(0, 160));
const s3 = await post("/api/profile", Object.assign({}, P1, { version: 2, name: "Ada Default v3" }), AH(tokA));
ok("save-v3", s3.status === 200 && s3.json.version === 3, s3.status);
const la2 = await get("/api/boards/" + bA.id + "/lead", AH(tokA));
ok("override-preserved", la2.status === 200 && la2.json.name === "Board Own", la2.status + " " + la2.text.slice(0, 200));
const sbB = await post("/api/profile", { name: "Bob Default", roleLabel: "Founder", background: "bb", familiarTopics: "bf", simplerTopics: "bs", commPrefs: "bc", version: 0 }, AH(tokB));
const bB = await makeBoard(tokB, "-bb");
ok("board-b-created", !!bB.id, bB.error || String(bB.id));
const lb = await get("/api/boards/" + bB.id + "/lead", AH(tokB));
ok("bob-board-no-leak", lb.status === 200 && lb.json.name === "Bob Default", String(lb.status) + " " + lb.text.slice(0, 160));
console.log("PASS " + pass + " FAIL " + fail);
if (fail > 0) { console.log("FAILURES: " + bad.join(" | ")); process.exit(1); }
console.log("PROFILE-SHARED-HTTP-QA PASS");
