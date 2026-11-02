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
  const f = await post("/api/meetings/" + mid + "/run", { policy: "focused", prompt: "QA cap question" }, { timeout: 90000 });
  ok("cap-focused-200", f.status === 200, f.status + " " + f.text.slice(0, 200));
  ok("cap-focused-five", (f.json?.published?.length ?? 0) === 5, "published=" + (f.json?.published?.length));
  const b = await post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "QA cap followup" }, { timeout: 90000 });
  ok("cap-balanced-same-turn-200", b.status === 200, b.status + " " + b.text.slice(0, 200));
  ok("cap-balanced-no-sixth", (b.json?.published?.length ?? -1) === 0, "published=" + (b.json?.published?.length));
  const msgs = await get("/api/meetings/" + mid + "/messages?take=100");
  const turnAdvisor = (msgs.json || []).filter((m) => (m.sender || m.Sender) === "advisor" && (m.sequence ?? m.Sequence) > 1);
  ok("cap-turn-total-five", turnAdvisor.length === 5, "advisorMsgs=" + turnAdvisor.length);
  const capNotes = await get("/api/meetings/" + mid + "/notes?kind=run-cap");
  const capBodies = (capNotes.json || []).map((n) => { try { return JSON.parse(n.body ?? n.Body ?? "{}"); } catch { return {}; } });
  ok("cap-note-persisted", capNotes.status === 200 && capBodies.some((b) => b.cap === 5 && typeof b.leadSeq === "number"), capNotes.text.slice(0, 200));
  await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "QA new lead question resets turn" });
  const nb = await post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "QA reset answers" }, { timeout: 90000 });
  ok("cap-new-lead-publishes", nb.status === 200 && (nb.json?.published?.length ?? 0) === 6, nb.status + " published=" + (nb.json?.published?.length));
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
await capHoldsAcrossPolicies();
await pauseTerminal();

console.log("PASS " + pass + " FAIL " + fail);
if (failures.length) console.log("failures:\n" + failures.join("\n"));
process.exit(fail ? 1 : 0);
