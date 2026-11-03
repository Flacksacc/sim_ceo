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
let msMode = "absent";

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
  if (req.method === "GET" && url.pathname === "/__qa/ms-mode") {
    const mode = url.searchParams.get("mode");
    if (mode === "absent" || mode === "official" || mode === "subsecond" || mode === "processed" || mode === "present") msMode = mode;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ msMode }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/__reset") {
    seq = 0;
    counts.chat = 0; counts.responses = 0; counts.transcribe = 0; counts.images = 0;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
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
    if (prompt.includes("QA-HTTP500")) {
    if (prompt.includes("QA-HTTP500-LONG")) {
      seq++;
      const pad = "x".repeat(2000);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa long failure " + pad, id: "qa-long-billed-1", usage: { prompt_tokens: 120, completion_tokens: 16 } }));
      return;
    }
    if (prompt.includes("QA-HTTP500-IDONLY")) {
      seq++;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa id-only failure", id: "qa-only-id-9" }));
      return;
    }
    if (prompt.includes("QA-HTTP500-CANARY")) {
      seq++;
      const canary = "QA-CANARY-PROMPT-abc123 QA-CANARY-KEY-sk-test-xyz";
      const pad = "q".repeat(600);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa canary failure " + canary + " " + pad, id: "qa-canary-1", usage: { prompt_tokens: 120, completion_tokens: 16 } }));
      return;
    }
    if (prompt.includes("QA-HTTP500-OVERSIZED")) {
      seq++;
      const pad = "z".repeat(200000);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa oversized " + pad, id: "qa-oversized-1", usage: { prompt_tokens: 10, completion_tokens: 10 } }));
      return;
    }
    if (prompt.includes("QA-HTTP500-USAGE")) {
      seq++;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa billed failure", id: "qa-failed-billed-1", usage: { prompt_tokens: 100, completion_tokens: 50 } }));
      return;
    }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa chat failure" }));
      return;
    }
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
    const cached = prompt.includes("QA-CACHED");
    const noUsage = prompt.includes("QA-NOUSAGE");
    const truncate = prompt.includes("QA-TRUNCATE");
    const negUsage = prompt.includes("QA-USAGE-NEG");
    const cacheOver = prompt.includes("QA-USAGE-CACHEOVER");
    const badType = prompt.includes("QA-USAGE-BADTYPE");
    const empty = prompt.includes("QA-EMPTY");
    if (empty) {
      res.writeHead(200, { "content-type": "application/json" });
      const env = { id: "qa-chat-" + seq, choices: [] };
      if (!noUsage) env.usage = cached
        ? { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } }
        : { prompt_tokens: 10, completion_tokens: 5 };
      res.end(JSON.stringify(env));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    const doc = {
      id: "qa-chat-" + seq,
      choices: [{ message: { role: "assistant", content: out.content }, finish_reason: truncate ? "length" : "stop" }],
    };
    if (prompt.includes("QA-USAGE-CONFLICT")) {
      doc.usage = { prompt_tokens: 100, input_tokens: 90, completion_tokens: 10 };
    } else if (prompt.includes("QA-USAGE-CACHED-CONFLICT")) {
      doc.usage = { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 }, cached_input_tokens: -1 };
    } else if (prompt.includes("QA-USAGE-BROKEN-DETAILS")) {
      doc.usage = { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: "broken", cached_tokens: 20 };
    } else if (negUsage) {
      doc.usage = { prompt_tokens: -5, completion_tokens: 10 };
    } else if (cacheOver) {
      doc.usage = { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 200 } };
    } else if (badType) {
      doc.usage = { prompt_tokens: "100", completion_tokens: 10 };
    } else if (!noUsage) {
      doc.usage = cached
        ? { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 40 } }
        : { prompt_tokens: 10, completion_tokens: 10 };
    }
    res.end(JSON.stringify(doc));
    return;
  }
  if (req.method === "POST" && url.pathname === "/responses") {
    counts.responses++;
    const input = typeof body?.input === "string" ? body.input : "";
    if (input.includes("QA-RESEARCHERR-SEARCH")) {
      seq++;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa billed research failure with search", id: "qa-resp-failed-search-1", usage: { input_tokens: 40, output_tokens: 10 }, output: [{ type: "web_search_call", results: [] }] }));
      return;
    }
    if (input.includes("QA-RESEARCHERR-IDONLY")) {
      seq++;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa id-only research failure", id: "qa-resp-only-id-7" }));
      return;
    }
    if (input.includes("QA-RESEARCHERR-LONG")) {
      seq++;
      const pad = "y".repeat(2000);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa long research failure " + pad, id: "qa-resp-long-1", usage: { input_tokens: 30, output_tokens: 5 }, output: [{ type: "web_search_call", results: [] }] }));
      return;
    }
    if (input.includes("QA-RESEARCHERR-EMPTY-OUTPUT")) {
      seq++;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa empty-output failure", id: "qa-resp-empty-1", usage: { input_tokens: 40, output_tokens: 10 }, output: [] }));
      return;
    }
    if (input.includes("QA-RESEARCHERR-NULL-OUTPUT")) {
      seq++;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa null-output failure", id: "qa-resp-null-1", usage: { input_tokens: 40, output_tokens: 10 }, output: null }));
      return;
    }
    if (input.includes("QA-RESEARCHERR-MALFORMED-OUTPUT")) {
      seq++;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa malformed-output failure", id: "qa-resp-mal-1", usage: { input_tokens: 40, output_tokens: 10 }, output: ["not-an-object"] }));
      return;
    }
    if (input.includes("QA-RESEARCHERR-CANARY")) {
      seq++;
      const canary = "QA-CANARY-PROMPT-abc123 QA-CANARY-KEY-sk-test-xyz";
      const pad = "r".repeat(600);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa canary research " + canary + " " + pad, id: "qa-resp-canary-1", usage: { input_tokens: 40, output_tokens: 10 }, output: [{ type: "web_search_call", results: [] }] }));
      return;
    }
    if (input.includes("QA-RESEARCHERR-OVERSIZED")) {
      seq++;
      const pad = "z".repeat(200000);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa oversized research " + pad, id: "qa-resp-oversized-1", usage: { input_tokens: 40, output_tokens: 10 } }));
      return;
    }
    if (input.includes("QA-RESEARCHERR-USAGE")) {
      seq++;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa billed research failure", id: "qa-resp-failed-1", usage: { input_tokens: 40, output_tokens: 10 } }));
      return;
    }
    if (input.includes("QA-RESEARCHERR")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa research failure" }));
      return;
    }
    if (input.includes("QA-SLEEP")) await sleep(sleepMsOf(input));
    if (input.includes("QA-RESP-INCOMPLETE")) {
      seq++;
      res.writeHead(200, { "content-type": "application/json" });
      const inc = { id: "qa-resp-" + seq, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
      if (!input.includes("QA-RESP-NOUSAGE")) inc.usage = { input_tokens: 30, output_tokens: 5 };
      res.end(JSON.stringify(inc));
      return;
    }
    if (input.includes("QA-RESP-EMPTY-OUTPUT-200")) {
      seq++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "qa-resp-empty200-" + seq, status: "completed", output: [], usage: { input_tokens: 20, output_tokens: 20 } }));
      return;
    }
    if (input.includes("QA-RESP-MALFORMED-OUTPUT-200")) {
      seq++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "qa-resp-mal200-" + seq, status: "completed", output: ["bad"], usage: { input_tokens: 20, output_tokens: 20 } }));
      return;
    }
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
    const rdoc = { id: "qa-resp-" + seq, status: "completed", output };
    if (!input.includes("QA-RESP-NOUSAGE")) rdoc.usage = { input_tokens: 20, output_tokens: 20 };
    res.end(JSON.stringify(rdoc));
    return;
  }
  if (req.method === "POST" && url.pathname === "/asr/transcribe") {
    if (typeof raw === "string" && raw.includes("QA-429")) {
      counts.transcribe++;
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa rate limited" }));
      return;
    }
    if (typeof raw === "string" && raw.includes("QA-500-ASR")) {
      counts.transcribe++;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "qa transcribe failure" }));
      return;
    }
    counts.transcribe++;
    res.writeHead(200, { "content-type": "application/json" });
    const tdoc = { transcript: "qa transcript" };
    if (msMode === "official") tdoc.audioDurationMs = 8240;
    else if (msMode === "subsecond") tdoc.audioDurationMs = 500;
    else if (msMode === "processed" || msMode === "present") tdoc.audioProcessedMs = 5000;
    res.end(JSON.stringify(tdoc));
    return;
  }
  if (req.method === "POST" && url.pathname === "/images/generations") {
    counts.images++;
    const one = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const iprompt = typeof body?.prompt === "string" ? body.prompt : "";
    const ok = () => res.writeHead(200, { "content-type": "application/json" });
    const hello = "aGVsbG8=";
    if (iprompt.includes("QA-IMG-HELLO")) { ok(); res.end(JSON.stringify({ id: "qa-img-hello-1", data: [{ b64_json: hello }] })); return; }
    if (iprompt.includes("QA-IMG-BADURL")) { ok(); res.end(JSON.stringify({ id: "qa-img-badurl-1", data: [{ url: "https://" }] })); return; }
    if (iprompt.includes("QA-IMG-IDONLY")) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "qa img failure", id: "qa-img-failed-7" })); return; }
    if (iprompt.includes("QA-IMG-PNGURL")) { ok(); res.end(JSON.stringify({ id: "qa-img-pngurl-1", data: [{ b64_json: one }, { url: "https://qa.example/img-valid.png" }] })); return; }
    if (iprompt.includes("QA-IMG-MALFORMED")) { ok(); res.end(JSON.stringify({ id: "qa-img-mal-1", data: [{ b64_json: "%%%" }] })); return; }
    if (iprompt.includes("QA-IMG-EMPTY")) { ok(); res.end(JSON.stringify({ data: [] })); return; }
    if (iprompt.includes("QA-IMG-MIXED")) { ok(); res.end(JSON.stringify({ id: "qa-img-mixed-1", data: [{ b64_json: one }, { b64_json: "%%%" }, { url: "https://qa.example/img3.png" }] })); return; }
    if (iprompt.includes("QA-IMG-NODATA")) { ok(); res.end(JSON.stringify({ note: "no data property" })); return; }
    if (iprompt.includes("QA-IMG-URL")) { ok(); res.end(JSON.stringify({ data: [{ url: "https://qa.example/img9.png" }] })); return; }
    if (iprompt.includes("QA-IMG-PARTIAL")) { ok(); res.end(JSON.stringify({ data: [{ b64_json: one }] })); return; }
    const want = Math.min(4, Math.max(1, Number(body?.n) || 1));
    ok(); res.end(JSON.stringify({ data: Array.from({ length: want }, () => ({ b64_json: one })) }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "qa: unknown route " + url.pathname }));
});

server.listen(PORT, "127.0.0.1", () => console.log("qa fake provider on 127.0.0.1:" + PORT));
