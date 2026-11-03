# Phase 8 restore security boundary (domain backup, narrow explicit boundary)

Decision: a domain backup restores ONLY domain entities. Installation security
authority (Accounts, Sessions, SecurityStates) and the current installation ACL
(Grants, Invites, Memberships) plus revocation decisions are NEVER cleared,
downgraded, or replaced by an old snapshot.

Consequences, enforced in `OpsEndpoints.MapBackup` (`server/SimCEO.Api/Work/OpsEndpoints.cs`):

- `restored.grants` / `restored.invites` are IGNORED by design. The live
  Grants/Invites/Memberships remain authoritative, so an old snapshot cannot
  resurrect revoked or left access (direct grants have no membership row, so
  filtering restored rows against inactive memberships alone is insufficient).
- Fresh-install restored boards carry no ACL rows: access requires a deliberate
  authorized reissue (new explicit invitation + accept), never anonymous owner
  defaults.
- Restore validates the full input graph (required collections non-null and
  non-null entries; meeting/source/note/advisor parent-board references) BEFORE
  any destructive mutation, performs ONE Atomic replacement, bumps restored
  meeting generations (stale pre-restore publications cannot commit), and rolls
  back with 500 leaving no partial state on storage failure.
- Exported backups never contain credentials or session tokens.
- Audit records `backup.restore` with `aclPreserved: true`.

Tests: `qa/phase8-repair-verify.mjs` (T8 backup-no-resurrect),
`qa/phase8-repair-pg*.cjs` (PG persistence across restarts, outage 503).
