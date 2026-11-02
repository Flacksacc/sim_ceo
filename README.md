# Sim CEO — first run

## Start (fresh install)

1. Copy secrets: `copy .env.example .env` (Windows) or `cp .env.example .env`,
   then fill in real values. Dev defaults in `compose.yaml` let a fresh
   checkout start without it; production must set `POSTGRES_PASSWORD`,
   `HINDSIGHT_PASSWORD`, and `META_API_KEY`. `.env` is git-ignored.
2. `docker compose up -d --build`
3. Open the app: `http://localhost:5080` (via proxy `https://localhost:8443`)
4. Health: `http://localhost:5080/health`, readiness: `http://localhost:5080/ready`

## Local dev without Docker (auto-reloads on save)

Run these two side by side. The API restarts itself when server files change;
the web page updates itself in the browser when web files change.

- API (in-memory store, no external packages needed):
  `dotnet watch run --project server/SimCEO.Api -- --urls http://localhost:5080`
- Web: `cd web && npm install && npm run dev` → `http://localhost:5173` (proxies `/api` + `/hubs` to :5080)

## Boardroom design preview

- Open `http://localhost:5173/boardroom-template.html` after starting the web dev server. This isolated interactive template uses mock content and requires no API.
- The layout, interaction, state, and source mapping are in [DESIGN.md](DESIGN.md); the downloaded product screenshots are in [docs/ui-references](docs/ui-references/README.md).
- The selected dark messaging concept and its detailed interaction/performance specification are in [docs/ui-concepts/12-messaging-interface-spec.md](docs/ui-concepts/12-messaging-interface-spec.md).

## Notes

- API uses a thread-safe in-memory store so the solution builds offline; the
  `SimCEO.Postgres` project carries the EF Core model + indexes (unique
  `(meeting_id, sequence)`, roster/advisor/grant indexes) for a networked
  machine with restored packages and migrations. `compose.yaml` runs `db`,
  `hindsight-db`, `hindsight` + `extractor` stubs, `app`, and `proxy`.
- Web client covers every view: Boards (+ readiness), resumable Wizard (+ review
  blockers, suggestions), Your Profile (versioned saves), Settings (draft,
  activation checklist, policy, retention), Roster (search, board chips, copy,
  archive, character drafts, auditions), Board Advisors (approve, roster sync,
  explicit portraits), Meetings (brief, close/reopen, search, notes, briefings,
  directions), Voice turns, Sources (upload, scope, restore, policy, wiki
  lifecycle), Records (prepare, review, approve, revise, amend, discard,
  export), People (invites, grants), Activity (usage filters, jobs, model
  calls, audit), and Help (command coverage).
- Honest stubs (metered, labeled unknown-cost): Meta Model API replies,
  transcription, document extraction, image generation, and semantic recall.
  Uploads, images, and downloads are real and bounded. No wiki connector:
  documents are the knowledge input.
- Grants: pass `X-User: <name>` (the People view has an "Act as" box).
  `owner` manages; with no invites/grants a board is open single-user; the
  first invite/grant opts it into enforcement and revocation sticks.
- Spending: Activity view, owner only. Monthly USD cap with warn or block
  mode; block stops non-owner model calls (402) while the owner always
  overrides. Enforcement counts known costs; stub calls are cost-unknown
  and reported separately.
- Checks: `dotnet run --project server/SimCEO.Api -- --selftest`,
  `npm run build` in `web/`, and the 40-assertion E2E in `/tmp/simceo-e2e.ps1`
  (run with `pwsh`, needs the API on `:5099`).
