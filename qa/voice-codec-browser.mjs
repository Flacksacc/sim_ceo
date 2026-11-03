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
const CDP = process.env.QA_CDP || "http://localhost:9333";
const WEB = process.env.QA_WEB || "http://127.0.0.1:5192";
const API = process.env.QA_API || "http://127.0.0.1:5115";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:5206";
const OUT = ".tmp/voice-qa/shots";
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
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
  if (r.status !== 200 || !j || typeof j.transcribe !== "number") throw new Error("fake counts shape invalid " + r.status + " " + t.slice(0, 200));
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
const run = "vb-" + Date.now().toString(36);
const board = await api("POST", "/api/boards", { name: run + "-b", mission: run + " mission", stage: "qa" });
const bid = board.json.id;
ok("seed-board", !!bid, board.text.slice(0, 160));
await api("POST", "/api/boards/" + bid + "/lead", { name: "QA Lead" });
const mtg = await api("POST", "/api/boards/" + bid + "/meetings", { title: run + " m1", brief: "voice browser brief" });
const mid = mtg.json.id;
ok("seed-meeting", !!mid, mtg.text.slice(0, 160));
const mtg2 = await api("POST", "/api/boards/" + bid + "/meetings", { title: run + " m2", brief: "second brief" });
const mid2 = mtg2.json.id;
await api("POST", "/api/meetings/" + mid + "/messages", { sender: "lead", content: "seeded hello" });
let browser = null;
let ctx = null;
let page = null;
const postedPaths = [];
const dialogs = [];
const uploads = [];
let transcribeMode = "normal";
let releaseASR = null;
const holdASR = () => new Promise((r) => { releaseASR = r; });
function releaseHeldASR() {
  const r = releaseASR;
  releaseASR = null;
  if (r) r();
}
try {
  browser = await chromium.connectOverCDP(CDP);
  const beforeContexts = browser.contexts().map((c) => c.pages().length);
  ok("cdp-shared-contexts-present", browser.contexts().length >= 1, "contexts=" + browser.contexts().length);
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();
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
    window.__decodeDelayMs = 0;
    window.__renderDelayMs = 0;
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
          inst.decodeAudioData = async (...da) => {
            if (window.__decodeDelayMs) await new Promise((r) => setTimeout(r, window.__decodeDelayMs));
            return origDecode(...da);
          };
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
            inst.startRendering = async (...sa) => {
              if (window.__renderDelayMs) await new Promise((r) => setTimeout(r, window.__renderDelayMs));
              return origRender(...sa);
            };
          } catch {}
          return inst;
        };
        W.prototype = OrigOAC.prototype;
        window.OfflineAudioContext = W;
      }
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
    if (transcribeMode === "fail502") {
      transcribeMode = "normal";
      await route.fulfill({ status: 502, contentType: "text/plain", body: "provider request aborted" });
      return;
    }
    if (transcribeMode.startsWith("delay:")) {
      const ms = Number(transcribeMode.slice(6)) || 0;
      await new Promise((r) => setTimeout(r, ms));
    }
    if (transcribeMode === "hold") {
      // ASR barrier: headers captured above, body held until released.
      await holdASR();
      try { await route.continue(); } catch {}
      return;
    }
    if (transcribeMode === "hold-after-provider") {
      // Provider runs NOW (headers+body observed at the fake), the response
      // is held until released: proves disposal of an already-running
      // provider response against a stale/new operation.
      let resp = null;
      try { resp = await route.fetch(); } catch { try { await route.continue(); } catch {} return; }
      await holdASR();
      try { await route.fulfill({ response: resp }); } catch {}
      return;
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
  const dictate = page.getByRole("button", { name: /Dictate/i }).first();
  await dictate.waitFor({ timeout: 30000 });
  ok("dictate-visible", true);
  await shot("voice-meet-primary.png");
  // Positive with exact payload correlation + typed during held ASR
  {
    const c0 = await fakeCounts();
    const u0 = await scopedUsage(mid);
    const up0 = uploads.length;
    // Explicit released barriers: decode held 2s, render held 2s, ASR held
    // until the test releases. Transcribing visible while the provider count
    // stays flat proves the pending stages are observed, not assumed.
    await page.evaluate(() => { window.__decodeDelayMs = 2000; window.__renderDelayMs = 2000; });
    transcribeMode = "hold";
    const box = await requireBox();
    await box.fill("typed hello", { timeout: 15000 });
    await dictate.click({ timeout: 15000 });
    await waitRecording();
    await page.waitForTimeout(2500);
    await shot("voice-recording.png");
    await box.fill("typed hello DURINGREC", { timeout: 15000 });
    const recState = await page.evaluate(() => ({ pressed: document.querySelector("[aria-pressed=true]") !== null }));
    ok("recording-state", recState.pressed === true, JSON.stringify(recState));
    await page.getByRole("button", { name: /Stop dictation/i }).first().click({ timeout: 15000 });
    await waitStopped();
    await waitTranscribing();
    // Decode barrier: conversion still running, upload not yet sent.
    await page.waitForTimeout(1200);
    const heldCounts = await fakeCounts();
    ok("decode-barrier-held", heldCounts.transcribe === c0.transcribe, c0.transcribe + "->" + heldCounts.transcribe);
    // Render/upload barrier: poll until the captured upload arrives while
    // the fake still shows no hit (headers sent, body held at the route).
    let upSeen = false;
    for (let i = 0; i < 40; i++) {
      if (uploads.length > up0 + 0) { upSeen = uploads.length === up0 + 1; break; }
      await page.waitForTimeout(500);
    }
    ok("asr-headers-sent", upSeen, "uploads=" + uploads.length + " base=" + up0);
    const heldCounts2 = await fakeCounts();
    ok("asr-body-held", heldCounts2.transcribe === c0.transcribe, c0.transcribe + "->" + heldCounts2.transcribe);
    await box.fill("typed hello DURINGREC DURING-HELD", { timeout: 15000 });
    releaseHeldASR();
    await page.evaluate(() => { window.__decodeDelayMs = 0; window.__renderDelayMs = 0; });
    transcribeMode = "normal";
    await waitTranscribed();
    await page.waitForTimeout(800);
    await shot("voice-transcribed.png");
    const draftVal = await box.inputValue();
    if (draftVal === null || draftVal === undefined) throw new Error("draft textarea missing");
    ok("editable-transcript-exact", transcriptAppended(draftVal, "typed hello DURINGREC DURING-HELD"), JSON.stringify(draftVal).slice(0, 300));
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
    await page.getByRole("button", { name: /Stop dictation/i }).first().click({ timeout: 15000 });
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
    await page.getByRole("button", { name: /Stop dictation/i }).first().click({ timeout: 15000 });
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
    await page.getByRole("button", { name: /Stop dictation/i }).first().click({ timeout: 15000 });
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
  // Delayed conversion cancelled by navigation
  {
    const c0 = await fakeCounts();
    await page.evaluate(() => { window.__decodeDelayMs = 3000; });
    await gotoMeet(mid2);
    await (await requireBox()).fill("conv-second", { timeout: 15000 });
    await gotoMeet(mid);
    const box4 = await requireBox();
    await box4.fill("conv-origin", { timeout: 15000 });
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: /Stop dictation/i }).first().click({ timeout: 15000 });
    await waitStopped();
    await waitTranscribing();
    await page.goto(WEB + "#/meet?board=" + bid + "&meeting=" + mid2, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    await page.evaluate(() => { window.__decodeDelayMs = 0; });
    const c1 = await fakeCounts();
    ok("conversion-cancel-no-provider", c1.transcribe === c0.transcribe, c0.transcribe + "->" + c1.transcribe);
    const cd = await (await requireBox()).inputValue();
    ok("conversion-cancel-no-leak", staleWriteAbsent(String(cd), "conv-second"), JSON.stringify(String(cd).slice(0, 200)));
  }
  // A-B-A with an already-running provider response: headers+body reach the
  // fake (count +1 observed while the response is held), navigation stales
  // the op, and the released response arriving after return must be
  // disposed: exact origin draft, no transcript, no error UI.
  {
    const c0 = await fakeCounts();
    await gotoMeet(mid);
    const box = await requireBox();
    await box.fill("aba-origin", { timeout: 15000 });
    transcribeMode = "hold-after-provider";
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: /Stop dictation/i }).first().click({ timeout: 15000 });
    await waitStopped();
    await waitTranscribing();
    // Provider already ran while its response is held: +1 observed.
    const held = await waitForProviderCount(fakeCounts, c0.transcribe, "aba-provider", 30000);
    ok("aba-provider-ran", held.transcribe === c0.transcribe + 1, c0.transcribe + "->" + held.transcribe);
    await gotoMeet(mid2);
    await page.waitForTimeout(800);
    await gotoMeet(mid);
    releaseHeldASR();
    transcribeMode = "normal";
    await page.waitForTimeout(4000);
    const c1 = await fakeCounts();
    const abaDraft = await (await requireBox()).inputValue();
    if (abaDraft === null || abaDraft === undefined) throw new Error("aba textarea missing");
    ok("aba-no-stale", staleWriteAbsent(String(abaDraft), "aba-origin") && c1.transcribe === c0.transcribe + 1, "draft=" + JSON.stringify(String(abaDraft).slice(0, 200)) + " counts=" + c0.transcribe + "->" + c1.transcribe);
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
    await page.getByRole("button", { name: /Stop dictation/i }).first().click({ timeout: 15000 });
    await waitStopped();
    await waitTranscribing();
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);
    transcribeMode = "normal";
    await page.waitForTimeout(4000);
    const c1 = await fakeCounts();
    ok("remount-no-provider", c1.transcribe === c0.transcribe, c0.transcribe + "->" + c1.transcribe);
    const rd = await (await requireBox()).inputValue();
    if (rd === null || rd === undefined) throw new Error("remount textarea missing");
    ok("remount-exact-draft", draftStrictEquals(String(rd), "remount-origin"), JSON.stringify(String(rd).slice(0, 300)));
  }
  // Controlled identity remount in the surviving document: a real React App
  // unmount/remount via simceo-auth-change with a new identity (epoch bump).
  // The old held provider response must never touch the new identity UI;
  // per-user drafts stay scoped; a new op works under the new identity and
  // the origin draft is intact after switching back.
  {
    const c0 = await fakeCounts();
    await gotoMeet(mid);
    const ibox = await requireBox();
    await ibox.fill("epoch-origin", { timeout: 15000 });
    transcribeMode = "hold-after-provider";
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: /Stop dictation/i }).first().click({ timeout: 15000 });
    await waitStopped();
    await waitTranscribing();
    const held2 = await waitForProviderCount(fakeCounts, c0.transcribe, "epoch-provider", 30000);
    ok("epoch-provider-ran", held2.transcribe === c0.transcribe + 1, c0.transcribe + "->" + held2.transcribe);
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
    // not write anything (fulfill on the dead route is ignored).
    releaseHeldASR();
    transcribeMode = "normal";
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
    await page.getByRole("button", { name: /Stop dictation/i }).first().click({ timeout: 15000 });
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
  // HTTP 502 body containing "aborted" is a visible error, retry releases op
  {
    const marker = "retry502";
    await page.evaluate(() => { window.__voiceStubMode = "tone"; });
    await gotoMeet(mid);
    const box6 = await requireBox();
    await box6.fill(marker, { timeout: 15000 });
    const c0 = await fakeCounts();
    transcribeMode = "fail502";
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: /Stop dictation/i }).first().click({ timeout: 15000 });
    await waitStopped();
    await page.waitForFunction(() => document.body.innerText.includes("Dictation failed"), null, { timeout: 15000 });
    const errBody = await page.locator("body").innerText();
    ok("aborted-body-visible-error", errBody.includes("502"), errBody.slice(0, 500));
    await page.getByRole("button", { name: /Dictate/i }).first().click({ timeout: 15000 });
    await waitRecording();
    ok("aborted-body-retry-released", true);
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: /Stop dictation/i }).first().click({ timeout: 15000 });
    await waitStopped();
    const c1 = await waitForCount(c0.transcribe, "aborted-retry", 30000);
    ok("aborted-body-retry-hit", c1.transcribe === c0.transcribe + 1, c0.transcribe + "->" + c1.transcribe);
    const rd6 = await (await requireBox()).inputValue();
    ok("aborted-body-retry-draft", transcriptAppended(rd6, marker), JSON.stringify(String(rd6).slice(0, 300)));
    await shot("voice-retry.png");
  }
  // Decode failure then retry with fresh-provider delta
  {
    const marker = "decode-retry";
    await gotoMeet(mid);
    const box7 = await requireBox();
    await box7.fill(marker, { timeout: 15000 });
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
    await page.getByRole("button", { name: /Stop dictation/i }).first().click({ timeout: 15000 });
    await waitStopped();
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
    await page.getByRole("button", { name: /Stop dictation/i }).first().click({ timeout: 15000 });
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
  try { fs.writeFileSync(".tmp/voice-qa/browser-summary.json", JSON.stringify({ pass, fail, failures }, null, 1)); } catch {}
  console.log(fail === 0 ? "VOICEBROWSER PASS " + pass : "VOICEBROWSER FAIL pass=" + pass + " fail=" + fail);
  for (const f of failures) console.log(" - " + f);
  process.exitCode = fail === 0 ? 0 : 1;
} catch (e) {
  console.log("VOICEBROWSER FATAL " + (e && e.stack ? e.stack : String(e)));
  try { fs.writeFileSync(".tmp/voice-qa/browser-summary.json", JSON.stringify({ pass, fail: fail + 1, failures: failures.concat(["fatal:" + String(e && e.message ? e.message : e)]) }, null, 1)); } catch {}
  process.exitCode = 1;
} finally {
  try { if (page && !page.isClosed()) await page.close().catch(() => {}); } catch {}
  try { if (ctx) await ctx.close().catch(() => {}); } catch {}
  try { if (browser) await browser.close().catch(() => {}); } catch {}
}
