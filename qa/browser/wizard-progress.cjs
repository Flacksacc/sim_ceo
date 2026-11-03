"use strict";
/* ============================================================================
 * Muse QA-only author.
 * NEW regression: qa/browser/wizard-progress.cjs (MAIN only).
 *
 * Closed P2 finding2 + parent-review regressions (1) sync-accept atomicity,
 * (2) interview field waits, (3) production interview/review contracts,
 * (4) isolated unsaved-input vs stale-version cases, plus the
 * getByLabel(/^Mission/) fatal (accessible names carry JSX padding
 * whitespace: all label regexes allow leading/trailing whitespace).
 *
 * Covered with REAL rendered UI clicks only:
 *   A. Atomic version-guard negative control (no browser needed): extracts
 *      the ACTUAL nextKnownWizVersion source between TEST-ANCHOR markers,
 *      strips only type annotations, and asserts same-tick batch v4-then-v3
 *      cannot commit v3, v4-then-v5 advances, other-draft identity adopts
 *      separately, and non-numeric input is ignored.
 *   B. Fast path + unsaved-input guard (About step, no step change yet):
 *      fill About, Continue (intended step 2 persisted, local advance, Save
 *      disabled while pending but typing/Add stay enabled), add seat R1
 *      during the save flight and seat R2 during the slow first GET flight,
 *      both UNSAVED: the current-version GET must be rejected by the dirty
 *      guards (not the version guard) with step 2 and both seats intact.
 *   C. Persist seats, Back to step 1, save (valid step-1 baseline), reload:
 *      resume shows step 1 + About (separate case, before any
 *      interview-driven step change).
 *   D. Stale-version case: Start interview (production start path: +1
 *      version, step recomputed to 3 for the missing lead) makes the next
 *      GET slow; Save during its flight; the stale GET (older version) is
 *      discarded entirely: local step stays 1, Mission intact, next send
 *      carries the fresh version (a downgrade would 409 + alert).
 *   E. Two successive REAL interview answers on the visible Mission step:
 *      each Send waits for actual field hydration (step-3 transition proves
 *      interview 1 applied; GET completion + Mission input value proves
 *      interview 2 applied after Back with no intermediate save), strict
 *      version chains, zero conflicts.
 *   F. Reload resumes step 3 + lead blocker + both turns + review; Back
 *      shows guided Mission; Continue to step 2 shows both seats; exactly
 *      one draft created; no dialogs; console clean.
 *
 * FIXTURE-COMPONENT browser proof (NOT end-to-end API):
 *   - The REAL React app is loaded from the isolated Vite QA_WEB server
 *     (default http://127.0.0.1:5174).
 *   - HTTP is stubbed IN THIS FILE ONLY via page.route("**\/api\/**") with a
 *     production-faithful wizard store: strict version guards, answer-path
 *     TWO version bumps (pending + completion) and start-path ONE bump,
 *     deterministic mission extract (mission = trimmed answer), step
 *     recomputed from real blockers (name/mission/advisors/lead), review
 *     returning real blockers + set/missing field states with Ready/Blocked
 *     status, GETs snapshotted at arrival (a delayed response carries
 *     request-time state). No model parsing is mirrored.
 *   - Other same-origin GET \/api\/** paths return a benign recorded scaffold
 *     (NON-ASSERTED). Any non-GET to an unknown path is answered 501 and
 *     FAILS the run. Dialogs (alerts) are recorded and must stay empty.
 *
 * Execution gate (DO NOT RUN until ALL hold):
 *   1. Fixed App (sync accept + split-step guard + pending-disable) on QA_WEB.
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
const SAVE_DELAY = 1200; // delayed save responses (opens flight windows)
const FIRST_GET_DELAY = 4500; // first hydration stays in flight for unsaved edits
const GET_DELAY = 3000; // later hydrations: slow enough to save before landing
const INTERVIEW_POST_DELAY = 200;
const T = {
  goto: 60000,
  step: 20000,
  poll: 25000,
  overall: 300000,
};

/* ---------------- fixture data ---------------- */
const ABOUT = { name: "P2W Progress Board", mission: "progress mission", stage: "forming" };
const R1 = "Finance reviewer";
const R2 = "People reviewer";
const A1 = "alpha scope note";
const A2 = "beta scope note";

const drafts = new Map(); // id -> draft row
let wizSeq = 0;
let getArrivals = 0;
const counters = { posts: [], iposts: [], gets: 0, reviews: 0, conflicts: 0, creations: 0, scaffolded: [], unhandledWrite: [], lastReview: null };

// Production-faithful blockers (WizardGuide.Blockers): name(1), mission(1),
// advisors(2), lead(3) with the production messages.
function blockersOf(ff) {
  const b = [];
  const adv = Array.isArray(ff.advisors) ? ff.advisors : [];
  const leadName = ff.lead && typeof ff.lead.name === "string" ? ff.lead.name : "";
  if (!ff.name || !String(ff.name).trim()) b.push({ field: "name", step: 1, message: "Give the board a name." });
  if (!ff.mission || !String(ff.mission).trim()) b.push({ field: "mission", step: 1, message: "Describe what the board is for." });
  if (adv.length === 0) b.push({ field: "advisors", step: 2, message: "Add at least one advisor." });
  if (adv.length > 10) b.push({ field: "advisors", step: 2, message: "A board holds at most ten advisors." });
  if (!leadName.trim()) b.push({ field: "lead", step: 3, message: "Tell us who leads the board." });
  return b;
}
// Production-faithful field states (WizardGuide.FieldStates): set/missing.
function fieldStatesOf(ff) {
  const adv = Array.isArray(ff.advisors) ? ff.advisors : [];
  const lead = (ff.lead && typeof ff.lead === "object") ? ff.lead : {};
  const set = (v) => (typeof v === "string" && v.trim() ? "set" : "missing");
  return [
    { field: "name", step: 1, status: set(ff.name) },
    { field: "mission", step: 1, status: set(ff.mission) },
    { field: "stage", step: 1, status: set(ff.stage) },
    { field: "advisors", step: 2, status: adv.length === 0 ? "missing" : "set" },
    { field: "leadName", step: 3, status: set(lead.name) },
    { field: "leadComm", step: 3, status: set(lead.commPrefs) },
  ];
}
function readFields(d) {
  try { return JSON.parse(d.fieldsJson || "{}"); } catch { return {}; }
}

function draftShape(d) {
  return {
    id: d.id,
    version: d.version,
    accountId: d.accountId,
    step: d.step,
    presetKey: d.presetKey,
    fieldsJson: d.fieldsJson,
    interviewJson: JSON.stringify({ turns: d.turns || [], checkpoints: [], pendingQuestion: d.pending || "" }),
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
  // Wizard review: production shape with real blockers + field states.
  if (method === "GET" && seg.length === 4 && seg[0] === "api" && seg[1] === "wizard" && seg[3] === "review") {
    counters.reviews += 1;
    const d = drafts.get(seg[2]);
    if (!d) return json(404, { error: "wizard draft not found" });
    const bl = blockersOf(readFields(d));
    const fl = fieldStatesOf(readFields(d));
    counters.lastReview = { blockers: bl, fields: fl };
    return json(200, { step: d.step, preset: d.presetKey, status: bl.length === 0 ? "Ready" : "Blocked", blockers: bl, fields: fl });
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
      counters.creations += 1;
      d = { id, version: 1, accountId: "", step: 1, presetKey: "", fieldsJson: "{}", turns: [], pending: "" };
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
  // Wizard interview: production contract without the model parser.
  // Entry version guard; start path (empty answer, no turns) bumps ONCE and
  // recomputes step; answer path bumps TWICE (pending + completion),
  // deterministically extracts mission = trimmed answer, recomputes step.
  if (method === "POST" && seg.length === 4 && seg[0] === "api" && seg[1] === "wizard" && seg[3] === "interview") {
    await sleep(INTERVIEW_POST_DELAY);
    const d = drafts.get(seg[2]);
    if (!d) return json(404, { error: "wizard draft not found" });
    const body = readJson(req);
    if (typeof body.version !== "number" || body.version !== d.version) {
      counters.conflicts += 1;
      return json(409, { error: "Stale wizard draft; refresh and re-apply your edit." });
    }
    const answer = typeof body.answer === "string" ? body.answer : "";
    const turns = Array.isArray(d.turns) ? d.turns : [];
    const applied = [];
    if (turns.length === 0 && !answer.trim()) {
      const q0 = d.pending || "What should the board focus on first?";
      const b0 = blockersOf(readFields(d));
      d.step = b0.length === 0 ? 4 : Math.min(...b0.map((x) => x.step));
      d.pending = q0;
      d.version += 1;
      d.updatedAt = new Date().toISOString();
      counters.iposts.push({ sentVersion: body.version, version: d.version, answer: "" });
      return json(200, { question: q0, analysis: "Starting the setup interview from the current draft.", applied, extractOk: true, extractError: null, pendingQuestion: q0, version: d.version, fields: fieldStatesOf(readFields(d)), blockers: b0, checkpoints: [], turns, done: b0.length === 0 });
    }
    const q = d.pending || "What should the board focus on first?";
    if (answer.trim()) {
      turns.push({ question: q, answer: answer.trim(), analysis: "noted", at: new Date().toISOString() });
      const f = readFields(d);
      f.mission = answer.trim().slice(0, 60);
      d.fieldsJson = JSON.stringify(f);
      applied.push("mission");
    }
    d.pending = "Follow-up " + (turns.length + 1);
    d.turns = turns;
    d.version += 1; // pending bump
    d.version += 1; // completion bump
    const after = blockersOf(readFields(d));
    d.step = after.length === 0 ? 4 : Math.min(...after.map((x) => x.step));
    d.updatedAt = new Date().toISOString();
    counters.iposts.push({ sentVersion: body.version, version: d.version, answer });
    return json(200, { question: d.pending, analysis: "noted", applied, extractOk: true, extractError: null, pendingQuestion: d.pending, version: d.version, fields: fieldStatesOf(readFields(d)), blockers: after, checkpoints: [], turns, done: after.length === 0 });
  }
  // Wizard GET: snapshot at arrival, then delay. The first hydration is slow
  // (unsaved-input window); later ones allow a save to land first (stale).
  if (method === "GET" && seg.length === 3 && seg[0] === "api" && seg[1] === "wizard") {
    const d = drafts.get(seg[2]);
    const snap = d ? draftShape(d) : null;
    const n = ++getArrivals;
    await sleep(n === 1 ? FIRST_GET_DELAY : GET_DELAY);
    counters.gets += 1;
    return snap ? json(200, snap) : json(404, { error: "wizard draft not found" });
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
const dialogs = [];
const hubsNotes = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
function watchdog() {
  console.log("TIMEOUT overall watchdog breached (" + T.overall + "ms)");
  process.exit(1);
}

// Section A: atomic version-guard negative control on the ACTUAL source.
// Extracts nextKnownWizVersion between TEST-ANCHOR markers in web/src/App.tsx,
// strips only type annotations, and asserts same-tick batch semantics.
function runAtomicVersionControl() {
  const src = fs.readFileSync("web/src/App.tsx", "utf8");
  const START = "// TEST-ANCHOR-START: nextKnownWizVersion";
  const END = "// TEST-ANCHOR-END: nextKnownWizVersion";
  const si = src.indexOf(START), ei = src.indexOf(END);
  ok("atomic-anchor-present", si >= 0 && ei > si, "markers=" + si + "/" + ei);
  if (!(si >= 0 && ei > si)) return false;
  let fnText = src.slice(si + START.length, ei);
  fnText = fnText
    .replace(/:\s*\{[^}]*\}/g, "")
    .replace(/:\s*string\b/g, "")
    .replace(/:\s*number\b/g, "");
  let fn = null;
  try {
    fn = new Function(fnText + "\nreturn nextKnownWizVersion;")();
  } catch (e) {
    ok("atomic-compiles", false, String((e && e.message) || e).slice(0, 200));
    return false;
  }
  ok("atomic-compiles", typeof fn === "function");
  if (typeof fn !== "function") return false;
  // Negative control: v4 then v3 in the SAME tick must not commit v3 and must
  // enqueue nothing for the stale response (identical reference back).
  const k0 = { id: "d", version: 2 };
  const k1 = fn(k0, "d", 4);
  const k2 = fn(k1, "d", 3);
  ok("atomic-batch-no-downgrade", !!k2 && k2.id === "d" && k2.version === 4, JSON.stringify(k2));
  ok("atomic-stale-no-enqueue", k2 === k1, "stale accept must return the identical store (no setState)");
  // Monotonic: v4 then v5 advances with a new store object.
  const k3 = fn(k2, "d", 5);
  ok("atomic-batch-advance", !!k3 && k3.version === 5 && k3 !== k2, JSON.stringify(k3));
  // Identity: another draft adopts its own version (no cross-draft carry).
  const k4 = fn(k3, "other", 1);
  ok("atomic-identity-separate", !!k4 && k4.id === "other" && k4.version === 1 && k4 !== k3, JSON.stringify(k4));
  // Non-numeric input is ignored.
  const k5 = fn(k4, "other", "x");
  ok("atomic-nonnumeric-ignored", k5 === k4, JSON.stringify(k5));
  return failures.length === 0;
}

(async () => {
  const timer = setTimeout(watchdog, T.overall);
  fs.mkdirSync(OUT, { recursive: true });

  if (!runAtomicVersionControl()) {
    console.log("BROWSERQA-WIZARD ATOMIC FAIL; skipping browser run");
    for (const fl of failures) console.log(" - " + fl);
    clearTimeout(timer);
    process.exit(1);
  }

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
    page.on("dialog", (d) => {
      dialogs.push((d.message() || "").slice(0, 200));
      d.dismiss().catch(() => {});
    });
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

    // Real UI: open the wizard from the Boards empty state (About step).
    await page.getByRole("button", { name: "Create your first board", exact: true }).click({ timeout: T.step });
    await wiz().waitFor({ timeout: T.step });
    let text = await wizText();
    ok("wizard-open-step1", text.includes("What is this board about?"), text.slice(0, 160));
    ok("draft-unsaved-initial", text.includes("Draft not saved yet on this device."), text.slice(0, 160));

    // Real UI: fill About (Mission input stays visible for the interview answers).
    const sec = wiz();
    await sec.getByLabel(/^\s*Board name\s*$/).fill(ABOUT.name, { timeout: T.step });
    await sec.getByLabel(/^\s*Mission\s*$/).fill(ABOUT.mission, { timeout: T.step });
    await sec.getByLabel(/^\s*Stage\s*$/).fill(ABOUT.stage, { timeout: T.step });
    ok("about-filled",
      (await sec.getByLabel(/^\s*Board name\s*$/).inputValue()) === ABOUT.name &&
      (await sec.getByLabel(/^\s*Mission\s*$/).inputValue()) === ABOUT.mission,
      (await wizText()).slice(0, 200));

    // Real UI: Continue persists the intended step explicitly while advancing
    // locally. Save disables while pending; typing/Add seat stay enabled.
    const postsBefore = counters.posts.length;
    await sec.getByRole("button", { name: "Continue", exact: true }).click({ timeout: T.step });
    const advanced = await waitFor(async () => (await wizText()).includes("Who should be on the board?"), T.step);
    text = await wizText();
    ok("continue-advances-local", advanced && !text.includes("What is this board about?"), text.slice(0, 200));
    ok("save-disabled-while-pending",
      await sec.getByRole("button", { name: "Save draft", exact: true }).isDisabled().catch(() => false));

    // Unsaved-input guard case: seat R1 typed during the save flight (before
    // the GET starts), seat R2 typed during the slow first GET flight. Both
    // stay UNSAVED: no second save before the GET lands, so the
    // current-version GET must be rejected by the dirty guards (not the
    // version guard).
    await sec.getByLabel(/^\s*Role\s*$/).fill(R1, { timeout: T.step });
    await sec.getByRole("button", { name: "Add seat", exact: true }).first().click({ timeout: T.step });
    const saved1 = await waitFor(async () => (await wizText()).includes("Draft saved on this device."), T.poll);
    ok("draft-saved-status", saved1, (await wizText()).slice(0, 200));
    await sec.getByLabel(/^\s*Role\s*$/).fill(R2, { timeout: T.step });
    await sec.getByRole("button", { name: "Add seat", exact: true }).first().click({ timeout: T.step });
    const seatsShown = await waitFor(async () => {
      const t = await wizText();
      return t.includes(R1) && t.includes(R2);
    }, T.step);
    ok("seats-added-unsaved", seatsShown, (await wizText()).slice(0, 240));
    const hydrated1 = await waitFor(() => counters.gets >= 1, T.poll);
    ok("hydrate1-landed", hydrated1, "gets=" + counters.gets);
    await new Promise((r) => setTimeout(r, 800));
    text = await wizText();
    ok("no-rewind-unsaved",
      text.includes("Who should be on the board?") && !text.includes("What is this board about?"),
      text.slice(0, 240));
    ok("no-overwrite-unsaved", text.includes(R1) && text.includes(R2), text.slice(0, 240));

    // Fixture proof: the Continue save persisted the intended step explicitly.
    const first = counters.posts[postsBefore];
    let firstFields = {};
    try { firstFields = JSON.parse((first && first.fieldsJson) || "{}"); } catch { firstFields = {}; }
    ok("save-persisted-intended-step", !!first && first.step === 2, JSON.stringify(first && { step: first.step }).slice(0, 120));
    ok("save-create-had-no-version", !!first && first.sentVersion === undefined, JSON.stringify(first && { v: first.sentVersion }).slice(0, 120));
    ok("save-fields-have-about",
      firstFields.name === ABOUT.name && firstFields.mission === ABOUT.mission && firstFields.stage === ABOUT.stage,
      String((first && first.fieldsJson) || "").slice(0, 200));

    // Persist the seats, Back to step 1 (local-only), save for a valid
    // step-1 baseline.
    await sec.getByRole("button", { name: "Save draft", exact: true }).click({ timeout: T.step });
    const secondDone = await waitFor(() => counters.posts.length >= postsBefore + 2, T.poll);
    ok("second-save-sent", secondDone, "posts=" + counters.posts.length);
    const second = counters.posts[postsBefore + 1];
    ok("version-guard-second-save", !!second && first && second.sentVersion === first.version,
      JSON.stringify(second && first && { sent: second.sentVersion, v1: first.version }).slice(0, 160));
    ok("second-save-persists-seats",
      !!second && String(second.fieldsJson || "").includes(R1) && String(second.fieldsJson || "").includes(R2) && second.step === 2,
      String((second && second.fieldsJson) || "").slice(0, 240));
    await wiz().getByRole("button", { name: "Back", exact: true }).click({ timeout: T.step });
    await page.waitForFunction(() => {
      const s = document.querySelector('section[aria-label="New-board wizard"]');
      return s && s.innerText.includes("What is this board about?");
    }, null, { timeout: T.step });
    await sec.getByRole("button", { name: "Save draft", exact: true }).click({ timeout: T.step });
    const thirdDone = await waitFor(() => counters.posts.length >= postsBefore + 3, T.poll);
    ok("third-save-step1-baseline", thirdDone, "posts=" + counters.posts.length);
    const third = counters.posts[postsBefore + 2];
    ok("version-guard-third-save", !!third && second && third.sentVersion === second.version && third.step === 1,
      JSON.stringify(third && second && { sent: third.sentVersion, v: second.version, step: third.step }).slice(0, 160));

    // Resume (separate case, before any interview-driven step change).
    // Fresh-resume sync: the default step-1 text renders before the persisted GET lands,
    // so readiness requires the persisted values + version-gated controls + GET completion.
    const getsBeforeResume = counters.gets;
    await page.reload({ waitUntil: "domcontentloaded", timeout: T.goto });
    await page.waitForFunction(() => document.body && document.body.innerText.length > 50, null, { timeout: T.step });
    if (!(await wiz().count())) {
      await page.getByRole("button", { name: "Create your first board", exact: true }).click({ timeout: T.step });
    }
    await wiz().waitFor({ timeout: T.step });
    // Resume controls are version-gated: while the persisted version loads the
    // mutating controls stay disabled and status must not claim a saved draft.
    // Capture the early gate, then wait for the actual persisted resume.
    const earlyResumeText = await wizText();
    const earlySaveDis = await wiz().getByRole("button", { name: "Save draft", exact: true }).isDisabled().catch(() => true);
    const earlyStartDis = await wiz().getByRole("button", { name: "Start interview", exact: true }).isDisabled().catch(() => true);
    const earlyAskDis = await wiz().getByRole("button", { name: /Ask the guide|Ask again|Guide is thinking/, exact: false }).isDisabled().catch(() => true);
    const earlyGated = earlyResumeText.includes("Loading saved draft") ? (earlySaveDis && earlyStartDis && earlyAskDis) : true;
    ok("resume-controls-not-premature", earlyGated, earlyResumeText.slice(0, 240));
    const resumedReady = await waitFor(async () => {
      const tx = await wizText();
      if (!tx.includes("What is this board about?")) return false;
      if (!tx.includes("Draft saved on this device.")) return false;
      const nm = await wiz().getByLabel(/^\s*Board name\s*$/).inputValue().catch(() => "@@");
      const ms = await wiz().getByLabel(/^\s*Mission\s*$/).inputValue().catch(() => "@@");
      if (nm !== ABOUT.name || ms !== ABOUT.mission) return false;
      const stDis = await wiz().getByRole("button", { name: "Start interview", exact: true }).isDisabled().catch(() => true);
      if (stDis) return false;
      const askDis = await wiz().getByRole("button", { name: /Ask the guide|Ask again|Guide is thinking/, exact: false }).isDisabled().catch(() => true);
      if (askDis) return false;
      return counters.gets >= getsBeforeResume + 1;
    }, T.poll);
    ok("reload-resumes-step1", resumedReady, (await wizText()).slice(0, 240));
    const reName = await wiz().getByLabel(/^\s*Board name\s*$/).inputValue().catch(() => "");
    const reMission = await wiz().getByLabel(/^\s*Mission\s*$/).inputValue().catch(() => "");
    ok("reload-resumes-about", reName === ABOUT.name && reMission === ABOUT.mission,
      JSON.stringify({ reName, reMission }).slice(0, 200));
    // Stale-version case: Start interview (production start path: +1 version,
    // step recomputed to 3 for the missing lead) makes the next GET slow;
    // Save during its flight; the stale GET (older version) is discarded
    // entirely: no step yank, no field touch, no version downgrade.
    await wiz().getByRole("button", { name: "Start interview", exact: true }).click({ timeout: T.step });
    const started = await waitFor(async () => (await wizText()).includes("Next question:"), T.poll);
    ok("interview-started", started, (await wizText()).slice(0, 240));
    const getsBeforeStale = counters.gets;
    await wiz().getByRole("button", { name: "Save draft", exact: true }).click({ timeout: T.step });
    const staleLanded = await waitFor(() => counters.gets >= getsBeforeStale + 1, T.poll);
    ok("stale-get-landed", staleLanded, "gets=" + counters.gets);
    await new Promise((r) => setTimeout(r, 800));
    text = await wizText();
    ok("no-yank-after-stale",
      text.includes("What is this board about?") && !text.includes("Who should be on the board?"),
      text.slice(0, 240));
    const saveFlight = counters.posts[counters.posts.length - 1];
    ok("no-mission-clobber-after-stale",
      (await wiz().getByLabel(/^\s*Mission\s*$/).inputValue().catch(() => "")) === ABOUT.mission,
      String((saveFlight && saveFlight.fieldsJson) || "").slice(0, 240));
    const iStart = counters.iposts[0];
    ok("stale-save-version", !!saveFlight && !!iStart && saveFlight.sentVersion === iStart.version,
      JSON.stringify(saveFlight && iStart && { sent: saveFlight.sentVersion, v: iStart.version }).slice(0, 160));

    // Two successive REAL interview answers on the visible Mission step.
    // Interview 1: the local step moves 1 -> 3 in the SAME block as the field
    // write, so the step-3 transition proves field hydration (turns alone do
    // not). Then Back (local-only) and read the Mission input value.
    await wiz().getByLabel(/^\s*Your answer\s*$/).fill(A1, { timeout: T.step });
    const getsBefore1 = counters.gets;
    await wiz().getByRole("button", { name: "Send answer", exact: true }).click({ timeout: T.step });
    const int1turns = await waitFor(async () => (await wizText()).includes(A1), T.poll);
    ok("interview-1-turns", int1turns, (await wizText()).slice(0, 300));
    const int1applied = await waitFor(async () => (await wizText()).includes("Who leads this board?"), T.poll);
    ok("interview-1-hydrated", int1applied && counters.gets >= getsBefore1 + 1, "gets=" + counters.gets);
    // Production Back is single-step: step 3 -> 2 -> 1 requires TWO clicks.
    await wiz().getByRole("button", { name: "Back", exact: true }).click({ timeout: T.step });
    const backTo2a = await waitFor(async () => (await wizText()).includes("Who should be on the board?"), T.poll);
    ok("interview-1-back-step2", backTo2a, (await wizText()).slice(0, 240));
    await wiz().getByRole("button", { name: "Back", exact: true }).click({ timeout: T.step });
    await page.waitForFunction(() => {
      const s = document.querySelector('section[aria-label="New-board wizard"]');
      return s && s.innerText.includes("What is this board about?");
    }, null, { timeout: T.step });
    const mission1ready = await waitFor(async () => (await wiz().getByLabel(/^\s*Mission\s*$/).inputValue().catch(() => "@@")) === A1, T.poll);
    const mission1 = await wiz().getByLabel(/^\s*Mission\s*$/).inputValue().catch(() => "");
    ok("interview-1-fields", mission1ready && mission1 === A1, JSON.stringify({ mission1 }).slice(0, 160));
    const ip1 = counters.iposts[1];
    ok("interview-1-version", !!ip1 && saveFlight && ip1.sentVersion === saveFlight.version,
      JSON.stringify(ip1 && saveFlight && { sent: ip1.sentVersion, v: saveFlight.version }).slice(0, 160));

    // Interview 2 with NO intermediate save: the baseline advanced by
    // interview 1 must let this hydration apply fields despite the Back
    // navigation (local step kept, fields applied).
    await wiz().getByLabel(/^\s*Your answer\s*$/).fill(A2, { timeout: T.step });
    const getsBefore2 = counters.gets;
    await wiz().getByRole("button", { name: "Send answer", exact: true }).click({ timeout: T.step });
    const int2turns = await waitFor(async () => (await wizText()).includes(A2), T.poll);
    ok("interview-2-turns", int2turns, (await wizText()).slice(0, 300));
    const int2hydrated = await waitFor(() => counters.gets >= getsBefore2 + 1, T.poll);
    ok("interview-2-hydrated", int2hydrated, "gets=" + counters.gets);
    // No Save between the two answers: wait for the actual second extract value.
    const mission2ready = await waitFor(async () => (await wiz().getByLabel(/^\s*Mission\s*$/).inputValue().catch(() => "@@")) === A2, T.poll);
    const mission2 = await wiz().getByLabel(/^\s*Mission\s*$/).inputValue().catch(() => "");
    ok("interview-2-fields", mission2ready && mission2 === A2, JSON.stringify({ mission2 }).slice(0, 160));
    const ip2 = counters.iposts[2];
    ok("interview-2-version-chain", !!ip2 && !!ip1 && ip2.sentVersion === ip1.version,
      JSON.stringify(ip2 && ip1 && { sent: ip2.sentVersion, v: ip1.version }).slice(0, 160));
    ok("no-conflict-saves-interviews", counters.conflicts === 0, "conflicts=" + counters.conflicts);

    await shot("wizard-progress");
    // Reload resumes the real progression: step 3 with the lead blocker.
    // Fresh-resume sync: wait for persisted GET completion, not just step text.
    const getsBeforeResume2 = counters.gets;
    await page.reload({ waitUntil: "domcontentloaded", timeout: T.goto });
    await page.waitForFunction(() => document.body && document.body.innerText.length > 50, null, { timeout: T.step });
    if (!(await wiz().count())) {
      await page.getByRole("button", { name: "Create your first board", exact: true }).click({ timeout: T.step });
    }
    await wiz().waitFor({ timeout: T.step });
    // Step 3 shows field states (leadName missing); the blocker text renders only in the step-4 Review card.
    // Assert the actual DOM field state and verify the blocker through the recorded fixture response.
    const resumed3 = await waitFor(async () => {
      const tx = await wizText();
      if (!tx.includes("Who leads this board?")) return false;
      if (!tx.includes(A1) || !tx.includes(A2)) return false;
      if (!(tx.includes("leadName") && tx.includes("missing"))) return false;
      return counters.gets >= getsBeforeResume2 + 1;
    }, T.poll);
    text = await wizText();
    ok("reload-resumes-step3", resumed3, text.slice(0, 240));
    ok("reload-resumes-lead-field", text.includes("leadName") && text.includes("missing"), text.slice(0, 400));
    const lastBl = (counters.lastReview && counters.lastReview.blockers) || [];
    ok("reload-resumes-lead-blocker", lastBl.some((b) => b.field === "lead" && String((b && b.message) || "").includes("who leads the board")), JSON.stringify(lastBl).slice(0, 300));
    ok("reload-resumes-turns", text.includes(A1) && text.includes(A2), text.slice(0, 300));
    ok("reload-resumes-review", text.includes("mission") && text.includes("set"), text.slice(0, 300));

    // Back (local-only) is single-step: step 3 -> 2 -> 1 requires TWO clicks.
    // Continue to step 2 then shows both seats.
    await wiz().getByRole("button", { name: "Back", exact: true }).click({ timeout: T.step });
    const backTo2b = await waitFor(async () => (await wizText()).includes("Who should be on the board?"), T.poll);
    ok("reload-back-step2", backTo2b, (await wizText()).slice(0, 240));
    await wiz().getByRole("button", { name: "Back", exact: true }).click({ timeout: T.step });
    await page.waitForFunction(() => {
      const s = document.querySelector('section[aria-label="New-board wizard"]');
      return s && s.innerText.includes("What is this board about?");
    }, null, { timeout: T.step });
    const backName = await wiz().getByLabel(/^\s*Board name\s*$/).inputValue().catch(() => "");
    const backMission = await wiz().getByLabel(/^\s*Mission\s*$/).inputValue().catch(() => "");
    ok("reload-resumes-about", backName === ABOUT.name && backMission === A2,
      JSON.stringify({ backName, backMission }).slice(0, 200));
    await wiz().getByRole("button", { name: "Continue", exact: true }).click({ timeout: T.step });
    const backStep2 = await waitFor(async () => (await wizText()).includes("Who should be on the board?"), T.poll);
    text = await wizText();
    ok("reload-resumes-seats", backStep2 && text.includes(R1) && text.includes(R2), text.slice(0, 240));

    // ---- Signal classifications ----
    ok("single-draft", counters.creations === 1, "creations=" + counters.creations);
    ok("no-unhandled-writes", counters.unhandledWrite.length === 0, counters.unhandledWrite.slice(0, 5).join(" | "));
    ok("no-dialogs", dialogs.length === 0, dialogs.slice(0, 5).join(" || ").slice(0, 300));
    ok("console-clean", consoleIssues.length === 0, consoleIssues.slice(0, 8).join(" || ").slice(0, 600));

    await shot("wizard-final");
    await page.close().catch(() => {});
    await ctx.close().catch(() => {}); // never close the shared remote browser
    clearTimeout(timer);
    const summary = {
      pass, fail, failures,
      consoleIssues: consoleIssues.slice(0, 20),
      dialogs: dialogs.slice(0, 10),
      hubsNotes,
      scaffolded: counters.scaffolded,
      gets: counters.gets,
      reviews: counters.reviews,
      conflicts: counters.conflicts,
      creations: counters.creations,
      posts: counters.posts.map((x) => ({ step: x.step, sentVersion: x.sentVersion, version: x.version })),
      iposts: counters.iposts.map((x) => ({ sentVersion: x.sentVersion, version: x.version })),
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
