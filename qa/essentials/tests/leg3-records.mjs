// leg3: records review essentials on REAL handlers (needs API+fake+PG).
// draft -> approve/revise/discard, review/export/effective, version/hash/
// watermark guards, 409 refresh-then-retry, held-token ABA, non-manager 403,
// missing 404, empty/invalid 4xx with no approval DOM.
// Exit nonzero on ANY failure. Secure-mode safe (Bearer everywhere).
import fs from "node:fs";
import path from "node:path";
import { makeCtx, get, post, camel, mustArray, registerOrLogin, digest } from "../helpers/essentials-http.mjs";

const ctx = makeCtx("leg3");
const ART = process.env.ESS_QA_ARTIFACT_DIR || ".";
const run = "ess3-" + Date.now().toString(36);
const writeArt = (name, obj) => {
  try { fs.writeFileSync(path.join(ART, name), typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)); }
  catch (e) { ctx.ok("artifact-" + name, false, String(e).slice(0, 160)); }
};
const tokMgr = await registerOrLogin(ctx, post, run + "-mgr@qa.local", "qa-mgr-1-pw12");
const tokOut = await registerOrLogin(ctx, post, run + "-outsider@qa.local", "qa-out-1-pw12");
ctx.ok("tokens-present", !!tokMgr && !!tokOut, "digests=" + digest(tokMgr) + "/" + digest(tokOut));

async function mkMeeting() {
  const b = await post("/api/boards", { name: run + "-board", mission: run + " mission", stage: "forming" }, { token: tokMgr });
  ctx.ok("setup-board", b.status === 201 && !!camel(b.json, "id"), "status=" + b.status);
  const bid = camel(b.json, "id");
  const m = await post("/api/boards/" + bid + "/meetings", { title: run + " meeting", brief: "records essentials" }, { token: tokMgr });
  ctx.ok("setup-meeting", m.status === 201 && !!camel(m.json, "id"), "status=" + m.status);
  return { bid, mid: camel(m.json, "id") };
}
async function guards(did, token) {
  const g = await get("/api/records/" + did, { token: token || tokMgr });
  ctx.ok("guards-fetch", g.status === 200, "status=" + g.status);
  return {
    version: camel(g.json, "version"), hash: camel(g.json, "hash"),
    reviewToken: camel(g.json, "reviewToken"), watermark: camel(g.json, "watermark"),
    row: g.json,
  };
}

const { mid } = await mkMeeting();

// --- single-document excerpts + working notes + recent input: exact bytes ---
const alphaText = "persist alpha exact " + run + " caf\u00e9 \u4e2d\u6587  trailing-space-check  ";
let did = "";
{
  const d = await post("/api/meetings/" + mid + "/record/draft", [{ id: "P1", text: alphaText }, { id: "P2", text: "persist beta exact" }], { token: tokMgr });
  ctx.ok("draft-201", d.status === 201 && !!camel(d.json, "id"), "status=" + d.status + " " + String(d.text).slice(0, 200));
  did = camel(d.json, "id");
  const g = await guards(did);
  ctx.ok("guard-version", typeof g.version === "number", "version=" + g.version);
  ctx.ok("guard-hash", typeof g.hash === "string" && g.hash.length > 0, String(g.hash).slice(0, 40));
  ctx.ok("guard-watermark", g.watermark !== undefined, String(g.watermark).slice(0, 80));
  const rev = await get("/api/records/" + did + "/review", { token: tokMgr });
  ctx.ok("review-200", rev.status === 200, "status=" + rev.status);
  ctx.ok("review-manager-state-valid", camel(rev.json, "stateValid") === true, "stateValid=" + camel(rev.json, "stateValid") + " err=" + String(camel(rev.json, "stateError") || "").slice(0, 160));
  let draftItems = [];
  try {
    const itemsRaw = camel(camel(rev.json, "draft"), "itemsJson") || "[]";
    const parsed = typeof itemsRaw === "string" ? JSON.parse(itemsRaw) : itemsRaw;
    if (Array.isArray(parsed)) draftItems = parsed;
  } catch (e) { ctx.ok("review-items-parse", false, String(e).slice(0, 160)); }
  const p1 = draftItems.find((x) => String(camel(x, "id") || camel(x, "itemId")) === "P1");
  ctx.ok("review-item-exact-bytes", !!p1 && String(camel(p1, "text")) === alphaText, p1 ? String(camel(p1, "text")).slice(0, 300) : "P1 missing; items=" + JSON.stringify(draftItems).slice(0, 300));
  const pending = camel(rev.json, "pending") || [];
  ctx.ok("review-pending-P1-P2", Array.isArray(pending) && pending.includes("P1") && pending.includes("P2"), "pending=" + JSON.stringify(pending).slice(0, 160));}

// --- non-manager cannot approve (403) and sees no approval affordance ---
{
  const g0 = await guards(did);
  const denied = await post("/api/records/" + did + "/items/approve", { version: g0.version, hash: g0.hash, reviewToken: g0.reviewToken, watermark: g0.watermark, itemId: "P2" }, { token: tokOut });
  ctx.ok("outsider-approve-denied", denied.status === 403 || denied.status === 404, "status=" + denied.status + " " + String(denied.text).slice(0, 200));
  const still = await guards(did);
  ctx.ok("denied-no-state-change", still.version === g0.version, "v " + g0.version + "->" + still.version);
}

// --- approve P1 (partial approval exports immediately), then open-draft gates ---
{
  let g = await guards(did);
  const a = await post("/api/records/" + did + "/items/approve", { version: g.version, hash: g.hash, reviewToken: g.reviewToken, watermark: g.watermark, itemId: "P1" }, { token: tokMgr });
  ctx.ok("approve-P1-200", a.status === 200, "status=" + a.status + " " + String(a.text).slice(0, 200));
  const exp1 = await get("/api/records/" + did + "/export?format=concise", { token: tokMgr });
  ctx.ok("export-approved-200", exp1.status === 200 && String(exp1.text).includes(alphaText), "status=" + exp1.status + " " + String(exp1.text).slice(0, 200));
}
// --- open draft gates: no effective chain yet (404), nothing to export (409) ---
{
  const d2 = await post("/api/meetings/" + mid + "/record/draft", [{ id: "Q1", text: "open gate item " + run }], { token: tokMgr });
  ctx.ok("gate-draft-201", d2.status === 201, "status=" + d2.status);
  const did2 = camel(d2.json, "id");
  const eff0 = await get("/api/records/" + did2 + "/effective", { token: tokMgr });
  ctx.ok("effective-open-404", eff0.status === 404, "status=" + eff0.status + " " + String(eff0.text).slice(0, 160));
  const exp0 = await get("/api/records/" + did2 + "/export?format=concise", { token: tokMgr });
  ctx.ok("export-open-409", exp0.status === 409, "status=" + exp0.status + " " + String(exp0.text).slice(0, 160));
}

// --- stale guard 409 is VISIBLE, then real refresh POST after new input ---
{
  const fresh = await guards(did);
  const staleVer = Math.max(0, (fresh.version | 0) - 1);
  const conflict = await post("/api/records/" + did + "/items/approve", { version: staleVer, hash: fresh.hash, reviewToken: fresh.reviewToken, watermark: fresh.watermark, itemId: "P1" }, { token: tokMgr });
  ctx.ok("stale-409-visible", conflict.status === 409, "status=" + conflict.status + " " + String(conflict.text).slice(0, 200));
  // New meeting input moves DeliveredRevision past the loaded watermark, so
  // the refresh POST below has real work (200), not already-current (409).
  const bump = await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "refresh bump " + run }, { token: tokMgr });
  ctx.ok("refresh-bump-posted", bump.status === 201 || bump.status === 200, "status=" + bump.status);
  const retry = await post("/api/records/" + did + "/refresh", { version: fresh.version, hash: fresh.hash, reviewToken: fresh.reviewToken, watermark: fresh.watermark }, { token: tokMgr });
  ctx.ok("refresh-post-200", retry.status === 200, "status=" + retry.status + " " + String(retry.text).slice(0, 300));
  const movedDraft = camel(retry.json, "draft") || {};
  const moved = camel(movedDraft, "watermark");
  ctx.ok("refresh-watermark-moved", typeof moved === "number" && moved > fresh.watermark, "watermark " + fresh.watermark + "->" + moved);
  const newToken = camel(movedDraft, "reviewToken");
  ctx.ok("refresh-token-rotated", typeof newToken === "string" && newToken.length > 0 && newToken !== fresh.reviewToken, "rotated=" + (newToken !== fresh.reviewToken));
  writeArt("refresh.json", { before: fresh.watermark, after: moved });
}

// --- revise P2, discard P2 with post-refresh guards, then effective/export ---
{
  let g = await guards(did);
  const r = await post("/api/records/" + did + "/items/revise", { version: g.version, hash: g.hash, reviewToken: g.reviewToken, watermark: g.watermark, itemId: "P2", text: "persist beta revised " + run }, { token: tokMgr });
  ctx.ok("revise-P2-200", r.status === 200, "status=" + r.status + " " + String(r.text).slice(0, 200));
  g = await guards(did);
  const x = await post("/api/records/" + did + "/items/discard", { version: g.version, hash: g.hash, reviewToken: g.reviewToken, watermark: g.watermark, itemId: "P2" }, { token: tokMgr });
  ctx.ok("discard-P2-200", x.status === 200, "status=" + x.status + " " + String(x.text).slice(0, 200));
  const eff = await get("/api/records/" + did + "/effective", { token: tokMgr });
  ctx.ok("effective-200", eff.status === 200, "status=" + eff.status + " " + String(eff.text).slice(0, 200));
  const exp = await get("/api/records/" + did + "/export?format=detailed", { token: tokMgr });
  ctx.ok("export-200", exp.status === 200 && String(exp.text).includes(alphaText) && !String(exp.text).includes("persist beta revised"), "status=" + exp.status + " " + String(exp.text).slice(0, 300));
}
// --- empty / invalid / missing: 4xx/404, never an approval DOM ---
{
  const emptyDraft = await post("/api/meetings/" + mid + "/record/draft", [{ id: "x", text: "   " }], { token: tokMgr });
  ctx.ok("empty-text-4xx", emptyDraft.status >= 400 && emptyDraft.status < 500, "status=" + emptyDraft.status);
  const dupDraft = await post("/api/meetings/" + mid + "/record/draft", [{ id: "x", text: "one" }, { id: "x", text: "two" }], { token: tokMgr });
  ctx.ok("dup-id-4xx", dupDraft.status >= 400 && dupDraft.status < 500, "status=" + dupDraft.status);
  const missing = await get("/api/records/00000000-0000-0000-0000-000000000000", { token: tokMgr });
  ctx.ok("missing-404", missing.status === 404, "status=" + missing.status);
  const missingApprove = await post("/api/records/00000000-0000-0000-0000-000000000000/items/approve", { version: 1, itemId: "x" }, { token: tokMgr });
  ctx.ok("missing-approve-404", missingApprove.status === 404, "status=" + missingApprove.status);
}

// --- held-token ABA: logout, old token cannot POST, fresh login sees intact draft and can act ---
{
  const tokH = await registerOrLogin(ctx, post, run + "-held@qa.local", "qa-held-1-pw12");
  const hb = await post("/api/boards", { name: run + "-hboard", mission: run, stage: "forming" }, { token: tokH });
  ctx.ok("held-setup-board", hb.status === 201, "status=" + hb.status);
  const hm = await post("/api/boards/" + camel(hb.json, "id") + "/meetings", { title: run + " h", brief: "held aba" }, { token: tokH });
  ctx.ok("held-setup-meeting", hm.status === 201, "status=" + hm.status);
  const hd = await post("/api/meetings/" + camel(hm.json, "id") + "/record/draft", [{ id: "H1", text: "held item exact" }], { token: tokH });
  ctx.ok("held-setup-draft", hd.status === 201, "status=" + hd.status);
  const hdid = camel(hd.json, "id");
  const hg = await guards(hdid, tokH);
  const lo = await post("/api/auth/logout", {}, { token: tokH });
  ctx.ok("held-logout-200", lo.status === 200, "status=" + lo.status);
  const heldPost = await post("/api/records/" + hdid + "/items/approve", { version: hg.version, hash: hg.hash, reviewToken: hg.reviewToken, watermark: hg.watermark, itemId: "H1" }, { token: tokH });
  ctx.ok("held-token-cannot-post", heldPost.status === 401, "status=" + heldPost.status);
  const tokH2 = await registerOrLogin(ctx, post, run + "-held@qa.local", "qa-held-1-pw12");
  const g2 = await guards(hdid, tokH2);
  ctx.ok("new-context-draft-intact", g2.version === hg.version, "v " + hg.version + "->" + g2.version);
  const okA = await post("/api/records/" + hdid + "/items/approve", { version: g2.version, hash: g2.hash, reviewToken: g2.reviewToken, watermark: g2.watermark, itemId: "H1" }, { token: tokH2 });
  ctx.ok("new-context-can-approve", okA.status === 200, "status=" + okA.status + " " + String(okA.text).slice(0, 200));
}

process.exit(ctx.verdict());