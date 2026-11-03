import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const ROOT = path.resolve(new URL(".", import.meta.url).pathname.replace(/^\//, "").replace(/^([A-Za-z]:)/, "$1"), "..");
const OUTDIR = path.join(ROOT, ".tmp", "voice-qa", "vc");
execSync("npx tsc src/voiceCodec.ts --outDir ../.tmp/voice-qa/vc --module nodenext --target es2022 --moduleResolution nodenext --skipLibCheck", { cwd: path.join(ROOT, "web"), stdio: "pipe" });
const vc = await import(pathToFileURL(path.join(OUTDIR, "voiceCodec.js")).href);
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class SlowBlob extends Blob {
  constructor(parts, opts, delayMs) { super(parts, opts); this._d = delayMs || 0; }
  async arrayBuffer() { if (this._d) await sleep(this._d); return super.arrayBuffer(); }
}
function makeWindow(decodeDelayMs, decodeImpl, hooks) {
  hooks.created = 0; hooks.closed = 0;
  const AC = class {
    constructor() { hooks.created++; }
    async decodeAudioData() { await sleep(decodeDelayMs); return decodeImpl(); }
    createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
    async close() { hooks.closed++; }
  };
  return { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a), AudioContext: AC };
}
function toneBuffer() {
  const n = 48000;
  return { length: n, duration: 1, sampleRate: 48000, numberOfChannels: 1, getChannelData: () => new Float32Array(n).fill(0.1) };
}
function makeOAC(renderDelayMs, outLen) {
  return class {
    constructor() {}
    createBufferSource() { return { set buffer(v) {}, connect() {}, start() {}, disconnect() {} }; }
    async startRendering() { await sleep(renderDelayMs); return { getChannelData: () => ({ slice: () => new Float32Array(outLen) }) }; }
  };
}
// A: decode 360ms + render 300ms under ONE 400ms deadline must time out once,
// near the single budget (fresh-30s-per-stage would take ~660ms and succeed).
{
  const hooks = {};
  globalThis.window = makeWindow(360, toneBuffer, hooks);
  globalThis.OfflineAudioContext = makeOAC(300, 16000);
  const t0 = Date.now();
  let err = null;
  try {
    await vc.convertRecordedBlobToWav(new SlowBlob([new Uint8Array(100)], {}, 0), 16000, { timeoutMs: 400 });
  } catch (e) { err = e; }
  const el = Date.now() - t0;
  ok("total-deadline-timeout", !!err && /timed out/.test(err.message || ""), String(err && err.message) + " elapsed=" + el);
  ok("total-deadline-elapsed", el >= 350 && el < 650, "elapsed=" + el);
  ok("total-deadline-context-closed", hooks.closed >= 1, JSON.stringify(hooks));
}
// B: blob read beyond the single budget rejects at the budget.
{
  const hooks = {};
  globalThis.window = makeWindow(0, toneBuffer, hooks);
  globalThis.OfflineAudioContext = makeOAC(0, 16000);
  const t0 = Date.now();
  let err = null;
  try {
    await vc.convertRecordedBlobToWav(new SlowBlob([new Uint8Array(100)], {}, 600), 16000, { timeoutMs: 300 });
  } catch (e) { err = e; }
  const el = Date.now() - t0;
  ok("blob-inside-deadline", !!err && /timed out/.test(err.message || ""), String(err && err.message) + " elapsed=" + el);
  ok("blob-elapsed", el >= 250 && el < 550, "elapsed=" + el);
}
// C: abort during blob read rejects cancelled, converter never starts decode.
{
  const hooks = {};
  globalThis.window = makeWindow(0, toneBuffer, hooks);
  globalThis.OfflineAudioContext = makeOAC(0, 16000);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  let err = null;
  try {
    await vc.convertRecordedBlobToWav(new SlowBlob([new Uint8Array(100)], {}, 5000), 16000, { signal: ac.signal, timeoutMs: 2000 });
  } catch (e) { err = e; }
  ok("abort-cancelled", !!err && err instanceof DOMException && err.name === "AbortError", String(err && err.name) + " " + String(err && err.message));
  ok("abort-no-decode-context", hooks.created === 0, JSON.stringify(hooks));
}
// D: timeout closes the owned context exactly once.
{
  const hooks = {};
  globalThis.window = makeWindow(5000, toneBuffer, hooks);
  globalThis.OfflineAudioContext = makeOAC(0, 16000);
  let err = null;
  try {
    await vc.convertRecordedBlobToWav(new SlowBlob([new Uint8Array(100)], {}, 0), 16000, { timeoutMs: 200 });
  } catch (e) { err = e; }
  ok("timeout-error", !!err && /timed out/.test(err.message || ""), String(err && err.message));
  ok("timeout-context-closed-once", hooks.closed === 1, JSON.stringify(hooks));
}
// E: late completion after timeout is ignored; converter state stays usable.
{
  const hooks = {};
  globalThis.window = makeWindow(600, toneBuffer, hooks);
  globalThis.OfflineAudioContext = makeOAC(0, 16000);
  let err = null;
  try {
    await vc.convertRecordedBlobToWav(new SlowBlob([new Uint8Array(100)], {}, 0), 16000, { timeoutMs: 200 });
  } catch (e) { err = e; }
  ok("late-first-timeout", !!err && /timed out/.test(err.message || ""), String(err && err.message));
  await sleep(700);
  const hooks2 = {};
  globalThis.window = makeWindow(0, toneBuffer, hooks2);
  globalThis.OfflineAudioContext = makeOAC(0, 16000);
  const r = await vc.convertRecordedBlobToWav(new SlowBlob([new Uint8Array(100)], {}, 0), 16000, { timeoutMs: 5000 });
  ok("late-state-clean", r.sampleRate === 16000 && r.durationSec === 1 && r.wavBytes.length === 44 + 32000, r.sampleRate + " dur=" + r.durationSec + " len=" + r.wavBytes.length);
}
delete globalThis.window;
delete globalThis.OfflineAudioContext;
console.log(fail === 0 ? "VOICEDEADLINE PASS " + pass : "VOICEDEADLINE FAIL pass=" + pass + " fail=" + fail);
for (const f of failures) console.log(" - " + f);
process.exitCode = fail === 0 ? 0 : 1;
