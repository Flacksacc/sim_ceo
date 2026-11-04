# Roster integrity — joined candidate pointer (docs-only, no new source)

This file does not replace either precursor record. Both precursor records are
preserved byte-identical under explicit names:

- `docs/roster-integrity-integration-backend.md` — exact bytes from
  `.tmp/advisor-final-backend` commit `dbb698c` (backend integration profile:
  roster visibility/count parity, blank-owner write authority, empty-link
  recovery, deterministic plan hash, server + focused QA only).
- `docs/roster-integrity-integration-frontend.md` — exact bytes from
  `.tmp/advisor-final-frontend` commit `604d9f9` (frontend integration profile:
  isolated `RosterIntegrity` / `RosterReconciliation` panels, no `App.tsx`
  wiring by that precursor; the integrator wires them).

Scope truthfulness for the joined candidate root:

- The backend record was authored against its own worktree/branch scope and
  must not be read as whole-app acceptance in this joined tree.
- The frontend record explicitly states its panels were NOT imported by
  `App.tsx` in that precursor; this joined tree wires them via the exact
  frontend `web/` tree (`604d9f9`), which primary reviews independently.
- No recovery, reconciliation apply, or human-data migration was performed by
  this join. Primary owns any production migration and final review.
