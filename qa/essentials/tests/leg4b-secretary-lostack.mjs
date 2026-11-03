// leg4b: unknown-success (lost acknowledgement) adoption for the Secretary
// assistant, via a QA-owned in-process harness around the REAL PostgresBackend
// (needs owned PG + owned fake; SELF-MANAGED: the runner creates/drops ONLY
// the exclusive DB; this leg owns its fake child + the harness process).
// The harness hosts the ACTUAL Secretary endpoint mappings in-process with
// the REAL PostgresBackend + a QA-owned post-commit interceptor: the actual
// EF commit SUCCEEDS, then a transport-level TimeoutException (lost ACK) is
// thrown ONCE for the publication unit. The actual handler must reconcile
// and the same-nonce retry must ADOPT the committed request/owner: one
// terminal completed owner, one note, NO second provider dispatch, NO second
// ledger pair, BOTH ledgers complete with prior rows intact. A reservation
// fault or an immediate trigger failure is NOT this scenario. Exit nonzero
// on ANY failure. No production edits, no shipping hooks, no secrets logged.
import fs from "node:fs";
import path from "node:path";
import { makeCtx, FAKE } from "../helpers/essentials-http.mjs";
import { verifyContainer, tableList } from "../helpers/essentials-pg.mjs";
import { startOwned, stopOwned, waitExit, waitForHttpOk } from "../helpers/essentials-proc.mjs";

const ctx = makeCtx("leg4b");
const ART = process.env.ESS_QA_ARTIFACT_DIR || ".";
const PROJECTROOT = process.env.ESS_QA_PROJECTROOT || ".";
const DB = process.env.ESS_QA_DB || "";
const CONN = process.env.ESS_QA_PG_CONN || "";
const run = "ess4b-" + Date.now().toString(36);
const HARNESS_PROJ = path.join(PROJECTROOT, "qa/essentials/probe/LostAckAdoption/LostAckAdoption.csproj");
const sleepMs = 8000;
let fakeH = null;

try {
  ctx.ok("env-db", !!DB && /^essentials_[a-z0-9_]+$/.test(DB), "ESS_QA_DB=" + DB);
  ctx.ok("env-conn", !!CONN && CONN.includes("Database=" + DB), "ESS_QA_PG_CONN present for own DB (value never logged)");
  ctx.ok("env-proj", fs.existsSync(HARNESS_PROJ), HARNESS_PROJ);
  if (!DB || !CONN || !fs.existsSync(HARNESS_PROJ)) throw new Error("leg4b env missing");
  verifyContainer();
  ctx.ok("container-verified", true, "owned 14bcfcf7 running");
  // Fresh exclusive DB must exist and be EMPTY (runner created it).
  const tables = tableList(DB);
  ctx.ok("db-empty-before-harness", tables.length === 0, "tables=" + tables.join(",").slice(0, 200));
  // Build the QA-owned harness (against the frozen ae server sources).
  const binDir = path.join(ART, "harness-bin");
  fs.mkdirSync(binDir, { recursive: true });
  {
    const out = path.join(ART, "harness-build.log"), err = path.join(ART, "harness-build.err.log");
    const bp = startOwned({ file: "dotnet", args: ["build", HARNESS_PROJ, "-o", binDir, "--nologo", "-v", "q"], cwd: PROJECTROOT, env: {}, outFile: out, errFile: err });
    const w = await waitExit(bp, 420000, "harness-build");
    ctx.ok("harness-build-exit0", w.ok && w.code === 0, "ok=" + w.ok + " exit=" + w.code + " (see harness-build.log)");
    await stopOwned(bp, "harness-build", out, err);
    if (!w.ok || w.code !== 0) throw new Error("harness build failed");
    const exe = path.join(binDir, "LostAckAdoption.exe");
    const dll = path.join(binDir, "LostAckAdoption.dll");
    ctx.ok("harness-artifact", fs.existsSync(exe) || fs.existsSync(dll), "exe=" + fs.existsSync(exe) + " dll=" + fs.existsSync(dll));
  }
  // Owned fake provider (hidden, retained handle, bounded startup).
  {
    const fakePort = String(new URL(FAKE).port || "5242");
    const out = path.join(ART, "fake.log"), err = path.join(ART, "fake.err.log");
    fakeH = startOwned({ file: "node.exe", args: ["qa/essentials/helpers/essentials-fake.mjs", "--port", fakePort], cwd: PROJECTROOT, env: {}, outFile: out, errFile: err });
    const w = await waitForHttpOk(FAKE + "/__health", { timeoutMs: 30000 });
    ctx.ok("fake-ready", w.ok, w.ok ? "owned fake up" : String(w.last).slice(0, 200));
    if (!w.ok) throw new Error("owned fake never healthy: " + w.last);
  }
  // Run the harness: it drives real HTTP against its in-process host.
  {
    const binDir2 = path.join(ART, "harness-bin");
    const exe = path.join(binDir2, "LostAckAdoption.exe");
    const useExe = fs.existsSync(exe);
    const target = useExe ? exe : "dotnet";
    const targs = useExe ? [] : [path.join(binDir2, "LostAckAdoption.dll")];
    const out = path.join(ART, "harness-stdout.log"), err = path.join(ART, "harness-stderr.log");
    const h = startOwned({
      file: target, args: [...targs, "--conn", CONN, "--art", ART, "--nonce", "nl-" + run, "--tag", run, "--sleep", String(sleepMs)],
      cwd: binDir2, env: { META_API_BASE: FAKE, META_API_KEY: "qa-dummy", WIKI_KEYRING_DIR: path.join(ART, "wiki-keyring") }, outFile: out, errFile: err,
    });
    const w = await waitExit(h, 300000, "harness");
    ctx.ok("harness-bounded-exit", w.ok, "ok=" + w.ok + " exit=" + w.code);
    await stopOwned(h, "harness", out, err);
    let stdout = "";
    try { stdout = fs.readFileSync(out, "utf8"); } catch {}
    const listen = (stdout.match(/LISTEN=(http:\/\/[^\s]+)/) || [])[1] || "";
    ctx.ok("harness-listened-loopback", /^http:\/\/127\.0\.0\.1:\d+$/.test(listen), "listen=" + listen);
    const verdict = /LOSTACK PASS/.test(stdout);
    ctx.ok("harness-verdict-pass", verdict && w.ok && w.code === 0, "exit=" + w.code + " verdict=" + (verdict ? "PASS" : "NOT-PASS"));
    const resPath = path.join(ART, "lostack-result.json");
    ctx.ok("harness-artifact-result", fs.existsSync(resPath), "lostack-result.json present=" + fs.existsSync(resPath));
    if (fs.existsSync(resPath)) {
      try {
        const res = JSON.parse(fs.readFileSync(resPath, "utf8"));
        ctx.ok("harness-result-shape", !!res.reqId && !!res.noteId && !!res.pair, "req=" + String(res.reqId).slice(0, 8) + " note=" + String(res.noteId).slice(0, 8) + " pair=" + String(res.pair).slice(0, 8));
        ctx.ok("harness-provider-stable", res.providerStable === true, "no second provider dispatch=" + res.providerStable);
      } catch (e) { ctx.ok("harness-result-parse", false, String(e).slice(0, 160)); }
    }
    // Every harness check line must be ok: no FAIL lines allowed.
    const failLines = stdout.split("\n").filter((l) => l.trim().startsWith("FAIL"));
    ctx.ok("harness-zero-fail-lines", failLines.length === 0, failLines.slice(0, 3).join(" | ").slice(0, 300));
    if (!w.ok || w.code !== 0 || !verdict) throw new Error("harness did not pass (see harness-stdout.log)");
  }
} catch (e) {
  ctx.ok("leg4b-fatal", false, String((e && e.message) || e).slice(0, 400));
} finally {
  if (fakeH) {
    const r = await stopOwned(fakeH, "fake-leg4b", path.join(ART, "fake.log"), path.join(ART, "fake.err.log"));
    if (!r.ok) ctx.ok("leg4b-fake-cleanup", false, r.note);
    else ctx.ok("leg4b-fake-cleaned", true, r.note);
    fakeH = null;
  } else {
    ctx.ok("leg4b-fake-cleaned", true, "fake never started or already stopped");
  }
}

process.exit(ctx.verdict());
