// qa/records-human-format-final.cjs — focused formatter regression for
// parent review records-181140d finding 4 (sole Muse scope).
// Scope: web/src/human-format.ts + this file (+ distinct doc only).
// No services, network, browser, PG, Docker, .env, keys, or process kills.
// Compiles the ACTUAL TypeScript source via the repo esbuild approach and
// exercises ACTUAL exported functions. Assertions check human-visible
// outcomes (leak vs neutral vs preserved); they do not mirror the internal
// classifier implementation.
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const entry = path.join(repoRoot, "web", "src", "human-format.ts");
  assert.ok(fs.existsSync(entry), "missing " + entry);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "hf-final-"));
  const outFile = path.join(workDir, "human-format.mjs");
  // Existing repo ts-compile/esbuild approach (no new toolchain).
  execSync("npx --yes esbuild " + JSON.stringify(entry) + " --format=esm --platform=node --outfile=" + JSON.stringify(outFile) + " --log-level=error", { stdio: "inherit" });
  const m = await import(pathToFileURL(outFile).href);
  for (const fn of ["humanNoteBody", "humanNoteTitle", "humanEvidenceTitle", "humanEvidenceExcerpt", "parseRecordItems"]) {
    assert.equal(typeof m[fn], "function", "missing export " + fn);
  }

  let passed = 0;
  function check(name, fn) {
    fn();
    passed += 1;
    console.log("ok - " + name);
  }
  function assertNoLeak(s, label) {
    assert.ok(!/reviewToken/i.test(s), label + " leaks reviewToken: " + JSON.stringify(s));
    assert.ok(!/\\u0022/i.test(s) && !/\\u007b/i.test(s) && !/\\u005b/i.test(s), label + " leaks unicode escapes: " + JSON.stringify(s));
  }
  function assertNoRawJson(s, label) {
    assert.ok(!s.includes('{"') && !s.includes('["'), label + " leaks raw JSON shape: " + JSON.stringify(s));
  }
  const NEUTRAL_BODY = "Note detail is available in context.";

  // ---- Exact review counterexample A (negative): malformed unicode-escaped inner JSON must not leak.
  check("review-A body unicode truncated object -> neutral, no leak", () => {
    const inner = '"{\\u0022reviewToken\\u0022:\\u0022internal';
    const out = m.humanNoteBody(JSON.stringify(inner));
    assert.equal(out, NEUTRAL_BODY);
    assertNoLeak(out, "review-A");
  });
  check("review-A title unicode truncated object -> neutral, no leak", () => {
    const inner = '"{\\u0022reviewToken\\u0022:\\u0022internal';
    const out = m.humanNoteTitle(JSON.stringify(inner));
    assert.equal(out, "(untitled note)");
    assertNoLeak(out, "review-A-title");
  });
  check("review-A evidence unicode truncated object -> neutral, no leak", () => {
    const inner = '"{\\u0022reviewToken\\u0022:\\u0022internal';
    const out = m.humanEvidenceExcerpt(JSON.stringify(inner), "note");
    assert.ok(out.includes("Supporting detail is available in context."), "expected evidence fallback, got " + JSON.stringify(out));
    assertNoLeak(out, "review-A-evidence");
  });

  // ---- Exact review counterexample B (positive): valid quoted-label ordinary prose must be preserved.
  check("review-B body quoted-label prose preserved", () => {
    const prose = '"Approved": use this label after review.';
    const out = m.humanNoteBody(JSON.stringify(prose));
    assert.ok(out.includes("Approved"), "lost label: " + JSON.stringify(out));
    assert.ok(out.includes("use this label after review."), "lost prose: " + JSON.stringify(out));
    assert.ok(!out.includes("available in context"), "erased to fallback: " + JSON.stringify(out));
  });
  check("review-B title quoted-label prose preserved", () => {
    const prose = '"Approved": use this label after review.';
    const out = m.humanNoteTitle(JSON.stringify(prose));
    assert.ok(out.includes("Approved") && out.includes("use this label"), "erased: " + JSON.stringify(out));
  });

  // ---- Quoted ordinary prose variants (must preserve).
  check("plain prose preserved", () => {
    const out = m.humanNoteBody("Just a plain decision note for the board.");
    assert.ok(out.includes("Just a plain decision note"), JSON.stringify(out));
  });
  check("quoted plain prose preserved", () => {
    const out = m.humanNoteBody(JSON.stringify('"hello world, see you Tuesday"'));
    assert.ok(out.toLowerCase().includes("hello world"), JSON.stringify(out));
    assert.ok(!out.includes("available in context"), JSON.stringify(out));
  });
  check("label-colon prose FYI preserved", () => {
    const out = m.humanNoteBody(JSON.stringify('"FYI": please review tomorrow morning.'));
    assert.ok(out.includes("FYI") && out.includes("please review tomorrow"), JSON.stringify(out));
  });
  check("bracket prose [note] preserved (not an array)", () => {
    const out = m.humanNoteBody(JSON.stringify('"[note] remember to call finance"'));
    assert.ok(out.includes("remember to call finance"), JSON.stringify(out));
    assert.ok(!out.includes("available in context"), JSON.stringify(out));
  });
  check("quoted brace prose without keys preserved", () => {
    const out = m.humanNoteBody(JSON.stringify('"{hello} mitten season is here"'));
    assert.ok(out.includes("hello") && out.includes("mitten"), JSON.stringify(out));
  });
  check("colon prose without quotes preserved", () => {
    const out = m.humanNoteBody("Status: all good today, no action needed.");
    assert.ok(out.includes("Status: all good today"), JSON.stringify(out));
  });
  check("quoted empty-string prose stays prose", () => {
    const out = m.humanNoteBody(JSON.stringify('"see the Q3 summary (draft)"'));
    assert.ok(out.includes("Q3 summary"), JSON.stringify(out));
  });

  // ---- Unicode structural quotes/array/object (must not leak).
  check("unicode object truncated unknown -> neutral", () => {
    const inner = '"{\\u0022watermark\\u0022:\\u0022abc123';
    const out = m.humanNoteBody(JSON.stringify(inner));
    assert.ok(out === NEUTRAL_BODY, JSON.stringify(out));
    assertNoLeak(out, "unicode-object");
    assertNoRawJson(out, "unicode-object");
  });
  check("unicode array truncated -> neutral, no raw shape", () => {
    const inner = '"[\\u0022alpha\\u0022,\\u0022beta';
    const out = m.humanNoteBody(JSON.stringify(inner));
    assert.ok(out === NEUTRAL_BODY, JSON.stringify(out));
    assertNoLeak(out, "unicode-array");
    assert.ok(!out.includes('["'), JSON.stringify(out));
  });
  check("unicode brace escape truncated -> neutral", () => {
    const inner = '"\\u007B\\u0022title\\u0022:\\u0022abc';
    const out = m.humanNoteBody(JSON.stringify(inner));
    assert.ok(out === NEUTRAL_BODY, JSON.stringify(out));
    assertNoLeak(out, "unicode-brace");
  });
  check("valid unicode-escaped JSON still projects", () => {
    const raw = '{"title":"\\u0042udget review","text":"Approve \\u0048iring plan"}';
    const out = m.humanNoteBody(raw);
    assert.ok(out.includes("udget review") || out.includes("Budget review"), JSON.stringify(out));
    assert.ok(out.includes("iring plan") || out.includes("Hiring plan"), JSON.stringify(out));
  });

  // ---- Array/object/escaped-backslash/depth-limit/truncated forms.
  check("valid object projects title+text", () => {
    const out = m.humanNoteBody(JSON.stringify({ title: "Budget review", text: "Approve hiring plan" }));
    assert.ok(out.includes("Budget review") && out.includes("Approve hiring plan"), JSON.stringify(out));
  });
  check("valid double-encoded object projects (2 layers)", () => {
    const dbl = JSON.stringify(JSON.stringify({ text: "Deep nested decision" }));
    const out = m.humanNoteBody(dbl);
    assert.ok(out.includes("Deep nested decision"), JSON.stringify(out));
  });
  check("valid triple-encoded object projects (3 layers bounded)", () => {
    const t3 = JSON.stringify(JSON.stringify(JSON.stringify({ text: "Triple layer decision" })));
    const out = m.humanNoteBody(t3);
    assert.ok(out.includes("Triple layer decision"), JSON.stringify(out));
  });
  check("triple-encoded object still projects (bounded 3 layers)", () => {
    let v = { text: "Depth limit probe" };
    let s = JSON.stringify(v);
    s = JSON.stringify(s);
    s = JSON.stringify(s);
    s = JSON.stringify(s);
    const out = m.humanNoteBody(s);
    assert.ok(out.includes("Depth limit probe"), "bounded 4-parse chain should project: " + JSON.stringify(out));
  });
  check("quintuple-encoded object fails safe at depth limit (neutral)", () => {
    let v = { text: "Depth limit probe" };
    let s = JSON.stringify(v);
    s = JSON.stringify(s);
    s = JSON.stringify(s);
    s = JSON.stringify(s);
    s = JSON.stringify(s);
    const out = m.humanNoteBody(s);
    assert.ok(out === NEUTRAL_BODY, JSON.stringify(out));
    assert.ok(!out.includes("Depth limit probe"), "depth-limit must not leak inner text: " + JSON.stringify(out));
  });
  check("escaped-backslash double-encoded projects without backslash leak", () => {
    const innerObj = JSON.stringify({ title: 'Say "hi" loudly' });
    const dbl = JSON.stringify(innerObj);
    const out = m.humanNoteBody(dbl);
    assert.ok(out.includes("Say") && out.includes("hi"), JSON.stringify(out));
    assert.ok(!out.includes('\\"'), "backslash leak: " + JSON.stringify(out));
  });
  check("truncated known-field object extracts without raw shape", () => {
    const out = m.humanNoteBody('{"title":"Budget review for Q3, planning continues');
    assert.ok(out.includes("Budget review for Q3"), JSON.stringify(out));
    assertNoRawJson(out, "truncated-known");
  });
  check("truncated unknown-field object -> neutral, no leak", () => {
    const out = m.humanNoteBody('{"reviewToken":"internal-abc-123 truncated');
    assert.ok(out === NEUTRAL_BODY, JSON.stringify(out));
    assertNoLeak(out, "truncated-unknown");
  });
  check("truncated array -> neutral fallback", () => {
    const out = m.humanNoteBody('["alpha","beta truncated');
    assert.ok(out === NEUTRAL_BODY, JSON.stringify(out));
  });
  check("malformed plain quoted object with escapes -> neutral", () => {
    const inner = '"{\\"reviewToken\\":\\"internal';
    const out = m.humanNoteBody(JSON.stringify(inner));
    assert.ok(out === NEUTRAL_BODY, JSON.stringify(out));
    assertNoLeak(out, "escaped-quote-truncated");
  });
  check("malformed quoted array with escapes -> neutral", () => {
    const inner = '"[\\"alpha\\",\\"beta';
    const out = m.humanNoteBody(JSON.stringify(inner));
    assert.ok(out === NEUTRAL_BODY, JSON.stringify(out));
  });

  // ---- Existing accepted JSON projections (no regression).
  check("question+text projection intact", () => {
    const out = m.humanNoteBody(JSON.stringify({ question: "Should we expand?", text: "Yes, open a second site." }));
    assert.ok(out.includes("Should we expand?") && out.includes("second site"), JSON.stringify(out));
  });
  check("guid scrubbed, human text kept", () => {
    const out = m.humanNoteBody("Meeting notes ref 123e4567-e89b-12d3-a456-426614174000 done today.");
    assert.ok(out.includes("a reference"), JSON.stringify(out));
    assert.ok(!out.includes("123e4567"), JSON.stringify(out));
    assert.ok(out.includes("done today"), JSON.stringify(out));
  });
  check("omitted manifest stripped with warning", () => {
    const out = m.humanNoteBody("Visible text [Omitted from packet direction:abc] trailing words.");
    assert.ok(out.includes("Visible text"), JSON.stringify(out));
    assert.ok(!out.includes("[Omitted from packet"), JSON.stringify(out));
    assert.ok(/omitted/i.test(out), JSON.stringify(out));
  });
  check("evidence record version label intact", () => {
    const out = m.humanEvidenceTitle("record v3 [abc]", "record", 3);
    assert.ok(/version 3/i.test(out), JSON.stringify(out));
  });
  check("parseRecordItems smoke intact", () => {
    const p = m.parseRecordItems(JSON.stringify([{ id: "a1", text: "Approve plan" }]));
    assert.equal(p.problem, null);
    assert.equal(p.items[0].text, "Approve plan");
  });

  console.log("human-format-final: " + passed + " groups passed");
}

main().catch((e) => { console.error("human-format-final FAILED:", e && e.message ? e.message : e); process.exit(1); });
