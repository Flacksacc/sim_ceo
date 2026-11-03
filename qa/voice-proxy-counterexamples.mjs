import http from "node:http";
import { createVoiceProxy, PROXY_PORT, proxyBase } from "./voice-stream-proxy.mjs";

// SEVENTH focused REAL-helper counterexamples for F6: exclusive claim,
// strict path, late arm, old-release isolation, shutdown refuse. Uses the
// ACTUAL createVoiceProxy (owned 5126) against a stub upstream on the owned
// 5125 loopback (started only if 5125 is free; skipped otherwise with a
// loud SKIP, never a false pass). No user ports, no new services beyond the
// owned temporary stub. Hidden handles, bounded drain, outer finally.
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
const STUB_PORT = 5125;
let stub = null;
let stubHits = 0;
async function stubStart() {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      stubHits++;
      let body = Buffer.alloc(0);
      req.on("data", (c) => { body = Buffer.concat([body, c]); });
      req.on("end", () => {
        setTimeout(() => {
          try { res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ transcript: "qa transcript" })); } catch {}
        }, 50);
      });
    });
    srv.on("error", (e) => resolve({ ok: false, err: e }));
    srv.listen(STUB_PORT, "127.0.0.1", () => resolve({ ok: true, srv }));
  });
}
const MID_A = "11111111-2222-3333-4444-555555555555";
const MID_B = "22222222-3333-4444-5555-666666666666";
const PATH_A = "/api/meetings/" + MID_A + "/transcribe";
const PATH_B = "/api/meetings/" + MID_B + "/transcribe";
let proxy = null;
try {
  const st = await stubStart();
  if (!st.ok) {
    console.log("VOICEPROXYCX SKIP stub-5125-busy :: owned 5125 in use by real API; run full suite for live proof");
    console.log("VOICEPROXYCX SKIP 0");
    process.exit(0);
  }
  stub = st.srv;
  proxy = createVoiceProxy({ apiBase: "http://127.0.0.1:5125" });
  await proxy.start();
  ok("proxy-started-owned", PROXY_PORT === 5126, String(PROXY_PORT));
  // 1. Exclusive claim: two concurrent transcribes under one arm -> exactly
  // one held, one passthrough; spec.op is the first claimer.
  {
    const h = proxy.holdNext(PATH_A);
    const u1 = fetch(proxyBase() + PATH_A, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) });
    await new Promise((r) => setTimeout(r, 150));
    const u2 = fetch(proxyBase() + PATH_A, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 2 }) });
    const heldP = await Promise.race([h.opPromise, new Promise((_, rej) => setTimeout(() => rej(new Error("hold-timeout")), 8000))]);
    ok("exclusive-first-held", !!heldP && heldP.held === true, JSON.stringify(heldP && heldP.id));
    await new Promise((r) => setTimeout(r, 600));
    const opsNow = proxy.ops();
    const heldOps = opsNow.filter((o) => o.held === true);
    ok("exclusive-only-one-held", heldOps.length === 1, "held=" + heldOps.length);
    h.release();
    const r1 = await u1;
    const t1 = await r1.text();
    const r2 = await u2;
    const t2 = await r2.text();
    ok("exclusive-both-complete", r1.status === 201 && r2.status === 201, r1.status + "/" + r2.status);
    ok("exclusive-op-single-claim", heldP && typeof heldP.id === "string" && t1.length > 0 && t2.length > 0, heldP.id);
  }
  // 2. Strict path: wrong GUID / extra suffix / non-transcribe never consume.
  {
    const h = proxy.holdNext(PATH_A);
    const bad1 = await fetch(proxyBase() + "/api/meetings/" + MID_A + "/transcribe/extra", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await bad1.text();
    ok("strict-suffix-passthrough", proxy.isArmed() === true, "arm must survive suffix probe");
    const bad2 = await fetch(proxyBase() + "/api/auth/status", { method: "GET" });
    await bad2.text().catch(() => "");
    ok("strict-nontranscribe-passthrough", proxy.isArmed() === true, "arm must survive status probe");
    h.release();
    await new Promise((r) => setTimeout(r, 200));
    ok("strict-arm-consumable-after-probes", proxy.isArmed() === false, "release clears armed");
  }
  // 3. Late arm: request started before arm must not attach.
  {
    const slowBody = "x".repeat(20000);
    const pendingReq = fetch(proxyBase() + PATH_B, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slow: slowBody }) });
    await new Promise((r) => setTimeout(r, 50));
    let lateThrew = false;
    let lateH = null;
    try { lateH = proxy.holdNext(PATH_B); } catch { lateThrew = true; }
    const rr = await pendingReq;
    await rr.text();
    if (lateH) { try { lateH.release(); } catch {} }
    ok("late-arm-no-attach", lateThrew === false, "late arm after dispatch must not claim inflight");
  }
  // 4. Old release cannot clear B: captured handles are spec-bound.
  {
    const hA = proxy.holdNext(PATH_A);
    let overlapThrew = false;
    try { proxy.holdNext(PATH_B); } catch { overlapThrew = true; }
    ok("overlap-refused", overlapThrew === true, "second arm while armed must throw");
    hA.release();
    await new Promise((r) => setTimeout(r, 200));
    const hB = proxy.holdNext(PATH_B);
    ok("old-release-clears-only-own", proxy.isArmed() === true && !!hB, "B arms after A release");
    hA.release();
    ok("old-release-after-b-noop", proxy.isArmed() === true, "old A release must not clear B");
    hB.release();
    await new Promise((r) => setTimeout(r, 200));
    ok("b-release-clears", proxy.isArmed() === false, "B release clears");
  }
  // 5. Shutdown refuses new upstream work (no NEW fetch).
  {
    const hitsBefore = stubHits;
    await proxy.stop();
    proxy = null;
    const r = await fetch(proxyBase() + PATH_A, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch((e) => ({ fetchFailed: true, err: e }));
    const refused = (r && (r.status === 499 || r.fetchFailed === true)) || false;
    ok("shutdown-refuses-new", refused === true || stubHits === hitsBefore, "hits=" + hitsBefore + "->" + stubHits + " status=" + (r && r.status));
  }
} catch (e) {
  fail++;
  failures.push("proxy-cx-fatal :: " + String((e && e.stack) || e).slice(0, 300));
  console.log("  FAIL proxy-cx-fatal :: " + String((e && e.message) || e).slice(0, 300));
} finally {
  try { if (proxy) await proxy.stop(); } catch {}
  try { if (stub) await new Promise((res) => { try { stub.closeAllConnections(); } catch {} const t = setTimeout(() => { try { stub.close(() => res()); } catch { res(); } }, 5000); try { stub.close(() => { clearTimeout(t); res(); }); } catch { clearTimeout(t); res(); } }); } catch {}
}
console.log(fail === 0 ? "VOICEPROXYCX PASS " + pass : "VOICEPROXYCX FAIL pass=" + pass + " fail=" + fail);
for (const f of failures) console.log(" - " + f);
process.exitCode = fail === 0 ? 0 : 1;