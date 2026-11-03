// Browser QA via the existing Codex Edge CDP endpoint. Connects to the
// running browser (never launches/kills it), opens its OWN page, walks the
// affected wizard/roster/discussion/record UI against the isolated QA stack
// (Vite :5174 -> API :5099 -> fake provider), records console errors and
// screenshots to .tmp/qa-browser/. Nonzero exit on failure.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const CDP = process.env.QA_CDP || "http://localhost:9333";
const WEB = process.env.QA_WEB || "http://127.0.0.1:5174";
const API = process.env.QA_API || "http://127.0.0.1:5099";
const OUT = ".tmp/qa-browser"; const run = "qb-" + Date.now().toString(36) + "-" + Math.floor(Math.random()*1e6).toString(36);
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
const consoleErrors = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
async function api(method, p, body) {
  const r = await fetch(API + p, {
    method, headers: { "content-type": "application/json", "x-user": "owner" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, json, text };
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

let browser, page, ctx;
try {
  browser = await chromium.connectOverCDP(CDP);
  ctx = await browser.newContext(); // lane D: own isolated context, never reuse user context
  page = await ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 300)));

  await page.goto(WEB, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.body && document.body.innerText.length > 50, null, { timeout: 60000 });
  ok("app-loads", true);
  // share the browser accountId with API seeding
  const accountId = await page.evaluate(() => localStorage.getItem("simceo-account"));
  ok("account-present", !!accountId, String(accountId));
  // ---- seed via API ----
  const board = await api("POST", "/api/boards", { name: run + "-bboard", mission: run + " mission", stage: "qa" });
  const bid = board.json.id;
  await api("POST", "/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Lead" });
  const quick = await api("POST", "/api/roster/quick", { accountId, name: run + "-adv", description: "browser probe advisor with words" });
  const rid = quick.json.id;
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "qa.png");
  const up = await fetch(API + "/api/roster/" + rid + "/image/upload", { method: "POST", headers: { "x-user": "owner" }, body: form });
  ok("seed-portrait", up.status === 201, String(up.status));
  const imgs = await api("GET", "/api/roster/" + rid + "/images");
  const imgId = imgs.json[0].id;
  const cp = await api("POST", "/api/roster/" + rid + "/copy", { boardId: bid, boardRole: "BrowserRole" });
  const aid = cp.json.id;
  const mtg = await api("POST", "/api/boards/" + bid + "/meetings", { title: run + " meeting", brief: "browser brief" });
  const mid = mtg.json.id;
  await api("POST", "/api/meetings/" + mid + "/messages", { sender: "lead", content: "Browser seeded question" });
  const wiz = await api("POST", "/api/wizard", { accountId, step: 1, presetKey: "", fieldsJson: JSON.stringify({ name: run + "-wiz", mission: "m", stage: "s", lead: { name: "L" }, advisors: [{ role: "Wiz", name: "" }] }) });
  const wid = wiz.json.id;
  const wizVer = wiz.json.version ?? wiz.json.Version ?? 1;
  await page.evaluate((id) => { localStorage.setItem("simceo-wizard", id); localStorage.setItem("simceo-fb-user-v2", "QA Browser"); }, wid);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body && document.body.innerText.length > 50, null, { timeout: 60000 });

  async function shot(name) {
    await page.screenshot({ path: path.join(OUT, name + ".png") });
  }
  async function gotoTab(label) {
    let btn = page.locator(`button[aria-label="${label}"]`).first();
    if (await btn.count() === 0) {
      console.log("  note reselect-board before " + label);
      const re = page.getByText(run + "-bboard").first();
      if (await re.count() > 0) { await re.click({ timeout: 15000 }); await page.waitForTimeout(1500); }
      btn = page.locator(`button[aria-label="${label}"]`).first();
    }
    await btn.click({ timeout: 15000 });
    await page.waitForTimeout(1200);
  }
  async function bodyHas(text) {
    return (await page.locator("body").innerText()).includes(text);
  }
  // ---- Boards tab: pick the seeded board ----
  await gotoTab("Boards");
  await shot("boards");
  const boardBtn = page.getByText(run + "-bboard").first();
  await boardBtn.click({ timeout: 15000 });
  await page.waitForTimeout(1500);
  ok("board-select", await bodyHas(run + "-bboard"));

  // ---- Roster tab: detail shows pending portrait review ----
  await gotoTab("Roster");
  await shot("roster-list");
  const entryBtn = page.getByText(run + "-adv").first();
  await entryBtn.click({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await shot("roster-detail");
  ok("roster-portrait-review", await bodyHas("Portraits - accept one before approval"), "review section missing");
  const acceptBtn = page.getByText("Accept portrait").first();
  await acceptBtn.click({ timeout: 15000 });
  await page.waitForTimeout(2000);
  await shot("roster-accepted");
  const accImgs = await api("GET", "/api/roster/" + rid + "/images");
  ok("ui-accept-portrait", (accImgs.json[0].review || accImgs.json[0].Review) === "accepted", JSON.stringify(accImgs.json[0]).slice(0, 200));
  // dossier hydration: research via UI, sources render
  const researchBtn = page.locator("button", { hasText: "Research dossier" }).first();
  await researchBtn.click({ timeout: 15000 });
  await page.waitForFunction(() => document.body.innerText.includes("QA grounded claim line one."), null, { timeout: 60000 });
  await shot("roster-dossier");
  ok("ui-dossier-claims", await bodyHas("QA grounded claim line one."));
  // DossierView renders readable citation titles (not a raw ref dump); the
  // qa.example URL lives in the anchor href, not in body text.
  await page.waitForFunction(() => document.body.innerText.includes("QA excerpt one."), null, { timeout: 60000 });
  const dossierSrc = await page.evaluate(() => ({
    body: document.body.innerText,
    hrefs: Array.from(document.querySelectorAll('a[href^="https://qa.example/"]')).map((a) => a.getAttribute("href")),
    linkTexts: Array.from(document.querySelectorAll('a[href^="https://qa.example/"]')).map((a) => (a.textContent || "").trim()),
    targets: Array.from(document.querySelectorAll('a[href^="https://qa.example/"]')).map((a) => (a.getAttribute("target") || "") + "|" + (a.getAttribute("rel") || "")),
  }));
  ok("ui-dossier-sources",
    dossierSrc.hrefs.includes("https://qa.example/s1") &&
    dossierSrc.hrefs.includes("https://qa.example/s2") &&
    dossierSrc.linkTexts.includes("QA source one") &&
    dossierSrc.linkTexts.includes("QA source two") &&
    dossierSrc.body.includes("QA excerpt one.") &&
    dossierSrc.body.includes("QA excerpt two.") &&
    dossierSrc.targets.length >= 2 &&
    dossierSrc.targets.every((v) => v.includes("_blank") && v.includes("noreferrer")),
    JSON.stringify(dossierSrc).slice(0, 500));

  // ---- Board Advisors tab ----
  await gotoTab("Board Advisors");
  await shot("advisors");
  ok("advisors-list", await bodyHas("BrowserRole"));
  const advisorCard = page.locator(".card", { hasText: "BrowserRole" });
  const syncBtn = advisorCard.getByRole("button", { name: "Update from roster" }).first();
  await syncBtn.click({ timeout: 15000 });
  await page.waitForTimeout(2000);
  await shot("advisor-synced");
  const approveBtn = advisorCard.getByRole("button", { name: "Approve" }).first();
  await approveBtn.click({ timeout: 15000 });
  await page.waitForTimeout(2000);
  await shot("advisor-approved");
  const advCheck = await api("GET", "/api/boards/" + bid + "/advisors");
  ok("ui-approve-advisor", (advCheck.json || []).some((a) => a.approved ?? a.Approved), JSON.stringify(advCheck.json).slice(0, 200));

  // ---- Profile: board-scoped lead save ----
  const openProfile = page.locator('button[aria-label="Open profile"]').first();
  await openProfile.click({ timeout: 15000 });
  await page.waitForFunction(() => document.body.innerText.includes("Saved version"), null, { timeout: 30000 });
  await page.waitForTimeout(800);
  await shot("profile");
  const leadName = page.locator('section[aria-label="Profile"] label').filter({ hasText: "Name" }).locator("input").first();
  await leadName.fill(run + "-lead", { timeout: 15000 });
  await page.getByText("Save profile").first().click({ timeout: 15000 });
  await page.waitForTimeout(2000);
  const boardLead = await api("GET", "/api/boards/" + bid + "/lead");
  ok("ui-lead-board-scoped", boardLead.status === 200 && (boardLead.json.name || boardLead.json.Name) === run + "-lead", boardLead.status + " " + boardLead.text.slice(0, 200));
  const globalLead = await api("GET", "/api/lead");
  ok("ui-lead-global-untouched", globalLead.status === 404 || (globalLead.json.id || globalLead.json.Id) !== (boardLead.json.id || boardLead.json.Id), globalLead.status + " " + globalLead.text.slice(0, 160));

  // ---- Meetings tab: discussion run renders ----
  await gotoTab("Meetings");
  await shot("meetings");
  const meetBtn = page.getByText(run + " meeting").first();
  await meetBtn.click({ timeout: 15000 });
  await page.waitForTimeout(1500);
  ok("meeting-select", await bodyHas("Browser seeded question"));
  await shot("meeting-detail");
  // ---- Records tab: draft + approve flow renders ----
  await gotoTab("Records");
  await shot("records");
  const items = [{ id: "a", text: "Browser exact item $5 [keep]" }, { id: "b", text: "Skip me" }];
  const d1 = await api("POST", "/api/meetings/" + mid + "/record/draft", items);
  const dh = d1.json.hash ?? d1.json.Hash, dw = d1.json.watermark ?? d1.json.Watermark;
  await api("POST", "/api/meetings/" + mid + "/record/approve", { draftId: d1.json.id, hash: dh, watermark: dw, itemIds: ["a"] });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body && document.body.innerText.length > 50, null, { timeout: 60000 });
  // reload drops board/meeting selection: reselect both deterministically
  await gotoTab("Boards");
  const reB = page.getByText(run + "-bboard").first();
  await reB.click({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await gotoTab("Meetings");
  const reM = page.getByText(run + " meeting").first();
  await reM.click({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await gotoTab("Records");
  await shot("records-approved");
  const draftRow = page.getByRole("button", { name: /approved \u00b7 decided/ }).first();
  await draftRow.waitFor({ timeout: 15000 }).catch(() => null);
  if (await draftRow.count() > 0) { await draftRow.click({ timeout: 15000 }); await page.waitForTimeout(1500); }
  ok("records-approved-item", await bodyHas("Browser exact item $5 [keep]"), "approved item not rendered");

  // ---- Settings + Activity tabs smoke ----
  await gotoTab("Settings");
  await shot("settings");
  await gotoTab("Activity");
  await shot("activity");
  // lane D: wizard versioned save/start/answer + discussion run render on isolated stack
  const wsave = await api("POST", "/api/wizard", { id: wid, version: wizVer, accountId, step: 1, presetKey: "", fieldsJson: JSON.stringify({ name: run + "-wiz", mission: "m", stage: "s", lead: { name: "L" }, advisors: [] }) });
  ok("ui-wizard-versioned-save", wsave.status === 200 && (wsave.json.version ?? wsave.json.Version) > 1, wsave.status + " " + wsave.text.slice(0, 200));
  const wver = wsave.json.version ?? wsave.json.Version;
  const wstart = await api("POST", "/api/wizard/" + wid + "/interview", { answer: "", version: wver });
  ok("ui-wizard-start", wstart.status === 200 && typeof (wstart.json.question ?? wstart.json.Question) === "string", wstart.status + " " + wstart.text.slice(0, 200));
  const wver2 = wstart.json.version ?? wstart.json.Version ?? wver;
  const wans = await api("POST", "/api/wizard/" + wid + "/interview", { answer: "browser answer", version: wver2 });
  ok("ui-wizard-answer", wans.status === 200, wans.status + " " + wans.text.slice(0, 200));
  const drun = await api("POST", "/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "browser discussion check" });
  ok("ui-discussion-run", drun.status === 200 && (drun.json.published ?? drun.json.Published ?? []).length >= 1, drun.status + " " + drun.text.slice(0, 300));
  await gotoTab("Meetings");
  await page.waitForTimeout(1500);
  ok("ui-discussion-renders", await bodyHas("QA advisor reply"), "advisor reply missing in UI");
  // lane D: adopt-to-record via REAL UI (no API POST for verified actions; GET validations only)
  const dexact = "Browser direction line one\nBrowser direction line two exact.";
  await gotoTab("Meetings");
  const meetPick2 = page.getByText(run + " meeting").first();
  await meetPick2.click({ timeout: 15000 });
  await page.waitForTimeout(1500);
  ok("meeting-reselect", await bodyHas("Browser seeded question"), "meeting detail missing before Options");
  const optionsTab = page.getByRole("tab", { name: "Options" }).first();
  await optionsTab.click({ timeout: 15000 });
  await page.waitForTimeout(1200);
  await shot("meeting-options");
  const exactField = page.getByLabel(/^\s*Exact text/).first();
  await exactField.fill(dexact, { timeout: 15000 });
  const scopeField = page.getByLabel(/^\s*Scope/).first();
  await scopeField.selectOption("meeting", { timeout: 15000 });
  const adoptRespP = page.waitForResponse((r) => r.url().includes("/api/boards/" + bid + "/directions") && r.request().method() === "POST", { timeout: 30000 });
  await page.getByRole("button", { name: /Adopt exact text/ }).first().click({ timeout: 15000 });
  const adoptResp = await adoptRespP;
  ok("ui-adopt-201", adoptResp.status() === 201, String(adoptResp.status()));
  let adoptJson = null; try { adoptJson = await adoptResp.json(); } catch { adoptJson = null; }
  const noteIdUi = adoptJson?.id ?? adoptJson?.Id ?? "";
  const noteBodyUi = adoptJson?.body ?? adoptJson?.Body ?? "";
  const noteScopeUi = adoptJson?.scope ?? adoptJson?.Scope ?? "";
  ok("ui-adopt-exact", noteBodyUi === dexact && noteScopeUi === "meeting" && typeof noteIdUi === "string" && noteIdUi.length > 10, JSON.stringify(adoptJson).slice(0, 500));
  await page.waitForFunction((t) => document.body.innerText.includes(t), "Browser direction line two exact.", { timeout: 30000 });
  await shot("direction-adopted");
  const dirRow = page.locator(".takenote", { hasText: "Browser direction line two exact." }).first();
  await dirRow.waitFor({ timeout: 30000 });
  const fromRespP = page.waitForResponse((r) => r.url().includes("/api/meetings/" + mid + "/record/from-direction") && r.request().method() === "POST", { timeout: 30000 });
  await dirRow.getByRole("button", { name: /Record this direction/ }).first().click({ timeout: 15000 });
  const fromResp = await fromRespP;
  ok("ui-fromdir-201", fromResp.status() === 201, String(fromResp.status()));
  let fromJson = null; try { fromJson = await fromResp.json(); } catch { fromJson = null; }
  const newRecId = fromJson?.id ?? fromJson?.Id ?? "";
  ok("ui-fromdir-id", typeof newRecId === "string" && newRecId.length > 10, String(newRecId).slice(0, 80));
  const fitems = JSON.parse(fromJson?.itemsJson ?? fromJson?.ItemsJson ?? "[]");
  ok("ui-fromdir-exact", fitems.length === 1 && fitems[0].text === dexact, JSON.stringify(fitems).slice(0, 500));
  await page.waitForFunction((id) => window.location.hash.includes(id), newRecId, { timeout: 30000 });
  await page.waitForTimeout(1200);
  await shot("records-from-direction");
  const hashNow = await page.evaluate(() => window.location.hash);
  ok("ui-fromdir-url", hashNow.includes("#/records") && hashNow.includes(bid) && hashNow.includes(mid) && hashNow.includes(newRecId), hashNow.slice(0, 300));
  await page.waitForFunction((t) => document.body.innerText.includes(t), "Browser direction line one", { timeout: 30000 });
  ok("ui-fromdir-review", await bodyHas("Browser direction line one") && await bodyHas("Browser direction line two exact."), "new exact item missing in selected review");
  const recList = await api("GET", "/api/meetings/" + mid + "/records");
  const newRec = (recList.json || []).find((r) => (r.id ?? r.Id) === newRecId);
  const oldRec = (recList.json || []).find((r) => (r.id ?? r.Id) === d1.json.id);
  ok("ui-fromdir-draft-unapproved", !!newRec && !(newRec.decided ?? newRec.Decided) && (newRec.status ?? newRec.Status) !== "approved", JSON.stringify(newRec).slice(0, 300));
  ok("ui-fromdir-old-approved", !!oldRec && !!(oldRec.decided ?? oldRec.Decided) && (oldRec.status ?? oldRec.Status) === "approved", JSON.stringify(oldRec).slice(0, 300));
  ok("tabs-smoke", true);

  await page.close(); await ctx.close(); // never close the shared browser
  const summary = { pass, fail, failures, consoleErrors: [...new Set(consoleErrors)].slice(0, 20) };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
  const bad = fail !== 0 || consoleErrors.length !== 0; console.log(!bad ? `BROWSERQA PASS ${pass}` : `BROWSERQA DONE pass=${pass} fail=${fail} consoleErrors=${consoleErrors.length}`);
  for (const f of failures) console.log(" - " + f);
  for (const c of summary.consoleErrors) console.log(" console: " + c);
  process.exit(bad ? 1 : 0);
} catch (e) {
  try { if (page && !page.isClosed()) await page.screenshot({ path: path.join(OUT, "fatal.png") }); } catch {}
  try { if (page && !page.isClosed()) await page.close(); } catch {}
  try { if (ctx) await ctx.close(); } catch {}
  console.log("BROWSERQA FATAL: " + (e?.message || e));
  process.exit(1);
}
