// SimCEO roster regression (Lane A findings 3,4,11,14).
// Isolated QA_API only. Default http://127.0.0.1:5099, REFUSE 5080.
// Run: QA_API=http://127.0.0.1:5099 node qa/roster-regression.mjs [--tag x]
// Does NOT restart shared QA API. Orphan test uses write/verify marker file.
import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const API = process.env.QA_API || "http://127.0.0.1:5099";
if (API.includes(":5080")) {
  console.error("REFUSE 5080: isolated QA_API required (default 5099).");
  process.exit(2);
}
const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
const TAG = argVal("--tag") || "roster";
const run = "rr-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
async function req(method, path, body, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 30000);
  try {
    const headers = { "x-user": opts.user || "owner" };
    let b;
    if (body !== undefined && !(body instanceof FormData)) {
      headers["content-type"] = "application/json";
      b = JSON.stringify(body);
    } else if (body instanceof FormData) {
      b = body;
    }
    if (opts.headers) Object.assign(headers, opts.headers);
    const r = await fetch(API + path, { method, signal: ctl.signal, headers, body: b });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const get = (p, o) => req("GET", p, undefined, o);
const post = (p, b, o) => req("POST", p, b, o);
const put = (p, b, o) => req("PUT", p, b, o);
const guid = () => crypto.randomUUID();
const ACCT = guid();
const camel = (o, k) => {
  if (!o || typeof o !== "object") return undefined;
  if (k in o) return o[k];
  const lo = k.toLowerCase();
  for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key];
  return undefined;
};
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
async function uploadPortrait(rosterId, user) {
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "qa.png");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(API + "/api/roster/" + rosterId + "/image/upload", {
      method: "POST", signal: ctl.signal, headers: { "x-user": user || "owner" }, body: form,
    });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
async function makeBoard(name) {
  const r = await post("/api/boards", { name, mission: run + " mission", stage: "qa" });
  ok("board-" + name, r.status === 201, r.status + " " + r.text.slice(0, 120));
  return camel(r.json, "id");
}
async function quickRoster(name, desc) {
  const q = await post("/api/roster/quick", { accountId: ACCT, name, description: desc });
  ok("quick-" + name, q.status === 201, q.status + " " + q.text.slice(0, 120));
  return camel(q.json, "id");
}
async function rosterByName(name) {
  const l = await get("/api/roster?accountId=" + ACCT + "&q=" + encodeURIComponent(name));
  const arr = Array.isArray(l.json) ? l.json : [];
  return arr.find((e) => ((e.entry && (e.entry.name || e.entry.Name)) || "") === name);
}
console.log("roster-regression " + run + " vs " + API);
// 1. invalid edit no mutation
{
  const nm = run + "-inv";
  const rid = await quickRoster(nm, "invalid edit probe for " + run);
  const before = await rosterByName(nm);
  const bv = before?.entry?.version ?? before?.entry?.Version;
  const bad = await put("/api/roster/" + rid, { name: "Changed", profileJson: "x" });
  ok("invalid-edit-400", bad.status === 400, String(bad.status));
  const after = await rosterByName(nm);
  const av = after?.entry?.version ?? after?.entry?.Version;
  const an = after?.entry?.name ?? after?.entry?.Name;
  ok("invalid-edit-no-mutation", av === bv && an === nm, "before=" + bv + "/" + nm + " after=" + av + "/" + an);
}
// 2. provider failure / zero-evidence blocks approve (fake has no /responses 500; use QA-NOSEARCH)
{
  const bid = await makeBoard(run + "-fail");
  const nm = run + "-zero";
  const q = await post("/api/roster/quick", { accountId: ACCT, name: nm, description: "zero evidence for " + run });
  const rid = camel(q.json, "id");
  await uploadPortrait(rid);
  const imgs = await get("/api/roster/" + rid + "/images");
  await post("/api/images/" + imgs.json[0].id + "/review", { decision: "accept" });
  const zr = await post("/api/roster/" + rid + "/research", { focus: "QA-NOSEARCH all angles" });
  ok("zero-research-200", zr.status === 200, String(zr.status));
  ok("zero-evidence", (zr.json?.evidenceRefs?.length ?? -1) === 0, JSON.stringify(zr.json?.evidenceRefs).slice(0, 120));
  const cp = await post("/api/roster/" + rid + "/copy", { boardId: bid, boardRole: "ZeroEv" });
  const aid = camel(cp.json, "id");
  // copy should be blocked while research-required with zero evidence? copy requires completeness (portrait ok, research pending? researched so not pending, but evidence gate is at approve)
  // approve must block on evidence
  if (cp.status === 201) {
    const ap = await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
    ok("approve-zeroevidence-409", ap.status === 409 && ap.text.toLowerCase().includes("evidence"), ap.status + " " + ap.text.slice(0, 160));
  } else {
    ok("copy-zero-pending-or-201", cp.status === 409 || cp.status === 201, String(cp.status));
  }
  const rFail = await post("/api/roster/quick", { accountId: ACCT, name: run + "-r500", description: "provider failure probe for " + run });
  const rFailId = camel(rFail.json, "id");
  const rFailRes = await post("/api/roster/" + rFailId + "/research", { focus: "QA-RESEARCHERR trigger" });
  ok("research-500-502", rFailRes.status === 502, String(rFailRes.status) + " " + rFailRes.text.slice(0, 160));
  const rFailGet = await get("/api/roster/" + rFailId + "/research");
  const rFailAt = rFailGet.json.researchedAt !== undefined ? rFailGet.json.researchedAt : rFailGet.json.ResearchedAt;
  ok("research-500-still-pending", rFailGet.status === 200 && rFailAt === null, rFailGet.text.slice(0, 160));
}
// 3. rename invalidates evidence
{
  const bid = await makeBoard(run + "-ren");
  const nm = run + "-renm";
  const rid = await quickRoster(nm, "rename probe for " + run);
  await uploadPortrait(rid);
  const imgs = await get("/api/roster/" + rid + "/images");
  await post("/api/images/" + imgs.json[0].id + "/review", { decision: "accept" });
  const rr = await post("/api/roster/" + rid + "/research", { focus: "rename baseline" });
  ok("rename-baseline-research-200", rr.status === 200, String(rr.status));
  const cp = await post("/api/roster/" + rid + "/copy", { boardId: bid, boardRole: "Ren" });
  const aid = camel(cp.json, "id");
  const ap0 = await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
  ok("rename-approve-before-200", ap0.status === 200, ap0.status + " " + ap0.text.slice(0, 120));
  const ed = await put("/api/roster/" + rid, { name: nm + "-v2" });
  ok("rename-200", ed.status === 200, String(ed.status));
  const apStale = await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
  ok("rename-stale-409", apStale.status === 409, String(apStale.status));
  const cp2 = await post("/api/roster/" + rid + "/copy", { boardId: bid, boardRole: "Ren2" });
  ok("rename-copy-blocked-409", cp2.status === 409, String(cp2.status) + " " + cp2.text.slice(0, 160));
}
// 4. orphan retry write/verify
{
  const marker = ".tmp/roster-orphan.json";
  if (process.env.QA_ROSTER_ORPHAN_WRITE === "1") {
    const rid = await quickRoster(run + "-orph", "orphan write for " + run);
    await uploadPortrait(rid);
    const imgs = await get("/api/roster/" + rid + "/images");
    await post("/api/images/" + imgs.json[0].id + "/review", { decision: "accept" });
    const slow = post("/api/roster/" + rid + "/research", { focus: "QA-SLEEP:8000 orphan" });
    await new Promise((r) => setTimeout(r, 700));
    fs.writeFileSync(marker, JSON.stringify({ rid, run }));
    console.log("  orphan-write marker " + marker + " rid=" + rid + " (restart API now to orphan, then rerun without WRITE)");
    const done = await slow;
    console.log("  orphan-write slow finished " + done.status);
    ok("orphan-write-started", true, "");
  } else if (fs.existsSync(marker)) {
    let m = null;
    try { m = JSON.parse(fs.readFileSync(marker, "utf-8")); } catch {}
    if (m?.rid) {
      const r = await post("/api/roster/" + m.rid + "/research", { focus: "orphan retry" });
      ok("orphan-retry-not-permanent-409", r.status === 200 || (r.status === 409 && !r.text.toLowerCase().includes("already running")), r.status + " " + r.text.slice(0, 200));
      if (r.status === 200) { try { fs.unlinkSync(marker); } catch {} }
    } else {
      ok("orphan-marker-parse", false, "bad marker");
    }
  } else {
    console.log("  skip orphan-retry: no marker; set QA_ROSTER_ORPHAN_WRITE=1 to create one (requires primary-coordinated restart).");
    ok("orphan-skip-documented", true, "");
  }
}
// 5. edit during slow research discards
{
  const rid = await quickRoster(run + "-slow", "slow edit probe for " + run);
  await uploadPortrait(rid);
  const imgs = await get("/api/roster/" + rid + "/images");
  await post("/api/images/" + imgs.json[0].id + "/review", { decision: "accept" });
  const slow = post("/api/roster/" + rid + "/research", { focus: "QA-SLEEP:4000 concurrent" });
  await new Promise((r) => setTimeout(r, 700));
  const ed = await put("/api/roster/" + rid, { description: "edited during research for " + run });
  ok("slow-edit-200", ed.status === 200, String(ed.status));
  const done = await slow;
  ok("slow-discarded-409", done.status === 409, String(done.status) + " " + done.text.slice(0, 160));
  const retry = await post("/api/roster/" + rid + "/research", { focus: "rerun after edit" });
  ok("slow-retry-200", retry.status === 200, String(retry.status));
}
// 6. A/B portraits selected A rejected cannot approve
{
  const bid = await makeBoard(run + "-ab");
  const rid = await quickRoster(run + "-ab", "ab probe for " + run);
  await uploadPortrait(rid);
  await uploadPortrait(rid);
  const imgs = await get("/api/roster/" + rid + "/images");
  ok("ab-two-images", Array.isArray(imgs.json) && imgs.json.length >= 2, "n=" + (imgs.json || []).length);
  const a = imgs.json[imgs.json.length - 1];
  const b = imgs.json[0];
  await post("/api/images/" + a.id + "/review", { decision: "accept" });
  await post("/api/images/" + b.id + "/review", { decision: "accept" });
  // research to satisfy evidence gate (or zero? need evidence; use normal)
  await post("/api/roster/" + rid + "/research", { focus: "ab baseline" });
  const cp = await post("/api/roster/" + rid + "/copy", { boardId: bid, boardRole: "AB" });
  const aid = camel(cp.json, "id");
  const sel = await post("/api/images/" + a.id + "/select", { boardAdvisorId: aid });
  ok("ab-select-200", sel.status === 200, String(sel.status) + " " + sel.text.slice(0, 160));
  const rej = await post("/api/images/" + a.id + "/review", { decision: "retry" });
  ok("ab-reject-200", rej.status === 200, String(rej.status));
  const ap = await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
  ok("ab-selected-rejected-blocks", ap.status === 409 && ap.text.toLowerCase().includes("portrait"), ap.status + " " + ap.text.slice(0, 200));
  await post("/api/images/" + a.id + "/review", { decision: "accept" });
  const ap2 = await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
  ok("ab-reaccept-200", ap2.status === 200, ap2.status + " " + ap2.text.slice(0, 160));
}
// 7. archive/unarchive
{
  const bid = await makeBoard(run + "-arch");
  const rid = await quickRoster(run + "-arch", "archive probe for " + run);
  await uploadPortrait(rid);
  const imgs = await get("/api/roster/" + rid + "/images");
  await post("/api/images/" + imgs.json[0].id + "/review", { decision: "accept" });
  await post("/api/roster/" + rid + "/research", { focus: "arch baseline" });
  const cp = await post("/api/roster/" + rid + "/copy", { boardId: bid, boardRole: "Arch" });
  const aid = camel(cp.json, "id");
  await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
  const ar = await post("/api/roster/" + rid + "/archive", { archived: true });
  ok("archive-200", ar.status === 200, String(ar.status));
  const apA = await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
  ok("archived-blocks-approve", apA.status === 409, String(apA.status));
  const un = await post("/api/roster/" + rid + "/archive", { archived: false });
  ok("unarchive-200", un.status === 200, String(un.status));
  const advs = await get("/api/boards/" + bid + "/advisors");
  const adv = (advs.json || []).find((x) => (x.id || x.Id) === aid);
  ok("unarchive-no-auto-approve", adv && !(adv.approved ?? adv.Approved), JSON.stringify(adv).slice(0, 200));
}
// 8. unrelated manager legacy scope (best effort)
{
  console.log("  note: true legacy ownerless (OwnerKey empty) cannot be created via /quick (sets OwnerKey); direct DB seed required. Best-effort unrelated-manager check below.");
  const bA = await makeBoard(run + "-legA");
  const bB = await makeBoard(run + "-legB");
  const rid = await quickRoster(run + "-leg", "legacy scope probe " + run);
  // owner entry: unrelated user without grant cannot write (403 expected for read-only stranger)
  // create a stranger grant read-only on A, manage on B, then attempt write as stranger? x-user header switches user.
  // invite flow: create invite on B for legmgr, accept as legmgr -> manage on B only.
  const inv = await post("/api/boards/" + bB + "/invites", { email: "legmgr@x", role: "manager" });
  const iid = camel(inv.json, "id");
  if (iid) {
    await req("POST", "/api/invites/" + iid + "/accept", { userKey: "legmgr" });
    const bad = await put("/api/roster/" + rid, { description: "unrelated manage attempt" }, { user: "legmgr" });
    ok("unrelated-manage-denied", bad.status === 403 || bad.status === 404, String(bad.status) + " " + bad.text.slice(0, 160));
  } else {
    ok("legacy-invite-setup", false, "no invite id");
  }
}
// 9. research focus type validated before job acquisition (no live leak, finally clears)
{
  const rid = await quickRoster(run + "-foc", "focus validation probe " + run);
  await uploadPortrait(rid);
  const imgs = await get("/api/roster/" + rid + "/images");
  await post("/api/images/" + imgs.json[0].id + "/review", { decision: "accept" });
  const bad = await post("/api/roster/" + rid + "/research", { focus: 123 });
  ok("research-focus-type-400", bad.status === 400, String(bad.status) + " " + bad.text.slice(0, 160));
  const retry = await post("/api/roster/" + rid + "/research", { focus: "valid after bad focus" });
  ok("research-after-bad-focus-200", retry.status === 200, String(retry.status) + " " + retry.text.slice(0, 160));
  const again = await post("/api/roster/" + rid + "/research", { focus: "second sequential proves live cleared" });
  ok("research-sequential-200", again.status === 200, String(again.status) + " " + again.text.slice(0, 160));
}
// 10. last-link removal still denies unrelated manager (owned-entry API proxy; true OwnerKey-empty deny is code-enforced)
{
  const bA = await makeBoard(run + "-unlA");
  const bB = await makeBoard(run + "-unlB");
  const rid = await quickRoster(run + "-unl", "unattached deny probe " + run);
  await uploadPortrait(rid);
  const imgs = await get("/api/roster/" + rid + "/images");
  await post("/api/images/" + imgs.json[0].id + "/review", { decision: "accept" });
  const cp = await post("/api/roster/" + rid + "/copy", { boardId: bA, boardRole: "Tmp" });
  const aid = camel(cp.json, "id");
  if (aid) {
    await req("DELETE", "/api/boards/" + bA + "/advisors/" + aid);
  }
  const inv2 = await post("/api/boards/" + bB + "/invites", { email: "unlmgr@x", role: "manager" });
  const iid2 = camel(inv2.json, "id");
  if (iid2) {
    await req("POST", "/api/invites/" + iid2 + "/accept", { userKey: "unlmgr" });
    const bad2 = await put("/api/roster/" + rid, { description: "unrelated after unlink" }, { user: "unlmgr" });
    ok("unlinked-unrelated-denied", bad2.status === 403, String(bad2.status) + " " + bad2.text.slice(0, 160));
  } else {
    ok("unlinked-invite-setup", false, "no invite id");
  }
  console.log("  note: true OwnerKey-empty unattached deny enforced in CanWriteRoster (return false); no public API creates OwnerKey-empty rows; PG live seed follows on postgres backends.");
}
{
  const be = await get("/api/backend");
  const isPg = be.status === 200 && ((be.json.mode || be.json.Mode) === "postgres");
  if (!isPg) {
    console.log("  note: ownerless PG seed skipped on memory backend (PG leg covers live seed).");
    ok("ownerless-pg-skip-documented", true, "");
  } else if (TAG.includes("seed")) {
    const bA = await makeBoard(run + "-ownA");
    const bB = await makeBoard(run + "-ownB");
    const rOwn = await post("/api/roster/quick", { accountId: ACCT, name: run + "-own", description: "ownerless seed probe for " + run });
    const rOwnId = camel(rOwn.json, "id");
    await uploadPortrait(rOwnId);
    const rOwnImgs = await get("/api/roster/" + rOwnId + "/images");
    await post("/api/images/" + rOwnImgs.json[0].id + "/review", { decision: "accept" });
    const cpA = await post("/api/roster/" + rOwnId + "/copy", { boardId: bA, boardRole: "OwnA" });
    ok("ownerless-link-201", cpA.status === 201, String(cpA.status));
    let seeded = false;
    try {
      const pre = spawnSync("docker", ["exec", "-i", "simceo-qa-pg", "psql", "-U", "simceo", "-d", "simceo", "-tAc", "SELECT count(*) FROM \"public\".\"RosterEntries\""], { encoding: "utf8", windowsHide: true, timeout: 30000 });
      if (pre.status === 0) {
        const sql = "UPDATE \"public\".\"RosterEntries\" SET \"OwnerKey\" = $$$$ WHERE \"Id\" = $$" + rOwnId + "$$";
        const up = spawnSync("docker", ["exec", "-i", "simceo-qa-pg", "psql", "-U", "simceo", "-d", "simceo", "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { encoding: "utf8", windowsHide: true, timeout: 30000 });
        if (up.status === 0) {
          const chk = spawnSync("docker", ["exec", "-i", "simceo-qa-pg", "psql", "-U", "simceo", "-d", "simceo", "-tAc", "SELECT count(*) FROM \"public\".\"RosterEntries\" WHERE \"Id\" = $$" + rOwnId + "$$ AND \"OwnerKey\" = $$$$"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
          seeded = (chk.status === 0 && ((chk.stdout || "").trim() === "1"));
        } else { console.log("  note: ownerless seed UPDATE failed: " + ((up.stderr || "") + (up.stdout || "")).slice(0, 160)); }
      } else { console.log("  note: ownerless seed skipped: RosterEntries table not visible: " + ((pre.stderr || "") + (pre.stdout || "")).slice(0, 160)); }
    } catch (e) { console.log("  note: ownerless seed docker unavailable: " + String((e && e.message) || e).slice(0, 160)); }
    ok("ownerless-seeded", seeded, "single-row OwnerKey clear failed");
    if (seeded) {
      fs.writeFileSync(".tmp/ownerless-pg-state.json", JSON.stringify({ bA: bA, bB: bB, rOwnId: rOwnId }));
      console.log("  note: ownerless seed written; verify runs after API restart.");
    }
  } else if (!fs.existsSync(".tmp/ownerless-pg-state.json")) {
    ok("ownerless-state-present", false, "pre-restart seed did not run; use the -Pg runner leg or --tag pg-laneA-seed first");
  } else {
    let st = null;
    try { st = JSON.parse(fs.readFileSync(".tmp/ownerless-pg-state.json", "utf8")); } catch (e) { st = null; }
    ok("ownerless-state-present", !!(st && st.rOwnId), "missing seed state");
    if (st && st.rOwnId) {
      const invB = await post("/api/boards/" + st.bB + "/invites", { email: "ownB@x", role: "manager" });
      const iidB = camel(invB.json, "id");
      if (iidB) { await req("POST", "/api/invites/" + iidB + "/accept", { userKey: "ownB" }); }
      const badB = await put("/api/roster/" + st.rOwnId, { description: "unrelated manage on ownerless" }, { user: "ownB" });
      ok("ownerless-unrelated-denied", badB.status === 403, String(badB.status) + " " + badB.text.slice(0, 160));
      const invA = await post("/api/boards/" + st.bA + "/invites", { email: "ownA@x", role: "manager" });
      const iidA = camel(invA.json, "id");
      if (iidA) { await req("POST", "/api/invites/" + iidA + "/accept", { userKey: "ownA" }); }
      const goodA = await put("/api/roster/" + st.rOwnId, { description: "linked manage on ownerless for " + run }, { user: "ownA" });
      ok("ownerless-linked-allowed", goodA.status === 200, String(goodA.status) + " " + goodA.text.slice(0, 160));
      try { fs.unlinkSync(".tmp/ownerless-pg-state.json"); } catch (e) {}
    }
  }
}
// 11. shared-image cross-board scope: single-board manage cannot retry/delete a shared portrait (finding 1).
// Shared review/delete mutates every board copy, so roster-linked images require
// the full CanWriteRoster boundary. Per-board select stays allowed; owner-owned
// templates stay owner-controlled; legacy ownerless all-linked-manage flows
// through that same boundary.
{
  console.log("  shared-image cross-board scope (finding 1)");
  const bA = await makeBoard(run + "-xA");
  const bB = await makeBoard(run + "-xB");
  const rid = await quickRoster(run + "-ximg", "shared image scope probe for " + run);
  await uploadPortrait(rid);
  const imgList0 = await get("/api/roster/" + rid + "/images");
  const imgId = camel(imgList0.json[0], "id");
  const acc = await post("/api/images/" + imgId + "/review", { decision: "accept" });
  ok("ximg-accept-200", acc.status === 200, String(acc.status));
  const cpA = await post("/api/roster/" + rid + "/copy", { boardId: bA, boardRole: "XA" });
  const aidA = camel(cpA.json, "id");
  ok("ximg-copy-A-201", cpA.status === 201, String(cpA.status));
  const cpB = await post("/api/roster/" + rid + "/copy", { boardId: bB, boardRole: "XB" });
  const aidB = camel(cpB.json, "id");
  ok("ximg-copy-B-201", cpB.status === 201, String(cpB.status));
  const selA = await post("/api/images/" + imgId + "/select", { boardAdvisorId: aidA });
  ok("ximg-select-A-200", selA.status === 200, String(selA.status));
  const selB = await post("/api/images/" + imgId + "/select", { boardAdvisorId: aidB });
  ok("ximg-select-B-200", selB.status === 200, String(selB.status));
  const apA = await post("/api/boards/" + bA + "/advisors/" + aidA + "/approve", {});
  ok("ximg-approve-A-200", apA.status === 200, String(apA.status));
  const apB = await post("/api/boards/" + bB + "/advisors/" + aidB + "/approve", {});
  ok("ximg-approve-B-200", apB.status === 200, String(apB.status));
  const invB = await post("/api/boards/" + bB + "/invites", { email: "crossb@x", role: "manager" });
  const iidB = camel(invB.json, "id");
  if (iidB) await req("POST", "/api/invites/" + iidB + "/accept", { userKey: "crossB" });
  const invA = await post("/api/boards/" + bA + "/invites", { email: "crossb@x", role: "viewer" });
  const iidA = camel(invA.json, "id");
  if (iidA) await req("POST", "/api/invites/" + iidA + "/accept", { userKey: "crossB" });
  ok("ximg-crossB-setup", !!(iidA && iidB), "invites " + iidA + " / " + iidB);
  const deniedRetry = await post("/api/images/" + imgId + "/review", { decision: "retry" }, { user: "crossB" });
  ok("ximg-crossB-retry-denied", deniedRetry.status === 403, String(deniedRetry.status) + " " + deniedRetry.text.slice(0, 160));
  const imgsAfter = await get("/api/roster/" + rid + "/images");
  const imgAfter = (imgsAfter.json || []).find((x) => camel(x, "id") === imgId);
  ok("ximg-denied-no-review-change", imgAfter && (camel(imgAfter, "review") === "accepted"), JSON.stringify(imgAfter).slice(0, 200));
  const advsA = await get("/api/boards/" + bA + "/advisors");
  const advA = (advsA.json || []).find((x) => camel(x, "id") === aidA);
  const advsB = await get("/api/boards/" + bB + "/advisors");
  const advB = (advsB.json || []).find((x) => camel(x, "id") === aidB);
  ok("ximg-denied-A-still-approved", advA && ((advA.approved ?? advA.Approved) === true), JSON.stringify(advA).slice(0, 200));
  ok("ximg-denied-B-still-approved", advB && ((advB.approved ?? advB.Approved) === true), JSON.stringify(advB).slice(0, 200));
  const deniedDel = await req("DELETE", "/api/images/" + imgId, undefined, { user: "crossB" });
  ok("ximg-crossB-delete-denied", deniedDel.status === 403, String(deniedDel.status) + " " + deniedDel.text.slice(0, 160));
  const imgsAfterDel = await get("/api/roster/" + rid + "/images");
  ok("ximg-denied-delete-no-remove", (imgsAfterDel.json || []).some((x) => camel(x, "id") === imgId), "n=" + (imgsAfterDel.json || []).length);
  const selCross = await post("/api/images/" + imgId + "/select", { boardAdvisorId: aidB }, { user: "crossB" });
  ok("ximg-crossB-select-allowed", selCross.status === 200, String(selCross.status) + " " + selCross.text.slice(0, 160));
  const advsA2 = await get("/api/boards/" + bA + "/advisors");
  const advA2 = (advsA2.json || []).find((x) => camel(x, "id") === aidA);
  ok("ximg-select-no-cross-unapprove", advA2 && ((advA2.approved ?? advA2.Approved) === true), JSON.stringify(advA2).slice(0, 200));
  const reApB = await post("/api/boards/" + bB + "/advisors/" + aidB + "/approve", {});
  ok("ximg-reapprove-B-200", reApB.status === 200, String(reApB.status));
  const invFA = await post("/api/boards/" + bA + "/invites", { email: "fullmgr@x", role: "manager" });
  const iidFA = camel(invFA.json, "id");
  if (iidFA) await req("POST", "/api/invites/" + iidFA + "/accept", { userKey: "fullmgr" });
  const invFB = await post("/api/boards/" + bB + "/invites", { email: "fullmgr@x", role: "manager" });
  const iidFB = camel(invFB.json, "id");
  if (iidFB) await req("POST", "/api/invites/" + iidFB + "/accept", { userKey: "fullmgr" });
  const fullRetry = await post("/api/images/" + imgId + "/review", { decision: "retry" }, { user: "fullmgr" });
  ok("ximg-fullmgr-owned-denied", fullRetry.status === 403, String(fullRetry.status) + " " + fullRetry.text.slice(0, 160));
  const ownRetry = await post("/api/images/" + imgId + "/review", { decision: "retry" });
  ok("ximg-owner-retry-200", ownRetry.status === 200, String(ownRetry.status));
  const advsA3 = await get("/api/boards/" + bA + "/advisors");
  const advA3 = (advsA3.json || []).find((x) => camel(x, "id") === aidA);
  const advsB3 = await get("/api/boards/" + bB + "/advisors");
  const advB3 = (advsB3.json || []).find((x) => camel(x, "id") === aidB);
  ok("ximg-owner-retry-unapproves-A", advA3 && !((advA3.approved ?? advA3.Approved) === true), JSON.stringify(advA3).slice(0, 200));
  ok("ximg-owner-retry-unapproves-B", advB3 && !((advB3.approved ?? advB3.Approved) === true), JSON.stringify(advB3).slice(0, 200));
  const ownAcc = await post("/api/images/" + imgId + "/review", { decision: "accept" });
  ok("ximg-owner-accept-200", ownAcc.status === 200, String(ownAcc.status));
  await post("/api/boards/" + bA + "/advisors/" + aidA + "/approve", {});
  await post("/api/boards/" + bB + "/advisors/" + aidB + "/approve", {});
  const ownDel = await req("DELETE", "/api/images/" + imgId);
  ok("ximg-owner-delete-204", ownDel.status === 204, String(ownDel.status));
  const imgsGone = await get("/api/roster/" + rid + "/images");
  ok("ximg-owner-delete-removed", !(imgsGone.json || []).some((x) => camel(x, "id") === imgId), "n=" + (imgsGone.json || []).length);
}
// 12. select must not override a shared rejection (finding 1 select bypass).
// Per-board select records identity only; the global Review stays rejected, so
// approval stays blocked until an explicit review accept with full scope.
{
  console.log("  select-preserves-rejection (finding 1 select bypass)");
  const bA = await makeBoard(run + "-sA");
  const bB = await makeBoard(run + "-sB");
  const rid = await quickRoster(run + "-srej", "select-rejection probe for " + run);
  await uploadPortrait(rid);
  const imgList = await get("/api/roster/" + rid + "/images");
  const imgId = camel(imgList.json[0], "id");
  const acc = await post("/api/images/" + imgId + "/review", { decision: "accept" });
  ok("srej-accept-200", acc.status === 200, String(acc.status));
  const cpA = await post("/api/roster/" + rid + "/copy", { boardId: bA, boardRole: "SA" });
  const aidA = camel(cpA.json, "id");
  const cpB = await post("/api/roster/" + rid + "/copy", { boardId: bB, boardRole: "SB" });
  const aidB = camel(cpB.json, "id");
  ok("srej-copies-201", cpA.status === 201 && cpB.status === 201, cpA.status + "/" + cpB.status);
  const invB = await post("/api/boards/" + bB + "/invites", { email: "selb@x", role: "manager" });
  const iidB = camel(invB.json, "id");
  if (iidB) await req("POST", "/api/invites/" + iidB + "/accept", { userKey: "selB" });
  ok("srej-selB-setup", !!iidB, String(iidB));
  const rej = await post("/api/images/" + imgId + "/review", { decision: "retry" });
  ok("srej-owner-reject-200", rej.status === 200, String(rej.status));
  const selB = await post("/api/images/" + imgId + "/select", { boardAdvisorId: aidB }, { user: "selB" });
  ok("srej-B-select-200", selB.status === 200, String(selB.status) + " " + selB.text.slice(0, 160));
  const imgsAfter = await get("/api/roster/" + rid + "/images");
  const imgAfter = (imgsAfter.json || []).find((x) => camel(x, "id") === imgId);
  ok("srej-review-still-rejected", imgAfter && (camel(imgAfter, "review") === "rejected"), JSON.stringify(imgAfter).slice(0, 200));
  const apB = await post("/api/boards/" + bB + "/advisors/" + aidB + "/approve", {}, { user: "selB" });
  ok("srej-B-approve-409", apB.status === 409 && apB.text.toLowerCase().includes("portrait"), String(apB.status) + " " + apB.text.slice(0, 200));
  const reAcc = await post("/api/images/" + imgId + "/review", { decision: "accept" });
  ok("srej-owner-accept-200", reAcc.status === 200, String(reAcc.status));
  const apB2 = await post("/api/boards/" + bB + "/advisors/" + aidB + "/approve", {});
  ok("srej-B-approve-after-accept-200", apB2.status === 200, String(apB2.status) + " " + apB2.text.slice(0, 160));
  const apA2 = await post("/api/boards/" + bA + "/advisors/" + aidA + "/approve", {});
  ok("srej-A-approve-after-accept-200", apA2.status === 200, String(apA2.status) + " " + apA2.text.slice(0, 160));
}
console.log("PASS " + pass + " FAIL " + fail);
if (failures.length) console.log("failures: " + failures.join(" | "));
process.exit(fail ? 1 : 0);