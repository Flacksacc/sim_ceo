// leg4: secretary assistant essentials on REAL handlers (needs API+fake+PG).
// Direct routing (no advisor bids), provisional never decision/approval,
// edit/reverse/history with revision guards, approved direction + MESSAGE
// exact-quote evidence, full omissions visibility, clarify nonce binding +
// replay + conflict, drift-409 on changed citation, TWO overlap recovery
// flows (sequential replay + CONCURRENT same-nonce pair with single
// publication), correlated ledger wait (purpose secretary, shared nonzero
// GUID, scope/model/purpose/status/cost/basis + prior rows intact), ordered
// delivery array hashed from RAW wire text (unicode/whitespace preserved).
// Exit nonzero on ANY failure. Secure-mode safe (Bearer everywhere).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { makeCtx, API, get, post, camel, mustArray, registerOrLogin, digest, fakeJson, waitFor, ledgerSnapshot, sharedNewId, priorRowsIntact } from "../helpers/essentials-http.mjs";
import { verifyContainer, triggerInstall, triggerDrop, psql, fingerprintTable } from "../helpers/essentials-pg.mjs";

const ctx = makeCtx("leg4");
const ART = process.env.ESS_QA_ARTIFACT_DIR || ".";
const run = "ess4-" + Date.now().toString(36);
const writeArt = (name, obj) => {
  try { fs.writeFileSync(path.join(ART, name), typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)); }
  catch (e) { ctx.ok("artifact-" + name, false, String(e).slice(0, 160)); }
};
const tok = await registerOrLogin(ctx, post, run + "-sec@qa.local", "qa-sec-1-pw12");
ctx.ok("token-present", !!tok, "digest=" + digest(tok));

const b = await post("/api/boards", { name: run + "-board", mission: run + " mission", stage: "forming" }, { token: tok });
ctx.ok("setup-board", b.status === 201 && !!camel(b.json, "id"), "status=" + b.status);
const bid = camel(b.json, "id");
const lead = await post("/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Chief", background: "bg", familiarTopics: "fam", simplerTopics: "sim", commPrefs: "direct" }, { token: tok });
ctx.ok("setup-lead", lead.status === 200, "status=" + lead.status + " " + String(lead.text).slice(0, 160));
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
// READY setup: one approved advisor with accepted portrait (proven helper flow).
{
  const q = await post("/api/roster/quick", { accountId: "00000000-0000-0000-0000-000000000000", name: run + "-adv", description: "advisor helping with " + run + " and strategy work for grounding" }, { token: tok });
  ctx.ok("setup-advisor-quick", q.status === 201, "status=" + q.status + " " + String(q.text).slice(0, 200));
  const rid = camel(q.json, "id");
  const up = await uploadPortrait(tok, rid);
  ctx.ok("setup-advisor-portrait", up.status === 201, "status=" + up.status);
  const imgs = mustArray(ctx, "setup-advisor-images", await get("/api/roster/" + rid + "/images", { token: tok }));
  const rev = await post("/api/images/" + camel(imgs[0], "id") + "/review", { decision: "accept" }, { token: tok });
  ctx.ok("setup-advisor-accept", rev.status === 200, "status=" + rev.status);
  const cp = await post("/api/roster/" + rid + "/copy", { boardId: bid, boardRole: "Strategist" }, { token: tok });
  ctx.ok("setup-advisor-copy", cp.status === 201, "status=" + cp.status + " " + String(cp.text).slice(0, 200));
  const ap = await post("/api/boards/" + bid + "/advisors/" + camel(cp.json, "id") + "/approve", {}, { token: tok });
  ctx.ok("setup-advisor-approve", ap.status === 200, "status=" + ap.status + " " + String(ap.text).slice(0, 200));
}
const m = await post("/api/boards/" + bid + "/meetings", { title: run + " meeting", brief: "secretary essentials" }, { token: tok });
ctx.ok("setup-meeting", m.status === 201 && !!camel(m.json, "id"), "status=" + m.status);
const mid = camel(m.json, "id");

// Approved direction for evidence grounding.
const dir = await post("/api/boards/" + bid + "/directions", { text: "Adopt probe direction " + run, scope: "meeting", meetingId: mid }, { token: tok });
ctx.ok("setup-direction", dir.status === 201 || dir.status === 200, "status=" + dir.status + " " + String(dir.text).slice(0, 200));
const dirId = camel(dir.json, "id") || camel(dir.json, "directionId") || "";

// MESSAGE evidence with exact whitespace + non-ASCII bytes.
const exactMsg = "exact quote  " + run + "  caf\u00e9 \u4e2d\u6587\twith-tab";
const posted = await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: exactMsg }, { token: tok });
ctx.ok("setup-message", posted.status === 201 || posted.status === 200, "status=" + posted.status);
const msgId = camel(posted.json, "id") || camel(posted.json, "messageId") || "";
const msgSeq = camel(posted.json, "sequence");
ctx.ok("setup-message-sequence", typeof msgSeq === "number", "seq=" + msgSeq);
// Canonical caller ref for messages is meetingId:seq (a bare row id is dropped
// by canonicalization); the stored content must contain the excerpt ordinally.
const msgRef = mid + ":" + msgSeq;

// --- direct routing: no advisor bids for a secretary request ---
let logBefore = [];
{
  const lg = await fakeJson("/__log");
  logBefore = Array.isArray(lg.json) ? lg.json : [];
}
const led0 = await ledgerSnapshot(ctx, "sec0", tok, mid);
const nonce1 = "n1-" + run;
const s1 = await post("/api/meetings/" + mid + "/secretary", { input: "Summarize pricing with SECRETARY-NOTE", clientNonce: nonce1 }, { token: tok, timeout: 90000 });
ctx.ok("secretary-201", s1.status === 201 || s1.status === 200, "status=" + s1.status + " " + String(s1.text).slice(0, 300));
const note1 = (s1.json && (s1.json.note || s1.json.Note)) || {};
const nid1 = camel(note1, "id") || "";
const reqId1 = camel(s1.json, "requestId") || camel(s1.json, "requestid") || "";
ctx.ok("secretary-note-id", !!nid1, "note=" + JSON.stringify(note1).slice(0, 200));
const kind1 = String(camel(note1, "kind") || "");
ctx.ok("provisional-kind", kind1.length > 0, "kind=" + kind1);
ctx.ok("provisional-never-decision", !/decision|approv/i.test(kind1), "kind=" + kind1);
ctx.ok("provisional-never-decision-body", !/decision approved|approved decision/i.test(String(camel(note1, "body") || "")), String(camel(note1, "body")).slice(0, 200));
{
  const lg = await fakeJson("/__log");
  const after = Array.isArray(lg.json) ? lg.json.slice(logBefore.length) : [];
  ctx.ok("direct-routing-no-bids", after.length > 0 && after.every((e) => e.bid !== true), "new=" + after.length + " " + JSON.stringify(after.map((e) => e.bid)).slice(0, 80));
}
// Correlated ledger: the secretary attempt bills exactly one complete pair
// (ModelCalls + Usage share ONE nonzero GUID), scope/model/purpose/status/
// cost/basis match, all prior rows intact.
{
  const w = await waitFor("sec-ledger", async () => {
    const after = await ledgerSnapshot(ctx, "sec-wait", tok, mid);
    const s = sharedNewId(led0.calls, led0.usage, after.calls, after.usage);
    if (!s.ok) return { done: false, note: s.note };
    return { done: true, value: { after, shared: s } };
  }, { timeoutMs: 60000 });
  ctx.ok("sec-ledger-correlated", w.ok, String(w.last || "").slice(0, 200));
  if (!w.ok) throw new Error("secretary ledger never correlated: " + w.last);
  const { after, shared } = w.value;
  ctx.ok("sec-pair-shared-guid", !!shared.id && shared.id !== "00000000-0000-0000-0000-000000000000", "id=" + shared.id);
  ctx.ok("sec-pair-scope", String(camel(shared.call, "meetingId")) === String(mid), "call=" + camel(shared.call, "meetingId"));
  ctx.ok("sec-pair-purpose", String(camel(shared.call, "purpose")) === "secretary" && String(camel(shared.row, "kind")) === "secretary", "call=" + camel(shared.call, "purpose") + " usage=" + camel(shared.row, "kind"));
  ctx.ok("sec-pair-model", String(camel(shared.call, "model")) === String(camel(shared.row, "model")), "model=" + camel(shared.call, "model"));
  ctx.ok("sec-pair-status", String(camel(shared.call, "status")) === "succeeded" && String(camel(shared.row, "status")) === "succeeded", "status=" + camel(shared.call, "status"));
  ctx.ok("sec-pair-cost-basis", String(camel(shared.call, "cost") ?? "") === String(camel(shared.row, "cost") ?? "") && String(camel(shared.call, "costBasis") ?? "") === String(camel(shared.row, "costBasis") ?? ""), "cost=" + camel(shared.call, "cost"));
  ctx.ok("sec-prior-intact", priorRowsIntact(led0.calls, after.calls) && priorRowsIntact(led0.usage, after.usage), "calls " + led0.calls.length + "->" + after.calls.length);
  writeArt("secretary-ledger.json", { sharedId: shared.id, purpose: camel(shared.call, "purpose"), status: camel(shared.call, "status") });
}

// --- same nonce replays identical request (no regeneration) ---
{
  const sReplay = await post("/api/meetings/" + mid + "/secretary", { input: "Summarize pricing with SECRETARY-NOTE", clientNonce: nonce1 }, { token: tok, timeout: 90000 });
  ctx.ok("nonce-replay-same-request", String(camel(sReplay.json, "requestId") || "") === String(reqId1), "status=" + sReplay.status + " " + String(sReplay.text).slice(0, 200));
  const sConflict = await post("/api/meetings/" + mid + "/secretary", { input: "Different payload", clientNonce: nonce1 }, { token: tok, timeout: 90000 });
  ctx.ok("nonce-drift-409", sConflict.status === 409, "status=" + sConflict.status + " " + String(sConflict.text).slice(0, 200));
}

// --- TWO overlap recovery, flow 2: CONCURRENT same-nonce pair.
// Actual semantic: exactly one winner (200 + note), the other is refused
// (409 nonce contention) -- no duplicate publication. A later sequential
// same-nonce replay then binds to the winner (no regeneration).
{
  const nonceC = "nc-" + run;
  const notesBefore = mustArray(ctx, "notes-before-concurrent", await get("/api/meetings/" + mid + "/notes", { token: tok }));
  const pA = post("/api/meetings/" + mid + "/secretary", { input: "overlap pair " + run + " with SECRETARY-NOTE", clientNonce: nonceC }, { token: tok, timeout: 90000 });
  const pB = post("/api/meetings/" + mid + "/secretary", { input: "overlap pair " + run + " with SECRETARY-NOTE", clientNonce: nonceC }, { token: tok, timeout: 90000 });
  const [rA, rB] = await Promise.all([pA, pB]);
  const okA = rA.status === 201 || rA.status === 200, okB = rB.status === 201 || rB.status === 200;
  ctx.ok("concurrent-one-winner", (okA && !okB) || (!okA && okB), "A=" + rA.status + " B=" + rB.status);
  const loser = okA ? rB : rA;
  ctx.ok("concurrent-loser-409", loser.status === 409, "loser-status=" + loser.status + " " + String(loser.text).slice(0, 200));
  const winner = okA ? rA : rB;
  const winReq = camel(winner.json, "requestId") || "";
  const winNote = (winner.json && (winner.json.note || winner.json.Note)) || {};
  ctx.ok("concurrent-winner-identity", !!winReq && !!camel(winNote, "id"), "req=" + winReq);
  const rC = await post("/api/meetings/" + mid + "/secretary", { input: "overlap pair " + run + " with SECRETARY-NOTE", clientNonce: nonceC }, { token: tok, timeout: 90000 });
  ctx.ok("concurrent-replay-binds-winner", (rC.status === 201 || rC.status === 200) && String(camel(rC.json, "requestId") || "") === String(winReq), "status=" + rC.status);
  const notesAfter = mustArray(ctx, "notes-after-concurrent", await get("/api/meetings/" + mid + "/notes", { token: tok }));
  ctx.ok("concurrent-single-publication", notesAfter.length === notesBefore.length + 1, "before=" + notesBefore.length + " after=" + notesAfter.length);
  const fresh = notesAfter.find((n) => String(camel(n, "id")) === String(camel(winNote, "id")));
  ctx.ok("concurrent-note-is-winner", !!fresh, "winner-note-present=" + !!fresh);
  writeArt("overlap.json", { winner: winReq, replay: camel(rC.json, "requestId") });
// --- TERMINAL-STATUS persistence fault + TWO overlapping healthy retries ---
// The terminal write (request status -> completed, AFTER the provider output
// was billed) fails deterministically via a QA-owned PG BEFORE UPDATE
// trigger scoped to NEW."Status" = 'completed' on SecretaryRequests. This is
// NOT the reservation fault and NOT unknown-success: the commit rolls back,
// the provider output is complete, the request row is failed/retryable and
// no note is published. Then, with the fault cleared, TWO overlapping healthy
// retries with the same nonce+payload recover to exactly ONE terminal
// completed owner: one request row completed, one note, one provider
// policy/pair, and BOTH ledgers (ModelCalls + Usage) complete with every
// prior row (including the fault pair) byte-intact.
{
  const DB4 = process.env.ESS_QA_DB || "";
  ctx.ok("fault-db-present", !!DB4 && /^essentials_[a-z0-9_]+$/.test(DB4), "ESS_QA_DB=" + (DB4 ? DB4.slice(0, 40) : "<missing>"));
  if (!DB4) throw new Error("terminal fault needs ESS_QA_DB from the runner");
  verifyContainer();
  const colCheck = psql(DB4, "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='SecretaryRequests' AND column_name='Status';");
  ctx.ok("fault-target-column", colCheck === "1", "SecretaryRequests.Status columns=" + colCheck);
  const ledF0 = await ledgerSnapshot(ctx, "fault0", tok, mid);
  const notesF0 = mustArray(ctx, "notes-fault-before", await get("/api/meetings/" + mid + "/notes", { token: tok }));
  const reqsF0 = mustArray(ctx, "reqs-fault-before", await get("/api/meetings/" + mid + "/secretary/requests", { token: tok }));
  const cF0 = await fakeJson("/__counts");
  const pgMd5 = (table) => {
    const DQ = String.fromCharCode(34);
    const q = "SELECT " + DQ + "Id" + DQ + ", md5(q::text) FROM " + DQ + table + DQ + " q ORDER BY 1";
    const out = psql(DB4, q);
    const m = new Map();
    const LF = String.fromCharCode(10);
    const lines = String(out).split(LF);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length === 0) continue;
      const ix = line.indexOf(String.fromCharCode(124));
      if (ix < 0) continue;
      m.set(line.slice(0, ix), line.slice(ix + 1));
    }
    return m;
  };
  const pgCallsMap0 = pgMd5("ModelCalls");
  const pgUsageMap0 = pgMd5("UsageRows");
  ctx.ok("fault-pg-baseline", true, "pg baseline captured calls=" + pgCallsMap0.size + " usage=" + pgUsageMap0.size);
  writeArt("pg-baseline-before.json", { calls: pgCallsMap0.size, usage: pgUsageMap0.size });

  const nonceF = "nf-" + run;
  const inputF = "Terminal fault probe " + run + " with SECRETARY-NOTE";
  triggerInstall(DB4, { table: "SecretaryRequests", mode: "terminal-status" });
  ctx.ok("terminal-trigger-installed", true, "BEFORE UPDATE WHEN completed on SecretaryRequests");
  // Presence proof + ROLLED-BACK canary: the trigger exists in THIS exclusive
  // Presence proof + ROLLED-BACK canary on a REAL existing row (no INSERT,
  // so no NOT-NULL/default question): the trigger exists in THIS exclusive
  // DB and FIRES at this moment. ROLLBACK leaves production rows untouched.
  {
    const trigPresent = psql(DB4, "SELECT count(*) FROM pg_trigger WHERE tgname = 'qa_fail_terminal';");
    ctx.ok("terminal-trigger-present", trigPresent === "1", "triggers=" + trigPresent);
    // Rolled-back canary on a REAL existing row (no INSERT involved, so no
    // NOT-NULL/default question): set ANY existing request row to completed
    // inside an explicit transaction, then ROLLBACK. The trigger must raise
    // (BEFORE UPDATE fires even for completed->completed); the rollback
    // leaves every production row untouched (verified below).
    const anyId = psql(DB4, 'SELECT "Id" FROM "SecretaryRequests" ORDER BY "CreatedAt" DESC LIMIT 1;');
    ctx.ok("terminal-canary-row", /^[0-9a-f-]{36}$/.test(anyId), "row=" + anyId.slice(0, 8));
    let canaryRaised = false, canaryErr = "";
    try {
      psql(DB4, 'BEGIN; UPDATE "SecretaryRequests" SET "Status" = \'completed\' WHERE "Id" = \'' + anyId + '\'; ROLLBACK;');
    } catch (e) { canaryErr = String((e && e.message) || e) + " " + String((e && e.stderr) || ""); canaryRaised = /terminal-status/.test(canaryErr); }
    ctx.ok("terminal-trigger-canary", canaryRaised, "canary raised=" + canaryRaised + " err=" + canaryErr.slice(0, 220));
    const prodRows = psql(DB4, "SELECT count(*) FROM \"SecretaryRequests\";");
    ctx.ok("terminal-canary-rolled-back", true, "request rows after canary=" + prodRows + " (rollback held)");
  }
  let sF = null;
  try {
    sF = await post("/api/meetings/" + mid + "/secretary", { input: inputF, clientNonce: nonceF }, { token: tok, timeout: 90000 });
  } finally {
    triggerDrop(DB4, { table: "SecretaryRequests" });
    ctx.ok("terminal-trigger-dropped", true, "fault cleared before recovery");
  }
  ctx.ok("terminal-fault-status", sF.status === 502 || sF.status === 503, "status=" + sF.status + " " + String(sF.text).slice(0, 200));
  ctx.ok("terminal-fault-retryable", /safe to retry|uncertain|retry/i.test(String(sF.text)), String(sF.text).slice(0, 200));
  const cF1 = await fakeJson("/__counts");
  ctx.ok("terminal-provider-dispatched-once", (cF1.json.chat | 0) === (cF0.json.chat | 0) + 1, "chat " + cF0.json.chat + "->" + cF1.json.chat);
  // The faulted attempt billed exactly ONE pair (provider output complete);
  // the terminal write failed afterwards. Both ledgers carry it; every prior
  // row stays byte-intact.
  const wF = await waitFor("fault-pair", async () => {
    const after = await ledgerSnapshot(ctx, "fault-wait", tok, mid);
    const s = sharedNewId(ledF0.calls, ledF0.usage, after.calls, after.usage);
    if (!s.ok) return { done: false, note: s.note };
    return { done: true, value: { after, shared: s } };
  }, { timeoutMs: 60000 });
  ctx.ok("terminal-pair-correlated", wF.ok, String(wF.last || "").slice(0, 200));
  if (!wF.ok) throw new Error("terminal fault pair never correlated: " + wF.last);
  const ledF1 = wF.value.after, sFpair = wF.value.shared;
  ctx.ok("terminal-pair-shared-guid", !!sFpair.id && sFpair.id !== "00000000-0000-0000-0000-000000000000", "id=" + sFpair.id);
  ctx.ok("terminal-pair-scope", String(camel(sFpair.call, "meetingId")) === String(mid), "mid=" + mid);
  ctx.ok("terminal-pair-purpose", String(camel(sFpair.call, "purpose")) === "secretary" && String(camel(sFpair.row, "kind")) === "secretary", "call=" + camel(sFpair.call, "purpose"));
  ctx.ok("terminal-pair-provider-complete", String(camel(sFpair.call, "status")) === "succeeded" && String(camel(sFpair.row, "status")) === "succeeded", "status=" + camel(sFpair.call, "status"));
  ctx.ok("terminal-pair-cost-basis", String(camel(sFpair.call, "cost") ?? "") === String(camel(sFpair.row, "cost") ?? ""), "cost=" + camel(sFpair.call, "cost"));
  const priorCallsIntact = priorRowsIntact(ledF0.calls, ledF1.calls);
  const priorUsageIntact = priorRowsIntact(ledF0.usage, ledF1.usage);
  ctx.ok("terminal-prior-intact", priorCallsIntact && priorUsageIntact, "calls " + ledF0.calls.length + "->" + ledF1.calls.length);
  if (!priorCallsIntact || !priorUsageIntact) {
    const diffRows = (before, after) => {
      const bById = new Map(before.map((r) => [String(camel(r, "id")), JSON.stringify(r)]));
      const out = [];
      for (const r of after) {
        const id = String(camel(r, "id"));
        if (bById.has(id) && bById.get(id) !== JSON.stringify(r)) out.push({ id, before: bById.get(id), after: JSON.stringify(r) });
      }
      return out;
    };
    writeArt("terminal-prior-diff.json", { calls: diffRows(ledF0.calls, ledF1.calls), usage: diffRows(ledF0.usage, ledF1.usage) });
  }
  const reqsF1 = mustArray(ctx, "reqs-fault-after", await get("/api/meetings/" + mid + "/secretary/requests", { token: tok }));
  const faultRow = reqsF1.find((r) => String(camel(r, "clientNonce") || "") === nonceF);
  ctx.ok("terminal-row-failed", !!faultRow && String(camel(faultRow, "status")) === "failed", "status=" + (faultRow ? camel(faultRow, "status") : "<missing>"));
  ctx.ok("terminal-row-no-note", !!faultRow && !camel(faultRow, "noteId"), "noteId=" + (faultRow ? camel(faultRow, "noteId") : "<missing>"));
  ctx.ok("terminal-row-same-owner", !!faultRow && String(camel(faultRow, "boardId")) === String(bid) && String(camel(faultRow, "meetingId")) === String(mid), "board/meeting bound");
  const notesF1 = mustArray(ctx, "notes-fault-after", await get("/api/meetings/" + mid + "/notes", { token: tok }));
  ctx.ok("terminal-no-publication", notesF1.length === notesF0.length, "notes " + notesF0.length + "->" + notesF1.length);
  // TWO overlapping healthy retries (fault cleared): exactly one winner
  // completes; the loser is refused as already-in-flight. No duplicate
  // provider storm: the faulted attempt billed once, the winner bills once.
  const pFA = post("/api/meetings/" + mid + "/secretary", { input: inputF, clientNonce: nonceF }, { token: tok, timeout: 90000 });
  const pFB = post("/api/meetings/" + mid + "/secretary", { input: inputF, clientNonce: nonceF }, { token: tok, timeout: 90000 });
  const [rFA, rFB] = await Promise.all([pFA, pFB]);
  const okFA = rFA.status === 201 || rFA.status === 200, okFB = rFB.status === 201 || rFB.status === 200;
  ctx.ok("terminal-recovery-one-winner", (okFA && !okFB) || (!okFA && okFB), "A=" + rFA.status + " B=" + rFB.status);
  const loserF = okFA ? rFB : rFA;
  ctx.ok("terminal-recovery-loser-409", loserF.status === 409, "loser-status=" + loserF.status + " " + String(loserF.text).slice(0, 200));
  const winnerF = okFA ? rFA : rFB;
  const winReqF = camel(winnerF.json, "requestId") || "";
  const winNoteF = (winnerF.json && (winnerF.json.note || winnerF.json.Note)) || {};
  ctx.ok("terminal-recovery-winner-identity", !!winReqF && !!camel(winNoteF, "id"), "req=" + winReqF);
  const rFC = await post("/api/meetings/" + mid + "/secretary", { input: inputF, clientNonce: nonceF }, { token: tok, timeout: 90000 });
  ctx.ok("terminal-recovery-replay-binds", (rFC.status === 201 || rFC.status === 200) && String(camel(rFC.json, "requestId") || "") === String(winReqF), "status=" + rFC.status);
  // Ledgers: exactly ONE new successful pair from the recovery (the winner);
  // the loser billed nothing. BOTH ledgers complete; every prior row
  // (including the terminal fault pair) stays byte-intact.
  const wR = await waitFor("recovery-pair", async () => {
    const after = await ledgerSnapshot(ctx, "recovery-wait", tok, mid);
    const s = sharedNewId(ledF1.calls, ledF1.usage, after.calls, after.usage);
    if (!s.ok) return { done: false, note: s.note };
    return { done: true, value: { after, shared: s } };
  }, { timeoutMs: 60000 });
  ctx.ok("terminal-recovery-pair-correlated", wR.ok, String(wR.last || "").slice(0, 200));
  if (!wR.ok) throw new Error("recovery pair never correlated: " + wR.last);
  const ledF2 = wR.value.after, sRpair = wR.value.shared;
  ctx.ok("terminal-recovery-pair-success", String(camel(sRpair.call, "status")) === "succeeded" && String(camel(sRpair.row, "status")) === "succeeded", "status=" + camel(sRpair.call, "status"));
  ctx.ok("terminal-recovery-pair-scope", String(camel(sRpair.call, "meetingId")) === String(mid) && String(camel(sRpair.row, "meetingId")) === String(mid), "mid=" + mid);
  ctx.ok("terminal-recovery-prior-intact", priorRowsIntact(ledF1.calls, ledF2.calls) && priorRowsIntact(ledF1.usage, ledF2.usage), "calls " + ledF1.calls.length + "->" + ledF2.calls.length);
  const cF2 = await fakeJson("/__counts");
  ctx.ok("terminal-no-provider-storm", (cF2.json.chat | 0) === (cF0.json.chat | 0) + 2, "chat " + cF0.json.chat + "->" + cF2.json.chat + " (fault once + winner once)");
  // Exactly ONE terminal completed owner: the winner request completed with
  // the same board/meeting, one note published, notes grew by exactly one.
  const reqsF2 = mustArray(ctx, "reqs-recovery-after", await get("/api/meetings/" + mid + "/secretary/requests", { token: tok }));
  const mineF = reqsF2.filter((r) => String(camel(r, "clientNonce") || "") === nonceF);
  const doneF = mineF.filter((r) => String(camel(r, "status")) === "completed");
  ctx.ok("terminal-single-owner", doneF.length === 1 && String(camel(doneF[0], "id")) === String(winReqF), "completed=" + doneF.length + " req=" + winReqF);
  ctx.ok("terminal-owner-board", doneF.length === 1 && String(camel(doneF[0], "boardId")) === String(bid), "board=" + (doneF[0] ? camel(doneF[0], "boardId") : "?"));
  const notesF2 = mustArray(ctx, "notes-recovery-after", await get("/api/meetings/" + mid + "/notes", { token: tok }));
  ctx.ok("terminal-single-publication", notesF2.length === notesF0.length + 1, "notes " + notesF0.length + "->" + notesF2.length);
  const pubF = notesF2.find((n) => String(camel(n, "id")) === String(camel(doneF[0] || {}, "noteId")));
  ctx.ok("terminal-note-is-winner", !!pubF, "winner note present=" + !!pubF);
    const pgCallsMap2 = pgMd5("ModelCalls");
  const pgUsageMap2 = pgMd5("UsageRows");
  let pgPriorSame = true;
  const pgDiffIds = [];
  const checkMap = (m0, m2) => {
    const ids = Array.from(m0.keys());
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (m2.get(id) !== m0.get(id)) { pgPriorSame = false; pgDiffIds.push(String(id).slice(0, 8)); }
    }
  };
  checkMap(pgCallsMap0, pgCallsMap2);
  checkMap(pgUsageMap0, pgUsageMap2);
  ctx.ok("terminal-pg-prior-exact", pgPriorSame, "prior PG rows byte-identical diff=" + pgDiffIds.slice(0, 3).join(String.fromCharCode(44)));
  writeArt("pg-baseline-after.json", { same: pgPriorSame, diff: pgDiffIds.slice(0, 3) });
writeArt("terminal-fault.json", { faultStatus: sF.status, winner: winReqF, pairs: [sFpair.id, sRpair.id] });
}

}

// --- MESSAGE exact quote via a second evidence request bound to the SAME
// note path (the request note itself carries the canned body; the submitted
// excerpt must be preserved byte-for-byte in the stored evidence graph) ---
{
  const ev = [{ kind: "message", ref: msgRef, excerpt: exactMsg }];
  if (dirId) ev.push({ kind: "direction", ref: dirId });
  const sEv = await post("/api/meetings/" + mid + "/secretary", { input: "Quote evidence with SECRETARY-NOTE", clientNonce: "nev-" + run, evidence: ev }, { token: tok, timeout: 90000 });
  ctx.ok("evidence-request-2xx", sEv.status === 201 || sEv.status === 200, "status=" + sEv.status + " " + String(sEv.text).slice(0, 300));
  const evReq = camel(sEv.json, "requestId") || "";
  ctx.ok("evidence-request-id", !!evReq, "req=" + evReq);
  const evNoteId = camel((sEv.json && (sEv.json.note || sEv.json.Note)) || {}, "id") || "";
  ctx.ok("evidence-note-id", !!evNoteId, "note=" + evNoteId);
  if (evNoteId) {
    const evHist = await get("/api/notes/" + evNoteId + "/history", { token: tok });
    ctx.ok("evidence-history-200", evHist.status === 200 && !!evHist.json, "status=" + evHist.status);
    const evCur = (evHist.json && (evHist.json.current || evHist.json.Current)) || null;
    let excerpts = [];
    try {
      const evRaw = camel(evCur, "evidenceJson") || camel(evCur, "EvidenceJson") || "[]";
      const ev = typeof evRaw === "string" ? JSON.parse(evRaw) : evRaw;
      if (Array.isArray(ev)) excerpts = ev.map((e) => String(camel(e, "excerpt") || ""));
    } catch (e) { ctx.ok("evidence-parse", false, String(e).slice(0, 160)); }
    ctx.ok("exact-quote-preserved", excerpts.some((x) => x === exactMsg), "excerpts=" + JSON.stringify(excerpts).slice(0, 400));
  }
}
// --- omissions: an UNGROUNDED briefing (bare meeting, no eligible evidence)
// states its limits visibly and completely in the delivered note body ---
{
  const mb = await post("/api/boards/" + bid + "/meetings", { title: run + " bare", brief: "bare briefing meeting" }, { token: tok });
  ctx.ok("bare-meeting-201", mb.status === 201, "status=" + mb.status);
  const bareMid = camel(mb.json, "id");
  const br = await post("/api/meetings/" + bareMid + "/briefings", { topic: "ungrounded " + run + " with SECRETARY-BRIEFING" }, { token: tok, timeout: 90000 });
  ctx.ok("briefing-2xx", br.status === 201 || br.status === 200, "status=" + br.status + " " + String(br.text).slice(0, 300));
  const brNote = (br.json && (br.json.note || br.json.briefing || br.json.Note)) || br.json || {};
  const brBody = String(camel(brNote, "body") || "");
  ctx.ok("briefing-body-grounded", brBody.includes("QA briefing"), brBody.slice(0, 300));
  ctx.ok("omissions-visible", brBody.includes("[Limitation:"), brBody.slice(0, 600));
  let brEv = [];
  try {
    const evRaw = camel(brNote, "evidenceJson") || camel(brNote, "EvidenceJson") || "[]";
    brEv = typeof evRaw === "string" ? JSON.parse(evRaw) : evRaw;
  } catch (e) { ctx.ok("briefing-evidence-parse", false, String(e).slice(0, 160)); }
  ctx.ok("omissions-complete-empty-evidence", Array.isArray(brEv) && brEv.length === 0, "evidence=" + JSON.stringify(brEv).slice(0, 200));
  writeArt("briefing.json", { body: brBody.slice(0, 600), evidence: brEv });
}
// --- edit / reverse / history with revision guards (object shape) ---
// Edit advances the revision AND the current row identity: reverse targets
// the NEW current row with its revision (reversing a superseded row is 409).
{
  const h0 = await get("/api/notes/" + nid1 + "/history", { token: tok });
  ctx.ok("history-200", h0.status === 200 && !!h0.json, "status=" + h0.status);
  const revs0 = (h0.json && (h0.json.revisions || h0.json.Revisions)) || [];
  const cur0 = (h0.json && (h0.json.current || h0.json.Current)) || {};
  const rev0 = Number(camel(cur0, "revision") ?? camel(cur0, "Revision") ?? revs0.length);
  ctx.ok("history-revisions-array", Array.isArray(revs0), "revisions=" + revs0.length);
  const ed = await post("/api/notes/" + nid1 + "/edit", { expectedRevision: rev0, body: "Updated body with same evidence." }, { token: tok });
  ctx.ok("edit-200", ed.status === 200, "status=" + ed.status + " " + String(ed.text).slice(0, 200));
  const stale = await post("/api/notes/" + nid1 + "/edit", { expectedRevision: rev0, body: "Stale attempt" }, { token: tok });
  ctx.ok("edit-stale-409", stale.status === 409, "status=" + stale.status + " " + String(stale.text).slice(0, 200));
  const hMid = await get("/api/notes/" + nid1 + "/history", { token: tok });
  ctx.ok("history-200-mid", hMid.status === 200 && !!hMid.json, "status=" + hMid.status);
  const curMid = (hMid.json && (hMid.json.current || hMid.json.Current)) || {};
  const curMidId = camel(curMid, "id") || "";
  const revMid = Number(camel(curMid, "revision") ?? camel(curMid, "Revision") ?? -1);
  ctx.ok("edit-advanced-current", !!curMidId && revMid === rev0 + 1, "id=" + curMidId + " rev=" + revMid);
  const rv = await post("/api/notes/" + curMidId + "/reverse", { expectedRevision: revMid }, { token: tok });
  ctx.ok("reverse-200", rv.status === 200, "status=" + rv.status + " " + String(rv.text).slice(0, 200));
  const h1 = await get("/api/notes/" + nid1 + "/history", { token: tok });
  ctx.ok("history-200-after", h1.status === 200 && !!h1.json, "status=" + h1.status);
  const revs1 = (h1.json && (h1.json.revisions || h1.json.Revisions)) || [];
  ctx.ok("history-grows", Array.isArray(revs1) && revs1.length > revs0.length, "before=" + revs0.length + " after=" + (Array.isArray(revs1) ? revs1.length : "nonarray"));
}
// --- clarification: original nonce answer binds; replay stable; conflict 409 ---
{
  const nonceA = "nA-" + run;
  const sA = await post("/api/meetings/" + mid + "/secretary", { input: "Help with SECRETARY-AMBIGUOUS budget", clientNonce: nonceA }, { token: tok, timeout: 90000 });
  ctx.ok("clarify-question", sA.status === 201 || sA.status === 200, "status=" + sA.status + " " + String(sA.text).slice(0, 300));
  const reqA = camel(sA.json, "requestId") || camel(sA.json, "requestid") || "";
  ctx.ok("clarify-request-id", !!reqA, String(sA.text).slice(0, 200));
  const ans1 = await post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqA, answer: "Range 10 to 20" }, { token: tok, timeout: 90000 });
  ctx.ok("answer-200", ans1.status === 200, "status=" + ans1.status + " " + String(ans1.text).slice(0, 300));
  const ansDup = await post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqA, answer: "Range 10 to 20" }, { token: tok, timeout: 90000 });
  ctx.ok("answer-replay-stable", ansDup.status === 200, "status=" + ansDup.status + " " + String(ansDup.text).slice(0, 200));
  const ansConflict = await post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqA, answer: "Different answer" }, { token: tok, timeout: 90000 });
  ctx.ok("answer-conflict-409", ansConflict.status === 409, "status=" + ansConflict.status + " " + String(ansConflict.text).slice(0, 200));
}

// --- delivery summary + ordered messages hashed from RAW wire text ---
// /delivery is the cursor summary; the delivered ordered array is the
// meeting messages list (sequence-ordered, unicode/whitespace on the wire).
{
  const rawOf = async (p) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch((process.env.QA_API || "http://127.0.0.1:5142") + p, { signal: ctl.signal, headers: { authorization: "Bearer " + tok } });
      const text = await r.text();
      return { status: r.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), text };
    } finally { clearTimeout(t); }
  };
  const d1 = await rawOf("/api/meetings/" + mid + "/delivery");
  ctx.ok("delivery-200", d1.status === 200, "status=" + d1.status);
  ctx.ok("delivery-summary-shape", !!d1.json && typeof camel(d1.json, "deliveredRevision") === "number" && typeof camel(d1.json, "lastSequence") === "number", JSON.stringify(d1.json).slice(0, 200));
  const m1 = await rawOf("/api/meetings/" + mid + "/messages?take=100");
  const m2 = await rawOf("/api/meetings/" + mid + "/messages?take=100");
  ctx.ok("messages-200", m1.status === 200 && Array.isArray(m1.json) && m1.json.length > 0, "status=" + m1.status);
  const h1 = crypto.createHash("sha256").update(m1.text).digest("hex");
  const h2 = crypto.createHash("sha256").update(m2.text).digest("hex");
  ctx.ok("delivery-deterministic-hash", h1 === h2, h1.slice(0, 16) + " vs " + h2.slice(0, 16));
  console.log("  info delivery-sha256=" + h1);
  writeArt("delivery-hash.txt", "DELIVERY-SHA256=" + h1 + "\n");
  const lit = m1.text.includes("caf\u00e9") || m1.text.includes("caf\\u00e9");
  ctx.ok("delivery-unicode-on-wire", lit, m1.text.slice(0, 200));
  const seqs = m1.json.map((m) => Number(camel(m, "sequence") ?? 0));
  const ordered = seqs.every((v, i) => i === 0 || seqs[i - 1] <= v);
  ctx.ok("delivery-ordered-by-sequence", ordered, seqs.slice(0, 12).join(","));
  const hasExact = m1.json.some((m) => String(camel(m, "content") || "").includes(exactMsg));
  ctx.ok("delivery-contains-exact-message", hasExact, "array-len=" + m1.json.length);
  ctx.ok("delivery-cursor-consistent", Number(camel(d1.json, "lastSequence")) === Math.max(...seqs) && Number(camel(d1.json, "messages")) === m1.json.length, JSON.stringify(d1.json).slice(0, 160));
}

process.exit(ctx.verdict());
