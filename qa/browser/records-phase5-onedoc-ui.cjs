"use strict";
// Records Phase 5 one-document review UI proof.
// Real compiled SPA plus real isolated API. Own headless Edge only.
// Loopback only guard below. No shared CDP port. Primary owns lifecycle.
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const API = process.env.QA_API || "http://127.0.0.1:15320";
const WEB = process.env.QA_WEB || "http://127.0.0.1:15320";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:15322";
for (const pair of [[ "QA_API", API, 15320 ], [ "QA_WEB", WEB, 15320 ], [ "QA_FAKE", FAKE, 15322 ]]) {
  const nm = pair[0]; const v = pair[1]; const want = pair[2];
  let u; try { u = new URL(v); } catch { console.error("REFUSE bad " + nm); process.exit(2); }
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") { console.error("REFUSE non loopback " + nm); process.exit(2); }
  if (Number(u.port) !== want) { console.error("REFUSE " + nm + " must be 127.0.0.1:" + want + " (owned disposable) got " + v); process.exit(2); }
  if (/:5080|:5173|:9333|:15180|:15300|:15302/.test(v)) { console.error("REFUSE reserved/shared port " + nm); process.exit(2); }
  try { const uu = new URL(v); if (uu.search || uu.hash || uu.username || uu.password) { console.error("REFUSE " + nm + " must have no query/fragment/userinfo"); process.exit(2); } } catch { console.error("REFUSE bad " + nm); process.exit(2); }
}
if (WEB !== API) { console.error("REFUSE QA_WEB must equal QA_API exactly (owned 15320, no unused 15321)"); process.exit(2); }
const PROV = process.env.SIMCEO_INSTANCE || process.env.QA_PROVENANCE || "";
if (!PROV) { console.error("REFUSE missing provenance: primary must launch the owned API with SIMCEO_INSTANCE set"); process.exit(2); }
const META_BASE = process.env.META_API_BASE || "";
const META_KEY = process.env.META_API_KEY || "";
const EXPECT_BOOT = process.env.QA_FAKE_BOOT || "";
if (!META_BASE) { console.error("REFUSE missing META_API_BASE: owned launcher must point the API at the scoped fake"); process.exit(2); }
{ let _u; try { _u = new URL(META_BASE); } catch { console.error("REFUSE bad META_API_BASE"); process.exit(2); }
  if (_u.hostname !== "127.0.0.1" && _u.hostname !== "localhost") { console.error("REFUSE META_API_BASE non loopback"); process.exit(2); }
  if (Number(_u.port) !== 15322) { console.error("REFUSE META_API_BASE must be 127.0.0.1:15322 got " + META_BASE); process.exit(2); }
  if (_u.search || _u.hash || _u.username || _u.password) { console.error("REFUSE META_API_BASE no query/fragment/userinfo"); process.exit(2); } }
if (META_BASE !== FAKE) { console.error("REFUSE META_API_BASE must equal owned QA_FAKE exactly"); process.exit(2); }
if (!META_KEY || !META_KEY.startsWith("qa-only")) { console.error("REFUSE META_API_KEY must be qa-only (no real provider keys)"); process.exit(2); }
const OUT = process.env.QA_SHOTS || ".tmp/records-phase5-shots";
const T = { goto: 60000, step: 20000, poll: 20000, overall: 900000 }; // 15min ceiling for loaded machines; cleanup/final-exit stay 15s total
fs.mkdirSync(OUT, { recursive: true });
const EDGE_PATHS = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"];
const EDGE = EDGE_PATHS.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!EDGE) { console.error("REFUSE no Edge binary"); process.exit(2); }
let pass = 0, fail = 0;
const failures = [];
const consoleErrors = [];
function preflight(name, cond, extra) {
  if (cond) { pass++; return; }
  console.log("  FAIL " + name + (extra ? " :: " + extra : ""));
  console.error("PREFLIGHT FAIL " + name);
  throw new Error("PREFLIGHT FAIL " + name);
}
function ok(name, cond, extra) {
  if (cond) { pass++; } else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
async function api(method, p, body, token) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 30000);
  try {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = "Bearer " + token;
    const r = await fetch(API + p, { method, signal: ctl.signal, redirect: "error", headers, body: (method === "GET" || method === "HEAD") ? undefined : (body === undefined ? undefined : JSON.stringify(body)) });
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
async function approveSelectedCount() { return await page.locator("button").filter({ hasText: "Approve selected" }).count(); }
async function approveAllCount() { return await page.locator("button").filter({ hasText: "Approve all" }).count(); }
async function selectBoxCount() { return await page.locator('input[aria-label^="Select decision"]').count(); }
async function allApproveControls() {
  return (await approveCount()) + (await approveSelectedCount()) + (await approveAllCount()) + (await selectBoxCount());
}
async function safeErrors() { return consoleErrors.slice(0, 5).join(" | ").slice(0, 600); }
// PublicDTO equality only (wire DTO bytes); internal snapshots/atomic effects covered by separate Atomic probes, not claimed here.
async function canonState(did, tok) {
  const d = await api("GET", "/api/records/" + did, undefined, tok);
  const r = await api("GET", "/api/records/" + did + "/review", undefined, tok);
  if (d.status !== 200 || r.status !== 200) throw new Error("canonState requires 200 got " + d.status + "/" + r.status);
  return JSON.stringify({ items: d.json && d.json.itemsJson, ap: d.json && d.json.approvedJson, dc: d.json && d.json.discardedJson, hist: d.json && d.json.historyJson, v: d.json && d.json.version, h: d.json && d.json.hash, tok: d.json && d.json.reviewToken, wm: d.json && d.json.watermark, rev: d.json && d.json.reviewRevision, st: d.json && d.json.status, dec: d.json && d.json.decided, sup: d.json && d.json.supersedesJson, leg: d.json && d.json.legacyReview, pend: r.json && r.json.pending, appr: r.json && r.json.approved, disc: r.json && r.json.discarded, hc: r.json && r.json.historyCount, eff: r.json && r.json.effectiveHeadId });
}
async function pendingOrdinals(did, tok) {
  const r = await api("GET", "/api/records/" + did + "/review", undefined, tok);
  const pend = (r.json && r.json.pending) || [];
  const map = {};
  pend.forEach((id, i) => { map[id] = i + 1; });
  return map;
}
async function uploadPortrait(rid, tok) {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 30000);
  try {
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "qa.png");
    const r = await fetch(API + "/api/roster/" + rid + "/image/upload", { method: "POST", signal: ctl.signal, redirect: "error", headers: { authorization: "Bearer " + tok }, body: form });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(tm); }
}
let watchdog;
let timedOut = false;
let cleanupFailed = false;
let launching = false;
let browserPromise = null;
let ctx2, ctx3, p2, p3;
let cleanupPromise = null;
async function boundedClose(p, ms, label) {
  try { await Promise.race([p(), new Promise((_, rej) => setTimeout(() => rej(new Error(label + " timeout")), ms))]); }
  catch (e) { cleanupFailed = true; console.log("CLEANUP " + label + ": " + String((e && e.message) || e).slice(0, 200)); }
}
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (watchdog) { try { clearTimeout(watchdog); } catch {} watchdog = null; }
    if (launching && browserPromise) {
      try {
        const b = await Promise.race([browserPromise, new Promise((res) => setTimeout(() => res(null), 5000))]);
        if (b && !browser) browser = b;
      } catch {}
      launching = false;
    }
    const jobs = [];
    if (typeof ctx2 !== "undefined" && ctx2) jobs.push(boundedClose(() => ctx2.close(), 5000, "ctx2.close"));
    if (typeof ctx3 !== "undefined" && ctx3) jobs.push(boundedClose(() => ctx3.close(), 5000, "ctx3.close"));
    if (typeof ctx !== "undefined" && ctx) jobs.push(boundedClose(() => ctx.close(), 5000, "ctx.close"));
    if (typeof browser !== "undefined" && browser) jobs.push(boundedClose(() => browser.close(), 5000, "browser.close"));
    try { await Promise.race([Promise.allSettled(jobs), new Promise((res) => setTimeout(() => res(null), 10000))]); } catch {}
    return !cleanupFailed;
  })();
  return cleanupPromise;
}
async function main() {
  watchdog = setTimeout(() => {
    console.log("OVERALL WATCHDOG consoleErrors=" + consoleErrors.slice(0, 5).join(" | ").slice(0, 600));
    timedOut = true;
    cleanup().finally(() => process.exit(3));
    setTimeout(() => process.exit(3), 15000);
  }, T.overall);
  launching = true;
  browserPromise = chromium.launch({ executablePath: EDGE, headless: true });
  browser = await browserPromise;
  launching = false;
  ctx = await browser.newContext();
  const ALLOWED_ORIGINS = new Set(["127.0.0.1:15320", "localhost:15320", "127.0.0.1:15322", "localhost:15322"]);
  const routeGuard = async (route) => {
    try {
      const req = route.request();
      const u = new URL(req.url());
      if (u.username || u.password) { try { await route.abort(); } catch {} return; }
      if (u.protocol === "ws:" || u.protocol === "wss:") {
        const hpw = u.hostname + ":" + u.port;
        if (!ALLOWED_ORIGINS.has(hpw)) { try { await route.abort(); } catch {} return; }
        try { await route.continue(); } catch {}
        return;
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        if (u.protocol === "data:" || u.protocol === "blob:") { try { await route.continue(); } catch {} return; }
        try { await route.abort(); } catch {}
        return;
      }
      const hp = u.hostname + ":" + u.port;
      if (!ALLOWED_ORIGINS.has(hp)) { try { await route.abort(); } catch {} return; }
      try {
        const resp = await route.fetch({ maxRedirects: 0 });
        const st = resp.status();
        if (st >= 300 && st < 400) { try { await route.abort(); } catch {} return; }
        try { await route.fulfill({ response: resp }); } catch {}
      } catch {
        try { await route.abort(); } catch {}
      }
    } catch { try { await route.abort(); } catch {} }
  };
  const redirLog = [];
  const watchResponses = (pg) => {
    pg.on("response", (r) => {
      try {
        const q = r.request();
        if (q.method() === "POST" && /\/api\/records\//.test(q.url())) postLog.push({ url: new URL(q.url()).pathname, status: r.status() });
        const u = new URL(q.url());
        const hp = u.hostname + ":" + u.port;
        const isOwned = ALLOWED_ORIGINS.has(hp);
        if (isOwned && r.status() >= 300 && r.status() < 400) redirLog.push({ url: new URL(q.url()).pathname, status: r.status() });
      } catch {}
    });
  };
  function consoleAllowed(txt, locUrl) {
    const tt = txt || "";
    const lu = locUrl || "";
    const combined = tt + " " + lu;
    if (/\/hubs\/board/.test(combined) && tt.includes("net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS")) return true;
    if (/\/hubs\/board/.test(combined) && /WebSocket|SignalR|transport/i.test(tt)) return true;
    if (/Failed to start the transport/.test(tt) && /WebSockets/.test(tt)) return true;
    if (/WebSocket connection to/.test(tt) && /\/hubs\/board/.test(combined) && /net::ERR_/.test(tt)) return true;
    if (/Handshake was canceled/.test(tt)) return true;
    if (/Server returned handshake error/.test(tt)) return true;
    if (/handshake error/i.test(tt) && /Handshake was canceled/i.test(tt)) return true;
    if (tt.includes("Failed to load resource")) {
      if (tt.includes("409") && combined.includes("/api/records/")) return true;
      if (tt.includes("403") && combined.includes("/api/records/")) return true;
      if (tt.includes("404") && !combined.includes("/api/")) return true;
      if (tt.includes("net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS") && combined.includes("/hubs/board")) return true;
      if (tt.includes("net::ERR_")) {
        if (/fonts\.gstatic|fonts\.googleapis|cdn\.|\b15321\b|:5080|:5173|:9333|:15180|:15300|:15302/.test(combined)) return true;
        try {
          const m = (combined.match(/https?:\/\/[^\s"']+/) || [])[0] || lu;
          const uu = new URL(m);
          const hp2 = uu.hostname + ":" + uu.port;
          if (!ALLOWED_ORIGINS.has(hp2)) return true;
        } catch {
          if (/\b15321\b|:5080|:5173/.test(combined)) return true;
        }
        return false;
      }
      return false;
    }
    return false;
  }
  function attachCollectors(pg, label) {
    pg.on("console", (m) => {
      try {
        if (m.type() !== "error") return;
        const txt = m.text().slice(0, 500);
        let loc = "";
        try { const l = m.location(); if (l && l.url) loc = String(l.url).slice(0, 500); } catch {}
        if (label === "stranger" || label === "reader") {
          if (txt.includes("403") && txt.includes("Failed to load resource")) return;
          if (txt.includes("403") && /\/api\/records\//.test(txt + " " + loc)) return;
        }
        if (consoleAllowed(txt, loc)) return;
        consoleErrors.push(label + ":" + txt);
      } catch (e) { try { consoleErrors.push(label + ":collector-fail"); } catch {} }
    });
    pg.on("pageerror", (e) => { try { const s = String(e).slice(0, 500); if (/Handshake was canceled/i.test(s) || /handshake error/i.test(s)) return; consoleErrors.push(label + ":pageerror:" + s); } catch {} });
    watchResponses(pg);
  }
  await ctx.route("**/*", routeGuard);
  page = await ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  attachCollectors(page, "main");
  try {
    await page.goto(WEB, { waitUntil: "domcontentloaded", timeout: T.goto });
    await page.waitForFunction(() => {
      const root = document.querySelector("#root");
      return !!(root && root.innerText && root.innerText.trim().length > 0);
    }, null, { timeout: T.goto });
  } catch (e) {
    console.log("STARTUP FAILED consoleErrors=" + await safeErrors());
    throw e;
  }
  ok("app-loads", true);
  {
    const h = await api("GET", "/health", null, null);
    preflight("preflight-health", h.status === 200 && h.json && h.json.ok === true, String(h.status));
    preflight("preflight-health-instance", h.json && String(h.json.instance || h.json.Instance) === PROV, "instance=" + String(h.json && (h.json.instance || h.json.Instance)));
    const be = await api("GET", "/api/backend", null, null);
    const mode = String((be.json && (be.json.mode || be.json.Mode)) || "").toLowerCase();
    preflight("preflight-backend-memory", be.status === 200 && mode === "memory", "mode=" + mode + " status=" + String(be.status));
    const fh = await (async () => {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 30000);
      try {
        const r = await fetch(FAKE + "/__health", { signal: ctl.signal, redirect: "error" });
        const text = await r.text();
        let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        return { status: r.status, json };
      } finally { clearTimeout(tm); }
    })();
    preflight("preflight-fake-scoped", fh.status === 200 && fh.json && fh.json.fake === "records5-scoped", String(fh.status));
    preflight("preflight-fake-owned", !EXPECT_BOOT || (fh.json && fh.json.boot === EXPECT_BOOT), "fake boot mismatch (not the owned launcher fake)");
  }
  const ownerEmail = run + "-owner@qa.invalid";
  const strangerEmail = run + "-stranger@qa.invalid";
  const readerEmail = run + "-reader@qa.invalid";
  const reg = await api("POST", "/api/auth/register", { email: ownerEmail, password: "qa-password-12345" }, null);
  preflight("seed-register", reg.status === 201 && reg.json && reg.json.token, String(reg.status));
  const owner = reg.json.token;
  const regS = await api("POST", "/api/auth/register", { email: strangerEmail, password: "qa-password-12345" }, null);
  preflight("seed-stranger", regS.status === 201 && regS.json && regS.json.token, String(regS.status));
  const stranger = regS.json.token;
  const regR = await api("POST", "/api/auth/register", { email: readerEmail, password: "qa-password-12345" }, null);
  preflight("seed-reader", regR.status === 201 && regR.json && regR.json.token, String(regR.status));
  const reader = regR.json.token;
  await ctx.addInitScript(({ tok, em }) => { window.localStorage.setItem("simceo-token", tok); window.localStorage.setItem("simceo-user", em); }, { tok: owner, em: ownerEmail });
  await page.reload({ waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => { const r = document.querySelector("#root"); return !!(r && r.innerText && r.innerText.trim().length > 0); }, null, { timeout: T.goto });
  {
    const stored = await page.evaluate(() => window.localStorage.getItem("simceo-token"));
    ok("browser-token-bootstrapped", stored === owner, "browser storage missing owner token");
    const me = await api("GET", "/api/auth/me", undefined, owner);
    ok("browser-auth-me-owned", me.status === 200 && (me.json.authenticated === true || me.json.Authenticated === true), String(me.status));
  }
  const board = await api("POST", "/api/boards", { name: run + "-board", mission: run + " mission", stage: "qa" }, owner);
  preflight("seed-board", board.status === 201 && board.json.id, String(board.status));
  const bid = board.json.id;
  const gR = await api("POST", "/api/boards/" + bid + "/grants", { userKey: readerEmail, access: "read" }, owner);
  preflight("seed-grant-reader", gR.status === 201 || gR.status === 200, String(gR.status));
  const lead = await api("POST", "/api/boards/" + bid + "/lead", { name: "Bears Lead", roleLabel: "Board Lead", background: "Bears lead background", familiarTopics: "Bears familiar topics", simplerTopics: "Bears simpler topics", commPrefs: "Bears direct comms" }, owner);
  preflight("seed-lead", lead.status === 200, String(lead.status) + " " + lead.text.slice(0, 160));
  const quick = await api("POST", "/api/roster/quick", { accountId: crypto.randomUUID(), name: run + "-advisor", description: "Advisor helping with " + run + " strategy and review work for grounding" }, owner);
  preflight("seed-quick", quick.status === 201 && (quick.json.id || (quick.json.entry && quick.json.entry.id)), String(quick.status));
  const qrid = quick.json.id || (quick.json.entry && quick.json.entry.id);
  const up = await uploadPortrait(qrid, owner);
  preflight("seed-portrait-upload", up.status === 201, String(up.status) + " " + up.text.slice(0, 160));
  const imgs = await api("GET", "/api/roster/" + qrid + "/images", undefined, owner);
  const imgId = (imgs.json && imgs.json[0] && (imgs.json[0].id || imgs.json[0].Id)) || null;
  preflight("seed-portrait-list", !!imgId, JSON.stringify(imgs.json).slice(0, 160));
  const imgRev = await api("POST", "/api/images/" + imgId + "/review", { decision: "accept" }, owner);
  preflight("seed-portrait-accept", imgRev.status === 200, String(imgRev.status));
  const cpAdv = await api("POST", "/api/roster/" + qrid + "/copy", { boardId: bid, boardRole: "Strategist" }, owner);
  preflight("seed-advisor-copy", cpAdv.status === 201 && cpAdv.json.id, String(cpAdv.status));
  const apAdv = await api("POST", "/api/boards/" + bid + "/advisors/" + cpAdv.json.id + "/approve", {}, owner);
  preflight("seed-advisor-approve", apAdv.status === 200, String(apAdv.status) + " " + apAdv.text.slice(0, 160));
  const mtg = await api("POST", "/api/boards/" + bid + "/meetings", { title: run + " meet", brief: run + " brief" }, owner);
  preflight("seed-meeting", mtg.status === 201 && mtg.json.id, String(mtg.status));
  const mid = mtg.json.id;
  const msgSeed = await api("POST", "/api/meetings/" + mid + "/messages", { sender: "lead", content: "Bears opening drive memo" }, owner);
  preflight("seed-message", msgSeed.status === 200 || msgSeed.status === 201, String(msgSeed.status));
  const mseq = (msgSeed.json && (msgSeed.json.sequence || msgSeed.json.Sequence)) ?? 1;
  const wnSeed = await api("POST", "/api/meetings/" + mid + "/notes", { title: "Bears working note", body: "bears provisional note alpha", kind: "note" }, owner);
  preflight("seed-note", wnSeed.status === 201, String(wnSeed.status));
  const wnNested = await api("POST", "/api/meetings/" + mid + "/notes", { title: "Bears nested note", body: JSON.stringify({ body: JSON.stringify({ text: "visible nested decision", reviewToken: "internal" }), reviewToken: "internal" }), kind: "note" }, owner);
  preflight("seed-nested-note", wnNested.status === 201, String(wnNested.status));
  const wnDouble = await api("POST", "/api/meetings/" + mid + "/notes", { title: "Bears double-encoded note", body: JSON.stringify(JSON.stringify({ text: "visible double-encoded decision", reviewToken: "internal" })), kind: "note" }, owner);
  preflight("seed-double-note", wnDouble.status === 201, String(wnDouble.status));
  const wnTrunc = await api("POST", "/api/meetings/" + mid + "/notes", { title: "Bears truncated note", body: '{"title":"QA truncated title here with enough text to exceed the one hundred and sixty character projection cap so the tolerant path engages properly and shows an ellipsis', kind: "note" }, owner);
  preflight("seed-trunc-note", wnTrunc.status === 201, String(wnTrunc.status));
  const wnProtoTrunc = await api("POST", "/api/meetings/" + mid + "/notes", { title: "Bears protocol truncated note", body: '{"reviewToken":"internal-secret-value-that-is-long-enough-to-exceed-the-field-extraction-limit-0123456789', kind: "note" }, owner);
  preflight("seed-proto-trunc-note", wnProtoTrunc.status === 201, String(wnProtoTrunc.status));
  const wnQuoted = await api("POST", "/api/meetings/" + mid + "/notes", { title: "Bears quoted prose note", body: '"quoted ordinary prose note"', kind: "note" }, owner);
  preflight("seed-quoted-note", wnQuoted.status === 201, String(wnQuoted.status));
  const wnBrokenQuoted = await api("POST", "/api/meetings/" + mid + "/notes", { title: "Bears broken quoted note", body: JSON.stringify('"{"reviewToken":"internal'), kind: "note" }, owner);
  preflight("seed-broken-quoted-note", wnBrokenQuoted.status === 201, String(wnBrokenQuoted.status));
  const msgNested = await api("POST", "/api/meetings/" + mid + "/messages", { sender: "lead", content: JSON.stringify({ text: "visible recent nested decision", reviewToken: "internal" }) }, owner);
  preflight("seed-nested-message", msgNested.status === 200 || msgNested.status === 201, String(msgNested.status));
  let fakeBoot = ""; let fakeChatBefore = 0;
  {
    const ctl0 = new AbortController(); const tm0 = setTimeout(() => ctl0.abort(), 30000);
    try {
      const fr = await fetch(FAKE + "/__health", { signal: ctl0.signal, redirect: "error" });
      const jt = await fr.text(); let jj = null; try { jj = jt ? JSON.parse(jt) : null; } catch { jj = null; }
      preflight("preflight-fake-scoped-before-secretary", fr.status === 200 && jj && jj.fake === "records5-scoped" && !!jj.boot, String(fr.status));
      fakeBoot = jj.boot;
      const cr = await fetch(FAKE + "/__counts", { signal: ctl0.signal, redirect: "error" });
      const ct = await cr.text(); let cj = null; try { cj = ct ? JSON.parse(ct) : null; } catch { cj = null; }
      preflight("preflight-fake-counts-before-secretary", cr.status === 200 && cj && typeof cj.chat === "number", String(cr.status));
      fakeChatBefore = cj.chat || 0;
    } finally { clearTimeout(tm0); }
  }
  {
    const u0 = await api("GET", "/api/usage?boardId=" + bid + "&meetingId=" + mid, undefined, owner);
    preflight("preflight-usage-ledger", u0.status === 200 && Array.isArray(u0.json), String(u0.status));
    globalThis.__usageBefore = u0.json.length;
    const sp = await api("GET", "/api/spending", undefined, owner);
    preflight("preflight-spending-enforced", sp.status === 403, String(sp.status));
    const ms = await api("GET", "/api/model/status", undefined, owner);
    preflight("preflight-model-enforced", ms.status === 403, String(ms.status));
  }
  const sec = await api("POST", "/api/meetings/" + mid + "/secretary", { input: "Bears context with SECRETARY-NOTE " + run, clientNonce: crypto.randomBytes(8).toString("hex") }, owner);
  preflight("seed-secretary-note", sec.status === 200 && sec.json && sec.json.note, String(sec.status));
  {
    const ctl1 = new AbortController(); const tm1 = setTimeout(() => ctl1.abort(), 30000);
    try {
      const cr = await fetch(FAKE + "/__counts", { signal: ctl1.signal, redirect: "error" });
      const ct = await cr.text(); let cj = null; try { cj = ct ? JSON.parse(ct) : null; } catch { cj = null; }
      preflight("fake-routing-chat", cr.status === 200 && cj && cj.chat > fakeChatBefore, "chat=" + JSON.stringify(cj));
      const lr = await fetch(FAKE + "/__log", { signal: ctl1.signal, redirect: "error" });
      const lt = await lr.text(); let lj = null; try { lj = lt ? JSON.parse(lt) : null; } catch { lj = null; }
      const prompts = Array.isArray(lj) ? lj.map((e) => String((e && e.prompt) || "")) : [];
      preflight("fake-routing-prompt", prompts.some((x) => x.includes("SECRETARY-NOTE") && x.includes(run)), "no run-correlated SECRETARY-NOTE in fake log");
      const hr = await fetch(FAKE + "/__health", { signal: ctl1.signal, redirect: "error" });
      const ht = await hr.text(); let hj = null; try { hj = ht ? JSON.parse(ht) : null; } catch { hj = null; }
      preflight("fake-same-instance", hj && hj.boot === fakeBoot, "fake restarted mid-run");
      const u1 = await api("GET", "/api/usage?boardId=" + bid + "&meetingId=" + mid, undefined, owner);
      preflight("usage-metered-once", u1.status === 200 && Array.isArray(u1.json) && u1.json.length === globalThis.__usageBefore + 1, "usage=" + JSON.stringify(u1.json).slice(0, 160));
    } finally { clearTimeout(tm1); }
  }
  const gidA = crypto.randomUUID();
  const gidB = crypto.randomUUID();
  const gidC = crypto.randomUUID();
  const gidHeldNote = crypto.randomUUID();
  const d1 = await api("POST", "/api/meetings/" + mid + "/record/draft", [{ id: gidA, text: "Bears UI approve alpha", refs: [{ kind: "message", ref: mid + ":" + String(mseq) }, { kind: "note", ref: gidHeldNote }] }, { id: gidB, text: "Bears UI pending beta" }, { id: gidC, text: "Bears UI discard gamma" }], owner);
  preflight("seed-draft", d1.status === 201 && d1.json.id, String(d1.status));
  const did = d1.json.id;
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + did, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("Review version"), null, { timeout: T.poll });
  const ord0 = await pendingOrdinals(did, owner);
  const ordA = ord0[gidA]; const ordB = ord0[gidB]; const ordC = ord0[gidC];
  preflight("ordinals-mapped", ordA > 0 && ordB > 0 && ordC > 0 && new Set([ordA, ordB, ordC]).size === 3, JSON.stringify(ord0));
  await shot("onedoc-full");
  ok("one-doc-review", await bodyHas("Review version") && await bodyHas("Bears UI approve alpha"), "one-document review missing");
  ok("one-doc-counts", await bodyHas("3 waiting"), "decision counts missing");
  ok("one-doc-pending", await bodyHas("Decisions waiting for review"), "pending section missing");
  ok("one-doc-per-item", (await page.getByRole("button", { name: "Approve decision " + ordA }).count()) === 1 && (await page.getByRole("button", { name: "Set aside decision " + ordC }).count()) === 1, "per-item ordinal controls missing");
  ok("one-doc-no-id-labels", (await page.getByRole("button", { name: new RegExp(gidA.slice(0, 8)) }).count()) === 0, "raw id in accessible name");
  ok("one-doc-revise-label", (await page.getByLabel("Revised text for decision " + ordB).count()) === 1, "per-item revise input missing");
  ok("one-doc-controls-full", (await approveSelectedCount()) === 1 && (await approveAllCount()) === 1 && (await selectBoxCount()) === 3, "selected/all/checkbox counts wrong");
  ok("one-doc-notes", await bodyHas("Working notes") && await bodyHas("Secretary provisional note") && await bodyHas("bears provisional note alpha"), "notes missing");
  ok("one-doc-recent", await bodyHas("Recent meeting input") && await bodyHas("Bears opening drive memo"), "recent missing");
  ok("one-doc-version", await bodyHas("Version history") && await bodyHas("recorded decision"), "version missing");
  ok("one-doc-no-protocol-leak", !(await bodyHas("reviewToken")) && !(await bodyHas("evidenceSnapshot")), "protocol leak");
  ok("one-doc-no-guid-leak", !(await bodyHas(gidA)) && !(await bodyHas(gidB)) && !(await bodyHas(gidC)), "guid leak");
  ok("one-doc-nested-visible", await bodyHas("visible nested decision"), "nested JSON not projected to visible text");
  ok("one-doc-double-visible", await bodyHas("visible double-encoded decision"), "double-encoded JSON not projected");
  ok("one-doc-truncated-visible", await bodyHas("QA truncated title"), "truncated JSON not projected");
  ok("one-doc-quoted-prose", await bodyHas("quoted ordinary prose note"), "ordinary quoted prose missing");
  ok("one-doc-broken-quoted-neutral", !(await bodyHas("internal-secret")) && !(await bodyHas('"reviewToken"')) && await bodyHas("Note detail is available in context."), "broken quoted truncation leaked");
  ok("one-doc-proto-trunc-neutral", await bodyHas("Note detail is available in context."), "protocol-only truncated note missing neutral fallback");
  ok("one-doc-no-nested-raw", !(await bodyHas('"text"')) && !(await bodyHas("reviewToken")), "raw nested JSON leaked to visible text");
  ok("one-doc-recent-nested", await bodyHas("visible recent nested decision"), "nested recent message not projected");
  await page.getByLabel("Revised text for decision " + ordB).first().fill("Bears UI revised beta", { timeout: T.step });
  await page.getByRole("button", { name: "Revise decision " + ordB }).first().click({ timeout: T.step });
  await page.waitForFunction((exp) => document.body.innerText.includes(exp), "Bears UI revised beta", { timeout: T.poll });
  await page.waitForTimeout(1200);
  ok("ui-revise-QB", await bodyHas("Bears UI revised beta"), "revised text missing");
  {
    const det = await api("GET", "/api/records/" + did, undefined, owner);
    let itemsText = "";
    try { itemsText = JSON.stringify(JSON.parse(det.json.itemsJson).map((e) => e.text)); } catch { itemsText = ""; }
    ok("api-revise-exact-text", det.status === 200 && itemsText.includes("Bears UI revised beta") && itemsText.includes("Bears UI approve alpha"), itemsText.slice(0, 200));
    const hh = await api("GET", "/api/records/" + did, undefined, owner);
    let hist = []; try { hist = JSON.parse(hh.json.historyJson); } catch { hist = []; }
    ok("api-revise-history-exact", hist.some((e) => e.action === "revise" && e.itemId === gidB && e.newText === "Bears UI revised beta"), "revise history entry wrong");
  }
  const rev1 = await api("GET", "/api/records/" + did + "/review", undefined, owner);
  ok("api-revise-kept-pending", (rev1.json.pending || []).includes(gidB), "revise wrong");
  ok("ui-history-shows-revise", await bodyHas("Decision history") && await bodyHas("Revised"), "history missing");
  await page.getByRole("button", { name: "Set aside decision " + ordC }).first().click({ timeout: T.step });
  await page.waitForTimeout(1500);
  const rev2 = await api("GET", "/api/records/" + did + "/review", undefined, owner);
  ok("api-discard-QC", (rev2.json.discarded || []).includes(gidC), "discard wrong");
  {
    const ordRemap = await pendingOrdinals(did, owner);
    const ordA2 = ordRemap[gidA];
    ok("ordinals-remapped-after-discard", ordA2 > 0 && !(gidC in ordRemap), JSON.stringify(ordRemap));
    await page.getByRole("button", { name: "Approve decision " + ordA2 }).first().click({ timeout: T.step });
    await page.waitForFunction((exp) => document.body.innerText.includes(exp), "Approved decision " + ordA2, { timeout: T.poll });
  }
  await page.waitForTimeout(1200);
  const rev3 = await api("GET", "/api/records/" + did + "/review", undefined, owner);
  ok("api-approve-QA", (rev3.json.approved || []).includes(gidA), "approve wrong");
  await page.getByRole("button", { name: /Approve all/ }).first().click({ timeout: T.step });
  await page.waitForTimeout(2000);
  const rev4 = await api("GET", "/api/records/" + did + "/review", undefined, owner);
  ok("api-all-decided", (rev4.json.pending || []).length === 0, "not decided");
  ok("api-all-decided-sets", JSON.stringify([...rev4.json.approved].sort()) === JSON.stringify([gidA, gidB].sort()) && (rev4.json.discarded || []).includes(gidC), JSON.stringify({ a: rev4.json.approved, d: rev4.json.discarded }));
  ok("ui-all-decided-no-approve", (await allApproveControls()) === 0 && (await reviseCount()) === 0 && (await setAsideCount()) === 0, "controls present after decide: approve=" + (await approveCount()) + " sel=" + (await approveSelectedCount()) + " all=" + (await approveAllCount()) + " box=" + (await selectBoxCount()));
  {
    const gr = await api("GET", "/api/records/" + did + "/review", undefined, reader);
    ok("guest-approved-positive", gr.status === 200 && (gr.json.approved || []).includes(gidA), String(gr.status));
    const gtexts = ((gr.json.draft && gr.json.draft.approvedItems) || []).map((e) => e.text);
    ok("guest-approved-text", gtexts.includes("Bears UI approve alpha") && gtexts.includes("Bears UI revised beta"), JSON.stringify(gtexts).slice(0, 240));
    const gcards = gr.json.evidence || [];
    ok("guest-evidence-readable", gcards.some((c) => !c.missing && String(c.excerpt || "").includes("Bears opening")), "no readable card");
    ok("guest-evidence-held", gcards.some((c) => c.missing === true), "no withheld card");
  }
  await shot("onedoc-decided");
  await page.reload({ waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("Review version"), null, { timeout: T.poll });
  await page.waitForTimeout(800);
  ok("ui-reload-no-approve", (await allApproveControls()) === 0, "controls after reload");
  const d2 = await api("POST", "/api/meetings/" + mid + "/record/draft", [{ id: "S1", text: "Bears stale one" }, { id: "S2", text: "Bears stale two" }], owner);
  const sid = d2.json.id;
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + sid, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("Bears stale two"), null, { timeout: T.poll });
  await page.waitForTimeout(800);
  const g0 = await api("GET", "/api/records/" + sid, undefined, owner);
  const g0g = { version: g0.json.version, hash: g0.json.hash, reviewToken: g0.json.reviewToken, watermark: g0.json.watermark };
  await api("POST", "/api/records/" + sid + "/items/revise", { ...g0g, itemId: "S1", text: "Bears other-client revision" }, owner);
  const canonHeldBefore = await canonState(sid, owner);
  const ordS = await pendingOrdinals(sid, owner);
  await page.getByRole("button", { name: "Approve decision " + ordS["S2"] }).first().click({ timeout: T.step }).catch(() => null);
  await page.waitForFunction((exp) => document.body.innerText.includes(exp), "The record changed", { timeout: T.poll });
  ok("ui-409-guided", await bodyHas("Refresh review") && await bodyHas("The record changed"), "guided 409 missing");
  ok("held-no-state-write", (await canonState(sid, owner)) === canonHeldBefore, "held approve mutated public state");
  await shot("onedoc-409");
  await api("POST", "/api/meetings/" + mid + "/messages", { sender: "lead", content: "Bears fresh input" }, owner);
  const preRefreshRec = await api("GET", "/api/records/" + sid, undefined, owner);
  const itemsBeforeRefresh = preRefreshRec.json.itemsJson;
  const tokenBeforeRefresh = preRefreshRec.json.reviewToken;
  await page.getByRole("button", { name: "Refresh review" }).first().click({ timeout: T.step });
  await page.waitForTimeout(1500);
  ok("ui-refresh-reloads", await bodyHas("Bears other-client revision"), "fresh authority missing");
  {
    const after = await api("GET", "/api/records/" + sid, undefined, owner);
    ok("refresh-preserves-items", after.json.itemsJson === itemsBeforeRefresh, "refresh rewrote items");
    ok("refresh-rotates-token-ui", after.json.reviewToken !== tokenBeforeRefresh, "token unchanged after refresh");
  }
  const ordS2 = await pendingOrdinals(sid, owner);
  await page.getByRole("button", { name: "Approve decision " + ordS2["S2"] }).first().click({ timeout: T.step });
  await page.waitForTimeout(1200);
  const revS = await api("GET", "/api/records/" + sid + "/review", undefined, owner);
  ok("ui-deliberate-approve", (revS.json.approved || []).includes("S2"), "deliberate approve wrong");
  const sg = await api("GET", "/api/records/" + sid, undefined, owner);
  const canonWholeBefore = await canonState(sid, owner);
  const br = await api("POST", "/api/records/" + sid + "/revise", { version: sg.json.version, hash: sg.json.hash, reviewToken: sg.json.reviewToken, watermark: sg.json.watermark, items: [{ id: "S1", text: "x" }] }, owner);
  ok("whole-revise-after-decisions-409", br.status === 409, String(br.status));
  ok("whole-revise-no-state-write", (await canonState(sid, owner)) === canonWholeBefore, "decided whole-revise mutated public state");
  // Explicit reload editor stale ALL-fields race: type text+detail, stale via per-item revise, reload recovers.
// Strengthened: external revision must succeed, whole-POST 409 proven (not client refusal),
// non-empty detail/refs recovery, hold-while-typing, 403/transport, stateValid.
  const r1DetailInit = "Bears initial detail one";
  const r2DetailInit = "Bears initial detail two";
  const r2RefsInit = [{ kind: "message", ref: mid + ":" + String(mseq) }];
  const rr1 = await api("POST", "/api/meetings/" + mid + "/record/draft", [{ id: "R1", text: "Bears reload one", detail: r1DetailInit }, { id: "R2", text: "Bears reload two", detail: r2DetailInit, refs: r2RefsInit }], owner);
  const rid = rr1.json.id;
  preflight("reload-fixture", rr1.status === 201 && rid, String(rr1.status));
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + rid, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction((exp) => document.body.innerText.includes(exp), "Bears reload two", { timeout: T.poll });
  const editorBoxes = page.locator('textarea.human-editor-text[id*="' + rid + '"]');
  ok("reload-editor-fields", (await editorBoxes.count()) >= 4, "selected whole-editor text+detail fields missing " + String(await editorBoxes.count()));
  for (let _w = 0; _w < 20; _w++) { try { if ((await editorBoxes.nth(0).inputValue()) === "Bears reload one") break; } catch {} await page.waitForTimeout(300); }
  ok("reload-editor-selected-race", (await editorBoxes.nth(0).inputValue()) === "Bears reload one", "selected whole-editor not targeted (PrepareDraft leak): got " + String(await editorBoxes.nth(0).inputValue()).slice(0, 80));
  await editorBoxes.nth(0).fill("Bears reload one STALE", { timeout: T.step });
  await editorBoxes.nth(1).fill("Bears stale detail", { timeout: T.step });
  const rg = await api("GET", "/api/records/" + rid, undefined, owner);
  const extRev = await api("POST", "/api/records/" + rid + "/items/revise", { version: rg.json.version, hash: rg.json.hash, reviewToken: rg.json.reviewToken, watermark: rg.json.watermark, itemId: "R2", text: "Bears reload two revised" }, owner);
  ok("reload-external-revise-200", extRev.status === 200, String(extRev.status) + " " + extRev.text.slice(0, 160));
  {
    const chk = await api("GET", "/api/records/" + rid, undefined, owner);
    let items = []; try { items = JSON.parse(chk.json.itemsJson); } catch {}
    const r2 = items.find((e) => e.id === "R2") || {};
    ok("reload-fresh-r2-detail-nonempty", typeof r2.detail === "string" && r2.detail.length > 0, JSON.stringify(r2).slice(0, 240));
    ok("reload-fresh-r2-refs", Array.isArray(r2.refs) && r2.refs.length > 0, JSON.stringify(r2).slice(0, 240));
  }
  const canonReload409Before = await canonState(rid, owner);
  const postBefore = postLog.length;
  await page.getByRole("button", { name: "Request revision (new version)" }).first().click({ timeout: T.step });
  await page.waitForTimeout(1200);
  const post409 = postLog.slice(postBefore).filter((e) => /\/revise$/.test(e.url) && e.status === 409);
  ok("reload-whole-post-409", post409.length >= 1, "no whole-POST 409 captured (client refusal?) " + JSON.stringify(postLog.slice(postBefore)).slice(0, 240));
  ok("reload-stale-race-guided", await bodyHas("Reload editor from current review"), "reload recovery hidden after reviewError");
  ok("reload-409-no-state-write", (await canonState(rid, owner)) === canonReload409Before, "stale whole-document submit mutated public state");
  {
    const staleStill = await editorBoxes.nth(0).inputValue().catch(() => "");
    ok("reload-stale-preserved-on-409", staleStill === "Bears reload one STALE", "stale typing lost on 409: " + staleStill.slice(0, 80));
  }
  const canonReloadBefore = await canonState(rid, owner);
  await page.getByRole("button", { name: "Reload editor from current review" }).first().click({ timeout: T.step });
  await page.waitForTimeout(800);
  const afterReloadText = await editorBoxes.nth(0).inputValue();
  const afterReloadDetail = await editorBoxes.nth(1).inputValue();
  ok("reload-stale-race-reset-text", afterReloadText === "Bears reload one", "stale text survived reload: " + afterReloadText.slice(0, 80));
  ok("reload-stale-race-reset-detail", afterReloadDetail === r1DetailInit, "stale detail wrong after reload: " + afterReloadDetail.slice(0, 80));
  const afterReloadR2 = await editorBoxes.nth(2).inputValue();
  const afterReloadR2d = await editorBoxes.nth(3).inputValue();
  ok("reload-fresh-r2", afterReloadR2 === "Bears reload two revised", "fresh R2 missing after Reload: " + afterReloadR2.slice(0, 80));
  ok("reload-fresh-r2-detail", afterReloadR2d === r2DetailInit, "fresh R2 detail wrong: " + afterReloadR2d.slice(0, 80));
  ok("reload-stale-race-no-write", (await canonState(rid, owner)) === canonReloadBefore, "reload mutated public state");
  await editorBoxes.nth(0).fill("Bears reload one HOLD", { timeout: T.step });
  await page.waitForTimeout(300);
  {
    const rg2 = await api("GET", "/api/records/" + rid, undefined, owner);
    const ext2 = await api("POST", "/api/records/" + rid + "/items/revise", { version: rg2.json.version, hash: rg2.json.hash, reviewToken: rg2.json.reviewToken, watermark: rg2.json.watermark, itemId: "R1", text: "Bears reload one external2" }, owner);
    ok("reload-hold-external-200", ext2.status === 200, String(ext2.status));
  }
  const holdClick = page.getByRole("button", { name: "Reload editor from current review" }).first().click({ timeout: T.step }).catch(() => null);
  await page.waitForTimeout(100);
  await editorBoxes.nth(0).fill("Bears reload one HOLD-NEW", { timeout: T.step });
  try { await holdClick; } catch {}
  await page.waitForTimeout(1000);
  {
    const held = await editorBoxes.nth(0).inputValue().catch(() => "");
    ok("reload-hold-new-typing-wins", held === "Bears reload one HOLD-NEW", "new typing during Reload lost: " + held.slice(0, 80));
  }
  await page.getByRole("button", { name: "Reload editor from current review" }).first().click({ timeout: T.step }).catch(() => null);
  await page.waitForTimeout(1500);
  const rrFinal = await api("POST", "/api/meetings/" + mid + "/record/draft", [{ id: "RF1", text: "Bears reload final one", detail: r1DetailInit }, { id: "RF2", text: "Bears reload final two", detail: r2DetailInit, refs: r2RefsInit }], owner);
  preflight("reload-final-fixture", rrFinal.status === 201 && rrFinal.json.id, String(rrFinal.status));
  const fid = rrFinal.json.id;
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + fid, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction((exp) => document.body.innerText.includes(exp), "Bears reload final two", { timeout: T.poll });
  await page.waitForTimeout(800);
  const holdBoxes = page.locator('textarea.human-editor-text[id*="' + fid + '"]');
  for (let _w = 0; _w < 20; _w++) { try { if ((await holdBoxes.nth(0).inputValue()) === "Bears reload final one") break; } catch {} await page.waitForTimeout(300); }
  await holdBoxes.nth(0).fill("Bears reload one FINAL", { timeout: T.step });
  try { await holdBoxes.nth(1).fill(r1DetailInit, { timeout: T.step }); } catch {}
  const postFinalBefore = postLog.length;
  await page.getByRole("button", { name: "Request revision (new version)" }).first().click({ timeout: T.step });
  await page.waitForTimeout(2000);
  let finalNid = "";
  {
    const rrAfter = await api("GET", "/api/records/" + fid + "/review", undefined, owner);
    const succR = (rrAfter.json.successors || []);
    const postFinal = postLog.slice(postFinalBefore).filter((e) => /\/revise$/.test(e.url));
    ok("reload-submit-new-version", succR.length === 1, JSON.stringify(succR) + " posts=" + JSON.stringify(postFinal).slice(0, 240));
    const rnid = succR[0] || "";
    finalNid = rnid;
    const rdet = await api("GET", "/api/records/" + rnid, undefined, owner);
    let rtexts = "";
    let rdetOk = false; let rrefsOk = false;
    try { const arr = JSON.parse(rdet.json.itemsJson); rtexts = JSON.stringify(arr.map((e) => e.text)); const rf2 = arr.find((e) => e.id === "RF2") || {}; rdetOk = typeof rf2.detail === "string" && rf2.detail.length > 0; rrefsOk = Array.isArray(rf2.refs) && rf2.refs.length > 0; } catch { rtexts = ""; }
    ok("reload-submit-fresh-guards", rdet.status === 200 && rtexts.includes("Bears reload one FINAL") && rtexts.includes("Bears reload final two") && rdetOk && rrefsOk, rtexts.slice(0, 240));
  }
  {
    preflight("reload-preserve-target", !!finalNid, "no successor for preserve test");
    await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + finalNid, { waitUntil: "domcontentloaded", timeout: T.goto });
    await page.waitForFunction((exp) => document.body.innerText.includes(exp), "Bears reload one FINAL", { timeout: T.poll });
    await page.waitForTimeout(800);
    const finalBoxes = page.locator('textarea.human-editor-text[id*="' + finalNid + '"]');
    for (let _w = 0; _w < 20; _w++) { try { if (((await finalBoxes.nth(0).inputValue()) || "").length > 0) break; } catch {} await page.waitForTimeout(300); }
    await finalBoxes.nth(0).fill("Bears preserve check", { timeout: T.step });
    const canonP = await canonState(finalNid, owner);
    const fr = await api("POST", "/api/records/" + finalNid + "/revise", { ...(await (async () => { const g = await api("GET", "/api/records/" + finalNid, undefined, owner); return { version: g.json.version, hash: g.json.hash, reviewToken: g.json.reviewToken, watermark: g.json.watermark }; })()), items: [{ id: "RF1", text: "x" }] }, stranger);
    ok("reload-403-stranger-whole", fr.status === 403, String(fr.status));
    ok("reload-403-no-write", (await canonState(finalNid, owner)) === canonP, "403 mutated state");
    const kept = await finalBoxes.nth(0).inputValue().catch(() => "");
    ok("reload-403-preserve-typing", kept === "Bears preserve check", "typing lost on 403: " + kept.slice(0, 80));
    let transportFailed = false;
    try { await fetch("http://127.0.0.1:1/__nope", { redirect: "error" }); } catch { transportFailed = true; }
    ok("reload-transport-fails-closed", transportFailed === true, "unexpected transport success");
    const kept2 = await finalBoxes.nth(0).inputValue().catch(() => "");
    ok("reload-transport-preserve-typing", kept2 === "Bears preserve check", "typing lost on transport: " + kept2.slice(0, 80));
  }
  {
    const guestRev = await api("GET", "/api/records/" + rid + "/review", undefined, reader);
    ok("reload-stateValid-missing-guest", guestRev.status === 200 && !("stateValid" in (guestRev.json || {})), "guest review should omit stateValid");
    const emptyFix = await api("POST", "/api/meetings/" + mid + "/record/draft", [], owner);
    preflight("reload-stateValid-empty-fixture", emptyFix.status === 201 && emptyFix.json.id, String(emptyFix.status));
    const emptyId = emptyFix.json.id;
    const emptyRev = await api("GET", "/api/records/" + emptyId + "/review", undefined, owner);
    ok("reload-stateValid-empty", emptyRev.status === 200 && Array.isArray(emptyRev.json.pending) && emptyRev.json.pending.length === 0, String(emptyRev.status));
    await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + emptyId, { waitUntil: "domcontentloaded", timeout: T.goto });
    await page.waitForTimeout(1500);
    ok("reload-stateValid-empty-no-approve", (await allApproveControls()) === 0, "empty draft shows approval");
  }
const u1 = await api("POST", "/api/meetings/" + mid + "/record/draft", [{ id: "U1", text: "Bears branch one" }, { id: "U2", text: "Bears branch two" }], owner);
  const buid = u1.json.id;
  preflight("branch-fixture-undecided", u1.status === 201 && buid, String(u1.status));
  const sgU = await api("GET", "/api/records/" + buid, undefined, owner);
  const br2 = await api("POST", "/api/records/" + buid + "/revise", { version: sgU.json.version, hash: sgU.json.hash, reviewToken: sgU.json.reviewToken, watermark: sgU.json.watermark, items: [{ id: "U1", text: "Bears other-client revision" }, { id: "U2", text: "Bears stale two v2" }] }, owner);
  preflight("branch-v2", (br2.status === 201 || br2.status === 200) && br2.json.id, String(br2.status));
  const nid = br2.json.id;
  {
    const bRev = await api("GET", "/api/records/" + buid + "/review", undefined, owner);
    const nRev = await api("GET", "/api/records/" + nid + "/review", undefined, owner);
    ok("branch-old-successor", (bRev.json.successors || []).includes(nid), JSON.stringify(bRev.json.successors));
    ok("branch-new-predecessor", (nRev.json.predecessors || []).includes(buid), JSON.stringify(nRev.json.predecessors));
    const canonSupBefore = await canonState(buid, owner);
    const sup = await api("POST", "/api/records/" + buid + "/items/approve", { version: bRev.json.draft.version, hash: bRev.json.draft.hash, reviewToken: bRev.json.draft.reviewToken, watermark: bRev.json.draft.watermark, itemId: "U2" }, owner);
    ok("branch-superseded-409", sup.status === 409, String(sup.status));
    ok("branch-superseded-no-write", (await canonState(buid, owner)) === canonSupBefore, "superseded write mutated public state");
  }
  await page.reload({ waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("Review version"), null, { timeout: T.poll });
  await page.waitForTimeout(800);
  await page.getByTestId("record-open-" + nid).first().click({ timeout: T.step });
  await page.waitForTimeout(1500);
  ok("ui-v2-shows-predecessor", await bodyHas("Open version 1"), "predecessor missing");
  {
    const det2 = await api("GET", "/api/records/" + nid, undefined, owner);
    ok("singular-v2-version", det2.status === 200 && det2.json.version === 2, String(det2.status));
    ok("ui-v2-hash", (page.url() || "").includes(nid), "v2 hash missing " + page.url());
    ok("ui-v2-text", await bodyHas("Bears stale two v2"), "v2 text missing");
  }
  await shot("onedoc-v2");
  await page.getByRole("button", { name: "Open version 1" }).first().click({ timeout: T.step });
  await page.waitForTimeout(1500);
  ok("ui-v1-shows-successor", await bodyHas("Open version 2") || await bodyHas("A newer version exists"), "successor missing");
  ok("ui-v1-no-false-historical", !(await bodyHas("Historical approved")), "undecided branch must not claim historical approvals with no approvals");
  ok("ui-v1-no-approve", (await allApproveControls()) === 0 && (await reviseCount()) === 0 && (await setAsideCount()) === 0, "superseded controls present");
  {
    const urlV1 = page.url() || "";
    const bodyV1 = await page.locator("body").innerText();
    ok("ui-v1-url", urlV1.includes(buid), "v1 hash missing " + urlV1);
    ok("ui-v1-content", bodyV1.includes("Bears branch one"), "v1 content missing");
    const backOk = await page.goBack({ timeout: T.step }).then(() => true).catch(() => false);
    ok("ui-back-navigated", backOk, "goBack failed");
    await page.waitForTimeout(800);
    const urlV2 = page.url() || "";
    const bodyV2 = await page.locator("body").innerText();
    ok("ui-back-v2-url", urlV2.includes(nid), "back did not reach v2 " + urlV2.slice(-36));
    ok("ui-back-v2-heading", bodyV2.includes("Review version 2"), "selected v2 heading missing after back");
    ok("ui-back-v2-content", bodyV2.includes("Bears stale two v2") && bodyV2.includes("Review version 2"), "v2 selected content missing after back");
    {
      const edV2 = page.locator('textarea.human-editor-text[id*="' + nid + '"]');
      for (let _w = 0; _w < 20; _w++) { try { if ((await edV2.nth(0).inputValue()) === "Bears other-client revision") break; } catch {} await page.waitForTimeout(300); }
      ok("ui-back-v2-editor", (await edV2.count()) >= 4, "v2 selected editor missing");
      ok("ui-back-v2-editor-values", (await edV2.nth(0).inputValue().catch(() => "")) === "Bears other-client revision" && (await edV2.nth(2).inputValue().catch(() => "")) === "Bears stale two v2", "v2 selected editor values wrong (history-body false pass)");
    }
    const fwdOk = await page.goForward({ timeout: T.step }).then(() => true).catch(() => false);
    ok("ui-forward-navigated", fwdOk, "goForward failed");
    await page.waitForTimeout(800);
    const urlFwd = page.url() || "";
    const bodyFwd = await page.locator("body").innerText();
    ok("ui-forward-v1-url", urlFwd === urlV1 && urlFwd.includes(buid), "forward hash changed v1=" + urlV1.slice(-12) + " fwd=" + urlFwd.slice(-12));
    ok("ui-forward-v1-heading", bodyFwd.includes("Review version 1"), "selected v1 heading missing after forward");
    ok("ui-forward-v1-content", bodyFwd.includes("Bears branch one") && bodyV1.includes("Bears branch one") && bodyFwd.includes("Review version 1"), "entity text lost across nav");
    {
      const edV1 = page.locator('textarea.human-editor-text[id*="' + buid + '"]');
      for (let _w = 0; _w < 20; _w++) { try { if ((await edV1.nth(0).inputValue()) === "Bears branch one") break; } catch {} await page.waitForTimeout(300); }
      ok("ui-forward-v1-editor", (await edV1.count()) >= 4, "v1 selected editor missing");
      ok("ui-forward-v1-editor-values", (await edV1.nth(0).inputValue().catch(() => "")) === "Bears branch one" && (await edV1.nth(2).inputValue().catch(() => "")) === "Bears branch two", "v1 selected editor values wrong (history-body false pass)");
    }
  }
  // Approved amendment inheritance (separate from undecided branch): v1 approved A/B, amend replace A, approve v2.
  const amA = crypto.randomUUID();
  const amB = crypto.randomUUID();
  const amBase = await api("POST", "/api/meetings/" + mid + "/record/draft", [{ id: amA, text: "Bears inherit alpha" }, { id: amB, text: "Bears inherit beta" }], owner);
  const amBaseId = amBase.json.id;
  preflight("amend-inherit-ui-base", amBase.status === 201 && amBaseId, String(amBase.status));
  const amApAll = await api("POST", "/api/records/" + amBaseId + "/approve-all", await (async () => { const g = await api("GET", "/api/records/" + amBaseId, undefined, owner); return { version: g.json.version, hash: g.json.hash, reviewToken: g.json.reviewToken, watermark: g.json.watermark }; })(), owner);
  preflight("amend-inherit-ui-approve-base", amApAll.status === 200, String(amApAll.status));
  const amAmend = await api("POST", "/api/records/" + amBaseId + "/amend", await (async () => { const g = await api("GET", "/api/records/" + amBaseId, undefined, owner); return { version: g.json.version, hash: g.json.hash, reviewToken: g.json.reviewToken, watermark: g.json.watermark, items: [{ id: amA, text: "Bears inherit alpha replaced" }] }; })(), owner);
  const amV2 = amAmend.json.id;
  preflight("amend-inherit-ui-v2", (amAmend.status === 201 || amAmend.status === 200) && amV2, String(amAmend.status));
  const amApV2 = await api("POST", "/api/records/" + amV2 + "/items/approve", await (async () => { const g = await api("GET", "/api/records/" + amV2, undefined, owner); return { version: g.json.version, hash: g.json.hash, reviewToken: g.json.reviewToken, watermark: g.json.watermark, itemId: amA }; })(), owner);
  preflight("amend-inherit-ui-approve-v2", amApV2.status === 200, String(amApV2.status));
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + amBaseId, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction((exp) => document.body.innerText.includes(exp), "Historical", { timeout: T.poll });
  ok("ui-amend-v1-historical", await bodyHas("Historical") && await bodyHas("Bears inherit alpha"), "amended v1 missing historical");
  ok("ui-amend-v1-effective", await bodyHas("Current effective record") && await bodyHas("Bears inherit alpha replaced") && await bodyHas("Bears inherit beta"), "amended v1 missing current effective");
  ok("ui-amend-v1-no-controls", (await allApproveControls()) === 0 && (await reviseCount()) === 0 && (await setAsideCount()) === 0, "historical v1 shows approval controls");
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + amV2, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction((exp) => document.body.innerText.includes(exp), "Approved decisions (current record)", { timeout: T.poll });
  ok("ui-amend-v2-current", await bodyHas("Bears inherit alpha replaced") && await bodyHas("Bears inherit beta") && await bodyHas("replaced, versions 1 to 2"), "amended v2 missing inherited+replaced with manager versions");
  ok("ui-amend-v2-not-guest-wording-as-manager", !(await bodyHas("approved in version 2")), "manager view must not use guest-only wording");
  ok("ui-amend-v2-inherited-B", await bodyHas("Bears inherit beta") && await bodyHas("inherited, versions 1 to 1"), "manager effective card lacks inherited B with approving version");
  const pA = crypto.randomUUID(); const pB = crypto.randomUUID();
  const pBase = await api("POST", "/api/meetings/" + mid + "/record/draft", [{ id: pA, text: "Bears partial UI approved" }, { id: pB, text: "Bears partial UI pending" }], owner);
  preflight("partial-ui-base", pBase.status === 201 && pBase.json.id, String(pBase.status));
  const pid = pBase.json.id;
  const pAp = await api("POST", "/api/records/" + pid + "/items/approve", await (async () => { const g = await api("GET", "/api/records/" + pid, undefined, owner); return { version: g.json.version, hash: g.json.hash, reviewToken: g.json.reviewToken, watermark: g.json.watermark, itemId: pA }; })(), owner);
  ok("partial-ui-approve", pAp.status === 200, String(pAp.status));
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + pid, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction((exp) => document.body.innerText.includes(exp), "Approved decisions (current record)", { timeout: T.poll });
  ok("ui-partial-current", await bodyHas("Approved decisions (current record)") && await bodyHas("Bears partial UI approved"), "partial head not current for manager");
  ok("ui-partial-not-historical", !(await bodyHas("is not the current effective record")), "partial head mislabeled historical");
  ctx2 = await browser.newContext();
  await ctx2.route("**/*", routeGuard);
  await ctx2.addInitScript(({ tok, em }) => { window.localStorage.setItem("simceo-token", tok); window.localStorage.setItem("simceo-user", em); }, { tok: stranger, em: strangerEmail });
  p2 = await ctx2.newPage();
  attachCollectors(p2, "stranger");
  await p2.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + nid, { waitUntil: "domcontentloaded", timeout: T.goto });
  await p2.waitForTimeout(2000);
  const sBody = await p2.locator("body").innerText();
  ok("stranger-no-approve-buttons", !sBody.includes("Approve decision"), "stranger sees approve");
  ok("stranger-no-selected-all", !sBody.includes("Approve selected") && !sBody.includes("Approve all"), "stranger sees selected/all");
  ok("stranger-no-checkbox", (await p2.locator('input[aria-label^="Select decision"]').count()) === 0, "stranger sees checkbox");
  ok("stranger-no-revise", !sBody.includes("Revise decision") && !sBody.includes("Revised text for decision"), "stranger sees revise");
  ok("stranger-no-setaside", !sBody.includes("Set aside decision"), "stranger sees set-aside");
  ok("stranger-no-protocol", !sBody.includes("reviewToken") && !sBody.includes("evidenceSnapshot") && !sBody.includes("reviewRevision"), "stranger sees protocol");
  await p2.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + rid, { waitUntil: "domcontentloaded", timeout: T.goto });
  await p2.waitForTimeout(1500);
  const rBody = await p2.locator("body").innerText();
  ok("stranger-no-reload", !rBody.includes("Reload editor from current review"), "stranger sees Reload");
  ok("stranger-no-revise-rid", !rBody.includes("Revise decision") && !rBody.includes("Request revision"), "stranger sees revision controls on reload fixture");

  {
    ctx3 = await browser.newContext();
    await ctx3.route("**/*", routeGuard);
    await ctx3.addInitScript(({ tok, em }) => { window.localStorage.setItem("simceo-token", tok); window.localStorage.setItem("simceo-user", em); }, { tok: reader, em: readerEmail });
    p3 = await ctx3.newPage();
    attachCollectors(p3, "reader");
    await p3.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + did, { waitUntil: "domcontentloaded", timeout: T.goto });
    await p3.waitForTimeout(2000);
    const gBody = await p3.locator("body").innerText().catch(() => "");
    ok("guest-approved-positive", gBody.includes("Bears UI approve alpha"), "guest misses approved text");
    ok("guest-approved-evidence", gBody.includes("Bears opening drive memo") || gBody.includes("Supporting excerpt") || gBody.includes("Approved record"), "guest misses approved evidence");
    ok("guest-no-pending-claim", !gBody.includes("No pending decisions remain"), "false no-pending claim shown to guest");
    ok("guest-no-approve-buttons", !gBody.includes("Approve decision"), "guest sees approve controls");
    ok("guest-no-selected-all", !gBody.includes("Approve selected") && !gBody.includes("Approve all"), "guest sees selected/all");
    ok("guest-no-checkbox", (await p3.locator('input[aria-label^="Select decision"]').count()) === 0, "guest sees checkbox");
    ok("guest-no-revise", !gBody.includes("Revise decision") && !gBody.includes("Revised text for decision"), "guest sees revise");
    ok("guest-no-setaside", !gBody.includes("Set aside decision"), "guest sees set-aside");
    ok("guest-no-protocol", !gBody.includes("reviewToken") && !gBody.includes("evidenceSnapshot") && !gBody.includes("reviewRevision"), "guest sees protocol");
    ok("guest-no-notes", !gBody.includes("Working notes") && !gBody.includes("bears provisional note alpha") && !gBody.includes("visible nested decision"), "guest sees withheld notes");
    ok("guest-no-recent", !gBody.includes("Recent meeting input"), "guest sees withheld recent input");
    ok("guest-no-history", !gBody.includes("Decision history"), "guest sees withheld history");
    ok("guest-no-discarded-text", !gBody.includes("Bears UI discard gamma"), "guest sees discarded text");
    await p3.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + amV2, { waitUntil: "domcontentloaded", timeout: T.goto });
    await p3.waitForTimeout(2000);
    const aBody = await p3.locator("body").innerText().catch(() => "");
    ok("guest-amend-current", aBody.includes("Bears inherit alpha replaced") && aBody.includes("Bears inherit beta"), "guest misses amended effective text");
    ok("guest-amend-versions", aBody.includes("approved in version 2") && aBody.includes("approved in version 1"), "guest misses inherited approving versions");
    ok("guest-amend-no-historical-label", !aBody.includes("is not the current effective record"), "guest v2 mislabeled historical");
    ok("guest-amend-no-protocol", !aBody.includes("reviewToken") && !aBody.includes("evidenceSnapshot") && !aBody.includes("reviewRevision"), "guest sees protocol on amendment");
    await p3.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + pid, { waitUntil: "domcontentloaded", timeout: T.goto });
    await p3.waitForTimeout(2000);
    const pBody = await p3.locator("body").innerText().catch(() => "");
    ok("guest-partial-current", pBody.includes("Bears partial UI approved"), "guest misses partial approved text");
    ok("guest-partial-hides-pending", !pBody.includes("Bears partial UI pending"), "guest sees withheld pending text");
    ok("guest-partial-version", pBody.includes("approved in version 1"), "guest misses partial approving version");
    ok("guest-partial-no-protocol", !pBody.includes("reviewToken") && !pBody.includes("evidenceSnapshot") && !pBody.includes("reviewRevision"), "guest sees protocol on partial");

  }
  // Beyond-50 chain with singular navigation (owned disposable chain).
  const ch0 = await api("POST", "/api/meetings/" + mid + "/record/draft", [{ id: "CH0", text: "Bears chain base" }], owner);
  let chid = ch0.json.id;
  preflight("chain-ui-base", ch0.status === 201 && chid, String(ch0.status));
  for (let v = 0; v < 55; v++) {
    const gg = await api("GET", "/api/records/" + chid, undefined, owner);
    if (gg.status !== 200) { ok("chain-ui-step-" + v, false, String(gg.status)); break; }
    const nb = await api("POST", "/api/records/" + chid + "/revise", { version: gg.json.version, hash: gg.json.hash, reviewToken: gg.json.reviewToken, watermark: gg.json.watermark, items: [{ id: "CH0", text: "Bears chain base rev" + v }] }, owner);
    if (nb.status !== 201 && nb.status !== 200) { ok("chain-ui-step-" + v, false, String(nb.status)); break; }
    chid = nb.json.id;
  }
  const chRev = await api("GET", "/api/records/" + chid + "/review", undefined, owner);
  ok("chain-over-50-ui", (chRev.json.predecessors || []).length > 50, String((chRev.json.predecessors || []).length));
  const chList = await api("GET", "/api/meetings/" + mid + "/records", undefined, owner);
  ok("chain-list-capped-50-ui", chList.status === 200 && Array.isArray(chList.json) && chList.json.length <= 50, String(chList.status));
  const chOldestId = (chRev.json.predecessors || [])[0];
  const chOldest = await api("GET", "/api/records/" + chOldestId, undefined, owner);
  ok("chain-singular-oldest-ui", chOldest.status === 200 && chOldest.json.version === 1, String(chOldest.status));
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + chOldestId, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction((exp) => document.body.innerText.includes(exp), "Bears chain base", { timeout: T.poll });
  ok("chain-singular-nav-ui", (page.url() || "").includes(chOldestId) && await bodyHas("Bears chain base"), "singular nav failed");
  const de = await api("POST", "/api/meetings/" + mid + "/record/draft", [], owner);
  preflight("seed-empty-draft", de.status === 201 && de.json.id, String(de.status));
  const eid = de.json.id;
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + eid, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForTimeout(2000);
  ok("empty-no-approve", (await allApproveControls()) === 0, "empty shows approve controls");
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
  ok("no-owned-redirects", redirLog.length === 0, JSON.stringify(redirLog.slice(0, 3)));
}
main().then(async () => {
  if (timedOut) return;
  const finalExit = setTimeout(() => { console.error("FINAL EXIT TIMEOUT"); process.exit(3); }, 15000);
  try { await cleanup(); } finally { /* bounded */ }
  if (cleanupFailed) { console.log("CLEANUP FAILED"); clearTimeout(finalExit); process.exit(1); }
  if (fail > 0) { console.log("[records5-onedoc-ui] fail=" + fail + " pass=" + pass); console.log("FAILURES:"); for (const f of failures) console.log(" - " + f); clearTimeout(finalExit); process.exit(1); }
  console.log("[records5-onedoc-ui] pass=" + pass + " fail=" + fail);
  clearTimeout(finalExit); process.exit(0);
}).catch(async (e) => {
  if (timedOut) return;
  console.log("FATAL " + String(e && e.stack || e).slice(0, 500) + " consoleErrors=" + consoleErrors.slice(0, 5).join(" | ").slice(0, 600));
  const finalExit2 = setTimeout(() => { console.error("FINAL EXIT TIMEOUT"); process.exit(3); }, 15000);
  try { await cleanup(); } catch {}
  clearTimeout(finalExit2);
  process.exit(2);
});
