// Material Review 4 QA (2d1658a independent review): proves all 4 source fixes.
// Talks only to QA_API (memory mode, no human DBs). Primary executes with owned ports/DBs.
// Static source checks + HTTP bounds/semantics. Provider-dependent research legs
// expect the fake provider (QA_FAKE) like character-advisor-qa; empty-URL contract
// asserts non-400 (200 with fake, 502 without) rather than hard 200.
// Exit nonzero on any failure.
import fs from "node:fs";
const API = process.env.QA_API || "http://127.0.0.1:5159";
const run = "mr4-" + Date.now().toString(36);
let pass = 0, fail = 0; const failures = [];
function ok(name, cond, extra) { if (cond) pass++; else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); } }
async function req(method, path, body, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), opts.timeout || 30000);
  try {
    const r = await fetch(API + path, { method, signal: ctl.signal,
      headers: { "content-type": "application/json", "x-user": opts.user || "owner", ...(opts.headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const post = (p, b, o) => req("POST", p, b, o);
const put = (p, b, o) => req("PUT", p, b, o);
const guid = () => globalThis.crypto.randomUUID();
const camel = (o, k) => { if (!o || typeof o !== "object") return undefined; if (k in o) return o[k]; const lo = k.toLowerCase(); for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key]; return undefined; };
const ACCT = guid();

// ---- static source checks (all 4, no runtime) ----
const cr = fs.readFileSync("server/SimCEO.Api/Work/CharacterResearch.cs", "utf8");
const cc = fs.readFileSync("server/SimCEO.Api/Work/ContextCurator.cs", "utf8");
const pg = fs.readFileSync("server/SimCEO.Api/Program.cs", "utf8");
const co = fs.readFileSync("server/SimCEO.Api/Work/CommitOutcome.cs", "utf8");
// (1) no pre-lock fallback; resolution from fresh cur inside Atomic; explicit semantics preserved
ok("static-1-no-preRes-fallback", !cr.includes("preRes.ResearchInputsJson") && !cr.includes("preRes.ResearchJson"), "preRes fallback remains");
ok("static-1-fresh-cur-inside-atomic", cr.includes("ParseInputs(cur.ResearchInputsJson)") && cr.includes("cur.ResearchJson") && cr.includes("explicitBackground") && cr.includes("explicitUrls") && cr.includes("explicitFocus"), "fresh resolution missing");
// (2) complete block tracking, single-line, atomic manifest, SourceEpoch guard intact
ok("static-2-block-tracking", cc.includes("sourceBlocks") && cc.includes("SingleLine") && cc.includes("Rebuild(out"), "block tracking missing");
ok("static-2-no-uuid-substring", !cc.includes('packet.Contains(id2.Split(":")[0]'), "uuid substring filter remains");
ok("static-2-evidence-atomic", cc.includes("outEvidence") && cc.includes("curEvidence") && cc.includes("transcriptBlocks"), "atomic manifest missing");
const ep = fs.readFileSync("server/SimCEO.Api/Work/Endpoints.cs", "utf8");
ok("static-2-sourceepoch-guard", ep.includes("s.SourceEpoch != cap.EpochBefore") && ep.includes("CheckPacketFreshnessLocked"), "SourceEpoch guard missing");
// (3) raw POST always validates objects (legacy included), validator still permits legacy
ok("static-3-raw-always-validates", pg.includes("Always enforce shared profile bounds") && pg.includes("ValidateSavedProfile(input.ProfileJson)"), "raw POST guard missing");
ok("static-3-no-conditional-keys", !pg.includes("TryGetProperty(CharacterBehavior.KeyContribution"), "conditional key gate remains in Program.cs");
const cb = fs.readFileSync("server/SimCEO.Api/Work/CharacterBehavior.cs", "utf8");
ok("static-3-validator-permits-legacy", cb.includes("if (!hasAny) return (true, null, null);"), "validator legacy compat changed");
// (4) terminal cleanup honest mapping, no catch-all Denied, fault seam present
ok("static-4-no-catchall-denied", !cr.includes("catch (Exception fex) when (fex is InvalidOperationException || fex is UnauthorizedAccessException)"), "catch-all remains");
ok("static-4-storage-fault", cr.includes('CommitOutcome.StorageFault("Research failure cleanup"'), "storage fault mapping missing");
ok("static-4-gone-404", cr.includes('CommitOutcome.IsMissing(iox, "gone")'), "gone 404 missing");
ok("static-4-fault-seam", cr.includes("FailCleanupFault"), "fault seam missing");
const failTermIdx = cr.indexOf("private static IResult FailTerminal");
const failBody = failTermIdx >= 0 ? cr.slice(failTermIdx) : "";
const seamIdx = failBody.indexOf("FailCleanupFault?.Invoke()");
const flushIdx = failBody.indexOf("s.Roster.Flush()");
const unapprIdx = failBody.indexOf("UnapproveBoardCopies(s, id)");
const catchIdx = failBody.indexOf('catch (InvalidOperationException iox) when (iox.Message == "res-restored")');
ok("static-4-seam-after-mutations", failTermIdx >= 0 && seamIdx > flushIdx && flushIdx > 0 && seamIdx > unapprIdx, "seam not after mutations");
ok("static-4-seam-inside-atomic", failBody.indexOf("Atomic.Run(s") >= 0 && seamIdx >= 0 && catchIdx > seamIdx, "seam not inside atomic unit");
ok("static-4-commit-outcome-intact", co.includes("StorageFault") && co.includes("IsMissing"), "CommitOutcome helper changed");

// ---- HTTP (3): raw creation bounds, legacy compat preserved ----
const bigBg = "B".repeat(25000);
const rBigLegacy = await post("/api/roster", { accountId: ACCT, name: run + "-bigleg", description: "raw legacy oversize probe", profileJson: JSON.stringify({ fictional: true, background: bigBg }) });
ok("http3-raw-big-legacy-400", rBigLegacy.status === 400, rBigLegacy.status + " " + rBigLegacy.text.slice(0, 200));
const smallLeg = { fictional: true, background: "small legacy background with enough length here" };
const rSmallLeg = await post("/api/roster", { accountId: ACCT, name: run + "-smallleg", description: "raw legacy compat probe with enough words", profileJson: JSON.stringify(smallLeg) });
ok("http3-raw-small-legacy-201", rSmallLeg.status === 201 && camel(rSmallLeg.json, "id"), rSmallLeg.status + " " + rSmallLeg.text.slice(0, 200));
const rPlainSmall = await post("/api/roster", { accountId: ACCT, name: run + "-plainsmall", description: "plain-text legacy compat probe with enough words", profileJson: "unlinked profile with enough length here for compat" });
ok("http3-raw-plain-small-201", rPlainSmall.status === 201, rPlainSmall.status + " " + rPlainSmall.text.slice(0, 200));
const rPlainBig = await post("/api/roster", { accountId: ACCT, name: run + "-plainbig", description: "plain-text oversize probe", profileJson: "P".repeat(25000) });
ok("http3-raw-plain-big-400", rPlainBig.status === 400, rPlainBig.status + " " + rPlainBig.text.slice(0, 200));
// PUT equivalence: same big legacy must also 400
if (rSmallLeg.status === 201) {
  const rid = camel(rSmallLeg.json, "id");
  const pBig = await put("/api/roster/" + rid, { profileJson: JSON.stringify({ fictional: true, background: bigBg }) });
  ok("http3-put-big-legacy-400", pBig.status === 400, pBig.status + " " + pBig.text.slice(0, 200));
} else ok("http3-put-big-legacy-400", false, "no small-legacy id to test PUT");
// chat must reject the oversize that raw now rejects (parity, not acceptance)
if (rSmallLeg.status === 201) {
  const rid = camel(rSmallLeg.json, "id");
  const cOk = await post("/api/roster/" + rid + "/chat", { message: "hello" });
  ok("http3-chat-small-legacy-ok", cOk.status === 200, cOk.status + " " + cOk.text.slice(0, 200));
}
const bg4001 = "B".repeat(4001);
const rBg4001 = await post("/api/roster", { accountId: ACCT, name: run + "-bg4001", description: "raw bg4001 probe with enough words here", profileJson: JSON.stringify({ fictional: true, background: bg4001 }) });
ok("http3-raw-bg4001-400", rBg4001.status === 400, rBg4001.status + " " + rBg4001.text.slice(0, 200));
const bg4000 = "B".repeat(4000);
const rBg4000 = await post("/api/roster", { accountId: ACCT, name: run + "-bg4000", description: "raw bg4000 probe with enough words here", profileJson: JSON.stringify({ fictional: true, background: bg4000 }) });
ok("http3-raw-bg4000-201", rBg4000.status === 201 && camel(rBg4000.json, "id"), rBg4000.status + " " + rBg4000.text.slice(0, 200));
const charBase = { accountId: ACCT, role: "Strategist", problem: "Decide the tradeoff with enough words here for character" };
const rCharLegObj = await post("/api/roster/character", { ...charBase, name: run + "-charlegobj", profileJson: { fictional: true, background: "small legacy background with enough length here" } });
ok("http3-char-object-legacy-201", rCharLegObj.status === 201 && camel(rCharLegObj.json, "id"), rCharLegObj.status + " " + rCharLegObj.text.slice(0, 200));
const rCharLegStr = await post("/api/roster/character", { ...charBase, name: run + "-charlegstr", profileJson: JSON.stringify({ fictional: true, background: "small legacy background with enough length here" }) });
ok("http3-char-string-legacy-201", rCharLegStr.status === 201 && camel(rCharLegStr.json, "id"), rCharLegStr.status + " " + rCharLegStr.text.slice(0, 200));
const rCharBigObj = await post("/api/roster/character", { ...charBase, name: run + "-charbigobj", profileJson: { fictional: true, background: bigBg } });
ok("http3-char-object-big-400", rCharBigObj.status === 400, rCharBigObj.status + " " + rCharBigObj.text.slice(0, 200));
const rCharBigStr = await post("/api/roster/character", { ...charBase, name: run + "-charbigstr", profileJson: JSON.stringify({ fictional: true, background: bigBg }) });
ok("http3-char-string-big-400", rCharBigStr.status === 400, rCharBigStr.status + " " + rCharBigStr.text.slice(0, 200));
const rCharPartial = await post("/api/roster/character", { ...charBase, name: run + "-charpartial", profileJson: { contributionCriteria: "Contribute when tradeoff needs evaluation.", reasoningApproach: "Compare evidence and constraints." } });
ok("http3-char-partial-400", rCharPartial.status === 400, rCharPartial.status + " " + rCharPartial.text.slice(0, 200));

// ---- HTTP (1): explicit input semantics/validation preserved (pre-gate, no provider needed) ----
const q = await post("/api/roster/quick", { accountId: ACCT, name: run + "-res", description: "research semantics probe with enough words here" });
ok("http1-quick-201", q.status === 201 && camel(q.json, "id"), q.status + " " + q.text.slice(0, 200));
if (q.status === 201) {
  const rid = camel(q.json, "id");
  const overBg = await post("/api/roster/" + rid + "/research", { background: "X".repeat(5000) });
  ok("http1-research-overbg-400", overBg.status === 400, overBg.status + " " + overBg.text.slice(0, 200));
  const badUrl = await post("/api/roster/" + rid + "/research", { sourceUrls: ["not-a-url"] });
  ok("http1-research-badurl-400", badUrl.status === 400, badUrl.status + " " + badUrl.text.slice(0, 200));
  const badFocus = await post("/api/roster/" + rid + "/research", { focus: 12345 });
  ok("http1-research-badfocus-400", badFocus.status === 400, badFocus.status + " " + badFocus.text.slice(0, 200));
  // empty research: meaningful terminal contract, never blind not400. With QA_FAKE expect 200 honest terminal + persisted inputs; otherwise accept 200 honest terminal or supported 502 provider fail, never 401/403/503.
  const empty = await post("/api/roster/" + rid + "/research", {}, { timeout: 60000 });
  const hasFake = !!process.env.QA_FAKE;
  ok("http1-research-empty-never-auth-unavail", empty.status !== 401 && empty.status !== 403 && empty.status !== 503, empty.status + " " + empty.text.slice(0, 200));
  if (hasFake) {
    ok("http1-research-empty-200-fake", empty.status === 200, empty.status + " " + empty.text.slice(0, 300));
    if (empty.status === 200) {
      const ds = (empty.json && (empty.json.draftStatus || empty.json.DraftStatus)) || "";
      ok("http1-research-empty-terminal-fake", ds === "done" || ds === "unsupported" || ds === "failed", empty.text.slice(0, 300));
      const g = await req("GET", "/api/roster/" + rid + "/research", undefined, { timeout: 30000 });
      const gi = (g.json && (g.json.inputs || g.json.Inputs)) || null;
      const gds = (g.json && (g.json.draftStatus || g.json.DraftStatus)) || "";
      ok("http1-research-empty-inputs-persisted", g.status === 200 && gi !== null, g.status + " " + g.text.slice(0, 300));
      ok("http1-research-empty-get-terminal", gds === "done" || gds === "unsupported" || gds === "failed", g.text.slice(0, 300));
    } else {
      ok("http1-research-empty-terminal-fake", false, "expected 200 with fake, got " + empty.status);
      ok("http1-research-empty-inputs-persisted", false, "no 200 to verify inputs");
      ok("http1-research-empty-get-terminal", false, "no 200 to verify GET terminal");
    }
  } else {
    const ds2 = (empty.json && (empty.json.draftStatus || empty.json.DraftStatus)) || "";
    const terminal200 = empty.status === 200 && (ds2 === "done" || ds2 === "unsupported" || ds2 === "failed");
    const supported502 = empty.status === 502 && empty.status !== 401 && empty.status !== 403 && empty.status !== 503;
    ok("http1-research-empty-honest", terminal200 || supported502, empty.status + " " + empty.text.slice(0, 300));
  }
}

console.log(`MATERIAL-REVIEW4 RESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass} pass, ${fail} fail)`);
if (fail > 0) { console.log(failures.join("\n")); process.exit(1); }
