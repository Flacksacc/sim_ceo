# Essentials QA checkpoint (Muse-authored, QA worktree only)

Scope: navigation/access + records review + saved-data/startup reliability,
PLUS Secretary assistant + voice dictation. No Wiki/guests/deep-usage/
background-job feature work. QA owns ONLY `qa/essentials/*` (+ this note).

## Committed pipeline (this checkpoint)

- `qa/essentials/run-essentials.ps1` — single required runner.
  Source-bind (Approot HEAD + dirty-diff hash) -> fresh publish (native
  exit 0 + DLL SHA) -> owned PG identity/start -> per-leg FRESH
  `essentials_<leg>_<stamp>` DB -> owned hidden API/fake (retained handles,
  bounded stdout/stderr EOF + completion) -> node leg -> bounded cleanup
  (drop owned DBs, restore container state, fail on owned leaks) ->
  ONE final verdict AFTER cleanup (`essentials-result.txt`), nonzero on
  any failure. Refuses unknown/deferred legs (fail-closed).
- `qa/essentials/helpers/essentials-http.mjs` — honest HTTP helper
  (real arrays + exact Length, 30s bounds, Bearer/digest-only logging).
- `qa/essentials/helpers/essentials-fake.mjs` — owned deterministic fake
  (chat/bids/replies/interview/research/secretary/transcribe shapes mirror
  proven harnesses) + `POST /__ess/arm` + `POST /__ess/reset` for owned
  held-fault proofs. No live network.
- `qa/essentials/tests/leg0-root-config.mjs` — backend-independent contract.
- `qa/essentials/tests/leg1-core-smoke.mjs` — health/ready/backend-PG hash,
  register/login, boards/meetings/discussion/wizard/directRun on real
  handlers, wrong-password isolation, held-logout no-publication, one
  billed ledger pair (calls+usage complete-window equality).
- `qa/essentials/tests/leg3-records.mjs` — draft/approve/revise/discard,
  review/effective/export, guard version/hash/watermark, 409-then-refresh,
  held-token ABA, outsider 403, missing 404, empty/dup 4xx.
- `qa/essentials/tests/leg4-secretary.mjs` — direct routing (no bids),
  provisional-never-decision, nonce replay + drift-409, MESSAGE exact
  quote (whitespace/unicode), omissions visible, edit/revise-409/reverse/
  history, clarify bind + replay + conflict-409, delivery RAW-wire hash.
- `qa/essentials/tests/leg5-voice.mjs` — strict WAV valid/reject matrix
  (reuses proven `qa/voice-wav.mjs`), draft-only exact bytes +
  creator-private, finalize-once + 409, armed-502 held (no pair) then
  fresh retry exactly one BOTH-ledger pair with prior rows intact.

## Runner command

```powershell
pwsh -ExecutionPolicy Bypass -File qa/essentials/run-essentials.ps1 -Approot <path-to-essentials-runnable-worktree> -Legs leg0,leg1,leg3,leg4,leg5
```

Contract-only early proof (no backend, NOT acceptance; runner requires pwsh 7):

```powershell
pwsh -ExecutionPolicy Bypass -File qa/essentials/run-essentials.ps1 -Approot <path-to-essentials-runnable-worktree> -Legs leg0
```

## Supported right now / deferred

Supported: leg0, leg1, leg3, leg4, leg5.
Deferred (NOT claimed, runner refuses): leg2 old-dump upgrade + second
restart, leg6 navigation/browser + web build/serve, leg7 backup/outage/
restore-epoch. Deferred legs land after: backend seeding checkpoint
(`MAIN.tmp/essentials-seed-interface.txt`), UI declares ready, and the
LAST source edit — full matching validation only then.

## Ownership recap

QA API 5142 / fake 5242 / web 5194; owned PG
`simceo-integration-qa-pg` (14bcfcf7a243, postgres:16-alpine, 15441).
Foreign busy port FAILS, never reused. Fresh per-leg artifacts; runner log
never hashed before final writes. No creds/tokens in logs (digests only).