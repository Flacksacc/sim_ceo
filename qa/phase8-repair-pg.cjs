const API = process.env.QA_API || "http://127.0.0.1:15441";
const run = "p8pg-" + Date.now().toString(36);
let pass = 0, fail = 0; const bad = [];
function ok(n, c, e) { if (c) pass++; else { fail++; bad.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
async function req(method, path, body, headers) {
  const r = await fetch(API + path, { method, headers: { "content-type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} return { status: r.status, json: j, text: t };
}
(async () => {
  console.log("repair-pg run=" + run + " api=" + API);
  const pw = "TestPassword123!";
  const B = (t) => ({ Authorization: "Bearer " + t });
  const admE = run + "-pgadmin@example.com", gE = run + "-pgguest@example.com";
  const ar = await req("POST", "/api/auth/register", { email: admE, password: pw });
  ok("pg-admin-reg", ar.status === 201 && ar.json?.token, ar.status + " " + ar.text.slice(0, 160));
  const gr = await req("POST", "/api/auth/register", { email: gE, password: pw });
  ok("pg-guest-reg", gr.status === 201 && gr.json?.token, gr.status + " " + gr.text.slice(0, 160));
  const adminT0 = ar.json?.token, guestT0 = gr.json?.token;
  const b = await req("POST", "/api/boards", { name: run + "-pgb" }, B(adminT0)); ok("pg-board", b.status === 201 && b.json?.id, b.status + " " + b.text.slice(0, 160));
  const bid = b.json?.id;
  const m = await req("POST", `/api/boards/${bid}/meetings`, { title: "pgm", brief: "b" }, B(adminT0)); const mid = m.json?.id;
  await req("POST", `/api/boards/${bid}/grants`, { userKey: gE, access: "discuss", meetingId: mid }, B(adminT0));
  const st = await req("GET", "/api/auth/status"); ok("pg-secure", st.json?.authRequired === true, st.text.slice(0, 120));
  console.log("PG-READY bid=" + bid + " mid=" + mid);
  console.log(`FINAL pass=${pass} fail=${fail}`);
  if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("HARNESS-ERROR " + (e && e.stack || e)); process.exit(2); });
