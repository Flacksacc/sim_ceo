"use strict";
// Records5 repair-closure UI proof.
// Real React app on QA_WEB (isolated Vite -> disposable QA_API), real CDP
// browser with own context (never closes shared browser). Seeds via API, then
// performs VERIFIED UI actions only. Asserts exact failed response statuses,
// request counts (no automatic retry), token-drift vs watermark-drift recovery,
// in-app navigation between two PENDING records with shared item IDs, delayed
// success/failure with no cross-record leak, Back/reload, empty + malformed
// (backup/restore-injected) DOM with zero approval controls anywhere.
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("path");
const crypto = require("node:crypto");
const CDP = process.env.QA_CDP || "http://127.0.0.1:9333";
const WEB = process.env.QA_WEB || "http://127.0.0.1:5188";
const API = process.env.QA_API || "http://127.0.0.1:5098";
const OUT = process.env.QA_SHOTS || ".tmp/records-qa-shots";
const MALFORMED = process.argv.includes("--malformed");
const SUMFILE = MALFORMED ? "summary-malformed.json" : "summary.json";
const T = { goto: 60000, step: 20000, poll: 20000, overall: 300000 };
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const failures = [];
const consoleErrors = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
async function api(method, p, body, user) {
  const r = await fetch(API + p, {
    method, headers: { "content-type": "application/json", "x-user": user || "owner" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, json, text };
}
const run = "qb-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
let browser, ctx, page;
const postLog = [];
async function bodyHas(s) { return (await page.locator("body").innerText()).includes(s); }
async function shot(name) { await page.screenshot({ path: path.join(OUT, name + ".png") }); }
async function approveButtonsFullDom() {
  return await page.locator("button").filter({ hasText: /^Approve / }).count();
}
function postsTo(re) { return postLog.filter((e) => re.test(e.url)); }
const watchdog = setTimeout(() => { console.log("OVERALL WATCHDOG"); process.exit(3); }, T.overall);
async function main() {
  browser = await chromium.connectOverCDP(CDP);
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
  ok("app-loads", true);  if (MALFORMED) { await malformedMode(); return; }
  const board = await api("POST", "/api/boards", { name: run + "-uiboard", mission: run + " mission", stage: "qa" });
  const bid = board.json.id;
  await api("POST", "/api/boards/" + bid + "/lead", { name: "UI Lead", roleLabel: "Lead" });
  const mtg = await api("POST", "/api/boards/" + bid + "/meetings", { title: run + " uimeet", brief: "ui brief" });
  const mid = mtg.json.id;
  await api("POST", "/api/meetings/" + mid + "/messages", { sender: "lead", content: "ui seeded input gamma" });
  await api("POST", "/api/meetings/" + mid + "/notes", { title: "uiwork", body: "ui provisional note beta", kind: "note" });
  const items = [
    { id: "UA", text: "UI approve alpha item exact" },
    { id: "UB", text: "UI pending beta item" },
    { id: "UC", text: "UI pending gamma item" },
    { id: "UD", text: "UI discard delta item" },
  ];
  const d1 = await api("POST", "/api/meetings/" + mid + "/record/draft", items);
  ok("seed-draft-201", d1.status === 201, String(d1.status));
  const did = d1.json.id;
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + did, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("Review v1"), null, { timeout: T.poll });
  await shot("records-full");
  ok("review-renders-one-doc", await bodyHas("Review v1") && await bodyHas("UI approve alpha item exact"), "one-document review missing");
  // per-item approve UA via REAL UI button
  await page.getByRole("button", { name: "Approve UA" }).first().click({ timeout: T.step });
  await page.waitForFunction(() => document.body.innerText.includes("Approved UA"), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(1500);
  await shot("records-approved-partial");
  ok("ui-approve-UA", await bodyHas("UI approve alpha item exact"), "approved item vanished");
  const rev1 = await api("GET", "/api/records/" + did + "/review");
  ok("api-partial-matches-ui", (rev1.json?.approved || []).includes("UA") && (rev1.json?.pending || []).includes("UB"), JSON.stringify(rev1.json).slice(0, 200));
  // per-item revise UB via REAL UI input + button
  await page.getByLabel("Revised text for UB").first().fill("UI revised beta v2", { timeout: T.step });
  await page.getByRole("button", { name: "Revise UB" }).first().click({ timeout: T.step });
  await page.waitForFunction(() => document.body.innerText.includes("UI revised beta v2"), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(1200);
  ok("ui-revise-UB", await bodyHas("UI revised beta v2"), "revised text missing");
  // per-item discard UD via REAL UI button
  await page.getByRole("button", { name: "Discard UD" }).first().click({ timeout: T.step });
  await page.waitForTimeout(1500);
  const rev2 = await api("GET", "/api/records/" + did + "/review");
  ok("api-discard-UD", (rev2.json?.discarded || []).includes("UD") && (rev2.json?.approved || []).includes("UA") && (rev2.json?.pending || []).includes("UC"), JSON.stringify(rev2.json).slice(0, 200));  // ---- TOKEN DRIFT (no new meeting input): another client revises UB, rotating the token ----
  postLog.length = 0;
  const tokRow0 = await api("GET", "/api/records/" + did);
  let tokG = { version: tokRow0.json.version ?? tokRow0.json.Version, hash: tokRow0.json.hash ?? tokRow0.json.Hash, reviewToken: tokRow0.json.reviewToken ?? tokRow0.json.ReviewToken, watermark: tokRow0.json.watermark ?? tokRow0.json.Watermark };
  const apiRev = await api("POST", "/api/records/" + did + "/items/revise", { ...tokG, itemId: "UB", text: "api revised beta v3" });
  ok("setup-token-drift-revise", apiRev.status === 200, String(apiRev.status));
  const approveClicks0 = postsTo(/items\/approve$/).length;
  await page.getByRole("button", { name: "Approve UB" }).first().click({ timeout: T.step }).catch(() => null);
  await page.waitForFunction(() => document.body.innerText.includes("Refresh review") && document.body.innerText.includes("No automatic retry"), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(1200);
  const tokApproves = postsTo(/items\/approve$/);
  ok("ui-token-409-exact", tokApproves.length === approveClicks0 + 1 && tokApproves[tokApproves.length - 1].status === 409, JSON.stringify(tokApproves));
  ok("ui-token-409-guided", await bodyHas("Refresh review") && await bodyHas("No automatic retry"), "no guided 409 explanation");
  await shot("records-409-token");
  const tokAfterFail = await api("GET", "/api/records/" + did + "/review");
  ok("ui-token-409-no-auto-retry", (tokAfterFail.json?.pending || []).includes("UB"), "stale click approved without deliberation");
  // deliberate reload-only refresh: zero refresh POSTs, fresh authority shown
  const refreshCount0 = postsTo(/\/refresh$/).length;
  await page.getByRole("button", { name: "Refresh review" }).first().click({ timeout: T.step });
  await page.waitForFunction(() => document.body.innerText.includes("already current") || document.body.innerText.includes("refreshed to current"), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(1500);
  const refreshAfterTok = postsTo(/\/refresh$/);
  ok("ui-token-refresh-no-post", refreshAfterTok.length === refreshCount0, "reload-only refresh issued a refresh POST: " + JSON.stringify(refreshAfterTok));
  ok("ui-token-refresh-reloaded", await bodyHas("api revised beta v3"), "fresh authority not reloaded");
  // ---- WATERMARK DRIFT: new meeting input makes loaded guards stale ----
  await api("POST", "/api/meetings/" + mid + "/messages", { sender: "lead", content: "ui fresh input forces stale guards" });
  const beforeHist = ((await api("GET", "/api/records/" + did)).json.historyJson ?? "").length;
  const approveClicks1 = postsTo(/items\/approve$/).length;
  await page.getByRole("button", { name: "Approve UB" }).first().click({ timeout: T.step }).catch(() => null);
  await page.waitForFunction(() => document.body.innerText.includes("Refresh review") && document.body.innerText.includes("No automatic retry"), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(1200);
  const wmApproves = postsTo(/items\/approve$/);
  ok("ui-wm-409-exact", wmApproves.length === approveClicks1 + 1 && wmApproves[wmApproves.length - 1].status === 409, JSON.stringify(wmApproves));
  await shot("records-409");
  const afterFail = await api("GET", "/api/records/" + did + "/review");
  ok("ui-wm-409-no-auto-retry", (afterFail.json?.pending || []).includes("UB"), "stale click approved: " + JSON.stringify(afterFail.json).slice(0, 160));
  const afterHist = ((await api("GET", "/api/records/" + did)).json.historyJson ?? "").length;
  ok("ui-409-no-history-write", afterHist === beforeHist, "failed click wrote history");
  // deliberate explicit Refresh review: real POST, token rotates, nothing approved
  const tokB = (await api("GET", "/api/records/" + did)).json;
  const tokBefore = tokB.reviewToken ?? tokB.ReviewToken;
  const refreshCount1 = postsTo(/\/refresh$/).length;
  await page.getByRole("button", { name: "Refresh review" }).first().click({ timeout: T.step });
  await page.waitForFunction(() => document.body.innerText.includes("refreshed to current"), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(1500);
  const refreshAfterWm = postsTo(/\/refresh$/);
  ok("ui-wm-refresh-one-post", refreshAfterWm.length === refreshCount1 + 1 && refreshAfterWm[refreshAfterWm.length - 1].status === 200, JSON.stringify(refreshAfterWm));
  const tokA = ((await api("GET", "/api/records/" + did)).json.reviewToken ?? (await api("GET", "/api/records/" + did)).json.ReviewToken);
  ok("ui-refresh-rotates-token", tokA && tokBefore && tokA !== tokBefore, "token unchanged by explicit refresh");
  const revAfterRefresh = await api("GET", "/api/records/" + did + "/review");
  ok("ui-refresh-no-auto-approve", (revAfterRefresh.json?.approved || []).includes("UA") && (revAfterRefresh.json?.pending || []).includes("UB"), "refresh approved or dropped items");
  // distinct deliberate next approval succeeds in the UI
  const approveClicks2 = postsTo(/items\/approve$/).length;
  await page.getByRole("button", { name: "Approve UB" }).first().click({ timeout: T.step });
  await page.waitForFunction(() => document.body.innerText.includes("Approved UB"), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(1200);
  const rev3 = await api("GET", "/api/records/" + did + "/review");
  ok("ui-deliberate-UB", (rev3.json?.approved || []).includes("UB"), JSON.stringify(rev3.json).slice(0, 200));
  const deliApproves = postsTo(/items\/approve$/);
  ok("ui-deliberate-one-post-200", deliApproves.length === approveClicks2 + 1 && deliApproves[deliApproves.length - 1].status === 200, JSON.stringify(deliApproves));  // approve-all via REAL UI button; then NO approval controls anywhere in the DOM
  await page.getByRole("button", { name: /Approve all/ }).first().click({ timeout: T.step });
  await page.waitForTimeout(2000);
  const rev4 = await api("GET", "/api/records/" + did + "/review");
  ok("api-all-decided", ((rev4.json?.pending || []).length === 0) && ((rev4.json?.approved || []).length === 3) && ((rev4.json?.discarded || []).length === 1), JSON.stringify(rev4.json).slice(0, 200));
  const fullDomCount = await approveButtonsFullDom();
  ok("ui-all-decided-no-approve-full-dom", fullDomCount === 0, "approval controls present in full DOM: " + fullDomCount);
  const hiddenCount = await page.locator("button:not(:visible)").filter({ hasText: /Approve/ }).count().catch(() => -1);
  ok("ui-all-decided-no-hidden-approve", hiddenCount === 0, "hidden approval controls: " + hiddenCount);
  await shot("records-final");
  // ---- two PENDING records with shared item IDs, in-app navigation only ----
  const d2 = await api("POST", "/api/meetings/" + mid + "/record/draft", [
    { id: "UA", text: "second record alpha" },
    { id: "UB", text: "second record beta" },
  ]);
  const did2 = d2.json.id;
  const d3 = await api("POST", "/api/meetings/" + mid + "/record/draft", [
    { id: "UA", text: "third record alpha" },
    { id: "UB", text: "third record beta" },
  ]);
  const did3 = d3.json.id;
  // the record list was fetched before d2/d3 existed; reload so in-app list buttons include them
  await page.reload({ waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("Review v1"), null, { timeout: T.poll });
  await page.waitForTimeout(800);
  async function openRec(id) {
    await page.locator(`[data-testid="record-open-${id}"]`).first().click({ timeout: T.step });
    await page.waitForTimeout(1200);
  }
  // deterministic hash load only for initial setup of the pair
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + did2, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("second record alpha"), null, { timeout: T.poll });
  await page.waitForTimeout(800);
  const scopedVal = await page.getByLabel("Revised text for UA").first().inputValue().catch(() => "UNFOUND");
  ok("ui-edit-state-scoped", scopedVal === "", "cross-record edit text leaked: " + JSON.stringify(scopedVal).slice(0, 120));
  await page.getByLabel("Revised text for UA").first().fill("typed in second record", { timeout: T.step });
  // in-app switch to d3: shared IDs, inputs must start empty, no error carried
  await openRec(did3);
  ok("ui-inapp-d3-alpha", await bodyHas("third record alpha"), "in-app navigation to d3 failed");
  const d3Val = await page.getByLabel("Revised text for UA").first().inputValue().catch(() => "UNFOUND");
  ok("ui-inapp-no-leak", d3Val === "" && !(await bodyHas("typed in second record")), "d2 text leaked into d3: " + JSON.stringify(d3Val).slice(0, 120));
  ok("ui-inapp-no-error", !(await bodyHas("No automatic retry")), "stale error displayed on d3");
  // back to d2 in-app: typed text preserved (scoped per draft)
  await openRec(did2);
  const backVal = await page.getByLabel("Revised text for UA").first().inputValue().catch(() => "UNFOUND");
  ok("ui-inapp-reset-on-return", backVal === "", "scoped edit state not reset on selection: " + JSON.stringify(backVal).slice(0, 120));
  // delayed FAILURE: rotate d2 token via API revise, slow the UI revise, switch away mid-flight
  let d2g = await api("GET", "/api/records/" + did2);
  let d2guards = { version: d2g.json.version ?? d2g.json.Version, hash: d2g.json.hash ?? d2g.json.Hash, reviewToken: d2g.json.reviewToken ?? d2g.json.ReviewToken, watermark: d2g.json.watermark ?? d2g.json.Watermark };
  const apiRevD2 = await api("POST", "/api/records/" + did2 + "/items/revise", { ...d2guards, itemId: "UB", text: "api revised d2 beta" });
  ok("setup-d2-token-rotated", apiRevD2.status === 200, String(apiRevD2.status));
  await page.getByLabel("Revised text for UB").first().fill("ui late revise d2", { timeout: T.step });
  await page.route("**/api/records/*/items/revise", async (route) => { await new Promise((r) => setTimeout(r, 1200)); await route.continue(); });
  await page.getByRole("button", { name: "Revise UB" }).first().click({ timeout: T.step }).catch(() => null);
  await page.waitForTimeout(300);
  await openRec(did3);
  ok("ui-delayed-no-leak-d3", !(await bodyHas("No automatic retry")) && !(await bodyHas("ui late revise d2")), "d2 in-flight failure leaked onto d3");
  await page.waitForTimeout(2200);
  const d2rev = await api("GET", "/api/records/" + did2 + "/review");
  ok("ui-delayed-failed-server", (d2rev.json?.pending || []).includes("UB"), "delayed revise unexpectedly succeeded");
  await page.unroute("**/api/records/*/items/revise");
  await openRec(did2);
  await page.waitForTimeout(800);
  const delayedRev = postLog.filter((e) => e.url === "/api/records/" + did2 + "/items/revise");
  ok("ui-delayed-409-response", delayedRev.length === 1 && delayedRev[0].status === 409, JSON.stringify(delayedRev));
  ok("ui-delayed-reset-on-return", !(await bodyHas("No automatic retry")), "error was not reset on selection change");
  const d2ub = ((await api("GET", "/api/records/" + did2)).json.itemsJson ?? "");
  ok("ui-delayed-no-overwrite", d2ub.includes("api revised d2 beta") && !d2ub.includes("ui late revise d2"), "stale late result overwrote d2");
  // delayed SUCCESS on d3 while viewing d2: d2 must not gain d3 state or errors
  await openRec(did3);
  await page.getByLabel("Revised text for UA").first().fill("typed in third record", { timeout: T.step });
  await page.route("**/api/records/*/items/approve", async (route) => { await new Promise((r) => setTimeout(r, 1200)); await route.continue(); });
  await page.getByRole("button", { name: "Approve UA" }).first().click({ timeout: T.step }).catch(() => null);
  await page.waitForTimeout(300);
  await openRec(did2);
  await page.waitForTimeout(2200);
  const d3rev = await api("GET", "/api/records/" + did3 + "/review");
  ok("ui-delayed-success-server", (d3rev.json?.approved || []).includes("UA"), "delayed approve did not land on d3");
  const d2revAfter = await api("GET", "/api/records/" + did2 + "/review");
  const d2StillPending = (d2revAfter.json?.pending || []).includes("UA");
  const d2ApproveBtn = await page.getByRole("button", { name: "Approve UA" }).count().catch(() => -1);
  const d2HasError = await bodyHas("No automatic retry");
  ok("ui-delayed-success-no-leak", d2StillPending && d2ApproveBtn === 1 && !d2HasError, "d3 success leaked onto d2 (pending=" + d2StillPending + " btn=" + d2ApproveBtn + " err=" + d2HasError + ")");
  await page.unroute("**/api/records/*/items/approve");
  // in-app back to the decided first record: zero approval controls, no resurrection
  await openRec(did);
  await page.waitForFunction(() => document.body.innerText.includes("UI approve alpha item exact"), null, { timeout: T.poll });
  await page.waitForTimeout(800);
  ok("ui-inapp-decided-clean", (await approveButtonsFullDom()) === 0 && !(await bodyHas("typed in second record")), "decided record gained controls or leaked text");
  // browser Back across pushed hash history, then reload: state stays coherent
  await page.goBack({ timeout: T.step }).catch(() => null);
  await page.waitForTimeout(1200);
  const backBody = await page.locator("body").innerText();
  ok("ui-back-no-crash", backBody.includes("Review v1") || backBody.includes("Records"), "back navigation broke the app");
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + did, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("Review v1"), null, { timeout: T.poll });
  await page.waitForTimeout(800);
  ok("ui-reload-no-approve", (await approveButtonsFullDom()) === 0, "approval controls after reload");
  // narrow viewport + dark theme for primary inspection
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  const themeBtn = page.getByRole("button", { name: /Switch to dark/ }).first();
  if (await themeBtn.count() > 0) { await themeBtn.click({ timeout: T.step }); await page.waitForTimeout(800); }
  await shot("records-narrow-dark");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("narrow-no-overflow", overflow <= 1, "overflow=" + overflow);
}async function malformedMode() {
  // Malformed persisted state via the owner-only backup/restore shipping path
  // (restore performs no per-draft validation), then real review rendering.
  const board = await api("POST", "/api/boards", { name: run + "-malboard", mission: run + " mission", stage: "qa" });
  const bid = board.json.id;
  const mtg = await api("POST", "/api/boards/" + bid + "/meetings", { title: run + " malmeet", brief: "mal brief" });
  const mid = mtg.json.id;
  await api("POST", "/api/meetings/" + mid + "/messages", { sender: "lead", content: "mal input" });
  const base = await api("GET", "/api/backup");
  ok("mal-backup-200", base.status === 200 && base.json?.snapshot, base.status + " " + base.text.slice(0, 120));
  const snap = JSON.parse(base.json.snapshot);
  const mkDraft = (id, itemsJson, historyJson) => ({
    Id: id, BoardId: bid, MeetingId: mid, Version: 1, Watermark: 0,
    ItemsJson: itemsJson, Hash: "h-mal", ApprovedJson: "[]", DiscardedJson: "[]",
    ReviewRevision: 1, ReviewToken: "tok-mal-" + id, HistoryJson: historyJson,
    EvidenceSnapshotJson: "[]", SupersedesJson: "[]", Decided: false, Status: "open",
    CreatedAt: new Date().toISOString(),
  });
  const mal1 = mkDraft(crypto.randomUUID(), JSON.stringify([{ id: "a", text: "mal one" }]), "[null]");
  const mal2 = mkDraft(crypto.randomUUID(), JSON.stringify([{ id: "b", text: "mal two", detail: { evil: 1 }, refs: [{ kind: "source", ref: "x" }] }]), "[]");
  const mal3 = mkDraft(crypto.randomUUID(), JSON.stringify([{ id: "c", text: "mal three" }]), JSON.stringify([{ action: { bad: 1 } }]));
  const malEmpty = mkDraft(crypto.randomUUID(), "[]", "[]");
  snap.drafts = (snap.drafts || []).concat([mal1, mal2, mal3, malEmpty]);
  const snapStr = JSON.stringify(snap);
  const snapHash = crypto.createHash("sha256").update(snapStr, "utf8").digest("hex");
  const rest = await api("POST", "/api/backup/restore", { snapshot: snapStr, hash: snapHash });
  ok("mal-restore-200", rest.status === 200, rest.status + " " + rest.text.slice(0, 200));
  for (const [nm, did] of [["hist-null", mal1.Id], ["item-objects", mal2.Id], ["action-object", mal3.Id]]) {
    await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + did, { waitUntil: "domcontentloaded", timeout: T.goto });
    await page.waitForFunction(() => document.body.innerText.includes("Review v1") || document.body.innerText.includes("malformed"), null, { timeout: T.poll }).catch(() => null);
    await page.waitForTimeout(1000);
    const crashed = (await page.locator("body").innerText()).includes("Something went wrong") || (await page.locator("body").innerText()).trim().length < 20;
    ok("mal-no-crash-" + nm, !crashed, "render crashed");
    ok("mal-banner-" + nm, await bodyHas("malformed"), "malformed banner missing");
    ok("mal-no-approve-" + nm, (await approveButtonsFullDom()) === 0, "approval controls on malformed record");
    const hid = await page.locator("button:not(:visible)").filter({ hasText: /Approve/ }).count().catch(() => -1);
    ok("mal-no-hidden-" + nm, hid === 0, "hidden approval controls: " + hid);
    const g = await api("GET", "/api/records/" + did);
    const tok = g.json?.reviewToken ?? g.json?.ReviewToken;
    const mut = await api("POST", "/api/records/" + did + "/items/approve", { version: 1, hash: "h-mal", reviewToken: tok, watermark: 0, itemId: nm === "item-objects" ? "b" : nm === "action-object" ? "c" : "a" });
    ok("mal-mutate-422-" + nm, mut.status === 422, String(mut.status));
  }
  // empty items: valid state, zero approval controls, no crash
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + malEmpty.Id, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("Review v1"), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(800);
  ok("mal-empty-renders", await bodyHas("Review v1"), "empty review missing");
  ok("mal-empty-no-approve", (await approveButtonsFullDom()) === 0, "approval controls on empty review");
  await shot("records-malformed");
  // restore pristine backup so nothing malformed lingers
  const backStr = base.json.snapshot;
  const backHash = crypto.createHash("sha256").update(backStr, "utf8").digest("hex");
  const back = await api("POST", "/api/backup/restore", { snapshot: backStr, hash: backHash });
  ok("mal-cleanup-restore", back.status === 200, back.status + " " + back.text.slice(0, 160));
}
main().then(async () => {
  clearTimeout(watchdog);
  try { await page.close(); await ctx.close(); } catch { }
  // The deliberate stale clicks are *expected* to fail with 409; Chrome logs
  // those resource failures at console-error level. Allow exactly those;
  // every other console error (including any pageerror) fails.
  const uniq = [...new Set(consoleErrors)];
  const allowed409 = uniq.filter((e) => e.includes("Failed to load resource") && e.includes("409"));
  const disallowed = uniq.filter((e) => !allowed409.includes(e)).slice(0, 20);
  const summary = { pass, fail, failures, consoleErrors: uniq.slice(0, 20), disallowedConsoleErrors: disallowed };
  fs.writeFileSync(path.join(OUT, SUMFILE), JSON.stringify(summary, null, 1));
  const clean = fail === 0 && disallowed.length === 0;
  console.log(clean ? `RECORDS-UI PASS ${pass}` : `RECORDS-UI DONE pass=${pass} fail=${fail} consoleErrors=${disallowed.length}`);
  process.exit(clean ? 0 : 1);
}).catch(async (e) => {
  clearTimeout(watchdog);
  console.log("RECORDS-UI ERROR " + (e && e.stack || e));
  try { await page.close(); await ctx.close(); } catch { }
  process.exit(2);
});