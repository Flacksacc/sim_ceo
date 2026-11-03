# Source-restore handoff for the evidence worker (backend-owned note, no source edits)

## Observed (Muse backend, 2026-11-03, API 6887d18e)
`POST /api/backup/restore` of the `essentials_backend_upg` own export returns
`422 {"error":"Backup graph rejected: snapshot family skips version v1;
partial-family removal is not supported (exclude or remove the whole family
instead)."}`. The rejection comes from `SourceGovernance.ValidateRestoreGraph`
(your file, not modified here); the backend surfaces it honestly as 422 with
zero mutation (re-export after the attempt is byte-identical modulo `at`).

## Trigger rows (read-only PG inspection, upg fixture)
8+ single-row source families exist ONLY at v3 (no v1/v2), e.g. fixture
charter uploads `pfx-20261103115500-charter.md`,
`pfx-primary202611031021-charter.md`, `pfx-20261103100500inducedfail2-charter.md`
(all `Version=3`, one row per family). These rows were created by governed
upload flows and are served live by the app; the export carries them as-is.

## Decision needed on your side
- Either accept single-version families at restore (they are what real flows
  produce), or provide a restore-time migration that materializes the
  missing lineage explicitly.
- Until then: upg restore stays honest-422; the backend no-loss proof on upg
  is read-only export + byte-identity, and the restore round-trip proof runs
  on fresh exclusive DBs (green).

## Adjacent boundary (same handoff)
Predecessor report noted `http-qa mem backup 422`: record-draft entries must
be objects at restore while the create path accepts laxer shapes. Create
validation lives in `RecordEndpoints` (your file); the backend restore side is
unchanged and strict by design. If the create path is intentionally lax,
please add the documented canonicalization so export/restore round-trips;
otherwise tighten create. Backend will re-prove after your commit.
