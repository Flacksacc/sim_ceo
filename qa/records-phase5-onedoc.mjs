// Records Phase 5 one-document review acceptance.
// Real isolated API only. Primary owns API and the scoped Secretary fake.
// Loopback only guard below refuses non loopback hosts and human ports.
// It is a guard, not an allowlist. Secretary seeding requires the scoped fake.
// Run scoped bears5 identity and boards only. Exit nonzero on any failure.
import crypto from "node:crypto";
const API = process.env.QA_API || "http://127.0.0.1:15320";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:15322";
for (const v of [API, FAKE]) {
  let u; try { u = new URL(v); } catch { console.error("REFUSE bad url " + v); process.exit(2); }
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") { console.error("REFUSE non loopback " + v); process.exit(2); }
}
if (/:5080|:5173/.test(API) || /:5080|:5173/.test(FAKE)) { console.error("REFUSE human port"); process.exit(2); }
const TAG = "records5-onedoc";
const run = "bears5-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; } else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
const OVERALL = setTimeout(() => { console.log("OVERALL TIMEOUT"); process.exit(3); }, 8 * 60 * 1000);
async function req(method, path, body, token) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 30000);
  try {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = "Bearer " + token;
    const r = await fetch(API + path, { method, signal: ctl.signal, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(tm); }
}
const get = (p, t) => req("GET", p, undefined, t);
const post = (p, b, t) => req("POST", p, b, t);
const camel = (o, k) => {
  if (!o || typeof o !== "object") return undefined;
  if (k in o) return o[k];
  const lo = k.toLowerCase();
  for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key];
  return undefined;
};
const leakRe = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32}/;
function humanStrings(v, depth) {
  const out = [];
  if (depth > 6 || v === null || v === undefined) return out;
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) { for (const e of v) out.push(...humanStrings(e, depth + 1)); return out; }
  if (typeof v === "object") {
    for (const k of ["title", "Title", "excerpt", "Excerpt", "body", "Body", "content", "Content", "text", "Text"]) { if (typeof v[k] === "string") out.push(v[k]); }
    for (const e of Object.values(v)) { if (e !== null && typeof e === "object") out.push(...humanStrings(e, depth + 1)); }
  }
  return out;
}
async function guards(did, tok) {
  const g = await get("/api/records/" + did, tok);
  ok("guards-" + String(did).slice(0, 8), g.status === 200, String(g.status));
  return { version: camel(g.json, "version"), hash: camel(g.json, "hash"), reviewToken: camel(g.json, "reviewToken"), watermark: camel(g.json, "watermark") };
}
function histOf(row) {
  try { const h = JSON.parse(camel(row, "historyJson") ?? "[]"); return Array.isArray(h) ? h : []; } catch { return []; }
}
async function register(email) {
  const r = await post("/api/auth/register", { email, password: "qa-password-12345" }, null);
  ok("register-" + email, r.status === 201 && r.json && r.json.token, String(r.status) + " " + r.text.slice(0, 120));
  const me = await get("/api/auth/me", r.json.token);
  ok("me-auth-" + email, me.status === 200 && camel(me.json, "authenticated") === true, String(me.status));
  return r.json.token;
}
console.log("[" + TAG + "] api=" + API + " run=" + run);
const ownerT = await register(run + "-owner@qa.invalid");
const strangerT = await register(run + "-stranger@qa.invalid");
const readerT = await register(run + "-reader@qa.invalid");
const contribT = await register(run + "-contrib@qa.invalid");
const board = await post("/api/boards", { name: run + "-board", mission: run + " mission", stage: "qa" }, ownerT);
ok("setup-board", board.status === 201 && camel(board.json, "id"), board.status + " " + board.text.slice(0, 160));
const bid = camel(board.json, "id");
const mtg = await post("/api/boards/" + bid + "/meetings", { title: run + " meet", brief: run + " brief" }, ownerT);
ok("setup-meeting", mtg.status === 201 && camel(mtg.json, "id"), String(mtg.status));
const mid = camel(mtg.json, "id");
const gR = await post("/api/boards/" + bid + "/grants", { userKey: run + "-reader@qa.invalid", access: "read" }, ownerT);
ok("grant-reader", gR.status === 201 || gR.status === 200, String(gR.status));
const gC = await post("/api/boards/" + bid + "/grants", { userKey: run + "-contrib@qa.invalid", access: "contribute" }, ownerT);
ok("grant-contrib", gC.status === 201 || gC.status === 200, String(gC.status));
const msg = await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "Bears opening drive memo" }, ownerT);
ok("setup-message", msg.status === 200 || msg.status === 201, String(msg.status));
const mseq = camel(msg.json, "sequence") ?? 1;
const wn = await post("/api/meetings/" + mid + "/notes", { title: "Bears working note", body: "bears provisional note alpha", kind: "note" }, ownerT);
ok("setup-note", wn.status === 201, String(wn.status));
const sec = await post("/api/meetings/" + mid + "/secretary", { input: "Bears context with SECRETARY-NOTE", clientNonce: crypto.randomBytes(8).toString("hex") }, ownerT);
ok("setup-secretary-note", sec.status === 200 && sec.json && sec.json.note, sec.status + " " + sec.text.slice(0, 300));
if (!(sec.json && sec.json.note)) { console.log("SECRETARY FAKE MISSING: point META_API_BASE at qa/records-phase5-fake.mjs; the plain fallback is not verified."); process.exit(1); }
const secKind = camel(sec.json.note, "kind") || "";
ok("setup-secretary-kind", secKind.indexOf("secretary") >= 0, secKind);
const gidA = crypto.randomUUID();
const gidB = crypto.randomUUID();
const gidC = crypto.randomUUID();
const gidD = crypto.randomUUID();
const items = [
  { id: gidA, text: "Bears approve alpha", refs: [{ kind: "message", ref: mid + ":" + String(mseq) }] },
  { id: gidB, text: "Bears pending beta" },
  { id: gidC, text: "Bears pending gamma" },
  { id: gidD, text: "Bears discard delta", refs: [{ kind: "note", ref: crypto.randomUUID() }] },
];
const d1 = await post("/api/meetings/" + mid + "/record/draft", items, ownerT);
ok("setup-draft", d1.status === 201 && camel(d1.json, "id"), String(d1.status));
const did = camel(d1.json, "id");
const rev = await get("/api/records/" + did + "/review", ownerT);
ok("review-200", rev.status === 200, String(rev.status));
const kinds = (rev.json.notes || []).map((n) => camel(n, "kind"));
ok("review-has-working-note", kinds.includes("note"), JSON.stringify(kinds));
ok("review-has-secretary-note", kinds.some((k) => String(k).indexOf("secretary") >= 0), JSON.stringify(kinds));
ok("review-notes-no-guid-leak", humanStrings(rev.json.notes, 0).every((s) => !leakRe.test(s)), "guid shaped text in notes");
ok("review-evidence-mixed", (rev.json.evidence || []).some((c) => !camel(c, "missing")) && (rev.json.evidence || []).some((c) => camel(c, "missing")), JSON.stringify((rev.json.evidence || []).map((c) => camel(c, "missing"))));
ok("review-evidence-no-guid-leak", humanStrings(rev.json.evidence, 0).every((s) => !leakRe.test(s)), "guid shaped text in evidence");
ok("review-recent-has-input", (rev.json.recentMessages || []).some((m) => String(camel(m, "content") || "").includes("Bears opening")), "recent missing");
ok("review-version-watermark", typeof camel(rev.json.draft, "version") === "number" && typeof rev.json.meetingWatermark === "number", "version watermark missing");
ok("review-lineage-present", Array.isArray(rev.json.predecessors) && Array.isArray(rev.json.successors) && Array.isArray(rev.json.effectiveIds) && Array.isArray(rev.json.lineageEffects), "lineage missing");
ok("review-pending-four", JSON.stringify([...rev.json.pending].sort()) === JSON.stringify([gidA, gidB, gidC, gidD].sort()), JSON.stringify(rev.json.pending).slice(0, 200));
ok("review-no-snapshot-bytes", !JSON.stringify(rev.json).includes("evidenceSnapshot"), "snapshot bytes in review");
const sg = await get("/api/records/" + did + "/review", strangerT);
ok("stranger-no-review", sg.status !== 200, String(sg.status));
ok("stranger-no-leak", !sg.text.includes("Bears approve alpha") && !sg.text.includes("reviewToken"), sg.text.slice(0, 200));
const rr = await get("/api/records/" + did + "/review", readerT);
ok("reader-review-200", rr.status === 200, String(rr.status));
ok("reader-guest-context", (rr.json.pending || []).length === 0 && (rr.json.notes || []).length === 0 && (rr.json.recentMessages || []).length === 0, "reader sees manage context");
ok("reader-evidence-approved-only", (rr.json.evidence || []).every((c) => (rev.json.approved || []).includes(camel(c, "itemId"))), "reader sees unapproved");
ok("reader-draft-no-history", !("historyJson" in (rr.json.draft || {})), "history disclosed to reader");
const rAp = await post("/api/records/" + did + "/items/approve", { ...(await guards(did, readerT)), itemId: gidA }, readerT);
ok("reader-approve-403", rAp.status === 403, String(rAp.status));
const rRv = await post("/api/records/" + did + "/items/revise", { ...(await guards(did, readerT)), itemId: gidB, text: "reader rewrite" }, readerT);
ok("reader-revise-403", rRv.status === 403, String(rRv.status));
const cAp = await post("/api/records/" + did + "/items/approve", { ...(await guards(did, contribT)), itemId: gidA }, contribT);
ok("contrib-approve-403", cAp.status === 403, String(cAp.status));
const cRv = await post("/api/records/" + did + "/items/revise", { ...(await guards(did, contribT)), itemId: gidB, text: "Bears revised beta" }, contribT);
ok("contrib-revise-200", cRv.status === 200, String(cRv.status));
const aA = await post("/api/records/" + did + "/items/approve", { ...(await guards(did, ownerT)), itemId: gidA }, ownerT);
ok("approve-gidA-200", aA.status === 200, String(aA.status));
const dD = await post("/api/records/" + did + "/items/discard", { ...(await guards(did, ownerT)), itemId: gidD }, ownerT);
ok("discard-gidD-200", dD.status === 200, String(dD.status));
const rev2 = await get("/api/records/" + did + "/review", ownerT);
ok("remaining-items", JSON.stringify([...rev2.json.pending].sort()) === JSON.stringify([gidB, gidC].sort()), JSON.stringify(rev2.json.pending));
const h2 = histOf((await get("/api/records/" + did, ownerT)).json);
const acts = h2.map((e) => String(e.action ?? "") + ":" + String(e.itemId ?? ""));
ok("history-approve-entry", acts.includes("approve:" + gidA), JSON.stringify(acts).slice(0, 300));
ok("history-revise-entry", h2.some((e) => e.action === "revise" && e.itemId === gidB && e.newText === "Bears revised beta"), "revise entry wrong");
ok("history-discard-entry", acts.includes("discard:" + gidD), JSON.stringify(acts).slice(0, 300));
ok("history-actor-present", h2.every((e) => typeof e.actor === "string" && e.actor !== ""), "anonymous entry");
ok("history-seq-tight", h2.every((e, i) => e.seq === i + 1) && h2.every((e) => typeof e.revision === "number" && typeof e.token === "string" && e.token !== ""), "seq revision token wrong");
const itemsAfter = JSON.parse((await get("/api/records/" + did, ownerT)).json.itemsJson);
ok("revise-preserves-approved", itemsAfter.find((i) => i.id === gidA).text === "Bears approve alpha" && itemsAfter.find((i) => i.id === gidB).text === "Bears revised beta", "items wrong");
const createEntry = h2.find((e) => e.action === "create");
ok("history-create-full-document", (() => { try { const v = JSON.parse(createEntry.newText); return Array.isArray(v) && v.length === 4; } catch { return false; } })(), "create entry is not full document");
const de = await post("/api/meetings/" + mid + "/record/draft", [], ownerT);
ok("setup-empty-draft", de.status === 201 && camel(de.json, "id"), String(de.status));
const eid = camel(de.json, "id");
const eRev = await get("/api/records/" + eid + "/review", ownerT);
ok("empty-review-no-pending", eRev.status === 200 && (eRev.json.pending || []).length === 0, String(eRev.status));
const eAll = await post("/api/records/" + eid + "/approve-all", await guards(eid, ownerT), ownerT);
ok("empty-approve-all-409", eAll.status === 409, String(eAll.status));
const allR = await post("/api/records/" + did + "/approve-all", await guards(did, ownerT), ownerT);
ok("approve-all-200", allR.status === 200, String(allR.status));
const rev3 = await get("/api/records/" + did + "/review", ownerT);
ok("all-decided", (rev3.json.pending || []).length === 0 && rev3.json.draft.decided === true, "not decided");
const again = await post("/api/records/" + did + "/items/approve", { ...(await guards(did, ownerT)), itemId: gidB }, ownerT);
ok("decided-approve-409", again.status === 409, String(again.status));
const s1 = await post("/api/meetings/" + mid + "/record/draft", [{ id: "S1", text: "Bears stale one" }, { id: "S2", text: "Bears stale two" }], ownerT);
const sid = camel(s1.json, "id");
const g0 = await guards(sid, ownerT);
await post("/api/records/" + sid + "/items/revise", { ...g0, itemId: "S1", text: "Bears other-client revision" }, ownerT);
const hBefore = histOf((await get("/api/records/" + sid, ownerT)).json).length;
const stale = await post("/api/records/" + sid + "/items/approve", { ...g0, itemId: "S2" }, ownerT);
ok("stale-approve-409", stale.status === 409, String(stale.status));
ok("stale-guided-refresh", /refresh/i.test(stale.text), stale.text.slice(0, 240));
ok("stale-server-has-no-client-wording", !/no automatic retry/i.test(stale.text), "server leaks client wording");
ok("conflict-no-history-write", histOf((await get("/api/records/" + sid, ownerT)).json).length === hBefore, "failed click wrote history");
await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "Bears fresh input moves watermark" }, ownerT);
const g1 = await guards(sid, ownerT);
const rf = await post("/api/records/" + sid + "/refresh", g1, ownerT);
ok("explicit-refresh-200", rf.status === 200, String(rf.status));
ok("refresh-rotates-token", camel(rf.json.draft || rf.json, "reviewToken") !== g1.reviewToken, "token unchanged");
const revS = await get("/api/records/" + sid + "/review", ownerT);
ok("refresh-no-auto-approve", JSON.stringify([...revS.json.pending].sort()) === JSON.stringify(["S1", "S2"]), JSON.stringify(revS.json.pending));
ok("refresh-history-entry", histOf((await get("/api/records/" + sid, ownerT)).json).some((e) => e.action === "refresh"), "no refresh history");
const wholeRev = await post("/api/records/" + did + "/revise", { ...(await guards(did, ownerT)), items: [{ id: "S1", text: "x" }] }, ownerT);
ok("whole-revise-after-decisions-409", wholeRev.status === 409, String(wholeRev.status));
const br = await post("/api/records/" + did + "/revise", { ...(await guards(did, ownerT)), items: [{ id: "S1", text: "Bears stale one v2" }, { id: "S2", text: "Bears stale two" }] }, ownerT);
ok("branch-v2-201", (br.status === 201 || br.status === 200) && camel(br.json, "id"), String(br.status));
const nid = camel(br.json, "id");
const oldRev = await get("/api/records/" + sid + "/review", ownerT);
ok("old-successor-listed", (oldRev.json.successors || []).includes(nid), JSON.stringify(oldRev.json.successors));
const newRev = await get("/api/records/" + nid + "/review", ownerT);
ok("new-predecessor-listed", (newRev.json.predecessors || []).includes(sid), JSON.stringify(newRev.json.predecessors));
const oldAp = await post("/api/records/" + sid + "/items/approve", { ...(await guards(sid, ownerT)), itemId: "S2" }, ownerT);
ok("superseded-approve-409", oldAp.status === 409, String(oldAp.status));
const effEmpty = await get("/api/records/" + nid + "/effective", ownerT);
ok("effective-404-before-approvals", effEmpty.status === 404, String(effEmpty.status));
const apNew = await post("/api/records/" + nid + "/items/approve", { ...(await guards(nid, ownerT)), itemId: "S1" }, ownerT);
ok("successor-approve-200", apNew.status === 200, String(apNew.status));
const eff = await get("/api/records/" + nid + "/effective", ownerT);
ok("effective-head", camel(eff.json, "head") === nid, JSON.stringify(eff.json).slice(0, 200));
const c0 = await post("/api/meetings/" + mid + "/record/draft", [{ id: "C0", text: "Bears chain base" }], ownerT);
let cid = camel(c0.json, "id");
ok("chain-base", c0.status === 201 && cid, String(c0.status));
for (let v = 0; v < 55; v++) {
  const gg = await guards(cid, ownerT);
  const nb = await post("/api/records/" + cid + "/revise", { ...gg, items: [{ id: "C0", text: "Bears chain base rev" + v }] }, ownerT);
  if (nb.status !== 201 && nb.status !== 200) { ok("chain-step-" + v, false, String(nb.status)); break; }
  cid = camel(nb.json, "id");
}
const chainRev = await get("/api/records/" + cid + "/review", ownerT);
ok("chain-over-50", (chainRev.json.predecessors || []).length > 50, String((chainRev.json.predecessors || []).length));
const listAll = await get("/api/meetings/" + mid + "/records", ownerT);
ok("list-capped-50", Array.isArray(listAll.json) && listAll.json.length <= 50, String(Array.isArray(listAll.json) && listAll.json.length));
const oldestId = (chainRev.json.predecessors || [])[0];
const oldest = await get("/api/records/" + oldestId, ownerT);
ok("singular-oldest-version", oldest.status === 200 && oldest.json.version === 1 && oldest.json.meetingId === mid, String(oldest.status));
console.log("[" + TAG + "] pass=" + pass + " fail=" + fail);
clearTimeout(OVERALL);
if (fail > 0) { console.log("FAILURES:"); for (const f of failures) console.log(" - " + f); process.exit(1); }
