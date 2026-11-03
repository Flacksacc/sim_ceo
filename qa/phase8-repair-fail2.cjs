const API = process.env.QA_API || "http://127.0.0.1:5097";
const crypto = require("crypto");
const run = "p8f-" + Date.now().toString(36);
let pass = 0, fail = 0; const bad = [];
function ok(n, c, e) { if (c) pass++; else { fail++; bad.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
async function req(method, p, body, headers) {
  const r = await fetch(API + p, { method, headers: { "content-type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} return { status: r.status, json: j, text: t };
}
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
(async () => {
  console.log("restore-fail test api=" + API + " run=" + run);
  const B = (t) => ({ Authorization: "Bearer " + t });
  const pw = "TestPassword123!";
  const st = await req("GET", "/api/auth/status");
  let adminE = (st.json && st.json.admin) || (run + "-admin@example.com");
  let adminT = null;
  const li = await req("POST", "/api/auth/login", { email: adminE, password: pw });
  if (li.status === 200 && li.json && li.json.token) { adminT = li.json.token; }
  else {
    adminE = run + "-admin@example.com";
    const rr = await req("POST", "/api/auth/register", { email: adminE, password: pw });
    ok("fail-setup-reg", rr.status === 201 && rr.json && rr.json.token, rr.status + " " + rr.text.slice(0, 120));
    adminT = rr.json.token;
  }
  const b = await req("POST", "/api/boards", { name: run + "-b" }, B(adminT));
  ok("fail-setup-board", b.status === 201, b.status + " " + b.text.slice(0, 120));
  const bid = b.json && (b.json.id || b.json.Id);
  const mm = await req("POST", "/api/boards/" + bid + "/meetings", { title: "m", brief: "b" }, B(adminT));
  ok("fail-setup-meeting", mm.status === 201, mm.status + " " + mm.text.slice(0, 120));
  const mid = mm.json && (mm.json.id || mm.json.Id);
  const pm = await req("POST", "/api/meetings/" + mid + "/messages", { content: "seed" }, B(adminT));
  ok("fail-setup-msg", pm.status === 201, pm.status + " " + pm.text.slice(0, 120));
  async function snapshotHash() {
    const e = await req("GET", "/api/backup", undefined, B(adminT));
    if (e.status !== 200 || !e.json || !e.json.snapshot) return null;
    const o = JSON.parse(e.json.snapshot);
    delete o.at;
    return sha(JSON.stringify(o));
  }
  const h0 = await snapshotHash();
  ok("fail-export", !!h0, "no snapshot");
  async function tryRestore(mut, label) {
    const e = await req("GET", "/api/backup", undefined, B(adminT));
    const snap = JSON.parse(e.json.snapshot);
    mut(snap);
    const s2 = JSON.stringify(snap);
    const r = await req("POST", "/api/backup/restore", { snapshot: s2, hash: sha(s2) }, B(adminT));
    const h1 = await snapshotHash();
    ok(label + "-rejected-400", r.status === 400, r.status + " " + r.text.slice(0, 160));
    ok(label + "-state-identical", h1 === h0, "state hash changed");
  }
  const exp0 = await req("GET", "/api/backup", undefined, B(adminT));
  const s0 = JSON.parse(exp0.json.snapshot);
  const someMid = (s0.meetings && s0.meetings[0] && s0.meetings[0].Id) || (s0.meetings && s0.meetings[0] && s0.meetings[0].id);
  const someBid = (s0.boards && s0.boards[0] && (s0.boards[0].Id || s0.boards[0].id));
  await tryRestore((s) => {
    const k = Object.keys(s.messages)[0] || "00000000-0000-0000-0000-000000000000";
    s.messages[k] = null;
  }, "fail-null-messages");
  await tryRestore((s) => { s.wizardDrafts = [null]; }, "fail-null-wizard");
  await tryRestore((s) => {
    const k = Object.keys(s.blobs)[0];
    if (k) s.blobs[k] = "!!!not-base64!!!";
    else s.blobs["00000000-0000-0000-0000-000000000000"] = "!!!not-base64!!!";
  }, "fail-bad-blob");
  await tryRestore((s) => { s.boards.push(JSON.parse(JSON.stringify(s.boards[0]))); }, "fail-dup-board");
  await tryRestore((s) => { s.notes.push({ Id: "11111111-1111-1111-1111-111111111111", BoardId: "22222222-2222-2222-2222-222222222222", MeetingId: someMid || "33333333-3333-3333-3333-333333333333", Kind: "note", Title: "x", Body: "x", Scope: "meeting", Provisional: true, EvidenceJson: "[]", CreatedAt: new Date().toISOString() }); }, "fail-bad-parent");
  await tryRestore((s) => {
    const k = Object.keys(s.messages)[0];
    if (k) s.messages[k] = [{ BoardId: someBid, MeetingId: k, Sequence: 1, Sender: "lead", Content: "a", Status: "committed", CreatedAt: new Date().toISOString() }, { BoardId: someBid, MeetingId: k, Sequence: 1, Sender: "lead", Content: "b", Status: "committed", CreatedAt: new Date().toISOString() }];
  }, "fail-dup-seq");
  const badHash = await req("POST", "/api/backup/restore", { snapshot: "{}", hash: "00" }, B(adminT));
  ok("fail-bad-hash-409", badHash.status === 409, badHash.status + " " + badHash.text.slice(0, 160));
  const hF = await snapshotHash();
  ok("fail-final-identical", hF === h0, "state hash changed at end");
  console.log("FINAL pass=" + pass + " fail=" + fail);
  if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("HARNESS-ERROR " + (e && e.stack || e)); process.exit(2); });
