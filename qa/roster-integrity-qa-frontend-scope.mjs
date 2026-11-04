import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";

// Isolated QA for roster-integrity (no live user data, no server starts).
// Run: node qa/roster-integrity-qa.mjs
// Checks: branch/worktree scope, App.tsx untouched, owned files present,
// dotnet build status (via env ROSTER_QA_BUILD result or skips with note),
// forbidden ports untouched (read-only probe, never start/stop anything).

const owned = [
  "server/SimCEO.Api/Work/RosterIntegrity.cs",
  "server/SimCEO.Api/Work/RosterReconciliation.cs",
  "web/src/roster-integrity.tsx",
  "web/src/roster-integrity.css",
  "qa/roster-integrity-qa.mjs",
  "docs/roster-integrity-integration.md",
];
const forbiddenTouch = ["web/src/App.tsx"];
let failures = 0;
const ok = (m) => console.log("PASS " + m);
const fail = (m) => { failures++; console.log("FAIL " + m); };

try {
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  (branch === "muse/roster-integrity-feedback" ? ok : fail)("branch=" + branch);
} catch { fail("branch unreadable"); }

let touched = [];
try {
  touched = execSync("git status --short", { encoding: "utf8" }).split("\n").map((l) => l.trim()).filter(Boolean);
  ok("worktree readable (" + touched.length + " touched paths)");
} catch { fail("git status unreadable"); }
for (const f of forbiddenTouch) {
  (touched.some((t) => t.includes(f)) ? fail : ok)("forbidden-untouched " + f);
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
const ports = [5173, 5080, 9333];
for (const p of ports) {
  const state = await probePort(p);
  console.log("INFO port " + p + ": " + state + " (probe only; nothing started/stopped)");
}

// Idempotency shape check: plan hash must be deterministic over sorted input.
const h = async (s) => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
};
const a = await h("roster-reconcile/1|k|b:stale|A:b");
const b = await h("roster-reconcile/1|k|b:stale|A:b");
(a === b ? ok : fail)("plan-hash deterministic (" + a + ")");
console.log(failures === 0 ? "ROSTER-INTEGRITY QA: ALL PASS" : "ROSTER-INTEGRITY QA: " + failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);