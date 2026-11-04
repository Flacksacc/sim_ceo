// qa/records-human-format-final.cjs — focused formatter regression for
// parent reviews records-181140d finding 4 and records-916c063 follow-up (sole Muse scope).
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

  // ---- Bare escaped structural JSON (review 916c063 P2 group 1): neutral, no leak.
  check("bare unicode-escaped object body -> neutral, no leak", () => {
    const out = m.humanNoteBody("{\\u0022reviewToken\\u0022:\\u0022internal");
    assert.ok(out === NEUTRAL_BODY, JSON.stringify(out));
    assertNoLeak(out, "bare-u-body");
    assertNoRawJson(out, "bare-u-body");
  });
  check("bare unicode-escaped object title/excerpt/evidenceTitle -> neutral", () => {
    const raw = "{\\u0022reviewToken\\u0022:\\u0022internal";
    assert.ok(m.humanNoteTitle(raw) === "(untitled note)", JSON.stringify(m.humanNoteTitle(raw)));
    assert.ok(m.humanEvidenceExcerpt(raw, "note").includes("Supporting detail is available in context."), JSON.stringify(m.humanEvidenceExcerpt(raw, "note")));
    assert.ok(m.humanEvidenceTitle(raw, "note", null) === "Supporting excerpt", JSON.stringify(m.humanEvidenceTitle(raw, "note", null)));
    assertNoLeak(m.humanNoteTitle(raw), "bare-u-title");
    assertNoLeak(m.humanEvidenceExcerpt(raw, "note"), "bare-u-excerpt");
  });
  check("bare unicode-brace body/title/excerpt -> neutral, no leak", () => {
    const raw = "\\u007B\\u0022reviewToken\\u0022:\\u0022internal";
    assert.ok(m.humanNoteBody(raw) === NEUTRAL_BODY, JSON.stringify(m.humanNoteBody(raw)));
    assert.ok(m.humanNoteTitle(raw) === "(untitled note)", JSON.stringify(m.humanNoteTitle(raw)));
    assert.ok(m.humanEvidenceExcerpt(raw, "note").includes("Supporting detail is available in context."), JSON.stringify(m.humanEvidenceExcerpt(raw, "note")));
    assertNoLeak(m.humanNoteBody(raw), "bare-brace");
  });
  check("bare backslash-escaped object body/title/excerpt -> neutral, no leak", () => {
    const raw = "{\\\"reviewToken\\\":\\\"internal";
    assert.ok(m.humanNoteBody(raw) === NEUTRAL_BODY, JSON.stringify(raw) + " got " + JSON.stringify(m.humanNoteBody(raw)));
    assert.ok(m.humanNoteTitle(raw) === "(untitled note)", JSON.stringify(m.humanNoteTitle(raw)));
    assert.ok(m.humanEvidenceExcerpt(raw, "note").includes("Supporting detail is available in context."), JSON.stringify(m.humanEvidenceExcerpt(raw, "note")));
    assertNoLeak(m.humanNoteBody(raw), "bare-bs");
    assertNoRawJson(m.humanNoteBody(raw), "bare-bs");
  });
  check("stringified bare unicode-escaped body/title/excerpt -> neutral", () => {
    const raw = JSON.stringify("{\\u0022reviewToken\\u0022:\\u0022internal");
    assert.ok(m.humanNoteBody(raw) === NEUTRAL_BODY, JSON.stringify(m.humanNoteBody(raw)));
    assert.ok(m.humanNoteTitle(raw) === "(untitled note)", JSON.stringify(m.humanNoteTitle(raw)));
    assert.ok(m.humanEvidenceExcerpt(raw, "note").includes("Supporting detail is available in context."), JSON.stringify(m.humanEvidenceExcerpt(raw, "note")));
    assertNoLeak(m.humanNoteBody(raw), "bare-u-stringify");
  });
  check("stringified bare backslash-escaped body -> neutral", () => {
    const raw = JSON.stringify("{\\\"reviewToken\\\":\\\"internal");
    assert.ok(m.humanNoteBody(raw) === NEUTRAL_BODY, JSON.stringify(m.humanNoteBody(raw)));
    assertNoLeak(m.humanNoteBody(raw), "bare-bs-stringify");
  });
  // ---- Overdepth encoding (review 916c063 P2 group 2): 6/7/12 layers fail neutral.
  check("six-encoded object body/title/excerpt/evidenceTitle -> neutral", () => {
    let s = JSON.stringify({ reviewToken: "internal" });
    for (let i = 0; i < 5; i++) s = JSON.stringify(s);
    assert.ok(m.humanNoteBody(s) === NEUTRAL_BODY, JSON.stringify(m.humanNoteBody(s)).slice(0, 200));
    assert.ok(m.humanNoteTitle(s) === "(untitled note)", JSON.stringify(m.humanNoteTitle(s)).slice(0, 200));
    assert.ok(m.humanEvidenceExcerpt(s, "note").includes("Supporting detail is available in context."), JSON.stringify(m.humanEvidenceExcerpt(s, "note")).slice(0, 200));
    assert.ok(m.humanEvidenceTitle(s, "note", null) === "Supporting excerpt", JSON.stringify(m.humanEvidenceTitle(s, "note", null)).slice(0, 200));
    assertNoLeak(m.humanNoteBody(s), "depth6-body");
    assertNoLeak(m.humanNoteTitle(s), "depth6-title");
  });
  check("seven-encoded object body/excerpt -> neutral", () => {
    let s = JSON.stringify({ reviewToken: "internal" });
    for (let i = 0; i < 6; i++) s = JSON.stringify(s);
    assert.ok(m.humanNoteBody(s) === NEUTRAL_BODY, JSON.stringify(m.humanNoteBody(s)).slice(0, 200));
    assert.ok(m.humanEvidenceExcerpt(s, "note").includes("Supporting detail is available in context."), JSON.stringify(m.humanEvidenceExcerpt(s, "note")).slice(0, 200));
    assertNoLeak(m.humanNoteBody(s), "depth7");
  });
  check("twelve-encoded object body/title/excerpt -> neutral", () => {
    let s = JSON.stringify({ reviewToken: "internal" });
    for (let i = 0; i < 11; i++) s = JSON.stringify(s);
    assert.ok(m.humanNoteBody(s) === NEUTRAL_BODY, JSON.stringify(m.humanNoteBody(s)).slice(0, 200));
    assert.ok(m.humanNoteTitle(s) === "(untitled note)", JSON.stringify(m.humanNoteTitle(s)).slice(0, 200));
    assert.ok(m.humanEvidenceExcerpt(s, "note").includes("Supporting detail is available in context."), JSON.stringify(m.humanEvidenceExcerpt(s, "note")).slice(0, 200));
    assertNoLeak(m.humanNoteBody(s), "depth12");
  });
  // ---- Ordinary prose preservation (review 916c063 P2 group 3).
  check("numeric bracket prose body/title/excerpt/evidenceTitle preserved", () => {
    const prose = "[2026] Budget review tomorrow.";
    const b = m.humanNoteBody(prose);
    assert.ok(b.includes("[2026]") && b.includes("Budget review tomorrow."), JSON.stringify(b));
    assert.ok(!b.includes("available in context"), JSON.stringify(b));
    const ti = m.humanNoteTitle(prose);
    assert.ok(ti.includes("[2026]") && ti.includes("Budget review"), JSON.stringify(ti));
    const ex = m.humanEvidenceExcerpt(prose, "note");
    assert.ok(ex.includes("[2026]") && ex.includes("Budget review"), JSON.stringify(ex));
    const et = m.humanEvidenceTitle(prose, "note", null);
    assert.ok(et.includes("[2026]") && et.includes("Budget review"), JSON.stringify(et));
    assertNoLeak(b, "numeric-bracket");
  });
  check("stringified numeric bracket prose preserved", () => {
    const out = m.humanNoteBody(JSON.stringify("[2026] Budget review tomorrow."));
    assert.ok(out.includes("[2026]") && out.includes("Budget review tomorrow."), JSON.stringify(out));
    assert.ok(!out.includes("available in context"), JSON.stringify(out));
  });
  check("nested [note] text preserved in all four exports", () => {
    const raw = JSON.stringify({ text: "[note] remember to call finance" });
    const b = m.humanNoteBody(raw);
    assert.ok(b.includes("[note]") && b.includes("remember to call finance"), JSON.stringify(b));
    assert.ok(!b.includes("available in context"), JSON.stringify(b));
    const ti = m.humanNoteTitle(raw);
    assert.ok(ti.includes("[note]") && ti.includes("remember to call finance"), JSON.stringify(ti));
    const ex = m.humanEvidenceExcerpt(raw, "note");
    assert.ok(ex.includes("[note]") && ex.includes("remember to call finance"), JSON.stringify(ex));
    const et = m.humanEvidenceTitle(raw, "note", null);
    assert.ok(et.includes("[note]") && et.includes("remember to call finance"), JSON.stringify(et));
    assertNoLeak(b, "nested-note");
  });
  check("nested numeric bracket text preserved", () => {
    const raw = JSON.stringify({ text: "[2026] Budget review tomorrow." });
    const b = m.humanNoteBody(raw);
    assert.ok(b.includes("[2026]") && b.includes("Budget review tomorrow."), JSON.stringify(b));
    assert.ok(!b.includes("available in context"), JSON.stringify(b));
    const ti = m.humanNoteTitle(raw);
    assert.ok(ti.includes("[2026]"), JSON.stringify(ti));
  });
  check("quoted-label prose preserved in evidence exports", () => {
    const prose = JSON.stringify("\"Approved\": use this label after review.");
    const ex = m.humanEvidenceExcerpt(prose, "note");
    assert.ok(ex.includes("Approved") && ex.includes("use this label"), JSON.stringify(ex));
    const et = m.humanEvidenceTitle(prose, "note", null);
    assert.ok(et.includes("Approved") && et.includes("use this label"), JSON.stringify(et));
  });
  check("valid numeric array still projects (no overcorrection)", () => {
    const out = m.humanNoteBody(JSON.stringify([2026]));
    assert.ok(out.includes("2026"), JSON.stringify(out));
    assert.ok(!out.includes("available in context"), JSON.stringify(out));
  });
  check("symmetric body/title/evidence for truncated known-field prose", () => {
    const raw = JSON.stringify({ title: "Budget review", text: "[note] remember to call finance" });
    const b = m.humanNoteBody(raw);
    assert.ok(b.includes("Budget review") && b.includes("remember to call finance"), JSON.stringify(b));
    assertNoLeak(b, "symmetric-known");
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
