# Roster contract QA — scope note (joined candidate, no new assertions)

Preserved precursor contracts (byte-identical, renamed only):

- `qa/roster-chat-contract-backend-scope.mjs` — exact bytes from
  `.tmp/advisor-final-backend` commit `dbb698c`. Asserts backend integration
  state (MapRosterChat wired, board direct-advisor chat retired, attach gated).
  Contains precursor branch/worktree scope assumptions; those ownership checks
  are ARCHIVED and must not be applied as functional acceptance in the joined
  tree.
- `qa/roster-chat-contract-frontend-scope.mjs` — exact bytes from
  `.tmp/advisor-final-frontend` commit `604d9f9`. Focused roster-chat file and
  endpoint shape checks from the frontend profile. Its scope checks are
  ARCHIVED for the same reason.
- `qa/roster-integrity-qa-backend-scope.mjs` — exact bytes from `dbb698c`.
  Checks precursor branch/worktree scope, forbidden areas (`web/`,
  profile-owned server files), owned files, and plan-hash determinism shape.
  In the joined tree both `server/` (backend) and `web/` (frontend) are
  intentionally present, so its `forbiddenTouch` branch assumptions FAIL by
  design here; archived, not a release gate.
- `qa/roster-integrity-qa-frontend-scope.mjs` — exact bytes from `604d9f9`.
  Checks precursor scope with `forbiddenTouch: web/src/App.tsx`. This joined
  tree intentionally includes the exact frontend `web/` tree, so that assertion
  also FAILS by design here; archived, not a release gate.

Real integrated checks in this joined tree are the actual `server/` files
(exact `dbb698c` bytes) plus the actual `web/` files (exact `604d9f9` bytes),
reviewed and executed by primary. No assertions were deleted to make any suite
green. No branch-ownership assumption is applied as functional acceptance.
The final integrated milestone QA `qa/advisor-integrated-qa.mjs` (`be958dc`,
UNEXECUTED here) is included as-authored for primary to run.
