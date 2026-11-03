import crypto from "node:crypto";
import {
  draftStrictEquals,
  transcriptAppended,
  staleWriteAbsent,
  payloadShaMatches,
  payloadBytesMatch,
  waitForCount,
} from "./voice-browser-assert.mjs";
// Negative controls feed hostile inputs to the ACTUAL browser assertion
// predicates (imported above), not to separately written copies. Each case
// asserts the hostile input FAILS the real predicate while clean inputs pass.
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
// Stale transcript leak must fail the real exact-draft predicate.
{
  const leaked = "nav-origin qa transcript";
  ok("cx-nav-real-fails-on-leak", staleWriteAbsent(leaked, "nav-origin") === false, leaked);
  ok("cx-nav-real-passes-clean", staleWriteAbsent("nav-origin", "nav-origin") === true, "nav-origin");
  ok("cx-origin-intact-real", draftStrictEquals("nav-origin", "nav-origin") === true, "nav-origin");
}
// A-B-A: stale text with flat counter must fail the real predicate.
{
  const leaked = "aba-origin qa transcript";
  ok("cx-aba-real-fails-stale-flat-counter", staleWriteAbsent(leaked, "aba-origin") === false, leaked);
  ok("cx-aba-real-passes-exact", staleWriteAbsent("aba-origin", "aba-origin") === true, "aba-origin");
}
// Upload/provider correlation uses the real sha/bytes predicates.
{
  const a = Buffer.from("audio-bytes-A");
  const b = Buffer.from("audio-bytes-B-different");
  const bSha = crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);
  const aSha = crypto.createHash("sha256").update(a).digest("hex").slice(0, 16);
  ok("cx-sha-real-fails-different-payload", payloadShaMatches(aSha, bSha) === false, "A vs sha(B)");
  ok("cx-sha-real-passes-exact", payloadShaMatches(aSha, aSha) === true, aSha);
  ok("cx-bytes-real-fails", payloadBytesMatch(a.length, b.length) === false, a.length + " vs " + b.length);
  ok("cx-bytes-real-passes", payloadBytesMatch(a.length, a.length) === true, String(a.length));
}
// Retry draft uses the real append predicate.
{
  ok("cx-retry-real-fails-partial", transcriptAppended("retry502", "retry502") === false, "missing transcript");
  ok("cx-retry-real-passes-exact", transcriptAppended("retry502 qa transcript", "retry502") === true, "retry502 qa transcript");
}
// The real strict waiter must surface a hung barrier instead of proceeding.
{
  let calls = 0;
  const hanging = async () => ({ transcribe: 7 + (calls++, 0) });
  let threw = false;
  const t0 = Date.now();
  try { await waitForCount(hanging, 7, "cx-hold", 300); } catch { threw = true; }
  const el = Date.now() - t0;
  ok("cx-wait-real-throws-on-hold", threw === true, "elapsed=" + el);
  ok("cx-wait-real-bounded", el < 5000, "elapsed=" + el);
  const rising = async () => ({ transcribe: 8 });
  const got = await waitForCount(rising, 7, "cx-release", 5000);
  ok("cx-wait-real-passes-on-release", got.transcribe === 8, JSON.stringify(got));
}
console.log(fail === 0 ? "VOICEASSERTCX PASS " + pass : "VOICEASSERTCX FAIL pass=" + pass + " fail=" + fail);
for (const f of failures) console.log(" - " + f);
process.exitCode = fail === 0 ? 0 : 1;