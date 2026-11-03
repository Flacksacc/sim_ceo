// Owned child-process launcher for self-managed essentials legs (Muse-owned).
// Narrow QA helper, not a framework: spawn with retained handles, bounded
// waits, stdio-to-file (EOF observed via completed files, never a second
// blind wait), unexpected-exit watch, aggregated cleanup. No PID guessing,
// no shell strings (argv arrays only), hidden windows.
import { spawn } from "node:child_process";
import fs from "node:fs";

export function startOwned({ file, args, cwd, env, outFile, errFile }) {
  const out = fs.openSync(outFile, "w");
  const err = fs.openSync(errFile, "w");
  let child = null;
  try {
    child = spawn(file, args, {
      cwd, stdio: ["ignore", out, err],
      windowsHide: true, env: { ...process.env, ...env },
    });
  } catch (e) {
    try { fs.closeSync(out); } catch {}
    try { fs.closeSync(err); } catch {}
    throw new Error("spawn-failed " + file + " :: " + String((e && e.message) || e).slice(0, 300));
  }
  if (!child || !child.pid) {
    try { child && child.kill(); } catch {}
    try { fs.closeSync(out); } catch {}
    try { fs.closeSync(err); } catch {}
    throw new Error("spawn-null-handle " + file);
  }
  if (child.exitCode !== null) {
    const early = child.exitCode;
    try { fs.closeSync(out); } catch {}
    try { fs.closeSync(err); } catch {}
    throw new Error("spawn-exited-immediately " + file + " exit=" + early);
  }
  child.on("error", () => {});
  return {
    child, pid: child.pid, outFd: out, errFd: err,
    get exited() { try { return child.exitCode !== null || child.signalCode !== null; } catch { return true; } },
  };
}

export function tailOf(path, n = 8) {
  try {
    const t = fs.readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
    return t.slice(-n).join(" | ").slice(0, 600);
  } catch { return "<unreadable>"; }
}

export async function waitExit(handle, timeoutMs, label) {
  const child = handle.child;
  if (child.exitCode !== null || child.signalCode !== null) return { ok: true, code: child.exitCode };
  const done = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => { clearTimeout(t); resolve(true); });
    child.once("error", () => { clearTimeout(t); resolve(true); });
  });
  if (!done) {
    try { child.kill(); } catch {}
    const done2 = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 15000);
      child.once("exit", () => { clearTimeout(t); resolve(true); });
    });
    if (!done2) return { ok: false, note: label + " kill-timeout (still alive)" };
  }
  await new Promise((r) => setTimeout(r, 250));
  return { ok: true, code: child.exitCode };
}

// Stop + confirm EOF: handle exited, native exit present, both stdio files
// complete. Never throws; anomalies are returned for aggregation.
export async function stopOwned(handle, label, outFile, errFile) {
  if (!handle) return { ok: true, note: label + " null (already gone)" };
  try {
    const child = handle.child;
    let exited = child.exitCode !== null || child.signalCode !== null;
    if (!exited) {
      try { child.kill(); } catch (e) { return { ok: false, note: label + " kill-failed :: " + String(e && e.message).slice(0, 200) }; }
      const w = await waitExit(handle, 20000, label);
      if (!w.ok) return w;
      exited = true;
    }
    await new Promise((r) => setTimeout(r, 250));
    try { fs.closeSync(handle.outFd); } catch {}
    try { fs.closeSync(handle.errFd); } catch {}
    let outOk = false, errOk = false;
    try { outOk = fs.statSync(outFile).isFile(); } catch {}
    try { errOk = fs.statSync(errFile).isFile(); } catch {}
    if (!outOk || !errOk) return { ok: false, note: label + " stdio-eof-missing out=" + outOk + " err=" + errOk };
    return { ok: true, note: label + " stopped exit=" + child.exitCode, code: child.exitCode };
  } catch (e) {
    return { ok: false, note: label + " stop-fatal :: " + String((e && e.message) || e).slice(0, 300) };
  }
}

export async function waitForHttpOk(url, { timeoutMs = 90000, intervalMs = 1000, want = 200 } = {}) {
  const start = Date.now();
  let last = "";
  for (;;) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      const text = await r.text().catch(() => "");
      clearTimeout(t);
      if (r.status === want) return { ok: true };
      last = "status=" + r.status + " " + String(text).slice(0, 160);
    } catch (e) { clearTimeout(t); last = String((e && e.message) || e).slice(0, 120); }
    if (Date.now() - start > timeoutMs) return { ok: false, last };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}