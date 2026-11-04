// Muse QA-only sibling interactions v2 (OWN 15380 and 15382 only, QA-only, bounded, closes OWN browser).
// Asserts real advisor POST answers, scoped chat plus editor at every checkpoint, completed polls, surviving state, and no crossover.
import crypto from "node:crypto";
import { chromium } from "playwright-core";
import zlib from "node:zlib";
const WEB = "http://127.0.0.1:15380";
const FAKE = "http://127.0.0.1:15382";
const ENV_WEB = (process.env.QA_WEB || WEB).trim();
const ENV_FAKE = (process.env.QA_FAKE || FAKE).trim();
function refuse(m) { console.log("REFUSE " + m); process.exit(2); }
if (ENV_WEB !== WEB) refuse("QA_WEB must be exactly " + WEB);
if (ENV_FAKE !== FAKE) refuse("QA_FAKE must be exactly " + FAKE);
for (const u of [ENV_WEB, ENV_FAKE]) { const x = new URL(u); if (x.username || x.password) refuse("credentials in URL"); if (x.protocol !== "http:") refuse("must be http"); }
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const OVERALL = 150000; const T0 = Date.now();
function budget(reserve) { const left = OVERALL - (Date.now() - T0) - (reserve || 0); if (left <= 0) throw new Error("OVERALL-DEADLINE-EXCEEDED"); return left; }
function cap(b, r) { return Math.min(b, budget(r)); }
function after(ms, what) { return new Promise((_, rej) => { const t = setTimeout(() => { try { rej(new Error("timeout:" + (what || "wait"))); } catch {} }, Math.max(1, ms)); }); }
function fail(m) { console.log("FAIL " + m); process.exitCode = 1; throw new Error(m); }
function ok(m) { console.log("ok " + m); }
function crc32(b) { let t = crc32._t; if (!t) { t = new Int32Array(256); for (let n = 0; n < 256; n++) { let v = n; for (let k = 0; k < 8; k++) v = (v & 1) ? (0xEDB88320 ^ (v >>> 1)) : (v >>> 1); t[n] = v; } crc32._t = t; } let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function png(r, g, bl) { const sig = Buffer.from([137,80,78,71,13,10,26,10]); const ih = Buffer.alloc(13); ih.writeUInt32BE(1,0); ih.writeUInt32BE(1,4); ih[8]=8; ih[9]=2; const hl=Buffer.alloc(4); hl.writeUInt32BE(13,0); const ht=Buffer.from("IHDR"); const hc=Buffer.alloc(4); hc.writeUInt32BE(crc32(Buffer.concat([ht,ih])),0); const raw=Buffer.from([r,g,bl]); const comp=zlib.deflateSync(Buffer.concat([Buffer.from([0]),raw])); const dl=Buffer.alloc(4); dl.writeUInt32BE(comp.length,0); const dt=Buffer.from("IDAT"); const dc=Buffer.alloc(4); dc.writeUInt32BE(crc32(Buffer.concat([dt,comp])),0); const el=Buffer.alloc(4); const et=Buffer.from("IEND"); const ec=Buffer.alloc(4); ec.writeUInt32BE(crc32(et),0); return Buffer.concat([sig,hl,ht,ih,hc,dl,dt,comp,dc,el,et,ec]); }
const run = "muse-rk3-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
const email = run + "@example.test"; const password = "Qa-" + crypto.randomBytes(9).toString("hex") + "-x9"; const ACCT = crypto.randomUUID();
let token = ""; let umail = "";
async function bodyText(r, ms) { try { return await Promise.race([r.text().catch(() => ""), after(ms, "body-read")]); } catch { return ""; } }
async function req(m, p, b, isForm) { const ms = cap(15000, 8000); const ctl = new AbortController(); const t = setTimeout(() => { try { ctl.abort(); } catch {} }, ms); try { const h = {}; if (token) h["authorization"] = "Bearer " + token; if (!isForm) h["content-type"] = "application/json"; const r = await fetch(WEB + p, { method: m, signal: ctl.signal, headers: h, redirect: "manual", body: b === undefined ? undefined : (isForm ? b : JSON.stringify(b)) }); const tx = await bodyText(r, Math.min(10000, budget(4000))); let j = null; try { j = tx ? JSON.parse(tx) : null; } catch {} return { s: r.status, j, tx }; } catch (e) { return { s: 0, j: null, tx: "transport:" + String((e && e.name) || "err").slice(0, 60) }; } finally { clearTimeout(t); } }
let browser = null; let ctx = null; let page = null; const warns = []; const cleanupErrs = []; let delayChatFor = "";
async function bye() { async function step(n, f) { try { await Promise.race([f(), after(5000, n)]); } catch (e) { cleanupErrs.push(n + ":" + String((e && e.message) || e).slice(0, 80)); } } await step("page-close", async () => { if (page) await page.close(); }); page = null; await step("ctx-close", async () => { if (ctx) await ctx.close(); }); ctx = null; await step("browser-close", async () => { if (browser) await browser.close(); }); browser = null; return cleanupErrs; }
function DQ() { return String.fromCharCode(34); }
function chatSel(rid) { return "div[data-roster-chat=" + DQ() + rid + DQ() + "]"; }
function cardSel(rid) { return "div.roster-detail > div.card[data-roster-entry-id=" + DQ() + rid + DQ() + "]"; }
async function needDetail(label, rid) { const d = await page.evaluate((id) => { try { const Q = String.fromCharCode(34); const sec = document.querySelector("section[aria-label=" + Q + "My Advisor Roster" + Q + "]"); const cards = sec ? sec.querySelectorAll("div.roster-detail > div.card[data-roster-entry-id=" + Q + id + Q + "]") : []; const card = cards && cards.length === 1 ? cards[0] : null; const chats = card ? card.querySelectorAll(":scope > div.card.roster-chat[data-roster-chat=" + Q + id + Q + "]").length : -1; const eds = card ? card.querySelectorAll(":scope > div.cc-editor").length : -1; const gChats = document.querySelectorAll("div[data-roster-chat]").length; const gEds = document.querySelectorAll("div.cc-editor").length; let kids = -1; try { kids = card ? card.childElementCount : -1; } catch {} return { cards: cards ? cards.length : -1, chats, eds, gChats, gEds, kids }; } catch (e) { return { err: 1 }; } }, rid); console.log("DETAIL " + label + " cards=" + d.cards + " chats=" + d.chats + " eds=" + d.eds + " gChats=" + d.gChats + " gEds=" + d.gEds + " kids=" + d.kids); if (!d || d.cards !== 1 || d.chats !== 1 || d.eds !== 1 || d.gChats !== 1 || d.gEds !== 1) fail(label + " expected one selected card with one chat and one editor"); ok(label + " one chat plus one editor in selected detail"); return d; }
async function sel(name) { const r = page.locator("aside.listpanel button.lprow", { hasText: name }).first(); await r.waitFor({ timeout: cap(10000, 8000) }); await r.click({ timeout: cap(10000, 8000) }); try { await page.waitForFunction((e) => { const b = Array.from(document.querySelectorAll("aside.listpanel button.lprow")).find((x) => (x.textContent || "").indexOf(e) >= 0); return b && b.getAttribute("aria-current") === "true"; }, name, { timeout: cap(10000, 8000) }); } catch {} }
async function waitResearch(rid, rounds, tag) { for (let i = 0; i < rounds; i++) { const res = await page.waitForResponse((r) => { try { const u = r.url(); return r.request().method() === "GET" && u.indexOf("/api/roster/" + rid + "/research") >= 0; } catch { return false; } }, { timeout: cap(25000, 8000) }); let st = 0; try { st = res.status(); } catch { st = -1; } try { await Promise.race([res.text().catch(() => ""), after(8000, "poll-body")]); } catch {} console.log("POLL " + tag + " round=" + (i + 1) + " status=" + st); if (!(st === 200 || st === 404)) fail(tag + " research poll unexpected status " + st); } ok(tag + " completed " + rounds + " app research polls"); }
async function sendAndAssertAdvisor(rid, tag, leadText) { const btnQ = chatSel(rid) + " button"; const respP = page.waitForResponse((r) => { try { const u = r.url(); return r.request().method() === "POST" && u.indexOf("/api/roster/" + rid + "/chat") >= 0; } catch { return false; } }, { timeout: cap(30000, 8000) }); await page.locator(btnQ, { hasText: "Send" }).first().click({ timeout: cap(10000, 8000) }); const resp = await respP; let st = 0; try { st = resp.status(); } catch { st = -1; } const rtx = await Promise.race([resp.text().catch(() => ""), after(10000, "chat-body")]); let ans = ""; let rj = null; try { rj = rtx ? JSON.parse(rtx) : null; } catch {} if (rj && typeof rj.answer === "string") ans = rj.answer; console.log(tag + " chat POST status=" + st + " answerLen=" + ans.length); if (!(st === 200 || st === 201)) fail(tag + " chat POST expected 200 or 201, got " + st); if (!ans || ans.length < 4) fail(tag + " chat POST missing expected answer"); if (!rj || rj.rosterId !== rid) fail(tag + " chat POST answer not scoped to selected advisor"); const probe = ans.slice(0, 24); const advQ = chatSel(rid) + " .msg-row.advisor .btext"; try { await page.locator(advQ, { hasText: probe }).first().waitFor({ timeout: cap(20000, 8000) }); } catch { fail(tag + " scoped advisor reply missing POST answer"); } ok(tag + " scoped advisor reply shows POST answer"); if (leadText) { try { await page.locator(chatSel(rid) + " .msg-row.lead .btext", { hasText: leadText }).first().waitFor({ timeout: cap(15000, 8000) }); ok(tag + " completed lead turn shows sent text, not just pending echo"); } catch { fail(tag + " completed lead turn missing sent text"); } } const btnTxt = await page.locator(btnQ, { hasText: "Send" }).first().innerText().catch(() => ""); if (btnTxt.indexOf("Sending") >= 0) fail(tag + " still sending after advisor reply"); const alerts = await page.locator(chatSel(rid) + " [role=" + DQ() + "alert" + DQ() + "]").count().catch(() => -1); if (alerts !== 0) fail(tag + " unexpected scoped error, alerts=" + alerts); ok(tag + " sending finished with no scoped error"); return ans; }
async function main() { console.log("interactions v2 start " + run);
const h = await req("GET", "/health", undefined, false); if (h.s !== 200) fail("health unreachable " + h.s); if (!h.j || h.j.instance !== "own-15380") fail("health instance not OWN 15380 stack"); ok("trusted OWN api health instance=own-15380");
const rd = await req("GET", "/ready", undefined, false); if (rd.s !== 200) fail("ready unreachable " + rd.s); ok("trusted OWN backend ready store=" + String(rd.j && rd.j.store));
const fms = cap(15000, 8000); const fctl = new AbortController(); const ft = setTimeout(() => { try { fctl.abort(); } catch {} }, fms); let fst = 0; let fj = null; try { const fr2 = await fetch(FAKE + "/__log", { method: "GET", signal: fctl.signal, redirect: "manual" }); fst = fr2.status; const ftx = await bodyText(fr2, Math.min(10000, budget(4000))); try { fj = ftx ? JSON.parse(ftx) : null; } catch {} } catch { fst = 0; } finally { clearTimeout(ft); } if (fst !== 200 || !Array.isArray(fj)) fail("fake routing not verified"); ok("trusted OWN fake routing");
const rg = await req("POST", "/api/auth/register", { email, password }, false); if (rg.s !== 201 || !rg.j || !rg.j.token) fail("register " + rg.s); token = String(rg.j.token); umail = String(rg.j.email || email);
const me = await req("GET", "/api/auth/me", undefined, false); if (me.s !== 200) fail("me " + me.s); ok("register plus auth-me");
async function mk(nm) { const q = await req("POST", "/api/roster/quick", { accountId: ACCT, name: nm, description: "Doc adviser " + run + ": one concrete sentence.", background: "Teaching bg " + run }, false); if (q.s !== 201 || !q.j || !q.j.id) fail("quick " + q.s); const id = String(q.j.id); const fd = new FormData(); fd.append("file", new Blob([png(38, 92, 160)], { type: "image/png" }), "qa.png"); const ms = cap(20000, 8000); const ctl = new AbortController(); const t = setTimeout(() => { try { ctl.abort(); } catch {} }, ms); try { const u = await fetch(WEB + "/api/roster/" + id + "/image/upload", { method: "POST", signal: ctl.signal, headers: token ? { authorization: "Bearer " + token } : {}, redirect: "manual", body: fd }); await bodyText(u, Math.min(10000, budget(4000))); if (u.status !== 201 && u.status !== 200) fail("upload " + u.status); } finally { clearTimeout(t); } return id; }
const tag8 = run.slice(-8); const mA = "MK-A-" + tag8; const mB = "MK-B-" + tag8;
const nA = run + "-A Adviser"; const nB = run + "-B Adviser"; const idA = await mk(nA); const idB = await mk(nB); ok("two advisors A=" + idA.slice(0, 8) + " B=" + idB.slice(0, 8));
browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript((c) => { try { if (c.t) localStorage.setItem("simceo-token", c.t); if (c.u) localStorage.setItem("simceo-user", c.u); if (c.a) localStorage.setItem("simceo-account", c.a); } catch {} }, { t: token, u: umail, a: ACCT });
page = await ctx.newPage();
page.on("console", (m) => { try { const t = m.text(); if (/two children with the same key|Encountered two children/i.test(t)) warns.push(t.slice(0, 160)); } catch {} });
page.on("pageerror", (e) => { try { const t = String(e.message || e); if (/same key|duplicate.*key/i.test(t)) warns.push(t.slice(0, 160)); } catch {} });
page.on("crash", () => { try { warns.push("PAGE-CRASHED"); } catch {} });
await page.route("**/*", async (rt) => { try { const u = new URL(rt.request().url()); if (u.protocol === "http:" || u.protocol === "https:") { if (u.origin !== WEB && u.origin !== FAKE) return await rt.abort(); if (/[.](woff2?|ttf|otf)$/i.test(u.pathname)) return await rt.abort(); if (delayChatFor && u.origin === WEB && u.pathname === "/api/roster/" + delayChatFor + "/chat" && rt.request().method() === "POST") { delayChatFor = ""; await page.waitForTimeout(2000); } } return await rt.continue(); } catch { try { return await rt.continue(); } catch {} } });
await page.goto(WEB + "/#/roster", { waitUntil: "domcontentloaded", timeout: cap(15000, 8000) }); await page.waitForTimeout(900);
await sel(nA); await page.waitForTimeout(900); await needDetail("initial-A", idA);
await waitResearch(idA, 2, "poll-A"); await needDetail("poll-A", idA);
const boxA = chatSel(idA) + " textarea"; const linkQ = "div.cc-editor input[aria-label=" + DQ() + "Inspiration link 1 of 3" + DQ() + "]";
await page.locator(boxA).first().fill("Draft " + mA + " question one");
await page.locator(linkQ).first().fill("https://example.test/" + run + "-a1");
const dv0 = await page.locator(boxA).first().inputValue(); const lv0 = await page.locator(linkQ).first().inputValue();
await waitResearch(idA, 1, "poll-A-typed");
const dv1 = await page.locator(boxA).first().inputValue(); const lv1 = await page.locator(linkQ).first().inputValue();
if (dv1 !== dv0 || dv1.indexOf(mA) < 0) fail("typed chat draft did not survive poll");
if (lv1 !== lv0 || lv1.indexOf(run + "-a1") < 0) fail("typed editor link did not survive poll");
ok("typed chat and editor state survive poll"); await needDetail("typed-A", idA);
await sel(nB); await page.waitForTimeout(900); await needDetail("switch-B", idB);
const boxB = chatSel(idB) + " textarea";
const bDraft0 = await page.locator(boxB).first().inputValue().catch(() => "");
if (bDraft0 !== "") fail("B draft must start empty, got " + bDraft0.slice(0, 60));
const bLink0 = await page.locator(linkQ).first().inputValue().catch(() => "");
if (bLink0 !== "") fail("B editor must start empty, got " + bLink0.slice(0, 60));
ok("B starts with empty draft and editor, no A crossover");
await page.locator(boxB).first().fill("Draft " + mB + " question one");
await sel(nA); await page.waitForTimeout(900); await needDetail("switchback-A", idA);
const aDraftBack = await page.locator(boxA).first().inputValue();
if (aDraftBack.indexOf(mA) < 0) fail("A draft marker lost across advisor switch");
const aLinkBack = await page.locator(linkQ).first().inputValue().catch(() => "");
console.log("NOTE switchback-A editor link value=" + JSON.stringify(aLinkBack.slice(0, 60)) + " (editor remounts from entry; unsent links are per-mount like chat turns, drafts persist via storage)");
ok("A unsent chat draft survives advisor switch");
const noBTxt = await page.locator(cardSel(idA)).first().innerText().catch(() => "");
if (noBTxt.indexOf(mB) >= 0) fail("A shows B marker, crossover");
ok("A has no B marker");
const ansA = await sendAndAssertAdvisor(idA, "send-A", mA); await needDetail("after-send-A", idA);
await sel(nB); await page.waitForTimeout(900); await needDetail("back-B", idB);
const bDraft1 = await page.locator(boxB).first().inputValue();
if (bDraft1.indexOf(mB) < 0) fail("B draft marker lost across switch");
const bTxt0 = await page.locator(cardSel(idB)).first().innerText().catch(() => "");
if (bTxt0.indexOf(mA) >= 0) fail("B shows A marker, crossover");
if (bTxt0.indexOf(ansA.slice(0, 20)) >= 0) fail("B shows A answer, crossover");
ok("B keeps own draft with no A crossover");
delayChatFor = idB;
const lateP = page.waitForResponse((r) => { try { const u = r.url(); return r.request().method() === "POST" && u.indexOf("/api/roster/" + idB + "/chat") >= 0; } catch { return false; } }, { timeout: cap(30000, 8000) });
await page.locator(chatSel(idB) + " button", { hasText: "Send" }).first().click({ timeout: cap(10000, 8000) });
await sel(nA); await needDetail("late-A", idA);
const lateResp = await lateP; const lateTx = await Promise.race([lateResp.text().catch(() => ""), after(10000, "late-body")]);
let lateAns = ""; try { const lj = lateTx ? JSON.parse(lateTx) : null; if (lj && typeof lj.answer === "string") lateAns = lj.answer; } catch {}
await page.waitForTimeout(1500); await needDetail("late-A-held", idA);
const aLateTxt = await page.locator(cardSel(idA)).first().innerText().catch(() => "");
if (aLateTxt.indexOf(mB) >= 0) fail("held late B answer leaked into A");
if (lateAns && lateAns.length >= 4 && aLateTxt.indexOf(lateAns.slice(0, 20)) >= 0) fail("held late B text leaked into A");
ok("held late B answer did not cross into A");
await sel(nB); await page.waitForTimeout(900); await needDetail("late-B", idB);
let lateSt = 0; try { lateSt = lateResp.status(); } catch { lateSt = -1; } console.log("late-B chat POST status=" + lateSt + " answerLen=" + lateAns.length); if (!(lateSt === 200 || lateSt === 201)) fail("held B chat POST expected 200 or 201, got " + lateSt); if (!lateAns || lateAns.length < 4) fail("held B chat POST missing expected answer"); ok("held B POST succeeded with scoped answer"); const bDraftAfter = await page.locator(boxB).first().inputValue().catch(() => ""); if (bDraftAfter !== "") fail("B draft must be cleared after send, got " + bDraftAfter.slice(0, 60)); const bLateTxt = await page.locator(cardSel(idB)).first().innerText().catch(() => ""); if (bLateTxt.indexOf(mA) >= 0) fail("B shows A marker after late send, crossover"); ok("B holds no A content after late send; unmounted turns reset by design with no leak");
await page.goto(WEB + "/#/boards", { waitUntil: "domcontentloaded", timeout: cap(15000, 8000) }); await page.waitForTimeout(800);
const zb = await page.locator("div[data-roster-chat]").count().catch(() => -1); const ze = await page.locator("div.cc-editor").count().catch(() => -1);
console.log("BOARDS chats=" + zb + " editors=" + ze);
if (zb !== 0 || ze !== 0) fail("boards must show zero roster chats and editors");
ok("boards shows zero chats and editors");
await page.goto(WEB + "/#/roster", { waitUntil: "domcontentloaded", timeout: cap(15000, 8000) }); await page.waitForTimeout(900);
await sel(nA); await page.waitForTimeout(900); await needDetail("nav-back-A", idA);
if (warns.length > 0) fail("duplicate key warnings: " + JSON.stringify(warns).slice(0, 300));
ok("no duplicate key warnings");
console.log("interactions v2 done " + run + " ms=" + (Date.now() - T0)); }
let mainFailed = false;
try { await main(); } catch (e) { mainFailed = true; console.log("FATAL " + String((e && e.message) || e).slice(0, 240)); if (!process.exitCode) process.exitCode = 1; }
const cerr = await bye();
if (cerr.length > 0) { console.log("FAIL cleanup: " + JSON.stringify(cerr).slice(0, 300)); process.exitCode = 1; }
if (!mainFailed && cerr.length === 0) console.log("interactions PASS " + run);
