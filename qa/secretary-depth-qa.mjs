import crypto from "node:crypto";
import fs from "node:fs";
const API = process.env.QA_API || "http://127.0.0.1:5113";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:5205";
const OUT = process.env.QA_OUT || ".tmp/secretary-depth-qa-result.txt";
const EXPECT_MODE = (process.env.QA_EXPECT_MODE || "").toLowerCase();
fs.mkdirSync(".tmp", { recursive: true });
fs.writeFileSync(OUT, "START " + new Date().toISOString() + " API=" + API + "\n");
let pass = 0; let fail = 0; const failures = [];
function ok(name, cond, extra) { if (cond) { pass++; fs.appendFileSync(OUT, "PASS " + name + "\n"); } else { fail++; const m = name + (extra ? " :: " + extra : ""); failures.push(m); fs.appendFileSync(OUT, "FAIL " + m + "\n"); console.log("FAIL " + m); } }
async function req(method, path, body) { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25000); try { const r = await fetch(API + path, { method, signal: ctl.signal, headers: { "content-type": "application/json", "x-user": "owner" }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; } return { status: r.status, json, text }; } finally { clearTimeout(t); } }
const get = (p) => req("GET", p, undefined);
const post = (p, b) => req("POST", p, b);
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
const guid = () => crypto.randomUUID();
const run = "sec-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 100000).toString(36);
async function fakeCounts() { try { const r = await fetch(FAKE + "/__counts"); return await r.json(); } catch { return null; } }
async function fakeLogClear() { try { await fetch(FAKE + "/__log", { method: "DELETE" }); } catch { } }
async function fakeLog() { try { const r = await fetch(FAKE + "/__log"); return await r.json(); } catch { return []; } }
async function modelCalls() { const r = await get("/api/models/calls"); return Array.isArray(r.json) ? r.json.length : -1; }
async function usageRows(bid, mid) { const r = await get("/api/usage?boardId=" + bid + "&meetingId=" + mid); return Array.isArray(r.json) ? r.json.length : -1; }
async function makeBoard() { const r = await post("/api/boards", { name: run + "-board", mission: run + " mission", stage: "qa" }); ok("board-create", r.status === 201 && r.json && (r.json.id || r.json.Id), r.status + " " + r.text.slice(0, 200)); return (r.json.id || r.json.Id); }
async function setupBoard(bid) {
  const l = await post("/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Chief", background: "bg", familiarTopics: "fam", simplerTopics: "sim", commPrefs: "direct" });
  ok("lead-save", l.status === 200, l.status + " " + l.text.slice(0, 200));
  const q = await post("/api/roster/quick", { accountId: guid(), name: run + "-adv", description: "advisor helping with " + run + " and strategy work for grounding" });
  ok("roster-quick", q.status === 201, q.status + " " + q.text.slice(0, 300));
  const rid = q.json.id || (q.json.entry && q.json.entry.id);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const form = new FormData(); form.append("file", new Blob([png], { type: "image/png" }), "qa.png");
  const upRaw = await fetch(API + "/api/roster/" + rid + "/image/upload", { method: "POST", headers: { "x-user": "owner" }, body: form });
  const upText = await upRaw.text(); ok("portrait-upload", upRaw.status === 201, upRaw.status + " " + upText.slice(0, 200));
  const imgs = await req("GET", "/api/roster/" + rid + "/images", undefined);
  const imgId = (imgs.json && imgs.json[0] && (imgs.json[0].id || imgs.json[0].Id)) || null;
  ok("portrait-list", !!imgId, JSON.stringify(imgs.json).slice(0, 200));
  const rev = await post("/api/images/" + imgId + "/review", { decision: "accept" });
  ok("portrait-accept", rev.status === 200, rev.status + " " + rev.text.slice(0, 200));
  const cp = await post("/api/roster/" + rid + "/copy", { boardId: bid, boardRole: "Strategist" });
  ok("advisor-copy", cp.status === 201, cp.status + " " + cp.text.slice(0, 300));
  const aid = cp.json.id || cp.json.Id;
  const ap = await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
  ok("advisor-approve", ap.status === 200, ap.status + " " + ap.text.slice(0, 300));
  const m = await post("/api/boards/" + bid + "/meetings", { title: run + " meeting", brief: "qa brief about pricing" });
  ok("meeting-create", m.status === 201, m.status + " " + m.text.slice(0, 200));
  return { rid, aid, mid: (m.json.id || m.json.Id) };
}
async function uploadSource(bid, scope, meetingId, fname, content) { const fd = new FormData(); fd.append("file", new Blob([content], { type: "text/plain" }), fname); if (scope) fd.append("scope", scope); if (meetingId) fd.append("meetingId", meetingId); const r = await fetch(API + "/api/boards/" + bid + "/sources/upload", { method: "POST", headers: { "x-user": "owner" }, body: fd }); const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { } return { status: r.status, json, text }; }
async function main() {
  const hb = await get("/health"); ok("health", hb.status === 200, hb.status + " " + hb.text.slice(0, 120));
  const be = await get("/api/backend"); ok("backend-probe", be.status === 200 && be.json, be.text.slice(0, 200));
  const mode = String(be.json.mode || be.json.Mode || "").toLowerCase();
  ok("backend-mode-asserted", mode === "memory" || mode === "postgres" || mode === "pg", "mode=" + mode);
  if (EXPECT_MODE) ok("backend-mode-expected", mode.includes(EXPECT_MODE) || (EXPECT_MODE === "postgres" && mode === "pg"), "mode=" + mode + " expect=" + EXPECT_MODE);
  fs.appendFileSync(OUT, "MODE " + mode + "\n");
  const bid = await makeBoard(); const st = await setupBoard(bid); const mid = st.mid;
  const up1 = await uploadSource(bid, "board", null, "pricing.txt", "Approved pricing policy. Budget range 10 to 20. Discounts require approval. Section alpha text for grounding.");
  ok("source-upload-board", up1.status === 201, up1.status + " " + up1.text.slice(0, 300));
  const sid1 = up1.json.id || up1.json.Id;
  const ap1 = await post("/api/sources/" + sid1 + "/approve", {}); ok("source-approve-board", ap1.status === 200, ap1.status + " " + ap1.text.slice(0, 300));
  const secs1 = await get("/api/sources/" + sid1 + "/sections"); ok("source-sections", secs1.status === 200 && secs1.json && secs1.json.sections && secs1.json.sections.length > 0, secs1.text.slice(0, 300));
  const secId1 = secs1.json.sections[0].id || secs1.json.sections[0].Id;
  const secText1 = secs1.json.sections[0].text || secs1.json.sections[0].Text || "";
  const up2 = await uploadSource(bid, "meeting", mid, "secret.txt", "Meeting only secret plan. Do not cite board wide.");
  const sid2 = up2.json.id || up2.json.Id; const ap2 = await post("/api/sources/" + sid2 + "/approve", {}); ok("source-approve-meeting", ap2.status === 200, ap2.status + " " + ap2.text.slice(0, 200));
  const up3 = await uploadSource(bid, "board", null, "pending.txt", "Pending draft not yet approved.");
  const sid3 = up3.json.id || up3.json.Id; ok("source-pending-stays", up3.status === 201, up3.status + " " + up3.text.slice(0, 200));
  const dir = await post("/api/boards/" + bid + "/directions", { text: "Always disclose budget range before recommending.", scope: "meeting", meetingId: mid });
  ok("direction-adopt", dir.status === 201, dir.status + " " + dir.text.slice(0, 200));
  const dirId = dir.json.id || dir.json.Id;
  const draft = await post("/api/meetings/" + mid + "/record/draft", [{ id: "a1", text: "Approve budget 15" }]);
  ok("draft-create", draft.status === 201, draft.status + " " + draft.text.slice(0, 200));
  const draftId = draft.json.id || draft.json.Id; const dhash = draft.json.hash || draft.json.Hash; const wm = draft.json.watermark ?? draft.json.Watermark ?? 0;
  const appr = await post("/api/meetings/" + mid + "/record/approve", { draftId, hash: dhash, watermark: wm, itemIds: ["a1"] });
  ok("record-approve-a1", appr.status === 200, appr.status + " " + appr.text.slice(0, 300));
  const resm = await post("/api/meetings/" + mid + "/resume", {}); ok("meeting-resume", resm.status === 200, resm.status + " " + resm.text.slice(0, 200));
  await fakeLogClear();
  const c0 = await fakeCounts(); const mc0 = await modelCalls(); const u0 = await usageRows(bid, mid);
  const nonce1 = guid();
  const s1 = await post("/api/meetings/" + mid + "/secretary", { input: "Summarize pricing with SECRETARY-NOTE", clientNonce: nonce1 });
  ok("secretary-note-201", s1.status === 200 && s1.json && s1.json.note, s1.status + " " + s1.text.slice(0, 500));
  const note1 = s1.json.note; const nid1 = note1.id || note1.Id;
  const reqId1 = s1.json.requestId || s1.json.requestid;
  ok("secretary-provisional", (note1.provisional ?? note1.Provisional) === true, JSON.stringify(note1).slice(0, 300));
  ok("secretary-kind", (note1.kind || note1.Kind || "").indexOf("secretary") >= 0, JSON.stringify(note1).slice(0, 200));
  const evj = note1.evidenceJson || note1.EvidenceJson || "[]";
  ok("secretary-evidence-has-approved", evj.indexOf(sid1) >= 0, evj.slice(0, 800));
  ok("secretary-evidence-excludes-pending", evj.indexOf(sid3) < 0, evj.slice(0, 500));
  let evParsed = []; try { evParsed = JSON.parse(evj); } catch { }
  const srcRef = evParsed.find((e) => (e.kind || e.Kind) === "source" && String(e.ref || e.Ref) === String(sid1));
  ok("secretary-evidence-canonical-section", !!srcRef && !!(srcRef.sectionId || srcRef.SectionId) && !!(srcRef.excerpt || srcRef.Excerpt), JSON.stringify(srcRef).slice(0, 400));
  if (srcRef) { const ex = srcRef.excerpt || srcRef.Excerpt || ""; ok("secretary-excerpt-exact-substring", secText1.indexOf(ex) >= 0 || ex.length === 0, "excerpt=" + ex.slice(0, 120)); }
  const msgs1 = await get("/api/meetings/" + mid + "/messages?take=100");
  const leadCount1 = (msgs1.json || []).filter((m) => (m.sender || m.Sender) === "lead").length;
  ok("owner-input-once", leadCount1 === 1, "leadCount=" + leadCount1);
  const c1 = await fakeCounts(); const mc1 = await modelCalls(); const u1 = await usageRows(bid, mid);
  ok("usage-one-call", c1 && c0 && (c1.chat - c0.chat) === 1, JSON.stringify(c1) + " vs " + JSON.stringify(c0));
  ok("usage-ledger-one-call", (mc1 - mc0) === 1, "modelCalls " + mc0 + "->" + mc1);
  ok("usage-row-one-event", (u1 - u0) === 1, "usage " + u0 + "->" + u1);
  const lg1 = await fakeLog();
  const lastPrompt = (lg1 || []).filter((e) => !e.bid).slice(-1)[0];
  const ptxt = (lastPrompt && lastPrompt.prompt) || "";
  ok("packet-includes-approved-source", ptxt.indexOf("pricing.txt") >= 0, ptxt.slice(0, 300));
  ok("packet-includes-direction", ptxt.indexOf("Always disclose budget") >= 0, ptxt.slice(0, 300));
  ok("packet-includes-record", ptxt.indexOf("Approve budget 15") >= 0, ptxt.slice(0, 300));
  ok("packet-excludes-pending", ptxt.indexOf("pending.txt") < 0, ptxt.slice(0, 300));
  ok("prompt-budget", ptxt.length <= 32000 && ptxt.length > 500, "len=" + ptxt.length);
  const bids1 = (lg1 || []).filter((e) => e.bid);
  ok("bypass-bids", bids1.length === 0, "bids=" + bids1.length);
  const sReplay = await post("/api/meetings/" + mid + "/secretary", { input: "Summarize pricing with SECRETARY-NOTE", clientNonce: nonce1 });
  ok("replay-same-nonce", sReplay.status === 200 && (sReplay.json.replay === true), sReplay.status + " " + sReplay.text.slice(0, 300));
  ok("replay-same-note", String(sReplay.json.note.id || sReplay.json.note.Id) === String(nid1), JSON.stringify(sReplay.json.note).slice(0, 200));
  ok("replay-same-request", String(sReplay.json.requestId) === String(reqId1), sReplay.text.slice(0, 200));
  const cR = await fakeCounts(); ok("replay-no-provider-delta", (cR.chat - c1.chat) === 0, "chat delta=" + (cR.chat - c1.chat));
  const msgs2 = await get("/api/meetings/" + mid + "/messages?take=100");
  const leadCount2 = (msgs2.json || []).filter((m) => (m.sender || m.Sender) === "lead").length;
  ok("replay-no-dup-owner", leadCount2 === leadCount1, "leadCount2=" + leadCount2);
  const sConflict = await post("/api/meetings/" + mid + "/secretary", { input: "Different payload", clientNonce: nonce1 });
  ok("conflict-nonce-409", sConflict.status === 409, sConflict.status + " " + sConflict.text.slice(0, 200));
  const nonceEv = guid();
  const sEvBase = await post("/api/meetings/" + mid + "/secretary", { input: "Evidence identity with SECRETARY-NOTE", clientNonce: nonceEv, evidence: [{ kind: "source", ref: sid1 }] });
  ok("evidence-base-201", sEvBase.status === 200, sEvBase.status + " " + sEvBase.text.slice(0, 200));
  const sEvConflict = await post("/api/meetings/" + mid + "/secretary", { input: "Evidence identity with SECRETARY-NOTE", clientNonce: nonceEv, evidence: [{ kind: "source", ref: sid2 }] });
  ok("evidence-payload-conflict-409", sEvConflict.status === 409, sEvConflict.status + " " + sEvConflict.text.slice(0, 200));
  const cConc0 = await fakeCounts();
  const msgsConc0 = await get("/api/meetings/" + mid + "/messages?take=100");
  const leadConc0 = (msgsConc0.json || []).filter((m) => (m.sender || m.Sender) === "lead").length;
  const nonceC = guid();
  const payC = "Concurrent with SECRETARY-NOTE " + nonceC.slice(0, 8) + " QA-SLEEP:3000";
  const pConc1 = post("/api/meetings/" + mid + "/secretary", { input: payC, clientNonce: nonceC });
  pConc1.catch(() => {});
  let sawReserved = false; let barrierReq = null;
  for (let bi = 0; bi < 50; bi++) {
    await sleep(200);
    const rsb = await get("/api/meetings/" + mid + "/secretary/requests");
    barrierReq = (Array.isArray(rsb.json) ? rsb.json : []).find((r) => (r.clientNonce || r.ClientNonce) === nonceC);
    const bst = barrierReq ? (barrierReq.status || barrierReq.Status) : "";
    if (bst === "pending" || bst === "inflight" || bst === "answering") { sawReserved = true; break; }
    if (bst === "completed" || bst === "needs-clarification" || bst === "failed" || bst === "discarded") break;
  }
  ok("concurrent-barrier", sawReserved, "no inflight reservation observed");
  const cc2 = await post("/api/meetings/" + mid + "/secretary", { input: payC, clientNonce: nonceC });
  const cc1 = await pConc1;
  const ccStatuses = [cc1.status, cc2.status].sort().join(",");
  ok("concurrent-nonce-serialized", ccStatuses === "200,409", cc1.status + "/" + cc2.status);
  ok("concurrent-same-request", String(cc1.json.requestId || "") === String(cc2.json.requestId || "") || cc2.status === 409, JSON.stringify({ a: cc1.json.requestId, b: cc2.json.requestId }));
  const concNote = (cc1.status === 200 ? cc1.json.note : cc2.json.note) || {};
  ok("concurrent-other-409", cc2.status === 409, cc2.status + " " + cc2.text.slice(0, 200));
  const msgsConc1 = await get("/api/meetings/" + mid + "/messages?take=100");
  const leadConc1 = (msgsConc1.json || []).filter((m) => (m.sender || m.Sender) === "lead").length;
  ok("concurrent-owner-once", leadConc1 === leadConc0 + 1, leadConc0 + "->" + leadConc1);
  const cConc1 = await fakeCounts(); ok("concurrent-single-provider", (cConc1.chat - cConc0.chat) === 1, "delta=" + (cConc1.chat - cConc0.chat));
  const nonceA = guid();
  const mcA0 = await modelCalls();
  const sA = await post("/api/meetings/" + mid + "/secretary", { input: "Help with SECRETARY-AMBIGUOUS budget", clientNonce: nonceA });
  ok("ambiguous-one-question", sA.status === 200 && sA.json && sA.json.status === "needs-clarification" && sA.json.question, sA.status + " " + sA.text.slice(0, 400));
  const reqA = sA.json.requestId || sA.json.requestid || sA.json.requestID;
  ok("ambiguous-request-id", !!reqA, sA.text.slice(0, 200));
  const msgsAns0 = await get("/api/meetings/" + mid + "/messages?take=100");
  const leadAns0 = (msgsAns0.json || []).filter((m) => (m.sender || m.Sender) === "lead").length;
  const mcAns0 = await modelCalls();
  const pAns1 = post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqA, answer: "Range 10 to 20 QA-SLEEP:3000" });
  pAns1.catch(() => {});
  let sawAnswering = false;
  for (let ai = 0; ai < 50; ai++) {
    await sleep(200);
    const rsa = await get("/api/meetings/" + mid + "/secretary/requests");
    const arow = (Array.isArray(rsa.json) ? rsa.json : []).find((r) => String(r.id || r.Id) === String(reqA));
    if (arow && (arow.status || arow.Status) === "answering") { sawAnswering = true; break; }
    if (arow && ["completed", "failed", "discarded"].includes(arow.status || arow.Status)) break;
  }
  ok("answer-barrier", sawAnswering, "no answering reservation observed");
  const ans2 = await post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqA, answer: "Range 10 to 20 QA-SLEEP:3000" });
  const ans1 = await pAns1;
  const ansSorted = [ans1.status, ans2.status].sort().join(",");
  ok("answer-concurrent-serialized", ansSorted === "200,409", ansSorted + " " + ans1.text.slice(0, 160) + " / " + ans2.text.slice(0, 160));
  const ansOk = ans1.status === 200 ? ans1 : (ans2.status === 200 ? ans2 : null);
  ok("answer-continues", !!ansOk && ansOk.json && ansOk.json.note, (ansOk||{status:0,text:"none"}).status + " " + String((ansOk||{text:""}).text).slice(0,400));
  const ansNoteId = ansOk ? (ansOk.json.note.id || ansOk.json.note.Id) : "";
  const ansReqId = ansOk ? (ansOk.json.requestId || "") : "";
  ok("answer-same-request", !!ansOk && String(ansReqId) === String(reqA), String(ansReqId) + " vs " + String(reqA));
  const mcA1 = await modelCalls();
  ok("answer-single-provider", (mcA1 - mcAns0) === 1, "delta=" + (mcA1 - mcAns0) + " (mcA0=" + mcA0 + ")");
  const msgsAns1 = await get("/api/meetings/" + mid + "/messages?take=100");
  const leadAns1 = (msgsAns1.json || []).filter((m) => (m.sender || m.Sender) === "lead").length;
  ok("answer-owner-appended-once", leadAns1 === leadAns0 + 1, leadAns0 + "->" + leadAns1);
  const attBefore = await get("/api/meetings/" + mid + "/secretary/requests/" + reqA);
  const attIdBefore = attBefore.json && attBefore.json.request ? (attBefore.json.request.answerAttemptId || attBefore.json.request.AnswerAttemptId) : null;
  const chatBeforeDup = await fakeCounts();
  const usageBeforeDup = await usageRows(bid, mid);
  const callsBeforeDup = await modelCalls();
  const msgsBeforeDup = JSON.stringify((await get("/api/meetings/" + mid + "/messages?take=100")).json);
  const ansDup = await post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqA, answer: "Range 10 to 20 QA-SLEEP:3000" });
  const chatAfterDup = await fakeCounts();
  const usageAfterDup = await usageRows(bid, mid);
  const callsAfterDup = await modelCalls();
  const msgsAfterDup = JSON.stringify((await get("/api/meetings/" + mid + "/messages?take=100")).json);
  const attAfter = await get("/api/meetings/" + mid + "/secretary/requests/" + reqA);
  const attIdAfter = attAfter.json && attAfter.json.request ? (attAfter.json.request.answerAttemptId || attAfter.json.request.AnswerAttemptId) : null;
  ok("answer-idempotent", ansDup.status === 200 && String(ansDup.json.note.id || ansDup.json.note.Id) === String(ansNoteId) && (ansDup.json.replay === true || ansDup.json.status === "completed"), ansDup.status + " " + ansDup.text.slice(0, 300));
  ok("answer-replay-no-provider", (chatAfterDup.chat - chatBeforeDup.chat) === 0, "chat delta=" + (chatAfterDup.chat - chatBeforeDup.chat));
  ok("answer-replay-no-ledger", (usageAfterDup - usageBeforeDup) === 0 && (callsAfterDup - callsBeforeDup) === 0, "usage=" + (usageAfterDup - usageBeforeDup) + " calls=" + (callsAfterDup - callsBeforeDup));
  ok("answer-replay-no-message", msgsAfterDup === msgsBeforeDup, "messages changed on replay");
  ok("answer-replay-same-attempt", !!attIdBefore && String(attIdBefore) === String(attIdAfter), String(attIdBefore) + " vs " + String(attIdAfter));
  const ansConflict = await post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqA, answer: "Different answer" });
  ok("answer-conflict-409", ansConflict.status === 409, ansConflict.status + " " + ansConflict.text.slice(0,200));
  const ansCompletedDiff = await post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqA, answer: "Range 10 to 20 QA-SLEEP:3000 but different" });
  ok("answer-completed-conflict-409", ansCompletedDiff.status === 409, ansCompletedDiff.status + " " + ansCompletedDiff.text.slice(0,200));
  for (const tok of ["SECRETARY-NONSTRING-Q", "SECRETARY-DUP-BODY", "SECRETARY-NONSTRING-KIND"]) {
    const nn = guid();
    const rStrict = await post("/api/meetings/" + mid + "/secretary", { input: "Strict field check " + tok, clientNonce: nn });
    ok("strict-" + tok + "-502", rStrict.status === 502, rStrict.status + " " + rStrict.text.slice(0, 200));
    const rStrict2 = await post("/api/meetings/" + mid + "/secretary", { input: "Strict field check " + tok, clientNonce: nn });
    ok("strict-" + tok + "-retryable", rStrict2.status === 502, rStrict2.status + " " + rStrict2.text.slice(0, 200));
  }
  const nonceBad = guid();
  const sBad = await post("/api/meetings/" + mid + "/secretary", { input: "Help with SECRETARY-AMBIGUOUS budget-fail", clientNonce: nonceBad });
  ok("answerfail-ambiguous", sBad.status === 200 && sBad.json && sBad.json.status === "needs-clarification", sBad.status + " " + sBad.text.slice(0, 200));
  const reqBad = sBad.json.requestId;
  const msgsBad0 = await get("/api/meetings/" + mid + "/messages?take=100");
  const leadBad0 = (msgsBad0.json || []).filter((m) => (m.sender || m.Sender) === "lead").length;
  const ansBad = await post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqBad, answer: "answer with SECRETARY-BAD" });
  ok("answer-provider-fail-502", ansBad.status === 502, ansBad.status + " " + ansBad.text.slice(0, 200));
  const stBad = await get("/api/meetings/" + mid + "/secretary/requests/" + reqBad);
  ok("answer-fail-retryable", stBad.json && stBad.json.request && (stBad.json.request.status || stBad.json.request.Status) === "needs-clarification", stBad.text.slice(0, 200));
  const ansSameBad = await post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqBad, answer: "answer with SECRETARY-BAD" });
  ok("answer-retry-same-allowed", ansSameBad.status === 502, ansSameBad.status + " " + ansSameBad.text.slice(0, 200));
  const msgsBad1 = await get("/api/meetings/" + mid + "/messages?take=100");
  const leadBad1 = (msgsBad1.json || []).filter((m) => (m.sender || m.Sender) === "lead").length;
  ok("answer-retry-owner-once", leadBad1 === leadBad0 + 1, leadBad0 + "->" + leadBad1);
  const nonceD = guid();
  const sD = await post("/api/meetings/" + mid + "/secretary", { input: "Discard flow SECRETARY-AMBIGUOUS", clientNonce: nonceD });
  ok("answerdiscard-ambiguous", sD.status === 200 && sD.json && sD.json.status === "needs-clarification", sD.status + " " + sD.text.slice(0, 200));
  const reqD = sD.json.requestId;
  const msgsD0 = await get("/api/meetings/" + mid + "/messages?take=100");
  const leadD0 = (msgsD0.json || []).filter((m) => (m.sender || m.Sender) === "lead").length;
  const pD = post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqD, answer: "Range 10 to 20 QA-SLEEP:4000" });
  await sleep(800);
  await req("PATCH", "/api/meetings/" + mid, { brief: "changed brief during answer generation " + run });
  const rD = await pD;
  ok("answer-discard-409", rD.status === 409, rD.status + " " + rD.text.slice(0, 200));
  const stD = await get("/api/meetings/" + mid + "/secretary/requests/" + reqD);
  ok("answer-discard-retryable", stD.json && stD.json.request && ["discarded", "failed", "interrupted"].includes(stD.json.request.status || stD.json.request.Status), stD.text.slice(0, 200));
  const rD2 = await post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqD, answer: "Range 10 to 20 QA-SLEEP:4000" });
  ok("answer-discard-retry-completes", rD2.status === 200 && rD2.json && rD2.json.note, rD2.status + " " + rD2.text.slice(0, 300));
  const msgsD1 = await get("/api/meetings/" + mid + "/messages?take=100");
  const leadD1 = (msgsD1.json || []).filter((m) => (m.sender || m.Sender) === "lead").length;
  ok("answer-discard-owner-once", leadD1 === leadD0 + 1, leadD0 + "->" + leadD1);
  const nonceE = guid(); const rev0 = note1.revision ?? note1.Revision ?? 1;
  const ed = await post("/api/notes/" + nid1 + "/edit", { expectedRevision: rev0, body: "Updated body with same evidence." });
  ok("edit-new-revision", ed.status === 200 && ed.json && ((ed.json.revision ?? ed.json.Revision) === rev0 + 1), ed.status + " " + ed.text.slice(0, 400));
  const nid2 = ed.json.id || ed.json.Id;
  const stale = await post("/api/notes/" + nid1 + "/edit", { expectedRevision: rev0, body: "Stale attempt" });
  ok("stale-409", stale.status === 409, stale.status + " " + stale.text.slice(0, 200));
  const hist = await get("/api/notes/" + nid2 + "/history");
  ok("history-ordered", hist.status === 200 && hist.json && hist.json.revisions && hist.json.revisions.length >= 2 && hist.json.revisions[0].revision === 1 && hist.json.revisions[1].revision === 2, hist.status + " " + hist.text.slice(0, 500));
  ok("history-full-texts", hist.status === 200 && hist.text.indexOf("QA provisional note body") >= 0 && hist.text.indexOf("Updated body with same evidence.") >= 0, hist.text.slice(0,400));
  ok("history-current-pointer", hist.status === 200 && hist.json && hist.json.current && String(hist.json.current.id || hist.json.current.Id) === String(nid2), hist.text.slice(0,300));
  const revNew = ed.json.revision ?? ed.json.Revision;
  const rv = await post("/api/notes/" + nid2 + "/reverse", { expectedRevision: revNew });
  ok("reverse-keeps-text", rv.status === 200 && (rv.text.indexOf("Updated body") >= 0), rv.status + " " + rv.text.slice(0, 300));
  const hist2 = await get("/api/notes/" + nid2 + "/history");
  ok("history-has-reversed", hist2.status === 200 && hist2.text.indexOf("reversed") >= 0, hist2.text.slice(0, 400));
  const crossBid = await makeBoard(); const crossSt = await setupBoard(crossBid); const crossMid = crossSt.mid;
  const crossNote = await post("/api/meetings/" + crossMid + "/notes", { title: "cross", body: "cross board note", kind: "note" });
  ok("cross-note-create", crossNote.status === 201, crossNote.status + " " + crossNote.text.slice(0,200));
  const crossRoot = crossNote.json.rootId || crossNote.json.RootId || crossNote.json.id || crossNote.json.Id;
  const histCross = await get("/api/notes/" + nid2 + "/history");
  ok("history-scope-leak", histCross.status === 200 && histCross.text.indexOf(String(crossRoot)) < 0 && histCross.text.indexOf(String(crossNote.json.id || crossNote.json.Id)) < 0, histCross.text.slice(0,400));
  const spoofRoot = guid();
  const spN = await post("/api/meetings/" + mid + "/notes", { title: "spoof attempt", body: "spoof body text", kind: "note", rootId: spoofRoot, revision: 99, noteStatus: "current" });
  ok("spoof-root-ignored", spN.status === 201 && String(spN.json.rootId || spN.json.RootId) !== String(spoofRoot) && String(spN.json.rootId || spN.json.RootId) === String(spN.json.id || spN.json.Id) && ((spN.json.revision ?? spN.json.Revision)) === 1, spN.status + " " + spN.text.slice(0, 300));
  const spH = await get("/api/notes/" + (spN.json.id || spN.json.Id) + "/history");
  ok("spoof-history-scoped", spH.status === 200 && spH.text.indexOf("spoof body text") >= 0 && spH.text.indexOf(String(spoofRoot)) < 0, spH.status + " " + spH.text.slice(0, 300));
  const midB = (await post("/api/boards/" + bid + "/meetings", { title: run + " meeting-B", brief: "second meeting same board" })).json;
  const midBId = midB.id || midB.Id;
  await post("/api/meetings/" + midBId + "/resume", {});
  const sameDir = await post("/api/boards/" + bid + "/directions", { text: "Same-board other-meeting direction", scope: "meeting", meetingId: midBId });
  const sameDirId = sameDir.json.id || sameDir.json.Id;
  const draftB = await post("/api/meetings/" + midBId + "/record/draft", [{ id: "b1", text: "Other meeting record item" }]);
  const draftBId = draftB.json.id || draftB.json.Id;
  await post("/api/meetings/" + midBId + "/record/approve", { draftId: draftBId, hash: draftB.json.hash || draftB.json.Hash, watermark: draftB.json.watermark ?? draftB.json.Watermark ?? 0, itemIds: ["b1"] });
  const nonceW = guid();
  const sW = await post("/api/meetings/" + mid + "/secretary", { input: "Wrong scope with SECRETARY-NOTE", clientNonce: nonceW, evidence: [{ kind: "direction", ref: sameDirId }, { kind: "record", ref: draftBId }] });
  const sWj = JSON.stringify(sW.json.note || {});
  ok("wrong-direction-dropped", sW.status === 200 && sWj.indexOf(String(sameDirId)) < 0, sW.status + " " + sW.text.slice(0,400));
  ok("wrong-record-dropped", sW.status === 200 && sWj.indexOf(String(draftBId)) < 0 && sWj.indexOf("Other meeting record item") < 0, sW.status + " " + sW.text.slice(0, 400));
  const wrongDir = await post("/api/boards/" + crossBid + "/directions", { text: "Other meeting direction", scope: "meeting", meetingId: crossMid });
  const wrongDirId = wrongDir.json.id || wrongDir.json.Id;
  const nonceW2 = guid();
  const sW2 = await post("/api/meetings/" + mid + "/secretary", { input: "Wrong board scope with SECRETARY-NOTE", clientNonce: nonceW2, evidence: [{ kind: "direction", ref: wrongDirId }] });
  ok("wrong-board-direction-dropped", sW2.status === 200 && JSON.stringify(sW2.json.note).indexOf(String(wrongDirId)) < 0, sW2.status + " " + sW2.text.slice(0,400));
  const nonceF = guid();
  const forged = await post("/api/meetings/" + mid + "/secretary", { input: "Cite forged with SECRETARY-NOTE", clientNonce: nonceF, evidence: [{ kind: "source", ref: sid1, excerpt: "forged quote not in sections xyz123" }] });
  ok("forged-ignored", forged.status === 200 && forged.json && forged.json.note, forged.status + " " + forged.text.slice(0, 400));
  const fevj = JSON.stringify(forged.json.note);
  ok("forged-canonicalized", fevj.indexOf("forged quote not in sections xyz123") < 0 && fevj.indexOf(sid1) >= 0, fevj.slice(0, 500));
  const bid2 = await makeBoard(); const st2 = await setupBoard(bid2); const mid2 = st2.mid;
  const nonceN = guid();
  const sN = await post("/api/meetings/" + mid2 + "/secretary", { input: "Summarize with SECRETARY-NOTE but no sources", clientNonce: nonceN });
  ok("no-evidence-limitation", sN.status === 200 && sN.json && sN.json.note && JSON.stringify(sN.json.note).indexOf("Limitation") >= 0, sN.status + " " + sN.text.slice(0, 400));
  for (const tok of ["SECRETARY-PLAIN","SECRETARY-FENCED","SECRETARY-ARRAY","SECRETARY-UNKNOWN","SECRETARY-CONTRADICTORY"]) {
    const n = guid();
    const r = await post("/api/meetings/" + mid + "/secretary", { input: "Fail " + tok, clientNonce: n });
    ok("strict-" + tok + "-502", r.status === 502, r.status + " " + r.text.slice(0,300));
    const r2 = await post("/api/meetings/" + mid + "/secretary", { input: "Fail " + tok, clientNonce: n });
    ok("strict-" + tok + "-retry-502", r2.status === 502, r2.status + " " + r2.text.slice(0,200));
  }
  const nonceB = guid();
  const sB = await post("/api/meetings/" + mid + "/secretary", { input: "Fail with SECRETARY-BAD", clientNonce: nonceB });
  ok("malformed-502", sB.status === 502, sB.status + " " + sB.text.slice(0, 300));
  const sB2 = await post("/api/meetings/" + mid + "/secretary", { input: "Fail with SECRETARY-BAD", clientNonce: nonceB });
  ok("failed-retryable", sB2.status === 502, sB2.status + " " + sB2.text.slice(0, 200));
  const notes = await get("/api/meetings/" + mid + "/notes");
  ok("notes-list", notes.status === 200 && Array.isArray(notes.json), notes.status + " " + notes.text.slice(0, 200));
  const kinds = (notes.json || []).map((n) => n.kind || n.Kind);
  ok("notes-distinguish", kinds.includes("secretary-note"), kinds.join(","));
  ok("notes-no-operational", !(notes.text.includes("run-outcome") || notes.text.includes("run-cap")), notes.text.slice(0,300));
  ok("notes-current-only", (notes.json || []).every((n) => (n.noteStatus || n.NoteStatus || "current") === "current"), JSON.stringify((notes.json||[]).map((n)=>n.noteStatus||n.NoteStatus)).slice(0,200));
  const dirNote = await post("/api/boards/" + bid + "/directions", { text: "Second direction", scope: "meeting", meetingId: mid });
  const dirId2 = dirNote.json.id || dirNote.json.Id;
  const dirEdit = await post("/api/notes/" + dirId2 + "/edit", { expectedRevision: 1, body: "hacked" });
  ok("direction-not-editable", dirEdit.status === 422, dirEdit.status + " " + dirEdit.text.slice(0, 200));
  for (const [inp, expect] of [["Secretary: hello"," hello"],["secretary, hello"," hello"],["  SECRETARY:  spaced","  spaced"],["Secretary:\nhello\nworld","\nhello\nworld"],["Secretary: Secretary: double"," Secretary: double"]]) {
    const nn = guid();
    const rr = await post("/api/meetings/" + mid + "/secretary", { input: inp + " SECRETARY-NOTE", clientNonce: nn });
    ok("prefix-preserve-" + JSON.stringify(inp).slice(0,20), rr.status === 200 && rr.json && rr.json.note && String(rr.json.note.title || rr.json.note.Title || "").toLowerCase().indexOf("secretary") >= 0 && !!(rr.json.requestId), rr.status + " " + rr.text.slice(0,300));
    if (rr.status === 200) {
      const rq = await get("/api/meetings/" + mid + "/secretary/requests/" + (rr.json.requestId));
      const stored = rq.json && (rq.json.request ? (rq.json.request.inputText || rq.json.request.InputText) : "");
      const storedReq = rq.status === 200 && rq.json && rq.json.request ? String(rq.json.request.id || rq.json.request.Id) : "";
      ok("prefix-exact-" + JSON.stringify(inp).slice(0,20), stored === expect + " SECRETARY-NOTE" && storedReq === String(rr.json.requestId), JSON.stringify(stored).slice(0,200) + " req=" + storedReq);
    }
  }
  const bk = await get("/api/backup");
  ok("backup-200", bk.status === 200 && bk.json && bk.json.snapshot, bk.status + " " + bk.text.slice(0,200));
  const snap = JSON.parse(bk.json.snapshot);
  ok("backup-version-3", snap.version === 3, "version=" + snap.version);
  ok("backup-has-secretary", Array.isArray(snap.secretaryRequests) && Array.isArray(snap.noteHistories) && snap.secretaryRequests.length > 0 && snap.noteHistories.length > 0, "sr=" + (snap.secretaryRequests||[]).length + " nh=" + (snap.noteHistories||[]).length);
  const notesBefore = (await get("/api/meetings/" + mid + "/notes")).json.length;
  const graphBefore = async () => {
    const nn = await get("/api/meetings/" + mid + "/notes");
    const rr = await get("/api/meetings/" + mid + "/secretary/requests");
    const noteIds = (Array.isArray(nn.json) ? nn.json : []).map((n) => String(n.id || n.Id)).sort();
    const reqIds = (Array.isArray(rr.json) ? rr.json : []).map((r) => String(r.id || r.Id)).sort();
    const bodies = (Array.isArray(nn.json) ? nn.json : []).map((n) => String(n.id || n.Id) + "=" + String(n.body || n.Body)).sort();
    return { noteIds, reqIds, bodies, noteCount: noteIds.length };
  };
  const g0 = await graphBefore();
  const badSnap = JSON.parse(bk.json.snapshot); badSnap.noteHistories = [{ id: guid(), rootId: guid(), noteId: guid(), revision: 1, title: "bad", body: "bad", evidenceJson: "[]", action: "created" }];
  const badJson = JSON.stringify(badSnap);
  const { createHash: ch2 } = await import("node:crypto");
  const badHashCorrect = ch2("sha256").update(badJson).digest("hex");
  const badR = await post("/api/backup/restore", { snapshot: badJson, hash: badHashCorrect });
  ok("backup-invalid-lineage-rejected", badR.status === 422 && (badR.text.indexOf("lineage") >= 0 || badR.text.indexOf("scope") >= 0 || badR.text.indexOf("missing") >= 0), badR.status + " " + badR.text.slice(0,300));
  const gBad = await graphBefore();
  ok("backup-rollback-preserved", JSON.stringify(gBad) === JSON.stringify(g0), "graph changed by rejected restore");
  const okR = await post("/api/backup/restore", { snapshot: bk.json.snapshot, hash: bk.json.hash });
  ok("backup-roundtrip", okR.status === 200, okR.status + " " + okR.text.slice(0,200));
  const g1 = await graphBefore();
  ok("backup-roundtrip-preserved", JSON.stringify(g1) === JSON.stringify(g0), "graph changed by valid restore");
  const brTopic = await post("/api/meetings/" + mid + "/briefings", { topic: "pricing risks SECRETARY-BRIEFING" });
  ok("briefing-grounded-201", brTopic.status === 201 && brTopic.json && (brTopic.json.kind || brTopic.json.Kind || "").indexOf("briefing") >= 0, brTopic.status + " " + brTopic.text.slice(0,400));
  const brEv = brTopic.json.evidenceJson || brTopic.json.EvidenceJson || "[]";
  ok("briefing-evidence-grounded", brEv.indexOf(sid1) >= 0, brEv.slice(0,500));
  const msgsBefore = await get("/api/meetings/" + mid + "/messages?take=100");
  const leadBefore = (msgsBefore.json || []).filter((m) => (m.sender || m.Sender) === "lead").length;
  const advBefore = (msgsBefore.json || []).filter((m) => (m.sender || m.Sender) !== "lead").length;
  await fakeLogClear();
  const runP = post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "Discuss pricing QA-SLEEP:4000" });
  let draftSeen = false;
  for (let i = 0; i < 50; i++) { await sleep(200); const lg = await fakeLog(); if ((lg || []).some((e) => e.draft)) { draftSeen = true; break; } }
  ok("interrupt-draft-latch", draftSeen, "no draft observed");
  const nonceI = guid();
  const sI = await post("/api/meetings/" + mid + "/secretary", { input: "Interrupt with SECRETARY-NOTE", clientNonce: nonceI });
  ok("interrupt-secretary-ok", sI.status === 200 && sI.json && sI.json.note, sI.status + " " + sI.text.slice(0, 300));
  const runR = await runP;
  ok("interrupt-run-409", runR.status === 409, runR.status + " " + runR.text.slice(0, 300));
  const msgsAfter = await get("/api/meetings/" + mid + "/messages?take=100");
  const advisorNew = (msgsAfter.json || []).filter((m) => (m.sender || m.Sender) !== "lead").length - advBefore;
  const leadAfter = (msgsAfter.json || []).filter((m) => (m.sender || m.Sender) === "lead").length;
  ok("interrupt-no-new-advisor", advisorNew === 0 && runR.status === 409, "advisorNew=" + advisorNew);
  ok("interrupt-owner-appended", leadAfter === leadBefore + 1, "lead " + leadBefore + "->" + leadAfter);
  const advBeforeMsgs = (msgsBefore.json || []).filter((m) => (m.sender || m.Sender) !== "lead");
  const advAfterMsgs = (msgsAfter.json || []).filter((m) => (m.sender || m.Sender) !== "lead");
  ok("interrupt-history-bytes", JSON.stringify(advBeforeMsgs) === JSON.stringify(advAfterMsgs), "pre-existing advisor history changed");
  const resm2 = await post("/api/meetings/" + mid + "/resume", {});
  ok("resume-after-interrupt", resm2.status === 200, resm2.status + " " + resm2.text.slice(0, 200));
  const isPg = mode === "postgres" || mode === "pg";
  const { execSync: qaExecSync, spawn: qaSpawn } = await import("node:child_process");
  async function qaHealth(timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { const r = await fetch(API + "/health"); if (r.status === 200) return true; } catch { }
      await sleep(1000);
    }
    return false;
  }
  async function qaTriggerTool(arg) {
    const dll = "qa/StorageFaultTrigger/bin/Debug/net10.0/StorageFaultTrigger.dll";
    const cs = process.env.PGCS || "Host=127.0.0.1;Port=15440;Database=simceo;Username=simceo;Password=simceo-dev-only";
    return new Promise((resolve) => {
      const p = qaSpawn("dotnet", [dll, arg], { env: { ...process.env, PGCS: cs } });
      let out = "", err = "";
      p.stdout.on("data", (d) => { out += d; });
      p.stderr.on("data", (d) => { err += d; });
      p.on("close", (code) => resolve({ code, out, err }));
    });
  }
  if (isPg) {
    for (const trig of ["install-write-fail", "install-commit-fail"]) {
      const inst = await qaTriggerTool(trig);
      ok("fault-trigger-" + trig, inst.code === 0 && inst.out.indexOf("installed") >= 0, JSON.stringify(inst).slice(0, 200));
      const notesF0 = (await get("/api/meetings/" + mid + "/notes")).json.length;
      const nonceF = guid();
      const rF = await post("/api/meetings/" + mid + "/secretary", { input: "Fault probe with SECRETARY-NOTE", clientNonce: nonceF });
      ok("fault-" + trig + "-502", rF.status === 502, rF.status + " " + rF.text.slice(0, 200));
      const stF = await get("/api/meetings/" + mid + "/secretary/requests");
      const rowF = (Array.isArray(stF.json) ? stF.json : []).find((r) => (r.clientNonce || r.ClientNonce) === nonceF);
      ok("fault-" + trig + "-recoverable", !!rowF && ["failed", "discarded", "interrupted"].includes(rowF.status || rowF.Status), JSON.stringify(rowF && (rowF.status || rowF.Status)));
      const notesF1 = (await get("/api/meetings/" + mid + "/notes")).json.length;
      ok("fault-" + trig + "-rollback", notesF1 === notesF0, notesF0 + "->" + notesF1);
      const drop = await qaTriggerTool("drop");
      ok("fault-trigger-drop-" + trig, drop.code === 0, JSON.stringify(drop).slice(0, 200));
      const rR = await post("/api/meetings/" + mid + "/secretary", { input: "Fault probe with SECRETARY-NOTE", clientNonce: nonceF });
      ok("fault-" + trig + "-retry-200", rR.status === 200 && rR.json && rR.json.note, rR.status + " " + rR.text.slice(0, 300));
    }
  } else {
    ok("fault-pg-only-documented", mode === "memory", "mode=" + mode);
  }
  {
    const legacy = JSON.parse(bk.json.snapshot);
    delete legacy.secretaryRequests; delete legacy.noteHistories; delete legacy.sections; delete legacy.heads; delete legacy.events; delete legacy.wizardDrafts;
    legacy.version = 1;
    const legacyJson = JSON.stringify(legacy);
    const { createHash: chL } = await import("node:crypto");
    const legacyHash = chL("sha256").update(legacyJson).digest("hex");
    const legR = await post("/api/backup/restore", { snapshot: legacyJson, hash: legacyHash });
    ok("legacy-restore-200", legR.status === 200, legR.status + " " + legR.text.slice(0, 200));
    const legNonce = guid();
    const legS = await post("/api/meetings/" + mid + "/secretary", { input: "After legacy restore SECRETARY-NOTE", clientNonce: legNonce });
    ok("legacy-secretary-works", legS.status === 200 && legS.json && legS.json.note, legS.status + " " + legS.text.slice(0, 200));
    await post("/api/backup/restore", { snapshot: bk.json.snapshot, hash: bk.json.hash });
  }
  {
    const getS = async (pp) => { try { return await get(pp); } catch (e) { return { status: 0, json: null, text: "FETCH-FAIL " + String(e).slice(0, 160) }; } };
    const postS = async (pp, b) => { try { return await post(pp, b); } catch (e) { return { status: 0, json: null, text: "FETCH-FAIL " + String(e).slice(0, 160) }; } };
    let curPid = Number(process.env.QA_API_PID || "0");
    const apiPid = curPid;
    const resolveApiPid = () => {
      try {
        const l = qaExecSync("powershell -NoProfile -Command \"Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq 5113 } | Select-Object -ExpandProperty OwningProcess\"").toString().trim();
        const pp = parseInt(l.split(/\s+/)[0], 10);
        return isNaN(pp) ? 0 : pp;
      } catch { return 0; }
    };
    const apiCmd = process.env.QA_API_CMD || "C:\\Program Files\\dotnet\\dotnet.exe";
    let apiArgs = [];
    try { apiArgs = JSON.parse(process.env.QA_API_ARGS || "[]"); } catch { apiArgs = []; }
    let apiEnv = {};
    try { apiEnv = JSON.parse(process.env.QA_API_ENV_JSON || "{}"); } catch { apiEnv = {}; }
    ok("restart-harness-ready", apiPid > 0 && !!apiCmd && Array.isArray(apiArgs) && apiArgs.length > 0, "pid=" + apiPid + " cmd=" + apiCmd);
    if (apiPid > 0 && apiCmd) {
      const killAndRespawn = async () => {
        try {
          const target = resolveApiPid() || curPid;
          fs.appendFileSync(OUT, "RESTART kill pid=" + target + " (env pid=" + apiPid + ")\n");
          qaExecSync("taskkill /F /PID " + target);
          curPid = 0;
        } catch (e) { fs.appendFileSync(OUT, "RESTART taskkill note: " + String(e).slice(0, 160) + "\n"); }
        for (let wi = 0; wi < 60 && await qaHealth(1000); wi++) { await sleep(500); }
        try {
          const child = qaSpawn(apiCmd, apiArgs, { detached: true, stdio: "ignore", env: { ...process.env, ...apiEnv } });
          child.on("error", (e) => { try { fs.appendFileSync(OUT, "RESTART spawn error: " + String(e).slice(0, 200) + "\n"); } catch { } });
          child.unref();
          fs.appendFileSync(OUT, "RESTART spawned pid=" + child.pid + "\n");
          curPid = child.pid;
        } catch (e) { fs.appendFileSync(OUT, "RESTART spawn throw: " + String(e).slice(0, 200) + "\n"); return false; }
        const up = await qaHealth(90000);
        fs.appendFileSync(OUT, "RESTART health=" + up + "\n");
        try {
          const lst = qaExecSync("powershell -NoProfile -Command \"Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq 5113 } | Select-Object -ExpandProperty OwningProcess\"").toString().trim();
          fs.appendFileSync(OUT, "RESTART listener=" + lst.slice(0, 120) + "\n");
        } catch (e) { fs.appendFileSync(OUT, "RESTART listener probe failed\n"); }
        return up;
      };
      if (isPg) {
        const nonceR = guid();
        const pR = post("/api/meetings/" + mid + "/secretary", { input: "Restart initial SECRETARY-NOTE QA-SLEEP:8000", clientNonce: nonceR });
        pR.catch(() => {});
        await sleep(1500);
        const up = await killAndRespawn();
        ok("restart-initial-up", up, "api did not return");
        const stR = await getS("/api/meetings/" + mid + "/secretary/requests");
        const rowR = (Array.isArray(stR.json) ? stR.json : []).find((r) => (r.clientNonce || r.ClientNonce) === nonceR);
        ok("restart-initial-interrupted", !!rowR && (rowR.status || rowR.Status) === "interrupted", JSON.stringify(rowR && (rowR.status || rowR.Status)));
        const leadR0 = (await getS("/api/meetings/" + mid + "/messages?take=100")).json.filter((m) => (m.sender || m.Sender) === "lead").length;
        const rRetry = await postS("/api/meetings/" + mid + "/secretary", { input: "Restart initial SECRETARY-NOTE QA-SLEEP:8000", clientNonce: nonceR });
        ok("restart-initial-retry", rRetry.status === 200 && rRetry.json && rRetry.json.note, rRetry.status + " " + rRetry.text.slice(0, 300));
        const leadR1 = (await getS("/api/meetings/" + mid + "/messages?take=100")).json.filter((m) => (m.sender || m.Sender) === "lead").length;
        ok("restart-initial-owner-once", leadR1 === leadR0, leadR0 + "->" + leadR1);
        const rDup = await postS("/api/meetings/" + mid + "/secretary", { input: "Restart initial SECRETARY-NOTE QA-SLEEP:8000", clientNonce: nonceR });
        ok("restart-initial-replay", rDup.status === 200 && String((rDup.json.note.id || rDup.json.note.Id)) === String(rRetry.json.note.id || rRetry.json.note.Id), rDup.status + " " + rDup.text.slice(0, 200));
        try { await pR; } catch { }
        const nonceAR = guid();
        const sAR = await postS("/api/meetings/" + mid + "/secretary", { input: "Restart answer SECRETARY-AMBIGUOUS", clientNonce: nonceAR });
        ok("restart-answer-ambiguous", sAR.status === 200 && sAR.json && sAR.json.status === "needs-clarification", sAR.status + " " + sAR.text.slice(0, 200));
        const reqAR = sAR.json.requestId;
        const pAR = post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqAR, answer: "Restart answer QA-SLEEP:8000" });
        pAR.catch(() => {});
        await sleep(1500);
        const up2 = await killAndRespawn();
        ok("restart-answer-up", up2, "api did not return");
        const stAR = await getS("/api/meetings/" + mid + "/secretary/requests/" + reqAR);
        const rowAR = stAR.json && stAR.json.request;
        ok("restart-answer-interrupted", !!rowAR && (rowAR.status || rowAR.Status) === "interrupted" && !!(rowAR.question || rowAR.Question), JSON.stringify(rowAR && { s: rowAR.status || rowAR.Status, q: !!(rowAR.question || rowAR.Question), ph: rowAR.phase || rowAR.Phase }));
        const leadAR0 = (await getS("/api/meetings/" + mid + "/messages?take=100")).json.filter((m) => (m.sender || m.Sender) === "lead").length;
        const rARetry = await postS("/api/meetings/" + mid + "/secretary/answer", { requestId: reqAR, answer: "Restart answer QA-SLEEP:8000" });
        ok("restart-answer-retry", rARetry.status === 200 && rARetry.json && rARetry.json.note, rARetry.status + " " + rARetry.text.slice(0, 300));
        const leadAR1 = (await getS("/api/meetings/" + mid + "/messages?take=100")).json.filter((m) => (m.sender || m.Sender) === "lead").length;
        ok("restart-answer-owner-once", leadAR1 === leadAR0, leadAR0 + "->" + leadAR1);
        try { await pAR; } catch { }
      } else {
        const up = await killAndRespawn();
        ok("restart-mem-up", up, "api did not return");
        const nb = await postS("/api/boards", { name: run + "-after-restart", mission: "m", stage: "qa" });
        ok("restart-mem-liveness", nb.status === 201, nb.status + " " + nb.text.slice(0, 160));
      }
    }
  }
  fs.appendFileSync(OUT, "IDS bid=" + bid + " mid=" + mid + " note=" + nid1 + " note2=" + nid2 + "\n");
  fs.appendFileSync(OUT, "DONE pass=" + pass + " fail=" + fail + "\n");
  console.log("DONE pass=" + pass + " fail=" + fail);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { fs.appendFileSync(OUT, "FATAL " + String(e) + "\n"); console.log("FATAL " + String(e)); process.exit(1); });
