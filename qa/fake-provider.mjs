// Deterministic fake Meta Model API for SimCEO QA.
// Opt-in only: the API under test points here via META_API_BASE.
// No network calls leave this process; every response is scripted.
// Behavior is driven by tokens embedded in the prompt text:
//
//   advisor bids (prompt contains "Reply with exactly YES or NO"):
//     QA-NO      -> "NO ..."   | QA-BIDERR -> HTTP 500
//     default    -> "YES ..."
//   advisor replies (prompt contains "YOUR TURN"):
//     QA-ABSTAIN -> "ABSTAIN" | QA-REPLYERR -> HTTP 500
//     QA-SLEEP:<ms> -> sleep first (owner-interruption / concurrency tests)
//     default    -> "QA advisor reply. [stance: Agrees]"
//   interview ("You guide Sim CEO board setup"):
//     QA-BADJSON -> unparseable text (exercises retry-with-repair + fallback)
//     QA-SLEEP:<ms> -> sleep first
//     default    -> valid JSON with empty updates
//   wizard guide ("onboarding guide") -> valid guide JSON
//   model test ("Reply with exactly: OK") -> "OK"
//   everything else -> "QA provisional text."
//
// /responses (grounded research): emits a message + web_search_call block
// with two fixed citations, unless the input contains QA-NOSEARCH
// (zero results -> unsupported-dossier path).
import http from "node:http";

const argIdx = process.argv.indexOf("--port");
const PORT = Number(argIdx >= 0 ? process.argv[argIdx + 1] : 5199);
let seq = 0;
const counts = { chat: 0, responses: 0, transcribe: 0, images: 0 };

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => resolve(b));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sleepMsOf(text) {
  const m = /QA-SLEEP:(\d+)/.exec(text || "");
  return m ? Math.min(Number(m[1]), 15000) : 0;
}
function chatContent(prompt) {
  if (prompt.includes("Reply with exactly YES or NO")) {
    if (prompt.includes("QA-BIDERR")) return { status: 500, body: "qa bid failure" };
    return { content: prompt.includes("QA-NO") ? "NO - not relevant to this prompt." : "YES - directly relevant." };
  }
  if (prompt.includes("YOUR TURN")) {
    if (prompt.includes("QA-REPLYERR")) return { status: 500, body: "qa reply failure" };
    if (prompt.includes("QA-ABSTAIN")) return { content: "ABSTAIN" };
    return { content: "QA advisor reply with a clear position. [stance: Agrees]" };
  }
  if (prompt.includes("You guide Sim CEO board setup")) {
    if (prompt.includes("QA-REPLYERR")) return { status: 500, body: "qa interview failure" };
    if (prompt.includes("QA-BADENVELOPE")) return { envelope: { choices: [] } };
    if (prompt.includes("QA-BADJSON")) return { content: "this is not json at all {{{" };
    return {
      content: JSON.stringify({
        analysis: "QA analysis recorded.",
        updates: {},
        nextQuestion: "QA next question: what is missing?",
      }),
    };
  }
  if (prompt.includes("onboarding guide")) {
    return {
      content: JSON.stringify({ suggestion: "QA suggestion.", nextQuestion: "QA next?", fields: {} }),
    };
  }
  if (prompt.includes("Reply with exactly: OK")) return { content: "OK" };
  return { content: "QA provisional text." };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  if (req.method === "GET" && url.pathname === "/__health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, fake: true }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/__counts") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(counts));
    return;
  }
  const raw = await readBody(req);
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
  if (req.method === "POST" && url.pathname === "/chat/completions") {
    counts.chat++;
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    const prompt = msgs.map((m) => m.content).join("\n") || "";
    const wait = sleepMsOf(prompt);
    if (wait) await sleep(wait);
    const out = chatContent(prompt);
    if (out.envelope) {
      seq++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Object.assign({ id: "qa-chat-" + seq, usage: { prompt_tokens: 10, completion_tokens: 10 } }, out.envelope)));
      return;
    }
    if (out.status) {
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: out.body }));
      return;
    }
    seq++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "qa-chat-" + seq,
      choices: [{ message: { role: "assistant", content: out.content } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/responses") {
    counts.responses++;
    const input = typeof body?.input === "string" ? body.input : "";
    if (input.includes("QA-RESEARCHERR")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa research failure" }));
      return;
    }
    if (input.includes("QA-SLEEP")) await sleep(sleepMsOf(input));
    seq++;
    const noSearch = input.includes("QA-NOSEARCH");
    const output = [
      { type: "message", content: [{ type: "output_text", text: "QA grounded claim line one.\nQA grounded claim line two." }] },
    ];
    if (!noSearch) {
      output.unshift({
        type: "web_search_call",
        results: [
          { url: "https://qa.example/s1", title: "QA source one", snippet: "QA excerpt one." },
          { url: "https://qa.example/s2", title: "QA source two", snippet: "QA excerpt two." },
        ],
      });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "qa-resp-" + seq,
      output,
      usage: { input_tokens: 20, output_tokens: 20 },
    }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/asr/transcribe") {
    counts.transcribe++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: "qa transcript", transcript: "qa transcript" }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/images/generations") {
    counts.images++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }] }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "qa: unknown route " + url.pathname }));
});

server.listen(PORT, "127.0.0.1", () => console.log("qa fake provider on 127.0.0.1:" + PORT));
