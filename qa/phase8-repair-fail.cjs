const API = process.env.QA_API || "http://127.0.0.1:5197";
const ids = require("../.tmp/legacy94-ids.json");
let pass = 0, fail = 0; const bad = [];
function ok(n, c, e) { if (c) pass++; else { fail++; bad.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
async function req(method, path, body, headers) {
  const r = await fetch(API + path, { method, headers: { "content-type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} return { status: r.status, json: j, text: t };
}
(async () => {
  console.log("failure-controls test api=" + API);
  const B = (t) => ({ Authorization: "Bearer " + t });
  const al = await req("POST", "/api/auth/login", { email: ids.alpha.email, password: ids.pw });
  const adminT = al.json?.token; ok("fail-login", al.status === 200 && adminT, al.status + " " + al.text.slice(0, 120));
  const before = await req("GET", `/api/boards/${ids.boardId}/grants`, undefined, B(adminT));
  const n0 = Array.isArray(before.json) ? before.json.length : -1;
  const badHash = await req("POST", "/api/backup/restore", { snapshot: "{}", hash: "00" }, B(adminT));
  ok("fail-bad-hash-409", badHash.status === 409, badHash.status + " " + badHash.text.slice(0, 160));
  const badVer = await req("POST", "/api/backup/restore", { snapshot: JSON.stringify({ version: 99 }), hash: "ab" }, B(adminT));
  ok("fail-malformed-400or409", badVer.status === 400 || badVer.status === 409, badVer.status + " " + badVer.text.slice(0, 160));
  const after = await req("GET", `/api/boards/${ids.boardId}/grants`, undefined, B(adminT));
  const n1 = Array.isArray(after.json) ? after.json.length : -2;
  ok("fail-no-partial-state", n0 === n1 && n0 >= 2, n0 + " vs " + n1);
  console.log(`FINAL pass=${pass} fail=${fail}`);
  if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("HARNESS-ERROR " + (e && e.stack || e)); process.exit(2); });
