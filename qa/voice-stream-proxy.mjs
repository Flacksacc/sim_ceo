import http from "node:http";

// QA-owned streaming proxy between the browser (web 5245) and the real API
// (5125). The proxy buffers the ACTUAL upstream API response body, sends HTTP
// headers downstream immediately (flushHeaders), then withholds the JSON /
// error body until the test releases it. The App fetch therefore resolves
// headers while r.json()/r.text() stays pending. Production never changes:
// upstream gateway buffering is irrelevant to downstream proxy streaming.
// Own loopback 127.0.0.1:5126 only; never user ports, never Docker, never a
// real provider. In-process: no child, no window, closed in test finally.
//
// SEVENTH repair: SYNCHRONOUS EXCLUSIVE claim of ONE EXPECTED exact
// transcribe path BEFORE FIRST await (copy armed is not a claim). The armed
// spec is captured synchronously at request entry before any await (body
// read / upstream fetch) AND atomically claimed: only the first concurrent
// transcribe matching the expected exact path claims the arm; a second
// concurrent request under the same arm passes through held=no and never
// shares the gate or overwrites spec.op. Claimed active spec is tracked
// separately so captured release + shutdown can still resolve it; old A can
// never release/clear B. Strict exact meeting route (no substring
// fragments). Shutdown REFUSES late forwarding/body continuations without a
// NEW fetch; owned handlers/body reads/controllers are tracked and drained
// with a deadline and honest failure. No new work is re-enabled during drain.
export const PROXY_PORT = 5126;
export function proxyBase() { return "http://127.0.0.1:" + PROXY_PORT; }

export function createVoiceProxy(opts) {
  const apiBase = (opts && opts.apiBase) || "http://127.0.0.1:5125";
  const holdTimeoutMs = (opts && opts.holdTimeoutMs) || 30000;
  let server = null;
  let seq = 0;
  let stopped = false;
  let armed = null; // { kind: "hold" | "error", status, bodyText, gate, op, resolveHeld, resolveGate, expected, autoReleased }
  let claimed = null; // synchronously claimed active spec (exclusive, one request only)
  const pendingResolves = new Set();
  const inflight = new Set();
  const activeHandlers = new Set();
  const ops = [];
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }
  function fwdHeaders(h) {
    const out = {};
    for (const [k, v] of Object.entries(h || {})) {
      const lk = String(k).toLowerCase();
      if (lk === "host" || lk === "connection" || lk === "content-length" || lk === "keep-alive" || lk === "transfer-encoding" || lk === "upgrade") continue;
      out[k] = v;
    }
    return out;
  }
  function pathOnlyOf(urlPath) {
    try { return String(urlPath || "/").split("?")[0]; } catch { return "/"; }
  }
  function isStrictTranscribe(method, urlPath) {
    try {
      if (method !== "POST") return false;
      if (typeof urlPath !== "string") return false;
      const p = pathOnlyOf(urlPath);
      if (!/^\/api\/meetings\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/transcribe$/.test(p)) return false;
      return true;
    } catch { return false; }
  }
  function clearClaimIf(spec) {
    try { if (claimed === spec) claimed = null; } catch {}
  }
  function releaseSpecGate(spec) {
    try {
      if (spec && spec.resolveGate) {
        const g = spec.resolveGate;
        spec.resolveGate = null;
        spec.gate = null;
        try { g(); } catch {}
      }
    } catch {}
  }
  function disarmSpec(spec) {
    try { if (armed === spec) armed = null; } catch {}
    clearClaimIf(spec);
  }
  async function onReqInner(downReq, downRes) {
    const entryArmed = armed;
    const entryStopped = stopped;
    const entryClaimed = claimed;
    const method = downReq.method || "GET";
    const urlPath = downReq.url || "/";
    const pathOnly = pathOnlyOf(urlPath);
    let myClaim = null;
    if (entryArmed && !stopped && !entryStopped && entryClaimed === null && armed === entryArmed) {
      const strictOk = isStrictTranscribe(method, urlPath);
      const exp = entryArmed.expected || null;
      const expOk = !exp || pathOnly === exp;
      if (strictOk && expOk && (entryArmed.kind === "hold" || entryArmed.kind === "error")) {
        claimed = entryArmed;
        myClaim = entryArmed;
      }
    }
    let body = Buffer.alloc(0);
    try { body = await readBody(downReq); } catch { try { downRes.writeHead(502); downRes.end("qa proxy read failure"); } catch {} return; }
    if (stopped || entryStopped) {
      const opD = { id: "op-" + (++seq), url: urlPath, method, upstreamStatus: 0, upstreamBytes: 0, held: false, synthetic: false, headersFlushedAt: 0, bodyReleasedAt: 0, autoReleased: false, drained: true, refusedShutdown: true };
      ops.push(opD);
      try { downRes.writeHead(499, { "content-type": "text/plain", "x-qa-op": opD.id, "x-qa-held": "no" }); downRes.end("qa proxy draining: shutdown refused new upstream"); } catch {}
      opD.headersFlushedAt = Date.now();
      opD.bodyReleasedAt = Date.now();
      return;
    }
    if (myClaim && myClaim.kind === "error" && armed === myClaim) {
      const spec = myClaim;
      const text = spec.bodyText || "";
      const opId = "op-" + (++seq);
      const head = { "content-type": "text/plain", "content-length": String(Buffer.byteLength(text)), "x-qa-op": opId, "x-qa-held": "error" };
      try { downRes.writeHead(spec.status || 502, head); } catch { disarmSpec(spec); return; }
      try { downRes.flushHeaders(); } catch {}
      const op = { id: opId, url: urlPath, method, upstreamStatus: spec.status || 502, upstreamBytes: Buffer.byteLength(text), held: true, synthetic: true, headersFlushedAt: Date.now(), bodyReleasedAt: 0, autoReleased: false };
      ops.push(op);
      spec.op = op;
      if (spec.resolveHeld) { const r = spec.resolveHeld; spec.resolveHeld = null; try { r(op); } catch {} }
      const timer = setTimeout(() => { if (spec.resolveGate) { op.autoReleased = true; const g = spec.resolveGate; spec.resolveGate = null; spec.gate = null; try { g(); } catch {} } disarmSpec(spec); }, holdTimeoutMs);
      if (spec.gate) await spec.gate;
      clearTimeout(timer);
      disarmSpec(spec);
      op.bodyReleasedAt = Date.now();
      try { downRes.end(text); } catch {}
      return;
    }
    if (entryArmed && entryArmed.kind === "error" && !myClaim) {
      const opP = { id: "op-" + (++seq), url: urlPath, method, upstreamStatus: 0, upstreamBytes: 0, held: false, synthetic: false, headersFlushedAt: 0, bodyReleasedAt: 0, autoReleased: false, passthroughUnderClaimedArm: true };
      ops.push(opP);
      let upResP = null;
      let upBodyP = Buffer.alloc(0);
      const ctrlP = new AbortController();
      inflight.add(ctrlP);
      try {
        upResP = await fetch(apiBase + urlPath, {
          method: downReq.method,
          headers: fwdHeaders(downReq.headers),
          body: (downReq.method === "GET" || downReq.method === "HEAD") ? undefined : body,
          duplex: "half",
          signal: ctrlP.signal,
        });
        upBodyP = Buffer.from(await upResP.arrayBuffer());
      } catch (e) {
        inflight.delete(ctrlP);
        if (ctrlP.signal.aborted) { try { downRes.writeHead(499, { "content-type": "text/plain", "x-qa-op": "aborted" }); downRes.end("qa proxy upstream aborted"); } catch {} return; }
        try { downRes.writeHead(502, { "content-type": "text/plain", "x-qa-op": opP.id }); downRes.end("qa proxy upstream failure"); } catch {}
        return;
      }
      inflight.delete(ctrlP);
      opP.upstreamStatus = upResP.status;
      opP.upstreamBytes = upBodyP.length;
      try { downRes.writeHead(upResP.status, { "content-type": upResP.headers.get("content-type") || "application/json", "x-qa-op": opP.id, "x-qa-held": "no" }); downRes.end(upBodyP); } catch {}
      opP.headersFlushedAt = Date.now();
      opP.bodyReleasedAt = Date.now();
      return;
    }
    let upRes = null;
    let upBody = Buffer.alloc(0);
    const ctrl = new AbortController();
    inflight.add(ctrl);
    try {
      upRes = await fetch(apiBase + urlPath, {
        method: downReq.method,
        headers: fwdHeaders(downReq.headers),
        body: (downReq.method === "GET" || downReq.method === "HEAD") ? undefined : body,
        duplex: "half",
        signal: ctrl.signal,
      });
      upBody = Buffer.from(await upRes.arrayBuffer());
    } catch (e) {
      inflight.delete(ctrl);
      if (ctrl.signal.aborted) { try { downRes.writeHead(499, { "content-type": "text/plain", "x-qa-op": "aborted" }); downRes.end("qa proxy upstream aborted"); } catch {} return; }
      try { downRes.writeHead(502, { "content-type": "text/plain", "x-qa-op": "op-" + (seq + 1) }); downRes.end("qa proxy upstream failure"); } catch {}
      return;
    }
    inflight.delete(ctrl);
    if (stopped) {
      const opS = { id: "op-" + (++seq), url: urlPath, method, upstreamStatus: upRes.status, upstreamBytes: upBody.length, held: false, synthetic: false, headersFlushedAt: 0, bodyReleasedAt: 0, autoReleased: false, drained: true, refusedLateHold: true };
      ops.push(opS);
      try { downRes.writeHead(upRes.status, { "content-type": upRes.headers.get("content-type") || "application/json", "x-qa-op": opS.id, "x-qa-held": "no" }); downRes.end(upBody); } catch {}
      opS.headersFlushedAt = Date.now();
      opS.bodyReleasedAt = Date.now();
      return;
    }
    const specH = myClaim;
    const shouldHold = !!specH && specH.kind === "hold" && armed === specH && claimed === specH && isStrictTranscribe(method, urlPath) && (!specH.expected || pathOnly === specH.expected);
    const op = { id: "op-" + (++seq), url: urlPath, method, upstreamStatus: upRes.status, upstreamBytes: upBody.length, held: !!shouldHold, synthetic: false, headersFlushedAt: 0, bodyReleasedAt: 0, autoReleased: false };
    const head = {
      "content-type": upRes.headers.get("content-type") || "application/json",
      "content-length": String(upBody.length),
      "x-qa-op": op.id,
      "x-qa-held": op.held ? "body" : "no",
    };
    try { downRes.writeHead(upRes.status, head); } catch { if (shouldHold) disarmSpec(specH); return; }
    try { downRes.flushHeaders(); } catch {}
    op.headersFlushedAt = Date.now();
    ops.push(op);
    if (shouldHold) {
      const spec = specH;
      spec.op = op;
      if (spec.resolveHeld) { const r = spec.resolveHeld; spec.resolveHeld = null; try { r(op); } catch {} }
      const timer = setTimeout(() => { if (spec.resolveGate) { op.autoReleased = true; const g = spec.resolveGate; spec.resolveGate = null; spec.gate = null; try { g(); } catch {} } disarmSpec(spec); }, holdTimeoutMs);
      if (spec.gate) await spec.gate;
      clearTimeout(timer);
      disarmSpec(spec);
    }
    op.bodyReleasedAt = Date.now();
    try { downRes.end(upBody); } catch {}
  }
  function onReq(downReq, downRes) {
    const p = onReqInner(downReq, downRes);
    activeHandlers.add(p);
    p.catch(() => {}).finally(() => { try { activeHandlers.delete(p); } catch {} });
  }
  function checkApiBase() {
    let u = null;
    try { u = new URL(apiBase); } catch { u = null; }
    const host = u ? u.hostname.replace(/^\[/, "").replace(/\]$/, "") : "";
    const loop = !!u && (host === "127.0.0.1" || host === "localhost" || host === "::1");
    const secrets = !!u && (u.username !== "" || u.password !== "" || (u.search !== "" && u.search !== "?") || u.hash !== "");
    if (!u || !loop || Number(u.port) !== 5125 || u.pathname !== "/" || secrets || !/^http:$/.test(u.protocol)) {
      throw new Error("proxy apiBase must be the owned loopback API (http://127.0.0.1:5125, no path/secrets)");
    }
  }
  return {
    start() {
      return new Promise((resolve, reject) => {
        try { checkApiBase(); } catch (e) { reject(e); return; }
        if (stopped) { reject(new Error("proxy stopped: late start refused")); return; }
        server = http.createServer(onReq);
        server.on("error", reject);
        server.listen(PROXY_PORT, "127.0.0.1", () => resolve());
      });
    },
    holdNext(expectedPath) {
      if (stopped) throw new Error("proxy stopped: late hold registration refused");
      if (armed) throw new Error("proxy already armed: overlapping holds refused (release first)");
      let resolveHeld = null, resolveGate = null;
      const opPromise = new Promise((r) => { resolveHeld = (...a) => { pendingResolves.delete(resolveHeld); try { r(...a); } catch {} }; pendingResolves.add(resolveHeld); });
      const gate = new Promise((r) => { resolveGate = r; });
      let exp = null;
      try {
        if (typeof expectedPath === "string" && expectedPath) {
          exp = expectedPath.split("?")[0];
          if (!/^\/api\/meetings\/[0-9a-fA-F-]{36}\/transcribe$/.test(exp)) throw new Error("holdNext expected must be exact /api/meetings/<guid>/transcribe");
        }
      } catch (e) { try { pendingResolves.delete(resolveHeld); } catch {} throw e; }
      const spec = { kind: "hold", gate, resolveGate, op: null, resolveHeld, autoReleased: false, expected: exp };
      armed = spec;
      return {
        opPromise,
        expected: exp,
        release() { if (armed === spec && spec.resolveGate) { const g = spec.resolveGate; spec.resolveGate = null; spec.gate = null; disarmSpec(spec); try { g(); } catch {} } else if (armed === spec) { disarmSpec(spec); } },
      };
    },
    errorNext(status, bodyText, expectedPath) {
      if (stopped) throw new Error("proxy stopped: late hold registration refused");
      if (armed) throw new Error("proxy already armed: overlapping holds refused (release first)");
      let resolveHeld = null, resolveGate = null;
      const opPromise = new Promise((r) => { resolveHeld = (...a) => { pendingResolves.delete(resolveHeld); try { r(...a); } catch {} }; pendingResolves.add(resolveHeld); });
      const gate = new Promise((r) => { resolveGate = r; });
      let exp = null;
      try {
        if (typeof expectedPath === "string" && expectedPath) {
          exp = expectedPath.split("?")[0];
          if (!/^\/api\/meetings\/[0-9a-fA-F-]{36}\/transcribe$/.test(exp)) throw new Error("errorNext expected must be exact /api/meetings/<guid>/transcribe");
        }
      } catch (e) { try { pendingResolves.delete(resolveHeld); } catch {} throw e; }
      const spec = { kind: "error", status: status || 502, bodyText: bodyText || "", gate, resolveGate, op: null, resolveHeld, autoReleased: false, expected: exp };
      armed = spec;
      return {
        opPromise,
        expected: exp,
        release() { if (armed === spec && spec.resolveGate) { const g = spec.resolveGate; spec.resolveGate = null; spec.gate = null; disarmSpec(spec); try { g(); } catch {} } else if (armed === spec) { disarmSpec(spec); } },
      };
    },
    releaseAll() {
      try {
        const spec = armed;
        if (spec && spec.resolveGate) { const g = spec.resolveGate; spec.resolveGate = null; spec.gate = null; disarmSpec(spec); try { g(); } catch {} }
        else if (spec && armed === spec) { disarmSpec(spec); }
      } catch {}
      for (const r of Array.from(pendingResolves)) { pendingResolves.delete(r); try { r(null); } catch {} }
      for (const c of Array.from(inflight)) { try { c.abort(); } catch {} }
    },
    ops() { return ops.slice(); },
    opCount() { return ops.length; },
    lastOp() { return ops.length ? ops[ops.length - 1] : null; },
    isArmed() { return !!armed; },
    activeCount() { return activeHandlers.size + inflight.size; },
    stop() {
      return new Promise((resolve, reject) => {
        stopped = true;
        try {
          const spec = armed;
          if (spec && spec.resolveGate) { const g = spec.resolveGate; spec.resolveGate = null; spec.gate = null; disarmSpec(spec); try { g(); } catch {} }
          else if (spec && armed === spec) { disarmSpec(spec); }
          for (const r of Array.from(pendingResolves)) { pendingResolves.delete(r); try { r(null); } catch {} }
          for (const c of Array.from(inflight)) { try { c.abort(); } catch {} }
        } catch {}
        const finish = (err) => { if (err) { try { reject(err); } catch {} } else { try { resolve(); } catch {} } };
        if (!server) {
          const t0 = Date.now();
          const poll = () => {
            if (activeHandlers.size === 0) { finish(null); return; }
            if (Date.now() - t0 > 8000) { finish(new Error("proxy handler drain timeout: " + activeHandlers.size + " owned handlers still active")); return; }
            setTimeout(poll, 100);
          };
          poll();
          return;
        }
        try { server.closeAllConnections(); } catch {}
        let settled = false;
        const t = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (activeHandlers.size > 0) { try { server.close(() => finish(new Error("proxy handler drain timeout: " + activeHandlers.size + " owned handlers still active"))); } catch { finish(new Error("proxy handler drain timeout")); } }
          else { try { server.close(() => finish(null)); } catch { finish(null); } }
        }, 8000);
        const pollDrain = () => {
          if (settled) return;
          if (activeHandlers.size === 0 && inflight.size === 0) {
            settled = true;
            try { clearTimeout(t); } catch {}
            try { server.close(() => finish(null)); } catch { finish(null); }
            return;
          }
          setTimeout(pollDrain, 100);
        };
        try {
          server.close(() => {
            if (settled) return;
            settled = true;
            try { clearTimeout(t); } catch {}
            if (activeHandlers.size > 0) finish(new Error("proxy handler drain timeout: " + activeHandlers.size + " owned handlers still active"));
            else finish(null);
          });
        } catch { try { clearTimeout(t); } catch {} if (!settled) { settled = true; finish(null); } }
        pollDrain();
      });
    },
  };
}