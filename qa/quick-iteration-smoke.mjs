// Quick-iteration read-only live smoke for the 09638f6 slice:
// 1) "New meeting" / "Request advisor responses" labels + helper text (old labels absent).
// 2) Profile background / familiar topics / simpler explanation / communication
//    preferences render as roomy multiline textareas; local newline works without
//    saving; saved custom prefs survive reload (never auto-overwritten by default).
// Usage: node qa/quick-iteration-smoke.mjs [--web http://127.0.0.1:5173] [--cdp http://127.0.0.1:9333]
// Env: QA_WEB (default http://127.0.0.1:5173), CDP_URL (optional), QA_SHOTS.
// READ-ONLY: GET navigations only. Never clicks New meeting / Request advisor
// responses / Save / Register / Sign in. Local keystrokes stay in the isolated
// context (discarded on close) and are reverted by reload. Never reads or writes
// real user browser profiles; field contents are hashed in-page, never logged.
// Own isolated context in all modes; only that context closes (never the browser).
// Exit 0 = every executed check passed (SKIPs are explicit, never false passes).
// Exit 1 = any FAIL. Screenshots -> QA_SHOTS (default .tmp/qa, git-ignored).
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webArg = (process.argv.find((a) => a.startsWith("--web=")) || "").slice("--web=".length);
const cdpArg = (process.argv.find((a) => a.startsWith("--cdp=")) || "").slice("--cdp=".length);
const WEB = (webArg || process.env.QA_WEB || "http://127.0.0.1:5173").replace(/\/+$/, "");
const CDP = cdpArg || process.env.CDP_URL || "";
const SHOTDIR = process.env.QA_SHOTS || path.join(here, "..", ".tmp", "qa");
fs.mkdirSync(SHOTDIR, { recursive: true });
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DEFAULT_COMM = "Be clear and direct. Explain unfamiliar terms, use practical examples, and finish with actionable next steps.";
const strHash = (s) => { let x = 0; for (let i = 0; i < s.length; i++) x = ((x * 31 + s.charCodeAt(i)) | 0); return (x >>> 0).toString(36); };
const DEFAULT_FP = DEFAULT_COMM.length + ":" + strHash(DEFAULT_COMM);

let pass = 0, fail = 0, skip = 0;
const failures = [];
function ok(name, cond) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; failures.push(name); console.log("  FAIL - " + name); }
}
function skipLine(name, why) { skip++; console.log("  SKIP - " + name + " :: " + why); }

const run = "qi-" + Date.now().toString(36);
const pageErrs = [];
const nonGet = new Set();
const snapFn = "(root) => { const els = [...root.querySelectorAll('label textarea')]; const h = (s) => { let x = 0; for (let i = 0; i < s.length; i++) x = ((x * 31 + s.charCodeAt(i)) | 0); return (x >>> 0).toString(36); }; return els.map((el) => el.value.length + ':' + h(el.value)); }";

async function main() {
  let browser = null, owned = false;
  if (CDP) {
    browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
  } else {
    browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-first-run"] });
    owned = true;
  }
  // Own isolated context: fresh storage, discarded on close. Never the user profile.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => pageErrs.push(String(e).split("\n")[0].slice(0, 120)));
  page.on("console", (m) => { if (m.type() === "error") pageErrs.push("console: " + m.text().slice(0, 120)); });
  page.on("request", (r) => {
    const m = r.method();
    if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
      const u = r.url();
      if (!/hub|negotiate/i.test(u)) nonGet.add(m + " " + u.slice(0, 60));
    }
  });
  console.log("quick-iteration smoke run=" + run + " web=" + WEB + " via=" + (CDP ? "existing-cdp-own-context" : "own-headless-edge"));

  await page.goto(WEB + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // ---------- Profile: 4 paragraph controls ----------
  const openProfile = page.getByRole("button", { name: "Open profile" });
  if (await openProfile.count() === 0) {
    skipLine("profile-textareas", "no Open profile control in this backend/auth state");
    skipLine("profile-multiline-local-newline", "profile not reachable");
    skipLine("profile-prefs-stable-across-reload", "profile not reachable");
    skipLine("profile-custom-prefs-preserved", "profile not reachable");
  } else {
    await openProfile.click();
    const section = page.locator('section[aria-label="Profile"]');
    ok("profile-section-visible", await section.isVisible());
    const labels = ["Background", "Subjects already familiar", "Subjects needing simpler explanation", "Communication preferences"];
    for (const label of labels) {
      ok("profile-control-present:" + label, await section.getByLabel(label, { exact: true }).count() === 1);
    }
    const tags = await section.evaluate((root) => {
      const out = [];
      for (const el of root.querySelectorAll("label textarea, label input")) out.push(el.tagName + ":" + (el.getAttribute("rows") || "-"));
      return out;
    });
    const roomy = tags.filter((t) => t.startsWith("TEXTAREA:"));
    ok("profile-four-textareas", roomy.length === 4);
    ok("profile-textarea-rows", roomy.length === 4 && roomy.every((t) => Number(t.split(":")[1]) >= 3));
    const heights = await section.evaluate((root) => {
      const out = [];
      for (const el of root.querySelectorAll("label textarea")) out.push(Math.round(el.getBoundingClientRect().height));
      return out;
    });
    ok("profile-textarea-roomy-height", heights.length === 4 && heights.every((h) => h >= 60));
    await page.screenshot({ path: path.join(SHOTDIR, "qi-profile-1440.png") });

    // Fingerprint values as length:hash only (never log contents).
    const snap0 = await section.evaluate(new Function("return " + snapFn)());
    const customPresent = snap0.length === 4 && snap0[3] !== DEFAULT_FP && Number(snap0[3].split(":")[0]) > 0;

    // Local multiline input without saving (no Save click anywhere in this script).
    const comm = section.getByLabel("Communication preferences", { exact: true });
    await comm.focus();
    await comm.press("End");
    await page.keyboard.insertText("\nlocal-qa-line");
    ok("profile-multiline-local-newline", await comm.evaluate((el) => el.value.includes("\n")));

    // Reload: unsaved keystrokes vanish (read-only proof) and restored values are stable.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: "Open profile" }).click();
    const section2 = page.locator('section[aria-label="Profile"]');
    const snap1 = await section2.evaluate(new Function("return " + snapFn)());
    ok("profile-prefs-stable-across-reload", JSON.stringify(snap0) === JSON.stringify(snap1));
    if (customPresent) ok("profile-custom-prefs-preserved", JSON.stringify(snap0) === JSON.stringify(snap1));
    else skipLine("profile-custom-prefs-preserved", "no saved/custom lead content in this backend state");
  }
  // ---------- Meeting actions: new labels + helpers, old labels absent ----------
  await page.goto(WEB + "/#/boards", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  if (await page.locator('a[href*="#/meet?board="]').count() === 0) {
    skipLine("meeting-new-labels", "no existing board link in this backend/auth state");
    skipLine("meeting-old-labels-absent", "no existing board link in this backend/auth state");
    skipLine("meeting-helper-text", "no existing board link in this backend/auth state");
  } else {
    await page.locator('a[href*="#/meet?board="]').first().click();
    await page.waitForTimeout(2500);
    const meetSection = page.locator('section[aria-label="Meetings and conversation"]');
    ok("meet-section-visible", await meetSection.count() > 0);
    const agendaN = await page.locator("ol.agenda button").count();
    if (agendaN > 0) {
      await page.locator("ol.agenda button").first().click();
      await page.waitForTimeout(2500);
    }
    if (await meetSection.locator("h2").count() === 0 && agendaN === 0) {
      skipLine("meeting-new-labels", "board has no existing meeting to open");
      skipLine("meeting-old-labels-absent", "board has no existing meeting to open");
      skipLine("meeting-helper-text", "board has no existing meeting to open");
    } else {
      ok("meeting-new-meeting-label", await page.getByRole("button", { name: "New meeting", exact: true }).count() >= 1);
      ok("meeting-request-label", await page.getByRole("button", { name: "Request advisor responses", exact: true }).count() >= 1);
      ok("meeting-old-start-absent", await page.getByRole("button", { name: "Start meeting", exact: true }).count() === 0);
      ok("meeting-old-run-absent", await page.getByRole("button", { name: "Run discussion", exact: true }).count() === 0);
      ok("meeting-helper-new", await page.getByText("Starts a new separate conversation.", { exact: true }).count() >= 1);
      ok("meeting-helper-request", await page.getByText("Asks the advisors in the current meeting to respond.", { exact: true }).count() >= 1);
      await page.screenshot({ path: path.join(SHOTDIR, "qi-meet-1440.png") });
    }
  }

  // ---------- Overflow: 1440 + 390, read-only ----------
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);
  ok("no-overflow-1440", await noOverflow());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  ok("no-overflow-390", await noOverflow());
  await page.screenshot({ path: path.join(SHOTDIR, "qi-390.png") });

  // ---------- Read-only + error report ----------
  console.log("non-get-requests=" + nonGet.size);
  ok("no-api-mutations", nonGet.size === 0);
  console.log("page-errors=" + pageErrs.length);
  ok("no-page-errors", pageErrs.length === 0);

  await ctx.close();
  if (!owned) { try { await browser.close(); } catch {} }
  console.log("RESULT pass=" + pass + " fail=" + fail + " skip=" + skip);
  if (failures.length) console.log("FAILURES:\n" + failures.join("\n"));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("FATAL " + String(e).split("\n")[0].slice(0, 160)); process.exit(1); });
