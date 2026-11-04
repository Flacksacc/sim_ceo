// Muse QA-only roster-chat mount diagnostic (OWN worktree, read-only app).
// Against OWN 15380 + fake 15382 only. Own synthetic account/seed.
// TOTAL 150s budget; aborts external/fonts; closes OWN context/browser.
// Captures causal outerHTML prefix + attribute arrays, not just counts.
// Usage: QA_WEB=http://127.0.0.1:15380 QA_FAKE=http://127.0.0.1:15382 node qa/muse-roster-mount-diagnostic.mjs
import crypto from "node:crypto";
import { chromium } from "playwright-core";
import os from "node:os";
import zlib from "node:zlib";
const QA_WEB = (process.env.QA_WEB || "http://127.0.0.1:15380").trim();
const QA_FAKE = (process.env.QA_FAKE || "http://127.0.0.1:15382").trim();
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const REQ_TIMEOUT = 15000;
const BROWSER_TIMEOUT = 10000;
const OVERALL_BUDGET_MS = 150000;
const startedAt = Date.now();
const remainingMs = (r) => Math.max(0, OVERALL_BUDGET_MS - (Date.now() - startedAt) - (r || 5000));
const boundedTimeout = (b, r) => Math.min(b, Math.max(3000, remainingMs(r || 8000)));
function assertDeadline(tag) { if (Date.now() - startedAt >= OVERALL_BUDGET_MS - 5000) throw new Error("OVERALL DEADLINE at " + tag); }
function pick(o, ...ks) { if (!o || typeof o !== "object") return undefined; for (const k of ks) { if (k in o) return o[k]; const lo = String(k).toLowerCase(); for (const j of Object.keys(o)) if (String(j).toLowerCase() === lo) return o[j]; } return undefined; }
if (/[^\s:@/]*:[^\s:@/]*@/.test(QA_WEB)) { console.log("REFUSE creds in URL"); process.exit(2); }
const webUrl = new URL(QA_WEB);
if (webUrl.protocol !== "http:" || webUrl.hostname !== "127.0.0.1" || webUrl.port !== "15380") { console.log("REFUSE QA_WEB must be http://127.0.0.1:15380"); process.exit(2); }
const WEB = webUrl.origin;
const fakeUrl = new URL(QA_FAKE);
if (fakeUrl.protocol !== "http:" || fakeUrl.hostname !== "127.0.0.1" || fakeUrl.port !== "15382") { console.log("REFUSE QA_FAKE must be http://127.0.0.1:15382"); process.exit(2); }
function crc32(buf) { let t = crc32._t; if (!t) { t = new Int32Array(256); for (let n = 0; n < 256; n++) { let v = n; for (let k = 0; k < 8; k++) v = (v & 1) ? (0xEDB88320 ^ (v >>> 1)) : (v >>> 1); t[n] = v; } crc32._t = t; } let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function solidPng(r, g, b) { const sig = Buffer.from([137,80,78,71,13,10,26,10]); const ih = Buffer.alloc(13); ih.writeUInt32BE(1,0); ih.writeUInt32BE(1,4); ih[8]=8; ih[9]=2; const hl=Buffer.alloc(4); hl.writeUInt32BE(13,0); const ht=Buffer.from("IHDR"); const hc=Buffer.alloc(4); hc.writeUInt32BE(crc32(Buffer.concat([ht,ih])),0); const raw=Buffer.from([r,g,b]); const comp=zlib.deflateSync(Buffer.concat([Buffer.from([0]),raw])); const dl=Buffer.alloc(4); dl.writeUInt32BE(comp.length,0); const dt=Buffer.from("IDAT"); const dc=Buffer.alloc(4); dc.writeUInt32BE(crc32(Buffer.concat([dt,comp])),0); const el=Buffer.alloc(4); const et=Buffer.from("IEND"); const ec=Buffer.alloc(4); ec.writeUInt32BE(crc32(et),0); return Buffer.concat([sig,hl,ht,ih,hc,dl,dt,comp,dc,el,et,ec]); }
const run = "muse-mt-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
const email = run + "@example.test";
const password = "Qa-" + crypto.randomBytes(9).toString("hex") + "-x9";
const ACCT = crypto.randomUUID();
let token = "";
let authedEmail = "";
async function req(method, p, body, isForm) {
  assertDeadline("req:"+p.slice(0,30));
  const cap = Math.min(REQ_TIMEOUT, Math.max(1000, remainingMs(8000)));
  const ctl = new AbortController(); const t = setTimeout(() => { try { ctl.abort(); } catch {} }, cap);
  try {
    const headers = {};
    if (token) headers["authorization"] = "Bearer " + token;
    if (!isForm) headers["content-type"] = "application/json";
    const r = await fetch(WEB + p, { method, signal: ctl.signal, headers, body: body === undefined ? undefined : (isForm ? body : JSON.stringify(body)) });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } catch (e) { return { status: 0, json: null, text: "transport:" + (e && e.name ? e.name : "err") }; }
  finally { clearTimeout(t); }
}
const get = (p) => req("GET", p);
const post = (p, b) => req("POST", p, b);
let browser = null; let ctx = null; let page = null;
async function closeAll() { try { if (page) await page.close(); } catch {} page = null; try { if (ctx) await ctx.close(); } catch {} ctx = null; try { if (browser) await browser.close(); } catch {} browser = null; }
async function main() {
  console.log("mount-diagnostic start run=" + run);
  const reg = await post("/api/auth/register", { email, password });
  if (reg.status !== 201 || !pick(reg.json, "token")) throw new Error("register failed status=" + reg.status);
  token = String(pick(reg.json, "token") || ""); authedEmail = String(pick(reg.json, "email") || email);
  if (token.length < 16) throw new Error("token too short");
  console.log("ok setup-register-201");
  const me = await get("/api/auth/me");
  if (me.status !== 200) throw new Error("auth-me barrier failed status=" + me.status);
  console.log("ok setup-me-authenticated");
  const fr = await fetch(QA_FAKE + "/__log").then(r => r.status).catch(() => 0);
  if (fr !== 200) throw new Error("fake log unreachable status=" + fr);
  console.log("ok fake-loopback-verified");
  const rname = run + "-Roster Adviser";
  const quick = await post("/api/roster/quick", { accountId: ACCT, name: rname, description: "Documentation teaching adviser for " + run + ": explains reserved example domains with one concrete sentence.", background: "Teaching background for " + run + ": example-domain notebook keeping." });
  if (quick.status !== 201 || !pick(quick.json, "id")) throw new Error("quick failed status=" + quick.status + " " + String(quick.text||"").slice(0,160));
  const rosterId = String(pick(quick.json, "id"));
  console.log("ok quick-201 rid8=" + rosterId.slice(0,8));
  const buf = solidPng(38, 92, 160);
  const form = new FormData(); form.append("file", new Blob([buf], { type: "image/png" }), "qa-neutral-a.png");
  const upCap = Math.min(REQ_TIMEOUT, Math.max(1000, remainingMs(8000)));
  const uctl = new AbortController(); const ut = setTimeout(() => { try { uctl.abort(); } catch {} }, upCap);
  let upStatus = 0;
  try { const r = await fetch(WEB + "/api/roster/" + rosterId + "/image/upload", { method: "POST", signal: uctl.signal, headers: token ? { authorization: "Bearer " + token } : {}, body: form }); upStatus = r.status; await r.text().catch(() => ""); } catch { upStatus = 0; } finally { clearTimeout(ut); }
  if (upStatus !== 201 && upStatus !== 200) throw new Error("portrait upload failed status=" + upStatus);
  console.log("ok portrait-uploaded status=" + upStatus);
  const comp = await get("/api/roster/" + rosterId + "/completeness");
  const completeFlag = comp.status === 200 && pick(comp.json, "complete") === true;
  console.log("note completeness status=" + comp.status + " complete=" + completeFlag + " missing=" + JSON.stringify(pick(comp.json, "missing") || []).slice(0,160));
  browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((cfg) => { try { if (cfg.tok) localStorage.setItem("simceo-token", cfg.tok); if (cfg.usr) localStorage.setItem("simceo-user", cfg.usr); if (cfg.acct) localStorage.setItem("simceo-account", cfg.acct); } catch {} }, { tok: token, usr: authedEmail, acct: ACCT });
  page = await ctx.newPage();
  await page.route("**/*", (route) => { try { const u = new URL(route.request().url()); if (u.hostname !== "127.0.0.1") return route.abort(); if (/\.(woff2?|ttf|otf)$/i.test(u.pathname) || /fonts\.(googleapis|gstatic)\.com/i.test(u.hostname)) return route.abort(); return route.continue(); } catch { try { return route.continue(); } catch {} } });
  // blank-page inert fixture: 2 divs, one unique attr
  const blank = await ctx.newPage();
  try {
    await blank.goto("about:blank", { waitUntil: "domcontentloaded", timeout: boundedTimeout(8000, 8000) });
    await blank.setContent("<div id=a>plain</div><div id=b data-qa-inert-blank=BLANK123>marked</div>", { timeout: boundedTimeout(8000, 8000) });
    const bNat = await blank.evaluate(() => { try { return { q: document.querySelectorAll("div[data-qa-inert-blank]").length, e: document.querySelectorAll('div[data-qa-inert-blank="BLANK123"]').length }; } catch (e) { return { err: String(e).slice(0,80) }; } });
    const bPw1 = await blank.locator("div[data-qa-inert-blank]").count().catch(() => -1);
    const bPw2 = await blank.locator('div[data-qa-inert-blank="BLANK123"]').count().catch(() => -1);
    console.log("BLANK-FIXTURE native=" + JSON.stringify(bNat) + " pwBare=" + bPw1 + " pwExact=" + bPw2 + " expect=1/1");
  } finally { try { await blank.close(); } catch {} }
  await page.goto(WEB + "/#/roster", { waitUntil: "domcontentloaded", timeout: boundedTimeout(15000, 8000) });
  await page.waitForTimeout(Math.min(1200, Math.max(300, remainingMs(6000))));
  const rrow = page.locator("aside.listpanel button.lprow", { hasText: rname }).first();
  await rrow.waitFor({ timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) });
  const rowName = await rrow.locator(".lprow-name").innerText().catch(() => "");
  if (rowName !== rname) throw new Error("row name drift want=" + rname.slice(0,24) + " got=" + String(rowName).slice(0,24));
  await rrow.click({ timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) });
  try { await page.waitForFunction((exp) => { const b = Array.from(document.querySelectorAll("aside.listpanel button.lprow")).find((e) => (e.textContent || "").indexOf(exp) >= 0); if (!b) return false; return b.getAttribute("aria-current") === "true" && b.className.indexOf("active") >= 0; }, rname, { timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }); } catch {}
  const ariaCur = await rrow.getAttribute("aria-current").catch(() => null);
  if (ariaCur !== "true") throw new Error("selection not proven aria=" + ariaCur);
  console.log("ok roster-row-selected aria=true");
  await page.waitForTimeout(800);
  const SYNTH = "MUSE-SYNTH-MOUNT-ABC123";
  const diag = await page.evaluate(({ rid, synth }) => {
    const out = {};
    try {
      const qsExact = 'div[data-roster-chat="' + rid + '"]';
      out.qsExact = qsExact.slice(0, 80) + " len=" + qsExact.length;
      out.qsLen = qsExact.length;
      const bare = Array.from(document.querySelectorAll("div[data-roster-chat]"));
      out.bareCount = bare.length;
      let exact = [];
      try { exact = Array.from(document.querySelectorAll(qsExact)); } catch (e) { out.qsaThrow = String(e && e.message || e).slice(0,120); }
      out.exactCount = exact.length;
      out.totalDivs = document.querySelectorAll("div").length;
      out.classCount = document.querySelectorAll(".roster-chat").length;
      const headFor = (el) => { try { const sec = el.closest("section,aside,main"); const h = sec ? sec.querySelector("h1,h2,h3") : null; return (h && h.innerText ? h.innerText : "").slice(0,60); } catch { return "head-err"; } };
      const anc = (el) => { const chain = []; let c = el; for (let i = 0; i < 6 && c; i++) { try { chain.push((c.tagName||"?") + "." + String(c.className||"").split(" ").slice(0,3).join(".") + "#" + (c.id||"")); } catch { chain.push("?"); } c = c.parentElement; } return chain.join(" > "); };
      out.first3 = exact.slice(0, 3).map((el) => {
        let attrs = []; try { attrs = Array.from(el.attributes).map((a) => a.name + "=" + String(a.value).slice(0,120)); } catch (e) { attrs = ["attrs-threw"]; }
        let viaCall = ""; try { viaCall = Element.prototype.getAttribute.call(el, "data-roster-chat"); } catch (e) { viaCall = "call-threw"; }
        let viaNamed = ""; try { const n = el.attributes.getNamedItem("data-roster-chat"); viaNamed = n ? n.value : "null-named"; } catch (e) { viaNamed = "named-threw"; }
        let direct = ""; try { direct = el.getAttribute("data-roster-chat"); } catch (e) { direct = "direct-threw"; }
        let matches = false; try { matches = el.matches(qsExact); } catch { matches = false; }
        return { tag: el.tagName, cls: String(el.className).slice(0,120), id: el.id || "", htmlPrefix: (el.outerHTML || "").slice(0, 300), attrs, viaCall: String(viaCall).slice(0,80), viaNamed: String(viaNamed).slice(0,80), direct: String(direct).slice(0,80), matches, anc: anc(el), head: headFor(el) };
      });
      try {
        const tw = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT, { acceptNode(n) { try { return (n.matches && n.matches(qsExact)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP; } catch { return NodeFilter.FILTER_SKIP; } } });
        let c = 0; const capNodes = []; while (tw.nextNode()) { c++; if (capNodes.length < 3) { try { capNodes.push(tw.currentNode.tagName + "." + String(tw.currentNode.className).slice(0,60)); } catch {} } if (c > 5000) break; }
        out.treeWalkerCount = c; out.treeWalkerFirst3 = capNodes;
      } catch (e) { out.treeWalkerCount = -1; }
      out.nativeToString = { getAttr: /\[native code\]/.test(String(Element.prototype.getAttribute.toString ? Element.prototype.getAttribute.toString() : "")), qsa: /\[native code\]/.test(String(Document.prototype.querySelectorAll.toString ? Document.prototype.querySelectorAll.toString() : "")), matches: /\[native code\]/.test(String(Element.prototype.matches.toString ? Element.prototype.matches.toString() : "")) };
      try { const s = document.querySelectorAll('div[data-roster-chat="' + synth + '"]'); out.synthCount = s.length; out.synthQs = ('div[data-roster-chat="' + synth + '"]').length; } catch (e) { out.synthCount = -9; }
      try { out.visibleHeadings = Array.from(document.querySelectorAll("h3")).map((h) => String(h.innerText||"").slice(0,60)).filter((t) => /chat with this advisor/i.test(t)); } catch { out.visibleHeadings = []; }
      try { out.singleClassPanels = Array.from(document.querySelectorAll(".roster-chat")).slice(0,3).map((el) => ({ tag: el.tagName, htmlPrefix: (el.outerHTML||"").slice(0,200), anc: anc(el) })); } catch { out.singleClassPanels = []; }
      try { const outer = document.querySelector("div.roster-detail > div.card[data-roster-entry-id]"); if (outer) { out.outerKids = Array.from(outer.children).map((el, i) => ({ i, tag: el.tagName, cls: String(el.className).slice(0,60), attr: el.hasAttribute("data-roster-chat") ? String(el.getAttribute("data-roster-chat")||"").slice(0,8) : "", h: (el.querySelector("h3,h4") ? String(el.querySelector("h3,h4").innerText||"").slice(0,40) : "") })); out.outerKidCount = outer.childElementCount; try { const ch = Array.from(outer.querySelectorAll(":scope > div.card.roster-chat[data-roster-chat]")); out.scopeChatCount = ch.length; out.sameParent = ch.length >= 2 ? ch[0].parentElement === ch[1].parentElement : "n/a"; } catch {} } } catch (e) { out.outerKids = []; }
      // temporary inert control in App with unique non-GUID marker, then remove
      try {
        const marker = "MUSE-INERT-CTRL-XYZ789";
        const d = document.createElement("div"); d.setAttribute("data-qa-inert-app", marker); d.textContent = "inert"; document.body.appendChild(d);
        const n1 = document.querySelectorAll("div[data-qa-inert-app]").length;
        let n2 = -1; try { n2 = document.querySelectorAll('div[data-qa-inert-app="' + marker + '"]').length; } catch {}
        d.remove();
        const n3 = document.querySelectorAll("div[data-qa-inert-app]").length;
        out.inertApp = { marker, nativeBare: n1, nativeExact: n2, afterRemove: n3 };
      } catch (e) { out.inertApp = { err: String(e).slice(0,80) }; }
    } catch (e) { out.evalThrow = String(e && e.message || e).slice(0,160); }
    return out;
  }, { rid: rosterId, synth: SYNTH });
  const pwBare = await page.locator("div[data-roster-chat]").count().catch(() => -1);
  const pwExact = await page.locator('div[data-roster-chat="' + rosterId + '"]').count().catch(() => -1);
  const pwClass = await page.locator(".roster-chat").count().catch(() => -1);
  const pwHead = await page.getByText("Chat with this advisor", { exact: false }).count().catch(() => -1);
  const pwSynth = await page.locator('div[data-roster-chat="' + SYNTH + '"]').count().catch(() => -1);
  const pwInertBare = diag && diag.inertApp ? "see-eval" : "n/a";
  console.log("DIAG pwBare=" + pwBare + " pwExact=" + pwExact + " pwClass=" + pwClass + " pwHead=" + pwHead + " pwSynth=" + pwSynth + " totalDivs=" + diag.totalDivs + " bare=" + diag.bareCount + " exact=" + diag.exactCount + " treeWalker=" + diag.treeWalkerCount + " synth=" + diag.synthCount);
  console.log("DIAG nativeToString=" + JSON.stringify(diag.nativeToString));
  console.log("DIAG first3=" + JSON.stringify(diag.first3 || []).slice(0, 4000));
  console.log("DIAG headings=" + JSON.stringify(diag.visibleHeadings || []) + " singleClass=" + JSON.stringify(diag.singleClassPanels || []).slice(0, 2000));
  console.log("DIAG inertApp=" + JSON.stringify(diag.inertApp || {}));
  console.log("DIAG qsExact=" + (diag.qsExact || "?"));
  let shot = "shot=skipped";
  try { const sp = os.tmpdir().replace(/\\/g, "/") + "/muse-mount-" + run + ".png"; await page.screenshot({ path: sp }).catch(() => {}); shot = "shot=" + sp; } catch {}
  console.log("DIAG " + shot);
  console.log("mount-diagnostic done elapsedMs=" + (Date.now() - startedAt));
}
try { await main(); } catch (e) { console.log("FATAL " + String((e && e.message) || e).slice(0, 300)); process.exitCode = 1; } finally { await closeAll(); }


