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
