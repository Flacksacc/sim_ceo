import { chromium } from "playwright-core";
const API = process.env.QA_API || "http://127.0.0.1:5096";
const WEB = process.env.QA_WEB || "http://127.0.0.1:5186";
const run = "qa-b" + Date.now().toString(36);
let pass = 0, fail = 0;
const bad = [];
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; bad.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); } }
async function api(method, path, body) {
  const r = await fetch(API + path, { method, headers: { "x-user": "owner", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, json, text };
}
const boardName = run + "-alpha";
const b = await api("POST", "/api/boards", { name: boardName, mission: run + " mission", stage: "qa" });
ok("seed-board", b.status === 201 && (b.json.id || b.json.Id), b.status);
const bid = b.json.id || b.json.Id;
const m = await api("POST", "/api/boards/" + bid + "/meetings", { title: run + " mtg", brief: "browser brief" });
ok("seed-meeting", m.status === 201, m.status);
const mid = m.json.id || m.json.Id;
const a = await api("POST", "/api/auditions", { question: run + " browser audition", profileJson: "{}" });
ok("seed-audition", a.status === 200, a.status);
const form = new FormData();
form.append("audio", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }), "mic.webm");
const tr = await fetch(API + "/api/meetings/" + mid + "/transcribe", { method: "POST", headers: { "x-user": "owner" }, body: form });
const trText = await tr.text();
ok("seed-transcribe", tr.status === 201 && trText.includes("qa transcript"), tr.status);
const bB = await api("POST", "/api/boards", { name: run + "-beta", mission: run + " mission B", stage: "qa" });
ok("seed-boardB", bB.status === 201, bB.status);
const bidB = bB.json.id || bB.json.Id;
const mB = await api("POST", "/api/boards/" + bidB + "/meetings", { title: run + " mtgB", brief: "browser brief B" });
ok("seed-meetingB", mB.status === 201, mB.status);
const midB = mB.json.id || mB.json.Id;
const formB = new FormData();
formB.append("audio", new Blob([new Uint8Array([5, 6, 7, 8])], { type: "audio/webm" }), "mic.webm");
const trB = await fetch(API + "/api/meetings/" + midB + "/transcribe", { method: "POST", headers: { "x-user": "owner" }, body: formB });
ok("seed-transcribeB", trB.status === 201, trB.status);
async function urows(qs) {
  const r = await fetch(API + "/api/usage?summary=true&limit=2000&" + qs, { headers: { "x-user": "owner" } });
  return r.json();
}
const audId = ((await urows("purpose=audition"))?.rows || []).map((r) => r.id).find((id) => id);
const trId = ((await urows("meetingId=" + mid))?.rows || []).map((r) => r.id).find((id) => id);
const trBId = ((await urows("meetingId=" + midB))?.rows || []).map((r) => r.id).find((id) => id);
ok("seed-row-ids", !!audId && !!trId && !!trBId, audId + "/" + trId + "/" + trBId);
const boardBName = run + "-beta";
let browser = null; let context = null;
try {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
  context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  console.log("browser: going to " + WEB);
  await page.goto(WEB + "/", { waitUntil: "domcontentloaded", timeout: 90000 });
  console.log("browser: loaded");
  await page.getByRole("button", { name: "Boards" }).first().click();
  {
    const brow = page.locator(".lprow", { hasText: boardName }).first();
    await brow.scrollIntoViewIfNeeded({ timeout: 20000 });
    await brow.click({ timeout: 20000 });
    ok("ui-board-nav-alpha", true);
  }
  await page.getByRole("button", { name: "Activity" }).first().click();
  await page.getByRole("heading", { name: "Activity and Usage" }).waitFor();
  ok("ui-activity-heading", true);
  await page.getByText("Pricing basis", { exact: false }).first().waitFor({ timeout: 20000 });
  ok("ui-pricing-basis", true);
  const scopeSel = page.getByLabel("Usage scope");
  await scopeSel.waitFor();
  ok("ui-scope-selector", true);
  const ledger = page.locator("[data-testid=usage-ledger-table]");
  const mledger = page.locator("[data-testid=modelcall-ledger-table]");
  const row = (id) => ledger.locator("tr[data-row-id=\"" + id + "\"]");
  const mrow = (id) => mledger.locator("tr[data-row-id=\"" + id + "\"]");
  async function waitRow(id) { await ledger.locator("tr[data-row-id=\"" + id + "\"]").first().waitFor({ timeout: 20000 }); }
  async function waitMRow(id) { await mledger.locator("tr[data-row-id=\"" + id + "\"]").first().waitFor({ timeout: 20000 }); }
  async function respOk(r, params) {
    if (!r.url().includes("/api/usage") && !r.url().includes("/api/models/calls")) return false;
    if (r.request().method() !== "GET") return false;
    let okStatus = false;
    try { okStatus = r.status() === 200; } catch { return false; }
    if (!okStatus) return false;
    const url = new URL(r.url());
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== "" && url.searchParams.get(k) !== String(v)) return false;
    }
    try {
      const j = await r.json();
      if (!j || !Array.isArray(j.rows)) return false;
    } catch { return false; }
    return true;
  }
  function paramsMatch(url, params) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== "" && u.searchParams.get(k) !== String(v)) return false;
    }
    return true;
  }
  async function waitUsageResponse(params) {
    const r = await page.waitForResponse((r) => r.url().includes("/api/usage?") && r.request().method() === "GET" && paramsMatch(r.url(), params), { timeout: 20000 });
    ok("ui-usage-resp-200", r.status() === 200, String(r.status()) + " " + r.url().slice(0, 160));
    const j = await r.json();
    ok("ui-usage-body-rows", j && Array.isArray(j.rows), "no rows array");
    return j;
  }
  async function waitModelResponse(params) {
    const r = await page.waitForResponse((r) => r.url().includes("/api/models/calls") && r.request().method() === "GET" && paramsMatch(r.url(), params), { timeout: 20000 });
    ok("ui-model-resp-200", r.status() === 200, String(r.status()) + " " + r.url().slice(0, 160));
    const j = await r.json();
    ok("ui-model-body-rows", j && Array.isArray(j.rows), "no rows array");
    return j;
  }
  await row(audId).first().waitFor();
  ok("ui-row-audition-present", true);
  await row(trId).first().waitFor();
  ok("ui-row-transcribe-present", true);
  await mrow(audId).first().waitFor();
  ok("ui-mrow-audition-present", true);
  await mrow(trId).first().waitFor();
  ok("ui-mrow-transcribe-present", true);
  // exact cells: cost/status/hidden/scope render with expected values in both tables
  async function expectCells(kind, id, want) {
    const uTxt = await ledger.locator("tr[data-row-id=\"" + id + "\"]").first().innerText();
    const mTxt = await mledger.locator("tr[data-row-id=\"" + id + "\"]").first().innerText();
    for (const [k, v] of Object.entries(want)) {
      ok("ui-" + kind + "-" + id.slice(0, 8) + "-cell-" + k, uTxt.includes(v), kind + " usage missing " + k + "=" + v + " :: " + uTxt.slice(0, 200));
      ok("ui-" + kind + "-" + id.slice(0, 8) + "-mcell-" + k, mTxt.includes(v), kind + " modelcall missing " + k + "=" + v + " :: " + mTxt.slice(0, 200));
    }
  }
  await expectCells("audition", audId, { purpose: "audition", hidden: "hidden", scope: "Unallocated" });
  await page.screenshot({ path: ".tmp/phase9/activity-installation.png", fullPage: true });
  ok("shot-installation", true);
  const purposeSel = page.getByLabel("Usage purpose");
  await Promise.all([waitUsageResponse({ purpose: "audition" }), waitModelResponse({ purpose: "audition" }), purposeSel.selectOption("audition")]);
  await waitRow(audId);
  await waitMRow(audId);
  ok("ui-filter-excludes-meeting-row", await row(trId).count() === 0, "transcribe row leaked into audition filter");
  ok("ui-filter-keeps-audition-row", await row(audId).count() === 1, "audition row missing");
  ok("ui-mfilter-excludes-meeting-row", await mrow(trId).count() === 0, "modelcall transcribe row leaked");
  ok("ui-mfilter-keeps-audition-row", await mrow(audId).count() === 1, "modelcall audition row missing");
  await page.screenshot({ path: ".tmp/phase9/activity-purpose-audition.png", fullPage: true });
  ok("shot-purpose", true);
  await purposeSel.selectOption("");
  await Promise.all([waitUsageResponse({}), waitModelResponse({}), scopeSel.selectOption("board")]);
  try {
    await waitRow(trId);
  } catch (e) {
    const tHtml = await page.locator("[data-testid=usage-ledger-table]").first().innerHTML().catch(() => "no-table");
    console.log("  DIAG usage table (first 1500 chars): " + String(tHtml).slice(0, 1500));
    const selVal = await scopeSel.inputValue().catch(() => "?");
    console.log("  DIAG scope value: " + selVal);
    throw e;
  }
  ok("ui-board-has-own-row", await row(trId).count() === 1, "board A row missing");
  ok("ui-board-excludes-installation-row", await row(audId).count() === 0, "installation row leaked into board scope");
  ok("ui-board-excludes-other-board", await row(trBId).count() === 0, "board B row leaked");
  ok("ui-mboard-has-own-row", await mrow(trId).count() === 1, "modelcall board A row missing");
  ok("ui-mboard-excludes-installation-row", await mrow(audId).count() === 0, "modelcall installation row leaked");
  await page.screenshot({ path: ".tmp/phase9/activity-board.png", fullPage: true });
  ok("shot-board", true);
  await scopeSel.selectOption("meeting");
  const meetSel = page.getByLabel("Usage meeting");
  await Promise.all([waitUsageResponse({ meetingId: mid }), waitModelResponse({ meetingId: mid }), meetSel.selectOption(mid)]);
  await waitRow(trId);
  await waitMRow(trId);
  ok("ui-meeting-row", await row(trId).count() === 1, "meeting row missing");
  ok("ui-meeting-excludes-others", await row(trBId).count() === 0 && await row(audId).count() === 0, "leak into meeting scope");
  ok("ui-mmeeting-row", await mrow(trId).count() === 1, "modelcall meeting row missing");
  await expectCells("transcribe", trId, { scope: "Allocated" });
  await page.screenshot({ path: ".tmp/phase9/activity-meeting.png", fullPage: true });
  ok("shot-meeting", true);
  await page.getByRole("button", { name: "Boards" }).first().click();
  {
    const browB = page.locator(".lprow", { hasText: boardBName }).first();
    await browB.scrollIntoViewIfNeeded({ timeout: 20000 });
    await browB.click({ timeout: 20000 });
    ok("ui-board-nav-beta", true);
  }
  await page.getByRole("button", { name: "Activity" }).first().click();
  await page.getByRole("button", { name: "Activity" }).first().click();
  await page.screenshot({ path: ".tmp/phase9/activity-after-switch.png", fullPage: true });
  const meetVal = await page.getByLabel("Usage meeting").inputValue();
  ok("ui-meeting-cleared-on-board-switch", meetVal === "", "meeting still selected: " + meetVal);
  await scopeSel.selectOption("board");
  await waitRow(trBId);
  ok("ui-boardB-own-row", await row(trBId).count() === 1, "board B row missing");
  ok("ui-boardB-excludes-A", await row(trId).count() === 0, "board A row leaked into board B");
  ok("ui-mboardB-own-row", await mrow(trBId).count() === 1, "modelcall board B row missing");
  ok("ui-mboardB-excludes-A", await mrow(trId).count() === 0, "modelcall board A row leaked into board B");
  ok("ui-mboardB-excludes-installation", await mrow(audId).count() === 0, "modelcall installation row leaked into board B");
  await page.screenshot({ path: ".tmp/phase9/activity-board-switch.png", fullPage: true });
  ok("shot-board-switch", true);
  await Promise.all([waitUsageResponse({}), waitModelResponse({}), scopeSel.selectOption("installation")]);
  await expectCells("audition-again", audId, { purpose: "audition", hidden: "hidden", scope: "Unallocated" });
  async function waitUsageError() {
    const r = await page.waitForResponse((r) => r.url().includes("/api/usage?") && r.request().method() === "GET" && r.status() !== 200, { timeout: 20000 });
    ok("ui-usage-err-status", r.status() !== 200, String(r.status()));
    return r;
  }
  async function waitModelError() {
    const r = await page.waitForResponse((r) => r.url().includes("/api/models/calls") && r.request().method() === "GET" && r.status() !== 200, { timeout: 20000 });
    ok("ui-model-err-status", r.status() !== 200, String(r.status()));
    return r;
  }
  const dayInput = page.getByLabel("Day", { exact: true });
  await Promise.all([waitUsageResponse({ day: "2000-01-01" }), waitModelResponse({ day: "2000-01-01" }), dayInput.fill("2000-01-01")]);
  // empty states appear only after successful queries (assert exact empty texts in both tables)
  await page.getByText("No usage in this scope yet.", { exact: false }).first().waitFor({ timeout: 20000 });
  ok("ui-empty-usage", true);
  await page.getByText("No model calls in this scope yet.", { exact: false }).first().waitFor({ timeout: 20000 });
  ok("ui-empty-modelcalls", true);
  ok("ui-mempty-modelcalls-table", await mledger.locator("tr[data-row-id]").count() === 0, "modelcall rows leaked into empty day");
  await Promise.all([waitUsageResponse(), waitModelResponse(), dayInput.fill("")]);
  await waitRow(audId);
  await waitMRow(audId);
  // valid range inclusion boundary: rows on/inside range return in both tables
  const fromInput = page.getByLabel("From", { exact: true });
  const toInput = page.getByLabel("To", { exact: true });
  await Promise.all([waitUsageResponse({ from: "2000-01-01" }), waitModelResponse({ from: "2000-01-01" }), fromInput.fill("2000-01-01")]);
  await Promise.all([waitUsageResponse({ from: "2000-01-01", to: "2999-12-31" }), waitModelResponse({ from: "2000-01-01", to: "2999-12-31" }), toInput.fill("2999-12-31")]);
  await waitRow(audId);
  await waitMRow(audId);
  ok("ui-range-includes-rows", await row(audId).count() === 1 && await mrow(audId).count() === 1, "range excluded valid rows");
  await toInput.fill("");
  await fromInput.fill("");
  await waitRow(audId);
  await waitMRow(audId);
  // inverted date range => server 400 on both routes => both ledger errors, no false empty
  await Promise.all([waitUsageResponse({ from: "2026-05-10" }), waitModelResponse({ from: "2026-05-10" }), fromInput.fill("2026-05-10")]);
  await Promise.all([waitUsageError(), waitModelError(), toInput.fill("2026-05-01")]);
  await page.locator("[data-testid=usage-ledger-error]").first().waitFor({ timeout: 20000 });
  ok("ui-range-usage-error", true);
  await page.locator("[data-testid=modelcall-ledger-error]").first().waitFor({ timeout: 20000 });
  ok("ui-range-modelcall-error", true);
  ok("ui-range-no-false-empty", await page.getByText("No usage in this scope yet.", { exact: false }).count() === 0, "false empty usage on error");
  await toInput.fill("");
  await fromInput.fill("");
  await waitRow(audId);
  await page.route("**/api/usage*", (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
  await page.route("**/api/models/calls*", (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
  await purposeSel.selectOption("secretary");
  await page.locator("[data-testid=usage-ledger-error]").first().waitFor({ timeout: 20000 });
  ok("ui-error-usage-alert", true);
  await page.locator("[data-testid=modelcall-ledger-error]").first().waitFor({ timeout: 20000 });
  ok("ui-error-modelcall-alert", true);
  ok("ui-error-no-false-empty", await page.getByText("No usage in this scope yet.", { exact: false }).count() === 0 && await page.getByText("No model calls in this scope yet.", { exact: false }).count() === 0, "false empty on failed query");
  await page.screenshot({ path: ".tmp/phase9/activity-error.png", fullPage: true });
  ok("shot-error", true);
  await context.close();
  context = null;
} catch (e) {
  console.log("  FAIL browser :: " + (e && e.message ? e.message : e));
  fail++; bad.push("browser :: " + (e && e.message ? e.message : e));
  try { if (context) await context.close(); } catch { }
}
console.log("browser usage-activity: pass=" + pass + " fail=" + fail + (fail ? " FAILURES: " + bad.join(" | ") : ""));
process.exit(fail ? 1 : 0);
