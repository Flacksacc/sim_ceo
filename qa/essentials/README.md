# Essentials QA (Muse-owned)

Selected scope only: navigation/access, records review, saved-data/startup
reliability, Secretary assistant, voice dictation. Full optional
Wiki/meeting-guest/deep-usage/background-job work is OFF SCOPE.

## Ownership

- This directory (`qa/essentials/*`) plus the narrow checkpoint note
  (`qa/docs/essentials-qa-checkpoint.md`) is the ONLY tree this QA author
  writes. No production/server/web edits, no other worktree writes.
- Owned services: QA API **5142**, QA fake **5242**, QA web **5194**,
  owned PG container `simceo-integration-qa-pg` (localhost **15441**).
  NEVER user 5080/5173/9333, backend 5140/5240/5193, or any foreign container.
- Foreign busy port: FAIL, never reuse. Every run uses fresh per-leg
  artifacts; the runner log is never hashed before final writes.

## Runner

Single required pipeline:

```powershell
pwsh -ExecutionPolicy Bypass -File qa/essentials/run-essentials.ps1 -Approot <path-to-essentials-runnable-worktree> -Legs leg0,leg1,leg3,leg4,leg5
```

- `-ProjectRoot` defaults to the QA worktree root (derived from the script
  location). `-Approot` defaults to the sibling
  `essentials-runnable-worktree`; both are VALIDATED (marker files), never
  trusted blindly, and no other app root is hardcoded.
- Contract-only early run (no backend needed): `-Legs leg0`.
- Full matching validation runs ONLY after backend/UI declare the last
  source ready. Early contract runs are labeled NOT acceptance.

## Legs

| Leg | File | Needs backend | Covers |
|-----|------|---------------|--------|
| leg0 | tests/leg0-root-config.mjs | no | ProjectRoot/Approot validation, owned-port contract, forbidden paths, container identity file |
| leg1 | tests/leg1-core-smoke.mjs | API+fake+PG | health/ready, register/login, boards/meetings/discussion/wizard/directRun, held-logout no-publish, one billed ledger pair, backend PG hash |
| leg3 | tests/leg3-records.mjs | API+fake+PG | record draft/approve/revise/discard, review/export, 409 refresh, held-token ABA, non-manager 403, missing 404 |
| leg4 | tests/leg4-secretary.mjs | API+fake+PG | direct routing, provisional never decision, edit/reverse/history, exact quote, omissions, clarify nonce binding, 201/drift-409 shape |
| leg5 | tests/leg5-voice.mjs | API+fake+PG | strict WAV valid/reject, draft-only exact bytes, finalize, held-502 no-pair + fresh retry one-pair |
| leg2 | (deferred) | — | old-dump clone/native restore + full field compare + second restart; runs only with seed checkpoint + old dump present |
| leg6 | (deferred) | UI ready | navigation/access browser + route contract; contract scan only until UI declares ready |
| leg7 | (deferred) | API+PG | backup roundtrip/prestate-failures/outage-503/restart-200/restore epoch; after last source edit |

Deferred legs are NOT claimed. The runner refuses unknown leg names
(fail-closed); no weak counts, no placeholder passes.

## Rules every leg follows

- Real handlers only (`RecordFull`/public endpoints), never surrogate
  direct table appends.
- Array endpoints asserted as actual arrays with exact `Length`
  (never nested-count `1` illusions).
- No credentials/tokens/salts/raw sessions in logs or artifacts; only
  12-char sha256 digests of QA tokens.
- One final verdict AFTER all cleanup; any failure (including cleanup)
  exits nonzero.