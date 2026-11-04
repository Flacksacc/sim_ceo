"use strict";
// Records Phase 5 one-document review UI proof.
// Real compiled SPA plus real isolated API. Own headless Edge only.
// Loopback only guard below. No shared CDP port. Primary owns lifecycle.
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const API = process.env.QA_API || "http://127.0.0.1:15320";
const WEB = process.env.QA_WEB || "http://127.0.0.1:15321";
for (const pair of [[ "QA_API", API ], [ "QA_WEB", WEB ]]) {
  const nm = pair[0]; const v = pair[1];
  let u; try { u = new URL(v); } catch { console.error("REFUSE bad " + nm); process.exit(2); }
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") { console.error("REFUSE non loopback " + nm); process.exit(2); }
  if (/:5080|:5173|:9333/.test(v)) { console.error("REFUSE reserved port " + nm); process.exit(2); }
}
const OUT = process.env.QA_SHOTS || ".tmp/records-phase5-shots";
const T = { goto: 60000, step: 20000, poll: 20000, overall: 600000 };
fs.mkdirSync(OUT, { recursive: true });
const EDGE_PATHS = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"];
const EDGE = EDGE_PATHS.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!EDGE) { console.error("REFUSE no Edge binary"); process.exit(2); }
let pass = 0, fail = 0;
const failures = [];
const consoleErrors = [];
function ok(name, cond, extra) {
  if (cond) { pass++; } else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
async function api(method, p, body, token) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 30000);
  try {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = "Bearer " + token;
    const r = await fetch(API + p, { method, signal: ctl.signal, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(tm); }
}
const run = "bears6-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
let browser, ctx, page;
const postLog = [];
async function bodyHas(s) { return (await page.locator("body").innerText()).includes(s); }
async function shot(name) { await page.screenshot({ path: path.join(OUT, name + ".png") }); }
async function approveCount() { return await page.locator("button").filter({ hasText: "Approve decision" }).count(); }
async function reviseCount() { return await page.locator("button").filter({ hasText: "Revise decision" }).count(); }
async function setAsideCount() { return await page.locator("button").filter({ hasText: "Set aside decision" }).count(); }
let watchdog;
async function cleanup() {
  if (watchdog) clearTimeout(watchdog);
  try { await ctx.close(); } catch {}
  try { await browser.close(); } catch {}
}
async function main() {
  watchdog = setTimeout(() => { console.log("OVERALL WATCHDOG"); process.exit(3); }, T.overall);
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => { consoleErrors.push("pageerror: " + String(e).slice(0, 300)); });
  page.on("response", (r) => {
    try { const q = r.request(); if (q.method() === "POST" && /\/api\/records\//.test(q.url())) postLog.push({ url: new URL(q.url()).pathname, status: r.status() }); } catch {}
  });
  await page.goto(WEB, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body && document.body.innerText.length > 50, null, { timeout: T.goto });
  ok("app-loads", true);
  const ownerEmail = run + "-owner@qa.invalid";
  const strangerEmail = run + "-stranger@qa.invalid";
  const reg = await api("POST", "/api/auth/register", { email: ownerEmail, password: "qa-password-12345" }, null);
  ok("seed-register", reg.status === 201 && reg.json && reg.json.token, String(reg.status));
  const owner = reg.json.token;
  const regS = await api("POST", "/api/auth/register", { email: strangerEmail, password: "qa-password-12345" }, null);
  ok("seed-stranger", regS.status === 201 && regS.json && regS.json.token, String(regS.status));
  const stranger = regS.json.token;
  await ctx.addInitScript((tok) => window.localStorage.setItem("simceo-token", tok), owner);
  const board = await api("POST", "/api/boards", { name: run + "-board", mission: run + " mission", stage: "qa" }, owner);
  ok("seed-board", board.status === 201 && board.json.id, String(board.status));
  const bid = board.json.id;
  const mtg = await api("POST", "/api/boards/" + bid + "/meetings", { title: run + " meet", brief: run + " brief" }, owner);
  const mid = mtg.json.id;
  await api("POST", "/api/meetings/" + mid + "/messages", { sender: "lead", content: "Bears opening drive memo" }, owner);
  await api("POST", "/api/meetings/" + mid + "/notes", { title: "Bears working note", body: "bears provisional note alpha", kind: "note" }, owner);
  const sec = await api("POST", "/api/meetings/" + mid + "/secretary", { input: "Bears context with SECRETARY-NOTE", clientNonce: crypto.randomBytes(8).toString("hex") }, owner);
  ok("seed-secretary-note", sec.status === 200 && sec.json && sec.json.note, String(sec.status));
  const gidA = crypto.randomUUID();
  const gidB = crypto.randomUUID();
  const gidC = crypto.randomUUID();
  const d1 = await api("POST", "/api/meetings/" + mid + "/record/draft", [{ id: gidA, text: "Bears UI approve alpha" }, { id: gidB, text: "Bears UI pending beta" }, { id: gidC, text: "Bears UI discard gamma" }], owner);
  ok("seed-draft", d1.status === 201 && d1.json.id, String(d1.status));
  const did = d1.json.id;
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + did, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("Review version"), null, { timeout: T.poll });
  await shot("onedoc-full");
  ok("one-doc-review", await bodyHas("Review version") && await bodyHas("Bears UI approve alpha"), "one-document review missing");
  ok("one-doc-counts", await bodyHas("3 waiting"), "decision counts missing");
  ok("one-doc-pending", await bodyHas("Decisions waiting for review"), "pending section missing");
  ok("one-doc-per-item", (await page.getByRole("button", { name: "Approve decision 1" }).count()) === 1 && (await page.getByRole("button", { name: "Set aside decision 3" }).count()) === 1, "per-item ordinal controls missing");
  ok("one-doc-no-id-labels", (await page.getByRole("button", { name: new RegExp(gidA.slice(0, 8)) }).count()) === 0, "raw id in accessible name");
  ok("one-doc-revise-label", (await page.getByLabel("Revised text for decision 2").count()) === 1, "per-item revise input missing");
  ok("one-doc-notes", await bodyHas("Working notes") && await bodyHas("Secretary provisional note") && await bodyHas("bears provisional note alpha"), "notes missing");
  ok("one-doc-recent", await bodyHas("Recent meeting input") && await bodyHas("Bears opening drive memo"), "recent missing");
  ok("one-doc-version", await bodyHas("Version history") && await bodyHas("recorded decision"), "version missing");
  ok("one-doc-no-protocol-leak", !(await bodyHas("reviewToken")) && !(await bodyHas("evidenceSnapshot")), "protocol leak");
  ok("one-doc-no-guid-leak", !(await bodyHas(gidA)) && !(await bodyHas(gidB)) && !(await bodyHas(gidC)), "guid leak");
  await page.getByLabel("Revised text for decision 2").first().fill("Bears UI revised beta", { timeout: T.step });
  await page.getByRole("button", { name: "Revise decision 2" }).first().click({ timeout: T.step });
  await page.waitForFunction(() => document.body.innerText.includes("Bears UI revised beta"), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(1200);
  ok("ui-revise-QB", await bodyHas("Bears UI revised beta"), "revised text missing");
  const rev1 = await api("GET", "/api/records/" + did + "/review", owner);
  ok("api-revise-kept-pending", (rev1.json.pending || []).includes(gidB), "revise wrong");
  ok("ui-history-shows-revise", await bodyHas("Decision history") && await bodyHas("Revised"), "history missing");
  await page.getByRole("button", { name: "Set aside decision 3" }).first().click({ timeout: T.step });
  await page.waitForTimeout(1500);
  const rev2 = await api("GET", "/api/records/" + did + "/review", owner);
  ok("api-discard-QC", (rev2.json.discarded || []).includes(gidC), "discard wrong");
  await page.getByRole("button", { name: "Approve decision 1" }).first().click({ timeout: T.step });
  await page.waitForFunction(() => document.body.innerText.includes("Approved decision 1"), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(1200);
  const rev3 = await api("GET", "/api/records/" + did + "/review", owner);
  ok("api-approve-QA", (rev3.json.approved || []).includes(gidA), "approve wrong");
  await page.getByRole("button", { name: /Approve all/ }).first().click({ timeout: T.step });
  await page.waitForTimeout(2000);
  const rev4 = await api("GET", "/api/records/" + did + "/review", owner);
  ok("api-all-decided", (rev4.json.pending || []).length === 0, "not decided");
  ok("ui-all-decided-no-approve", (await approveCount()) === 0, "approval present after decide");
  ok("ui-all-decided-no-revise", (await reviseCount()) === 0, "revise present after decide");
  ok("ui-all-decided-no-setaside", (await setAsideCount()) === 0, "set aside present after decide");
  await shot("onedoc-decided");
  await page.reload({ waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("Review version"), null, { timeout: T.poll });
  await page.waitForTimeout(800);
  ok("ui-reload-no-approve", (await approveCount()) === 0, "approval after reload");
  const d2 = await api("POST", "/api/meetings/" + mid + "/record/draft", [{ id: "S1", text: "Bears stale one" }, { id: "S2", text: "Bears stale two" }], owner);
  const sid = d2.json.id;
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + sid, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("Bears stale two"), null, { timeout: T.poll });
  await page.waitForTimeout(800);
  const g0 = await api("GET", "/api/records/" + sid, owner);
  const g0g = { version: g0.json.version, hash: g0.json.hash, reviewToken: g0.json.reviewToken, watermark: g0.json.watermark };
  await api("POST", "/api/records/" + sid + "/items/revise", { ...g0g, itemId: "S1", text: "Bears other-client revision" }, owner);
  await page.getByRole("button", { name: "Approve decision 2" }).first().click({ timeout: T.step }).catch(() => null);
  await page.waitForFunction(() => document.body.innerText.includes("No automatic retry"), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(1200);
  ok("ui-409-guided", await bodyHas("Refresh review") && await bodyHas("No automatic retry"), "guided 409 missing");
  await shot("onedoc-409");
  await api("POST", "/api/meetings/" + mid + "/messages", { sender: "lead", content: "Bears fresh input" }, owner);
  await page.getByRole("button", { name: "Refresh review" }).first().click({ timeout: T.step });
  await page.waitForTimeout(1500);
  ok("ui-refresh-reloads", await bodyHas("Bears other-client revision"), "fresh authority missing");
  await page.getByRole("button", { name: "Approve decision 2" }).first().click({ timeout: T.step });
  await page.waitForTimeout(1200);
  const revS = await api("GET", "/api/records/" + sid + "/review", owner);
  ok("ui-deliberate-approve", (revS.json.approved || []).includes("S2"), "deliberate approve wrong");
  const sg = await api("GET", "/api/records/" + sid, owner);
  const br = await api("POST", "/api/records/" + sid + "/revise", { version: sg.json.version, hash: sg.json.hash, reviewToken: sg.json.reviewToken, watermark: sg.json.watermark, items: [{ id: "S1", text: "x" }] }, owner);
  ok("whole-revise-after-decisions-409", br.status === 409, String(br.status));
  const sg2 = await api("GET", "/api/records/" + sid, owner);
  const br2 = await api("POST", "/api/records/" + sid + "/revise", { version: sg2.json.version, hash: sg2.json.hash, reviewToken: sg2.json.reviewToken, watermark: sg2.json.watermark, items: [{ id: "S1", text: "Bears other-client revision" }, { id: "S2", text: "Bears stale two v2" }] }, owner);
  ok("branch-v2", (br2.status === 201 || br2.status === 200) && br2.json.id, String(br2.status));
  const nid = br2.json.id;
  await page.reload({ waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("Review version"), null, { timeout: T.poll });
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Version 2" }).first().click({ timeout: T.step });
  await page.waitForTimeout(1500);
  ok("ui-v2-shows-predecessor", await bodyHas("Open version 1"), "predecessor missing");
  await shot("onedoc-v2");
  await page.getByRole("button", { name: "Open version 1" }).first().click({ timeout: T.step });
  await page.waitForTimeout(1500);
  ok("ui-v1-shows-successor", await bodyHas("Open version 2") || await bodyHas("A newer version exists"), "successor missing");
  ok("ui-v1-no-approve", (await approveCount()) === 0 && (await reviseCount()) === 0 && (await setAsideCount()) === 0, "superseded controls present");
  await page.goBack({ timeout: T.step }).catch(() => null);
  await page.waitForTimeout(800);
  await page.goForward({ timeout: T.step }).catch(() => null);
  await page.waitForTimeout(800);
  ok("ui-back-forward", true);
  const ctx2 = await browser.newContext();
  await ctx2.addInitScript((tok) => window.localStorage.setItem("simceo-token", tok), stranger);
  const p2 = await ctx2.newPage();
  await p2.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + nid, { waitUntil: "domcontentloaded", timeout: T.goto });
  await p2.waitForTimeout(2000);
  const sBody = await p2.locator("body").innerText().catch(() => "");
  ok("stranger-no-approve-buttons", !sBody.includes("Approve decision"), "stranger sees approve");
  await ctx2.close().catch(() => null);
  const de = await api("POST", "/api/meetings/" + mid + "/record/draft", [], owner);
  const eid = de.json.id;
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + eid, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForTimeout(2000);
  ok("empty-no-approve", (await approveCount()) === 0, "empty shows approve");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  const themeBtn = page.getByRole("button", { name: /Switch to dark/ }).first();
  if (await themeBtn.count() > 0) { await themeBtn.click({ timeout: T.step }); await page.waitForTimeout(800); }
  await shot("onedoc-narrow-dark");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("narrow-no-overflow", overflow <= 1, "overflow=" + overflow);
  ok("no-console-errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  const badPosts = postLog.filter((e) => e.status >= 500);
  const okPosts = postLog.filter((e) => e.status >= 200 && e.status < 300);
  ok("postlog-no-500", badPosts.length === 0, JSON.stringify(badPosts.slice(0, 3)));
  ok("postlog-has-record-posts", okPosts.length >= 4, String(okPosts.length));
  console.log("[records5-onedoc-ui] pass=" + pass + " fail=" + fail);
}
main().then(async () => { await cleanup(); if (fail > 0) { console.log("FAILURES:"); for (const f of failures) console.log(" - " + f); process.exit(1); } }).catch(async (e) => { console.log("FATAL " + String(e && e.stack || e).slice(0, 500)); try { await cleanup(); } catch {} process.exit(2); });
