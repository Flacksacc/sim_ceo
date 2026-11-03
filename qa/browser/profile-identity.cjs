"use strict";
/* ============================================================================
 * Muse QA-only author.
 * NEW regression: qa/browser/profile-identity.cjs (MAIN only).
 *
 * Closed P2 profile case: two boards A/B, BOTH with NO saved lead and NO
 * global lead. Type unsaved fields on A, switch to B via actual app
 * navigation (Boards list row click + Open profile click) and assert B's
 * form is empty (not A's draft). Save B's own fields and assert the actual
 * intercepted POST is scoped to B (/api/boards/<B>/lead) with B's data.
 * Switch back to A and assert A's fields (not B's). Save A; assert both
 * saved leads are v1 with own-board content. Same-board background refetch
 * must not clobber an unsaved typed value when identity is unchanged.
 *
 * FIXTURE-COMPONENT browser proof (NOT end-to-end API):
 *   - The REAL React app is loaded from the isolated Vite QA_WEB server
 *     (default http://127.0.0.1:5174). All DOM navigation, form state, and
 *     React Query behavior under test are the real app's.
 *   - HTTP is stubbed IN THIS FILE ONLY via page.route("**\/api\/**") with a
 *     small faithful store for: boards list/detail, board-lead GET (404 when
 *     missing) + POST echo with version guards, global lead GET (404), plus
 *     minimal Setup/Status shapes the Boards tab needs to render.
 *   - Other same-origin GET \/api\/** paths return a benign recorded scaffold
 *     (NON-ASSERTED, listed in the summary). Any non-GET to an unknown path
 *     is answered 501 and FAILS the run (no silent pretend writes, no
 *     unhandled-path silence).
 *   - The REAL backend lead-identity case (delayed-run discard, version
 *     guards against the disposable API) lives separately in
 *     qa/identity-boundary-regression.mjs and is NOT covered here.
 *   - If final qa/fixtures.cjs lands in MAIN via merge, a future (separate)
 *     change may rebase this file onto it; until then this file is
 *     self-contained and MUST NOT import ../fixtures.cjs.
 *
 * Execution gate (DO NOT RUN until ALL hold):
 *   1. Navigation merge landed: profile reachable at hash
 *      #/profile?board=<boardId> (asserted strictly as nav-hash-profile-board).
 *   2. Updated App (Boards/Profile/lead-scope behavior) is served on QA_WEB.
 *   Until then: `node --check qa/browser/profile-identity.cjs` ONLY.
 *
 * Runtime contract: own CDP context on :9333 (QA_CDP), CPU only, no new
 * browser launch, never close the shared remote browser (close own
 * page/context only). Bounded timeouts everywhere; any breach exits nonzero.
 * Screenshots/logs are optional diagnostics under .tmp/qa-browser-profile/
 * (best effort; never fail the run). No fake passes, no skips.
 * ========================================================================== */

const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

/* ---------------- config (bounded, nonzero-exit) ---------------- */
const CDP = process.env.QA_CDP || "http://127.0.0.1:9333";
const WEB = process.env.QA_WEB || "http://127.0.0.1:5174";
const OUT = ".tmp/qa-browser-profile";
const T = {
  goto: 60000,
  step: 20000, // per-assertion wait budget
  poll: 15000, // polling budget for store-driven conditions
  overall: 240000, // hard watchdog for the whole run
};
const BOARD_A = { id: "pc-board-a", name: "P2A Alpha Board", mission: "alpha mission", stage: "forming" };
const BOARD_B = { id: "pc-board-b", name: "P2B Beta Board", mission: "beta mission", stage: "forming" };
// Distinctive per-board typed values (cross-contamination detectors).
const DRAFT_A = { name: "Ada Alpha", roleLabel: "Founder", background: "alpha-bg-draft", familiarTopics: "alpha-fam", simplerTopics: "alpha-simp", commPrefs: "alpha-comm" };
const SAVE_B = { name: "Ben Beta", roleLabel: "CEO", background: "beta-bg-own", familiarTopics: "beta-fam", simplerTopics: "beta-simp", commPrefs: "beta-comm" };
const SAVE_A = { name: "Ada Alpha", roleLabel: "Founder", background: "alpha-bg-own", familiarTopics: "alpha-fam", simplerTopics: "alpha-simp", commPrefs: "alpha-comm" };
const DIRTY_BG = "alpha-bg-dirty-unsaved";

/* ---------------- tiny faithful fixture store (in-file) ---------------- */
const leads = new Map(); // boardId -> lead row
const counters = { leadGet: { [BOARD_A.id]: 0, [BOARD_B.id]: 0 }, posts: [], scaffolded: [], unhandledWrite: [] };

function leadRow(boardId, fields, version) {
  return {
    id: "lead-" + boardId,
    boardId,
    version,
    name: fields.name,
    roleLabel: fields.roleLabel,
    background: fields.background,
    familiarTopics: fields.familiarTopics,
    simplerTopics: fields.simplerTopics,
    commPrefs: fields.commPrefs,
    updatedAt: new Date().toISOString(),
    provenanceJson: "{}",
  };
}
function setupShape(board) {
  const lead = leads.get(board.id) || null;
  return {
    board: {
      id: board.id, name: board.name, mission: board.mission, stage: board.stage,
      activeConfig: true, leadProfileVersion: lead ? lead.version : 0,
      retainAudio: false, discussionPolicy: "balanced", dataUse: "demo",
    },
    draftJson: "{}",
    activeJson: "{}",
    draftHash: "fx-" + board.id,
    dirty: false,
    lead,
    advisors: { total: 0, approved: 0 },
  };
}
function statusShape(board) {
  const lead = leads.get(board.id) || null;
  return {
    board: board.id, active: true, dirty: false, name: true,
    lead: !!lead, leadVersion: lead ? lead.version : 0,
    advisors: { total: 0, approved: 0 }, meetings: { total: 0, active: 0 },
    sourcesPending: 0, jobsFailed: 0, policy: "balanced", retainAudio: false,
  };
}

function normApiPath(url) {
  const u = new URL(url);
  return u.pathname.replace(/\/+$/, "") || "/";
}

async function fixtureFulfill(route) {
  const req = route.request();
  const method = req.method();
  const p = normApiPath(req.url());
  const seg = p.split("/").filter(Boolean); // e.g. ["api","boards",id,"lead"]

  const json = (status, obj) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });

  // Boards list (faithful: exactly A + B).
  if (method === "GET" && p === "/api/boards") return json(200, [BOARD_A, BOARD_B]);
  // Board detail (faithful).
  if (method === "GET" && seg.length === 3 && seg[0] === "api" && seg[1] === "boards") {
    const b = [BOARD_A, BOARD_B].find((x) => x.id === seg[2]);
    return b ? json(200, b) : json(404, { error: "board not found" });
  }
  // Board-scoped advisors/meetings (faithful minimal: no advisors/meetings in this case).
  if (method === "GET" && seg.length === 4 && seg[0] === "api" && seg[1] === "boards" &&
      (seg[3] === "advisors" || seg[3] === "meetings")) {
    return json(200, []);
  }
  // Boards-tab setup/status (faithful minimal shapes mirroring App.tsx types).
  if (method === "GET" && seg.length === 4 && seg[0] === "api" && seg[1] === "boards" && seg[3] === "setup") {
    const b = [BOARD_A, BOARD_B].find((x) => x.id === seg[2]);
    return b ? json(200, setupShape(b)) : json(404, { error: "board not found" });
  }
  if (method === "GET" && seg.length === 4 && seg[0] === "api" && seg[1] === "boards" && seg[3] === "status") {
    const b = [BOARD_A, BOARD_B].find((x) => x.id === seg[2]);
    return b ? json(200, statusShape(b)) : json(404, { error: "board not found" });
  }
  // Board lead GET: 404 when missing (EXPECTED contract), echo when saved.
  if (method === "GET" && seg.length === 4 && seg[0] === "api" && seg[1] === "boards" && seg[3] === "lead") {
    counters.leadGet[seg[2]] = (counters.leadGet[seg[2]] || 0) + 1;
    const lead = leads.get(seg[2]);
    return lead ? json(200, lead) : json(404, { error: "no saved profile for board" });
  }
  // Board lead POST: echo + version guard (faithful).
  if (method === "POST" && seg.length === 4 && seg[0] === "api" && seg[1] === "boards" && seg[3] === "lead") {
    const bid = seg[2];
    if (bid !== BOARD_A.id && bid !== BOARD_B.id) return json(404, { error: "board not found" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch { body = {}; }
    counters.posts.push({ url: req.url(), boardId: bid, body });
    const current = leads.has(bid) ? leads.get(bid).version : 0;
    const sent = body.version === undefined || body.version === null ? 0 : Number(body.version);
    if (sent !== current) return json(409, { error: "lead version conflict" });
    const row = leadRow(bid, body, current + 1);
    leads.set(bid, row);
    return json(200, row);
  }
  // Global lead: absent in this case (EXPECTED 404 contract).
  if (p === "/api/lead") {
    if (method === "GET") return json(404, { error: "no global lead" });
    counters.posts.push({ url: req.url(), boardId: "<global>", body: req.postData() || "" });
    return json(501, { error: "global lead writes are out of scope for this case" });
  }
  // Model status: benign scaffold so the shell renders (NON-ASSERTED).
  if (method === "GET" && p === "/api/model/status") {
    counters.scaffolded.push(method + " " + p);
    return json(200, {
      configured: false, source: "", model: "fixture", chatOverride: "",
      keyHint: "", lastTestAt: null, lastTestOk: false,
      lastTestModel: "", lastTestError: "",
    });
  }
  // Benign scaffold for any other same-origin GET (NON-ASSERTED, recorded).
  if (method === "GET") {
    counters.scaffolded.push(method + " " + p);
    return json(200, []);
  }
  // Unknown writes: loud 501 + recorded for a hard failure (no pretend API).
  counters.unhandledWrite.push(method + " " + p);
  return json(501, { error: "unhandled fixture path: " + method + " " + p });
}

/* ---------------- console/network classification ----------------
 * ONLY the expected missing-profile GET-lead 404 is excused, by exact
 * resource/response correlation. Chromium generic console text
 * (Failed to load resource: ... 404) never contains the word lead, so the
 * classifier MUST NOT require /lead/i in console text and MUST NOT use a
 * count-pair fallback. Fail closed when console location is absent.
 * A generic 404 is excused ONLY when location.url itself is an exact lead
 * path AND that exact resource has a tracked GET 404 response. Responses
 * and console messages can arrive in either order, so lead-path consoles
 * are buffered and resolved to expected404s at signal time by exact-URL
 * key match. No blanket 404/console ignores. All other console
 * errors/warnings, pageerrors, and non-lead http/requestfaileds still fail.
 * Hubs WS traffic (if any) is out of fixture scope and recorded separately,
 * never silently ignored.
 */
function isLeadApiPath(urlOrPath) {
  try {
    const p = new URL(urlOrPath, "http://127.0.0.1").pathname.replace(/\/+$/, "") || "/";
    return /^\/api\/(boards\/[^/]+\/lead|lead)$/.test(p);
  } catch { return false; }
}
function isGenericFailedResource404(text) {
  return /Failed to load resource/i.test(text || "") && /404/.test(text || "");
}
function consoleLocationUrl(m) {
  try {
    if (typeof m.location === "function") {
      const loc = m.location();
      if (loc && loc.url) return loc.url;
    } else if (m && m.location && m.location.url) return m.location.url;
  } catch { /* fall through to empty */ }
  return "";
}
function lead404Key(urlOrPath, method) {
  try {
    const u = new URL(urlOrPath, "http://127.0.0.1");
    const p = u.pathname.replace(/\/+$/, "") || "/";
    return (method || "GET") + " " + u.origin + p + u.search;
  } catch { return ""; }
}

/* ---------------- main ---------------- */
let pass = 0, fail = 0;
const failures = [];
const consoleIssues = [];
const expected404s = [];
const hubsNotes = [];
const expectedLead404ResponseKeys = new Set();
const pendingLead404Consoles = [];
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
  // Reads the real Profile section: field values keyed by label first line + status lines.
  async function profileForm() {
    return await page.evaluate(() => {
      const sec = document.querySelector('section[aria-label="Profile"]');
      if (!sec) return null;
      const fields = {};
      sec.querySelectorAll("label").forEach((lab) => {
        const key = ((lab.innerText || "").split("\n")[0] || "").trim();
        const ctrl = lab.querySelector("input, select, textarea");
        if (key && ctrl) fields[key] = ctrl.value;
      });
      const status = Array.from(sec.querySelectorAll('p[role="status"]'))
        .map((p) => (p.innerText || "").trim()).filter(Boolean);
      return { fields, status };
    });
  }
  async function openProfile() {
    await page.getByRole("button", { name: "Open profile", exact: true }).click({ timeout: T.step });
    await page.locator('section[aria-label="Profile"]').waitFor({ timeout: T.step });
  }
  async function gotoBoardsAndPick(boardName) {
    await page.getByRole("button", { name: "Boards", exact: true }).click({ timeout: T.step });
    const row = page.locator('aside[aria-label="Boards"] button.lprow', { hasText: boardName });
    await row.first().waitFor({ timeout: T.step });
    await row.first().click({ timeout: T.step });
    await page.waitForFunction(
      (nm) => {
        const el = document.querySelector('aside[aria-label="Boards"] button.lprow.active .lprow-name');
        return el && el.textContent && el.textContent.includes(nm);
      },
      boardName, { timeout: T.step });
  }
  async function fillProfile(values) {
    const sec = page.locator('section[aria-label="Profile"]');
    await sec.getByLabel(/^\s*Name/).fill(values.name, { timeout: T.step });
    await sec.getByLabel(/^\s*Role label/).selectOption(values.roleLabel, { timeout: T.step });
    await sec.getByLabel(/^\s*Background/).fill(values.background, { timeout: T.step });
    await sec.getByLabel(/^\s*Subjects already familiar/).fill(values.familiarTopics, { timeout: T.step });
    await sec.getByLabel(/^\s*Subjects needing simpler/).fill(values.simplerTopics, { timeout: T.step });
    await sec.getByLabel(/^\s*Communication preferences/).fill(values.commPrefs, { timeout: T.step });
  }

  try {
    browser = await chromium.connectOverCDP(CDP);
    ctx = await browser.newContext(); // own isolated context; never touches the user's context
    page = await ctx.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      try { localStorage.setItem("simceo-fb-user-v2", "QA Profile"); } catch { /* ignore */ }
    });

    page.on("console", (m) => {
      const type = m.type();
      if (type !== "error" && type !== "warning") return;
      const text = (m.text() || "").slice(0, 400);
      if (isGenericFailedResource404(text)) {
        const locUrl = consoleLocationUrl(m);
        if (locUrl && isLeadApiPath(locUrl)) {
          pendingLead404Consoles.push({ text, locUrl });
          return; // buffered: resolved at signal time by exact tracked GET 404
        }
      }
      consoleIssues.push(type + ": " + text);
    });
    page.on("pageerror", (e) => consoleIssues.push("pageerror: " + String((e && e.message) || e).slice(0, 400)));
    page.on("response", (r) => {
      try {
        const url = r.url();
        if (!url.includes("/api/")) return;
        if (r.status() < 400) return;
        const req = r.request();
        if (req.method() === "GET" && r.status() === 404) {
          try {
            if (isLeadApiPath(new URL(url).pathname)) {
              expectedLead404ResponseKeys.add(lead404Key(url, req.method()));
              return; // candidate expected contract: resolved at signal time
            }
          } catch { /* fall through to issue */ }
        }
        consoleIssues.push("http-" + r.status() + ": " + req.method() + " " + url.slice(0, 200));
      } catch (err) { consoleIssues.push("response-hook: " + String(err).slice(0, 160)); }
    });
    page.on("requestfailed", (r) => {
      const url = r.url();
      if (/\/hubs\//.test(url) || url.startsWith("ws")) { hubsNotes.push("hubs-scaffold: " + url.slice(0, 160)); return; }
      if (!url.includes("/api/") && !/127\.0\.0\.1:5174\/?$/.test(url) && r.resourceType() === "document") {
        consoleIssues.push("requestfailed-document: " + url.slice(0, 200));
        return;
      }
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
    await page.locator('aside[aria-label="Boards"] button.lprow', { hasText: BOARD_A.name }).first().waitFor({ timeout: T.step });
    await page.locator('aside[aria-label="Boards"] button.lprow', { hasText: BOARD_B.name }).first().waitFor({ timeout: T.step });
    ok("boards-listed", true);

    // ---- Board A: no saved lead, type UNSAVED draft ----
    await gotoBoardsAndPick(BOARD_A.name);
    ok("select-board-A", true);
    await openProfile();
    await page.getByText(/No saved profile yet/).first().waitFor({ timeout: T.step });
    let f = await profileForm();
    ok("profile-A-empty-initial",
      !!f && f.fields["Name"] === "" && f.fields["Background"] === "" &&
      f.status.some((s) => /No saved profile yet/.test(s)),
      JSON.stringify(f && f.fields).slice(0, 200));
    await fillProfile(DRAFT_A);
    f = await profileForm();
    ok("draft-A-typed", !!f && f.fields["Name"] === DRAFT_A.name && f.fields["Background"] === DRAFT_A.background,
      JSON.stringify(f && f.fields).slice(0, 200));

    // ---- Switch to B via actual app navigation: B form must be empty, not A ----
    await gotoBoardsAndPick(BOARD_B.name);
    await openProfile();
    await page.getByText(/No saved profile yet/).first().waitFor({ timeout: T.step });
    f = await profileForm();
    ok("switch-B-form-empty",
      !!f && f.fields["Name"] === "" && f.fields["Background"] === "" &&
      f.fields["Subjects already familiar"] === "" && f.status.some((s) => /No saved profile yet/.test(s)),
      JSON.stringify(f && f.fields).slice(0, 240));

    // ---- Save B's own fields; assert actual request scope + payload ----
    const postsBeforeB = counters.posts.length;
    await fillProfile(SAVE_B);
    await page.locator('section[aria-label="Profile"]').getByRole("button", { name: "Save profile" }).click({ timeout: T.step });
    await page.getByText(/Saved version 1/).first().waitFor({ timeout: T.step });
    const bPosts = counters.posts.slice(postsBeforeB);
    ok("save-B-post-scoped",
      bPosts.length === 1 && bPosts[0].boardId === BOARD_B.id &&
      bPosts[0].body.name === SAVE_B.name && bPosts[0].body.background === SAVE_B.background &&
      bPosts[0].body.familiarTopics === SAVE_B.familiarTopics &&
      !counters.posts.slice(0, postsBeforeB).concat(bPosts).some((p) => p.boardId === BOARD_A.id),
      JSON.stringify(bPosts).slice(0, 300));
    const leadB = leads.get(BOARD_B.id);
    ok("save-B-v1-own-content",
      !!leadB && leadB.version === 1 && leadB.name === SAVE_B.name &&
      leadB.background === SAVE_B.background && leadB.boardId === BOARD_B.id,
      JSON.stringify(leadB).slice(0, 240));

    // ---- Switch to A via actual app navigation: A's fields, not B's ----
    await gotoBoardsAndPick(BOARD_A.name);
    await openProfile();
    await page.locator('section[aria-label="Profile"]').waitFor({ timeout: T.step });
    f = await profileForm();
    ok("switch-A-not-B",
      !!f && f.fields["Name"] !== SAVE_B.name && f.fields["Background"] !== SAVE_B.background &&
      f.status.some((s) => /No saved profile yet/.test(s)),
      JSON.stringify(f && f.fields).slice(0, 240));

    // ---- Save A; both leads end at v1 with own-board content ----
    const postsBeforeA = counters.posts.length;
    await fillProfile(SAVE_A);
    await page.locator('section[aria-label="Profile"]').getByRole("button", { name: "Save profile" }).click({ timeout: T.step });
    await page.getByText(/Saved version 1/).first().waitFor({ timeout: T.step });
    const aPosts = counters.posts.slice(postsBeforeA);
    ok("save-A-post-scoped",
      aPosts.length === 1 && aPosts[0].boardId === BOARD_A.id &&
      aPosts[0].body.name === SAVE_A.name && aPosts[0].body.background === SAVE_A.background,
      JSON.stringify(aPosts).slice(0, 300));
    const leadA = leads.get(BOARD_A.id);
    ok("save-A-v1-own-content",
      !!leadA && leadA.version === 1 && leadA.name === SAVE_A.name && leadA.boardId === BOARD_A.id,
      JSON.stringify(leadA).slice(0, 240));

    // Round-trip: B shows B's fields, A shows A's fields.
    await gotoBoardsAndPick(BOARD_B.name);
    await openProfile();
    await page.getByText(/Saved version 1/).first().waitFor({ timeout: T.step });
    f = await profileForm();
    ok("switch-B-own-fields",
      !!f && f.fields["Name"] === SAVE_B.name && f.fields["Background"] === SAVE_B.background &&
      f.fields["Role label for this board"] === SAVE_B.roleLabel,
      JSON.stringify(f && f.fields).slice(0, 240));
    await gotoBoardsAndPick(BOARD_A.name);
    await openProfile();
    await page.getByText(/Saved version 1/).first().waitFor({ timeout: T.step });
    f = await profileForm();
    ok("switch-A-own-fields",
      !!f && f.fields["Name"] === SAVE_A.name && f.fields["Background"] === SAVE_A.background &&
      f.fields["Role label for this board"] === SAVE_A.roleLabel,
      JSON.stringify(f && f.fields).slice(0, 240));
    ok("both-v1-same-version-own-content",
      leads.get(BOARD_A.id).version === 1 && leads.get(BOARD_B.id).version === 1 &&
      leads.get(BOARD_A.id).name !== leads.get(BOARD_B.id).name &&
      leads.get(BOARD_A.id).background !== leads.get(BOARD_B.id).background);
    ok("no-global-lead",
      !Array.from(counters.posts).some((p) => p.boardId === "<global>") &&
      !leads.has("<global>") && !leads.has("global"));

    // ---- Same-board background refetch must not clobber unsaved edits ----
    // (No page.reload: reload cannot preserve the draft. Tab away/back keeps
    // component state while the lead query re-enables + refetches; window
    // blur/focus additionally exercises focus refetch.)
    const bgBox = page.locator('section[aria-label="Profile"]').getByLabel(/^\s*Background/);
    await bgBox.fill(DIRTY_BG, { timeout: T.step });
    const getsBefore = counters.leadGet[BOARD_A.id] || 0;
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.getByRole("button", { name: "Boards", exact: true }).click({ timeout: T.step });
    await openProfile();
    const deadline = Date.now() + T.poll;
    while ((counters.leadGet[BOARD_A.id] || 0) <= getsBefore && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const getsAfter = counters.leadGet[BOARD_A.id] || 0;
    f = await profileForm();
    ok("refetch-keeps-unsaved",
      getsAfter > getsBefore && !!f && f.fields["Background"] === DIRTY_BG &&
      f.fields["Name"] === SAVE_A.name &&
      f.status.some((s) => /Saved version 1/.test(s)),
      "leadGET " + getsBefore + "->" + getsAfter + " fields=" + JSON.stringify(f && f.fields).slice(0, 200));

    // ---- Final combined navigation hash (requires nav merge) ----
    const hash = await page.evaluate(() => location.hash || "");
    ok("nav-hash-profile-board",
      new RegExp("#/profile\\?board=" + BOARD_A.id + "(?:&|$)").test(hash) ||
      new RegExp("#/profile[?&]board=" + BOARD_A.id).test(hash),
      "hash=" + JSON.stringify(hash) + " (requires nav merge serving #/profile?board=<id>)");

    // ---- Resolve buffered lead-404 consoles by exact tracked response ----
    for (const p of pendingLead404Consoles) {
      const k = lead404Key(p.locUrl, "GET");
      if (k && expectedLead404ResponseKeys.has(k)) expected404s.push(p.text);
      else consoleIssues.push("console: " + p.text + " @ " + String(p.locUrl).slice(0, 200));
    }
    pendingLead404Consoles.length = 0;
    // ---- Signal classifications ----
    ok("no-unhandled-writes", counters.unhandledWrite.length === 0, counters.unhandledWrite.slice(0, 5).join(" | "));
    ok("console-clean",
      consoleIssues.length === 0, consoleIssues.slice(0, 8).join(" || ").slice(0, 600));

    await shot("profile-final");
    await page.close().catch(() => {});
    await ctx.close().catch(() => {}); // never close the shared remote browser
    clearTimeout(timer);
    const summary = {
      pass, fail, failures,
      consoleIssues: consoleIssues.slice(0, 20),
      expectedLead404s: expected404s.length,
      hubsNotes,
      scaffolded: counters.scaffolded,
      leadGetCounts: counters.leadGet,
      posts: counters.posts.map((p) => ({ boardId: p.boardId, name: p.body && p.body.name, version: p.body && p.body.version })),
    };
    fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
    if (fail !== 0) await shot("profile-failure");
    console.log(fail === 0 ? "BROWSERQA-PROFILE PASS " + pass : "BROWSERQA-PROFILE DONE pass=" + pass + " fail=" + fail);
    for (const fl of failures) console.log(" - " + fl);
    for (const ci of summary.consoleIssues) console.log(" console: " + ci);
    console.log(" expected-lead-404s=" + expected404s.length + " scaffolded=" + counters.scaffolded.length);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    try { if (page && !page.isClosed()) await page.screenshot({ path: path.join(OUT, "fatal.png") }); } catch { /* ignore */ }
    try { if (page && !page.isClosed()) await page.close(); } catch { /* ignore */ }
    try { if (ctx) await ctx.close(); } catch { /* ignore */ }
    clearTimeout(timer);
    console.log("BROWSERQA-PROFILE FATAL: " + ((e && e.message) || e));
    process.exit(1);
  }
})();
