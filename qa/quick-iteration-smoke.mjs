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
// Own isolated context in all modes. Cleanup: owned headless Edge closes in
// finally; shared CDP connection never closes (only our context does).
// Exit 0 = every executed check passed (SKIPs only for genuinely absent data).
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
const absentProfileResponses = new Set();
const consoleErrs = [];
const nonGet = new Set();
const hashOf = (page) => page.evaluate(() => window.location.hash);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function main() {
  let browser = null, owned = false, ctx = null;
  try {
    if (CDP) {
      browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
      owned = false;
    } else {
      browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-first-run"] });
      owned = true;
    }
    // Own isolated context: fresh storage, discarded on close. Never the user profile.
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    page.on("response", (r) => {
      if (r.status() === 404 && r.request().method() === "GET" && r.url() === WEB + "/api/profile") {
        absentProfileResponses.add(r.url());
        console.log("EXPECTED-EMPTY-PROFILE GET /api/profile 404");
      } else if (r.status() >= 400) pageErrs.push("HTTP " + r.status() + " " + new URL(r.url()).pathname);
    });
    page.on("pageerror", (e) => pageErrs.push(String(e).split("\n")[0].slice(0, 120)));
    page.on("console", (m) => { if (m.type() === "error") consoleErrs.push({ text: m.text(), url: m.location().url }); });
    page.on("request", (r) => {
      const m = r.method();
      if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
        const u = r.url();
        if (!/hub|negotiate/i.test(u)) nonGet.add(m + " " + u.slice(0, 60));
      }
    });
    const rail = (name) => page.locator("nav.rail").getByRole("button", { name, exact: true });
    const section = (label) => page.locator('main section[aria-label="' + label + '"]');
    // Fingerprint textarea values as length:hash only (never log contents).
    const snapFn = () => {
      const els = [...document.querySelectorAll('main section[aria-label="Profile"] label textarea')];
      const h = (s) => { let x = 0; for (let i = 0; i < s.length; i++) x = ((x * 31 + s.charCodeAt(i)) | 0); return (x >>> 0).toString(36); };
      return els.map((el) => el.value.length + ":" + h(el.value));
    };
    console.log("quick-iteration smoke run=" + run + " web=" + WEB + " via=" + (CDP ? "existing-cdp-own-context" : "own-headless-edge"));

    await page.goto(WEB + "/", { waitUntil: "domcontentloaded" });
    await page.locator("main section .card").first().waitFor({ timeout: 20000 });

    // ---------- Board first: profile lead is board-scoped ----------
    const boardBtns = page.locator(".listpanel-rows button");
    await boardBtns.first().waitFor({ timeout: 15000 }).catch(() => null);
    const boardN = await boardBtns.count();
    ok("board-list-present", boardN > 0);
    if (boardN === 0) {
      skipLine("profile-textareas", "no boards in backend");
      skipLine("meeting-new-labels", "no boards in backend");
    } else {
      await boardBtns.first().click();
      await page.waitForFunction(() => /board=/.test(window.location.hash), null, { timeout: 8000 }).catch(() => {});
      ok("board-select-writes-hash", /board=/.test(await hashOf(page)));

      // ---------- Profile: 4 paragraph controls ----------
      const leadWait = page.waitForResponse(/\/api\/boards\/[^/]+\/lead/, { timeout: 15000 }).catch(() => null);
      await rail("Profile").click();
      await section("Profile").waitFor({ timeout: 10000 });
      ok("profile-section-visible", await section("Profile").isVisible());
      await leadWait;
      const prof = section("Profile");
      const labels = ["Background", "Subjects already familiar", "Subjects needing simpler explanation", "Communication preferences"];
      await prof.getByLabel(labels[0]).first().waitFor({ timeout: 10000 }).catch(() => null);
      for (const label of labels) {
        ok("profile-control-present:" + label, await prof.getByLabel(label).count() === 1);
      }
      const tags = await prof.evaluate((root) => {
        const out = [];
        for (const el of root.querySelectorAll("label textarea, label input")) out.push(el.tagName + ":" + (el.getAttribute("rows") || "-"));
        return out;
      });
      const roomy = tags.filter((t) => t.startsWith("TEXTAREA:"));
      ok("profile-four-textareas", roomy.length === 4);
      ok("profile-textarea-rows", roomy.length === 4 && roomy.every((t) => Number(t.split(":")[1]) >= 3));
      const heights = await prof.evaluate((root) => {
        const out = [];
        for (const el of root.querySelectorAll("label textarea")) out.push(Math.round(el.getBoundingClientRect().height));
        return out;
      });
      ok("profile-textarea-roomy-height", heights.length === 4 && heights.every((h) => h >= 60));
      await page.screenshot({ path: path.join(SHOTDIR, "qi-profile-1440.png") });

      const snap0 = await page.evaluate(snapFn);
      const customPresent = snap0.length === 4 && snap0[3] !== DEFAULT_FP && Number(snap0[3].split(":")[0]) > 0;

      // Local multiline input without saving (no Save click anywhere in this script).
      const comm = prof.getByLabel("Communication preferences");
      await comm.focus();
      await comm.press("End");
      await page.keyboard.insertText("\nlocal-qa-line");
      ok("profile-multiline-local-newline", await comm.evaluate((el) => el.value.includes("\n")));

      // Reload: unsaved keystrokes vanish (read-only proof); wait for the actual
      // lead GET (not a fixed sleep) before comparing restored values.
      const leadWait2 = page.waitForResponse(/\/api\/boards\/[^/]+\/lead/, { timeout: 15000 }).catch(() => null);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator("main section .card").first().waitFor({ timeout: 20000 });
      await rail("Profile").click();
      await section("Profile").waitFor({ timeout: 10000 });
      await leadWait2;
      const snap1 = await page.evaluate(snapFn);
      ok("profile-prefs-stable-across-reload", snap0.length === 4 && JSON.stringify(snap0) === JSON.stringify(snap1));
      if (customPresent) ok("profile-custom-prefs-preserved", JSON.stringify(snap0) === JSON.stringify(snap1));
      else skipLine("profile-custom-prefs-preserved", "no saved/custom lead content in this backend state");

      // ---------- Meeting actions: new labels + helpers, old labels absent ----------
      await rail("Meetings").click();
      await page.locator("ol.agenda, .listpanel-rows").first().waitFor({ timeout: 15000 });
      const hMeet = await hashOf(page);
      ok("meet-destination-board-context", hMeet.includes("/meet") && hMeet.includes("board="));
      await page.waitForFunction(() => document.querySelectorAll("ol.agenda button").length > 0, null, { timeout: 10000 }).catch(() => null);
      const agendaN = await page.locator("ol.agenda button").count();
      if (agendaN === 0) {
        skipLine("meeting-new-labels", "selected board has no meetings");
        skipLine("meeting-old-labels-absent", "selected board has no meetings");
        skipLine("meeting-helper-text", "selected board has no meetings");
      } else {
        await page.locator("ol.agenda button").first().click();
        await page.waitForFunction(() => /meeting=/.test(window.location.hash), null, { timeout: 8000 }).catch(() => {});
        ok("meeting-select-writes-hash", /meeting=/.test(await hashOf(page)));
        ok("meeting-heading-renders", await page.locator('section[aria-label="Meetings and conversation"] h2').count() > 0);
        ok("meeting-new-meeting-label", await page.getByRole("button", { name: "New meeting", exact: true }).count() >= 1);
        ok("meeting-request-label", await page.getByRole("button", { name: "Request advisor responses", exact: true }).count() >= 1);
        ok("meeting-old-start-absent", await page.getByRole("button", { name: "Start meeting", exact: true }).count() === 0);
        ok("meeting-old-run-absent", await page.getByRole("button", { name: "Run discussion", exact: true }).count() === 0);
        ok("meeting-helper-new", await page.getByText("New meeting starts a separate conversation. Creating one never asks the advisors anything.", { exact: true }).count() >= 1);
        ok("meeting-helper-request", await page.getByText(/Asks the advisors in the current meeting/).count() >= 1);
        await page.screenshot({ path: path.join(SHOTDIR, "qi-meet-1440.png") });
      }
    }

    // Records navigation and help must work on the actual deployed build.
    await rail("Records").click();
    await section("Records").waitFor({ timeout: 10000 });
    ok("records-destination", (await hashOf(page)).includes("/records"));
    ok("records-plain-language-help", await section("Records").getByText(/Approval always checks that you are reviewing the latest meeting input/).count() === 1);
    ok("records-no-technical-help", !(await section("Records").innerText()).includes("hash + watermark"));

    // ---------- Overflow: 1440 + 390, read-only ----------
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(500);
    ok("no-overflow-1440", await noOverflow(page));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    ok("no-overflow-390", await noOverflow(page));
    await page.screenshot({ path: path.join(SHOTDIR, "qi-390.png") });

    // ---------- Read-only + error report ----------
    console.log("non-get-requests=" + nonGet.size);
    ok("no-api-mutations", nonGet.size === 0);
    // A missing account default is the endpoint's intentional empty state.
    // Exempt only its confirmed GET 404 resource console message; retain all
    // JavaScript exceptions and every other HTTP/console failure.
    for (const e of consoleErrs) {
      if (!(absentProfileResponses.has(e.url) && /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/.test(e.text))) {
        pageErrs.push("console: " + e.text.slice(0, 120));
      }
    }
    console.log("page-errors=" + pageErrs.length);
    for (const pageErr of pageErrs) console.log("PAGE-ERROR " + String(pageErr).slice(0, 400));
    ok("no-page-errors", pageErrs.length === 0);

    console.log("RESULT pass=" + pass + " fail=" + fail + " skip=" + skip);
    if (failures.length) console.log("FAILURES:\n" + failures.join("\n"));
    process.exitCode = fail ? 1 : 0;
  } finally {
    // Shared CDP connection is never closed; only our own context is.
    if (ctx) { try { await ctx.close(); } catch {} }
    if (owned && browser) { try { await browser.close(); } catch {} }
  }
}

main().catch((e) => { console.error("FATAL " + String(e).split("\n")[0].slice(0, 160)); process.exit(1); });
