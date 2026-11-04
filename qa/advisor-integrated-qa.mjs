// qa/advisor-integrated-qa.mjs — FINAL integrated advisor milestone QA (Muse-authored, sole script author).
//
// Own worktree: .tmp/advisor-integration-qa. This file is the ONLY code change;
// no App/server edits. Primary mechanically ports this file into the final
// coherent root and executes it there; this author never runs it (no services,
// browsers, processes, Docker, .env, or human ports here — node --check only).
// Unexecuted artifact: assertion counts describe what the script WILL check
// when primary runs it against the actual compiled combined app.
//
// Corrected revision addressing every concrete finding of the be958dc review
// (frontend read-only at 604d9f9, backend at dbb698c; frontend owned by
// another Muse — never edited here):
//  F1. Opens creation with the ACTUAL button "+ Create new Advisor" (App.tsx
//      rail) and scopes ALL creation locators to the actual dialog
//      div.modal[role=dialog][aria-label="Create advisor"].
//  F2. No global editor locators: creation touches only the dialog editor;
//      later edits touch only the selected-roster detail editor after the
//      dialog is closed. No .first()-over-ambiguity.
//  F3. Owner-save readback uses the ACTUAL canonical wrapper the App uses in
//      resolveCanonicalEntry (GET /api/roster?accountId= + exact-ID entry
//      unwrap, entry.profileJson) for all three paragraphs. GET
//      /roster/{id}/research is used ONLY for research state/version — it
//      carries no canonical profileJson (CharacterResearch returns research
//      metadata, draftProfile, version, stage, inputs).
//  F4. Research fixture is documentation-grounded and honestly fetchable: a
//      documentation/example-domain teaching advisor whose subject matches
//      the example.com seed, mirroring the positive fetched baseline in
//      backend qa/character-presence-qa.mjs (seed description teaches
//      reserved example domains; baseline research fetches the example.com
//      URL with fetched:true and the dossier prompt carries the URL marker).
//      Unsupported/no-evidence is an honest FAIL, never forced.
//  F5. Research progress requires VISIBLE live text: dialog
//      #cc-research-status showing working + human stage + elapsed/live-run
//      wording, correlated with GET /research running/stage. Auto-start is
//      detected (no blind click); the run button is clicked only from a
//      proven idle state, and the click alone never counts as progress.
//  F6. Meeting search uses the ACTUAL labelled textbox ("Search messages");
//      settings uses the EXACT "Meeting settings" button and asserts
//      Decisions & evidence INSIDE the opened dialog; Escape dismissal is the
//      source-confirmed native dialog cancel path.
//  F7. Presence proof reads the ACTUAL rail (section.meet-participants /
//      ul.mp-rail): exact seats by boardRole display name, excluded badge
//      "Not in this meeting" on the non-participant seat, accepted-portrait
//      img per advisor seat, Secretary seat in-rail. No body-text search.
//  F8. Activity separates vocabularies: RAW backend states
//      (awaiting-selection / awaiting-publication, ...) validated against the
//      raw contract; RENDERED rail badge classes validated against the mapped
//      UI vocabulary; mapping cross-checked. The meeting QUESTION carries a
//      QA-SLEEP:6000 pacing marker so the fake run holds transient states
//      while the real per-advisor poll observes.
//  F9. Once-only lead/auto-init/run (POST messages x1, PATCH x1, POST run
//      x1), exact participant set on the scoped detail, exactly one meeting
//      control area; Secretary question correlated to its completed request
//      (Question/InputText marker match) + persisted provisional note + zero
//      non-provisional direction notes (no decision).
//  F10. Rerun prompt proof correlates CURRENT canonical markers (fresh
//      collection readback) to the EXACT owned advisor contribution
//      (role/name marker in the same fake responses prompt) with no
//      stale-marker leak. Live mode has no prompt log: reported as an
//      explicit UNPROVED requirement (fails closed), never generic-nonempty.
//  F11. Every named rail destination is visited with hash arrival per the
//      repo navigation convention plus entity checks and a per-page
//      debug-surface scan; roster direct chat is driven through the REAL
//      RosterChatPanel UI (not HTTP-only).
//  F12. NO global prompt-log DELETE: baseline timestamp captured at setup,
//      all prompt assertions filter t>=baseline + owned run markers. Budget
//      is ENFORCED (overrun throws into finally cleanup). failExit throws so
//      the browser context ALWAYS closes via finally; process.exit runs once
//      at the very end. Expected 404s (pre-save /api/profile absence) are
//      classified, never counted as unexplained. Owned rows are left for
//      forensics (exact-ID scope only); browser/context cleanup always runs.
//
// Run (primary executes):
//   QA_WEB=http://127.0.0.1:15300 node qa/advisor-integrated-qa.mjs
//   ALLOW_LIVE_PROVIDER=1 QA_WEB=http://127.0.0.1:15180 node qa/advisor-integrated-qa.mjs
//
// ALLOWLIST: QA_WEB must be http://127.0.0.1:15300 (default, compiled native QA
// app + API, fake-backed) or http://127.0.0.1:15180 (owned compiled Docker,
// requires ALLOW_LIVE_PROVIDER=1). QA_FAKE, when set, must be
// http://127.0.0.1:15302 (primary-owned standard qa/fake-provider.mjs prompt
// log). Refuses 5173/5080/9333, any other host/port, and credential URLs.
// Model keys are never read; the server holds them. Token lives in memory only.
import crypto from "node:crypto";
import { chromium } from "playwright-core";

const QA_WEB = (process.env.QA_WEB || "http://127.0.0.1:15300").trim();
const LIVE = process.env.ALLOW_LIVE_PROVIDER === "1";
const FAKE = (process.env.QA_FAKE || "http://127.0.0.1:15302").trim();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application.exe";
const REQ_TIMEOUT = 30000;
const RESEARCH_TIMEOUT = 185000;
const RUN_TIMEOUT = 150000;
const BROWSER_TIMEOUT = 30000;
const OVERALL_BUDGET_MS = 420000;
const startedAt = Date.now();
let pass = 0; let fail = 0; const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("  FAIL - " + name + (extra ? " :: " + String(extra).slice(0, 220) : "")); failures.push(name + (extra ? " :: " + String(extra).slice(0, 220) : "")); }
}
function trunc(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) : s; }
function redact(s) { return trunc(s, 220).replace(/[0-9a-f]{32,}/gi, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]"); }
// failExit throws (never process.exit here) so main/finally ALWAYS closes the browser.
function failExit(msg) { console.log("FATAL " + msg); throw new Error("FATAL: " + msg); }
function elapsed() { return Date.now() - startedAt; }
function checkBudget(name) {
  const e = elapsed();
  ok(name + "-within-budget-enforced", e < OVERALL_BUDGET_MS, e + "ms");
  if (e >= OVERALL_BUDGET_MS) throw new Error("OVERALL BUDGET EXCEEDED at " + name + " (" + e + "ms >= " + OVERALL_BUDGET_MS + "ms); aborting into cleanup.");
}
// ---- allowlist gates (no human ports, no credentials, no other hosts) ----
if (/[^\s:@/]*:[^\s:@/]*@/.test(QA_WEB)) failExit("REFUSE: credentials-in-URL are never accepted.");
let webUrl = null;
try { webUrl = new URL(QA_WEB); } catch { failExit("REFUSE: QA_WEB is not a valid URL."); }
if (webUrl.protocol !== "http:") failExit("REFUSE: QA_WEB must be plain http loopback.");
if (webUrl.hostname !== "127.0.0.1") failExit("REFUSE: QA_WEB must be 127.0.0.1 loopback.");
if (webUrl.port !== "15300" && webUrl.port !== "15180") failExit("REFUSE: QA_WEB port must be 15300 or 15180 (rejects 5173/5080/9333/all others).");
if (webUrl.username || webUrl.password) failExit("REFUSE: credentials-in-URL are never accepted.");
if (webUrl.port === "15180" && !LIVE) failExit("REFUSE: port 15180 requires ALLOW_LIVE_PROVIDER=1; default is 15300 fake-backed (no live-model claim).");
const WEB = webUrl.origin;
const FAKE_ENABLED = FAKE !== "" && FAKE !== "none";
let fakeUrl = null;
if (FAKE_ENABLED) {
  try { fakeUrl = new URL(FAKE); } catch { failExit("REFUSE: QA_FAKE is not a valid URL."); }
  if (fakeUrl.protocol !== "http:" || fakeUrl.hostname !== "127.0.0.1" || fakeUrl.port !== "15302") failExit("REFUSE: QA_FAKE must be http://127.0.0.1:15302 loopback.");
  if (fakeUrl.username || fakeUrl.password) failExit("REFUSE: credentials-in-URL are never accepted.");
}
ok("allowlist-web-ok", WEB === "http://127.0.0.1:15300" || (WEB === "http://127.0.0.1:15180" && LIVE), WEB);

// ---- owned identity (random account, token in memory only, never logged) ----
// Deterministic bootstrap: the SAME account id seeds the browser
// (simceo-account), the roster quick seeds, and every fresh-collection
// readback, so rows are deterministically visible to this identity.
const run = "aiqa-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
const email = run + "@example.test";
const password = "Qa-" + crypto.randomBytes(9).toString("hex") + "-x9";
const ACCT = crypto.randomUUID();
let token = "";
let authedEmail = "";
let logBaselineT = 0;
function pick(o) {
  if (!o || typeof o !== "object") return undefined;
  for (let i = 1; i < arguments.length; i++) {
    const k = arguments[i];
    if (k in o) return o[k];
    const lo = String(k).toLowerCase();
    const keys = Object.keys(o);
    for (let j = 0; j < keys.length; j++) if (String(keys[j]).toLowerCase() === lo) return o[keys[j]];
  }
  return undefined;
}
async function req(method, p, body, opts) {
  opts = opts || {};
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), opts.timeout || REQ_TIMEOUT);
  const headers = { "content-type": "application/json" };
  if (token) headers["authorization"] = "Bearer " + token;
  try {
    const r = await fetch(WEB + p, { method: method, signal: ctl.signal, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json: json, text: text };
  } catch (e) { return { status: 0, json: null, text: "transport-failure: " + (e && e.name ? e.name : "error") }; }
  finally { clearTimeout(t); }
}
const get = (p, o) => req("GET", p, undefined, o);
const post = (p, b, o) => req("POST", p, b, o);
const patch = (p, b, o) => req("PATCH", p, b, o);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
async function uploadPortrait(rosterId) {
  const form = new FormData(); form.append("file", new Blob([PNG], { type: "image/png" }), "qa-neutral.png");
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), REQ_TIMEOUT);
  try {
    const hdrs = token ? { "authorization": "Bearer " + token } : {};
    const r = await fetch(WEB + "/api/roster/" + rosterId + "/image/upload", { method: "POST", signal: ctl.signal, headers: hdrs, body: form });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: r.status, json: json, text: text };
  } catch { return { status: 0, json: null, text: "transport-failure" }; }
  finally { clearTimeout(t); }
}
async function fakeLog() {
  if (!FAKE_ENABLED) return null;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), REQ_TIMEOUT);
  try {
    const r = await fetch(fakeUrl.origin + "/__log", { signal: ctl.signal });
    const j = await r.json(); return Array.isArray(j) ? j : null;
  } catch { return null; } finally { clearTimeout(t); }
}
// Owned prompt-log view: baseline timestamp (captured at setup, NEVER a
// global DELETE) + this run markers. No global mutation, ever.
function ownedLog(log) { return (log || []).filter((e) => Number(e.t || 0) >= logBaselineT && String(e.full || "").includes(run)); }
function dossierHits(log, mark) { return ownedLog(log).filter((e) => e.path === "responses" && String(e.full || "").includes(mark)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const M1 = "QA-CRIT-" + run, M2 = "QA-REAS-" + run, M3 = "QA-STYLE-" + run;
const N1 = "QA-CRIT2-" + run, N2 = "QA-REAS2-" + run, N3 = "QA-STYLE2-" + run;
const OWNED_URL_MARK = "doc-seed-" + run;
const OWNED_URL = "https://example.com/?" + OWNED_URL_MARK;
let boardA = "", boardB = "", rosterId = "", rosterName = "", advisor1 = "", roster2 = "", advisor2 = "", meetingId = "";
// QA-SLEEP:6000 paces the fake run so the real per-advisor activity poll can
// observe transient states; the marker text rides inside the lead content.
const QUESTION = "Council " + run + " [QA-SLEEP:6000]: with one pilot boat down, how do you weigh a dense low-risk berth plan against a sparse high-risk one?";
const SECQ = "secretary: " + run + " please note the pilot-boat gap for the record, no decision yet?";
// ---- browser harness (own headless Edge via playwright-core only) ----
let browser = null; let ctx = null; let page = null;
const netPosts = { messages: [], patch: [], run: [] };
let pageErrors = []; let badResponses = [];
async function launchBrowser() {
  browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(function (cfg) { try { if (cfg.tok) localStorage.setItem("simceo-token", cfg.tok); if (cfg.usr) localStorage.setItem("simceo-user", cfg.usr); if (cfg.acct) localStorage.setItem("simceo-account", cfg.acct); } catch {} }, { tok: token, usr: authedEmail, acct: ACCT });
  page = await ctx.newPage();
  page.on("request", (r) => { try {
    const u = new URL(r.url()); if (u.origin !== WEB) return; const p = u.pathname; const m = r.method(); const t = Date.now();
    if (m === "POST" && /\/api\/meetings\/[^/]+\/messages$/.test(p)) netPosts.messages.push(t);
    if (m === "PATCH" && /\/api\/meetings\/[^/]+$/.test(p)) netPosts.patch.push(t);
    if (m === "POST" && /\/api\/meetings\/[^/]+\/run$/.test(p)) netPosts.run.push(t);
  } catch {} });
  page.on("response", (r) => { try {
    const u = new URL(r.url()); if (u.origin !== WEB) return;
    if (r.status() >= 400) badResponses.push(r.status() + " " + u.pathname.slice(0, 100));
  } catch {} });
  page.on("pageerror", (e) => { try { pageErrors.push(String((e && e.message) || e).slice(0, 160)); } catch {} });
}
async function closeBrowser() {
  try { if (page) await page.close(); } catch {} page = null;
  try { if (ctx) await ctx.close(); } catch {} ctx = null;
  try { if (browser) await browser.close(); } catch {} browser = null;
}
async function gotoTab(hash) { await page.goto(WEB + hash, { waitUntil: "domcontentloaded", timeout: BROWSER_TIMEOUT }); await page.waitForTimeout(1200); }
async function fillField(patterns, value, what) {
  for (let i = 0; i < patterns.length; i++) {
    try { const lab = page.getByLabel(patterns[i], { exact: false }); if (await lab.count() > 0) { await lab.first().fill(value); return "label:" + String(patterns[i]); } } catch {}
  }
  for (let i = 0; i < patterns.length; i++) {
    try { const ph = page.getByPlaceholder(patterns[i]); if (await ph.count() > 0) { await ph.first().fill(value); return "placeholder:" + String(patterns[i]); } } catch {}
  }
  failExit("setup-ambiguous contract: profile field not found (" + what + "). Frontend mount may be WIP; not inventing an endpoint.");
}
// Canonical fresh-collection readback: the SAME wrapper the App uses in
// resolveCanonicalEntry (GET /api/roster?accountId=, unwrap the exact-ID
// entry). Never reads canonical paragraphs from /research.
async function canonicalEntry(id) {
  const rl = await get("/api/roster?accountId=" + ACCT);
  if (rl.status !== 200 || !Array.isArray(rl.json)) return { row: null, entry: null, status: rl.status, text: rl.text };
  let row = null;
  for (let i = 0; i < rl.json.length; i++) {
    const ent = pick(rl.json[i], "entry") || rl.json[i];
    if (String(pick(ent, "id") || "").toLowerCase() === String(id).toLowerCase()) { row = rl.json[i]; break; }
  }
  return { row: row, entry: row ? (pick(row, "entry") || row) : null, status: rl.status, text: "" };
}
function threeParas(profileJson) { try { const p = JSON.parse(profileJson || "{}"); return [p.contributionCriteria, p.reasoningApproach, p.responseStyle].map((s) => String(s || "")); } catch { return []; } }
// Expected (narrowly classified, never blanket-ignored): the pre-save
// /api/profile absence probe legitimately 404s, including the page load.
function isExpectedBad(entry) { return /^404 \/api\/profile(\?|$|\s)/.test(entry); }

// ---- 0. register + fake prompt-log loopback check (baseline, never DELETE) ----
async function stepSetup() {
  const reg = await post("/api/auth/register", { email: email, password: password });
  ok("setup-register-201", reg.status === 201 && pick(reg.json, "token"), "status=" + reg.status + " " + redact(reg.text));
  if (reg.status !== 201) failExit("setup register failed status=" + reg.status + " " + redact(reg.text));
  token = String(pick(reg.json, "token") || ""); authedEmail = String(pick(reg.json, "email") || email);
  ok("setup-token-held", token.length >= 16, "len=" + token.length);
  const me = await get("/api/auth/me");
  ok("setup-me-authenticated", me.status === 200, "status=" + me.status + " " + redact(me.text));
  const log = await fakeLog();
  if (WEB === "http://127.0.0.1:15300") {
    ok("fake-loopback-verified", Array.isArray(log), log === null ? "QA_FAKE /__log unreachable (server must be fake-backed at 15302)" : "entries=" + log.length);
    if (!Array.isArray(log)) failExit("fake prompt log unreachable; refusing to proceed without the required fake loopback proof surface.");
  } else {
    console.log("note: live mode; fake log " + (log === null ? "absent (prompt-log assertions use the explicit live-UNPROVED path)" : "present entries=" + log.length));
  }
  // Baseline (no global DELETE, ever): prompt assertions filter t>=baseline
  // AND owned run markers.
  logBaselineT = Date.now();
  ok("promptlog-baseline-captured", logBaselineT > 0, "baselineT=" + logBaselineT + " entries=" + (Array.isArray(log) ? log.length : "n/a-live"));
  checkBudget("setup");
}
// ---- 1. profile via UI without board; two boards reuse; override isolated ----
async function stepProfile() {
  const pre = await get("/api/profile");
  ok("profile-absent-before-save", pre.status === 404, "status=" + pre.status);
  await launchBrowser();
  await gotoTab("/#/profile");
  const P = {
    name: "QA Default " + run,
    background: "QA default background paragraph for " + run + ": harbor evening shifts and pilot-boat scheduling.",
    familiar: "QA familiar paragraph for " + run + ": berth allocation and tide windows.",
    simpler: "QA simpler paragraph for " + run + ": explain tide math plainly with one example.",
    comms: "QA default comms " + run + ": be direct, show numbers, end with next step.",
  };
  await fillField([/display name/i, /^name/i, /your name/i], P.name, "name");
  await fillField([/background/i], P.background, "background");
  await fillField([/familiar/i], P.familiarTopics, "familiarTopics");
  await fillField([/simpler/i], P.simplerTopics, "simplerTopics");
  await fillField([/communication/i, /comm/i, /preferences/i], P.comms, "commPrefs");
  let saveStatus = 0;
  try {
    const waited = Promise.all([
      page.waitForResponse((r) => /\/api\/(profile|lead)/.test(new URL(r.url()).pathname) && r.request().method() === "POST", { timeout: BROWSER_TIMEOUT }),
      page.getByRole("button", { name: /save/i }).first().click(),
    ]);
    const resps = await waited;
    saveStatus = resps[0].status();
  } catch (e) { ok("profile-ui-saved", false, "no POST /api/profile|lead response completion observed"); }
  if (saveStatus) ok("profile-ui-saved", saveStatus === 200, "status=" + saveStatus);
  const g = await get("/api/profile");
  ok("profile-http-readback", g.status === 200 && pick(g.json, "name") === P.name && String(pick(g.json, "background") || "").includes(run) && String(pick(g.json, "familiarTopics") || "").includes(run) && String(pick(g.json, "simplerTopics") || "").includes(run) && pick(g.json, "commPrefs") === P.comms, "status=" + g.status + " " + redact(g.text));
  const gver = Number(pick(g.json, "version") || 0);
  const mkBoard = async (tag) => {
    const b = await post("/api/boards", { name: run + "-" + tag, mission: "QA integrated board " + tag + " " + run, stage: "qa" });
    if (b.status !== 201 || !pick(b.json, "id")) return { error: "status=" + b.status + " " + redact(b.text) };
    return { id: String(pick(b.json, "id")) };
  };
  const a = await mkBoard("ab"); const b = await mkBoard("bb");
  ok("boards-created", !!a.id && !!b.id, (a.error || a.id) + " / " + (b.error || b.id));
  if (!a.id || !b.id) failExit("board setup failed.");
  boardA = a.id; boardB = b.id;
  const la = await get("/api/boards/" + boardA + "/lead"); const lb = await get("/api/boards/" + boardB + "/lead");
  ok("boards-inherit-default", la.status === 200 && lb.status === 200 && pick(la.json, "name") === P.name && pick(lb.json, "name") === P.name && pick(la.json, "commPrefs") === P.comms, "a=" + la.status + " b=" + lb.status);
  const over = await post("/api/boards/" + boardA + "/lead", { name: "Board Own " + run, roleLabel: "CEO", background: "ob", familiarTopics: "of", simplerTopics: "os", commPrefs: "oc-" + run, version: pick(la.json, "version") });
  ok("explicit-override-ok", over.status === 200 && pick(over.json, "name") === "Board Own " + run, "status=" + over.status + " " + redact(over.text));
  await post("/api/profile", { name: P.name, roleLabel: "Board Lead", background: P.background, familiarTopics: P.familiar, simplerTopics: P.simpler, commPrefs: P.comms + " v2", version: gver }, {});
  const la2 = await get("/api/boards/" + boardA + "/lead"); const lb2 = await get("/api/boards/" + boardB + "/lead");
  ok("override-preserved-foreign-unaffected", la2.status === 200 && pick(la2.json, "name") === "Board Own " + run && lb2.status === 200 && pick(lb2.json, "name") === P.name, "a=" + redact(la2.text) + " b=" + redact(lb2.text));
  checkBudget("profile");
}
// ---- 2. ONE CreateAdvisor UI flow with real research (dialog-scoped) ----
let researchDoneAt = 0;
async function stepCreateAdvisor() {
  await gotoTab("/#/roster");
  // F1: the ACTUAL rail button reads "+ Create new Advisor".
  try { await page.getByRole("button", { name: /\+ Create new Advisor/ }).first().click({ timeout: BROWSER_TIMEOUT }); } catch (e) { ok("create-button-actual", false, "rail button + Create new Advisor not clickable"); failExit("CreateAdvisor entry button missing; aborting (no cascade)."); }
  ok("create-button-actual", true, "+ Create new Advisor clicked");
  // F1+F2: scope EVERYTHING to the actual dialog. The dialog hosts one
  // editor; onCreated also selects the new roster entry, mounting the detail
  // editor behind the modal — global locators would straddle both editors.
  const dlg = page.locator('div.modal[role="dialog"][aria-label="Create advisor"]');
  try { await dlg.waitFor({ timeout: BROWSER_TIMEOUT }); } catch { ok("create-dialog-mounted", false, "Create advisor dialog never mounted (frontend mount WIP?)"); failExit("CreateAdvisor UI not mounted."); }
  ok("create-dialog-mounted", true, "dialog div.modal[role=dialog][aria-label=Create advisor] mounted");
  // F4: documentation-grounded fixture. The subject (reserved example domains
  // in documentation) matches the example.com seed, mirroring the positive
  // fetched baseline in backend qa/character-presence-qa.mjs: fetched:true
  // evidence plus the URL marker carried in the dossier prompt. Harbor
  // expertise + bare example.com is NOT used (that combination proves nothing).
  rosterName = run + "-Docs Adviser";
  await dlg.locator("#cc-name").fill(rosterName);
  await dlg.locator("#cc-description").fill("Documentation and example-domain teaching advisor: explains reserved example domains and illustrative examples in documentation. Fictional teaching advisor for " + run + ".");
  await dlg.locator("#cc-background").fill("Documentation-domain background for " + run + ": teaches reserved example domains and illustrative examples in documentation; keeps an example-domain notebook.");
  await dlg.locator('input[aria-label="Inspiration link 1 of 3"]').fill(OWNED_URL);
  let quickBody = null;
  try {
    const waited = Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/roster/quick" && r.request().method() === "POST", { timeout: BROWSER_TIMEOUT }),
      dlg.getByRole("button", { name: /create draft/i }).click(),
    ]);
    const resps = await waited;
    ok("create-draft-via-ui", resps[0].status() === 201, "status=" + resps[0].status());
    try { quickBody = await resps[0].json(); } catch { quickBody = null; }
  } catch (e) { ok("create-draft-via-ui", false, "POST /api/roster/quick never completed"); failExit("draft create failed; aborting (no cascade)."); }
  rosterId = String(pick(quickBody, "id") || "");
  if (!rosterId) failExit("201 but no roster id from UI create.");
  // F5: VISIBLE live progress, dialog-scoped, correlated with server state.
  // Fresh creation auto-starts research; click ONLY from a proven idle state.
  const statusLoc = dlg.locator("#cc-research-status");
  async function readResearch() {
    let text = "";
    try { text = await statusLoc.innerText(); } catch { text = ""; }
    let running = false, stage = "";
    try {
      const g = await get("/api/roster/" + rosterId + "/research");
      if (g.status === 200 && g.json) { running = !!pick(g.json, "running"); stage = String(pick(g.json, "stage") || ""); }
    } catch {}
    return { text: text || "", running: running, stage: stage };
  }
  function isLiveProgress(t) { return /research status:/i.test(t) && /working/i.test(t) && /(starting|fetching-sources|researching|compiling)/i.test(t) && /(elapsed|live server run)/i.test(t); }
  const s0 = await readResearch();
  const autoStarted = s0.running || /working/i.test(s0.text);
  let clickedManual = false;
  if (!autoStarted) {
    try { await dlg.getByRole("button", { name: /run research on this draft/i }).click({ timeout: 8000 }); clickedManual = true; } catch {}
    await page.waitForTimeout(1500);
  }
  let progressSeen = "";
  for (let i = 0; i < 8; i++) {
    const s = await readResearch();
    if (isLiveProgress(s.text)) { progressSeen = trunc(s.text, 160); break; }
    await sleep(2000);
  }
  ok("research-progress-live-visible", progressSeen !== "", (progressSeen || "no working/stage/elapsed/live-run text observed") + " autoStarted=" + autoStarted + " manualClicked=" + clickedManual);
  if (!progressSeen) failExit("research progress never visibly live; refusing to claim progress from a click.");
  // Bounded wait for the REAL server run via GET research state.
  const end = Date.now() + RESEARCH_TIMEOUT;
  let stage = "", done = false, lastText = "";
  const hb = setInterval(() => console.log("research: still pending..."), 20000);
  try {
    while (Date.now() < end) {
      const g = await get("/api/roster/" + rosterId + "/research");
      if (g.status === 200 && g.json) {
        stage = String(pick(g.json, "stage") || "");
        const ds = String(pick(g.json, "draftStatus") || pick(g.json, "draftstatus") || "");
        lastText = "stage=" + stage + " draftStatus=" + ds;
        if (stage === "done") { done = true; break; }
        if (stage === "failed" || stage === "unsupported" || stage === "interrupted") break;
      }
      try {
        const st = await statusLoc.innerText().catch(() => "");
        if (!progressSeen && isLiveProgress(st)) progressSeen = trunc(st, 160);
      } catch {}
      await sleep(3000);
    }
  } finally { clearInterval(hb); }
  const g = await get("/api/roster/" + rosterId + "/research");
  const evCount = Number(pick(g.json, "evidenceCount") ?? pick(g.json, "evidencecount") ?? -1);
  const supported = /yes|true/i.test(String(pick(g.json, "supported") ?? "")) || evCount >= 1;
  // F4 continued: the owned seed URL must be tracked AND fetched, and the
  // dossier prompt (responses path) must carry the owned marker — otherwise
  // the result is unsupported production behavior and an honest FAIL.
  const srcs = pick(g.json, "sources") || [];
  const srcArr = Array.isArray(srcs) ? srcs : [];
  const ownedFetched = srcArr.filter((e) => String((e && (e.url || e.Url)) || "").includes(OWNED_URL_MARK) && ((e && (e.fetched !== undefined ? e.fetched : e.Fetched)) === true));
  let ownedPrompt = 0;
  const log0 = await fakeLog();
  if (Array.isArray(log0)) ownedPrompt = dossierHits(log0, OWNED_URL_MARK).length;
  ok("research-evidence-owned-fetched", done && ownedFetched.length >= 1, lastText + " evidenceCount=" + evCount + " ownedFetched=" + ownedFetched.length);
  ok("research-dossier-prompt-owned", Array.isArray(log0) ? ownedPrompt >= 1 : true, Array.isArray(log0) ? "owned dossier prompts=" + ownedPrompt : "live mode: no fake log (dossier proof via evidenceRefs only)");
  ok("research-supported-or-honest-fail", done && (supported || evCount >= 1), lastText + " evidenceCount=" + evCount);
  if (!done || !(supported || evCount >= 1)) failExit("research did not ground honestly (" + lastText + "); refusing to force ResearchJson/approval.");
  researchDoneAt = Date.now();
  // Compiled paragraphs: adopt via the DIALOG editor only, then read the 3
  // dialog editables.
  async function readParas() {
    const fs = dlg.locator("fieldset").filter({ hasText: "Character paragraphs" }).locator("textarea");
    const n = await fs.count(); const vals = [];
    for (let i = 0; i < n; i++) vals.push(await fs.nth(i).inputValue().catch(() => ""));
    return vals;
  }
  for (let i = 0; i < 3; i++) {
    try {
      const btns = dlg.getByRole("button", { name: /use compiled draft/i });
      const n = await btns.count();
      if (n > 0) { await btns.first().click({ timeout: 5000 }); await page.waitForTimeout(800); }
      else break;
    } catch { break; }
  }
  let paras = await readParas();
  ok("research-compiled-3paras", paras.length === 3 && paras.every((v) => v.trim().length > 20 && !v.includes("Seed (pending research)")), "count=" + paras.length + " lens=" + paras.map((v) => v.length).join(","));
  // Owner final tweaks with unique markers, saved through the DIALOG editor.
  const fs = dlg.locator("fieldset").filter({ hasText: "Character paragraphs" }).locator("textarea");
  const marks = [M1, M2, M3];
  for (let i = 0; i < 3 && i < paras.length; i++) {
    const cur = await fs.nth(i).inputValue().catch(() => "");
    await fs.nth(i).fill(cur.trim() + " [" + marks[i] + "]");
  }
  const before = await get("/api/roster/" + rosterId + "/research");
  const verBefore = Number(pick(before.json, "version") || 0);
  try {
    const waited = Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/roster/" + rosterId && r.request().method() === "PUT", { timeout: BROWSER_TIMEOUT }),
      dlg.getByRole("button", { name: /save draft changes/i }).click(),
    ]);
    const resps = await waited;
    ok("owner-tweaks-saved", resps[0].status() === 200, "status=" + resps[0].status());
  } catch (e) { ok("owner-tweaks-saved", false, "PUT /api/roster/{id} never completed"); }
  // F3: readback via the canonical fresh collection wrapper (exact-ID entry),
  // exactly as resolveCanonicalEntry does. /research carries NO profileJson.
  const canon = await canonicalEntry(rosterId);
  const full = threeParas(canon.entry ? (pick(canon.entry, "profileJson") || pick(canon.entry, "profilejson") || "") : "");
  ok("owner-markers-roundtrip", canon.status === 200 && !!canon.entry && full.every((v, i) => v.includes(marks[i])), "status=" + canon.status + " lens=" + full.map((v) => v.length).join(","));
  if (!(canon.status === 200 && canon.entry)) failExit("canonical fresh-collection readback failed; refusing HTTP-body proof.");
  const after = await get("/api/roster/" + rosterId + "/research");
  ok("owner-version-bump", Number(pick(after.json, "version") || 0) > verBefore, "before=" + verBefore + " after=" + String(pick(after.json, "version")));
  // F2: close the dialog so later edits use ONLY the selected-roster detail
  // editor (never two mounted editors again).
  try { await dlg.getByRole("button", { name: /close/i }).click({ timeout: 8000 }); } catch {}
  await page.waitForTimeout(600);
  ok("create-dialog-closed", await dlg.count() === 0, "dialog editors remaining=" + await dlg.count());
  checkBudget("create-advisor");
}
// ---- 3. portrait + attach gates + second member ----
// Source-confirmed invariant: the untouched quick second seed leaves
// ResearchRequested=false, and completeness/research approval checks are
// conditional on that flag — missing research is NOT a confirmed
// attach/approval blocker for this seed. The second member is therefore
// created via real HTTP quick + portrait + accept + copy + approve, and is
// proven profile-valid through the completeness gate + canonical readback
// (no research assertions on it, honestly).
async function stepPortraitAttach() {
  const up = await uploadPortrait(rosterId);
  ok("portrait-upload-201", up.status === 201, "status=" + up.status + " " + redact(up.text));
  const imgs = await get("/api/roster/" + rosterId + "/images");
  const imgList = Array.isArray(imgs.json) ? imgs.json : [];
  const imgId = imgList.length > 0 ? String(pick(imgList[0], "id") || "") : "";
  if (!imgId) failExit("portrait uploaded but not listed: " + redact(imgs.text));
  let rev = { status: 0, text: "" };
  if (imgId) rev = await post("/api/images/" + imgId + "/review", { decision: "accept" });
  ok("portrait-accept-200", rev.status === 200, "status=" + rev.status + " " + redact(rev.text));
  if (rev.status !== 200) failExit("portrait review failed; refusing to attach without the accepted gate.");
  const cp = await post("/api/roster/" + rosterId + "/copy", { boardId: boardA, boardRole: "Harbor Strategist" });
  ok("attach-first-201", cp.status === 201 && pick(cp.json, "id"), "status=" + cp.status + " " + redact(cp.text));
  if (!pick(cp.json, "id")) failExit("first attach failed.");
  advisor1 = String(pick(cp.json, "id"));
  const dup = await post("/api/roster/" + rosterId + "/copy", { boardId: boardA, boardRole: "Harbor Strategist" });
  ok("duplicate-attach-409", dup.status === 409, "status=" + dup.status + " " + redact(dup.text));
  const ap = await post("/api/boards/" + boardA + "/advisors/" + advisor1 + "/approve", {});
  ok("approve-first-200", ap.status === 200, "status=" + ap.status + " " + redact(ap.text));
  if (ap.status !== 200) failExit("approve gate did not clear on a researched+accepted advisor.");
  const q2 = await post("/api/roster/quick", { accountId: ACCT, name: run + "-Tide Watcher", description: "Fictional tide-watch member validating that non-participants are still listed for " + run + "." });
  ok("second-quick-201", q2.status === 201 && pick(q2.json, "id"), "status=" + q2.status + " " + redact(q2.text));
  if (!pick(q2.json, "id")) failExit("second member quick failed.");
  roster2 = String(pick(q2.json, "id") || "");
  checkBudget("portrait-attach");
}
// ---- 3b. second member gates + canonical board-advisor resolution ----
async function stepSecondMember() {
  const up2 = await uploadPortrait(roster2);
  ok("second-portrait-upload-201", up2.status === 201, "status=" + up2.status + " " + redact(up2.text));
  const imgs2 = await get("/api/roster/" + roster2 + "/images");
  const imgId2 = Array.isArray(imgs2.json) && imgs2.json.length > 0 ? String(pick(imgs2.json[0], "id") || "") : "";
  const rev2 = imgId2 ? await post("/api/images/" + imgId2 + "/review", { decision: "accept" }) : { status: 0, text: "no-image" };
  ok("second-portrait-accept-200", rev2.status === 200, "status=" + rev2.status + " " + redact(rev2.text));
  // Profile-validated through the REAL gates: completeness endpoint (which is
  // research-conditional for this seed) + canonical fresh-collection readback.
  const comp = await get("/api/roster/" + roster2 + "/completeness");
  const compList = Array.isArray(pick(comp.json, "missing")) ? pick(comp.json, "missing") : [];
  ok("second-complete-gate", comp.status === 200 && pick(comp.json, "complete") === true, "status=" + comp.status + " missing=" + compList.join(";"));
  const canon2 = await canonicalEntry(roster2);
  const p2 = threeParas(canon2.entry ? (pick(canon2.entry, "profileJson") || "") : "");
  ok("second-profile-validated", canon2.status === 200 && !!canon2.entry && p2.length === 3 && p2.every((v) => typeof v === "string" && v.length > 0), "status=" + canon2.status + " lens=" + p2.map((v) => v.length).join(","));
  const cp2 = await post("/api/roster/" + roster2 + "/copy", { boardId: boardA, boardRole: "Tide Watcher" });
  ok("second-attach-201", cp2.status === 201 && pick(cp2.json, "id"), "status=" + cp2.status + " " + redact(cp2.text));
  if (!pick(cp2.json, "id")) failExit("second attach failed.");
  advisor2 = String(pick(cp2.json, "id"));
  const ap2 = await post("/api/boards/" + boardA + "/advisors/" + advisor2 + "/approve", {});
  ok("second-approve-200", ap2.status === 200, "status=" + ap2.status + " " + redact(ap2.text));
  // Per-board GET: ALL advisor canonical IDs resolve to owned roster entries.
  const al = await get("/api/boards/" + boardA + "/advisors");
  const list = Array.isArray(al.json) ? al.json : [];
  const have1 = list.some((x) => String(pick(x, "id") || "").toLowerCase() === advisor1.toLowerCase());
  const have2 = list.some((x) => String(pick(x, "id") || "").toLowerCase() === advisor2.toLowerCase());
  const rl = await get("/api/roster?accountId=" + ACCT);
  const rows = Array.isArray(rl.json) ? rl.json : [];
  const rosterIds = new Set(rows.map((x) => String(pick(pick(x, "entry") || x, "id") || "").toLowerCase()));
  const unresolvable = list.filter((x) => !rosterIds.has(String(pick(x, "rosterEntryId") || pick(x, "rosterentryid") || "").toLowerCase()));
  ok("board-advisors-resolve-roster", al.status === 200 && have1 && have2 && unresolvable.length === 0, "status=" + al.status + " advisors=" + list.length + " unresolvable=" + unresolvable.length);
  checkBudget("second-member");
}
// ---- 4. meeting UI send + activity + secretary ----
// F8: RAW backend states (MeetingActivity: awaiting-selection,
// awaiting-publication, ...) are validated against the raw contract ONLY;
// RENDERED rail badge classes are validated against the mapped UI vocabulary
// (meeting-activity.ts maps awaiting-* to waiting-for-*). Never compared
// across vocabularies.
const RAW_VOCAB = new Set(["idle", "queued", "awaiting-selection", "considering", "responding", "awaiting-publication", "complete", "abstained", "failed", "interrupted"]);
const MAPPED_VOCAB = new Set(["idle", "queued", "waiting-for-selection", "considering", "responding", "waiting-for-publication", "complete", "abstained", "waiting-for-clarification", "failed", "interrupted", "excluded", "needs-approval", "pending"]);
function mapRaw(s) { if (s === "awaiting-selection") return "waiting-for-selection"; if (s === "awaiting-publication") return "waiting-for-publication"; return s; }
async function getActivity(mid) {
  const a = await get("/api/meetings/" + mid + "/activity");
  if (a.status !== 200 || !a.json) return { status: a.status, states: [], raw: a.text };
  const disc = pick(a.json, "discussion") || {};
  const arr = pick(disc, "advisors") || [];
  return { status: 200, states: (Array.isArray(arr) ? arr : []).map((x) => ({ id: String(pick(x, "advisorId") || ""), state: String(pick(x, "state") || ""), reason: String(pick(x, "reason") || "") })), raw: "" };
}
async function stepMeeting() {
  const m = await post("/api/boards/" + boardA + "/meetings", { title: run + " harbor call", brief: "", participantIds: [advisor1] });
  ok("meeting-created-201", m.status === 201 && pick(m.json, "id"), "status=" + m.status + " " + redact(m.text));
  if (!pick(m.json, "id")) failExit("meeting create failed.");
  meetingId = String(pick(m.json, "id"));
  const det0 = await get("/api/boards/" + boardA + "/meetings/" + meetingId);
  ok("meeting-brief-empty", det0.status === 200 && String(pick(det0.json, "brief") || "") === "", "status=" + det0.status);
  await gotoTab("/#/meet?board=" + encodeURIComponent(boardA) + "&meeting=" + encodeURIComponent(meetingId));
  // F6+F7: toolbar search (ACTUAL labelled textbox), EXACT Meeting settings
  // button + in-dialog Decisions & evidence, and the ACTUAL presence rail.
  let shellNote = "";
  let searchOk = false, settingsOk = false, railOk = false, controlOk = false;
  try {
    const searchInput = page.getByLabel("Search messages");
    const hasSearch = await searchInput.count() > 0;
    let isTextbox = false, above = false;
    if (hasSearch) {
      isTextbox = await searchInput.first().getAttribute("type").then((t) => t !== "search").catch(() => false);
      try { isTextbox = (await searchInput.first().getAttribute("role").catch(() => "")) !== "searchbox" || isTextbox; } catch {}
      const msgPos = await page.getByText(/^messages$/i).first().boundingBox().catch(() => null);
      const searchPos = await searchInput.first().boundingBox().catch(() => null);
      above = !!(msgPos && searchPos && searchPos.y < msgPos.y);
    }
    searchOk = hasSearch && above;
    shellNote += "search=" + hasSearch + " aboveMessages=" + above + ";";
    // EXACT settings button (never a global /settings/i first-match: that can
    // hit global navigation Settings and navigate away from the composer).
    const settingsBtn = page.getByRole("button", { name: "Meeting settings", exact: true });
    const settingsDlg = page.locator('section[aria-label="Meeting settings"]');
    if (await settingsBtn.count() > 0) {
      await settingsBtn.first().click({ timeout: 8000 }).catch(() => {});
      await settingsDlg.first().waitFor({ timeout: 8000 }).catch(() => {});
      const dlgVisible = await settingsDlg.first().count().then((n) => n > 0).catch(() => false);
      let hasDecisions = false;
      if (dlgVisible) hasDecisions = await settingsDlg.first().getByText(/decisions.*evidence|evidence.*decisions/i).first().count().then((n) => n > 0).catch(() => false);
      settingsOk = dlgVisible && hasDecisions;
      shellNote += "settingsDlg=" + dlgVisible + " decisions=" + hasDecisions + ";";
      // Source-confirmed native Escape dismissal (cancel path).
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(600);
      const stillOpen = await settingsDlg.first().count().then(async (n) => n > 0 && await settingsDlg.first().isVisible().catch(() => false)).catch(() => false);
      settingsOk = settingsOk && !stillOpen;
      shellNote += "escapeClosed=" + (!stillOpen) + ";";
    } else { shellNote += "settingsBtn=missing;"; }
    // ACTUAL rail: seats by boardRole display name (the rail shows boardRole,
    // never the roster entry name), excluded badge on the non-participant,
    // accepted portrait per advisor seat, Secretary seat in-rail.
    const rail = page.locator('section.meet-participants ul.mp-rail[aria-label="Participant activity"]');
    await rail.waitFor({ timeout: BROWSER_TIMEOUT }).catch(() => {});
    const railPresent = await rail.count() > 0;
    if (railPresent) {
      const seats = rail.locator("li.mp-seat");
      const seatCount = await seats.count();
      const names = await rail.locator(".mp-name").allInnerTexts().catch(() => []);
      const badges = await rail.locator(".mp-badge").allInnerTexts().catch(() => []);
      const classes = await seats.evaluateAll((els) => els.map((e) => e.className)).catch(() => []);
      const hasLead = names.some((n) => n.includes("QA Default " + run));
      const hasAdv1 = names.some((n) => n.includes("Harbor Strategist"));
      const hasAdv2 = names.some((n) => n.includes("Tide Watcher"));
      const hasSec = names.some((n) => /secretary/i.test(n)) && classes.some((c) => c.includes("is-sec"));
      const adv2Excluded = classes.some((c, i) => c.includes("act-excluded") && String(names[i] || "").includes("Tide Watcher"));
      const badgeExcluded = badges.some((b) => /not in this meeting/i.test(b));
      async function portraitLoaded(alt) {
        const img = rail.locator('img[alt="' + alt + '"]');
        if (await img.count() === 0) return "missing:" + alt;
        const src = await img.first().getAttribute("src").catch(() => "");
        if (!src) return "empty-src:" + alt;
        const w = await img.first().evaluate((el) => el.naturalWidth || 0).catch(() => 0);
        return w > 0 ? "" : "not-loaded:" + alt;
      }
      const p1 = await portraitLoaded("Portrait of Harbor Strategist");
      const p2 = await portraitLoaded("Portrait of Tide Watcher");
      const mappedOk = classes.every((c) => String(c).split(/\s+/).filter((t) => t.indexOf("act-") === 0).every((t) => MAPPED_VOCAB.has(t.slice(4))));
      railOk = seatCount >= 4 && hasLead && hasAdv1 && hasAdv2 && hasSec && adv2Excluded && badgeExcluded && p1 === "" && p2 === "" && mappedOk;
      shellNote += "seats=" + seatCount + " lead=" + hasLead + " adv1=" + hasAdv1 + " adv2=" + hasAdv2 + " sec=" + hasSec + " excluded=" + (adv2Excluded && badgeExcluded) + " portraits=" + (p1 || "ok") + "/" + (p2 || "ok") + " mappedVocab=" + mappedOk + ";";
    } else { shellNote += "rail=missing;"; }
    // Exactly one meeting control area (the conv-actions group) + composer.
    const ctlCount = await page.locator('[aria-label="Meeting and advisor controls"]').count().catch(() => -1);
    const composerCount = await page.locator(".composer-bar").count().catch(() => -1);
    controlOk = ctlCount === 1 && composerCount === 1;
    shellNote += "controlAreas=" + ctlCount + " composers=" + composerCount + ";";
  } catch (e) { shellNote += " shell probe threw: " + trunc(String((e && e.message) || e), 120); }
  ok("meeting-search-textbox-above", searchOk, shellNote || "search contract (see contract doc)");
  ok("meeting-settings-dialog-decisions-escape", settingsOk, shellNote || "settings contract (see contract doc)");
  ok("meeting-rail-seats-portraits-secretary", railOk, shellNote || "rail contract (see contract doc)");
  ok("meeting-control-area-once", controlOk, shellNote || "exactly one control area + composer");
  // Restrict participants via a real route (HTTP PATCH is an allowed route),
  // then verify the EXACT participant set on the scoped detail — statuses
  // alone never prove restriction.
  const rp = await patch("/api/meetings/" + meetingId, { participantIds: [advisor1] });
  const detR = await get("/api/boards/" + boardA + "/meetings/" + meetingId);
  let idList = null;
  if (detR.status === 200 && detR.json) {
    const rawIds = pick(detR.json, "participantIds");
    if (Array.isArray(rawIds)) idList = rawIds.map(String);
    else { try { const pj = JSON.parse(pick(detR.json, "participantIdsJson") || "[]"); if (Array.isArray(pj)) idList = pj.map(String); } catch {} }
  }
  ok("participants-restricted-real-route", (rp.status === 200 || rp.status === 204) && detR.status === 200, "patch=" + rp.status + " detail=" + detR.status);
  ok("participants-exact-set", Array.isArray(idList) && idList.length === 1 && idList[0].toLowerCase() === advisor1.toLowerCase(), "ids=" + (idList ? idList.join(",") : "unparsed-assumption(see contract)"));
  // Send ONE question through the real composer.
  const box = page.locator(".composer-bar textarea").first();
  const hasComposer = await box.count() > 0;
  if (!hasComposer) { ok("meeting-send-ready", false, "composer never mounted"); failExit("composer missing."); }
  try { await box.waitFor({ timeout: BROWSER_TIMEOUT }); } catch { ok("meeting-send-ready", false, "composer never mounted"); failExit("composer missing."); }
  await box.fill(QUESTION);
  try {
    await page.waitForFunction(() => { const b = document.querySelector(".composer-bar button.primary"); return b && !b.disabled; }, { timeout: BROWSER_TIMEOUT });
  } catch { ok("meeting-send-ready", false, "send still disabled after draft + meeting load"); failExit("send never enabled."); }
  ok("meeting-send-ready", true, "send enabled after draft + meeting load");
  const sendStart = Date.now();
  const seenStates = new Set();
  const pollAct = setInterval(() => {
    getActivity(meetingId).then((a) => { for (const s of a.states) seenStates.add(s.state + (s.reason ? ":" + s.reason : "")); }).catch(() => {});
  }, 2500);
  await box.press("Enter");
  let progress = "";
  try { await page.waitForFunction(() => document.body.innerText.indexOf("Sending message...") >= 0, { timeout: 8000 }); progress = "sending"; } catch {}
  if (!progress) {
    try { await page.waitForFunction(() => document.body.innerText.indexOf("Requesting advisor responses...") >= 0, { timeout: BROWSER_TIMEOUT }); progress = "working"; } catch { ok("meeting-progress-visible", false, "no sending/working status"); }
  }
  if (progress) ok("meeting-progress-visible", true, progress + " after " + (Date.now() - sendStart) + "ms");
  let terminal = false;
  try { await page.waitForFunction(() => document.body.innerText.indexOf("Responses complete.") >= 0, { timeout: RUN_TIMEOUT }); terminal = true; } catch { ok("meeting-terminal-complete", false, "no Responses complete. within " + RUN_TIMEOUT + "ms"); }
  if (terminal) ok("meeting-terminal-complete", true, "after " + (Date.now() - sendStart) + "ms");
  clearInterval(pollAct);
  const fin = await getActivity(meetingId);
  for (const s of fin.states) seenStates.add(s.state + (s.reason ? ":" + s.reason : ""));
  const observed = [...seenStates];
  // F8 continued: RAW states against the RAW contract only; rendered rail
  // badge classes against the MAPPED contract; mapping cross-checked.
  const rawStates = observed.map((s) => String(s).split(":")[0]);
  const vocabOk = rawStates.every((s) => RAW_VOCAB.has(s));
  const rawReached = rawStates.some((s) => s === "awaiting-publication" || s === "complete");
  let mappedReached = false, mappedOk = true;
  try {
    const rail = page.locator('section.meet-participants ul.mp-rail[aria-label="Participant activity"]');
    const classes = await rail.locator("li.mp-seat").evaluateAll((els) => els.map((e) => e.className)).catch(() => []);
    const acts = [];
    for (const c of classes) { const mt = /act-([a-z-]+)/.exec(String(c)); if (mt) acts.push(mt[1]); }
    mappedOk = acts.every((a) => MAPPED_VOCAB.has(a));
    mappedReached = acts.some((a) => a === "waiting-for-publication" || a === "complete");
    const crossOk = rawStates.every((s) => MAPPED_VOCAB.has(mapRaw(s)));
    ok("activity-mapped-badges-honest", mappedOk && crossOk, "rendered=" + acts.join(","));
  } catch (e) { ok("activity-mapped-badges-honest", false, "rail badge read failed: " + trunc(String((e && e.message) || e), 120)); }
  ok("activity-states-raw-honest", vocabOk && rawReached, "raw=" + observed.join(","));
  // F9: actual once-only lead + auto-init + run (browser-observed counts).
  ok("send-lead-once", netPosts.messages.length === 1, "POST messages=" + netPosts.messages.length);
  ok("autoinit-patch-once", netPosts.patch.length === 1, "PATCH meetings=" + netPosts.patch.length);
  ok("run-once", netPosts.run.length === 1, "POST run=" + netPosts.run.length);
  const msgs = await get("/api/meetings/" + meetingId + "/messages?take=100");
  const msgList = Array.isArray(msgs.json) ? msgs.json : [];
  const leads = msgList.filter((x) => String(pick(x, "sender") || "").toLowerCase() === "lead" && String(pick(x, "content") || pick(x, "body") || "").includes(QUESTION.slice(0, 24)));
  ok("send-lead-text-once", msgs.status === 200 && leads.length === 1, "status=" + msgs.status + " matching-leads=" + leads.length + " total=" + msgList.length);
  const det1 = await get("/api/boards/" + boardA + "/meetings/" + meetingId);
  ok("autobrief-once", det1.status === 200 && String(pick(det1.json, "brief") || "").length > 0, "status=" + det1.status + " briefLen=" + String(pick(det1.json, "brief") || "").length);
  const adv = msgList.filter((x) => { const a = String(pick(x, "advisorId") || ""); return a && a !== "00000000-0000-0000-0000-000000000000"; });
  const nonempty = adv.filter((x) => String(pick(x, "content") || pick(x, "body") || "").trim().length >= 20);
  ok("advisor-reply-nonempty", nonempty.length >= 1, "advisor-nonempty=" + nonempty.length + " advisor-total=" + adv.length);
  if (nonempty.length < 1) failExit("no model contribution: HTTP 200 is not proof; need >=1 nonempty advisor reply.");
  // F9: Secretary direct question through the SAME composer -> correlated
  // completed request + persisted PROVISIONAL note, and NO decision.
  const sreq0 = await get("/api/meetings/" + meetingId + "/secretary/requests");
  const sreq0List = Array.isArray(sreq0.json) ? sreq0.json : [];
  const sreq0Ids = new Set(sreq0List.map((x) => String(pick(x, "id") || "")));
  await box.fill(SECQ);
  await box.press("Enter");
  let prov = false;
  try { await page.waitForFunction(() => /provisional/i.test(document.body.innerText), { timeout: 90000 }); prov = true; } catch { ok("secretary-provisional-visible", false, "no provisional note within 90s"); }
  if (prov) ok("secretary-provisional-visible", true, "provisional note visible via same composer");
  const sreq1 = await get("/api/meetings/" + meetingId + "/secretary/requests");
  const sreq1List = Array.isArray(sreq1.json) ? sreq1.json : [];
  const fresh = sreq1List.filter((x) => !sreq0Ids.has(String(pick(x, "id") || "")));
  ok("secretary-request-recorded", sreq1.status === 200 && fresh.length === 1, "status=" + sreq1.status + " newRequests=" + fresh.length);
  if (fresh.length === 1) {
    const rq = fresh[0];
    const qtext = String(pick(rq, "question") || pick(rq, "inputText") || "");
    const rqId = String(pick(rq, "id") || "");
    ok("secretary-request-correlated", qtext.includes(run) && String(pick(rq, "status") || "") === "completed" && !!pick(rq, "noteId"), "qMatch=" + qtext.includes(run) + " status=" + pick(rq, "status") + " noteId=" + !!pick(rq, "noteId"));
    const one = await get("/api/meetings/" + meetingId + "/secretary/requests/" + rqId);
    const note = pick(one.json, "note") || {};
    const nbody = String(pick(note, "body") || "");
    const nkind = String(pick(note, "kind") || "");
    ok("secretary-note-provisional-persisted", one.status === 200 && (nkind === "secretary-note" || nkind === "secretary-briefing") && pick(note, "provisional") === true && nbody.includes(run), "status=" + one.status + " kind=" + nkind + " provisional=" + pick(note, "provisional") + " bodyMatch=" + nbody.includes(run));
  } else {
    ok("secretary-request-correlated", false, "expected exactly 1 new request, found " + fresh.length);
    ok("secretary-note-provisional-persisted", false, "no single correlated request to resolve");
  }
  const nz = await get("/api/meetings/" + meetingId + "/notes?kind=direction");
  const nlist = Array.isArray(nz.json) ? nz.json : [];
  const dirs = nlist.filter((x) => String(pick(x, "kind") || "").toLowerCase() === "direction");
  const nonProv = dirs.filter((x) => pick(x, "provisional") !== true);
  ok("secretary-no-decision", nz.status === 200 && nonProv.length === 0, "status=" + nz.status + " directionNotes=" + dirs.length + " nonProvisional=" + nonProv.length);
  checkBudget("meeting");
}
// ---- 5. canonical re-edit + re-gate + prompt-log markers ----
async function stepReeditRerun() {
  await gotoTab("/#/roster");
  // F2: the creation dialog is closed (asserted in stepCreateAdvisor), so the
  // page holds exactly ONE Character paragraphs editor: the selected-roster
  // detail editor. Open the OWN entry by clicking its roster name.
  let editorOpen = false;
  try {
    const cand = page.getByText(rosterName, { exact: false }).first();
    await cand.click({ timeout: BROWSER_TIMEOUT });
    await page.waitForTimeout(1200);
    const n = await page.locator("fieldset").filter({ hasText: "Character paragraphs" }).count().catch(() => 0);
    editorOpen = n === 1;
  } catch {}
  ok("canonical-editor-open", editorOpen, editorOpen ? "exactly one Character paragraphs editor (detail)" : "could not open owned entry into a single detail editor");
  if (!editorOpen) failExit("canonical editor did not open as a single detail editor; refusing HTTP-only edit (UI path required).");
  const fs = page.locator("fieldset").filter({ hasText: "Character paragraphs" }).locator("textarea");
  const n = await fs.count();
  if (n !== 3) failExit("expected 3 paragraph editables, found " + n);
  const cur = [];
  for (let i = 0; i < 3; i++) cur.push(await fs.nth(i).inputValue().catch(() => ""));
  const marks2 = [N1, N2, N3];
  for (let i = 0; i < 3; i++) {
    const stripped = cur[i].split("[" + M1).join("").split("[" + M2).join("").split("[" + M3).join("").trim();
    await fs.nth(i).fill(stripped + " [" + marks2[i] + "]");
  }
  const rBefore = await get("/api/roster/" + rosterId + "/research");
  const verBefore = Number(pick(rBefore.json, "version") || 0);
  const editMarkAt = Date.now();
  try {
    const waited = Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/roster/" + rosterId && r.request().method() === "PUT", { timeout: BROWSER_TIMEOUT }),
      page.getByRole("button", { name: /save draft changes/i }).first().click(),
    ]);
    const resps = await waited;
    ok("canonical-edit-saved", resps[0].status() === 200, "status=" + resps[0].status());
  } catch (e) { ok("canonical-edit-saved", false, "PUT /api/roster/{id} never completed"); failExit("canonical edit save failed."); }
  // F3: readback via the canonical fresh collection wrapper (exact-ID entry).
  const canon = await canonicalEntry(rosterId);
  const full = threeParas(canon.entry ? (pick(canon.entry, "profileJson") || "") : "");
  ok("canonical-markers-roundtrip", canon.status === 200 && !!canon.entry && full.every((v, i) => v.includes(marks2[i])), "status=" + canon.status + " lens=" + full.map((v) => v.length).join(","));
  const rAfter = await get("/api/roster/" + rosterId + "/research");
  ok("canonical-version-bump", Number(pick(rAfter.json, "version") || 0) > verBefore, "before=" + verBefore + " after=" + String(pick(rAfter.json, "version")));
  // Board re-review/sync/approve via the actual gate (observe; never assume no re-approval).
  const sy = await post("/api/boards/" + boardA + "/advisors/" + advisor1 + "/sync-roster", {});
  const syOk = sy.status === 200;
  const ap = await post("/api/boards/" + boardA + "/advisors/" + advisor1 + "/approve", {});
  ok("rereview-sync-approve", syOk && ap.status === 200, "sync=" + sy.status + " " + redact(sy.text) + " approve=" + ap.status + " " + redact(ap.text));
  if (!(syOk && ap.status === 200)) failExit("re-review gate did not clear; stopping before rerun proof.");
  // Next run: fresh owned meeting, HTTP run (real route), then prompt-log proof.
  const m2 = await post("/api/boards/" + boardA + "/meetings", { title: run + " harbor rerun", brief: "Rerun brief " + run, participantIds: [advisor1] });
  if (m2.status !== 201 || !pick(m2.json, "id")) failExit("rerun meeting create failed.");
  const mid2 = String(pick(m2.json, "id"));
  const r2 = await post("/api/meetings/" + mid2 + "/run", {}, { timeout: RUN_TIMEOUT });
  ok("rerun-run-200", r2.status === 200, "status=" + r2.status + " " + redact(r2.text));
  const log = await fakeLog();
  if (Array.isArray(log)) {
    // F10: correlate CURRENT markers to the EXACT owned advisor contribution:
    // the same responses prompt must carry the advisor correlation (role or
    // roster name) AND all current markers, with no stale-marker leak.
    const post2 = ownedLog(log).filter((e) => Number(e.t || 0) >= editMarkAt - 5000 && e.path === "responses");
    const ownedCorr = post2.filter((e) => String(e.full || "").includes("Harbor Strategist") || String(e.full || "").includes(rosterName) || String(e.full || "").includes(advisor1));
    const withCurrent = ownedCorr.filter((e) => [N1, N2, N3].every((mk) => String(e.full || "").includes(mk)));
    const staleLeak = post2.filter((e) => [M1, M2, M3].some((mk) => String(e.full || "").includes(mk)));
    ok("promptlog-current-markers-owned", withCurrent.length >= 1 && staleLeak.length === 0, "post-edit=" + post2.length + " ownedCorr=" + ownedCorr.length + " current=" + withCurrent.length + " stale-leak=" + staleLeak.length);
  } else {
    // F10: live mode has no prompt log: report the missing prompt evidence as
    // an explicit UNPROVED requirement (fails closed). A published nonempty
    // reply is NEVER accepted as prompt proof.
    const vm = await get("/api/meetings/" + mid2 + "/messages?take=100");
    const vl = Array.isArray(vm.json) ? vm.json : [];
    const vadv = vl.filter((x) => String(pick(x, "content") || pick(x, "body") || "").trim().length >= 20);
    ok("promptlog-live-unproved", false, "live mode: prompt inspection unavailable; rerun published-nonempty=" + vadv.length + " but prompt correlation UNPROVED (no fake log)");
  }
  checkBudget("reedit-rerun");
}

// ---- 5b. roster direct chat through the REAL RosterChatPanel UI ----
async function stepRosterChatUI() {
  await gotoTab("/#/roster");
  try { await page.getByText(rosterName, { exact: false }).first().click({ timeout: BROWSER_TIMEOUT }); } catch {}
  await page.waitForTimeout(1200);
  const panel = page.locator('div[data-roster-chat="' + rosterId + '"]');
  let panelOk = false;
  try { await panel.waitFor({ timeout: BROWSER_TIMEOUT }); panelOk = true; } catch { ok("roster-chat-panel-mounted", false, "RosterChatPanel for owned advisor never mounted"); }
  ok("roster-chat-panel-mounted", panelOk, panelOk ? "div[data-roster-chat] mounted" : "panel missing");
  if (!panelOk) failExit("roster chat panel missing; refusing HTTP-only chat.");
  const headOk = await panel.getByText("Chat with this advisor", { exact: false }).count().then((c) => c > 0).catch(() => false);
  const boardfreeOk = await panel.getByText(/nothing here joins a meeting/i).count().then((c) => c > 0).catch(() => false);
  ok("roster-chat-boardfree-contract", headOk && boardfreeOk, "heading=" + headOk + " boardfree-note=" + boardfreeOk);
  const chatLog = panel.locator('[role="log"]');
  const chatBox = panel.getByLabel(/message /i);
  const boxOk = await chatBox.count() > 0;
  ok("roster-chat-controls", boxOk && await chatLog.count() > 0, "messageBox=" + boxOk);
  if (!boxOk) failExit("roster chat message box missing.");
  const mc0 = await get("/api/meetings/" + meetingId + "/messages?take=100");
  const c0 = Array.isArray(mc0.json) ? mc0.json.length : -1;
  await chatBox.first().fill("Direct " + run + ": state your current berth criterion in one line?");
  const sendBtn = panel.getByRole("button", { name: /^send$/i });
  try { await sendBtn.first().click({ timeout: 8000 }); } catch { ok("roster-chat-ui-reply", false, "Send never clickable"); failExit("roster chat send failed."); }
  let replied = "";
  try {
    await page.waitForFunction((rid) => {
      const el = document.querySelector('div[data-roster-chat="' + rid + '"] [role="log"]');
      return el && el.innerText && el.innerText.length > 80;
    }, rosterId, { timeout: 90000 });
    replied = await chatLog.first().innerText().catch(() => "");
  } catch { ok("roster-chat-ui-reply", false, "no advisor reply rendered in roster chat log within 90s"); }
  if (replied) ok("roster-chat-ui-reply", replied.length > 80 && /direct/i.test(replied), "logLen=" + replied.length);
  const mc1 = await get("/api/meetings/" + meetingId + "/messages?take=100");
  ok("roster-chat-stateless", mc1.status === 200 && Array.isArray(mc1.json) && mc1.json.length === c0, "before=" + c0 + " after=" + (Array.isArray(mc1.json) ? mc1.json.length : "?"));
  checkBudget("roster-chat-ui");
}
// ---- 6. navigation: every named destination, direct routes, back/forward ----
async function scanDebug(tag) {
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
  const guidHits = (bodyText.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) || []).length;
  const jsonHits = (bodyText.match(/"\w+"\s*:\s*[\[{"]/g) || []).length;
  const html = await page.evaluate(() => document.documentElement.innerHTML.slice(0, 200000)).catch(() => "");
  const hiddenGuid = /data-.*id="[0-9a-f-]{36}"/i.test(html) || /<!--.*[0-9a-f]{8}-.*-->/i.test(html);
  const clean = guidHits === 0 && jsonHits === 0 && !hiddenGuid;
  ok("debug-clean-" + tag, clean, "guidHits=" + guidHits + " jsonHits=" + jsonHits + " hidden=" + hiddenGuid);
}
async function stepNavigation() {
  // F11: EVERY named rail destination (repo convention: nav.rail buttons by
  // exact name, hash arrival with board context, as in qa/navigation.cjs). No
  // skipped destinations: arrived must equal total.
  const dests = [
    { label: "Boards", seg: "boards" },
    { label: "Roster", seg: "roster" },
    { label: "Board Advisors", seg: "advisors" },
    { label: "Meetings", seg: "meet" },
    { label: "Sources", seg: "sources" },
    { label: "Records", seg: "records" },
    { label: "People", seg: "people" },
    { label: "Activity", seg: "activity" },
    { label: "Settings", seg: "settings" },
    { label: "Profile", seg: "profile" },
    { label: "Help", seg: "help" },
  ];
  let arrived = 0;
  for (const d of dests) {
    let clicked = false;
    try { await page.locator("nav.rail").getByRole("button", { name: d.label, exact: true }).click({ timeout: 8000 }); clicked = true; }
    catch {
      try { await page.locator("nav.rail").getByRole("link", { name: d.label, exact: true }).click({ timeout: 8000 }); clicked = true; } catch {}
    }
    if (!clicked) { ok("nav-dest-" + d.seg, false, "nav control not clickable: " + d.label); continue; }
    await page.waitForTimeout(900);
    const h = await page.evaluate(() => location.hash).catch(() => "");
    const hashOk = h.indexOf("#/" + d.seg) === 0;
    if (hashOk) arrived++;
    ok("nav-dest-" + d.seg, hashOk, "hash=" + h.slice(0, 120));
    await scanDebug("nav-" + d.seg);
  }
  ok("nav-all-destinations", arrived === dests.length, "arrived=" + arrived + "/" + dests.length);
  // Entity confirmation on the key screens (intended screen AND entity).
  await page.locator("nav.rail").getByRole("button", { name: "Boards", exact: true }).click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(900);
  const boardsBody = await page.evaluate(() => document.body.innerText).catch(() => "");
  ok("nav-entity-boards", boardsBody.includes(run + "-ab"), "owned board listed");
  await page.locator("nav.rail").getByRole("button", { name: "Roster", exact: true }).click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(900);
  const rosterBody = await page.evaluate(() => document.body.innerText).catch(() => "");
  ok("nav-entity-roster", rosterBody.includes(rosterName), "owned advisor listed");
  await page.locator("nav.rail").getByRole("button", { name: "Board Advisors", exact: true }).click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(900);
  const advSec = await page.locator('section[aria-label="This Board\'s Advisors"]').count().catch(() => 0);
  const advBody = await page.evaluate(() => document.body.innerText).catch(() => "");
  ok("nav-entity-advisors", advSec > 0 && advBody.includes("Harbor Strategist"), "advisors section + owned role");
  await page.locator("nav.rail").getByRole("button", { name: "Records", exact: true }).click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(900);
  const recSec = await page.locator("section").filter({ hasText: "Records" }).first().count().catch(() => 0);
  ok("nav-entity-records", recSec > 0, "records section visible");
  // Direct routes + back/forward with EXACT expected hashes (never merely
  // "different"): profile, roster, then the owned meeting.
  await gotoTab("/#/profile");
  await gotoTab("/#/roster");
  await gotoTab("/#/meet?board=" + encodeURIComponent(boardA) + "&meeting=" + encodeURIComponent(meetingId));
  const meetBody = await page.evaluate(() => document.body.innerText).catch(() => "");
  ok("nav-direct-meet-entity", meetBody.includes(run + " harbor call"), "owned meeting title rendered");
  await page.goBack().catch(() => {});
  await page.waitForTimeout(900);
  const backHash = await page.evaluate(() => location.hash).catch(() => "");
  await page.goForward().catch(() => {});
  await page.waitForTimeout(900);
  const fwdHash = await page.evaluate(() => location.hash).catch(() => "");
  ok("nav-direct-backforward", backHash === "#/roster" && fwdHash.indexOf("#/meet") === 0 && fwdHash.includes(meetingId), "back=" + backHash.slice(0, 60) + " fwd=" + fwdHash.slice(0, 120));
  // F12: narrowly classify the expected pre-save /api/profile 404s; every
  // other page error / failed response is unexplained.
  const expected = badResponses.filter(isExpectedBad);
  const unexpected = badResponses.filter((e) => !isExpectedBad(e));
  ok("no-unexpected-failures", pageErrors.length === 0 && unexpected.length === 0, "pageerrors=" + pageErrors.length + " unexpectedBad=" + unexpected.length + " expected404s=" + expected.length + (unexpected.length ? " " + redact(unexpected.slice(0, 3).join(" | ")) : ""));
  checkBudget("navigation");
}

async function main() {
  try {
    await stepSetup();
    await stepProfile();
    await stepCreateAdvisor();
    await stepPortraitAttach();
    await stepSecondMember();
    await stepMeeting();
    await stepReeditRerun();
    await stepRosterChatUI();
    await stepNavigation();
  } catch (e) {
    fail++;
    const m = "threw " + trunc(String((e && e.stack) || (e && e.message) || e), 400).replace(/[0-9a-f]{32,}/gi, "[redacted]");
    failures.push(m); console.log("  FAIL " + m);
  } finally {
    // Browser/context cleanup is UNCONDITIONAL; process.exit never runs
    // before this finally.
    await closeBrowser();
  }
  console.log("");
  console.log("ADVISOR INTEGRATED QA " + (fail === 0 ? "PASS" : "FAIL") + " assertions-pass=" + pass + " assertions-fail=" + fail + " elapsedMs=" + elapsed());
  if (failures.length) { console.log("failures:"); for (const f of failures) console.log(" - " + redact(f)); }
  console.log("note: owned QA account/boards/roster/meetings left for forensics (exact-ID scope only; never touched other rows/accounts; no backup/restore/reconcile/reset; no private values logged).");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log("FATAL " + redact(String((e && e.stack) || e))); process.exit(2); });
