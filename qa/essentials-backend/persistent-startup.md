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
- Ports: app publishes `127.0.0.1:${APP_HOST_PORT:-5080}:5080` (loopback-only; helper generic default stays 5080). Final human concrete uses `-AppPort 5173` so compiled UI+API both serve on `localhost:5173` with no Vite proxy. Legacy old in-memory API on 5080 MUST STAY ALIVE for unsupported-auth-state/rollback; PRIMARY only backs up/releases the dev Vite 5173 holder during final handoff. The helper preflights the chosen port and fails before acquisition if busy.
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

## Human commands — FINAL handoff (primary-only cutover)
Final human stack serves compiled UI+API together on `localhost:5173` (loopback-only) from NEW project `simceo-essentials` with NEW volumes `simceo_essentials_pgdata` / `simceo_essentials_appdata` and the existing private MAIN `.env`. This is a different project from the `simceo-ess-final-15180` verification and uses NEW volumes — not old `sim_ceo_pgdata` and not QA volumes. No Vite proxy is needed for the compiled production UI. Legacy old API on 5080 stays alive for rollback. Helper generic default stays 5080 via `-AppPort`; final human passes `-AppPort 5173`.
```powershell
# review-only render (quiet; no containers, no volumes, no secrets printed):
powershell -File qa/essentials-backend/essentials-persist.ps1 -Action status
# FINAL human start — only after PRIMARY backs up/releases the dev Vite 5173 holder (legacy 5080 stays alive). Startup is already user-authorized; agent launch is currently blocked at the execution layer, so human manual fallback with this reviewed command may be required:
pwsh -NoProfile -File C:/Users/War/scrach/sim_ceo/.tmp/essentials-runnable-worktree/qa/essentials-backend/essentials-persist.ps1 -Action start -Project simceo-essentials -AppPort 5173 -EnvFile C:/Users/War/scrach/sim_ceo/.env
# status / stop (same explicit config works from a fresh shell; without
# private config, status lists owned containers by label and stop halts them
# by label, secret-free, volumes preserved):
powershell -File qa/essentials-backend/essentials-persist.ps1 -Action status
powershell -File qa/essentials-backend/essentials-persist.ps1 -Action stop
```
Readiness (final human): `GET http://localhost:5173/health` 200 and `GET http://localhost:5173/ready` 200 `{"ready":true,"store":"postgres"}` plus `healthy` container status (`docker inspect` on the app container). Generic helper default remains 5080 when `-AppPort` is omitted.
PRIMARY must fresh-capture/merge-coherently/restore the preserved legacy v2 data into the NEW PG ONLY and read-only smoke before declaring ready. Never claim already deployed or data restored.
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
finds its sibling browser helper by its own path, operates on MAIN).
Requires PowerShell 7+ (`pwsh`); Windows PowerShell 5.1 is not supported.

```powershell
pwsh -File C:/Users/War/scrach/sim_ceo/.tmp/essentials-runnable-worktree/qa/essentials-backend/capture-human-state.ps1 -MainRoot C:/Users/War/scrach/sim_ceo
# optionally also preserve original browser drafts via the existing allowlisted helper:
pwsh -File C:/Users/War/scrach/sim_ceo/.tmp/essentials-runnable-worktree/qa/essentials-backend/capture-human-state.ps1 -MainRoot C:/Users/War/scrach/sim_ceo -IncludeBrowser
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
misread): the domain backup v2 carries grants/invites domain data but NO
accounts/sessions/security-states/ACL (authstate is NOT exported and
account/session counts are never inferred; grants/invites counts are domain
data only, never permission/auth proof); audit is API-capped at 200 so zero
`auth.register` events proves nothing; `/api/model/status` never returns a
raw key (only configured/source/model/chatOverride-empty);
jobs/usage/model-calls endpoints truncate (take100/500/200). A complete
capture (native exit 0) means read-only data capture only and is NOT cutover
readiness: the old in-memory API MUST NOT be stopped solely because a
domain snapshot exists (the snapshot is valid for domain restore - legacy v2
domain restore passed the 315 probe - but NOT for full auth/policy state,
and is only one preflight input). Cutover/start require separate verification; isolated Docker startup is user-authorized with a reviewed manual fallback, but runtime execution is currently rejected pre-process by external execution policy.

Do NOT overwrite the older checkpoint
`.tmp/dev-app-preservation-20261103-141739-UTC-backup.json`, and leave the
current MAIN `tmp.txt` (c924892, unknown origin) untouched.

## Existing-stack update (rapid redeploy, primary-only run)

`-Action update` refreshes ONLY the app container of an already-live
`simceo-essentials` stack (human app on `127.0.0.1:5173`, db
`simceo-essentials-db-1`). It never boots a new stack, and the helper never
recreates or removes the db container or any volume: `start` still refuses
a busy port, and `update` refuses anything but the exact live match, then
fails closed before any swap when backups are not fresh and complete. The
new app image itself may run migrations on first boot, so schema/data can
change through the app; that is the app image's doing, not the helper's.

Exact human invocation (the approved private MAIN `.env` is explicitly
provided by primary; the helper repo root is derived from the helper file
location, never hardcoded):

```powershell
powershell -File qa/essentials-backend/essentials-persist.ps1 -Action update -Project simceo-essentials -AppPort 5173 -EnvFile C:/Users/War/scrach/sim_ceo/.env
```

What update does, in order (minimal downtime; the old app serves until swap):

1. Sealed approved env first (existing key guard: inherited coding-profile
   keys cleared, allowlisted file values win, compose env source sealed).
2. Existing-only preflight: exactly one live app and one live db container
   with matching `com.docker.compose.project` / `service` labels, the live
   app publishing exactly `127.0.0.1:<AppPort>`, the db container `healthy`, and the
   live named volumes mounted at the db/app data dirs inspected to exist (by volume name, not filesystem path). Anything else aborts.
3. Preserves a rollback image ref
   (`simceo-essentials-app:rollback-<UTC>-<id>`) from the running app image.
4. Builds the new app image while the old app stays up (verified still
   running after build; nothing recreated yet).
5. Takes fresh backups into a NEW gitignored private
   `<helper-root>/.tmp/update-<UTC>-<id>/` dir: a full cluster `pg_dumpall
   -c` dump (includes roles/globals, read-only against the live db over the
   local trusted connection with no password in process args, written to a
   container-side file and copied out byte-for-byte) plus a read-only
   `docker cp` of `/app/data`, with a nonsecret `manifest.json`
   (sizes, SHA256, image refs only). Any backup failure aborts before swap.
6. Recreates ONLY app (`up -d --no-deps --no-build app`; db container and volumes preserved by the helper, not recreated or removed), then
   requires container `healthy` plus `/ready` returning
   `{ready:true, store:postgres}`.

What update never does: `down` (with or without `-v`), volume
create/remove, db build/recreate, secret or response-body printing, or
overwriting an existing backup dir. On post-swap failure it throws an
explicit rollback (retags the pinned rollback image, then recreates app
with the same approved env file and port, so the command is directly
usable):

```powershell
docker tag <rollback-tag> simceo-essentials-app:1.0.0; $env:APP_HOST_PORT="5173"; docker compose --env-file "C:/Users/War/scrach/sim_ceo/.env" --project-name simceo-essentials -f <helper-root>/qa/essentials-backend/simceo-essentials.compose.yaml up -d --no-deps --no-build app
```

and leaves all backups in place. The helper preserves the db container and
volumes without recreating or removing them, but the new app image itself
may run migrations on first boot, so schema/data can change through the app
(a `psql` restore from the kept dump stays a primary-only explicit
decision, not part of update).
