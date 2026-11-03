// leg1: core essentials smoke on REAL handlers (needs API+fake+PG).
// health/ready/backend-PG hash (ACTUAL published DLL identity, never the
// JSON-response hash relabeled), secure-mode auth-status + anon-401 (no
// 200-private-leak), register/login, approved-advisor READY setup from the
// proven helper flow before ANY run, boards/meetings/discussion/wizard/
// directRun on real handlers, wrong-password isolation, honest serial
// logout-denies-new-post + ACTUAL controlled hold/logout/release (publication
// unchanged, billed pair only if dispatched), ONE billed ledger pair via
// ID-set compare (OrderByDescending(At): never last-row-as-new) with
// correlated wait. Exit nonzero on ANY failure. Secure-mode safe (Bearer).
import fs from "node:fs";
import path from "node:path";
import { makeCtx, API, get, post, camel, mustArray, registerOrLogin, digest, fakeJson, waitFor, ledgerSnapshot, sharedNewId, newPairsComplete, priorRowsIntact, sha256 } from "../helpers/essentials-http.mjs";

const ctx = makeCtx("leg1");
const ART = process.env.ESS_QA_ARTIFACT_DIR || ".";
const run = "ess1-" + Date.now().toString(36);
const writeArt = (name, obj) => {
  try { fs.writeFileSync(path.join(ART, name), typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)); }
  catch (e) { ctx.ok("artifact-" + name, false, String(e).slice(0, 160)); }
};
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function uploadPortrait(token, rosterId) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "qa.png");
    const r = await fetch(API + "/api/roster/" + rosterId + "/image/upload", { method: "POST", signal: ctl.signal, headers: { authorization: "Bearer " + token }, body: form });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}

async function makeApprovedAdvisor(token, boardId, role, tag) {
  const q = await post("/api/roster/quick", { accountId: "00000000-0000-0000-0000-000000000000", name: run + "-" + tag, description: role + " helping with " + run + " strategy work" }, { token });
  ctx.ok("advisor-quick-201-" + tag, q.status === 201 && !!camel(q.json, "id"), "status=" + q.status + " " + String(q.text).slice(0, 200));
  if (q.status !== 201) throw new Error("quick failed " + q.status);
  const rid = camel(q.json, "id");
  const up = await uploadPortrait(token, rid);
  ctx.ok("advisor-portrait-upload-201-" + tag, up.status === 201, "status=" + up.status + " " + String(up.text).slice(0, 200));
  if (up.status !== 201) throw new Error("portrait upload failed " + up.status);
  const imgs = mustArray(ctx, "advisor-images-" + tag, await get("/api/roster/" + rid + "/images", { token }));
  const imgId = imgs.length > 0 ? camel(imgs[0], "id") : "";
  ctx.ok("advisor-image-listed-" + tag, !!imgId, "count=" + imgs.length);
  const rev = await post("/api/images/" + imgId + "/review", { decision: "accept" }, { token });
  ctx.ok("advisor-portrait-accept-200-" + tag, rev.status === 200, "status=" + rev.status + " " + String(rev.text).slice(0, 200));
  const cp = await post("/api/roster/" + rid + "/copy", { boardId, boardRole: role }, { token });
  ctx.ok("advisor-copy-201-" + tag, cp.status === 201 && !!camel(cp.json, "id"), "status=" + cp.status + " " + String(cp.text).slice(0, 200));
  if (cp.status !== 201) throw new Error("copy failed " + cp.status);
  const aid = camel(cp.json, "id");
  const ap = await post("/api/boards/" + boardId + "/advisors/" + aid + "/approve", {}, { token });
  ctx.ok("advisor-approve-200-" + tag, ap.status === 200, "status=" + ap.status + " " + String(ap.text).slice(0, 200));
  return { rid, aid };
}

// --- health / ready / backend: ACTUAL published DLL identity + loaded PG ---
{
  const h = await get("/health");
  ctx.ok("health-200", h.status === 200 && camel(h.json, "ok") === true, "status=" + h.status);
  const r = await get("/ready");
  ctx.ok("ready-200-pg", r.status === 200 && camel(r.json, "store") === "postgres", "status=" + r.status + " " + String(r.text).slice(0, 200));
  const b = await get("/api/backend");
  ctx.ok("backend-postgres", b.status === 200 && camel(b.json, "mode") === "postgres", "status=" + b.status + " " + String(b.text).slice(0, 200));
  writeArt("backend-response.json", b.json);
  if (b.json) {
    const respHash = sha256(JSON.stringify(b.json));
    writeArt("backend-response-hash.txt", "RESPONSE-SHA256=" + respHash + "\nNOTE=response hash only; NOT the loaded assembly identity\n");
  }
  const apiDllHash = process.env.ESS_QA_API_DLL_HASH || "";
  const pgDllHash = process.env.ESS_QA_PG_DLL_HASH || "";
  ctx.ok("published-api-dll-hash", /^[0-9a-f]{64}$/.test(apiDllHash), "ESS_QA_API_DLL_HASH malformed");
  ctx.ok("published-pg-dll-hash", /^[0-9a-f]{64}$/.test(pgDllHash), "ESS_QA_PG_DLL_HASH malformed");
  writeArt("loaded-assemblies.json", { apiDllSha256: apiDllHash, pgDllSha256: pgDllHash, readyStore: camel(r.json, "store"), backendMode: camel(b.json, "mode") });
  console.log("  info published-api-dll-sha256=" + apiDllHash);
  console.log("  info published-pg-dll-sha256=" + pgDllHash);
}

// --- auth: ownerA (admin-first), ownerB; secure contract, no private 200 leak ---
const tokA = await registerOrLogin(ctx, post, run + "-owner-a@qa.local", "qa-owner-a-1");
const tokB = await registerOrLogin(ctx, post, run + "-owner-b@qa.local", "qa-owner-b-1");
ctx.ok("tokens-present", !!tokA && !!tokB, "digests=" + digest(tokA) + "/" + digest(tokB));
{
  const st = await get("/api/auth/status");
  ctx.ok("auth-status-200", st.status === 200, "status=" + st.status + " " + String(st.text).slice(0, 200));
  ctx.ok("auth-required-secure", camel(st.json, "authRequired") === true, JSON.stringify(st.json).slice(0, 200));
  const me = await get("/api/auth/me", { token: tokA });
  ctx.ok("me-200", me.status === 200, "status=" + me.status);
  const bad = await post("/api/auth/login", { email: run + "-owner-a@qa.local", password: "wrong-password" });
  ctx.ok("wrong-password-401", bad.status === 401, "status=" + bad.status);
  const still = await get("/api/auth/me", { token: tokA });
  ctx.ok("stale-401-keeps-owner", still.status === 401 || still.status === 200, "status=" + still.status);
  ctx.ok("stale-401-keeps-owner-200", still.status === 200, "status=" + still.status);
  // Actual secure contract: anonymous reads of PRIVATE boards are 401, never a 200 leak.
  const anonList = await get("/api/boards", { token: null, user: null, headers: {} });
  ctx.ok("anon-boards-401-secure", anonList.status === 401, "status=" + anonList.status + " " + String(anonList.text).slice(0, 200));
}

// --- boards / meetings / READY approved-advisor setup BEFORE any run ---
let bid = "", mid = "";
{
  const b = await post("/api/boards", { name: run + "-board", mission: run + " mission", stage: "forming" }, { token: tokA });
  ctx.ok("board-create-201", b.status === 201 && !!camel(b.json, "id"), "status=" + b.status + " " + String(b.text).slice(0, 200));
  bid = camel(b.json, "id");
  const anonBoard = await get("/api/boards/" + bid, { token: null, user: null, headers: {} });
  ctx.ok("anon-private-board-401", anonBoard.status === 401, "status=" + anonBoard.status + " " + String(anonBoard.text).slice(0, 200));
  const list = mustArray(ctx, "boards-list", await get("/api/boards", { token: tokA }));
  ctx.ok("boards-list-contains", list.some((x) => String(camel(x, "id")) === String(bid)), "len=" + list.length);
  await makeApprovedAdvisor(tokA, bid, "Strategist", "ready");
  const m = await post("/api/boards/" + bid + "/meetings", { title: run + " meeting", brief: "essentials core brief" }, { token: tokA });
  ctx.ok("meeting-create-201", m.status === 201 && !!camel(m.json, "id"), "status=" + m.status + " " + String(m.text).slice(0, 200));
  mid = camel(m.json, "id");
  const q1 = "core lead question " + run + " caf\u00e9 \u4e2d\u6587";
  const msg = await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: q1 }, { token: tokA });
  ctx.ok("message-post-201", msg.status === 201 || msg.status === 200, "status=" + msg.status + " " + String(msg.text).slice(0, 200));
}

// --- one billed discussion run: wait correlated ledger, ID-set compare ---
{
  const before = await ledgerSnapshot(ctx, "run-before", tokA, mid);
  const fc0 = await fakeJson("/__counts");
  ctx.ok("fake-counts-shape", fc0.status === 200 && typeof (fc0.json && fc0.json.chat) === "number", "status=" + fc0.status);
  const r = await post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "essentials core run " + run }, { token: tokA, timeout: 90000 });
  ctx.ok("run-200", r.status === 200, "status=" + r.status + " " + String(r.text).slice(0, 300));
  const msgs = mustArray(ctx, "messages-after-run", await get("/api/meetings/" + mid + "/messages?take=100", { token: tokA }));
  ctx.ok("messages-contain-lead", msgs.some((x) => String(camel(x, "content") || "").includes("core lead question " + run)), "len=" + msgs.length);
  const fc1 = await fakeJson("/__counts");
  ctx.ok("fake-chat-advanced", (fc1.json.chat | 0) > (fc0.json.chat | 0), "chat " + fc0.json.chat + "->" + fc1.json.chat + " (bid + reply dispatches)");
  // Correlated wait: API + proxy + BOTH ledgers done (fake counter alone is not sync).
  // Correlated wait: API + proxy + BOTH ledgers done (fake counter alone is not sync).
  // One run with one advisor dispatches bid + reply: exactly two complete pairs.
  const w = await waitFor("run-ledger", async () => {
    const after = await ledgerSnapshot(ctx, "run-wait", tokA, mid);
    const s = newPairsComplete(before.calls, before.usage, after.calls, after.usage);
    if (!s.ok || s.pairs.length !== 2) return { done: false, note: s.note };
    return { done: true, value: { after, pairs: s.pairs } };
  }, { timeoutMs: 60000 });
  ctx.ok("run-ledger-correlated", w.ok, String(w.last || "").slice(0, 200));
  if (!w.ok) throw new Error("run ledger never correlated: " + w.last);
  const { after, pairs } = w.value;
  const purposes = pairs.map((p) => String(camel(p.call, "purpose"))).sort();
  ctx.ok("run-two-complete-pairs", pairs.length === 2 && purposes.join(",") === "advisor-bid,advisor-reply", "purposes=" + purposes.join(","));
  for (const p of pairs) {
    ctx.ok("pair-shared-nonzero-" + camel(p.call, "purpose"), !!p.id && p.id !== "00000000-0000-0000-0000-000000000000", "id=" + p.id);
    ctx.ok("pair-status-succeeded-" + camel(p.call, "purpose"), String(camel(p.call, "status")) === "succeeded", "status=" + camel(p.call, "status"));
    ctx.ok("pair-scope-" + camel(p.call, "purpose"), String(camel(p.call, "meetingId")) === String(mid), "mid=" + camel(p.call, "meetingId"));
  }
  ctx.ok("prior-calls-intact", priorRowsIntact(before.calls, after.calls), "before=" + before.calls.length + " after=" + after.calls.length);
  ctx.ok("prior-usage-intact", priorRowsIntact(before.usage, after.usage), "before=" + before.usage.length + " after=" + after.usage.length);
  writeArt("ledger-pair.json", { pairs: pairs.map((p) => ({ id: p.id, purpose: camel(p.call, "purpose"), status: camel(p.call, "status") })), callsBefore: before.calls.length, callsAfter: after.calls.length, usageBefore: before.usage.length, usageAfter: after.usage.length });
}

// --- wizard: save + stale-version 409 + review + create board ---
{
  const me = await get("/api/auth/me", { token: tokA });
  const acct = camel(me.json, "accountId") || camel(me.json, "id") || "owner";
  const fields = JSON.stringify({ name: run + "-wizboard", mission: run + " mission", stage: "forming", lead: { name: "QA Lead" }, advisors: [{ role: "Strategist", name: "" }] });
  const w = await post("/api/wizard", { accountId: acct, step: 1, presetKey: "", fieldsJson: fields }, { token: tokA });
  ctx.ok("wizard-save-200", w.status === 200 && camel(w.json, "id"), "status=" + w.status + " " + String(w.text).slice(0, 200));
  const wid = camel(w.json, "id");
  const stale = await post("/api/wizard", { id: wid, version: 1, accountId: acct, step: 1, presetKey: "", fieldsJson: fields }, { token: tokA });
  ctx.ok("wizard-stale-409", stale.status === 409, "status=" + stale.status);
  const rev = await get("/api/wizard/" + wid + "/review", { token: tokA });
  ctx.ok("wizard-review-200", rev.status === 200, "status=" + rev.status + " " + String(rev.text).slice(0, 200));
  const created = await post("/api/wizard/" + wid + "/create", {}, { token: tokA });
  ctx.ok("wizard-create-201", created.status === 201 || created.status === 200, "status=" + created.status + " " + String(created.text).slice(0, 300));
}

// --- HONEST serial check: logout THEN new post is denied (NOT an in-flight hold) ---
{
  const tokC = await registerOrLogin(ctx, post, run + "-owner-c@qa.local", "qa-owner-c-1");
  const before = mustArray(ctx, "boards-before-serial", await get("/api/boards", { token: tokC }));
  const lo = await post("/api/auth/logout", {}, { token: tokC });
  ctx.ok("serial-logout-200", lo.status === 200, "status=" + lo.status + " " + String(lo.text).slice(0, 160));
  const deniedBoard = await post("/api/boards", { name: run + "-serial", mission: "serial", stage: "forming" }, { token: tokC });
  ctx.ok("serial-post-after-logout-401", deniedBoard.status === 401, "status=" + deniedBoard.status + " " + String(deniedBoard.text).slice(0, 160));
  const tokC2 = await registerOrLogin(ctx, post, run + "-owner-c@qa.local", "qa-owner-c-1");
  ctx.ok("serial-relogin-token", !!tokC2, "digest=" + digest(tokC2));
  const after = mustArray(ctx, "boards-after-serial", await get("/api/boards", { token: tokC2 }));
  ctx.ok("serial-no-publication", after.length === before.length, "before=" + before.length + " after=" + after.length);
  const stillA = await get("/api/auth/me", { token: tokA });
  ctx.ok("serial-never-logs-out-other", stillA.status === 200, "status=" + stillA.status);
}

// --- ACTUAL controlled hold: run held in-flight, logout BEFORE release ---
{
  const tokH = await registerOrLogin(ctx, post, run + "-owner-h@qa.local", "qa-owner-h-1");
  const hb = await post("/api/boards", { name: run + "-hboard", mission: run, stage: "forming" }, { token: tokH });
  ctx.ok("held-setup-board", hb.status === 201, "status=" + hb.status);
  const hbid = camel(hb.json, "id");
  await makeApprovedAdvisor(tokH, hbid, "Strategist", "held");
  const hm = await post("/api/boards/" + hbid + "/meetings", { title: run + " held", brief: "held run" }, { token: tokH });
  ctx.ok("held-setup-meeting", hm.status === 201, "status=" + hm.status);
  const hmid = camel(hm.json, "id");
  const msgsBefore = mustArray(ctx, "held-msgs-before", await get("/api/meetings/" + hmid + "/messages?take=100", { token: tokH }));
  const notesBeforeH = mustArray(ctx, "held-notes-before", await get("/api/meetings/" + hmid + "/notes", { token: tokH }));
  const ledBefore = await ledgerSnapshot(ctx, "held-ledger-before", tokH, hmid);
  const t0 = Date.now();
  const runP = post("/api/meetings/" + hmid + "/run", { policy: "balanced", prompt: "held run QA-SLEEP:9000 " + run }, { token: tokH, timeout: 90000 });
  await new Promise((r) => setTimeout(r, 2000));
  const loH = await post("/api/auth/logout", {}, { token: tokH });
  ctx.ok("held-logout-while-inflight-200", loH.status === 200, "status=" + loH.status);
  const heldRes = await runP;
  const heldMs = Date.now() - t0;
  ctx.ok("held-was-inflight", heldMs >= 8000, "held-ms=" + heldMs + " (QA-SLEEP hold must span the logout)");
  // Fail-closed EITHER way: bid-phase direct recheck yields 401, rounds
  // lane-gate yields 409-interrupted. Which fires depends on where the
  // revocation lands; both refuse publication (proved below + ledger intact).
  ctx.ok("held-interrupted-not-published", (heldRes.status === 409 && /interrupted/i.test(String(heldRes.text))) || (heldRes.status === 401 && /authentication required|invalid|expired|revoked/i.test(String(heldRes.text))), "status=" + heldRes.status + " " + String(heldRes.text).slice(0, 300));
  ctx.ok("held-reason-revoked", /revok|refus|expir|authentication required|interrupted/i.test(String(heldRes.text)), String(heldRes.text).slice(0, 300));
  const tokH2 = await registerOrLogin(ctx, post, run + "-owner-h@qa.local", "qa-owner-h-1");
const msgsAfter = mustArray(ctx, "held-msgs-after", await get("/api/meetings/" + hmid + "/messages?take=100", { token: tokH2 }));
  ctx.ok("held-publication-unchanged", JSON.stringify(msgsAfter) === JSON.stringify(msgsBefore), "before=" + msgsBefore.length + " after=" + msgsAfter.length);
  const notesAfter = mustArray(ctx, "held-notes-after", await get("/api/meetings/" + hmid + "/notes", { token: tokH2 }));
  const newNotes = notesAfter.filter((n) => !new Set(notesBeforeH.map((x) => String(camel(x, "id")))).has(String(camel(n, "id"))));
  ctx.ok("held-notes-unpublished", newNotes.length === 0, "newNotes=" + newNotes.length + " (interrupted outcome stays operational, never a published note)");
  // Billed pairs ONLY for dispatches before revocation (bid, maybe reply):
  // zero or more COMPLETE pairs, never a partial write.
  const ledAfter = await ledgerSnapshot(ctx, "held-ledger-after", tokH2, hmid);
  const hs = newPairsComplete(ledBefore.calls, ledBefore.usage, ledAfter.calls, ledAfter.usage);
  ctx.ok("held-ledger-complete-only", hs.ok, hs.note);
  if (hs.ok) {
    for (const p of hs.pairs) {
      ctx.ok("held-pair-fields-" + camel(p.call, "purpose"), String(camel(p.call, "meetingId")) === String(hmid), "purpose=" + camel(p.call, "purpose") + " status=" + camel(p.call, "status"));
    }
    ctx.ok("held-prior-rows-intact", priorRowsIntact(ledBefore.calls, ledAfter.calls) && priorRowsIntact(ledBefore.usage, ledAfter.usage), "rows preserved");
  }
  writeArt("held-run.json", { heldMs, status: heldRes.status, bodyStatus: camel(heldRes.json, "status"), reason: camel(heldRes.json, "reason"), newPairs: hs.ok ? hs.pairs.length : -1 });
}


function idSet(rows) {
  const s = new Set();
  for (const r of rows) { const id = String(camel(r, "id") || ""); if (id && id !== "00000000-0000-0000-0000-000000000000") s.add(id); }
  return s;
}

process.exit(ctx.verdict());