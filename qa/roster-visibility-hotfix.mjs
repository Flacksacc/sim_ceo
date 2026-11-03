// Focused HTTP QA for the roster visibility hotfix (Muse-authored).
// Spins its OWN api (127.0.0.1:15961, memory mode) + fake provider (:15962).
// Touches nothing else: never 5173/5080/5099/5100/5199/5174/15971/15972, no PG, no Docker, no human DB.
// Covers: mismatched-client-account visibility of live board-linked entries,
// list==count coherence, canonical-entry edit (same id, no clones, next chat
// uses it), explicit-owner priority, stranger negatives, secure guest
// boundary, and the unchanged board-direct-chat route (no 410).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))) + path.sep;
const API = "http://127.0.0.1:15961";
for (const bad of [":5173", ":5080", ":5099", ":5100", ":5199", ":5174", ":15971", ":15972"]) {
  if (API.includes(bad)) { console.error("refuse port " + bad); process.exit(2); }
}
let pass = 0, fail = 0;
const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; bad.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
async function req(method, p, body, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 60000);
  try {
    const headers = { ...(opts.headers || {}) };
    if (opts.user !== false) {
      if (opts.token) headers["authorization"] = "Bearer " + opts.token;
      else headers["x-user"] = opts.user || "owner";
    }
    let b;
    if (body !== undefined && !(body instanceof FormData)) { headers["content-type"] = "application/json"; b = JSON.stringify(body); }
    else if (body instanceof FormData) b = body;
    const r = await fetch(API + p, { method, signal: ctl.signal, headers, body: b });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const get = (p, o) => req("GET", p, undefined, o);
const post = (p, b, o) => req("POST", p, b, o);
const put = (p, b, o) => req("PUT", p, b, o);
const guid = () => globalThis.crypto.randomUUID();
const ci = (o, k) => {
  if (!o || typeof o !== "object") return undefined;
  if (k in o) return o[k];
  const lo = k.toLowerCase();
  for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key];
  return undefined;
};
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAhWjR9awAAAABJRU5ErkJggg==", "base64");
async function uploadPortrait(rosterId, o) {
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "qa.png");
  return req("POST", "/api/roster/" + rosterId + "/image/upload", form, o);
}
async function waitUp(url, secs = 60) {
  const end = Date.now() + secs * 1000;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
async function main() {
  const keyring = fs.mkdtempSync(path.join(os.tmpdir(), "roster-vis-keyring-"));
  const dll = path.join(ROOT, "server", "SimCEO.Api", "bin", "Debug", "net10.0", "SimCEO.Api.dll");
  if (!fs.existsSync(dll)) { console.error("missing build output: " + dll); process.exit(2); }
  const fake = spawn(process.execPath, [path.join(ROOT, "qa", "fake-provider.mjs"), "--port", "15962"], { stdio: "ignore" });
  const api = spawn("dotnet", [dll], {
    stdio: "ignore",
    env: { ...process.env, ASPNETCORE_URLS: "http://127.0.0.1:15961", META_API_BASE: "http://127.0.0.1:15962", META_API_KEY: "qa-dummy", WIKI_KEYRING_DIR: keyring },
  });
  const kill = () => { try { api.kill(); } catch {} try { fake.kill(); } catch {} };
  process.on("exit", kill);
  try {
    ok("api-up", await waitUp(API + "/health", 60));
    const run = "rv-" + Date.now().toString(36);
    const H1 = guid();
    const RND = guid();
    // --- demo mode: seed board + attached entry ---
    const b = await post("/api/boards", { name: run + "-board", mission: run + " mission" });
    ok("demo-board", b.status === 201, b.status + " " + b.text.slice(0, 120));
    const bid = ci(b.json, "id");
    const q1 = await post("/api/roster/quick", { accountId: H1, name: run + "-E", description: "attached entry for " + run });
    ok("demo-quick", q1.status === 201, q1.status + " " + q1.text.slice(0, 120));
    const eid = ci(q1.json, "id");
    const up = await uploadPortrait(eid, {});
    ok("demo-portrait", up.status === 201, up.status + " " + up.text.slice(0, 120));
    const imgs = await get("/api/roster/" + eid + "/images");
    const imgId = ci(imgs.json?.[0], "id");
    const rev = await post("/api/images/" + imgId + "/review", { decision: "accept" });
    ok("demo-accept", rev.status === 200, rev.status + " " + rev.text.slice(0, 120));
    const cp = await post("/api/roster/" + eid + "/copy", { boardId: bid, boardRole: "Seat" });
    ok("demo-copy", cp.status === 201, cp.status + " " + cp.text.slice(0, 160));
    const aid = ci(cp.json, "id");
    // --- mismatched browser-local account still sees the live-linked entry ---
    const lr = await get("/api/roster?accountId=" + RND);
    const lrArr = Array.isArray(lr.json) ? lr.json : [];
    const lrIds = lrArr.map((e) => String(ci(ci(e, "entry"), "id") || ""));
    ok("demo-mismatch-list", lr.status === 200 && lrIds.includes(String(eid)), lr.status + " ids=" + JSON.stringify(lrIds));
    const cr = await get("/api/roster/count?accountId=" + RND);
    ok("demo-mismatch-count", cr.status === 200 && ci(cr.json, "total") === lrArr.length, cr.status + " " + cr.text.slice(0, 120));
    // --- backward compat: account-matched unattached rows still visible to that account ---
    const qu = await post("/api/roster/quick", { accountId: H1, name: run + "-U", description: "unattached entry for " + run });
    const uid = ci(qu.json, "id");
    const lu = await get("/api/roster?accountId=" + RND);
    const luIds = (Array.isArray(lu.json) ? lu.json : []).map((e) => String(ci(ci(e, "entry"), "id") || ""));
    const luS = await get("/api/roster?accountId=" + RND, { user: "stranger-x" });
    const luSIds = (Array.isArray(luS.json) ? luS.json : []).map((e) => String(ci(ci(e, "entry"), "id") || ""));
    ok("demo-foreign-hidden", luS.status === 200 && !luSIds.includes(String(uid)) && luSIds.includes(String(eid)), luS.status + " " + JSON.stringify(luSIds));
    const lh = await get("/api/roster?accountId=" + H1);
    const lhArr = Array.isArray(lh.json) ? lh.json : [];
    const lhIds = lhArr.map((e) => String(ci(ci(e, "entry"), "id") || ""));
    ok("demo-compat-visible", lh.status === 200 && lhIds.includes(String(uid)) && lhIds.includes(String(eid)), lh.status + " " + JSON.stringify(lhIds));
    const ch = await get("/api/roster/count?accountId=" + H1);
    ok("demo-count-coherent", ch.status === 200 && ci(ch.json, "total") === lhArr.length, ch.status + " " + ch.text.slice(0, 120));
    // --- unchanged board-direct-chat route still alive (no 410) ---
    const ap = await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
    ok("demo-approve", ap.status === 200, ap.status + " " + ap.text.slice(0, 160));
    const chat = await post("/api/boards/" + bid + "/advisors/" + aid + "/chat", { message: "hello advisor" });
    ok("demo-chat-alive", chat.status !== 404 && chat.status !== 410, String(chat.status) + " " + chat.text.slice(0, 160));
    // --- canonical edit: same id, version bump, no clones, no GET mutation ---
    const before = lhArr.find((e) => String(ci(ci(e, "entry"), "id")) === String(eid));
    const bv = ci(ci(before, "entry"), "version");
    const ed = await put("/api/roster/" + eid, { name: run + "-E-v2" });
    ok("demo-edit", ed.status === 200 && String(ci(ed.json, "id")) === String(eid) && ci(ed.json, "version") === bv + 1, ed.status + " " + ed.text.slice(0, 160));
    const la2 = await get("/api/roster?accountId=" + RND);
    const la2Arr = Array.isArray(la2.json) ? la2.json : [];
    ok("demo-no-clone", la2Arr.length === lrArr.length + 1, la2Arr.length + " vs " + (lrArr.length + 1));
    const la3 = await get("/api/roster?accountId=" + RND);
    ok("demo-no-get-mutation", JSON.stringify(la2.json) === JSON.stringify(la3.json));
    const advs = await get("/api/boards/" + bid + "/advisors");
    const advEntryIds = (Array.isArray(advs.json) ? advs.json : []).map((a) => String(ci(a, "rosterEntryId")));
    ok("demo-link-intact", advs.status === 200 && advEntryIds.includes(String(eid)), advs.status + " " + advs.text.slice(0, 160));
    const chat2 = await post("/api/boards/" + bid + "/advisors/" + aid + "/chat", { message: "hello again" });
    ok("demo-chat-postedit", chat2.status === 200 && typeof ci(chat2.json, "answer") === "string" && ci(chat2.json, "answer").length > 0, String(chat2.status) + " " + chat2.text.slice(0, 160));
    // --- unrelated demo user cannot edit someone else's explicit entry ---
    const edX = await put("/api/roster/" + eid, { name: "hijack" }, { user: "stranger-x" });
    ok("demo-stranger-edit-denied", edX.status === 403, String(edX.status));
    // --- secure mode: register flips the server; owner/stranger/guest boundaries ---
    const regO = await post("/api/auth/register", { email: "vis-owner@x.test", password: "0123456789ab" }, { user: false });
    ok("sec-register", regO.status === 201 && ci(regO.json, "token"), regO.status + " " + regO.text.slice(0, 160));
    const tO = ci(regO.json, "token");
    const regS = await post("/api/auth/register", { email: "vis-stranger@x.test", password: "0123456789ab" }, { user: false });
    ok("sec-register-stranger", regS.status === 201 && ci(regS.json, "token"), regS.status + " " + regS.text.slice(0, 120));
    const tS = ci(regS.json, "token");
    const sb = await post("/api/boards", { name: run + "-sboard", mission: run + " secure" }, { token: tO });
    ok("sec-board", sb.status === 201, sb.status + " " + sb.text.slice(0, 120));
    const sbid = ci(sb.json, "id");
    const sq = await post("/api/roster/quick", { accountId: guid(), name: run + "-SE", description: "secure entry for " + run }, { token: tO });
    ok("sec-quick", sq.status === 201, sq.status + " " + sq.text.slice(0, 120));
    const seid = ci(sq.json, "id");
    const so = await get("/api/roster?accountId=" + RND, { token: tO });
    const soArr = Array.isArray(so.json) ? so.json : [];
    ok("sec-owner-list", so.status === 200 && soArr.map((e) => String(ci(ci(e, "entry"), "id"))).includes(String(seid)), so.status + " " + so.text.slice(0, 200));
    const sco = await get("/api/roster/count?accountId=" + RND, { token: tO });
    ok("sec-owner-count", sco.status === 200 && ci(sco.json, "total") === soArr.length, sco.status + " " + sco.text.slice(0, 120));
    const ss = await get("/api/roster?accountId=" + RND, { token: tS });
    ok("sec-stranger-list-empty", ss.status === 200 && Array.isArray(ss.json) && ss.json.length === 0, ss.status + " " + ss.text.slice(0, 200));
    const scs = await get("/api/roster/count?accountId=" + RND, { token: tS });
    ok("sec-stranger-count-zero", scs.status === 200 && ci(scs.json, "total") === 0, scs.status + " " + scs.text.slice(0, 120));
    const seEdit = await put("/api/roster/" + seid, { name: run + "-SE-v2" }, { token: tS });
    ok("sec-stranger-edit-denied", seEdit.status === 403, String(seEdit.status));
    const seComp = await get("/api/roster/" + seid + "/completeness", { token: tS });
    ok("sec-stranger-detail-denied", seComp.status === 403, String(seComp.status));
    const seEditO = await put("/api/roster/" + seid, { name: run + "-SE-v2" }, { token: tO });
    ok("sec-owner-edit", seEditO.status === 200 && String(ci(seEditO.json, "id")) === String(seid), seEditO.status + " " + seEditO.text.slice(0, 160));
    // guest boundary: meeting-scoped grant sees advisors projection, never roster templates
    const mt = await post("/api/boards/" + sbid + "/meetings", { title: run + "-mtg" }, { token: tO });
    ok("sec-meeting", mt.status === 201, mt.status + " " + mt.text.slice(0, 120));
    const mid = ci(mt.json, "id");
    const gr = await post("/api/boards/" + sbid + "/grants", { userKey: "vis-stranger@x.test", access: "discuss", meetingId: mid }, { token: tO });
    ok("sec-grant", gr.status === 201, gr.status + " " + gr.text.slice(0, 160));
    const gl = await get("/api/roster?accountId=" + RND, { token: tS });
    ok("sec-guest-no-templates", gl.status === 200 && Array.isArray(gl.json) && gl.json.length === 0, gl.status + " " + gl.text.slice(0, 200));
    const gc = await get("/api/roster/count?accountId=" + RND, { token: tS });
    ok("sec-guest-count-zero", gc.status === 200 && ci(gc.json, "total") === 0, gc.status + " " + gc.text.slice(0, 120));
  } finally {
    kill();
  }
  console.log(fail === 0 ? ("VISQA PASS " + pass) : ("VISQA FAIL pass=" + pass + " fail=" + fail + " :: " + bad.join("; ")));
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("VISQA ERROR " + (e?.stack || e)); process.exit(2); });
