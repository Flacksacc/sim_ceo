import crypto from "node:crypto";
const API = process.env.QA_API || "http://127.0.0.1:5097";
const run = "p8r-" + Date.now().toString(36);
let pass = 0, fail = 0; const bad = [];
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; bad.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); } }
async function req(method, path, body, headers) {
  const r = await fetch(API + path, { method, headers: { "content-type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} return { status: r.status, json: j, text: t };
}
const B = (t) => (t ? { Authorization: "Bearer " + t } : {});
const pw = "TestPassword123!";
async function reg(email) { return await req("POST", "/api/auth/register", { email, password: pw }); }
console.log("repair-verify run=" + run + " api=" + API);
const adminE = run + "-admin@example.com", guestE = run + "-guest@example.com", strE = run + "-str@example.com", mgrE = run + "-mgr@example.com", lvE = run + "-lv@example.com";
const ar = await reg(adminE); ok("admin-register", ar.status === 201 && ar.json?.token, ar.status + " " + ar.text.slice(0, 160));
const gr = await reg(guestE); ok("guest-register", gr.status === 201 && gr.json?.token, gr.status + " " + gr.text.slice(0, 160));
const sr = await reg(strE); ok("stranger-register", sr.status === 201, sr.status + " " + sr.text.slice(0, 160));
const mr = await reg(mgrE); ok("mgr-register", mr.status === 201, mr.status + " " + mr.text.slice(0, 160));
const lr = await reg(lvE); ok("leave-register", lvE ? lr.status === 201 : false, lr.status + " " + lr.text.slice(0, 160));
const adminT = ar.json?.token, guestT = gr.json?.token, strT = sr.json?.token, mgrT = mr.json?.token, lvT = lr.json?.token;
const st = await req("GET", "/api/auth/status"); ok("secure-on", st.json?.authRequired === true, st.text.slice(0, 160));
const instAdminE = ((st.json?.admin || adminE) + "").toLowerCase();
let instAdminT = adminT;
if (instAdminE !== adminE.toLowerCase()) { const li = await req("POST", "/api/auth/login", { email: instAdminE, password: pw }); if (li.status === 200 && li.json?.token) instAdminT = li.json.token; }
ok("inst-admin-token", !!instAdminT, instAdminE);
const b = await req("POST", "/api/boards", { name: run + "-b" }, B(adminT)); ok("board-create", b.status === 201 && b.json?.id, b.status + " " + b.text.slice(0, 200));
const bid = b.json?.id;
const m1 = await req("POST", `/api/boards/${bid}/meetings`, { title: "m1", brief: "b" }, B(adminT)); const mid1 = m1.json?.id; ok("m1-create", m1.status === 201 && mid1, m1.status + " " + m1.text.slice(0, 160));
const m2 = await req("POST", `/api/boards/${bid}/meetings`, { title: "m2", brief: "b" }, B(adminT)); const mid2 = m2.json?.id; ok("m2-create", m2.status === 201 && mid2, m2.status + " " + m2.text.slice(0, 160));
await req("POST", `/api/boards/${bid}/grants`, { userKey: guestE, access: "discuss", meetingId: mid1 }, B(adminT));
await req("POST", `/api/boards/${bid}/grants`, { userKey: mgrE, access: "manage", meetingId: mid1 }, B(adminT));
// T1 lead admin-only
{
  const g = await req("GET", "/api/lead", undefined, B(guestT)); ok("lead-guest-403", g.status === 403, g.status + " " + g.text.slice(0, 120));
  const s = await req("GET", "/api/lead", undefined, B(strT)); ok("lead-stranger-403", s.status === 403, s.status + " " + s.text.slice(0, 120));
  const a = await req("GET", "/api/lead", undefined, B(instAdminT)); ok("lead-admin-200", a.status === 200 || a.status === 404, a.status + " " + a.text.slice(0, 120));
  const p = await req("POST", "/api/lead", { name: "x" }, B(guestT)); ok("lead-post-guest-403", p.status === 403, p.status + " " + p.text.slice(0, 120));
}
// T2 boards list scrubbed for meeting guest
{
  const l = await req("GET", "/api/boards", undefined, B(guestT)); const rows = Array.isArray(l.json) ? l.json : [];
  const row = rows.find((x) => (x.id || x.Id) === bid) || rows[0];
  const s = JSON.stringify(row || {});
  const noDraftKeys = row && !("DraftJson" in row) && !("draftJson" in row) && !("ActiveJson" in row) && !("activeJson" in row) && !s.includes("DraftJson") && !s.includes("draftJson") && !s.includes("ActiveJson") && !s.includes("activeJson");
  ok("boards-guest-no-draft", !!noDraftKeys, l.status + " " + s.slice(0, 200));
  ok("boards-guest-no-ownerkey", row && !("OwnerKey" in row) && !("ownerKey" in row) && !s.includes("OwnerKey") && !s.includes("ownerKey"), s.slice(0, 200));
  ok("boards-guest-shape", !!row && row.guest === true && Array.isArray(row.meetingIds) && row.meetingIds.includes(mid1), s.slice(0, 200));
}
// T3 board detail guest DTO minimal
{
  const d = await req("GET", `/api/boards/${bid}`, undefined, B(guestT)); const s = d.text;
  ok("board-detail-guest-no-draft", d.status === 200 && !s.includes("DraftJson") && !s.includes("draftJson") && !s.includes("ActiveJson") && !s.includes("activeJson"), d.status + " " + s.slice(0, 200));
}
// T4 guest-settings minimal
{
  const g = await req("GET", `/api/boards/${bid}/guest-settings`, undefined, B(guestT)); const s = g.text;
  ok("guest-settings-200", g.status === 200, g.status + " " + s.slice(0, 160));
  ok("guest-settings-minimal", g.status === 200 && !s.includes("DraftJson") && !s.includes("draftJson") && !s.includes("ActiveJson") && !s.includes("activeJson"), s.slice(0, 200));
}
// T5 meeting isolation
{
  await req("POST", `/api/meetings/${mid1}/messages`, { content: "owner hello m1" }, B(adminT));
  const own = await req("GET", `/api/meetings/${mid1}/messages?take=60`, undefined, B(guestT)); ok("guest-own-meeting-200", own.status === 200, own.status + " " + own.text.slice(0, 120));
  const other = await req("GET", `/api/meetings/${mid2}/messages?take=60`, undefined, B(guestT)); ok("guest-other-meeting-403", other.status === 403, other.status + " " + other.text.slice(0, 120));
}
// T6 source versions filtered
{
  async function upload(meetingId, scope, filename, content) {
    const fd = new FormData(); fd.append("file", new Blob([content], { type: "text/plain" }), filename);
    const r = await fetch(API + `/api/boards/${bid}/sources/upload?scope=${scope}&meetingId=${meetingId}`, { method: "POST", headers: B(adminT), body: fd });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, text: t };
  }
  const u1 = await upload(mid1, "meeting", "notes.txt", "M1 approved content"); ok("src-m1-upload", u1.status === 201 && u1.json?.id, u1.status + " " + u1.text.slice(0, 160));
  const u2 = await upload(mid2, "meeting", "notes.txt", "M2 PRIVATE content"); ok("src-m2-upload", u2.status === 201 && u2.json?.id, u2.status + " " + u2.text.slice(0, 160));
  const ap = await req("POST", `/api/sources/${u1.json?.id}/approve`, {}, B(adminT)); ok("src-m1-approve", ap.status === 200, ap.status + " " + ap.text.slice(0, 120));
  const v = await req("GET", `/api/sources/${u1.json?.id}/versions`, undefined, B(guestT));
  const rows = Array.isArray(v.json) ? v.json : [];
  const leaked = rows.some((x) => JSON.stringify(x).includes("M2 PRIVATE"));
  const ids = rows.map((x) => x.id || x.Id);
  const m2b64 = Buffer.from("M2 PRIVATE content").toString("base64");
  const leakedBytes = rows.some((x) => JSON.stringify(x).includes(m2b64));
  ok("src-versions-200", v.status === 200, v.status + " " + v.text.slice(0, 160));
  ok("src-versions-exact-ids", v.status === 200 && ids.includes(u1.json?.id) && !ids.includes(u2.json?.id), "ids=" + JSON.stringify(ids));
  ok("src-versions-no-leak", v.status === 200 && !leaked && !leakedBytes && rows.length >= 1, "rows=" + rows.length + " " + v.text.slice(0, 200));
}
// T7 voice creator-private
{
  const c = await req("POST", `/api/meetings/${mid1}/voice`, { partial: "owner secret draft" }, B(adminT));
  ok("voice-create", c.status === 201 && c.json?.id, c.status + " " + c.text.slice(0, 160));
  const vid = c.json?.id;
  const gl = await req("GET", `/api/meetings/${mid1}/voice`, undefined, B(guestT));
  const grows = Array.isArray(gl.json) ? gl.json : [];
  ok("voice-guest-no-unsent", gl.status === 200 && !grows.some((x) => (x.Id || x.id) === vid), gl.status + " " + gl.text.slice(0, 200));
  const gf = await req("POST", `/api/voice/${vid}/finalize`, { transcript: "guest hijack" }, B(guestT));
  ok("voice-guest-finalize-403", gf.status === 403, gf.status + " " + gf.text.slice(0, 120));
  const af = await req("POST", `/api/voice/${vid}/finalize`, { transcript: "owner final" }, B(adminT));
  ok("voice-admin-finalize-200", af.status === 200, af.status + " " + af.text.slice(0, 160));
}
// T8 restore preserves current ACL (no resurrect)
{
  const exp = await req("GET", "/api/backup", undefined, B(instAdminT)); ok("backup-export", exp.status === 200 && exp.json?.snapshot && exp.json?.hash, exp.status + " " + exp.text.slice(0, 120));
  const grants0 = await req("GET", `/api/boards/${bid}/grants`, undefined, B(adminT));
  const gg = (Array.isArray(grants0.json) ? grants0.json : []).find((g) => (g.userKey || g.UserKey) === guestE && ((g.meetingId || g.MeetingId) === mid1));
  ok("backup-grant-present", !!gg, JSON.stringify((grants0.json || []).length));
  const snapWithGrant = exp.json?.snapshot, hashWithGrant = exp.json?.hash;
  if (gg) { const del = await req("DELETE", `/api/grants/${gg.id || gg.Id}`, undefined, B(adminT)); ok("backup-grant-delete", del.status === 204 || del.status === 200, del.status + " " + del.text.slice(0, 120)); }
  const deniedBefore = await req("GET", `/api/meetings/${mid1}/messages?take=5`, undefined, B(guestT));
  ok("backup-denied-before-restore", deniedBefore.status === 403, deniedBefore.status + " " + deniedBefore.text.slice(0, 120));
  const rs = await req("POST", "/api/backup/restore", { snapshot: snapWithGrant, hash: hashWithGrant }, B(instAdminT));
  ok("backup-restore-200", rs.status === 200, rs.status + " " + rs.text.slice(0, 200));
  const deniedAfter = await req("GET", `/api/meetings/${mid1}/messages?take=5`, undefined, B(guestT));
  ok("backup-no-resurrect", deniedAfter.status === 403, deniedAfter.status + " " + deniedAfter.text.slice(0, 160));
  const re = await req("POST", "/api/auth/login", { email: adminE, password: pw }); ok("backup-admin-still-works", re.status === 200 && re.json?.token, re.status + " " + re.text.slice(0, 120));
  await req("POST", `/api/boards/${bid}/grants`, { userKey: guestE, access: "discuss", meetingId: mid1 }, B(adminT));
}
// T9 repair-access respects leave (no silent reissue)
{
  const inv = await req("POST", `/api/boards/${bid}/invites`, { email: lvE, role: "guest", meetingId: mid1 }, B(adminT));
  ok("invite-create", inv.status === 201 && (inv.json?.id || inv.json?.Id), inv.status + " " + inv.text.slice(0, 200));
  const invId = inv.json?.id || inv.json?.Id;
  const acc = await req("POST", `/api/invites/${invId}/accept`, {}, B(lvT)); ok("invite-accept", acc.status === 200, acc.status + " " + acc.text.slice(0, 200));
  const canBefore = await req("GET", `/api/meetings/${mid1}/messages?take=5`, undefined, B(lvT)); ok("invite-access-before-leave", canBefore.status === 200, canBefore.status + " " + canBefore.text.slice(0, 120));
  await req("POST", `/api/meetings/${mid1}/leave`, {}, B(lvT));
  const rep = await req("POST", `/api/boards/${bid}/repair-access`, {}, B(adminT)); ok("repair-200", rep.status === 200, rep.status + " " + rep.text.slice(0, 160));
  const stillOut = await req("GET", `/api/meetings/${mid1}/messages?take=5`, undefined, B(lvT));
  ok("repair-no-reissue-after-leave", stillOut.status === 403, stillOut.status + " " + stillOut.text.slice(0, 160));
}
console.log(`RESTPART pass=${pass} fail=${fail}`);
// T9 authenticated portrait exact bytes; unrelated guest denied
{
  const re = await req("POST", "/api/roster", { name: "Media Entry", description: "media test entry", profileJson: "{\"bio\":\"a sufficiently long test profile for media\"}" }, B(adminT));
  ok("media-roster-create", re.status === 201 && (re.json?.id || re.json?.Id), re.status + " " + re.text.slice(0, 160));
  const rid = re.json?.id || re.json?.Id;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const fd = new FormData(); fd.append("file", new Blob([png], { type: "image/png" }), "dot.png");
  const up = await fetch(API + `/api/roster/${rid}/image/upload`, { method: "POST", headers: B(adminT), body: fd });
  const upt = await up.text(); let upj = null; try { upj = JSON.parse(upt); } catch {}
  ok("media-upload", up.status === 201 && (upj?.id || upj?.Id), up.status + " " + upt.slice(0, 160));
  const imgId = upj?.id || upj?.Id;
  const dl = await fetch(API + `/api/images/${imgId}`, { headers: B(adminT) });
  const buf = Buffer.from(await dl.arrayBuffer());
  ok("media-bytes-exact", dl.status === 200 && buf.equals(png), dl.status + " len=" + buf.length);
  const gd = await fetch(API + `/api/images/${imgId}`, { headers: B(guestT) });
  ok("media-guest-denied", gd.status === 403, gd.status);
}
console.log(`FINAL pass=${pass} fail=${fail}`);
if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
process.exit(fail === 0 ? 0 : 1);
