// leg0: root-configuration contract (NO backend needed).
// Validates: ProjectRoot (defaults to QA worktree script root) supports an
// actual Approot; owned ports 5142/5242/5194; forbidden user/backend/shared
// ports absent; owned PG container FULL identity file present; fresh run id
// bound; required env bound. Exit nonzero on ANY failure.
// This run is CONTRACT-ONLY, never acceptance.
import fs from "node:fs";
import path from "node:path";
import { makeCtx, API, FAKE } from "../helpers/essentials-http.mjs";

const ctx = makeCtx("leg0");
const WEB = process.env.QA_WEB || "http://127.0.0.1:5194";
const projectRoot = process.env.ESS_QA_PROJECTROOT || "";
const approot = process.env.ESS_QA_APPROOT || "";
const head = process.env.ESS_QA_HEAD || "";
const dirtyHash = process.env.ESS_QA_DIRTY_HASH || "";
const runId = process.env.ESS_QA_RUN_ID || "";
const FULL_ID = "14bcfcf7a243e5bc73385da4d24a33475b6eab0b04b8185e1d1534c13d1a1891";

ctx.ok("env-projectroot-set", projectRoot.length > 0, "ESS_QA_PROJECTROOT missing");
ctx.ok("env-approot-set", approot.length > 0, "ESS_QA_APPROOT missing");
ctx.ok("env-head-set", /^[0-9a-f]{40}$/.test(head), "ESS_QA_HEAD=" + head.slice(0, 20));
ctx.ok("env-dirty-hash-set", /^[0-9a-f]{64}$/.test(dirtyHash), "dirty hash malformed");
ctx.ok("env-run-id-set", /^[0-9a-f]{32}$/.test(runId), "ESS_QA_RUN_ID missing (fresh per-run artifacts required)");

// Owned-port contract: QA_API must be 5142, QA_FAKE 5242, QA_WEB 5194.
function portOf(u) {
  try { return Number(new URL(u).port); } catch { return -1; }
}
ctx.ok("api-owned-port", portOf(API) === 5142, "QA_API=" + API);
ctx.ok("fake-owned-port", portOf(FAKE) === 5242, "QA_FAKE=" + FAKE);
ctx.ok("web-owned-port", portOf(WEB) === 5194, "QA_WEB=" + WEB);

// Forbidden: never user data (5080/5173), shared CDP (9333), backend-owned
// (5140/5240/5193), legacy QA ports, or any foreign project ports.
const FORBIDDEN = ["5080", "5173", "9333", "5140", "5240", "5193", "5099", "5100", "5115", "5121", "5221", "5199", "5174", "5230", "15442", "15432", "5432", "3000", "18088", "54329"];
for (const bad of FORBIDDEN) {
  ctx.ok("forbidden-port-" + bad, !API.includes(":" + bad) && !FAKE.includes(":" + bad) && !WEB.includes(":" + bad), API + " " + FAKE + " " + WEB);
}

// ProjectRoot markers (QA worktree): the runner itself + proven fixtures.
for (const rel of ["qa/essentials/run-essentials.ps1", "qa/fixtures.cjs", "qa/voice-wav.mjs", "qa/fake-provider.mjs", "SimCEO.sln"]) {
  const p = path.join(projectRoot, rel);
  ctx.ok("projectroot-marker-" + rel.replace(/[^a-z0-9]+/gi, "-"), fs.existsSync(p), p);
}

// Approot markers (runnable app root): real solution + API + web.
for (const rel of ["SimCEO.sln", "server/SimCEO.Api/SimCEO.Api.csproj", "web/src/App.tsx", "server/SimCEO.Api/Work/Secretary.cs"]) {
  const p = path.join(approot, rel);
  ctx.ok("approot-marker-" + rel.replace(/[^a-z0-9]+/gi, "-"), fs.existsSync(p), p);
}

// Approot must not BE the QA worktree and must not be user CWD junk.
ctx.ok("approot-distinct", path.resolve(approot) !== path.resolve(projectRoot), approot);
ctx.ok("approot-abs", path.isAbsolute(approot), approot);

// Container identity proof file (written by the runner after docker inspect).
const identFile = process.env.ESS_QA_CONTAINER_IDENT || "";
ctx.ok("env-container-ident-set", identFile.length > 0, "ESS_QA_CONTAINER_IDENT missing");
if (identFile) {
  let ident = null;
  try { ident = JSON.parse(fs.readFileSync(identFile, "utf8")); } catch (e) { ident = null; }
  ctx.ok("container-ident-readable", !!ident, identFile);
  if (ident) {
    ctx.ok("container-id-full", String(ident.id || "") === FULL_ID, String(ident.id).slice(0, 32) + "...");
    ctx.ok("container-image", String(ident.image || "") === "postgres:16-alpine", String(ident.image));
    ctx.ok("container-port", String(ident.ports || "").includes("15441"), String(ident.ports));
  }
}

process.exit(ctx.verdict());