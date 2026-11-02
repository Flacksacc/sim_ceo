"use strict";
/* ============================================================================
 * Muse QA-only author.
 * NEW regression: qa/browser/wizard-progress.cjs (MAIN only).
 *
 * Closed P2 finding2: initial wizard hydration could undo Continue and
 * overwrite newly entered fields. Start with no saved wizard id, fill About,
 * click Continue (real UI click). The save persists the intended next step
 * explicitly while the UI advances locally; the delayed initial GET must not
 * rewind the step or clobber advisor input typed during the flight. Reload
 * must resume the correct persisted step + fields.
 *
 * FIXTURE-COMPONENT browser proof (NOT end-to-end API):
 *   - The REAL React app is loaded from the isolated Vite QA_WEB server
 *     (default http://127.0.0.1:5174). All DOM navigation, form state, and
 *     React Query behavior under test are the real app's.
 *   - HTTP is stubbed IN THIS FILE ONLY via page.route("**\/api\/**") with a
 *     small faithful wizard store: empty boards list, presets, wizard POST
 *     with strict version guards + SAVE_DELAY, wizard GET with GET_DELAY,
 *     wizard review, plus model-status/auth scaffolds. No new browser launch,
 *     no user-context reuse.
 *   - Other same-origin GET \/api\/** paths return a benign recorded scaffold
 *     (NON-ASSERTED, listed in the summary). Any non-GET to an unknown path
 *     is answered 501 and FAILS the run (no silent pretend writes, no
 *     unhandled-path silence).
 *   - No API-only proxy for the UI: every state change under test is driven
 *     by real rendered clicks/typing; fixture counters only record what the
 *     real app sent.
 *
 * Execution gate (DO NOT RUN until ALL hold):
 *   1. Fixed App (intended-step save + guarded hydration) is served on QA_WEB.
 *   2. QA stack (CDP :9333 + Vite :5174) is up.
 *   Until then: `node --check qa/browser/wizard-progress.cjs` ONLY.
 *
 * Runtime contract: own CDP context on :9333 (QA_CDP), CPU only, no new
 * browser launch, never close the shared remote browser (close own
 * page/context only). Bounded timeouts everywhere; any breach exits nonzero.
 * Screenshots/logs are optional diagnostics under .tmp/qa-browser-wizard/
 * (best effort; never fail the run). No fake passes, no skips.
 * ========================================================================== */

const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

/* ---------------- config (bounded, nonzero-exit) ---------------- */
const CDP = process.env.QA_CDP || "http://127.0.0.1:9333";
const WEB = process.env.QA_WEB || "http://127.0.0.1:5174";
const OUT = ".tmp/qa-browser-wizard";
const SAVE_DELAY = 1200; // delayed initial save response (opens the flight window)
const GET_DELAY = 1500; // delayed initial GET hydration (exposes stale overwrite)
const T = {
  goto: 60000,
  step: 20000,
  poll: 20000,
  overall: 240000,
};

/* ---------------- fixture data ---------------- */
const ABOUT = { name: "P2W Progress Board", mission: "progress mission", stage: "forming" };
const ROLE = "Finance reviewer";

const drafts = new Map(); // id -> draft row
let wizSeq = 0;
const counters = { posts: [], gets: 0, reviews: 0, conflicts: 0, scaffolded: [], unhandledWrite: [] };

function draftShape(d) {
  return {
    id: d.id,
    version: d.version,
    accountId: d.accountId,
    step: d.step,
    presetKey: d.presetKey,
    fieldsJson: d.fieldsJson,
    interviewJson: d.interviewJson || "{}",
    status: "Saved",
    updatedAt: new Date().toISOString(),
  };
}

function readJson(req) {
  try { return JSON.parse(req.postData() || "{}"); } catch { return {}; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fixtureFulfill(route) {
  const req = route.request();
  const method = req.method();
  const u = new URL(req.url());
  const p = u.pathname.replace(/\/+$/, "") || "/";
  const seg = p.split("/").filter(Boolean);
  const json = (status, obj) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });

  // Boards list: empty so the "Create your first board" entry renders.
  if (method === "GET" && p === "/api/boards") return json(200, []);
  // Presets: single strategy preset for the Starting shape select.
  if (method === "GET" && p === "/api/presets") {
    return json(200, [
      { key: "strategy", title: "Strategy", roles: [], question: "q", agenda: "a", deliverable: "d" },
    ]);
  }
  // Wizard review: minimal shape for the Review/guided cards.
  if (method === "GET" && seg.length === 4 && seg[0] === "api" && seg[1] === "wizard" && seg[3] === "review") {
    counters.reviews += 1;
    const d = drafts.get(seg[2]);
    if (!d) return json(404, { error: "wizard draft not found" });
    return json(200, { step: d.step, preset: d.presetKey, status: "Saved", blockers: [], fields: [] });
  }
  // Wizard save: faithful create + strict version guard, delayed.
  if (method === "POST" && p === "/api/wizard") {
    await sleep(SAVE_DELAY);
    const body = readJson(req);
    let id = typeof body.id === "string" && body.id ? body.id : "";
    let d = id ? drafts.get(id) : undefined;
    if (d) {
      const want = body.version;
      if (typeof want !== "number" || want !== d.version) {
        counters.conflicts += 1;
        return json(409, { error: "Stale wizard draft; refresh and re-apply your edit with the current version." });
      }
    } else {
      id = id || "wiz-" + (++wizSeq) + "-p2w";
      d = { id, version: 1, accountId: "", step: 1, presetKey: "", fieldsJson: "{}", interviewJson: "{}" };
    }
    d.accountId = typeof body.accountId === "string" ? body.accountId : d.accountId;
    if (typeof body.step === "number") d.step = body.step;
    if (typeof body.presetKey === "string") d.presetKey = body.presetKey;
    if (typeof body.fieldsJson === "string") d.fieldsJson = body.fieldsJson;
    d.version += 1;
    d.updatedAt = new Date().toISOString();
    drafts.set(id, d);
    counters.posts.push({ step: d.step, sentVersion: body.version, version: d.version, fieldsJson: d.fieldsJson });
    return json(200, draftShape(d));
  }
  // Wizard GET: delayed hydration.
  if (method === "GET" && seg.length === 3 && seg[0] === "api" && seg[1] === "wizard") {
    await sleep(GET_DELAY);
    counters.gets += 1;
    const d = drafts.get(seg[2]);
    return d ? json(200, draftShape(d)) : json(404, { error: "wizard draft not found" });
  }
  // Shell scaffolds so the app renders (NON-ASSERTED).
  if (method === "GET" && p === "/api/model/status") {
    counters.scaffolded.push(method + " " + p);
    return json(200, {
      configured: false, source: "", model: "fixture", chatOverride: "",
      keyHint: "", lastTestAt: null, lastTestOk: false,
      lastTestModel: "", lastTestError: "",
    });
  }
  if (method === "GET" && p === "/api/auth/me") {
    counters.scaffolded.push(method + " " + p);
    return json(200, { user: "", authenticated: false });
  }
  if (method === "GET") {
    counters.scaffolded.push(method + " " + p);
    return json(200, []);
  }
  counters.unhandledWrite.push(method + " " + p);
  return json(501, { error: "unhandled fixture path: " + method + " " + p });
}

/* ---------------- main ---------------- */
let pass = 0, fail = 0;
const failures = [];
const consoleIssues = [];
const hubsNotes = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
function watchdog() {
  console.log("TIMEOUT overall watchdog breached (" + T.overall + "ms)");
  process.exit(1);
}

(async () => {
  const timer = setTimeout(watchdog, T.overall);
  fs.mkdirSync(OUT, { recursive: true });
  let browser, ctx, page;
  async function shot(name) {
    try { await page.screenshot({ path: path.join(OUT, name + ".png") }); } catch { /* diagnostics only */ }
  }
  async function waitFor(fn, timeout) {
    const deadline = Date.now() + (timeout || T.poll);
    for (;;) {
      try { if (await fn()) return true; } catch { /* retry */ }
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  function wiz() { return page.locator('section[aria-label="New-board wizard"]'); }
  async function wizText() {
    return await wiz().innerText().catch(() => "");
  }

  try {
    browser = await chromium.connectOverCDP(CDP);
    ctx = await browser.newContext(); // own isolated context; never touches the user's context
    page = await ctx.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });

    page.on("console", (m) => {
      const type = m.type();
      if (type !== "error" && type !== "warning") return;
      consoleIssues.push(type + ": " + (m.text() || "").slice(0, 400));
    });
    page.on("pageerror", (e) => consoleIssues.push("pageerror: " + String((e && e.message) || e).slice(0, 400)));
    page.on("response", (r) => {
      try {
        const url = r.url();
        if (!url.includes("/api/")) return;
        if (r.status() < 400) return;
        consoleIssues.push("http-" + r.status() + ": " + r.method() + " " + url.slice(0, 200));
      } catch (err) { consoleIssues.push("response-hook: " + String(err).slice(0, 160)); }
    });
    page.on("requestfailed", (r) => {
      const url = r.url();
      if (/\/hubs\//.test(url) || url.startsWith("ws")) { hubsNotes.push("hubs-scaffold: " + url.slice(0, 160)); return; }
      if (!url.includes("/api/")) return;
      consoleIssues.push("requestfailed: " + url.slice(0, 200));
    });

    // Fixture HTTP layer for \/api\/** (in-file; page assets pass through untouched).
    await page.route("**/api/**", (route) => fixtureFulfill(route).catch((e) => {
      consoleIssues.push("fixture-hook: " + String(e).slice(0, 160));
      route.abort().catch(() => {});
    }));

    await page.goto(WEB, { waitUntil: "domcontentloaded", timeout: T.goto });
    await page.waitForFunction(() => document.body && document.body.innerText.length > 50, null, { timeout: T.step });
    ok("app-loads", true);

    // Fresh draft: no saved wizard id in this isolated context.
    const storedBefore = await page.evaluate(() => localStorage.getItem("simceo-wizard"));
    ok("no-saved-wizard-initial", !storedBefore, String(storedBefore).slice(0, 80));

    // Real UI: open the wizard from the Boards empty state.
    await page.getByRole("button", { name: "Create your first board", exact: true }).click({ timeout: T.step });
    await wiz().waitFor({ timeout: T.step });
    let text = await wizText();
    ok("wizard-open-step1", text.includes("What is this board about?"), text.slice(0, 160));
    ok("draft-unsaved-initial", text.includes("Draft not saved yet on this device."), text.slice(0, 160));

    // Real UI: fill About.
    const sec = wiz();
    await sec.getByLabel(/Board name/).fill(ABOUT.name, { timeout: T.step });
    await sec.getByLabel(/^Mission/).fill(ABOUT.mission, { timeout: T.step });
    await sec.getByLabel(/^Stage/).fill(ABOUT.stage, { timeout: T.step });
    ok("about-filled",
      (await sec.getByLabel(/Board name/).inputValue()) === ABOUT.name &&
      (await sec.getByLabel(/^Mission/).inputValue()) === ABOUT.mission,
      (await wizText()).slice(0, 200));

    // Real UI: Continue. The app advances locally while the delayed save persists step 2.
    const postsBefore = counters.posts.length;
    await sec.getByRole("button", { name: "Continue", exact: true }).click({ timeout: T.step });
    const advanced = await waitFor(async () => (await wizText()).includes("Who should be on the board?"), T.step);
    text = await wizText();
    ok("continue-advances-local", advanced && !text.includes("What is this board about?"), text.slice(0, 200));

    // Real UI during the save/GET flight: add an advisor seat.
    await sec.getByLabel(/^Role$/).fill(ROLE, { timeout: T.step });
    await sec.getByRole("button", { name: "Add seat", exact: true }).first().click({ timeout: T.step });
    const seatShown = await waitFor(async () => (await wizText()).includes(ROLE), T.step);
    ok("seat-added-during-flight", seatShown, (await wizText()).slice(0, 240));

    // Wait out the delayed save + delayed hydration, then verify no rewind/overwrite.
    const saved = await waitFor(async () => (await wizText()).includes("Draft saved on this device."), T.poll);
    ok("draft-saved-status", saved, (await wizText()).slice(0, 200));
    const hydrated = await waitFor(() => counters.gets >= 1, T.poll);
    ok("hydrate-landed", hydrated, "gets=" + counters.gets);
    await new Promise((r) => setTimeout(r, 800));
    text = await wizText();
    ok("no-rewind-after-hydrate",
      text.includes("Who should be on the board?") && !text.includes("What is this board about?"),
      text.slice(0, 240));
    ok("no-overwrite-after-hydrate", text.includes(ROLE), text.slice(0, 240));

    // Fixture proof: the real save persisted the intended next step explicitly.
    const first = counters.posts[postsBefore];
    let firstFields = {};
    try { firstFields = JSON.parse((first && first.fieldsJson) || "{}"); } catch { firstFields = {}; }
    ok("save-persisted-intended-step", !!first && first.step === 2, JSON.stringify(first && { step: first.step }).slice(0, 120));
    ok("save-create-had-no-version", !!first && first.sentVersion === undefined, JSON.stringify(first && { v: first.sentVersion }).slice(0, 120));
    ok("save-fields-have-about",
      firstFields.name === ABOUT.name && firstFields.mission === ABOUT.mission && firstFields.stage === ABOUT.stage,
      String((first && first.fieldsJson) || "").slice(0, 200));
    ok("no-conflict-on-initial-save", counters.conflicts === 0, "conflicts=" + counters.conflicts);

    // Real UI: Save draft persists the seat under the strict version guard.
    const v1 = first && first.version;
    await sec.getByRole("button", { name: "Save draft", exact: true }).click({ timeout: T.step });
    const secondDone = await waitFor(() => counters.posts.length >= postsBefore + 2, T.poll);
    ok("second-save-sent", secondDone, "posts=" + counters.posts.length);
    const second = counters.posts[postsBefore + 1];
    ok("version-guard-second-save", !!second && second.sentVersion === v1, JSON.stringify(second && { sent: second.sentVersion, v1 }).slice(0, 160));
    ok("second-save-persists-seat",
      !!second && String(second.fieldsJson || "").includes(ROLE) && second.step === 2,
      String((second && second.fieldsJson) || "").slice(0, 240));

    await shot("wizard-progress");
    // Reload: the draft must resume at the persisted step + fields.
    await page.reload({ waitUntil: "domcontentloaded", timeout: T.goto });
    await page.waitForFunction(() => document.body && document.body.innerText.length > 50, null, { timeout: T.step });
    if (!(await wiz().count())) {
      await page.getByRole("button", { name: "Create your first board", exact: true }).click({ timeout: T.step });
    }
    await wiz().waitFor({ timeout: T.step });
    const resumedStep = await waitFor(async () => (await wizText()).includes("Who should be on the board?"), T.poll);
    text = await wizText();
    ok("reload-resumes-step", resumedStep, text.slice(0, 240));
    ok("reload-resumes-seat", text.includes(ROLE), text.slice(0, 240));

    // Real UI: Back is local-only, so About can be verified without another save.
    await wiz().getByRole("button", { name: "Back", exact: true }).click({ timeout: T.step });
    await page.waitForFunction(() => {
      const s = document.querySelector('section[aria-label="New-board wizard"]');
      return s && s.innerText.includes("What is this board about?");
    }, null, { timeout: T.step });
    const backName = await wiz().getByLabel(/Board name/).inputValue().catch(() => "");
    const backMission = await wiz().getByLabel(/^Mission/).inputValue().catch(() => "");
    ok("reload-resumes-about", backName === ABOUT.name && backMission === ABOUT.mission,
      JSON.stringify({ backName, backMission }).slice(0, 200));

    // ---- Signal classifications ----
    ok("no-unhandled-writes", counters.unhandledWrite.length === 0, counters.unhandledWrite.slice(0, 5).join(" | "));
    ok("console-clean", consoleIssues.length === 0, consoleIssues.slice(0, 8).join(" || ").slice(0, 600));

    await shot("wizard-final");
    await page.close().catch(() => {});
    await ctx.close().catch(() => {}); // never close the shared remote browser
    clearTimeout(timer);
    const summary = {
      pass, fail, failures,
      consoleIssues: consoleIssues.slice(0, 20),
      hubsNotes,
      scaffolded: counters.scaffolded,
      gets: counters.gets,
      reviews: counters.reviews,
      conflicts: counters.conflicts,
      posts: counters.posts.map((x) => ({ step: x.step, sentVersion: x.sentVersion, version: x.version })),
    };
    fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
    if (fail !== 0) await shot("wizard-failure");
    console.log(fail === 0 ? "BROWSERQA-WIZARD PASS " + pass : "BROWSERQA-WIZARD DONE pass=" + pass + " fail=" + fail);
    for (const fl of failures) console.log(" - " + fl);
    for (const ci of summary.consoleIssues) console.log(" console: " + ci);
    console.log(" gets=" + counters.gets + " scaffolded=" + counters.scaffolded.length);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    try { if (page && !page.isClosed()) await page.screenshot({ path: path.join(OUT, "fatal.png") }); } catch { /* ignore */ }
    try { if (page && !page.isClosed()) await page.close(); } catch { /* ignore */ }
    try { if (ctx) await ctx.close(); } catch { /* ignore */ }
    clearTimeout(timer);
    console.log("BROWSERQA-WIZARD FATAL: " + ((e && e.message) || e));
    process.exit(1);
  }
})();
