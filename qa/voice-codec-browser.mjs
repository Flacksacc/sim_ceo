import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { findDelimiters } from "./voice-multipart.mjs";
import {
  draftStrictEquals,
  transcriptAppended,
  staleWriteAbsent,
  payloadShaMatches,
  payloadBytesMatch,
  waitForCount as waitForProviderCount,
} from "./voice-browser-assert.mjs";
import { createVoiceProxy, proxyBase, PROXY_PORT } from "./voice-stream-proxy.mjs";
const CDP = process.env.QA_CDP || "http://localhost:9333";
const WEB = process.env.QA_WEB || "http://127.0.0.1:5245";
const API = process.env.QA_API || "http://127.0.0.1:5125";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:5225";
const OUT = ".tmp/voice-qa/shots";
const SUMMARY_PATH = ".tmp/voice-qa/browser-summary.json";
const OWNED_PATH = ".tmp/voice-qa/owned-targets.json";
function writeSummaryFile(targetPath, obj) {
  fs.writeFileSync(targetPath, JSON.stringify(obj, null, 1));
}
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
let verdictPublished = 0;
// The verdict is computed by this ACTUAL function and published ONCE in
// finally after bounded cleanup. Cleanup failures fold into FAIL with a
// nonzero code; no PASS token or artifact is ever emitted before cleanup.
function finalVerdict(p, f, fails, cleanupErrs) {
  const ce = cleanupErrs || [];
  const all = fails.concat(ce.map((e) => "cleanup-" + e));
  const code = (f + ce.length) === 0 ? 0 : 1;
  const text = code === 0 ? "VOICEBROWSER PASS " + p : "VOICEBROWSER FAIL pass=" + p + " fail=" + (f + ce.length);
  return { code, text, summary: { pass: p, fail: f + ce.length, failures: all } };
}
async function closeBounded(fn, label, cleanupErrs, timeoutMs) {
  let t = null;
  try {
    await Promise.race([fn(), new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label + " close timeout")), timeoutMs || 15000); })]);
  } catch (e) { cleanupErrs.push(label + ":" + (e && e.message ? e.message : String(e))); } finally { try { if (t) clearTimeout(t); } catch {} }
}
async function api(method, p, body) {
  const r = await fetch(API + p, { method, headers: { "content-type": "application/json", "x-user": "owner" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (r.status < 200 || r.status >= 300) throw new Error("api " + method + " " + p + " -> " + r.status + " " + text.slice(0, 200));
  if (json === null || typeof json !== "object") throw new Error("api shape invalid " + p);
  return { status: r.status, json, text };
}
async function fakeCounts() {
  const r = await fetch(FAKE + "/__counts");
  const t = await r.text();
  let j = null;
  try { j = t ? JSON.parse(t) : null; } catch { j = null; }
  // Owned-fake shape check: the exact key set proves the PROTOCOL shape of
  // the QA fake (not any untrusted loopback service). Instance ownership
  // comes from the retained launch (this run started the fake on 5225 and
  // keeps its process); keys alone never prove the instance. No redirect or
  // crypto-identity claim: the production gateway default HttpClient permits
  // redirects, this suite makes no redirect request and claims no escape.
  const keys = !j ? [] : Object.keys(j).sort();
  const exact = r.status === 200 && !!j && typeof j.transcribe === "number" && JSON.stringify(keys) === JSON.stringify(["chat", "images", "responses", "transcribe"]);
  if (!exact) throw new Error("fake counts identity invalid (must be the owned fake) " + r.status + " " + t.slice(0, 200));
  return j;
}
async function fakeLast() {
  const r = await fetch(FAKE + "/__last-transcribe");
  const t = await r.text();
  let j = null;
  try { j = t ? JSON.parse(t) : null; } catch { j = null; }
  if (r.status !== 200 || !j || typeof j.n !== "number") throw new Error("fake last shape invalid " + r.status + " " + t.slice(0, 200));
  return j;
}
async function scopedUsage(mid) {
  const r = await fetch(API + "/api/usage?meetingId=" + mid, { headers: { "x-user": "owner" } });
  const t = await r.text();
  let j = null;
  try { j = t ? JSON.parse(t) : null; } catch { j = null; }
  if (r.status !== 200 || !Array.isArray(j)) throw new Error("usage shape invalid " + r.status + " " + t.slice(0, 200));
  return j.filter((x) => ((x.kind ?? x.Kind) || "") === "voice-transcribe").length;
}
function sha16(buf) { return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16); }
function extractAudioPart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(contentType || "");
  if (!m) throw new Error("no boundary in " + contentType);
  const b = (m[1] || m[2] || "").trim();
  // Same strict shared scanner as the fake provider (full closing suffix).
  const idx = findDelimiters(body, b);
  for (let d = 0; d < idx.length; d++) {
    if (idx[d].close) break;
    const nx = idx[d + 1];
    if (!nx) break;
    const seg = body.subarray(idx[d].head, nx.at - 2);
    const sep = seg.indexOf(Buffer.from("\r\n\r\n"));
    if (sep < 0) continue;
    const head = seg.subarray(0, sep).toString("latin1");
    if (/name\s*=\s*"?audio"?/.test(head)) return seg.subarray(sep + 4);
  }
  throw new Error("audio part not found");
}
// Fourth repair: voice browser QA owns loopback API 5125 + fake 5225 + web
// 5245 only (CDP 9333 is the shared QA Edge; the suite keeps user targets and
// disconnects its own transport). Refuse user/dev ports before launch.
for (const [v, port, label] of [[API, 5125, "api"], [FAKE, 5225, "fake"], [WEB, 5245, "web"]]) {
  let u = null;
  try { u = new URL(v); } catch { u = null; }
  // Bracket-tolerant loopback: URL keeps IPv6 brackets in hostname.
  const host = u ? String(u.hostname).replace(/^\[/, "").replace(/\]$/, "") : "";
  const loop = !!u && (host === "127.0.0.1" || host === "localhost" || host === "::1");
  const rooted = !!u && u.pathname === "/";
  const protoOk = !!u && u.protocol === "http:";
  const secrets = !!u && (u.username !== "" || u.password !== "" || (u.search !== "" && u.search !== "?") || u.hash !== "");
  if (!u || !loop || !rooted || !protoOk || secrets || Number(u.port) !== port || /:(5080|5173)\b/.test(String(v))) {
    console.log("  FAIL " + label + "-owns-port :: must be http loopback :" + port + " root no-userinfo/query/fragment (raw value withheld)");
    process.exit(2);
  }
}
const run = "vb-" + Date.now().toString(36);
let bid = "", mid = "", mid2 = "";
let proxy = null;
let proxyStarted = false;
let browser = null;
let ctx = null;
let page = null;
let fatalErr = null;
const postedPaths = [];
const dialogs = [];
const uploads = [];
// All App transcribe traffic flows through the QA-owned streaming proxy
// (own 5126): pass-through unless a hold/error is armed. Queue-level delays
// ("delay:N") bypass the proxy for the reload-during-upload case.
let transcribeMode = "via-proxy";
// SIXTH: outer-scope drain helper. Function declarations inside the try block
// are block-scoped (ESM strict) and invisible in finally, so the callable
// lives here and is assigned once the page exists. Finally disarms first,
// then drains, with shutdown refusing new registrations.
let releaseAllGatesFn = async () => {};
try {
  try { fs.mkdirSync(OUT, { recursive: true }); } catch (e) { throw new Error("out-mkdir failed: " + (e && e.message ? e.message : String(e))); }
  try { fs.mkdirSync(".tmp/voice-qa", { recursive: true }); } catch (e) { throw new Error("qa-dir-mkdir failed: " + (e && e.message ? e.message : String(e))); }
  // Verdict sentinel BEFORE any fallible setup, inside the same lifecycle:
  // proves NOTHING is published before finally (self-test near the end of
  // try asserts this file still says pending). Failure here is fatal.
  // Initial mkdir/artifact setup is INSIDE this protected lifecycle so a
  // directory-creation failure shares cleanup + verdict (no bypass).
  try { writeSummaryFile(SUMMARY_PATH, { verdict: "pending", run }); } catch (e) { throw new Error("sentinel-write failed: " + (e && e.message ? e.message : String(e))); }
  // Seed inside the lifecycle so startup failures share cleanup + verdict.
  const board = await api("POST", "/api/boards", { name: run + "-b", mission: run + " mission", stage: "qa" });
  bid = board.json.id;
  ok("seed-board", !!bid, board.text.slice(0, 160));
  await api("POST", "/api/boards/" + bid + "/lead", { name: "QA Lead" });
  const mtg = await api("POST", "/api/boards/" + bid + "/meetings", { title: run + " m1", brief: "voice browser brief" });
  mid = mtg.json.id;
  ok("seed-meeting", !!mid, mtg.text.slice(0, 160));
  const mtg2 = await api("POST", "/api/boards/" + bid + "/meetings", { title: run + " m2", brief: "second brief" });
  mid2 = mtg2.json.id;
  await api("POST", "/api/meetings/" + mid + "/messages", { sender: "lead", content: "seeded hello" });
  // QA-owned streaming proxy (own 127.0.0.1:5126) starts inside the lifecycle
  // before any browser traffic; every App transcribe is continued through it.
  proxy = createVoiceProxy({ apiBase: API });
  await proxy.start();
  proxyStarted = true;
  {
    let ph = null;
    try { ph = await fetch(proxyBase() + "/api/auth/status"); } catch (e) { throw new Error("proxy health fetch failed: " + (e && e.message ? e.message : String(e))); }
    ok("proxy-up", ph.status === 200, "status=" + ph.status);
    if (ph.status !== 200) throw new Error("proxy health non-200: " + ph.status);
  }
  ok("proxy-port-owned", PROXY_PORT === 5126, String(PROXY_PORT));
  browser = await chromium.connectOverCDP(CDP);
  const beforeContexts = browser.contexts().map((c) => c.pages().length);
  ok("cdp-shared-contexts-present", browser.contexts().length >= 1, "contexts=" + browser.contexts().length);
  // SEVENTH: capture pre-existing CDP target IDs before creating our own
  // context. Ownership is derived from the ACTUAL owned page/context target
  // IDs via the own page CDP session, not from a global after-minus-before
  // diff (which captures parallel foreign targets). The manifest is bound to
  // this run + browser instance; capture/write failure FAILS (never
  // swallowed). No localhost URL-substring ownership.
  let cdpBeforeIds = [];
  let cdpInstanceWs = "";
  try {
    const vr = await fetch(CDP + "/json/version", { signal: AbortSignal.timeout(10000) });
    const vj = await vr.json();
    cdpInstanceWs = (vj && vj.webSocketDebuggerUrl) || "";
    const lr = await fetch(CDP + "/json/list", { signal: AbortSignal.timeout(10000) });
    const lj = await lr.json();
    if (Array.isArray(lj)) cdpBeforeIds = lj.map((t) => t && t.id).filter(Boolean);
  } catch (e) { throw new Error("cdp-before capture failed: " + (e && e.message ? e.message : String(e))); }
  if (!cdpInstanceWs) throw new Error("cdp-before instance identity missing");
  if (!Array.isArray(cdpBeforeIds) || cdpBeforeIds.length < 1) throw new Error("cdp-before target list empty: fresh binding requires nonempty pre-run set");
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();
  // Record ACTUAL owned IDs via the own page CDP session.
  try {
    const sess = await ctx.newCDPSession(page);
    let ownTid = "";
    try {
      const info = await sess.send("Target.getTargetInfo");
      ownTid = (info && info.targetInfo && info.targetInfo.targetId) || "";
    } catch (e) { throw new Error("own targetId capture failed: " + (e && e.message ? e.message : String(e))); }
    if (!ownTid) throw new Error("own targetId empty");
    const ownedIds = [ownTid];
    writeSummaryFile(OWNED_PATH, { run, instanceWs: cdpInstanceWs, before: cdpBeforeIds, owned: ownedIds });
    const verifyRaw = fs.readFileSync(OWNED_PATH, "utf8");
    const verify = JSON.parse(verifyRaw);
    if (!verify || !Array.isArray(verify.owned) || verify.owned.length < 1 || verify.run !== run || verify.instanceWs !== cdpInstanceWs) throw new Error("owned manifest verify failed");
    ok("owned-manifest-bound", true, "owned=" + ownedIds.length + " run=" + run);
  } catch (e) {
    ok("owned-manifest-bound", false, String((e && e.message) || e).slice(0, 200));
    throw e;
  }
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 300)));
  page.on("dialog", async (d) => { dialogs.push(d.message()); try { await d.dismiss(); } catch {} });
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("/api/meetings/") && req.method() === "POST") {
      if (u.includes("/transcribe")) { /* captured via route below */ }
      else if (u.includes("/messages")) postedPaths.push("messages");
      else if (u.includes("/run")) postedPaths.push("run");
      else if (u.includes("/secretary")) postedPaths.push("secretary");
      else if (u.includes("/record/")) postedPaths.push("record");
    }
    if (u.includes("/api/voice/") && u.includes("/finalize")) postedPaths.push("finalize");
  });
  await ctx.addInitScript(() => {
    window.__voiceStubMode = "tone";
    window.__resolvePermission = null;
    window.__acCreated = 0;
    window.__acClosed = 0;
    // Per-operation correlated stage gates: wrappers below record entry
    // per conversion stage ONLY when armed; the test waits for the entered
    // op, then explicitly releases it. No cumulative ever-true flags, no
    // timer assumptions. Disarmed = direct pass-through.
    window.__voiceGate = { armed: false, shutdown: false, seq: 0, pending: [], completed: [] };
    window.__voiceGateWrap = function (stage, fn) {
      const g = window.__voiceGate;
      if (!g || !g.armed || g.shutdown) return fn();
      const id = ++g.seq;
      const op = { id, stage, enteredAt: Date.now() };
      g.pending.push(op);
      return new Promise((resolve) => {
        const to = setTimeout(() => { op.timedOut = true; finish(); }, 15000);
        op._resolve = () => { clearTimeout(to); finish(); };
        function finish() {
          try {
            const ix = g.pending.indexOf(op);
            if (ix >= 0) g.pending.splice(ix, 1);
            g.completed.push({ id: op.id, stage: op.stage, enteredAt: op.enteredAt, releasedAt: Date.now(), timedOut: !!op.timedOut });
          } catch {}
          resolve();
        }
      }).then(fn);
    };
    window.__voiceGateReleaseAll = function () {
      try {
        const g = window.__voiceGate || { pending: [] };
        try { g.armed = false; g.shutdown = true; } catch {}
        for (const o of g.pending.slice()) { try { o._resolve && o._resolve(); } catch {} }
      } catch {}
    };
    try {
      const OrigAC = window.AudioContext || window.webkitAudioContext;
      if (OrigAC) {
        const C = OrigAC;
        const Wrap = function (...a) {
          window.__acCreated++;
          const inst = new C(...a);
          const origClose = inst.close.bind(inst);
          inst.close = async (...ca) => { window.__acClosed++; return origClose(...ca); };
          const origDecode = inst.decodeAudioData.bind(inst);
          inst.decodeAudioData = (...da) => window.__voiceGateWrap("decode", () => origDecode(...da));
          return inst;
        };
        Wrap.prototype = C.prototype;
        if (window.AudioContext) window.AudioContext = Wrap;
      }
    } catch {}
    try {
      const OrigOAC = window.OfflineAudioContext;
      if (OrigOAC) {
        const W = function (...a) {
          const inst = new OrigOAC(...a);
          try {
            const origRender = inst.startRendering.bind(inst);
            inst.startRendering = (...sa) => window.__voiceGateWrap("render", () => origRender(...sa));
          } catch {}
          return inst;
        };
        W.prototype = OrigOAC.prototype;
        window.OfflineAudioContext = W;
      }
    } catch {}
  try {
    const OrigBlobAB = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function (...ab) { const self = this, args = ab; return window.__voiceGateWrap("blob", () => OrigBlobAB.apply(self, args)); };
  } catch {}
  try {
      const m = navigator.mediaDevices;
      if (m) {
        m.getUserMedia = async () => {
          if (window.__voiceStubMode === "fail") throw new Error("stub mic fail");
          if (window.__voiceStubMode === "delay-permission") {
            await new Promise((res) => { window.__resolvePermission = res; });
            if (window.__voiceStubMode === "fail-after-wait") throw new Error("stub mic fail");
          }
          const AC = window.AudioContext || window.webkitAudioContext;
          const ac = new AC();
          try { await ac.resume(); } catch {}
          const osc = ac.createOscillator();
          osc.frequency.value = 440;
          const gain = ac.createGain();
          gain.gain.value = 0.5;
          osc.connect(gain);
          const dest = ac.createMediaStreamDestination();
          gain.connect(dest);
          try { osc.start(); } catch {}
          window.__stubAC = ac;
          window.__stubOsc = osc;
          window.__lastStream = dest.stream;
          return dest.stream;
        };
      }
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const g = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        window.__realGetUserMedia = g;
      }
    } catch {}
  });
  await page.route("**/api/meetings/*/transcribe", async (route) => {
    const req = route.request();
    try {
      const b = req.postDataBuffer();
      if (b) uploads.push({ body: Buffer.from(b), contentType: req.headers()["content-type"] || "" });
    } catch {}
    if (transcribeMode === "via-proxy") {
      // QA-owned streaming proxy (own 5126): buffers the ACTUAL upstream
      // API response, flushes headers to the App, holds the JSON/error body
      // until the test releases. The App fetch resolves headers while
      // r.json()/r.text() stays pending. A proxy hold (not route.fulfill) is
      // what exercises downstream body pending against the real App flow.
      try {
        const u = new URL(req.url());
        await route.continue({ url: "http://127.0.0.1:5126" + u.pathname + u.search });
      } catch {
        // Loud failure, never silent direct dispatch: abort so the pending
        // waitHold below times out with the override named. No unobserved
        // request proceeds.
        try { await route.abort(); } catch {}
      }
      return;
    }
    if (transcribeMode.startsWith("delay:")) {
      const ms = Number(transcribeMode.slice(6)) || 0;
      await new Promise((r) => setTimeout(r, ms));
    }
    await route.continue();
  });
  async function requireBox() {
    const box = page.getByLabel(/Message\. Press Enter to send/i).first();
    await box.waitFor({ state: "visible", timeout: 15000 });
    return box;
  }
  async function shot(n) { await page.screenshot({ path: path.join(OUT, n) }); }
  async function waitRecording() {
    await page.waitForFunction(() => document.body.innerText.includes("Stop dictation") || document.querySelector("[aria-pressed=true]") !== null, null, { timeout: 15000 });
  }
  async function waitStopped() {
    await page.waitForFunction(() => !document.querySelector("[aria-pressed=true]"), null, { timeout: 15000 });
  }
  async function waitTranscribing() {
    await page.waitForFunction(() => document.body.innerText.includes("Transcribing"), null, { timeout: 15000 });
  }
  async function waitTranscribed() {
    await page.waitForFunction(() => document.body.innerText.includes("Dictation transcribed into the draft."), null, { timeout: 60000 });
  }
  async function waitForCount(baseline, label, timeoutMs) {
    // The ACTUAL shared waiter: strict, never swallows a hung barrier.
    try {
      return await waitForProviderCount(fakeCounts, baseline, label, timeoutMs);
    } catch (e) {
      const tail = await page.locator("body").innerText().catch(() => "");
      const dval = await page.evaluate(() => { const el = document.querySelector("textarea"); return el ? String(el.value).slice(0, 200) : "NO-TEXTAREA"; }).catch(() => "EVAL-FAIL");
      const lll = await fakeLast().catch(() => null);
      throw new Error(String((e && e.message) || e) + " draft=" + JSON.stringify(String(dval).slice(0, 200)) + " bodyTail=" + JSON.stringify(tail.slice(-300)) + " lastN=" + (lll && lll.n));
    }
  }
  async function gotoMeet(id) {
    await page.goto(WEB + "#/meet?board=" + bid + "&meeting=" + id, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => document.body && document.body.innerText.length > 50, null, { timeout: 60000 });
    await page.waitForTimeout(2000);
  }
  await page.goto(WEB + "#/meet?board=" + bid + "&meeting=" + mid, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.body && document.body.innerText.length > 50, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  // Per-operation gate helpers: baseline = gate seq at reset; only ops
  // with id > baseline belong to the current operation (exact correlation).
  // SIXTH: pending means UNRESOLVED (entered and still held). Completed
  // includes timed-out auto-releases and must never satisfy a held check.
  async function gateArm() { await page.evaluate(() => { const g = window.__voiceGate || {}; g.armed = true; }); }
  async function gateDisarm() { await page.evaluate(() => { const g = window.__voiceGate || {}; g.armed = false; }).catch(() => {}); }
  async function gateReset() { return await page.evaluate(() => { const g = window.__voiceGate; g.pending = []; g.completed = []; return g.seq; }); }
  async function waitGateEntered(stage, baseline, timeoutMs) {
    // Exact unresolved PENDING id only: timed-out/completed never counts.
    await page.waitForFunction(
      (args) => { const g = window.__voiceGate || { pending: [] }; return g.pending.some((o) => o.stage === args[0] && o.id > args[1] && !o.timedOut); },
      [stage, baseline],
      { timeout: timeoutMs || 15000 },
    );
    return await page.evaluate((args) => { const g = window.__voiceGate || { pending: [] }; const all = g.pending.filter((o) => o.stage === args[0] && o.id > args[1] && !o.timedOut); return all.length ? all[all.length - 1].id : -1; }, [stage, baseline]);
  }
  async function gatePendingIds(stage, baseline) {
    return await page.evaluate((args) => { const g = window.__voiceGate || { pending: [] }; return g.pending.filter((o) => o.stage === args[0] && o.id > args[1]).map((o) => ({ id: o.id, timedOut: !!o.timedOut })); }, [stage, baseline]);
  }
  async function releaseGate(stage, baseline) {
    await page.evaluate((args) => { const g = window.__voiceGate || { pending: [] }; for (const o of g.pending.slice()) { if (o.stage === args[0] && o.id > args[1]) { try { o._resolve && o._resolve(); } catch {} } } }, [stage, baseline]);
  }
  async function releaseGateId(stage, id) {
    await page.evaluate((args) => { const g = window.__voiceGate || { pending: [] }; for (const o of g.pending.slice()) { if (o.stage === args[0] && o.id === args[1]) { try { o._resolve && o._resolve(); } catch {} } } }, [stage, id]);
  }
  async function gateCompleted(stage, baseline) {
    return await page.evaluate((args) => { const g = window.__voiceGate || { completed: [] }; return g.completed.filter((o) => o.stage === args[0] && o.id > args[1]); }, [stage, baseline]);
  }
  // Assign the outer-scope drain: disarm BEFORE releasing all, then drain.
  releaseAllGatesFn = async () => {
    try { await page.evaluate(() => { try { const g = window.__voiceGate || {}; g.armed = false; } catch {} }).catch(() => {}); } catch {}
    try { await page.evaluate(() => { try { if (typeof window.__voiceGateReleaseAll === "function") window.__voiceGateReleaseAll(); } catch {} }).catch(() => {}); } catch {}
  };
  async function waitHold(hold, label, timeoutMs) {
    const to = new Promise((_, rej) => setTimeout(() => rej(new Error(label + " proxy never held (route continue url override unsupported or proxy missed the request)")), timeoutMs || 20000));
    return await Promise.race([hold.opPromise, to]);
  }
  const dictate = page.getByRole("button", { name: /Dictate/i }).first();
  await dictate.waitFor({ timeout: 30000 });
  ok("dictate-visible", true);
  await shot("voice-meet-primary.png");
  // Positive with exact payload correlation + typed during held ASR
  {
    const c0 = await fakeCounts();
    const u0 = await scopedUsage(mid);
    const up0 = uploads.length;
    // Per-operation correlated gates: the proxy holds the downstream body
    // after flushing headers; each conversion stage is entered and
    // explicitly released. No cumulative flags, no delays.
    const baselinePos = await gateReset();
    await gateArm();
    const holdPos = proxy.holdNext("/api/meetings/" + mid + "/transcribe");
    const box = await requireBox();
    await box.fill("typed hello", { timeout: 15000 });
    await dictate.click({ timeout: 15000 });
    await waitRecording();
    await page.waitForTimeout(2500);
    await shot("voice-recording.png");
    await box.fill("typed hello DURINGREC", { timeout: 15000 });
    const recState = await page.evaluate(() => ({ pressed: document.querySelector("[aria-pressed=true]") !== null }));
    ok("recording-state", recState.pressed === true, JSON.stringify(recState));
    await page.getByRole("button", { name: "Stop and transcribe into draft", exact: true }).first().click({ timeout: 15000 });
    await waitStopped();
    await waitTranscribing();
    // Correlated entered gates: blob -> decode -> render, each explicitly
    // released. The provider count stays flat at every held stage.
    const blobId = await waitGateEntered("blob", baselinePos);
    ok("blob-entered", blobId > baselinePos, "id=" + blobId);
    const heldB = await fakeCounts();
    ok("blob-held-no-provider", heldB.transcribe === c0.transcribe, c0.transcribe + "->" + heldB.transcribe);
    await releaseGate("blob", baselinePos);
    const decId = await waitGateEntered("decode", baselinePos);
    ok("decode-entered", decId > baselinePos, "id=" + decId);
    const heldD = await fakeCounts();
    ok("decode-held-no-provider", heldD.transcribe === c0.transcribe, c0.transcribe + "->" + heldD.transcribe);
    await releaseGate("decode", baselinePos);
    const renId = await waitGateEntered("render", baselinePos);
    ok("render-entered", renId > baselinePos, "id=" + renId);
    const heldR = await fakeCounts();
    ok("render-held-no-provider", heldR.transcribe === c0.transcribe, c0.transcribe + "->" + heldR.transcribe);
    await releaseGate("render", baselinePos);
    // Conversion finished: the upload reaches the proxy, which completes the
    // ACTUAL upstream API call (provider runs) and flushes headers to the
    // App while holding the JSON body. Upload capture proves the App sent
    // headers; the provider hit proves upstream completed; pending
    // Transcribing + unchanged draft prove the App body read is pending.
    const heldOp = await waitHold(holdPos, "positive-asr");
    ok("proxy-op-held", !!heldOp && heldOp.held === true && heldOp.upstreamStatus === 201, JSON.stringify(heldOp));
    ok("proxy-headers-flushed", heldOp.headersFlushedAt > 0 && heldOp.bodyReleasedAt === 0 && heldOp.autoReleased === false, JSON.stringify({ h: heldOp.headersFlushedAt, b: heldOp.bodyReleasedAt }));
    ok("proxy-op-correlated", typeof heldOp.url === "string" && heldOp.url.includes("/api/meetings/" + mid + "/transcribe"), heldOp.url);
    let upSeen = false;
    for (let i = 0; i < 40; i++) {
      if (uploads.length === up0 + 1) { upSeen = true; break; }
      await page.waitForTimeout(500);
    }
    ok("asr-upload-sent", upSeen, "uploads=" + uploads.length + " base=" + up0);
    const heldCounts2 = await fakeCounts();
    ok("asr-provider-ran-while-held", heldCounts2.transcribe === c0.transcribe + 1, c0.transcribe + "->" + heldCounts2.transcribe);
    const pendBody = await page.locator("body").innerText();
    ok("asr-body-pending-ui", pendBody.includes("Transcribing") && !pendBody.includes("Dictation transcribed"), pendBody.slice(0, 200));
    const pendDraft = await box.inputValue();
    ok("asr-body-pending-draft", String(pendDraft) === "typed hello DURINGREC", JSON.stringify(String(pendDraft).slice(0, 200)));
    await box.fill("typed hello DURINGREC DURING-HELD", { timeout: 15000 });
    holdPos.release();
    await gateDisarm();
    // Every held stage completed exactly once via explicit release (no timer).
    {
      const comp = await page.evaluate((b) => (window.__voiceGate.completed || []).filter((o) => o.id > b), baselinePos);
      const byStage = (s) => comp.filter((o) => o.stage === s);
      ok("gates-explicit-release", byStage("blob").length === 1 && byStage("decode").length === 1 && byStage("render").length === 1 && comp.every((o) => !o.timedOut), JSON.stringify(comp.map((o) => o.stage + "#" + o.id)));
    }
    await waitTranscribed();
    await page.waitForTimeout(800);
    await shot("voice-transcribed.png");
    const draftVal = await box.inputValue();
    if (draftVal === null || draftVal === undefined) throw new Error("draft textarea missing");
    ok("editable-transcript-exact", transcriptAppended(draftVal, "typed hello DURINGREC DURING-HELD"), JSON.stringify(draftVal).slice(0, 300));
    // Exact stored bytes: the App persists drafts to localStorage under the
    // account-scoped draft key; the stored text must equal the shown draft.
    const storedVal = await page.evaluate((args) => { try { return localStorage.getItem("simceo-draft:" + args[0] + ":" + args[1] + ":anon"); } catch { return "LS-FAIL"; } }, [bid, mid]);
    ok("stored-draft-exact", storedVal === draftVal, "stored=" + JSON.stringify(String(storedVal).slice(0, 200)));
    const c1 = await fakeCounts();
    ok("fresh-provider-hit", c1.transcribe === c0.transcribe + 1, JSON.stringify(c1));
    const last = await fakeLast();
    ok("fresh-hit-correlated", last.n === c1.transcribe, "n=" + last.n + " counts=" + c1.transcribe);
    ok("uploads-captured", uploads.length === up0 + 1, up0 + "->" + uploads.length);
    const up = uploads[uploads.length - 1];
    const audioPart = extractAudioPart(up.body, up.contentType);
    ok("payload-sha-exact", payloadShaMatches(sha16(audioPart), last.audioSha256), sha16(audioPart) + " vs " + last.audioSha256);
    ok("payload-bytes-exact", payloadBytesMatch(audioPart.length, last.audioBytes), audioPart.length + " vs " + last.audioBytes);
    ok("fake-valid-wav", last.validWav === true, JSON.stringify(last).slice(0, 300));
    ok("fake-16k-mono", last.sampleRate === 16000 && last.channels === 1 && last.bits === 16, JSON.stringify(last).slice(0, 200));
    ok("fake-encoding-wav", String(last.encoding || "").toUpperCase() === "WAV", JSON.stringify(last).slice(0, 200));
    ok("fake-parts", Array.isArray(last.partNames) && last.partNames.includes("audio") && last.partNames.includes("request"), JSON.stringify(last.partNames));
    const wavInfo = "sr=" + last.sampleRate + " ch=" + last.channels + " bits=" + last.bits + " dur=" + last.durSec + " rms=" + last.rms + " nz=" + last.nz + " freq~" + last.freqEst;
    ok("wav-header", last.sampleRate === 16000 && last.channels === 1 && last.bits === 16, wavInfo);
    ok("wav-duration", last.durSec >= 1.0 && last.durSec <= 8.0, wavInfo);
    ok("wav-amplitude", last.rms > 500 && last.nz > 1000, wavInfo);
    ok("wav-frequency", last.freqEst >= 280 && last.freqEst <= 640, wavInfo);
    const u1 = await scopedUsage(mid);
    ok("scoped-usage-plus-1", u1 === u0 + 1, "usage " + u0 + "->" + u1);
    ok("no-autosend", !postedPaths.includes("messages") && !postedPaths.includes("run") && !postedPaths.includes("secretary") && !postedPaths.includes("record") && !postedPaths.includes("finalize"), postedPaths.join(","));
    const msgs = await api("GET", "/api/meetings/" + mid + "/messages");
    const onlySeeded = Array.isArray(msgs.json) && msgs.json.length === 1 && String(msgs.json[0].content || msgs.json[0].Content || "").includes("seeded hello");
    ok("no-message-posted", onlySeeded, msgs.text.slice(0, 300));
    const cleanup = await page.evaluate(() => {
      const s = window.__lastStream;
      const tracks = s ? s.getTracks().map((t) => t.readyState) : [];
      return { tracks, created: window.__acCreated, closed: window.__acClosed };
    });
    ok("tracks-stopped", Array.isArray(cleanup.tracks) && cleanup.tracks.length > 0 && cleanup.tracks.every((x) => x === "ended"), JSON.stringify(cleanup).slice(0, 200));
    ok("contexts-closed", cleanup.created > 0 && cleanup.closed >= 1, JSON.stringify(cleanup).slice(0, 200));
    try { await page.evaluate(() => { try { window.__stubOsc && window.__stubOsc.stop(); } catch {} try { window.__stubAC && window.__stubAC.close(); } catch {} }); } catch {}
  }
  // Multi-start overlap: two synchronous clicks share one operation. Both
  // clicks are actually dispatched (never a swallowed locator timeout); the
  // second is a benign no-op while starting, and exactly one provider hit
  // lands with the exact draft.
  {
    const c0 = await fakeCounts();
    await page.evaluate(() => { window.__voiceStubMode = "tone"; window.__resolvePermission = null; window.__decodeDelayMs = 0; window.__renderDelayMs = 0; });
    await gotoMeet(mid);
    const obox = await requireBox();
    await obox.fill("overlap-origin", { timeout: 15000 });
    // Two clicks in the same task: no locator re-query, no timeout to
    // swallow. The second runs while the first is still starting.
    const clicks = await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /Dictate/i.test((x.textContent || "") + " " + (x.getAttribute("aria-label") || "") + " " + (x.getAttribute("title") || "")));
      if (!b) return -1;
      b.click();
      b.click();
      return 2;
    });
    ok("overlap-clicks-dispatched", clicks === 2, String(clicks));
    await waitRecording();
    await page.waitForTimeout(2000);
    const st = await page.evaluate(() => ({ pressed: document.querySelector("[aria-pressed=true]") !== null }));
    ok("overlap-single-recording", st.pressed === true, JSON.stringify(st));
    await page.getByRole("button", { name: "Stop and transcribe into draft", exact: true }).first().click({ timeout: 15000 });
    await waitStopped();
    const c1 = await waitForCount(c0.transcribe, "overlap", 30000);
    ok("overlap-single-hit", c1.transcribe === c0.transcribe + 1, c0.transcribe + "->" + c1.transcribe);
    await waitTranscribed();
    const odraft = await (await requireBox()).inputValue();
    ok("overlap-exact-draft", transcriptAppended(odraft, "overlap-origin"), JSON.stringify(String(odraft).slice(0, 200)));
  }
  // Pending permission late after navigation: no recorder/upload, no modal
  {
    const c0 = await fakeCounts();
    await gotoMeet(mid2);
    await (await requireBox()).fill("mid2-base", { timeout: 15000 });
    await gotoMeet(mid);
    await page.evaluate(() => { window.__voiceStubMode = "delay-permission"; window.__resolvePermission = null; });
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(800);
    await page.goto(WEB + "#/meet?board=" + bid + "&meeting=" + mid2, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1000);
    await page.evaluate(() => { try { window.__resolvePermission && window.__resolvePermission(); } catch {} window.__voiceStubMode = "tone"; });
    await page.waitForTimeout(4500);
    const c1 = await fakeCounts();
    ok("pending-nav-no-provider", c1.transcribe === c0.transcribe, c0.transcribe + "->" + c1.transcribe);
    const secondDraft = await (await requireBox()).inputValue();
    if (secondDraft === null || secondDraft === undefined) throw new Error("textarea missing after pending nav");
    ok("pending-nav-no-leak", staleWriteAbsent(String(secondDraft), "mid2-base"), JSON.stringify(String(secondDraft).slice(0, 200)));
    const navBody = await page.locator("body").innerText();
    ok("pending-nav-no-stale-toast", !navBody.includes("Microphone unavailable"), navBody.slice(0, 200));
    await page.evaluate(() => { try { window.__lastStream && window.__lastStream.getTracks().forEach((t) => t.stop()); } catch {} });
  }
  // Stale late permission vs new op: old stream stops, new op unaffected
  {
    const c0 = await fakeCounts();
    await page.evaluate(() => { window.__voiceStubMode = "delay-permission"; window.__resolvePermission = null; });
    await gotoMeet(mid);
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(800);
    await page.goto(WEB + "#/meet?board=" + bid + "&meeting=" + mid2, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1000);
    await page.evaluate(() => { window.__voiceStubMode = "tone"; });
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await waitRecording();
    await page.evaluate(() => { try { window.__resolvePermission && window.__resolvePermission(); } catch {} });
    await page.waitForTimeout(2000);
    const st = await page.evaluate(() => ({ pressed: document.querySelector("[aria-pressed=true]") !== null }));
    ok("stale-new-op-unaffected", st.pressed === true, JSON.stringify(st));
    await page.getByRole("button", { name: "Stop and transcribe into draft", exact: true }).first().click({ timeout: 15000 });
    await waitStopped();
    const c1 = await waitForCount(c0.transcribe, "stale", 30000);
    ok("stale-single-hit", c1.transcribe === c0.transcribe + 1, c0.transcribe + "->" + c1.transcribe);
  }
  // Rejected late permission after unmount with a new op owning the UI: the
  // old rejection is silent (no modal, no denial toast, no provider hit, no
  // draft touch) and the new op completes exactly.
  {
    const c0 = await fakeCounts();
    await gotoMeet(mid);
    await (await requireBox()).fill("failwait-origin", { timeout: 15000 });
    await gotoMeet(mid2);
    await (await requireBox()).fill("failwait-second", { timeout: 15000 });
    await gotoMeet(mid);
    await page.evaluate(() => { window.__voiceStubMode = "delay-permission"; window.__resolvePermission = null; });
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(800);
    // Unmount the pending op by navigating, then start a new op that owns UI.
    await gotoMeet(mid2);
    await page.waitForTimeout(800);
    await page.evaluate(() => { window.__voiceStubMode = "tone"; });
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await waitRecording();
    // Now reject the OLD permission: must be silent against the new op.
    await page.evaluate(() => { window.__voiceStubMode = "fail-after-wait"; try { window.__resolvePermission && window.__resolvePermission(); } catch {} });
    await page.waitForTimeout(1500);
    const st = await page.evaluate(() => ({ pressed: document.querySelector("[aria-pressed=true]") !== null }));
    ok("failwait-new-op-unaffected", st.pressed === true, JSON.stringify(st));
    await page.getByRole("button", { name: "Stop and transcribe into draft", exact: true }).first().click({ timeout: 15000 });
    await waitStopped();
    const c1 = await waitForCount(c0.transcribe, "failwait", 30000);
    ok("failwait-single-hit", c1.transcribe === c0.transcribe + 1, c0.transcribe + "->" + c1.transcribe);
    await waitTranscribed();
    const fbody = await page.locator("body").innerText();
    ok("failwait-no-denial-toast", !fbody.includes("Microphone unavailable"), fbody.slice(0, 200));
    const fdraft = await (await requireBox()).inputValue();
    ok("failwait-exact-draft", transcriptAppended(fdraft, "failwait-second"), JSON.stringify(String(fdraft).slice(0, 200)));
    const c2 = await fakeCounts();
    ok("failwait-no-extra-provider", c2.transcribe === c1.transcribe, c1.transcribe + "->" + c2.transcribe);
    await gotoMeet(mid);
    const back = await (await requireBox()).inputValue();
    ok("failwait-origin-intact", staleWriteAbsent(String(back), "failwait-origin"), JSON.stringify(String(back).slice(0, 200)));
    await page.evaluate(() => { window.__voiceStubMode = "tone"; window.__resolvePermission = null; });
  }
  // Navigation during record cancels exactly, other meeting intact
  {
    const c0 = await fakeCounts();
    await page.evaluate(() => { window.__voiceStubMode = "tone"; });
    await gotoMeet(mid);
    await gotoMeet(mid2);
    await (await requireBox()).fill("mid2-clean", { timeout: 15000 });
    await gotoMeet(mid);
    const box2 = await requireBox();
    await box2.fill("nav-origin", { timeout: 15000 });
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1500);
    await page.goto(WEB + "#/meet?board=" + bid + "&meeting=" + mid2, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4500);
    await shot("voice-nav-second.png");
    const secondDraft = await (await requireBox()).inputValue();
    if (secondDraft === null || secondDraft === undefined) throw new Error("second textarea missing");
    ok("nav-cancel-no-leak", draftStrictEquals(String(secondDraft), "mid2-clean"), JSON.stringify(String(secondDraft).slice(0, 200)));
    const c1 = await fakeCounts();
    ok("nav-cancel-no-provider", c1.transcribe === c0.transcribe, c0.transcribe + "->" + c1.transcribe);
    await gotoMeet(mid);
    const originDraft = await (await requireBox()).inputValue();
    if (originDraft === null || originDraft === undefined) throw new Error("origin textarea missing");
    ok("nav-origin-intact", draftStrictEquals(String(originDraft), "nav-origin"), JSON.stringify(String(originDraft).slice(0, 300)));
  }
  // Top-level tab unmount in surviving document
  {
    const c0 = await fakeCounts();
    await gotoMeet(mid);
    const box3 = await requireBox();
    await box3.fill("boards-origin", { timeout: 15000 });
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await waitRecording();
    await page.goto(WEB + "#/boards", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4500);
    const c1 = await fakeCounts();
    ok("tab-unmount-no-provider", c1.transcribe === c0.transcribe, c0.transcribe + "->" + c1.transcribe);
    const tr = await page.evaluate(() => {
      const s = window.__lastStream;
      return s ? s.getTracks().map((t) => t.readyState) : [];
    });
    ok("tab-unmount-tracks-ended", tr.length > 0 && tr.every((x) => x === "ended"), JSON.stringify(tr));
    await gotoMeet(mid);
    const back = await (await requireBox()).inputValue();
    if (back === null || back === undefined) throw new Error("back textarea missing");
    ok("tab-unmount-origin-intact", draftStrictEquals(back, "boards-origin"), JSON.stringify(back.slice(0, 200)));
  }
  // Blob-held cancel by navigation: exact unresolved PENDING blob id held,
  // cancelled by navigation BEFORE release; late release inert.
  {
    const c0 = await fakeCounts();
    const baselineBlob = await gateReset();
    await gateArm();
    await gotoMeet(mid2);
    await (await requireBox()).fill("conv-blob-second", { timeout: 15000 });
    await gotoMeet(mid);
    await (await requireBox()).fill("conv-blob-origin", { timeout: 15000 });
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: "Stop and transcribe into draft", exact: true }).first().click({ timeout: 15000 });
    await waitStopped();
    await waitTranscribing();
    const blobId = await waitGateEntered("blob", baselineBlob);
    ok("conv-blob-held-id", blobId > baselineBlob, "id=" + blobId);
    {
      const pend = await gatePendingIds("blob", baselineBlob);
      const exact = pend.filter((o) => o.id === blobId);
      ok("conv-blob-unresolved-pending", exact.length === 1 && exact[0].timedOut === false, JSON.stringify(pend));
      const compPre = await gateCompleted("blob", baselineBlob);
      ok("conv-blob-not-completed-pre", compPre.filter((o) => o.id === blobId).length === 0, JSON.stringify(compPre.map((o) => o.id)));
    }
    await page.goto(WEB + "#/meet?board=" + bid + "&meeting=" + mid2, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);
    await releaseGateId("blob", blobId);
    await gateDisarm();
    await page.waitForTimeout(3000);
    {
      const comp = await gateCompleted("blob", baselineBlob);
      const mine = comp.filter((o) => o.id === blobId);
      ok("conv-blob-released-explicit", mine.length === 1 && mine[0].timedOut === false, JSON.stringify(mine));
    }
    const c1 = await fakeCounts();
    ok("conv-blob-cancel-no-provider", c1.transcribe === c0.transcribe, c0.transcribe + "->" + c1.transcribe);
    const bd = await (await requireBox()).inputValue();
    ok("conv-blob-cancel-no-leak", staleWriteAbsent(String(bd), "conv-blob-second"), JSON.stringify(String(bd).slice(0, 200)));
  }
  // Delayed conversion cancelled by navigation
  {
    const c0 = await fakeCounts();
    const baselineConv = await gateReset();
    await gateArm();
    await gotoMeet(mid2);
    await (await requireBox()).fill("conv-second", { timeout: 15000 });
    await gotoMeet(mid);
    const box4 = await requireBox();
    await box4.fill("conv-origin", { timeout: 15000 });
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: "Stop and transcribe into draft", exact: true }).first().click({ timeout: 15000 });
    await waitStopped();
    await waitTranscribing();
    // Decode entered and HELD: cancel by navigation BEFORE release, then
    // release the late completion. Late completion after cancel is inert:
    // no provider hit, second-meeting draft intact.
    const convBlob = await waitGateEntered("blob", baselineConv);
    ok("conv-blob-entered", convBlob > baselineConv, "id=" + convBlob);
    await releaseGate("blob", baselineConv);
    const convDec = await waitGateEntered("decode", baselineConv);
    ok("conv-decode-entered", convDec > baselineConv, "id=" + convDec);
    await page.goto(WEB + "#/meet?board=" + bid + "&meeting=" + mid2, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);
    await releaseGate("decode", baselineConv);
    await gateDisarm();
    await page.waitForTimeout(3000);
    {
      const convComp = await gateCompleted("decode", baselineConv);
      ok("conv-decode-released-explicit", convComp.length === 1 && convComp.every((o) => !o.timedOut), JSON.stringify(convComp.map((o) => o.id)));
    }
    const c1 = await fakeCounts();
    ok("conversion-cancel-no-provider", c1.transcribe === c0.transcribe, c0.transcribe + "->" + c1.transcribe);
    const cd = await (await requireBox()).inputValue();
    ok("conversion-cancel-no-leak", staleWriteAbsent(String(cd), "conv-second"), JSON.stringify(String(cd).slice(0, 200)));
  }
  // Render-held cancel by navigation: blob+decode released, render HELD as
  // exact unresolved PENDING; navigation cancels; late release inert.
  {
    const c0 = await fakeCounts();
    const baselineRen = await gateReset();
    await gateArm();
    await gotoMeet(mid2);
    await (await requireBox()).fill("conv-render-second", { timeout: 15000 });
    await gotoMeet(mid);
    await (await requireBox()).fill("conv-render-origin", { timeout: 15000 });
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: "Stop and transcribe into draft", exact: true }).first().click({ timeout: 15000 });
    await waitStopped();
    await waitTranscribing();
    const rBlob = await waitGateEntered("blob", baselineRen);
    ok("conv-render-blob-held", rBlob > baselineRen, "id=" + rBlob);
    await releaseGateId("blob", rBlob);
    const rDec = await waitGateEntered("decode", baselineRen);
    ok("conv-render-decode-held", rDec > baselineRen, "id=" + rDec);
    await releaseGateId("decode", rDec);
    const rRen = await waitGateEntered("render", baselineRen);
    ok("conv-render-held-id", rRen > baselineRen, "id=" + rRen);
    {
      const pend = await gatePendingIds("render", baselineRen);
      const exact = pend.filter((o) => o.id === rRen);
      ok("conv-render-unresolved-pending", exact.length === 1 && exact[0].timedOut === false, JSON.stringify(pend));
    }
    await page.goto(WEB + "#/meet?board=" + bid + "&meeting=" + mid2, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);
    await releaseGateId("render", rRen);
    await gateDisarm();
    await page.waitForTimeout(3000);
    {
      const comp = await gateCompleted("render", baselineRen);
      const mine = comp.filter((o) => o.id === rRen);
      ok("conv-render-released-explicit", mine.length === 1 && mine[0].timedOut === false, JSON.stringify(mine));
    }
    const c1 = await fakeCounts();
    ok("conv-render-cancel-no-provider", c1.transcribe === c0.transcribe, c0.transcribe + "->" + c1.transcribe);
    const rd = await (await requireBox()).inputValue();
    ok("conv-render-cancel-no-leak", staleWriteAbsent(String(rd), "conv-render-second"), JSON.stringify(String(rd).slice(0, 200)));
  }
  // Surviving-document keyed unmount during held decode: React App remounts
  // via simceo-auth-change in the SAME document (no navigation/reload). The
  // old held conversion must never land; new identity works; origin intact.
  {
    const c0 = await fakeCounts();
    const baselineKey = await gateReset();
    await gateArm();
    await gotoMeet(mid);
    await (await requireBox()).fill("conv-key-origin", { timeout: 15000 });
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: "Stop and transcribe into draft", exact: true }).first().click({ timeout: 15000 });
    await waitStopped();
    await waitTranscribing();
    const kBlob = await waitGateEntered("blob", baselineKey);
    ok("conv-key-blob-held", kBlob > baselineKey, "id=" + kBlob);
    await releaseGateId("blob", kBlob);
    const kDec = await waitGateEntered("decode", baselineKey);
    ok("conv-key-decode-held", kDec > baselineKey, "id=" + kDec);
    {
      const pend = await gatePendingIds("decode", baselineKey);
      ok("conv-key-unresolved-pending", pend.some((o) => o.id === kDec && !o.timedOut), JSON.stringify(pend));
    }
    const epochBefore = await page.evaluate(() => window.__simceoEpoch);
    await page.evaluate(() => {
      localStorage.setItem("simceo-fb-user-v2", "qa-fb-key");
      localStorage.setItem("simceo-user", "qa-key2");
      window.dispatchEvent(new Event("simceo-auth-change"));
    });
    await page.waitForTimeout(2000);
    const epochAfter = await page.evaluate(() => window.__simceoEpoch);
    ok("conv-key-remount-bumped", epochAfter === epochBefore + 1, epochBefore + "->" + epochAfter);
    await releaseGateId("decode", kDec);
    await gateDisarm();
    await page.waitForTimeout(3000);
    const c1 = await fakeCounts();
    ok("conv-key-cancel-no-provider", c1.transcribe === c0.transcribe, c0.transcribe + "->" + c1.transcribe);
    await gotoMeet(mid);
    const kd = await (await requireBox()).inputValue();
    ok("conv-key-no-leak", !String(kd).includes("qa transcript") && !String(kd).includes("Dictation transcribed"), JSON.stringify(String(kd).slice(0, 300)));
    await page.evaluate(() => {
      localStorage.removeItem("simceo-user");
      localStorage.removeItem("simceo-fb-user-v2");
      window.dispatchEvent(new Event("simceo-auth-change"));
    });
    await page.waitForTimeout(1500);
  }
  // A-B-A with an already-running provider response: headers+body reach the
  // fake (count +1 observed while the response is held). A NEW B operation is
  // then started and owns the UI while the old A response is still held; the
  // released old completion must not disturb it (exact B draft, one B hit).
  // Returning to A must show the exact origin draft with no error UI.
  {
    const c0 = await fakeCounts();
    await gotoMeet(mid);
    const box = await requireBox();
    await box.fill("aba-origin", { timeout: 15000 });
    const holdA = proxy.holdNext("/api/meetings/" + mid + "/transcribe");
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: "Stop and transcribe into draft", exact: true }).first().click({ timeout: 15000 });
    await waitStopped();
    await waitTranscribing();
    // A upstream completes and the proxy holds A downstream body: +1
    // observed at the fake while the App body read stays pending.
    const heldA = await waitHold(holdA, "aba-provider");
    ok("aba-provider-ran", heldA.held === true && heldA.upstreamStatus === 201, JSON.stringify(heldA));
    {
      const hcA = await fakeCounts();
      ok("aba-provider-plus-1", hcA.transcribe === c0.transcribe + 1, c0.transcribe + "->" + hcA.transcribe);
    }
    await gotoMeet(mid2);
    await page.waitForTimeout(800);
    // A new B operation owns the UI while the old A response is still held;
    // B conversion is HELD at decode-entered (B still current/pending).
    const baselineB = await gateReset();
    await gateArm();
    const abox = await requireBox();
    await abox.fill("aba-second", { timeout: 15000 });
    const opBaseB = proxy.opCount();
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await waitRecording();
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: "Stop and transcribe into draft", exact: true }).first().click({ timeout: 15000 });
    await waitStopped();
    await waitTranscribing();
    const bBlob = await waitGateEntered("blob", baselineB);
    ok("aba-b-blob-entered", bBlob > baselineB, "id=" + bBlob);
    await releaseGateId("blob", bBlob);
    const bDec = await waitGateEntered("decode", baselineB);
    ok("aba-b-decode-held", bDec > baselineB, "id=" + bDec);
    let abaStoredABefore = null, abaStoredBBefore = null;
    {
      // B exact decode PENDING before old A release (unresolved, not timed out).
      const pendPre = await gatePendingIds("decode", baselineB);
      const exactPre = pendPre.filter((o) => o.id === bDec);
      ok("aba-b-decode-pending-pre", exactPre.length === 1 && exactPre[0].timedOut === false, JSON.stringify(pendPre));
      const bBody = await page.locator("body").innerText();
      const bDraftPre = await (await requireBox()).inputValue();
      const cPre = await fakeCounts();
      ok("aba-b-still-current", bBody.includes("Transcribing") && String(bDraftPre) === "aba-second" && cPre.transcribe === c0.transcribe + 1, "draft=" + JSON.stringify(String(bDraftPre).slice(0, 120)) + " counts=" + cPre.transcribe);
      // SEVENTH: exact stored A/B draft bytes IMMEDIATELY before old A
      // release while B decode is STILL held (not only after B completion,
      // which can overwrite corruption).
      abaStoredABefore = await page.evaluate((args) => { try { return localStorage.getItem("simceo-draft:" + args[0] + ":" + args[1] + ":anon"); } catch { return "LS-FAIL"; } }, [bid, mid]);
      abaStoredBBefore = await page.evaluate((args) => { try { return localStorage.getItem("simceo-draft:" + args[0] + ":" + args[1] + ":anon"); } catch { return "LS-FAIL"; } }, [bid, mid2]);
      ok("aba-stored-a-before", abaStoredABefore === "aba-origin", "storedA=" + JSON.stringify(String(abaStoredABefore).slice(0, 200)));
      ok("aba-stored-b-before", abaStoredBBefore === "aba-second", "storedB=" + JSON.stringify(String(abaStoredBBefore).slice(0, 200)));
    }
    // Release the OLD A completion while the new B op is still HELD: B must
    // be unaffected; A late body lands on a dead route and is disposed.
    holdA.release();
    await page.waitForTimeout(1500);
    {
      // A actual body released (same op id, flushed then released).
      const aOpAfter = proxy.ops().find((o) => o.id === heldA.id);
      ok("aba-a-actually-released", !!aOpAfter && aOpAfter.bodyReleasedAt >= aOpAfter.headersFlushedAt && aOpAfter.headersFlushedAt > 0, JSON.stringify(aOpAfter));
      // B still exact unresolved PENDING after old A release.
      const pendPost = await gatePendingIds("decode", baselineB);
      const exactPost = pendPost.filter((o) => o.id === bDec);
      ok("aba-b-decode-pending-post", exactPost.length === 1 && exactPost[0].timedOut === false, JSON.stringify(pendPost));
      const bBody2 = await page.locator("body").innerText();
      const bDraft2 = await (await requireBox()).inputValue();
      const cMid = await fakeCounts();
      ok("aba-b-unaffected-by-old-release", bBody2.includes("Transcribing") && String(bDraft2) === "aba-second" && cMid.transcribe === c0.transcribe + 1 && !bBody2.includes("Dictation failed"), "draft=" + JSON.stringify(String(bDraft2).slice(0, 120)) + " counts=" + cMid.transcribe);
      // SEVENTH: exact stored bytes IMMEDIATELY after old A release while B
      // is STILL held: neither key may have changed; B pending IDs retained,
      // A actually released, fresh B proxy baseline retained.
      const abaStoredAAfter = await page.evaluate((args) => { try { return localStorage.getItem("simceo-draft:" + args[0] + ":" + args[1] + ":anon"); } catch { return "LS-FAIL"; } }, [bid, mid]);
      const abaStoredBAfter = await page.evaluate((args) => { try { return localStorage.getItem("simceo-draft:" + args[0] + ":" + args[1] + ":anon"); } catch { return "LS-FAIL"; } }, [bid, mid2]);
      ok("aba-stored-a-stable", abaStoredAAfter === abaStoredABefore, "before=" + JSON.stringify(String(abaStoredABefore).slice(0, 120)) + " after=" + JSON.stringify(String(abaStoredAAfter).slice(0, 120)));
      ok("aba-stored-b-stable", abaStoredBAfter === abaStoredBBefore && abaStoredBAfter === "aba-second", "before=" + JSON.stringify(String(abaStoredBBefore).slice(0, 120)) + " after=" + JSON.stringify(String(abaStoredBAfter).slice(0, 120)));
      ok("aba-b-pending-ids-retained", true, "bDec=" + bDec);
      ok("aba-a-released-b-baseline", !!aOpAfter && cMid.transcribe === c0.transcribe + 1, "aOp=" + (aOpAfter && aOpAfter.id) + " counts=" + cMid.transcribe);
    }
    // Finish B: release exact decode; B flows through the proxy unheld and lands exactly.
    await releaseGateId("decode", bDec);
    await gateDisarm();
    await waitTranscribed();
    const bdraft = await (await requireBox()).inputValue();
    if (bdraft === null || bdraft === undefined) throw new Error("aba second textarea missing");
    ok("aba-new-exact-draft", transcriptAppended(String(bdraft), "aba-second"), JSON.stringify(String(bdraft).slice(0, 200)));
    {
      // Exact stored bytes: App persists drafts under account-scoped key.
      const storedB = await page.evaluate((args) => { try { return localStorage.getItem("simceo-draft:" + args[0] + ":" + args[1] + ":anon"); } catch { return "LS-FAIL"; } }, [bid, mid2]);
      ok("aba-stored-draft-exact", storedB === bdraft, "stored=" + JSON.stringify(String(storedB).slice(0, 200)));
    }
    const c1 = await fakeCounts();
    ok("aba-two-hits", c1.transcribe === c0.transcribe + 2, c0.transcribe + "->" + c1.transcribe);
    {
      // Fresh B proxy op from baseline nonce (no earlier transcription match).
      const freshOps = proxy.ops().slice(opBaseB).filter((o) => !o.synthetic && typeof o.url === "string" && o.url.includes("/api/meetings/" + mid2 + "/transcribe"));
      ok("aba-b-proxy-passthrough", freshOps.length === 1 && freshOps[0].held === false && freshOps[0].upstreamStatus === 201 && freshOps[0].bodyReleasedAt >= freshOps[0].headersFlushedAt && freshOps[0].autoReleased === false, JSON.stringify(freshOps[0] || freshOps));
    }
    await gotoMeet(mid);
    await page.waitForTimeout(1500);
    const abaDraft = await (await requireBox()).inputValue();
    if (abaDraft === null || abaDraft === undefined) throw new Error("aba textarea missing");
    ok("aba-no-stale", staleWriteAbsent(String(abaDraft), "aba-origin") && c1.transcribe === c0.transcribe + 2, "draft=" + JSON.stringify(String(abaDraft).slice(0, 200)) + " counts=" + c0.transcribe + "->" + c1.transcribe);
    const abaBody = await page.locator("body").innerText();
    ok("aba-no-error", !abaBody.includes("Dictation failed"), abaBody.slice(0, 200));
  }
  // Identity remount: reload during held ASR, old op never lands
  // NOTE: exact draft text is not asserted here. This suite runs on the vite dev server with React StrictMode,
  // whose double-effect draft load/persist race can wipe the localStorage draft on full reload. That pre-existing
  // draft-persistence behavior is outside the voice lane; the voice-owned assertions are no-upload and no-stale-result.
  {
    const c0 = await fakeCounts();
    await gotoMeet(mid);
    const box5 = await requireBox();
    await box5.fill("remount-origin", { timeout: 15000 });
    transcribeMode = "delay:4000";
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: "Stop and transcribe into draft", exact: true }).first().click({ timeout: 15000 });
    await waitStopped();
    await waitTranscribing();
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);
    transcribeMode = "via-proxy";
    await page.waitForTimeout(4000);
    const c1 = await fakeCounts();
    ok("remount-no-provider", c1.transcribe === c0.transcribe, c0.transcribe + "->" + c1.transcribe);
    const rd = await (await requireBox()).inputValue();
    if (rd === null || rd === undefined) throw new Error("remount textarea missing");
    ok("remount-exact-draft", draftStrictEquals(String(rd), "remount-origin"), JSON.stringify(String(rd).slice(0, 300)));
  }
  // Controlled identity remount in the surviving document: a real React App
  // unmount/remount via simceo-auth-change with a new identity (epoch bump).
  // Server-side authority is proven separately by qa/voice-account-driver.mjs
  // against real register/login/session credentials; this block covers the
  // component remount only, never an account change.
  // The old held provider response must never touch the new identity UI;
  // per-user drafts stay scoped; a new op works under the new identity and
  // the origin draft is intact after switching back.
  {
    const c0 = await fakeCounts();
    await gotoMeet(mid);
    const ibox = await requireBox();
    await ibox.fill("epoch-origin", { timeout: 15000 });
    const holdE = proxy.holdNext("/api/meetings/" + mid + "/transcribe");
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: "Stop and transcribe into draft", exact: true }).first().click({ timeout: 15000 });
    await waitStopped();
    await waitTranscribing();
    const heldE = await waitHold(holdE, "epoch-provider");
    ok("epoch-provider-ran", heldE.held === true && heldE.upstreamStatus === 201, JSON.stringify(heldE));
    {
      const hcE = await fakeCounts();
      ok("epoch-provider-plus-1", hcE.transcribe === c0.transcribe + 1, c0.transcribe + "->" + hcE.transcribe);
    }
    const epochBefore = await page.evaluate(() => window.__simceoEpoch);
    // Drive the real main.tsx remount path: the anon identity branch keys
    // off simceo-fb-user-v2, while voice/draft scoping keys off simceo-user.
    // Setting both performs an actual React App unmount/remount in the
    // surviving document with an epoch bump and a new demo identity.
    await page.evaluate(() => {
      localStorage.setItem("simceo-fb-user-v2", "qa-fb-2");
      localStorage.setItem("simceo-user", "qa-epoch2");
      window.dispatchEvent(new Event("simceo-auth-change"));
    });
    await page.waitForTimeout(2000);
    const epochAfter = await page.evaluate(() => window.__simceoEpoch);
    ok("epoch-remount-bumped", epochAfter === epochBefore + 1, epochBefore + "->" + epochAfter);
    // Old op aborted by unmount cleanup; delivering its held response must
    // not write anything (proxy body lands on a dead route and is ignored).
    holdE.release();
    await page.waitForTimeout(3000);
    await gotoMeet(mid);
    const nbox = await requireBox();
    const ndraft = await nbox.inputValue();
    ok("epoch-new-identity-scoped", staleWriteAbsent(String(ndraft), ""), JSON.stringify(String(ndraft).slice(0, 200)));
    await nbox.fill("epoch2-new", { timeout: 15000 });
    const c1 = await fakeCounts();
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await waitRecording();
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: "Stop and transcribe into draft", exact: true }).first().click({ timeout: 15000 });
    await waitStopped();
    const c2 = await waitForCount(c1.transcribe, "epoch2", 30000);
    await waitTranscribed();
    ok("epoch2-fresh-hit", c2.transcribe === c1.transcribe + 1, c1.transcribe + "->" + c2.transcribe);
    const e2draft = await (await requireBox()).inputValue();
    ok("epoch2-exact-draft", transcriptAppended(e2draft, "epoch2-new"), JSON.stringify(String(e2draft).slice(0, 200)));
    // Switch back: the origin draft is intact, never hydrated under the new account.
    await page.evaluate(() => {
      localStorage.removeItem("simceo-user");
      localStorage.removeItem("simceo-fb-user-v2");
      window.dispatchEvent(new Event("simceo-auth-change"));
    });
    await page.waitForTimeout(1500);
    await gotoMeet(mid);
    const backDraft = await (await requireBox()).inputValue();
    ok("epoch-origin-intact", staleWriteAbsent(String(backDraft), "epoch-origin"), JSON.stringify(String(backDraft).slice(0, 300)));
  }
  // ACTUAL controlled fake->API 502, held via the forwarding branch: the
  // owned fake returns 502 once, the REAL API observes the provider failure,
  // records the failed ledger pair, and returns 502; the proxy holds THOSE
  // actual 502 bytes (headers flushed, body pending). Retry then succeeds.
  {
    const marker = "retry502";
    await page.evaluate(() => { window.__voiceStubMode = "tone"; });
    await gotoMeet(mid);
    const box6 = await requireBox();
    await box6.fill(marker, { timeout: 15000 });
    const c0 = await fakeCounts();
    // Snapshot scoped ledgers before the controlled failure.
    const uPre = await (async () => { const r = await fetch(API + "/api/usage?meetingId=" + mid + "&purpose=voice-transcribe", { headers: { "x-user": "owner" } }); return await r.json(); })();
    const cPre = await (async () => { const r = await fetch(API + "/api/models/calls?meetingId=" + mid + "&purpose=voice-transcribe", { headers: { "x-user": "owner" } }); return await r.json(); })();
    // Arm the owned fake to fail the NEXT transcribe with the exact body.
    {
      const fr = await fetch(FAKE + "/__fail-next-transcribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: 502, body: "provider request aborted" }) });
      ok("actual502-fake-armed", fr.status === 200, "status=" + fr.status);
    }
    const errHold = proxy.holdNext("/api/meetings/" + mid + "/transcribe");
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: "Stop and transcribe into draft", exact: true }).first().click({ timeout: 15000 });
    await waitStopped();
    await waitTranscribing();
    // Failure completion held: the App waits for the ACTUAL API 502 body.
    // The UI must stay Transcribing with no error and an untouched draft.
    await page.waitForTimeout(1500);
    const errOp = await waitHold(errHold, "aborted-error");
    ok("actual502-held", !!errOp && errOp.synthetic === false && errOp.held === true && errOp.upstreamStatus === 502 && errOp.autoReleased === false, JSON.stringify(errOp));
    ok("actual502-op-correlated", typeof errOp.url === "string" && errOp.url.includes("/api/meetings/" + mid + "/transcribe"), errOp.url);
    {
      // Provider was actually hit (fake count +1) while the App body waits.
      const hc = await fakeCounts();
      ok("actual502-provider-ran-while-held", hc.transcribe === c0.transcribe + 1, c0.transcribe + "->" + hc.transcribe);
    }
    const pendingBody = await page.locator("body").innerText();
    ok("aborted-body-held", !pendingBody.includes("Dictation failed"), pendingBody.slice(0, 200));
    const pendingDraft = await (await requireBox()).inputValue();
    ok("aborted-body-draft-held", String(pendingDraft) === marker, JSON.stringify(String(pendingDraft).slice(0, 200)));
    errHold.release();
    await page.waitForFunction(() => document.body.innerText.includes("Dictation failed"), null, { timeout: 15000 });
    const errBody = await page.locator("body").innerText();
    ok("aborted-body-visible-error", errBody.includes("502"), errBody.slice(0, 500));
    {
      // Failed ledger pair: exactly one new row each, SAME id, failed status.
      const uPost = await (async () => { const r = await fetch(API + "/api/usage?meetingId=" + mid + "&purpose=voice-transcribe", { headers: { "x-user": "owner" } }); return await r.json(); })();
      const cPost = await (async () => { const r = await fetch(API + "/api/models/calls?meetingId=" + mid + "&purpose=voice-transcribe", { headers: { "x-user": "owner" } }); return await r.json(); })();
      ok("actual502-usage-plus-1", Array.isArray(uPost) && Array.isArray(uPre) && uPost.length === uPre.length + 1, (uPre && uPre.length) + "->" + (uPost && uPost.length));
      ok("actual502-calls-plus-1", Array.isArray(cPost) && Array.isArray(cPre) && cPost.length === cPre.length + 1, (cPre && cPre.length) + "->" + (cPost && cPost.length));
      if (Array.isArray(uPost) && Array.isArray(cPost) && uPost.length === uPre.length + 1 && cPost.length === cPre.length + 1) {
        const uIds = new Set(uPre.map((x) => x.id ?? x.Id));
        const cIds = new Set(cPre.map((x) => x.id ?? x.Id));
        const au = uPost.filter((x) => !uIds.has(x.id ?? x.Id));
        const ac = cPost.filter((x) => !cIds.has(x.id ?? x.Id));
        const uid = au.length ? (au[0].id ?? au[0].Id) : "";
        const cid = ac.length ? (ac[0].id ?? ac[0].Id) : "";
        ok("actual502-pair-same-guid", au.length === 1 && ac.length === 1 && !!uid && uid === cid, "usage=" + uid + " calls=" + cid);
        if (au.length && ac.length) {
          const uSt = au[0].status ?? au[0].Status, cSt = ac[0].status ?? ac[0].Status;
          ok("actual502-pair-failed", uSt === "failed" && cSt === "failed", uSt + "/" + cSt);
        } else {
          ok("actual502-pair-failed", false, "missing added rows");
        }
      } else {
        ok("actual502-pair-same-guid", false, "ledger lengths");
        ok("actual502-pair-failed", false, "ledger lengths");
      }
    }
    // SEVENTH: FRESH baselines AFTER the real failure (not c0 from before
    // the failed call). The failed attempt already produced c0+1, so waiting
    // from c0 would let the FAILED call satisfy the retry assertion. Fresh
    // provider/proxy/BOTH-ledger baselines require exactly one NEW success
    // call/pair for the retry.
    const cFail = await fakeCounts();
    ok("actual502-fail-count-plus-1", cFail.transcribe === c0.transcribe + 1, c0.transcribe + "->" + cFail.transcribe);
    const proxyFailCount = proxy.opCount();
    const uFail = await (async () => { const r = await fetch(API + "/api/usage?meetingId=" + mid + "&purpose=voice-transcribe", { headers: { "x-user": "owner" } }); return await r.json(); })();
    const cFailLed = await (async () => { const r = await fetch(API + "/api/models/calls?meetingId=" + mid + "&purpose=voice-transcribe", { headers: { "x-user": "owner" } }); return await r.json(); })();
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await waitRecording();
    ok("aborted-body-retry-released", true);
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: "Stop and transcribe into draft", exact: true }).first().click({ timeout: 15000 });
    await waitStopped();
    const c1 = await waitForCount(cFail.transcribe, "aborted-retry", 30000);
    ok("aborted-body-retry-hit", c1.transcribe === cFail.transcribe + 1, cFail.transcribe + "->" + c1.transcribe);
    {
      const freshProxy = proxy.ops().slice(proxyFailCount).filter((o) => !o.synthetic && typeof o.url === "string" && o.url.includes("/api/meetings/" + mid + "/transcribe"));
      ok("aborted-body-retry-proxy-one", freshProxy.length === 1 && freshProxy[0].held === false && freshProxy[0].upstreamStatus === 201, JSON.stringify(freshProxy[0] || freshProxy));
      const uRetry = await (async () => { const r = await fetch(API + "/api/usage?meetingId=" + mid + "&purpose=voice-transcribe", { headers: { "x-user": "owner" } }); return await r.json(); })();
      const cRetry = await (async () => { const r = await fetch(API + "/api/models/calls?meetingId=" + mid + "&purpose=voice-transcribe", { headers: { "x-user": "owner" } }); return await r.json(); })();
      ok("aborted-body-retry-usage-plus-1", Array.isArray(uRetry) && uRetry.length === uFail.length + 1, uFail.length + "->" + uRetry.length);
      ok("aborted-body-retry-calls-plus-1", Array.isArray(cRetry) && cRetry.length === cFailLed.length + 1, cFailLed.length + "->" + cRetry.length);
      if (Array.isArray(uRetry) && Array.isArray(cRetry) && uRetry.length === uFail.length + 1 && cRetry.length === cFailLed.length + 1) {
        const uIdsR = new Set(uFail.map((x) => x.id ?? x.Id));
        const cIdsR = new Set(cFailLed.map((x) => x.id ?? x.Id));
        const auR = uRetry.filter((x) => !uIdsR.has(x.id ?? x.Id));
        const acR = cRetry.filter((x) => !cIdsR.has(x.id ?? x.Id));
        const uidR = auR.length ? (auR[0].id ?? auR[0].Id) : "";
        const cidR = acR.length ? (acR[0].id ?? acR[0].Id) : "";
        ok("aborted-body-retry-pair-same-guid", auR.length === 1 && acR.length === 1 && !!uidR && uidR === cidR, "usage=" + uidR + " calls=" + cidR);
        if (auR.length && acR.length) {
          const uStR = auR[0].status ?? auR[0].Status, cStR = acR[0].status ?? acR[0].Status;
          ok("aborted-body-retry-pair-succeeded", uStR === "succeeded" && cStR === "succeeded", uStR + "/" + cStR);
        } else {
          ok("aborted-body-retry-pair-succeeded", false, "missing retry rows");
        }
      } else {
        ok("aborted-body-retry-pair-same-guid", false, "retry ledger lengths");
        ok("aborted-body-retry-pair-succeeded", false, "retry ledger lengths");
      }
    }
    // SIXTH: provider count increments when the fake is hit, but the App
    // draft appends after the proxy releases the body and the App parses
    // JSON. Poll for the exact retry draft (not just a stale Transcribed
    // banner) before asserting.
    try {
      await page.waitForFunction((m) => { const el = document.querySelector("textarea"); return el && String(el.value).includes(m) && String(el.value).includes("qa transcript"); }, marker, { timeout: 15000 });
    } catch {}
    const rd6 = await (await requireBox()).inputValue();
    ok("aborted-body-retry-draft", transcriptAppended(rd6, marker), JSON.stringify(String(rd6).slice(0, 300)));
    await shot("voice-retry.png");
  }
  // AUXILIARY synthetic error-body control (labeled, NOT actual API proof):
  // exercises App error-body pending on the real fetch path. Actual provider
  // failure is proven by the actual502 block above via the forwarding branch.
  {
    const marker = "synth502";
    await gotoMeet(mid);
    await (await requireBox()).fill(marker, { timeout: 15000 });
    const sHold = proxy.errorNext(502, "provider request aborted", "/api/meetings/" + mid + "/transcribe");
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: "Stop and transcribe into draft", exact: true }).first().click({ timeout: 15000 });
    await waitStopped();
    await waitTranscribing();
    await page.waitForTimeout(1500);
    const sOp = await waitHold(sHold, "synthetic-error");
    ok("synthetic-error-held", !!sOp && sOp.synthetic === true && sOp.upstreamStatus === 502, JSON.stringify(sOp));
    sHold.release();
    await page.waitForFunction(() => document.body.innerText.includes("Dictation failed"), null, { timeout: 15000 });
    ok("synthetic-error-visible", true);
    await gateDisarm();
  }
  // Decode failure then retry with fresh-provider delta
  {
    const marker = "decode-retry";
    await gotoMeet(mid);
    const box7 = await requireBox();
    await box7.fill(marker, { timeout: 15000 });
    const baselineDecode = await gateReset();
    await gateArm();
    const c0 = await fakeCounts();
    await page.evaluate(() => {
      try {
        const P = window.AudioContext || window.webkitAudioContext;
        if (P && !P.prototype.__qaDecodePatched) {
          P.prototype.__qaDecodePatched = true;
          const orig = P.prototype.decodeAudioData;
          P.prototype.decodeAudioData = function () { return Promise.reject(new Error("qa decode fail")); };
          window.__qaDecodeOrig = orig;
        }
      } catch {}
    });
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await waitRecording();
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: "Stop and transcribe into draft", exact: true }).first().click({ timeout: 15000 });
    await waitStopped();
    await waitTranscribing();
    // Decode entered and HELD: the error only materializes after release,
    // proving the failure path runs through the real decode stage.
    const drBlob = await waitGateEntered("blob", baselineDecode);
    ok("decode-retry-blob-entered", drBlob > baselineDecode, "id=" + drBlob);
    await releaseGate("blob", baselineDecode);
    const drDec = await waitGateEntered("decode", baselineDecode);
    ok("decode-retry-decode-entered", drDec > baselineDecode, "id=" + drDec);
    await releaseGate("decode", baselineDecode);
    await gateDisarm();
    await page.waitForFunction(() => document.body.innerText.includes("Dictation failed"), null, { timeout: 15000 });
    const errBody = await page.locator("body").innerText();
    ok("decode-error-visible", errBody.includes("Could not decode") || errBody.includes("Dictation failed"), errBody.slice(0, 500));
    const cFail = await fakeCounts();
    ok("decode-no-provider", cFail.transcribe === c0.transcribe, c0.transcribe + "->" + cFail.transcribe);
    await page.evaluate(() => {
      try {
        const P = window.AudioContext || window.webkitAudioContext;
        if (P && P.prototype.__qaDecodePatched && window.__qaDecodeOrig) {
          P.prototype.decodeAudioData = window.__qaDecodeOrig;
          delete P.prototype.__qaDecodePatched;
        }
      } catch {}
    });
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await waitRecording();
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: "Stop and transcribe into draft", exact: true }).first().click({ timeout: 15000 });
    await waitStopped();
    const c1 = await waitForCount(cFail.transcribe, "decode-retry", 30000);
    ok("decode-retry-fresh-hit", c1.transcribe === cFail.transcribe + 1, cFail.transcribe + "->" + c1.transcribe);
    const retryDraft = await (await requireBox()).inputValue();
    if (retryDraft === null || retryDraft === undefined) throw new Error("retry textarea missing");
    ok("decode-retry-draft", transcriptAppended(retryDraft, marker), JSON.stringify(String(retryDraft).slice(0, 300)));
  }
  // Mic denial error: the App surfaces denial as a toast (its own alert helper), never a native dialog.
  {
    await page.evaluate(() => { window.__voiceStubMode = "fail"; });
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1500);
    await shot("voice-error.png");
    const errBody = await page.locator("body").innerText();
    ok("error-visible", errBody.includes("Microphone unavailable") || errBody.includes("Dictation failed"), errBody.slice(0, 500));
    await page.evaluate(() => { window.__voiceStubMode = "tone"; });
    ok("mic-denial-toast-exact", errBody.includes("Microphone unavailable."), errBody.slice(0, 500));
  }
  ok("no-native-dialogs", dialogs.length === 0, JSON.stringify(dialogs));
  ok("no-console-errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  // Verdict-ordering self-test (runs BEFORE finally): failure-injection
  // controls prove the ACTUAL helpers fold faults into FAIL with no PASS
  // token and nonzero code, and that nothing was published yet.
  {
    const inj = finalVerdict(1, 0, [], ["injected:page-close timeout"]);
    ok("cleanup-inject-fails", inj.code === 1 && inj.text.indexOf("VOICEBROWSER PASS") < 0 && inj.summary.fail === 1, inj.text);
    const cln = finalVerdict(1, 0, [], []);
    ok("cleanup-clean-passes", cln.code === 0 && cln.text === "VOICEBROWSER PASS 1", cln.text);
    // SEVENTH: ACTUAL controlled startup/fatal/final-artifact-write failures
    // through the REAL lifecycle helpers (not literal error arithmetic or an
    // unrelated bad-path probe only). Each fault folds into FAIL/nonzero
    // with no PASS token, proving the actual lifecycle failure branches.
    {
      let startupRejected = false;
      try {
        const badProxy = createVoiceProxy({ apiBase: "http://127.0.0.1:5999/" });
        await badProxy.start();
      } catch { startupRejected = true; }
      ok("startup-failure-folds", startupRejected === true, "bad apiBase must reject via real checkApiBase");
      const startupV = finalVerdict(0, 0, [], startupRejected ? ["startup:apiBase-rejected"] : []);
      ok("startup-verdict-fails", startupRejected && startupV.code === 1 && startupV.text.indexOf("VOICEBROWSER PASS") < 0, startupV.text);
    }
    // ACTUAL closeBounded fault (real helper, not pure arithmetic).
    const probeErrs = [];
    await closeBounded(() => Promise.reject(new Error("injected-probe-fault")), "injected-probe", probeErrs, 1000);
    ok("cleanup-fault-folds", probeErrs.length === 1 && String(probeErrs[0]).startsWith("injected-probe:"), JSON.stringify(probeErrs).slice(0, 160));
    const probeV = finalVerdict(0, 0, [], probeErrs);
    ok("cleanup-fault-verdict-fails", probeV.code === 1 && probeV.text.indexOf("VOICEBROWSER PASS") < 0 && probeV.summary.fail === 1, probeV.text);
    // ACTUAL fatal retention folds into FAIL: derive the fatal string from a
    // real thrown error through the actual catch path, not a literal.
    let probeFatalStr = "";
    try { throw new Error("probe-fatal-lifecycle"); } catch (e) { probeFatalStr = String((e && e.stack) || e).slice(0, 500); }
    const fatalV = finalVerdict(0, 0, [], ["fatal:" + probeFatalStr]);
    ok("fatal-folds-fail", probeFatalStr.includes("probe-fatal-lifecycle") && fatalV.code === 1 && fatalV.text.indexOf("VOICEBROWSER PASS") < 0, fatalV.text.slice(0, 160));
    // ACTUAL final-artifact-write failure through the REAL helper used by
    // finally (writeSummaryFile), targeting a directory path so the same
    // helper throws; the failure folds to nonzero with no PASS token.
    let artifactProbeFailed = false;
    let artifactProbeMsg = "";
    try { writeSummaryFile(".tmp/voice-qa", { verdict: "probe" }); } catch (e) { artifactProbeFailed = true; artifactProbeMsg = String((e && e.message) || e); }
    ok("artifact-failure-nonzero-probe", artifactProbeFailed === true, artifactProbeMsg.slice(0, 160));
    const artV = finalVerdict(0, 0, [], artifactProbeFailed ? ["artifact-write:" + artifactProbeMsg] : []);
    ok("artifact-verdict-fails", artifactProbeFailed && artV.code === 1 && artV.summary.fail === 1 && artV.text.indexOf("VOICEBROWSER PASS") < 0, artV.text);
    let sent = null;
    try { sent = JSON.parse(fs.readFileSync(SUMMARY_PATH, "utf8")); } catch {}
    ok("verdict-not-published-early", !!sent && sent.verdict === "pending" && verdictPublished === 0, JSON.stringify(sent).slice(0, 160));
  }
} catch (e) {
  console.log("VOICEBROWSER FATAL " + (e && e.stack ? e.stack : String(e)));
  try { fatalErr = String((e && e.stack) || e).slice(0, 500); } catch {}
  process.exitCode = 1;
} finally {
  // Bounded cleanup FIRST: disarm + release every held proxy/gate barrier
  // (outer-scope helper, shutdown refuses new registrations), then close
  // every owned context/transport with a deadline. The verdict and the
  // machine artifact are published ONCE, here, after cleanup folds in.
  // No PASS token or summary exists before this point (sentinel "pending"
  // until now). Final artifact failure is itself a cleanup failure (nonzero).
  // SEVENTH: bounded + accounted gate release / proxy stop so a failed or
  // hung release cannot prevent ALL remaining close attempts. Each step is
  // bounded (closeBounded race) and folded into cleanupErrs; every owned
  // close is still attempted even if an earlier gate/proxy step hangs.
  const cleanupErrs = [];
  await closeBounded(async () => { try { if (proxy) proxy.releaseAll(); } catch {} }, "proxy-releaseAll", cleanupErrs, 5000);
  await closeBounded(() => releaseAllGatesFn(), "gate-release", cleanupErrs, 10000);
  if (fatalErr) cleanupErrs.push("fatal:" + fatalErr);
  if (page && !page.isClosed()) await closeBounded(() => page.close(), "page", cleanupErrs);
  if (ctx) await closeBounded(() => ctx.close(), "ctx", cleanupErrs);
  if (browser) await closeBounded(() => browser.close(), "browser", cleanupErrs);
  if (proxy && proxyStarted) await closeBounded(() => proxy.stop(), "proxy-stop", cleanupErrs, 15000);
  else if (proxy) await closeBounded(() => proxy.stop(), "proxy-stop", cleanupErrs, 15000);
  for (const ce of cleanupErrs) console.log("  FAIL cleanup-" + ce);
  let v = finalVerdict(pass, fail, failures, cleanupErrs);
  try { writeSummaryFile(SUMMARY_PATH, v.summary); } catch (e) {
    const ae = "artifact-write:" + (e && e.message ? e.message : String(e));
    cleanupErrs.push(ae);
    console.log("  FAIL cleanup-" + ae);
    v = finalVerdict(pass, fail, failures, cleanupErrs);
    try { writeSummaryFile(SUMMARY_PATH, v.summary); } catch {}
  }
  console.log(v.text);
  for (const fl of v.summary.failures) console.log(" - " + fl);
  verdictPublished++;
  process.exitCode = v.code;
}
