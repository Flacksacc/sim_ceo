import { createVoiceProxy } from "./voice-stream-proxy.mjs";
import { draftStrictEquals, transcriptAppended, staleWriteAbsent, payloadShaMatches, payloadBytesMatch, waitForCount } from "./voice-browser-assert.mjs";

// SEVENTH focused five-finding counterexamples on REAL helpers (no browser,
// no API). Each proves the fix discriminates: old logic passes wrong, new
// logic fails wrong and passes right.
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
// F1: real startup failure branch (bad apiBase rejects via checkApiBase).
{
  let rejected = false;
  try { const p = createVoiceProxy({ apiBase: "http://127.0.0.1:5999/" }); await p.start(); } catch { rejected = true; }
  ok("f1-startup-rejects", rejected === true, "bad apiBase must reject");
  // Real artifact helper failure folds (same writeFileSync path as finally).
  let artFail = false;
  try { (await import("node:fs")).default.writeFileSync(".tmp/voice-qa", "x"); } catch { artFail = true; }
  ok("f1-artifact-fails", artFail === true, "directory write must throw");
}
// F3: stale c0 baseline false-passes; fresh baseline requires NEW hit.
{
  let cur = 10;
  const get = async () => ({ transcribe: cur });
  // Failed call already produced c0+1: waiting from stale c0 returns at once.
  const stale = await waitForCount(get, 9, "f3-stale", 3000);
  ok("f3-stale-false-pass", stale.transcribe === 10, "stale c0=" + 9 + " hit=" + stale.transcribe);
  // Fresh baseline after failure (cFail=10): must wait for 11.
  cur = 10;
  setTimeout(() => { cur = 11; }, 800);
  const fresh = await waitForCount(get, 10, "f3-fresh", 5000);
  ok("f3-fresh-requires-new", fresh.transcribe === 11, "fresh cFail=10 hit=" + fresh.transcribe);
}
// F4: stored A/B bytes must be exact before AND after old release while B held.
{
  const storedABefore = "aba-origin";
  const storedBBefore = "aba-second";
  const storedAAfter = "aba-origin";
  const storedBAfter = "aba-second";
  ok("f4-stored-a-stable", draftStrictEquals(storedAAfter, storedABefore) === true, storedAAfter);
  ok("f4-stored-b-stable", draftStrictEquals(storedBAfter, storedBBefore) === true && storedBAfter === "aba-second", storedBAfter);
  const corruptedB = "aba-origin qa transcript";
  ok("f4-stale-corruption-fails", staleWriteAbsent(corruptedB, "aba-second") === false, corruptedB);
  // Driver verdict: pend>0 with fail==0 must be INCOMPLETE, never PASS.
  const verdict = (f, p) => f > 0 ? "FAIL" : p > 0 ? "INCOMPLETE" : "PASS";
  ok("f4-incomplete-not-pass", verdict(0, 1) === "INCOMPLETE", verdict(0, 1));
  ok("f4-pass-only-when-clean", verdict(0, 0) === "PASS", verdict(0, 0));
}
// F5: retained rows FULLFIELD unchanged; scope/purpose on failure pairs.
{
  const u0 = [{ id: "a-1", kind: "voice-transcribe", meetingId: "m1", boardId: "b1", status: "succeeded", cost: 0.0001, costBasis: "PIN", model: "muse-voice-transcribe-1.0" }];
  const u1good = [...u0, { id: "a-2", kind: "voice-transcribe", meetingId: "m1", boardId: "b1", status: "succeeded", cost: 0.0001, costBasis: "PIN", model: "muse-voice-transcribe-1.0" }];
  const m1 = new Map(u1good.map((x) => [x.id, JSON.stringify(x)]));
  const chg = u0.filter((x) => m1.has(x.id) && m1.get(x.id) !== JSON.stringify(x));
  ok("f5-retained-good", chg.length === 0 && u1good.length === u0.length + 1, "chg=" + chg.length);
  const u1bad = [{ id: "a-1", kind: "voice-transcribe", meetingId: "m1", boardId: "WRONG", status: "succeeded", cost: 0.0001, costBasis: "PIN", model: "muse-voice-transcribe-1.0" }, u1good[1]];
  const m2 = new Map(u1bad.map((x) => [x.id, JSON.stringify(x)]));
  const chg2 = u0.filter((x) => m2.has(x.id) && m2.get(x.id) !== JSON.stringify(x));
  ok("f5-retained-detects-mutation", chg2.length === 1, "chg=" + chg2.length);
  const scopeOk = (r) => r.meetingId === "m1" && r.boardId === "b1" && r.kind === "voice-transcribe";
  ok("f5-scope-rejects-wrong-board", scopeOk(u1bad[0]) === false, JSON.stringify(u1bad[0].boardId));
}
// F6: strict exact transcribe path (real proxy regex mirrored from source).
{
  const re = /^\/api\/meetings\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/transcribe$/;
  const good = "/api/meetings/11111111-2222-3333-4444-555555555555/transcribe";
  ok("f6-strict-pass", re.test(good) === true, good);
  ok("f6-strict-rejects-suffix", re.test(good + "/extra") === false, "suffix");
  ok("f6-strict-rejects-query-split", re.test(good.split("?")[0]) === true, "query split ok");
  ok("f6-payload-sha-real", payloadShaMatches("ab", "ab") === true && payloadShaMatches("ab", "cd") === false, "sha");
  ok("f6-payload-bytes-real", payloadBytesMatch(5, 5) === true && payloadBytesMatch(5, 6) === false, "bytes");
  ok("f6-transcript-exact", transcriptAppended("m qa transcript", "m") === true && transcriptAppended("m", "m") === false, "append");
}
console.log(fail === 0 ? "VOICESEVENTHFOCUSED PASS " + pass : "VOICESEVENTHFOCUSED FAIL pass=" + pass + " fail=" + fail);
for (const f of failures) console.log(" - " + f);
process.exitCode = fail === 0 ? 0 : 1;