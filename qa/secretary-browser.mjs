import crypto from "node:crypto";
import fs from "node:fs";
import { chromium } from "playwright-core";
const API = process.env.QA_API || "http://127.0.0.1:5113";
const WEB = process.env.QA_WEB || "http://127.0.0.1:5191";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:5205";
const OUT = process.env.QA_BROWSER_OUT || ".tmp/secretary-browser-result.txt";
fs.mkdirSync(".tmp", { recursive: true });
fs.writeFileSync(OUT, "START " + new Date().toISOString() + "\n");
let pass = 0; let fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; fs.appendFileSync(OUT, "PASS " + name + "\n"); } else { fail++; fs.appendFileSync(OUT, "FAIL " + name + (extra ? " :: " + extra : "") + "\n"); console.log("FAIL " + name + (extra ? " :: " + extra : "")); } }
async function req(method, path, body) { const r = await fetch(API + path, { method, headers: { "content-type": "application/json", "x-user": "owner" }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { } return { status: r.status, json, text }; }
async function fakeLogClear() { try { await fetch(FAKE + "/__log", { method: "DELETE" }); } catch { } }
async function fakeLog() { try { const r = await fetch(FAKE + "/__log"); return await r.json(); } catch { return []; } }
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
async function main() {
  let browser = null; let ctx = null; let page = null; let ownedBrowser = false; (globalThis).__secClose = null;
  const closeBrowser = async () => {
    let ctxErr = null, brErr = null;
    try { if (ctx) await ctx.close(); } catch (e) { ctxErr = String(e).slice(0, 160); }
    try { if (browser) await browser.close(); } catch (e) { brErr = String(e).slice(0, 160); }
    browser = null; ctx = null; page = null;
    return { ctxErr, brErr };
  };
  async function cdpTargets() { try { const r = await fetch("http://127.0.0.1:9333/json/list"); return await r.json(); } catch { return null; } }
async function cdpVersion() { try { const r = await fetch("http://127.0.0.1:9333/json/version"); return await r.json(); } catch { return null; } }
  try { (globalThis).__secClose = closeBrowser; } catch { }
  const run = "b-" + Date.now().toString(36);
  const b = await req("POST", "/api/boards", { name: run + " board", mission: run + " mission", stage: "qa" });
  ok("browser-board", b.status === 201, b.status + " " + b.text.slice(0, 200));
  const bid = b.json.id || b.json.Id;
  await req("POST", "/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Chief", background: "bg", familiarTopics: "fam", simplerTopics: "sim", commPrefs: "direct" });
  const q = await req("POST", "/api/roster/quick", { accountId: crypto.randomUUID(), name: run + " adv", description: "advisor helping with " + run + " and strategy work for browser" });
  ok("browser-roster", q.status === 201, q.status + " " + q.text.slice(0, 200));
  const rid = q.json.id || (q.json.entry && q.json.entry.id);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const form = new FormData(); form.append("file", new Blob([png], { type: "image/png" }), "qa.png");
  const upRaw = await fetch(API + "/api/roster/" + rid + "/image/upload", { method: "POST", headers: { "x-user": "owner" }, body: form });
  await upRaw.text();
  const imgs = await req("GET", "/api/roster/" + rid + "/images", undefined);
  const imgId = (imgs.json && imgs.json[0] && (imgs.json[0].id || imgs.json[0].Id)) || null;
  await req("POST", "/api/images/" + imgId + "/review", { decision: "accept" });
  const cp = await req("POST", "/api/roster/" + rid + "/copy", { boardId: bid, boardRole: "Strategist" });
  const aid = cp.json.id || cp.json.Id;
  await req("POST", "/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
  const m = await req("POST", "/api/boards/" + bid + "/meetings", { title: run + " meeting", brief: "browser brief" });
  const mid = m.json.id || m.json.Id;
  const m2 = await req("POST", "/api/boards/" + bid + "/meetings", { title: run + " meeting2", brief: "second brief" });
  const mid2 = m2.json.id || m2.json.Id;
  const fd = new FormData(); fd.append("file", new Blob(["Browser grounding text. Budget 10 to 20. Approved policy section."], { type: "text/plain" }), "browser.txt"); fd.append("scope", "board");
  const upRaw2 = await fetch(API + "/api/boards/" + bid + "/sources/upload", { method: "POST", headers: { "x-user": "owner" }, body: fd });
  const upText2 = await upRaw2.text(); let upJson = null; try { upJson = JSON.parse(upText2); } catch { }
  const sid = upJson.id || upJson.Id;
  await req("POST", "/api/sources/" + sid + "/approve", {});
  await req("POST", "/api/meetings/" + mid + "/resume", {});
  await req("POST", "/api/meetings/" + mid2 + "/resume", {});
  try {
    const anon = await fetch(WEB + "/api/boards", { method: "GET" });
    const anonText = await anon.text();
    const direct = await fetch(API + "/api/boards", { method: "GET" });
    const directText = await direct.text();
    ok("browser-proxy-no-default", anon.status === direct.status && anonText === directText, "proxy=" + anon.status + " direct=" + direct.status);
  } catch (e) { ok("browser-proxy-no-default", false, String(e).slice(0, 200)); }
  try {
    const regEmail = "brow-" + Date.now().toString(36) + "@qa.local";
    const reg = await fetch(API + "/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: regEmail, password: "qa-password-12345" }) });
    const regJ = await reg.json().catch(() => null);
    const tok = regJ && (regJ.token || regJ.Token);
    ok("browser-auth-register", reg.status === 201 && !!tok, "status=" + reg.status);
    if (tok) {
      const meR = await fetch(WEB + "/api/auth/me", { headers: { "authorization": "Bearer " + tok } });
      const meT = await meR.text();
      ok("browser-proxy-bearer-forward", meR.status === 200 && meT.indexOf(regEmail) >= 0, "status=" + meR.status + " " + meT.slice(0, 160));
    } else { ok("browser-proxy-bearer-forward", false, "no token"); }
  } catch (e) { ok("browser-auth-register", false, String(e).slice(0, 200)); ok("browser-proxy-bearer-forward", false, String(e).slice(0, 200)); }
  const cdpBefore = await cdpTargets();
  const cdpVerBefore = await cdpVersion();
  const cdpWsBefore = cdpVerBefore ? (cdpVerBefore.webSocketDebuggerUrl || "") : "";
  // Owned headless Edge is preferred; parallel CDP is avoided. Only use shared CDP when explicitly present,
  // and never leak an already-connected browser object if context creation fails.
  try {
    const tmp = await chromium.connectOverCDP("http://127.0.0.1:9333", { timeout: 10000 });
    try {
      ctx = await tmp.newContext({ viewport: { width: 1440, height: 900 } });
      browser = tmp;
      ownedBrowser = false;
    } catch (eCtx) {
      try { await tmp.close(); } catch { }
      throw eCtx;
    }
  } catch {
    browser = null; ctx = null;
    // Own headless Edge (hidden, no parallel CDP): exact owned instance, safe Browser.close() disconnects only transport on CDP.
    browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    ownedBrowser = true;
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  }
  page = await ctx.newPage();
  page.on("pageerror", (e) => { try { fs.appendFileSync(OUT, "PAGEERROR " + String(e).slice(0, 300) + "\n"); } catch { } });
  page.on("console", (m) => { try { if (m.type() === "error") fs.appendFileSync(OUT, "CONSOLE-ERROR " + String(m.text()).slice(0, 200) + "\n"); } catch { } });
  async function contentHas(text, timeoutMs) { try { await page.waitForFunction((tt) => document.body.textContent.indexOf(tt) >= 0, text, { timeout: timeoutMs || 15000 }); return true; } catch { return false; } }
  await page.setExtraHTTPHeaders({ "x-user": "owner" });
  await fakeLogClear();
  const urlChat = WEB + "/#/meet?board=" + bid + "&meeting=" + mid;
  await page.goto(urlChat, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(8000);
  const audience = page.locator(`select[aria-label="Message audience"]`);
  try { await audience.selectOption("secretary", { timeout: 8000 }); ok("browser-audience-select", true, ""); } catch (e) { ok("browser-audience-select", false, String(e).slice(0,300)); }
  const box = page.locator("textarea[aria-label]").first();
  await box.fill("Summarize browser grounding SECRETARY-NOTE");
  const sendBtn = page.getByRole("button", { name: "Send" }).first();
  await sendBtn.click({ timeout: 8000 });
  await page.waitForTimeout(7000);
  const notesApi1 = await req("GET", "/api/meetings/" + mid + "/notes");
  const hasNote1 = (notesApi1.json || []).some((n) => JSON.stringify(n).includes("QA provisional note body"));
  ok("browser-audience-note-persisted", hasNote1, notesApi1.text.slice(0,400));
  const lg1 = await fakeLog();
  ok("browser-audience-zero-bids", (lg1 || []).filter((e) => e.bid).length === 0, "bids=" + (lg1||[]).filter((e)=>e.bid).length);
  const noteId1 = ((notesApi1.json || []).find((n) => (n.kind||n.Kind) === "secretary-note") || {});
  const nid1 = noteId1.id || noteId1.Id || "";
  ok("browser-note-id-rendered", !!nid1, JSON.stringify(noteId1).slice(0,200));
  const urlTake = WEB + "/#/meet?board=" + bid + "&meeting=" + mid + "&mtab=takeaways";
  await page.goto(urlTake, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(4000);
  const bodyText1 = await page.content();
  ok("browser-takeaways-load", bodyText1.indexOf("Secretary provisional notes") >= 0, bodyText1.slice(0, 400));
  ok("browser-provisional-label", bodyText1.indexOf("Provisional") >= 0, "no provisional");
  ok("browser-note-body-rendered", bodyText1.indexOf("QA provisional note body") >= 0, bodyText1.slice(0,500));
  ok("browser-note-id-in-dom", !!nid1 && bodyText1.indexOf(String(nid1).slice(0, 8)) >= 0, "nid=" + String(nid1).slice(0, 13));
  await page.screenshot({ path: ".tmp/secretary-takeaways.png" });
  const histBtn = page.getByRole("button", { name: "History" }).first();
  try { await histBtn.click({ timeout: 8000 }); await page.waitForTimeout(2000); const t2 = await page.content(); ok("browser-history-open", t2.indexOf("rev 1") >= 0 || t2.indexOf("Root") >= 0, t2.slice(0, 500)); } catch (e) { ok("browser-history-open", false, String(e).slice(0, 300)); }
  await page.screenshot({ path: ".tmp/secretary-history.png" });
  const editBtn = page.getByRole("button", { name: "Edit" }).first();
  try {
    await editBtn.click({ timeout: 8000 }); await page.waitForTimeout(1000);
    const ta = page.locator("textarea").last();
    await ta.fill("Browser edited body with same evidence.");
    const saveBtn = page.getByRole("button", { name: /Save revision/ }).first();
    await saveBtn.click({ timeout: 8000 }); await page.waitForTimeout(3000);
    const notesAfter = await req("GET", "/api/meetings/" + mid + "/notes");
    ok("browser-edit-persisted", JSON.stringify(notesAfter.json).includes("Browser edited body"), notesAfter.text.slice(0,400));
  } catch (e) { ok("browser-edit-persisted", false, String(e).slice(0,400)); }
  try {
    await page.goto(urlTake, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(3000);
    const revBtn = page.getByRole("button", { name: "Reverse" }).first();
    await revBtn.click({ timeout: 8000 }); await page.waitForTimeout(3000);
    const h = await req("GET", "/api/notes/" + nid1 + "/history");
    const htxt = JSON.stringify(h.json || {});
    ok("browser-reverse-ui", h.status === 200 && htxt.indexOf("reversed") >= 0 && htxt.indexOf("Browser edited body") >= 0, h.status + " " + htxt.slice(0, 400));
  } catch (e) { ok("browser-reverse-ui", false, String(e).slice(0,400)); }
  await fakeLogClear();
  await page.goto(urlChat, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: ".tmp/secretary-chat.png" });
  try {
    const beforeIds = new Set(((await req("GET", "/api/meetings/" + mid + "/notes")).json || []).map((n) => n.id || n.Id));
    const chat0 = await fakeLog();
    const chatN0 = chat0.length;
    const box2 = page.locator("textarea[aria-label]").first();
    await box2.fill("Secretary: summarize pricing for browser");
    const sendBtn2 = page.getByRole("button", { name: "Send" }).first();
    await sendBtn2.click({ timeout: 8000 });
    await page.waitForTimeout(7000);
    const afterNotes = await req("GET", "/api/meetings/" + mid + "/notes");
    const newOnes = (afterNotes.json || []).filter((n) => !beforeIds.has(n.id || n.Id));
    const newId = newOnes.length === 1 ? (newOnes[0].id || newOnes[0].Id) : "";
    ok("browser-prefix-new-request", newOnes.length === 1 && !!newId, "new=" + newOnes.length);
    const chat1 = await fakeLog();
    const newPrompts = chat1.slice(chatN0);
    ok("browser-prefix-one-provider", newPrompts.length === 1 && (newPrompts[0].prompt || "").indexOf("summarize pricing for browser") >= 0, "prompts=" + newPrompts.length);
    await page.goto(urlTake, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    const t3 = await page.content();
    ok("browser-prefix-routing", !!newId && t3.indexOf(String(newId).slice(0, 8)) >= 0, t3.slice(0, 500));
    const lg2 = await fakeLog();
    ok("browser-prefix-zero-bids", (lg2 || []).filter((e) => e.bid).length === 0, "bids=" + (lg2||[]).filter((e)=>e.bid).length);
  } catch (e) { ok("browser-prefix-new-request", false, String(e).slice(0, 300)); ok("browser-prefix-one-provider", false, String(e).slice(0, 200)); ok("browser-prefix-routing", false, String(e).slice(0, 400)); ok("browser-prefix-zero-bids", false, String(e).slice(0,200)); }
  await page.screenshot({ path: ".tmp/secretary-routing.png" });
  try {
    const box3 = page.locator("textarea[aria-label]").first();
    await page.goto(urlChat, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(2000);
    await box3.fill("Secretary: Help with SECRETARY-AMBIGUOUS budget");
    await page.getByRole("button", { name: "Send" }).first().click({ timeout: 8000 });
    await page.waitForTimeout(7000);
    await page.goto(urlTake, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(3000);
    const tc = await page.content();
    const hasClar = tc.indexOf("Secretary clarification") >= 0;
    ok("browser-clarification-rendered", hasClar, tc.slice(0,500));
    if (hasClar) {
      const ansBox = page.getByLabel("Answer");
      try { await ansBox.fill("Range 10 to 20"); } catch { await page.locator("textarea").last().fill("Range 10 to 20"); }
      const chatA0 = (await fakeLog()).length;
      await page.getByRole("button", { name: /Send answer/ }).first().click({ timeout: 8000 });
      await page.waitForTimeout(7000);
      const na = await req("GET", "/api/meetings/" + mid + "/notes");
      const ansNote = (na.json || []).find((n) => JSON.stringify(n).includes("after clarification"));
      const ansId = ansNote ? (ansNote.id || ansNote.Id) : "";
      const ansReq = await req("GET", "/api/meetings/" + mid + "/secretary/requests");
      const ansReqRow = (Array.isArray(ansReq.json) ? ansReq.json : []).find((r) => (r.status || r.Status) === "completed" && (r.answer || r.Answer || "").includes("Range 10 to 20"));
      ok("browser-answer-persisted", na.status === 200 && !!ansId && !!(ansReqRow && (ansReqRow.id || ansReqRow.Id)), na.status + " " + na.text.slice(0, 200));
      if (ansId) {
        const reqIdA = ansReqRow ? (ansReqRow.id || ansReqRow.Id) : "";
        await page.goto(urlTake, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(2500);
        const tA = await page.content();
        const abCount = await page.getByLabel("Answer").count();
        const sendCount = await page.getByRole("button", { name: /Send answer/ }).count();
        const chatA1 = (await fakeLog()).length;
        const completedRow = (await req("GET", "/api/meetings/" + mid + "/secretary/requests")).json;
        const completedHit = (Array.isArray(completedRow) ? completedRow : []).some((r) => String(r.id || r.Id) === String(reqIdA) && (r.status || r.Status) === "completed");
        ok("browser-answer-retry-resolved-absent", abCount === 0 && sendCount === 0 && completedHit && tA.indexOf("Secretary clarification") < 0, "ab=" + abCount + " send=" + sendCount + " completed=" + completedHit);
        const chatA2 = (await fakeLog()).length;
        ok("browser-answer-retry-resolved-nocall", chatA2 === chatA1, "delta=" + (chatA2 - chatA1));
      } else { ok("browser-answer-retry-resolved-absent", false, "no answer note"); ok("browser-answer-retry-resolved-nocall", false, "no answer note"); }
    } else { ok("browser-answer-persisted", false, "no clarification"); ok("browser-answer-retry-resolved-absent", false, "no clarification"); ok("browser-answer-retry-resolved-nocall", false, "no clarification"); }
  } catch (e) { ok("browser-clarification-rendered", false, String(e).slice(0,400)); try { ok("browser-answer-persisted", false, String(e).slice(0,200)); } catch { } try { ok("browser-answer-retry-resolved-absent", false, String(e).slice(0,200)); } catch { } try { ok("browser-answer-retry-resolved-nocall", false, String(e).slice(0,200)); } catch { } }
  try {
    await page.goto(urlChat, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(2000);
    await page.locator("textarea[aria-label]").first().fill("Secretary: failing answer SECRETARY-AMBIGUOUS");
    await page.getByRole("button", { name: "Send" }).first().click({ timeout: 8000 });
    await page.waitForTimeout(7000);
    await page.goto(urlTake, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(3000);
    const hasClarF = await contentHas("Secretary clarification", 15000);
    const tcF = await page.content();
    ok("browser-answerfail-clarification", hasClarF, tcF.slice(0, 400));
    if (hasClarF) {
      await page.getByLabel("Answer").first().fill("zz SECRETARY-BAD");
      await page.getByRole("button", { name: /Send answer/ }).first().click({ timeout: 8000 });
      await page.waitForTimeout(7000);
      const tcE = await page.content();
      const errCard = tcE.indexOf("Secretary error") >= 0;
      const retryBtn = await page.getByRole("button", { name: /Retry answer/ }).count();
      ok("browser-answerfail-errorcard", errCard && retryBtn >= 1, tcE.slice(0, 400) + " retryBtn=" + retryBtn);
      const rowsF = await req("GET", "/api/meetings/" + mid + "/secretary/requests");
      const rowF = (Array.isArray(rowsF.json) ? rowsF.json : []).find((r) => (r.answer || r.Answer || "").indexOf("zz SECRETARY-BAD") >= 0);
      const reqF = rowF ? (rowF.id || rowF.Id) : "";
      ok("browser-answerfail-row-needs-clarification", !!rowF && (rowF.status || rowF.Status) === "needs-clarification", JSON.stringify(rowF && (rowF.status || rowF.Status)));
      const chatF0 = (await fakeLog()).length;
      if (retryBtn >= 1) {
        await page.getByRole("button", { name: /Retry answer/ }).first().click({ timeout: 8000 });
        await page.waitForTimeout(7000);
      }
      const chatF1 = (await fakeLog()).length;
      const rowsF2 = await req("GET", "/api/meetings/" + mid + "/secretary/requests");
      const rowF2 = (Array.isArray(rowsF2.json) ? rowsF2.json : []).find((r) => String(r.id || r.Id) === String(reqF));
      ok("browser-answerfail-retry-same", !!rowF2 && String(rowF2.id || rowF2.Id) === String(reqF) && (rowF2.status || rowF2.Status) === "needs-clarification" && (chatF1 - chatF0) === 1, "req=" + reqF + " delta=" + (chatF1 - chatF0));
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(2000);
      await contentHas("Secretary error", 15000);
      const tcR = await page.content();
      const retryBtn2 = await page.getByRole("button", { name: /Retry answer/ }).count();
      ok("browser-answerfail-hydrated", retryBtn2 >= 1 && tcR.indexOf("Secretary error") >= 0, "retryBtn=" + retryBtn2);
    } else { ok("browser-answerfail-errorcard", false, "no clarification"); ok("browser-answerfail-row-needs-clarification", false, "no clarification"); ok("browser-answerfail-retry-same", false, "no clarification"); ok("browser-answerfail-hydrated", false, "no clarification"); }
  } catch (e) { ok("browser-answerfail-clarification", false, String(e).slice(0, 300)); try { ok("browser-answerfail-errorcard", false, String(e).slice(0, 200)); } catch { } try { ok("browser-answerfail-row-needs-clarification", false, String(e).slice(0, 200)); } catch { } try { ok("browser-answerfail-retry-same", false, String(e).slice(0, 200)); } catch { } try { ok("browser-answerfail-hydrated", false, String(e).slice(0, 200)); } catch { } }
  try {
    await page.goto(urlChat, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(2000);
    await page.locator("textarea[aria-label]").first().fill("Secretary: Fail SECRETARY-BAD initial browser");
    await page.getByRole("button", { name: "Send" }).first().click({ timeout: 8000 });
    await page.waitForTimeout(7000);
    await page.goto(urlTake, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(2000);
    await contentHas("Secretary error", 15000);
    let tcI = await page.content();
    const errI = tcI.indexOf("Secretary error") >= 0;
    const urlI = page.url();
    try { if (!(errI)) await page.screenshot({ path: ".tmp/secretary-initialfail.png" }); } catch { }
    const retryI = await page.getByRole("button", { name: /Retry secretary/ }).count();
    ok("browser-initial-failed-card", errI && retryI >= 1, "url=" + urlI + " retry=" + retryI);
    const rowsI = await req("GET", "/api/meetings/" + mid + "/secretary/requests");
    const rowI = (Array.isArray(rowsI.json) ? rowsI.json : []).find((r) => (r.inputText || r.InputText || "").indexOf("Fail SECRETARY-BAD initial browser") >= 0);
    const reqI = rowI ? (rowI.id || rowI.Id) : "";
    ok("browser-initial-failed-row", !!rowI && (rowI.status || rowI.Status) === "failed", JSON.stringify(rowI && (rowI.status || rowI.Status)));
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(2000);
    await contentHas("Secretary error", 15000);
    tcI = await page.content();
    const retryI2 = await page.getByRole("button", { name: /Retry secretary/ }).count();
    ok("browser-initial-failed-hydrated", retryI2 >= 1 && tcI.indexOf("Secretary error") >= 0, "retry=" + retryI2);
    const chatI0 = (await fakeLog()).length;
    if (retryI2 >= 1) {
      await page.getByRole("button", { name: /Retry secretary/ }).first().click({ timeout: 8000 });
      await page.waitForTimeout(7000);
    }
    const chatI1 = (await fakeLog()).length;
    const rowsI2 = await req("GET", "/api/meetings/" + mid + "/secretary/requests");
    const rowI2 = (Array.isArray(rowsI2.json) ? rowsI2.json : []).find((r) => String(r.id || r.Id) === String(reqI));
    ok("browser-initial-failed-retry-same", !!rowI2 && (rowI2.status || rowI2.Status) === "failed" && (chatI1 - chatI0) === 1, "req=" + reqI + " delta=" + (chatI1 - chatI0));
  } catch (e) { ok("browser-initial-failed-card", false, String(e).slice(0, 300)); try { ok("browser-initial-failed-row", false, String(e).slice(0, 200)); } catch { } try { ok("browser-initial-failed-hydrated", false, String(e).slice(0, 200)); } catch { } try { ok("browser-initial-failed-retry-same", false, String(e).slice(0, 200)); } catch { } }
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await contentHas("Secretary provisional notes", 20000);
  const t4 = await page.content();
  ok("browser-reload-notes-hydrated", t4.indexOf("Secretary provisional notes") >= 0 && (t4.indexOf("QA provisional note") >= 0 || t4.indexOf("Browser edited") >= 0), t4.slice(0, 500));
  try {
    await page.goto(urlTake, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(3000);
    const tHist = await page.content();
    const rootShort = String(nid1).slice(0, 8);
    ok("browser-reversed-root-discoverable", tHist.indexOf("All note history") >= 0 && (!!rootShort && tHist.indexOf(rootShort) >= 0), tHist.slice(0, 500));
    const rootCard = page.locator(".takenote", { hasText: String(nid1).slice(0, 8) });
    if (await rootCard.count() > 0) {
      await rootCard.getByRole("button", { name: "History" }).first().click({ timeout: 8000 }); await page.waitForTimeout(2000);
      const tH = await page.content();
      ok("browser-reversed-history-after-reload", tH.indexOf("reversed") >= 0 && tH.indexOf("Browser edited body") >= 0, tH.slice(0, 500));
    } else { ok("browser-reversed-history-after-reload", false, "reversed root card not found"); }
  } catch (e) { ok("browser-reversed-root-discoverable", false, String(e).slice(0, 300)); ok("browser-reversed-history-after-reload", false, String(e).slice(0, 200)); }
  try {
    await page.goto(WEB + "/#/meet?board=" + bid + "&meeting=" + mid2, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    const other = await page.content();
    ok("browser-identity-scoped", other.indexOf("Browser edited body") < 0, other.slice(0,400));
    await page.goto(urlChat, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(2000);
    const backBox = page.locator("textarea[aria-label]").first();
    await backBox.fill("unsent draft must survive");
    await page.waitForTimeout(500);
    const v = await backBox.inputValue();
    ok("browser-draft-preserved", v === "unsent draft must survive", v.slice(0,100));
  } catch (e) { ok("browser-identity-scoped", false, String(e).slice(0,300)); ok("browser-draft-preserved", false, String(e).slice(0,200)); }
  try {
    const lsKeys = await page.evaluate(() => Object.keys(localStorage));
    const ownerKeys = lsKeys.filter((k) => k.indexOf("sec-envelope:owner:") === 0 || k.indexOf("sec-answer-envelope:owner:") === 0);
    ok("browser-identity-owner-envelope", ownerKeys.length > 0, ownerKeys.slice(0, 3).join(","));
    const urlPeople = WEB + "/#/people?board=" + bid;
    await page.goto(urlPeople, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(2500);
    const actBox = page.getByLabel("Act as user");
    const actCount = await actBox.count();
    ok("browser-identity-box", actCount >= 1, "actCount=" + actCount);
    if (actCount >= 1) {
      await actBox.first().fill("bob");
      try { await page.waitForFunction(() => (document.querySelector("textarea[aria-label]") || { value: "" }).value !== undefined, null, { timeout: 5000 }); } catch { }
      await page.waitForTimeout(1000);
      const keysUnapplied = await page.evaluate(() => Object.keys(localStorage));
      const bobUnapplied = keysUnapplied.filter((k) => k.indexOf(":bob:") >= 0 && k.indexOf("sec-") === 0);
      ok("browser-identity-unapplied-text-ignored", bobUnapplied.length === 0, bobUnapplied.slice(0, 3).join(","));
      await page.getByRole("button", { name: "Apply identity" }).first().click({ timeout: 8000 });
      await page.waitForTimeout(3000);
      const tcBob = await page.content();
      const noStaleClar = tcBob.indexOf("Secretary clarification") < 0;
      await page.goto(urlChat, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(2000);
      await page.locator("textarea[aria-label]").first().fill("Secretary: bob probe SECRETARY-NOTE");
      await page.waitForTimeout(500);
      const bobDis = await page.getByRole("button", { name: "Send" }).first().isDisabled();
      fs.appendFileSync(OUT, "BOB send disabled=" + bobDis + "\n");
      await page.getByRole("button", { name: "Send" }).first().click({ timeout: 8000 });
      await page.waitForTimeout(7000);
      const keysBob = await page.evaluate(() => Object.keys(localStorage));
      const bobKeys = keysBob.filter((k) => k.indexOf(":bob:") >= 0 && k.indexOf("sec-") === 0);
      const tcBob2 = await page.content();
      const bobDenied = tcBob2.indexOf("Access revoked") >= 0 || tcBob2.indexOf("Secretary error") >= 0;
      const rowsBob = await req("GET", "/api/meetings/" + mid + "/secretary/requests");
      const rowBob = (Array.isArray(rowsBob.json) ? rowsBob.json : []).find((r) => (r.inputText || r.InputText || "").indexOf("bob probe") >= 0);
      fs.appendFileSync(OUT, "BOB row=" + (rowBob ? JSON.stringify({ s: rowBob.status || rowBob.Status, n: rowBob.clientNonce || rowBob.ClientNonce }).slice(0, 120) : "none") + " bodyHasError=" + (tcBob2.indexOf("error") >= 0) + "\n");
      ok("browser-identity-applied-switch", noStaleClar && (bobKeys.length > 0 || bobDenied || !!rowBob), "noStaleClar=" + noStaleClar + " bobKeys=" + bobKeys.length + " denied=" + bobDenied + " row=" + !!rowBob);
    } else { ok("browser-identity-unapplied-text-ignored", false, "no act box"); ok("browser-identity-applied-switch", false, "no act box"); }
  } catch (e) { ok("browser-identity-owner-envelope", false, String(e).slice(0, 300)); try { ok("browser-identity-box", false, String(e).slice(0, 200)); } catch { } try { ok("browser-identity-unapplied-text-ignored", false, String(e).slice(0, 200)); } catch { } try { ok("browser-identity-applied-switch", false, String(e).slice(0, 200)); } catch { } }
  try {
    await page.goto(urlTake, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(3000);
    const topicBox = page.getByPlaceholder("e.g. pricing risks");
    const hasBrief = await topicBox.count();
    if (hasBrief > 0) {
      const b4 = await req("GET", "/api/meetings/" + mid + "/notes");
      const beforeIds = new Set((b4.json || []).map((n) => n.id || n.Id));
      const chatB0 = (await fakeLog()).length;
      await topicBox.fill("browser briefing risks SECRETARY-BRIEFING");
      await page.getByRole("button", { name: "Prepare briefing" }).first().click({ timeout: 8000 });
      await page.waitForTimeout(7000);
      const bAfter = await req("GET", "/api/meetings/" + mid + "/notes");
      const newOnes = (bAfter.json || []).filter((n) => !beforeIds.has(n.id || n.Id));
      const newBrief = newOnes.length === 1 ? newOnes[0] : null;
      ok("browser-briefing-prepared", bAfter.status === 200 && newOnes.length === 1 && ((newBrief.kind || newBrief.Kind) || "").indexOf("briefing") >= 0, "new=" + newOnes.length);
      ok("browser-briefing-exact", !!newBrief && (newBrief.title || newBrief.Title) === "QA briefing" && (newBrief.body || newBrief.Body) === "QA briefing body with grounded support.", JSON.stringify(newBrief).slice(0, 300));
      const chatB1 = (await fakeLog()).length;
      ok("browser-briefing-one-provider", (chatB1 - chatB0) === 1, "delta=" + (chatB1 - chatB0));
      const lgB = await fakeLog();
      const lastB = lgB.length > 0 ? (lgB[lgB.length - 1].prompt || "") : "";
      ok("browser-briefing-prompt-topic", lastB.indexOf("browser briefing risks SECRETARY-BRIEFING") >= 0, lastB.slice(-200));
      const tB = await page.content();
      ok("browser-briefing-rendered", tB.indexOf("QA briefing body") >= 0, tB.slice(0, 400));
    } else { ok("browser-briefing-prepared", false, "no Prepare briefing UI"); ok("browser-briefing-exact", false, "no Prepare briefing UI"); ok("browser-briefing-one-provider", false, "no Prepare briefing UI"); ok("browser-briefing-prompt-topic", false, "no Prepare briefing UI"); ok("browser-briefing-rendered", false, "no Prepare briefing UI"); }
  } catch (e) { ok("browser-briefing-prepared", false, String(e).slice(0, 300)); ok("browser-briefing-rendered", false, String(e).slice(0, 200)); }
  try {
    await page.goto(urlChat, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(2000);
    const nHeld0 = (await req("GET", "/api/meetings/" + mid + "/notes")).json.length;
    const slowBox = page.locator("textarea[aria-label]").first();
    await slowBox.fill("Secretary: slow held completion SECRETARY-NOTE QA-SLEEP:5000");
    await page.getByRole("button", { name: "Send" }).first().click({ timeout: 8000 });
    await page.waitForTimeout(800);
    await slowBox.fill("unsent draft must survive late completion");
    await page.waitForTimeout(8000);
    const held = await slowBox.inputValue();
    const heldNotes = await req("GET", "/api/meetings/" + mid + "/notes");
    const heldLg = await fakeLog();
    const heldSlow = heldLg.some((e) => (e.prompt || "").indexOf("slow held completion") >= 0);
    ok("browser-held-completion", held === "unsent draft must survive late completion" && (heldNotes.json || []).length === nHeld0 + 1 && heldSlow, "draft=" + held.slice(0, 60) + " notes=" + nHeld0 + "->" + (heldNotes.json || []).length + " slowPrompt=" + heldSlow);
  } catch (e) { ok("browser-held-completion", false, String(e).slice(0, 300)); }
  const cerr = await closeBrowser();
  ok("browser-cleanup-closed", !cerr.ctxErr && !cerr.brErr, JSON.stringify(cerr));
  const cdpAfter = await cdpTargets();
  const cdpVerAfter = await cdpVersion();
  const cdpWsAfter = cdpVerAfter ? (cdpVerAfter.webSocketDebuggerUrl || "") : "";
  if (cdpBefore && cdpAfter) {
    const afterIds = new Set(cdpAfter.map((x) => x.id));
    const kept = cdpBefore.filter((x) => afterIds.has(x.id));
    const ours = cdpAfter.filter((x) => (x.url || "").indexOf("/#/meet?board=" + bid) >= 0);
    // Actual browser instance + user targets retained: compare webSocketDebuggerUrl instance identity, retain ALL preexisting targets by ID.
    const sameInstance = cdpWsBefore && cdpWsAfter && cdpWsBefore === cdpWsAfter;
    ok("browser-cdp-targets-retained", kept.length === cdpBefore.length && sameInstance, "kept=" + kept.length + "/" + cdpBefore.length + " sameInstance=" + !!sameInstance);
    ok("browser-cdp-own-contexts-closed", ours.length === 0, "own=" + ours.length);
    fs.appendFileSync(OUT, "CDP retained=" + kept.length + "/" + cdpBefore.length + " sameInstance=" + !!sameInstance + " ownRemaining=" + ours.length + " wsBefore=" + String(cdpWsBefore).slice(0,40) + "\n");
  } else {
    ok("browser-cdp-targets-retained", ownedBrowser === true, "no shared CDP; owned=" + ownedBrowser);
    ok("browser-cdp-own-contexts-closed", !cerr.ctxErr && !cerr.brErr, JSON.stringify(cerr));
  }
  fs.appendFileSync(OUT, "DONE pass=" + pass + " fail=" + fail + "\n");
  console.log("DONE pass=" + pass + " fail=" + fail);
  if (fail > 0) process.exit(1);
}
main().catch(async (e) => {
  try { const f = (globalThis).__secClose; if (f) await f(); } catch { }
  fs.appendFileSync(OUT, "FATAL " + String((e && e.stack) || e) + "\n"); console.log("FATAL " + String(e)); process.exit(1);
});
process.on("unhandledRejection", async (e) => {
  try { const f = (globalThis).__secClose; if (f) await f(); } catch { }
  fs.appendFileSync(OUT, "FATAL-UNHANDLED " + String((e && e.stack) || e) + "\n"); try { process.exitCode = 1; } catch { }
});
