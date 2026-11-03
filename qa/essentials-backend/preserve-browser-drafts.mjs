// preserve-browser-drafts.mjs (Muse, source-only)
// READONLY operational backup of human unsent drafts from the operator's own
// browser via explicit CDP targets. No dependencies (Node built-ins only:
// global fetch + global WebSocket + fs/path/url).
//
// What it does:
//   1. GET {cdp}/json/list (readonly) and match ONLY explicitly allowlisted
//      existing target IDs (never discovers/owns all targets).
//   2. Opens ONE WebSocket per allowlisted target, checks the live page origin
//      is an explicitly allowed local project dev-app origin
//      (localhost/127.x loopback :5173 or :5174), then runs READONLY
//      Runtime.evaluate captures (sanitized route + safe params only, full
//      exact draft/recovery localStorage keys/values, full visible unsent
//      field values). No DOM mutation, no navigation, no clicks/keys/resize,
//      no activation, no Browser.close / Target.close / Target.createTarget /
//      Page.navigate. Only its own WS connections are closed.
//   3. Non-app targets (edge://newtab, chrome://, about:, blank, non-page
//      types) are explicitly marked skipped-non-app (ok, no capture needed).
//      Actual app capture errors, missing expected app targets, incomplete
//      captures, or zero valid app captures fail closed: console top-level
//      ok:false with native nonzero exit.
//   4. Writes ONE private UTF-8 (no BOM) JSON file to an explicit --out path
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
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
]);
const HTTP_TIMEOUT_MS = 6000;
const WS_TIMEOUT_MS = 6000;
const EVAL_TIMEOUT_MS = 9000;
const PER_TARGET_BUDGET_MS = 25000;
const MAX_STORAGE_KEYS = 50;
const MAX_FIELDS = 100;
const MAX_LABEL_CHARS = 120;
const MAX_SAFE_PARAMS = 10;
const MAX_TOTAL_CAPTURE_CHARS = 500000;
const MAX_TOTAL_JSON_CHARS = 1000000;
const MAX_ROUTE_CHARS = 500;

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

function isNonAppTarget(entry, origin) {
  const url = String((entry && entry.url) || "");
  const type = String((entry && entry.type) || "");
  if (url.startsWith("edge://") || url.startsWith("chrome://") || url.startsWith("about:") ||
      url.startsWith("chrome-") || url === "about:blank" || url.startsWith("data:")) return true;
  if (!origin || origin === "null" || origin === "about:blank") return true;
  if (type && type !== "page") return true;
  return false;
}

// Readonly origin probe: no storage/DOM access, location only.
const ORIGIN_PROBE = "(() => ({ href: String(location.href), origin: String(location.origin) }))()";

// Readonly draft capture. No mutation, no events, no navigation. Full exact
// draft/recovery key names (incl. Secretary sec-envelope:/sec-answer-envelope:/sec-submit:/sec-pending: and simceo-draft:/simceo-wizard:) + full values and full visible nonsecret field
// values; bounded by key/field counts plus a shared total-char budget with
// fail-closed incomplete reporting (never silently drops keys/fields).
// Query AND hash parameters are sanitized: only the pre-existing safe set is
// kept, raw hash is never stored, credentials never saved as raw hash.
const DRAFT_CAPTURE = `(() => {
  const SAFE_PARAMS = new Set(["boardId","board","meetingId","meeting","recordId","record","step","tab","view"]);
  const SECRET_RE = /token|session|api[_-]?key|apikey|secret|password|auth|credential|bearer|code|state/i;
  const APP_KEY_RE = /^(sec-envelope:|sec-answer-envelope:|sec-submit:|sec-pending:|simceo-draft:|simceo-wizard:)/;
  const DRAFT_RE = /draft|recover|unsent|autosave|auto-save|backup|sec-envelope:|sec-answer-envelope:|sec-submit:|sec-pending:|simceo-draft:|simceo-wizard:/i;
  const SECRET_KEY_RE = /token|session|api[_-]?key|apikey|credential|secret|auth|password|bearer|simceo-token/i;
  const SECRET_FIELD_RE = /token|api[_-]?key|apikey|secret|password|passwd|pwd|auth|credential|session|bearer/i;
  const out = { url: "", route: "", paramsKept: {}, paramsDropped: 0,
    storageScanned: 0, storageSkippedSecret: 0, storageKeys: [], fieldScanned: 0, fields: [],
    incomplete: false, incompleteReason: "", totalChars: 0, draftMatchCount: 0, fieldMatchCount: 0 };
  const markIncomplete = (reason) => { out.incomplete = true; if (!out.incompleteReason) out.incompleteReason = reason; };
  let pathName = "";
  try { out.url = String(location.origin) + String(location.pathname); } catch { markIncomplete("location-read-error"); }
  try { pathName = String(location.pathname || ""); } catch { markIncomplete("location-read-error"); }
  const keepSafe = (sp) => {
    for (const kv of sp) {
      const k = kv[0], v = kv[1];
      if (SAFE_PARAMS.has(k) && !SECRET_RE.test(k)) {
        if (Object.keys(out.paramsKept).length < ${MAX_SAFE_PARAMS}) out.paramsKept[k] = String(v).slice(0, ${MAX_LABEL_CHARS});
      } else out.paramsDropped++;
    }
  };
  try {
    const sp = new URLSearchParams(location.search || "");
    keepSafe(sp);
  } catch {}
  let cleanHash = "";
  try {
    const h = String(location.hash || "");
    if (h) {
      const qIdx = h.indexOf("?");
      let hPath = qIdx >= 0 ? h.slice(0, qIdx) : h;
      let hQuery = qIdx >= 0 ? h.slice(qIdx + 1) : "";
      if (qIdx < 0 && h.indexOf("=") >= 0) { hPath = ""; hQuery = h.slice(1); }
      hPath = String(hPath || "").slice(0, ${MAX_ROUTE_CHARS});
      const kept = [];
      if (hQuery) {
        let hsp = null;
        try { hsp = new URLSearchParams(hQuery); } catch { hsp = null; }
        if (hsp) {
          for (const kv of hsp) {
            const k = kv[0], v = kv[1];
            if (SAFE_PARAMS.has(k) && !SECRET_RE.test(k)) {
              if (Object.keys(out.paramsKept).length < ${MAX_SAFE_PARAMS}) {
                out.paramsKept[k] = String(v).slice(0, ${MAX_LABEL_CHARS});
                kept.push(k + "=" + String(v).slice(0, ${MAX_LABEL_CHARS}));
              }
            } else out.paramsDropped++;
          }
        } else out.paramsDropped++;
      }
      cleanHash = hPath + (kept.length ? "?" + kept.join("&") : "");
    }
  } catch {}
  try { out.route = (String(pathName || "") + String(cleanHash || "")).slice(0, ${MAX_ROUTE_CHARS}); } catch { markIncomplete("route-read-error"); }
  try {
    const keys = Object.keys(localStorage || {});
    out.storageScanned = keys.length;
    const matched = [];
    for (const k of keys) {
      if (!DRAFT_RE.test(k)) continue;
      if (APP_KEY_RE.test(k)) { matched.push(String(k)); continue; }
      if (SECRET_KEY_RE.test(k)) { out.storageSkippedSecret++; continue; }
      matched.push(String(k));
    }
    out.draftMatchCount = matched.length;
    if (matched.length > ${MAX_STORAGE_KEYS}) markIncomplete("storage-key-limit:" + matched.length + ">" + ${MAX_STORAGE_KEYS});
    const take = matched.slice(0, ${MAX_STORAGE_KEYS});
    for (const k of take) {
      let raw = "";
      try { raw = localStorage.getItem(k) ?? ""; } catch { markIncomplete("storage-read-error"); continue; }
      const full = String(raw);
      if ((out.totalChars + full.length) > ${MAX_TOTAL_CAPTURE_CHARS}) { markIncomplete("total-capture-limit-storage"); break; }
      out.totalChars += full.length;
      out.storageKeys.push({ k: k, len: full.length, truncated: false, preview: full });
    }
  } catch { markIncomplete("storage-enumeration-error"); }
  try {
    const els = document.querySelectorAll("textarea, input, select, [contenteditable='true'], [contenteditable='']");
    out.fieldScanned = els.length;
    const cands = [];
    for (const el of els) {
      const tag = (el.tagName || "").toLowerCase();
      const type = String(el.getAttribute ? (el.getAttribute("type") || "") : "").toLowerCase();
      if (["password","hidden","file","submit","button"].includes(type)) continue;
      const id = String(el.id || ""), name = String(el.name || "");
      const ph = String(el.getAttribute ? (el.getAttribute("placeholder") || "") : "");
      const aria = String(el.getAttribute ? (el.getAttribute("aria-label") || "") : "");
      if (SECRET_FIELD_RE.test(id + " " + name + " " + ph + " " + aria)) continue;
      let r = null;
      try { r = el.getBoundingClientRect(); } catch { markIncomplete("field-measure-error"); }
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
      } catch { markIncomplete("field-read-error"); }
      if (!val) continue;
      cands.push({ kind: String(kind).slice(0, 32), label: label, val: String(val) });
    }
    out.fieldMatchCount = cands.length;
    if (cands.length > ${MAX_FIELDS}) markIncomplete("field-limit:" + cands.length + ">" + ${MAX_FIELDS});
    const takeF = cands.slice(0, ${MAX_FIELDS});
    for (const c of takeF) {
      const full = String(c.val);
      if ((out.totalChars + full.length) > ${MAX_TOTAL_CAPTURE_CHARS}) { markIncomplete("total-capture-limit-fields"); break; }
      out.totalChars += full.length;
      out.fields.push({ kind: c.kind, label: c.label, len: full.length, truncated: false, preview: full });
    }
  } catch { markIncomplete("dom-capture-error"); }
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
      if (isNonAppTarget(entry, origin)) {
        return { id: targetId, ok: true, status: "skipped-non-app", route: "", draftKeys: 0, fields: 0, error: "", _cap: null, skipped: true };
      }
      return { id: targetId, ok: false, status: "blocked-origin", route: "", draftKeys: 0, fields: 0,
        error: "origin-not-allowed", _cap: null };
    }
    const cap = await cdpEvaluate(ws, DRAFT_CAPTURE);
    if (Date.now() - started > PER_TARGET_BUDGET_MS) throw new Error("per-target-budget-exceeded");
    if (!cap || typeof cap !== "object") throw new Error("empty-capture");
    if (cap.incomplete) {
      return { id: targetId, ok: false, status: "incomplete-capture", route: String(cap.route || ""),
        paramsKept: (cap && cap.paramsKept) || {}, draftKeys: (cap && cap.storageKeys ? cap.storageKeys.length : 0),
        fields: (cap && cap.fields ? cap.fields.length : 0),
        error: String(cap.incompleteReason || "incomplete-capture").slice(0, 160), _cap: cap };
    }
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

const backedUp = results.filter((r) => r.ok && r.status === "backed-up");
const skippedNonApp = results.filter((r) => r.status === "skipped-non-app");
const failures = results.filter((r) => !r.ok);
let overallOk = failures.length === 0 && backedUp.length > 0;
let overallError = "";
if (backedUp.length === 0) {
  overallOk = false;
  overallError = "missing-expected-app-page: no valid app capture";
}

const payload = {
  tool: "preserve-browser-drafts.mjs",
  readonly: true, backupOnly: true, neverReapplies: true,
  cdp: CDP, allowlistedIds: requestedIds,
  capturedAt: new Date().toISOString(),
  originAllowlist: [...ALLOWED_ORIGINS],
  limits: { maxStorageKeys: MAX_STORAGE_KEYS, maxFields: MAX_FIELDS,
    maxLabelChars: MAX_LABEL_CHARS, maxSafeParams: MAX_SAFE_PARAMS,
    maxTotalCaptureChars: MAX_TOTAL_CAPTURE_CHARS, maxTotalJsonChars: MAX_TOTAL_JSON_CHARS,
    maxRouteChars: MAX_ROUTE_CHARS,
    httpTimeoutMs: HTTP_TIMEOUT_MS, wsTimeoutMs: WS_TIMEOUT_MS, evalTimeoutMs: EVAL_TIMEOUT_MS },
  note: "Scoped human draft/recovery backup only: full exact nonsecret draft/recovery keys+values (incl. Secretary sec-envelope:/sec-answer-envelope:/sec-submit:/sec-pending: and simceo-draft:/simceo-wizard:) and visible unsent field values; credential/token/session/API-key keys and secret fields excluded at capture; query+hash sanitized to safe board/meeting/record/step/tab/view params only (raw hash never stored); non-app/newtab targets skipped; total capture bounded with fail-closed incomplete reporting. Run only against operator-owned loopback :5173/:5174 pages.",
  requireAppCapture: true,
  skippedNonAppCount: skippedNonApp.length,
  incompleteCount: results.filter((r) => r.status === "incomplete-capture").length,
  targets: results.map((r) => ({
    id: r.id, ok: r.ok, status: r.status, route: r.route,
    paramsKept: r.paramsKept || {}, draftKeys: r.draftKeys, fields: r.fields, error: r.error || "",
    ...(r.ok && r._cap ? { storage: r._cap.storageKeys, storageScanned: r._cap.storageScanned,
      storageSkippedSecret: r._cap.storageSkippedSecret, draftMatchCount: r._cap.draftMatchCount,
      fieldScanned: r._cap.fieldScanned, fieldMatchCount: r._cap.fieldMatchCount,
      capturedFields: r._cap.fields, totalChars: r._cap.totalChars,
      incomplete: !!r._cap.incomplete, incompleteReason: String(r._cap.incompleteReason || ""),
      url: r._cap.url, paramsDropped: r._cap.paramsDropped } : {}),
    ...(!r.ok && r._cap ? { storageScanned: r._cap.storageScanned, draftMatchCount: r._cap.draftMatchCount,
      fieldScanned: r._cap.fieldScanned, fieldMatchCount: r._cap.fieldMatchCount,
      totalChars: r._cap.totalChars, incomplete: !!r._cap.incomplete,
      incompleteReason: String(r._cap.incompleteReason || "") } : {}),
  })),
};

let payloadJson = JSON.stringify(payload, null, 2);
if (payloadJson.length > MAX_TOTAL_JSON_CHARS) {
  overallOk = false;
  overallError = "total-json-limit-exceeded:" + payloadJson.length + ">" + MAX_TOTAL_JSON_CHARS;
  payload.incomplete = true;
  payload.incompleteReason = overallError;
  payloadJson = JSON.stringify(payload, null, 2);
}

fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
fs.writeFileSync(resolvedOut, payloadJson, { encoding: "utf8" });

const totalDrafts = results.reduce((n, r) => n + (r.draftKeys || 0), 0);
const totalFields = results.reduce((n, r) => n + (r.fields || 0), 0);
const errors = results.filter((r) => !r.ok).map((r) => r.id + ":" + (r.error || r.status));
if (!overallOk && overallError && !errors.some((e) => e.includes(overallError.split(":")[0]))) errors.push(overallError);
console.log(JSON.stringify({
  ok: overallOk, out: resolvedOut, cdp: CDP,
  allowlistedTargetCount: requestedIds.length,
  okCount: backedUp.length,
  skippedNonAppCount: skippedNonApp.length,
  missingCount: results.filter((r) => r.status === "missing").length,
  blockedOriginCount: results.filter((r) => r.status === "blocked-origin").length,
  incompleteCount: results.filter((r) => r.status === "incomplete-capture").length,
  totalDraftKeys: totalDrafts, totalFields,
  targets: results.map((r) => ({ id: r.id, status: r.status, route: r.route, draftKeys: r.draftKeys, fields: r.fields, error: r.error || "" })),
  errors,
}));
process.exit(overallOk ? 0 : 3);