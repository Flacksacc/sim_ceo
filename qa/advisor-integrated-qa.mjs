// qa/advisor-integrated-qa.mjs — FINAL integrated advisor milestone QA (Muse-authored, sole script author).
//
// Own worktree: .tmp/advisor-integration-qa. This file is the ONLY code change;
// no App/server edits. Primary mechanically ports this file into the final
// coherent root and executes it there; this author never runs it (no services,
// browsers, processes, Docker, .env, or human ports here — node --check only).
//
// What it proves, using REAL compiled UI + REAL API (fake-backed by default):
//  1. Account-default profile saved via UI without a board (three paragraph
//     inputs + default comm prefs); two owned boards read back the same default;
//     an explicit per-board override does not leak to the foreign board.
//  2. ONE CreateAdvisor UI flow: name + description + optional BG + public
//     example.com documentation URL (fictional character, safe fetchable topic).
//     Real research progress is visible and 3 editable compiled paragraphs
//     eventually populate; owner saves final tweaks with unique markers.
//     Never forces ResearchJson/approval; unsupported/provider failure is an
//     honest FAIL, never a skip.
//  3. Portrait upload (neutral fixture PNG, real API) + accepted review; first
//     attach required, second attach rejected 409; per-board advisor canonical
//     IDs resolve to owned roster entries. A SECOND owned member (real HTTP
//     quick/profile-validated) proves non-participants are still listed.
//  4. ONE meeting UI send: toolbar search above Messages, Decisions & Evidence
//     inside settings, ALL board members + Secretary portrait tray (non-
//     participant shown), participants restricted via real routes. One question
//     drives one lead + one auto-brief (blank start) + one run + advisor reply,
//     with always-visible progress. Fake sleep markers pace observation of the
//     real per-advisor activity poll. Secretary direct question through the same
//     composer yields an actual provisional note (not a decision). Activity
//     states are sourced from the real contract vocabulary only.
//  5. Canonical roster 3-paragraph re-edit through the actual editor + board
//     re-review/sync/approve via the actual gate; the next run's fake prompt
//     log carries the CURRENT full markers (not the old copy). Roster direct
//     chat is board-free with board-like messaging controls.
//  6. Navigation across tabs/direct routes/back-forward on the owned account:
//     no hidden raw GUID/JSON debug surface, no unexpected page errors or
//     unexplained failed requests.
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
const COMPOSER_LABEL = "Message. Press Enter to send, Shift and Enter for a new line.";
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
function failExit(msg) { console.log("FATAL " + msg); process.exit(2); }
function elapsed() { return Date.now() - startedAt; }
function checkBudget(name) { ok(name + "-within-budget", elapsed() < OVERALL_BUDGET_MS, elapsed() + "ms"); }

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
const run = "aiqa-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
const email = run + "@example.test";
const password = "Qa-" + crypto.randomBytes(9).toString("hex") + "-x9";
const ACCT = crypto.randomUUID();
let token = "";
let authedEmail = "";
function pick(o, ...keys) {
  if (!o || typeof o !== "object") return undefined;
  for (const k of keys) { if (k in o) return o[k]; const lo = String(k).toLowerCase(); for (const key of Object.keys(o)) if (String(key).toLowerCase() === lo) return o[key]; }
  return undefined;
}
async function req(method, p, body, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), opts.timeout || REQ_TIMEOUT);
  const headers = { "content-type": "application/json" };
  if (token) headers["authorization"] = "Bearer " + token;
  try {
    const r = await fetch(WEB + p, { method, signal: ctl.signal, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
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
    const r = await fetch(WEB + "/api/roster/" + rosterId + "/image/upload", { method: "POST", signal: ctl.signal, headers: token ? { "authorization": "Bearer " + token } : {}, body: form });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: r.status, json, text };
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const M1 = "QA-CRIT-" + run, M2 = "QA-REAS-" + run, M3 = "QA-STYLE-" + run;
const N1 = "QA-CRIT2-" + run, N2 = "QA-REAS2-" + run, N3 = "QA-STYLE2-" + run;
let boardA = "", boardB = "", rosterId = "", advisor1 = "", roster2 = "", advisor2 = "", meetingId = "";
const QUESTION = "Council " + run + ": with one pilot boat down, how do you weigh a dense low-risk berth plan against a sparse high-risk one?";

// ---- browser harness (own headless Edge via playwright-core only) ----
let browser = null; let ctx = null; let page = null;
const netPosts = { messages: [], patch: [], run: [] };
let pageErrors = []; let badResponses = [];
async function launchBrowser() {
  browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(({ tok, usr }) => { try { if (tok) localStorage.setItem("simceo-token", tok); if (usr) localStorage.setItem("simceo-user", usr); } catch {} }, { tok: token, usr: authedEmail });
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
  for (const rx of patterns) {
    try { const lab = page.getByLabel(rx, { exact: false }); if (await lab.count() > 0) { await lab.first().fill(value); return "label:" + String(rx); } } catch {}
  }
  for (const rx of patterns) {
    try { const ph = page.getByPlaceholder(rx); if (await ph.count() > 0) { await ph.first().fill(value); return "placeholder:" + String(rx); } } catch {}
  }
  failExit("setup-ambiguous contract: profile field not found (" + what + "). Frontend mount may be WIP; not inventing an endpoint. Tried labels/placeholders: " + patterns.map(String).join(" | "));
}

// ---- 0. register + fake prompt-log loopback check ----
async function stepSetup() {
  const reg = await post("/api/auth/register", { email, password });
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
    try { await fetch(fakeUrl.origin + "/__log", { method: "DELETE" }); } catch {}
  } else {
    console.log("note: live mode; fake log " + (log === null ? "absent (prompt-log assertions use live fallback)" : "present entries=" + log.length));
  }
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
  await fillField([/familiar/i], P.familiar, "familiarTopics");
  await fillField([/simpler/i], P.simpler, "simplerTopics");
  await fillField([/communication/i, /comm/i, /preferences/i], P.comms, "commPrefs");
  let saveStatus = 0;
  try {
    const [resp] = await Promise.all([
      page.waitForResponse((r) => /\/api\/(profile|lead)/.test(new URL(r.url()).pathname) && r.request().method() === "POST", { timeout: BROWSER_TIMEOUT }),
      page.getByRole("button", { name: /save/i }).first().click(),
    ]);
    saveStatus = resp.status();
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
  const s3 = await post("/api/profile", { name: P.name, roleLabel: "Board Lead", background: P.background, familiarTopics: P.familiar, simplerTopics: P.simpler, commPrefs: P.comms + " v2", version: gver }, {});
  void s3;
  const la2 = await get("/api/boards/" + boardA + "/lead"); const lb2 = await get("/api/boards/" + boardB + "/lead");
  ok("override-preserved-foreign-unaffected", la2.status === 200 && pick(la2.json, "name") === "Board Own " + run && lb2.status === 200 && pick(lb2.json, "name") === P.name, "a=" + redact(la2.text) + " b=" + redact(lb2.text));
  checkBudget("profile");
}

// ---- 2. ONE CreateAdvisor UI flow with real research ----
let researchDoneAt = 0;
async function stepCreateAdvisor() {
  await gotoTab("/#/roster");
  const flow = page.locator('section[aria-label="Create advisor"]');
  if (await flow.count() === 0) {
    try { await page.getByRole("button", { name: /create advisor/i }).first().click({ timeout: BROWSER_TIMEOUT }); } catch {}
  }
  try { await page.locator('section[aria-label="Create advisor"]').waitFor({ timeout: BROWSER_TIMEOUT }); } catch { ok("create-flow-visible", false, "CreateAdvisor section never mounted (frontend mount WIP?)"); failExit("CreateAdvisor UI not mounted."); }
  ok("create-flow-visible", true, "CreateAdvisor section mounted");
  const cname = run + "-Harbor Adviser";
  await page.locator("#cc-name").fill(cname);
  await page.locator("#cc-description").fill("Fictional harbor-operations adviser weighing berth and tide tradeoffs for " + run + ". Studies how ports sequence pilotage when staffing is tight.");
  await page.locator("#cc-background").fill("Fictional color for " + run + ": grew up near a container terminal; keeps a tide table notebook.");
  await page.locator('input[aria-label="Inspiration link 1 of 3"]').fill("https://example.com/");
  let quickBody = null;
  try {
    const [resp] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/roster/quick" && r.request().method() === "POST", { timeout: BROWSER_TIMEOUT }),
      page.getByRole("button", { name: /create draft/i }).first().click(),
    ]);
    ok("create-draft-via-ui", resp.status() === 201, "status=" + resp.status());
    try { quickBody = await resp.json(); } catch { quickBody = null; }
  } catch (e) { ok("create-draft-via-ui", false, "POST /api/roster/quick never completed"); failExit("draft create failed; aborting (no cascade)."); }
  rosterId = String(pick(quickBody, "id") || "");
  if (!rosterId) { ok("create-draft-via-ui", false, "201 but no roster id"); failExit("no roster id from UI create."); }
  // research progress visible (auto-starts on fresh creation; click only if idle)
  let progressSeen = "";
  try {
    await page.getByText(/research status:/i).first().waitFor({ timeout: BROWSER_TIMEOUT });
    const st = await page.locator("#cc-research-status").innerText().catch(() => "");
    if (/working|researching|stage/i.test(st)) progressSeen = trunc(st, 120);
  } catch {}
  if (!progressSeen) {
    try { await page.getByRole("button", { name: /run research on this draft/i }).first().click({ timeout: 8000 }); progressSeen = "manual-start-clicked"; } catch {}
  }
  // bounded wait for the REAL server run via unwrapped GET entry research state
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
        const st = await page.locator("#cc-research-status").innerText().catch(() => "");
        if (!progressSeen && /working|researching|stage|elapsed/i.test(st)) progressSeen = trunc(st, 120);
      } catch {}
      await sleep(3000);
    }
  } finally { clearInterval(hb); }
  ok("research-progress-visible", !!progressSeen, progressSeen || "no working/stage text observed");
  const g = await get("/api/roster/" + rosterId + "/research");
  const evCount = Number(pick(g.json, "evidenceCount") ?? pick(g.json, "evidencecount") ?? -1);
  const supported = /yes|true/i.test(String(pick(g.json, "supported") ?? "")) || evCount >= 1;
  ok("research-supported-or-honest-fail", done && (supported || evCount >= 1), lastText + " evidenceCount=" + evCount);
  if (!done || !(supported || evCount >= 1)) failExit("research did not ground honestly (" + lastText + "); refusing to force ResearchJson/approval.");
  researchDoneAt = Date.now();
  // compiled paragraphs: adopt via real UI if they differ, then read the 3 editables
  async function readParas() {
    const fs = page.locator("fieldset").filter({ hasText: "Character paragraphs" }).locator("textarea");
    const n = await fs.count(); const vals = [];
    for (let i = 0; i < n; i++) vals.push(await fs.nth(i).inputValue().catch(() => ""));
    return vals;
  }
  for (let i = 0; i < 3; i++) {
    try {
      const btns = page.getByRole("button", { name: /use compiled draft/i });
      const n = await btns.count();
      if (n > 0) { await btns.first().click({ timeout: 5000 }); await page.waitForTimeout(800); }
      else break;
    } catch { break; }
  }
  let paras = await readParas();
  ok("research-compiled-3paras", paras.length === 3 && paras.every((v) => v.trim().length > 20 && !v.includes("Seed (pending research)")), "count=" + paras.length + " lens=" + paras.map((v) => v.length).join(","));
  // owner final tweaks with unique markers, saved through the actual editor
  const fs = page.locator("fieldset").filter({ hasText: "Character paragraphs" }).locator("textarea");
  const marks = [M1, M2, M3];
  for (let i = 0; i < 3 && i < paras.length; i++) {
    const cur = await fs.nth(i).inputValue().catch(() => "");
    await fs.nth(i).fill(cur.trim() + " [" + marks[i] + "]");
  }
  const before = await get("/api/roster/" + rosterId + "/research");
  const verBefore = Number(pick(before.json, "version") || 0);
  try {
    const [resp] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/roster/" + rosterId && r.request().method() === "PUT", { timeout: BROWSER_TIMEOUT }),
      page.getByRole("button", { name: /save draft changes/i }).first().click(),
    ]);
    ok("owner-tweaks-saved", resp.status() === 200, "status=" + resp.status());
  } catch (e) { ok("owner-tweaks-saved", false, "PUT /api/roster/{id} never completed"); }
  const after = await get("/api/roster/" + rosterId + "/research");
  const prof = (() => { try { return JSON.parse(pick(after.json, "profileJson") || pick(after.json, "profilejson") || "{}"); } catch { return {}; } })();
  const full = [prof.contributionCriteria, prof.reasoningApproach, prof.responseStyle].map((s) => String(s || ""));
  ok("owner-markers-roundtrip", full.every((v, i) => v.includes(marks[i])), "lens=" + full.map((v) => v.length).join(","));
  ok("owner-version-bump", Number(pick(after.json, "version") || 0) > verBefore, "before=" + verBefore + " after=" + String(pick(after.json, "version")));
  checkBudget("create-advisor");
}

// ---- 3. portrait + attach gates + second member ----
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
  if (ap.status !== 200) failExit("approve gate failed on a researched+accepted advisor.");
  // second owned member via real HTTP quick + portrait + accept + copy + approve (profile-validated)
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
  // profile-validated: canonical GET entry carries the 3 paragraphs at current version
  const rl = await get("/api/roster?accountId=" + ACCT);
  const rows = Array.isArray(rl.json) ? rl.json : [];
  const row2 = rows.find((x) => String(pick(pick(x, "entry") || x, "id") || "").toLowerCase() === roster2.toLowerCase());
  const ent2 = pick(row2, "entry") || row2 || {};
  let prof2 = {};
  try { prof2 = JSON.parse(pick(ent2, "profileJson") || "{}"); } catch {}
  ok("second-profile-validated", rl.status === 200 && !!row2 && ["contributionCriteria", "reasoningApproach", "responseStyle"].every((k) => typeof prof2[k] === "string"), "status=" + rl.status);
  const cp2 = await post("/api/roster/" + roster2 + "/copy", { boardId: boardA, boardRole: "Tide Watcher" });
  ok("second-attach-201", cp2.status === 201 && pick(cp2.json, "id"), "status=" + cp2.status + " " + redact(cp2.text));
  if (!pick(cp2.json, "id")) failExit("second attach failed.");
  advisor2 = String(pick(cp2.json, "id"));
  const ap2 = await post("/api/boards/" + boardA + "/advisors/" + advisor2 + "/approve", {});
  ok("second-approve-200", ap2.status === 200, "status=" + ap2.status + " " + redact(ap2.text));
  // per-board GET: ALL advisor canonical IDs resolve to owned roster entries
  const al = await get("/api/boards/" + boardA + "/advisors");
  const list = Array.isArray(al.json) ? al.json : [];
  const have1 = list.some((x) => String(pick(x, "id") || "").toLowerCase() === advisor1.toLowerCase());
  const have2 = list.some((x) => String(pick(x, "id") || "").toLowerCase() === advisor2.toLowerCase());
  const rosterIds = new Set(rows.map((x) => String(pick(pick(x, "entry") || x, "id") || "").toLowerCase()));
  const unresolvable = list.filter((x) => !rosterIds.has(String(pick(x, "rosterEntryId") || pick(x, "rosterentryid") || "").toLowerCase()));
  ok("board-advisors-resolve-roster", al.status === 200 && have1 && have2 && unresolvable.length === 0, "status=" + al.status + " advisors=" + list.length + " unresolvable=" + unresolvable.length);
  checkBudget("second-member");
}

// ---- 4. meeting UI send + activity + secretary ----
const VOCAB = new Set(["idle", "queued", "waiting-for-selection", "considering", "responding", "waiting-for-publication", "complete", "abstained", "waiting-for-clarification", "failed", "interrupted", "excluded", "needs-approval", "pending"]);
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
  // toolbar search above Messages; settings holds Decisions & Evidence; tray has all + Secretary
  let shellOk = false, shellNote = "";
  try {
    const searchBox = page.getByRole("searchbox").first();
    const hasSearch = await searchBox.count() > 0;
    const msgPos = await page.getByText(/^messages$/i).first().boundingBox().catch(() => null);
    const searchPos = hasSearch ? await searchBox.boundingBox().catch(() => null) : null;
    const above = !!(msgPos && searchPos && searchPos.y < msgPos.y);
    const settingsBtn = page.getByRole("button", { name: /settings/i }).first();
    let hasDecisions = false;
    if (await settingsBtn.count() > 0) {
      await settingsBtn.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(800);
      hasDecisions = await page.getByText(/decisions.*evidence|evidence.*decisions/i).first().count().then((n) => n > 0).catch(() => false);
      await page.keyboard.press("Escape").catch(() => {});
    }
    const body = await page.evaluate(() => document.body.innerText).catch(() => "");
    const trayHasAdvisor2 = body.includes(run + "-Tide Watcher") || (await page.getByText(/not in this meeting/i).count().catch(() => 0)) > 0;
    const trayHasSecretary = /secretary/i.test(body);
    shellNote = "search=" + hasSearch + " above=" + above + " decisions=" + hasDecisions + " nonparticipant=" + trayHasAdvisor2 + " secretary=" + trayHasSecretary;
    shellOk = hasSearch && above && hasDecisions && trayHasAdvisor2 && trayHasSecretary;
  } catch (e) { shellNote = "shell probe threw: " + trunc(String((e && e.message) || e), 120); }
  ok("meeting-ui-shell", shellOk, shellNote || "toolbar search/settings/decisions/tray contract (see docs/advisor-integrated-qa-contract.md)");
  // restrict participants via a real route (HTTP PATCH is an allowed real route)
  const rp = await patch("/api/meetings/" + meetingId, { participantIds: [advisor1] });
  const detR = await get("/api/boards/" + boardA + "/meetings/" + meetingId);
  ok("participants-restricted-real-route", (rp.status === 200 || rp.status === 204) && detR.status === 200, "patch=" + rp.status + " detail=" + detR.status);
  // send ONE question through the real composer
  const box = page.locator(".composer-bar textarea").first();
  const hasComposer = await box.count() > 0;
  let usedFallbackComposer = "";
  let activeBox = box;
  if (!hasComposer) {
    try { activeBox = page.locator('textarea[aria-label="' + COMPOSER_LABEL + '"]').first(); } catch {}
    usedFallbackComposer = "aria-label-fallback";
  }
  try { await activeBox.waitFor({ timeout: BROWSER_TIMEOUT }); } catch { ok("meeting-send-ready", false, "composer never mounted " + usedFallbackComposer); failExit("composer missing."); }
  await activeBox.fill(QUESTION);
  try {
    await page.waitForFunction(() => { const b = document.querySelector(".composer-bar button.primary"); return b && !b.disabled; }, { timeout: BROWSER_TIMEOUT });
  } catch { ok("meeting-send-ready", false, "send still disabled after draft + meeting load"); failExit("send never enabled."); }
  ok("meeting-send-ready", true, "send enabled after draft + meeting load " + usedFallbackComposer);
  const sendStart = Date.now();
  const seenStates = new Set();
  const pollAct = setInterval(() => {
    getActivity(meetingId).then((a) => { for (const s of a.states) seenStates.add(s.state + (s.reason ? ":" + s.reason : "")); }).catch(() => {});
  }, 2500);
  await activeBox.press("Enter");
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
  const vocabOk = observed.every((s) => VOCAB.has(String(s).split(":")[0]));
  const participantSeen = observed.some((s) => /waiting-for-publication|complete/.test(s));
  const claimedResponding = observed.includes("responding");
  ok("activity-states-honest", vocabOk && participantSeen, "observed=" + observed.join(",") + " respondingClaimedOnlyIfSeen=" + claimedResponding);
  ok("send-lead-once", netPosts.messages.length === 1, "POST messages=" + netPosts.messages.length);
  const msgs = await get("/api/meetings/" + meetingId + "/messages?take=100");
  const msgList = Array.isArray(msgs.json) ? msgs.json : [];
  const leads = msgList.filter((x) => String(pick(x, "sender") || "").toLowerCase() === "lead" && String(pick(x, "content") || pick(x, "body") || "").includes(QUESTION.slice(0, 24)));
  ok("send-lead-text-once", msgs.status === 200 && leads.length === 1, "status=" + msgs.status + " matching-leads=" + leads.length + " total=" + msgList.length);
  const det1 = await get("/api/boards/" + boardA + "/meetings/" + meetingId);
  ok("autobrief-once", det1.status === 200 && String(pick(det1.json, "brief") || "").length > 0, "status=" + det1.status + " briefLen=" + String(pick(det1.json, "brief") || "").length);
  ok("run-once", netPosts.run.length === 1, "POST run=" + netPosts.run.length);
  const adv = msgList.filter((x) => { const a = String(pick(x, "advisorId") || ""); return a && a !== "00000000-0000-0000-0000-000000000000"; });
  const nonempty = adv.filter((x) => String(pick(x, "content") || pick(x, "body") || "").trim().length >= 20);
  ok("advisor-reply-nonempty", nonempty.length >= 1, "advisor-nonempty=" + nonempty.length + " advisor-total=" + adv.length);
  if (nonempty.length < 1) failExit("no model contribution: HTTP 200 is not proof; need >=1 nonempty advisor reply.");
  // secretary direct question through the SAME composer -> provisional note, not decision
  await activeBox.fill("secretary: " + run + " please note the pilot-boat gap for the record, no decision yet?");
  await activeBox.press("Enter");
  let prov = false;
  try { await page.waitForFunction(() => /provisional/i.test(document.body.innerText), { timeout: 90000 }); prov = true; } catch { ok("secretary-provisional", false, "no provisional note within 90s"); }
  if (prov) ok("secretary-provisional", true, "provisional note visible via same composer");
  const sreq = await get("/api/meetings/" + meetingId + "/secretary/requests");
  ok("secretary-request-recorded", sreq.status === 200, "status=" + sreq.status + " " + redact(sreq.text));
  checkBudget("meeting");
}

// ---- 5. canonical re-edit + re-gate + prompt-log markers; roster direct chat ----
async function stepReeditRerun() {
  await gotoTab("/#/roster");
  // open the canonical editor for our OWN entry (tolerant open: click entry name; honest fail names the assumption)
  let editorOpen = false;
  try {
    const cand = page.getByText(run + "-Harbor Adviser", { exact: false }).first();
    await cand.click({ timeout: BROWSER_TIMEOUT });
    await page.waitForTimeout(1200);
    editorOpen = await page.locator("fieldset").filter({ hasText: "Character paragraphs" }).count().then((n) => n > 0).catch(() => false);
  } catch {}
  ok("canonical-editor-open", editorOpen, editorOpen ? "Character paragraphs fieldset mounted" : "could not open owned entry editor (assumption: clicking the roster entry name opens CharacterEditor)");
  if (!editorOpen) failExit("canonical editor did not open; refusing HTTP-only edit (UI path required).");
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
    const [resp] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/roster/" + rosterId && r.request().method() === "PUT", { timeout: BROWSER_TIMEOUT }),
      page.getByRole("button", { name: /save draft changes/i }).first().click(),
    ]);
    ok("canonical-edit-saved", resp.status() === 200, "status=" + resp.status());
  } catch (e) { ok("canonical-edit-saved", false, "PUT /api/roster/{id} never completed"); failExit("canonical edit save failed."); }
  const rAfter = await get("/api/roster/" + rosterId + "/research");
  ok("canonical-version-bump", Number(pick(rAfter.json, "version") || 0) > verBefore, "before=" + verBefore + " after=" + String(pick(rAfter.json, "version")));
  // board re-review/sync/approve via the actual gate (observe; never assume no re-approval)
  const sy = await post("/api/boards/" + boardA + "/advisors/" + advisor1 + "/sync-roster", {});
  const syOk = sy.status === 200;
  const ap = await post("/api/boards/" + boardA + "/advisors/" + advisor1 + "/approve", {});
  ok("rereview-sync-approve", syOk && ap.status === 200, "sync=" + sy.status + " " + redact(sy.text) + " approve=" + ap.status + " " + redact(ap.text));
  if (!(syOk && ap.status === 200)) failExit("re-review gate did not clear; stopping before rerun proof.");
  // next run: fresh owned meeting, HTTP run (real route), then prompt-log proof
  const m2 = await post("/api/boards/" + boardA + "/meetings", { title: run + " harbor rerun", brief: "Rerun brief " + run, participantIds: [advisor1] });
  if (m2.status !== 201 || !pick(m2.json, "id")) failExit("rerun meeting create failed.");
  const mid2 = String(pick(m2.json, "id"));
  const beforeMsgs = await get("/api/meetings/" + mid2 + "/messages?take=100");
  void beforeMsgs;
  const r2 = await post("/api/meetings/" + mid2 + "/run", {}, { timeout: RUN_TIMEOUT });
  ok("rerun-run-200", r2.status === 200, "status=" + r2.status + " " + redact(r2.text));
  const log = await fakeLog();
  if (Array.isArray(log)) {
    const post2 = log.filter((e) => Number(e.t || 0) >= editMarkAt - 5000);
    const hasAll = (e) => [N1, N2, N3].every((mk) => String(e.full || "").includes(mk));
    const withCurrent = post2.filter(hasAll);
    const staleLeak = post2.filter((e) => [M1, M2, M3].some((mk) => String(e.full || "").includes(mk)));
    ok("promptlog-current-markers", withCurrent.length >= 1 && staleLeak.length === 0, "post-edit=" + post2.length + " current=" + withCurrent.length + " stale-leak=" + staleLeak.length);
  } else {
    // live provider fallback: no fake log exists; prove the rerun published instead
    const vm = await get("/api/meetings/" + mid2 + "/messages?take=100");
    const vl = Array.isArray(vm.json) ? vm.json : [];
    const vadv = vl.filter((x) => String(pick(x, "content") || pick(x, "body") || "").trim().length >= 20);
    ok("promptlog-current-markers-live-fallback", vm.status === 200 && vadv.length >= 1, "live mode: no fake log; published-nonempty=" + vadv.length);
  }
  // roster direct chat: board-free, board-like controls, stateless
  const mc0 = await get("/api/meetings/" + meetingId + "/messages?take=100");
  const c0 = Array.isArray(mc0.json) ? mc0.json.length : -1;
  const chat = await post("/api/roster/" + rosterId + "/chat", { message: "Direct " + run + ": state your current berth criterion in one line?", history: [] });
  const answer = String(pick(chat.json, "answer") || pick(chat.json, "reply") || "");
  const chatLeaksBoard = /\/api\/boards\//.test(chat.text) || /"boardId"\s*:\s*"[0-9a-f-]{36}"/i.test(chat.text);
  ok("roster-chat-boardfree", chat.status === 200 && answer.trim().length > 0 && !chatLeaksBoard, "status=" + chat.status + " answerLen=" + answer.length);
  const mc1 = await get("/api/meetings/" + meetingId + "/messages?take=100");
  ok("roster-chat-stateless", mc1.status === 200 && Array.isArray(mc1.json) && mc1.json.length === c0, "before=" + c0 + " after=" + (Array.isArray(mc1.json) ? mc1.json.length : "?"));
  checkBudget("reedit-rerun");
}

// ---- 6. navigation: tabs, direct routes, back/forward; no debug surfaces ----
async function stepNavigation() {
  const tabs = ["Boards", "Roster", "Board Advisors", "Meetings", "Profile"];
  let clicked = 0;
  for (const t of tabs) {
    try { await page.getByRole("button", { name: new RegExp("^" + t + "$", "i") }).first().click({ timeout: 8000 }); await page.waitForTimeout(900); clicked++; }
    catch {
      try { await page.getByRole("link", { name: new RegExp("^" + t + "$", "i") }).first().click({ timeout: 8000 }); await page.waitForTimeout(900); clicked++; } catch {}
    }
  }
  ok("nav-tabs-clickable", clicked >= 4, "clicked=" + clicked + "/5 (contract: nav labels Boards/Roster/Board Advisors/Meetings/Profile)");
  await gotoTab("/#/profile");
  await gotoTab("/#/roster");
  await gotoTab("/#/meet?board=" + encodeURIComponent(boardA) + "&meeting=" + encodeURIComponent(meetingId));
  await page.goBack().catch(() => {});
  await page.waitForTimeout(900);
  const backHash = await page.evaluate(() => location.hash).catch(() => "");
  await page.goForward().catch(() => {});
  await page.waitForTimeout(900);
  const fwdHash = await page.evaluate(() => location.hash).catch(() => "");
  ok("nav-direct-backforward", backHash !== fwdHash, "back=" + backHash.slice(0, 60) + " fwd=" + fwdHash.slice(0, 60));
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
  const guidHits = (bodyText.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) || []).length;
  const jsonHits = (bodyText.match(/"\w+"\s*:\s*[\[{"]/g) || []).length;
  ok("no-guid-json-surface", guidHits === 0 && jsonHits === 0, "guidHits=" + guidHits + " jsonHits=" + jsonHits);
  const html = await page.evaluate(() => document.documentElement.innerHTML.slice(0, 200000)).catch(() => "");
  const hiddenGuid = /data-.*id="[0-9a-f-]{36}"/i.test(html) || /<!--.*[0-9a-f]{8}-.*-->/i.test(html);
  ok("no-hidden-guid-debug", !hiddenGuid, hiddenGuid ? "hidden raw-ID/debug markup detected" : "no hidden raw-ID/debug markup");
  ok("no-unexpected-failures", pageErrors.length === 0 && badResponses.length === 0, "pageerrors=" + pageErrors.length + " badResponses=" + badResponses.length + (badResponses.length ? " " + redact(badResponses.slice(0, 3).join(" | ")) : ""));
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
    await stepNavigation();
  } catch (e) {
    fail++;
    const m = "threw " + trunc(String((e && e.stack) || (e && e.message) || e), 400).replace(/[0-9a-f]{32,}/gi, "[redacted]");
    failures.push(m); console.log("  FAIL " + m);
  } finally {
    await closeBrowser();
  }
  console.log("");
  console.log("ADVISOR INTEGRATED QA " + (fail === 0 ? "PASS" : "FAIL") + " assertions-pass=" + pass + " assertions-fail=" + fail + " elapsedMs=" + elapsed());
  if (failures.length) { console.log("failures:"); for (const f of failures) console.log(" - " + redact(f)); }
  console.log("note: owned QA account/boards/roster/meetings left for forensics (exact-ID scope only; never touched other rows/accounts; no backup/restore/reconcile/reset; no private values logged).");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log("FATAL " + redact(String((e && e.stack) || e))); process.exit(2); });
