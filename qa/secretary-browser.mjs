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
    try { if (ctx && ownedBrowser) await ctx.close(); } catch { }
    try { if (browser) { if (ownedBrowser) await browser.close(); else await browser.disconnect(); } } catch { }
    browser = null; ctx = null; page = null;
  };
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
  try {
    browser = await chromium.connectOverCDP("http://127.0.0.1:9333", { timeout: 10000 });
    ownedBrowser = false;
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  } catch {
    try { if (browser) await browser.disconnect(); } catch { }
    browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    ownedBrowser = true;
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  }
  page = await ctx.newPage();
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
        const chatA1 = (await fakeLog()).length;
        await page.goto(urlTake, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(2000);
        const ab = page.getByLabel("Answer");
        try { await ab.fill("Range 10 to 20"); } catch { }
        try { await page.getByRole("button", { name: /Send answer/ }).first().click({ timeout: 5000 }); } catch { }
        await page.waitForTimeout(4000);
        const chatA2 = (await fakeLog()).length;
        const na2 = await req("GET", "/api/meetings/" + mid + "/notes");
        const still = (na2.json || []).some((n) => String(n.id || n.Id) === String(ansId));
        ok("browser-answer-retry", still && chatA2 === chatA1, "delta=" + (chatA2 - chatA1));
      } else { ok("browser-answer-retry", false, "no answer note"); }
    } else { ok("browser-answer-persisted", false, "no clarification"); ok("browser-answer-retry", false, "no clarification"); }
  } catch (e) { ok("browser-clarification-rendered", false, String(e).slice(0,400)); try { ok("browser-answer-persisted", false, String(e).slice(0,200)); } catch { } try { ok("browser-answer-retry", false, String(e).slice(0,200)); } catch { } }
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
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
    await page.goto(urlTake, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(3000);
    const topicBox = page.getByPlaceholder("e.g. pricing risks");
    const hasBrief = await topicBox.count();
    if (hasBrief > 0) {
      const b4 = (await req("GET", "/api/meetings/" + mid + "/notes")).json.length;
      await topicBox.fill("browser briefing risks SECRETARY-BRIEFING");
      await page.getByRole("button", { name: "Prepare briefing" }).first().click({ timeout: 8000 });
      await page.waitForTimeout(7000);
      const bAfter = await req("GET", "/api/meetings/" + mid + "/notes");
      const bNew = (bAfter.json || []).filter((n) => ((n.kind || n.Kind) || "").indexOf("briefing") >= 0);
      ok("browser-briefing-prepared", bAfter.status === 200 && bNew.length > 0 && (bAfter.json || []).length >= b4, "count=" + b4 + "->" + (bAfter.json || []).length);
      const tB = await page.content();
      ok("browser-briefing-rendered", tB.indexOf("QA briefing body") >= 0, tB.slice(0, 400));
    } else { ok("browser-briefing-prepared", false, "no Prepare briefing UI"); ok("browser-briefing-rendered", false, "no Prepare briefing UI"); }
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
  await closeBrowser();
  fs.appendFileSync(OUT, "DONE pass=" + pass + " fail=" + fail + "\n");
  console.log("DONE pass=" + pass + " fail=" + fail);
  if (fail > 0) process.exit(1);
}
main().catch(async (e) => {
  try { const f = (globalThis).__secClose; if (f) await f(); } catch { }
  fs.appendFileSync(OUT, "FATAL " + String(e) + "\n"); console.log("FATAL " + String(e)); process.exit(1);
});
process.on("unhandledRejection", async (e) => {
  try { const f = (globalThis).__secClose; if (f) await f(); } catch { }
  fs.appendFileSync(OUT, "FATAL-UNHANDLED " + String(e) + "\n"); try { process.exitCode = 1; } catch { }
});
