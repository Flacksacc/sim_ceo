// Lane B discussion regression: sync/edit during generation, per-lead cap,
// terminal run outcomes, wizard version guard. Real HTTP against the API
// under test (default http://127.0.0.1:5099). Refuses :5080 entirely.
// Existing fake-provider protocol only (QA-SLEEP / QA-NO / QA-ABSTAIN).
// Unique owned data per run (qa-reg-*); never touches other boards.
// DEFERRED by default: do not run until the primary integration barrier
// clears; do not restart shared servers to run this file.
import crypto from "node:crypto";

const API = process.env.QA_API || "http://127.0.0.1:5099";
if (API.includes(":5080")) {
  console.error("REFUSE 5080: discussion-regression must not run against the shared dev server; use QA_API=http://127.0.0.1:5099.");
  process.exit(2);
}

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
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
const run = "qa-reg-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function runOutcomes(mid) {
  const n = await get("/api/meetings/" + mid + "/notes?kind=run-outcome");
  return n.json || [];
}
// Actual lead sequence for a turn: max lead-message sequence in the meeting.
// Cap records persist per leadSeq, so every cap assertion pins this value.
async function leadSeqAfter(mid) {
  const msgs = await get("/api/meetings/" + mid + "/messages?take=100");
  const leads = (msgs.json || []).filter((m) => (m.sender || m.Sender) === "lead");
  return leads.reduce((mx, m) => Math.max(mx, Number(m.sequence ?? m.Sequence ?? 0)), 0);
}
// Persisted run-cap rows for one lead turn (body carries leadSeq/cap/policy).
async function capNotesFor(mid, leadSeq, o) {
  const notes = await get("/api/meetings/" + mid + "/notes?kind=run-cap", o);
  const rows = [];
  for (const n of (notes.json || [])) {
    try {
      const b = JSON.parse(n.body ?? n.Body ?? "{}");
      if (Number(b.leadSeq) === Number(leadSeq)) rows.push({ id: n.id ?? n.Id, body: b });
    } catch { /* unparseable bodies never satisfy a cap assertion */ }
  }
  return { status: notes.status, rows };
}
function yieldedReasons(runJson) {
  return ((runJson && runJson.yielded) || []).map((y) => y.reason || y.Reason);
}
async function wizardGuards() {
  console.log("lane-b: wizard save version guard");
  const w = await post("/api/wizard", { accountId: ACCT, step: 1, presetKey: "", fieldsJson: "{}" });
  ok("wizard-create-200", w.status === 200 && camel(w.json, "id"), w.status + " " + w.text.slice(0, 160));
  const wid = camel(w.json, "id");
  const wv0 = camel(w.json, "version") ?? 1;
  const missing = await post("/api/wizard", { id: wid, accountId: ACCT, step: 1, fieldsJson: "{}" });
  ok("wizard-missing-version-409", missing.status === 409, String(missing.status) + " " + missing.text.slice(0, 160));
  const nonnum = await post("/api/wizard", { id: wid, version: "1", accountId: ACCT, step: 1, fieldsJson: "{}" });
  ok("wizard-nonnumeric-version-409", nonnum.status === 409, String(nonnum.status) + " " + nonnum.text.slice(0, 160));
  const good = await post("/api/wizard", { id: wid, version: wv0, accountId: ACCT, step: 1, fieldsJson: "{}" });
  ok("wizard-int-version-200", good.status === 200 && (camel(good.json, "version") === wv0 + 1), good.status + " " + good.text.slice(0, 200));
}

async function syncBlocks() {
  console.log("lane-b: slow run then sync-roster blocks publication");
  const bid = await makeBoard(run + "-sync");
  await post("/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Lead" });
  const a = await makeAdvisor(bid, "SyncSolo");
  ok("sync-advisor-ready", !a.error, a.error || "");
  const mid = await makeMeeting(bid, "sync brief");
  await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "QA sync probe question" });
  const slow = post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "QA-SLEEP:4000 sync probe" }, { timeout: 90000 });
  await sleep(700);
  const sy = await post("/api/boards/" + bid + "/advisors/" + a.aid + "/sync-roster", {});
  ok("sync-mid-run-200", sy.status === 200, String(sy.status));
  const done = await slow;
  ok("sync-run-200-blocked", done.status === 200 && (done.json?.published?.length ?? -1) === 0, done.status + " " + done.text.slice(0, 300));
  const reasons = (done.json?.yielded || []).map((y) => y.reason || y.Reason);
  ok("sync-yield-reason", reasons.some((r) => ["reapproval-required", "not-eligible", "stale-profile"].includes(r)), JSON.stringify(reasons));
  const notes = await runOutcomes(mid);
  const last = notes[0] || {};
  ok("sync-terminal-outcome", JSON.stringify(last).includes("completed") || JSON.stringify(last).includes("Run: 0 replies"), JSON.stringify(last).slice(0, 300));
}

async function profileChangeBlocks() {
  console.log("lane-b: profile input change during generation blocks publication");
  const bid = await makeBoard(run + "-prof");
  await post("/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Lead" });
  const a = await makeAdvisor(bid, "ProfSolo");
  ok("prof-advisor-ready", !a.error, a.error || "");
  const mid = await makeMeeting(bid, "profile brief");
  await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "QA profile probe question" });
  const slow = post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "QA-SLEEP:4000 profile probe" }, { timeout: 90000 });
  await sleep(700);
  const ed = await put("/api/roster/" + a.rid, { profileJson: JSON.stringify({ fictional: true, changed: run, padding: "0123456789abcdef0123456789" }) });
  ok("profile-edit-mid-run-200", ed.status === 200, String(ed.status) + " " + ed.text.slice(0, 160));
  const done = await slow;
  ok("profile-run-blocked", done.status === 200 && (done.json?.published?.length ?? -1) === 0, done.status + " " + done.text.slice(0, 300));
  const reasons = (done.json?.yielded || []).map((y) => y.reason || y.Reason);
  ok("profile-yield-reason", reasons.some((r) => ["reapproval-required", "not-eligible", "stale-profile"].includes(r)), JSON.stringify(reasons));
}

async function capHoldsAcrossPolicies() {
  console.log("lane-b: focused5 then balanced same-turn cap holds; new lead resets");
  const bid = await makeBoard(run + "-cap");
  await post("/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Lead" });
  const roles = ["C1", "C2", "C3", "C4", "C5", "C6"];
  for (const r of roles) {
    const a = await makeAdvisor(bid, r);
    ok("cap-advisor-" + r, !a.error, a.error || "");
  }
  const mid = await makeMeeting(bid, "cap brief");
  await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "QA cap turn question" });
  const L1 = await leadSeqAfter(mid);
  ok("cap-leadseq-recorded", L1 > 0, "leadSeq=" + L1);
  // Supported configuration only: PATCH the board, then run with NO body
  // policy. Production captures the effective board policy and deliberately
  // ignores body policy for every caller, so ordinary run requests must not
  // carry a policy override.
  const pf = await patch("/api/boards/" + bid, { discussionPolicy: "focused" });
  ok("cap-patch-focused-200", pf.status === 200, pf.status + " " + pf.text.slice(0, 200));
  const f = await post("/api/meetings/" + mid + "/run", { prompt: "QA cap question" }, { timeout: 90000 });
  ok("cap-focused-200", f.status === 200, f.status + " " + f.text.slice(0, 200));
  ok("cap-focused-five", (f.json?.published?.length ?? 0) === 5, "published=" + (f.json?.published?.length));
  ok("cap-focused-yield-omitted", yieldedReasons(f.json).includes("cap-omitted"), JSON.stringify(yieldedReasons(f.json)));
  ok("cap-focused-overflow", f.json?.overflow?.cap === 5 && f.json?.overflow?.policy === "focused", JSON.stringify(f.json?.overflow).slice(0, 200));
  const capF = await capNotesFor(mid, L1);
  ok("cap-note-persisted", capF.status === 200 && capF.rows.length === 1 && capF.rows[0].body.cap === 5 && capF.rows[0].body.policy === "focused", "rows=" + capF.rows.length + " " + JSON.stringify(capF.rows[0]?.body).slice(0, 160));
  // Same lead turn, between completed runs, no new lead message: the PATCHED
  // balanced policy governs, but the durable same-lead minimum of five stands.
  const pb = await patch("/api/boards/" + bid, { discussionPolicy: "balanced" });
  ok("cap-patch-balanced-200", pb.status === 200, pb.status + " " + pb.text.slice(0, 200));
  const b = await post("/api/meetings/" + mid + "/run", { prompt: "QA cap followup" }, { timeout: 90000 });
  ok("cap-balanced-same-turn-200", b.status === 200, b.status + " " + b.text.slice(0, 200));
  ok("cap-balanced-no-sixth", (b.json?.published?.length ?? -1) === 0, "published=" + (b.json?.published?.length));
  ok("cap-balanced-yield-omitted", yieldedReasons(b.json).includes("cap-omitted"), JSON.stringify(yieldedReasons(b.json)));
  ok("cap-balanced-overflow", b.json?.overflow?.cap === 5 && b.json?.overflow?.policy === "balanced", JSON.stringify(b.json?.overflow).slice(0, 200));
  const capB = await capNotesFor(mid, L1);
  ok("cap-note-still-five", capB.status === 200 && capB.rows.length === 1 && capB.rows[0].body.cap === 5 && capB.rows[0].body.policy === "balanced", "rows=" + capB.rows.length + " " + JSON.stringify(capB.rows[0]?.body).slice(0, 160));
  const msgs = await get("/api/meetings/" + mid + "/messages?take=100");
  const turnAdvisor = (msgs.json || []).filter((m) => (m.sender || m.Sender) === "advisor" && (m.sequence ?? m.Sequence) > 1);
  ok("cap-turn-total-five", turnAdvisor.length === 5, "advisorMsgs=" + turnAdvisor.length);
  // Conflicting body policy must not override the configured board policy.
  const bo = await post("/api/meetings/" + mid + "/run", { policy: "focused", prompt: "QA body override probe" }, { timeout: 90000 });
  ok("cap-body-policy-ignored-200", bo.status === 200, bo.status + " " + bo.text.slice(0, 200));
  ok("cap-body-policy-no-sixth", (bo.json?.published?.length ?? -1) === 0, "published=" + (bo.json?.published?.length));
  const capBO = await capNotesFor(mid, L1);
  ok("cap-body-policy-note", capBO.rows.length === 1 && capBO.rows[0].body.cap === 5 && capBO.rows[0].body.policy === "balanced", JSON.stringify(capBO.rows[0]?.body).slice(0, 160));
  await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "QA new lead question resets turn" });
  const L2 = await leadSeqAfter(mid);
  ok("cap-new-leadseq-recorded", L2 > L1, "L1=" + L1 + " L2=" + L2);
  const nb = await post("/api/meetings/" + mid + "/run", { prompt: "QA reset answers" }, { timeout: 90000 });
  ok("cap-new-lead-publishes", nb.status === 200 && (nb.json?.published?.length ?? 0) === 6, nb.status + " published=" + (nb.json?.published?.length));
  const capN = await capNotesFor(mid, L2);
  ok("cap-new-lead-ten", capN.status === 200 && capN.rows.length === 1 && capN.rows[0].body.cap === 10, "rows=" + capN.rows.length + " " + JSON.stringify(capN.rows[0]?.body).slice(0, 160));

  return { bid, mid, L1 };
}

async function capRestrictedSecure(bid, mid, L1) {
  console.log("lane-b: secure discuss-only caller runs but cannot reconfigure or override policy");
  // Flipping this store to secure mode is permanent, so these real-identity
  // checks run last. The first registered account becomes installation admin;
  // the second is an ordinary account that receives only a meeting discuss
  // grant. Bearer identity takes precedence over the demo header.
  const adm = await post("/api/auth/register", { email: run + "-discadmin@example.test", password: "Qa-disc-" + run.slice(0, 8) + "-x9admin" });
  ok("cap-secure-admin-register", (adm.status === 201 || adm.status === 200) && camel(adm.json, "token"), "status=" + adm.status);
  const adminTok = camel(adm.json, "token") || "";
  const du = await post("/api/auth/register", { email: run + "-discuss@example.test", password: "Qa-disc-" + run.slice(0, 8) + "-x9user12" });
  ok("cap-secure-discuss-register", (du.status === 201 || du.status === 200) && camel(du.json, "token"), "status=" + du.status);
  const discussTok = camel(du.json, "token") || "";
  const auth = (tok) => ({ headers: { authorization: "Bearer " + tok } });
  const gr = await post("/api/boards/" + bid + "/grants", { meetingId: mid, userKey: run + "-discuss@example.test", access: "discuss" }, auth(adminTok));
  ok("cap-secure-grant-201", gr.status === 201, "status=" + gr.status + " " + gr.text.slice(0, 200));
  const dr = await post("/api/meetings/" + mid + "/run", { prompt: "QA secure discuss run probe" }, { timeout: 90000, ...auth(discussTok) });
  ok("cap-secure-discuss-run-200", dr.status === 200, dr.status + " " + dr.text.slice(0, 200));
  ok("cap-secure-discuss-no-new", (dr.json?.published?.length ?? -1) === 0, "published=" + (dr.json?.published?.length));
  const dp = await patch("/api/boards/" + bid, { discussionPolicy: "open" }, auth(discussTok));
  ok("cap-secure-discuss-patch-denied", dp.status === 403, "status=" + dp.status + " " + dp.text.slice(0, 160));
  const da = await post("/api/boards/" + bid + "/setup/activate", { hash: "0".repeat(64) }, auth(discussTok));
  ok("cap-secure-discuss-activate-denied", da.status === 403, "status=" + da.status + " " + da.text.slice(0, 160));
  const dCfg = await get("/api/boards/" + bid + "/setup", auth(adminTok));
  ok("cap-secure-policy-unchanged", camel(dCfg.json?.board, "discussionPolicy") === "balanced", "policy=" + camel(dCfg.json?.board, "discussionPolicy"));
  const dOverride = await post("/api/meetings/" + mid + "/run", { policy: "open", prompt: "QA secure discuss override probe" }, { timeout: 90000, ...auth(discussTok) });
  ok("cap-secure-discuss-override-ignored", dOverride.status === 200 && (dOverride.json?.published?.length ?? -1) === 0, dOverride.status + " published=" + (dOverride.json?.published?.length));
  const capD = await capNotesFor(mid, L1, auth(adminTok));
  ok("cap-secure-note-unchanged", capD.rows.length === 1 && capD.rows[0].body.cap === 5 && capD.rows[0].body.policy === "balanced", JSON.stringify(capD.rows[0]?.body).slice(0, 160));
}

async function capActivatedBoard() {
  console.log("lane-b: activated board keeps focused until a fresh-hash activation switches it");
  const bid = await makeBoard(run + "-capact");
  await post("/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Lead" });
  for (const r of ["D1", "D2", "D3", "D4", "D5", "D6"]) {
    const a = await makeAdvisor(bid, r);
    ok("capact-advisor-" + r, !a.error, a.error || "");
  }
  const pf = await patch("/api/boards/" + bid, { discussionPolicy: "focused" });
  ok("capact-patch-focused-200", pf.status === 200, pf.status + " " + pf.text.slice(0, 200));
  const s0 = await get("/api/boards/" + bid + "/setup");
  const h0 = camel(s0.json, "draftHash") || "";
  ok("capact-hash-present", s0.status === 200 && !!h0, "status=" + s0.status);
  const ac = await post("/api/boards/" + bid + "/setup/activate", { hash: h0 });
  ok("capact-activate-200", ac.status === 200, ac.status + " " + ac.text.slice(0, 300));
  const mid = await makeMeeting(bid, "capact brief");
  await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "QA capact turn question" });
  const L1 = await leadSeqAfter(mid);
  ok("capact-leadseq-recorded", L1 > 0, "leadSeq=" + L1);
  const f = await post("/api/meetings/" + mid + "/run", { prompt: "QA capact question" }, { timeout: 90000 });
  ok("capact-focused-200", f.status === 200, f.status + " " + f.text.slice(0, 200));
  ok("capact-focused-five", (f.json?.published?.length ?? 0) === 5, "published=" + (f.json?.published?.length));
  const capF = await capNotesFor(mid, L1);
  ok("capact-note-focused", capF.rows.length === 1 && capF.rows[0].body.cap === 5 && capF.rows[0].body.policy === "focused", JSON.stringify(capF.rows[0]?.body).slice(0, 160));
  // Draft-only PATCH on an activated board leaves the focused effect in place.
  const pb = await patch("/api/boards/" + bid, { discussionPolicy: "balanced" });
  ok("capact-patch-balanced-200", pb.status === 200, pb.status + " " + pb.text.slice(0, 200));
  const b = await post("/api/meetings/" + mid + "/run", { prompt: "QA capact followup" }, { timeout: 90000 });
  ok("capact-still-focused-200", b.status === 200, b.status + " " + b.text.slice(0, 200));
  ok("capact-still-focused-no-new", (b.json?.published?.length ?? -1) === 0, "published=" + (b.json?.published?.length));
  const capB = await capNotesFor(mid, L1);
  ok("capact-note-still-focused", capB.rows.length === 1 && capB.rows[0].body.cap === 5 && capB.rows[0].body.policy === "focused", JSON.stringify(capB.rows[0]?.body).slice(0, 160));
  // Stale activation reviews fail closed; a fresh-hash activation switches.
  const stale = await post("/api/boards/" + bid + "/setup/activate", { hash: "0".repeat(64) });
  ok("capact-stale-hash-409", stale.status === 409, "status=" + stale.status + " " + stale.text.slice(0, 160));
  const s1 = await get("/api/boards/" + bid + "/setup");
  const h1 = camel(s1.json, "draftHash") || "";
  const ac2 = await post("/api/boards/" + bid + "/setup/activate", { hash: h1 });
  ok("capact-activate-balanced-200", ac2.status === 200, ac2.status + " " + ac2.text.slice(0, 300));
  const nb = await post("/api/meetings/" + mid + "/run", { prompt: "QA capact after activation" }, { timeout: 90000 });
  ok("capact-after-activate-200", nb.status === 200, nb.status + " " + nb.text.slice(0, 200));
  ok("capact-after-activate-no-new", (nb.json?.published?.length ?? -1) === 0, "published=" + (nb.json?.published?.length));
  const capN = await capNotesFor(mid, L1);
  ok("capact-note-balanced-five", capN.rows.length === 1 && capN.rows[0].body.cap === 5 && capN.rows[0].body.policy === "balanced", JSON.stringify(capN.rows[0]?.body).slice(0, 160));
}

async function pauseTerminal() {
  console.log("lane-b: pause mid-run leaves terminal outcome");
  const bid = await makeBoard(run + "-pint");
  await post("/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Lead" });
  const a = await makeAdvisor(bid, "PauseSolo");
  ok("pause-advisor-ready", !a.error, a.error || "");
  const mid = await makeMeeting(bid, "pause brief");
  await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "QA pause q" });
  const rp = post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "QA-SLEEP:4000 pause probe" }, { timeout: 90000 });
  await sleep(700);
  await post("/api/meetings/" + mid + "/pause", {});
  const done = await rp;
  ok("pause-run-409", done.status === 409, String(done.status) + " " + done.text.slice(0, 200));
  const notes = await runOutcomes(mid);
  const term = notes.find((n) => JSON.stringify(n).includes("interrupted")) || notes[0] || {};
  const body = typeof (term.body ?? term.Body) === "string" ? (term.body ?? term.Body) : JSON.stringify(term.body ?? term.Body ?? "");
  ok("pause-terminal-status", body.includes("interrupted"), body.slice(0, 300));
  ok("pause-terminal-reason", body.includes("meeting state changed"), body.slice(0, 300));
  ok("pause-terminal-remaining", body.includes("PauseSolo"), body.slice(0, 300));
  const after = await get("/api/meetings/" + mid + "/messages?take=100");
  ok("pause-no-drafts", (after.json || []).filter((m) => (m.sender || m.Sender) === "advisor").length === 0, "advisorMsgs present");
}

await wizardGuards();
await syncBlocks();
await profileChangeBlocks();
const capIds = await capHoldsAcrossPolicies();
await capActivatedBoard();
await pauseTerminal();
await capRestrictedSecure(capIds.bid, capIds.mid, capIds.L1);

console.log("PASS " + pass + " FAIL " + fail);
if (failures.length) console.log("failures:\n" + failures.join("\n"));
process.exit(fail ? 1 : 0);
