# Advisor claim endpoint gateway/commit regression (claim-endpoint)

Sole author: Muse. Production frozen at CBC/851 (exact CBC source + prior QA base);
existing fixtures and production files untouched. New/owned only:
qa/advisor-claim-endpoint-fake.mjs, qa/advisor-claim-endpoint-qa.mjs, this doc.

## What it proves via actual endpoints (no static source as proof)

- Owns exact loopback stack API 127.0.0.1:15500 + fake 127.0.0.1:15502, dummy key,
  unique instance qa-claim-endpoint-15500, absolute CONTENTROOT/keyring, refuses
  occupied ports, controlled child env (dummy fake only, no NODE hooks/PG/.env),
  no other worktrees, no PG/Docker, env real provider human.
- Provenance BEFORE first mutation (honest, no build inside harness): git HEAD
  present plus publish DLL SHA256 recorded; QA_EXPECTED_SOURCE_REV (full 40-hex)
  + QA_EXPECTED_DLL_SHA (sha256 of publish/SimCEO.Api.dll) must both match or
  harness FATALS (stale prebuilt refused). QA_FRESH_BUILD never built anything
  and its old bypass is removed: QA_FRESH_BUILD=1 now fails fast with
  provenance-fresh-build-removed. Primary must fresh-publish (dotnet publish)
  from the combined source, record HEAD+DLL SHA, then rerun this harness pinned.
- Registers a real private QA user, then actual POST /api/roster/ai-draft twice:
  unsupported (CLAIMENDPOINT-UNSUPPORTED + CLMEP-U marker) and supported
  max-budget (2000-char focus + CLMEP-S marker, evidenceCount 5 distinct).
- Fake captures delivered prompts and returns MIXED lines: FACT alpha +
  INTERPRETATION beta + second FACT gamma sharing the fact URL (distinct
  passage) + URI-identity variants with OTHER distinct quotes (wrong path case,
  trailing slash, query-value case) + host-case variant (same quote, canonical
  retain) + one unsupported note. Each line has an exact URL/quote/kind;
  web_search_call snippets match exactly. Unsupported branch returns only the
  unsupported line with no web_search_call, so Atomic commits unsupported.
- Same-flow correlation: each dossier/profile/compiler log, responseId, and
  order assertion is filtered by its own CLMEP-U/S/C marker (never joined
  short-flow logs). ResponseIds contain their flow marker; dossier precedes
  profile/compiler per flow. Grammar (KIND | / EVIDENCE: / EXACT format) is
  asserted inside the SAME max-flow dossier log, length <= 16000, no URL
  prefix checks.
- All claims individually verified: FACT alpha/gamma exact URL+quote/kind/verified,
  INTERPRETATION beta exact, wrongpath/slash/querycase distinct exact, hostcase
  retained to canonical FACT_URL, unsupported verified false with empty refs/sources.
  Character S1..S5 each resolve SID to its FULL 2000-char URL with exact quote.
- Unsupported coherence AFTER real Atomic commit: researched false, draftStatus
  unsupported, evidenceCount 0; GET stage unsupported (not running), researchedAt
  null; responseId carries U marker; canonical read contains the entry.
- Behavior-save preservation (tags-only insufficient): valid full three-paragraph
  profileJson PUT on unsupported AND supported/character branches, then canonical
  readback shows ResearchJson draftStatus pinned (unsupported stays unsupported,
  supported becomes saved), savedProfileHash present, version +1, ResearchInputsJson
  unchanged, GET stage still terminal.
- Staging uses provider-generated portrait (same fake, no external fetch) so
  portrait gate clears while research gate stays open: copy 201; approve 409
  research-unsupported with grounded-evidence wording.
- Character max accepted: name 120 + role 500 + problem 4000 at POST /character,
  then focus 2000 + background 4000 + FIVE full 2000-char distinct URLs at
  POST /research; complete SID bindings and full URLs delivered in the same flow;
  dossier prompt <= 16000; elapsed bounded.
- Maximum-link dossier: five 2000-character URLs are retained and resolved in
  partial claims, then compilation fails explicitly when that dossier exceeds
  its smaller compile budget. The stage becomes failed and stops running.
  A separate explicit research request with ordinary-length URLs proves recovery.
- Bounds: exactly 4 responses + 3 chat (U/S/C plus one max-link dossier failure;
  the rejected dossier never reaches compile, no third validator);
  per-flow elapsed under deadlines; cleanup verified (children EXIT + ports
  closed) and controls final exit AFTER cleanup; pidfile removed only when clean,
  retained when uncertain.

## Run (only when 15500/15502 free and safe; primary fresh publish/rerun after merge)

# Primary (combined source, e.g. e74a68f): fresh-publish then record pins:
#   dotnet publish server/SimCEO.Api/SimCEO.Api.csproj -c Release -o ../own-15500-15502/publish
#   git rev-parse HEAD  # -> QA_EXPECTED_SOURCE_REV
#   sha256sum ../own-15500-15502/publish/SimCEO.Api.dll  # -> QA_EXPECTED_DLL_SHA
# Then pinned (only supported invocation; no build inside harness):
QA_EXPECTED_SOURCE_REV=<full 40-hex HEAD> QA_EXPECTED_DLL_SHA=<sha256 dll> node qa/advisor-claim-endpoint-qa.mjs
# QA_FRESH_BUILD=1 is removed and fails fast; it never built.

Exit 0 PASS, 1 FAIL (incl. cleanup failure), 2 FATAL/setup. Leaves owned rows for forensics (exact-ID scope only).

## Fixes in this revision (no assertion weakening)

- Diagnostics no longer eagerly throw: all JSON.stringify(x).slice extras use
  safe truncJson(x, n) (undefined -> "undefined"), so a missing claim reports
  FAIL with bounded context instead of FATAL Cannot read properties of undefined
  (reading slice). Assertion conditions unchanged.
- FATAL path prints bounded message + stack (2000 chars) + accumulated
  results (last 25, 4000 chars) before exit, and cleanup runs in finally so
  ports/children are always reaped; pidfile retained only when uncertain.
- This branch does not contain production inventory fix e8871e0 (source-only);
  primary reruns the combined actual current source with fresh publish + pins.

## Unexecuted and why (truthful limits)

- Owner-fetch positive + no-refetch production counts: established ONLY by the
  separate production-worker injected gateway probe (34792 path), NOT by this
  loopback fake. Loopback URLs are SSRF-pinned non-public by design.
- Localhost/SSRF weakening negatives: not attempted by design.
- Paid-network provider wording/timing: fakes only.
- Fault-injection seams (FailCleanupFault etc.): never set.
- PG/Docker/human ports/.env keys/providers/other roots: never touched.
- Prior 41/0 primary result concerned older 67a902f source, not this CBC/851 run.
- Parallel readonly review may read but never changes production.

## Direct verification after background shutdown

Primary `66e0a86` fresh publish and pinned endpoint run: **92 passed, zero
failed** (`.tmp/primary-direct-advisor-endpoint2-runtime.log` in the parent QA
directory). The canonical roster response is unwrapped through `entry`;
paragraph-only saves retain ResearchInputsJson byte-for-byte. Child cleanup
recognizes exit or signal completion and waits for both owned ports to close.
The generated character description is bounded independently while the full
role/problem remain in ProfileJson. No real provider or human data was used.
