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
  // Bounded: pre/post CDP fetches must not hang the parent past its deadline.
  const r = await fetch(CDP + p, { signal: AbortSignal.timeout(10000) });
  const t = await r.text();
  let j = null;
  try { j = t ? JSON.parse(t) : null; } catch { j = null; }
  return { status: r.status, json: j, text: t };
}
const before = await cdpJson("/json/version");
ok("cdp-up-before", before.status === 200 && !!before.json && typeof before.json.Browser === "string", "status=" + before.status);
// Instance identity: webSocketDebuggerUrl identifies THIS browser instance;
// the product/version string alone also matches a different browser.
const beforeWs = before.json && before.json.webSocketDebuggerUrl;
ok("cdp-instance-before", typeof beforeWs === "string" && beforeWs.length > 0, String(beforeWs));
const beforeList = await cdpJson("/json/list");
ok("cdp-list-before", beforeList.status === 200 && Array.isArray(beforeList.json), "status=" + beforeList.status);
// Service workers/iframes may disappear naturally. Preserve every preexisting
// page, which is the user-facing target the child must never close.
const beforeIds = Array.isArray(beforeList.json) ? beforeList.json.filter((t) => t?.type === "page").map((t) => t.id).filter(Boolean) : [];
ok("cdp-targets-present-before", beforeIds.length >= 1, "ids=" + beforeIds.length);
const logW = fs.createWriteStream(LOG, { flags: "w" });
const errW = fs.createWriteStream(ERRLOG, { flags: "w" });
const child = spawn(process.execPath, ["qa/voice-codec-browser.mjs"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env },
  windowsHide: true,
});
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
// Cleanup failures FAIL: a killed/timed-out or nonzero child is never
// reported as successful cleanup.
ok("browser-exit-normal", timedOut === false && code === 0, "timedOut=" + timedOut + " code=" + code);
const after = await cdpJson("/json/version");
ok("cdp-up-after", after.status === 200 && !!after.json && typeof after.json.Browser === "string", "status=" + after.status);
const afterWs = after.json && after.json.webSocketDebuggerUrl;
ok("cdp-same-instance", !!beforeWs && afterWs === beforeWs, String(beforeWs) + " vs " + String(afterWs));
const afterList = await cdpJson("/json/list");
ok("cdp-list-after", afterList.status === 200 && Array.isArray(afterList.json), "status=" + afterList.status);
// Retention: every pre-existing shared/default-context target ID must still
// exist. The suite owns only its page/context and disconnects transport via
// Playwright browser.close(); it must never close user targets.
const afterIds = new Set(Array.isArray(afterList.json) ? afterList.json.map((t) => t && t.id).filter(Boolean) : []);
const missing = beforeIds.filter((id) => !afterIds.has(id));
ok("cdp-targets-retained", missing.length === 0, "missing=" + JSON.stringify(missing) + " before=" + beforeIds.length + " after=" + afterIds.size);
// Owned-target disposal by EXACT ID (SIXTH): the child records its pre-run
// CDP IDs and its exact new owned target/context IDs in
// .tmp/voice-qa/owned-targets.json. Verify THOSE IDs disappeared while every
// pre-existing (user/shared/parallel, incl. 71766/0A36) ID is retained.
// URL substrings alone misclassify about:blank, IPv6 orphans, and unrelated
// parallel contexts that legitimately sit on a voice port.
{
  // SEVENTH: exact OWN IDs from the child manifest (own page CDP session),
  // fresh nonempty run+instance-bound evidence required. Stale/empty/failed
  // manifests FAIL; no localhost URL-substring fallback credit (foreign
  // parallel targets legitimately use voice ports and must not fail/pass).
  let ownedIds = [];
  let manifestOk = false;
  let manifestWhy = "";
  try {
    const raw = fs.readFileSync(".tmp/voice-qa/owned-targets.json", "utf8");
    const j = JSON.parse(raw);
    const owned = (j && Array.isArray(j.owned)) ? j.owned.filter(Boolean) : [];
    const before = (j && Array.isArray(j.before)) ? j.before.filter(Boolean) : [];
    const runId = (j && typeof j.run === "string") ? j.run : "";
    const instWs = (j && typeof j.instanceWs === "string") ? j.instanceWs : "";
    if (!runId) manifestWhy = "missing run binding";
    else if (!instWs) manifestWhy = "missing instance binding";
    else if (instWs !== beforeWs) manifestWhy = "stale instance binding";
    else if (owned.length < 1) manifestWhy = "empty owned ids";
    else if (before.length < 1) manifestWhy = "empty before ids";
    else {
      const beforeSet0 = new Set(beforeIds);
      const manifestBeforeMissing = before.filter((id) => !beforeSet0.has(id));
      if (manifestBeforeMissing.length > 0) manifestWhy = "stale before set";
      else { ownedIds = owned; manifestOk = true; }
    }
    if (!manifestOk && !manifestWhy) manifestWhy = "unreadable manifest";
  } catch (e) { manifestWhy = "manifest read/parse failed: " + String((e && e.message) || e).slice(0, 120); }
  ok("cdp-owned-ids-file", manifestOk === true, manifestOk ? "owned=" + ownedIds.length : manifestWhy);
  ok("cdp-owned-manifest-fresh", manifestOk === true, manifestOk ? "bound run+instance nonempty" : manifestWhy);
  const gone = ownedIds.filter((id) => afterIds.has(id));
  ok("cdp-owned-targets-disposed", manifestOk && gone.length === 0, "leaked-owned-ids=" + JSON.stringify(gone.slice(0, 4)) + " owned=" + ownedIds.length + (manifestOk ? "" : " manifest=" + manifestWhy));
}
console.log(fail === 0 ? "VOICEBROWSERPARENT PASS " + pass : "VOICEBROWSERPARENT FAIL pass=" + pass + " fail=" + fail);
for (const f of failures) console.log(" - " + f);
process.exitCode = fail === 0 ? 0 : 1;
