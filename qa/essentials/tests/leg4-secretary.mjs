// leg4: secretary assistant essentials on REAL handlers (needs API+fake+PG).
// Direct routing (no advisor bids), provisional never decision/approval,
// edit/reverse/history with revision guards, approved direction + MESSAGE
// exact-quote evidence, full omissions visibility, clarify nonce binding +
// replay + conflict, drift-409 on changed citation, ordered delivery hash
// from RAW wire text (no re-serialization), unicode/whitespace preserved.
// Exit nonzero on ANY failure. Secure-mode safe (Bearer everywhere).
import crypto from "node:crypto";
import { makeCtx, get, post, camel, mustArray, registerOrLogin, digest, fakeJson } from "../helpers/essentials-http.mjs";

const ctx = makeCtx("leg4");
const run = "ess4-" + Date.now().toString(36);
const tok = await registerOrLogin(ctx, post, run + "-sec@qa.local", "qa-sec-1");
ctx.ok("token-present", !!tok, "digest=" + digest(tok));

const b = await post("/api/boards", { name: run + "-board", mission: run + " mission", stage: "forming" }, { token: tok });
ctx.ok("setup-board", b.status === 201 && !!camel(b.json, "id"), "status=" + b.status);
const bid = camel(b.json, "id");
const lead = await post("/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Chief", background: "bg", familiarTopics: "fam", simplerTopics: "sim", commPrefs: "direct" }, { token: tok });
ctx.ok("setup-lead", lead.status === 200, "status=" + lead.status + " " + String(lead.text).slice(0, 160));
const q = await post("/api/roster/quick", { accountId: "00000000-0000-0000-0000-000000000000", name: run + "-adv", description: "advisor helping with " + run + " and strategy work for grounding" }, { token: tok });
ctx.ok("setup-advisor", q.status === 201, "status=" + q.status + " " + String(q.text).slice(0, 200));
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

// --- direct routing: no advisor bids for a secretary request ---
let logBefore = [];
{
  const lg = await fakeJson("/__log");
  logBefore = Array.isArray(lg.json) ? lg.json : [];
}
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

// --- same nonce replays identical request (no regeneration) ---
{
  const sReplay = await post("/api/meetings/" + mid + "/secretary", { input: "Summarize pricing with SECRETARY-NOTE", clientNonce: nonce1 }, { token: tok, timeout: 90000 });
  ctx.ok("nonce-replay-same-request", String(camel(sReplay.json, "requestId") || "") === String(reqId1), "status=" + sReplay.status + " " + String(sReplay.text).slice(0, 200));
  const sConflict = await post("/api/meetings/" + mid + "/secretary", { input: "Different payload", clientNonce: nonce1 }, { token: tok, timeout: 90000 });
  ctx.ok("nonce-drift-409", sConflict.status === 409, "status=" + sConflict.status + " " + String(sConflict.text).slice(0, 200));
}

// --- MESSAGE exact quote (whitespace + unicode preserved end to end) ---
{
  const ev = [{ kind: "message", ref: msgId, excerpt: exactMsg }];
  if (dirId) ev.push({ kind: "direction", ref: dirId });
  const sEv = await post("/api/meetings/" + mid + "/secretary", { input: "Quote evidence with SECRETARY-NOTE", clientNonce: "nev-" + run, evidence: ev }, { token: tok, timeout: 90000 });
  ctx.ok("evidence-request-2xx", sEv.status === 201 || sEv.status === 200, "status=" + sEv.status + " " + String(sEv.text).slice(0, 300));
  const evNote = (sEv.json && (sEv.json.note || sEv.json.Note)) || {};
  const evBody = String(camel(evNote, "body") || "");
  ctx.ok("exact-quote-preserved", evBody.includes(exactMsg), "body=" + evBody.slice(0, 300));
}

// --- omissions: ungrounded briefing states its limits visibly and completely ---
{
  const br = await post("/api/meetings/" + mid + "/briefings", { topic: "ungrounded " + run }, { token: tok, timeout: 90000 });
  ctx.ok("briefing-2xx", br.status === 201 || br.status === 200, "status=" + br.status + " " + String(br.text).slice(0, 200));
  const brBody = String(camel(br.json, "body") || camel((br.json && (br.json.note || br.json.briefing)) || {}, "body") || JSON.stringify(br.json)).slice(0, 4000);
  ctx.ok("omissions-visible", /limitation|no eligible|not available/i.test(brBody), brBody.slice(0, 300));
}

// --- edit / reverse / history with revision guards ---
{
  const h0 = mustArray(ctx, "history-before", await get("/api/notes/" + nid1 + "/history", { token: tok }));
  const rev0 = h0.length > 0 ? (camel(h0[h0.length - 1], "revision") ?? h0.length) : 0;
  const ed = await post("/api/notes/" + nid1 + "/edit", { expectedRevision: rev0, body: "Updated body with same evidence." }, { token: tok });
  ctx.ok("edit-200", ed.status === 200, "status=" + ed.status + " " + String(ed.text).slice(0, 200));
  const stale = await post("/api/notes/" + nid1 + "/edit", { expectedRevision: rev0, body: "Stale attempt" }, { token: tok });
  ctx.ok("edit-stale-409", stale.status === 409, "status=" + stale.status + " " + String(stale.text).slice(0, 200));
  const rv = await post("/api/notes/" + nid1 + "/reverse", {}, { token: tok });
  ctx.ok("reverse-200", rv.status === 200, "status=" + rv.status + " " + String(rv.text).slice(0, 200));
  const h1 = mustArray(ctx, "history-after", await get("/api/notes/" + nid1 + "/history", { token: tok }));
  ctx.ok("history-grows", h1.length > h0.length, "before=" + h0.length + " after=" + h1.length);
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

// --- ordered delivery hashed from RAW wire text (no re-serialization) ---
{
  const rawOf = async (p) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch((process.env.QA_API || "http://127.0.0.1:5142") + p, { signal: ctl.signal, headers: { authorization: "Bearer " + tok } });
      const text = await r.text();
      return { status: r.status, text };
    } finally { clearTimeout(t); }
  };
  const d1 = await rawOf("/api/meetings/" + mid + "/delivery");
  const d2 = await rawOf("/api/meetings/" + mid + "/delivery");
  ctx.ok("delivery-200", d1.status === 200, "status=" + d1.status);
  const h1 = crypto.createHash("sha256").update(d1.text).digest("hex");
  const h2 = crypto.createHash("sha256").update(d2.text).digest("hex");
  ctx.ok("delivery-deterministic-hash", h1 === h2, h1.slice(0, 16) + " vs " + h2.slice(0, 16));
  console.log("  info delivery-sha256=" + h1);
  const lit = d1.text.includes("caf\u00e9") || d1.text.includes("caf\\u00e9");
  ctx.ok("delivery-unicode-on-wire", lit, d1.text.slice(0, 200));
}

process.exit(ctx.verdict());