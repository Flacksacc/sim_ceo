# Records human-format final (Muse sole scope) — finding 4 fix

Sole-source scope: `web/src/human-format.ts` + `qa/records-human-format-final.cjs` (+ this note).
No UI/API changes. No launcher, API suite, or browser QA touched.

## Parent finding (records-181140d-independent-review.txt, finding 4)

`isQuotedJsonLike` used literal substrings (`\"`, `":`, `{"`, `["`):

- Missed Unicode-escaped inner JSON (`\u0022`, `\u007B`, `\u005B`): after a valid
  outer decode, a truncated inner layer fell through as prose and leaked
  protocol fields/JSON syntax. Repro: `humanNoteBody(JSON.stringify(
  '"{\\u0022reviewToken\\u0022:\\u0022internal'))` leaked `reviewToken`.
- Over-matched ordinary prose: `humanNoteBody(JSON.stringify(
  '"Approved": use this label after review.'))` was classified as malformed
  JSON and replaced with the neutral fallback, erasing human content.

## Fix (source architecture preserved)

- Added `decodeUnicodeEscapesForShape` (`\uXXXX` -> char for detection only),
  `hasJsonObjectPrefix` (`{"` / `{}`), `hasJsonArrayPrefix` (`["` / `[{` /
  `[[` / `[]` / number / `-` / `true` / `false` / `null`), `isBareJsonLike`.
- `isQuotedJsonLike` now requires a brace/bracket payload with a valid JSON
  prefix after unicode + `\"` normalisation. Bare quoted labels (`"Approved":`
  prose), `[note]` prose, and `{hello}` prose stay prose. Unicode/object/array
  payloads (`{"`, `["`, `\u0022`, `\u007B`, `\u005B`) still count as JSON-like
  and fail safe at every decode step and at the 3-layer limit.
- `tryParseJson` + all four callers (`humanNoteTitle`, `humanNoteBody`,
  `humanEvidenceTitle`, `humanEvidenceExcerpt`) now use `isBareJsonLike`
  instead of bare `startsWith("{"/"[")`, so validly-decoded bracket prose
  (`[note] ...`) is preserved while truncated protocol JSON still goes
  neutral. Bounded 3-layer decode and neutral fallback for unknown/truncated
  protocol JSON are unchanged.

## QA (actual exports via esbuild)

`qa/records-human-format-final.cjs` compiles the actual TS with
`npx esbuild web/src/human-format.ts --format=esm` and imports the build.
32 groups, no classifier mirroring:

- Exact review A (body/title/evidence unicode truncated) -> neutral, no leak.
- Exact review B (body/title quoted-label prose) -> preserved.
- Quoted ordinary prose: plain, quoted, `FYI:` label, `[note]`, `{hello}`,
  colon prose, parenthetical prose -> preserved.
- Unicode structural: object/array/brace truncated -> neutral; valid
  unicode-escaped JSON still projects.
- Layers: valid 2/3/4-parse chains project; 5x encoding fails safe neutral;
  escaped-backslash double-encoding projects without backslash leak.
- Truncated: known-field extracts; unknown object/array/escaped forms neutral.
- Existing projections: question+text, GUID scrub, omitted-manifest warning,
  record-version label, `parseRecordItems` smoke.

Results: `human-format-final: 32 groups passed`; existing
`qa/human-format-check.mjs: 7 groups passed`.
