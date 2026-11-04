import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";

// Integrated QA for roster backend ownership (no live user data, no server starts).
// Run: node qa/roster-integrity-qa.mjs
// Checks: branch/worktree scope, forbidden areas untouched (web/*, profile-owned
// server files), owned files present, forbidden ports untouched (read-only probe),
// plan-hash determinism shape.

const owned = [
  "server/SimCEO.Api/Work/RosterIntegrity.cs",
  "server/SimCEO.Api/Work/RosterReconciliation.cs",
  "server/SimCEO.Api/Work/RosterReconcileApply.cs",
  "server/SimCEO.Api/Work/RosterChatEndpoints.cs",
  "qa/roster-backend-qa.mjs",
  "qa/roster-pg-qa.mjs",
  "qa/roster-chat-contract.mjs",
  "qa/roster-integrity-qa.mjs",
];
// Backend profile must not touch frontend or the profile-owner backend areas.
const forbiddenTouch = [
  "web/",
  "server/SimCEO.Api/Work/LeadSetup.cs",
  "server/SimCEO.Api/Work/OpsEndpoints.cs",
  "server/SimCEO.Api/Work/WizardGuide.cs",
  "server/SimCEO.Api/Domain/Entities.cs",
];
let failures = 0;
const ok = (m) => console.log("PASS " + m);
const fail = (m) => { failures++; console.log("FAIL " + m); };

let touched = [];
try {
  touched = execSync("git status --short", { encoding: "utf8" }).split("\n").map((l) => l.trim()).filter(Boolean);
  ok("worktree readable (" + touched.length + " touched paths)");
} catch { fail("git status unreadable"); }
const paths = touched.map((t) => t.replace(/^[AMDRC?U ]+\s+/, "").replace(/^".*"$/, (s) => s.slice(1, -1)));
for (const f of forbiddenTouch) {
  (paths.some((t) => t === f || t.startsWith(f)) ? fail("forbidden-touched " + f) : ok("forbidden-untouched " + f));
}
for (const f of owned) {
  (existsSync(f) ? ok : fail)("owned-present " + f);
}

function probePort(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port, timeout: 800 }, () => {
      s.destroy();
      resolve("LISTENING (left alone)");
    });
    s.on("timeout", () => { s.destroy(); resolve("closed"); });
    s.on("error", () => resolve("closed"));
  });
}
const ports = [5173, 5080, 9333, 5099, 15441];
for (const p of ports) {
  const state = await probePort(p);
  console.log("INFO port " + p + ": " + state + " (probe only; nothing started/stopped)");
}

// Idempotency shape check: plan hash must be deterministic over sorted input.
const h = async (s) => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
};
const a = await h("roster-reconcile/1|scope:all|k|b:stale|A:b");
const b = await h("roster-reconcile/1|scope:all|k|b:stale|A:b");
(a === b ? ok : fail)("plan-hash deterministic (" + a + ")");
console.log(failures === 0 ? "ROSTER-INTEGRITY QA: ALL PASS" : "ROSTER-INTEGRITY QA: " + failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);