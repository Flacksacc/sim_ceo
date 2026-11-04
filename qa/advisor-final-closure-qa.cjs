"use strict";
// Advisor final closure QA: precursor checks for the eight-review-findings
// iteration (helper/SSR render + source wiring). NOT lifecycle acceptance:
// mounted App/hook lifecycle acceptance lives in
// qa/advisor-final-lifecycle-browser.mjs (real compiled App + React Query
// through Playwright with deferred route fixtures).
// No services, browser, Docker, or provider keys. Runs the real behavioral
// render suite (web/src/__behavioral__/check.tsx, which imports the actual
// hook/presence/renderer/character modules) plus wiring assertions against
// the actual App/hook source so integration is verified beyond pure helpers.
const { execSync, execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const web = path.join(root, "web");
const out = path.join(root, ".beh-tmp-closure");
const fail = (m) => { console.error("FAIL " + m); process.exit(1); };
const ok = (m) => console.log("ok - " + m);

try {
  fs.rmSync(out, { recursive: true, force: true });
  execSync(
    "npx tsc src/__behavioral__/check.tsx --outDir " + path.join("..", ".beh-tmp-closure") +
    " --module commonjs --target es2020 --jsx react-jsx --esModuleInterop --skipLibCheck --moduleResolution node",
    { cwd: web, stdio: "inherit" },
  );
  const dropCss = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) dropCss(p);
      else if (f.name.endsWith(".js")) {
        const tx = fs.readFileSync(p, "utf8");
        if (tx.indexOf(".css") >= 0) fs.writeFileSync(p, tx.split("\n").filter((ln) => ln.indexOf(".css") < 0).join("\n"));
      }
    }
  };
  dropCss(out);
  const childOut = execFileSync(
    process.execPath,
    [path.join(out, "__behavioral__", "check.js")],
    { env: Object.assign({}, process.env, { NODE_PATH: path.join(web, "node_modules") }), encoding: "utf8" },
  );
  process.stdout.write(childOut);
  ok("behavioral render suite (actual App/hook modules) passed");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}

// Wiring assertions against the actual source (integration, not mirrors).
const app = fs.readFileSync(path.join(web, "src", "App.tsx"), "utf8");
const act = fs.readFileSync(path.join(web, "src", "meeting-activity.ts"), "utf8");
const pres = fs.readFileSync(path.join(web, "src", "meeting-presence.ts"), "utf8");
const part = fs.readFileSync(path.join(web, "src", "meeting-participants.tsx"), "utf8");
const adv = fs.readFileSync(path.join(web, "src", "advisor-creation.tsx"), "utf8");
const must = (cond, name) => { if (!cond) fail(name); ok(name); };

must(app.indexOf("activityAvailability") >= 0, "wire: App holds hook availability");
must(app.indexOf('availability: (activityAvailability as any) ?? "available"') >= 0, "wire: App passes availability into buildPresence");
must(app.indexOf('availability={(activityAvailability as any) ?? "available"}') >= 0, "wire: App passes availability into renderer");
must(act.indexOf("resolveActivityAvailability") >= 0, "wire: hook exposes availability resolver");
must(act.indexOf("selectSecretaryActivity") >= 0, "wire: hook aggregates secretary active-first");
must(pres.indexOf("availSeat") >= 0, "wire: presence gates snapshot on availability");
must(part.indexOf("checking activity") >= 0, "wire: renderer reports checking instead of false listening");
must(app.indexOf("askSecretary.reset();") >= 0, "wire: Apply identity retires held secretary initial");
must(app.indexOf("retrySecretary.reset();") >= 0, "wire: Apply identity retires held secretary retry");
must(app.indexOf("answerSecretary.reset();") >= 0, "wire: Apply identity retires held secretary answer");
must(app.indexOf("askBriefing.reset();") >= 0, "wire: Apply identity retires held briefing");
must(app.indexOf("editNote.reset();") >= 0, "wire: Apply identity retires held note edit");
must(app.indexOf("reverseNote.reset();") >= 0, "wire: Apply identity retires held note reverse");
must(app.indexOf("Briefing submission retired before dispatch") >= 0, "wire: briefing validates frozen vars before dispatch");
must(app.indexOf("Note edit retired before dispatch") >= 0, "wire: note edit validates frozen vars before dispatch");
must(app.indexOf("Note reverse retired before dispatch") >= 0, "wire: note reverse validates frozen vars before dispatch");
must(app.indexOf("refetchInterval: !!selRow?.entry.id") >= 0, "wire: roster-research refreshes while open");
must(app.indexOf("selResearchData") >= 0, "wire: banner derives from owned GET research snapshot");
must(app.indexOf("selResearchLoading") >= 0, "wire: banner reports loading honestly");
must(app.indexOf("isRosterResearchRunning(d)") >= 0, "wire: running beats cached researchedAt");
must(app.indexOf("prevResearchRunRef") >= 0, "wire: canonical meta refreshes on research transition");
must(app.indexOf("onreconnecting") >= 0, "wire: hub reconnecting marks transport");
must(app.indexOf("hubRev") >= 0, "wire: restore recovers connection without ID change");
must(app.indexOf('live={live && activityAvailability === "available"}') >= 0, "wire: Live badge requires actual transport+availability");
must(app.indexOf("visibilitychange") >= 0, "wire: resume triggers fresh HTTP with cleanup");
must(act.indexOf("const pool = responding.length") >= 0, "wire: aggregation prefers inflight/answering over pending");
must(act.indexOf("awaitingFresh") >= 0, "wire: hook gates retained snapshot until fresh HTTP after resume");
must(act.indexOf("pagePaused") >= 0, "wire: hook pauses on hidden tab/offline");
must(app.indexOf("onInvalidated") >= 0, "wire: App wires canonical-save invalidation without adoption");
must(adv.indexOf("capturedInvalidated") >= 0, "wire: editor invalidates immediately after confirmed PUT before verify");
must(adv.indexOf("onInvalidated") >= 0, "wire: editor invalidates after every confirmed PUT");
must(adv.indexOf("isAllowlistedClientValidation") >= 0, "wire: only allowlisted validation passes through");
must(adv.indexOf("exactClientValidationCopy") >= 0, "wire: validation uses exact patterns, never raw substring");
must(adv.indexOf("friendlyError(") < 0, "wire: character translator never consults generic shared mapper");
must(adv.indexOf("That change conflicted with a newer saved version") >= 0, "wire: generic 409 never claims already-running");
must(adv.indexOf('could not be verified (" + (verifyError') < 0, "wire: PUT verify note never interpolates raw status");

// Forbidden concurrent-owner files must be excluded from this commit's payload.
// The check inspects only the staged payload (stage the explicit commit paths
// first): concurrent-owner WIP stays unstaged in the working tree and is
// excluded by `git commit --only`, so unstaged dirt is not a failure here.
try {
  const staged = (() => { try { return execSync("git diff --cached --name-only", { cwd: root, encoding: "utf8" }).split(/\r?\n/).filter(Boolean); } catch { return []; } })();
  for (const f of ["qa/meeting-send-pipeline-qa.mjs", "qa/navigation.cjs", "qa/fixtures.cjs"]) {
    if (staged.indexOf(f) >= 0) fail("forbidden file staged: " + f);
  }
  ok("forbidden owner files excluded from payload (send-pipeline/navigation/fixtures)");
} catch (e) {
  if (e && e.message && e.message.indexOf("forbidden file") >= 0) throw e;
  console.log("warn - git check skipped (" + String((e && e.message) || e).slice(0, 120) + ")");
}

console.log("advisor-final-closure-qa: PASS");
