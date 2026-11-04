"use strict";
// Records Phase 5 one-document review UI proof.
// Real compiled SPA plus real isolated API. Own headless Edge only.
// Loopback only guard below. No shared CDP port. Primary owns lifecycle.
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const API = process.env.QA_API || "http://127.0.0.1:15320";
const WEB = process.env.QA_WEB || "http://127.0.0.1:15321";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:15322";
for (const pair of [[ "QA_API", API, 15320 ], [ "QA_WEB", WEB, 15321 ], [ "QA_FAKE", FAKE, 15322 ]]) {
  const nm = pair[0]; const v = pair[1]; const want = pair[2];
  let u; try { u = new URL(v); } catch { console.error("REFUSE bad " + nm); process.exit(2); }
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") { console.error("REFUSE non loopback " + nm); process.exit(2); }
  if (nm === "QA_WEB" && v === API) { /* WEB same API origin allowed */ }
  else if (Number(u.port) !== want) { console.error("REFUSE " + nm + " must be 127.0.0.1:" + want + " (owned disposable) got " + v); process.exit(2); }
  if (/:5080|:5173|:9333/.test(v)) { console.error("REFUSE reserved port " + nm); process.exit(2); }
}
const PROV = process.env.SIMCEO_INSTANCE || process.env.QA_PROVENANCE || "";
if (!PROV) { console.error("REFUSE missing provenance: primary must launch the owned API with SIMCEO_INSTANCE set"); process.exit(2); }
const OUT = process.env.QA_SHOTS || ".tmp/records-phase5-shots";
const T = { goto: 60000, step: 20000, poll: 20000, overall: 600000 };
fs.mkdirSync(OUT, { recursive: true });
const EDGE_PATHS = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"];
const EDGE = EDGE_PATHS.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!EDGE) { console.error("REFUSE no Edge binary"); process.exit(2); }
let pass = 0, fail = 0;
const failures = [];
const consoleErrors = [];
function ok(name, cond, extra) {
  if (cond) { pass++; } else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
async function api(method, p, body, token) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 30000);
  try {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = "Bearer " + token;
    const r = await fetch(API + p, { method, signal: ctl.signal, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
async function canonState(did, tok) {
  const d = await api("GET", "/api/records/" + did, tok);
  const r = await api("GET", "/api/records/" + did + "/review", tok);
  return JSON.stringify({ items: d.json && d.json.itemsJson, ap: d.json && d.json.approvedJson, dc: d.json && d.json.discardedJson, hist: d.json && d.json.historyJson, v: d.json && d.json.version, h: d.json && d.json.hash, tok: d.json && d.json.reviewToken, wm: d.json && d.json.watermark, pend: r.json && r.json.pending, appr: r.json && r.json.approved, hc: r.json && r.json.historyCount });
}
async function pendingOrdinals(did, tok) {
  const r = await api("GET", "/api/records/" + did + "/review", tok);
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
    const r = await fetch(API + "/api/roster/" + rid + "/image/upload", { method: "POST", signal: ctl.signal, headers: { authorization: "Bearer " + tok }, body: form });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(tm); }
}
let watchdog;
let timedOut = false;
async function boundedClose(p, ms, label) {
  try { await Promise.race([p(), new Promise((_, rej) => setTimeout(() => rej(new Error(label + " timeout")), ms))]); }
  catch (e) { console.log("CLEANUP " + label + ": " + String((e && e.message) || e).slice(0, 200)); }
}
async function cleanup() {
  if (watchdog) clearTimeout(watchdog);
  if (ctx) await boundedClose(() => ctx.close(), 10000, "ctx.close");
  if (browser) await boundedClose(() => browser.close(), 10000, "browser.close");
}
async function main() {
  watchdog = setTimeout(() => {
    console.log("OVERALL WATCHDOG consoleErrors=" + consoleErrors.slice(0, 5).join(" | ").slice(0, 600));
    timedOut = true;
    cleanup().finally(() => process.exit(3));
    setTimeout(() => process.exit(3), 15000);
  }, T.overall);
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => { consoleErrors.push("pageerror: " + String(e).slice(0, 300)); });
  page.on("response", (r) => {
    try { const q = r.request(); if (q.method() === "POST" && /\/api\/records\//.test(q.url())) postLog.push({ url: new URL(q.url()).pathname, status: r.status() }); } catch {}
  });
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
    ok("preflight-health", h.status === 200 && h.json && h.json.ok === true, String(h.status));
    ok("preflight-health-instance", h.json && String(h.json.instance || h.json.Instance) === PROV, "instance=" + String(h.json && (h.json.instance || h.json.Instance)));
    const be = await api("GET", "/api/backend", null, null);
    const mode = String((be.json && (be.json.mode || be.json.Mode)) || "").toLowerCase();
    ok("preflight-backend-memory", mode === "memory", "mode=" + mode);
    const fh = await (async () => {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 30000);
      try {
        const r = await fetch(FAKE + "/__health", { signal: ctl.signal });
        const text = await r.text();
        let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        return { status: r.status, json };
      } finally { clearTimeout(tm); }
    })();
    ok("preflight-fake-scoped", fh.status === 200 && fh.json && fh.json.fake === "records5-scoped", String(fh.status));
  }
  const ownerEmail = run + "-owner@qa.invalid";
  const strangerEmail = run + "-stranger@qa.invalid";
  const readerEmail = run + "-reader@qa.invalid";
  const reg = await api("POST", "/api/auth/register", { email: ownerEmail, password: "qa-password-12345" }, null);
  ok("seed-register", reg.status === 201 && reg.json && reg.json.token, String(reg.status));
  const owner = reg.json.token;
  const regS = await api("POST", "/api/auth/register", { email: strangerEmail, password: "qa-password-12345" }, null);
  ok("seed-stranger", regS.status === 201 && regS.json && regS.json.token, String(regS.status));
  const stranger = regS.json.token;
  const regR = await api("POST", "/api/auth/register", { email: readerEmail, password: "qa-password-12345" }, null);
  ok("seed-reader", regR.status === 201 && regR.json && regR.json.token, String(regR.status));
  const reader = regR.json.token;
  await ctx.addInitScript((tok) => window.localStorage.setItem("simceo-token", tok), owner);
  const board = await api("POST", "/api/boards", { name: run + "-board", mission: run + " mission", stage: "qa" }, owner);
  ok("seed-board", board.status === 201 && board.json.id, String(board.status));
  const bid = board.json.id;
  const gR = await api("POST", "/api/boards/" + bid + "/grants", { userKey: readerEmail, access: "read" }, owner);
  ok("seed-grant-reader", gR.status === 201 || gR.status === 200, String(gR.status));
  const lead = await api("POST", "/api/boards/" + bid + "/lead", { name: "Bears Lead", roleLabel: "Board Lead", background: "Bears lead background", familiarTopics: "Bears familiar topics", simplerTopics: "Bears simpler topics", commPrefs: "Bears direct comms" }, owner);
  ok("seed-lead", lead.status === 200, String(lead.status) + " " + lead.text.slice(0, 160));
  const quick = await api("POST", "/api/roster/quick", { accountId: crypto.randomUUID(), name: run + "-advisor", description: "Advisor helping with " + run + " strategy and review work for grounding" }, owner);
  ok("seed-quick", quick.status === 201 && (quick.json.id || (quick.json.entry && quick.json.entry.id)), String(quick.status));
  const qrid = quick.json.id || (quick.json.entry && quick.json.entry.id);
  const up = await uploadPortrait(qrid, owner);
  ok("seed-portrait-upload", up.status === 201, String(up.status) + " " + up.text.slice(0, 160));
  const imgs = await api("GET", "/api/roster/" + qrid + "/images", owner);
  const imgId = (imgs.json && imgs.json[0] && (imgs.json[0].id || imgs.json[0].Id)) || null;
  ok("seed-portrait-list", !!imgId, JSON.stringify(imgs.json).slice(0, 160));
  const imgRev = await api("POST", "/api/images/" + imgId + "/review", { decision: "accept" }, owner);
  ok("seed-portrait-accept", imgRev.status === 200, String(imgRev.status));
  const cpAdv = await api("POST", "/api/roster/" + qrid + "/copy", { boardId: bid, boardRole: "Strategist" }, owner);
  ok("seed-advisor-copy", cpAdv.status === 201 && cpAdv.json.id, String(cpAdv.status));
  const apAdv = await api("POST", "/api/boards/" + bid + "/advisors/" + cpAdv.json.id + "/approve", {}, owner);
  ok("seed-advisor-approve", apAdv.status === 200, String(apAdv.status) + " " + apAdv.text.slice(0, 160));
  const mtg = await api("POST", "/api/boards/" + bid + "/meetings", { title: run + " meet", brief: run + " brief" }, owner);
  const mid = mtg.json.id;
  const msgSeed = await api("POST", "/api/meetings/" + mid + "/messages", { sender: "lead", content: "Bears opening drive memo" }, owner);
  const mseq = (msgSeed.json && (msgSeed.json.sequence || msgSeed.json.Sequence)) ?? 1;
  await api("POST", "/api/meetings/" + mid + "/notes", { title: "Bears working note", body: "bears provisional note alpha", kind: "note" }, owner);
  const sec = await api("POST", "/api/meetings/" + mid + "/secretary", { input: "Bears context with SECRETARY-NOTE", clientNonce: crypto.randomBytes(8).toString("hex") }, owner);
  ok("seed-secretary-note", sec.status === 200 && sec.json && sec.json.note, String(sec.status));
  const gidA = crypto.randomUUID();
  const gidB = crypto.randomUUID();
  const gidC = crypto.randomUUID();
  const gidHeldNote = crypto.randomUUID();
  const d1 = await api("POST", "/api/meetings/" + mid + "/record/draft", [{ id: gidA, text: "Bears UI approve alpha", refs: [{ kind: "message", ref: mid + ":" + String(mseq) }, { kind: "note", ref: gidHeldNote }] }, { id: gidB, text: "Bears UI pending beta" }, { id: gidC, text: "Bears UI discard gamma" }], owner);
  ok("seed-draft", d1.status === 201 && d1.json.id, String(d1.status));
  const did = d1.json.id;
  await page.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + did, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("Review version"), null, { timeout: T.poll });
  const ord0 = await pendingOrdinals(did, owner);
  const ordA = ord0[gidA]; const ordB = ord0[gidB]; const ordC = ord0[gidC];
  ok("ordinals-mapped", ordA > 0 && ordB > 0 && ordC > 0 && new Set([ordA, ordB, ordC]).size === 3, JSON.stringify(ord0));
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
  await page.getByLabel("Revised text for decision " + ordB).first().fill("Bears UI revised beta", { timeout: T.step });
  await page.getByRole("button", { name: "Revise decision " + ordB }).first().click({ timeout: T.step });
  await page.waitForFunction(() => document.body.innerText.includes("Bears UI revised beta"), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(1200);
  ok("ui-revise-QB", await bodyHas("Bears UI revised beta"), "revised text missing");
  {
    const det = await api("GET", "/api/records/" + did, owner);
    let itemsText = "";
    try { itemsText = JSON.stringify(JSON.parse(det.json.itemsJson).map((e) => e.text)); } catch { itemsText = ""; }
    ok("api-revise-exact-text", det.status === 200 && itemsText.includes("Bears UI revised beta") && itemsText.includes("Bears UI approve alpha"), itemsText.slice(0, 200));
    const hh = await api("GET", "/api/records/" + did, owner);
    let hist = []; try { hist = JSON.parse(hh.json.historyJson); } catch { hist = []; }
    ok("api-revise-history-exact", hist.some((e) => e.action === "revise" && e.itemId === gidB && e.newText === "Bears UI revised beta"), "revise history entry wrong");
  }
  const rev1 = await api("GET", "/api/records/" + did + "/review", owner);
  ok("api-revise-kept-pending", (rev1.json.pending || []).includes(gidB), "revise wrong");
  ok("ui-history-shows-revise", await bodyHas("Decision history") && await bodyHas("Revised"), "history missing");
  await page.getByRole("button", { name: "Set aside decision " + ordC }).first().click({ timeout: T.step });
  await page.waitForTimeout(1500);
  const rev2 = await api("GET", "/api/records/" + did + "/review", owner);
  ok("api-discard-QC", (rev2.json.discarded || []).includes(gidC), "discard wrong");
  await page.getByRole("button", { name: "Approve decision " + ordA }).first().click({ timeout: T.step });
  await page.waitForFunction(() => document.body.innerText.includes("Approved decision " + ordA), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(1200);
  const rev3 = await api("GET", "/api/records/" + did + "/review", owner);
  ok("api-approve-QA", (rev3.json.approved || []).includes(gidA), "approve wrong");
  await page.getByRole("button", { name: /Approve all/ }).first().click({ timeout: T.step });
  await page.waitForTimeout(2000);
  const rev4 = await api("GET", "/api/records/" + did + "/review", owner);
  ok("api-all-decided", (rev4.json.pending || []).length === 0, "not decided");
  ok("api-all-decided-sets", JSON.stringify([...rev4.json.approved].sort()) === JSON.stringify([gidA, gidB].sort()) && (rev4.json.discarded || []).includes(gidC), JSON.stringify({ a: rev4.json.approved, d: rev4.json.discarded }));
  ok("ui-all-decided-no-approve", (await allApproveControls()) === 0 && (await reviseCount()) === 0 && (await setAsideCount()) === 0, "controls present after decide: approve=" + (await approveCount()) + " sel=" + (await approveSelectedCount()) + " all=" + (await approveAllCount()) + " box=" + (await selectBoxCount()));
  {
    const gr = await api("GET", "/api/records/" + did + "/review", reader);
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
  const g0 = await api("GET", "/api/records/" + sid, owner);
  const g0g = { version: g0.json.version, hash: g0.json.hash, reviewToken: g0.json.reviewToken, watermark: g0.json.watermark };
  await api("POST", "/api/records/" + sid + "/items/revise", { ...g0g, itemId: "S1", text: "Bears other-client revision" }, owner);
  const canonHeldBefore = await canonState(sid, owner);
  const ordS = await pendingOrdinals(sid, owner);
  await page.getByRole("button", { name: "Approve decision " + ordS["S2"] }).first().click({ timeout: T.step }).catch(() => null);
  await page.waitForFunction(() => document.body.innerText.includes("No automatic retry"), null, { timeout: T.poll }).catch(() => null);
  await page.waitForTimeout(1200);
  ok("ui-409-guided", await bodyHas("Refresh review") && await bodyHas("No automatic retry"), "guided 409 missing");
  ok("held-no-state-write", (await canonState(sid, owner)) === canonHeldBefore, "held approve mutated canonical state");
  await shot("onedoc-409");
  await api("POST", "/api/meetings/" + mid + "/messages", { sender: "lead", content: "Bears fresh input" }, owner);
  const itemsBeforeRefresh = (await api("GET", "/api/records/" + sid, owner)).json.itemsJson;
  await page.getByRole("button", { name: "Refresh review" }).first().click({ timeout: T.step });
  await page.waitForTimeout(1500);
  ok("ui-refresh-reloads", await bodyHas("Bears other-client revision"), "fresh authority missing");
  {
    const after = await api("GET", "/api/records/" + sid, owner);
    ok("refresh-preserves-items", after.json.itemsJson === itemsBeforeRefresh, "refresh rewrote items");
    ok("refresh-rotates-token-ui", after.json.reviewToken !== g0g.reviewToken, "token unchanged after refresh");
  }
  const ordS2 = await pendingOrdinals(sid, owner);
  await page.getByRole("button", { name: "Approve decision " + ordS2["S2"] }).first().click({ timeout: T.step });
  await page.waitForTimeout(1200);
  const revS = await api("GET", "/api/records/" + sid + "/review", owner);
  ok("ui-deliberate-approve", (revS.json.approved || []).includes("S2"), "deliberate approve wrong");
  const sg = await api("GET", "/api/records/" + sid, owner);
  const canonWholeBefore = await canonState(sid, owner);
  const br = await api("POST", "/api/records/" + sid + "/revise", { version: sg.json.version, hash: sg.json.hash, reviewToken: sg.json.reviewToken, watermark: sg.json.watermark, items: [{ id: "S1", text: "x" }] }, owner);
  ok("whole-revise-after-decisions-409", br.status === 409, String(br.status));
  ok("whole-revise-no-state-write", (await canonState(sid, owner)) === canonWholeBefore, "decided whole-revise mutated state");
  const u1 = await api("POST", "/api/meetings/" + mid + "/record/draft", [{ id: "U1", text: "Bears branch one" }, { id: "U2", text: "Bears branch two" }], owner);
  const buid = u1.json.id;
  ok("branch-fixture-undecided", u1.status === 201 && buid, String(u1.status));
  const sgU = await api("GET", "/api/records/" + buid, owner);
  const br2 = await api("POST", "/api/records/" + buid + "/revise", { version: sgU.json.version, hash: sgU.json.hash, reviewToken: sgU.json.reviewToken, watermark: sgU.json.watermark, items: [{ id: "U1", text: "Bears other-client revision" }, { id: "U2", text: "Bears stale two v2" }] }, owner);
  ok("branch-v2", (br2.status === 201 || br2.status === 200) && br2.json.id, String(br2.status));
  const nid = br2.json.id;
  {
    const bRev = await api("GET", "/api/records/" + buid + "/review", owner);
    const nRev = await api("GET", "/api/records/" + nid + "/review", owner);
    ok("branch-old-successor", (bRev.json.successors || []).includes(nid), JSON.stringify(bRev.json.successors));
    ok("branch-new-predecessor", (nRev.json.predecessors || []).includes(buid), JSON.stringify(nRev.json.predecessors));
    const canonSupBefore = await canonState(buid, owner);
    const sup = await api("POST", "/api/records/" + buid + "/items/approve", { version: bRev.json.draft.version, hash: bRev.json.draft.hash, reviewToken: bRev.json.draft.reviewToken, watermark: bRev.json.draft.watermark, itemId: "U2" }, owner);
    ok("branch-superseded-409", sup.status === 409, String(sup.status));
    ok("branch-superseded-no-write", (await canonState(buid, owner)) === canonSupBefore, "superseded write mutated state");
  }
  await page.reload({ waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForFunction(() => document.body.innerText.includes("Review version"), null, { timeout: T.poll });
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Version 2" }).first().click({ timeout: T.step });
  await page.waitForTimeout(1500);
  ok("ui-v2-shows-predecessor", await bodyHas("Open version 1"), "predecessor missing");
  {
    const det2 = await api("GET", "/api/records/" + nid, owner);
    ok("singular-v2-version", det2.status === 200 && det2.json.version === 2, String(det2.status));
    ok("ui-v2-hash", (page.url() || "").includes(nid), "v2 hash missing " + page.url());
    ok("ui-v2-text", await bodyHas("Bears stale two v2"), "v2 text missing");
  }
  await shot("onedoc-v2");
  await page.getByRole("button", { name: "Open version 1" }).first().click({ timeout: T.step });
  await page.waitForTimeout(1500);
  ok("ui-v1-shows-successor", await bodyHas("Open version 2") || await bodyHas("A newer version exists"), "successor missing");
  ok("ui-v1-historical", await bodyHas("Historical") || await bodyHas("historical"), "historical section missing on superseded v1");
  ok("ui-v1-no-approve", (await allApproveControls()) === 0 && (await reviseCount()) === 0 && (await setAsideCount()) === 0, "superseded controls present");
  {
    const urlV1 = page.url() || "";
    const bodyV1 = await page.locator("body").innerText().catch(() => "");
    await page.goBack({ timeout: T.step }).catch(() => null);
    await page.waitForTimeout(800);
    await page.goForward({ timeout: T.step }).catch(() => null);
    await page.waitForTimeout(800);
    const urlBack = page.url() || "";
    const bodyBack = await page.locator("body").innerText().catch(() => "");
    ok("ui-back-forward-hash", urlBack === urlV1 && urlBack.includes(buid), "hash changed v1=" + urlV1.slice(-12) + " back=" + urlBack.slice(-12));
    ok("ui-back-forward-entity", bodyBack.includes("Bears branch one") && bodyV1.includes("Bears branch one"), "entity text lost across nav");
    ok("ui-back-forward-human", bodyBack.includes("Historical") && !bodyBack.includes("U1"), "history section or id leak across nav");
  }
  const ctx2 = await browser.newContext();
  await ctx2.addInitScript((tok) => window.localStorage.setItem("simceo-token", tok), stranger);
  const p2 = await ctx2.newPage();
  await p2.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + nid, { waitUntil: "domcontentloaded", timeout: T.goto });
  await p2.waitForTimeout(2000);
  const sBody = await p2.locator("body").innerText().catch(() => "");
  ok("stranger-no-approve-buttons", !sBody.includes("Approve decision"), "stranger sees approve");
  await ctx2.close().catch(() => null);
  {
    const ctx3 = await browser.newContext();
    await ctx3.addInitScript((tok) => window.localStorage.setItem("simceo-token", tok), reader);
    const p3 = await ctx3.newPage();
    await p3.goto(WEB + "#/records?board=" + bid + "&meeting=" + mid + "&rec=" + did, { waitUntil: "domcontentloaded", timeout: T.goto });
    await p3.waitForTimeout(2000);
    const gBody = await p3.locator("body").innerText().catch(() => "");
    ok("guest-approved-positive", gBody.includes("Bears UI approve alpha"), "guest misses approved text");
    ok("guest-no-pending-claim", !gBody.includes("No pending decisions remain"), "false no-pending claim shown to guest");
    ok("guest-no-approve-buttons", !gBody.includes("Approve decision"), "guest sees approve controls");
    await ctx3.close().catch(() => null);
  }
  const de = await api("POST", "/api/meetings/" + mid + "/record/draft", [], owner);
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
  console.log("[records5-onedoc-ui] pass=" + pass + " fail=" + fail);
}
main().then(async () => { if (timedOut) return; await cleanup(); if (fail > 0) { console.log("FAILURES:"); for (const f of failures) console.log(" - " + f); process.exit(1); } }).catch(async (e) => { if (timedOut) return; console.log("FATAL " + String(e && e.stack || e).slice(0, 500) + " consoleErrors=" + consoleErrors.slice(0, 5).join(" | ").slice(0, 600)); try { await cleanup(); } catch {} process.exit(2); });
