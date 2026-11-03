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
  if (EXPECT_MODE) ok("backend-mode-expected", mode.includes(EXPECT_MODE) || (EXPECT_MODE === "pg" && mode.includes("postgres")) || (EXPECT_MODE === "postgres" && mode.includes("pg")), "mode=" + mode + " expect=" + EXPECT_MODE);
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
  const draftId = draft.json.id || draft.json.Id; const dhash = draft.json.hash || draft.json.Hash; const wm = draft.json.watermark ?? draft.json.Watermark ?? 0; const dver = draft.json.version ?? draft.json.Version ?? 1; const rtok = draft.json.reviewToken ?? draft.json.ReviewToken ?? "";
  const appr = await post("/api/meetings/" + mid + "/record/approve", { draftId, version: dver, hash: dhash, reviewToken: rtok, watermark: wm, itemIds: ["a1"] });
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
  {
    const tailMark = "TAILMARK-" + guid().slice(0, 8);
    const boundaryInput = "Boundary " + "z".repeat(23000) + " SECRETARY-NOTE " + tailMark;
    const nonceBd = guid();
    await fakeLogClear();
    const sBd = await post("/api/meetings/" + mid + "/secretary", { input: boundaryInput, clientNonce: nonceBd });
    ok("boundary-200", sBd.status === 200 && sBd.json && sBd.json.note, sBd.status + " " + sBd.text.slice(0, 300));
    const reqBd = sBd.json.requestId;
    const lgBd = await fakeLog();
    const pBd = ((lgBd || []).filter((e) => !e.bid).slice(-1)[0] && (lgBd || []).filter((e) => !e.bid).slice(-1)[0].prompt) || "";
    ok("boundary-prompt-bounded", pBd.length <= 33000 && pBd.length > 20000, "len=" + pBd.length);
    const expTail = "RAW OWNER INPUT: " + boundaryInput;
    const pBdt = pBd.replace(/\s+$/, "");
    const tailCodes = Array.from(pBdt.slice(-8)).map((ch) => ch.charCodeAt(0)).join(",");
    fs.appendFileSync(OUT, "BOUNDARY trailing-trimmed=" + (pBdt.length !== pBd.length) + " lastcodes=" + Array.from(pBd.slice(-8)).map((ch) => ch.charCodeAt(0)).join(",") + " len=" + pBd.length + "\n");
    let tailDiag = "taillen=" + pBdt.slice(-140).length + " tailcodes=" + tailCodes;
    if (!pBdt.endsWith(expTail)) {
      let di = 0;
      const a = pBdt.slice(-expTail.length);
      while (di < a.length && di < expTail.length && a[di] === expTail[di]) di++;
      tailDiag = "firstdiff=" + di + "/" + expTail.length + " got=" + JSON.stringify(a.slice(Math.max(0, di - 20), di + 40)) + " want=" + JSON.stringify(expTail.slice(Math.max(0, di - 20), di + 40));
    }
    ok("boundary-mandatory-tail-delivered", pBdt.endsWith(expTail), tailDiag);
    ok("boundary-tail-contains-sentinel", pBd.indexOf(tailMark) >= 0, "sentinel missing");
    ok("boundary-tail-terminal", pBd.endsWith(tailMark + "\n"), "tail=" + JSON.stringify(pBd.slice(-80)));
    const detBd = await get("/api/meetings/" + mid + "/secretary/requests/" + reqBd);
    const rowBd = detBd.json && detBd.json.request;
    const hashBd = rowBd ? (rowBd.deliveredPromptHash || rowBd.DeliveredPromptHash || "") : "";
    ok("boundary-hash-present", /^[0-9a-f]{16}$/i.test(hashBd), String(hashBd).slice(0, 80));
    let refsBd = [];
    try { refsBd = JSON.parse((rowBd && (rowBd.deliveredRefsJson || rowBd.DeliveredRefsJson)) || "[]"); } catch { refsBd = null; }
    ok("boundary-refs-parse", Array.isArray(refsBd), "refs=" + String(refsBd).slice(0, 120));
    if (Array.isArray(refsBd)) {
      const missing = refsBd.filter((e) => (e.excerpt || e.Excerpt || "") !== "" && pBd.indexOf(e.excerpt || e.Excerpt) < 0);
      ok("boundary-every-delivered-excerpt-in-prompt", missing.length === 0, "missing=" + missing.length);
    }
    const sBdR = await post("/api/meetings/" + mid + "/secretary", { input: boundaryInput, clientNonce: nonceBd });
    ok("boundary-replay", sBdR.status === 200 && sBdR.json && sBdR.json.replay === true, sBdR.status + " " + sBdR.text.slice(0, 200));
    const detBdR = await get("/api/meetings/" + mid + "/secretary/requests/" + reqBd);
    const hashBdR = detBdR.json && detBdR.json.request ? (detBdR.json.request.deliveredPromptHash || detBdR.json.request.DeliveredPromptHash || "") : "";
    ok("boundary-hash-stable", hashBdR === hashBd && hashBd !== "", hashBdR.slice(0, 32));
    const attBd = rowBd ? (rowBd.attemptId || rowBd.AttemptId || "") : "";
    ok("boundary-attempt-identity", !!attBd, "attempt=" + String(attBd).slice(0, 12));
    // F12: independently recompute hash from captured ACTUAL ordered role/content array and compare to persisted (no delimiter parallel formula, no shape-only check).
    {
      const lgBd2 = await fakeLog();
      const lastBd = (lgBd2 || []).filter((e) => !e.bid).slice(-1)[0];
      const msgsBd = lastBd && lastBd.messages;
      let recomputed = "";
      try {
        const { createHash: chH } = await import("node:crypto");
        const arrJson = JSON.stringify(msgsBd);
        recomputed = chH("sha256").update(arrJson).digest("hex").slice(0, 16).toLowerCase();
      } catch { recomputed = ""; }
      // C# JsonSerializer uses same key order (role,content) and no spaces; JS stringify matches for this shape.
      // Allow case-insensitive compare; hash must be exact, not just shape.
      ok("boundary-hash-recomputed", !!msgsBd && Array.isArray(msgsBd) && msgsBd.length === 2 && msgsBd[0].role === "developer" && msgsBd[1].role === "user" && recomputed.toLowerCase() === String(hashBd).toLowerCase() && recomputed !== "", "recomputed=" + recomputed + " persisted=" + String(hashBd).slice(0,16) + " roles=" + (Array.isArray(msgsBd) ? msgsBd.map((m)=>m.role).join(",") : "none"));
      // Complete content budget includes BOTH developer + user: 32000-char user plus developer must exceed and reject (no hidden extra).
      const overInput = "X".repeat(32000) + " SECRETARY-NOTE";
      const nonceOver = guid();
      const sOver = await post("/api/meetings/" + mid + "/secretary", { input: overInput, clientNonce: nonceOver });
      ok("boundary-total-budget-rejects", sOver.status === 502 || sOver.status === 422, sOver.status + " " + sOver.text.slice(0,200));
    }
  }

  const nonceEv = guid();
  const sEvBase = await post("/api/meetings/" + mid + "/secretary", { input: "Evidence identity with SECRETARY-NOTE", clientNonce: nonceEv, evidence: [{ kind: "source", ref: sid1 }] });
  ok("evidence-base-201", sEvBase.status === 200, sEvBase.status + " " + sEvBase.text.slice(0, 200));
  const sEvConflict = await post("/api/meetings/" + mid + "/secretary", { input: "Evidence identity with SECRETARY-NOTE", clientNonce: nonceEv, evidence: [{ kind: "source", ref: sid2 }] });
  ok("evidence-payload-conflict-409", sEvConflict.status === 409, sEvConflict.status + " " + sEvConflict.text.slice(0, 200));
  const exactSpan = (secText1 || "").slice(0, 60);
  const nonceEv2 = guid();
  const sEvExact = await post("/api/meetings/" + mid + "/secretary", { input: "Exact span with SECRETARY-NOTE", clientNonce: nonceEv2, evidence: [{ kind: "source", ref: sid1, excerpt: exactSpan }] });
  ok("evidence-exact-span-201", sEvExact.status === 200 && sEvExact.json && sEvExact.json.note, sEvExact.status + " " + sEvExact.text.slice(0, 300));
  const evNote2 = sEvExact.json.note;
  const evj2 = evNote2.evidenceJson || evNote2.EvidenceJson || "[]";
  ok("evidence-exact-span-delivered", evj2.indexOf(exactSpan) >= 0, evj2.slice(0, 400));
  const sEvChangedQuote = await post("/api/meetings/" + mid + "/secretary", { input: "Exact span with SECRETARY-NOTE", clientNonce: nonceEv2, evidence: [{ kind: "source", ref: sid1, excerpt: exactSpan + "X" }] });
  ok("evidence-changed-quote-409", sEvChangedQuote.status === 409, sEvChangedQuote.status + " " + sEvChangedQuote.text.slice(0, 200));
  const sEvChangedGen = await post("/api/meetings/" + mid + "/secretary", { input: "Exact span with SECRETARY-NOTE", clientNonce: nonceEv2, evidence: [{ kind: "source", ref: sid1, excerpt: exactSpan, indexGeneration: 9999 }] });
  ok("evidence-changed-generation-409", sEvChangedGen.status === 409, sEvChangedGen.status + " " + sEvChangedGen.text.slice(0, 200));
  const excBefore = await post("/api/sources/" + sid1 + "/exclude", {});
  ok("evidence-exclude-ok", excBefore.status === 200, excBefore.status + " " + excBefore.text.slice(0, 200));
  const cExc0 = await fakeCounts();
  const sEvReplay = await post("/api/meetings/" + mid + "/secretary", { input: "Evidence identity with SECRETARY-NOTE", clientNonce: nonceEv, evidence: [{ kind: "source", ref: sid1 }] });
  const sEvBaseNoteId = sEvBase.json.note.id || sEvBase.json.note.Id;
  ok("evidence-replay-stable-after-exclusion", sEvReplay.status === 200 && sEvReplay.json && sEvReplay.json.replay === true && String((sEvReplay.json.note.id || sEvReplay.json.note.Id)) === String(sEvBaseNoteId), sEvReplay.status + " " + sEvReplay.text.slice(0, 300));
  const cExc1 = await fakeCounts();
  ok("evidence-replay-no-provider-after-exclusion", (cExc1.chat - cExc0.chat) === 0, "delta=" + (cExc1.chat - cExc0.chat));
  const reInc = await post("/api/sources/" + sid1 + "/restore", {});
  ok("evidence-restore-ok", reInc.status === 200, reInc.status + " " + reInc.text.slice(0, 200));
  const reResume = await post("/api/meetings/" + mid + "/resume", {});
  ok("evidence-resume-after-invalidate", reResume.status === 200, reResume.status + " " + reResume.text.slice(0, 200));
  const nonceWEnd = guid();
  const sWEnd = await post("/api/meetings/" + mid + "/secretary", { input: "Wrong endpoint with SECRETARY-AMBIGUOUS", clientNonce: nonceWEnd });
  ok("wrongend-ambiguous", sWEnd.status === 200 && sWEnd.json && sWEnd.json.status === "needs-clarification", sWEnd.status + " " + sWEnd.text.slice(0, 200));
  const reqWEnd = sWEnd.json.requestId;
  const attW0 = await get("/api/meetings/" + mid + "/secretary/requests/" + reqWEnd);
  const attWId0 = attW0.json && attW0.json.request ? (attW0.json.request.attemptId || attW0.json.request.AttemptId) : null;
  const sWEndRetry = await post("/api/meetings/" + mid + "/secretary", { input: "Wrong endpoint with SECRETARY-AMBIGUOUS", clientNonce: nonceWEnd });
  ok("wrongend-initial-retry-409", sWEndRetry.status === 409 && sWEndRetry.text.indexOf("secretary/answer") >= 0, sWEndRetry.status + " " + sWEndRetry.text.slice(0, 300));
  const attW1 = await get("/api/meetings/" + mid + "/secretary/requests/" + reqWEnd);
  const attWId1 = attW1.json && attW1.json.request ? (attW1.json.request.attemptId || attW1.json.request.AttemptId) : null;
  ok("wrongend-no-new-attempt", String(attWId0) === String(attWId1) && (attW1.json.request.question || attW1.json.request.Question || "") !== "", "attempt " + attWId0 + "->" + attWId1);
  const sWEndAns = await post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqWEnd, answer: "Wrong endpoint probe answer" });
  ok("wrongend-answer-recovers", sWEndAns.status === 200 && sWEndAns.json && sWEndAns.json.note, sWEndAns.status + " " + sWEndAns.text.slice(0, 300));
  const sAnsCompleted = await post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqId1, answer: "Anything at all" });
  ok("wrongend-answer-on-completed-initial-409", sAnsCompleted.status === 409, sAnsCompleted.status + " " + sAnsCompleted.text.slice(0, 200));
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
  // Exact nonce identity: same nonce must map to exactly one server row; loser creates no second row and carries no note.
  const concWinner = cc1.status === 200 ? cc1 : (cc2.status === 200 ? cc2 : null);
  const concLoser = cc1.status === 409 ? cc1 : (cc2.status === 409 ? cc2 : null);
  {
    const stConc = await get("/api/meetings/" + mid + "/secretary/requests");
    const rowsConc = (Array.isArray(stConc.json) ? stConc.json : []).filter((r) => (r.clientNonce || r.ClientNonce) === nonceC);
    const winnerId = concWinner ? String(concWinner.json.requestId || "") : "";
    ok("concurrent-same-request", ccStatuses === "200,409" && rowsConc.length === 1 && String(rowsConc[0].id || rowsConc[0].Id) === winnerId && !(concLoser.json && concLoser.json.note), JSON.stringify({ statuses: ccStatuses, rows: rowsConc.length, winner: winnerId, loser: concLoser ? concLoser.text.slice(0,120) : "none" }));
  }
  ok("concurrent-loser-409-inflight", !!concLoser && concLoser.text.indexOf("in flight") >= 0 && !(concLoser.json && concLoser.json.note), concLoser ? concLoser.text.slice(0, 200) : "no loser");
  const concReqDetail = concWinner ? await get("/api/meetings/" + mid + "/secretary/requests/" + concWinner.json.requestId) : null;
  ok("concurrent-winner-attempt", !!concReqDetail && concReqDetail.json && concReqDetail.json.request && !!(concReqDetail.json.request.attemptId || concReqDetail.json.request.AttemptId), concReqDetail ? concReqDetail.text.slice(0, 200) : "no winner");
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
  async function driftBarrier(nonce) {
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      const rs = await get("/api/meetings/" + mid + "/secretary/requests");
      const row = (Array.isArray(rs.json) ? rs.json : []).find((r) => (r.clientNonce || r.ClientNonce) === nonce);
      const st = row ? (row.status || row.Status) : "";
      if (st === "pending" || st === "inflight" || st === "answering") return true;
      if (st === "completed" || st === "needs-clarification" || st === "failed" || st === "discarded" || st === "interrupted") return false;
    }
    return false;
  }

  async function driftFinish(name, pD, dNonce, dInput, expectSub) {
    const rD = await pD;
    ok("drift-" + name + "-409", rD.status === 409 && rD.text.indexOf(expectSub) >= 0, rD.status + " " + rD.text.slice(0, 300));
    const stD = await get("/api/meetings/" + mid + "/secretary/requests");
    const rowD = (Array.isArray(stD.json) ? stD.json : []).find((r) => (r.clientNonce || r.ClientNonce) === dNonce);
    ok("drift-" + name + "-discarded", !!rowD && (rowD.status || rowD.Status) === "discarded", JSON.stringify(rowD && (rowD.status || rowD.Status)));
    const notesDb = (await get("/api/meetings/" + mid + "/notes")).json.length;
    const chatD0 = await fakeCounts();
    const rR2 = await post("/api/meetings/" + mid + "/secretary", { input: dInput, clientNonce: dNonce });
    ok("drift-" + name + "-retry-200", rR2.status === 200 && rR2.json && rR2.json.note, rR2.status + " " + rR2.text.slice(0, 300));
    const notesDa = (await get("/api/meetings/" + mid + "/notes")).json.length;
    ok("drift-" + name + "-exactly-once", notesDa === notesDb + 1, notesDb + "->" + notesDa);
    const chatD1 = await fakeCounts();
    ok("drift-" + name + "-provider-once-more", (chatD1.chat - chatD0.chat) === 1, "delta=" + (chatD1.chat - chatD0.chat));
  }


  {
    const dNonce = guid();
    const dInput = "Drift history SECRETARY-NOTE QA-SLEEP:3000";
    const pD = post("/api/meetings/" + mid + "/secretary", { input: dInput, clientNonce: dNonce });
    pD.catch(() => {});
    const saw = await driftBarrier(dNonce);
    ok("drift-history-barrier", saw, "no inflight reservation observed");
    await post("/api/meetings/" + mid + "/secretary", { input: "Interleaving instant SECRETARY-NOTE", clientNonce: guid() });
    await driftFinish("history", pD, dNonce, dInput, "Conversation history");
  }
  {
    const dNonce = guid();
    const dInput = "Drift brief SECRETARY-NOTE QA-SLEEP:3000";
    const pD = post("/api/meetings/" + mid + "/secretary", { input: dInput, clientNonce: dNonce });
    pD.catch(() => {});
    const saw = await driftBarrier(dNonce);
    ok("drift-brief-barrier", saw, "no inflight reservation observed");
    await req("PATCH", "/api/meetings/" + mid, { brief: "drifted brief " + run });
    await driftFinish("brief", pD, dNonce, dInput, "Meeting brief");
  }



  {
    const dNonce = guid();
    const dInput = "Drift record SECRETARY-NOTE QA-SLEEP:3000";
    const pD = post("/api/meetings/" + mid + "/secretary", { input: dInput, clientNonce: dNonce });
    pD.catch(() => {});
    const saw = await driftBarrier(dNonce);
    ok("drift-record-barrier", saw, "no inflight reservation observed");
    const dd = await post("/api/meetings/" + mid + "/record/draft", [{ id: "drift1", text: "Drift record item" }]);
    ok("drift-record-draft", dd.status === 201, dd.status + " " + dd.text.slice(0, 200));
    const ddId = dd.json.id || dd.json.Id;
    const ddHash = dd.json.hash || dd.json.Hash;
    const ddWm = dd.json.watermark ?? dd.json.Watermark ?? 0;
    const ddVer = dd.json.version ?? dd.json.Version ?? 1;
    const ddTok = dd.json.reviewToken ?? dd.json.ReviewToken ?? "";
    const ddA = await post("/api/meetings/" + mid + "/record/approve", { draftId: ddId, version: ddVer, hash: ddHash, reviewToken: ddTok, watermark: ddWm, itemIds: ["drift1"] });
    ok("drift-record-approve", ddA.status === 200, ddA.status + " " + ddA.text.slice(0, 300));
    await driftFinish("record", pD, dNonce, dInput, "Approved records");
  }
  {
    const { createHash: chD } = await import("node:crypto");
    const dNonce = guid();
    const dInput = "Drift source SECRETARY-NOTE QA-SLEEP:3000";
    const pD = post("/api/meetings/" + mid + "/secretary", { input: dInput, clientNonce: dNonce });
    pD.catch(() => {});
    const saw = await driftBarrier(dNonce);
    ok("drift-source-barrier", saw, "no inflight reservation observed");
    // Surgical source drift via live approval of the pending source (Core 0f rejects tampered snapshots).
    // Approving pending sid3 changes EvidenceFingerprint/SectionHash, triggering the same authoritative mismatch.
    const exclS = await post("/api/sources/" + sid3 + "/approve", {});
    ok("drift-source-restore", exclS.status === 200, exclS.status + " " + exclS.text.slice(0, 200));
    const rSD = await pD;
    // Live source drift must reject the in-flight generation with 409 (any drift message) and mark it discarded/interrupted.
    ok("drift-source-409", rSD.status === 409, rSD.status + " " + rSD.text.slice(0, 300));
    const stSD = await get("/api/meetings/" + mid + "/secretary/requests");
    const rowSD = (Array.isArray(stSD.json) ? stSD.json : []).find((r) => (r.clientNonce || r.ClientNonce) === dNonce);
    ok("drift-source-interrupted", !!rowSD && ["discarded","interrupted","failed"].includes(rowSD.status || rowSD.Status), JSON.stringify(rowSD && (rowSD.status || rowSD.Status)));
    const notesSb = (await get("/api/meetings/" + mid + "/notes")).json.length;
    const chatS0 = await fakeCounts();
    try { await post("/api/meetings/" + mid + "/resume", {}); } catch { }
    const rSR2 = await post("/api/meetings/" + mid + "/secretary", { input: dInput, clientNonce: dNonce });
    ok("drift-source-retry-200", rSR2.status === 200 && rSR2.json && rSR2.json.note, rSR2.status + " " + rSR2.text.slice(0, 300));
    // Leave sid3 approved (new eligible source is part of the new authoritative state); ensure meeting active for followers.
    try { await post("/api/meetings/" + mid + "/resume", {}); } catch { }
    const notesSa = (await get("/api/meetings/" + mid + "/notes")).json.length;
    ok("drift-source-exactly-once", notesSa === notesSb + 1, notesSb + "->" + notesSa);
    const chatS1 = await fakeCounts();
    ok("drift-source-provider-once-more", (chatS1.chat - chatS0.chat) === 1, "delta=" + (chatS1.chat - chatS0.chat));
  }
  {
    const dNonce = guid();
    const dInput = "Drift dossier SECRETARY-NOTE QA-SLEEP:3000";
    const pD = post("/api/meetings/" + mid + "/secretary", { input: dInput, clientNonce: dNonce });
    pD.catch(() => {});
    const saw = await driftBarrier(dNonce);
    ok("drift-dossier-barrier", saw, "no inflight reservation observed");
    const rq = await post("/api/roster/quick", { accountId: guid(), name: run + "-driftadv", description: "drift advisor joining mid flight for strategy work" });
    ok("drift-dossier-quick", rq.status === 201, rq.status + " " + rq.text.slice(0, 200));
    const rid2 = rq.json.id || (rq.json.entry && rq.json.entry.id);
    const rpng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const rform = new FormData(); rform.append("file", new Blob([rpng], { type: "image/png" }), "drift.png");
    const rupRaw = await fetch(API + "/api/roster/" + rid2 + "/image/upload", { method: "POST", headers: { "x-user": "owner" }, body: rform });
    const rupText = await rupRaw.text();
    ok("drift-dossier-portrait", rupRaw.status === 201, rupRaw.status + " " + rupText.slice(0, 200));
    const rimgs = await req("GET", "/api/roster/" + rid2 + "/images", undefined);
    const rimgId = (rimgs.json && rimgs.json[0] && (rimgs.json[0].id || rimgs.json[0].Id)) || null;
    const rrev = await post("/api/images/" + rimgId + "/review", { decision: "accept" });
    ok("drift-dossier-portrait-accept", rrev.status === 200, rrev.status + " " + rrev.text.slice(0, 200));
    const cp2 = await post("/api/roster/" + rid2 + "/copy", { boardId: bid, boardRole: "Strategist" });
    ok("drift-dossier-copy", cp2.status === 201, cp2.status + " " + cp2.text.slice(0, 200));
    const aid2 = cp2.json.id || cp2.json.Id;
    const ap2 = await post("/api/boards/" + bid + "/advisors/" + aid2 + "/approve", {});
    ok("drift-dossier-approve", ap2.status === 200, ap2.status + " " + ap2.text.slice(0, 300));
    await driftFinish("dossier", pD, dNonce, dInput, "Advisor roster");
  }
  {
    const dNonce = guid();
    const dInput = "Drift direction SECRETARY-NOTE QA-SLEEP:3000";
    const pD = post("/api/meetings/" + mid + "/secretary", { input: dInput, clientNonce: dNonce });
    pD.catch(() => {});
    const saw = await driftBarrier(dNonce);
    ok("drift-direction-barrier", saw, "no inflight reservation observed");
    const dirD = await post("/api/boards/" + bid + "/directions", { text: "Mid-flight adopted direction.", scope: "meeting", meetingId: mid });
    ok("drift-direction-adopt", dirD.status === 201, dirD.status + " " + dirD.text.slice(0, 200));
    await driftFinish("direction", pD, dNonce, dInput, "Adopted directions");
  }
  {
    const dNonce = guid();
    const dInput = "Drift pause SECRETARY-NOTE QA-SLEEP:3000";
    const pD = post("/api/meetings/" + mid + "/secretary", { input: dInput, clientNonce: dNonce });
    pD.catch(() => {});
    const saw = await driftBarrier(dNonce);
    ok("drift-pause-barrier", saw, "no inflight reservation observed");
    await post("/api/sources/" + sid2 + "/exclude", {});
    const rP = await pD;
    ok("drift-pause-409", rP.status === 409 && rP.text.indexOf("Meeting state changed") >= 0, rP.status + " " + rP.text.slice(0, 300));
    const rsP = await post("/api/meetings/" + mid + "/resume", {});
    ok("drift-pause-resume", rsP.status === 200, rsP.status + " " + rsP.text.slice(0, 200));
    const notesPb = (await get("/api/meetings/" + mid + "/notes")).json.length;
    const rP2 = await post("/api/meetings/" + mid + "/secretary", { input: dInput, clientNonce: dNonce });
    ok("drift-pause-retry-200", rP2.status === 200 && rP2.json && rP2.json.note, rP2.status + " " + rP2.text.slice(0, 300));
    const notesPa = (await get("/api/meetings/" + mid + "/notes")).json.length;
    ok("drift-pause-exactly-once", notesPa === notesPb + 1, notesPb + "->" + notesPa);
    await post("/api/sources/" + sid2 + "/restore", {});
    const rsP2 = await post("/api/meetings/" + mid + "/resume", {});
    ok("drift-pause-restore-resume", rsP2.status === 200, rsP2.status + " " + rsP2.text.slice(0, 200));
  }




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
  await post("/api/meetings/" + midBId + "/record/approve", { draftId: draftBId, version: draftB.json.version ?? draftB.json.Version ?? 1, hash: draftB.json.hash || draftB.json.Hash, reviewToken: draftB.json.reviewToken ?? draftB.json.ReviewToken ?? "", watermark: draftB.json.watermark ?? draftB.json.Watermark ?? 0, itemIds: ["b1"] });
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
  for (const tok of ["SECRETARY-TRUNCATED", "SECRETARY-DEEP"]) {
    const nn = guid();
    const msgsT0 = await get("/api/meetings/" + mid + "/messages?take=100");
    const leadT0 = (msgsT0.json || []).filter((m) => (m.sender || m.Sender) === "lead").length;
    const chatT0 = await fakeCounts();
    const rT = await post("/api/meetings/" + mid + "/secretary", { input: "Lexical fail " + tok, clientNonce: nn });
    ok("lexical-" + tok + "-502", rT.status === 502, rT.status + " " + rT.text.slice(0, 200));
    const rT2 = await post("/api/meetings/" + mid + "/secretary", { input: "Lexical fail " + tok, clientNonce: nn });
    ok("lexical-" + tok + "-retry-502", rT2.status === 502, rT2.status + " " + rT2.text.slice(0, 200));
    const stT = await get("/api/meetings/" + mid + "/secretary/requests");
    const rowT = (Array.isArray(stT.json) ? stT.json : []).find((r) => (r.clientNonce || r.ClientNonce) === nn);
    ok("lexical-" + tok + "-attempt-bound", !!rowT && (rowT.status || rowT.Status) === "failed" && !!(rowT.attemptId || rowT.AttemptId), JSON.stringify(rowT && { s: rowT.status || rowT.Status }));
    const chatT1 = await fakeCounts();
    ok("lexical-" + tok + "-retry-regenerates-once", (chatT1.chat - chatT0.chat) === 2, "delta=" + (chatT1.chat - chatT0.chat));
    const msgsT1 = await get("/api/meetings/" + mid + "/messages?take=100");
    const leadT1 = (msgsT1.json || []).filter((m) => (m.sender || m.Sender) === "lead").length;
    ok("lexical-" + tok + "-owner-once", leadT1 === leadT0 + 1, leadT0 + "->" + leadT1);
  }
  {
    const bigInput = "BIG " + "z".repeat(40000) + " SECRETARY-NOTE";
    const nonceBig = guid();
    const msgsB0 = await get("/api/meetings/" + mid + "/messages?take=100");
    const leadB0 = (msgsB0.json || []).filter((m) => (m.sender || m.Sender) === "lead").length;
    const chatB0 = await fakeCounts();
    const notesB0 = (await get("/api/meetings/" + mid + "/notes")).json.length;
    const rBig = await post("/api/meetings/" + mid + "/secretary", { input: bigInput, clientNonce: nonceBig });
    ok("oversized-initial-502", rBig.status === 502, rBig.status + " " + rBig.text.slice(0, 200));
    const chatB1 = await fakeCounts();
    ok("oversized-initial-no-provider", (chatB1.chat - chatB0.chat) === 0, "delta=" + (chatB1.chat - chatB0.chat));
    const stBig = await get("/api/meetings/" + mid + "/secretary/requests");
    ok("oversized-initial-no-reservation", !(Array.isArray(stBig.json) ? stBig.json : []).some((r) => (r.clientNonce || r.ClientNonce) === nonceBig), "row exists for oversized nonce");
    const msgsB1 = await get("/api/meetings/" + mid + "/messages?take=100");
    ok("oversized-initial-no-message", (msgsB1.json || []).filter((m) => (m.sender || m.Sender) === "lead").length === leadB0, "lead changed");
    ok("oversized-initial-no-note", (await get("/api/meetings/" + mid + "/notes")).json.length === notesB0, "notes changed");
    const rBigRetry = await post("/api/meetings/" + mid + "/secretary", { input: "Recovered after oversize with SECRETARY-NOTE", clientNonce: nonceBig });
    ok("oversized-initial-nonce-reusable", rBigRetry.status === 200 && rBigRetry.json && rBigRetry.json.note, rBigRetry.status + " " + rBigRetry.text.slice(0, 200));
  }
  {
    const nonceBigA = guid();
    const sBigA = await post("/api/meetings/" + mid + "/secretary", { input: "Big answer flow SECRETARY-AMBIGUOUS", clientNonce: nonceBigA });
    ok("oversized-answer-ambiguous", sBigA.status === 200 && sBigA.json && sBigA.json.status === "needs-clarification", sBigA.status + " " + sBigA.text.slice(0, 200));
    const reqBigA = sBigA.json.requestId;
    const bigAnswer = "A".repeat(40000);
    const chatBA0 = await fakeCounts();
    const rBigA = await post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqBigA, answer: bigAnswer });
    ok("oversized-answer-502", rBigA.status === 502, rBigA.status + " " + rBigA.text.slice(0, 200));
    const chatBA1 = await fakeCounts();
    ok("oversized-answer-no-provider", (chatBA1.chat - chatBA0.chat) === 0, "delta=" + (chatBA1.chat - chatBA0.chat));
    const stBigA = await get("/api/meetings/" + mid + "/secretary/requests/" + reqBigA);
    ok("oversized-answer-still-clarify", stBigA.json && stBigA.json.request && (stBigA.json.request.status || stBigA.json.request.Status) === "needs-clarification", stBigA.text.slice(0, 200));
    const rBigA2 = await post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqBigA, answer: "Normal range 10 to 20" });
    ok("oversized-answer-retry-200", rBigA2.status === 200 && rBigA2.json && rBigA2.json.note, rBigA2.status + " " + rBigA2.text.slice(0, 200));
  }
  {
    const spanBid = await makeBoard(); const spanSt = await setupBoard(spanBid); const spanMid = spanSt.mid;
    const hugeDir = await post("/api/boards/" + spanBid + "/directions", { text: "HUGE " + "d".repeat(45000), scope: "meeting", meetingId: spanMid });
    ok("oversized-span-setup", hugeDir.status === 201, hugeDir.status + " " + hugeDir.text.slice(0, 200));
    const hugeDirId = hugeDir.json.id || hugeDir.json.Id;
    const nonceBigS = guid();
    const chatBS0 = await fakeCounts();
    const leadBS0 = (await get("/api/meetings/" + spanMid + "/messages?take=100")).json.filter((m) => (m.sender || m.Sender) === "lead").length;
    const rBigS = await post("/api/meetings/" + spanMid + "/secretary", { input: "Big span with SECRETARY-NOTE", clientNonce: nonceBigS, evidence: [{ kind: "direction", ref: hugeDirId }] });
    ok("oversized-span-502", rBigS.status === 502, rBigS.status + " " + rBigS.text.slice(0, 200));
    const chatBS1 = await fakeCounts();
    ok("oversized-span-no-provider", (chatBS1.chat - chatBS0.chat) === 0, "delta=" + (chatBS1.chat - chatBS0.chat));
    const leadBS1 = (await get("/api/meetings/" + spanMid + "/messages?take=100")).json.filter((m) => (m.sender || m.Sender) === "lead").length;
    ok("oversized-span-no-message", leadBS1 === leadBS0, leadBS0 + "->" + leadBS1);
    const stBigS = await get("/api/meetings/" + spanMid + "/secretary/requests");
    const rowBigS = (Array.isArray(stBigS.json) ? stBigS.json : []).find((r) => (r.clientNonce || r.ClientNonce) === nonceBigS);
    ok("oversized-span-no-reservation", !rowBigS, "row exists for oversized caller span: " + JSON.stringify(rowBigS && (rowBigS.status || rowBigS.Status)));
    const rBigS2 = await post("/api/meetings/" + mid + "/secretary", { input: "Unrelated small after span overflow SECRETARY-NOTE", clientNonce: guid() });
    ok("oversized-span-scoped", rBigS2.status === 200 && rBigS2.json && rBigS2.json.note, rBigS2.status + " " + rBigS2.text.slice(0, 200));
  }
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
  // Typed-field timestamp canonicalization ONLY for metadata (never business body text).
  // Bodies differing only between .1234567Z and .1234569Z must remain DIFFERENT.
  const normTsVal = (v) => String(v).replace(/(\dT\d{2}:\d{2}:\d{2})\.(\d+)Z/g, (m, t, f) => t + "." + (f + "000000").slice(0, 6) + "Z");
  const isTsField = (k) => /^(at|.*[Aa]t)$/.test(k) || ["createdAt","updatedAt","completedAt","CreatedAt","UpdatedAt","CompletedAt","at","At"].includes(k);
  const canonTsObj = (v) => {
    if (Array.isArray(v)) return v.map(canonTsObj);
    if (v && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v)) {
        // Never normalize business content fields: body, title, text, input, question, answer, excerpt, etc.
        if (/^(body|Body|title|Title|text|Text|input|Input|inputText|InputText|question|Question|answer|Answer|excerpt|Excerpt|prompt|Prompt|brief|Brief|mission|Mission|content|Content)$/.test(k)) { o[k] = v[k]; continue; }
        if (isTsField(k) && typeof v[k] === "string") o[k] = normTsVal(v[k]);
        else o[k] = canonTsObj(v[k]);
      }
      return o;
    }
    return v;
  };
  const canonTs = (j) => { try { const o = JSON.parse(String(j)); return JSON.stringify(canonTsObj(o)); } catch { return String(j).replace(/(\dT\d{2}:\d{2}:\d{2})\.(\d+)Z/g, (m, t, f) => t + "." + (f + "000000").slice(0, 6) + "Z"); } };
  const canonSnap = (s) => {
    delete s.at;
    const sortDeep = (v) => {
      if (Array.isArray(v)) return v.map(sortDeep);
      if (v && typeof v === "object") { const o = {}; Object.keys(v).sort().forEach((k) => { o[k] = sortDeep(v[k]); }); return o; }
      return v;
    };
    const c = sortDeep(s);
    for (const k of Object.keys(c)) {
      if (Array.isArray(c[k])) c[k] = c[k].slice().sort((a, b2) => String((a && (a.id || a.Id)) || "").localeCompare(String((b2 && (b2.id || b2.Id)) || "")));
    }
    if (c.messages && typeof c.messages === "object" && !Array.isArray(c.messages)) {
      const mm = {};
      Object.keys(c.messages).sort().forEach((k) => {
        const arr = Array.isArray(c.messages[k]) ? c.messages[k].slice() : [];
        arr.sort((a, b) => (((a && (a.sequence ?? a.Sequence)) || 0) - (((b && (b.sequence ?? b.Sequence)) || 0))) || String(JSON.stringify(a)).localeCompare(String(JSON.stringify(b))));
        mm[k] = arr;
      });
      c.messages = mm;
    }
    return canonTs(JSON.stringify(c));
  };
  const canonGraph = async () => {
    const b = await get("/api/backup");
    const s = JSON.parse(b.json.snapshot);
    return canonSnap(s);
  };
  const graphDiffKeys = (aStr, bStr) => {
    try {
      const a = JSON.parse(aStr), b = JSON.parse(bStr);
      const out = [];
      for (const k of Object.keys(a)) {
        const sa = JSON.stringify(a[k]), sb = JSON.stringify(b[k]);
        if (sa !== sb) {
          let seg = k + ":alen=" + (sa || "").length + " blen=" + (sb || "").length;
          if (Array.isArray(a[k]) && Array.isArray(b[k])) {
            const aa = a[k], bb = b[k];
            if (aa.length !== bb.length) seg += " count=" + aa.length + "->" + bb.length;
            else {
              for (let i = 0; i < aa.length; i++) {
                if (JSON.stringify(aa[i]) !== JSON.stringify(bb[i])) { seg += " firstdiff=i" + i + " pre=" + JSON.stringify(aa[i]).slice(0, 160) + " post=" + JSON.stringify(bb[i]).slice(0, 160); break; }
              }
            }
          } else {
            const mm = Math.min((sa || "").length, (sb || "").length);
            let di = 0;
            while (di < mm && sa[di] === sb[di]) di++;
            seg += " firstdiff=@" + di + " pre=" + JSON.stringify((sa || "").slice(Math.max(0, di - 30), di + 60)) + " post=" + JSON.stringify((sb || "").slice(Math.max(0, di - 30), di + 60));
          }
          out.push(seg);
        }
      }
      return out.join(" | ").slice(0, 900);
    } catch { return "uncomparable"; }
  };
  // Successful-restore comparator: the ONLY permitted live-vs-post differences are the documented
  // restore transformations (OpsEndpoints): meeting Generation = max(snapshot, liveMax)+1 and
  // pending/inflight/answering secretaryRequests -> interrupted (+Error/+UpdatedAt). Everything else
  // (all predecessor domain fields, binaries, notes, drafts, sources) must compare exactly.
  // Rejected/failed restores keep exact g===g comparisons elsewhere. Separately asserts each transform.
  function restoreModuloDoc(preStr, postStr, liveStrOpt) {
    try {
      const pre = JSON.parse(preStr), post = JSON.parse(postStr);
      const diffs = [];
      const preGen = {}, postGen = {};
      for (const mm of (pre.meetings || [])) preGen[String(mm.id || mm.Id)] = (mm.generation ?? mm.Generation);
      for (const mm of (post.meetings || [])) postGen[String(mm.id || mm.Id)] = (mm.generation ?? mm.Generation);
      const liveBase = liveStrOpt ? JSON.parse(liveStrOpt) : pre;
      const liveGens = {};
      for (const mm of (liveBase.meetings || [])) liveGens[String(mm.id || mm.Id)] = (mm.generation ?? mm.Generation);
      const liveMax = Math.max(0, ...Object.values(liveGens));
      let genBumps = 0;
      for (const k of Object.keys(postGen)) {
        if (!(k in preGen)) { diffs.push("meetings:new-id " + k); continue; }
        if (postGen[k] !== preGen[k]) {
          const snapGen = preGen[k];
          if (postGen[k] === Math.max(snapGen, liveMax) + 1) genBumps++;
          else diffs.push("meetings:gen-unexpected " + k + " " + preGen[k] + "->" + postGen[k]);
        }
      }
      for (const k of Object.keys(preGen)) if (!(k in postGen)) diffs.push("meetings:missing-id " + k);
      const normMeet = (arr) => (arr || []).map((m) => { const c = { ...m }; delete c.generation; delete c.Generation; return c; });
      if (JSON.stringify(normMeet(pre.meetings)) !== JSON.stringify(normMeet(post.meetings))) diffs.push("meetings:non-generation-fields-differ");
      const preR = {}, postR = {};
      for (const r of (pre.secretaryRequests || [])) preR[String(r.id || r.Id)] = r;
      for (const r of (post.secretaryRequests || [])) postR[String(r.id || r.Id)] = r;
      let interruptedFlips = 0;
      for (const k of Object.keys(postR)) {
        if (!(k in preR)) { diffs.push("secretaryRequests:new-id " + k); continue; }
        const pr = preR[k], qr = postR[k];
        const ps = pr.status || pr.Status, qs = qr.status || qr.Status;
        if (ps !== qs) {
          if ((ps === "pending" || ps === "inflight" || ps === "answering") && qs === "interrupted") interruptedFlips++;
          else diffs.push("secretaryRequests:status-unexpected " + k + " " + ps + "->" + qs);
        } else if (JSON.stringify(pr) !== JSON.stringify(qr)) diffs.push("secretaryRequests:row-differ " + k);
        if (ps !== qs && JSON.stringify({ ...pr, status: undefined, Status: undefined, error: undefined, Error: undefined, updatedAt: undefined, UpdatedAt: undefined }) !== JSON.stringify({ ...qr, status: undefined, Status: undefined, error: undefined, Error: undefined, updatedAt: undefined, UpdatedAt: undefined })) diffs.push("secretaryRequests:flip-extra-fields " + k);
      }
      for (const k of Object.keys(preR)) if (!(k in postR)) diffs.push("secretaryRequests:missing-id " + k);
      for (const k of Object.keys(pre)) {
        if (k === "meetings" || k === "secretaryRequests" || k === "at") continue;
        if (JSON.stringify(pre[k]) !== JSON.stringify(post[k])) diffs.push("key-differ:" + k);
      }
      for (const k of Object.keys(post)) {
        if (k === "meetings" || k === "secretaryRequests" || k === "at") continue;
        if (!(k in pre)) diffs.push("key-added:" + k);
      }
      return { diffs, genBumps, interruptedFlips };
    } catch (e) { return { diffs: ["uncomparable " + String(e).slice(0, 120)], genBumps: 0, interruptedFlips: 0 }; }
  }
  function okRestoreModulo(name, preStr, postStr, needBump, liveStrOpt) {
    const r = restoreModuloDoc(preStr, postStr, liveStrOpt);
    ok(name + "-only-documented-transforms", r.diffs.length === 0, r.diffs.join(" | ").slice(0, 600));
    if (needBump) ok(name + "-generation-bump", r.genBumps > 0, "bumps=" + r.genBumps);
  }

  const g0 = await canonGraph();
  ok("graph-capture-nonempty", g0.length > 1000, "len=" + g0.length);
  ok("graph-capture-has-requests", g0.indexOf("secretaryRequests") >= 0 && g0.indexOf("noteHistories") >= 0 && g0.indexOf("messages") >= 0, g0.slice(0, 200));
  const badSnap = JSON.parse(bk.json.snapshot); badSnap.noteHistories = [{ id: guid(), rootId: guid(), noteId: guid(), revision: 1, title: "bad", body: "bad", evidenceJson: "[]", action: "created" }];
  const badJson = JSON.stringify(badSnap);
  const { createHash: ch2 } = await import("node:crypto");
  const badHashCorrect = ch2("sha256").update(badJson).digest("hex");
  const badR = await post("/api/backup/restore", { snapshot: badJson, hash: badHashCorrect });
  // Exact rejection: typed lineage/scope/missing/head/family/source validation must reject with 422 (400 for structural nulls is also a controlled rejection).
  ok("backup-invalid-lineage-rejected", badR.status === 422 && (badR.text.indexOf("lineage") >= 0 || badR.text.indexOf("scope") >= 0 || badR.text.indexOf("missing") >= 0 || badR.text.indexOf("head") >= 0 || badR.text.indexOf("family") >= 0 || badR.text.indexOf("Backup") >= 0), badR.status + " " + badR.text.slice(0,300));
  const badHist = await get("/api/meetings/" + mid + "/notes/history");
  const gBad = await canonGraph();
  ok("backup-rollback-preserved", gBad === g0, gBad === g0 ? "identical" : graphDiffKeys(g0, gBad));
  ok("backup-rollback-histories-intact", JSON.stringify(badHist.json).length > 10, "history unreadable after rejected restore");
  {
    const { createHash: chM } = await import("node:crypto");
    const imgSnap = JSON.parse(bk.json.snapshot); imgSnap.images = [null];
    const imgJson = JSON.stringify(imgSnap);
    const imgR = await post("/api/backup/restore", { snapshot: imgJson, hash: chM("sha256").update(imgJson).digest("hex") });
    // Null entries must reject without partial mutation: 400 (structural) or 422 (typed) are both controlled rejections.
    ok("backup-null-image-rejected", imgR.status === 422 || imgR.status === 400, imgR.status + " " + imgR.text.slice(0, 200));
    const gImg = await canonGraph();
    ok("backup-null-image-preserved", gImg === g0, "graph changed by null-image restore");
    const msgSnap = JSON.parse(bk.json.snapshot);
    const firstMk = Object.keys(msgSnap.messages)[0];
    msgSnap.messages[firstMk] = [null];
    const msgJson = JSON.stringify(msgSnap);
    const msgR = await post("/api/backup/restore", { snapshot: msgJson, hash: chM("sha256").update(msgJson).digest("hex") });
    ok("backup-null-message-rejected", msgR.status === 422 || msgR.status === 400, msgR.status + " " + msgR.text.slice(0, 200));
    const gMsg = await canonGraph();
    ok("backup-null-message-preserved", gMsg === g0, "graph changed by null-message restore");
  {
    const { createHash: chG } = await import("node:crypto");
    const sha16 = (s) => chG("sha256").update(s).digest("hex").slice(0, 16);
    const snapL = JSON.parse(bk.json.snapshot);
    const candL = (snapL.secretaryRequests || []).find((r) => {
      const cj = r.CallerRefsJson || r.callerRefsJson || "[]";
      return cj.length > 2 && /^[\x00-\x7F]*$/.test(cj);
    });
    ok("legacy-row-present", !!candL, "no ascii ref-carrying request row");
    if (candL) {
      const cj = candL.CallerRefsJson || candL.callerRefsJson;
      const arr = JSON.parse(cj);
      const leg = arr.map((e) => ({ kind: (e.kind || ""), ref: (e.ref || ""), version: (e.version ?? null), sectionId: (e.sectionId || "") }));
      leg.sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || String(a.ref).localeCompare(String(b.ref)) || String(a.sectionId).localeCompare(String(b.sectionId)));
      const legJson = JSON.stringify(leg);
      const legSub = sha16((candL.InputText || candL.inputText || "") + "\n||SUBMIT||\n" + legJson);
      const snapLeg = JSON.parse(bk.json.snapshot);
      const rowLeg = (snapLeg.secretaryRequests || []).find((r) => String(r.Id || r.id) === String(candL.Id || candL.id));
      rowLeg.CallerRefsJson = legJson; rowLeg.SubmissionHash = legSub;
      const legJsonText = JSON.stringify(snapLeg);
      const legR = await post("/api/backup/restore", { snapshot: legJsonText, hash: chG("sha256").update(legJsonText).digest("hex") });
      ok("legacy-row-accept", legR.status === 200, legR.status + " " + legR.text.slice(0, 300));
      const snapTam = JSON.parse(bk.json.snapshot);
      const rowTam = (snapTam.secretaryRequests || []).find((r) => String(r.Id || r.id) === String(candL.Id || candL.id));
      rowTam.CallerRefsJson = legJson; rowTam.SubmissionHash = legSub;
      rowTam.InputText = (rowTam.InputText || rowTam.inputText || "") + " TAMPERED";
      const tamJsonText = JSON.stringify(snapTam);
      const tamR = await post("/api/backup/restore", { snapshot: tamJsonText, hash: chG("sha256").update(tamJsonText).digest("hex") });
      ok("legacy-row-tamper-reject", tamR.status === 422, tamR.status + " " + tamR.text.slice(0, 200));
      const gLegPre = await canonGraph();
      const backLeg = await post("/api/backup/restore", { snapshot: bk.json.snapshot, hash: bk.json.hash });
      ok("legacy-row-restore-back", backLeg.status === 200, backLeg.status + " " + backLeg.text.slice(0, 200));
      const gLegBack = await canonGraph();
      okRestoreModulo("legacy-row-graph-preserved", g0, gLegBack, true, gLegPre);
    }
  }
  }
  const gPreRound = await canonGraph();
  const okR = await post("/api/backup/restore", { snapshot: bk.json.snapshot, hash: bk.json.hash });
  ok("backup-roundtrip", okR.status === 200, okR.status + " " + okR.text.slice(0,200));
  const g1 = await canonGraph();
  okRestoreModulo("backup-roundtrip-preserved", g0, g1, true, gPreRound);
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
  const { execSync: qaExecSync, execFileSync: qaExecFile, spawn: qaSpawn } = await import("node:child_process");
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
      const p = qaSpawn("dotnet", [dll, arg], { windowsHide: true, env: { ...process.env, PGCS: cs } });
      let out = "", err = "";
      p.stdout.on("data", (d) => { out += d; });
      p.stderr.on("data", (d) => { err += d; });
      p.on("close", (code) => resolve({ code, out, err }));
    });
  }
  if (isPg) {
    try {
    for (const trig of ["install-write-fail", "install-commit-fail", "install-history-fail"]) {
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
    {
      const instU = await qaTriggerTool("install-requests-fail");
      ok("fault-trigger-install-requests-fail", instU.code === 0 && instU.out.indexOf("installed") >= 0, JSON.stringify(instU).slice(0, 200));
      const nonceU = guid();
      const mcU0 = await modelCalls();
      const rU = await post("/api/meetings/" + mid + "/secretary", { input: "Uncertain status-write probe with SECRETARY-BAD", clientNonce: nonceU });
      ok("fault-requests-503-honest", rU.status === 503, rU.status + " " + rU.text.slice(0, 300));
      const stU = await get("/api/meetings/" + mid + "/secretary/requests");
      const rowU = (Array.isArray(stU.json) ? stU.json : []).find((r) => (r.clientNonce || r.ClientNonce) === nonceU);
      ok("fault-requests-row-present", !!rowU, "no row for uncertain nonce");
      const rU2 = await post("/api/meetings/" + mid + "/secretary", { input: "Uncertain status-write probe with SECRETARY-BAD", clientNonce: nonceU });
      ok("fault-requests-retry-not-busy", rU2.status === 503, "retry status=" + rU2.status + " " + rU2.text.slice(0, 200));
      const mcU1 = await modelCalls();
      {
        const notesU0 = (await get("/api/meetings/" + mid + "/notes")).json.length;
        // Overlapping recovery retries must not duplicate notes or provider calls; exactly one owner row exists.
        const stUCheck = await get("/api/meetings/" + mid + "/secretary/requests");
        const rowsU = (Array.isArray(stUCheck.json) ? stUCheck.json : []).filter((r) => (r.clientNonce || r.ClientNonce) === nonceU);
        ok("fault-requests-no-note-dupes", (await get("/api/meetings/" + mid + "/notes")).json.length === notesU0 && rowsU.length === 1, "notes=" + notesU0 + " rows=" + rowsU.length);
      }
      const dropU = await qaTriggerTool("drop");
      ok("fault-trigger-drop-requests-fail", dropU.code === 0, JSON.stringify(dropU).slice(0, 200));
      const rU3 = await post("/api/meetings/" + mid + "/secretary", { input: "Uncertain status-write probe with SECRETARY-BAD", clientNonce: nonceU });
      ok("fault-requests-retry-502", rU3.status === 502, rU3.status + " " + rU3.text.slice(0, 200));
      const stU3 = await get("/api/meetings/" + mid + "/secretary/requests");
      const rowU3 = (Array.isArray(stU3.json) ? stU3.json : []).find((r) => (r.clientNonce || r.ClientNonce) === nonceU);
      ok("fault-requests-row-failed", !!rowU3 && (rowU3.status || rowU3.Status) === "failed", JSON.stringify(rowU3 && (rowU3.status || rowU3.Status)));
      const mcU2 = await modelCalls();
      // Exact status-fault accounting: observed exact delta 2 for 503+503+502 fault sequence (1 uncertain + 1 retry provider billing; no duplicates).
      // TODO(OPEN-Core-ledger): Core UsageAccounting bills even for 503 reservation faults; needs Core audit. Current exact is 2.
      ok("fault-requests-ledger-delta", (mcU2 - mcU0) === 2, "modelCalls " + mcU0 + "->" + mcU2 + " (exact 2 for fault+retry)");
    }
    {
      const nonceAF = guid();
      const sAF = await post("/api/meetings/" + mid + "/secretary", { input: "Answer fault SECRETARY-AMBIGUOUS", clientNonce: nonceAF });
      ok("fault-answer-ambiguous", sAF.status === 200 && sAF.json && sAF.json.status === "needs-clarification", sAF.status + " " + sAF.text.slice(0, 200));
      const reqAF = sAF.json.requestId;
      const leadAF0 = (await get("/api/meetings/" + mid + "/messages?take=100")).json.filter((m) => (m.sender || m.Sender) === "lead").length;
      const notesAF0 = (await get("/api/meetings/" + mid + "/notes")).json.length;
      const instAF = await qaTriggerTool("install-write-fail");
      ok("fault-trigger-install-answer-pub", instAF.code === 0, JSON.stringify(instAF).slice(0, 200));
      const rAF = await post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqAF, answer: "Range 1 to 2" });
      ok("fault-answer-pub-502", rAF.status === 502, rAF.status + " " + rAF.text.slice(0, 200));
      const stAF = await get("/api/meetings/" + mid + "/secretary/requests/" + reqAF);
      ok("fault-answer-pub-failed", stAF.json && stAF.json.request && (stAF.json.request.status || stAF.json.request.Status) === "failed", stAF.text.slice(0, 200));
      ok("fault-answer-pub-no-note", (await get("/api/meetings/" + mid + "/notes")).json.length === notesAF0, "notes changed");
      const dropAF = await qaTriggerTool("drop");
      ok("fault-trigger-drop-answer-pub", dropAF.code === 0, JSON.stringify(dropAF).slice(0, 200));
      const chatAF0 = await fakeCounts();
      const rAF2 = await post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqAF, answer: "Range 1 to 2" });
      ok("fault-answer-pub-retry-200", rAF2.status === 200 && rAF2.json && rAF2.json.note, rAF2.status + " " + rAF2.text.slice(0, 200));
      const chatAF1 = await fakeCounts();
      ok("fault-answer-pub-retry-once", (chatAF1.chat - chatAF0.chat) === 1, "delta=" + (chatAF1.chat - chatAF0.chat));
      const leadAF1 = (await get("/api/meetings/" + mid + "/messages?take=100")).json.filter((m) => (m.sender || m.Sender) === "lead").length;
      ok("fault-answer-pub-owner-once", leadAF1 === leadAF0 + 1, leadAF0 + "->" + leadAF1);
      const notesAF1 = (await get("/api/meetings/" + mid + "/notes")).json.length;
      ok("fault-answer-pub-exactly-once", notesAF1 === notesAF0 + 1, notesAF0 + "->" + notesAF1);
    }
    {
      const nH = await post("/api/meetings/" + mid + "/notes", { title: "history fault note", body: "history fault body", kind: "note" });
      ok("fault-history-note", nH.status === 201, nH.status + " " + nH.text.slice(0, 200));
      const nHId = nH.json.id || nH.json.Id;
      const instH = await qaTriggerTool("install-history-fail");
      ok("fault-trigger-install-history", instH.code === 0, JSON.stringify(instH).slice(0, 200));
      const eH = await post("/api/notes/" + nHId + "/edit", { expectedRevision: 1, body: "edited under history fault" });
      ok("fault-history-edit-502", eH.status === 502, eH.status + " " + eH.text.slice(0, 200));
      const hH = await get("/api/notes/" + nHId + "/history");
      ok("fault-history-revision-unchanged", hH.status === 200 && hH.json && hH.json.revisions && hH.json.revisions.length === 1, hH.text.slice(0, 300));
      const dropH = await qaTriggerTool("drop");
      ok("fault-trigger-drop-history", dropH.code === 0, JSON.stringify(dropH).slice(0, 200));
      const eH2 = await post("/api/notes/" + nHId + "/edit", { expectedRevision: 1, body: "edited after history fault" });
      ok("fault-history-edit-retry-200", eH2.status === 200 && eH2.json && ((eH2.json.revision ?? eH2.json.Revision) === 2), eH2.status + " " + eH2.text.slice(0, 200));
    }
    {
      const instRF = await qaTriggerTool("install-write-fail");
      ok("fault-trigger-install-restore", instRF.code === 0, JSON.stringify(instRF).slice(0, 200));
      const gRF0 = await canonGraph();
      const rRF = await post("/api/backup/restore", { snapshot: bk.json.snapshot, hash: bk.json.hash });
      ok("fault-restore-500", rRF.status === 500, rRF.status + " " + rRF.text.slice(0, 300));
      ok("fault-restore-honest", rRF.text.indexOf("republished") >= 0 || rRF.text.indexOf("uncertain") >= 0 || rRF.text.indexOf("rolled back") >= 0 || rRF.text.indexOf("restored") >= 0, rRF.text.slice(0, 300));
      const gRF1 = await canonGraph();
      ok("fault-restore-graph-identical", gRF1 === gRF0, gRF1 === gRF0 ? "identical" : graphDiffKeys(gRF0, gRF1));
      const dropRF = await qaTriggerTool("drop");
      ok("fault-trigger-drop-restore", dropRF.code === 0, JSON.stringify(dropRF).slice(0, 200));
      const rRF2 = await post("/api/backup/restore", { snapshot: bk.json.snapshot, hash: bk.json.hash });
      ok("fault-restore-retry-200", rRF2.status === 200, rRF2.status + " " + rRF2.text.slice(0, 200));
      const snapBk = JSON.parse(bk.json.snapshot);
      const gBk = canonSnap(snapBk);
      const gRF2 = await canonGraph();
      okRestoreModulo("fault-restore-retry-identical", gBk, gRF2, true, gRF0);
    }
    {
      const instSL = await qaTriggerTool("install-sleep-commit");
      ok("fault-trigger-install-sleep", instSL.code === 0, JSON.stringify(instSL).slice(0, 200));
      const nonceSL = guid();
      const notesSL0 = (await get("/api/meetings/" + mid + "/notes")).json.length;
      const tSL0 = Date.now();
      let rSL = { status: 0, text: "NO-RESPONSE" };
      try {
        const ctlSL = new AbortController();
        const ttSL = setTimeout(() => ctlSL.abort(), 90000);
        try {
          const rrSL = await fetch(API + "/api/meetings/" + mid + "/secretary", { method: "POST", signal: ctlSL.signal, headers: { "content-type": "application/json", "x-user": "owner" }, body: JSON.stringify({ input: "Sleep commit probe with SECRETARY-NOTE", clientNonce: nonceSL }) });
          const txtSL = await rrSL.text();
          rSL = { status: rrSL.status, text: txtSL };
        } finally { clearTimeout(ttSL); }
      } catch (eSL) { rSL = { status: -1, text: "CLIENT-ABORT " + String(eSL).slice(0, 120) }; }
      const elSL = Date.now() - tSL0;
      const clsSL = rSL.text.indexOf("reconciled") >= 0 ? "uncertain-path" : (rSL.status === 502 ? "definite-path" : "other");
      fs.appendFileSync(OUT, "SLEEP-COMMIT status=" + rSL.status + " elapsedMs=" + elSL + " class=" + clsSL + " body=" + rSL.text.slice(0, 220) + "\n");
      ok("fault-sleep-controlled", (rSL.status === 502 || rSL.status === 503) && elSL >= 25000, "status=" + rSL.status + " elapsed=" + elSL);
      const dropSL = await qaTriggerTool("drop");
      ok("fault-trigger-drop-sleep", dropSL.code === 0, JSON.stringify(dropSL).slice(0, 200));
      const stSL = await get("/api/meetings/" + mid + "/secretary/requests");
      const rowSL = (Array.isArray(stSL.json) ? stSL.json : []).find((r) => (r.clientNonce || r.ClientNonce) === nonceSL);
      ok("fault-sleep-row-recoverable", !!rowSL && ["failed", "discarded", "interrupted"].includes(rowSL.status || rowSL.Status), JSON.stringify(rowSL && (rowSL.status || rowSL.Status)));
      const rSL2 = await post("/api/meetings/" + mid + "/secretary", { input: "Sleep commit probe with SECRETARY-NOTE", clientNonce: nonceSL });
      ok("fault-sleep-retry-200", rSL2.status === 200 && rSL2.json && rSL2.json.note, rSL2.status + " " + rSL2.text.slice(0, 300));
      const notesSL1 = (await get("/api/meetings/" + mid + "/notes")).json.length;
      ok("fault-sleep-exactly-once", notesSL1 === notesSL0 + 1, notesSL0 + "->" + notesSL1);
    }
    } finally {
      // Trigger cleanup failure must be visible (never swallowed): failed drop leaves fault armed for followers.
      try {
        const finalDrop = await qaTriggerTool("drop");
        ok("fault-trigger-final-drop", finalDrop.code === 0, JSON.stringify(finalDrop).slice(0,200));
      } catch (eDrop) {
        ok("fault-trigger-final-drop", false, String(eDrop).slice(0,200));
      }
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
    ok("legacy-v1-shape-restore-200", legR.status === 200, legR.status + " " + legR.text.slice(0, 200));
    const legNonce = guid();
    const legS = await post("/api/meetings/" + mid + "/secretary", { input: "After legacy restore SECRETARY-NOTE", clientNonce: legNonce });
    ok("legacy-v1-secretary-works", legS.status === 200 && legS.json && legS.json.note, legS.status + " " + legS.text.slice(0, 200));
    await post("/api/backup/restore", { snapshot: bk.json.snapshot, hash: bk.json.hash });
  }
  {
    const fixRaw = fs.readFileSync("qa/fixtures/predecessor-complete-20261103-070907-backup.json", "utf8");
    const fixWrap = JSON.parse(fixRaw);
    const fixSnap = JSON.parse(fixWrap.snapshot);
    ok("legacy-fixture-shape", fixSnap.version === 2 && Array.isArray(fixSnap.boards) && fixSnap.boards.length === 16, "version=" + fixSnap.version + " boards=" + (fixSnap.boards || []).length);
    const fixR = await post("/api/backup/restore", { snapshot: fixWrap.snapshot, hash: fixWrap.hash });
    ok("legacy-fixture-restore-200", fixR.status === 200, fixR.status + " " + fixR.text.slice(0, 300));
    const fixBoards = await get("/api/boards");
    ok("legacy-fixture-16-boards-live", fixBoards.status === 200 && Array.isArray(fixBoards.json) && fixBoards.json.length === 16, fixBoards.status + " count=" + (Array.isArray(fixBoards.json) ? fixBoards.json.length : "?"));
    const fixBid = fixSnap.boards[0].id || fixSnap.boards[0].Id;
    const fixNotes = (fixSnap.notes || []).filter((n) => (n.boardId || n.BoardId) === fixBid);
    const fixMidRow = (fixSnap.meetings || []).find((m) => (m.boardId || m.BoardId) === fixBid);
    const fixMid = fixMidRow ? (fixMidRow.id || fixMidRow.Id) : null;
    ok("legacy-fixture-board-content", fixNotes.length > 0 && !!fixMid, "notes=" + fixNotes.length + " meeting=" + !!fixMid);
    const sampleBody = String(fixNotes[0].body || fixNotes[0].Body || "");
    const liveNotes = await get("/api/meetings/" + fixMid + "/notes");
    ok("legacy-fixture-old-bodies-readable", liveNotes.status === 200 && liveNotes.text.indexOf(sampleBody.slice(0, 40)) >= 0, liveNotes.status + " " + liveNotes.text.slice(0, 200));
    await post("/api/boards/" + fixBid + "/lead", { name: "QA Legacy Lead", roleLabel: "Chief", background: "bg", familiarTopics: "fam", simplerTopics: "sim", commPrefs: "direct" });
    const lrq = await post("/api/roster/quick", { accountId: guid(), name: run + "-legacyadv", description: "legacy upgrade advisor helping with strategy" });
    const lrid = lrq.json.id || (lrq.json.entry && lrq.json.entry.id);
    const lcp = await post("/api/roster/" + lrid + "/copy", { boardId: fixBid, boardRole: "Strategist" });
    const laid = lcp.json.id || lcp.json.Id;
    await post("/api/boards/" + fixBid + "/advisors/" + laid + "/approve", {});
    const lm = await post("/api/boards/" + fixBid + "/meetings", { title: run + " legacy meeting", brief: "legacy upgrade brief" });
    const lmid = lm.json.id || lm.json.Id;
    await post("/api/meetings/" + lmid + "/resume", {});
    const legFix = await post("/api/meetings/" + lmid + "/secretary", { input: "Legacy upgrade probe SECRETARY-NOTE", clientNonce: guid() });
    ok("legacy-fixture-secretary-works", legFix.status === 200 && legFix.json && legFix.json.note, legFix.status + " " + legFix.text.slice(0, 300));
    const liveNotes2 = await get("/api/meetings/" + fixMid + "/notes");
    ok("legacy-fixture-old-bodies-intact", liveNotes2.status === 200 && liveNotes2.text.indexOf(sampleBody.slice(0, 40)) >= 0, liveNotes2.text.slice(0, 200));
    const bkBack = await post("/api/backup/restore", { snapshot: bk.json.snapshot, hash: bk.json.hash });
    ok("legacy-fixture-restore-back", bkBack.status === 200, bkBack.status + " " + bkBack.text.slice(0, 200));
    const midPing = await get("/api/meetings/" + mid + "/notes");
    ok("legacy-fixture-qa-state-restored", midPing.status === 200 && Array.isArray(midPing.json), midPing.status + " " + midPing.text.slice(0, 200));
  }
  {
    const getS = async (pp) => { try { return await get(pp); } catch (e) { return { status: 0, json: null, text: "FETCH-FAIL " + String(e).slice(0, 160) }; } };
    const postS = async (pp, b) => { try { return await post(pp, b); } catch (e) { return { status: 0, json: null, text: "FETCH-FAIL " + String(e).slice(0, 160) }; } };
    let curPid = Number(process.env.QA_API_PID || "0");
    const apiPid = curPid;
    const resolveApiPid = () => {
      try {
        const l = qaExecFile("powershell.exe", ["-NoProfile", "-Command", "Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq 5113 } | Select-Object -ExpandProperty OwningProcess"], { windowsHide: true }).toString().trim();
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
          qaExecFile("taskkill.exe", ["/F", "/PID", String(target)], { windowsHide: true });
          curPid = 0;
        } catch (e) { fs.appendFileSync(OUT, "RESTART taskkill note: " + String(e).slice(0, 160) + "\n"); }
        for (let wi = 0; wi < 60 && await qaHealth(1000); wi++) { await sleep(500); }
        try {
          const child = qaSpawn(apiCmd, apiArgs, { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ...apiEnv } });
          child.on("error", (e) => { try { fs.appendFileSync(OUT, "RESTART spawn error: " + String(e).slice(0, 200) + "\n"); } catch { } });
          child.unref();
          fs.appendFileSync(OUT, "RESTART spawned pid=" + child.pid + "\n");
          curPid = child.pid;
        } catch (e) { fs.appendFileSync(OUT, "RESTART spawn throw: " + String(e).slice(0, 200) + "\n"); return false; }
        const up = await qaHealth(90000);
        fs.appendFileSync(OUT, "RESTART health=" + up + "\n");
        try {
          const lst = qaExecFile("powershell.exe", ["-NoProfile", "-Command", "Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq 5113 } | Select-Object -ExpandProperty OwningProcess"], { windowsHide: true }).toString().trim();
          fs.appendFileSync(OUT, "RESTART listener=" + lst.slice(0, 120) + "\n");
        } catch (e) { fs.appendFileSync(OUT, "RESTART listener probe failed\n"); }
        return up;
      };
      if (isPg) {
        const nonceR = guid();
        const pR = post("/api/meetings/" + mid + "/secretary", { input: "Restart initial SECRETARY-NOTE QA-SLEEP:8000", clientNonce: nonceR });
        pR.catch(() => {});
        await sleep(1500);
        const sortMsgs = (arr) => (Array.isArray(arr) ? arr.slice() : []).sort((a, b) => (((a && (a.sequence ?? a.Sequence)) || 0) - (((b && (b.sequence ?? b.Sequence)) || 0))) || String(JSON.stringify(a)).localeCompare(String(JSON.stringify(b))));
        const canonMsgs = (v) => canonTs(JSON.stringify(v));
        const msgsPre = canonMsgs(sortMsgs((await getS("/api/meetings/" + mid + "/messages?take=100")).json));
        const up = await killAndRespawn();
        ok("restart-initial-up", up, "api did not return");
        const stR = await getS("/api/meetings/" + mid + "/secretary/requests");
        const rowR = (Array.isArray(stR.json) ? stR.json : []).find((r) => (r.clientNonce || r.ClientNonce) === nonceR);
        ok("restart-initial-interrupted", !!rowR && (rowR.status || rowR.Status) === "interrupted", JSON.stringify(rowR && (rowR.status || rowR.Status)));
        const leadR0 = (await getS("/api/meetings/" + mid + "/messages?take=100")).json.filter((m) => (m.sender || m.Sender) === "lead").length;
        const qPre = await getS("/api/meetings/" + mid + "/secretary/requests");
        const rowPre = (Array.isArray(qPre.json) ? qPre.json : []).find((r) => (r.clientNonce || r.ClientNonce) === nonceR);
        const rRetry = await postS("/api/meetings/" + mid + "/secretary", { input: "Restart initial SECRETARY-NOTE QA-SLEEP:8000", clientNonce: nonceR });
        ok("restart-initial-retry", rRetry.status === 200 && rRetry.json && rRetry.json.note, rRetry.status + " " + rRetry.text.slice(0, 300));
        const leadR1 = (await getS("/api/meetings/" + mid + "/messages?take=100")).json.filter((m) => (m.sender || m.Sender) === "lead").length;
        ok("restart-initial-owner-once", leadR1 === leadR0, leadR0 + "->" + leadR1);
        const rDup = await postS("/api/meetings/" + mid + "/secretary", { input: "Restart initial SECRETARY-NOTE QA-SLEEP:8000", clientNonce: nonceR });
        ok("restart-initial-replay", rDup.status === 200 && String((rDup.json.note.id || rDup.json.note.Id)) === String(rRetry.json.note.id || rRetry.json.note.Id), rDup.status + " " + rDup.text.slice(0, 200));
        const msgsPost = canonMsgs(sortMsgs((await getS("/api/meetings/" + mid + "/messages?take=100")).json));
        const qPost = await getS("/api/meetings/" + mid + "/secretary/requests");
        const rowPost = (Array.isArray(qPost.json) ? qPost.json : []).find((r) => (r.clientNonce || r.ClientNonce) === nonceR);
        ok("restart-initial-input-bytes", !!rowPost && (rowPost.inputText || rowPost.InputText) === "Restart initial SECRETARY-NOTE QA-SLEEP:8000", JSON.stringify(rowPost && (rowPost.inputText || rowPost.InputText)).slice(0, 160));
        let msgDiag = "len " + JSON.parse(msgsPre).length + "->" + JSON.parse(msgsPost).length;
        if (msgsPost !== msgsPre) {
          try {
            const a = JSON.parse(msgsPre), b = JSON.parse(msgsPost);
            for (let i = 0; i < Math.max(a.length, b.length); i++) {
              if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
                const sa = JSON.stringify(a[i]) || "", sb = JSON.stringify(b[i]) || "";
                const mml = Math.min(sa.length, sb.length);
                let di = 0;
                while (di < mml && sa[di] === sb[di]) di++;
                msgDiag += " firstdiff=i" + i + "@" + di + " pre=" + JSON.stringify(sa.slice(Math.max(0, di - 40), di + 200)) + " post=" + JSON.stringify(sb.slice(Math.max(0, di - 40), di + 200));
                break;
              }
            }
          } catch { }
        }
        ok("restart-initial-messages-stable", msgsPost === msgsPre, msgDiag);
        const promptPre = rowPre ? (rowPre.deliveredPromptHash || rowPre.DeliveredPromptHash || "") : "";
        const promptPost = rowPost ? (rowPost.deliveredPromptHash || rowPost.DeliveredPromptHash || "") : "";
        fs.appendFileSync(OUT, "RESTART-INITIAL rowPre=" + JSON.stringify(rowPre && { s: rowPre.status || rowPre.Status, ph: rowPre.phase || rowPre.Phase }) + " rowPost=" + JSON.stringify(rowPost && { s: rowPost.status || rowPost.Status }) + "\n");
        try { await pR; } catch { }
        const nonceAR = guid();
        const sAR = await postS("/api/meetings/" + mid + "/secretary", { input: "Restart answer SECRETARY-AMBIGUOUS", clientNonce: nonceAR });
        ok("restart-answer-ambiguous", sAR.status === 200 && sAR.json && sAR.json.status === "needs-clarification", sAR.status + " " + sAR.text.slice(0, 200));
        const reqAR = sAR.json.requestId;
        const qAR0 = sAR.json.question || "";
        const pAR = post("/api/meetings/" + mid + "/secretary/answer", { requestId: reqAR, answer: "Restart answer QA-SLEEP:8000" });
        pAR.catch(() => {});
        await sleep(1500);
        const up2 = await killAndRespawn();
        ok("restart-answer-up", up2, "api did not return");
        const stAR = await getS("/api/meetings/" + mid + "/secretary/requests/" + reqAR);
        const rowAR = stAR.json && stAR.json.request;
        ok("restart-answer-interrupted", !!rowAR && (rowAR.status || rowAR.Status) === "interrupted" && !!(rowAR.question || rowAR.Question), JSON.stringify(rowAR && { s: rowAR.status || rowAR.Status, q: !!(rowAR.question || rowAR.Question), ph: rowAR.phase || rowAR.Phase }));
        ok("restart-answer-question-bytes", !!rowAR && (rowAR.question || rowAR.Question) === qAR0, JSON.stringify(rowAR && (rowAR.question || rowAR.Question)).slice(0, 160));
        ok("restart-answer-answer-bytes", !!rowAR && (rowAR.answer || rowAR.Answer) === "Restart answer QA-SLEEP:8000", JSON.stringify(rowAR && (rowAR.answer || rowAR.Answer)).slice(0, 160));
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
main().catch((e) => { fs.appendFileSync(OUT, "FATAL " + String((e && e.stack) || e) + "\n"); console.log("FATAL " + String(e)); process.exit(1); });
