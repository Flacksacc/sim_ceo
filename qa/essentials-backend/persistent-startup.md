# Essentials persistent startup (authorized runnable; primary-only cutover)

## What this is
A NEW dedicated compose project `simceo-essentials` (db + app ONLY) with NEW
volumes `simceo_essentials_pgdata` / `simceo_essentials_appdata`. It preserves
the stopped production volume `sim_ceo_pgdata` (unknown older user data) by
never referencing it: no mount, no restore-over, no drop. QA proof databases
are separate and never mounted here.

## Preservation contract
- `sim_ceo_pgdata` is only INSPECTED (docker volume inspect) in preflight; the
  helper warns if it is missing, never creates or repairs it.
- Fresh user state must be captured (GET /api/backup on the CURRENT user API) immediately before any cutover, plus a config backup, and restored only into this new project DB by PRIMARY as the final coherent cutover after checks. Muse performs ONLY isolated new-project/ports proof; Muse never cuts over the human project.
- Container env comes from the SELECTED existing private app `.env`
  (`POSTGRES_PASSWORD`, private `META_API_KEY` app key, `META_API_BASE`),
  loaded by the helper into its PRIVATE process environment so the values
  always win over any inherited coding-profile key (compose `--env-file`
  has LOWER precedence than process env, so process env always wins, and every Compose call additionally passes an explicit env file (the selected approved file, or a controlled empty file), so a missing field is never backfilled from another discovered repo env).
  Never commit `.env`; never print keys, full `config`, or container env;
  the helper logs set/empty status only (never values, suffixes, full config, or container env).
- Ports: API `${APP_HOST_PORT:-5080}` (human default 5080, matches dev API + Vite 5173 origin). The human entry point :5173 must match API :5080 after cutover (Vite/proper forwarder or concrete start below). Stop any dev API on the chosen port first; the helper preflights this and fails before acquisition if busy.
- Build context is the repo root relative to the compose file (`../..`), so
  the same file works in a MAIN checkout and in a runnable worktree. The
  runtime image installs a portable curl/wget probe (apt/tdnf/apk covered;
  the build FAILS if no probe can be provided) and ships a working
  `HEALTHCHECK` on `/health`. Readiness additionally requires the real PG
  response body `{"ready":true,"store":"postgres"}` on `/ready`.

## Verified runtime facts (2026-11-03, Muse)
- `mcr.microsoft.com/dotnet/aspnet:10.0` contains NEITHER wget NOR curl NOR
  python3, so the Dockerfile installs the probe at build time (portable
  across apt/tdnf/apk) instead of assuming it.
- The helper validates with `compose config -q` (quiet: proves the render
  without printing interpolated secrets) and builds db AND app explicitly
  (`--build` on both, so no stale versioned image is reused).
- Native `dotnet publish` of SimCEO.Api + PG readiness + restart behavior are
  proven by the owned QA runner in this directory (`run.ps1`, per-run
  artifacts under `art-*`).

## Human commands (from the repo root, MAIN checkout)
```powershell
# review-only render (quiet; no containers, no volumes, no secrets printed):
powershell -File qa/essentials-backend/essentials-persist.ps1 -Action status
# start with the selected existing app .env (private; never modified). Concrete final start (primary cutover only): -File qa/essentials-backend/essentials-persist.ps1 -Action start -EnvFile .env
# status / stop (same explicit config works from a fresh shell; without
# private config, status lists owned containers by label and stop halts them
# by label, secret-free, volumes preserved):
powershell -File qa/essentials-backend/essentials-persist.ps1 -Action status
powershell -File qa/essentials-backend/essentials-persist.ps1 -Action stop
```
Readiness: `GET http://localhost:5080/health` 200 and
`GET http://localhost:5080/ready` 200 `{"ready":true,"store":"postgres"}`
plus `healthy` container status (`docker inspect` on the app container).
Rollback: `stop` ONLY and PRESERVE all volumes (NEVER `down -v` for the persistent human project). `sim_ceo_pgdata` and the old stack are unaffected.

## Isolated verification (agents/primary ONLY; never user ports)
Native build/runtime proof uses an ISOLATED project and ports, never
5080/5173/9333:
```powershell
powershell -File qa/essentials-backend/essentials-persist.ps1 -Action start -Project simceo-ess-verify -AppPort 5191 -PgPassword "verify-only-dummy" -MetaKey "verify-dummy" -MetaBase "http://127.0.0.1:9"
powershell -File qa/essentials-backend/essentials-persist.ps1 -Action stop -Project simceo-ess-verify -AppPort 5191
```
Dummy credentials only: no provider key from the coding profile, no live
paid call. The isolated project gets its own fresh volumes automatically
(compose prefixes named volumes per project).

## Pre-cutover human-state preservation (read-only; primary preflight)

Before ANY cutover, primary runs the read-only preservation helper
`qa/essentials-backend/capture-human-state.ps1` (Muse-authored, preservation
only; no app/test/runtime changes). It captures the ORIGINAL running old
human API (default `http://127.0.0.1:5080`) plus the MAIN private `.env`
into a NEW unique ignored `MAIN/.tmp/human-state-<UTCstamp>-<guid8>/` dir.
It never overwrites an existing capture, never mutates anything (GET-only,
no POST/PUT/import/restart/stop/Docker/SQL), and never prints bodies,
drafts, or credentials (manifest holds statuses, SHA256s, counts only).

Exact invocation from the MAIN checkout (helper file lives in this worktree,
finds its sibling browser helper by its own path, operates on MAIN):

```powershell
powershell -File C:/Users/War/scrach/sim_ceo/.tmp/essentials-runnable-worktree/qa/essentials-backend/capture-human-state.ps1 -MainRoot C:/Users/War/scrach/sim_ceo
# optionally also preserve original browser drafts via the existing allowlisted helper:
powershell -File C:/Users/War/scrach/sim_ceo/.tmp/essentials-runnable-worktree/qa/essentials-backend/capture-human-state.ps1 -MainRoot C:/Users/War/scrach/sim_ceo -IncludeBrowser
```

What the helper verifies: the `/api/backup` wrapper snapshot string SHA256
against `wrapper.hash` using the actual old `Hashing.FullHash` semantics
(lowercase hex SHA256 over the exact snapshot UTF8 bytes) before credit;
exact wrapper raw bytes AND exact embedded snapshot bytes are preserved
separately (no re-serialization). Counts only (no names/content) for
boards/meetings/messages/notes/drafts/roster/advisors/sources/wizardDrafts/
images/etc, plus raw `/ready`, `/api/activity/jobs`, `/api/usage`,
`/api/activity/audit`, `/api/models/calls`, `/api/model/status`,
`/api/spending`, and per-meeting `/api/meetings/{Id}/voice`.

Known old-backup omissions (documented in the capture manifest, must not be
misread): the domain backup carries NO accounts/sessions/grants/invites/
security-states/ACL (authstate is NOT exported and counts are never
inferred); audit is API-capped at 200 so zero `auth.register` events proves
nothing; `/api/model/status` never returns a raw key (only
configured/source/model/chatOverride-empty); jobs/usage/model-calls
endpoints truncate (take100/500/200). A complete capture is NOT cutover
readiness: the old in-memory API MUST NOT be stopped solely because a
domain snapshot exists (the snapshot is unrestorable without authstate and
is only one preflight input). Cutover/start remain BLOCKED on Docker
startup approval.

Do NOT overwrite the older checkpoint
`.tmp/dev-app-preservation-20261103-141739-UTC-backup.json`, and leave the
current MAIN `tmp.txt` (c924892, unknown origin) untouched.
