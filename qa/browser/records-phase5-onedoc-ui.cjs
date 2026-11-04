"use strict";
// Records Phase 5 one-document review UI proof (Muse-authored, primary executes).
// Real compiled SPA on QA_WEB plus real isolated API on QA_API. Launches its
// OWN headless Edge via playwright-core; never touches shared CDP 9333.
// Run-scoped bears6-* identity and boards only; touches nothing else.
// Exit nonzero on any failure. No skips except an already-decided snapshot.
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("path");
const crypto = require("node:crypto");

const API = process.env.QA_API || "http://127.0.0.1:15320";
const WEB = process.env.QA_WEB || "http://127.0.0.1:15321";
for (const [nm, v] of [["QA_API", API], ["QA_WEB", WEB]]) {
  let u;
  try { u = new URL(v); } catch { console.error("REFUSE bad " + nm + ": " + v); process.exit(2); }
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") { console.error("REFUSE non-loopback " + nm + ": " + v); process.exit(2); }
  if (/:5080|:5173|:9333/.test(v)) { console.error("REFUSE reserved port " + nm + ": " + v); process.exit(2); }
}
const OUT = process.env.QA_SHOTS || ".tmp/records-phase5-shots";
const T = { goto: 60000, step: 20000, poll: 20000, overall: 600000 };
fs.mkdirSync(OUT, { recursive: true });
const EDGE_PATHS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const EDGE = EDGE_PATHS.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!EDGE) { console.error("REFUSE no Edge binary found; install Edge, do not substitute another browser silently."); process.exit(2); }
let pass = 0, fail = 0;
const failures = [];
const consoleErrors = [];
function ok(name, cond, extra) {
  if (cond) { pass++; /* console.log("  ok " + name); */ }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
async function api(method, p, body, user) {
  const r = await fetch(API + p, {
    method,
    headers: { "content-type": "application/json", "x-user": user || owner },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, json, text };
}
const run = "bears6-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
const owner = run + "-owner";
let browser, ctx, page;
const postLog = [];
async function bodyHas(s) { return (await page.locator("body").innerText()).includes(s); }
async function shot(name) { await page.screenshot({ path: path.join(OUT, name + ".png") }); }
async function approveButtonsFullDom() {
  return await page.locator("button").filter({ hasText: /^Approve / }).count();
}
const watchdog = setTimeout(() => { console.log("OVERALL WATCHDOG"); process.exit(3); }, T.overall);
async function main() {
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => { consoleErrors.push("pageerror: " + String(e).slice(0, 300)); });
  page.on("response", (r) => {
    try {
      const q = r.request();
      if (q.method() === "POST" && /\/api\/records\//.test(q.url())) postLog.push({ url: new URL(q.url()).pathname, status: r.status() });
    } catch {}
  });
  await page.goto(WEB, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body && document.body.innerText.length > 50, null, { timeout: T.goto });
  ok("app-loads", true);
  const board = await api("POST", "/api/boards", { name: run + "-board", mission: run + " mission", stage: "qa" });
  ok("seed-board", board.status === 201 && board.json.id, String(board.status));
  const bid = board.json.id;
  const mtg = await api("POST", "/api/boards/" + bid + "/meetings", { title: run + " meet", brief: run + " brief" });
  const mid = mtg.json.id;
  await api("POST", "/api/meetings/" + mid + "/messages", { sender: "lead", content: "Bears opening drive memo" });
  await api("POST", "/api/meetings/" + mid + "/notes", { title: "Bears working note", body: "bears provisional note alpha", kind: "note" });
  const sec = await api("POST", "/api/meetings/" + mid + "/secretary", { input: "Bears context with SECRETARY-NOTE", clientNonce: crypto.randomBytes(8).toString("hex") });
  ok("seed-secretary-note", sec.status === 200 && sec.json && sec.json.note, String(sec.status));
  const d1 = await api("POST", "/api/meetings/" + mid + "/record/draft", [
    { id: "QA", text: "Bears UI approve alpha" },
    { id: "QB", text: "Bears UI pending beta" },
    { id: "QC", text: "Bears UI discard gamma" },
  ]);
  ok("seed-draft", d1.status === 201 && d1.json.id, String(d1.status));
  const did = d1.json.id;
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + did, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("Review v1"), null, { timeout: T.poll });
  await shot("onedoc-full");
  ok("one-doc-review", await bodyHas("Review v1") && await bodyHas("Bears UI approve alpha"), "one-document review missing");
  ok("one-doc-counts", await bodyHas("3 waiting"), "decision counts missing");
  ok("one-doc-pending", await bodyHas("Decisions waiting for review"), "pending section missing");
  ok("one-doc-per-item", (await page.getByRole("button", { name: "Approve QA" }).count()) === 1 && (await page.getByRole("button", { name: "Discard QC" }).count()) === 1, "per-item controls missing");
  ok("one-doc-revise-label", (await page.getByLabel("Revised text for QB").count()) === 1, "per-item revise input missing");
  ok("one-doc-notes", await bodyHas("Working notes") && await bodyHas("Secretary provisional note") && await bodyHas("bears provisional note alpha"), "notes section/labels missing");
  ok("one-doc-recent", await bodyHas("Recent meeting input") && await bodyHas("Bears opening drive memo"), "recent input missing");
  ok("one-doc-version", await bodyHas("Version history") && await bodyHas("recorded decision"), "version context missing");
  ok("one-doc-no-protocol-leak", !(await bodyHas("reviewToken")) && !(await bodyHas("evidenceSnapshot")), "protocol internals rendered");
  // per-item revise QB via REAL UI input + button
  await page.getByLabel("Revised text for QB").first().fill("Bears UI revised beta", { timeout: T.step });
  await page.getByRole("button", { name: "Revise QB" }).first().click({ timeout: T.step });
  await page.waitForFunction(() => document.body.innerText.includes("Bears UI revised beta"), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(1200);
  ok("ui-revise-QB", await bodyHas("Bears UI revised beta"), "revised text missing");
  const rev1 = await api("GET", "/api/records/" + did + "/review");
  ok("api-revise-kept-pending", (rev1.json.pending || []).includes("QB") && (rev1.json.approved || []).length === 0, JSON.stringify(rev1.json.pending));
  ok("ui-history-shows-revise", await bodyHas("Decision history") && await bodyHas("Revised"), "per-item history missing");
  // per-item discard QC via REAL UI button
  await page.getByRole("button", { name: "Discard QC" }).first().click({ timeout: T.step });
  await page.waitForTimeout(1500);
  const rev2 = await api("GET", "/api/records/" + did + "/review");
  ok("api-discard-QC", (rev2.json.discarded || []).includes("QC") && JSON.stringify([...rev2.json.pending].sort()) === JSON.stringify(["QA", "QB"]), JSON.stringify(rev2.json.pending));
  // per-item approve QA via REAL UI button
  await page.getByRole("button", { name: "Approve QA" }).first().click({ timeout: T.step });
  await page.waitForFunction(() => document.body.innerText.includes("Approved QA"), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(1200);
  const rev3 = await api("GET", "/api/records/" + did + "/review");
  ok("api-approve-QA", (rev3.json.approved || []).includes("QA"), JSON.stringify(rev3.json.approved));
  // approve-all via REAL UI button; then NO approval controls anywhere
  await page.getByRole("button", { name: /Approve all/ }).first().click({ timeout: T.step });
  await page.waitForTimeout(2000);
  const rev4 = await api("GET", "/api/records/" + did + "/review");
  ok("api-all-decided", (rev4.json.pending || []).length === 0 && (rev4.json.approved || []).length === 2 && (rev4.json.discarded || []).length === 1, JSON.stringify({ p: rev4.json.pending, a: rev4.json.approved, d: rev4.json.discarded }));
  ok("ui-all-decided-no-approve", (await approveButtonsFullDom()) === 0, "approval controls present after decide");
  await shot("onedoc-decided");
  await page.reload({ waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("Review v1"), null, { timeout: T.poll });
  await page.waitForTimeout(800);
  ok("ui-reload-no-approve", (await approveButtonsFullDom()) === 0, "approval controls after reload");
  // ---- 409 conflict + explicit refresh on a fresh draft ----
  const d2 = await api("POST", "/api/meetings/" + mid + "/record/draft", [
    { id: "S1", text: "Bears stale one" },
    { id: "S2", text: "Bears stale two" },
  ]);
  const sid = d2.json.id;
  const g0 = await api("GET", "/api/records/" + sid);
  const g0g = { version: g0.json.version, hash: g0.json.hash, reviewToken: g0.json.reviewToken, watermark: g0.json.watermark };
  await api("POST", "/api/records/" + sid + "/items/revise", { ...g0g, itemId: "S1", text: "Bears other-client revision" });
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + sid, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("Bears stale two"), null, { timeout: T.poll });
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Approve S2" }).first().click({ timeout: T.step }).catch(() => null);
  await page.waitForFunction(() => document.body.innerText.includes("No automatic retry"), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(1200);
  ok("ui-409-guided", await bodyHas("Refresh review") && await bodyHas("No automatic retry"), "guided 409 missing");
  await shot("onedoc-409");
  await api("POST", "/api/meetings/" + mid + "/messages", { sender: "lead", content: "Bears fresh input" });
  await page.getByRole("button", { name: "Refresh review" }).first().click({ timeout: T.step });
  await page.waitForFunction(() => document.body.innerText.includes("refreshed to current"), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(1500);
  ok("ui-refresh-reloads", await bodyHas("Bears other-client revision"), "fresh authority not reloaded");
  await page.getByRole("button", { name: "Approve S2" }).first().click({ timeout: T.step });
  await page.waitForFunction(() => document.body.innerText.includes("Approved S2"), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(1200);
  const revS = await api("GET", "/api/records/" + sid + "/review");
  ok("ui-deliberate-approve", (revS.json.approved || []).includes("S2"), JSON.stringify(revS.json.approved));
  // ---- supersession: branch v2 via API, navigate in-app ----
  const sg = await api("GET", "/api/records/" + sid);
  const br = await api("POST", "/api/records/" + sid + "/revise", {
    version: sg.json.version, hash: sg.json.hash, reviewToken: sg.json.reviewToken, watermark: sg.json.watermark,
    items: [{ id: "S1", text: "Bears other-client revision" }, { id: "S2", text: "Bears stale two v2" }],
  });
  ok("branch-v2", (br.status === 201 || br.status === 200) && br.json.id, String(br.status));
  const nid = br.json.id;
  await page.reload({ waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("Review v"), null, { timeout: T.poll });
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Version 2" }).first().click({ timeout: T.step });
  await page.waitForTimeout(1500);
  ok("ui-v2-shows-predecessor", await bodyHas("Open version 1"), "predecessor navigation missing on v2");
  await shot("onedoc-v2");
  await page.getByRole("button", { name: "Open version 1" }).first().click({ timeout: T.step });
  await page.waitForTimeout(1500);
  ok("ui-v1-shows-successor", await bodyHas("Open version 2") || await bodyHas("A newer version replaced this review"), "successor context missing on v1");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  const themeBtn = page.getByRole("button", { name: /Switch to dark/ }).first();
  if (await themeBtn.count() > 0) { await themeBtn.click({ timeout: T.step }); await page.waitForTimeout(800); }
  await shot("onedoc-narrow-dark");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("narrow-no-overflow", overflow <= 1, "overflow=" + overflow);
  ok("no-console-errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
}
main().then(async () => {
  clearTimeout(watchdog);
  console.log("[records5-onedoc-ui] pass=" + pass + " fail=" + fail);
  try { await ctx.close(); } catch {}
  try { await browser.close(); } catch {}
  if (fail > 0) { console.log("FAILURES:\n" + failures.join("\n")); process.exit(1); }
}).catch(async (e) => {
  clearTimeout(watchdog);
  console.log("FATAL " + String(e).slice(0, 500));
  try { await browser.close(); } catch {}
  process.exit(2);
});
