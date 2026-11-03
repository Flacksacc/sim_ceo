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
        // --- secure mode, genuine legacy graph via backup/restore ---
    // First registration becomes installation admin; Alice (owner under test) is NON-admin
    // so the non-admin list/count filters actually execute.
    const regA = await post("/api/auth/register", { email: "vis-admin@x.test", password: "0123456789ab" }, { user: false });
    ok("sec-admin-register", regA.status === 201 && ci(regA.json, "token"), regA.status + " " + regA.text.slice(0, 120));
    const tA = ci(regA.json, "token");
    const regO = await post("/api/auth/register", { email: "vis-alice@x.test", password: "0123456789ab" }, { user: false });
    ok("sec-alice-register", regO.status === 201 && ci(regO.json, "token"), regO.status + " " + regO.text.slice(0, 120));
    const tO = ci(regO.json, "token");
    const regS = await post("/api/auth/register", { email: "vis-bob@x.test", password: "0123456789ab" }, { user: false });
    ok("sec-bob-register", regS.status === 201 && ci(regS.json, "token"), regS.status + " " + regS.text.slice(0, 120));
    const tS = ci(regS.json, "token");
    const bA1 = await post("/api/boards", { name: run + "-A1", mission: run + " alice" }, { token: tO });
    ok("sec-board-alice", bA1.status === 201, bA1.status + " " + bA1.text.slice(0, 120));
    const a1 = ci(bA1.json, "id");
    const bBB = await post("/api/boards", { name: run + "-BB", mission: run + " bob" }, { token: tS });
    ok("sec-board-bob", bBB.status === 201, bBB.status + " " + bBB.text.slice(0, 120));
    const bb = ci(bBB.json, "id");
    const bAD = await post("/api/boards", { name: run + "-ADM", mission: run + " admin" }, { token: tA });
    ok("sec-board-admin", bAD.status === 201, bAD.status + " " + bAD.text.slice(0, 120));
    const adm = ci(bAD.json, "id");
    async function seedEntry(name, o) {
      const q = await post("/api/roster/quick", { accountId: guid(), name, description: name + " for " + run }, o);
      const id = ci(q.json, "id");
      const u = await uploadPortrait(id, o);
      const im = await get("/api/roster/" + id + "/images", o);
      const rv = await post("/api/images/" + ci(im.json?.[0], "id") + "/review", { decision: "accept" }, o);
      return { status: q.status === 201 && u.status === 201 && rv.status === 200 ? 201 : 500, id };
    }
    const e1 = await seedEntry(run + "-L1", { token: tO });
    const e2 = await seedEntry(run + "-L2", { token: tO });
    const e3 = await seedEntry(run + "-L3", { token: tO });
    const ex = await seedEntry(run + "-EX", { token: tO });
    ok("sec-seed", e1.status === 201 && e2.status === 201 && e3.status === 201 && ex.status === 201, [e1.id, e2.id, e3.id, ex.id].join(","));
    const c1 = await post("/api/roster/" + e1.id + "/copy", { boardId: a1, boardRole: "Seat1" }, { token: tO });
    const c2 = await post("/api/roster/" + e2.id + "/copy", { boardId: a1, boardRole: "Seat2" }, { token: tO });
    const c3 = await post("/api/roster/" + e3.id + "/copy", { boardId: a1, boardRole: "Seat3" }, { token: tO });
    const c3b = await post("/api/roster/" + e3.id + "/copy", { boardId: bb, boardRole: "Seat3b" }, { token: tA });
    const cx = await post("/api/roster/" + ex.id + "/copy", { boardId: a1, boardRole: "SeatX" }, { token: tO });
    const cxb = await post("/api/roster/" + ex.id + "/copy", { boardId: adm, boardRole: "SeatXb" }, { token: tA });
    ok("sec-links", [c1, c2, c3, c3b, cx, cxb].every((r) => r.status === 201), [c1.status, c2.status, c3.status, c3b.status, cx.status, cxb.status].join(","));
    const aid1 = ci(c1.json, "id");
    const ap1 = await post("/api/boards/" + a1 + "/advisors/" + aid1 + "/approve", {}, { token: tO });
    ok("sec-approve", ap1.status === 200, ap1.status + " " + ap1.text.slice(0, 120));
    // Export, convert E1/E2/E3 to genuine blank-owner legacy rows, retire E2's only link.
    const bk = await get("/api/backup", { token: tA });
    ok("sec-export", bk.status === 200 && ci(bk.json, "snapshot"), bk.status + " " + bk.text.slice(0, 120));
    const snap = JSON.parse(ci(bk.json, "snapshot"));
    const norm = (v) => String(v || "").toLowerCase();
    const blankIds = [e1.id, e2.id, e3.id].map(norm);
    for (const r of snap.roster) if (blankIds.includes(norm(r.Id))) r.OwnerKey = "";
    let retired = 0;
    for (const a of snap.advisors) {
      if (norm(a.RosterEntryId) === norm(e2.id) && norm(a.BoardId) === norm(a1) && !a.Removed) { a.Removed = true; retired++; }
    }
    ok("sec-edit-one-link-retired", retired === 1, String(retired));
    const { createHash } = await import("node:crypto");
    const snapStr = JSON.stringify(snap);
    const snapHash = createHash("sha256").update(snapStr, "utf8").digest("hex");
    const rs = await post("/api/backup/restore", { snapshot: snapStr, hash: snapHash }, { token: tA });
    ok("sec-restore", rs.status === 200, rs.status + " " + rs.text.slice(0, 200));
    // Authoritative post-restore fixture check BEFORE any visibility negative.
    const al = await get("/api/roster?accountId=" + RND, { token: tO });
    const alArr = Array.isArray(al.json) ? al.json : [];
    const byId = (id) => alArr.find((e) => norm(ci(ci(e, "entry"), "id")) === norm(id));
    const g1 = byId(e1.id), g2 = byId(e2.id), g3 = byId(e3.id), gx = byId(ex.id);
    ok("sec-restore-ids-stable", !!(g1 && g2 && g3 && gx), alArr.map((e) => ci(ci(e, "entry"), "id")).join(",").slice(0, 300));
    ok("sec-restore-blank", g1 && g2 && g3 && ci(ci(g1, "entry"), "ownerKey") === "" && ci(ci(g2, "entry"), "ownerKey") === "" && ci(ci(g3, "entry"), "ownerKey") === "", JSON.stringify([g1 && ci(ci(g1, "entry"), "ownerKey"), g2 && ci(ci(g2, "entry"), "ownerKey")]).slice(0, 120));
    ok("sec-restore-profile", g1 && (ci(ci(g1, "entry"), "profileJson") || "").includes("L1") && (ci(ci(g1, "entry"), "name") || "").includes("L1"), String(g1 && ci(ci(g1, "entry"), "name")).slice(0, 80));
    ok("sec-restore-explicit-owner", gx && ci(ci(gx, "entry"), "ownerKey") === "vis-alice@x.test", String(gx && ci(ci(gx, "entry"), "ownerKey")).slice(0, 80));
    // Random browser-local account: Alice sees every appropriate entry, list==count.
    const alIds = alArr.map((e) => norm(ci(ci(e, "entry"), "id")));
    ok("sec-alice-list", al.status === 200 && [e1.id, e2.id, e3.id, ex.id].every((id) => alIds.includes(norm(id))), al.status + " n=" + alArr.length);
    const ac = await get("/api/roster/count?accountId=" + RND, { token: tO });
    ok("sec-alice-count", ac.status === 200 && ci(ac.json, "total") === alArr.length, ac.status + " " + ac.text.slice(0, 120));
    // Historical-only E2: owner edit works on the canonical entry, no clones, no GET mutation.
    const ed2 = await put("/api/roster/" + e2.id, { name: run + "-L2-v2" }, { token: tO });
    ok("sec-historical-edit", ed2.status === 200 && norm(ci(ed2.json, "id")) === norm(e2.id), ed2.status + " " + ed2.text.slice(0, 160));
    const alA = await get("/api/roster?accountId=" + RND, { token: tO });
    const alB = await get("/api/roster?accountId=" + RND, { token: tO });
    ok("sec-no-clone-mutation", alA.status === 200 && alB.status === 200 && JSON.stringify(alA.json) === JSON.stringify(alB.json) && alA.json.length === alArr.length, "n=" + (alA.json || []).length);
    // Owner edit of the ACTIVE legacy entry flows into the next board-direct-chat
    // prompt from the same canonical entry. Asserted on the fake provider's
    // delivered prompt log (not the answer text or self-rating).
    const FAKEB = "http://127.0.0.1:15962";
    async function fakeLog() { const r = await fetch(FAKEB + "/__log"); return r.ok ? await r.json() : []; }
    async function clearFakeLog() { await fetch(FAKEB + "/__log", { method: "DELETE" }); }
    const chatPrompts = async () => (await fakeLog()).filter((e) => e.path === "chat").map((e) => e.full || "");
    const oldName1 = run + "-L1";
    const newName1 = "Proven-" + run;
    const proofMark = "CANONICAL-PROMPT-PROOF-77";
    const ch0 = await post("/api/boards/" + a1 + "/advisors/" + aid1 + "/chat", { message: "baseline" }, { token: tO });
    const basePrompts = await chatPrompts();
    const baseLast = basePrompts.length ? basePrompts[basePrompts.length - 1] : "";
    ok("sec-chat-prompt-baseline", ch0.status === 200 && baseLast.includes(oldName1) && !baseLast.includes(proofMark), String(ch0.status));
    await clearFakeLog();
    const newProfile1 = JSON.stringify({ proof: proofMark, background: "edited canonical background for " + run, strengths: ["tradeoffs"], methods: ["comparison"], evidenceNeeded: ["sources"], limits: ["defers"] });
    const ed1 = await put("/api/roster/" + e1.id, { name: newName1, profileJson: newProfile1 }, { token: tO });
    ok("sec-active-edit", ed1.status === 200 && norm(ci(ed1.json, "id")) === norm(e1.id), ed1.status + " " + ed1.text.slice(0, 160));
    const sy1 = await post("/api/boards/" + a1 + "/advisors/" + aid1 + "/sync-roster", {}, { token: tO });
    ok("sec-sync", sy1.status === 200, sy1.status + " " + sy1.text.slice(0, 160));
    const ap1b = await post("/api/boards/" + a1 + "/advisors/" + aid1 + "/approve", {}, { token: tO });
    ok("sec-reapprove", ap1b.status === 200, ap1b.status + " " + ap1b.text.slice(0, 160));
    const chA = await post("/api/boards/" + a1 + "/advisors/" + aid1 + "/chat", { message: "hello advisor" }, { token: tO });
    const postPrompts = await chatPrompts();
    const lastPrompt = postPrompts.length ? postPrompts[postPrompts.length - 1] : "";
    ok("sec-chat-canonical", chA.status === 200 && lastPrompt.includes(newName1) && lastPrompt.includes(proofMark) && !lastPrompt.includes(oldName1), String(chA.status) + " prompt=" + lastPrompt.slice(0, 200));
    // Stranger Bob: no access to Alice's legacy entries; ambiguous E3 editable by neither linker.
    const bl = await get("/api/roster?accountId=" + RND, { token: tS });
    const blIds = (Array.isArray(bl.json) ? bl.json : []).map((e) => norm(ci(ci(e, "entry"), "id")));
    ok("sec-bob-negatives", bl.status === 200 && !blIds.includes(norm(e1.id)) && !blIds.includes(norm(e2.id)), bl.status + " " + JSON.stringify(blIds).slice(0, 200));
    const bc = await get("/api/roster/count?accountId=" + RND, { token: tS });
    ok("sec-bob-count", bc.status === 200 && ci(bc.json, "total") === blIds.length, bc.status + " " + bc.text.slice(0, 120));
    const eb = await put("/api/roster/" + e1.id, { name: "hijack" }, { token: tS });
    ok("sec-bob-edit-denied", eb.status === 403, String(eb.status));
    const ea = await put("/api/roster/" + e3.id, { name: "alice-claim" }, { token: tO });
    const ebb = await put("/api/roster/" + e3.id, { name: "bob-claim" }, { token: tS });
    ok("sec-ambiguous-denied", ea.status === 403 && ebb.status === 403, ea.status + "/" + ebb.status);
    const exa = await put("/api/roster/" + ex.id, { name: run + "-EX-v2" }, { token: tO });
    ok("sec-explicit-wins", exa.status === 200 && norm(ci(exa.json, "id")) === norm(ex.id), exa.status + " " + exa.text.slice(0, 160));
    // Meeting-only guest: templates never leak; own-board membership still projected.
    const mt = await post("/api/boards/" + a1 + "/meetings", { title: run + "-mtg" }, { token: tO });
    ok("sec-meeting", mt.status === 201, mt.status + " " + mt.text.slice(0, 120));
    const mid = ci(mt.json, "id");
    const gr = await post("/api/boards/" + a1 + "/grants", { userKey: "vis-bob@x.test", access: "discuss", meetingId: mid }, { token: tO });
    ok("sec-grant", gr.status === 201, gr.status + " " + gr.text.slice(0, 160));
    const gl = await get("/api/roster?accountId=" + RND, { token: tS });
    const glIds = (Array.isArray(gl.json) ? gl.json : []).map((e) => norm(ci(ci(e, "entry"), "id")));
    ok("sec-guest-boundary", gl.status === 200 && !glIds.includes(norm(e1.id)) && !glIds.includes(norm(e2.id)), gl.status + " " + JSON.stringify(glIds).slice(0, 200));
    const gc = await get("/api/roster/count?accountId=" + RND, { token: tS });
    ok("sec-guest-count", gc.status === 200 && ci(gc.json, "total") === glIds.length, gc.status + " " + gc.text.slice(0, 120));
  } finally {
    kill();
  }
  console.log(fail === 0 ? ("VISQA PASS " + pass) : ("VISQA FAIL pass=" + pass + " fail=" + fail + " :: " + bad.join("; ")));
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("VISQA ERROR " + (e?.stack || e)); process.exit(2); });
