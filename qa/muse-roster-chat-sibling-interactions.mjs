// Muse QA-only sibling interactions (OWN 15380+15382, QA-only, bounded, closes OWN browser).
import crypto from "node:crypto";
import { chromium } from "playwright-core";
import zlib from "node:zlib";
const QA_WEB = (process.env.QA_WEB || "http://127.0.0.1:15380").trim();
const QA_FAKE = (process.env.QA_FAKE || "http://127.0.0.1:15382").trim();
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const OVERALL_MS = 150000; const T0 = Date.now();
const leftMs = (r) => Math.max(0, OVERALL_MS - (Date.now() - T0) - (r || 5000));
const bto = (b, r) => Math.min(b, Math.max(3000, leftMs(r || 8000)));
function fail(m) { console.log("FAIL " + m); process.exitCode = 1; throw new Error(m); }
function ok(m) { console.log("ok " + m); }
if (new URL(QA_WEB).port !== "15380") { console.log("REFUSE QA_WEB must be 15380"); process.exit(2); }
if (new URL(QA_FAKE).port !== "15382") { console.log("REFUSE QA_FAKE must be 15382"); process.exit(2); }
const WEB = new URL(QA_WEB).origin;
function crc32(b) { let t = crc32._t; if (!t) { t = new Int32Array(256); for (let n = 0; n < 256; n++) { let v = n; for (let k = 0; k < 8; k++) v = (v & 1) ? (0xEDB88320 ^ (v >>> 1)) : (v >>> 1); t[n] = v; } crc32._t = t; } let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function png(r, g, bl) { const sig = Buffer.from([137,80,78,71,13,10,26,10]); const ih = Buffer.alloc(13); ih.writeUInt32BE(1,0); ih.writeUInt32BE(1,4); ih[8]=8; ih[9]=2; const hl=Buffer.alloc(4); hl.writeUInt32BE(13,0); const ht=Buffer.from("IHDR"); const hc=Buffer.alloc(4); hc.writeUInt32BE(crc32(Buffer.concat([ht,ih])),0); const raw=Buffer.from([r,g,bl]); const comp=zlib.deflateSync(Buffer.concat([Buffer.from([0]),raw])); const dl=Buffer.alloc(4); dl.writeUInt32BE(comp.length,0); const dt=Buffer.from("IDAT"); const dc=Buffer.alloc(4); dc.writeUInt32BE(crc32(Buffer.concat([dt,comp])),0); const el=Buffer.alloc(4); const et=Buffer.from("IEND"); const ec=Buffer.alloc(4); ec.writeUInt32BE(crc32(et),0); return Buffer.concat([sig,hl,ht,ih,hc,dl,dt,comp,dc,el,et,ec]); }
const run = "muse-rk2-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
const email = run + "@example.test"; const password = "Qa-" + crypto.randomBytes(9).toString("hex") + "-x9"; const ACCT = crypto.randomUUID();
let token = ""; let umail = "";
async function req(m, p, b, f) { const ctl = new AbortController(); const t = setTimeout(() => { try { ctl.abort(); } catch {} }, 15000); try { const h = {}; if (token) h["authorization"] = "Bearer " + token; if (!f) h["content-type"] = "application/json"; const r = await fetch(WEB + p, { method: m, signal: ctl.signal, headers: h, body: b === undefined ? undefined : (f ? b : JSON.stringify(b)) }); const tx = await r.text(); let j = null; try { j = tx ? JSON.parse(tx) : null; } catch {} return { s: r.status, j, tx }; } catch (e) { return { s: 0, j: null, tx: "t:" + e.name }; } finally { clearTimeout(t); } }
let browser = null; let ctx = null; let page = null; const warns = [];
async function bye() { try { if (page) await page.close(); } catch {} page = null; try { if (ctx) await ctx.close(); } catch {} ctx = null; try { if (browser) await browser.close(); } catch {} browser = null; }
async function counts(rid) { const d = await page.evaluate((id) => { try { const q = "div[data-roster-chat=" + String.fromCharCode(34) + id + String.fromCharCode(34) + "]"; const bare = document.querySelectorAll("div[data-roster-chat]").length; let ex = 0; try { ex = document.querySelectorAll(q).length; } catch { ex = -1; } const cls = document.querySelectorAll(".roster-chat").length; return { bare, ex, cls }; } catch (e) { return { err: 1 }; } }, rid); const pw = await page.locator("div[data-roster-chat]").count().catch(() => -1); return { d, pw }; }
function need1(label, c) { console.log("COUNT " + label + " bare=" + c.d.bare + " ex=" + c.d.ex + " cls=" + c.d.cls + " pw=" + c.pw); if (c.d.bare !== 1 || c.d.ex !== 1 || c.d.cls !== 1 || c.pw !== 1) fail(label + " expected exactly 1"); ok(label + " exactly one"); }
async function sel(name) { const r = page.locator("aside.listpanel button.lprow", { hasText: name }).first(); await r.waitFor({ timeout: bto(10000, 8000) }); await r.click({ timeout: bto(10000, 8000) }); try { await page.waitForFunction((e) => { const b = Array.from(document.querySelectorAll("aside.listpanel button.lprow")).find((x) => (x.textContent || "").indexOf(e) >= 0); return b && b.getAttribute("aria-current") === "true"; }, name, { timeout: bto(10000, 8000) }); } catch {} }
async function main() { console.log("interactions start " + run);
const rg = await req("POST", "/api/auth/register", { email, password }); if (rg.s !== 201) fail("register " + rg.s); token = String(rg.j.token); umail = String(rg.j.email || email);
const me = await req("GET", "/api/auth/me"); if (me.s !== 200) fail("me " + me.s); ok("register+me");
const fr = await fetch(QA_FAKE + "/__log").then((r) => r.status).catch(() => 0); if (fr !== 200) fail("fake " + fr); ok("fake-loopback");
async function mk(nm) { const q = await req("POST", "/api/roster/quick", { accountId: ACCT, name: nm, description: "Doc adviser " + run + ": one concrete sentence.", background: "Teaching bg " + run }); if (q.s !== 201) fail("quick " + q.s); const id = String(q.j.id); const fd = new FormData(); fd.append("file", new Blob([png(38,92,160)], { type: "image/png" }), "qa.png"); const u = await fetch(WEB + "/api/roster/" + id + "/image/upload", { method: "POST", headers: token ? { authorization: "Bearer " + token } : {}, body: fd }); if (u.status !== 201 && u.status !== 200) fail("upload " + u.status); return id; }
const nA = run + "-A Adviser"; const nB = run + "-B Adviser"; const idA = await mk(nA); const idB = await mk(nB); ok("two advisors A=" + idA.slice(0,8) + " B=" + idB.slice(0,8));
browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript((c) => { try { if (c.t) localStorage.setItem("simceo-token", c.t); if (c.u) localStorage.setItem("simceo-user", c.u); if (c.a) localStorage.setItem("simceo-account", c.a); } catch {} }, { t: token, u: umail, a: ACCT });
page = await ctx.newPage();
page.on("console", (m) => { try { const t = m.text(); if (/two children with the same key|Encountered two children/i.test(t)) warns.push(t.slice(0,160)); } catch {} });
page.on("pageerror", (e) => { try { const t = String(e.message || e); if (/same key|duplicate.*key/i.test(t)) warns.push(t.slice(0,160)); } catch {} });
await page.route("**/*", (rt) => { try { const u = new URL(rt.request().url()); if (u.hostname !== "127.0.0.1") return rt.abort(); return rt.continue(); } catch { try { return rt.continue(); } catch {} } });
await page.goto(WEB + "/#/roster", { waitUntil: "domcontentloaded", timeout: bto(15000, 8000) }); await page.waitForTimeout(900);
await sel(nA); await page.waitForTimeout(900); need1("initial-A", await counts(idA));
await page.waitForTimeout(6000); need1("poll-A-6s", await counts(idA));
const q = "div[data-roster-chat=" + String.fromCharCode(34) + idA + String.fromCharCode(34) + "] textarea";
await page.locator(q).first().fill("Draft probe " + run); await page.waitForTimeout(1200); need1("typing-A", await counts(idA));
const qb = "div[data-roster-chat=" + String.fromCharCode(34) + idA + String.fromCharCode(34) + "] button";
await page.locator(qb, { hasText: "Send" }).first().click({ timeout: bto(10000, 8000) });
try { await page.locator("div.msg-row", { hasText: "Draft probe" }).first().waitFor({ timeout: bto(25000, 8000) }); ok("send-A echoed"); } catch { fail("send-A no echo"); }
await page.waitForTimeout(1500); need1("after-send-A", await counts(idA));
await sel(nB); await page.waitForTimeout(900); need1("switch-B", await counts(idB));
const zA = await page.locator("div[data-roster-chat]").count().catch(() => -1); if (zA !== 1) fail("switch-B total chats must stay 1, got " + zA); ok("switch-B total 1, no crossover");
await sel(nA); await page.waitForTimeout(900); need1("switchback-A", await counts(idA));
await page.goto(WEB + "/#/boards", { waitUntil: "domcontentloaded", timeout: bto(15000, 8000) }); await page.waitForTimeout(800);
await page.goto(WEB + "/#/roster", { waitUntil: "domcontentloaded", timeout: bto(15000, 8000) }); await page.waitForTimeout(900);
await sel(nA); await page.waitForTimeout(900); need1("nav-back-A", await counts(idA));
if (warns.length > 0) fail("duplicate key warnings: " + JSON.stringify(warns).slice(0,300)); ok("no duplicate key warnings");
console.log("interactions PASS " + run + " ms=" + (Date.now() - T0)); }
try { await main(); } catch (e) { console.log("FATAL " + String((e && e.message) || e).slice(0,240)); if (!process.exitCode) process.exitCode = 1; } finally { await bye(); }
