# Essentials QA (Muse-owned)

Selected scope only: navigation/access, records review, saved-data/startup
reliability, Secretary assistant, voice dictation. Full optional
Wiki/meeting-guest/deep-usage/background-job work is OFF SCOPE.

## Ownership

- This directory (`qa/essentials/*`) plus the narrow checkpoint note
  (`qa/docs/essentials-qa-checkpoint.md`) is the ONLY tree this QA author
  writes. No production/server/web edits, no other worktree writes.
- Owned services: QA API **5142**, QA fake **5242**, QA web **5194**,
  owned PG container `simceo-integration-qa-pg` (localhost **15441**,
  full id `14bcfcf7a243...`, left RUNNING, never stopped here).
  NEVER user 5080/5173/9333, backend 5140/5240/5193, or any foreign container.
- Foreign busy port: FAIL, never reuse. Fresh per-run GUID + per-leg
  artifacts (refuse overwrite). No creds/tokens/salts in logs or artifacts
  (only 12-char digests).

## Runner

Single required pipeline (run from the QA worktree root):

```powershell
pwsh -ExecutionPolicy Bypass -File qa/essentials/run-essentials.ps1 -Approot <path-to-essentials-runnable-worktree> -Legs leg0
pwsh -ExecutionPolicy Bypass -File qa/essentials/run-essentials.ps1 -Approot <path-to-essentials-runnable-worktree> -Legs leg1,leg3,leg4,leg5
pwsh -ExecutionPolicy Bypass -File qa/essentials/run-essentials.ps1 -Approot <path-to-essentials-runnable-worktree> -Legs leg2,leg6,leg7
```

- `-ProjectRoot` defaults to the QA worktree root (derived from the script
  location). `-Approot` defaults to the sibling
  `essentials-runnable-worktree`; both are VALIDATED (marker files), never
  trusted blindly, and no other app root is hardcoded.
- Contract-only early run (no backend needed): `-Legs leg0`.
- leg2/leg7 are self-managed (runner owns the exclusive DB only; the leg
  owns its API generations for restarts/outage). leg6 builds the ACTUAL
  production web (`tsc` + Vite, native exit 0, dist hashed) and serves it
  via the owned static proxy.
- A REQUIRED `--selftest` gate runs after publish; the pipeline continues
  so legs still validate, but the final verdict stays FAIL until the
  server owner lands the one-line fixture fix (see checkpoint).

## Legs

| Leg | File | Needs backend | Covers |
|-----|------|---------------|--------|
| leg0 | tests/leg0-root-config.mjs | no | ProjectRoot/Approot validation, owned-port contract, forbidden ports, FULL container identity, fresh run ID |
| leg1 | tests/leg1-core-smoke.mjs | API+fake+PG | DLL identity + loaded PG proof, secure anon-401, READY advisor setup, boards/meetings/discussion/wizard/directRun, serial logout + ACTUAL hold/logout/release, bid+reply ledger pairs + prior rows intact |
| leg2 | tests/leg2-old-upgrade.mjs | PG+API gens | genuine 94d16 dump restore, pre/post full fingerprints, 3 API gens (TWO restarts), startup migration proof, old-table preservation + new-table allowlist, legacy JobPayload verbatim |
| leg3 | tests/leg3-records.mjs | API+fake+PG | review exact bytes/stateValid/pending, outsider 403, partial export, open-draft gates, stale 409 + REAL refresh POST, revise/discard, decided effective/export, empty/invalid/missing 4xx/404, held-token ABA |
| leg4 | tests/leg4-secretary.mjs | API+fake+PG | direct routing, provisional never decision, ledger pair, sequential + CONCURRENT nonce overlap, exact quote in evidenceJson, bare-meeting briefing limits, edit/stale-409/current-row reverse/history, clarification bind/replay/conflict, delivery summary + ordered messages hashed from wire |
| leg5 | tests/leg5-voice.mjs | API+fake+PG | strict WAV matrix, draft exact + creator-private, finalize + 409, armed-502 ONE FAILED pair + fresh retry ONE successful pair + prior rows intact |
| leg6 | tests/leg6-web.mjs | API+fake+PG+web | production build + owned proxy (no owner injection), headless Edge desktop/mobile/light/dark/keyboard, UI login, nav/back/forward/reload/invalid routes, 403/archived DOM, approval DOM, stale-409 + UI refresh POST, Adopt verbatim, secretary intent/history, voice DRAFT/edit-no-autosend/cancel/permission/retry, token ABA, late-401 purge + relogin, localStorage strings, legitimate 204 |
| leg7 | tests/leg7-backup-outage.mjs | PG+API gens+fake | backup roundtrip (hash verifies), 3 failed-restore refusals + state unchanged, live billed pair, held restore-epoch discard, real COMMIT fault (QA trigger) + retry adoption, outage (drop OWN db): ready 503 / health 200 / redacted diag, recreate + restore + preservation, TWO restarts, ledger alive |

## Rules every leg follows

- Real handlers only (`RecordFull`/public endpoints), never surrogate
  direct table appends.
- Array endpoints asserted as actual arrays with exact `Length`.
- Ledger windows are `OrderByDescending(At)`: compare ID sets, never
  last-row-as-new. Billed attempts share ONE nonzero GUID across
  ModelCalls+Usage; every new pair must be complete, prior rows intact.
- Fake counters are NOT synchronization: always `waitFor` the correlated
  API/proxy/ledger state.
- No credentials/tokens/salts in logs or artifacts; only digests.
- One final verdict AFTER all cleanup; any failure (including cleanup)
  exits nonzero.