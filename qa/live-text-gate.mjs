// SimCEO live generated-text acceptance gate (phases 1-3, Meta real text only).
// Bounded real-provider check, separate from deterministic fake-provider QA.
// Default QA_API http://127.0.0.1:5110; REFUSES :5080/:5099/:5100 (fake/dev).
// Requires LIVE_TEXT_GATE=1. Never reads/prints secrets; key is launcher/API-side only.
// Unique account/run boards; strict fails exit nonzero; 120s/call, bounded total.
// No screenshots, no image generation, no GPU, no external publish/commit.
// Contract ref: WizardGuide interview (analysis/updates/nextQuestion + ApplyFieldUpdate keys),
// Roster research (3 research calls; searched==usable grounded angles 1..3, supported, claims+refs+3 responseIds),
// Discussion run (approved QA/synthetic brief fixture only -> bids+replies -> committed advisor message; second run yields, no duplicate),
// Ops ledger (/api/models/calls + /api/usage real IDs, cost/tokens, budget <=12).
// Run (after main QA barrier, launcher holds the key):
//   LIVE_TEXT_GATE=1 QA_API=http://127.0.0.1:5110 node qa/live-text-gate.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const API = process.env.QA_API || "http://127.0.0.1:5110";
for (const bad of [":5080", ":5099", ":5100"]) {
  if (API.includes(bad)) {
    console.error("REFUSE " + bad.slice(1) + ": live-text-gate must not run against fake/dev ports; use QA_API=http://127.0.0.1:5110.");
    process.exit(2);
  }
}
if (process.env.LIVE_TEXT_GATE !== "1") {
  console.error("REFUSE: set LIVE_TEXT_GATE=1 to execute the bounded live Meta text gate.");
  process.exit(2);
}

const CALL_TIMEOUT = 120000;
const OVERALL_BUDGET_MS = 480000;
const MAX_PROVIDER_CALLS = 12;
const startedAt = Date.now();

const run = "live-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
const ACCT = crypto.randomUUID();
let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else {
    fail++;
    failures.push(name + (extra ? " :: " + extra : ""));
    console.log("  FAIL " + name + (extra ? " :: " + extra : ""));
  }
}
function elapsed() { return Date.now() - startedAt; }
function checkOverall(name) {
  ok(name + "-within-overall-budget", elapsed() < OVERALL_BUDGET_MS, elapsed() + "ms");
}
async function req(method, p, body, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || CALL_TIMEOUT);
  try {
    const r = await fetch(API + p, {
      method,
      signal: ctl.signal,
      headers: { "content-type": "application/json", "x-user": "owner", ...(opts.headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: "transport-failure: " + (e && e.name ? e.name : "error") + " " + (e && e.message ? e.message : "") };
  } finally { clearTimeout(t); }
}
const get = (p, o) => req("GET", p, undefined, o);
const post = (p, b, o) => req("POST", p, b, o);
function camel(o, k) {
  if (!o || typeof o !== "object") return undefined;
  if (k in o) return o[k];
  const lo = String(k).toLowerCase();
  for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key];
  return undefined;
}
function pick(o, ...keys) {
  for (const k of keys) { const v = camel(o, k); if (v !== undefined) return v; }
  return undefined;
}
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAKE_RX = /qa-chat|qa-resp|qa\.example|fakeqa|QA provisional|QA advisor reply/i;
const FALLBACK_RX = /Recorded\.|usage-capped|unparsed-model-output|guide model is unavailable|guide is paused|retry later/i;
function hasFake(s) { return typeof s === "string" && FAKE_RX.test(s); }
function hasFallback(s) { return typeof s === "string" && FALLBACK_RX.test(s); }
function trunc(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) : s; }
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
async function uploadPortrait(rosterId) {
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "live.png");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), CALL_TIMEOUT);
  try {
    const r = await fetch(API + "/api/roster/" + rosterId + "/image/upload", {
      method: "POST", signal: ctl.signal, headers: { "x-user": "owner" }, body: form,
    });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: "transport-failure: " + (e && e.message ? e.message : "") };
  } finally { clearTimeout(t); }
}
async function uploadBrief(boardId, filename, text) {
  // Normal board-sources upload path (multipart FormData, like uploadPortrait).
  // Plain .txt is read directly server-side; no extractor, no model call.
  const form = new FormData();
  form.append("file", new Blob([text], { type: "text/plain" }), filename);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), CALL_TIMEOUT);
  try {
    const r = await fetch(API + "/api/boards/" + boardId + "/sources/upload", {
      method: "POST", signal: ctl.signal, headers: { "x-user": "owner" }, body: form,
    });
    const text2 = await r.text();
    let json = null; try { json = text2 ? JSON.parse(text2) : null; } catch { json = null; }
    return { status: r.status, json, text: text2 };
  } catch (e) {
    return { status: 0, json: null, text: "transport-failure: " + (e && e.message ? e.message : "") };
  } finally { clearTimeout(t); }
}
async function modelCalls() {
  const r = await get("/api/models/calls");
  ok("calls-readable", r.status === 200 && Array.isArray(r.json), r.status + " " + trunc(r.text, 160));
  return Array.isArray(r.json) ? r.json : [];
}
function callIds(list) { return new Set(list.map((c) => String(pick(c, "id") || ""))); }

console.log("live-text-gate run=" + run + " api=" + API);

const baseCalls = await modelCalls();
const baseIds = callIds(baseCalls);
checkOverall("startup");

// ---------- (a) versioned wizard interview: real answer persists, extracts mission ----------
console.log("gate-a: wizard interview (real generated text)");
const wizAnswer = "Our company is Harborline Logistics; our mission is to cut last-mile delivery costs by 20 percent in 2026 for regional grocers.";
let wizId = null;
{
  const w = await post("/api/wizard", {
    accountId: ACCT, step: 1, presetKey: "",
    fieldsJson: JSON.stringify({ name: run + "-livewiz", mission: "", stage: "forming", lead: { name: "QA Lead" }, advisors: [{ role: "Strategist", name: "" }] }),
  });
  ok("wizard-draft-200", w.status === 200 && pick(w.json, "id"), w.status + " " + trunc(w.text, 200));
  wizId = pick(w.json, "id");
  if (wizId) {
    const g0 = await get("/api/wizard/" + wizId);
    const v0 = pick(g0.json, "version");
    ok("wizard-version-present", typeof v0 === "number" && v0 > 0, trunc(g0.text, 200));
    if (typeof v0 === "number") {
      const iv = await post("/api/wizard/" + wizId + "/interview", { answer: wizAnswer, version: v0 });
      ok("wizard-interview-200", iv.status === 200, iv.status + " " + trunc(iv.text, 240));
      if (iv.status === 200 && iv.json) {
        const extractOk = pick(iv.json, "extractOk");
        const extractError = pick(iv.json, "extractError");
        const analysis = String(pick(iv.json, "analysis") || "");
        const question = String(pick(iv.json, "question") || pick(iv.json, "pendingQuestion") || pick(iv.json, "nextQuestion") || "");
        const applied = pick(iv.json, "applied") || [];
        ok("wizard-no-provider-outage", iv.status !== 503 && iv.status !== 502, trunc(iv.text, 200));
        ok("wizard-extractOk-true", extractOk === true, "extractOk=" + JSON.stringify(extractOk) + " err=" + JSON.stringify(extractError));
        ok("wizard-no-fallback", !extractError && !hasFallback(analysis), "err=" + JSON.stringify(extractError) + " analysis=" + trunc(analysis, 160));
        ok("wizard-analysis-concrete", analysis.trim().length >= 20 && analysis.includes(" ") && !hasFake(analysis), trunc(analysis, 200));
        ok("wizard-nextQuestion-concrete", question.trim().length >= 10 && !hasFake(question), trunc(question, 200));
        const appliedLow = Array.isArray(applied) ? applied.map((a) => String(a).toLowerCase()) : [];
        ok("wizard-applied-nonempty", Array.isArray(applied) && applied.length > 0, JSON.stringify(applied).slice(0, 240));
        ok("wizard-applied-mission", appliedLow.includes("mission"), JSON.stringify(applied).slice(0, 240));
      } else {
        ok("wizard-interview-shape", false, trunc(iv.text, 240));
      }
      const g1 = await get("/api/wizard/" + wizId);
      const v1 = pick(g1.json, "version");
      ok("wizard-version-bumped", typeof v1 === "number" && typeof v0 === "number" && v1 > v0, "v0=" + v0 + " v1=" + v1);
      const ijRaw = String(pick(g1.json, "interviewJson") || "");
      ok("wizard-answer-persisted-exact", ijRaw.includes(wizAnswer), trunc(ijRaw, 240));
      try {
        const ij = ijRaw ? JSON.parse(ijRaw) : null;
        const turns = (ij && ij.turns) || (ij && ij.Turns) || [];
        const last = Array.isArray(turns) && turns.length > 0 ? turns[turns.length - 1] : null;
        const lastAns = last ? String(last.answer || last.Answer || "") : "";
        ok("wizard-turn-answer-exact", lastAns === wizAnswer, trunc(lastAns, 200));
      } catch { ok("wizard-turn-answer-exact", false, "interviewJson unparseable"); }
    }
  }
}
checkOverall("gate-a");

// ---------- (b) grounded historical dossier: Grace Hopper, one endpoint = 3 provider requests ----------
console.log("gate-b: grounded dossier (Grace Hopper)");
let dossier = null;
{
  const q = await post("/api/roster/quick", { accountId: ACCT, name: "Grace Hopper", description: "Historical dossier probe for Grace Hopper for " + run });
  ok("hopper-quick-201", q.status === 201 && pick(q.json, "id"), q.status + " " + trunc(q.text, 200));
  const rid = pick(q.json, "id");
  if (rid) {
    const focus = "Grace Hopper identity: US Navy rear admiral, COBOL and compiler pioneer, key dates and contributions. Return factual claims with sources.";
    const resCallsBefore = callIds(await modelCalls());
    const r = await post("/api/roster/" + rid + "/research", { focus });
    ok("hopper-research-200", r.status === 200, r.status + " " + trunc(r.text, 240));
    ok("hopper-no-provider-outage", r.status !== 503 && r.status !== 502, trunc(r.text, 200));
    dossier = r.json || null;
    if (r.status === 200 && dossier) {
      const searched = pick(dossier, "searched");
      const supported = pick(dossier, "supported");
      const claims = pick(dossier, "claims") || [];
      const responseIds = pick(dossier, "responseIds") || pick(dossier, "responseids") || [];
      const evidenceRefs = pick(dossier, "evidenceRefs") || pick(dossier, "evidencerefs") || [];
      ok("hopper-supported", supported === true, "supported=" + JSON.stringify(supported));
      ok("hopper-searched-usable-angles", Number.isInteger(searched) && searched >= 1 && searched <= 3, "searched=" + JSON.stringify(searched) + " (usable grounded angles, not request count)");
      ok("hopper-claims-nonempty", Array.isArray(claims) && claims.length > 0, "claims=" + (Array.isArray(claims) ? claims.length : typeof claims));
      ok("hopper-responseIds-3-real", Array.isArray(responseIds) && responseIds.length === 3 && responseIds.every((id) => typeof id === "string" && id.length >= 8 && !/^qa-/i.test(id) && !/fakeqa/i.test(id)) && new Set(responseIds).size === 3, JSON.stringify(responseIds).slice(0, 240));
      const resCallsAfter = await modelCalls();
      const freshRes = resCallsAfter.filter((c) => !resCallsBefore.has(String(pick(c, "id") || "")));
      const resOnly = freshRes.filter((c) => String(pick(c, "purpose") || "") === "advisor-research");
      ok("hopper-research-calls-3", resOnly.length === 3, "researchCalls=" + resOnly.length);
      const resNotes = resOnly.map((c) => String(pick(c, "note") || pick(c, "searchNote") || ""));
      ok("hopper-research-calls-completed", resOnly.length === 3 && resNotes.every((n) => /status completed/i.test(n)), trunc(resNotes.join(" | ").slice(0, 240), 240));
      const ledgerResIds = resNotes.map((n) => { const m = /response\s+(resp_\S+?)[;\s]/.exec(n); return m ? m[1] : ""; }).filter((s) => s.length > 0);
      ok("hopper-research-ids-match", ledgerResIds.length === 3 && Array.isArray(responseIds) && responseIds.length === 3 && ledgerResIds.every((id) => responseIds.includes(id)) && new Set([...ledgerResIds, ...responseIds]).size === 3, JSON.stringify(ledgerResIds).slice(0, 240));
      const refUrls = [];
      const refExcerpts = [];
      let allHaveRefs = true;
      if (Array.isArray(claims)) {
        for (const c of claims) {
          const refs = pick(c, "refs") || [];
          if (!Array.isArray(refs) || refs.length === 0) { allHaveRefs = false; break; }
          for (const rf of refs) {
            const u = String(pick(rf, "url") || pick(rf, "ref") || "");
            const ex = String(pick(rf, "excerpt") || "");
            if (/^https?:\/\//i.test(u)) refUrls.push(u);
            if (ex.trim().length >= 10) refExcerpts.push(ex);
          }
          const txt = String(pick(c, "text") || "");
          if (hasFake(txt)) { allHaveRefs = false; break; }
        }
      }
      ok("hopper-perclaim-refs", allHaveRefs, "claims=" + (Array.isArray(claims) ? claims.length : "?"));
      const distinctUrls = [...new Set(refUrls)];
      const extraUrls = Array.isArray(evidenceRefs) ? evidenceRefs.map((e) => String(pick(e, "url") || pick(e, "ref") || "")).filter((u) => /^https?:\/\//i.test(u)) : [];
      const allUrls = [...new Set([...distinctUrls, ...extraUrls])];
      ok("hopper-sources-urls", allUrls.length >= 2, JSON.stringify(allUrls.slice(0, 4)).slice(0, 300));
      ok("hopper-excerpts-nonempty", refExcerpts.length >= 2, "excerpts=" + refExcerpts.length);
      const excerptUrlSet = new Set();
      if (Array.isArray(claims)) {
        for (const c of claims) {
          const refs = pick(c, "refs") || [];
          if (!Array.isArray(refs)) continue;
          for (const rf of refs) {
            const u = String(pick(rf, "url") || pick(rf, "ref") || "");
            const ex = String(pick(rf, "excerpt") || "");
            if (/^https?:\/\//i.test(u) && ex.trim().length >= 10) excerptUrlSet.add(u.toLowerCase());
          }
        }
      }
      ok("hopper-distinct-excerpt-url", excerptUrlSet.size >= 1, "excerptUrls=" + excerptUrlSet.size);
      try {
        fs.mkdirSync(path.join(process.cwd(), ".tmp"), { recursive: true });
        const bounded = {
          run, subject: "Grace Hopper", searched, supported,
          responseIds: (Array.isArray(responseIds) ? responseIds : []).slice(0, 3),
          claimCount: Array.isArray(claims) ? claims.length : 0,
          claims: (Array.isArray(claims) ? claims : []).slice(0, 12).map((c) => ({
            angle: trunc(pick(c, "angle") || "", 160),
            text: trunc(pick(c, "text") || "", 500),
            refs: (Array.isArray(pick(c, "refs")) ? pick(c, "refs") : []).slice(0, 3).map((rf) => ({
              url: trunc(pick(rf, "url") || pick(rf, "ref") || "", 300),
              title: trunc(pick(rf, "title") || "", 200),
              excerpt: trunc(pick(rf, "excerpt") || "", 300),
            })),
          })),
          citations: allUrls.slice(0, 10),
        };
        fs.writeFileSync(path.join(process.cwd(), ".tmp", "live-text-gate-evidence.json"), JSON.stringify(bounded, null, 2));
        ok("hopper-evidence-saved", true);
      } catch (e) { ok("hopper-evidence-saved", false, String(e && e.message ? e.message : e)); }
    }
  }
}
checkOverall("gate-b");

// ---------- (c) fictional advisor lifecycle + discussion run, no auto-record, no duplicate on repeat ----------
console.log("gate-c: fictional advisor + discussion");
let mid = null;
let committedCountBefore = -1;
{
  const b = await post("/api/boards", { name: run + "-liveboard", mission: "Cut last-mile delivery costs by 20 percent in 2026 for regional grocers; balance warehouse staffing, route density, and cold-chain reliability for " + run, stage: "qa" });
  ok("live-board-201", b.status === 201 && pick(b.json, "id"), b.status + " " + trunc(b.text, 200));
  const bid = pick(b.json, "id");
  if (bid) {
    const lead = await post("/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Chief", background: "bg", familiarTopics: "fam", simplerTopics: "sim", commPrefs: "blunt" });
    ok("live-lead-200", lead.status === 200, lead.status + " " + trunc(lead.text, 200));
    const callsBeforeQuick = (await modelCalls()).length;
    const qf = await post("/api/roster/quick", { accountId: ACCT, name: run + "-fic", description: "Fictional strategist specializing in regional grocer last-mile logistics tradeoffs: route density vs delivery cost, warehouse staffing, cold-chain risk for " + run });
    ok("live-quick-201", qf.status === 201 && pick(qf.json, "id"), qf.status + " " + trunc(qf.text, 200));
    const rid = pick(qf.json, "id");
    const callsAfterQuick = (await modelCalls()).length;
    ok("live-quick-no-provider-call", callsAfterQuick === callsBeforeQuick, "before=" + callsBeforeQuick + " after=" + callsAfterQuick);
    if (rid) {
      const up = await uploadPortrait(rid);
      ok("live-portrait-upload-201", up.status === 201, up.status + " " + trunc(up.text, 200));
      const imgs = await get("/api/roster/" + rid + "/images");
      const imgId = Array.isArray(imgs.json) && imgs.json.length > 0 ? pick(imgs.json[0], "id") : undefined;
      ok("live-image-listed", !!imgId, trunc(imgs.text, 200));
      if (imgId) {
        const rev = await post("/api/images/" + imgId + "/review", { decision: "accept" });
        ok("live-portrait-accept-200", rev.status === 200, rev.status + " " + trunc(rev.text, 200));
        const cp = await post("/api/roster/" + rid + "/copy", { boardId: bid, boardRole: "Strategist" });
        ok("live-copy-201", cp.status === 201 && pick(cp.json, "id"), cp.status + " " + trunc(cp.text, 200));
        const aid = pick(cp.json, "id");
        if (aid) {
          const ap = await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
          ok("live-approve-200", ap.status === 200, ap.status + " " + trunc(ap.text, 200));
          const briefFile = "live-qa-brief-" + run + ".txt";
          const briefText = [
            "QA SYNTHETIC FIXTURE BRIEF - not real research, live-gate fixture only for " + run + ".",
            "Harborline QA network, two options:",
            "OPT1 Route 9 (dense suburbs): 42 stops at about $3.10/stop. Consolidation merges 6 low-density legs; needs 2 extra sorters at Mercer depot.",
            "OPT2 Route 17 (rural): 11 stops with a 38-mile deadhead at about $6.80/stop. Reefer unit R-3 fails above 30C ambient; ice-cream pallets must hold -18C.",
            "Staffing: Mercer depot has 6 drivers averaging 2 callouts/week; night sort ends 2 a.m.",
            "Goal: cut last-mile costs 20 percent in 2026 without a cold-chain breach.",
          ].join("\n");
          const callsBeforeBrief = (await modelCalls()).length;
          const ub = await uploadBrief(bid, briefFile, briefText);
          ok("live-brief-upload-201", ub.status === 201 && pick(ub.json, "id"), ub.status + " " + trunc(ub.text, 200));
          const briefId = pick(ub.json, "id");
          if (briefId) {
            const ba = await post("/api/sources/" + briefId + "/approve", {});
            ok("live-brief-approve-200", ba.status === 200 && pick(ba.json, "approved") === true && pick(ba.json, "excluded") === false, ba.status + " " + trunc(ba.text, 200));
            const ctx = await get("/api/boards/" + bid + "/context");
            ok("live-brief-in-context", ctx.status === 200 && Number(pick(ctx.json, "approved")) >= 1, ctx.status + " " + trunc(ctx.text, 200));
          } else {
            ok("live-brief-approve-200", false, "no brief id");
            ok("live-brief-in-context", false, "no brief id");
          }
          const callsAfterBrief = (await modelCalls()).length;
          ok("live-brief-no-provider-call", callsAfterBrief === callsBeforeBrief, "before=" + callsBeforeBrief + " after=" + callsAfterBrief);
          const m = await post("/api/boards/" + bid + "/meetings", { title: run + " mtg", brief: "live gate brief; approved QA synthetic brief: " + briefFile });
          ok("live-meeting-201", m.status === 201 && pick(m.json, "id"), m.status + " " + trunc(m.text, 200));
          mid = pick(m.json, "id");
          if (mid) {
            const human = "Live gate question " + run + " (QA synthetic fixture, not real research): using approved brief " + briefFile + ", compare Route 9 density consolidation vs Route 17 reefer R-3 replacement - which protects the 20 percent cost-cut goal with less cold-chain risk, and what Mercer staffing tradeoff decides it? Cite [source:" + briefFile + "] where used.";
            const hm = await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: human });
            ok("live-human-message-200", hm.status === 200 || hm.status === 201, hm.status + " " + trunc(hm.text, 200));
            const r1 = await post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: human });
            ok("live-run-200", r1.status === 200, r1.status + " " + trunc(r1.text, 240));
            ok("live-run-no-outage", r1.status !== 503 && r1.status !== 502, trunc(r1.text, 200));
            const published = pick(r1.json, "published") || [];
            ok("live-run-published", Array.isArray(published) && published.length >= 1, "published=" + (Array.isArray(published) ? published.length : typeof published));
            const msgs = await get("/api/meetings/" + mid + "/messages?take=100");
            const list = Array.isArray(msgs.json) ? msgs.json : [];
            const advMsgs = list.filter((mm) => {
              const aid2 = String(pick(mm, "advisorId") || "");
              const sender = String(pick(mm, "sender") || "");
              return (aid2 && aid2 !== "00000000-0000-0000-0000-000000000000") || sender.toLowerCase() === "advisor";
            });
            const committed = advMsgs.filter((mm) => String(pick(mm, "content") || pick(mm, "body") || "").trim().length >= 20);
            ok("live-committed-reply-nonempty", committed.length >= 1, "advisorMsgs=" + advMsgs.length);
            if (committed.length >= 1) {
              const body0 = String(pick(committed[0], "content") || pick(committed[0], "body") || "");
              ok("live-reply-no-fake-markers", body0.trim().length >= 20 && !hasFake(body0), trunc(body0, 200));
              ok("live-reply-brief-grounded", body0.includes("Route 9") && body0.includes("Route 17"), trunc(body0, 200));
              ok("live-reply-cites-source", /\[source:/i.test(body0), trunc(body0, 200));
            }
            committedCountBefore = list.length;
            const recs = await get("/api/meetings/" + mid + "/records");
            ok("live-no-auto-record", recs.status === 200 && Array.isArray(recs.json) && recs.json.length === 0, recs.status + " " + trunc(recs.text, 200));
            const r2 = await post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: human });
            ok("live-rerun-200", r2.status === 200, r2.status + " " + trunc(r2.text, 240));
            const pub2 = pick(r2.json, "published") || [];
            ok("live-rerun-no-duplicate", Array.isArray(pub2) && pub2.length === 0, "published=" + (Array.isArray(pub2) ? pub2.length : "?"));
            const msgs2 = await get("/api/meetings/" + mid + "/messages?take=100");
            const list2 = Array.isArray(msgs2.json) ? msgs2.json : [];
            ok("live-rerun-no-new-messages", list2.length === committedCountBefore, "before=" + committedCountBefore + " after=" + list2.length);
          }
        }
      }
    }
  }
}
checkOverall("gate-c");

// ---------- (d) ledger: real IDs, relevant purposes, cost/tokens, total budget <=12 ----------
console.log("gate-d: model ledger + usage");
{
  const calls = await modelCalls();
  const fresh = calls.filter((c) => !baseIds.has(String(pick(c, "id") || "")));
  ok("ledger-has-new-calls", fresh.length >= 5, "new=" + fresh.length);
  ok("ledger-total-within-12", fresh.length <= MAX_PROVIDER_CALLS, "new=" + fresh.length);
  let idsReal = true;
  let purposesReal = true;
  for (const c of fresh) {
    const id = String(pick(c, "id") || "");
    const note = String(pick(c, "note") || pick(c, "searchNote") || "");
    if (!UUID_RX.test(id) || hasFake(id) || hasFake(note)) { idsReal = false; break; }
  }
  ok("ledger-ids-real-nonfake", idsReal, trunc(JSON.stringify(fresh.map((c) => pick(c, "id"))), 240));
  const purposes = new Set(fresh.map((c) => String(pick(c, "purpose") || "")));
  const hasResearch = purposes.has("advisor-research");
  const hasWizard = purposes.has("wizard-interview");
  const hasRun = purposes.has("advisor-bid") || purposes.has("advisor-reply") || purposes.has("advisor-draft");
  ok("ledger-purposes-relevant", hasResearch && hasWizard && hasRun, JSON.stringify([...purposes]).slice(0, 240));
  let tokensOk = true;
  for (const c of fresh) {
    const it = Number(pick(c, "inputTokens"));
    const ot = Number(pick(c, "outputTokens"));
    if (!(it > 0) || !(ot >= 0)) { tokensOk = false; break; }
  }
  ok("ledger-tokens-present", tokensOk, trunc(JSON.stringify(fresh.slice(0, 2).map((c) => ({ it: pick(c, "inputTokens"), ot: pick(c, "outputTokens") }))), 200));
  const u = await get("/api/usage");
  ok("usage-readable", u.status === 200 && Array.isArray(u.json) && u.json.length > 0, u.status + " " + trunc(u.text, 200));
  if (Array.isArray(u.json) && u.json.length > 0) {
    const withCost = u.json.filter((e) => Number(pick(e, "cost")) > 0 && String(pick(e, "model") || "").length > 1);
    ok("usage-cost-tokens", withCost.length >= 1, "withCost=" + withCost.length + " total=" + u.json.length);
    const usageFake = u.json.some((e) => hasFake(String(pick(e, "note") || "")) || hasFake(String(pick(e, "model") || "")));
    ok("usage-no-fake-markers", !usageFake, "checked " + u.json.length + " rows");
  }
  ok("overall-elapsed-bounded", elapsed() < OVERALL_BUDGET_MS, elapsed() + "ms");
}
checkOverall("gate-d");

console.log("");
console.log("LIVE GATE " + (fail === 0 ? "PASS" : "FAIL") + " pass=" + pass + " fail=" + fail + " elapsedMs=" + elapsed());
if (failures.length > 0) { console.log("failures:"); for (const f of failures) console.log(" - " + f); }
process.exit(fail === 0 ? 0 : 1);
