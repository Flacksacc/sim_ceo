"use strict";
// Isolated interaction proof for the feedback-integration frontend.
// Own stack only: API on 127.0.0.1:5181, web on 127.0.0.1:5191, fake model
// provider on 127.0.0.1:5259, fresh in-memory state, fresh Edge profile.
// Never touches 5173/5080/CDP or the human app. No server files are edited.
// The only shim is GET/POST /api/profile served by the temp vite config,
// capturing the pending account-profile contract the UI is built against
// (versioned save + 409 "superseded" on stale base); backend review of the
// real routes is still open, so the fixture stands in explicitly.
const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "web");
const MAIN_QA = "C:/Users/War/scrach/sim_ceo/qa";
const API_PORT = 5181;
const WEB_PORT = 5191;
const FAKE_PORT = 5259;
const API = "http://127.0.0.1:" + API_PORT;
const WEBURL = "http://127.0.0.1:" + WEB_PORT;
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PLAYWRIGHT = path.join(MAIN_QA, "node_modules", "playwright-core");
const PROOF_DIR = path.join(__dirname, "proof");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(name, fn, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout waiting for " + name);
    await sleep(1000);
  }
}
async function api(method, p, body) {
  const r = await fetch(API + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!r.ok) { const e = new Error(r.status + " " + (json && json.error ? json.error : text.slice(0, 200))); throw e; }
  return json;
}


// Self-owned child cleanup only: terminate processes this script started.
// Never touch shared/user processes; on a busy port, report metadata and stop.
const { chromium } = require(PLAYWRIGHT);

const results = { startedAt: new Date().toISOString(), steps: [], pass: true, skipped: 0 };
function sanitize(v) {
  return String(v == null ? "" : v)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .slice(0, 600);
}
let globalBlocked = "";
const ONLY = (process.env.ONLY || "").split(",").map((x) => x.trim()).filter(Boolean);
async function closeDialogs(page) {
  try {
    const dlg = page.getByRole("dialog");
    if ((await dlg.count()) > 0) {
      await page.keyboard.press("Escape");
      await dlg.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    }
  } catch {}
}
async function step(name, fn, opts) {
  opts = opts || {};
  if (ONLY.length > 0 && !ONLY.some((k) => name.indexOf(k) >= 0)) {
    results.steps.push({ name, ms: 0, skipped: true, evidence: "SKIPPED by ONLY filter (" + ONLY.join(",") + ")" });
    results.skipped += 1;
    console.log("skip - " + name);
    return;
  }
  if (globalBlocked) {
    results.steps.push({ name, pass: false, ms: 0, error: "blocked: " + globalBlocked });
    results.pass = false;
    console.log("BLOCKED - " + name + " :: " + globalBlocked);
    return;
  }
  const t0 = Date.now();
  try {
    const evidence = (await fn()) || "";
    results.steps.push({ name, pass: true, ms: Date.now() - t0, evidence: sanitize(evidence) });
    console.log("ok - " + name);
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 500);
    results.steps.push({ name, pass: false, ms: Date.now() - t0, error: sanitize(msg) });
    results.pass = false;
    console.log("FAIL - " + name + " :: " + msg);
  }
}
async function fakeLog() {
  const r = await fetch("http://127.0.0.1:" + FAKE_PORT + "/__log");
  return r.json();
}
async function fakeLogReset() {
  await fetch("http://127.0.0.1:" + FAKE_PORT + "/__log", { method: "DELETE" });
}

let browser = null;
let procs = [];
function track(child) { procs.push(child); return child; }
// Self-owned child cleanup only: terminate processes this script started.
// Never touch shared/user processes; on a busy port, report metadata and stop.
function stopOwned() {
  for (const child of procs.splice(0)) {
    try { if (child.exitCode === null) child.kill(); } catch {}
  }
}
function readTail(p, n) {
  try {
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    return lines.slice(-n).join(' | ').slice(0, 900);
  } catch { return '(no log)'; }
}

async function main() {
  fs.mkdirSync(PROOF_DIR, { recursive: true });
  const apiLog = 'api.log';
  const webLog = 'web.log';
  const logPath = (n) => path.join(PROOF_DIR, n);
  const logFile = (n) => fs.openSync(logPath(n), 'w');

  const fake = track(spawn(process.execPath, [path.join(MAIN_QA, 'fake-provider.mjs'), '--port', String(FAKE_PORT)], { cwd: ROOT, stdio: 'ignore', windowsHide: true }));
  await waitFor('fake provider', async () => { const r = await fetch('http://127.0.0.1:' + FAKE_PORT + '/__health'); return r.ok; }, 30000);

  const apiEnv = Object.assign({}, process.env, {
    META_API_KEY: 'qa-dummy',
    META_API_BASE: 'http://127.0.0.1:' + FAKE_PORT,
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  });
  try {
    execSync('dotnet build server/SimCEO.Api -c Debug --nologo -v q', { cwd: ROOT, env: apiEnv, stdio: 'ignore', windowsHide: true });
  } catch (e) {
    throw new Error('api build failed (offline restore or compile).');
  }
  const apiDll = path.join(ROOT, 'server', 'SimCEO.Api', 'bin', 'Debug', 'net10.0', 'SimCEO.Api.dll');
  if (!fs.existsSync(apiDll)) throw new Error('api build produced no dll: ' + apiDll);
  const apiOut = logFile(apiLog);
  const apiProc = track(spawn('dotnet', [apiDll, '--urls', API], { cwd: ROOT, env: apiEnv, stdio: ['ignore', apiOut, apiOut], windowsHide: true }));
  try {
    await waitFor('api /health', async () => { const r = await fetch(API + '/health'); return r.ok; }, 180000);
  } catch (e) {
    throw new Error('api unhealthy on 127.0.0.1:' + API_PORT + ' (busy port or crash). Tail: ' + readTail(logPath(apiLog), 12));
  }

  const webOut = logFile(webLog);
  const webProc = track(spawn(process.execPath, [path.join(WEB, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', 'vite.isolated-qa.config.ts'], { cwd: WEB, stdio: ['ignore', webOut, webOut], windowsHide: true }));
  try {
    await waitFor('web root', async () => { const r = await fetch(WEBURL + '/'); return r.ok; }, 120000);
  } catch (e) {
    throw new Error('web unhealthy on 127.0.0.1:' + WEB_PORT + ' (busy port or crash). Tail: ' + readTail(logPath(webLog), 12));
  }

  // ---- setup via HTTP (not asserted UI; prepares board + seated advisor)
  const setup = {};
  await step("setup: board + seated approved advisor", async () => {
    try {
    const board = await api("POST", "/api/boards", { name: "Proof Board", mission: "proof mission" });
    setup.boardId = board.id;
    const entry = await api("POST", "/api/roster/quick", { accountId: "00000000-0000-0000-0000-000000000000", name: "Strategist", description: "Pricing strategist with deep B2B experience.", tags: "pricing" });
    setup.rosterId = entry.id;
    const gen = await api("POST", "/api/roster/" + entry.id + "/image/generate", { count: 1 });
    const imgs = gen.images || gen.created || gen;
    const list = Array.isArray(imgs) ? imgs : (imgs.images || []);
    setup.imageId = (list[0] && (list[0].id || list[0])) || (await api("GET", "/api/roster/" + entry.id + "/images"))[0].id;
    await api("POST", "/api/images/" + setup.imageId + "/review", { decision: "accept" });
    const copy = await api("POST", "/api/roster/" + entry.id + "/copy", { boardId: board.id, role: "Strategist" });
    setup.advisorId = copy.id || (copy.advisor && copy.advisor.id);
    await api("POST", "/api/images/" + setup.imageId + "/select", { boardAdvisorId: setup.advisorId });
    await api("POST", "/api/boards/" + board.id + "/advisors/" + setup.advisorId + "/approve", {});
    const entry2 = await api("POST", "/api/roster/quick", { accountId: "00000000-0000-0000-0000-000000000000", name: "Observer", description: "Watches operations with care.", tags: "ops" });
    const gen2 = await api("POST", "/api/roster/" + entry2.id + "/image/generate", { count: 1 });
    const imgs2 = gen2.images || gen2.created || gen2;
    const list2 = Array.isArray(imgs2) ? imgs2 : (imgs2.images || []);
    const imageId2 = (list2[0] && (list2[0].id || list2[0])) || (await api("GET", "/api/roster/" + entry2.id + "/images"))[0].id;
    await api("POST", "/api/images/" + imageId2 + "/review", { decision: "accept" });
    const copy2 = await api("POST", "/api/roster/" + entry2.id + "/copy", { boardId: board.id, role: "Observer" });
    setup.advisorId2 = copy2.id || (copy2.advisor && copy2.advisor.id);
    await api("POST", "/api/images/" + imageId2 + "/select", { boardAdvisorId: setup.advisorId2 });
    return "board ready, Strategist approved, Observer pending approval";
    } catch (e) { globalBlocked = "setup failed: " + String((e && e.message) || e).slice(0, 200); throw e; }
  });

  browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

  // ---- 1. profile: save round-trip, no clobber, stale-base conflict
  await step("profile: save creates version 1", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    setup.pctx1 = ctx; setup.page1 = page;
    await page.goto(WEBURL + "/#/profile", { waitUntil: "domcontentloaded" });
    const section = page.locator('section[aria-label="Profile"]');
    await section.getByText("No saved profile yet.").waitFor({ timeout: 15000 });
    await section.getByLabel("Name").fill("Proof Lead");
    await section.getByLabel("Background").fill("Proof background paragraph.");
    await section.getByRole("button", { name: "Save profile" }).click();
    await section.getByText("Profile saved as your account default for all boards.").first().waitFor({ timeout: 15000 });
    if ((await section.getByText("Provenance").count()) !== 0) throw new Error("provenance copy leaked into profile UI");
    const txt = (await section.innerText()) || "";
    if (/version [0-9]+/i.test(txt)) throw new Error("version numbers leaked into profile UI");
    // keep ctx1/page1 open for the typing + conflict steps below
    return "version 1 saved";
  });
  await step("profile: typing survives post-save refetch (stale-cache guard)", async () => {
    const page = setup.page1;
    const section = page.locator('section[aria-label="Profile"]');
    await section.getByLabel("Background").fill("Proof background paragraph plus more typing.");
    await page.waitForTimeout(4000);
    const v = await section.getByLabel("Background").inputValue();
    if (v !== "Proof background paragraph plus more typing.") throw new Error("typing was clobbered: " + v.slice(0, 80));
    return "typed text intact after refetch";
  });

  await step("profile: stale base save conflicts friendly, edits preserved", async () => {
    const page1 = setup.page1;
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    setup.pctx2 = ctx2;
    await page2.goto(WEBURL + "/#/profile", { waitUntil: "domcontentloaded" });
    const s2 = page2.locator('section[aria-label="Profile"]');
    await s2.getByText("Saved profile loaded.").waitFor({ timeout: 15000 });
    await s2.getByLabel("Name").fill("Second Writer");
    const s1 = page1.locator('section[aria-label="Profile"]');
    await s1.getByLabel("Communication preferences").fill("Direct and brief, please.");
    await s1.getByRole("button", { name: "Save profile" }).click();
    await s1.getByText("Profile saved as your account default for all boards.").first().waitFor({ timeout: 15000 });
    await s2.getByRole("button", { name: "Save profile" }).click();
    await s2.getByRole("alert").waitFor({ timeout: 15000 });
    const alertTxt = (await s2.getByRole("alert").first().innerText()) || "";
    if (alertTxt.indexOf("Another save landed first") < 0) throw new Error("friendly 409 copy missing: " + alertTxt.slice(0, 160));
    const kept = await s2.getByLabel("Name").inputValue();
    if (kept !== "Second Writer") throw new Error("conflicting edits lost");
    if (await s2.getByRole("button", { name: "Save profile" }).isEnabled()) throw new Error("save not frozen after conflict");
    if ((await s2.getByRole("button", { name: "Reload saved profile" }).count()) === 0) throw new Error("reload affordance missing after conflict");
    await ctx2.close();
    return "409 mapped friendly, typed name kept, save frozen until reload";
  });

  // ---- 2. meetings: first-meeting shell, settings, participants
  await step("meet: no-meeting shell offers New meeting", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    setup.pctx3 = ctx; setup.meetPage = page;
    await page.goto(WEBURL + "/#/meet?board=" + setup.boardId, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "No meeting selected" }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "New meeting" }).click();
    await page.locator('ol[aria-label="Meetings"] button').first().waitFor({ timeout: 15000 });
    await page.locator('ol[aria-label="Meetings"] button').first().click();
    setup.meetingA = new URL(page.url()).hash.split("meeting=")[1].split("&")[0];
    const log = await fakeLog();
    if (log.length !== 0) throw new Error("model called during creation: " + log.length);
    return "first meeting created with zero model calls";
  });

  await step("meet: settings brief textarea saves + gating copy shown", async () => {
    const page = setup.meetPage;
    const first = page.locator('ol[aria-label="Meetings"] button').first();
    await first.click();
    await page.getByRole("button", { name: "Meeting settings" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Meeting brief").fill("Should we expand into catering?");
    await dlg.getByRole("button", { name: "Save title + brief" }).click();
    await page.getByText("Should we expand into catering?").first().waitFor({ timeout: 15000 });
    await page.keyboard.press("Escape");
    return "brief saved and shown";
  });

  await step("meet: participant exclusion persists, last uncheck blocked", async () => {
    const page = setup.meetPage;
    await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
    await closeDialogs(page);
    await page.getByRole("button", { name: "Meeting settings" }).click();
    const dlg = page.getByRole("dialog");
    const strat = dlg.getByRole("checkbox", { name: "Strategist" });
    await strat.waitFor({ timeout: 15000 });
    await strat.uncheck();
    await dlg.getByRole("button", { name: "Save title + brief" }).click();
    await page.waitForTimeout(1500);
    const mid = await api("GET", "/api/boards/" + setup.boardId + "/meetings/" + setup.meetingA);
    if (!mid.participantIdsJson || mid.participantIdsJson.indexOf(setup.advisorId) >= 0) throw new Error("exclusion did not persist server-side: " + mid.participantIdsJson);
    await page.keyboard.press("Escape");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Meeting settings" }).click();
    const dlg2 = page.getByRole("dialog");
    if (await dlg2.getByRole("checkbox", { name: "Strategist" }).isChecked()) throw new Error("exclusion did not survive reload");
    if (!(await dlg2.getByRole("checkbox", { name: "Observer" }).isChecked())) throw new Error("observer unexpectedly excluded");
    if (!(await dlg2.getByRole("checkbox", { name: "Observer" }).isDisabled())) throw new Error("last participant uncheck allowed: empty means everyone");
    await dlg2.getByRole("button", { name: "Include everyone" }).click();
    await dlg2.getByRole("button", { name: "Save title + brief" }).click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1500);
    const all = await api("GET", "/api/boards/" + setup.boardId + "/meetings/" + setup.meetingA);
    if (all.participantIdsJson !== "[]") throw new Error("include-everyone not stored as empty: " + all.participantIdsJson);
    return "single exclusion persisted; silent-everyone prevented; include-everyone is explicit";
  });

  await step("meet: settings dialog focus and Escape restore", async () => {
    const page = setup.meetPage;
    await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Meeting settings" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.waitFor({ timeout: 15000 });
    const inside = await page.evaluate(() => { const d = document.querySelector("dialog"); const a = document.activeElement; return !!(d && a && a !== d && d.contains(a)); });
    if (!inside) throw new Error("focus did not move inside the dialog");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached", timeout: 15000 });
    const back = await page.evaluate(() => (document.activeElement && document.activeElement.textContent) || "");
    if (back.indexOf("Meeting settings") < 0) throw new Error("focus did not return to the trigger");
    return "focus in, Escape out, focus restored";
  });

  await step("meet: presence rail always visible with every seat", async () => {
    const page = setup.meetPage;
    await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
    await closeDialogs(page);
    const rail = page.getByRole("region", { name: "Meeting participants" });
    await rail.getByText("Strategist").first().waitFor({ timeout: 15000 });
    for (const name of ["Strategist", "Observer", "Secretary"]) {
      if ((await rail.getByText(name, { exact: false }).count()) === 0) throw new Error("seat missing from rail: " + name);
    }
    if ((await rail.getByText("Needs approval", { exact: true }).count()) < 1) throw new Error("unapproved seat must show Needs approval, never responding");
    await api("PATCH", "/api/meetings/" + setup.meetingA, { participantIds: [setup.advisorId] });
    await page.reload({ waitUntil: "domcontentloaded" });
    await rail.getByText("Observer").first().waitFor({ timeout: 15000 });
    if ((await rail.getByText("Observer", { exact: false }).count()) === 0) throw new Error("excluded seat vanished from rail: " + (await rail.innerText()).slice(0, 300));
    if ((await rail.getByText("Not in this meeting", { exact: true }).count()) < 1) throw new Error("excluded seat must say Not in this meeting");
    await api("PATCH", "/api/meetings/" + setup.meetingA, { participantIds: [] });
    await page.reload({ waitUntil: "domcontentloaded" });
    await rail.getByText("Strategist").first().waitFor({ timeout: 15000 });
    if ((await rail.getByText("Listening", { exact: true }).count()) < 2) throw new Error("silent seats must show Listening, not responding");
    if ((await rail.getByText("Needs approval", { exact: true }).count()) < 1) throw new Error("unapproved seat must keep Needs approval after restore");
    await page.getByRole("button", { name: "Hide meeting context" }).click();
    if (!(await rail.isVisible())) throw new Error("presence rail hidden with collapsed context");
    await page.getByRole("button", { name: "Show context" }).click();
    if (!(await rail.isVisible())) throw new Error("presence rail lost after expanding context");
    return "all seats plus secretary visible, independent of context collapse";
  });
  await step("meet: request enabled with brief, second meeting disabled", async () => {
    const page = setup.meetPage;
    const head = page.locator(".conv-head");
    const reqA = head.getByRole("button", { name: "Request advisor responses" });
    await reqA.waitFor({ timeout: 15000 });
    if (!(await reqA.isEnabled())) throw new Error("request should be enabled with brief + discuss");
    const before = (await fakeLog()).length;
    await page.getByRole("button", { name: "New meeting" }).click();
    const reqB = page.locator(".conv-head").getByRole("button", { name: "Request advisor responses" });
    await reqB.waitFor({ timeout: 15000 });
    await page.getByText("No brief yet.").first().waitFor({ timeout: 15000 });
    for (let k = 0; k < 12; k++) { if (!(await reqB.isEnabled())) break; await page.waitForTimeout(500); }
    if (await reqB.isEnabled()) throw new Error("request enabled on brief-less meeting");
    const u = new URL(page.url());
    setup.meetingIdB = u.hash.split("meeting=")[1].split("&")[0];
    const after = (await fakeLog()).length;
    if (after !== before) throw new Error("model called by meeting creation");
    return "gating correct, creation is model-free";
  });

  await step("meet: settings stay with the meeting they were opened for", async () => {
    const page = setup.meetPage;
    await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
    await closeDialogs(page);
    await page.getByRole("button", { name: "Meeting settings" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Meeting title").fill("MARKER-A-TITLE");
    if ((await dlg.getByLabel("Meeting title").inputValue()) !== "MARKER-A-TITLE") throw new Error("marker fill lost before navigation");
    await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingIdB, { waitUntil: "domcontentloaded" });
    await page.getByRole("dialog").waitFor({ state: "detached", timeout: 15000 });
    await page.getByRole("button", { name: "Meeting settings" }).click();
    const dlgB = page.getByRole("dialog");
    const titleB = await dlgB.getByLabel("Meeting title").inputValue();
    if (titleB === "MARKER-A-TITLE") throw new Error("meeting A draft leaked into meeting B settings");
    await page.keyboard.press("Escape");
    const bDetail = await api("GET", "/api/boards/" + setup.boardId + "/meetings/" + setup.meetingIdB);
    if ((bDetail.brief ?? "") !== "") throw new Error("meeting B brief changed by stray settings");
    await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
    return "settings closed on navigation; B untouched: " + titleB;
  });

  await step("meet: explicit request produces advisor replies", async () => {
    const page = setup.meetPage;
    await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
    await page.getByText("Should we expand into catering?").first().waitFor({ timeout: 15000 });
    setup.meetingId = setup.meetingA;
    const req = page.locator(".conv-head").getByRole("button", { name: "Request advisor responses" });
    await req.click();
    await page.getByText("Advisors drafting...").first().waitFor({ timeout: 15000 });
    await page.locator(".msg-row.advisor .btext").first().waitFor({ timeout: 180000 });
    const n = await page.locator(".msg-row.advisor .btext").count();
    if (n < 1) throw new Error("no advisor replies");
    return n + " advisor message(s) after one explicit request";
  });
  await step("meet: request disabled while paused, draft preserved", async () => {
    const page = setup.meetPage;
    await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
    await page.getByText("Should we expand into catering?").first().waitFor({ timeout: 15000 });
    const head = page.locator(".conv-head");
    const req = head.getByRole("button", { name: "Request advisor responses" });
    await req.waitFor({ timeout: 15000 });
    if (!(await req.isEnabled())) throw new Error("request should be enabled while active");
    const box = page.getByLabel(/Message\. Press Enter/);
    await box.fill("paused draft kept");
    const before = (await fakeLog()).length;
    await page.getByRole("button", { name: "Pause meeting" }).click();
    await page.locator(".conv-status").getByText("Paused").first().waitFor({ timeout: 15000 });
    if (await req.isEnabled()) throw new Error("request enabled while paused");
    if ((await box.inputValue()) !== "paused draft kept") throw new Error("composer draft lost on pause");
    await page.waitForTimeout(1500);
    if ((await fakeLog()).length !== before) throw new Error("model called without an explicit request");
    await page.getByRole("button", { name: "Resume meeting" }).click();
    await page.locator(".conv-status").getByText("Active").first().waitFor({ timeout: 15000 });
    if (!(await req.isEnabled())) throw new Error("request not restored after resume");
    return "paused blocks request, draft kept, resume restores, zero model calls";
  });

  await step("meet: search results stay with their meeting", async () => {
    const page = setup.meetPage;
    await api("POST", "/api/meetings/" + setup.meetingA + "/messages", { sender: "lead", content: "catering budget review seed" });
    await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
    await page.getByText("Should we expand into catering?").first().waitFor({ timeout: 15000 });
    await page.route("**/messages/search**", async (route) => { try { await new Promise((r) => setTimeout(r, 3500)); await route.continue(); } catch {} });
    await page.getByRole("textbox", { name: "Search messages" }).fill("catering");
    await page.getByRole("search").getByRole("button", { name: "Search" }).click();
    await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingIdB, { waitUntil: "domcontentloaded" });
    await page.getByRole("textbox", { name: "Search messages" }).fill("zzz-no-match");
    await page.getByRole("search").getByRole("button", { name: "Search" }).click();
    await page.waitForTimeout(6000);
    if ((await page.locator(".search-hits").count()) !== 0) throw new Error("stale search from meeting A leaked into B");
    try { await page.unrouteAll({ behavior: "wait" }); } catch {}
    await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
    return "late A response discarded, B keeps only its own results";
  });

  await step("meet: held search released after moving without a new search stays away", async () => {
    const page = setup.meetPage;
    await api("POST", "/api/meetings/" + setup.meetingA + "/messages", { sender: "lead", content: "quarantine zebra seed" });
    await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
    await page.getByText("Should we expand into catering?").first().waitFor({ timeout: 15000 });
    await page.route("**/messages/search**", async (route) => { try { await new Promise((r) => setTimeout(r, 3500)); await route.continue(); } catch {} });
    await page.getByRole("textbox", { name: "Search messages" }).fill("quarantine");
    await page.getByRole("search").getByRole("button", { name: "Search" }).click();
    await page.evaluate(() => { try { window.__qaSameDoc = 1; } catch {} });
    await page.evaluate((h) => { window.location.hash = h; }, "#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingIdB);
    await page.waitForTimeout(1200);
    const same = await page.evaluate(() => { try { return window.__qaSameDoc === 1; } catch { return false; } });
    if (!same) throw new Error("document reloaded during same-document search navigation");
    await page.getByRole("textbox", { name: "Search messages" }).waitFor({ timeout: 15000 });
    await page.waitForTimeout(6000);
    if ((await page.locator(".search-hits").count()) !== 0) throw new Error("held A response populated B without any B search (same-document)");
    try { await page.unrouteAll({ behavior: "wait" }); } catch {}
    await api("POST", "/api/meetings/" + setup.meetingIdB + "/messages", { sender: "lead", content: "harbor light seed" });
    await page.getByRole("textbox", { name: "Search messages" }).fill("harbor");
    await page.getByRole("search").getByRole("button", { name: "Search" }).click();
    await page.locator(".search-hits").first().waitFor({ timeout: 15000 });
    const hitsText = await page.locator(".search-hits").innerText();
    if (hitsText.indexOf("harbor") < 0) throw new Error("positive B search did not surface B hits: " + hitsText.slice(0, 200));
    await page.evaluate((h) => { window.location.hash = h; }, "#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA);
    await page.waitForTimeout(900);
    return "same-document A held, B clean without B search, positive B search works";
  });

  await step("meet: settings and people surfaces show no raw identifiers", async () => {
    const page = setup.meetPage;
    const guid = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
    await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Meeting settings" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Note title").fill("Human note");
    await dlg.getByLabel("Note body").fill("plain human note without identifiers");
    await dlg.getByRole("button", { name: "Save note" }).click();
    await dlg.getByText("plain human note without identifiers").first().waitFor({ timeout: 15000 });
    await dlg.locator("details").evaluateAll((ds) => ds.forEach((d) => { d.open = true; }));
    await page.waitForTimeout(800);
    const dtext = await dlg.innerText();
    const dm = dtext.match(guid);
    if (dm) throw new Error("raw identifier visible in settings: " + dm[0].slice(0, 18) + "...");
    await page.keyboard.press("Escape");
    await page.goto(WEBURL + "/#/people?board=" + setup.boardId, { waitUntil: "domcontentloaded" });
    const people = page.locator('section[aria-label="People"]');
    await people.waitFor({ timeout: 15000 });
    const pm = (await people.innerText()).match(guid);
    if (pm) throw new Error("raw identifier visible in people: " + pm[0].slice(0, 18) + "...");
    return "expanded settings and people show human labels only";
  });
  await step("records: structured editor preserves content, revision keeps ids + metadata", async () => {
    const page = setup.meetPage;
    const mid = setup.meetingId || setup.meetingA;
    await page.goto(WEBURL + "/#/records?board=" + setup.boardId + "&meeting=" + mid, { waitUntil: "domcontentloaded" });
    const section = page.locator('section[aria-label="Records"]');
    const prepCard = section.locator("div.card", { hasText: "Prepare draft from the list above" });
    await prepCard.getByRole("button", { name: "Add decision" }).click();
    await prepCard.getByRole("button", { name: "Add decision" }).click();
    await prepCard.getByLabel("Decision 1", { exact: true }).fill("Approve the autumn hiring plan\nwith quarterly review");
    await prepCard.getByLabel("Decision 2", { exact: true }).fill("Decline the pop-up lease");
    await prepCard.getByLabel("Decision 3", { exact: true }).fill("Approve the staff rotation pilot");
    const seenNet = []; page.on("response", (r) => { try { if (String(r.url()).indexOf("/record/draft") >= 0) seenNet.push(r.status() + " " + r.url()); } catch {} });
    await prepCard.getByRole("button", { name: "Prepare draft from the list above" }).click();
    try { await section.getByRole("button", { name: /Version 1/ }).first().waitFor({ timeout: 15000 }); }
    catch (e) { const t = await section.innerText(); const toasts = await page.locator(".toasts").innerText().catch(() => "(no toasts)");
      let srv = "(api n/a)"; try { const rl = await api("GET", "/api/meetings/" + mid + "/records"); srv = "server drafts=" + rl.length + " v=" + rl.map((r) => r.version).join(","); } catch (se) { srv = "server err " + String(se).slice(0, 120); }
      throw new Error("no v1; section: " + t.slice(0, 900) + " || toasts: " + toasts.slice(0, 300) + " || " + srv + " || net: " + seenNet.join(";").slice(0, 300)); }
    await section.getByRole("button", { name: /Version 1/ }).first().click();
    await section.getByText("Approve the autumn hiring plan").first().waitFor({ timeout: 15000 });
    const before = await api("GET", "/api/meetings/" + mid + "/records");
    const v1 = before.find((r) => r.version === 1);
    if (!v1) throw new Error("v1 draft missing");
    const items1 = JSON.parse(v1.itemsJson);
    if (items1.length !== 3 || items1[0].text !== "Approve the autumn hiring plan\nwith quarterly review" || items1[2].text !== "Approve the staff rotation pilot") throw new Error("prepare mangled content: " + v1.itemsJson.slice(0, 160));
    if (new Set(items1.map((i) => i.id)).size !== 3) throw new Error("ids not unique");
    const revCard = section.locator("div.card", { hasText: "Request revision (new version)" });
    await revCard.getByLabel("Decision 1", { exact: true }).fill("Approve the autumn hiring plan now\nwith quarterly review");
    await section.getByRole("button", { name: "Request revision (new version)" }).click();
    await section.getByRole("button", { name: /Version 2/ }).first().waitFor({ timeout: 15000 });
    const after = await api("GET", "/api/meetings/" + mid + "/records");
    const v2 = after.find((r) => r.version === 2);
    if (!v2) throw new Error("v2 missing");
    const items2 = JSON.parse(v2.itemsJson);
    if (items2[0].id !== items1[0].id || items2[1].id !== items1[1].id || items2[2].id !== items1[2].id) throw new Error("revision regenerated ids");
    if (items2[0].text !== "Approve the autumn hiring plan now\nwith quarterly review") throw new Error("multiline edit lost");
    return "v1 ids " + items1.map((i) => i.id).join(",") + " stable into v2, multiline intact";
  });

  await step("records: expanded record surfaces show no raw identifiers", async () => {
    const page = setup.meetPage;
    const guid = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
    const mid2 = setup.meetingId || setup.meetingA;
    await page.goto(WEBURL + "/#/records?board=" + setup.boardId + "&meeting=" + mid2, { waitUntil: "domcontentloaded" });
    const section = page.locator('section[aria-label="Records"]');
    await section.locator("details").evaluateAll((ds) => ds.forEach((d) => { d.open = true; }));
    await page.waitForTimeout(800);
    const text = await section.innerText();
    const m = text.match(guid);
    if (m) throw new Error("raw identifier visible in records: " + m[0].slice(0, 18) + "...");
    return "expanded records show human labels only";
  });
  await step("roster: chat success, preceding-only history, retry without duplicates", async () => {
    const ctx = await browser.newContext();
    let page = null;
    try {
    page = await ctx.newPage();
    setup.chatCtx = ctx;
    setup.chatPage = page;
    await page.goto(WEBURL + "/#/roster", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Create new Advisor" }).first().click();
    const dlg = page.getByRole("dialog", { name: "Create advisor" });
    await dlg.getByRole("textbox", { name: "Name" }).fill("Proof Chat One");
    await dlg.getByRole("textbox", { name: "Role" }).fill("Listener");
    await dlg.getByLabel("Description (your words, always editable)").fill("A patient listener for direct chat proof.");
    await dlg.getByLabel("Include grounded research when creating this draft").uncheck();
    await dlg.getByRole("button", { name: "Create draft", exact: true }).click();
    await page.getByText("Blank draft saved").first().waitFor({ timeout: 15000 });
    await dlg.getByText("Close", { exact: true }).click();
    await page.locator('.lprow-name', { hasText: "Proof Chat One" }).click();
    await page.getByRole("button", { name: "Generate portrait" }).click();
    await page.getByText("Portrait generated.").first().waitFor({ timeout: 90000 });
    await page.getByRole("button", { name: "Accept portrait" }).click();
    await page.waitForTimeout(2000);
    await page.getByRole("button", { name: "Create new Advisor" }).first().click();
    const dlg2 = page.getByRole("dialog", { name: "Create advisor" });
    await dlg2.getByRole("textbox", { name: "Name" }).fill("Proof Chat Two");
    await dlg2.getByRole("textbox", { name: "Role" }).fill("Listener");
    await dlg2.getByLabel("Description (your words, always editable)").fill("Second listener for draft isolation proof.");
    await dlg2.getByLabel("Include grounded research when creating this draft").uncheck();
    await dlg2.getByRole("button", { name: "Create draft", exact: true }).click();
    await page.getByText("Blank draft saved").first().waitFor({ timeout: 15000 });
    await dlg2.getByText("Close", { exact: true }).click();
    await page.locator('.lprow-name', { hasText: "Proof Chat Two" }).click();
    await page.getByRole("button", { name: "Generate portrait" }).click();
    await page.getByText("Portrait generated.").first().waitFor({ timeout: 90000 });
    await page.getByRole("button", { name: "Accept portrait" }).click();
    await page.waitForTimeout(2000);
    await page.locator('.lprow-name', { hasText: "Proof Chat One" }).click();
    const chat = page.locator("[data-roster-chat]");
    await chat.getByPlaceholder(/Ask .* directly/).fill("draft-kept-across-switch");
    await page.locator('.lprow-name', { hasText: "Proof Chat Two" }).click();
    if ((await chat.getByPlaceholder(/Ask .* directly/).inputValue()) !== "") throw new Error("draft leaked across advisors");
    await page.locator('.lprow-name', { hasText: "Proof Chat One" }).click();
    if ((await chat.getByPlaceholder(/Ask .* directly/).inputValue()) !== "draft-kept-across-switch") throw new Error("draft not preserved");
    await chat.getByPlaceholder(/Ask .* directly/).fill("hello advisor one");
    await chat.getByRole("button", { name: "Send" }).click();
    await chat.getByText("Fixture reply to: hello advisor one").first().waitFor({ timeout: 15000 });
    if ((await chat.locator(".msg-row.lead .btext").count()) !== 1) throw new Error("lead turns duplicated");
    if ((await chat.locator(".msg-row.advisor .btext").count()) !== 1) throw new Error("expected one reply, server or panel duplicated");
    await chat.getByPlaceholder(/Ask .* directly/).fill("second question");
    await chat.getByRole("button", { name: "Send" }).click();
    await chat.getByText("Fixture reply to: second question").first().waitFor({ timeout: 15000 });
    const clog = await (await fetch(WEBURL + "/__chat-log")).json();
    const last = clog[clog.length - 1];
    if (last.message !== "second question") throw new Error("server saw wrong message");
    if (last.history.some((h) => h.content === "second question")) throw new Error("current message duplicated into history");
    if (last.history.length !== 2) throw new Error("history should hold exactly the preceding turn, got " + last.history.length);
    await chat.getByPlaceholder(/Ask .* directly/).fill("QA-FAIL probe");
    await chat.getByRole("button", { name: "Send" }).click();
    await chat.getByText("Sending failed. Try again.").waitFor({ timeout: 15000 });
    await chat.getByRole("button", { name: "Copy error report" }).waitFor({ timeout: 15000 });
    if (await chat.getByText("Fixture forced failure").count() !== 0) throw new Error("raw server error displayed");
    if ((await chat.locator(".msg-row.lead .btext").count()) !== 3) throw new Error("pending turn duplicated or lost");
    await chat.getByRole("button", { name: "Retry" }).click();
    await page.waitForTimeout(2000);
    if ((await chat.locator(".msg-row.lead .btext").count()) !== 3) throw new Error("retry duplicated the turn");
    if ((await chat.getByText("profile v").count()) !== 0) throw new Error("technical version shown in chat");
    return "drafts isolated; preceding-only history; single pending turn incl retry; friendly failure";
    } finally { if (page) await closeDialogs(page).catch(() => {}); }
  });

  await step("roster: pending retired on version change, chat stays usable", async () => {
    if (!setup.chatPage) throw new Error("blocked: roster chat scenario did not establish a page");
    const page = setup.chatPage;
    await page.goto(WEBURL + "/#/roster", { waitUntil: "domcontentloaded" });
    await closeDialogs(page);
    await page.getByRole("button", { name: "Create new Advisor" }).first().click();
    const dlg = page.getByRole("dialog", { name: "Create advisor" });
    await dlg.getByRole("textbox", { name: "Name" }).fill("Proof Chat Three");
    await dlg.getByRole("textbox", { name: "Role" }).fill("Listener");
    await dlg.getByLabel("Description (your words, always editable)").fill("Version retire probe.");
    await dlg.getByLabel("Include grounded research when creating this draft").uncheck();
    await dlg.getByRole("button", { name: "Create draft", exact: true }).click();
    await page.getByText("Blank draft saved").first().waitFor({ timeout: 15000 });
    await dlg.getByText("Close", { exact: true }).click();
    await page.locator('.lprow-name', { hasText: "Proof Chat Three" }).click();
    const rosterId = await page.locator("[data-roster-entry-id]").first().getAttribute("data-roster-entry-id");
    if (!rosterId || rosterId.indexOf("-") < 0) throw new Error("no roster id for bump");
    await page.getByRole("button", { name: "Generate portrait" }).click();
    await page.getByText("Portrait generated.").waitFor({ timeout: 60000 });
    const chat = page.locator("[data-roster-chat]");
    await chat.getByPlaceholder(/Ask .* directly/).fill("QA-SLEEP:15000 version retire probe");
    const t0 = Date.now();
    await chat.getByRole("button", { name: "Send" }).click();
    await chat.getByText(/Responding/).first().waitFor({ timeout: 15000 });
    setup.sleepSentAt = Date.now();
    await api("PUT", "/api/roster/" + rosterId, { name: "Proof Chat Three", description: "Version retire probe.", tags: "" });
    await page.getByRole("button", { name: "Accept portrait" }).click();
    await page.waitForTimeout(3000);
    if ((await chat.getByText(/Responding/).count()) !== 0) throw new Error("pending not retired after version change");
    const elapsed = Date.now() - t0;
    await page.waitForTimeout(Math.max(0, 19000 - elapsed));
    if ((await chat.locator(".msg-row.advisor .btext").count()) !== 0) throw new Error("stale reply displayed after resolve");
    await chat.getByPlaceholder(/Ask .* directly/).fill("post-retire check");
    await chat.getByRole("button", { name: "Send" }).click();
    try { await chat.getByText("Fixture reply to: post-retire check").first().waitFor({ timeout: 15000 }); }
    catch (e) { let clog = []; try { clog = await (await fetch(WEBURL + "/__chat-log")).json(); } catch {} const last = clog.length ? clog[clog.length - 1] : null; throw new Error("no post-retire reply; chatLog n=" + clog.length + " last=" + JSON.stringify(last).slice(0, 200)); }
    await setup.chatCtx.close();
    return "stale reply discarded, composer intact, chat usable after retire";
  });

  await step("profile: identity switch drops previous account editor", async () => {
    const page = setup.page1;
    await page.goto(WEBURL + "/#/profile", { waitUntil: "domcontentloaded" });
    const section = page.locator('section[aria-label="Profile"]');
    await section.getByLabel("Name").fill("Account A Name");
    await page.goto(WEBURL + "/#/people?board=" + setup.boardId, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Act as user").fill("BoardTwo");
    await page.getByRole("button", { name: "Apply identity" }).click();
    await page.waitForTimeout(1500);
    await page.route(WEBURL + "/api/profile", async (route) => {
      try {
      if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, 3000));
      await route.continue();
      } catch {}
    });
    await page.goto(WEBURL + "/#/profile", { waitUntil: "domcontentloaded" });
    const saveBtn = page.locator('section[aria-label="Profile"]').getByRole("button", { name: "Save profile" });
    await saveBtn.waitFor({ timeout: 15000 });
    const clickable = await saveBtn.isEnabled().catch(() => true);
    await page.unroute(WEBURL + "/api/profile");
    if (clickable) throw new Error("previous account edits submittable after switch");
    await page.waitForTimeout(3500);
    const nameVal = await page.locator('section[aria-label="Profile"]').getByLabel("Name").inputValue();
    if (nameVal === "Account A Name") throw new Error("previous account edits visible after switch");
    const plog = await (await fetch(WEBURL + "/__profile-log")).json();
    if (plog.some((e) => (e.body && e.body.name) === "Account A Name")) throw new Error("previous account edits were submitted");
    const section2 = page.locator('section[aria-label="Profile"]');
    await section2.getByLabel("Name").fill("Board Two Lead");
    await section2.getByRole("button", { name: "Save profile" }).click();
    await section2.getByText("Profile saved as your account default for all boards.").first().waitFor({ timeout: 15000 });
    await page.goto(WEBURL + "/#/people?board=" + setup.boardId, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Act as user").fill("");
    await page.getByRole("button", { name: "Apply identity" }).click();
    await page.waitForTimeout(1500);
    await page.goto(WEBURL + "/#/profile", { waitUntil: "domcontentloaded" });
    const section3 = page.locator('section[aria-label="Profile"]');
    await section3.getByText("Saved profile loaded.").first().waitFor({ timeout: 15000 });
    const ownerName = await section3.getByLabel("Name").inputValue();
    if (!ownerName || ownerName === "Board Two Lead") throw new Error("owner profile not restored after switch back: " + ownerName);
    return "editor reset on switch, nothing submitted, per-account versions";
  });
  await step("profile: base advances after own save, next save succeeds", async () => {
    const page = setup.page1;
    await page.goto(WEBURL + "/#/profile", { waitUntil: "domcontentloaded" });
    const section = page.locator('section[aria-label="Profile"]');
    // Version ground truth comes from the same fixture the UI talks to
    // (WEBURL, never the real-API helper: /api/profile is a UI-behavior
    // fixture here until the backend routes land).
    let v0 = 0;
    try { const vr = await fetch(WEBURL + "/api/profile"); if (vr.ok) { const cur = await vr.json(); v0 = (cur && cur.version) || 0; } } catch {}
    if (!v0) {
      const statusText = await section.innerText().catch(() => "");
      v0 = 0; try { const vr2 = await fetch(WEBURL + "/api/profile"); if (vr2.ok) { const cur2 = await vr2.json(); v0 = (cur2 && cur2.version) || 0; } } catch {}
    }
    await section.getByLabel("Name").fill("Proof Lead Final");
    await section.getByLabel("Familiar", { exact: false }).first().fill("Base advance probe");
    // Type DURING the save flight (response lands ~1.5s later by fixture
    // contract); waiting for the response text first would make in-flight
    // typing impossible and the kept-typing branch unreachable.
    await section.getByRole("button", { name: "Save profile" }).click();
    const bg = section.getByLabel("Background");
    const cur = await bg.inputValue();
    await bg.fill(cur + " plus flight typing");
    try { await section.getByText("Your newer edits are still in the form").waitFor({ timeout: 20000 }); }
    catch (e) {
      const st = await section.innerText().catch(() => "(no status)");
      let pv = "?";
      try { const cur = await api("GET", "/api/profile"); pv = String(cur.version); } catch (se) { pv = "GET-err:" + String(se).slice(0, 300); }
      let plog = "?";
      try { const pl = await (await fetch(WEBURL + "/__profile-log")).json(); const le = pl[pl.length - 1]; plog = "posts=" + pl.length + " last=" + JSON.stringify(le).slice(0, 160); } catch (se2) { plog = "plog-err"; }
      throw new Error("kept-typing message missing; status=" + JSON.stringify(st).slice(0, 200) + " serverVersion=" + pv + " " + plog);
    }
    await section.getByRole("button", { name: "Save profile" }).click();
    await section.getByText("Profile saved as your account default for all boards.").first().waitFor({ timeout: 20000 });
    const after = await section.getByLabel("Background").inputValue();
    if (after.indexOf("plus flight typing") < 0) throw new Error("newer typing lost across saves");
    if ((await section.getByRole("alert").count()) !== 0) throw new Error("second save conflicted: base did not advance");
    return "base advanced; newer typing applied on the next save";
  });

  // ---- visual presence/settings evidence (fixture-only screenshots) ----
  // Uses the app's real appearance contract (localStorage simceo-theme ->
  // documentElement.dataset.theme) and real layout; screenshots land in
  // qa/proof/shots/ (gitignored) and paths are recorded in the report.
  async function newVisualCtx(viewport, theme) {
    const ctx = await browser.newContext({ viewport, hasTouch: viewport.width <= 480 });
    if (theme) await ctx.addInitScript((t) => { try { localStorage.setItem("simceo-theme", t); } catch {} }, theme);
    const page = await ctx.newPage();
    return { ctx, page };
  }
  async function assertNoHOverflow(page, label) {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 1) throw new Error(label + ": horizontal overflow " + over + "px");
  }
  // Actual geometry/hit-test proof for narrow viewports: isVisible/isEnabled
  // plus programmatic fill can pass beneath an overlapping sticky tray, so
  // mobile steps scroll the real control into view, assert its rect sits
  // inside the viewport below the sticky participants tray, hit-test its tap
  // center with elementFromPoint, and focus it with an actual tap.
  async function trayBottom(page) {
    return await page.evaluate(() => {
      const t = document.querySelector(".meet-participants");
      if (!t) return 0;
      return Math.round(t.getBoundingClientRect().bottom);
    });
  }
  async function assertTapVisible(page, locator, label) {
    await locator.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    let info = await locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      let readable = false;
      try {
        const cs = getComputedStyle(el);
        readable = cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") > 0.5;
      } catch {}
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        same: !!hit && (hit === el || el.contains(hit)),
        hit: hit ? String(hit.tagName + "." + (hit.className && hit.className.baseVal !== undefined ? hit.className.baseVal : hit.className)).slice(0, 80) : "(none)",
        readable };
    });
    const vw = page.viewportSize().width;
    const vh = page.viewportSize().height;
    let tb0 = await trayBottom(page);
    if (info && info.y < tb0 - 1) {
      await locator.evaluate((el) => { try { el.scrollIntoView({ block: "center", inline: "center" }); } catch {} });
      await page.waitForTimeout(300);
      info = await locator.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        let readable = false;
        try {
          const cs = getComputedStyle(el);
          readable = cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") > 0.5;
        } catch {}
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          same: !!hit && (hit === el || el.contains(hit)),
          hit: hit ? String(hit.tagName + "." + (hit.className && hit.className.baseVal !== undefined ? hit.className.baseVal : hit.className)).slice(0, 80) : "(none)",
          readable };
      });
    }
    if (!info || info.w <= 0 || info.h <= 0) throw new Error(label + " has no tappable rect");
    if (!info.readable) throw new Error(label + " is not readable (hidden/transparent)");
    const tb = await trayBottom(page);
    if (info.y < tb - 1) throw new Error(label + " sits under the sticky tray (top " + info.y + " < tray bottom " + tb + ")");
    if (info.x < 0 || info.y < 0 || info.x + info.w > vw + 1 || info.y + info.h > vh + 1)
      throw new Error(label + " outside viewport " + vw + "x" + vh + " rect " + info.x + "," + info.y + " " + info.w + "x" + info.h);
    if (!info.same) throw new Error(label + " tap center hits " + info.hit + " instead of the control");
    return info;
  }
  async function assertTapFocus(page, locator, label) {
    try { await locator.tap(); } catch { await locator.click(); }
    await page.waitForTimeout(300);
    const active = await page.evaluate(() => {
      const a = document.activeElement;
      return a ? (a.tagName + "|" + (a.getAttribute("aria-label") || a.tagName)) : "(none)";
    });
    if (active.indexOf("TEXTAREA") !== 0 && active.indexOf("INPUT") !== 0)
      throw new Error(label + " did not take tap focus, active=" + active);
  }
  async function assertDialogOpaque(page, label) {
    const bg = await page.evaluate(() => {
      const d = document.querySelector("dialog, [role=dialog]");
      if (!d) return null;
      return getComputedStyle(d).backgroundColor;
    });
    if (!bg) throw new Error(label + ": settings dialog missing for opacity check");
    const m = /rgba?\(([^)]+)\)/.exec(bg);
    const parts = m ? m[1].split(",") : [];
    const alpha = parts.length >= 4 ? parseFloat(parts[3]) : 1;
    if (!(alpha >= 0.99)) throw new Error(label + ": settings dialog not opaque, bg=" + bg);
  }
  function shotPath(name) { return path.join(PROOF_DIR, "shots", name); }
  async function settleVisual(page) {
    try { await page.evaluate(() => document.fonts && document.fonts.ready ? document.fonts.ready.then(() => {}).catch(() => {}) : null); } catch {}
    try {
      await page.waitForFunction(() => {
        const imgs = Array.from(document.querySelectorAll(".mp-seat img"));
        return imgs.every((im) => im.complete);
      }, { timeout: 15000 });
    } catch {}
    await page.waitForTimeout(900);
    try {
      await page.evaluate(() => {
        const dlg = document.querySelector("dialog");
        if (dlg) { dlg.style.opacity = "1"; }
        document.querySelectorAll("main section, dialog").forEach((el) => {
          try { el.style.animation = "none"; } catch {}
          try { el.style.transition = "none"; } catch {}
          try { if (getComputedStyle(el).opacity !== "1") el.style.opacity = "1"; } catch {}
        });
      });
    } catch {}
    await page.waitForTimeout(400);
  }

  await step("visual: presence rail 1440px light, every seat with honest portraits", async () => {
    if (!setup.meetingA) throw new Error("blocked: meeting shell scenario did not run");
    fs.mkdirSync(path.join(PROOF_DIR, "shots"), { recursive: true });
    const v = await newVisualCtx({ width: 1440, height: 900 }, null);
    try {
      const page = v.page;
      await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
      const rail = page.getByRole("region", { name: "Meeting participants" });
      await rail.getByText("Strategist").first().waitFor({ timeout: 15000 });
      const theme = await page.evaluate(() => document.documentElement.dataset.theme);
      if (theme !== "light") throw new Error("theme contract not applied, got: " + theme);
      for (const name of ["Strategist", "Observer", "Secretary"]) {
        if ((await rail.getByText(name, { exact: false }).count()) === 0) throw new Error("seat missing from rail: " + name);
      }
      // Atomic seat snapshot: poll until every rendered portrait is decoded
      // (a React re-resolve can swap an <img> between a bare wait and a later
      // read, flaking the honest-portrait assertion). A permanently broken
      // image never satisfies the gate, so the wait times out and fails.
      const seatsHandle = await page.waitForFunction(() => {
        const nodes = Array.from(document.querySelectorAll(".mp-seat"));
        if (nodes.length < 3) return null;
        const out = nodes.map((st) => {
          const im = st.querySelector("img");
          const fb = st.querySelector(".mp-fallback");
          const badge = st.querySelector(".mp-badge");
          return { hasImg: !!im, loaded: im ? (im.complete && im.naturalWidth > 0) : null, fallback: fb ? (fb.textContent || "").trim() : null, badge: badge ? (badge.textContent || "").trim() : null };
        });
        if (!out.some((x) => x.hasImg && x.loaded)) return null;
        if (out.some((x) => x.hasImg && !x.loaded)) return null;
        if (!out.some((x) => !x.hasImg && x.fallback)) return null;
        return out;
      }, { timeout: 20000 }).catch(async (e) => {
        const dbg = await page.evaluate(() => Array.from(document.querySelectorAll(".mp-seat")).map((st) => {
          const im = st.querySelector("img");
          return (st.textContent || "").slice(0, 24) + "|img=" + (!!im) + "|c=" + (im ? im.complete : "-") + "|w=" + (im ? im.naturalWidth : "-");
        }).join(" ; ")).catch(() => "(no dom)");
        throw new Error("portrait seats never reached all-decoded (broken image or missing seat): " + dbg + " :: " + String((e && e.message) || e).slice(0, 120));
      });
      const seats = await seatsHandle.jsonValue();
      if (seats.length < 3) throw new Error("expected at least 3 seats, saw " + seats.length);
      if (seats.some((x) => x.hasImg && !x.loaded)) throw new Error("broken portrait image rendered");
      if (!seats.some((x) => x.hasImg && x.loaded)) throw new Error("no loaded portrait; Strategist image should load");
      if (!seats.some((x) => !x.hasImg && x.fallback)) throw new Error("no initials fallback; Observer/Secretary should fall back");
      if (seats.some((x) => (x.badge || "").indexOf("Responding") >= 0)) throw new Error("idle rail must not show Responding");
      const directChild = await page.evaluate(() => !!document.querySelector(".meet-right > .meet-participants"));
      if (!directChild) throw new Error("rail is not a direct always-visible child of the meeting rail");
      await settleVisual(page);
      await assertNoHOverflow(page, "1440 light");
      await page.screenshot({ path: shotPath("presence-1440-light.png"), fullPage: true });
      return "rail visible, " + seats.length + " seats, portraits+fallbacks honest, shots/presence-1440-light.png";
    } finally { await v.ctx.close().catch(() => {}); }
  });

  await step("visual: hiding context cannot hide the rail", async () => {
    if (!setup.meetingA) throw new Error("blocked: meeting shell scenario did not run");
    const v = await newVisualCtx({ width: 1440, height: 900 }, null);
    try {
      const page = v.page;
      await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
      const rail = page.getByRole("region", { name: "Meeting participants" });
      await rail.getByText("Strategist").first().waitFor({ timeout: 15000 });
      await page.getByRole("button", { name: "Hide meeting context" }).click();
      await page.getByRole("button", { name: "Show context" }).waitFor({ timeout: 15000 });
      if ((await page.locator(".context-body").count()) !== 0) throw new Error("context body should collapse");
      if (!(await rail.isVisible())) throw new Error("presence rail hidden together with context");
      await settleVisual(page);
      await assertNoHOverflow(page, "1440 light collapsed");
      await page.screenshot({ path: shotPath("presence-1440-light-context-hidden.png"), fullPage: true });
      await page.getByRole("button", { name: "Show context" }).click();
      await page.getByRole("button", { name: "Show context" }).waitFor({ state: "detached", timeout: 15000 });
      if (!(await rail.isVisible())) throw new Error("rail lost after expanding context");
      return "rail independent of context collapse, shots/presence-1440-light-context-hidden.png";
    } finally { await v.ctx.close().catch(() => {}); }
  });

  await step("visual: settings dialog shows decisions and evidence in place", async () => {
    if (!setup.meetingA) throw new Error("blocked: meeting shell scenario did not run");
    const v = await newVisualCtx({ width: 1440, height: 900 }, null);
    try {
      const page = v.page;
      await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Meeting settings" }).click();
      const dlg = page.getByRole("dialog");
      await dlg.waitFor({ timeout: 15000 });
      const pos = await page.evaluate(() => {
        const d = document.querySelector("dialog");
        if (!d) return null;
        const picks = d.querySelector(".conv-picks");
        const dec = d.querySelector(".conv-decisions");
        const h4 = dec ? dec.querySelector("h4") : null;
        let orderOk = false;
        if (picks && dec) {
          orderOk = (picks.compareDocumentPosition(dec) & 4) !== 0;
          const save = dec.nextElementSibling;
          orderOk = orderOk && !!save && save.classList.contains("meetctl");
        }
        const txt = d.innerText || "";
        return { hasPicks: !!picks, hasDec: !!dec, h4: h4 ? h4.textContent : "", orderOk: orderOk,
          hasTakeaways: txt.indexOf("Key takeaways") >= 0, hasOptions: txt.indexOf("Options on the table") >= 0,
          hasDecision: txt.indexOf("Decision state") >= 0, hasEvidence: txt.indexOf("Evidence") >= 0,
          hasMeetingViewsTabs: !!document.querySelector('[aria-label="Meeting views"]') };
      });
      if (!pos) throw new Error("settings dialog not found in DOM");
      if (!pos.hasDec || pos.h4.indexOf("Decisions") < 0) throw new Error("Decisions & evidence section missing");
      if (!pos.orderOk) throw new Error("decisions section out of place (must follow participants, precede save)");
      for (const k of ["hasTakeaways", "hasOptions", "hasDecision", "hasEvidence"]) if (!pos[k]) throw new Error("moved block missing: " + k);
      if (pos.hasMeetingViewsTabs) throw new Error("legacy meeting-views tabs still rendered");
      await settleVisual(page);
      await assertDialogOpaque(page, "1440 light");
      await assertNoHOverflow(page, "1440 settings");
      await page.screenshot({ path: shotPath("settings-1440-light.png"), fullPage: true });
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached", timeout: 15000 });
      return "settings owns decisions+evidence in place, shots/settings-1440-light.png";
    } finally { await v.ctx.close().catch(() => {}); }
  });

  await step("visual: 390px mobile rail precedes conversation and sticks", async () => {
    if (!setup.meetingA) throw new Error("blocked: meeting shell scenario did not run");
    const v = await newVisualCtx({ width: 390, height: 844 }, "dark");
    try {
      const page = v.page;
      await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
      const rail = page.getByRole("region", { name: "Meeting participants" });
      await rail.getByText("Strategist").first().waitFor({ timeout: 15000 });
      const theme = await page.evaluate(() => document.documentElement.dataset.theme);
      if (theme !== "dark") throw new Error("dark theme contract not applied: " + theme);
      const order = await page.evaluate(() => {
        const r = document.querySelector(".meet-participants");
        const chat = document.querySelector(".chatscroll");
        const railEl = document.querySelector(".mp-rail");
        if (!r || !chat || !railEl) return null;
        const rb = r.getBoundingClientRect();
        const cb = chat.getBoundingClientRect();
        return { railTop: rb.top, chatTop: cb.top, railAboveChat: rb.top < cb.top,
          sticky: getComputedStyle(r).position, dir: getComputedStyle(railEl).flexDirection };
      });
      if (!order) throw new Error("rail or message flow missing");
      if (!order.railAboveChat) throw new Error("rail does not precede message flow (tops: rail " + order.railTop + " chat " + order.chatTop + ")");
      if (order.sticky !== "sticky") throw new Error("rail must stick while messages/composer are used, got: " + order.sticky);
      if (order.dir !== "row") throw new Error("narrow rail must be a horizontal strip, got: " + order.dir);
      try { await assertNoHOverflow(page, "390 dark"); }
      catch (e) {
        const wide = await page.evaluate(() => {
          const out = [];
          const vw = window.innerWidth;
          document.querySelectorAll("body *").forEach((el) => {
            try {
              const r = el.getBoundingClientRect();
              if (r.width > vw + 1 && out.length < 8) out.push(el.tagName + "." + (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) + " w=" + Math.round(r.width));
            } catch {}
          });
          const probe = document.querySelector(".meet-left input");
          const cs = probe ? getComputedStyle(probe) : null;
          const chain = [];
          let el = document.querySelector(".boardroom");
          while (el && chain.length < 6) { const r = el.getBoundingClientRect(); chain.push(el.tagName + "." + (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) + " w=" + Math.round(r.width)); el = el.parentElement; }
          const bis = ["bisect:"];
          for (const sel of [".meet-left", ".meet-center", ".meet-right", ".conv-head", ".conv-actions", ".conv-title", "ol.agenda", ".conv-search", ".chatscroll", ".composer", ".meet-participants", ".context-bar", ".toasts"]) {
            try {
              const tgt = document.querySelector(sel);
              if (!tgt) { bis.push(sel + "=absent"); continue; }
              const prev = tgt.style.display;
              tgt.style.display = "none";
              bis.push(sel + "->" + document.documentElement.scrollWidth);
              tgt.style.display = prev;
            } catch (be) { bis.push(sel + "=err"); }
          }
          chain.push(bis.join(" "));
          return "vw=" + vw + " docW=" + document.documentElement.scrollWidth + " :: " + out.join(" | ") + " || input(min=" + (cs ? cs.minWidth : "n/a") + " max=" + (cs ? cs.maxWidth : "n/a") + " w=" + (cs ? cs.width : "n/a") + ") chain=" + chain.join(" < ");
        });
        throw new Error(String((e && e.message) || e) + " || " + wide.slice(0, 600));
      }
      await settleVisual(page);
      await page.screenshot({ path: shotPath("presence-390-dark.png"), fullPage: true });
      const navSummaryD = page.locator("details.meet-left > summary").first();
      await assertTapVisible(page, navSummaryD, "meeting selector summary (390 dark)");
      await navSummaryD.click();
      await page.waitForTimeout(400);
      const navOpenD = await page.evaluate(() => { const d = document.querySelector("details.meet-left"); return d ? !!d.open : null; });
      if (!navOpenD) throw new Error("meeting selector did not expand on tap (390 dark)");
      await assertTapVisible(page, page.getByRole("textbox", { name: "Search meetings" }), "meeting filter (390 dark)");
      await navSummaryD.click();
      await page.waitForTimeout(400);
      const toolbarD = page.getByRole("button", { name: "Meeting settings" });
      await assertTapVisible(page, toolbarD, "toolbar settings (390 dark)");
      const composerD = page.getByLabel(/Message\. Press Enter/);
      await assertTapVisible(page, composerD, "composer (390 dark)");
      await assertTapFocus(page, composerD, "composer (390 dark)");
      await composerD.fill("viewport probe dark");
      if ((await composerD.inputValue()) !== "viewport probe dark") throw new Error("composer input lost (390 dark)");
      const msgD = page.locator(".msg-row .btext").first();
      if ((await msgD.count()) === 0) throw new Error("no rendered message to scroll (390 dark)");
      await assertTapVisible(page, msgD, "first message (390 dark)");
      const msgTextD = ((await msgD.innerText().catch(() => "")) || "").trim();
      if (msgTextD.length < 1) throw new Error("first message has no readable text (390 dark)");
      await page.evaluate(() => window.scrollTo(0, 1200));
      await page.waitForTimeout(600);
      const stuck = await page.evaluate(() => { const r = document.querySelector(".meet-participants"); return r ? r.getBoundingClientRect().top : 9999; });
      if (!(await rail.isVisible())) throw new Error("rail lost after scrolling messages");
      if (stuck > 40) throw new Error("rail did not stick during message scroll, top=" + stuck);
      await page.getByRole("button", { name: "Meeting settings" }).click();
      await page.getByRole("dialog").waitFor({ timeout: 15000 });
      await settleVisual(page);
      await assertDialogOpaque(page, "390 dark");
      await page.screenshot({ path: shotPath("settings-390-dark.png"), fullPage: true });
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached", timeout: 15000 });
      return "390px dark: rail first+sticky+horizontal, shots/presence-390-dark.png + shots/settings-390-dark.png";
    } finally { await v.ctx.close().catch(() => {}); }
  });

  await step("visual: presence rail 1440px dark, every seat with honest portraits", async () => {
    if (!setup.meetingA) throw new Error("blocked: meeting shell scenario did not run");
    fs.mkdirSync(path.join(PROOF_DIR, "shots"), { recursive: true });
    const v = await newVisualCtx({ width: 1440, height: 900 }, "dark");
    try {
      const page = v.page;
      await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
      const rail = page.getByRole("region", { name: "Meeting participants" });
      await rail.getByText("Strategist").first().waitFor({ timeout: 15000 });
      const theme = await page.evaluate(() => document.documentElement.dataset.theme);
      if (theme !== "dark") throw new Error("theme contract not applied, got: " + theme);
      for (const name of ["Strategist", "Observer", "Secretary"]) {
        if ((await rail.getByText(name, { exact: false }).count()) === 0) throw new Error("seat missing from rail: " + name);
      }
      // Atomic seat snapshot: poll until every rendered portrait is decoded
      // (a React re-resolve can swap an <img> between a bare wait and a later
      // read, flaking the honest-portrait assertion). A permanently broken
      // image never satisfies the gate, so the wait times out and fails.
      const seatsHandle = await page.waitForFunction(() => {
        const nodes = Array.from(document.querySelectorAll(".mp-seat"));
        if (nodes.length < 3) return null;
        const out = nodes.map((st) => {
          const im = st.querySelector("img");
          const fb = st.querySelector(".mp-fallback");
          const badge = st.querySelector(".mp-badge");
          return { hasImg: !!im, loaded: im ? (im.complete && im.naturalWidth > 0) : null, fallback: fb ? (fb.textContent || "").trim() : null, badge: badge ? (badge.textContent || "").trim() : null };
        });
        if (!out.some((x) => x.hasImg && x.loaded)) return null;
        if (out.some((x) => x.hasImg && !x.loaded)) return null;
        if (!out.some((x) => !x.hasImg && x.fallback)) return null;
        return out;
      }, { timeout: 20000 }).catch(async (e) => {
        const dbg = await page.evaluate(() => Array.from(document.querySelectorAll(".mp-seat")).map((st) => {
          const im = st.querySelector("img");
          return (st.textContent || "").slice(0, 24) + "|img=" + (!!im) + "|c=" + (im ? im.complete : "-") + "|w=" + (im ? im.naturalWidth : "-");
        }).join(" ; ")).catch(() => "(no dom)");
        throw new Error("portrait seats never reached all-decoded (broken image or missing seat): " + dbg + " :: " + String((e && e.message) || e).slice(0, 120));
      });
      const seats = await seatsHandle.jsonValue();
      if (seats.length < 3) throw new Error("expected at least 3 seats, saw " + seats.length);
      if (seats.some((x) => x.hasImg && !x.loaded)) throw new Error("broken portrait image rendered");
      if (!seats.some((x) => x.hasImg && x.loaded)) throw new Error("no loaded portrait; Strategist image should load");
      if (!seats.some((x) => !x.hasImg && x.fallback)) throw new Error("no initials fallback; Observer/Secretary should fall back");
      const convW = await page.evaluate(() => { const el = document.querySelector(".meet-center"); return el ? el.getBoundingClientRect().width : 0; });
      if (convW < 600) throw new Error("desktop chat did not regain width, center=" + Math.round(convW) + "px");
      await settleVisual(page);
      await assertNoHOverflow(page, "1440 dark");
      await page.screenshot({ path: shotPath("presence-1440-dark.png"), fullPage: true });
      return "rail visible dark 1440, center " + Math.round(convW) + "px, shots/presence-1440-dark.png";
    } finally { await v.ctx.close().catch(() => {}); }
  });

  await step("visual: 390px mobile light rail precedes conversation and sticks", async () => {
    if (!setup.meetingA) throw new Error("blocked: meeting shell scenario did not run");
    const v = await newVisualCtx({ width: 390, height: 844 }, null);
    try {
      const page = v.page;
      await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
      const rail = page.getByRole("region", { name: "Meeting participants" });
      await rail.getByText("Strategist").first().waitFor({ timeout: 15000 });
      const theme = await page.evaluate(() => document.documentElement.dataset.theme);
      if (theme !== "light") throw new Error("light theme contract not applied: " + theme);
      const order = await page.evaluate(() => {
        const r = document.querySelector(".meet-participants");
        const chat = document.querySelector(".chatscroll");
        if (!r || !chat) return null;
        const rb = r.getBoundingClientRect();
        const cb = chat.getBoundingClientRect();
        return { railTop: rb.top, chatTop: cb.top, railAboveChat: rb.top < cb.top, sticky: getComputedStyle(r).position };
      });
      if (!order) throw new Error("rail or message flow missing");
      if (!order.railAboveChat) throw new Error("rail does not precede message flow (light 390)");
      if (order.sticky !== "sticky") throw new Error("rail must stick (light 390), got: " + order.sticky);
      await settleVisual(page);
      try { await assertNoHOverflow(page, "390 light"); }
      catch (e) { throw new Error(String((e && e.message) || e)); }
      await page.screenshot({ path: shotPath("presence-390-light.png"), fullPage: true });
      const toolbar = page.getByRole("button", { name: "Meeting settings" });
      await assertTapVisible(page, toolbar, "toolbar settings (390 light)");
      const composer = page.getByLabel(/Message\. Press Enter/);
      await assertTapVisible(page, composer, "composer (390 light)");
      await assertTapFocus(page, composer, "composer (390 light)");
      await composer.fill("viewport probe");
      if ((await composer.inputValue()) !== "viewport probe") throw new Error("composer input lost (390 light)");
      const msg = page.locator(".msg-row .btext").first();
      if ((await msg.count()) === 0) throw new Error("no rendered message to scroll (390 light)");
      await assertTapVisible(page, msg, "first message (390 light)");
      const msgText = ((await msg.innerText().catch(() => "")) || "").trim();
      if (msgText.length < 1) throw new Error("first message has no readable text (390 light)");
      await toolbar.click();
      await page.getByRole("dialog").waitFor({ timeout: 15000 });
      await settleVisual(page);
      await assertDialogOpaque(page, "390 light");
      await page.screenshot({ path: shotPath("settings-390-light.png"), fullPage: true });
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached", timeout: 15000 });
      return "390px light: rail first+sticky, toolbar+composer+message geometry+tap, settings opaque, shots/presence-390-light.png + shots/settings-390-light.png";
    } finally { await v.ctx.close().catch(() => {}); }
  });

  await step("meet: only accepted portraits render; reject clears the rail image", async () => {
    const pctx = await browser.newContext();
    const page = await pctx.newPage();
    try {
    await page.goto(WEBURL + "/#/roster", { waitUntil: "domcontentloaded" });
    const acct = await page.evaluate(() => { try { return localStorage.getItem("simceo-account") || ""; } catch { return ""; } });
    if (!acct) throw new Error("browser account id missing for roster-scoped probe");
    const entry = await api("POST", "/api/roster/quick", { accountId: acct, name: "Portrait Probe", description: "A probe face for acceptance gating.", tags: "" });
    const gen = await api("POST", "/api/roster/" + entry.id + "/image/generate", { count: 1 });
    const gi = gen.images || gen.created || gen;
    const gl = Array.isArray(gi) ? gi : (gi.images || []);
    const imgId = (gl[0] && (gl[0].id || gl[0])) || (await api("GET", "/api/roster/" + entry.id + "/images"))[0].id;
    const copy = await api("POST", "/api/roster/" + entry.id + "/copy", { boardId: setup.boardId, role: "Portrait Probe" });
    const probeAdv = copy.id || (copy.advisor && copy.advisor.id);
    const probeEntryId = entry.id;
    await api("POST", "/api/images/" + imgId + "/select", { boardAdvisorId: probeAdv });
    await page.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
    const rail = page.getByRole("region", { name: "Meeting participants" });
    await rail.getByText("Strategist").first().waitFor({ timeout: 15000 });
    const seat = rail.locator(".mp-seat", { hasText: "Portrait Probe" });
    try { await seat.waitFor({ timeout: 15000 }); }
    catch (e) {
      let advs = "?";
      try { const al = await api("GET", "/api/boards/" + setup.boardId + "/advisors"); advs = al.map((a) => (a.boardRole || "?") + ":" + (a.approved ? "ok" : "pend")).join(","); } catch (se) { advs = "GET-err:" + String(se).slice(0, 120); }
      const rt = await rail.innerText().catch(() => "(no rail)");
      throw new Error("probe seat missing; board advisors=[" + advs.slice(0, 300) + "] rail=" + rt.slice(0, 300));
    }
    await rail.locator(".mp-seat", { hasText: "Strategist" }).locator("img").first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(3000);
    if ((await seat.locator("img").count()) !== 0) throw new Error("pending selected portrait rendered before acceptance");
    if ((await seat.getByText("Needs approval", { exact: true }).count()) === 0) throw new Error("unapproved seat missing Needs approval");
    // Same-document review flow: no page.reload() anywhere below. Hash hops
    // stay in the same document (marker-guarded); the rail must re-resolve
    // acceptedness from fresh image metadata on each return to the meeting.
    const meetHash = "#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA;
    await page.evaluate(() => { try { window.__qaSameDoc = 1; } catch {} });
    const sameDocHash = async (hash) => {
      await page.evaluate((h) => { window.location.hash = h; }, hash);
      await page.waitForTimeout(900);
      const same = await page.evaluate(() => { try { return window.__qaSameDoc === 1; } catch { return false; } });
      if (!same) throw new Error("document reloaded during same-page portrait flow");
    };
    await api("POST", "/api/images/" + imgId + "/review", { decision: "accept" });
    await sameDocHash("#/roster");
    await sameDocHash(meetHash);
    await rail.getByText("Strategist").first().waitFor({ timeout: 15000 });
    await seat.locator("img").first().waitFor({ timeout: 20000 });
    if ((await seat.locator("img").count()) !== 1) {
      let advs = "?"; let imgs = "?";
      try { const al = await api("GET", "/api/boards/" + setup.boardId + "/advisors"); const pa = al.find((a) => String(a.boardRole) === "Portrait Probe"); advs = pa ? ("keys=" + Object.keys(pa).join(",") + " reid=" + pa.rosterEntryId + " prov=" + pa.imageProvenance + " approved=" + pa.approved) : "probe-absent:" + al.map((a) => a.boardRole).join(","); } catch (se) { advs = "GET-err:" + String(se).slice(0, 100); }
      try { const il = await api("GET", "/api/roster/" + probeEntryId + "/images"); imgs = il.map((im) => String(im.id).slice(0, 8) + ":" + im.review).join(","); } catch (se) { imgs = "GET-err:" + String(se).slice(0, 100); }
      let blob = "?";
      try { blob = JSON.stringify(await page.evaluate(async (id) => { const x = await fetch("/api/images/" + id); const buf = await x.arrayBuffer(); return { s: x.status, ct: x.headers.get("content-type"), n: buf.byteLength }; }, imgId)); } catch (be) { blob = "fetch-err:" + String(be).slice(0, 120); }
      throw new Error("accepted portrait did not load; advisor=" + advs + " images=" + imgs + " blob=" + blob);
    }
    const ok = await seat.locator("img").evaluate((el) => el.complete && el.naturalWidth > 0);
    if (!ok) throw new Error("accepted portrait image failed to decode");
    await api("POST", "/api/images/" + imgId + "/review", { decision: "retry" });
    await sameDocHash("#/roster");
    await sameDocHash(meetHash);
    await rail.getByText("Strategist").first().waitFor({ timeout: 15000 });
    await rail.locator(".mp-seat", { hasText: "Strategist" }).locator("img").first().waitFor({ timeout: 20000 });
    await page.waitForFunction(() => { const seats = Array.from(document.querySelectorAll(".mp-seat")); const s = seats.find((x) => (x.textContent || "").indexOf("Portrait Probe") >= 0); return !!s && s.querySelectorAll("img").length === 0; }, { timeout: 20000 });
    if ((await seat.locator("img").count()) !== 0) throw new Error("rejected portrait still rendered after review change");
    if ((await seat.getByText("Needs approval", { exact: true }).count()) === 0) throw new Error("seat lost Needs approval after reject");
    // Supported in-app flow: accept through the roster review UI (bumps the
    // presence review generation), then back to the meeting with no reload.
    await sameDocHash("#/roster");
    await page.locator(".lprow-name", { hasText: "Portrait Probe" }).first().click();
    await page.getByRole("button", { name: "Accept portrait" }).first().click();
    await page.waitForTimeout(2500);
    await sameDocHash(meetHash);
    await seat.locator("img").first().waitFor({ timeout: 20000 });
    const ok2 = await seat.locator("img").evaluate((el) => el.complete && el.naturalWidth > 0);
    if (!ok2) throw new Error("in-app accepted portrait image failed to decode");
    return "pending never renders; accept/reject/re-accept resolve same-page without reload";
    } finally { await pctx.close().catch(() => {}); }
  });

  await step("meet: external rejection clears a mounted portrait without reload", async () => {
    const ctx = await browser.newContext();
    const pageA = await ctx.newPage();
    const pageB = await ctx.newPage();
    try {
      await pageA.goto(WEBURL + "/#/roster", { waitUntil: "domcontentloaded" });
      const acct = await pageA.evaluate(() => { try { return localStorage.getItem("simceo-account") || ""; } catch { return ""; } });
      if (!acct) throw new Error("browser account id missing for two-tab probe");
      const entry = await api("POST", "/api/roster/quick", { accountId: acct, name: "TwoTab Probe", description: "Two-tab rejection probe.", tags: "" });
      const gen = await api("POST", "/api/roster/" + entry.id + "/image/generate", { count: 1 });
      const gi = gen.images || gen.created || gen;
      const gl = Array.isArray(gi) ? gi : (gi.images || []);
      const imgId = (gl[0] && (gl[0].id || gl[0])) || (await api("GET", "/api/roster/" + entry.id + "/images"))[0].id;
      const copy = await api("POST", "/api/roster/" + entry.id + "/copy", { boardId: setup.boardId, role: "TwoTab Probe" });
      const probeAdv = copy.id || (copy.advisor && copy.advisor.id);
      await api("POST", "/api/images/" + imgId + "/select", { boardAdvisorId: probeAdv });
      await api("POST", "/api/images/" + imgId + "/review", { decision: "accept" });
      await pageA.goto(WEBURL + "/#/meet?board=" + setup.boardId + "&meeting=" + setup.meetingA, { waitUntil: "domcontentloaded" });
      const railA = pageA.getByRole("region", { name: "Meeting participants" });
      await railA.getByText("Strategist").first().waitFor({ timeout: 15000 });
      const seatA = railA.locator(".mp-seat", { hasText: "TwoTab Probe" });
      await seatA.waitFor({ timeout: 15000 });
      await seatA.locator("img").first().waitFor({ timeout: 20000 });
      const oldSrc = await seatA.locator("img").evaluate((el) => el.src);
      if (!oldSrc || oldSrc.indexOf("blob:") !== 0) throw new Error("expected blob portrait in A, got: " + String(oldSrc).slice(0, 80));
      await pageA.evaluate(() => { try { window.__qaSameDoc = 1; } catch {} });
      await pageB.goto(WEBURL + "/#/roster", { waitUntil: "domcontentloaded" });
      await api("POST", "/api/images/" + imgId + "/review", { decision: "retry" });
      try { await pageA.bringToFront(); } catch {}
      await pageA.evaluate(() => { try { window.dispatchEvent(new Event("focus")); } catch {} try { document.dispatchEvent(new Event("visibilitychange")); } catch {} });
      await pageA.waitForFunction(() => {
        const seats = Array.from(document.querySelectorAll(".mp-seat"));
        const s = seats.find((x) => (x.textContent || "").indexOf("TwoTab Probe") >= 0);
        return !!s && s.querySelectorAll("img").length === 0;
      }, { timeout: 20000 });
      const same = await pageA.evaluate(() => { try { return window.__qaSameDoc === 1; } catch { return false; } });
      if (!same) throw new Error("document reloaded during two-tab rejection flow");
      const afterCount = await seatA.locator("img").count();
      if (afterCount !== 0) throw new Error("rejected blob survived in mounted meeting (old=" + String(oldSrc).slice(0, 40) + ")");
      const stillOld = await pageA.evaluate((old) => {
        const imgs = Array.from(document.querySelectorAll(".mp-seat img"));
        return imgs.some((im) => im.src === old);
      }, oldSrc);
      if (stillOld) throw new Error("old blob URL still present after external rejection");
      if ((await seatA.getByText("Needs approval", { exact: true }).count()) === 0) throw new Error("seat lost Needs approval after external reject");
      return "two-tab reject clears mounted blob without reload, fallback kept";
    } finally { await ctx.close().catch(() => {}); }
  });

  await step("roster: bearer A and B on one browser keep drafts private per identity", async () => {
    const emailA = "qa.a@example.com";
    const emailB = "qa.b@example.com";
    const pw = "TestPassword123!";
    const regA = await api("POST", "/api/auth/register", { email: emailA, password: pw });
    const regB = await api("POST", "/api/auth/register", { email: emailB, password: pw });
    if (!regA.token || !regB.token) throw new Error("registration did not issue bearer sessions");
    const authFetch = async (token, method, p, body) => {
      const r = await fetch(API + p, { method, headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      if (!r.ok) throw new Error(r.status + " " + ((json && json.error) || text.slice(0, 160)));
      return json;
    };
    const entry = await authFetch(regA.token, "POST", "/api/roster/quick", { accountId: "00000000-0000-0000-0000-000000000000", name: "Bearer Entry", description: "Shared entry for identity-scoped draft proof.", tags: "" });
    const gen = await authFetch(regA.token, "POST", "/api/roster/" + entry.id + "/image/generate", { count: 1 });
    const gi = gen.images || gen.created || gen;
    const gl = Array.isArray(gi) ? gi : (gi.images || []);
    const imgId = (gl[0] && (gl[0].id || gl[0])) || (await authFetch(regA.token, "GET", "/api/roster/" + entry.id + "/images"))[0].id;
    await authFetch(regA.token, "POST", "/api/images/" + imgId + "/review", { decision: "accept" });
    const boardA = await authFetch(regA.token, "POST", "/api/boards", { name: "Bearer Board", mission: "identity proof" });
    const copy = await authFetch(regA.token, "POST", "/api/roster/" + entry.id + "/copy", { boardId: boardA.id, role: "Bearer Shared" });
    await authFetch(regA.token, "POST", "/api/boards/" + boardA.id + "/grants", { userKey: emailB, access: "read" });
    // NOTE: identity is applied with plain evaluate+reload, never
    // addInitScript: an init script would re-apply the first identity on
    // every later reload and make the same-browser switch untestable.
    const ctx = await browser.newContext();
    const applyIdentity = async (page, token, email) => {
      await page.evaluate(({ t, u }) => { try { localStorage.setItem("simceo-token", t); localStorage.setItem("simceo-user", u); } catch {} }, { t: token, u: email });
      await page.reload({ waitUntil: "domcontentloaded" });
    };
    try {
      const page = await ctx.newPage();
      await page.goto(WEBURL + "/#/roster", { waitUntil: "domcontentloaded" });
      await applyIdentity(page, regA.token, emailA);
      await page.locator(".lprow-name", { hasText: "Bearer Entry" }).click();
      const chat = page.locator("[data-roster-chat]");
      await chat.getByPlaceholder(/Ask .* directly/).fill("AAA-DRAFT-MARKER");
      const keysA = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.indexOf("roster-chat-draft:") === 0));
      const mineA = keysA.filter((k) => k.endsWith(":" + entry.id));
      if (mineA.length !== 1) throw new Error("expected exactly one draft key for the entry, saw: " + JSON.stringify(keysA));
      if (mineA[0] !== "roster-chat-draft:" + emailA + ":" + entry.id) throw new Error("draft key not scoped to effective identity: " + mineA[0]);
      const uuidA = await page.evaluate(() => { try { return localStorage.getItem("simceo-account") || ""; } catch { return ""; } });
      if (uuidA && mineA[0].indexOf(uuidA) >= 0) throw new Error("draft key uses the persistent browser UUID");
      if (mineA[0].indexOf(regA.token) >= 0 || mineA[0].indexOf(regB.token) >= 0) throw new Error("raw token material in storage key");
      await applyIdentity(page, regB.token, emailB);
      await page.locator(".lprow-name", { hasText: "Bearer Entry" }).click();
      const chatB = page.locator("[data-roster-chat]");
      const bVal = await chatB.getByPlaceholder(/Ask .* directly/).inputValue();
      if (bVal !== "") {
        const ls = await page.evaluate(() => ({ keys: Object.keys(localStorage).filter((k) => k.indexOf("roster-chat-draft:") === 0), tok: (localStorage.getItem("simceo-token") || "").slice(0, 8), usr: localStorage.getItem("simceo-user") || "" }));
        throw new Error("B loaded A's unsent draft: composer=" + JSON.stringify(bVal).slice(0, 80) + " storage=" + JSON.stringify(ls).slice(0, 300));
      }
      await chatB.getByPlaceholder(/Ask .* directly/).fill("BBB-DRAFT-MARKER");
      await applyIdentity(page, regA.token, emailA);
      await page.locator(".lprow-name", { hasText: "Bearer Entry" }).click();
      const chatA2 = page.locator("[data-roster-chat]");
      if ((await chatA2.getByPlaceholder(/Ask .* directly/).inputValue()) !== "AAA-DRAFT-MARKER") throw new Error("A's draft was not restored after B's session");
      const keysAll = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.indexOf("roster-chat-draft:") === 0));
      if (!keysAll.some((k) => k === "roster-chat-draft:" + emailA + ":" + entry.id)) throw new Error("A key missing");
      if (!keysAll.some((k) => k === "roster-chat-draft:" + emailB + ":" + entry.id)) throw new Error("B key missing");
      return "bearer A/B same browser: drafts isolated by identity, restored per identity";
    } finally { await ctx.close().catch(() => {}); }
  });

  if (results.steps.filter((x) => !x.skipped).length === 0) {
    results.pass = false;
    results.steps.push({ name: "harness", pass: false, ms: 0, error: "no scenarios executed (ONLY filter matched nothing)" });
  }
  const report = {
    startedAt: results.startedAt,
    skipped: results.skipped,
    finishedAt: new Date().toISOString(),
    pass: results.pass,
    steps: results.steps,
    stack: { api: "127.0.0.1:5181", web: "127.0.0.1:5191", fakeModel: "127.0.0.1:5259" },
  };
  fs.mkdirSync(PROOF_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROOF_DIR, "last-run.json"), JSON.stringify(report, null, 2));
  const ran = results.steps.filter((x) => !x.skipped);
  console.log("proof steps pass: " + ran.filter((x) => x.pass).length + "/" + ran.length + " (" + results.skipped + " skipped)");
  try { if (browser) await browser.close(); } catch {}
}

main().then(() => {
  stopOwned();
  process.exitCode = results.pass ? 0 : 1;
}).catch((e) => {
  try {
    results.steps.push({ name: "harness", pass: false, ms: 0, error: sanitize(String((e && e.message) || e)) });
    results.pass = false;
    fs.mkdirSync(PROOF_DIR, { recursive: true });
    fs.writeFileSync(path.join(PROOF_DIR, "last-run.json"), JSON.stringify(results, null, 2));
  } catch {}
  console.log("proof harness failed: " + String((e && e.message) || e).slice(0, 400));
  stopOwned();
  process.exitCode = 1;
});
