import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Backend-owned HTTP QA for roster integrity integration (isolated fixture).
// Run: node qa/roster-backend-qa.mjs
// Spins its OWN api (127.0.0.1:15971, memory mode) + fake provider (:15972).
// Touches nothing else: never 5173/5080/9333/5099/15441, no PG, no Docker.
// Covers: attach gates (roster-only/cap/dup/completeness), canonical read
// projection, canonical edits in generated context (roster-chat prompt log),
// stale-generation rejection (discussion run), orphan recovery (stale/dup/
// missing/archived) via plan+apply, owner boundary, research progress,
// roster-only chat + retired board chat (410), backup/restore roundtrip.
const API = "http://127.0.0.1:15971";
const FAKE = "http://127.0.0.1:15972";
import { fileURLToPath } from "node:url";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))) + path.sep;
let pass = 0, fail = 0;
const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; bad.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(method, p, body, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 60000);
  try {
    const headers = { ...(opts.headers || {}) };
    if (!opts.user || opts.user !== false) headers["x-user"] = opts.user || "owner";
    let b;
    if (body !== undefined && typeof body !== "object") { b = body; }
    else if (body !== undefined && !(body instanceof FormData)) { headers["content-type"] = "application/json"; b = JSON.stringify(body); }
    else if (body instanceof FormData) b = body;
    const r = await fetch(API + p, { method, signal: ctl.signal, headers, body: b });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const get = (p, o) => req("GET", p, undefined, o);
const post = (p, b, o) => req("POST", p, b, o);
const put = (p, b, o) => req("PUT", p, b, o);
const guid = () => globalThis.crypto.randomUUID();
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
async function waitUp(url, secs = 60) {
  const end = Date.now() + secs * 1000;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await sleep(500);
  }
  return false;
}
let apiProc = null, fakeProc = null, qaKeyring = "";
function rmDirVerified(dir, prefix) {
  try {
    const base = path.resolve(os.tmpdir()) + path.sep;
    const full = path.resolve(dir);
    if (!full.startsWith(base)) return false;
    if (path.basename(full).indexOf(prefix) !== 0) return false;
    fs.rmSync(full, { recursive: true, force: true });
    return true;
  } catch { return false; }
}
function start() {
  const keyring = fs.mkdtempSync(path.join(os.tmpdir(), "roster-qa-keyring-"));
  qaKeyring = keyring;
  fs.appendFileSync("C:/Users/War/scrach/sim_ceo/.tmp/feedback-backend/qa-roster-backend-qa.spawn.log", "spawn fake: " + path.join(ROOT, "qa/fake-provider.mjs") + "\n");
  fakeProc = spawn(process.execPath, [path.join(ROOT, "qa/fake-provider.mjs"), "--port", "15972"], { stdio: "ignore", windowsHide: true });
  fakeProc.on("error", (e) => fs.appendFileSync("C:/Users/War/scrach/sim_ceo/.tmp/feedback-backend/qa-roster-backend-qa.spawn.log", "fake spawn error: " + e + "\n"));
  const env = { ...process.env, ASPNETCORE_URLS: "http://127.0.0.1:15971", META_API_BASE: FAKE, META_API_KEY: "qa-key", SIMCEO_INSTANCE: "roster-qa", WIKI_KEYRING_DIR: keyring };
  delete env.USE_POSTGRES;
  apiProc = spawn("dotnet", ["run", "--project", path.join(ROOT, "server/SimCEO.Api/SimCEO.Api.csproj"), "--no-build", "-c", "Debug"], { env, stdio: "ignore", windowsHide: true });
  apiProc.on("error", (e) => fs.appendFileSync("C:/Users/War/scrach/sim_ceo/.tmp/feedback-backend/qa-roster-backend-qa.spawn.log", "api spawn error: " + e + "\n"));
}
function stop() { try { apiProc && apiProc.kill(); } catch {} try { fakeProc && fakeProc.kill(); } catch {} }

async function main() {
  start();
  ok("fake provider up", await waitUp(FAKE + "/__health", 30));
  ok("api up (isolated 15971)", await waitUp(API + "/health", 90));
  const be = await get("/api/backend");
  ok("backend memory mode", be.json && be.json.mode === "memory", JSON.stringify(be.json));

  // ---- B: board + attach gates ----
  const acct = guid();
  const board = await post("/api/boards", { name: "Roster QA Board", mission: "m", stage: "s" });
  ok("board created", board.status === 201 && board.json.id, board.status + " " + board.text.slice(0, 120));
  const bid = board.json.id;
  const q1 = await post("/api/roster/quick", { accountId: acct, name: "QA Advisor One", description: "A sufficiently long advisor description here." });
  ok("quick entry created", q1.status === 201 && q1.json.id, q1.status);
  const rid1 = q1.json.id;
  const bare = await post(`/api/boards/${bid}/advisors`, { rosterEntryId: rid1, boardRole: "Strategist" });
  ok("attach blocked while incomplete (no portrait)", bare.status === 409, bare.status);
  const fd = new FormData();
  fd.append("file", new Blob([PNG], { type: "image/png" }), "a.png");
  const up = await post(`/api/roster/${rid1}/image/upload`, fd);
  ok("portrait uploaded", up.status === 201 && up.json.id, up.status);
  const imgId = up.json.id;
  const rev = await post(`/api/images/${imgId}/review`, { decision: "accept" });
  ok("portrait accepted", rev.status === 200, rev.status);
  const a1 = await post(`/api/boards/${bid}/advisors`, { rosterEntryId: rid1, boardRole: "Strategist" });
  ok("attach via advisor POST (canonical link)", a1.status === 201 && a1.json.rosterEntryId === rid1, a1.status + " " + a1.text.slice(0, 160));
  const aid1 = a1.json.id;
  const dup = await post(`/api/boards/${bid}/advisors`, { rosterEntryId: rid1, boardRole: "Strategist" });
  ok("duplicate attach rejected", dup.status === 409, dup.status);
  const q2 = await post("/api/roster/quick", { accountId: acct, name: "QA Advisor Two", description: "Another sufficiently long advisor description." });
  const rid2 = q2.json.id;
  const fd2 = new FormData();
  fd2.append("file", new Blob([PNG], { type: "image/png" }), "b.png");
  await post(`/api/roster/${rid2}/image/upload`, fd2);
  const cp = await post(`/api/roster/${rid2}/copy`, { boardId: bid, boardRole: "Analyst" });
  ok("attach via roster copy", cp.status === 201, cp.status + " " + cp.text.slice(0, 160));
  ok("rosterless attach rejected", (await post(`/api/boards/${bid}/advisors`, { boardRole: "Ghost" })).status === 400);
  ok("unknown roster attach 404", (await post(`/api/boards/${bid}/advisors`, { rosterEntryId: guid() })).status === 404);
  // stranger (non-owner) cannot copy an unattached entry
  const qx = await post("/api/roster/quick", { accountId: acct, name: "QA Private", description: "Private entry with sufficient description text." });
  ok("stranger copy of unattached entry denied", (await post(`/api/roster/${qx.json.id}/copy`, { boardId: bid }, { user: "stranger" })).status === 403);
  ok("stranger roster write denied", (await put(`/api/roster/${rid1}`, { description: "hijack" }, { user: "stranger" })).status === 403);
  ok("stranger reconcile plan denied", (await post("/api/admin/roster-reconcile/plan", {}, { user: "stranger" })).status === 403);

  // ---- C: 10-member cap over HTTP ----
  for (let i = 3; i <= 10; i++) {
    const q = await post("/api/roster/quick", { accountId: acct, name: "QA Cap " + i, description: "Cap filler advisor number " + i + " with text." });
    const fdx = new FormData();
    fdx.append("file", new Blob([PNG], { type: "image/png" }), "c" + i + ".png");
    await post(`/api/roster/${q.json.id}/image/upload`, fdx);
    const ax = await post(`/api/boards/${bid}/advisors`, { rosterEntryId: q.json.id, boardRole: "Seat " + i });
    if (ax.status !== 201) { ok("cap fill " + i, false, ax.status + " " + ax.text.slice(0, 120)); break; }
    if (i === 10) ok("10 advisors attached", true);
  }
  const q11 = await post("/api/roster/quick", { accountId: acct, name: "QA Cap 11", description: "Eleventh advisor with sufficient text here." });
  const fd11 = new FormData();
  fd11.append("file", new Blob([PNG], { type: "image/png" }), "c11.png");
  await post(`/api/roster/${q11.json.id}/image/upload`, fd11);
  ok("11th attach blocked (cap)", (await post(`/api/boards/${bid}/advisors`, { rosterEntryId: q11.json.id, boardRole: "Extra" })).status === 409);

  // ---- D: canonical read projection + edit propagation ----
  const list1 = await get(`/api/boards/${bid}/advisors`);
  const row1 = (list1.json || []).find((a) => a.id === aid1);
  ok("projection carries canonical name", row1 && row1.rosterName === "QA Advisor One", JSON.stringify(row1).slice(0, 200));
  ok("projection not stale at pin", row1 && row1.stale === false && row1.rosterVersionCurrent === row1.rosterVersion, JSON.stringify(row1).slice(0, 200));
  const fp1 = row1.behaviorFingerprint;
  const edit = await put(`/api/roster/${rid1}`, { name: "QA Advisor One Renamed", description: "Updated description with sufficient length text." });
  ok("roster edit bumps version", edit.status === 200 && edit.json.version > 1, edit.status);
  const list2 = await get(`/api/boards/${bid}/advisors`);
  const row2 = list2.json.find((a) => a.id === aid1);
  ok("canonical edit reflected in projection", row2 && row2.rosterName === "QA Advisor One Renamed", JSON.stringify(row2).slice(0, 200));
  ok("projection flags stale pin", row2 && row2.stale === true && row2.rosterVersionCurrent > row2.rosterVersion, JSON.stringify(row2).slice(0, 200));
  ok("behavior fingerprint changes with edit", row2 && row2.behaviorFingerprint && row2.behaviorFingerprint !== fp1);
  const sync = await post(`/api/boards/${bid}/advisors/${aid1}/sync-roster`, {});
  ok("sync re-pins (unapproved)", sync.status === 200 && sync.json.approved === false, sync.status);
  const list3 = await get(`/api/boards/${bid}/advisors`);
  ok("projection fresh after sync", list3.json.find((a) => a.id === aid1).stale === false);
  ok("advisor approved after re-review", (await post(`/api/boards/${bid}/advisors/${aid1}/approve`, {})).status === 200);

  // ---- E: roster-only chat uses canonical current fields; board chat retired ----
  const chat1 = await post(`/api/roster/${rid1}/chat`, { message: "Hello advisor" });
  ok("roster chat answers", chat1.status === 200 && chat1.json.stored === false && chat1.json.rosterVersion === edit.json.version, chat1.status + " " + chat1.text.slice(0, 160));
  const log1 = await (await fetch(FAKE + "/__log")).json();
  const lastPrompt1 = (log1[log1.length - 1] || {}).full || "";
  ok("chat prompt carries canonical profile", lastPrompt1.includes("QA Advisor One Renamed"), lastPrompt1.slice(0, 120));
  const editedBehavior = await put(`/api/roster/${rid1}`, { profileJson: JSON.stringify({ ...JSON.parse(edit.json.profileJson), contributionCriteria: "CANONICAL-MARKER-42: contribute when an actionable tradeoff needs evaluation.", reasoningApproach: "Compare evidence, alternatives, and constraints before recommending a next step.", responseStyle: "Answer directly, explain disagreements, and state uncertainty plainly." }) });
  ok("canonical behavior edit saved", editedBehavior.status === 200 && editedBehavior.json.version > edit.json.version, editedBehavior.status);
  const chat2 = await post(`/api/roster/${rid1}/chat`, { message: "Hello again" });
  const log2 = await (await fetch(FAKE + "/__log")).json();
  const lastPrompt2 = (log2[log2.length - 1] || {}).full || "";
  ok("chat prompt reflects edited canonical profile", chat2.status === 200 && lastPrompt2.includes("CANONICAL-MARKER-42"), lastPrompt2.slice(0, 160));
  const oldChat = await post(`/api/boards/${bid}/advisors/${aid1}/chat`, { message: "hi" });
  ok("board direct chat retired (410 + roster route)", oldChat.status === 410 && oldChat.json && String(oldChat.json.rosterChat).includes(`/api/roster/${rid1}/chat`), oldChat.status + " " + oldChat.text.slice(0, 200));
  await post(`/api/boards/${bid}/advisors/${aid1}/sync-roster`, {});
  await post(`/api/boards/${bid}/advisors/${aid1}/approve`, {});

  // ---- E2: roster-chat edit/restore races prove the post-await guards ----
  const chatTag = "CHATEDIT-" + guid().slice(0, 8);
  const chatEditP = post(`/api/roster/${rid1}/chat`, { message: "QA-SLEEP:6000 " + chatTag + " edit race" }, { timeout: 120000 });
  let sawChatEdit = false;
  for (let ei = 0; ei < 40; ei++) {
    await sleep(250);
    const lge = await (await fetch(FAKE + "/__log")).json();
    if ((lge || []).some((e) => (e.full || "").includes(chatTag))) { sawChatEdit = true; break; }
  }
  ok("chat edit race held provider dispatch", sawChatEdit, "no dispatch");
  await put(`/api/roster/${rid1}`, { description: "Mid-chat canonical edit with sufficient length text." });
  const chatEdit = await chatEditP;
  ok("chat edit discards with version-change signal (no leak)", chatEdit.status === 409 && /(?:changed|edited) during generation/.test(chatEdit.text) && !/QA provisional text/.test(chatEdit.text), chatEdit.status + " " + chatEdit.text.slice(0, 200));
  await post(`/api/boards/${bid}/advisors/${aid1}/sync-roster`, {});
  await post(`/api/boards/${bid}/advisors/${aid1}/approve`, {});
  const chatTagR = "CHATRESTORE-" + guid().slice(0, 8);
  const bkChat = await get("/api/backup");
  ok("pre-chat-race backup captured", bkChat.status === 200 && typeof bkChat.json.snapshot === "string", bkChat.status);
  const chatRestoreP = post(`/api/roster/${rid1}/chat`, { message: "QA-SLEEP:6000 " + chatTagR + " restore race" }, { timeout: 120000 });
  let sawChatRestore = false;
  for (let cri = 0; cri < 40; cri++) {
    await sleep(250);
    const lgcr = await (await fetch(FAKE + "/__log")).json();
    if ((lgcr || []).some((e) => (e.full || "").includes(chatTagR))) { sawChatRestore = true; break; }
  }
  ok("chat restore race held provider dispatch", sawChatRestore, "no dispatch");
  const rsChat = await post("/api/backup/restore", { snapshot: bkChat.json.snapshot, hash: bkChat.json.hash }, { timeout: 120000 });
  const chatRestore = await chatRestoreP;
  ok("chat restore applied", rsChat.status === 200, rsChat.status);
  ok("chat restore discards with restore signal (no leak)", chatRestore.status === 409 && /restored during generation/.test(chatRestore.text) && !/QA provisional text/.test(chatRestore.text), chatRestore.status + " " + chatRestore.text.slice(0, 200));

  // ---- F: research progress for unified create flow ----
  const draft = await post("/api/roster/ai-draft", { accountId: acct, name: "QA Drafted", role: "Researcher", focus: "risk" }, { timeout: 120000 });
  ok("ai-draft creates researched entry", draft.status === 201 && draft.json.entry && draft.json.entry.id, draft.status + " " + draft.text.slice(0, 160));
  const dr = draft.json.entry.id;
  const rget = await get(`/api/roster/${dr}/research`);
  ok("research GET exposes progress fields", rget.status === 200 && rget.json.researchedAt && rget.json.running === false && typeof rget.json.evidenceCount === "number" && typeof rget.json.version === "number", JSON.stringify(rget.json).slice(0, 220));

  // ---- G: discussion baseline + stale-generation rejection ----
  const m1 = await post(`/api/boards/${bid}/meetings`, { title: "QA run baseline" });
  const run1 = await post(`/api/meetings/${m1.json.id}/run`, { prompt: "Should we expand carefully?" }, { timeout: 120000 });
  ok("baseline discussion run publishes", run1.status === 200 && (run1.json.published || []).length >= 1, run1.status + " " + run1.text.slice(0, 220));
  const probeTag = "STALEPROBE-" + guid().slice(0, 8);
  const m2 = await post(`/api/boards/${bid}/meetings`, { title: "QA run stale", brief: "QA-SLEEP:4000 " + probeTag + " baseline brief." });
  const runP = post(`/api/meetings/${m2.json.id}/run`, { prompt: "QA-SLEEP:4000 " + probeTag + " Should we expand carefully?" }, { timeout: 120000 });
  const logPre = await (await fetch(FAKE + "/__log")).json();
  const draftsPre = (logPre || []).filter((e) => e.draft === true).length;
  let sawDraftFlight = false;
  for (let pi = 0; pi < 40; pi++) {
    await sleep(500);
    const lgp = await (await fetch(FAKE + "/__log")).json();
    if ((lgp || []).filter((e) => e.draft === true).length > draftsPre) { sawDraftFlight = true; break; }
  }
  await put(`/api/roster/${rid1}`, { description: "Mid-run canonical edit with sufficient length.", profileJson: JSON.stringify({ fictional: true, marker: probeTag + "-EDIT", background: "stale probe profile with sufficient length text here" }) });
  await post(`/api/boards/${bid}/advisors/${aid1}/sync-roster`, {});
  await post(`/api/boards/${bid}/advisors/${aid1}/approve`, {});
  const run2 = await runP;
  const run2txt = JSON.stringify(run2.json || {});
  const yielded2 = (run2.json && run2.json.yielded) || [];
  const staleYielded = yielded2.some((y) => y && y.reason === "stale-profile");
  const providerErrAny = /provider-error/i.test(run2txt) || ((run2.json && run2.json.bidErrors) || []).length > 0;
  ok("stale generation discarded with stale-profile yield (provider healthy)", run2.status === 200 && ((run2.json.published || []).length === 0) && staleYielded && sawDraftFlight && !providerErrAny, run2.status + " " + run2txt.slice(0, 300));
  const msgsStale = await get(`/api/meetings/${m2.json.id}/messages`);
  ok("no advisor messages from stale run", Array.isArray(msgsStale.json) && msgsStale.json.filter((m) => m.sender === "advisor").length === 0, JSON.stringify(msgsStale.json).slice(0, 200));
  const logAll = await (await fetch(FAKE + "/__log")).json();
  const probeBids = (logAll || []).filter((e) => (e.full || "").includes(probeTag) && e.bid === true);
  const probeReplies = (logAll || []).filter((e) => (e.full || "").includes(probeTag) && e.draft === true);
  ok("stale run dispatched bids before the edit", probeBids.length >= 1, probeBids.length);
  ok("no reply prompt carries post-edit content (discard, not rebuild)", probeReplies.every((e) => !(e.full || "").includes(probeTag + "-EDIT")), probeReplies.length);
  await post(`/api/boards/${bid}/advisors/${aid1}/sync-roster`, {});
  await post(`/api/boards/${bid}/advisors/${aid1}/approve`, {});
  const run2b = await post(`/api/meetings/${m2.json.id}/run`, { prompt: "Should we expand carefully?" }, { timeout: 120000 });
  ok("post-repair run publishes again (setup was fine; only the edit discarded)", run2b.status === 200 && (run2b.json.published || []).length >= 1, run2b.status + " " + run2b.text.slice(0, 220));
  await post(`/api/boards/${bid}/advisors/${aid1}/sync-roster`, {});
  await post(`/api/boards/${bid}/advisors/${aid1}/approve`, {});

  // ---- G2: restore-during-generation discards with a restore-specific signal ----
  const m3 = await post(`/api/boards/${bid}/meetings`, { title: "QA run restore race" });
  const bkPre = await get("/api/backup");
  const snapPre = bkPre.json.snapshot;
  const hashPre = bkPre.json.hash;
  ok("pre-race backup captured", bkPre.status === 200 && typeof snapPre === "string" && typeof hashPre === "string", bkPre.status);
  const runR = post(`/api/meetings/${m3.json.id}/run`, { prompt: "QA-SLEEP:6000 restore race run." }, { timeout: 120000 });
  const logRPre = await (await fetch(FAKE + "/__log")).json();
  const draftsRPre = (logRPre || []).filter((e) => e.draft === true).length;
  let sawDraftR = false;
  for (let ri = 0; ri < 40; ri++) {
    await sleep(500);
    const lgr = await (await fetch(FAKE + "/__log")).json();
    if ((lgr || []).filter((e) => e.draft === true).length > draftsRPre) { sawDraftR = true; break; }
  }
  ok("restore race held a successful provider draft in flight", sawDraftR, "no draft dispatched");
  const rsRace = await post("/api/backup/restore", { snapshot: snapPre, hash: hashPre }, { timeout: 120000 });
  const runR2 = await runR;
  ok("restore mid-run applied", rsRace.status === 200, rsRace.status + " " + rsRace.text.slice(0, 160));
  ok("restore-during-generation discards with restore signal", runR2.status === 409 && /restored during generation/i.test(runR2.text), runR2.status + " " + runR2.text.slice(0, 300));
  const msgsRace = await get(`/api/meetings/${m3.json.id}/messages`);
  ok("no messages published from restored run", Array.isArray(msgsRace.json) && msgsRace.json.length === 0, JSON.stringify(msgsRace.json).slice(0, 200));

  // ---- H: reconciliation plan + apply (stale/dup/missing/archived) ----
  await put(`/api/roster/${rid2}`, { description: "Bump for stale orphan with sufficient length." });
  const plan1 = await post("/api/admin/roster-reconcile/plan", { idempotencyKey: "qa-key-1" });
  ok("plan reports stale orphan (dry-run, no writes)", plan1.status === 200 && plan1.json.orphans.some((o) => o.reason === "stale-version"), plan1.status + " " + plan1.text.slice(0, 200));
  const h1 = plan1.json.planHash;
  const plan1b = await post("/api/admin/roster-reconcile/plan", { idempotencyKey: "qa-key-1" });
  ok("plan deterministic (same hash on re-run)", plan1b.json.planHash === h1, plan1b.json.planHash);
  ok("apply with wrong hash refused", (await post("/api/admin/roster-reconcile/apply", { idempotencyKey: "qa-key-1", planHash: "deadbeef" })).status === 409);
  ok("stranger apply denied", (await post("/api/admin/roster-reconcile/apply", { idempotencyKey: "qa-key-1", planHash: h1 }, { user: "stranger" })).status === 403);
  const ap1 = await post("/api/admin/roster-reconcile/apply", { idempotencyKey: "qa-key-1", planHash: h1 });
  ok("apply re-pins stale link", ap1.status === 200 && (ap1.json.applied || []).some((s) => s.startsWith("repin:")), ap1.status + " " + ap1.text.slice(0, 220));
  const planClean = await post("/api/admin/roster-reconcile/plan", { idempotencyKey: "qa-key-1" });
  ok("plan clean after apply", planClean.json.orphans.length === 0, JSON.stringify(planClean.json.orphans).slice(0, 200));
  const replay = await post("/api/admin/roster-reconcile/apply", { idempotencyKey: "qa-key-1", planHash: h1 });
  ok("idempotent replay no-op", replay.status === 200 && (replay.json.applied || []).length === 0, replay.status + " " + replay.text.slice(0, 200));

  // concurrent apply: same reviewed plan from two callers; both succeed, repairs land once
  await put(`/api/roster/${rid1}`, { description: "Concurrent-race bump with sufficient length text here." });
  const planC = await post("/api/admin/roster-reconcile/plan", { idempotencyKey: "qa-key-C" });
  const [cA, cB] = await Promise.all([
    post("/api/admin/roster-reconcile/apply", { idempotencyKey: "qa-key-C", planHash: planC.json.planHash }),
    post("/api/admin/roster-reconcile/apply", { idempotencyKey: "qa-key-C", planHash: planC.json.planHash }),
  ]);
  const unionApplied = [...(cA.json.applied || []), ...(cB.json.applied || [])];
  const concOk = [cA.status, cB.status].every((s) => s === 200 || s === 409);
  ok("concurrent apply settles without error", concOk, cA.status + "/" + cB.status);
  ok("concurrent repairs applied exactly once", unionApplied.filter((s) => s.startsWith("repin:")).length === 1, JSON.stringify(unionApplied));
  const planAfterConc = await post("/api/admin/roster-reconcile/plan", { idempotencyKey: "qa-key-C2" });
  ok("state converged after concurrent apply", planAfterConc.status === 200 && !(planAfterConc.json.orphans || []).some((o) => o.reason === "stale-version" && o.rosterEntryId === rid1), JSON.stringify((planAfterConc.json.orphans || []).map((o) => o.reason)));
  // plan mutation between review and apply: stale hash refused with fresh hash
  await put(`/api/roster/${rid1}`, { description: "Mutation-after-plan bump with sufficient length text." });
  const planM = await post("/api/admin/roster-reconcile/plan", { idempotencyKey: "qa-key-M" });
  await put(`/api/roster/${rid1}`, { description: "Second mutation invalidating the reviewed plan text here." });
  const staleApply = await post("/api/admin/roster-reconcile/apply", { idempotencyKey: "qa-key-M", planHash: planM.json.planHash });
  ok("mutated plan refused with fresh hash", staleApply.status === 409 && staleApply.json && staleApply.json.freshPlanHash && staleApply.json.freshPlanHash !== planM.json.planHash, staleApply.status + " " + staleApply.text.slice(0, 160));
  const freshApply = await post("/api/admin/roster-reconcile/apply", { idempotencyKey: "qa-key-M", planHash: staleApply.json.freshPlanHash });
  ok("fresh plan applies after re-review", freshApply.status === 200 && (freshApply.json.applied || []).some((s) => s.startsWith("repin:")), freshApply.status);
  // legacy duplicate links arrive via backup restore (restore lineage guards rightly
  // refuse to CREATE dangling links, so missing-link recovery is covered by the
  // in-process selftest fixture instead). survivor = earliest CreatedAt.
  const bk = await get("/api/backup");
  const snap = bk.status === 200 && bk.json && typeof bk.json.snapshot === "string" ? JSON.parse(bk.json.snapshot) : null;
  ok("backup exports graph", snap && snap.version === 4 && Array.isArray(snap.advisors), bk.status);
  const target = snap.advisors.find((a) => a.RosterEntryId === rid1 && !a.Removed);
  const earlyDup = { ...target, Id: guid(), CreatedAt: "2020-01-01T00:00:00.000Z" };
  snap.advisors.push(earlyDup);
  const snapStr = JSON.stringify(snap);
  const snapHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapStr)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const rs = await post("/api/backup/restore", { snapshot: snapStr, hash: snapHash }, { timeout: 120000 });
  ok("legacy duplicate graph restores", rs.status === 200, rs.status + " " + rs.text.slice(0, 220));
  const plan2 = await post("/api/admin/roster-reconcile/plan", { idempotencyKey: "qa-key-2" });
  const reasons2 = (plan2.json.orphans || []).map((o) => o.reason).sort();
  ok("plan finds duplicate link", plan2.status === 200 && reasons2.includes("duplicate-link"), JSON.stringify(reasons2));
  const ap2 = await post("/api/admin/roster-reconcile/apply", { idempotencyKey: "qa-key-2", planHash: plan2.json.planHash });
  const applied2 = ap2.json.applied || [];
  ok("apply dedupes (earliest wins)", ap2.status === 200 && applied2.some((s) => s.startsWith("dedupe:")), ap2.status + " " + ap2.text.slice(0, 260));
  const listAfter = await get(`/api/boards/${bid}/advisors`);
  const idsAfter = (listAfter.json || []).map((a) => a.id);
  ok("survivor kept, later dup removed", idsAfter.includes(earlyDup.Id) && !idsAfter.includes(target.Id), idsAfter.length);
  const msgsAfter = await get(`/api/meetings/${m1.json.id}/messages`);
  const advMsgs = (msgsAfter.json || []).filter((m) => m.sender === "advisor");
  ok("history preserved (messages retargeted, content intact)", advMsgs.length >= 1 && advMsgs.every((m) => m.advisorId === earlyDup.Id), JSON.stringify(advMsgs).slice(0, 240));

  // cross-account ownership: entry owned elsewhere is flagged, never merged/touched
  const b2 = await post("/api/boards", { name: "QA Foreign Board" });
  const bid2 = b2.json.id;
  const f1 = await post("/api/roster/quick", { accountId: guid(), name: "QA Foreign Entry", description: "Foreign-owned entry with sufficient text." });
  const ridF = f1.json.id;
  const fdf = new FormData();
  fdf.append("file", new Blob([PNG], { type: "image/png" }), "f.png");
  await post(`/api/roster/${ridF}/image/upload`, fdf);
  const fa = await post(`/api/boards/${bid2}/advisors`, { rosterEntryId: ridF, boardRole: "Foreign" });
  const aidF = fa.json.id;
  await put(`/api/roster/${ridF}`, { description: "Bumped foreign entry with sufficient length." });
  const bk2 = await get("/api/backup");
  const snap2 = JSON.parse(bk2.json.snapshot);
  snap2.roster.find((r) => r.Id === ridF).OwnerKey = "external-owner";
  const snapStr2 = JSON.stringify(snap2);
  const snapHash2 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapStr2)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  ok("foreign-owned graph restores", (await post("/api/backup/restore", { snapshot: snapStr2, hash: snapHash2 }, { timeout: 120000 })).status === 200);
  const planF = await post("/api/admin/roster-reconcile/plan", { idempotencyKey: "qa-key-F" });
  ok("plan still reports stale foreign link", (planF.json.orphans || []).some((o) => o.advisorId === aidF && o.reason === "stale-version"), JSON.stringify((planF.json.orphans || []).length));
  const apF = await post("/api/admin/roster-reconcile/apply", { idempotencyKey: "qa-key-F", planHash: planF.json.planHash });
  const flaggedF = apF.json.flagged || [];
  ok("cross-account repair refused (flagged, untouched)", apF.status === 200 && !(apF.json.applied || []).some((s) => s.includes(aidF)) && flaggedF.some((s) => s.includes("owner-mismatch")), apF.status + " " + apF.text.slice(0, 220));
  // archived entries are flagged, never auto-repaired
  await post(`/api/roster/${rid2}/archive`, { archived: true });
  const plan3 = await post("/api/admin/roster-reconcile/plan", { idempotencyKey: "qa-key-3" });
  ok("plan flags archived link", (plan3.json.orphans || []).some((o) => o.reason === "archived-roster"), JSON.stringify((plan3.json.orphans || []).map((o) => o.reason)));
  const ap3 = await post("/api/admin/roster-reconcile/apply", { idempotencyKey: "qa-key-3", planHash: plan3.json.planHash });
  ok("archived flagged, not auto-repaired", ap3.status === 200 && (ap3.json.flagged || []).some((s) => s.startsWith("archived:")) && !(ap3.json.applied || []).length, ap3.status + " " + ap3.text.slice(0, 220));
  const archList = await get(`/api/boards/${bid}/advisors`);
  const archRow = (archList.json || []).find((a) => a.rosterEntryId === rid2);
  ok("archived link stays visible in board projection", archRow && archRow.rosterName === "QA Advisor Two" && archRow.unlinked === false, JSON.stringify(archRow).slice(0, 200));
  ok("archived link not approvable (policy preserved)", (await post(`/api/boards/${bid}/advisors/${archRow.id}/approve`, {})).status === 409);
  await post(`/api/roster/${rid2}/archive`, { archived: false });
  // ---- I: legacy blank-owner visibility (random client account must not hide
  // attached entries) + effective-owner edit authority + boundary negatives ----
  const lb = await post("/api/boards", { name: "Legacy Board" }, { user: "alice" });
  const lbid = lb.json.id;
  const le = await post("/api/roster/quick", { accountId: acct, name: "Legacy Attached", description: "Legacy entry with sufficient description text." }, { user: "alice" });
  const ridL = le.json.id;
  const ldf = new FormData();
  ldf.append("file", new Blob([PNG], { type: "image/png" }), "l.png");
  await post(`/api/roster/${ridL}/image/upload`, ldf, { user: "alice" });
  await post(`/api/boards/${lbid}/advisors`, { rosterEntryId: ridL, boardRole: "Legacy Seat" }, { user: "alice" });
  const lone = await post("/api/roster/quick", { accountId: "22222222-3333-4444-5555-666666666666", name: "Unrelated Private", description: "Unattached foreign entry with sufficient text." }, { user: "stranger" });
  const ridU = lone.json.id;
  const bkL2 = await get("/api/backup");
  const snapL = JSON.parse(bkL2.json.snapshot);
  const legRow = snapL.roster.find((r) => r.Id === ridL);
  legRow.OwnerKey = "";
  legRow.AccountId = "11111111-2222-3333-4444-555555555555";
  const snapLStr = JSON.stringify(snapL);
  const snapLHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapLStr)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const rsL = await post("/api/backup/restore", { snapshot: snapLStr, hash: snapLHash }, { timeout: 120000 });
  ok("legacy blank-owner graph restores", rsL.status === 200, rsL.status + " " + rsL.text.slice(0, 160));
  const rndAcct = guid();
  const visL = await get(`/api/roster?accountId=${rndAcct}`);
  const visIds = (visL.json || []).map((x) => x.entry && (x.entry.id || x.entry.Id)).filter(Boolean);
  ok("attached legacy entry visible under random client account", visL.status === 200 && visIds.includes(ridL), visL.status + " count=" + visIds.length);
  ok("unattached foreign entry stays hidden (no leak)", !visIds.includes(ridU), visIds.length);
  const visBob = await get(`/api/roster?accountId=${guid()}`, { user: "bob" });
  ok("attached entry visible via board membership (non-owner reader)", ((visBob.json || []).map((x) => x.entry && (x.entry.id || x.entry.Id))).includes(ridL), visBob.status);
  const cntL = await get(`/api/roster/count?accountId=${rndAcct}`);
  ok("count matches visible list", cntL.status === 200 && cntL.json && cntL.json.total === (visL.json || []).length, JSON.stringify(cntL.json));
  const ownAcct = "22222222-3333-4444-5555-666666666666";
  const visOwn = await get(`/api/roster?accountId=${ownAcct}`, { user: "stranger" });
  ok("owner sees own unattached entry (exists, authorized)", visOwn.status === 200 && ((visOwn.json || []).map((x) => x.entry && (x.entry.id || x.entry.Id))).includes(ridU), visOwn.status);
  const compU = await get(`/api/roster/${ridU}/completeness`, { user: "stranger" });
  ok("unattached entry exists post-restore (owner-readable)", compU.status === 200 && compU.json && (compU.json.missing || []).includes("portrait"), compU.status + " " + compU.text.slice(0, 160));
  const putA = await put(`/api/roster/${ridL}`, { description: "Edited by effective board owner alice with sufficient length." }, { user: "alice" });
  ok("effective board owner edits legacy blank-owner entry", putA.status === 200 && putA.json.version === 2, putA.status + " " + putA.text.slice(0, 160));
  ok("non-owner cannot edit legacy entry", (await put(`/api/roster/${ridL}`, { description: "hijack attempt with sufficient length text." }, { user: "bob" })).status === 403);
  ok("non-owner list hides unattached private entry", !((await get(`/api/roster?accountId=${rndAcct}`, { user: "bob" })).json || []).map((x) => x.entry && (x.entry.id || x.entry.Id)).includes(ridU));
  ok("explicit-owner entry hidden from strangers", !((await get(`/api/roster?accountId=${rndAcct}`, { user: "carol" })).json || []).map((x) => x.entry && (x.entry.id || x.entry.Id)).includes(ridU));
  const projL = await get(`/api/boards/${lbid}/advisors`, { user: "alice" });
  ok("board projection reflects effective-owner edit", (projL.json || []).some((a) => a.rosterEntryId === ridL && a.rosterName === "Legacy Attached"), JSON.stringify(projL.json).slice(0, 200));
  // placeholder gate: recovered entries need completion or evidenced research
  const aidL = (await get(`/api/boards/${bid}/advisors`)).json.find((a) => a.rosterEntryId === rid2);
  const fdx = new FormData();
  fdx.append("file", new Blob([PNG], { type: "image/png" }), "b2.png");
  const up2 = await post(`/api/roster/${rid2}/image/upload`, fdx);
  ok("placeholder portrait uploaded", up2.status === 201 && up2.json.id, up2.status);
  ok("placeholder portrait accepted", (await post(`/api/images/${up2.json.id}/review`, { decision: "accept" })).status === 200);
  await post(`/api/boards/${bid}/advisors/${aidL.id}/sync-roster`, {});
  ok("baseline advisor approvable", (await post(`/api/boards/${bid}/advisors/${aidL.id}/approve`, {})).status === 200);
  await put(`/api/roster/${rid2}`, { tags: "recovered" });
  await post(`/api/boards/${bid}/advisors/${aidL.id}/sync-roster`, {});
  const apPh = await post(`/api/boards/${bid}/advisors/${aidL.id}/approve`, {});
  ok("recovered placeholder blocked even with accepted portrait", apPh.status === 409 && /Recovered entry is an incomplete placeholder/.test(apPh.text), apPh.status + " " + apPh.text.slice(0, 160));
  const resPh = await post(`/api/roster/${rid2}/research`, { focus: "placeholder completion" }, { timeout: 120000 });
  ok("research completes with evidence on placeholder", resPh.status === 200, resPh.status);
  const rePh = await get(`/api/roster/${rid2}/research`);
  ok("research returns evidence", rePh.json && rePh.json.evidenceCount >= 1 && rePh.json.running === false, JSON.stringify(rePh.json).slice(0, 160));
  await post(`/api/boards/${bid}/advisors/${aidL.id}/sync-roster`, {});
  ok("researched placeholder approvable", (await post(`/api/boards/${bid}/advisors/${aidL.id}/approve`, {})).status === 200);
  await put(`/api/roster/${rid2}`, { tags: "recovered, needs-review" });
  await post(`/api/boards/${bid}/advisors/${aidL.id}/sync-roster`, {});
  ok("re-tagged placeholder blocked again", (await post(`/api/boards/${bid}/advisors/${aidL.id}/approve`, {})).status === 409);
  await put(`/api/roster/${rid2}`, { tags: "" });
  await post(`/api/boards/${bid}/advisors/${aidL.id}/sync-roster`, {});
  ok("owner tag completion unblocks approval", (await post(`/api/boards/${bid}/advisors/${aidL.id}/approve`, {})).status === 200);

  // secure admin boundary (runs last: registration flips the store to secure mode)
  const regA = await post("/api/auth/register", { email: "admin@x.test", password: "0123456789ab" });
  ok("admin registered", regA.status === 200 || regA.status === 201, regA.status);
  const loginA = await post("/api/auth/login", { email: "admin@x.test", password: "0123456789ab" });
  const tokA = loginA.json && loginA.json.token;
  ok("admin login yields bearer", loginA.status === 200 && !!tokA, loginA.status);
  const secPlan = await fetch(API + "/api/admin/roster-reconcile/plan", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tokA }, body: JSON.stringify({ idempotencyKey: "qa-sec" }) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  ok("secure installation admin may reconcile", secPlan.status === 200, secPlan.status);
  const regB = await post("/api/auth/register", { email: "bob@x.test", password: "0123456789ab" });
  const loginB = await post("/api/auth/login", { email: "bob@x.test", password: "0123456789ab" });
  const tokB = loginB.json && loginB.json.token;
  const secPlanB = await fetch(API + "/api/admin/roster-reconcile/plan", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tokB }, body: JSON.stringify({ idempotencyKey: "qa-sec" }) }).then(async (r) => ({ status: r.status }));
  ok("secure non-admin denied reconcile", secPlanB.status === 403, secPlanB.status);
  const secApply = await fetch(API + "/api/admin/roster-reconcile/apply", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tokA }, body: JSON.stringify({ idempotencyKey: "qa-sec", planHash: secPlan.json.planHash }) }).then(async (r) => ({ status: r.status }));
  ok("secure admin apply succeeds", secApply.status === 200, secApply.status);
  const regH = await post("/api/auth/register", { email: "alice@x.test", password: "0123456789ab" });
  ok("history owner registered", regH.status === 200 || regH.status === 201, regH.status);
  const loginH = await post("/api/auth/login", { email: "alice@x.test", password: "0123456789ab" });
  const tokH = loginH.json && loginH.json.token;
  ok("history owner login yields bearer", loginH.status === 200 && !!tokH, loginH.status);
  const loginA2 = await post("/api/auth/login", { email: "admin@x.test", password: "0123456789ab" });
  const tokA2 = loginA2.json && loginA2.json.token;
  const hb = await fetch(API + "/api/boards", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tokH }, body: JSON.stringify({ name: "Hist Board" }) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  ok("history owner creates board", hb.status === 201 && hb.json && hb.json.id && hb.json.ownerKey === "alice@x.test", hb.status);
  const hBoardId = hb.json.id;
  const bkS = await fetch(API + "/api/backup", { headers: { authorization: "Bearer " + tokA2 } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  ok("secure backup exports for admin", bkS.status === 200 && bkS.json && typeof bkS.json.snapshot === "string", bkS.status);
  const snapS = JSON.parse(bkS.json.snapshot);
  const hEntry = { ...snapS.roster[0], Id: guid(), AccountId: guid(), OwnerKey: "", Name: "Hist Legacy", Description: "Historical-only legacy entry with sufficient text.", ProfileJson: JSON.stringify({ fictional: true, marker: "HIST-PROFILE-MARKER-" + hBoardId.slice(0, 8), background: "historical canonical profile with sufficient length text" }), Tags: "", Version: 1 };
  const hAdv = { ...snapS.advisors[0], Id: guid(), BoardId: hBoardId, RosterEntryId: hEntry.Id, RosterVersion: 1, BoardRole: "Hist Gone", Approved: false, Removed: true, ImageProvenance: "" };
  snapS.roster.push(hEntry); snapS.advisors.push(hAdv);
  const snapSStr = JSON.stringify(snapS);
  const snapSHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapSStr)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const rsS = await fetch(API + "/api/backup/restore", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tokA2 }, body: JSON.stringify({ snapshot: snapSStr, hash: snapSHash }) }).then(async (r) => ({ status: r.status, text: await r.text() }));
  ok("historical-only graph restores", rsS.status === 200, rsS.status + " " + rsS.text.slice(0, 160));
  const rndH = guid();
  const visH = await fetch(API + `/api/roster?accountId=${rndH}`, { headers: { authorization: "Bearer " + tokH } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const visHIds = ((visH.json || []).map((x) => x.entry && (x.entry.id || x.entry.Id)));
  ok("removed-history owner lists entry", visH.status === 200 && visHIds.includes(hEntry.Id), visH.status);
  const visHRow = (visH.json || []).find((x) => { const e = x.entry || {}; return (e.id || e.Id) === hEntry.Id; });
  const visHProf = visHRow && visHRow.entry && (visHRow.entry.profileJson || visHRow.entry.ProfileJson || "");
  ok("removed-history owner sees full canonical profile", !!visHRow && visHProf.includes("HIST-PROFILE-MARKER"), JSON.stringify(visHRow ? visHRow.entry : null).slice(0, 200));
  ok("removed-history owner sees research fields", !!visHRow && visHRow.entry && ("researchRequested" in visHRow.entry || "ResearchRequested" in visHRow.entry) && ("evidenceCount" in visHRow.entry || "EvidenceCount" in visHRow.entry), "research fields missing");
  const cntH = await fetch(API + `/api/roster/count?accountId=${rndH}`, { headers: { authorization: "Bearer " + tokH } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  ok("removed-history owner count parity", cntH.status === 200 && cntH.json && cntH.json.total === (visH.json || []).length, JSON.stringify(cntH.json));
  const compH = await fetch(API + `/api/roster/${hEntry.Id}/completeness`, { headers: { authorization: "Bearer " + tokH } }).then(async (r) => ({ status: r.status }));
  ok("removed-history owner direct read", compH.status === 200, compH.status);
  const chatH = await fetch(API + `/api/roster/${hEntry.Id}/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tokH }, body: JSON.stringify({ message: "hello history" }) });
  ok("removed-history owner chat", chatH.status === 200, chatH.status);
  const putH = await fetch(API + `/api/roster/${hEntry.Id}`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer " + tokH }, body: JSON.stringify({ description: "Edited by historical owner with sufficient length text." }) }).then(async (r) => ({ status: r.status }));
  ok("removed-history owner write", putH.status === 200, putH.status);
  const visB = await fetch(API + `/api/roster?accountId=${rndH}`, { headers: { authorization: "Bearer " + tokB } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  ok("stranger list hides historical entry", !(((visB.json || []).map((x) => x.entry && (x.entry.id || x.entry.Id)))).includes(hEntry.Id), visB.status);
  const putB = await fetch(API + `/api/roster/${hEntry.Id}`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer " + tokB }, body: JSON.stringify({ description: "hijack attempt with sufficient length text here." }) }).then(async (r) => ({ status: r.status }));
  ok("stranger write denied on historical entry", putB.status === 403, putB.status);
  const chatSlow = fetch(API + `/api/roster/${rid1}/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tokA }, body: JSON.stringify({ message: "QA-SLEEP:6000 revoke race" }) });
  let sawChatDispatch = false;
  for (let ci = 0; ci < 40; ci++) {
    await sleep(250);
    const lgc = await (await fetch(FAKE + "/__log")).json();
    if ((lgc || []).some((e) => (e.full || "").includes("QA-SLEEP:6000 revoke race"))) { sawChatDispatch = true; break; }
  }
  ok("revoke race held provider dispatch", sawChatDispatch, "no chat dispatch observed");
  const logoutA = await fetch(API + "/api/auth/logout", { method: "POST", headers: { authorization: "Bearer " + tokA } });
  const chatRev = await chatSlow;
  const chatRevTxt = await chatRev.text().catch(() => "");
  ok("admin logout revokes session", logoutA.status === 200, logoutA.status);
  ok("revoked session chat refused after generation (no leak)", chatRev.status === 401 && !/QA provisional text/.test(chatRevTxt), chatRev.status + " " + chatRevTxt.slice(0, 200));
  // in-process store fixture: stale/dup/missing/archived + replay (no ports, no human data)
  let selftestOut = "";
  try { selftestOut = execFileSync("dotnet", ["run", "--project", path.join(ROOT, "server/SimCEO.Api/SimCEO.Api.csproj"), "--no-build", "-c", "Debug", "--", "--selftest"], { encoding: "utf8", timeout: 180000, windowsHide: true }); }
  catch (e) { selftestOut = String((e && e.stdout) || e); }
  ok("in-process selftest (store orphan recovery incl. missing-link reconstruction)", selftestOut.includes("SELFTEST PASS"), selftestOut.slice(-300));

  console.log(fail === 0 ? `\nPASS roster-backend-qa (${pass} checks)` : `\nFAIL roster-backend-qa (${fail} failures)\n` + bad.join("\n"));
}

try { await main(); } catch (e) { fail++; console.log("  FAIL harness :: " + (e && e.stack || e)); }
stop();
rmDirVerified(qaKeyring, "roster-qa-keyring-");
await sleep(500);
process.exit(fail === 0 ? 0 : 1);
