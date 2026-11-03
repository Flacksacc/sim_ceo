// preserve-browser-drafts.mjs (Muse, source-only)
// READONLY operational backup of human unsent drafts from the operator's own
// browser via explicit CDP targets. No dependencies (Node built-ins only:
// global fetch + global WebSocket + fs/path/url).
//
// What it does:
//   1. GET {cdp}/json/list (readonly) and match ONLY explicitly allowlisted
//      existing target IDs (never discovers/owns all targets).
//   2. Opens ONE WebSocket per allowlisted target, checks the live page origin
//      is localhost/127.x loopback :5173, then runs READONLY Runtime.evaluate
//      captures (route + nonsecret params, scoped draft/recovery localStorage
//      keys, visible unsent field metadata). No DOM mutation, no navigation,
//      no clicks/keys/resize/activation, no Browser.close / Target.close /
//      createPage. Only its own WS connections are closed.
//   3. Writes ONE private UTF-8 (no BOM) JSON file to an explicit --out path
//      that must live under a `.tmp` segment (ignored scratch). Prints ONLY
//      public console fields: out path, allowlisted count, per-target status,
//      draft/field counts, error summary. Never prints secret or draft values.
//
// What it NEVER does: reapply/restore drafts, touch approvals/credentials,
//   read simceo-token/session/API-key/credential keys, store to memory or Git.
//
// Usage (do NOT run during primary final-cutover use; syntax check only):
//   node qa/essentials-backend/preserve-browser-drafts.mjs `
//     --out "C:/Users/War/scrach/sim_ceo/.tmp/browser-drafts/browser-drafts-<ts>.json" `
//     --cdp "http://127.0.0.1:9333" `
//     --targets "71766AA22DFF97E3F3C4EFDA148A9794,0A36D2AB172DF5B20D9843DDA9834293"
import fs from "node:fs";
import path from "node:path";

const DEFAULT_CDP = "http://127.0.0.1:9333";
const ALLOWLISTED_IDS = [
  "71766AA22DFF97E3F3C4EFDA148A9794",
  "0A36D2AB172DF5B20D9843DDA9834293",
];
const ALLOW = new Set(ALLOWLISTED_IDS);
const ALLOWED_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);
const HTTP_TIMEOUT_MS = 6000;
const WS_TIMEOUT_MS = 6000;
const EVAL_TIMEOUT_MS = 9000;
const PER_TARGET_BUDGET_MS = 25000;
const MAX_STORAGE_KEYS = 50;
const MAX_VALUE_CHARS = 2000;
const MAX_FIELDS = 100;
const MAX_FIELD_VALUE_CHARS = 1000;
const MAX_LABEL_CHARS = 120;

function argValue(name, dflt) {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  return process.argv[i + 1];
}
function usageError(msg) {
  console.error(JSON.stringify({ ok: false, error: msg,
    usage: "node qa/essentials-backend/preserve-browser-drafts.mjs --out <MAIN.tmp/*.json> [--cdp http://127.0.0.1:9333] [--targets id1,id2]" }));
  process.exit(1);
}

const CDP = argValue("--cdp", DEFAULT_CDP);
const TARGETS_RAW = argValue("--targets", ALLOWLISTED_IDS.join(","));
const OUT = argValue("--out", "");
if (!OUT) usageError("missing required --out <MAIN.tmp/*.json>");
if (!CDP.startsWith("http://127.0.0.1:9333")) usageError("only --cdp http://127.0.0.1:9333 is supported");
const requestedIds = TARGETS_RAW.split(",").map((s) => s.trim()).filter(Boolean);
if (requestedIds.length === 0) usageError("empty --targets");
for (const id of requestedIds) {
  if (!ALLOW.has(id)) {
    console.error(JSON.stringify({ ok: false, error: "target-not-allowlisted", id }));
    process.exit(2);
  }
}
const resolvedOut = path.resolve(OUT);
const outSegments = resolvedOut.split(path.sep);
if (!outSegments.some((seg) => seg === ".tmp")) usageError("--out must live under a MAIN .tmp segment (ignored scratch)");
if (!resolvedOut.toLowerCase().endsWith(".json")) usageError("--out must be a .json path");

async function fetchJsonList(cdpBase) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("http-timeout")), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(cdpBase.replace(/\/$/, "") + "/json/list", { signal: ctrl.signal });
    if (!res.ok) throw new Error("list-http-" + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(url); }
    catch (e) { reject(e); return; }
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("ws-connect-timeout")); }, WS_TIMEOUT_MS);
    const onOpen = () => { clearTimeout(timer); cleanup(); resolve(ws); };
    const onError = (ev) => { clearTimeout(timer); cleanup(); reject(new Error("ws-connect-error")); };
    const cleanup = () => {
      if (ws.removeEventListener) { ws.removeEventListener("open", onOpen); ws.removeEventListener("error", onError); }
      else { ws.onopen = null; ws.onerror = null; }
    };
    if (ws.addEventListener) { ws.addEventListener("open", onOpen); ws.addEventListener("error", onError); }
    else { ws.onopen = onOpen; ws.onerror = onError; }
    if (ws.readyState === 1) { clearTimeout(timer); cleanup(); resolve(ws); }
  });
}

function cdpEvaluate(ws, expression) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9) + 1;
    const timer = setTimeout(() => { detach(); reject(new Error("evaluate-timeout")); }, EVAL_TIMEOUT_MS);
    const onMessage = (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); }
      catch { return; }
      if (!msg || msg.id !== id) return;
      clearTimeout(timer); detach();
      if (msg.error) reject(new Error("evaluate-error:" + (msg.error.message || "cdp")));
      else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
    };
    const onErr = () => { clearTimeout(timer); detach(); reject(new Error("ws-error")); };
    const detach = () => {
      if (ws.removeEventListener) { ws.removeEventListener("message", onMessage); ws.removeEventListener("error", onErr); }
    };
    if (ws.addEventListener) { ws.addEventListener("message", onMessage); ws.addEventListener("error", onErr); }
    else { ws.onmessage = onMessage; ws.onerror = onErr; }
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: false } }));
  });
}

function closeOwnedWs(ws) {
  try { if (ws && ws.readyState === 1) ws.close(); } catch {}
}

// Readonly origin probe: no storage/DOM access, location only.
const ORIGIN_PROBE = "(() => ({ href: String(location.href), origin: String(location.origin) }))()";

// Readonly draft capture. No mutation, no events, no navigation. Bounded.
const DRAFT_CAPTURE = `(() => {
  const trunc = (s, n) => { s = String(s ?? ""); return { text: s.slice(0, n), len: s.length, truncated: s.length > n }; };
  const SAFE_PARAMS = new Set(["boardId","board","meetingId","meeting","recordId","record","step","tab","view"]);
  const SECRET_RE = /token|session|api[_-]?key|apikey|secret|password|auth|credential|bearer|code|state/i;
  const DRAFT_RE = /draft|recover|unsent|autosave|auto-save|backup/i;
  const SECRET_KEY_RE = /token|session|api[_-]?key|apikey|credential|secret|auth|password|bearer|simceo-token/i;
  const SECRET_FIELD_RE = /token|api[_-]?key|apikey|secret|password|passwd|pwd|auth|credential|session|bearer/i;
  const out = { url: "", route: "", paramsKept: {}, paramsDropped: 0,
    storageScanned: 0, storageSkippedSecret: 0, storageKeys: [], fieldScanned: 0, fields: [] };
  try { out.url = String(location.origin) + String(location.pathname); } catch {}
  try { out.route = String(location.pathname) + String(location.hash || ""); } catch {}
  try {
    const sp = new URLSearchParams(location.search || "");
    for (const [k, v] of sp) {
      if (SAFE_PARAMS.has(k) && !SECRET_RE.test(k)) {
        if (Object.keys(out.paramsKept).length < 10) out.paramsKept[k] = String(v).slice(0, ${MAX_LABEL_CHARS});
      } else out.paramsDropped++;
    }
  } catch {}
  try {
    const keys = Object.keys(localStorage || {});
    out.storageScanned = keys.length;
    for (const k of keys) {
      if (out.storageKeys.length >= ${MAX_STORAGE_KEYS}) break;
      if (!DRAFT_RE.test(k)) continue;
      if (SECRET_KEY_RE.test(k)) { out.storageSkippedSecret++; continue; }
      let raw = "";
      try { raw = localStorage.getItem(k) ?? ""; } catch { continue; }
      const t = trunc(raw, ${MAX_VALUE_CHARS});
      out.storageKeys.push({ k: String(k).slice(0, ${MAX_LABEL_CHARS}), len: t.len, truncated: t.truncated, preview: t.text });
    }
  } catch {}
  try {
    const els = document.querySelectorAll("textarea, input, select, [contenteditable='true'], [contenteditable='']");
    out.fieldScanned = els.length;
    for (const el of els) {
      if (out.fields.length >= ${MAX_FIELDS}) break;
      const tag = (el.tagName || "").toLowerCase();
      const type = String(el.getAttribute ? (el.getAttribute("type") || "") : "").toLowerCase();
      if (["password","hidden","file","submit","button"].includes(type)) continue;
      const id = String(el.id || ""), name = String(el.name || "");
      const ph = String(el.getAttribute ? (el.getAttribute("placeholder") || "") : "");
      const aria = String(el.getAttribute ? (el.getAttribute("aria-label") || "") : "");
      if (SECRET_FIELD_RE.test(id + " " + name + " " + ph + " " + aria)) continue;
      let r = null;
      try { r = el.getBoundingClientRect(); } catch {}
      if (!r || (!(r.width || r.height))) continue;
      let label = aria || ph || name || id || tag;
      try {
        if (id) { const lab = document.querySelector("label[for='" + CSS.escape(id) + "']"); if (lab && lab.textContent) label = lab.textContent; }
        if ((!aria && !ph) && el.closest) { const lab2 = el.closest("label"); if (lab2 && lab2.textContent) label = lab2.textContent; }
      } catch {}
      label = String(label || tag).replace(/\\s+/g, " ").trim().slice(0, ${MAX_LABEL_CHARS});
      let kind = tag + (type ? ("[" + type + "]") : "");
      let val = "";
      try {
        if (tag === "select") {
          const sel = el; val = String(sel.options && sel.options[sel.selectedIndex] ? (sel.options[sel.selectedIndex].text || sel.value) : sel.value || "");
        } else if (type === "checkbox" || type === "radio") {
          val = (el.checked ? "checked:" : "unchecked:") + String(el.value || "on");
        } else if (el.isContentEditable) { val = String(el.textContent || ""); }
        else { val = String(el.value ?? ""); }
      } catch {}
      if (!val) continue;
      const t = trunc(val, ${MAX_FIELD_VALUE_CHARS});
      out.fields.push({ kind: kind.slice(0, 32), label, len: t.len, truncated: t.truncated, preview: t.text });
    }
  } catch {}
  return out;
})()`;

async function backupOneTarget(list, targetId) {
  const started = Date.now();
  const entry = (Array.isArray(list) ? list : []).find((t) => t && t.id === targetId);
  if (!entry || !entry.webSocketDebuggerUrl) {
    return { id: targetId, ok: false, status: "missing", route: "", draftKeys: 0, fields: 0, error: "target-unavailable-via-json-list" };
  }
  let ws = null;
  try {
    ws = await connectWs(entry.webSocketDebuggerUrl);
    const originInfo = await cdpEvaluate(ws, ORIGIN_PROBE);
    const origin = originInfo && originInfo.origin;
    if (!ALLOWED_ORIGINS.has(origin)) {
      return { id: targetId, ok: false, status: "blocked-origin", route: "", draftKeys: 0, fields: 0,
        error: "origin-not-loopback-5173", _cap: null };
    }
    const cap = await cdpEvaluate(ws, DRAFT_CAPTURE);
    if (Date.now() - started > PER_TARGET_BUDGET_MS) throw new Error("per-target-budget-exceeded");
    return { id: targetId, ok: true, status: "backed-up", route: String((cap && cap.route) || ""),
      paramsKept: (cap && cap.paramsKept) || {}, draftKeys: (cap && cap.storageKeys ? cap.storageKeys.length : 0),
      fields: (cap && cap.fields ? cap.fields.length : 0), error: "", _cap: cap };
  } catch (e) {
    return { id: targetId, ok: false, status: "error", route: "", draftKeys: 0, fields: 0, error: String((e && e.message) || e).slice(0, 160) };
  } finally {
    closeOwnedWs(ws);
  }
}

const list = await fetchJsonList(CDP).catch((e) => {
  console.error(JSON.stringify({ ok: false, error: "cdp-list-unreachable", cdp: CDP, detail: String((e && e.message) || e).slice(0, 160) }));
  process.exit(1);
});

const results = [];
for (const id of requestedIds) {
  results.push(await backupOneTarget(list, id));
}

const okOnes = results.filter((r) => r.ok);
const payload = {
  tool: "preserve-browser-drafts.mjs",
  readonly: true, backupOnly: true, neverReapplies: true,
  cdp: CDP, allowlistedIds: requestedIds,
  capturedAt: new Date().toISOString(),
  originAllowlist: [...ALLOWED_ORIGINS],
  limits: { maxStorageKeys: MAX_STORAGE_KEYS, maxValueChars: MAX_VALUE_CHARS, maxFields: MAX_FIELDS,
    maxFieldValueChars: MAX_FIELD_VALUE_CHARS, maxLabelChars: MAX_LABEL_CHARS,
    httpTimeoutMs: HTTP_TIMEOUT_MS, wsTimeoutMs: WS_TIMEOUT_MS, evalTimeoutMs: EVAL_TIMEOUT_MS },
  note: "Scoped human draft/recovery backup only. Credential/token/session/API-key keys and secret fields excluded at capture. Run only against operator-owned loopback :5173 pages.",
  targets: results.map((r) => ({
    id: r.id, ok: r.ok, status: r.status, route: r.route,
    paramsKept: r.paramsKept || {}, draftKeys: r.draftKeys, fields: r.fields, error: r.error || "",
    ...(r.ok && r._cap ? { storage: r._cap.storageKeys, storageScanned: r._cap.storageScanned,
      storageSkippedSecret: r._cap.storageSkippedSecret, fieldScanned: r._cap.fieldScanned, capturedFields: r._cap.fields,
      url: r._cap.url, paramsDropped: r._cap.paramsDropped } : {}),
  })),
};

fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
fs.writeFileSync(resolvedOut, JSON.stringify(payload, null, 2), { encoding: "utf8" });

const totalDrafts = results.reduce((n, r) => n + (r.draftKeys || 0), 0);
const totalFields = results.reduce((n, r) => n + (r.fields || 0), 0);
console.log(JSON.stringify({
  ok: true, out: resolvedOut, cdp: CDP,
  allowlistedTargetCount: requestedIds.length,
  okCount: okOnes.length,
  missingCount: results.filter((r) => r.status === "missing").length,
  blockedOriginCount: results.filter((r) => r.status === "blocked-origin").length,
  totalDraftKeys: totalDrafts, totalFields,
  targets: results.map((r) => ({ id: r.id, status: r.status, route: r.route, draftKeys: r.draftKeys, fields: r.fields, error: r.error || "" })),
  errors: results.filter((r) => !r.ok).map((r) => r.id + ":" + (r.error || r.status)),
}));
process.exit(0);



