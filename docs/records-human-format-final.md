# Records human-format final (Muse sole scope) — finding 4 fix + 916c063 follow-up

Sole-source scope: web/src/human-format.ts + qa/records-human-format-final.cjs (+ this note).
No UI/API changes. No launcher, API suite, or browser QA touched.

## Parent findings

181140d finding 4: quoted classifier used literal substrings, missed
unicode-escaped inner JSON and over-matched quoted-label prose.

916c063 follow-up (three counterexample groups, source-traced):

1. Bare escaped JSON leaks protocol text (no outer quotes):
   humanNoteBody with bare unicode or backslash-escaped object shapes
   returned raw text including reviewToken; JSON.stringify outer layer
   also leaked after one successful decode.
2. Deeper encoding bypasses depth limit: 6x stringified object left three
   quoted layers after 3 decodes; classifier left an escaped structural
   quote after the brace and displayed encoded protocol text.
3. Ordinary prose preservation inconsistent: [2026] Budget review
   tomorrow suppressed as array prefix; known-field projections lost
   [note] remember to call finance inside object projection.

## Fix (source architecture preserved)

- Bare escaped shape normalization is detection-only: decodeUnicode for
  shape plus backslash-quote prefix in hasJsonObjectPrefix and
  hasJsonArrayPrefix. Human prose still preserved by callers; protocol
  shapes fail neutral with no source leak.
- Bounded depth stays max 3 actual decodes. After 3 successful string
  decodes a still-quoted string is unresolved overdepth (6, 7, 12+):
  fail honest neutral fallback regardless of deeper count; no unbounded
  decode is attempted.
- Numeric bracket prose guard: isBracketLabelProse treats [label] plus
  trailing words (no structural quotes or braces inside) as prose, so
  [2026] Budget review tomorrow is preserved while valid [2026] arrays
  still project.
- projectNestedString and classifier consistency across all callers:
  new looksLikeNestedPayload routes quoted, bare, and backslash-led
  shapes through the safe path; projectNestedString preserves
  non-JSON shapes (bracket-label prose) instead of dropping them, so
  nested text inside known fields survives in every export.
- All four exports (humanNoteBody, humanNoteTitle, humanEvidenceTitle,
  humanEvidenceExcerpt) share tryParseJson plus isBareJsonLike; evidence
  record version-label fallback is retained.

## QA (actual exports via esbuild)

qa/records-human-format-final.cjs compiles the actual TS with
npx esbuild web/src/human-format.ts --format=esm and imports the build.
48 groups, no classifier mirroring:

- Exact review A (body/title/evidence unicode truncated) -> neutral.
- Exact review B (body/title quoted-label prose) -> preserved, plus
  evidence title and excerpt quoted-label preservation.
- Bare escaped: bare unicode object, unicode brace, backslash-escaped,
  plus JSON.stringify outer layers -> neutral, symmetric
  body/title/excerpt/evidenceTitle, no leak or raw shape.
- Overdepth: 6-layer (body/title/excerpt/evidenceTitle), 7-layer
  (body/excerpt), 12-layer (body/title/excerpt) -> neutral, no leak.
- Prose: numeric bracket bare and stringified preserved in all four
  exports; nested [note] text preserved in all four exports; nested
  numeric bracket preserved; valid [2026] array still projects.
- Prior layers: valid 2/3/4-parse chains project; 5x fails safe;
  escaped-backslash double-encoding projects without backslash leak.
- Truncated: known-field extracts; unknown object/array/escaped neutral.
- Existing: question+text, GUID scrub, omitted-manifest warning,
  record-version label, parseRecordItems smoke.

Results: human-format-final: 48 groups passed; existing
qa/human-format-check.mjs: 7 groups passed (corrected file:// invocation).
