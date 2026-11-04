// Muse QA-only sibling regression v2 (OWN 15380 and 15382 only, QA-only, bounded, closes OWN browser).
// Captures causal mount evidence and ASSERTS exactly one chat plus one editor; fails on any duplicate or missing panel.
import crypto from "node:crypto";
import { chromium } from "playwright-core";
import os from "node:os";
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
function after(ms, what) { return new Promise((_, rej) => { setTimeout(() => { try { rej(new Error("timeout:" + (what || "wait"))); } catch {} }, Math.max(1, ms)); }); }
function fail(m) { console.log("FAIL " + m); process.exitCode = 1; throw new Error(m); }
function ok(m) { console.log("ok " + m); }
function crc32(b) { let t = crc32._t; if (!t) { t = new Int32Array(256); for (let n = 0; n < 256; n++) { let v = n; for (let k = 0; k < 8; k++) v = (v & 1) ? (0xEDB88320 ^ (v >>> 1)) : (v >>> 1); t[n] = v; } crc32._t = t; } let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function png(r, g, bl) { const sig = Buffer.from([137,80,78,71,13,10,26,10]); const ih = Buffer.alloc(13); ih.writeUInt32BE(1,0); ih.writeUInt32BE(1,4); ih[8]=8; ih[9]=2; const hl=Buffer.alloc(4); hl.writeUInt32BE(13,0); const ht=Buffer.from("IHDR"); const hc=Buffer.alloc(4); hc.writeUInt32BE(crc32(Buffer.concat([ht,ih])),0); const raw=Buffer.from([r,g,bl]); const comp=zlib.deflateSync(Buffer.concat([Buffer.from([0]),raw])); const dl=Buffer.alloc(4); dl.writeUInt32BE(comp.length,0); const dt=Buffer.from("IDAT"); const dc=Buffer.alloc(4); dc.writeUInt32BE(crc32(Buffer.concat([dt,comp])),0); const el=Buffer.alloc(4); const et=Buffer.from("IEND"); const ec=Buffer.alloc(4); ec.writeUInt32BE(crc32(et),0); return Buffer.concat([sig,hl,ht,ih,hc,dl,dt,comp,dc,el,et,ec]); }
const run = "muse-mt3-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
const email = run + "@example.test"; const password = "Qa-" + crypto.randomBytes(9).toString("hex") + "-x9"; const ACCT = crypto.randomUUID();
let token = ""; let umail = "";
async function bodyText(r, ms) { try { return await Promise.race([r.text().catch(() => ""), after(ms, "body-read")]); } catch { return ""; } }
async function req(m, p, b, isForm) { const ms = cap(15000, 8000); const ctl = new AbortController(); const t = setTimeout(() => { try { ctl.abort(); } catch {} }, ms); try { const h = {}; if (token) h["authorization"] = "Bearer " + token; if (!isForm) h["content-type"] = "application/json"; const r = await fetch(WEB + p, { method: m, signal: ctl.signal, headers: h, redirect: "manual", body: b === undefined ? undefined : (isForm ? b : JSON.stringify(b)) }); const tx = await bodyText(r, Math.min(10000, budget(4000))); let j = null; try { j = tx ? JSON.parse(tx) : null; } catch {} return { s: r.status, j, tx }; } catch (e) { return { s: 0, j: null, tx: "transport:" + String((e && e.name) || "err").slice(0, 60) }; } finally { clearTimeout(t); } }
let browser = null; let ctx = null; let page = null; const cleanupErrs = [];
async function bye() { async function step(n, f) { try { await Promise.race([f(), after(5000, n)]); } catch (e) { cleanupErrs.push(n + ":" + String((e && e.message) || e).slice(0, 80)); } } await step("blank-close", async () => { if (blank && !blank.isClosed()) await blank.close(); }); await step("page-close", async () => { if (page) await page.close(); }); page = null; await step("ctx-close", async () => { if (ctx) await ctx.close(); }); ctx = null; await step("browser-close", async () => { if (browser) await browser.close(); }); browser = null; return cleanupErrs; }
let blank = null;
function DQ() { return String.fromCharCode(34); }
async function main() { console.log("mount-regression v2 start " + run);
const h = await req("GET", "/health", undefined, false); if (h.s !== 200) fail("health unreachable " + h.s); if (!h.j || h.j.instance !== "own-15380") fail("health instance not OWN 15380 stack"); ok("trusted OWN api health instance=own-15380");
const rd = await req("GET", "/ready", undefined, false); if (rd.s !== 200) fail("ready unreachable " + rd.s); ok("trusted OWN backend ready store=" + String(rd.j && rd.j.store));
const fms = cap(15000, 8000); const fctl = new AbortController(); const ft = setTimeout(() => { try { fctl.abort(); } catch {} }, fms); let fst = 0; let fj = null; try { const fr2 = await fetch(FAKE + "/__log", { method: "GET", signal: fctl.signal, redirect: "manual" }); fst = fr2.status; const ftx = await bodyText(fr2, Math.min(10000, budget(4000))); try { fj = ftx ? JSON.parse(ftx) : null; } catch {} } catch { fst = 0; } finally { clearTimeout(ft); } if (fst !== 200 || !Array.isArray(fj)) fail("fake routing not verified"); ok("trusted OWN fake routing");
const rg = await req("POST", "/api/auth/register", { email, password }, false); if (rg.s !== 201 || !rg.j || !rg.j.token) fail("register " + rg.s); token = String(rg.j.token); umail = String(rg.j.email || email); if (token.length < 16) fail("token too short"); ok("setup-register-201");
const me = await req("GET", "/api/auth/me", undefined, false); if (me.s !== 200) fail("auth-me barrier " + me.s); ok("setup-me-authenticated");
const rname = run + "-Roster Adviser";
const quick = await req("POST", "/api/roster/quick", { accountId: ACCT, name: rname, description: "Documentation teaching adviser " + run + ": one concrete sentence.", background: "Teaching background " + run }, false); if (quick.s !== 201 || !quick.j || !quick.j.id) fail("quick " + quick.s); const rosterId = String(quick.j.id); ok("quick-201 rid8=" + rosterId.slice(0, 8));
const ums = cap(20000, 8000); const uctl = new AbortController(); const ut = setTimeout(() => { try { uctl.abort(); } catch {} }, ums); const fd = new FormData(); fd.append("file", new Blob([png(38, 92, 160)], { type: "image/png" }), "qa-neutral-a.png"); let upStatus = 0; try { const u = await fetch(WEB + "/api/roster/" + rosterId + "/image/upload", { method: "POST", signal: uctl.signal, headers: token ? { authorization: "Bearer " + token } : {}, redirect: "manual", body: fd }); upStatus = u.status; await bodyText(u, Math.min(10000, budget(4000))); } catch { upStatus = 0; } finally { clearTimeout(ut); } if (upStatus !== 201 && upStatus !== 200) fail("portrait upload " + upStatus); ok("portrait-uploaded status=" + upStatus);
browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript((c) => { try { if (c.t) localStorage.setItem("simceo-token", c.t); if (c.u) localStorage.setItem("simceo-user", c.u); if (c.a) localStorage.setItem("simceo-account", c.a); } catch {} }, { t: token, u: umail, a: ACCT });
page = await ctx.newPage();
await page.route("**/*", async (rt) => { try { const u = new URL(rt.request().url()); if (u.protocol === "http:" || u.protocol === "https:") { if (u.origin !== WEB && u.origin !== FAKE) return await rt.abort(); if (/[.](woff2?|ttf|otf)$/i.test(u.pathname)) return await rt.abort(); } return await rt.continue(); } catch { try { return await rt.continue(); } catch {} } });
blank = await ctx.newPage();
await blank.goto("about:blank", { waitUntil: "domcontentloaded", timeout: cap(8000, 8000) });
await blank.setContent("<div id=a>plain</div><div id=b data-qa-inert-blank=BLANK123>marked</div>", { timeout: cap(8000, 8000) });
const bNat = await blank.evaluate(() => { try { return { q: document.querySelectorAll("div[data-qa-inert-blank]").length, e: document.querySelectorAll("div[data-qa-inert-blank=" + String.fromCharCode(34) + "BLANK123" + String.fromCharCode(34) + "]").length }; } catch (e) { return { err: 1 }; } });
if (!bNat || bNat.q !== 1 || bNat.e !== 1) fail("blank fixture engine not healthy: " + JSON.stringify(bNat));
ok("blank fixture native 1 and exact 1, engine healthy");
await page.goto(WEB + "/#/roster", { waitUntil: "domcontentloaded", timeout: cap(15000, 8000) }); await page.waitForTimeout(900);
const rrow = page.locator("aside.listpanel button.lprow", { hasText: rname }).first(); await rrow.waitFor({ timeout: cap(10000, 8000) }); await rrow.click({ timeout: cap(10000, 8000) });
try { await page.waitForFunction((e) => { const b = Array.from(document.querySelectorAll("aside.listpanel button.lprow")).find((x) => (x.textContent || "").indexOf(e) >= 0); return b && b.getAttribute("aria-current") === "true" && b.className.indexOf("active") >= 0; }, rname, { timeout: cap(10000, 8000) }); } catch {}
const aria = await rrow.getAttribute("aria-current").catch(() => null); if (aria !== "true") fail("selection not proven"); ok("roster row selected aria-current true"); await page.waitForTimeout(800);
const SYNTH = "MUSE-SYNTH-MOUNT-ABC123";
async function diagOnce(rid, label) {
const d = await page.evaluate((cfg) => { const out = {}; const rid = cfg.rid; const synth = cfg.synth; try { const Q = String.fromCharCode(34); const q = "div[data-roster-chat=" + Q + rid + Q + "]"; out.qLen = q.length; out.bare = document.querySelectorAll("div[data-roster-chat]").length; let exact = []; try { exact = Array.from(document.querySelectorAll(q)); } catch (e) { out.qsaThrow = String((e && e.message) || e).slice(0, 80); } out.exact = exact.length; out.totalDivs = document.querySelectorAll("div").length; out.cls = document.querySelectorAll(".roster-chat").length;
const anc = (el) => { const chain = []; let c = el; for (let i = 0; i < 6 && c; i++) { try { chain.push((c.tagName || "?") + "." + String(c.className || "").split(" ").slice(0, 3).join(".") + "#" + (c.id || "")); } catch { chain.push("?"); } c = c.parentElement; } return chain.join(" > "); };
out.first = exact.slice(0, 3).map((el) => { let attrs = []; try { attrs = Array.from(el.attributes).map((a) => a.name + "=" + String(a.value).slice(0, 40)); } catch { attrs = ["attrs-threw"]; } let viaCall = ""; try { viaCall = Element.prototype.getAttribute.call(el, "data-roster-chat"); } catch { viaCall = "call-threw"; } let matched = false; try { matched = el.matches(q); } catch { matched = false; } return { tag: el.tagName, cls: String(el.className).slice(0, 60), html: (el.outerHTML || "").slice(0, 220), attrs, viaCall: String(viaCall).slice(0, 40), matched, anc: anc(el) }; });
try { const w = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT, { acceptNode(n) { try { return (n.matches && n.matches(q)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP; } catch { return NodeFilter.FILTER_SKIP; } } }); let c = 0; while (w.nextNode()) { c++; if (c > 5000) break; } out.tw = c; } catch { out.tw = -1; }
out.nativeCode = /native code/.test(String(Element.prototype.getAttribute)) && /native code/.test(String(Document.prototype.querySelectorAll)) && /native code/.test(String(Element.prototype.matches));
try { out.synth = document.querySelectorAll("div[data-roster-chat=" + Q + synth + Q + "]").length; } catch { out.synth = -9; }
try { out.heads = Array.from(document.querySelectorAll("h3")).map((hh) => String(hh.innerText || "")).filter((t) => /chat with this advisor/i.test(t)).length; } catch { out.heads = -1; }
try { const o = document.querySelector("div.roster-detail > div.card[data-roster-entry-id]"); if (o) { out.kids = o.childElementCount; out.scopeChats = o.querySelectorAll(":scope > div.card.roster-chat[data-roster-chat]").length; out.scopeEds = o.querySelectorAll(":scope > div.cc-editor").length; try { const ch = Array.from(o.querySelectorAll(":scope > div.card.roster-chat[data-roster-chat]")); out.sameParent = ch.length >= 2 ? ch[0].parentElement === ch[1].parentElement : "na-single"; } catch { out.sameParent = "err"; } try { out.chatIdx = Array.from(o.children).map((el, i) => (el.hasAttribute && el.hasAttribute("data-roster-chat")) ? i : -1).filter((i) => i >= 0); } catch { out.chatIdx = []; } } } catch (e) { out.outerErr = String((e && e.message) || e).slice(0, 60); }
try { const mk = "MUSE-INERT-CTRL-XYZ789"; const dd = document.createElement("div"); dd.setAttribute("data-qa-inert-app", mk); dd.textContent = "inert"; document.body.appendChild(dd); out.inertBare = document.querySelectorAll("div[data-qa-inert-app]").length; let n2 = -1; try { n2 = document.querySelectorAll("div[data-qa-inert-app=" + Q + mk + Q + "]").length; } catch {} out.inertExact = n2; dd.remove(); out.inertAfter = document.querySelectorAll("div[data-qa-inert-app]").length; } catch (e) { out.inertErr = String((e && e.message) || e).slice(0, 60); }
} catch (e) { out.evalThrow = String((e && e.message) || e).slice(0, 120); } return out; }, { rid, synth: SYNTH });
const pwBare = await page.locator("div[data-roster-chat]").count().catch(() => -1);
const pwExact = await page.locator("div[data-roster-chat=" + DQ() + rid + DQ() + "]").count().catch(() => -1);
console.log("DIAG " + label + " bare=" + d.bare + " exact=" + d.exact + " tw=" + d.tw + " cls=" + d.cls + " heads=" + d.heads + " synth=" + d.synth + " scopeChats=" + d.scopeChats + " scopeEds=" + d.scopeEds + " sameParent=" + d.sameParent + " totalDivs=" + d.totalDivs + " pwBare=" + pwBare + " pwExact=" + pwExact + " kids=" + d.kids + " idx=" + JSON.stringify(d.chatIdx || []));
console.log("DIAG " + label + " html=" + String((d.first && d.first[0] && d.first[0].html) || "none").slice(0, 200));
console.log("DIAG " + label + " anc=" + String((d.first && d.first[0] && d.first[0].anc) || "none").slice(0, 200));
console.log("DIAG " + label + " inert=" + d.inertBare + "/" + d.inertExact + "/" + d.inertAfter + " nativeCode=" + d.nativeCode);
if (d.evalThrow) fail(label + " diagnostic evaluation threw: " + d.evalThrow);
if (!d.nativeCode) fail(label + " native engine hooks not intact");
if (d.inertBare !== 1 || d.inertExact !== 1 || d.inertAfter !== 0) fail(label + " inert control unhealthy");
if (d.bare !== 1) fail(label + " bare count must be 1, got " + d.bare);
if (d.exact !== 1) fail(label + " exact count must be 1, got " + d.exact);
if (d.tw !== 1) fail(label + " treeWalker count must be 1, got " + d.tw);
if (d.cls !== 1) fail(label + " class count must be 1, got " + d.cls);
if (d.heads !== 1) fail(label + " heading count must be 1, got " + d.heads);
if (d.synth !== 0) fail(label + " synthetic selector must be 0, got " + d.synth);
if (d.scopeChats !== 1) fail(label + " scoped chats must be 1, got " + d.scopeChats);
if (d.scopeEds !== 1) fail(label + " scoped editors must be 1, got " + d.scopeEds);
if (pwBare !== 1 || pwExact !== 1) fail(label + " playwright counts must be 1 and 1, got " + pwBare + " and " + pwExact);
const f0 = d.first && d.first[0]; if (!f0 || f0.tag !== "DIV" || String(f0.cls).indexOf("roster-chat") < 0 || !f0.matched) fail(label + " first node is not the expected chat panel");
ok(label + " ASSERTS passed: exactly one chat plus one editor"); return d; }
await diagOnce(rosterId, "initial");
for (let i = 0; i < 2; i++) { const res = await page.waitForResponse((r) => { try { const u = r.url(); return r.request().method() === "GET" && u.indexOf("/api/roster/" + rosterId + "/research") >= 0; } catch { return false; } }, { timeout: cap(25000, 8000) }); let pst = 0; try { pst = res.status(); } catch { pst = -1; } try { await Promise.race([res.text().catch(() => ""), after(8000, "poll-body")]); } catch {} console.log("POLL initial round=" + (i + 1) + " status=" + pst); if (!(pst === 200 || pst === 404)) fail("research poll unexpected status " + pst); }
ok("completed 2 app research polls with no growth expected");
await diagOnce(rosterId, "after-polls");
try { const sp = os.tmpdir().replace(/\\/g, "/") + "/muse-mount-" + run + ".png"; await page.screenshot({ path: sp }).catch(() => {}); } catch {}
console.log("mount-regression v2 done " + run + " ms=" + (Date.now() - T0)); }
let mainFailed = false;
try { await main(); } catch (e) { mainFailed = true; console.log("FATAL " + String((e && e.message) || e).slice(0, 240)); if (!process.exitCode) process.exitCode = 1; }
const cerr = await bye();
if (cerr.length > 0) { console.log("FAIL cleanup: " + JSON.stringify(cerr).slice(0, 300)); process.exitCode = 1; }
if (!mainFailed && cerr.length === 0) console.log("mount-regression PASS " + run);
