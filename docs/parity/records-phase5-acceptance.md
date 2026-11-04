# Records Phase 5 one-document review — acceptance contract

Scope: Phase 5 gaps only. One-document review with working notes (including
correctly labelled Secretary provisional notes/briefings), pending items with
per-item approve/revise/discard, approve-all, evidence excerpts, recent input,
version/watermark and predecessor/successor/effective supersession context.
Human-readable UI throughout: no raw JSON, no GUID links, no hashes or tokens
on screen. Server CAS/hash/version/watermark/409 drift guards, atomicity,
permissions, no implicit approvals, and the empty-draft approval guard are
preserved unchanged.

## Source changes (Muse-authored)

- `server/SimCEO.Api/Work/RecordEndpoints.cs`: `ReviewPayload` notes now also
  include `secretary-note` / `secretary-briefing` provisional kinds. Display
  only — approved-evidence eligibility (`ResolveEvidenceAuthorized`, which
  requires non-provisional state) is untouched, so read-only context still
  grants no approval.
- `web/src/App.tsx` Records area only: the selected draft now renders a
  one-document review — decision counts, per-item approve/revise/discard with
  `Approve {id}` / `Revise {id}` / `Discard {id}` and
  `Revised text for {id}` controls, approve-all through the atomic per-item
  path, working notes with Secretary labels, supporting excerpts, recent
  meeting input, version history with predecessor/successor navigation,
  lineage/effective context, and decision history. Per-item revise/discard are
  contribute-level (server: contribute); approvals stay manage-level and gated
  by the server-computed `stateValid` flag. Empty, decided, invalid, and
  superseded reviews render zero approval controls. Draft GUIDs, hashes,
  review tokens, and watermarks-as-codes never render; predecessors and
  successors navigate by human `Version N` labels.
- `web/src/human-record-items.tsx`: `RecordVersionRow` accepts an optional
  `testId` for in-app record navigation; no visual change.

No edits to advisors, profile, send, meeting, Activity, or other lanes.

## QA (Muse-authored, primary executes — runtime QA is primary responsibility)

- `qa/records-phase5-onedoc.mjs` — API: secretary/working notes in review,
  leak negatives (GUID/token/snapshot scan), stranger/reader/contributor
  grants, per-item history + remaining items after revise/discard, empty and
  all-decided approval guards, 409 conflict with explicit refresh, and
  supersession navigation/affected context.
- `qa/browser/records-phase5-onedoc-ui.cjs` — compiled SPA + real API with its
  own headless Edge (never shared CDP 9333): one-document rendering, real UI
  per-item revise/discard/approve, approve-all to zero controls, reload, 409
  then explicit refresh then deliberate approve, v1/v2 navigation, narrow
  dark viewport, zero console errors.

Ports (explicit loopback allowlist, human ports refused):

- `QA_API` default `http://127.0.0.1:15320` (primary-owned isolated API)
- `QA_FAKE` default `http://127.0.0.1:15322` (fake provider for the Secretary seed)
- `QA_WEB` default `http://127.0.0.1:15321` (primary-served compiled SPA)

All data is run-scoped (`bears5-*` / `bears6-*` identity and boards).

## Verified by the author

- `tsc --noEmit` on `web/`: pass.
- `vite build` on `web/`: pass (128 modules).
- `dotnet build server/SimCEO.Api -p:SkipStagePostgres=true`: 0 errors
  (32 pre-existing warnings in untouched files).
- `node --check` on both new QA scripts: pass.

Unexecuted: all runtime API/browser QA above, human-port checks, deployment,
and full-parity acceptance. The checked-in older UI expectations
(`qa/browser/records-review-ui.cjs`) predate the one-document surface; the
new scripts above are the aligned proof for this slice.
