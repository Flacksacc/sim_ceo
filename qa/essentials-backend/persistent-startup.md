# Essentials persistent startup (human-run; agents never cut over)

## What this is
A NEW dedicated compose project `simceo-essentials` (db + app ONLY) with NEW
volumes `simceo_essentials_pgdata` / `simceo_essentials_appdata`. It preserves
the stopped production volume `sim_ceo_pgdata` (unknown older user data) by
never referencing it: no mount, no restore-over, no drop. QA proof databases
are separate and never mounted here.

## Preservation contract
- `sim_ceo_pgdata` is only INSPECTED (docker volume inspect) in preflight; the
  helper aborts with a warning if it is missing, never creates or repairs it.
- Fresh user state must be captured (GET /api/backup on the CURRENT user API)
  immediately before any cutover, and restored only into this new project DB
  after the human approves. No agent performs the cutover.
- Same secret contract as MAIN: container env comes from MAIN `.env`
  (`POSTGRES_PASSWORD`, private `META_API_KEY` app key, `META_API_BASE`).
  Never commit `.env`; never use a coding-profile key.
- Ports: API 5080 (matches dev API + Vite 5173 origin). Stop any dev API on
  5080 first; the helper preflights this. Production serves the built web
  from wwwroot on 5080; dev flow (Vite 5173 -> API 5080) is unchanged.

## Verified runtime facts (2026-11-03, Muse)
- `mcr.microsoft.com/dotnet/aspnet:10.0` contains NEITHER wget NOR curl NOR
  python3 (`docker run --rm <image> sh -c "command -v wget curl python3"`
  prints nothing). The image HEALTHCHECK (`wget -qO- .../health`) therefore
  always reports unhealthy. This stack sets `healthcheck.disable: true` on
  app and gates readiness by host-side polling (`/health` 200 liveness +
  `/ready` 200 store=postgres) in `essentials-persist.ps1`.
- Native `dotnet publish` of SimCEO.Api + PG readiness + restart behavior are
  proven by the owned QA runner in this directory (`run.ps1`, per-run
  artifacts under `art-*`).

## Dockerfile proposal (NOT applied; needs primary approval)
```dockerfile
# runtime stage, before ENTRYPOINT:
RUN apt-get update && apt-get install -y --no-install-recommends wget && rm -rf /var/lib/apt/lists/*
```
Value: working in-image HEALTHCHECK. Cost: one apt package in the runtime
image. Until approved, host polling remains the gate.

## Human commands
```powershell
# review-only render (no containers, no volumes):
docker compose --project-name simceo-essentials -f qa/essentials-backend/simceo-essentials.compose.yaml --env-file .env config
# start (from the repo root, MAIN checkout):
powershell -File qa/essentials-backend/essentials-persist.ps1 -Action start
# status / stop:
powershell -File qa/essentials-backend/essentials-persist.ps1 -Action status
powershell -File qa/essentials-backend/essentials-persist.ps1 -Action stop
```
Readiness: `GET http://localhost:5080/health` 200 and
`GET http://localhost:5080/ready` 200 `{"ready":true,"store":"postgres"}`.
Rollback: `stop`, then optionally `docker compose ... down -v` removes ONLY
the new project volumes; `sim_ceo_pgdata` and the old stack are unaffected.
