# Advisor presence default portrait (meeting fix)

Rebased onto combined candidate: old f1 built against ec2a4ca backend would
delete the canonical roster projection. This resolves onto cd54468 (full
server dbb plus web ec2 plus QA), retaining all canonical fields and ACLs.

## Problem
Roster copy creates a board advisor with no portrait selection
(`ImageProvenance = "initials"`). Approval honors the deterministic accepted
legacy portrait, but the meeting rail stayed on initials: the old hook bailed
on empty provenance, and `/api/roster/{id}/images` lacks `BoardAdvisorId`.
A second defect: focus reread cached display ids with no fresh review GET,
so revoking or rejecting the SAME id could leave a retained portrait on
focus, since owner-readable bytes alone cannot prove freshness.

## Fix (read-only, same authority)
- Server helper `RosterDisplayOps.ResolveDisplayPortrait` wraps shared actual
  dbb helpers (`ResolveSelectedImage`, `HasExplicitPortraitSelection`,
  `IsPortraitAccepted`) plus identical deterministic legacy
  (`RosterEntryId` + accepted, `OrderBy CreatedAt ThenBy Id`). No mutation,
  no approval change, no new permission or keys.
- Server DTO retains the current canonical manager projection
  (`ResolveCanonicalView` + `rosterName/rosterVersionCurrent/stale/unlinked/`
  `behaviorFingerprint`, `BadToken` guard) and adds ONLY
  `displayPortraitImageId`; guest DTO adds the same id to its existing fields.
- App `useDisplayPortraits(boardId, ...)` plus `normalizeDisplayImageId`
  re-queries authoritative `GET /api/boards/{boardId}/advisors` for the
  computed display id before loading bytes on every resolve, including
  focus, visibility, and advisor refresh. Same-ID revoke or reject therefore
  clears to initials. Fail-closed: failed, malformed, omitted, or null
  fresh metadata keeps initials with no cached rescue, and no request
  issues after retire. Bytes still flow only through authorized
  `authedBlobUrl("/api/images/" + id)` with token, user, epoch, immediate
  clear and revoke, `blobStale` and retired checks, unmount cleanup, and no
  wrong-identity reuse. Display ids validate precise GUID groups;
  the server Guid is always valid. Guest DTO computes once (no double
  resolve window).

## Proof
- `dotnet build server/SimCEO.Api` Release, 0 errors.
- `npm run build --prefix web` (`tsc --noEmit` + vite) PASS.
- `node qa/advisor-presence-portrait.cjs` PASS against combined source:
  shared resolver and order, canonical projection retained, both DTOs carry
  the additive id, frontend helpers prove selected/none/rejected/ambiguous,
  and App proves fail-closed fresh DTO before bytes with preserved guards.
- `dotnet run --project qa/PresenceDisplayProbe` (USE_POSTGRES=0, Pg.Backend
  null) invokes REAL RosterDisplayOps on an owned InMemoryStore for
  deterministic legacy, tie-break, no-selection, explicit valid/invalid/
  rejected/grandfathered, ambiguous linked/prefix, cross-roster, and
  single pending linked, with fingerprint and gate parity.

## Gaps
- Live runtime with real HTTP, Postgres, Docker, or browser was not run here;
  primary actual run plus independent review are still required.
