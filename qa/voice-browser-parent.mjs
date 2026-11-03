import { spawn } from "node:child_process";
import fs from "node:fs";
const CDP = process.env.QA_CDP || "http://localhost:9333";
const TIMEOUT_MS = 8 * 60 * 1000;
const LOG = ".tmp/voice-qa/browser.log";
const ERRLOG = ".tmp/voice-qa/browser.err.log";
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
async function cdpJson(p) {
  const r = await fetch(CDP + p);
  const t = await r.text();
  let j = null;
  try { j = t ? JSON.parse(t) : null; } catch { j = null; }
  return { status: r.status, json: j, text: t };
}
const before = await cdpJson("/json/version");
ok("cdp-up-before", before.status === 200 && !!before.json && typeof before.json.Browser === "string", "status=" + before.status);
const beforeList = await cdpJson("/json/list");
ok("cdp-list-before", beforeList.status === 200 && Array.isArray(beforeList.json), "status=" + beforeList.status);
const logW = fs.createWriteStream(LOG, { flags: "w" });
const errW = fs.createWriteStream(ERRLOG, { flags: "w" });
const child = spawn(process.execPath, ["qa/voice-codec-browser.mjs"], { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.pipe(logW);
child.stderr.pipe(errW);
let timedOut = false;
const killer = setTimeout(() => {
  timedOut = true;
  try { child.kill("SIGKILL"); } catch {}
}, TIMEOUT_MS);
const code = await new Promise((resolve) => child.on("close", resolve));
clearTimeout(killer);
await new Promise((r) => setTimeout(r, 500));
ok("browser-exit-normal", timedOut === false && code === 0, "timedOut=" + timedOut + " code=" + code);
const after = await cdpJson("/json/version");
ok("cdp-up-after", after.status === 200 && !!after.json && typeof after.json.Browser === "string", "status=" + after.status);
ok("cdp-same-browser", before.json && after.json && before.json.Browser === after.json.Browser, String(before.json && before.json.Browser) + " vs " + String(after.json && after.json.Browser));
const afterList = await cdpJson("/json/list");
ok("cdp-list-after", afterList.status === 200 && Array.isArray(afterList.json), "status=" + afterList.status);
console.log(fail === 0 ? "VOICEBROWSERPARENT PASS " + pass : "VOICEBROWSERPARENT FAIL pass=" + pass + " fail=" + fail);
for (const f of failures) console.log(" - " + f);
process.exitCode = fail === 0 ? 0 : 1;
