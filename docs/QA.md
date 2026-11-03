# SimCEO QA record

Last verified: 2026-10-28 (UTC). Loopback runs on the dev machine unless noted.

## Automated gates

| Gate | Command | Result |
|---|---|---|
| Server selftest (memory) | `dotnet run --project server/SimCEO.Api -- --selftest` | PASS (14 areas) |
| Server selftest (Postgres) | `USE_POSTGRES=1 CONNECTIONSTRINGS__APP=Host=localhost;Port=5433;… dotnet run … -- --selftest` against throwaway `postgres:16-alpine` | PASS (14 areas); rows confirmed in tables |
| HTTP E2E (memory + Postgres) | `pwsh /tmp/simceo-e2e.ps1` vs port 5099/5100 | PASS except `audition` (see note 1) |
| Tasks probe (auth/export/import/backup/restore/extract) | `pwsh $env:TEMP/simceo-tasks-probe.ps1` | ALL PASS (15 checks) |
| Web typecheck + build | `npm run build --prefix web` (`tsc --noEmit && vite build`) | PASS |
| SignalR negotiate | `POST /hubs/board/negotiate?negotiateVersion=1` | connectionId returned |

Note 1: `audition` asserts the answer contains "placeholder" (stub era). With the
live Meta key the endpoint returns a real model answer with `stored=false`, which
is the intended behavior; the assertion is stale, not a regression.

## Perf (task 23)

Local loopback, Debug build, in-memory store, 30 seeded messages. All
endpoints 11–17 ms: boards-list 17, meetings-list 13, messages-take60 14,
delivery 11, recall 14, status 14, usage 14, export-board 16, audit-200 12.
No N+1 patterns: list endpoints are single in-memory scans or single EF
queries; Postgres writes are lock-serialized per operation.

## Accessibility pass (task 24)

- Rail nav has `aria-label` + `aria-current`; virtualized lists have
  `aria-label`; icon-less buttons carry text labels; status text uses
  `role="status"`; scope picker is a labelled native `<dialog>`.
- `:focus-visible` outline and a skip-to-content link added
  (`web/src/styles.css`, `web/src/App.tsx`).
- `prefers-reduced-motion` reset already present.
- Not done: screen-reader run-through, keyboard-only walkthrough of the
  wizard, contrast-ratio measurement. No canvas or custom widgets.

## Bugs found and fixed during this pass

- Docling upload used multipart field `file`; docling-serve requires `files`.
- Board export serialized PascalCase while import reads camelCase → 500.
  Export now uses `JsonSerializerDefaults.Web`.
- Sources Approve/Exclude buttons posted to routes that never existed (404).
  They now PATCH `{approved}/{excluded}` (also added to the API).
- Sources could never become approved, so recall never returned them.
- `MessageList.Add` hid (not overrode) `List.Add`; Postgres appends were
  silently lost until all table APIs return `MessageList`.

## Session durability test (2026-10-28, stack on Postgres)

- Register → `/api/auth/me` with token: `authenticated=True` before restart.
- `docker compose restart app` → same token: `authenticated=False`, user
  falls back to demo `owner` identity. Sessions are memory-only: every
  restart logs everyone out (by design, documented limitation).
- Re-login with the same credentials after restart: OK, new 64-char token.
  Accounts persist in Postgres; only the session cookies don't.

## UI redesign (2026-10-28)

Token-based stylesheet (`web/src/styles.css`): sidebar + topbar shell,
grouped nav (Overview/Build/Run/Manage), real buttons, ledger tables, toast
system replacing all 34 `alert()` popups, dark theme, responsive collapse.
Voice tab removed; dictation is a mic button in the meeting composer that
appends the transcript to the draft. Verified: `tsc --noEmit && vite build`
clean, served bundle on the stack contains the new shell (maincol/toasts/
topbar markers present), server E2E unaffected (no API changes).

## Boardroom messaging redesign (2026-10-28)

Meet tab rebuilt as agenda/members rail + tabbed center
(Discussion/Takeaways/Options/Decision) + brief/evidence/record inspector.
Identity headers with initials, timestamps, challenge + citation chips, new-
message pill, audience selector (Everyone/Secretary), measured virtualization,
density toggle. Verified: `tsc` clean, served bundle markers present, stack
E2E all-pass. Critique fixes: widened content cap for 3 panes, honest toggle
semantics (`aria-pressed`), agenda `aria-current`. Deferred (no server data):
stance labels, reply threading, excerpt page refs, in-thread photo avatars.
Note: a parallel mock page (`web/boardroom-template.*`) from another session
was left unshipped (single-entry build restored); density toggle borrowed.

## Known limitations

- Audit/usage/model-call streams, auth sessions, spend config, and rate-limit
  counters are memory-only; Postgres persists domain tables + messages.
- Postgres schema is created with `EnsureCreated` (no migrations yet).
- The `hindsight` compose service is a stub; recall merges remote hits only
  when a real service answers `/search` with an array.
- Single-process EF context with a lock: fine for one replica, not for
  multi-replica app deployments.

## Lane D client/API repairs (2026-11-02, MAIN, no barrier run yet)

- Atomic human-message append + DeliveredRevision/Generation in Atomic.Run inside MessageLock; forged advisor fields cleared.
- Record approve calls ValidateDraftItems for legacy persisted drafts; empty/duplicate/invalid rejected.
- LeadSetup binds the selected portrait identity, review state and provenance in the activation hash; ResolveLead global-only, board fallback, canonical identity/content/version.
- ModelPolicy: Standard data-use constrains effective model even with global contributor override (accepted snapshot preserved).
- Profile UI hydration keyed by board/profile ID+version with reset on missing; stray quote-space artifact removed; effective board lead GET fallback is lane B.
- Import UI sends current local accountId; wizard UI sends/updates version for save/start/answer/create; no UI-owned source of truth.
- Adopt-to-record: POST /api/meetings/{id}/record/from-direction with noteId (contribute check, board/meeting scope, exact multiline byte roundtrip, unapproved draft/current watermark/hash); UI Record this direction routes to record review; manual raw JSON path compatible.
- QA: --only unknown fails nonzero; browser console/page errors fail exit with own new context (never closes browser); fake provider QA-BADENVELOPE/QA-RESEARCHERR test-only controls; runner portable paths + real vite.qa.config + production PG publish verification; restart asserts portraits/approvals/interview/record/run outcomes; lane regression hooks run after core suite when present.
- Status: source/tests patched and compile-checked (dotnet build 0 errors; node --check clean). No shared QA stack restarted; no full suites run until all lanes report ready. No phase PASS claimed.

## Muse QA harness integration (2026-11-02, syntax check only, no full run)

- qa/run-qa.ps1 is now the one authoritative runner: preflight port gates, isolated build, fake :5199,
  HTTP mem plus backup, real C-sharp provider-envelope x8 on own :5202, isolated storage x7 and public-evidence
  probe artifacts, selftest, web build, production publish PG-staging assert, PG block with identity-boundary
  after pg plus backup and before persist-write, ownerless seed split across restart, rollback probe plus
  pending-restart write bracketing the owned :5100 restart with pid-change and port-gone gates, lanes on both
  backends, and -Browser extras (portable npm ci, profile-identity, navigation fixture) after the 23-check workflow.
- Barrier: main plus nav merge and retriever repairs are pending, so no full run was executed; PS parse 0 errors
  and node --check clean on all wired suites. Detail: .tmp/muse-qa-harness-integration-result.txt.

## Primary checkpoint 2026-11-02 (America/New_York, MAIN ONLY, phases 0-3 ACCEPTED)

Muse authored all application, test and script code; primary reviewed it and ran the acceptance checks. Backend commit 94d5ce0. API code unchanged between backend/live runs and final UI. Original 3 boards (2 archived) restored on :5080/:5173 with their saved contents and archival states preserved. Primary independently viewed desktop / dark / mobile screens.

### Harness
- Full: `qa/run-qa.ps1 -Pg -Browser` (backend HTTP/selftest/probes/publish/PG/lanes + browser).
- Frontend rerun only: `qa/run-qa.ps1 -BrowserOnly` (explicitly NOT backend acceptance; skips backend HTTP/selftest/probes/publish/PG/lane blocks).

### Backend legs (both full runs passed these; full runs FAILED UI-only, NOT whole-PASS)
- `.tmp/primary-combined-qa.log` + `.tmp/primary-combined-qa2.log`: memory HTTP 182 + backup 6; published-PG HTTP 182 + backup 6; provider envelope 8 (real C# gateway on own loopback :5202, dummy key); storage-failure 7 (isolated artifact); public-evidence fetch 105 (injected fixtures only); selftest + web build + production publish PG-staging at actual runtime; identity-boundary 30 (PG only, after pg+backup, before persist-write); persist-write 12 / persist-verify 17 across owned :5100 restart (pid-change + port-gone gates); actual pending-research / interview restart + SQL rollback probes on the PG leg; roster 87/89 plus ownerless PG seed 90; discussion 40 mem + 40 PG; import/interview 30 mem + 30 PG; core-snapshot 16 mem + 16 PG.
- Run 1 UI failures: app 22+1 fail, profile/wizard FATALS. Run 2 UI failures: wizard 4 fails + FATAL. Backend counts above still stand; do not cite either full log as whole-PASS.

### BrowserOnly final (frontend only, `.tmp/primary-browser-qa5.log`, QA RUNNER PASS browser-only)
- App 30 (real Adopt UI + returned record ID, exact draft-unapproved, from-direction 201/exact/url/review/draft-unapproved/old-approved); profile 19; dossier-evidence 15; wizard 57; navigation fixture 222 (desktop + mobile 390 + resize, dark included). No backend acceptance claimed by this log alone.

### Live generated text vs deterministic provider tests
- Actual Meta generated text: `.tmp/live-text-gate-primary6.log` LIVE GATE PASS 76 (wizard interview, grounded Grace Hopper dossier, fictional advisor + discussion, ledger + usage, 43 s actual runtime).
- Deterministic provider API tests (do NOT cite as generated text): real C# gateway envelope x8, storage x7, public-evidence 105, plus fake-provider QA-BADENVELOPE / QA-RESEARCHERR actual negative cases (retires the old insufficient-evidence-only-code-verified / not-naturally-triggerable notes).

### Restored-app read-only smoke
- `.tmp/primary-restored-live-navigation.log`: real user app on :5173, 9/0, read-only (board list, board/meeting hash writes, meeting heading, reload hash, Profile/Help, no page errors).

### Independent closures
- `.tmp/phase03-nonwizard-final-closure-review.txt` (findings 1,3-6 closed in source/bounded probes; not full 0-3 acceptance by itself).
- `.tmp/public-evidence-ancestor-closure-review.txt` (hidden-ancestor excerpts 7/0 in-RAM AngleSharp hydration).
- `.tmp/wizard-guide-final-closure-review.txt` (setup-guide bypass closed in source + props probes).
- Planned tag after commit (not created by this edit): phase03-verified-20261102.

### Limits preserved
- ASR codec path, image-live behavior, live readiness/runtime beyond the logged runs, and phase 9 accounting depth remain unverified and are not claimed. Phases 4-10 stay unchecked: phase 6 review-rejected (13 defects in fresh Muse fixing; PRODUCT skill creation owned by phase 6, not Main), phases 8/9 in separate worktrees unaccepted, phases 4/5/7/10 not implemented. Skill PRODUCT creation is not duplicated here.
- Reporting hygiene: `qa/navigation.cjs` footer now prints actual BASE/CDP instead of hardcoded :5175 (reporting only; no assertions/behavior). Obsolete `qa/launch.py` helper removed (run-qa owns launches via hidden Start-Hidden; no references remained).
