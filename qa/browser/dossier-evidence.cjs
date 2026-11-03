"use strict";
/* ============================================================================
 * Muse QA-only author.
 * NEW regression: qa/browser/dossier-evidence.cjs (MAIN only).
 *
 * Narrow DossierView repair proof: the REAL React app is loaded from the
 * isolated Vite QA_WEB server (default http://127.0.0.1:5174). HTTP is
 * stubbed IN THIS FILE ONLY via page.route("**\/api\/**") with a tiny
 * faithful roster store whose researchJson carries camelCase AND PascalCase
 * refs with real excerpts, one empty-excerpt claim, and one unsafe-URL
 * claim. No live servers are started here; the parent runs this later
 * against its own QA_WEB (Vite :5174 -> disposable API :5099).
 *
 * Asserts (rendered DOM, real DossierView):
 *   1. actual nonempty excerpt text renders verbatim (camel + Pascal).
 *   2. readable citation title renders with a safe http(s) external link.
 *   3. same-URL sources+refs dedupe to ONE link per claim (no duplicates).
 *   4. no raw kind:ref dump ("[source:") renders anywhere.
 *   5. empty-excerpt claim is marked Unsupported and its claim text is
 *      NEVER manufactured into any div.excerpt block.
 *   6. unsafe javascript: URL never becomes an <a href>.
 *
 * Execution gate: updated App (DossierView excerpt repair) served on QA_WEB.
 * Until then: `node --check qa/browser/dossier-evidence.cjs` ONLY.
 *
 * Runtime contract: own CDP context on :9333 (QA_CDP), CPU only, no new
 * browser launch, never closes the shared remote browser (own page/context
 * only). Bounded timeouts everywhere; any breach exits nonzero.
 * Screenshots/logs under .tmp/qa-browser-dossier/ (best effort).
 * No fake passes, no skips.
 * ========================================================================== */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const CDP = process.env.QA_CDP || "http://127.0.0.1:9333";
const WEB = process.env.QA_WEB || "http://127.0.0.1:5174";
const OUT = ".tmp/qa-browser-dossier";
const T = { goto: 60000, step: 20000, overall: 240000 };

const ALPHA_URL = "https://qa.example/alpha";
const BETA_URL = "https://qa.example/beta";
const GAMMA_URL = "https://qa.example/gamma";
const ALPHA_EXCERPT = "QA alpha grounded excerpt 7f3a.";
const BETA_EXCERPT = "QA beta Pascal excerpt 9c2e.";
const EPSILON_EXCERPT = "QA epsilon excerpt with unsafe url.";
const GAMMA_TEXT = "QA unsupported claim gamma unique 4d1e.";

const DOSSIER = {
  subject: "Dossier evidence probe",
  supported: true,
  claims: [
    {
      angle: "pricing",
      text: "QA grounded claim alpha.",
      sources: [{ url: ALPHA_URL, title: "QA Alpha Source" }],
      refs: [{ kind: "source", ref: ALPHA_URL, url: ALPHA_URL, title: "QA Alpha Source", excerpt: ALPHA_EXCERPT }],
    },
    {
      Angle: "history",
      Text: "QA Pascal claim beta.",
      Sources: [{ Url: BETA_URL, Title: "QA Beta Source" }],
      Refs: [{ Kind: "source", Ref: BETA_URL, Url: BETA_URL, Title: "QA Beta Source", Excerpt: BETA_EXCERPT }],
    },
    {
      angle: "risk",
      text: GAMMA_TEXT,
      sources: [{ url: GAMMA_URL, title: "QA Gamma Source" }],
      refs: [{ kind: "source", ref: GAMMA_URL, url: GAMMA_URL, title: "QA Gamma Source", excerpt: "   " }],
    },
    {
      angle: "pricing",
      text: "QA duplicate claim delta.",
      sources: [{ url: ALPHA_URL, title: "QA Alpha Source" }],
      refs: [{ kind: "source", ref: ALPHA_URL, url: ALPHA_URL, title: "QA Alpha Source", excerpt: ALPHA_EXCERPT }],
    },
    {
      angle: "risk",
      text: "QA unsafe claim epsilon.",
      sources: [],
      refs: [{ kind: "source", ref: "javascript:alert(1)", url: "javascript:alert(1)", title: "Evil Title", excerpt: EPSILON_EXCERPT }],
    },
  ],
  note: "Probe dossier.",
};

const ENTRY_ID = "dossier-ev-1";
function row() {
  return {
    entry: {
      id: ENTRY_ID,
      accountId: "qa",
      type: 0,
      name: "Dossier Ev Advisor",
      description: "probe entry",
      profileJson: "{}",
      version: 1,
      archived: false,
      tags: "",
      updatedAt: "2026-11-02",
      researchedAt: "2026-11-02",
      researchRequested: true,
      evidenceCount: 2,
      researchJson: JSON.stringify(DOSSIER),
    },
    imageCount: 0,
    complete: true,
    missing: [],
    boards: [],
  };
}

async function fulfill(route) {
  const req = route.request();
  const method = req.method();
  const u = new URL(req.url());
  const p = u.pathname.replace(/\/+$/, "") || "/";
  const json = (status, obj) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });
  if (method === "GET" && (p === "/api/roster" || p === "/api/roster/count" || p === "/api/model/status")) {
    if (p === "/api/roster/count") return json(200, { total: 1 });
    if (p === "/api/model/status") return json(200, { configured: false, source: "", model: "fixture", chatOverride: "", keyHint: "", lastTestAt: null, lastTestOk: false, lastTestModel: "", lastTestError: "" });
    return json(200, [row()]);
  }
  if (method === "GET" && p === ("/api/roster/" + ENTRY_ID + "/images")) return json(200, []);
  if (method === "GET" && p === "/api/boards") return json(200, []);
  if (method === "GET") return json(200, []);
  return json(501, { error: "unhandled fixture path: " + method + " " + p });
}

let pass = 0, fail = 0;
const failures = [];
const consoleIssues = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
function watchdog() { console.log("TIMEOUT overall watchdog breached"); process.exit(1); }

(async () => {
  const timer = setTimeout(watchdog, T.overall);
  fs.mkdirSync(OUT, { recursive: true });
  let browser, ctx, page;
  async function shot(name) {
    try { await page.screenshot({ path: path.join(OUT, name + ".png") }); } catch (e) { /* diagnostics only */ }
  }
  try {
    browser = await chromium.connectOverCDP(CDP);
    ctx = await browser.newContext();
    page = await ctx.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      try { localStorage.setItem("simceo-fb-user-v2", "QA Dossier"); } catch (e) { /* ignore */ }
    });
    page.on("console", (m) => {
      const t = m.type();
      if (t !== "error" && t !== "warning") return;
      consoleIssues.push(t + ": " + (m.text() || "").slice(0, 300));
    });
    page.on("pageerror", (e) => consoleIssues.push("pageerror: " + String((e && e.message) || e).slice(0, 300)));
    await page.route("**/api/**", (route) => fulfill(route).catch((e) => route.abort().catch(() => {})));
    await page.goto(WEB, { waitUntil: "domcontentloaded", timeout: T.goto });
    await page.waitForFunction(() => document.body && document.body.innerText.length > 50, null, { timeout: T.step });
    ok("app-loads", true);
    await page.getByRole("button", { name: "Roster", exact: true }).click({ timeout: T.step });
    await page.locator('section[aria-label="My Advisor Roster"]').waitFor({ timeout: T.step });
    const entryBtn = page.locator(".listpanel-rows button", { hasText: "Dossier Ev Advisor" });
    await entryBtn.first().waitFor({ timeout: T.step });
    await entryBtn.first().click({ timeout: T.step });
    await page.getByRole("heading", { name: "Latest dossier" }).first().waitFor({ timeout: T.step });
    await shot("dossier-detail");
    const bodyText = await page.locator("body").innerText();
    ok("excerpt-alpha-renders", bodyText.includes(ALPHA_EXCERPT));
    ok("excerpt-beta-pascal-renders", bodyText.includes(BETA_EXCERPT));
    ok("excerpt-epsilon-renders", bodyText.includes(EPSILON_EXCERPT));
    ok("citation-title-alpha", bodyText.includes("QA Alpha Source"));
    ok("citation-title-beta", bodyText.includes("QA Beta Source"));
    ok("unsupported-marker", bodyText.includes("Unsupported — no excerpt in cited evidence."));
    ok("no-refdump", !bodyText.includes("[source:"), bodyText.slice(0, 200));
    const counts = await page.evaluate((args) => {
      const q = (sel) => Array.from(document.querySelectorAll(sel));
      const excerpts = q("div.excerpt").map((el) => el.textContent || "");
      const alphaLinks = q('a[href="' + args.alpha + '"]').length;
      const gammaLinks = q('a[href="' + args.gamma + '"]').length;
      const jsLinks = q('a[href^="javascript:"]').length;
      const alphaTargets = q('a[href="' + args.alpha + '"]').map((a) => a.getAttribute("target") + "|" + a.getAttribute("rel"));
      return { excerpts, alphaLinks, gammaLinks, jsLinks, alphaTargets };
    }, { alpha: ALPHA_URL, gamma: GAMMA_URL });
    ok("excerpt-blocks-present", counts.excerpts.length >= 3, String(counts.excerpts.length));
    ok("empty-does-not-manufacture", counts.excerpts.every((t) => !t.includes(GAMMA_TEXT)), counts.excerpts.join(" || ").slice(0, 300));
    ok("dedupe-alpha-one-link-per-claim", counts.alphaLinks === 2, "alphaLinks=" + counts.alphaLinks);
    ok("gamma-link-present", counts.gammaLinks === 1, "gammaLinks=" + counts.gammaLinks);
    ok("unsafe-never-linked", counts.jsLinks === 0, "jsLinks=" + counts.jsLinks);
    ok("safe-link-target", counts.alphaTargets.every((v) => v.indexOf("_blank") >= 0 && v.indexOf("noreferrer") >= 0), counts.alphaTargets.join(","));
    ok("no-console-issues", consoleIssues.length === 0, consoleIssues.slice(0, 3).join(" || "));
    await shot("dossier-asserted");
  } catch (e) {
    fail++;
    failures.push("threw: " + String((e && e.message) || e).slice(0, 400));
    console.log("  FAIL threw " + String((e && e.message) || e).slice(0, 400));
    try { if (page) await page.screenshot({ path: path.join(OUT, "fail.png") }); } catch (ee) { /* ignore */ }
  } finally {
    clearTimeout(timer);
    try { if (ctx) await ctx.close(); } catch (e) { /* ignore */ }
    console.log("dossier-evidence: pass=" + pass + " fail=" + fail);
    if (consoleIssues.length) console.log("consoleIssues: " + consoleIssues.slice(0, 5).join(" || "));
    if (failures.length) console.log("failures: " + failures.join(" || "));
    process.exit(fail ? 1 : 0);
  }
})();
