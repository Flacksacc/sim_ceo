# Memory (file-backed fallback)

The Memory Palace MCP server is not reachable from this runtime
(`unsupported call`, empty resource/template listings, verified 2026-11-02),
so durable memory lives here until the server is reattached. If the server
comes back, mirror durable entries there and treat it as primary.

## How to use this store

- At session start, when a request matches a topic below (or needs prior
  context), read this file first, then the linked topic file(s).
- After substantial work, append durable decisions, preferences, and useful
  project state to the matching topic file (newest at bottom, dated).
- NEVER store secrets, credentials, API keys, tokens, or transient scratch.
- Keep entries short, factual, and decision-oriented.

## Topics

- UI generation standards -> `design-rules.md` (standing laws for all
  generated UI; always active, not recall-gated)
- Sim CEO product -> (project docs: PRODUCT.md, DESIGN.md)

## 2026-11-02 parity Phase 1 done (E2E-verified live)
- Attach (both POST advisors and POST roster/copy) now uses RosterOps.Completeness (name+desc+profile+portrait, blocks research-pending). New PUT /api/roster/{id} edits name/desc/profile/tags and bumps Version (approve 409 until sync-roster).
- Research filters empty citation excerpts. Selftest fixture gives CopyMe an accepted portrait; SELFTEST PASS.
- Roster detail UI has portrait accept/retry review w/ thumbnails (.portrait-review/.portrait-thumb). reviewImg mutation now wired.
- API runs under agent exec session (user API tab dead): dotnet SimCEO.Api.dll --urls http://localhost:5080. Store is in-memory: backup via GET /api/backup to .tmp/backup.json, restore via POST /api/backup/restore, re-apply META_API_KEY from .env via PUT /api/model/settings after every restart.
- CAUTION: Where-Object -eq on possibly-missing props matched everything and wiped board advisors; recreated 5 seeds (new ids in .tmp/seed-advisors.json). Prefer explicit loops/property checks on live data.

## 2026-11-02 parity Phase 2 done (E2E+browser verified)
- POST /api/wizard/{id}/interview: one-question turns, LLM analysis + field extraction into FieldsJson, step checkpoints, retry-with-repair on unparseable output, usage-gate + offline fallbacks that still save input.
- GET /api/wizard/{id} hydrates + self-heals InterviewJson casing; review returns fields[] per-field status; wizard UI has Guided interview panel + Setup fields checklists + resume hydrate.
- Removed shadowed OpsEndpoints wizard review/suggest (duplicate routes caused live 500s on both). Backup v2 includes wizard drafts; restore accepts v1|v2.
- Entities.cs was destroyed by an in-place python write (open(w) truncates before arg eval). Rebuilt from backup.json keys + code refs + reflection evidence; compiler-verified via selftest PASS. Rules: stage reconstructions in .tmp/*.new, verify, then copy; never open(w) the original until the replacement is verified. DataUse default is contributor (selftest model-default-contributor proves it).
- PS quoting: single-quoted strings keep everything literal; every embedded single quote must be doubled; prefer file-based .py scripts over python -c for anything non-trivial.

## 2026-11-02 parity Phase 3 done (live E2E on seed board)
- Run returns yielded[{advisor,reason}] (bid-declined/abstained/provider-error/already-replied-this-turn) + abstained + bidErrors + overflow{omitted,cap,policy}; unapproved pool never speaks unless explicitly picked; empty pool = 409 with fixes (stale picks get re-pick fix).
- Secretary pre-check: 409 + fixes when no approved advisor/lead. Directions byte-verbatim. Record approve hash+watermark 409s; export approved-only.
- Seed meeting ran end-to-end (6 advisor messages, record dec1 approved). Seed participant IDs repaired after advisor wipe (PATCH meeting with current advisor IDs).
- UI: runSummary toast (published/yielded/overflow), alert() on run/secretary 409s. E2E scripts: .tmp/e2e_phase1.ps1 (11 checks), .tmp/e2e_phase2.ps1 (8), phase 3 verified ad-hoc.
