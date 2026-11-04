// Supplementary: max-size accepted paragraphs (3x~1900 chars) survive every
// prompt whole, incl. the section-cap path; prompt text has no quote artifacts.
const API = process.env.QA_API || "http://127.0.0.1:5157";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:5252";
const run = "cmx-" + Date.now().toString(36);
let pass = 0, fail = 0; const failures = [];
function ok(name, cond, extra) { if (cond) pass++; else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); } }
async function req(method, path, body, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), opts.timeout || 30000);
  try {
    const r = await fetch(API + path, { method, signal: ctl.signal, headers: { "content-type": "application/json", "x-user": "owner" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const get = (p, o) => req("GET", p, undefined, o);
const post = (p, b, o) => req("POST", p, b, o);
const put = (p, b, o) => req("PUT", p, b, o);
const camel = (o, k) => { if (!o || typeof o !== "object") return undefined; if (k in o) return o[k]; const lo = k.toLowerCase(); for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key]; return undefined; };
const ACCT = globalThis.crypto.randomUUID();
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
async function fakeLog() { return (await fetch(FAKE + "/__log")).json(); }
async function fakeLogClear() { await fetch(FAKE + "/__log", { method: "DELETE" }); }
console.log("maxsize: 3x~1900 char paragraphs end to end");
const seed = await post("/api/roster/quick", { accountId: ACCT, name: "Max Size Max", description: "Max-size paragraph probe advisor with a sufficiently long description here." });
const rid = camel(seed.json, "id");
ok("seed-201", seed.status === 201 && rid, seed.status);
const pad = (w, m, n) => (w + " detail text. ").repeat(n) + " " + m;
const prof = { fictional: true, name: "Max Size Max", contributionCriteria: pad("Contribute", "END-MAX-CRIT", 72), reasoningApproach: pad("Reason", "END-MAX-REAS", 88), responseStyle: pad("Respond", "END-MAX-STYLE", 88) };
for (const k of ["contributionCriteria", "reasoningApproach", "responseStyle"]) ok("para-near-max-" + k, prof[k].length > 1700 && prof[k].length <= 2000, k + "=" + prof[k].length);
const save = await put("/api/roster/" + rid, { profileJson: JSON.stringify(prof) });
ok("save-200", save.status === 200, save.status + " " + save.text.slice(0, 160));
const up = await (async () => {
  const form = new FormData(); form.append("file", new Blob([PNG], { type: "image/png" }), "qa.png");
  const r = await fetch(API + "/api/roster/" + rid + "/image/upload", { method: "POST", headers: { "x-user": "owner" }, body: form });
  return { status: r.status };
})();
ok("portrait-201", up.status === 201, up.status);
const imgs = await get("/api/roster/" + rid + "/images");
await post("/api/images/" + camel(imgs.json?.[0], "id") + "/review", { decision: "accept" });
const board = camel((await post("/api/boards", { name: run + "-max", mission: "m", stage: "qa" })).json, "id");
const cp = await post("/api/roster/" + rid + "/copy", { boardId: board, boardRole: "Max" });
ok("copy-201", cp.status === 201, cp.status + " " + cp.text.slice(0, 160));
const aid = camel(cp.json, "id");
const ap = await post("/api/boards/" + board + "/advisors/" + aid + "/approve", {});
ok("approve-200", ap.status === 200, ap.status + " " + ap.text.slice(0, 160));
const mid = camel((await post("/api/boards/" + board + "/meetings", { title: run + " max", brief: "Max-size probe." })).json, "id");
await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "Short opener." });
const longQ = "Max-size run question: which option is best? " + "Relevant background line. ".repeat(60) + " DECISIVE TAIL MAX-9981";
await fakeLogClear();
const runRes = await post("/api/meetings/" + mid + "/run", { prompt: longQ }, { timeout: 120000 });
ok("run-200", runRes.status === 200 && (runRes.json?.published?.length || 0) >= 1, runRes.status + " " + runRes.text.slice(0, 200));
const log = await fakeLog();
const bids = log.filter((e) => e.bid);
const drafts = log.filter((e) => e.draft);
ok("max-bid-whole", bids.length >= 1 && bids.every((b) => b.full.includes("END-MAX-CRIT") && b.full.includes("END-MAX-REAS") && b.full.includes("MAX-9981")), "bids=" + bids.length);
ok("max-reply-whole", drafts.length >= 1 && drafts.every((d) => d.full.includes("END-MAX-CRIT") && d.full.includes("END-MAX-REAS") && d.full.includes("END-MAX-STYLE") && d.full.includes("MAX-9981") && d.full.includes("CURRENT REQUEST")), "drafts=" + drafts.length);
const chat = await post("/api/roster/" + rid + "/chat", { message: "Quick max check?" });
ok("chat-200", chat.status === 200 && chat.json?.answer, chat.status + " " + chat.text.slice(0, 160));
const log2 = await fakeLog();
const chats = log2.filter((e) => e.path === "chat" && !e.bid && !e.draft);
ok("max-chat-whole", chats.some((c) => c.full.includes("END-MAX-CRIT") && c.full.includes("END-MAX-STYLE") && c.full.includes("character" + String.fromCharCode(39) + "s bluntness") && !c.full.includes("character" + String.fromCharCode(39, 39) + "s")), "chat prompts checked");
const aud = await post("/api/auditions", { rosterId: rid, question: "Max audition?" });
ok("audition-200", aud.status === 200, aud.status + " " + aud.text.slice(0, 160));
const log3 = await fakeLog();
ok("max-audition-whole", log3.filter((e) => e.path === "chat").some((c) => c.full.includes("AUDITION") && c.full.includes("END-MAX-CRIT") && c.full.includes("END-MAX-STYLE")), "aud checked");
console.log("character-maxsize-qa: pass=" + pass + " fail=" + fail);
if (failures) { console.log("FAILURES:"); for (const f of failures) console.log(" - " + f); }
process.exit(fail ? 1 : 0);
