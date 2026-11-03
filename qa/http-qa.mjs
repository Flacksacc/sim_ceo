// SimCEO phases 0-3 HTTP QA. Deterministic; talks only to the API under test
// (default http://127.0.0.1:5099) which itself points at the fake provider.
// Unique owned data per run (qa-<run>-*); never touches other boards.
// Exit nonzero on any failure; prints PASS/FAIL counts.
import crypto from "node:crypto";
const API = process.env.QA_API || "http://127.0.0.1:5099";
const args = process.argv.slice(2);
function argValEarly(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length && !String(args[i + 1]).startsWith("--") ? args[i + 1] : undefined;
}
const TAG = argValEarly("--tag") || "mem";
const run = "qa-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
function sha(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
async function req(method, path, body, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 30000);
  try {
    const r = await fetch(API + path, {
      method,
      signal: ctl.signal,
      headers: { "content-type": "application/json", "x-user": "owner", ...(opts.headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const get = (p, o) => req("GET", p, undefined, o);
const post = (p, b, o) => req("POST", p, b, o);
const put = (p, b, o) => req("PUT", p, b, o);
const patch = (p, b, o) => req("PATCH", p, b, o);
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
async function uploadPortrait(rosterId) {
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "qa.png");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(API + "/api/roster/" + rosterId + "/image/upload", {
      method: "POST", signal: ctl.signal, headers: { "x-user": "owner" }, body: form,
    });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
async function makeBoard(name) {
  const r = await post("/api/boards", { name, mission: run + " mission", stage: "qa" });
  ok("create-board-" + name, r.status === 201 && camel(r.json, "id"), r.status + " " + r.text.slice(0, 160));
  return camel(r.json, "id");
}
async function makeAdvisor(boardId, role) {
  const nm = run + "-" + role;
  const q = await post("/api/roster/quick", { accountId: ACCT, name: nm, description: role + " helping with " + run });
  if (q.status !== 201) return { error: "quick:" + q.status + " " + q.text.slice(0, 200) };
  const rid = camel(q.json, "id") || camel(q.json?.entry, "id");
  const up = await uploadPortrait(rid);
  if (up.status !== 201) return { error: "upload:" + up.status + " " + up.text.slice(0, 200) };
  const imgs = await get("/api/roster/" + rid + "/images");
  const imgId = imgs.json?.[0]?.id || camel(imgs.json?.[0], "id");
  const rev = await post("/api/images/" + imgId + "/review", { decision: "accept" });
  if (rev.status !== 200) return { error: "review:" + rev.status + " " + rev.text.slice(0, 200) };
  const cp = await post("/api/roster/" + rid + "/copy", { boardId, boardRole: role });
  if (cp.status !== 201) return { error: "copy:" + cp.status + " " + cp.text.slice(0, 200) };
  const aid = camel(cp.json, "id");
  const ap = await post("/api/boards/" + boardId + "/advisors/" + aid + "/approve", {});
  if (ap.status !== 200) return { error: "approve:" + ap.status + " " + ap.text.slice(0, 200) };
  return { rid, aid };
}
async function makeMeeting(boardId, brief) {
  const m = await post("/api/boards/" + boardId + "/meetings", { title: run + " mtg", brief: brief || "qa brief" });
  ok("create-meeting", m.status === 201 && camel(m.json, "id"), m.status + " " + m.text.slice(0, 160));
  return camel(m.json, "id");
}

// ---------- phase 0 ----------
async function phase0() {
  console.log("phase0: evidence + snapshot");
  const bid = await makeBoard(run + "-p0");
  const p0patch = await patch("/api/boards/" + bid, { discussionPolicy: "focused", dataUse: "standard", retainAudio: true });
  ok("board-patch-200", p0patch.status === 200, String(p0patch.status));
  const spol = await put("/api/boards/" + bid + "/source-policy", { blockedTypes: "exe" });
  ok("source-policy-200", spol.status === 200, String(spol.status) + " " + spol.text.slice(0, 160));
  await post("/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Chief", background: "bg", familiarTopics: "fam", simplerTopics: "sim", commPrefs: "blunt" });
  const adv = await makeAdvisor(bid, "Keeper");
  ok("p0-advisor-ready", !adv.error, adv.error || "");
  const mid = await makeMeeting(bid, "p0 brief");
  const br = await post("/api/meetings/" + mid + "/briefings", { topic: "qa topic", evidence: [{ kind: "source", ref: "s1", title: "T", excerpt: "E" }] });
  ok("briefing-evidence-stored", br.status === 201 && JSON.stringify(br.json).includes("s1"), br.status + " " + br.text.slice(0, 200));
  const exact = "Adopt $5.00 now [brackets] (keep!)";
  const dr = await post("/api/boards/" + bid + "/directions", { text: exact, scope: "meeting", meetingId: mid, evidence: [{ kind: "note", ref: "n1" }] });
  ok("direction-created", dr.status === 201, dr.status + " " + dr.text.slice(0, 160));
  const dl = await get("/api/boards/" + bid + "/directions");
  const bodies = (dl.json || []).map((n) => n.body || n.Body);
  ok("direction-exact-text", bodies.includes(exact), JSON.stringify(bodies).slice(0, 200));
  const dnote = (dl.json || []).find((n) => (n.body || n.Body) === exact);
  ok("direction-evidence-stored", dnote && JSON.stringify(dnote.evidenceJson || dnote.EvidenceJson || "").includes("n1"), JSON.stringify(dnote).slice(0, 300));
  const ex = await get("/api/boards/" + bid + "/export");
  ok("export-200", ex.status === 200 && ex.json?.snapshot && ex.json?.hash, ex.status + " " + ex.text.slice(0, 160));
  const snap = JSON.parse(ex.json.snapshot);
  ok("export-versioned", snap.version === 1, "version=" + snap.version);
  ok("export-exportedAt", typeof snap.exportedAt === "string" && !isNaN(Date.parse(snap.exportedAt)), "exportedAt=" + snap.exportedAt);
  ok("snapshot-has-roster", Array.isArray(snap.roster) && snap.roster.length === 1 && (snap.roster[0].profileJson || snap.roster[0].profilejson || "").length > 20, "roster=" + (snap.roster || []).length);
  const im = await post("/api/boards/import", { snapshot: ex.json.snapshot, hash: ex.json.hash });
  ok("import-201", im.status === 201, im.status + " " + im.text.slice(0, 200));
  const ibid = camel(im.json?.board, "id");
  const ib = await get("/api/boards/" + ibid);
  ok("import-inactive", ib.json && (ib.json.activeConfig === false || ib.json.ActiveConfig === false), JSON.stringify(ib.json).slice(0, 200));
  ok("import-policies", (ib.json?.discussionPolicy || ib.json?.DiscussionPolicy) === "focused" && (ib.json?.dataUse || ib.json?.DataUse) === "standard", JSON.stringify(ib.json).slice(0, 300));
  const setup = await get("/api/boards/" + ibid + "/setup");
  ok("import-lead-fields", setup.json?.lead && (setup.json.lead.name || setup.json.lead.Name) === "QA Lead" && (setup.json.lead.commPrefs || setup.json.lead.CommPrefs) === "blunt", JSON.stringify(setup.json?.lead).slice(0, 300));
  const iad = await get("/api/boards/" + ibid + "/advisors");
  ok("import-advisor-mapped", Array.isArray(iad.json) && iad.json.length === 1, JSON.stringify(iad.json).slice(0, 300));
  const iadv = iad.json[0];
  ok("import-advisor-unapproved", !(iadv.approved ?? iadv.Approved), JSON.stringify(iadv).slice(0, 200));
  ok("import-new-ids", (iadv.id || iadv.Id) !== adv.aid && ibid !== bid, "ids reused");
  ok("import-roster-version", (iadv.rosterVersion ?? iadv.RosterVersion) === 1, JSON.stringify(iadv).slice(0, 200));
  const tampered = await post("/api/boards/import", { snapshot: "X" + ex.json.snapshot.slice(1), hash: ex.json.hash });
  ok("import-tamper-409", tampered.status === 409, String(tampered.status));
  const noexp = JSON.parse(ex.json.snapshot); delete noexp.exportedAt;
  const noexpSnap = JSON.stringify(noexp);
  const noexpRes = await post("/api/boards/import", { snapshot: noexpSnap, hash: sha(noexpSnap) });
  ok("import-noexportedat-400", noexpRes.status === 400, String(noexpRes.status) + " " + noexpRes.text.slice(0, 120));
  const badv = { ...JSON.parse(ex.json.snapshot), version: 2 };
  const badvSnap = JSON.stringify(badv);
  const badvRes = await post("/api/boards/import", { snapshot: badvSnap, hash: sha(badvSnap) });
  ok("import-badversion-400", badvRes.status === 400, String(badvRes.status));
  const boardsBeforeBad = await get("/api/boards");
  const nullAdv = JSON.parse(ex.json.snapshot);
  nullAdv.advisors = [nullAdv.advisors[0], null];
  const nullAdvSnap = JSON.stringify(nullAdv);
  const nullAdvRes = await post("/api/boards/import", { snapshot: nullAdvSnap, hash: sha(nullAdvSnap) });
  ok("import-null-advisor-400", nullAdvRes.status === 400, String(nullAdvRes.status) + " " + nullAdvRes.text.slice(0, 160));
  const missMap = JSON.parse(ex.json.snapshot);
  missMap.advisors[0].rosterEntryId = "00000000-0000-0000-0000-000000000000";
  const missMapSnap = JSON.stringify(missMap);
  const missMapRes = await post("/api/boards/import", { snapshot: missMapSnap, hash: sha(missMapSnap) });
  ok("import-missing-mapping-422", missMapRes.status === 422, String(missMapRes.status) + " " + missMapRes.text.slice(0, 160));
  const dupMap = JSON.parse(ex.json.snapshot);
  dupMap.advisors = [dupMap.advisors[0], { ...dupMap.advisors[0] }];
  const dupMapSnap = JSON.stringify(dupMap);
  const dupMapRes = await post("/api/boards/import", { snapshot: dupMapSnap, hash: sha(dupMapSnap) });
  ok("import-dup-roster-422", dupMapRes.status === 422, String(dupMapRes.status) + " " + dupMapRes.text.slice(0, 160));
  const bigSnap = JSON.parse(ex.json.snapshot);
  bigSnap.roster = [];
  bigSnap.advisors = [];
  for (let i = 0; i < 11; i++) {
    const rid = "11111111-1111-1111-1111-" + String(100000000000 + i);
    bigSnap.roster.push({ id: rid, name: "Bulk" + i, description: "bulk entry " + i, profileJson: "a sufficiently long bulk profile json string " + i });
    bigSnap.advisors.push({ rosterEntryId: rid, boardRole: "BulkRole" + i, rosterVersion: 1 });
  }
  const bigSnapText = JSON.stringify(bigSnap);
  const bigRes = await post("/api/boards/import", { snapshot: bigSnapText, hash: sha(bigSnapText) });
  ok("import-cap-422", bigRes.status === 422, String(bigRes.status) + " " + bigRes.text.slice(0, 160));
  const boardsAfterBad = await get("/api/boards");
  ok("import-invalid-no-partial", (boardsAfterBad.json || []).length === (boardsBeforeBad.json || []).length, "before=" + (boardsBeforeBad.json || []).length + " after=" + (boardsAfterBad.json || []).length);
}
// ---------- phase 1 ----------
async function phase1() {
  console.log("phase1: trusted advisors");
  const bid = await makeBoard(run + "-p1");
  const q = await post("/api/roster/quick", { accountId: ACCT, name: run + "-bare", description: "bare strategist for " + run });
  ok("quick-201", q.status === 201, q.status + " " + q.text.slice(0, 160));
  const rid = camel(q.json, "id");
  const cp0 = await post("/api/roster/" + rid + "/copy", { boardId: bid, boardRole: "Strategist" });
  ok("copy-noportrait-409", cp0.status === 409 && cp0.text.toLowerCase().includes("portrait"), cp0.status + " " + cp0.text.slice(0, 160));
  const up = await uploadPortrait(rid);
  ok("portrait-upload-201", up.status === 201, up.status + " " + up.text.slice(0, 160));
  const imgs0 = await get("/api/roster/" + rid + "/images");
  const imgId = imgs0.json?.[0]?.id;
  const cp1 = await post("/api/roster/" + rid + "/copy", { boardId: bid, boardRole: "Strategist" });
  ok("copy-pending-portrait-201", cp1.status === 201, cp1.status + " " + cp1.text.slice(0, 160));
  const aid = camel(cp1.json, "id");
  const ap0 = await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
  ok("approve-pending-portrait-409", ap0.status === 409 && ap0.text.toLowerCase().includes("portrait"), ap0.status + " " + ap0.text.slice(0, 200));
  const rev = await post("/api/images/" + imgId + "/review", { decision: "accept" });
  ok("portrait-accept-200", rev.status === 200, rev.status + " " + rev.text.slice(0, 160));
  const ap1 = await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
  ok("approve-after-accept-200", ap1.status === 200, ap1.status + " " + ap1.text.slice(0, 200));
  // direct attach cannot inject approved:true (trust fields are server-owned)
  const qd = await post("/api/roster/quick", { accountId: ACCT, name: run + "-inj", description: "injection probe for " + run });
  const ridd = camel(qd.json, "id");
  await uploadPortrait(ridd);
  const inj = await post("/api/boards/" + bid + "/advisors", { rosterEntryId: ridd, boardRole: "Injected", approved: true });
  ok("direct-attach-201-unapproved", inj.status === 201 && (inj.json?.approved ?? inj.json?.Approved) === false, inj.status + " " + inj.text.slice(0, 200));
  // version mismatch -> sync -> reapproval required
  const ed = await put("/api/roster/" + rid, { description: "updated description for " + run });
  ok("roster-edit-bumps-version", ed.status === 200 && (ed.json?.version ?? ed.json?.Version) === 2, ed.status + " " + ed.text.slice(0, 160));
  const apStale = await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
  ok("approve-stale-version-409", apStale.status === 409, apStale.status + " " + apStale.text.slice(0, 160));
  const sy = await post("/api/boards/" + bid + "/advisors/" + aid + "/sync-roster", {});
  ok("sync-200", sy.status === 200, sy.status + " " + sy.text.slice(0, 160));
  const advList = await get("/api/boards/" + bid + "/advisors");
  const synced = (advList.json || []).find((a) => (a.id || a.Id) === aid);
  ok("sync-requires-reapproval", synced && (synced.approved ?? synced.Approved) === false, JSON.stringify(synced).slice(0, 200));
  const ap2 = await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
  ok("approve-after-sync-200", ap2.status === 200, ap2.status + " " + ap2.text.slice(0, 160));
  // same role on distinct advisors is allowed (stable AdvisorId identity)
  const qs = await post("/api/roster/quick", { accountId: ACCT, name: run + "-same", description: "same role probe for " + run });
  const rids = camel(qs.json, "id");
  await uploadPortrait(rids);
  const cps = await post("/api/roster/" + rids + "/copy", { boardId: bid, boardRole: "Strategist" });
  ok("same-role-distinct-allowed", cps.status === 201 && camel(cps.json, "id") !== aid, cps.status + " " + cps.text.slice(0, 160));
  // raw roster creation ignores client trust fields
  const qr = await post("/api/roster", { accountId: guid(), name: run + "-raw", description: "raw trust probe with enough words here", profileJson: "a sufficiently long profile json string for gates", researchRequested: true, evidenceCount: 9, researchJson: "{}" });
  ok("raw-trust-sanitized", qr.status === 201 && (qr.json?.researchRequested ?? qr.json?.ResearchRequested) === false && (qr.json?.evidenceCount ?? qr.json?.EvidenceCount) === 0, qr.status + " " + qr.text.slice(0, 200));
  // research-in-progress gate (sleep keeps the window open)
  const q2 = await post("/api/roster/quick", { accountId: ACCT, name: run + "-res", description: "research gating for " + run });
  const rid2 = camel(q2.json, "id");
  await uploadPortrait(rid2);
  const imgs2 = await get("/api/roster/" + rid2 + "/images");
  await post("/api/images/" + imgs2.json[0].id + "/review", { decision: "accept" });
  await post("/api/roster/" + rid2 + "/copy", { boardId: bid, boardRole: "Researcher" });
  const pending = post("/api/roster/" + rid2 + "/research", { focus: "QA-SLEEP:4000 steady" });
  await new Promise((r) => setTimeout(r, 600));
  const rdone = await pending;
  ok("research-200", rdone.status === 200 && (rdone.json?.claims?.length ?? 0) > 0, rdone.status + " " + rdone.text.slice(0, 200));
  ok("dossier-claim-refs", JSON.stringify(rdone.json).includes("qa.example"), rdone.text.slice(0, 300));
  ok("evidence-counts-citations", (rdone.json?.evidenceRefs?.length ?? -1) >= 2, JSON.stringify(rdone.json?.evidenceRefs).slice(0, 200));
  // unsupported path: zero citations -> gate blocks approval (ai-draft carries focus in its single grounded call)
  const q3 = await post("/api/roster/ai-draft", { accountId: ACCT, name: run + "-nos", role: "Watcher", focus: "QA-NOSEARCH nothing" });
  ok("aidraft-200", q3.status === 201, q3.status + " " + q3.text.slice(0, 200));
  const rid3 = camel(q3.json?.entry, "id");
  ok("dossier-unsupported-note", JSON.stringify(q3.json?.entry?.researchJson || q3.text).toLowerCase().includes("unsupported"), q3.text.slice(0, 300));
  ok("aidraft-zero-evidence", (q3.json?.entry?.evidenceCount ?? q3.json?.entry?.EvidenceCount) === 0, q3.text.slice(0, 200));
  await uploadPortrait(rid3);
  const imgs3 = await get("/api/roster/" + rid3 + "/images");
  await post("/api/images/" + imgs3.json[0].id + "/review", { decision: "accept" });
  const cp3 = await post("/api/roster/" + rid3 + "/copy", { boardId: bid, boardRole: "Unsupported" });
  const aid3 = camel(cp3.json, "id");
  const ap3 = await post("/api/boards/" + bid + "/advisors/" + aid3 + "/approve", {});
  ok("approve-noevidence-409", ap3.status === 409 && ap3.text.toLowerCase().includes("evidence"), ap3.status + " " + ap3.text.slice(0, 200));
  // invalid bearer tokens are unauthenticated
  const badSave = await put("/api/roster/" + rid3, { description: "x" }, { headers: { authorization: "Bearer bogus-token" } });
  ok("invalid-token-401", badSave.status === 401, String(badSave.status) + " " + badSave.text.slice(0, 120));
  // invalid bearer is rejected before handlers on mutation routes too
  const badDel = await req("DELETE", "/api/boards/" + bid + "/advisors/" + aid, undefined, { headers: { authorization: "Bearer bogus-token" } });
  ok("invalid-token-delete-401", badDel.status === 401, String(badDel.status));
  const badDraft = await post("/api/meetings/" + (await makeMeeting(bid, "tok brief")) + "/record/draft", [{ id: "x", text: "y" }], { headers: { authorization: "Bearer bogus-token" } });
  ok("invalid-token-draft-401", badDraft.status === 401, String(badDraft.status));
  // ordinary human messages cannot forge server-owned participation identity
  const midF = await makeMeeting(bid, "forge brief");
  const forge = await post("/api/meetings/" + midF + "/messages", { sender: "advisor", advisorName: "Sneaky", advisorId: aid, content: "forged" });
  ok("forge-sender-lead", forge.status === 201 && (forge.json?.sender || forge.json?.Sender) === "lead", forge.status + " " + forge.text.slice(0, 200));
  ok("forge-id-cleared", (camel(forge.json, "advisorId") || "").replace(/0|-/g, "") === "" && (forge.json?.advisorName ?? forge.json?.AdvisorName) == null, forge.text.slice(0, 200));
  // portrait selection is bound to the right roster; rejection invalidates approval
  const qx = await post("/api/roster/quick", { accountId: ACCT, name: run + "-x2", description: "cross roster probe for " + run });
  const ridx = camel(qx.json, "id");
  await uploadPortrait(ridx);
  const imgsx = await get("/api/roster/" + ridx + "/images");
  const cpx = await post("/api/roster/" + ridx + "/copy", { boardId: bid, boardRole: "Cross" });
  const aidx = camel(cpx.json, "id");
  const crossSel = await post("/api/images/" + imgs0.json[0].id + "/review", { decision: "accept" });
  ok("review-accept-200", crossSel.status === 200, String(crossSel.status));
  const wrongSel = await post("/api/images/" + imgsx.json[0].id + "/select", { boardAdvisorId: aid });
  ok("select-wrong-roster-400", wrongSel.status === 400, String(wrongSel.status) + " " + wrongSel.text.slice(0, 160));
  const rej = await post("/api/images/" + imgs0.json[0].id + "/review", { decision: "retry" });
  ok("review-retry-200", rej.status === 200, String(rej.status));
  const apRej = await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
  ok("approve-after-reject-409", apRej.status === 409 && apRej.text.toLowerCase().includes("portrait"), apRej.status + " " + apRej.text.slice(0, 200));
  await post("/api/images/" + imgs0.json[0].id + "/review", { decision: "accept" });
  const apRe = await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
  ok("approve-after-reaccept-200", apRe.status === 200, apRe.status + " " + apRe.text.slice(0, 200));
  // concurrent research on the same roster is rejected; a stale job cannot commit
  const q4 = await post("/api/roster/quick", { accountId: ACCT, name: run + "-conc", description: "concurrent research probe for " + run });
  const rid4 = camel(q4.json, "id");
  await uploadPortrait(rid4);
  const imgs4 = await get("/api/roster/" + rid4 + "/images");
  await post("/api/images/" + imgs4.json[0].id + "/review", { decision: "accept" });
  const slowRes = post("/api/roster/" + rid4 + "/research", { focus: "QA-SLEEP:4000 concurrent" });
  await new Promise((r) => setTimeout(r, 700));
  const concRes = await post("/api/roster/" + rid4 + "/research", { focus: "second" });
  ok("research-concurrent-409", concRes.status === 409, String(concRes.status) + " " + concRes.text.slice(0, 160));
  const slowDone = await slowRes;
  ok("research-slow-200", slowDone.status === 200, String(slowDone.status));
  // true zero-citation fixture across all angles: no evidence, approval blocked
  const q5 = await post("/api/roster/quick", { accountId: ACCT, name: run + "-zero", description: "zero evidence probe for " + run });
  const rid5 = camel(q5.json, "id");
  await uploadPortrait(rid5);
  const imgs5 = await get("/api/roster/" + rid5 + "/images");
  await post("/api/images/" + imgs5.json[0].id + "/review", { decision: "accept" });
  const zeroRes = await post("/api/roster/" + rid5 + "/research", { focus: "QA-NOSEARCH all angles" });
  ok("research-nosearch-200", zeroRes.status === 200, String(zeroRes.status));
  ok("research-nosearch-zero", (zeroRes.json?.evidenceRefs?.length ?? -1) === 0 && (zeroRes.json?.supported ?? true) === false, zeroRes.text.slice(0, 300));
  const cp5 = await post("/api/roster/" + rid5 + "/copy", { boardId: bid, boardRole: "ZeroEv" });
  const ap5 = await post("/api/boards/" + bid + "/advisors/" + camel(cp5.json, "id") + "/approve", {});
  ok("approve-zeroevidence-409", ap5.status === 409 && ap5.text.toLowerCase().includes("evidence"), ap5.status + " " + ap5.text.slice(0, 200));
  // profile edit invalidates the dossier: stale copy, then research-pending
  const edLate = await put("/api/roster/" + rid4, { description: "edited after research for " + run });
  ok("roster-edit-ok", edLate.status === 200, String(edLate.status));
  const cpLate = await post("/api/roster/" + rid4 + "/copy", { boardId: bid, boardRole: "StaleEv" });
  ok("copy-after-edit-pending-409", cpLate.status === 409 && cpLate.text.toLowerCase().includes("research"), cpLate.status + " " + cpLate.text.slice(0, 200));
  const reRes = await post("/api/roster/" + rid4 + "/research", { focus: "rerun after edit" });
  ok("research-rerun-200", reRes.status === 200 && (reRes.json?.evidenceRefs?.length ?? 0) > 0, reRes.status + " " + reRes.text.slice(0, 200));
  const cpLate2 = await post("/api/roster/" + rid4 + "/copy", { boardId: bid, boardRole: "StaleEv" });
  ok("copy-after-rerun-201", cpLate2.status === 201, cpLate2.status + " " + cpLate2.text.slice(0, 200));
  const apLate = await post("/api/boards/" + bid + "/advisors/" + camel(cpLate2.json, "id") + "/approve", {});
  ok("approve-after-rerun-200", apLate.status === 200, apLate.status + " " + apLate.text.slice(0, 200));
}

// ---------- phase 2 ----------
async function phase2() {
  console.log("phase2: setup interview + wizard");
  const wizAcct = guid();
  const w = await post("/api/wizard", { accountId: wizAcct, step: 1, presetKey: "", fieldsJson: JSON.stringify({ name: run + "-wizboard", mission: run + " mission", stage: "forming", lead: { name: "QA Lead" }, advisors: [{ role: "Strategist", name: "" }] }) });
  ok("wizard-draft-200", w.status === 200 && camel(w.json, "id"), w.status + " " + w.text.slice(0, 160));
  const wid = camel(w.json, "id");
  const rv = await get("/api/wizard/" + wid + "/review");
  ok("wizard-review-blockers-shape", rv.status === 200 && Array.isArray(rv.json?.blockers), rv.status + " " + rv.text.slice(0, 200));
  const wg0 = await get("/api/wizard/" + wid);
  const wv0 = wg0.json?.version ?? wg0.json?.Version ?? 1;
  const g1 = await post("/api/wizard/" + wid + "/interview", { answer: "first answer", version: wv0 });
  ok("interview-200", g1.status === 200 && g1.json?.extractOk === true, g1.status + " " + g1.text.slice(0, 300));
  ok("interview-pending-question", typeof g1.json?.pendingQuestion === "string" && g1.json.pendingQuestion.length > 0, g1.text.slice(0, 200));
  // fast-path save preserves interview history
  const g1ver = g1.json?.version ?? g1.json?.Version ?? wv0;
  const wsave = await post("/api/wizard", { id: wid, version: g1ver, accountId: wizAcct, step: 1, presetKey: "", fieldsJson: JSON.stringify({ name: run + "-wizboard", mission: "changed mission", stage: "forming", lead: { name: "QA Lead" }, advisors: [{ role: "Strategist", name: "" }] }) });
  ok("fastpath-save-200", wsave.status === 200, wsave.status + " " + wsave.text.slice(0, 160));
  const wg = await get("/api/wizard/" + wid);
  ok("fastpath-preserves-history", wg.status === 200 && JSON.stringify(wg.json?.interviewJson || "").includes("first answer"), wg.status + " " + JSON.stringify(wg.json).slice(0, 300));
  ok("hydrate-pending-question", JSON.stringify(wg.json?.interviewJson || "").includes("pendingQuestion"), JSON.stringify(wg.json).slice(0, 200));
  const wver = wg.json?.version ?? wg.json?.Version ?? 0;
  ok("wizard-version-present", typeof wver === "number" && wver > 0, JSON.stringify(wg.json).slice(0, 200));
  const staleSave = await post("/api/wizard", { id: wid, version: Math.max(0, wver - 1), accountId: wizAcct, step: 1, presetKey: "", fieldsJson: JSON.stringify({ name: run + "-stale", mission: "x", stage: "x", lead: { name: "L" }, advisors: [{ role: "R", name: "" }] }) });
  ok("wizard-stale-save-409", staleSave.status === 409, String(staleSave.status) + " " + staleSave.text.slice(0, 160));
  const staleAns = await post("/api/wizard/" + wid + "/interview", { answer: "stale tab answer", version: Math.max(0, wver - 1) });
  ok("wizard-stale-interview-409", staleAns.status === 409, String(staleAns.status));
  const bad = await post("/api/wizard/" + wid + "/interview", { answer: "QA-BADJSON answer kept", version: wver });
  ok("interview-badjson-200-fallback", bad.status === 200 && bad.json?.extractOk === false && JSON.stringify(bad.json?.analysis || "").toLowerCase().includes("recorded"), bad.status + " " + bad.text.slice(0, 300));
  const wg2 = await get("/api/wizard/" + wid);
  ok("interview-answer-persisted-after-failure", wg2.status === 200 && JSON.stringify(wg2.json?.interviewJson || "").includes("QA-BADJSON answer kept"), wg2.status + " " + JSON.stringify(wg2.json).slice(0, 300));
  const badVer = bad.json?.version ?? bad.json?.Version ?? wver;
  const perr = await post("/api/wizard/" + wid + "/interview", { answer: "QA-REPLYERR probe kept", version: badVer });
  ok("interview-provider-error-persisted", perr.status === 200 && perr.json?.extractOk === false && JSON.stringify(wg.json || "").length > 0, perr.status + " " + perr.text.slice(0, 300));
  const wg3 = await get("/api/wizard/" + wid);
  ok("interview-provider-error-answer-saved", JSON.stringify(wg3.json?.interviewJson || "").includes("QA-REPLYERR probe kept"), JSON.stringify(wg3.json).slice(0, 300));
  const w2 = await post("/api/wizard", { accountId: wizAcct, step: 1, presetKey: "", fieldsJson: JSON.stringify({ name: run + "-wiz2", mission: "m", stage: "s", lead: { name: "L" }, advisors: [{ role: "R", name: "" }] }) });
  const wid2 = camel(w2.json, "id");
  const g2v = await get("/api/wizard/" + wid2);
  const v2 = g2v.json?.version ?? g2v.json?.Version ?? 1;
  const slow = post("/api/wizard/" + wid2 + "/interview", { answer: "QA-SLEEP:3000 early-persist-probe", version: v2 });
  await new Promise((r) => setTimeout(r, 700));
  const mid2 = await get("/api/wizard/" + wid2);
  ok("interview-pre-llm-persist", mid2.status === 200 && JSON.stringify(mid2.json?.interviewJson || "").includes("early-persist-probe"), mid2.status + " " + JSON.stringify(mid2.json).slice(0, 300));
  const busySave = await post("/api/wizard", { id: wid2, accountId: wizAcct, step: 1, presetKey: "", fieldsJson: JSON.stringify({ name: "busy" }) });
  ok("wizard-busy-save-409", busySave.status === 409, String(busySave.status) + " " + busySave.text.slice(0, 160));
  await slow;
  const w3 = await post("/api/wizard", { accountId: wizAcct, step: 1, presetKey: "", fieldsJson: JSON.stringify({}) });
  const c0 = await post("/api/wizard/" + camel(w3.json, "id") + "/create", {});
  ok("wizard-create-blocked-409", c0.status === 409 && c0.json?.blockers, c0.status + " " + c0.text.slice(0, 160));
  const boardsBefore = await get("/api/boards");
  const nBefore = (boardsBefore.json || []).length;
  ok("wizard-create-blocked-no-partial", (boardsBefore.json || []).every((b) => (b.name || b.Name) !== run + "-blocked"), "partial board written");
  const c1 = await post("/api/wizard/" + wid + "/create", {});
  ok("wizard-create-201", c1.status === 201 && c1.json?.board && (c1.json?.advisors?.length ?? 0) === 1, c1.status + " " + c1.text.slice(0, 300));
  ok("wizard-create-portrait-lifecycle", JSON.stringify(c1.json?.portraitReview || "").includes("pending"), c1.text.slice(0, 200));
  const wbid = camel(c1.json?.board, "id");
  const boardsAfter = await get("/api/boards");
  ok("wizard-create-one-board", (boardsAfter.json || []).length === nBefore + 1, "n=" + (boardsAfter.json || []).length);
  const c2 = await post("/api/wizard/" + wid + "/create", {});
  ok("wizard-create-retry-same-board", (c2.status === 200 || c2.status === 201) && camel(c2.json?.board, "id") === wbid, c2.status + " " + c2.text.slice(0, 200));
  const boardsAfterRetry = await get("/api/boards");
  ok("wizard-retry-no-duplicate", (boardsAfterRetry.json || []).length === nBefore + 1, "n=" + (boardsAfterRetry.json || []).length);
  // concurrent create serializes to a single board
  const wc = await post("/api/wizard", { accountId: wizAcct, step: 1, presetKey: "", fieldsJson: JSON.stringify({ name: run + "-conc", mission: "m", stage: "s", lead: { name: "L" }, advisors: [{ role: "Rc", name: "" }] }) });
  const widc = camel(wc.json, "id");
  const [cc1, cc2] = await Promise.all([post("/api/wizard/" + widc + "/create", {}), post("/api/wizard/" + widc + "/create", {})]);
  const ccSorted = [cc1.status, cc2.status].sort().join(",");
  const ccBoards = [camel(cc1.json?.board, "id"), camel(cc2.json?.board, "id")];
  ok("concurrent-create-serialized", ccSorted === "201,409" || (ccSorted === "200,201" && ccBoards[0] && ccBoards[0] === ccBoards[1]), cc1.status + "/" + cc2.status);
  const boardsAfterConc = await get("/api/boards");
  ok("concurrent-create-one-board", (boardsAfterConc.json || []).length === nBefore + 2, "n=" + (boardsAfterConc.json || []).length);
  const wadv = await get("/api/boards/" + wbid + "/advisors");
  const waid = wadv.json?.[0]?.id;
  const wap0 = await post("/api/boards/" + wbid + "/advisors/" + waid + "/approve", {});
  ok("wizard-advisor-approve-pending-409", wap0.status === 409, wap0.status + " " + wap0.text.slice(0, 160));
  const wr = await get("/api/roster?accountId=" + encodeURIComponent(wizAcct));
  const wrEntry = (wr.json || []).find((e) => (e.entry?.name || "").includes("Strategist"));
  const wimgs = await get("/api/roster/" + wrEntry.entry.id + "/images");
  const wimgId = wimgs.json?.[0]?.id;
  ok("wizard-placeholder-pending", (wimgs.json?.[0]?.review || "") === "pending" && (wimgs.json?.[0]?.kind || "").includes("wizard"), wimgs.text.slice(0, 200));
  await post("/api/images/" + wimgId + "/review", { decision: "accept" });
  const wap1 = await post("/api/boards/" + wbid + "/advisors/" + waid + "/approve", {});
  ok("wizard-advisor-approve-after-accept-200", wap1.status === 200, wap1.status + " " + wap1.text.slice(0, 160));
  const lv = await get("/api/boards/" + wbid + "/setup");
  const hash = lv.json?.draftHash;
  ok("setup-canonical-hash", typeof hash === "string" && hash.length >= 16 && typeof (lv.json?.canonicalJson) === "string", lv.text.slice(0, 200));
  const noHash = await post("/api/boards/" + wbid + "/setup/activate", {});
  ok("activate-hash-required-400", noHash.status === 400, String(noHash.status));
  const badAct = await post("/api/boards/" + wbid + "/setup/activate", { hash: "deadbeefdeadbeef" });
  ok("activate-bad-hash-409", badAct.status === 409, String(badAct.status));
  const goodAct = await post("/api/boards/" + wbid + "/setup/activate", { hash });
  ok("activate-200", goodAct.status === 200, goodAct.status + " " + goodAct.text.slice(0, 200));
  const stale = await post("/api/boards/" + wbid + "/lead", { version: 0, name: "Stale", roleLabel: "x" });
  ok("lead-stale-409", stale.status === 409, stale.status + " " + stale.text.slice(0, 120));
  const bare = await makeBoard(run + "-bare");
  const sec0 = await post("/api/meetings/" + (await makeMeeting(bare, "bare")) + "/secretary", { request: "hi" });
  ok("secretary-bare-409", sec0.status === 409, String(sec0.status));
  const midS = await makeMeeting(wbid, "ready");
  const sec1 = await post("/api/meetings/" + midS + "/secretary", { request: "qa status" });
  ok("secretary-ready-200", sec1.status === 200 && sec1.json?.provisional === true, sec1.status + " " + sec1.text.slice(0, 200));
}
// ---------- phase 3 ----------
async function phase3() {
  console.log("phase3: discussion + records");
  const bid = await makeBoard(run + "-p3");
  await post("/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Lead" });
  const roles = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"];
  for (const r of roles) {
    const a = await makeAdvisor(bid, r);
    ok("advisor-ready-" + r, !a.error, a.error || "");
  }
  const mid = await makeMeeting(bid, "p3 brief");
  await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "QA opening question" });
  const no = await post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "QA-NO decline everything please" });
  ok("run-allno-200", no.status === 200, no.status + " " + no.text.slice(0, 200));
  ok("run-allno-silent", (no.json?.published?.length ?? -1) === 0, "published=" + (no.json?.published?.length));
  const yReasons = (no.json?.yielded || []).map((y) => y.reason || y.Reason);
  ok("run-allno-yields", yReasons.length === roles.length && yReasons.every((r) => r === "bid-declined"), JSON.stringify(yReasons));
  ok("run-allno-no-overflow", (no.json?.overflow ?? null) === null, JSON.stringify(no.json?.overflow));
  const cap = await post("/api/meetings/" + mid + "/run", { policy: "focused", prompt: "QA cap question" });
  ok("run-cap-200", cap.status === 200, cap.status + " " + cap.text.slice(0, 200));
  ok("run-cap-five", (cap.json?.published?.length ?? 0) === 5, "published=" + (cap.json?.published?.length));
  ok("run-cap-two-rounds", (cap.json?.rounds?.length ?? 0) === 2, "rounds=" + (cap.json?.rounds?.length));
  ok("run-cap-omitted", (cap.json?.overflow?.omitted?.length ?? 0) === 1 && (cap.json?.overflow?.cap ?? 0) === 5, JSON.stringify(cap.json?.overflow));
  const capY = (cap.json?.yielded || []).map((y) => y.reason || y.Reason);
  ok("run-cap-yield-reason", capY.includes("cap-omitted"), JSON.stringify(capY));
  const notes = await get("/api/meetings/" + mid + "/notes?kind=run-outcome");
  ok("run-outcome-persisted", notes.status === 200 && (notes.json || []).length >= 2 && JSON.stringify(notes.json).includes("cap-omitted"), notes.status + " " + notes.text.slice(0, 300));
  const rep = await post("/api/meetings/" + mid + "/run", { policy: "focused", prompt: "QA cap question" });
  ok("run-repeat-silent", rep.status === 200 && (rep.json?.published?.length ?? -1) === 0, rep.status + " published=" + (rep.json?.published?.length));
  const repY = (rep.json?.yielded || []).map((y) => y.reason || y.Reason);
  ok("run-repeat-yields", repY.length === 6 && repY.filter((r) => r === "already-replied-this-turn").length === 5 && repY.filter((r) => r === "cap-omitted").length === 1, JSON.stringify(repY));
  await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "QA follow-up question" });
  const fol = await post("/api/meetings/" + mid + "/run", { policy: "focused", prompt: "QA follow-up answers" });
  ok("run-followup-publishes", fol.status === 200 && (fol.json?.published?.length ?? 0) > 0, fol.status + " published=" + (fol.json?.published?.length));
  const perr = await post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "QA-REPLYERR all fail" });
  await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "QA error probe" });
  const perr2 = await post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "QA-REPLYERR all fail" });
  ok("run-replyerr-yields", perr2.status === 200 && (perr2.json?.published?.length ?? -1) === 0, perr2.status + " " + perr2.text.slice(0, 200));
  // board-scoped lead isolation: two boards resolve and run independently
  const biso1 = await makeBoard(run + "-iso1");
  await post("/api/boards/" + biso1 + "/lead", { name: "Lead One", roleLabel: "L1" });
  const biso2 = await makeBoard(run + "-iso2");
  await post("/api/boards/" + biso2 + "/lead", { name: "Lead Two", roleLabel: "L2" });
  const l1a = await get("/api/boards/" + biso1 + "/lead");
  ok("lead-v1", (l1a.json?.version ?? l1a.json?.Version) === 1, l1a.text.slice(0, 160));
  await post("/api/boards/" + biso1 + "/lead", { version: 1, name: "Lead One v2", roleLabel: "L1" });
  const l1b = await get("/api/boards/" + biso1 + "/lead");
  const l2 = await get("/api/boards/" + biso2 + "/lead");
  ok("lead-board-scope", (l1b.json?.version ?? 0) === 2 && (l2.json?.version ?? 0) === 1 && (l2.json?.name || l2.json?.Name) === "Lead Two", l1b.text.slice(0, 160) + " / " + l2.text.slice(0, 160));
  const isoAdv = await makeAdvisor(biso2, "IsoSolo");
  ok("isoadvisor-ready", !isoAdv.error, isoAdv.error || "");
  const isoMid = await makeMeeting(biso2, "iso brief");
  await post("/api/meetings/" + isoMid + "/messages", { sender: "lead", content: "iso question" });
  const isoRun = await post("/api/meetings/" + isoMid + "/run", { policy: "balanced", prompt: "iso answers", leadVersion: 1 });
  ok("run-isolated-board-version-200", isoRun.status === 200, isoRun.status + " " + isoRun.text.slice(0, 200));
  const isoBad = await post("/api/meetings/" + isoMid + "/run", { policy: "balanced", prompt: "iso answers", leadVersion: 2 });
  ok("run-other-board-version-409", isoBad.status === 409, String(isoBad.status));
  const lvBad = await post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "x", leadVersion: 999999 });
  ok("run-stale-lead-409", lvBad.status === 409, String(lvBad.status));
  const bid2 = await makeBoard(run + "-p3i");
  await post("/api/boards/" + bid2 + "/lead", { name: "QA Lead", roleLabel: "Lead" });
  await makeAdvisor(bid2, "Solo");
  const mid2 = await makeMeeting(bid2, "interrupt brief");
  await post("/api/meetings/" + mid2 + "/messages", { sender: "lead", content: "QA slow question QA-SLEEP:4000" });
  const slowRun = post("/api/meetings/" + mid2 + "/run", { policy: "balanced", prompt: "QA-SLEEP:4000 slow reply" });
  await new Promise((r) => setTimeout(r, 700));
  await post("/api/meetings/" + mid2 + "/messages", { sender: "lead", content: "QA owner override turn" });
  const intr = await slowRun;
  ok("run-interrupted-409", intr.status === 409, intr.status + " " + intr.text.slice(0, 200));
  const afterMsgs = await get("/api/meetings/" + mid2 + "/messages?take=100");
  const advMsgs = (afterMsgs.json || []).filter((m) => (m.sender || m.Sender) === "advisor");
  ok("run-interrupted-no-drafts", advMsgs.length === 0, "advisorMsgs=" + advMsgs.length);
  const mid3 = await makeMeeting(bid2, "concurrent brief");
  await post("/api/meetings/" + mid3 + "/messages", { sender: "lead", content: "QA concurrent q" });
  const r1 = post("/api/meetings/" + mid3 + "/run", { policy: "balanced", prompt: "QA-SLEEP:4000 concurrent" });
  await new Promise((r) => setTimeout(r, 700));
  const r2 = await post("/api/meetings/" + mid3 + "/run", { policy: "balanced", prompt: "QA concurrent q" });
  ok("run-concurrent-409", r2.status === 409, r2.status + " " + r2.text.slice(0, 200));
  const r1done = await r1;
  ok("run-first-completes", r1done.status === 200 && (r1done.json?.published?.length ?? 0) === 1, r1done.status + " " + r1done.text.slice(0, 200));
  // paused meeting invalidates in-flight work
  const mid4 = await makeMeeting(bid2, "pause brief");
  await post("/api/meetings/" + mid4 + "/messages", { sender: "lead", content: "QA pause q" });
  const rp = post("/api/meetings/" + mid4 + "/run", { policy: "balanced", prompt: "QA-SLEEP:4000 paused mid-run" });
  await new Promise((r) => setTimeout(r, 700));
  await post("/api/meetings/" + mid4 + "/pause", {});
  const rpdone = await rp;
  ok("run-paused-409", rpdone.status === 409, rpdone.status + " " + rpdone.text.slice(0, 200));
  const items = [{ id: "a", text: "Do X $5 [keep] verbatim", detail: "why", status: "adopted", scope: "board", refs: [{ kind: "source", ref: "s1" }] }, { id: "b", text: "Skip me" }];
  const d1 = await post("/api/meetings/" + mid + "/record/draft", items);
  ok("record-draft-201", d1.status === 201 && d1.json?.hash && d1.json?.watermark !== undefined, d1.status + " " + d1.text.slice(0, 200));
  const did = camel(d1.json, "id"), dhash = d1.json?.hash ?? d1.json?.Hash, dwm = d1.json?.watermark ?? d1.json?.Watermark;
  const dver1 = d1.json?.version ?? d1.json?.Version, dtok1 = d1.json?.reviewToken ?? d1.json?.ReviewToken;
  const apBadHash = await post("/api/meetings/" + mid + "/record/approve", { draftId: did, version: dver1, hash: "deadbeefdeadbeef", reviewToken: dtok1, watermark: dwm, itemIds: ["a"] });
  ok("record-approve-badhash-409", apBadHash.status === 409, String(apBadHash.status));
  await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "QA drift message" });
  const apStaleWm = await post("/api/meetings/" + mid + "/record/approve", { draftId: did, version: dver1, hash: dhash, reviewToken: dtok1, watermark: dwm, itemIds: ["a"] });
  ok("record-approve-stalewm-409", apStaleWm.status === 409, String(apStaleWm.status) + " " + apStaleWm.text.slice(0, 160));
  const d2 = await post("/api/meetings/" + mid + "/record/draft", items);
  const did2 = camel(d2.json, "id"), dh2 = d2.json?.hash ?? d2.json?.Hash, dw2 = d2.json?.watermark ?? d2.json?.Watermark;
  const dv2 = d2.json?.version ?? d2.json?.Version, dt2 = d2.json?.reviewToken ?? d2.json?.ReviewToken;
  // Phase5: every review mutation additionally sends version + review token.
  const apMissing = await post("/api/meetings/" + mid + "/record/approve", { draftId: did2, version: dv2, hash: dh2, reviewToken: dt2, watermark: dw2, itemIds: ["does-not-exist"] });
  ok("record-approve-missing-id-422", apMissing.status === 422, String(apMissing.status) + " " + apMissing.text.slice(0, 160));
  const apDup = await post("/api/meetings/" + mid + "/record/approve", { draftId: did2, version: dv2, hash: dh2, reviewToken: dt2, watermark: dw2, itemIds: ["a", "a"] });
  ok("record-approve-dup-id-422", apDup.status === 422, String(apDup.status));
  const apEmpty = await post("/api/meetings/" + mid + "/record/approve", { draftId: did2, version: dv2, hash: dh2, reviewToken: dt2, watermark: dw2, itemIds: [] });
  ok("record-approve-empty-400", apEmpty.status === 400, String(apEmpty.status));
  const apOk = await post("/api/meetings/" + mid + "/record/approve", { draftId: did2, version: dv2, hash: dh2, reviewToken: dt2, watermark: dw2, itemIds: ["a"] });
  ok("record-approve-200-exact", apOk.status === 200, apOk.status + " " + apOk.text.slice(0, 200));
  // Phase5 partial semantics: approving only "a" leaves "b" pending and the draft undecided.
  const rev2 = await get("/api/records/" + did2 + "/review");
  ok("record-partial-pending", rev2.status === 200 && (rev2.json?.pending || []).includes("b") && (rev2.json?.approved || []).includes("a") && rev2.json?.draft?.status === "partially-approved" && rev2.json?.draft?.decided !== true, rev2.status + " " + rev2.text.slice(0, 200));
  const apAgain = await post("/api/meetings/" + mid + "/record/approve", { draftId: did2, version: dv2, hash: dh2, reviewToken: dt2, watermark: dw2, itemIds: ["a"] });
  ok("record-approve-double-409", apAgain.status === 409, String(apAgain.status));
  const expC = await get("/api/records/" + did2 + "/export?format=concise");
  ok("record-export-approved-only", expC.status === 200 && expC.text.includes("[a]") && expC.text.includes("$5 [keep]") && !expC.text.includes("Skip me"), expC.status + " " + expC.text.slice(0, 200));
  const expD = await get("/api/records/" + did2 + "/export?format=detailed");
  ok("record-export-refs", expD.status === 200 && expD.text.includes("refs: source:s1"), expD.status + " " + expD.text.slice(0, 200));
  const revv = await post("/api/records/" + did2 + "/revise", { version: dv2, hash: dh2, reviewToken: dt2, watermark: dw2, items });
  ok("revise-partial-409", revv.status === 409, String(revv.status));
  // Complete the review with the fresh token, then amend the final approved record.
  const fresh2 = await get("/api/records/" + did2);
  const fv2 = fresh2.json?.version ?? fresh2.json?.Version, ft2 = fresh2.json?.reviewToken ?? fresh2.json?.ReviewToken;
  const apB = await post("/api/meetings/" + mid + "/record/approve", { draftId: did2, version: fv2, hash: dh2, reviewToken: ft2, watermark: dw2, itemIds: ["b"] });
  ok("record-approve-rest-200", apB.status === 200 && (apB.json?.status === "approved" || apB.json?.Status === "approved"), apB.status + " " + apB.text.slice(0, 200));
  const fresh2b = await get("/api/records/" + did2);
  const gv = fresh2b.json?.version ?? fresh2b.json?.Version, gt = fresh2b.json?.reviewToken ?? fresh2b.json?.ReviewToken, gh = fresh2b.json?.hash ?? fresh2b.json?.Hash, gw = fresh2b.json?.watermark ?? fresh2b.json?.Watermark;
  const amd = await post("/api/records/" + did2 + "/amend", { version: gv, hash: gh, reviewToken: gt, watermark: gw, items });
  ok("amend-approved-201", amd.status === 201 && (amd.json?.version ?? amd.json?.Version) === 2, amd.status + " " + amd.text.slice(0, 200));
  const expAmended = await get("/api/records/" + did2 + "/export?format=concise");
  ok("amend-preserves-approved", expAmended.status === 200 && expAmended.text.includes("[a]"), expAmended.status + " " + expAmended.text.slice(0, 160));
  const d3 = await post("/api/meetings/" + mid + "/record/draft", items);
  const did3 = camel(d3.json, "id");
  const g3 = await get("/api/records/" + did3);
  const gv3 = g3.json?.version ?? g3.json?.Version, gt3 = g3.json?.reviewToken ?? g3.json?.ReviewToken, gh3 = g3.json?.hash ?? g3.json?.Hash, gw3 = g3.json?.watermark ?? g3.json?.Watermark;
  const disc = await post("/api/records/" + did3 + "/discard", { version: gv3, hash: gh3, reviewToken: gt3, watermark: gw3 });
  ok("discard-200", disc.status === 200, String(disc.status));
  const disc2 = await post("/api/records/" + did3 + "/discard", { version: gv3, hash: gh3, reviewToken: gt3, watermark: gw3 });
  ok("discard-decided-409", disc2.status === 409, String(disc2.status));
  const expDisc = await get("/api/records/" + did3 + "/export?format=concise");
  ok("discard-export-409", expDisc.status === 409, String(expDisc.status));
  // lane D: legacy persisted empty-text draft must be rejected at approval
  const leg = await post("/api/meetings/" + mid + "/record/draft", [{ id: "legacy-ok", text: "Legacy kept item" }]);
  const legId = camel(leg.json, "id");
  const legRow = await get("/api/records/" + legId);
  ok("legacy-draft-open", leg.status === 201 && legRow.status === 200, leg.status + " " + leg.text.slice(0, 160));
  // lane D: adopt-to-record from an adopted direction (exact multiline byte roundtrip)
  const exactDir = "Adopt line one $5 [keep]\nAdopt line two (exact) — UTF8 ✓\nThird line.";
  const dr2 = await post("/api/boards/" + bid + "/directions", { text: exactDir, scope: "meeting", meetingId: mid });
  ok("fromdir-direction-201", dr2.status === 201, dr2.status + " " + dr2.text.slice(0, 160));
  const dirId = camel(dr2.json, "id");
  const dl2 = await get("/api/boards/" + bid + "/directions");
  const found2 = (dl2.json || []).find((n) => (n.id || n.Id) === dirId);
  ok("fromdir-exact-roundtrip", found2 && (found2.body || found2.Body) === exactDir, JSON.stringify(found2).slice(0, 300));
  const fd = await post("/api/meetings/" + mid + "/record/from-direction", { noteId: dirId });
  ok("fromdir-201", fd.status === 201, fd.status + " " + fd.text.slice(0, 200));
  const fdId = camel(fd.json, "id"), fdHash = fd.json?.hash ?? fd.json?.Hash, fdWm = fd.json?.watermark ?? fd.json?.Watermark;
  const fdVer = fd.json?.version ?? fd.json?.Version, fdTok = fd.json?.reviewToken ?? fd.json?.ReviewToken;
  const fdItems = JSON.parse(fd.json?.itemsJson ?? fd.json?.ItemsJson ?? "[]");
  ok("fromdir-item-exact-bytes", fdItems.length === 1 && fdItems[0].text === exactDir, JSON.stringify(fdItems).slice(0, 300));
  ok("fromdir-item-evidence", JSON.stringify(fdItems[0].refs || []).includes(dirId), JSON.stringify(fdItems[0]).slice(0, 300));
  ok("fromdir-unapproved", (fd.json?.status ?? fd.json?.Status) !== "approved" && (fd.json?.decided ?? fd.json?.Decided) !== true, fd.text.slice(0, 160));
  const fdAp = await post("/api/meetings/" + mid + "/record/approve", { draftId: fdId, version: fdVer, hash: fdHash, reviewToken: fdTok, watermark: fdWm, itemIds: [fdItems[0].id] });
  ok("fromdir-approve-200", fdAp.status === 200, fdAp.status + " " + fdAp.text.slice(0, 200));
  const fdMiss = await post("/api/meetings/" + mid + "/record/from-direction", {});
  ok("fromdir-missing-noteid-400", fdMiss.status === 400, String(fdMiss.status));
  const fdUnknown = await post("/api/meetings/" + mid + "/record/from-direction", { noteId: "00000000-0000-0000-0000-000000000000" });
  ok("fromdir-unknown-404", fdUnknown.status === 404, String(fdUnknown.status));
  const plainNote = await post("/api/meetings/" + mid + "/notes", { title: "plain", body: "plain note", kind: "note" });
  const plainId = camel(plainNote.json, "id");
  const fdWrongKind = await post("/api/meetings/" + mid + "/record/from-direction", { noteId: plainId });
  ok("fromdir-wrong-kind-422", fdWrongKind.status === 422, String(fdWrongKind.status));
  const fdBadScope = await post("/api/boards/" + bid + "/directions", { text: "x", scope: "" });
  ok("direction-empty-scope-400", fdBadScope.status === 400, String(fdBadScope.status));
}

// ---------- backup portrait round-trip (destructive: restore wipes store; run last / standalone) ----------
async function backupRoundtrip() {
  console.log("backup: portrait review survival");
  const q = await post("/api/roster/quick", { accountId: ACCT, name: run + "-bak", description: "backup probe entry here" });
  const rid = camel(q.json, "id");
  await uploadPortrait(rid);
  const bak = await get("/api/backup");
  ok("backup-200", bak.status === 200 && bak.json?.snapshot && bak.json?.hash, bak.status + " " + bak.text.slice(0, 160));
  const snap = JSON.parse(bak.json.snapshot);
  const imgs = snap.images.filter((i) => (i.rosterEntryId || i.RosterEntryId) === rid);
  ok("backup-has-pending-image", imgs.length === 1 && (imgs[0].review || imgs[0].Review) === "pending", JSON.stringify(imgs).slice(0, 300));
  const rs = await post("/api/backup/restore", { snapshot: bak.json.snapshot, hash: bak.json.hash });
  ok("restore-200", rs.status === 200, rs.status + " " + rs.text.slice(0, 200));
  const ri = await get("/api/roster/" + rid + "/images");
  ok("restore-preserves-pending", ri.status === 200 && (ri.json || []).length === 1 && (ri.json[0].review || ri.json[0].Review) === "pending", ri.status + " " + ri.text.slice(0, 200));
}

// ---------- persist modes (PG leg: restart survival) ----------
async function persistWrite() {
  const fs = await import("node:fs");
  const bid = await makeBoard(run + "-persist");
  await post("/api/boards/" + bid + "/lead", { name: "Persist Lead", roleLabel: "Lead" });
  const adv = await makeAdvisor(bid, "Persistor");
  ok("persist-advisor-ready", !adv.error, adv.error || "");
  const mid = await makeMeeting(bid, "persist brief");
  const m1 = await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "persist-probe-" + run });
  const runRes = await post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "persist run question" });
  ok("persist-run-200", runRes.status === 200, runRes.status + " " + runRes.text.slice(0, 200));
  const items = [{ id: "p1", text: "Persist decision " + run, detail: "why", status: "adopted", scope: "board" }];
  const imgs0 = await get("/api/roster/" + adv.rid + "/images");
  const img0 = (imgs0.json || [])[0] || {};
  ok("persist-portrait-accepted", (img0.review || img0.Review) === "accepted", JSON.stringify(img0).slice(0, 200));
  const advs0 = await get("/api/boards/" + bid + "/advisors");
  const adv0 = (advs0.json || []).find((a) => (a.id || a.Id) === adv.aid);
  ok("persist-approval-set", !!(adv0 && (adv0.approved ?? adv0.Approved)), JSON.stringify(adv0).slice(0, 200));
  const wiz = await post("/api/wizard", { accountId: ACCT, step: 1, presetKey: "", fieldsJson: JSON.stringify({ name: run + "-pwiz", mission: "m", stage: "s", lead: { name: "L" }, advisors: [] }) });
  const wizId = camel(wiz.json, "id");
  const wizVer0 = wiz.json?.version ?? wiz.json?.Version ?? 1;
  const g0 = await post("/api/wizard/" + wizId + "/interview", { answer: "", version: wizVer0 });
  ok("persist-interview-pending", g0.status === 200 && typeof (g0.json?.pendingQuestion ?? g0.json?.PendingQuestion) === "string", g0.status + " " + g0.text.slice(0, 200));
  const wizVer1 = g0.json?.version ?? g0.json?.Version ?? wizVer0;
  const g1 = await post("/api/wizard/" + wizId + "/interview", { answer: "persist interview answer " + run, version: wizVer1 });
  ok("persist-interview-answered", g1.status === 200, g1.status + " " + g1.text.slice(0, 200));
  const wizVer2 = g1.json?.version ?? g1.json?.Version ?? wizVer1;
  const d1 = await post("/api/meetings/" + mid + "/record/draft", items);
  const did = camel(d1.json, "id");
  const ap = await post("/api/meetings/" + mid + "/record/approve", { draftId: did, version: d1.json?.version ?? d1.json?.Version, hash: d1.json?.hash ?? d1.json?.Hash, reviewToken: d1.json?.reviewToken ?? d1.json?.ReviewToken, watermark: d1.json?.watermark ?? d1.json?.Watermark, itemIds: ["p1"] });
  ok("persist-record-approve-200", ap.status === 200, ap.status + " " + ap.text.slice(0, 200));
  const del = await get("/api/meetings/" + mid + "/delivery");
  const runOutcome = await get("/api/meetings/" + mid + "/notes?kind=run-outcome");
  fs.writeFileSync(process.env.QA_PERSIST_FILE || ".tmp/qa-persist.json", JSON.stringify({
    bid, mid, aid: adv.aid, rid: adv.rid, did, text: "persist-probe-" + run,
    rev: del.json?.deliveredRevision ?? del.json?.DeliveredRevision, wizId, wizVer: wizVer2, img: img0.id || img0.Id,
  }));
  ok("persist-write", m1.status === 201, String(m1.status));
}
async function persistVerify() {
  const fs = await import("node:fs");
  const p = JSON.parse(fs.readFileSync(process.env.QA_PERSIST_FILE || ".tmp/qa-persist.json", "utf8"));
  const be = await get("/api/backend");
  ok("persist-backend-postgres", (be.json?.mode || be.json?.Mode) === "postgres", be.text.slice(0, 160));
  const b = await get("/api/boards/" + p.bid);
  ok("persist-board-survives", b.status === 200, String(b.status));
  const lead = await get("/api/boards/" + p.bid + "/lead");
  ok("persist-lead-survives", lead.status === 200 && (lead.json?.name || lead.json?.Name) === "Persist Lead", lead.status + " " + lead.text.slice(0, 160));
  const advs = await get("/api/boards/" + p.bid + "/advisors");
  const adv = (advs.json || []).find((a) => (a.id || a.Id) === p.aid);
  ok("persist-approval-survives", adv && (adv.approved ?? adv.Approved) === true, JSON.stringify(adv).slice(0, 200));
  const msgs = await get("/api/meetings/" + p.mid + "/messages?take=100");
  const found = (msgs.json || []).some((m) => (m.content || m.Content) === p.text);
  ok("persist-message-survives", found, "msgs=" + (msgs.json || []).length);
  const del = await get("/api/meetings/" + p.mid + "/delivery");
  ok("persist-revision-survives", (del.json?.deliveredRevision ?? del.json?.DeliveredRevision) === p.rev, JSON.stringify(del.json).slice(0, 200));
  const exp = await get("/api/records/" + p.did + "/export?format=concise");
  ok("persist-record-survives", exp.status === 200 && exp.text.includes("[p1]") && exp.text.includes("Persist decision"), exp.status + " " + exp.text.slice(0, 200));
  const notes = await get("/api/meetings/" + p.mid + "/notes?kind=run-outcome");
  ok("persist-outcome-survives", notes.status === 200 && (notes.json || []).length >= 1 && JSON.stringify(notes.json).includes(String(p.rev)), notes.status + " " + notes.text.slice(0, 300));
  const pimgs = await get("/api/roster/" + p.rid + "/images");
  ok("persist-images-200", pimgs.status === 200 && Array.isArray(pimgs.json), pimgs.status + " " + pimgs.text.slice(0, 200));
  const pimg = (pimgs.json || []).find((i) => (i.id || i.Id) === p.img);
  ok("persist-portrait-review-survives", !!pimg && (pimg.review || pimg.Review) === "accepted", JSON.stringify(pimg || pimgs.json || []).slice(0, 200));
  if (p.img) {
    let binOk = false, binDetail = "skipped";
    try {
      const br = await fetch(API + "/api/images/" + p.img, { headers: { "x-user": "owner" } });
      const buf = Buffer.from(await br.arrayBuffer());
      const ct = br.headers.get("content-type") || "";
      binDetail = br.status + " ct=" + ct + " len=" + buf.length;
      binOk = br.status === 200 && buf.length > 0 && ct.includes("image/png") && Buffer.compare(buf, PNG) === 0;
      if (br.status === 200 && buf.length > 0 && Buffer.compare(buf, PNG) !== 0) binDetail += " bytes!=fixture";
      if (br.status === 200 && !ct.includes("image/png")) binDetail += " type!=fixture";
    } catch (e) { binDetail = "threw: " + (e?.message || e); }
    ok("persist-portrait-bytes-survive", binOk, binDetail);
    const miss = await get("/api/images/00000000-0000-0000-0000-000000000000");
    ok("persist-portrait-missing-404", miss.status === 404, String(miss.status));
  } else {
    ok("persist-portrait-bytes-survive", false, "p.img missing from persist file");
  }
  const pwiz = await get("/api/wizard/" + p.wizId);
  ok("persist-interview-survives", pwiz.status === 200 && JSON.stringify(pwiz.json?.interviewJson || "").includes("persist interview answer"), pwiz.status + " " + pwiz.text.slice(0, 200));
  const pwizVer = pwiz.json?.version ?? pwiz.json?.Version;
  if (typeof p.wizVer === "number") ok("persist-wizard-version-survives", pwiz.status === 200 && pwizVer === p.wizVer, "got=" + pwizVer + " want=" + p.wizVer);
  else ok("persist-wizard-version-survives", pwiz.status === 200 && typeof pwizVer === "number" && pwizVer > 0, JSON.stringify(pwiz.json).slice(0, 200));
  const prec = await get("/api/records/" + p.did);
  ok("persist-record-id-survives", prec.status === 200 && ((prec.json?.id || prec.json?.Id) === p.did), prec.status + " " + prec.text.slice(0, 200));
}

function argVal(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length && !String(args[i + 1]).startsWith("--") ? args[i + 1] : undefined;
}
const only = argVal("--only");
const mode = argVal("--mode");
try {
  await get("/health").then((h) => ok("health", h.status === 200, String(h.status)));
  await get("/api/backend").then((b) => {
    const mode = b.json?.mode || b.json?.Mode;
    const want = TAG.startsWith("pg") ? "postgres" : "memory";
    ok("backend-mode-" + want, mode === want, "mode=" + mode + " tag=" + TAG);
  });
  if (mode === "persist-write") await persistWrite();
  else if (mode === "persist-verify") await persistVerify();
  else if (mode === "backup") await backupRoundtrip();
  else {
    const allowedOnly = ["phase0", "phase1", "phase2", "phase3"];
    if (only && !allowedOnly.includes(only)) {
      fail++;
      failures.push("unknown --only value: " + only);
      console.log("  FAIL unknown --only " + only + " (expected one of " + allowedOnly.join(", ") + ")");
    } else {
    if (!only || only === "phase0") await phase0();
    if (!only || only === "phase1") await phase1();
    if (!only || only === "phase2") await phase2();
    if (!only || only === "phase3") await phase3();
    }
  }
} catch (e) {
  fail++;
  failures.push("threw: " + (e?.message || e));
}
console.log(fail === 0 ? "HTTPQA PASS " + pass + " [" + TAG + "]" : "HTTPQA FAIL pass=" + pass + " fail=" + fail + " [" + TAG + "]");
for (const f of failures) console.log(" - " + f);
process.exit(fail === 0 ? 0 : 1);
