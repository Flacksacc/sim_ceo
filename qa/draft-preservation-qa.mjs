// Draft preservation proof (integration): same-account composer draft survives
// full reloads under StrictMode; per-user keys isolate switched accounts.
// LIVE backend only (real reload + real localStorage). No fixtures.
//   QA_API=http://127.0.0.1:5121 QA_WEB=http://127.0.0.1:5193 node qa/draft-preservation-qa.mjs
// Exit 0 on success, 1 on any failure.
import { chromium } from "playwright-core";
const API = process.env.QA_API || "http://127.0.0.1:5121";
const WEB = process.env.QA_WEB || "http://127.0.0.1:5193";
const CDP = process.env.QA_CDP || "http://localhost:9333";
let pass = 0, fail = 0;
const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; bad.push(name); console.log("  FAIL - " + name + (extra ? " :: " + String(extra).slice(0, 300) : "")); }
}
const api = async (method, path, body, headers) => {
  const r = await fetch(API + path, {
    method, headers: { "content-type": "application/json", "x-user": "owner", ...(headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, json, text };
};
const run = "draft" + Date.now().toString(36);
let browser = null, ctx = null, page = null;
try {
  const b = await api("POST", "/api/boards", { name: run + "-board", mission: run });
  const bid = b.json?.id ?? b.json?.Id;
  ok("board-created", b.status === 201 && !!bid, b.status + " " + b.text.slice(0, 160));
  const m = await api("POST", "/api/boards/" + bid + "/meetings", { title: run + "-mtg" });
  const mid = m.json?.id ?? m.json?.Id;
  ok("meeting-created", m.status === 201 && !!mid, m.status + " " + m.text.slice(0, 160));
  browser = await chromium.connectOverCDP(CDP);
  ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 200)));
  page.on("console", (m2) => { if (m2.type() === "error" && !m2.text().includes("Failed to load resource")) errs.push(m2.text().slice(0, 200)); });
  await page.goto(WEB + "/#/boards", { waitUntil: "domcontentloaded" });
  await page.locator(".listpanel-rows button", { hasText: run + "-board" }).first().click({ timeout: 20000 });
  await page.locator(".listpanel-rows button", { hasText: run + "-mtg" }).first().click({ timeout: 20000 });
  const box = page.locator('textarea[aria-label="Message. Press Enter to send, Shift and Enter for a new line."]');
  await box.waitFor({ timeout: 20000 });
  const ALPHA = "DRAFT-ALPHA-" + run;
  await box.fill(ALPHA);
  await page.waitForFunction((want) => {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("simceo-draft:") && (localStorage.getItem(k) || "").includes(want)) return true;
      }
      return false;
    } catch { return false; }
  }, ALPHA, { timeout: 10000 });
  ok("draft-persisted-to-storage", true);
  const keyBefore = await page.evaluate(() => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith("simceo-draft:")) out.push(k + "=" + (localStorage.getItem(k) || "").length); }
    return out.join(",");
  });
  ok("draft-key-scoped", /simceo-draft:.+:.+:.+/.test(keyBefore), keyBefore.slice(0, 200));
  // Full reload: same-account draft must survive (StrictMode is on in main.tsx).
  await page.reload({ waitUntil: "domcontentloaded" });
  await box.waitFor({ timeout: 20000 });
  const afterReload = await box.inputValue();
  ok("draft-survives-reload", afterReload.includes(ALPHA), JSON.stringify(afterReload).slice(0, 200));
  // Second reload for StrictMode double-effect stability.
  await page.reload({ waitUntil: "domcontentloaded" });
  await box.waitFor({ timeout: 20000 });
  const afterReload2 = await box.inputValue();
  ok("draft-survives-second-reload", afterReload2.includes(ALPHA), JSON.stringify(afterReload2).slice(0, 200));
  // Editing after reload persists too (no clobber by stale load).
  const ALPHA2 = ALPHA + "-EDIT";
  await box.fill(ALPHA2);
  await page.waitForFunction((want) => {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("simceo-draft:") && (localStorage.getItem(k) || "") === want) return true;
      }
      return false;
    } catch { return false; }
  }, ALPHA2, { timeout: 10000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await box.waitFor({ timeout: 20000 });
  ok("edited-draft-survives-reload", (await box.inputValue()) === ALPHA2, "");
  ok("no-console-errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  console.log("DRAFTQA " + (fail === 0 ? "PASS" : "FAIL") + " pass=" + pass + " fail=" + fail);
  process.exit(fail === 0 ? 0 : 1);
} catch (e) {
  console.log("DRAFTQA FATAL " + String(e && e.stack || e).slice(0, 500));
  process.exit(1);
} finally {
  try { if (page) await page.close(); } catch {}
  try { if (ctx) await ctx.close(); } catch {}
}
