const API = process.env.QA_API || "http://127.0.0.1:5097";
let pass = 0, fail = 0; const bad = [];
function ok(n, c, e) { if (c) pass++; else { fail++; bad.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
async function req(method, path, body, headers) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(API + path, { method, signal: ctl.signal, headers: { "content-type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const tx = await r.text(); let j = null; try { j = tx ? JSON.parse(tx) : null; } catch {} return { status: r.status, json: j, text: tx };
  } finally { clearTimeout(t); }
}
(async () => {
  console.log("outage test api=" + API);
  const s = await req("GET", "/api/auth/status");
  ok("outage-status-503", s.status === 503, s.status + " " + s.text.slice(0, 160));
  const b = await req("GET", "/api/boards");
  ok("outage-boards-not-200-open", b.status !== 200, b.status + " " + b.text.slice(0, 160));
  ok("outage-boards-503", b.status === 503, b.status + " " + b.text.slice(0, 160));
  const m = await req("PUT", "/api/model/settings", { apiKey: "" });
  ok("outage-model-anon-not-success", m.status !== 200 && m.status !== 201, m.status + " " + m.text.slice(0, 160));
  console.log(`FINAL pass=${pass} fail=${fail}`);
  if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("HARNESS-ERROR " + (e && e.stack || e)); process.exit(2); });
