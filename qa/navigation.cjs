// qa/navigation.cjs - reproducible browser QA for app navigation repairs.
// Fixture mode (default): deterministic stateful page.route fixtures against the
// isolated worktree server; the user API on :5080 is never touched.
//   node qa/navigation.cjs [--base http://localhost:5175/] [--cdp http://localhost:9333]
// Live smoke (read-only navigation against the real backend via the same proxy):
//   node qa/navigation.cjs --live
// Env overrides: QA_BASE, CDP_URL, QA_SHOTS.
// Uses the EXISTING browser CDP (default http://localhost:9333) with an OWN
// context/page and never closes the user's browser (only our contexts close).
// Requires: playwright-core (see qa/package.json; `npm --prefix qa ci`).
// Exit 0 on success, 1 on any failure. Screenshots -> qa-adjacent .tmp/qa (git-ignored).
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const cdpArg = (process.argv.find((a) => a.startsWith("--cdp=")) || "").slice("--cdp=".length);
const CDP = process.env.CDP_URL || cdpArg || "http://localhost:9333";
const LIVE = process.argv.includes("--live");
const baseArg = (process.argv.find((a) => a.startsWith("--base=")) || "").slice("--base=".length);
const BASE = baseArg || process.env.QA_BASE || "http://localhost:5175/";
const SHOTDIR = process.env.QA_SHOTS || path.join(__dirname, "..", ".tmp", "qa");
fs.mkdirSync(SHOTDIR, { recursive: true });

let passed = 0, failed = 0;
const failures = [];
let shotN = 0;
async function check(page, name, cond) {
  let ok = false;
  try { ok = !!(await cond()); } catch (e) { ok = false; failures.push(name + " :: threw " + String(e).split("\n")[0]); }
  if (ok) { passed++; console.log("  ok - " + name); }
  else {
    failed++;
    console.log("  FAIL - " + name);
    if (!failures.some((f) => f.startsWith(name + " "))) failures.push(name);
    try {
      shotN++;
      if (page) await page.screenshot({ path: path.join(SHOTDIR, "fail-" + shotN + ".png") });
    } catch {}
  }
}
async function waitHash(page, want, timeout) {
  try {
    await page.waitForFunction((w) => window.location.hash === w, want, { timeout: timeout || 8000 });
    return true;
  } catch { return false; }
}
const hashOf = (page) => page.evaluate(() => window.location.hash);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const setDelay = (page, key, ms) => page.evaluate(([k, m]) => fetch("/api/__qa/delay?key=" + k + "&ms=" + m).then((r) => r.json()), [key, ms]);

const fixtures = require("./fixtures.cjs");
const { B1, B2, fixtureHandler } = fixtures;
async function desktopSuite(browser) {
  console.log("DESKTOP suite (fixture mode, 1440x1000)");
  const reqLog = [];
  const unhandled = [];
  const consoleErrs = [];
  const pageErrs = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    await ctx.route("**/api/**", fixtureHandler(reqLog, unhandled));
    await ctx.route("**/hubs/**", (r) => r.abort());
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error") consoleErrs.push(m.text().slice(0, 200)); });
    page.on("pageerror", (e) => pageErrs.push(String(e).slice(0, 200)));
    const rail = (name) => page.locator("nav.rail").getByRole("button", { name, exact: true });
    const section = (label) => page.locator('main section[aria-label="' + label + '"]');

    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await section("Boards").waitFor({ timeout: 15000 });
    await check(page, "boot canonical hash is #/boards", async () => (await hashOf(page)) === "#/boards");
    await check(page, "desktop boards has no horizontal overflow", () => noOverflow(page));
    await page.screenshot({ path: path.join(SHOTDIR, "shot-desktop-boards.png") });

    // select Alpha board from the sidebar list
    await page.locator(".listpanel-rows button", { hasText: "Alpha Board" }).click();
    await check(page, "sidebar board select writes hash board", async () => (await hashOf(page)).includes("board=b-alpha"));
    await check(page, "main shows open Alpha board", () => page.locator("main").getByText("Open board: Alpha Board").isVisible());

    // all 12 destinations reachable from the rail
    await rail("Meetings").click();
    await check(page, "rail Meetings hash", async () => (await hashOf(page)) === "#/meet?board=b-alpha");
    await rail("Sources").click();
    await check(page, "rail Sources hash", async () => (await hashOf(page)) === "#/sources?board=b-alpha");
    await rail("Records").click();
    await check(page, "rail Records section visible", () => section("Records").first().isVisible());
    await check(page, "rail Records exact hash (board kept, no stale rec)", async () => (await hashOf(page)) === "#/records?board=b-alpha");
    await rail("People").click();
    await check(page, "rail People hash", async () => (await hashOf(page)) === "#/people?board=b-alpha");
    await rail("Activity").click();
    await check(page, "rail Activity hash", async () => (await hashOf(page)) === "#/activity?board=b-alpha");
    await rail("Settings").click();
    await check(page, "rail Settings hash", async () => (await hashOf(page)) === "#/settings?board=b-alpha");
    await rail("Profile").click();
    await check(page, "rail Profile hash", async () => (await hashOf(page)) === "#/profile?board=b-alpha");
    await rail("Help").click();
    await check(page, "rail Help hash", async () => (await hashOf(page)) === "#/help?board=b-alpha");
    await rail("Roster").click();
    await check(page, "rail Roster hash", async () => (await hashOf(page)) === "#/roster?board=b-alpha");
    await rail("Board Advisors").click();
    await check(page, "rail Board Advisors hash", async () => (await hashOf(page)) === "#/advisors?board=b-alpha");

    // select a meeting from the main agenda, then every meeting view with EXACT hashes
    await rail("Meetings").click();
    await page.locator("ol.agenda button", { hasText: "Pricing move QA session" }).click();
    await check(page, "meeting select writes hash meeting", async () => (await hashOf(page)).includes("meeting=m-one"));
    await check(page, "meeting heading is selected meeting", () => page.locator('section[aria-label="Meetings and conversation"] h2', { hasText: "Pricing move QA session" }).isVisible());
    await page.screenshot({ path: path.join(SHOTDIR, "shot-desktop-meet.png") });
    const base2 = "#/meet?board=b-alpha&meeting=m-one";
    await check(page, "discussion view exact hash (mtab default omitted)", async () => (await hashOf(page)) === base2);
    await page.getByRole("tab", { name: "Key takeaways", exact: true }).click();
    await check(page, "takeaways view exact hash", async () => (await hashOf(page)) === base2 + "&mtab=takeaways");
    await page.getByRole("tab", { name: "Options", exact: true }).click();
    await check(page, "options view exact hash", async () => (await hashOf(page)) === base2 + "&mtab=options");
    await page.getByRole("tab", { name: "Decision", exact: true }).click();
    await check(page, "decision view exact hash", async () => (await hashOf(page)) === base2 + "&mtab=decision");
    await check(page, "meeting view Decision selected", () => page.getByRole("tab", { name: "Decision", exact: true }).getAttribute("aria-selected").then((v) => v === "true"));
    await page.getByRole("tab", { name: "Board members", exact: true }).click();
    await check(page, "members context exact hash", async () => (await hashOf(page)) === base2 + "&mtab=decision&ctab=members");
    await page.getByRole("tab", { name: "Context", exact: true }).click();
    await check(page, "context default omitted from hash", async () => (await hashOf(page)) === base2 + "&mtab=decision");
    await page.getByRole("tab", { name: "Decisions", exact: true }).click();
    await check(page, "decisions context exact hash", async () => (await hashOf(page)) === base2 + "&mtab=decision&ctab=decisions");
    await check(page, "desktop meet has no horizontal overflow", () => noOverflow(page));

    // OMITTED-FROM-WINDOW meeting: valid via scoped lookup, absent from the
    // unfiltered newest-200 list window. List absence must never clear it.
    let mark = reqLog.length;
    await page.goto(BASE + "#/meet?board=b-alpha&meeting=m-old", { waitUntil: "domcontentloaded" });
    await page.locator('section[aria-label="Meetings and conversation"] h2', { hasText: "Ancient pricing debate" }).waitFor({ timeout: 15000 });
    await check(page, "omitted meeting deep link keeps exact hash", async () => (await hashOf(page)) === "#/meet?board=b-alpha&meeting=m-old");
    await check(page, "omitted meeting heading uses authoritative detail", () => page.locator('section[aria-label="Meetings and conversation"] h2', { hasText: "Ancient pricing debate" }).isVisible());
    await check(page, "omitted meeting messages load (verified parent gates open)", () => page.getByText("Legacy hello from the archive").isVisible());
    await check(page, "scoped validation lookup fired for omitted meeting", async () => reqLog.slice(mark).some((u) => u.includes("/api/boards/b-alpha/meetings/m-old")));
    // the window list genuinely omits it: honesty probe on the raw endpoint
    await check(page, "window list omits m-old (cap simulation honest)", async () => page.evaluate(() => fetch("/api/boards/b-alpha/meetings").then((r) => r.json()).then((l) => Array.isArray(l) && !l.some((x) => x.id === "m-old"))));
    // search finds the older meeting (filtered search scans full history)
    await page.getByLabel("Search meetings").fill("legacy");
    await page.locator("ol.agenda button", { hasText: "Ancient pricing debate" }).waitFor({ timeout: 8000 });
    await check(page, "search surfaces omitted meeting", () => page.locator("ol.agenda button", { hasText: "Ancient pricing debate" }).isVisible());
    await page.locator("ol.agenda button", { hasText: "Ancient pricing debate" }).click();
    await check(page, "searched omitted meeting keeps hash", async () => (await hashOf(page)) === "#/meet?board=b-alpha&meeting=m-old");
    // a refresh that still lacks the entity must not clear it (delayed list)
    await setDelay(page, "meetings", 1500);
    await page.locator('summary:has-text("Meeting setup")').click();
    await page.getByRole("button", { name: "Save title + brief" }).click();
    await page.waitForTimeout(1200);
    await page.waitForTimeout(300);
    await check(page, "omitted meeting survives in-flight refresh", async () => (await hashOf(page)).includes("meeting=m-old"));
    await page.waitForTimeout(2000);
    await check(page, "omitted meeting survives resolved window refresh", async () => (await hashOf(page)) === "#/meet?board=b-alpha&meeting=m-old");
    await check(page, "omitted meeting heading still authoritative", () => page.locator('section[aria-label="Meetings and conversation"] h2', { hasText: "Ancient pricing debate" }).isVisible());
    await page.getByLabel("Search meetings").fill("");

    // create -> navigate: the new meeting must survive cache refresh (regression)
    await page.goto(BASE + "#/meet?board=b-alpha", { waitUntil: "domcontentloaded" });
    await page.locator("ol.agenda button", { hasText: "Pricing move QA session" }).waitFor({ timeout: 15000 });
    await setDelay(page, "meetings", 1200);
    await page.getByRole("button", { name: "Start meeting" }).click();
    await page.waitForFunction(() => /meeting=m-new-/.test(window.location.hash), null, { timeout: 8000 }).catch(() => {});
    await check(page, "created meeting navigates to m-new", async () => /meeting=m-new-/.test(await hashOf(page)));
    const createdHash = await hashOf(page);
    await page.waitForTimeout(400);
    await check(page, "created meeting not cleared during delayed refresh", async () => (await hashOf(page)) === createdHash);
    await page.waitForTimeout(1800);
    await check(page, "created meeting still selected after refresh resolves", async () => /meeting=m-new-/.test(await hashOf(page)));
    await check(page, "created meeting shows messages scope (no gating stall)", async () => reqLog.some((u) => /\/api\/meetings\/m-new-/.test(u) && u.includes("/messages")));

    // OMITTED-FROM-WINDOW board: valid via singular lookup, outside newest-100.
    mark = reqLog.length;
    await page.goto(BASE + "#/meet?board=b-old", { waitUntil: "domcontentloaded" });
    await page.locator(".listpanel-sub", { hasText: "Old Archive Board" }).waitFor({ timeout: 15000 });
    await check(page, "omitted board deep link keeps hash", async () => (await hashOf(page)) === "#/meet?board=b-old");
    await check(page, "omitted board heading uses detail, not list fallback", () => page.locator(".listpanel-sub", { hasText: "Old Archive Board" }).isVisible());
    await check(page, "singular board lookup fired for omitted board", async () => reqLog.slice(mark).some((u) => u === "GET /api/boards/b-old"));
    await check(page, "window boards list honestly omits b-old", async () => page.evaluate(() => fetch("/api/boards").then((r) => r.json()).then((l) => Array.isArray(l) && !l.some((x) => x.id === "b-old"))));
    await check(page, "omitted board gates open for its meetings", async () => reqLog.slice(mark).some((u) => u.includes("/api/boards/b-old/meetings")));

    // invalid ids: a scoped validation lookup is permitted, but no downstream
    // fetch for the stale id and no context leakage may follow.
    mark = reqLog.length;
    await page.goto(BASE + "#/meet?board=NOPE&meeting=NOPE", { waitUntil: "domcontentloaded" });
    await section("Boards").first().waitFor({ timeout: 15000 });
    await check(page, "bogus board id lands on Boards", async () => (await hashOf(page)) === "#/boards");
    await check(page, "bogus board validation lookup permitted", async () => reqLog.slice(mark).some((u) => u.includes("/api/boards/NOPE")));
    {
      const fresh = reqLog.slice(mark);
      await check(page, "no messages fetch for bogus meeting", async () => !fresh.some((u) => u.includes("/api/meetings/NOPE/")));
      await check(page, "no record fetch for bogus record", async () => !fresh.some((u) => u.includes("/api/records/NOPE")));
      await check(page, "no advisors fetch for bogus board", async () => !fresh.some((u) => u.includes("/api/boards/NOPE/advisors")));
      await check(page, "no usage fetch for bogus board", async () => !fresh.some((u) => u.includes("/api/usage") && u.includes("NOPE")));
    }
    mark = reqLog.length;
    await page.goto(BASE + "#/meet?board=b-beta&meeting=m-one", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !window.location.hash.includes("meeting="), null, { timeout: 8000 }).catch(() => {});
    await check(page, "mismatched meeting dropped, board kept", async () => { const h = await hashOf(page); return h.includes("board=b-beta") && !h.includes("meeting="); });
    await check(page, "scoped parent check fired for mismatch", async () => reqLog.slice(mark).some((u) => u.includes("/api/boards/b-beta/meetings/m-one")));
    await check(page, "no meeting fetch for mismatched id", async () => !reqLog.slice(mark).some((u) => u.includes("/api/meetings/m-one/")));
    mark = reqLog.length;
    await page.goto(BASE + "#/records?board=b-alpha&meeting=m-one&rec=NOPE-REC", { waitUntil: "domcontentloaded" });
    await section("Records").first().waitFor({ timeout: 15000 });
    await page.waitForFunction(() => !window.location.hash.includes("rec="), null, { timeout: 8000 }).catch(() => {});
    await check(page, "bogus record id is dropped from hash", async () => !(await hashOf(page)).includes("rec="));
    await check(page, "record validation lookup permitted", async () => reqLog.slice(mark).some((u) => u.includes("/api/records/NOPE-REC")));
    await check(page, "no downstream fetch for bogus record parent", async () => !reqLog.slice(mark).some((u) => u.includes("NOPE-REC") && !u.includes("/api/records/NOPE-REC")));

    // filtered meeting list keeps coherent detail
    await page.goto(BASE + "#/meet?board=b-alpha&meeting=m-one", { waitUntil: "domcontentloaded" });
    await page.locator('section[aria-label="Meetings and conversation"] h2', { hasText: "Pricing move QA session" }).waitFor({ timeout: 15000 });
    await page.getByLabel("Search meetings").fill("no-such-meeting-nav-audit");
    await page.getByText("No meetings match this filter").waitFor({ timeout: 8000 });
    await check(page, "filter shows honest empty state", () => page.getByText("No meetings match this filter").isVisible());
    await check(page, "heading stays on open meeting when filtered out", () => page.locator('section[aria-label="Meetings and conversation"] h2', { hasText: "Pricing move QA session" }).isVisible());
    await check(page, "messages stay visible when filtered out", () => page.getByText("Hello board").isVisible());
    await page.getByLabel("Search meetings").fill("");

    // OMITTED-FROM-WINDOW record: valid via singular lookup for its meeting,
    // absent from that meeting's newest-50 list window.
    await page.goto(BASE + "#/records?board=b-alpha&meeting=m-old&rec=r-old", { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /Review v3/ }).waitFor({ timeout: 15000 });
    await check(page, "omitted record deep link keeps exact hash", async () => (await hashOf(page)) === "#/records?board=b-alpha&meeting=m-old&rec=r-old");
    await check(page, "omitted record review opens from detail", () => page.getByRole("heading", { name: /Review v3/ }).isVisible());
    await check(page, "omitted record legacy item renders", () => page.getByText("Legacy item stands").isVisible());

    // record deep link + create-record + revise + compare-select lifecycle
    await page.goto(BASE + "#/records?board=b-alpha&meeting=m-one&rec=r-1", { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /Review v1/ }).waitFor({ timeout: 15000 });
    await check(page, "record deep link opens review", () => page.getByRole("heading", { name: /Review v1/ }).isVisible());
    await setDelay(page, "records", 1200);
    await page.getByRole("button", { name: "Prepare draft from items" }).click();
    await page.waitForFunction(() => /rec=r-new-/.test(window.location.hash), null, { timeout: 8000 }).catch(() => {});
    await check(page, "prepared draft navigates to r-new", async () => /rec=r-new-/.test(await hashOf(page)));
    await page.getByRole("heading", { name: /Review v1/ }).waitFor({ timeout: 15000 });
    await check(page, "prepared draft review renders", () => page.getByRole("heading", { name: /Review v1/ }).isVisible());
    const draftHash = await hashOf(page);
    await page.waitForTimeout(1800);
    await check(page, "prepared draft survives delayed records refresh", async () => (await hashOf(page)) === draftHash);
    await page.getByRole("button", { name: "Request revision (new version)" }).click();
    await page.getByRole("heading", { name: /Review v2/ }).waitFor({ timeout: 15000 });
    await check(page, "revision creates next version review", () => page.getByRole("heading", { name: /Review v2/ }).isVisible());
    await check(page, "revision hash carries new rec", async () => /rec=r-new-/.test(await hashOf(page)) && (await hashOf(page)) !== draftHash);
    const revHash = await hashOf(page);
    await page.locator('select').filter({ hasText: "pick" }).first().selectOption("r-2");
    await check(page, "compare select takes earlier version", () => page.locator("main section").getByText("Raise starter by $5").first().isVisible());
    await page.goto(BASE + "#/records?board=b-alpha&meeting=m-two", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !window.location.hash.includes("rec="), null, { timeout: 8000 }).catch(() => {});
    await check(page, "meeting switch drops record, board+meeting kept", async () => (await hashOf(page)) === "#/records?board=b-alpha&meeting=m-two");
    await check(page, "meeting switch clears compare selection", () => page.getByText("Review v", { exact: false }).isHidden().catch(() => true));
    await page.goBack();
    await check(page, "Back restores exact record hash", async () => (await hashOf(page)) === revHash);
    await page.getByRole("heading", { name: /Review v2/ }).waitFor({ timeout: 15000 });
    await check(page, "Back restores review without compare state", async () => (await page.locator('main select').first().inputValue()) === "");

    // message-search isolation: owned search state resets on board switch,
    // while a Back traversal restores the URL without resurrecting it
    await page.goto(BASE + "#/meet?board=b-alpha&meeting=m-one", { waitUntil: "domcontentloaded" });
    await page.locator('section[aria-label="Meetings and conversation"] h2', { hasText: "Pricing move QA session" }).waitFor({ timeout: 15000 });
    await page.locator('summary:has-text("Search this conversation")').click();
    const searchBox = page.locator('details:has-text("Search this conversation")');
    await searchBox.getByLabel("Search messages").fill("raise");
    await searchBox.getByRole("button", { name: "Search", exact: true }).click();
    await page.locator('details:has-text("Search this conversation")').getByText("Raise it.").waitFor({ timeout: 8000 });
    await check(page, "populated message search returns fixture hit", () => page.locator('details:has-text("Search this conversation")').getByText("Raise it.").isVisible());
    await rail("Boards").click();
    await page.locator(".listpanel-rows button", { hasText: "Beta Board" }).click();
    await check(page, "board switch drops meeting from hash", async () => { const h = await hashOf(page); return h.includes("board=b-beta") && !h.includes("meeting="); });
    await rail("Meetings").click();
    await check(page, "new board lists its own meetings", () => page.locator("ol.agenda button", { hasText: "Beta kickoff" }).isVisible());
    await check(page, "old board meeting not shown", () => page.locator("ol.agenda button", { hasText: "Pricing move QA session" }).isHidden());
    await page.locator("ol.agenda button", { hasText: "Beta kickoff" }).click();
    await check(page, "beta meeting select writes hash", async () => (await hashOf(page)) === "#/meet?board=b-beta&meeting=m-three");
    await check(page, "board switch clears message search text", () => page.getByLabel("Search messages").inputValue().then((v) => v === ""));
    await check(page, "board switch clears message search hits", () => page.locator('details:has-text("Search this conversation")').getByText("Raise it.").isHidden());
    await page.goBack();
    await waitHash(page, "#/meet?board=b-beta");
    await page.goBack();
    await waitHash(page, "#/boards?board=b-beta");
    await page.goBack();
    await waitHash(page, "#/boards?board=b-alpha&meeting=m-one");
    await page.goBack();
    await page.locator('section[aria-label="Meetings and conversation"] h2', { hasText: "Pricing move QA session" }).waitFor({ timeout: 15000 });
    await check(page, "Back after board switch restores prior meeting", () => page.locator('section[aria-label="Meetings and conversation"] h2', { hasText: "Pricing move QA session" }).isVisible());
    await check(page, "Back traversal does not resurrect search text", () => page.getByLabel("Search messages").inputValue().then((v) => v === ""));

    // exact-view Back: decision+decisions must restore precisely, not loosely
    await page.goto(BASE + "#/meet?board=b-alpha&meeting=m-one&mtab=decision&ctab=decisions", { waitUntil: "domcontentloaded" });
    await page.locator('section[aria-label="Meetings and conversation"] h2', { hasText: "Pricing move QA session" }).waitFor({ timeout: 15000 });
    await rail("Sources").click();
    await section("Resources and Inbox").first().waitFor();
    await page.goBack();
    await check(page, "Back restores exact decision+decisions hash", async () => (await hashOf(page)) === "#/meet?board=b-alpha&meeting=m-one&mtab=decision&ctab=decisions");
    await check(page, "Back restores decision tab selected", () => page.getByRole("tab", { name: "Decision", exact: true }).getAttribute("aria-selected").then((v) => v === "true"));
    await check(page, "Back restores decisions context selected", () => page.getByRole("tab", { name: "Decisions", exact: true }).getAttribute("aria-selected").then((v) => v === "true"));
    await page.goForward();
    await section("Resources and Inbox").first().waitFor({ timeout: 8000 });
    await check(page, "Forward restores Sources", () => section("Resources and Inbox").first().isVisible());

    // reload persistence incl. inspector context
    await page.goto(BASE + "#/meet?board=b-alpha&meeting=m-one&mtab=takeaways&ctab=members", { waitUntil: "domcontentloaded" });
    await page.locator('section[aria-label="Meetings and conversation"] h2', { hasText: "Pricing move QA session" }).waitFor({ timeout: 15000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('section[aria-label="Meetings and conversation"] h2', { hasText: "Pricing move QA session" }).waitFor({ timeout: 15000 });
    await check(page, "reload keeps meeting heading", () => page.locator('section[aria-label="Meetings and conversation"] h2', { hasText: "Pricing move QA session" }).isVisible());
    await check(page, "reload keeps hash inc mtab+ctab", async () => (await hashOf(page)) === "#/meet?board=b-alpha&meeting=m-one&mtab=takeaways&ctab=members");
    await check(page, "reload keeps meeting tab selected", () => page.getByRole("tab", { name: "Key takeaways" }).getAttribute("aria-selected").then((v) => v === "true"));
    await check(page, "reload keeps context tab selected", () => page.getByRole("tab", { name: "Board members" }).getAttribute("aria-selected").then((v) => v === "true"));

    // copied deep link in a fresh page (same context keeps fixtures)
    const page2 = await ctx.newPage();
    page2.on("console", (m) => { if (m.type() === "error") consoleErrs.push("[p2] " + m.text().slice(0, 200)); });
    page2.on("pageerror", (e) => pageErrs.push("[p2] " + String(e).slice(0, 200)));
    await page2.goto(BASE + "#/meet?board=b-alpha&meeting=m-one&mtab=options&ctab=decisions", { waitUntil: "domcontentloaded" });
    await page2.locator('section[aria-label="Meetings and conversation"] h2', { hasText: "Pricing move QA session" }).waitFor({ timeout: 15000 });
    await check(page2, "deep link restores meeting + options view", () => page2.getByRole("tab", { name: "Options" }).getAttribute("aria-selected").then((v) => v === "true"));
    await check(page2, "deep link restores decisions context", () => page2.getByRole("tab", { name: "Decisions" }).getAttribute("aria-selected").then((v) => v === "true"));
    await page2.close();

    // Activity guard: usage waits for a VALID board; invalid boards never fire it
    mark = reqLog.length;
    await page.goto(BASE + "#/activity?board=b-alpha", { waitUntil: "domcontentloaded" });
    await section("Activity and Usage").first().waitFor({ timeout: 15000 });
    await check(page, "activity usage fires for valid board (guard open)", async () => reqLog.some((u) => u.includes("/api/usage") && u.includes("boardId=b-alpha")));
    mark = reqLog.length;
    await page.goto(BASE + "#/activity?board=NOPE", { waitUntil: "domcontentloaded" });
    await section("Boards").first().waitFor({ timeout: 15000 });
    await check(page, "activity with bogus board lands on Boards", async () => (await hashOf(page)) === "#/boards");
    await check(page, "activity with bogus board never fires usage", async () => !reqLog.slice(mark).some((u) => u.includes("/api/usage") && u.includes("NOPE")));

    // board-owned isolation: advisor chat selection + history reset on switch
    await page.goto(BASE + "#/advisors?board=b-alpha", { waitUntil: "domcontentloaded" });
    await page.locator('section[aria-label="This Board\'s Advisors"] h2').waitFor({ timeout: 15000 });
    await check(page, "populated advisors list shows two seats", () => page.locator('section[aria-label="This Board\'s Advisors"] h2', { hasText: "2/10" }).isVisible());
    const chatCard = page.locator('.card:has(h3:text("Chat directly with an advisor"))');
    await chatCard.locator("select").selectOption("a-1");
    await chatCard.getByPlaceholder("Ask this advisor directly").fill("hello fixture");
    await chatCard.getByPlaceholder("Ask this advisor directly").press("Enter");
    await page.getByText("Fixture reply from CFO Ada: noted.").waitFor({ timeout: 8000 });
    await check(page, "advisor test chat returns fixture reply", () => page.getByText("Fixture reply from CFO Ada: noted.").isVisible());
    await page.goto(BASE + "#/boards?board=b-beta", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.location.hash === "#/boards?board=b-beta", null, { timeout: 8000 }).catch(() => {});
    await page.goto(BASE + "#/advisors?board=b-beta", { waitUntil: "domcontentloaded" });
    await page.locator('section[aria-label="This Board\'s Advisors"] h2').waitFor({ timeout: 15000 });
    await check(page, "board switch clears advisor chat selection", () => page.locator('.card:has(h3:text("Chat directly with an advisor")) select').inputValue().then((v) => v === ""));
    await check(page, "board switch clears advisor chat history", () => page.getByText("Fixture reply from CFO Ada: noted.").isHidden());
    await page.goBack();
    await page.goBack();
    await page.locator('section[aria-label="This Board\'s Advisors"] h2').waitFor({ timeout: 15000 });
    await check(page, "Back restores advisors URL without chat state", async () => (await hashOf(page)) === "#/advisors?board=b-alpha");
    await check(page, "Back does not resurrect chat selection", () => page.locator('.card:has(h3:text("Chat directly with an advisor")) select').inputValue().then((v) => v === ""));

    // board switch drops stale meeting/record (existing behavior, kept)
    await page.goto(BASE + "#/records?board=b-alpha&meeting=m-one&rec=r-1", { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /Review v1/ }).waitFor({ timeout: 15000 });
    await rail("Boards").click();
    await page.locator(".listpanel-rows button", { hasText: "Beta Board" }).click();
    await check(page, "board switch drops meeting from hash", async () => { const h = await hashOf(page); return h.includes("board=b-beta") && !h.includes("meeting="); });
    await check(page, "board switch drops record from hash", async () => !(await hashOf(page)).includes("rec="));
    await rail("Meetings").click();
    await check(page, "new board lists its own meetings", () => page.locator("ol.agenda button", { hasText: "Beta kickoff" }).isVisible());
    await check(page, "old board meeting not shown", () => page.locator("ol.agenda button", { hasText: "Pricing move QA session" }).isHidden());

    // Back after a board switch restores the prior board+meeting (no lost entry)
    await page.goto(BASE + "#/meet?board=b-alpha&meeting=m-one", { waitUntil: "domcontentloaded" });
    await page.locator('section[aria-label="Meetings and conversation"] h2', { hasText: "Pricing move QA session" }).waitFor({ timeout: 15000 });
    await rail("Boards").click();
    await page.locator(".listpanel-rows button", { hasText: "Beta Board" }).click();
    await page.waitForFunction(() => window.location.hash.includes("board=b-beta"), null, { timeout: 8000 }).catch(() => {});
    await page.goBack();
    await page.waitForFunction(() => window.location.hash.includes("board=b-alpha"), null, { timeout: 8000 }).catch(() => {});
    await check(page, "Back returns to boards-with-alpha entry", async () => (await hashOf(page)) === "#/boards?board=b-alpha&meeting=m-one");
    await page.goBack();
    await page.locator('section[aria-label="Meetings and conversation"] h2', { hasText: "Pricing move QA session" }).waitFor({ timeout: 15000 });
    await check(page, "Back after board switch restores prior meeting", () => page.locator('section[aria-label="Meetings and conversation"] h2', { hasText: "Pricing move QA session" }).isVisible());
    await check(page, "Back after board switch restores hash", async () => (await hashOf(page)) === "#/meet?board=b-alpha&meeting=m-one");

    // sidebar and main board selections stay consistent
    await rail("Boards").click();
    await check(page, "sidebar marks active Alpha row", () => page.locator(".listpanel-rows button", { hasText: "Alpha Board" }).getAttribute("class").then((c) => (c || "").includes("active")));
    await page.locator("main section .card button", { hasText: "Beta Board" }).first().click();
    await check(page, "main board card switches board", async () => (await hashOf(page)).includes("board=b-beta"));
    await check(page, "sidebar meeting list follows main selection", () => page.locator(".listpanel-rows button", { hasText: "Beta kickoff" }).isVisible());

    // logo returns to Boards and preserves wizard draft
    await rail("Boards").click();
    await page.getByRole("button", { name: "New board", exact: true }).first().click();
    await page.locator('section[aria-label="New-board wizard"]').waitFor({ timeout: 8000 });
    await page.getByPlaceholder("e.g. Pricing review").fill("Draft Board X");
    const logoBtn = page.getByRole("button", { name: /go to Boards/ });
    await check(page, "logo is a labelled button", () => logoBtn.isVisible());
    await logoBtn.focus();
    await page.keyboard.press("Enter");
    await section("Boards").first().waitFor({ timeout: 8000 });
    await check(page, "logo keyboard activation returns to Boards", async () => (await hashOf(page)).startsWith("#/boards"));
    await page.getByRole("button", { name: "New board", exact: true }).first().click();
    await check(page, "wizard draft preserved after logo nav", () => page.getByPlaceholder("e.g. Pricing review").inputValue().then((v) => v === "Draft Board X"));

    // create-board: full wizard flow with a delayed boards refresh in flight
    await rail("Boards").click();
    await page.getByRole("button", { name: "New board", exact: true }).first().click();
    await page.locator('section[aria-label="New-board wizard"]').waitFor({ timeout: 8000 });
    await check(page, "wizard destination reachable with hash", async () => (await hashOf(page)).startsWith("#/wizard"));
    await page.getByPlaceholder("e.g. Pricing review").fill("QA Created Board");
    await page.getByPlaceholder("What should the board help you decide?").fill("QA mission decides pricing");
    await page.locator('section[aria-label="New-board wizard"]').getByRole("button", { name: "Continue" }).first().click();
    await page.getByPlaceholder("e.g. Finance reviewer").fill("QA Reviewer");
    await page.getByRole("button", { name: "Add seat" }).click();
    await page.locator('section[aria-label="New-board wizard"]').getByRole("button", { name: "Continue" }).first().click();
    await page.locator('section[aria-label="New-board wizard"]').getByLabel("Name", { exact: true }).fill("QA Lead");
    await page.locator('section[aria-label="New-board wizard"]').getByRole("button", { name: "Continue" }).first().click();
    await page.getByRole("button", { name: "Create board" }).waitFor({ timeout: 8000 });
    await setDelay(page, "boards", 1500);
    await page.getByRole("button", { name: "Create board" }).click();
    await page.waitForFunction(() => /board=b-new-/.test(window.location.hash), null, { timeout: 10000 }).catch(() => {});
    await check(page, "created board navigates with new board context", async () => /board=b-new-/.test(await hashOf(page)) && (await hashOf(page)).startsWith("#/advisors"));
    const boardHash = await hashOf(page);
    await page.locator(".mobilebar .boardname").waitFor({ state: "attached", timeout: 15000 });
    await check(page, "created board name renders from detail", () => page.locator(".mobilebar .boardname").textContent().then((v) => (v || "").includes("QA Created Board")));
    await page.waitForTimeout(2000);
    await check(page, "created board survives delayed boards refresh", async () => (await hashOf(page)) === boardHash);
    await rail("Boards").click();
    await check(page, "created board appears in boards window list", () => page.locator("main section .card button", { hasText: "QA Created Board" }).first().isVisible());

    await page.goto(BASE + "#/meet?board=b-alpha&meeting=m-one", { waitUntil: "domcontentloaded" });
    await page.locator("section[aria-label=\"Meetings and conversation\"] h2").waitFor({ timeout: 15000 });
    await page.locator("summary:has-text(\"Meeting setup\")").click();
    await page.locator("section[aria-label=\"Meetings and conversation\"]").getByLabel("Brief (a meeting needs a brief before discussion)").fill("Updated brief for QA run enables discussion");
    await page.getByRole("button", { name: "Save title + brief" }).click();
    await page.waitForTimeout(1200);
    await check(page, "meeting brief save updates detail", () => page.locator("section[aria-label=\"Meetings and conversation\"] div.meet-head").getByText("Updated brief for QA run enables discussion").isVisible());
    await check(page, "saved brief enables Run", () => page.getByRole("button", { name: "Run discussion" }).isEnabled());
    await page.getByRole("button", { name: "Pause" }).click();
    await page.waitForTimeout(1200);
    await check(page, "pause enables Resume", () => page.getByRole("button", { name: "Resume" }).isEnabled());
    await page.getByRole("button", { name: "Resume" }).click();
    await page.waitForTimeout(1200);
    await check(page, "resume restores Pause", () => page.getByRole("button", { name: "Pause" }).isEnabled());
    await page.locator("section[aria-label=\"Meetings and conversation\"]").getByLabel("Brief (a meeting needs a brief before discussion)").fill("Should we raise the starter tier?");
    await page.getByRole("button", { name: "Save title + brief" }).click();
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Close without publication" }).click();
    await page.waitForTimeout(1200);
    await check(page, "close disables Pause", () => page.getByRole("button", { name: "Pause" }).isDisabled());
    await page.getByRole("button", { name: "Reopen (history intact)" }).click();
    await page.waitForTimeout(1200);
    await check(page, "reopen restores Pause", () => page.getByRole("button", { name: "Pause" }).isEnabled());
    await page.goto(BASE + "#/boards?board=b-alpha", { waitUntil: "domcontentloaded" });
    await section("Boards").first().waitFor({ timeout: 8000 });
    await section("Boards").getByLabel("Board name").fill("Alpha Board RENAMED");
    await page.getByRole("button", { name: "Save draft" }).click();
    await page.waitForTimeout(1200);
    await check(page, "board rename updates heading", () => page.locator(".mobilebar .boardname").textContent().then((v) => (v || "").includes("RENAMED")));
    await section("Boards").getByLabel("Board name").fill("Alpha Board");
    await page.getByRole("button", { name: "Save draft" }).click();
    await page.waitForTimeout(1200);
    await check(page, "board rename restores heading", () => page.locator(".mobilebar .boardname").textContent().then((v) => (v || "").includes("Alpha Board")));


    // P1: controlled delayed-write A->B — save must cache by returned identity, not selected IDs.
    // Meeting case: save A (m-one) with delay, switch to B (m-two) before response.
    await page.goto(BASE + "#/meet?board=b-alpha&meeting=m-one", { waitUntil: "domcontentloaded" });
    await page.locator("section[aria-label=\"Meetings and conversation\"] h2", { hasText: "Pricing move QA session" }).waitFor({ timeout: 15000 });
    await page.locator("summary:has-text(\"Meeting setup\")").click();
    const briefBox = page.locator("section[aria-label=\"Meetings and conversation\"]").getByLabel("Brief (a meeting needs a brief before discussion)");
    await briefBox.fill("A-DELAYED-P1-BOARD-CHECK");
    await setDelay(page, "save-meeting", 1500);
    await page.getByRole("button", { name: "Save title + brief" }).click();
    // immediate user switch to B before A response returns (push semantics preserved)
    await page.locator("ol.agenda button", { hasText: "Second session notes" }).click();
    await page.waitForFunction(() => window.location.hash.includes("meeting=m-two"), null, { timeout: 8000 }).catch(() => {});
    await check(page, "delayed save switch lands on B", async () => (await hashOf(page)).includes("meeting=m-two"));
    await page.waitForTimeout(2200);
    await check(page, "B form untouched by A delayed response", () => page.locator("section[aria-label=\"Meetings and conversation\"]").getByLabel("Brief (a meeting needs a brief before discussion)").inputValue().then((v) => !v.includes("A-DELAYED-P1-BOARD-CHECK")).catch(() => false));
    // second save on B must not carry A data
    await page.locator("section[aria-label=\"Meetings and conversation\"]").getByLabel("Brief (a meeting needs a brief before discussion)").fill("Follow-up notes");
    await page.getByRole("button", { name: "Save title + brief" }).click();
    await page.waitForTimeout(1200);
    await check(page, "B second save keeps B data", () => page.locator("section[aria-label=\"Meetings and conversation\"]").getByLabel("Brief (a meeting needs a brief before discussion)").inputValue().then((v) => v.includes("Follow-up notes") && !v.includes("A-DELAYED")).catch(() => false));
    // switch back to A: A must carry its delayed update
    await page.locator("ol.agenda button", { hasText: "Pricing move QA session" }).click();
    await page.waitForFunction(() => window.location.hash.includes("meeting=m-one"), null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
    await check(page, "A updated by its delayed save", () => page.locator("section[aria-label=\"Meetings and conversation\"]").getByLabel("Brief (a meeting needs a brief before discussion)").inputValue().then((v) => v.includes("A-DELAYED-P1-BOARD-CHECK")).catch(() => false));
    // restore A brief for later suites
    await page.locator("section[aria-label=\"Meetings and conversation\"]").getByLabel("Brief (a meeting needs a brief before discussion)").fill("Should we raise the starter tier?");
    await page.getByRole("button", { name: "Save title + brief" }).click();
    await page.waitForTimeout(1200);

    // P1 board case: save Alpha with delay, switch to Beta before response.
    await page.goto(BASE + "#/boards?board=b-alpha", { waitUntil: "domcontentloaded" });
    await section("Boards").first().waitFor({ timeout: 8000 });
    await section("Boards").getByLabel("Board name").fill("Alpha Board P1-DELAYED");
    await setDelay(page, "save-board", 1500);
    await page.getByRole("button", { name: "Save draft" }).click();
    await page.locator(".listpanel-rows button", { hasText: "Beta Board" }).click();
    await page.waitForFunction(() => window.location.hash.includes("board=b-beta"), null, { timeout: 8000 }).catch(() => {});
    await check(page, "board delayed switch lands on Beta", async () => (await hashOf(page)).includes("board=b-beta"));
    await page.waitForTimeout(2200);
    await check(page, "Beta heading untouched by Alpha delayed save", () => page.locator(".mobilebar .boardname").textContent().then((v) => !(v || "").includes("P1-DELAYED")).catch(() => false));
    // Beta second save keeps Beta data
    await section("Boards").first().waitFor({ timeout: 8000 });
    await check(page, "Beta form untouched by Alpha delayed save", () => section("Boards").getByLabel("Board name").inputValue().then((v) => !v.includes("P1-DELAYED")).catch(() => false));
    await page.locator(".listpanel-rows button", { hasText: "Alpha Board" }).click();
    await page.waitForFunction(() => window.location.hash.includes("board=b-alpha"), null, { timeout: 8000 }).catch(() => {});
    await section("Boards").first().waitFor({ timeout: 8000 });
    await page.waitForTimeout(1500);
    await check(page, "Alpha updated by its delayed save", () => page.locator(".mobilebar .boardname").textContent().then((v) => (v || "").includes("P1-DELAYED")).catch(() => false));
    await check(page, "Alpha form reflects delayed save", () => section("Boards").getByLabel("Board name").inputValue().then((v) => v.includes("P1-DELAYED")).catch(() => false));
    await section("Boards").getByLabel("Board name").fill("Alpha Board");
    await page.getByRole("button", { name: "Save draft" }).click();
    await page.waitForTimeout(1200);

    // P2: invalid-parent cleanup must REPLACE, Back leaves, Forward cannot trap.
    await page.goto(BASE + "#/meet?board=b-alpha&meeting=m-one", { waitUntil: "domcontentloaded" });
    await page.locator("section[aria-label=\"Meetings and conversation\"] h2", { hasText: "Pricing move QA session" }).waitFor({ timeout: 15000 });
    const validHash = await hashOf(page);
    await page.goto(BASE + "#/meet?board=NOPE&meeting=NOPE", { waitUntil: "domcontentloaded" });
    await section("Boards").first().waitFor({ timeout: 15000 });
    await check(page, "bogus parent cleanup lands on Boards (no transient meet)", async () => (await hashOf(page)) === "#/boards");
    await page.goBack();
    await page.locator("section[aria-label=\"Meetings and conversation\"] h2", { hasText: "Pricing move QA session" }).waitFor({ timeout: 15000 }).catch(() => {});
    await check(page, "Back after bogus cleanup restores valid route", async () => (await hashOf(page)) === validHash);
    await page.goForward();
    await section("Boards").first().waitFor({ timeout: 15000 }).catch(() => {});
    await check(page, "Forward after Back returns to Boards (no trap)", async () => (await hashOf(page)) === "#/boards");
    // no transient boardless #/meet in history: second Back must not land on #/meet
    await page.goBack();
    await page.locator("section[aria-label=\"Meetings and conversation\"] h2", { hasText: "Pricing move QA session" }).waitFor({ timeout: 15000 }).catch(() => {});
    const backAgain = await hashOf(page);
    await check(page, "no transient boardless meet trapped in history", async () => backAgain !== "#/meet" && backAgain.includes("meeting=m-one"));
    // meeting-invalid with valid board: replace, Back leaves, Forward clean
    await page.goto(BASE + "#/meet?board=b-alpha&meeting=m-one", { waitUntil: "domcontentloaded" });
    await page.locator("section[aria-label=\"Meetings and conversation\"] h2", { hasText: "Pricing move QA session" }).waitFor({ timeout: 15000 });
    await page.goto(BASE + "#/meet?board=b-alpha&meeting=NOPE-MEET", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.location.hash === "#/meet?board=b-alpha", null, { timeout: 8000 }).catch(() => {});
    await check(page, "bogus meeting cleanup keeps board, drops meeting (replace)", async () => (await hashOf(page)) === "#/meet?board=b-alpha");
    await page.goBack();
    await page.locator("section[aria-label=\"Meetings and conversation\"] h2", { hasText: "Pricing move QA session" }).waitFor({ timeout: 15000 }).catch(() => {});
    await check(page, "Back after meeting cleanup restores meeting", async () => (await hashOf(page)).includes("meeting=m-one"));
    await page.goForward();
    await page.waitForFunction(() => window.location.hash === "#/meet?board=b-alpha", null, { timeout: 8000 }).catch(() => {});
    await check(page, "Forward after meeting Back returns clean (no trap)", async () => (await hashOf(page)) === "#/meet?board=b-alpha");

    // Genuine SPA cached record -> wrong parent (no reload): no review/actions while unverified.
    await page.goto(BASE + "#/records?board=b-alpha&meeting=m-one&rec=r-1", { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /Review v1/ }).waitFor({ timeout: 15000 });
    await check(page, "SPA setup review visible before switch", () => page.getByRole("heading", { name: /Review v1/ }).isVisible());
    await page.evaluate(() => { window.location.hash = "#/records?board=b-alpha&meeting=m-two&rec=r-1"; });
    await page.waitForFunction(() => !window.location.hash.includes("rec="), null, { timeout: 8000 }).catch(() => {});
    await check(page, "SPA wrong-parent drops rec without reload", async () => !(await hashOf(page)).includes("rec="));
    await check(page, "SPA wrong-parent hides review without reload", () => page.getByRole("heading", { name: /Review v/ }).isHidden());
    await check(page, "SPA wrong-parent hides approve action", () => page.getByRole("button", { name: /Approve/ }).isHidden().catch(() => true));
    // SPA parent pending: delay meeting-detail, switch meeting, assert no review while pending
    await page.goto(BASE + "#/records?board=b-alpha&meeting=m-one&rec=r-1", { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /Review v1/ }).waitFor({ timeout: 15000 });
    await setDelay(page, "meeting-detail", 1500);
    await page.evaluate(() => { window.location.hash = "#/records?board=b-alpha&meeting=m-two&rec=r-1"; });
    await page.waitForTimeout(400);
    await check(page, "SPA pending parent hides review", () => page.getByRole("heading", { name: /Review v/ }).isHidden());
    await page.waitForTimeout(1800);
    await check(page, "SPA pending resolves without rec (still wrong parent)", async () => !(await hashOf(page)).includes("rec="));
    // SPA parent error: inject 500 for meeting-detail, switch, assert no review/actions
    await page.goto(BASE + "#/records?board=b-alpha&meeting=m-one&rec=r-1", { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /Review v1/ }).waitFor({ timeout: 15000 });
    await page.evaluate(() => fetch("/api/__qa/fail?key=meeting-detail&status=500").then((r) => r.json()));
    await page.evaluate(() => { window.location.hash = "#/records?board=b-alpha&meeting=m-two&rec=r-1"; });
    await page.waitForTimeout(900);
    await check(page, "SPA error parent hides review", () => page.getByRole("heading", { name: /Review v/ }).isHidden());
    await check(page, "SPA error parent hides revise action", () => page.getByRole("button", { name: /Request revision/ }).isHidden().catch(() => true));
    await page.reload({ waitUntil: "domcontentloaded" });
    await section("Records").first().waitFor({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);

    // P3: strict wizard fixture contracts + suggest->save/interview normal case.
    const wizContracts = await page.evaluate(async () => {
      const out = {};
      const j = async (url, opts) => {
        const r = await fetch(url, opts);
        let b = null;
        try { b = await r.json(); } catch { b = null; }
        return { status: r.status, body: b };
      };
      // new draft must return version 2 (main POST /api/wizard starts 1 then ++)
      const created = await j("/api/wizard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: 1, presetKey: "strategy", fieldsJson: "{}", accountId: "" }) });
      out.newStatus = created.status;
      out.newVersion = created.body && created.body.version;
      const wid = created.body && created.body.id;
      out.wid = !!wid;
      if (!wid) return out;
      const v0 = created.body.version;
      // suggest must NOT bump version
      const sug = await j("/api/wizard/" + wid + "/suggest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: 1, input: "hello" }) });
      out.suggestStatus = sug.status;
      const afterSug = await j("/api/wizard/" + wid, { method: "GET" });
      out.suggestVersionUnchanged = afterSug.body && afterSug.body.version === v0;
      // save with current version must succeed (no false stale after suggest)
      const save = await j("/api/wizard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: wid, version: v0, step: 1, presetKey: "strategy", fieldsJson: JSON.stringify({ name: "  QA Board  ", mission: "  QA mission  ", stage: "Seed", advisors: [{ role: "  Strategist  ", name: "" }], lead: { name: "  QA Lead  " } }), accountId: "" }) });
      out.saveAfterSuggestStatus = save.status;
      out.saveAfterSuggestVersion = save.body && save.body.version;
      const v1 = save.body && save.body.version;
      // interview missing version => 409
      const miss = await j("/api/wizard/" + wid + "/interview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: "hi" }) });
      out.interviewMissing409 = miss.status === 409;
      // interview stale version => 409
      const stale = await j("/api/wizard/" + wid + "/interview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: "hi", version: v0 }) });
      out.interviewStale409 = stale.status === 409;
      // interview correct version => 200 + version bump
      const good = await j("/api/wizard/" + wid + "/interview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: "we decide pricing", version: v1 }) });
      out.interviewGoodStatus = good.status;
      out.interviewGoodBumps = good.body && good.body.version === v1 + 1;
      // review trims + max 10: whitespace-only name/mission/lead must block
      const w2 = await j("/api/wizard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: 1, fieldsJson: "{}", accountId: "" }) });
      const wid2 = w2.body && w2.body.id;
      const v2 = w2.body && w2.body.version;
      await j("/api/wizard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: wid2, version: v2, fieldsJson: JSON.stringify({ name: "   ", mission: "   ", advisors: [{ role: "   " }], lead: { name: "   " } }) }) });
      const revWhite = await j("/api/wizard/" + wid2 + "/review", { method: "GET" });
      const wb = (revWhite.body && revWhite.body.blockers) || [];
      out.reviewWhiteBlocks = wb.length >= 3;
      // 11 advisors must block (max 10)
      const many = [];
      for (let i = 0; i < 11; i++) many.push({ role: "Role " + i, name: "" });
      const w3 = await j("/api/wizard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: 1, fieldsJson: "{}", accountId: "" }) });
      const wid3 = w3.body && w3.body.id;
      const v3 = w3.body && w3.body.version;
      await j("/api/wizard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: wid3, version: v3, fieldsJson: JSON.stringify({ name: "B", mission: "M", advisors: many, lead: { name: "L" } }) }) });
      const revMany = await j("/api/wizard/" + wid3 + "/review", { method: "GET" });
      out.reviewManyBlocksAdvisors = ((revMany.body && revMany.body.blockers) || []).some((b) => b.field === "advisors");
      const createMany = await j("/api/wizard/" + wid3 + "/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      out.createMany409 = createMany.status === 409;
      // invalid shape: advisors as string, lead as string => must block, not crash
      const w4 = await j("/api/wizard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: 1, fieldsJson: "{}", accountId: "" }) });
      const wid4 = w4.body && w4.body.id;
      const v4 = w4.body && w4.body.version;
      await j("/api/wizard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: wid4, version: v4, fieldsJson: JSON.stringify({ name: "B", mission: "M", advisors: "not-an-array", lead: "not-an-object" }) }) });
      const revBad = await j("/api/wizard/" + wid4 + "/review", { method: "GET" });
      out.reviewBadShapeBlocks = ((revBad.body && revBad.body.blockers) || []).length > 0;
      const createBad = await j("/api/wizard/" + wid4 + "/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      out.createBadShape409 = createBad.status === 409;
      // idempotent create replay: valid create twice returns same board
      const w5 = await j("/api/wizard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: 1, fieldsJson: "{}", accountId: "" }) });
      const wid5 = w5.body && w5.body.id;
      const v5 = w5.body && w5.body.version;
      await j("/api/wizard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: wid5, version: v5, fieldsJson: JSON.stringify({ name: "Replay Board", mission: "Replay mission", advisors: [{ role: "Strategist", name: "" }], lead: { name: "Replay Lead" } }) }) });
      const c1 = await j("/api/wizard/" + wid5 + "/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const c2 = await j("/api/wizard/" + wid5 + "/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      out.createReplayConsistent = c1.status === 200 && c2.status === 200 && c1.body && c2.body && c1.body.board && c2.body.board && c1.body.board.id === c2.body.board.id;
      return out;
    });
    await check(page, "wizard new draft version is 2 (main contract)", async () => wizContracts.newStatus === 200 && wizContracts.newVersion === 2);
    await check(page, "wizard suggest leaves version unchanged", async () => wizContracts.suggestStatus === 200 && wizContracts.suggestVersionUnchanged === true);
    await check(page, "wizard save after suggest succeeds (no false stale)", async () => wizContracts.saveAfterSuggestStatus === 200 && wizContracts.saveAfterSuggestVersion === wizContracts.newVersion + 1);
    await check(page, "wizard interview missing version 409", async () => wizContracts.interviewMissing409 === true);
    await check(page, "wizard interview stale version 409", async () => wizContracts.interviewStale409 === true);
    await check(page, "wizard interview good version bumps", async () => wizContracts.interviewGoodStatus === 200 && wizContracts.interviewGoodBumps === true);
    await check(page, "wizard review trims whitespace required fields", async () => wizContracts.reviewWhiteBlocks === true);
    await check(page, "wizard review max 10 advisors blocks", async () => wizContracts.reviewManyBlocksAdvisors === true);
    await check(page, "wizard create max 10 advisors 409", async () => wizContracts.createMany409 === true);
    await check(page, "wizard invalid shape blocked (review)", async () => wizContracts.reviewBadShapeBlocks === true);
    await check(page, "wizard invalid shape 409 on create", async () => wizContracts.createBadShape409 === true);
    await check(page, "wizard idempotent create replay consistent", async () => wizContracts.createReplayConsistent === true);

    await page.goto(BASE + "#/records?board=b-beta&meeting=m-one&rec=r-1", { waitUntil: "domcontentloaded" });
    await section("Records").first().waitFor({ timeout: 15000 });
    await page.waitForFunction(() => !window.location.hash.includes("rec="), null, { timeout: 8000 }).catch(() => {});
    await check(page, "wrong-parent cached record drops rec", async () => !(await hashOf(page)).includes("rec="));
    await check(page, "wrong-parent hides review", () => page.getByRole("heading", { name: /Review v/ }).isHidden());
    await page.goto(BASE + "#/records?board=b-alpha&meeting=m-one&rec=r-1", { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /Review v1/ }).waitFor({ timeout: 15000 });
    await page.evaluate(() => fetch("/api/__qa/fail?key=m-one&status=500").then((r) => r.json()));
    await page.reload({ waitUntil: "domcontentloaded" });
    await section("Records").first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    await check(page, "transport-error hides cached review", () => page.getByRole("heading", { name: /Review v/ }).isHidden());
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /Review v1/ }).waitFor({ timeout: 15000 });
    await check(page, "recovered parent restores review", () => page.getByRole("heading", { name: /Review v1/ }).isVisible());

    await page.goto(BASE + "#/roster?board=b-alpha", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollTo(0, 99999));
    await rail("Profile").click();
    await section("Profile").first().waitFor({ timeout: 8000 });
    await check(page, "scroll reset shows Profile heading", () => page.getByRole("heading", { name: "Profile" }).isVisible());
    await check(page, "document top reset on tab change", () => page.evaluate(() => window.scrollY === 0));

    await rail("Boards").click();
    await page.getByRole("button", { name: "New board", exact: true }).first().click();
    await page.locator("section[aria-label=\"New-board wizard\"]").waitFor({ timeout: 8000 });
    await check(page, "second New board is fresh Step1", () => page.getByPlaceholder("e.g. Pricing review").inputValue().then((v) => v === ""));
    await page.getByPlaceholder("e.g. Pricing review").fill("QA Second Board");
    await page.getByPlaceholder("What should the board help you decide?").fill("Second mission decides onboarding");
    await page.locator("section[aria-label=\"New-board wizard\"]").getByRole("button", { name: "Continue" }).first().click();
    await page.getByPlaceholder("e.g. Finance reviewer").fill("QA Second Reviewer");
    await page.getByRole("button", { name: "Add seat" }).click();
    await page.locator("section[aria-label=\"New-board wizard\"]").getByRole("button", { name: "Continue" }).first().click();
    await page.locator("section[aria-label=\"New-board wizard\"]").getByLabel("Name", { exact: true }).fill("QA Second Lead");
    await page.locator("section[aria-label=\"New-board wizard\"]").getByRole("button", { name: "Continue" }).first().click();
    await page.getByRole("button", { name: "Create board" }).click();
    await page.waitForFunction(() => /board=b-new-/.test(window.location.hash), null, { timeout: 10000 }).catch(() => {});
    await check(page, "second board distinct from first", async () => (await hashOf(page)) !== boardHash && /board=b-new-/.test(await hashOf(page)));

    // skip link moves focus without touching the route
    await rail("Boards").click();
    await section("Boards").first().waitFor({ timeout: 8000 });
    const beforeSkip = await hashOf(page);
    // Offscreen until :focus (CSS hides it at -9999px), so activate the real
    // handler the way keyboard users do: programmatic click fires onClick,
    // which must preventDefault, focus main, and leave the hash untouched.
    await check(page, "skip link targets #main (handler owns the trap)", () => page.locator("a.skip").getAttribute("href").then((v) => v === "#main"));
    await page.evaluate(() => { const el = document.querySelector("a.skip"); if (el) el.click(); });
    await check(page, "skip link focuses main content", () => page.evaluate(() => document.activeElement && document.activeElement.id === "main"));
    await check(page, "skip link preserves route (no #main parse)", async () => (await hashOf(page)) === beforeSkip);

    // Profile + Help reachable while signed out (no demo sign-in side effect)
    await page.evaluate(() => localStorage.removeItem("simceo-fb-user-v2"));
    await rail("Profile").click();
    await section("Profile").first().waitFor({ timeout: 8000 });
    await check(page, "Profile reachable signed out", () => page.getByText("Not signed in").isVisible());
    await rail("Help").click();
    await section("Help").first().waitFor({ timeout: 8000 });
    await check(page, "Help reachable signed out", () => page.getByText("Keyboard shortcuts").isVisible());
    await check(page, "visiting Profile did not sign in", () => page.evaluate(() => localStorage.getItem("simceo-fb-user-v2") === null));

    // dark theme still lays out without overflow (light shots taken earlier)
    await rail("Profile").click();
    await page.getByRole("button", { name: "Switch to dark" }).click();
    await page.goto(BASE + "#/boards?board=b-alpha", { waitUntil: "domcontentloaded" });
    await section("Boards").first().waitFor({ timeout: 15000 });
    await check(page, "dark boards has no horizontal overflow", () => noOverflow(page));
    await page.screenshot({ path: path.join(SHOTDIR, "shot-dark-boards.png") });
    await page.goto(BASE + "#/meet?board=b-alpha&meeting=m-one", { waitUntil: "domcontentloaded" });
    await page.locator('section[aria-label="Meetings and conversation"] h2', { hasText: "Pricing move QA session" }).waitFor({ timeout: 15000 });
    await check(page, "dark meet has no horizontal overflow", () => noOverflow(page));
    await page.screenshot({ path: path.join(SHOTDIR, "shot-dark-meet.png") });

    // console health: no duplicate-key warnings, no page errors, no stub gaps
    await check(page, "no react duplicate-key warnings", async () => !consoleErrs.some((t) => /unique ["']key|duplicate.*key|key.*duplicat/i.test(t)));
    await check(page, "no page errors", async () => pageErrs.length === 0);
    await check(page, "no unhandled fixture paths", async () => unhandled.length === 0);
    if (unhandled.length) console.log("  unhandled: " + unhandled.join(" | "));
  } finally {
    await ctx.close();
  }
}

async function mobileSuite(browser) {
  console.log("MOBILE suite (fixture mode, 390x844)");
  const reqLog = [];
  const unhandled = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await ctx.route("**/api/**", fixtureHandler(reqLog, unhandled));
    await ctx.route("**/hubs/**", (r) => r.abort());
    const page = await ctx.newPage();
    await page.goto(BASE + "#/meet?board=b-alpha&meeting=m-one", { waitUntil: "domcontentloaded" });
    await page.locator('section[aria-label="Meetings and conversation"]').waitFor({ timeout: 15000 });
    await check(page, "phone meet has no horizontal overflow", () => noOverflow(page));
    const railProbe = () => page.evaluate(() => {
      const nav = document.querySelector("nav.rail");
      if (!nav) return { missing: true };
      const cs = getComputedStyle(nav);
      return { inert: nav.hasAttribute("inert"), visibility: cs.visibility };
    });
    const focusInNav = () => page.evaluate(() => !!document.activeElement && !!document.activeElement.closest("nav.rail"));
    const closed = await railProbe();
    await check(page, "closed mobile nav is inert", async () => closed.inert === true);
    await check(page, "closed mobile nav is hidden", async () => closed.visibility === "hidden");
    await check(page, "closed mobile nav holds no focus", async () => !(await focusInNav()));
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.waitForFunction(() => document.querySelector("nav.rail") && !document.querySelector("nav.rail").hasAttribute("inert"), null, { timeout: 8000 }).catch(() => {});
    await page.waitForFunction(() => getComputedStyle(document.querySelector("nav.rail")).visibility === "visible", null, { timeout: 8000 }).catch(() => {});
    await page.waitForFunction(() => { const ae = document.activeElement; return !!ae && !!ae.closest("nav.rail"); }, null, { timeout: 8000 }).catch(() => {});
    await check(page, "opening moves focus into nav", () => focusInNav());
    const openS = await railProbe();
    await check(page, "open nav is not inert", async () => openS.inert === false);
    await check(page, "open nav is visible", async () => openS.visibility === "visible");
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(SHOTDIR, "shot-mobile-nav-open.png") });
    // genuine arrow-key travel: focus must MOVE between rail destinations
    const focusedLabel = () => page.evaluate(() => { const ae = document.activeElement; return ae ? (ae.getAttribute("aria-label") || "") : ""; });
    await page.locator("nav.rail button.rail-home").focus();
    const first = await focusedLabel();
    await check(page, "rail home focusable for arrow travel", async () => (await focusedLabel()).length > 0 && (await focusInNav()));
    await page.keyboard.press("ArrowDown");
    const second = await focusedLabel();
    await check(page, "arrow key moves focus to next destination", async () => (await focusInNav()) && second !== first && second.length > 0);
    await page.keyboard.press("ArrowUp");
    await check(page, "arrow key moves focus back", async () => (await focusInNav()) && (await focusedLabel()) === first);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector("nav.rail").hasAttribute("inert"), null, { timeout: 8000 }).catch(() => {});
    await check(page, "Escape closes the nav", async () => (await railProbe()).inert === true);
    await check(page, "Escape restores focus to menu button", () => page.evaluate(() => document.activeElement && document.activeElement.getAttribute("aria-label") === "Open navigation"));
    // backdrop dismiss path
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.waitForFunction(() => !document.querySelector("nav.rail").hasAttribute("inert"), null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Close navigation" }).click({ timeout: 8000, position: { x: 350, y: 200 } });
    await page.waitForFunction(() => document.querySelector("nav.rail").hasAttribute("inert"), null, { timeout: 8000 }).catch(() => {});
    await check(page, "backdrop dismiss closes nav", async () => (await railProbe()).inert === true);
    await check(page, "backdrop dismiss restores focus to menu", () => page.evaluate(() => document.activeElement && document.activeElement.getAttribute("aria-label") === "Open navigation"));
    // dark theme drawer screenshot on phone widths
    await page.evaluate(() => { localStorage.setItem("simceo-theme", "dark"); });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('section[aria-label="Meetings and conversation"]').waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.waitForFunction(() => !document.querySelector("nav.rail").hasAttribute("inert"), null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(SHOTDIR, "shot-mobile-dark-nav.png") });
    await check(page, "dark phone drawer opens without overflow", () => noOverflow(page));
    await check(page, "mobile: no unhandled fixture paths", async () => unhandled.length === 0);
  } finally {
    await ctx.close();
  }
}

async function resizeSuite(browser) {
  console.log("RESIZE suite (breakpoint transitions, 1440 <-> 390)");
  const reqLog = [];
  const unhandled = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    await ctx.route("**/api/**", fixtureHandler(reqLog, unhandled));
    await ctx.route("**/hubs/**", (r) => r.abort());
    const page = await ctx.newPage();
    await page.goto(BASE + "#/meet?board=b-alpha&meeting=m-one", { waitUntil: "domcontentloaded" });
    await page.locator('section[aria-label="Meetings and conversation"]').waitFor({ timeout: 15000 });
    const railProbe = () => page.evaluate(() => {
      const nav = document.querySelector("nav.rail");
      if (!nav) return { missing: true };
      return { inert: nav.hasAttribute("inert"), visibility: getComputedStyle(nav).visibility };
    });
    await check(page, "desktop rail is operable (no inert)", async () => (await railProbe()).inert === false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector("nav.rail").hasAttribute("inert"), null, { timeout: 8000 }).catch(() => {});
    await check(page, "shrinking to phone makes rail inert", async () => (await railProbe()).inert === true);
    await page.waitForFunction(() => getComputedStyle(document.querySelector("nav.rail")).visibility === "hidden", null, { timeout: 8000 }).catch(() => {});
    await check(page, "shrunk rail is hidden", async () => (await railProbe()).visibility === "hidden");
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.waitForFunction(() => { const ae = document.activeElement; return !!ae && !!ae.closest("nav.rail"); }, null, { timeout: 8000 }).catch(() => {});
    await check(page, "phone drawer takes focus after shrink", () => page.evaluate(() => !!document.activeElement && !!document.activeElement.closest("nav.rail")));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => !document.querySelector("nav.rail").hasAttribute("inert"), null, { timeout: 8000 }).catch(() => {});
    await check(page, "growing back clears inert via breakpoint sub", async () => (await railProbe()).inert === false);
    await page.waitForFunction(() => getComputedStyle(document.querySelector("nav.rail")).visibility === "visible", null, { timeout: 8000 }).catch(() => {});
    await check(page, "grown rail is visible", async () => (await railProbe()).visibility === "visible");
    await check(page, "grown rail stays keyboard reachable", () => page.evaluate(() => {
      const btn = document.querySelector("nav.rail button");
      if (!btn) return false;
      btn.focus();
      return document.activeElement === btn;
    }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => !document.querySelector("nav.rail").hasAttribute("inert"), null, { timeout: 8000 }).catch(() => {});
    await check(page, "shrinking with open drawer keeps it usable", async () => (await railProbe()).inert === false);
    await page.locator("nav.rail button.rail-home").focus();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => !document.querySelector("nav.rail").hasAttribute("inert"), null, { timeout: 8000 }).catch(() => {});
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector("nav.rail").hasAttribute("inert"), null, { timeout: 8000 }).catch(() => {});
    await check(page, "resize opener preserved after focus-rail-wide-narrow-Escape", () => page.evaluate(() => document.activeElement && document.activeElement.getAttribute("aria-label") === "Open navigation"));
    await check(page, "resize Escape closes drawer", async () => (await railProbe()).inert === true);
    await check(page, "resize: no unhandled fixture paths", async () => unhandled.length === 0);
  } finally {
    await ctx.close();
  }
}

async function liveSmoke(browser) {
  console.log("LIVE smoke (real backend, read-only navigation)");
  const probe = await fetch(BASE + "api/boards").then((r) => r.ok).catch(() => false);
  if (!probe) {
    console.log("LIVE-SKIPPED: backend unreachable at " + BASE + " (original app/server not restored). Fixture mode remains the tested proof.");
    return;
  }
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.locator("main section .card").first().waitFor({ timeout: 20000 });
    await check(page, "live: board list renders", () => page.getByText("QA Loop").first().isVisible());
    await page.locator(".listpanel-rows button").first().click();
    await page.waitForFunction(() => /board=/.test(window.location.hash), null, { timeout: 8000 }).catch(() => {});
    await check(page, "live: selecting board writes hash", async () => /board=/.test(await hashOf(page)));
    await page.getByRole("button", { name: "Meetings" }).first().click();
    await page.locator("ol.agenda, .listpanel-rows").first().waitFor({ timeout: 15000 });
    const h = await hashOf(page);
    await check(page, "live: meet destination has board context", async () => h.includes("/meet") && h.includes("board="));
    const firstMeeting = page.locator("ol.agenda button").first();
    if (await firstMeeting.count() > 0) {
      await firstMeeting.click();
      await page.waitForFunction(() => /meeting=/.test(window.location.hash), null, { timeout: 8000 }).catch(() => {});
      await check(page, "live: selecting meeting writes hash", async () => /meeting=/.test(await hashOf(page)));
      await check(page, "live: meeting heading renders", () => page.locator('section[aria-label="Meetings and conversation"] h2').isVisible());
    } else {
      console.log("  skip - live: no meetings to open on this board");
    }
    const reloaded = await hashOf(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("main section").first().waitFor({ timeout: 20000 });
    await check(page, "live: reload keeps destination hash", async () => (await hashOf(page)) === reloaded);
    await page.locator("nav.rail").getByRole("button", { name: "Profile", exact: true }).click();
    await page.locator('main section[aria-label="Profile"]').waitFor({ timeout: 10000 });
    await check(page, "live: profile reachable", () => page.locator('main section[aria-label="Profile"]').isVisible());
    await page.locator("nav.rail").getByRole("button", { name: "Help", exact: true }).click();
    await page.locator('main section[aria-label="Help"]').waitFor({ timeout: 10000 });
    await check(page, "live: help reachable", () => page.locator('main section[aria-label="Help"]').isVisible());
    await check(page, "live: no page errors", async () => errs.length === 0);
  } finally {
    await ctx.close();
  }
}

(async () => {
  console.log((LIVE ? "LIVE" : "FIXTURE") + " run against " + BASE + " via " + CDP);
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
  } catch (e) {
    console.log("FAIL - cannot connect to existing browser CDP at " + CDP + ": " + String(e).split("\n")[0]);
    process.exit(1);
  }
  try {
    if (LIVE) await liveSmoke(browser);
    else { await desktopSuite(browser); await mobileSuite(browser); await resizeSuite(browser); }
  } catch (e) {
    failed++;
    failures.push("suite crashed :: " + String(e).split("\n")[0]);
    console.log("suite crashed: " + String(e && e.stack || e).split("\n").slice(0, 5).join("\n"));
  }
  console.log("----");
  console.log("mode: " + (LIVE ? "live-smoke (real :5080 backend via :5175 proxy, read-only navigation)" : "deterministic fixtures (user :5080 API untouched; :5175 serves the worktree bundle)"));
  console.log("passed: " + passed + ", failed: " + failed);
  if (failures.length) console.log("failures:\n - " + failures.join("\n - "));
  // Never close the user's browser; our contexts were closed per-suite.
  process.exit(failed ? 1 : 0);
})();
