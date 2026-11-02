import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Real production-gateway regression: builds and runs
// qa/ProviderEnvelopeProbe (production C# ModelGateway CompleteAsync /
// CompleteGroundedAsync against observed fixtures via own loopback 127.0.0.1:5202).
// This launcher contains no envelope parser and proves nothing by itself;
// the C# probe verdict in .tmp/muse-provider-probe-result.txt is the proof.
const root = dirname(fileURLToPath(import.meta.url));
const repo = dirname(root);
const proj = join(root, "ProviderEnvelopeProbe", "ProviderEnvelopeProbe.csproj");
const outDir = join(repo, ".tmp", "muse-provider-probe");
const resultFile = join(repo, ".tmp", "muse-provider-probe-result.txt");

console.log("provider-envelope-regression: real C# ModelGateway probe (no mirror parser)");
console.log("building " + proj);
mkdirSync(outDir, { recursive: true });
const b = spawnSync("dotnet", ["build", proj, "-p:SkipStagePostgres=true", "-o", outDir, "--nologo", "-v", "q"], { cwd: repo, stdio: "inherit" });
if (b.status !== 0) {
  console.error("probe build failed");
  process.exit(1);
}
const dll = join(outDir, "ProviderEnvelopeProbe.dll");
console.log("running real gateway probe on loopback 127.0.0.1:5202 ...");
const r = spawnSync("dotnet", [dll], { cwd: repo, stdio: "inherit" });
try {
  if (existsSync(resultFile)) {
    const txt = readFileSync(resultFile, "utf8");
    console.log("--- " + resultFile + " ---");
    console.log(txt);
  } else {
    console.error("result file missing: " + resultFile);
  }
} catch (e) {
  console.error("cannot read result: " + (e && e.message ? e.message : e));
}
if (r.status !== 0) {
  console.error("REAL-PROBE failed");
  process.exit(r.status ?? 1);
}
console.log("provider-envelope-regression REAL-PROBE accepted (see result file for 8 real C# cases)");
