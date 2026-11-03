import crypto from "node:crypto";
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
// Old vs new assertion logic on identical hostile inputs. Each case asserts
// the OLD logic passes (demonstrating the hole) and the NEW logic fails.
function oldNavNoLeak(draft) { return !String(draft).includes("qa transcript") || true; }
function newNavNoLeak(draft) { return !String(draft).includes("qa transcript"); }
{
  const leaked = "nav-origin qa transcript";
  ok("cx-nav-old-passes-on-leak", oldNavNoLeak(leaked) === true, leaked);
  ok("cx-nav-new-fails-on-leak", newNavNoLeak(leaked) === false, leaked);
  ok("cx-nav-new-passes-clean", newNavNoLeak("nav-origin") === true, "nav-origin");
}
function oldAba(draft, c0, c1) {
  const hasStale = String(draft).includes("qa transcript") && !String(draft).includes("aba-origin-DONE");
  return !hasStale || c1 === c0;
}
function newAba(draft, c0, c1) { return draft === "aba-origin" && c1 === c0; }
{
  const leaked = "aba-origin qa transcript";
  ok("cx-aba-old-passes-stale-plus-flat-counter", oldAba(leaked, 7, 7) === true, leaked);
  ok("cx-aba-new-fails-stale-flat-counter", newAba(leaked, 7, 7) === false, leaked);
  ok("cx-aba-new-passes-exact", newAba("aba-origin", 7, 7) === true, "aba-origin");
}
function oldSha(s) { return typeof s === "string" && s.length >= 8; }
function newSha(uploadBytes, providerSha) {
  return crypto.createHash("sha256").update(uploadBytes).digest("hex").slice(0, 16) === providerSha;
}
{
  const a = Buffer.from("audio-bytes-A");
  const b = Buffer.from("audio-bytes-B-different");
  const bSha = crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);
  ok("cx-sha-old-passes-different-payload", oldSha(bSha) === true, bSha);
  ok("cx-sha-new-fails-different-payload", newSha(a, bSha) === false, "A vs sha(B)");
  const aSha = crypto.createHash("sha256").update(a).digest("hex").slice(0, 16);
  ok("cx-sha-new-passes-exact", newSha(a, aSha) === true, aSha);
}
async function oldWaitSwallow(check) {
  try { await check(); } catch {}
  return true;
}
async function newWaitStrict(check) { await check(); return true; }
{
  const hanging = () => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout 50ms")), 50));
  const oldR = await oldWaitSwallow(hanging);
  ok("cx-wait-old-swallows-timeout", oldR === true, "proceeded despite timeout");
  let newThrew = false;
  try { await newWaitStrict(hanging); } catch { newThrew = true; }
  ok("cx-wait-new-throws-timeout", newThrew === true, "strict barrier surfaces timeout");
}
console.log(fail === 0 ? "VOICEASSERTCX PASS " + pass : "VOICEASSERTCX FAIL pass=" + pass + " fail=" + fail);
for (const f of failures) console.log(" - " + f);
process.exitCode = fail === 0 ? 0 : 1;
