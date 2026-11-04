# Roster integrity — integration handoff (primary owns merge + production migration)

Owned by agent Muse on branch `muse/roster-integrity-feedback`, worktree
`C:/Users/War/scrach/sim_ceo/.tmp/roster-integrity-feedback` only.
No live user-data writes were performed; no App.tsx edits were made.

## New owned files (no overwrites)

- `server/SimCEO.Api/Work/RosterIntegrity.cs`
  `RosterIntegrity.CheckAttach` (canonical attach gate: existing board,
  existing non-archived roster entry, caller roster-read auth, board manage,
  cap 10, unique (board, roster), roster completeness),
  `CanonicalBehaviorFingerprint` (roster-driven only; board role excluded),
  `BoardAttachmentFingerprint` (board-specific only),
  `ResolveCanonicalView` (boards render this; roster edits change behavior),
  `IsMaterialResearchChange` / `IsStaleContext` (updates invalidate pending
  old context; material research needs fresh review, never silent approval),
  `CanonicalPacketSection` (version-pinned curator section).
- `server/SimCEO.Api/Work/RosterReconciliation.cs`
  `Scan` (missing / archived / stale-version / duplicate-link orphans),
  `BuildBackup` (read-only JSON snapshot of affected advisors + roster + images),
  `Plan` (read-only deterministic dry-run; identical re-run = identical
  PlanHash; name match alone never merges across owners),
  `ApplyPinnedReviewReset` (primary-only production runner; idempotent per
  IdempotencyKey via marker note; only RePinAndUnapprove auto-applies,
  duplicates/orphans stay manual).
- `web/src/roster-integrity.tsx` + `web/src/roster-integrity.css`
  Isolated panels (`RosterLinkBadge`, `BoardAdvisorLinkPanel`,
  `ReconciliationReviewPanel`) using existing tokens only. NOT imported by
  App.tsx; the integrator wires them.
- `qa/roster-integrity-qa.mjs` — isolated QA (scope, forbidden-touch,
  owned-files, read-only port probe of 5173/5080/9333, plan-hash
  determinism). No fixtures DB, no server starts.

## Needed changes in overlapping files (NOT made here; primary integrates via Muse)

1. `server/SimCEO.Api/Work/Endpoints.cs` (board-advisor create/update paths):
   call `RosterIntegrity.CheckAttach` before creating any BoardAdvisor and
   reject rosterless creation (409). Keep cap-10 + unique-link errors.
2. `server/SimCEO.Api/Work/RosterEndpoints.cs` (`RosterOps.TryCopy`):
   route copy validation through `CheckAttach` so every attach links an
   authorized canonical entry; keep `BoardsFor` live derivation.
3. `server/SimCEO.Api/Work/ContextCurator.cs` (`BuildPacket` / `BidPacket`):
   replace the direct `rent.ProfileJson` embed with
   `RosterIntegrity.CanonicalPacketSection` so roster edits change effective
   behavior; keep `BoardRole` as the board-specific line.
4. Approval flow (roster edit endpoints): on roster version bump, rely on
   existing `UnapproveBoardCopies` + surface `ResolveCanonicalView.Stale`;
   on material research change (`IsMaterialResearchChange`) require explicit
   re-review of the new facts before any board re-approval.
5. `web/src/App.tsx` (integrator only): mount the new panels in the
   This-Board's-Advisors and roster detail views. This task deliberately
   leaves App.tsx untouched.
6. Production migration (primary runs): `RosterReconciliation.Plan` dry-run
   review, backup capture, owner approval, then `ApplyPinnedReviewReset`
   once with a recorded IdempotencyKey. Agent performed zero live writes.

## Preserved invariants

- Cap 10 / unique links / version pins / research approval / privacy
  (CanWriteRoster / CanReadRoster boundaries unchanged).
- Board-specific role/participation metadata never leak into canonical
  behavior hashes; canonical capabilities/profile content always from roster.
- No naive name merging across people/accounts: stable RosterEntryId,
  ownership keys, and content-hash evidence required; ambiguous cases flag
  for owner review.
- Old userdata preserved until reviewed reconciliation is approved.