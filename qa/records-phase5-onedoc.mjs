// Records Phase 5 one-document review acceptance.
// Real isolated API only. Primary owns API and the scoped Secretary fake.
// Loopback only guard below refuses non loopback hosts and human ports.
// It is a guard, not an allowlist. Secretary seeding requires the scoped fake.
// Run scoped bears5 identity and boards only. Exit nonzero on any failure.
import crypto from "node:crypto";
const API = process.env.QA_API || "http://127.0.0.1:15320";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:15322";
const EXPECT_PORTS = { QA_API: 15320, QA_FAKE: 15322 };
for (const pair of [["QA_API", API, 15320], ["QA_FAKE", FAKE, 15322]]) {
  const nm = pair[0]; const v = pair[1]; const want = pair[2];
  let u; try { u = new URL(v); } catch { console.error("REFUSE bad " + nm + " " + v); process.exit(2); }
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") { console.error("REFUSE non loopback " + nm); process.exit(2); }
  if (Number(u.port) !== want) { console.error("REFUSE " + nm + " must be 127.0.0.1:" + want + " (owned disposable) got " + v); process.exit(2); }
  if (u.search || u.hash || u.username || u.password) { console.error("REFUSE " + nm + " must have no query/fragment/userinfo got " + v); process.exit(2); }
}
if (/:5080|:5173|:9333/.test(API) || /:5080|:5173|:9333/.test(FAKE)) { console.error("REFUSE human port"); process.exit(2); }
const PROV = process.env.SIMCEO_INSTANCE || process.env.QA_PROVENANCE || "";
if (!PROV) { console.error("REFUSE missing provenance: primary must launch the owned API with SIMCEO_INSTANCE set"); process.exit(2); }
const META_BASE = process.env.META_API_BASE || "";
const META_KEY = process.env.META_API_KEY || "";
const EXPECT_BOOT = process.env.QA_FAKE_BOOT || "";
if (!META_BASE) { console.error("REFUSE missing META_API_BASE: owned launcher must point the API at the scoped fake"); process.exit(2); }
{ let _u; try { _u = new URL(META_BASE); } catch { console.error("REFUSE bad META_API_BASE"); process.exit(2); }
  if (_u.hostname !== "127.0.0.1" && _u.hostname !== "localhost") { console.error("REFUSE META_API_BASE non loopback"); process.exit(2); }
  if (Number(_u.port) !== 15322) { console.error("REFUSE META_API_BASE must be 127.0.0.1:15322 got " + META_BASE); process.exit(2); }
  if (_u.search || _u.hash || _u.username || _u.password) { console.error("REFUSE META_API_BASE no query/fragment/userinfo"); process.exit(2); } }
if (META_BASE !== FAKE) { console.error("REFUSE META_API_BASE must equal owned QA_FAKE exactly"); process.exit(2); }
if (!META_KEY || !META_KEY.startsWith("qa-only")) { console.error("REFUSE META_API_KEY must be qa-only (no real provider keys)"); process.exit(2); }
const TAG = "records5-onedoc";
const run = "bears5-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
let pass = 0, fail = 0;
const failures = [];
function preflight(name, cond, extra) {
  if (cond) { pass++; } else { console.error("PREFLIGHT FAIL " + name + (extra ? " :: " + extra : "")); process.exit(2); }
}
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
    const r = await fetch(API + path, { method, signal: ctl.signal, redirect: "error", headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(tm); }
}
const get = (p, t) => req("GET", p, undefined, t);
const post = (p, b, t) => req("POST", p, b, t);
async function fakeFetch(path, opts) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(FAKE + path, { redirect: "error", signal: ctl.signal, ...(opts || {}) });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(tm); }
}
// PublicDTO equality only: compares wire review DTO bytes (items/approved/discarded/history/version/hash/revision/status/decided/supersedes/token/watermark + pending/approved/discarded/historyCount). It does not observe internal evidence snapshots, orphan successors, or other atomic effects; those are covered by separate Atomic probes (see qa/RecordAtomicProbe), not claimed here.
async function canonState(did, tok) {
  const d = await get("/api/records/" + did, tok);
  const r = await get("/api/records/" + did + "/review", tok);
  if (d.status !== 200 || r.status !== 200) throw new Error("canonState requires 200 got " + d.status + "/" + r.status + " for " + did);
  return JSON.stringify({
    items: camel(d.json, "itemsJson"), ap: camel(d.json, "approvedJson"), dc: camel(d.json, "discardedJson"),
    hist: camel(d.json, "historyJson"), v: camel(d.json, "version"), h: camel(d.json, "hash"),
    rev: camel(d.json, "reviewRevision"), st: camel(d.json, "status"), dec: camel(d.json, "decided"), sup: camel(d.json, "supersedesJson"), leg: camel(d.json, "legacyReview"),
    tok: camel(d.json, "reviewToken"), wm: camel(d.json, "watermark"),
    pend: r.json ? r.json.pending : null, appr: r.json ? r.json.approved : null,
    disc: r.json ? r.json.discarded : null, hc: r.json ? r.json.historyCount : null,
  });
}
async function uploadPortrait(rid, tok) {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), "qa.png");
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(API + "/api/roster/" + rid + "/image/upload", { method: "POST", signal: ctl.signal, redirect: "error", headers: { authorization: "Bearer " + tok }, body: form });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(tm); }
}
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
  preflight("guards-" + String(did).slice(0, 8), g.status === 200, String(g.status));
  return { version: camel(g.json, "version"), hash: camel(g.json, "hash"), reviewToken: camel(g.json, "reviewToken"), watermark: camel(g.json, "watermark") };
}
function histOf(row) {
  try { const h = JSON.parse(camel(row, "historyJson") ?? "[]"); return Array.isArray(h) ? h : []; } catch { return []; }
}
async function register(email) {
  const r = await post("/api/auth/register", { email, password: "qa-password-12345" }, null);
  preflight("register-" + email, r.status === 201 && r.json && r.json.token, String(r.status) + " " + r.text.slice(0, 120));
  const me = await get("/api/auth/me", r.json.token);
  preflight("me-auth-" + email, me.status === 200 && camel(me.json, "authenticated") === true, String(me.status));
  return r.json.token;
}
console.log("[" + TAG + "] api=" + API + " run=" + run);
{
  const h = await req("GET", "/health", undefined, null);
  preflight("preflight-health", h.status === 200 && h.json && h.json.ok === true, String(h.status));
  preflight("preflight-health-instance", h.json && String(camel(h.json, "instance")) === PROV, "instance=" + String(h.json && camel(h.json, "instance")) + " prov=" + PROV);
  const be = await req("GET", "/api/backend", undefined, null);
  const mode = String((be.json && (camel(be.json, "mode"))) || "").toLowerCase();
  preflight("preflight-backend", be.status === 200 && !!be.json, String(be.status));
  preflight("preflight-backend-memory", be.status === 200 && mode === "memory", "mode=" + mode + " status=" + String(be.status));
  const fh = await fakeFetch("/__health");
  preflight("preflight-fake-health", fh.status === 200 && fh.json && fh.json.fake === "records5-scoped", String(fh.status));
  preflight("preflight-fake-boot", !!(fh.json && fh.json.boot), "no boot nonce");
  globalThis.__fakeBoot = fh.json && fh.json.boot;
  preflight("preflight-fake-owned", !EXPECT_BOOT || (fh.json && fh.json.boot === EXPECT_BOOT), "fake boot mismatch (not the owned launcher fake)");
  const fc = await fakeFetch("/__counts");
  preflight("preflight-fake-counts", fc.status === 200 && fc.json && typeof fc.json.chat === "number", String(fc.status));
  globalThis.__fakeChatBefore = (fc.json && fc.json.chat) || 0;
}
const ownerT = await register(run + "-owner@qa.invalid");
const strangerT = await register(run + "-stranger@qa.invalid");
const readerT = await register(run + "-reader@qa.invalid");
const contribT = await register(run + "-contrib@qa.invalid");
const board = await post("/api/boards", { name: run + "-board", mission: run + " mission", stage: "qa" }, ownerT);
preflight("setup-board", board.status === 201 && camel(board.json, "id"), board.status + " " + board.text.slice(0, 160));
const bid = camel(board.json, "id");
const gR = await post("/api/boards/" + bid + "/grants", { userKey: run + "-reader@qa.invalid", access: "read" }, ownerT);
preflight("grant-reader", gR.status === 201 || gR.status === 200, String(gR.status));
const gC = await post("/api/boards/" + bid + "/grants", { userKey: run + "-contrib@qa.invalid", access: "contribute" }, ownerT);
preflight("grant-contrib", gC.status === 201 || gC.status === 200, String(gC.status));
const lead = await post("/api/boards/" + bid + "/lead", { name: "Bears Lead", roleLabel: "Board Lead", background: "Bears lead background", familiarTopics: "Bears familiar topics", simplerTopics: "Bears simpler topics", commPrefs: "Bears direct comms" }, ownerT);
preflight("setup-lead", lead.status === 200, lead.status + " " + lead.text.slice(0, 200));
const quick = await post("/api/roster/quick", { accountId: crypto.randomUUID(), name: run + "-advisor", description: "Advisor helping with " + run + " strategy and review work for grounding" }, ownerT);
preflight("setup-quick", quick.status === 201 && (camel(quick.json, "id") || (quick.json.entry && quick.json.entry.id)), quick.status + " " + quick.text.slice(0, 200));
const qrid = camel(quick.json, "id") || (quick.json.entry && quick.json.entry.id);
const up = await uploadPortrait(qrid, ownerT);
preflight("setup-portrait-upload", up.status === 201, up.status + " " + up.text.slice(0, 200));
const imgs = await get("/api/roster/" + qrid + "/images", ownerT);
const imgId = (imgs.json && (camel(imgs.json[0], "id"))) || null;
preflight("setup-portrait-list", !!imgId, JSON.stringify(imgs.json).slice(0, 200));
const imgRev = await post("/api/images/" + imgId + "/review", { decision: "accept" }, ownerT);
preflight("setup-portrait-accept", imgRev.status === 200, imgRev.status + " " + imgRev.text.slice(0, 200));
const cpAdv = await post("/api/roster/" + qrid + "/copy", { boardId: bid, boardRole: "Strategist" }, ownerT);
preflight("setup-advisor-copy", cpAdv.status === 201 && camel(cpAdv.json, "id"), cpAdv.status + " " + cpAdv.text.slice(0, 200));
const aidAdv = camel(cpAdv.json, "id");
const apAdv = await post("/api/boards/" + bid + "/advisors/" + aidAdv + "/approve", {}, ownerT);
preflight("setup-advisor-approve", apAdv.status === 200, apAdv.status + " " + apAdv.text.slice(0, 200));
const mtg = await post("/api/boards/" + bid + "/meetings", { title: run + " meet", brief: run + " brief" }, ownerT);
preflight("setup-meeting", mtg.status === 201 && camel(mtg.json, "id"), String(mtg.status));
const mid = camel(mtg.json, "id");
const msg = await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "Bears opening drive memo" }, ownerT);
preflight("setup-message", msg.status === 200 || msg.status === 201, String(msg.status));
const mseq = camel(msg.json, "sequence") ?? 1;
const wn = await post("/api/meetings/" + mid + "/notes", { title: "Bears working note", body: "bears provisional note alpha", kind: "note" }, ownerT);
preflight("setup-note", wn.status === 201, String(wn.status));
{
  const u0 = await get("/api/usage?boardId=" + bid + "&meetingId=" + mid, ownerT);
  preflight("preflight-usage-ledger", u0.status === 200 && Array.isArray(u0.json), String(u0.status));
  globalThis.__usageBefore = u0.json.length;
}
const wnNested = await post("/api/meetings/" + mid + "/notes", { title: "Bears nested note", body: JSON.stringify({ text: "visible nested wire decision", reviewToken: "internal" }), kind: "note" }, ownerT);
preflight("setup-nested-note", wnNested.status === 201, String(wnNested.status));
const wnDouble = await post("/api/meetings/" + mid + "/notes", { title: "Bears double-encoded note", body: JSON.stringify(JSON.stringify({ text: "visible double-encoded wire decision", reviewToken: "internal" })), kind: "note" }, ownerT);
preflight("setup-double-note", wnDouble.status === 201, String(wnDouble.status));
const sec = await post("/api/meetings/" + mid + "/secretary", { input: "Bears context with SECRETARY-NOTE " + run, clientNonce: crypto.randomBytes(8).toString("hex") }, ownerT);
ok("setup-secretary-note", sec.status === 200 && sec.json && sec.json.note, sec.status + " " + sec.text.slice(0, 300));
if (!(sec.json && sec.json.note)) { console.log("SECRETARY FAKE MISSING: point META_API_BASE at qa/records-phase5-fake.mjs; the plain fallback is not verified."); process.exit(1); }
const secKind = camel(sec.json.note, "kind") || "";
ok("setup-secretary-kind", secKind.indexOf("secretary") >= 0, secKind);
{
  const fc = await fakeFetch("/__counts");
  preflight("fake-routing-chat", fc.status === 200 && fc.json && fc.json.chat > globalThis.__fakeChatBefore, "chat=" + JSON.stringify(fc.json));
  const lg = await fakeFetch("/__log");
  const prompts = Array.isArray(lg.json) ? lg.json.map((e) => String((e && e.prompt) || "")) : [];
  preflight("fake-routing-prompt", prompts.some((s) => s.includes("SECRETARY-NOTE") && s.includes(run)), "no run-correlated SECRETARY-NOTE in fake log");
  const fh = await fakeFetch("/__health");
  preflight("fake-same-instance", fh.json && fh.json.boot === globalThis.__fakeBoot, "fake restarted mid-run");
  const u1 = await get("/api/usage?boardId=" + bid + "&meetingId=" + mid, ownerT);
  preflight("usage-metered-once", u1.status === 200 && Array.isArray(u1.json) && u1.json.length === globalThis.__usageBefore + 1, "usage=" + JSON.stringify(u1.json).slice(0, 160));
}
{
  const nb = await post("/api/boards", { name: run + "-nolead-board", mission: run + " nolead mission", stage: "qa" }, ownerT);
  preflight("setup-nolead-board", nb.status === 201 && camel(nb.json, "id"), String(nb.status));
  const nbid = camel(nb.json, "id");
  const nm = await post("/api/boards/" + nbid + "/meetings", { title: run + " nolead meet", brief: run + " nolead brief" }, ownerT);
  preflight("setup-nolead-meeting", nm.status === 201 && camel(nm.json, "id"), String(nm.status));
  const nmid = camel(nm.json, "id");
  const countsNeg0 = await fakeFetch("/__counts");
  preflight("setup-gate-counts", countsNeg0.status === 200 && countsNeg0.json && typeof countsNeg0.json.chat === "number", String(countsNeg0.status));
  const chatBeforeNeg = countsNeg0.json.chat;
  let nsecStatus = -1, nsecText = "";
  try { const r = await post("/api/meetings/" + nmid + "/secretary", { input: "Bears context with SECRETARY-NOTE " + run + "-nolead", clientNonce: crypto.randomBytes(8).toString("hex") }, ownerT); nsecStatus = r.status; nsecText = r.text; }
  catch (e) { nsecStatus = 0; nsecText = "TRANSPORT:" + String(e).slice(0, 120); }
  ok("setup-gate-requires-lead", nsecStatus !== 200 && nsecStatus !== 0, String(nsecStatus) + " " + nsecText.slice(0, 160));
  const countsNeg1 = await fakeFetch("/__counts");
  preflight("setup-gate-counts-after", countsNeg1.status === 200 && countsNeg1.json && typeof countsNeg1.json.chat === "number", String(countsNeg1.status));
  const chatAfterNeg = countsNeg1.json.chat;
  ok("setup-gate-no-provider-without-lead", chatAfterNeg === chatBeforeNeg, "chat=" + chatAfterNeg + " before=" + chatBeforeNeg);
}
const gidA = crypto.randomUUID();
const gidB = crypto.randomUUID();
const gidC = crypto.randomUUID();
const gidD = crypto.randomUUID();
const gidHeldNote = crypto.randomUUID();
const items = [
  { id: gidA, text: "Bears approve alpha", refs: [{ kind: "message", ref: mid + ":" + String(mseq) }, { kind: "note", ref: gidHeldNote }] },
  { id: gidB, text: "Bears pending beta" },
  { id: gidC, text: "Bears pending gamma" },
  { id: gidD, text: "Bears discard delta", refs: [{ kind: "note", ref: crypto.randomUUID() }] },
];
const d1 = await post("/api/meetings/" + mid + "/record/draft", items, ownerT);
preflight("setup-draft", d1.status === 201 && camel(d1.json, "id"), String(d1.status));
const did = camel(d1.json, "id");
const rev = await get("/api/records/" + did + "/review", ownerT);
ok("review-200", rev.status === 200, String(rev.status));
const kinds = (rev.json.notes || []).map((n) => camel(n, "kind"));
ok("review-has-working-note", kinds.includes("note"), JSON.stringify(kinds));
ok("review-has-secretary-note", kinds.some((k) => String(k).indexOf("secretary") >= 0), JSON.stringify(kinds));
ok("review-has-nested-note", (rev.json.notes || []).some((n) => String(camel(n, "body") || "").includes("visible nested wire decision")), "nested wire note missing");
ok("review-has-double-note", (rev.json.notes || []).some((n) => String(camel(n, "body") || "").includes("visible double-encoded wire decision")), "double-encoded wire note missing");
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
{
  const badTok = await get("/api/records/" + did + "/review", "invalid-token-xyz");
  ok("invalid-token-no-review", badTok.status === 401 || badTok.status === 403, String(badTok.status));
}
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
preflight("setup-empty-draft", de.status === 201 && camel(de.json, "id"), String(de.status));
const eid = camel(de.json, "id");
const eRev = await get("/api/records/" + eid + "/review", ownerT);
ok("empty-review-no-pending", eRev.status === 200 && (eRev.json.pending || []).length === 0, String(eRev.status));
const eAll = await post("/api/records/" + eid + "/approve-all", await guards(eid, ownerT), ownerT);
ok("empty-approve-all-409", eAll.status === 409, String(eAll.status));
const allR = await post("/api/records/" + did + "/approve-all", await guards(did, ownerT), ownerT);
ok("approve-all-200", allR.status === 200, String(allR.status));
const rev3 = await get("/api/records/" + did + "/review", ownerT);
ok("all-decided", (rev3.json.pending || []).length === 0 && rev3.json.draft.decided === true, "not decided");
ok("all-approved-set", JSON.stringify([...rev3.json.approved].sort()) === JSON.stringify([gidA, gidB, gidC].sort()), JSON.stringify(rev3.json.approved));
ok("all-discarded-set", JSON.stringify([...rev3.json.discarded].sort()) === JSON.stringify([gidD]), JSON.stringify(rev3.json.discarded));
{
  const gr = await get("/api/records/" + did + "/review", readerT);
  ok("guest-approved-positive", gr.status === 200 && (gr.json.approved || []).length === 3, String(gr.status));
  const gtexts = ((gr.json.draft && gr.json.draft.approvedItems) || []).map((e) => e.text);
  ok("guest-approved-text", gtexts.includes("Bears approve alpha") && gtexts.includes("Bears revised beta"), JSON.stringify(gtexts).slice(0, 300));
  const gcards = gr.json.evidence || [];
  ok("guest-evidence-readable", gcards.some((c) => !camel(c, "missing") && String(camel(c, "excerpt") || "").includes("Bears opening")), JSON.stringify(gcards.map((c) => camel(c, "missing"))));
  ok("guest-evidence-held", gcards.some((c) => camel(c, "missing") === true), "no withheld card in guest readback");
  ok("guest-no-pending-disclosure", (gr.json.pending || []).length === 0 && (gr.json.notes || []).length === 0 && (gr.json.recentMessages || []).length === 0, "guest sees manage context");
  ok("guest-no-id-leak", Array.isArray(gr.json.draft?.approvedItems) && gr.json.draft.approvedItems.length > 0 && Array.isArray(gr.json.draft?.effective?.approvedItems) && gr.json.draft.effective.approvedItems.length > 0 && gr.json.draft.approvedItems.every((it) => typeof it?.text === "string" && !leakRe.test(it.text)) && gr.json.draft.effective.approvedItems.every((it) => typeof it?.text === "string" && !leakRe.test(it.text)), "identifier in approved text");
  ok("guest-draft-no-history", !(gr.json.draft || {}).historyJson && !("historyJson" in (gr.json.draft || {})), "history disclosed to guest");
}
{
  const pA = crypto.randomUUID(); const pB = crypto.randomUUID();
  const pBase = await post("/api/meetings/" + mid + "/record/draft", [{ id: pA, text: "Bears partial approved" }, { id: pB, text: "Bears partial pending" }], ownerT);
  preflight("partial-base", pBase.status === 201 && camel(pBase.json, "id"), String(pBase.status));
  const pid = camel(pBase.json, "id");
  const pAp = await post("/api/records/" + pid + "/items/approve", { ...(await guards(pid, ownerT)), itemId: pA }, ownerT);
  ok("partial-approve-one", pAp.status === 200, String(pAp.status));
  const pMgr = await get("/api/records/" + pid + "/review", ownerT);
  ok("partial-head-is-base", pMgr.json.effectiveHeadId === pid, JSON.stringify(pMgr.json.effectiveHeadId));
  ok("partial-still-pending", JSON.stringify([...pMgr.json.pending].sort()) === JSON.stringify([pB]), JSON.stringify(pMgr.json.pending));
  const pGuest = await get("/api/records/" + pid + "/review", readerT);
  ok("partial-guest-head", pGuest.status === 200 && String(pGuest.json.draft?.effective?.headId) === pid, JSON.stringify(pGuest.json.draft?.effective).slice(0, 300));
  const pGItems = ((pGuest.json.draft?.effective?.approvedItems) || []);
  ok("partial-guest-approved-only-A", pGItems.some((e) => e.text === "Bears partial approved" && e.approvedBy?.version === 1) && !pGItems.some((e) => e.text === "Bears partial pending"), JSON.stringify(pGItems).slice(0, 400));
  ok("partial-guest-no-pending", (pGuest.json.pending || []).length === 0 && (pGuest.json.notes || []).length === 0 && (pGuest.json.recentMessages || []).length === 0, "guest sees manage context on partial");
  ok("partial-guest-no-history", !(pGuest.json.draft || {}).historyJson && !("historyJson" in (pGuest.json.draft || {})), "history disclosed to partial guest");
}
const canonDecidedBefore = await canonState(did, ownerT);
const again = await post("/api/records/" + did + "/items/approve", { ...(await guards(did, ownerT)), itemId: gidB }, ownerT);
ok("decided-approve-409", again.status === 409, String(again.status));
ok("decided-no-state-write", (await canonState(did, ownerT)) === canonDecidedBefore, "decided write mutated public state");
const s1 = await post("/api/meetings/" + mid + "/record/draft", [{ id: "S1", text: "Bears stale one" }, { id: "S2", text: "Bears stale two" }], ownerT);
const sid = camel(s1.json, "id");
const g0 = await guards(sid, ownerT);
await post("/api/records/" + sid + "/items/revise", { ...g0, itemId: "S1", text: "Bears other-client revision" }, ownerT);
const hBefore = histOf((await get("/api/records/" + sid, ownerT)).json).length;
const canonStaleBefore = await canonState(sid, ownerT);
const stale = await post("/api/records/" + sid + "/items/approve", { ...g0, itemId: "S2" }, ownerT);
ok("stale-approve-409", stale.status === 409, String(stale.status));
ok("stale-guided-refresh", /refresh/i.test(stale.text), stale.text.slice(0, 240));
ok("stale-server-has-no-client-wording", !/no automatic retry/i.test(stale.text), "server leaks client wording");
ok("conflict-no-history-write", histOf((await get("/api/records/" + sid, ownerT)).json).length === hBefore, "failed click wrote history");
ok("conflict-no-state-write", (await canonState(sid, ownerT)) === canonStaleBefore, "failed approve mutated public state");
{
  const gOwn = await guards(sid, ownerT);
  const canonSidBefore = await canonState(sid, ownerT);
  const stWhole = await post("/api/records/" + sid + "/revise", { ...gOwn, items: [{ id: "S1", text: "stranger x" }] }, strangerT);
  ok("stranger-whole-revise-403", stWhole.status === 403, String(stWhole.status));
  ok("stranger-whole-no-state-write", (await canonState(sid, ownerT)) === canonSidBefore, "stranger revise mutated public state");
}
await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "Bears fresh input moves watermark" }, ownerT);
const g1 = await guards(sid, ownerT);
const itemsBeforeRefresh = camel((await get("/api/records/" + sid, ownerT)).json, "itemsJson");
const tokenBeforeRefresh = g1.reviewToken;
const rf = await post("/api/records/" + sid + "/refresh", g1, ownerT);
ok("explicit-refresh-200", rf.status === 200, String(rf.status));
ok("refresh-rotates-token", camel(rf.json.draft || rf.json, "reviewToken") !== tokenBeforeRefresh, "token unchanged");
const revS = await get("/api/records/" + sid + "/review", ownerT);
ok("refresh-no-auto-approve", JSON.stringify([...revS.json.pending].sort()) === JSON.stringify(["S1", "S2"]), JSON.stringify(revS.json.pending));
ok("refresh-history-entry", histOf((await get("/api/records/" + sid, ownerT)).json).some((e) => e.action === "refresh"), "no refresh history");
ok("refresh-preserves-items", camel((await get("/api/records/" + sid, ownerT)).json, "itemsJson") === itemsBeforeRefresh, "refresh rewrote items");
const canonWholeBefore = await canonState(did, ownerT);
const wholeRev = await post("/api/records/" + did + "/revise", { ...(await guards(did, ownerT)), items: [{ id: "S1", text: "x" }] }, ownerT);
ok("whole-revise-after-decisions-409", wholeRev.status === 409, String(wholeRev.status));
ok("whole-revise-no-state-write", (await canonState(did, ownerT)) === canonWholeBefore, "decided whole-revise mutated public state");
const u1 = await post("/api/meetings/" + mid + "/record/draft", [{ id: "U1", text: "Bears branch one" }, { id: "U2", text: "Bears branch two" }], ownerT);
const buid = camel(u1.json, "id");
preflight("branch-fixture-undecided", u1.status === 201 && buid, String(u1.status));
const br = await post("/api/records/" + buid + "/revise", { ...(await guards(buid, ownerT)), items: [{ id: "U1", text: "Bears branch one v2" }, { id: "U2", text: "Bears branch two" }] }, ownerT);
preflight("branch-v2-201", (br.status === 201 || br.status === 200) && camel(br.json, "id"), String(br.status));
const nid = camel(br.json, "id");
const oldRev = await get("/api/records/" + buid + "/review", ownerT);
ok("old-successor-listed", (oldRev.json.successors || []).includes(nid), JSON.stringify(oldRev.json.successors));
const newRev = await get("/api/records/" + nid + "/review", ownerT);
ok("new-predecessor-listed", (newRev.json.predecessors || []).includes(buid), JSON.stringify(newRev.json.predecessors));
const canonSupBefore = await canonState(buid, ownerT);
const oldAp = await post("/api/records/" + buid + "/items/approve", { ...(await guards(buid, ownerT)), itemId: "U2" }, ownerT);
ok("superseded-approve-409", oldAp.status === 409, String(oldAp.status));
ok("superseded-no-state-write", (await canonState(buid, ownerT)) === canonSupBefore, "superseded write mutated public state");
const effEmpty = await get("/api/records/" + nid + "/effective", ownerT);
ok("effective-404-before-approvals", effEmpty.status === 404, String(effEmpty.status));
const apNew = await post("/api/records/" + nid + "/items/approve", { ...(await guards(nid, ownerT)), itemId: "U1" }, ownerT);
ok("successor-approve-200", apNew.status === 200, String(apNew.status));
const eff = await get("/api/records/" + nid + "/effective", ownerT);
ok("effective-head", camel(eff.json, "head") === nid, JSON.stringify(eff.json).slice(0, 200));

const amA = crypto.randomUUID();
const amB = crypto.randomUUID();
const amBase = await post("/api/meetings/" + mid + "/record/draft", [{ id: amA, text: "Bears inherit alpha" }, { id: amB, text: "Bears inherit beta" }], ownerT);
const amBaseId = camel(amBase.json, "id");
preflight("amend-inherit-base", amBase.status === 201 && amBaseId, String(amBase.status));
const amAp = await post("/api/records/" + amBaseId + "/approve-all", await guards(amBaseId, ownerT), ownerT);
preflight("amend-inherit-approve-base", amAp.status === 200, String(amAp.status));
const amHeadBefore = await get("/api/records/" + amBaseId + "/effective", ownerT);
ok("amend-inherit-head-is-base", amHeadBefore.status === 200 && camel(amHeadBefore.json, "head") === amBaseId, JSON.stringify(amHeadBefore.json).slice(0, 200));
const amAmend = await post("/api/records/" + amBaseId + "/amend", { ...(await guards(amBaseId, ownerT)), items: [{ id: amA, text: "Bears inherit alpha replaced" }] }, ownerT);
const amV2 = camel(amAmend.json, "id");
preflight("amend-inherit-v2", (amAmend.status === 201 || amAmend.status === 200) && amV2, String(amAmend.status));
const amMgrV1 = await get("/api/records/" + amBaseId + "/review", ownerT);
ok("amend-inherit-v1-still-head-with-pending-child", amMgrV1.json.effectiveHeadId === amBaseId, JSON.stringify(amMgrV1.json.effectiveHeadId));
const amAp2 = await post("/api/records/" + amV2 + "/items/approve", { ...(await guards(amV2, ownerT)), itemId: amA }, ownerT);
preflight("amend-inherit-approve-v2", amAp2.status === 200, String(amAp2.status));
const amMgrV2 = await get("/api/records/" + amV2 + "/review", ownerT);
const amEff = (amMgrV2.json.lineageEffects || []);
ok("amend-inherit-replaced-A", amEff.some((e) => e.id === amA && e.status === "replaced" && String(e.text).includes("replaced") && e.fromVersion === 1 && e.toVersion === 2), JSON.stringify(amEff).slice(0, 400));
ok("amend-inherit-inherited-B", amEff.some((e) => e.id === amB && e.status === "inherited" && e.fromVersion === 1 && String(e.text).includes("beta")), JSON.stringify(amEff).slice(0, 600));
ok("amend-inherit-head-is-v2", amMgrV2.json.effectiveHeadId === amV2 && amMgrV2.json.effectiveHeadVersion === 2, JSON.stringify({ h: amMgrV2.json.effectiveHeadId, v: amMgrV2.json.effectiveHeadVersion }));
const amMgrV1After = await get("/api/records/" + amBaseId + "/review", ownerT);
ok("amend-inherit-v1-historical-after-approval", amMgrV1After.json.effectiveHeadId === amV2, JSON.stringify(amMgrV1After.json.effectiveHeadId));
const amGuestV1 = await get("/api/records/" + amBaseId + "/review", readerT);
ok("amend-inherit-guest-v1-historical", amGuestV1.status === 200 && String(amGuestV1.json.draft?.effective?.headId) === amV2 && String(amGuestV1.json.draft?.effective?.headVersion) === "2", JSON.stringify(amGuestV1.json.draft?.effective).slice(0, 300));
const amGuestV2 = await get("/api/records/" + amV2 + "/review", readerT);
const amGItems = ((amGuestV2.json.draft?.effective?.approvedItems) || []);
ok("amend-inherit-guest-v2-current", amGuestV2.status === 200 && amGItems.some((e) => e.text === "Bears inherit alpha replaced" && e.approvedBy?.version === 2) && amGItems.some((e) => e.text === "Bears inherit beta" && e.approvedBy?.version === 1), JSON.stringify(amGItems).slice(0, 600));
preflight("amend-inherit-effective-contains-B", (() => { try { const ee = amMgrV2.json; return Array.isArray(ee.effectiveIds) && ee.effectiveIds.includes(amB); } catch { return false; } })(), "effectiveIds missing inherited B");
const c0 = await post("/api/meetings/" + mid + "/record/draft", [{ id: "C0", text: "Bears chain base" }], ownerT);
let cid = camel(c0.json, "id");
preflight("chain-base", c0.status === 201 && cid, String(c0.status));
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
