# Essentials QA checkpoint (Muse-authored, QA worktree only)

Scope: navigation/access + records review + saved-data/startup reliability,
PLUS Secretary assistant + voice dictation. No Wiki/guests/deep-usage/
background-job feature work. QA author owns ONLY `qa/essentials/*` (+ this note).

## Committed pipeline (this checkpoint)

- `qa/essentials/run-essentials.ps1` — single required runner.
  Dangerous-port preflight BEFORE ANY start (exact owned set API 5142 /
  fake 5242 / web 5194 / PG 15441; refuses 5080/5173/9333/5140/5240/5193 and
  all other foreign ports) -> source-bind (Approot HEAD + dirty-diff hash) ->
  fresh publish (native exit 0, BOTH SimCEO.Api.dll AND SimCEO.Postgres.dll
  SHA256) -> REQUIRED --selftest gate (in-memory; pipeline continues so legs
  still validate, final verdict stays FAIL if the gate ever regresses) ->
  owned PG full-ID identity/start (14bcfcf7a243..., left RUNNING, never
  stopped here; primary manages lifecycle centrally) -> per-leg FRESH
  `essentials_<leg>_<stamp>_<run8>` DB (regex-guarded, drop-only-own) ->
  owned hidden API/fake/web (retained handles from FIRST start, bounded
  waits, BOTH stdout EOF observed, unexpected-exit watch, async-spawn
  failure, outer-finally child handling, aggregated cleanup, port-leak
  checks) -> node leg -> bounded cleanup -> ONE final verdict AFTER cleanup.
  leg0 is contract-only (no publish, no container start, no DB).
  leg2/leg7 are self-managed (runner owns DB only; legs own API generations
  for restarts/outage). leg6 builds the ACTUAL production web (tsc+Vite
  exit 0, dist hash) and serves it via the owned static proxy (canonical
  headers, NO default owner injection; logged-out fetch is 401).
- `qa/essentials/helpers/essentials-http.mjs` — honest HTTP helper (real
  arrays + exact Length, 30s bounds, Bearer/digest-only logging) + waitFor
  correlated completion (fake counters are NOT sync) + ID-set ledger helpers
  (OrderByDescending(At): never last-row-as-new; ModelCalls+Usage share ONE
  nonzero GUID; newPairsComplete checks every new pair + prior rows intact).
- `qa/essentials/helpers/essentials-proc.mjs` — owned child launcher for
  self-managed legs (argv arrays, hidden, bounded, EOF-observed, no PID guess).
- `qa/essentials/helpers/essentials-pg.mjs` — owned-PG ops in the OWNED
  container only (verify full ID, exclusive DBs, canonical fingerprints,
  dump restore with verified temp cleanup, QA-owned Notes triggers).
- `qa/essentials/helpers/essentials-web.mjs` — owned static dist server +
  /api + /hubs (http + ws passthrough) proxy, canonical headers, never
  injects a default identity.
- `qa/essentials/helpers/essentials-fake.mjs` — deterministic fake
  (chat/bids/replies/interview/research/secretary incl. SECRETARY-BRIEFING/
  AMBIGUOUS/NOTE/SECOND-QUESTION + transcribe WAV accounting) +
  `POST /__ess/arm|reset` for owned held-fault proofs. No live network.
- `qa/essentials/probe/ActivateProbe.*` — QA-only read-only diagnostic that
  traced the frozen --selftest `activate` failure to its exact conditional
  (see "Known gate" below). No production writes, no fixture changes.

## Legs (all Muse-authored, real handlers only)

| Leg | File | Needs | Covers |
|-----|------|-------|--------|
| leg0 | tests/leg0-root-config.mjs | nothing | root markers, owned ports, forbidden ports, FULL container ID, fresh run ID |
| leg1 | tests/leg1-core-smoke.mjs | API+fake+PG | published DLL identity + loaded PG proof, secure auth-status + anon-401 (no 200 leak), READY approved-advisor setup before ANY run, boards/meetings/discussion/wizard/directRun, wrong-password isolation, honest serial logout-denies-new-post, ACTUAL controlled hold/logout/release (409 interrupted, publication unchanged, outcome note, billed pairs only if dispatched), bid+reply TWO complete pairs + prior rows intact |
| leg2 | tests/leg2-old-upgrade.mjs | PG+API gens | genuine 94d16 dump restore (exclusive DB, byte/size refs, internal checksums, family counts vs preserved canonical backup), pre-upgrade full fingerprint, 3 API gens (TWO restarts), startup migration proof, B==C==D, old ROWS byte-identical except explicit schema evolution (added tables + added columns with empty/canonical backfills; source collision renumbers only with content preserved + server-owned migrate-version event), legacy JobPayload verbatim + never executed |
| leg3 | tests/leg3-records.mjs | API+fake+PG | draft exact bytes via review draft.itemsJson + stateValid + pending, outsider 403 + no state change, partial-approve export, open-draft gates (effective 404, export 409), stale 409 + REAL refresh POST after new input (200, watermark moves), revise/discard, decided effective/export exact, empty/invalid/missing 4xx/404, held-token ABA |
| leg4 | tests/leg4-secretary.mjs | API+fake+PG | READY setup, direct routing (no bids), provisional never decision, correlated secretary ledger pair, sequential replay + drift 409, CONCURRENT same-nonce winner/409 + replay binds + single publication, exact quote in stored evidenceJson, bare-meeting briefing with visible [Limitation:] + empty evidence, edit/stale-409/current-row reverse/history growth, clarification bind/replay/conflict, delivery summary + ordered messages hashed from RAW wire text |
| leg5 | tests/leg5-voice.mjs | API+fake+PG | strict WAV valid/reject matrix, draft exact + creator-private (granted reader), finalize + 409, ARMED 502 bills ONE FAILED pair (shared GUID) + fresh retry bills ONE successful pair + prior rows intact |
| leg6 | tests/leg6-web.mjs | API+fake+PG+web | production build + owned proxy (no owner injection), headless Edge desktop/mobile/light/dark/keyboard, UI login, tabs/back/forward/reload/invalid routes, 403/archived DOM, approval DOM (manager present / reader absent), stale-409 + UI refresh POST, Adopt verbatim, secretary intent/history, voice DRAFT/edit-no-autosend/cancel/permission/retry, token ABA, late-401 purge + relogin, localStorage strings, legitimate 204 accepted, app alive |
| leg7 | tests/leg7-backup-outage.mjs | PG+API gens+fake | full backup roundtrip (hash verifies), 3 failed-restore refusals with state unchanged, live billed pair, held restore-epoch discard (interrupted, publication discarded), real COMMIT fault (QA trigger, uncertain 503) + retry adoption single publication, outage (drop OWN db): ready 503 / health 200 / redacted diag, recreate + restore + re-verify (grants/invites excluded by design), TWO restarts, ledger alive |

## Runner command

```powershell
pwsh -ExecutionPolicy Bypass -File qa/essentials/run-essentials.ps1 -Approot <path-to-essentials-runnable-worktree> -Legs leg0
pwsh -ExecutionPolicy Bypass -File qa/essentials/run-essentials.ps1 -Approot <path-to-essentials-runnable-worktree> -Legs leg1,leg3,leg4,leg5
pwsh -ExecutionPolicy Bypass -File qa/essentials/run-essentials.ps1 -Approot <path-to-essentials-runnable-worktree> -Legs leg2,leg6,leg7
```

Contract-only early proof (no backend, NOT acceptance): `-Legs leg0`.

## Latest validation (all selected legs green)

Approot runnable HEAD `ae1cdde6` (backend hardening in progress; UI merge in
progress). Each leg below passed in its own fresh per-leg DB on the owned
container, with native exits observed for every child:

| Leg | Result | Checks | Run artifact (`.tmp/ess-qa/<stamp>-<run8>/`) |
|-----|--------|--------|-----------------------------------------------|
| leg0 | PASS | 44 | 20261103-110033 contract-only |
| leg1 | PASS | 95 | 20261103-110548 held 401-path (2 billed pairs, no publication) |
| leg2 | PASS | 56 | 20261103-093747 old-16-tables byte-identical except explicit schema evolution; B==C==D |
| leg3 | PASS | 52 | 20261103-110033 review/export/effective/refresh semantics |
| leg4 | PASS | 76 | 20261103-110033 concurrent overlap + ledger pair + ordered delivery hash |
| leg5 | PASS | 97 | 20261103-110033 armed-502 FAILED pair + fresh retry pair |
| leg6 | PASS | 79 | 20261103-104007 production build + headless Edge DOM |
| leg7 | PASS | 110 | 20261103-105940 backup roundtrip + outage + restarts + ledger alive |

Full gate `leg0..leg7` in one invocation: latest full run 20261103-110033
has all legs PASS (leg1 held assertions finalized just after; leg1-only
rerun 20261103-110548 confirms 95 PASS, RUNNER PASS). No self-acceptance:
primary/dedicated-AI reviews retain acceptance; no user cutover.

## Known gate (server owner action required)

Frozen `--selftest` FAILED at seed 0f98 (`activate`, exit 1) when QA runs started; the backend owner has since fixed it (gate now exits 0 at runnable HEAD 9392a74b). The QA probe
(`qa/essentials/probe`) reproduces against actual server code and proves:
`LeadSetup.Activate` RETURNS 200 with the LIVE row activated
(`ActiveConfig=True`, `ActiveJson` set, hash stable, rehash-409 correct);
the selftest then asserts the STALE caller-held `board` reference, which was
orphaned by the preceding EXPECTED-FAILURE `Activate(board, null)` unit:
rollback `RestoreLive` replaces every live row with deep clones, so the
caller's `board.ActiveConfig` stays False while the store row is True.
This is a selftest-fixture staleness bug, NOT a production defect (HTTP
callers always re-read; all other selftest asserts pass).
Server-owner fix (one line, no behavior change, in `Program.cs` --selftest):
re-fetch before asserting, e.g.
`var liveBoard = store.Boards[board.Id];` then assert on `liveBoard`
(or assert on the returned `activated` row). QA made NO production write
and NO fixture change outside its ownership. The runner keeps the
`selftest-gate` REQUIRED: any run records its native exit, and the final
verdict stays FAIL until the server owner lands the fix.

## Ownership recap

QA API 5142 / fake 5242 / web 5194; owned PG
`simceo-integration-qa-pg` (14bcfcf7a243e5bc73385da4d24a33475b6eab0b04b8185e1d1534c13d1a1891,
postgres:16-alpine, 15441). Foreign busy port FAILS, never reused. Fresh
per-run GUID + per-leg artifacts (refuse overwrite). No creds/tokens in logs
(digests only). No prior/other DBs touched or dropped; no foreign containers;
container left RUNNING. Live paid calls OFF (fake only).