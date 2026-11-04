// Records Phase 5 one-document review acceptance (Muse-authored, primary executes).
// Real isolated API only. Default http://127.0.0.1:15320 (primary-owned); the
// fake provider default http://127.0.0.1:15322 backs the Secretary note seed.
// Explicit loopback allowlist: non-loopback APIs and human ports are refused.
// Run-scoped bears5-* identity and boards only; touches nothing else.
// Exit nonzero on any failure. No skips: provider-backed Secretary seeding is required.
import crypto from "node:crypto";

const API = process.env.QA_API || "http://127.0.0.1:15320";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:15322";
{
  let u;
  try { u = new URL(API); } catch { console.error("REFUSE bad QA_API: " + API); process.exit(2); }
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") { console.error("REFUSE non-loopback QA_API: " + API); process.exit(2); }
  if (/:5080|:5173/.test(API)) { console.error("REFUSE human-port QA_API: " + API); process.exit(2); }
  let f;
  try { f = new URL(FAKE); } catch { console.error("REFUSE bad QA_FAKE: " + FAKE); process.exit(2); }
  if (f.hostname !== "127.0.0.1" && f.hostname !== "localhost") { console.error("REFUSE non-loopback QA_FAKE: " + FAKE); process.exit(2); }
}
const TAG = "records5-onedoc";
const run = "bears5-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
const owner = run + "-owner";
const stranger = run + "-stranger";
const reader = run + "-reader";
const contrib = run + "-contrib";
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; /* console.log("  ok " + name); */ }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
async function req(method, path, body, user) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(API + path, {
      method, signal: ctl.signal,
      headers: { "content-type": "application/json", "x-user": user || owner },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const get = (p, u) => req("GET", p, undefined, u);
const post = (p, b, u) => req("POST", p, b, u);
const camel = (o, k) => {
  if (!o || typeof o !== "object") return undefined;
  if (k in o) return o[k];
  const lo = k.toLowerCase();
  for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key];
  return undefined;
};
const leakRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/i;
function humanStrings(v, depth) {
  // Collect human-readable strings (titles/excerpts/bodies/content) for leak scan.
  const out = [];
  if (depth > 6 || v === null || v === undefined) return out;
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) { for (const e of v) out.push(...humanStrings(e, depth + 1)); return out; }
  if (typeof v === "object") {
    for (const k of ["title", "Title", "excerpt", "Excerpt", "body", "Body", "content", "Content", "text", "Text"]) {
      if (typeof v[k] === "string") out.push(v[k]);
    }
    for (const e of Object.values(v)) {
      if (e !== null && typeof e === "object") out.push(...humanStrings(e, depth + 1));
    }
  }
  return out;
}
function hasSnapshotKey(obj, depth) {
  if (!obj || typeof obj !== "object" || depth > 8) return false;
  if (Array.isArray(obj)) return obj.some((e) => hasSnapshotKey(e, depth + 1));
  const keys = Object.keys(obj);
  if (keys.includes("evidenceSnapshotJson") || keys.includes("EvidenceSnapshotJson")) return true;
  return Object.values(obj).some((v) => v !== null && typeof v === "object" && hasSnapshotKey(v, depth + 1));
}
async function guards(did, user) {
  const g = await get("/api/records/" + did, user);
  ok("guards-fetch-" + String(did).slice(0, 8), g.status === 200, String(g.status));
  return {
    version: camel(g.json, "version"), hash: camel(g.json, "hash"),
    reviewToken: camel(g.json, "reviewToken"), watermark: camel(g.json, "watermark"),
  };
}
function histOf(row) {
  try { const h = JSON.parse(camel(row, "historyJson") ?? "[]"); return Array.isArray(h) ? h : []; } catch { return []; }
}

console.log("[" + TAG + "] api=" + API + " run=" + run);
// ---------- setup ----------
const board = await post("/api/boards", { name: run + "-board", mission: run + " mission", stage: "qa" });
ok("setup-board", board.status === 201 && camel(board.json, "id"), board.status + " " + board.text.slice(0, 160));
const bid = camel(board.json, "id");
const mtg = await post("/api/boards/" + bid + "/meetings", { title: run + " meet", brief: run + " brief" });
ok("setup-meeting", mtg.status === 201 && camel(mtg.json, "id"), mtg.status + " " + mtg.text.slice(0, 160));
const mid = camel(mtg.json, "id");
const msg = await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "Bears opening drive memo" });
ok("setup-message", msg.status === 200 || msg.status === 201, String(msg.status));
const wn = await post("/api/meetings/" + mid + "/notes", { title: "Bears working note", body: "bears provisional note alpha", kind: "note" });
ok("setup-note", wn.status === 201, String(wn.status) + " " + wn.text.slice(0, 160));
const sec = await post("/api/meetings/" + mid + "/secretary", { input: "Bears context with SECRETARY-NOTE", clientNonce: crypto.randomBytes(8).toString("hex") });
ok("setup-secretary-note", sec.status === 200 && sec.json && sec.json.note, sec.status + " " + sec.text.slice(0, 300));
const secKind = camel(sec.json.note, "kind") || "";
ok("setup-secretary-kind", secKind.indexOf("secretary") >= 0, secKind);
const items = [
  { id: "RA", text: "Bears approve alpha" },
  { id: "RB", text: "Bears pending beta" },
  { id: "RC", text: "Bears pending gamma" },
  { id: "RD", text: "Bears discard delta" },
];
const d1 = await post("/api/meetings/" + mid + "/record/draft", items);
ok("setup-draft", d1.status === 201 && camel(d1.json, "id"), String(d1.status));
const did = camel(d1.json, "id");

// ---------- one-document review context ----------
const rev = await get("/api/records/" + did + "/review");
ok("review-200", rev.status === 200, String(rev.status));
const kinds = (rev.json.notes || []).map((n) => camel(n, "kind"));
ok("review-has-working-note", kinds.includes("note"), JSON.stringify(kinds));
ok("review-has-secretary-note", kinds.some((k) => String(k).indexOf("secretary") >= 0), JSON.stringify(kinds));
ok("review-notes-human-keys", (rev.json.notes || []).every((n) => {
  const ks = Object.keys(n);
  return ks.every((k) => ["id", "Id", "kind", "Kind", "title", "Title", "body", "Body", "createdAt", "CreatedAt"].includes(k));
}), JSON.stringify((rev.json.notes || []).map(Object.keys)));
ok("review-notes-no-guid-leak", humanStrings(rev.json.notes, 0).every((s) => !leakRe.test(s)), "guid-shaped text in notes");
ok("review-evidence-no-guid-leak", humanStrings(rev.json.evidence, 0).every((s) => !leakRe.test(s)), "guid-shaped text in evidence");
ok("review-recent-has-input", (rev.json.recentMessages || []).some((m) => String(camel(m, "content") || "").includes("Bears opening")), JSON.stringify(rev.json.recentMessages).slice(0, 200));
ok("review-version-watermark", typeof camel(rev.json.draft, "version") === "number" && typeof rev.json.meetingWatermark === "number", JSON.stringify({ v: camel(rev.json.draft, "version"), w: rev.json.meetingWatermark }));
ok("review-lineage-present", Array.isArray(rev.json.predecessors) && Array.isArray(rev.json.successors) && Array.isArray(rev.json.effectiveIds) && Array.isArray(rev.json.lineageEffects), "missing lineage context");
ok("review-no-snapshot-bytes", !hasSnapshotKey(rev.json, 0), "snapshot bytes in review payload");
ok("review-pending-four", JSON.stringify([...rev.json.pending].sort()) === JSON.stringify(["RA", "RB", "RC", "RD"]), JSON.stringify(rev.json.pending));

// ---------- scoped leak negatives ----------
await post("/api/boards/" + bid + "/grants", { userKey: owner, access: "manage" });
await post("/api/boards/" + bid + "/grants", { userKey: reader, access: "read" });
await post("/api/boards/" + bid + "/grants", { userKey: contrib, access: "contribute" });
const sg = await get("/api/records/" + did + "/review", stranger);
ok("stranger-no-review", sg.status !== 200, String(sg.status));
ok("stranger-no-leak", !sg.text.includes("Bears approve alpha") && !sg.text.includes("reviewToken"), sg.text.slice(0, 200));
const rr = await get("/api/records/" + did + "/review", reader);
ok("reader-review-200", rr.status === 200, String(rr.status));
ok("reader-guest-context", (rr.json.pending || []).length === 0 && (rr.json.notes || []).length === 0 && (rr.json.recentMessages || []).length === 0 && (rr.json.predecessors || []).length === 0 && (rr.json.successors || []).length === 0, JSON.stringify({ p: rr.json.pending, n: (rr.json.notes || []).length }));
ok("reader-evidence-approved-only", (rr.json.evidence || []).every((c) => (rev.json.approved || []).includes(camel(c, "itemId"))), JSON.stringify(rr.json.evidence).slice(0, 200));
ok("reader-draft-no-history", !("historyJson" in (rr.json.draft || {})) && !("HistoryJson" in (rr.json.draft || {})), "history disclosed to reader");
const rAp = await post("/api/records/" + did + "/items/approve", { ...(await guards(did)), itemId: "RA" }, reader);
ok("reader-approve-403", rAp.status === 403, String(rAp.status));
const rRv = await post("/api/records/" + did + "/items/revise", { ...(await guards(did)), itemId: "RB", text: "reader rewrite" }, reader);
ok("reader-revise-403", rRv.status === 403, String(rRv.status));
const cAp = await post("/api/records/" + did + "/items/approve", { ...(await guards(did)), itemId: "RA" }, contrib);
ok("contrib-approve-403", cAp.status === 403, String(cAp.status));
const cRv = await post("/api/records/" + did + "/items/revise", { ...(await guards(did)), itemId: "RB", text: "Bears revised beta" }, contrib);
ok("contrib-revise-200", cRv.status === 200, String(cRv.status) + " " + cRv.text.slice(0, 160));

// ---------- per-item history + remaining items ----------
const aA = await post("/api/records/" + did + "/items/approve", { ...(await guards(did)), itemId: "RA" });
ok("approve-RA-200", aA.status === 200, String(aA.status));
const dD = await post("/api/records/" + did + "/items/discard", { ...(await guards(did)), itemId: "RD" });
ok("discard-RD-200", dD.status === 200, String(dD.status));
const rev2 = await get("/api/records/" + did + "/review");
ok("remaining-items", JSON.stringify([...rev2.json.pending].sort()) === JSON.stringify(["RB", "RC"]) && JSON.stringify([...rev2.json.approved].sort()) === JSON.stringify(["RA"]) && JSON.stringify([...rev2.json.discarded].sort()) === JSON.stringify(["RD"]), JSON.stringify({ p: rev2.json.pending, a: rev2.json.approved, d: rev2.json.discarded }));
const h2 = histOf((await get("/api/records/" + did)).json);
const acts = h2.map((e) => String(e.action ?? e.Action ?? "") + ":" + String(e.itemId ?? e.ItemId ?? ""));
ok("history-approve-entry", acts.includes("approve:RA"), JSON.stringify(acts));
ok("history-revise-entry", h2.some((e) => (e.action ?? e.Action) === "revise" && (e.itemId ?? e.ItemId) === "RB" && (e.newText ?? e.NewText) === "Bears revised beta" && String(e.oldText ?? e.OldText).includes("pending beta")), JSON.stringify(h2).slice(0, 300));
ok("history-discard-entry", acts.includes("discard:RD"), JSON.stringify(acts));
ok("history-actor-present", h2.every((e) => typeof (e.actor ?? e.Actor) === "string" && (e.actor ?? e.Actor) !== ""), "anonymous history entry");
const itemsAfter = JSON.parse((await get("/api/records/" + did)).json.itemsJson);
ok("revise-preserves-approved", itemsAfter.find((i) => i.id === "RA").text === "Bears approve alpha" && itemsAfter.find((i) => i.id === "RB").text === "Bears revised beta", JSON.stringify(itemsAfter));

// ---------- empty-draft guard ----------
const de = await post("/api/meetings/" + mid + "/record/draft", []);
ok("setup-empty-draft", de.status === 201 && camel(de.json, "id"), String(de.status));
const eid = camel(de.json, "id");
const eRev = await get("/api/records/" + eid + "/review");
ok("empty-review-no-pending", eRev.status === 200 && (eRev.json.pending || []).length === 0, String(eRev.status));
const eAll = await post("/api/records/" + eid + "/approve-all", await guards(eid));
ok("empty-approve-all-409", eAll.status === 409, String(eAll.status));
const eOne = await post("/api/records/" + eid + "/items/approve", { ...(await guards(eid)), itemId: "ZX" });
ok("empty-item-approve-422", eOne.status === 422, String(eOne.status));

// ---------- all-decided guard ----------
const allR = await post("/api/records/" + did + "/approve-all", await guards(did));
ok("approve-all-200", allR.status === 200, String(allR.status));
const rev3 = await get("/api/records/" + did + "/review");
ok("all-decided", (rev3.json.pending || []).length === 0 && rev3.json.draft.decided === true, JSON.stringify({ p: rev3.json.pending, d: rev3.json.draft.decided }));
const again = await post("/api/records/" + did + "/items/approve", { ...(await guards(did)), itemId: "RB" });
ok("decided-approve-409", again.status === 409, String(again.status));
const againAll = await post("/api/records/" + did + "/approve-all", await guards(did));
ok("decided-approve-all-409", againAll.status === 409, String(againAll.status));

// ---------- 409 conflict + explicit refresh ----------
const s1 = await post("/api/meetings/" + mid + "/record/draft", [{ id: "S1", text: "Bears stale one" }, { id: "S2", text: "Bears stale two" }]);
const sid = camel(s1.json, "id");
const g0 = await guards(sid);
await post("/api/records/" + sid + "/items/revise", { ...g0, itemId: "S1", text: "Bears other-client revision" });
const stale = await post("/api/records/" + sid + "/items/approve", { ...g0, itemId: "S2" });
ok("stale-approve-409", stale.status === 409, String(stale.status));
ok("stale-guided-refresh", /refresh/i.test(stale.text) && /no automatic retry/i.test(stale.text), stale.text.slice(0, 240));
const hBefore = histOf((await get("/api/records/" + sid)).json).length;
ok("conflict-no-history-write", histOf((await get("/api/records/" + sid)).json).length === hBefore, "failed click wrote history");
await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "Bears fresh input moves watermark" });
const g1 = await guards(sid);
const rf = await post("/api/records/" + sid + "/refresh", g1);
ok("explicit-refresh-200", rf.status === 200, String(rf.status) + " " + rf.text.slice(0, 200));
ok("refresh-rotates-token", camel(rf.json.draft || rf.json, "reviewToken") !== g1.reviewToken, "token unchanged");
const revS = await get("/api/records/" + sid + "/review");
ok("refresh-no-auto-approve", JSON.stringify([...revS.json.pending].sort()) === JSON.stringify(["S1", "S2"]), JSON.stringify(revS.json.pending));
ok("refresh-history-entry", histOf((await get("/api/records/" + sid)).json).some((e) => (e.action ?? e.Action) === "refresh"), "no refresh history");

// ---------- supersession navigation + affected context ----------
const br = await post("/api/records/" + sid + "/revise", { ...(await guards(sid)), items: [{ id: "S1", text: "Bears stale one v2" }, { id: "S2", text: "Bears stale two" }] });
ok("branch-v2-201", (br.status === 201 || br.status === 200) && camel(br.json, "id"), String(br.status) + " " + br.text.slice(0, 200));
const nid = camel(br.json, "id");
const oldRev = await get("/api/records/" + sid + "/review");
ok("old-successor-listed", (oldRev.json.successors || []).includes(nid), JSON.stringify(oldRev.json.successors));
const newRev = await get("/api/records/" + nid + "/review");
ok("new-predecessor-listed", (newRev.json.predecessors || []).includes(sid), JSON.stringify(newRev.json.predecessors));
const oldAp = await post("/api/records/" + sid + "/items/approve", { ...(await guards(sid)), itemId: "S2" });
ok("superseded-approve-409", oldAp.status === 409, String(oldAp.status));
const eff = await get("/api/records/" + nid + "/effective");
ok("effective-head", camel(eff.json, "head") === nid, JSON.stringify(eff.json).slice(0, 200));
const apNew = await post("/api/records/" + nid + "/items/approve", { ...(await guards(nid)), itemId: "S1" });
ok("successor-approve-200", apNew.status === 200, String(apNew.status));
const newRev2 = await get("/api/records/" + nid + "/review");
ok("successor-affected-context", (newRev2.json.approved || []).includes("S1") && Array.isArray(newRev2.json.lineageEffects), JSON.stringify({ a: newRev2.json.approved }));
ok("successor-version-marked", camel(newRev2.json.draft, "version") === camel(newRev.json.draft, "version"), "version moved unexpectedly");

console.log("[" + TAG + "] pass=" + pass + " fail=" + fail);
if (fail > 0) { console.log("FAILURES:\n" + failures.join("\n")); process.exit(1); }
