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
  has LOWER precedence than process env, so the helper never uses it).
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
# status / stop:
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
