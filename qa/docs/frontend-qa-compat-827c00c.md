# QA compatibility notes — 827c00c frontend (send pipeline + navigation fixtures)

App source frozen for dedicated review. This doc records QA-only contract
updates; no production files were touched.

## Stale contracts found (primary logs)

- `primary-advisor-827c00c-send-browser.log`: 123 PASS / 4 FAIL —
  `testApplyIdentityRetirement` and `testHeldPatchOverlapNewSurvives` timed
  out on heading `Act as (demo identity for grant checks)`;
  `testSecretaryRetryVisible` timed out waiting for `Secretary error` text;
  `no-page-errors` collected five 404 resource errors.
- `primary-advisor-827c00c-nav-fixture.log`: 2 PASS then suite crash clicking
  the `Alpha Board` sidebar row — the boards list never rendered.
- Screenshot `shot-desktop-boards.png` shows an empty board list with
  `Active (...)`, confirming the boards query never enabled.

## Root causes in the 827c00c app

- People page now renders `Preview access as` (`web/src/App.tsx` ~8808);
  the `Act as user` label and `Apply identity` button are unchanged.
- Secretary error/retry card moved into `MeetingSettingsDialog`
  (`Meeting settings` dialog, `App.tsx` ~7995): it only renders while the
  dialog is open, so body-text waits on the takeaways tab can never see it.
- `anonPrivateBlocked = !token && authStatusQ.data?.authRequired !== false`
  (`App.tsx` ~1408): with no `/api/auth/status` fixture the status query
  stays undefined, so boards/meetings/advisors never enable.
- `useMeetingActivity` polls `GET /api/meetings/:id/activity` (`tab=meet`,
  4s refetch, `retry:false`): unhandled in both stubs, producing the 404
  console noise that failed `no-page-errors` (console filter untouched).

## QA-only changes

- `qa/fixtures.cjs`
  - `GET /api/auth/status` → honest unsecured DTO
    `{ authRequired:false, hasAccounts:false, accountCount:0, admin:"" }`
    (mirrors `AuthEndpoints /api/auth/status` with no accounts).
  - `GET /api/boards/:bid/capabilities[?meetingId=]` → mirrors
    `PeopleEndpoints CapabilityView` (open demo maps to `manage`;
    `guest:false, admin:false, meetings:[]`); unknown board or
    parent-mismatched meeting stays a validation 404.
  - `GET /api/meetings/:id/activity` → idle DTO
    `{ discussion:{status:"idle",advisors:[]}, secretary:[] }` matching
    `meeting-activity.ts`; unknown meeting (non-`m-new-`) stays 404.
  - `GET /api/roster/:id/research` → truthful validation 404 (fixture
    roster is empty; never a blanket allow, never an unhandled gap).
- `qa/meeting-send-pipeline-qa.mjs` (all 23 scenarios preserved)
  - Identity tests use heading `Preview access as`; label/button selectors
    unchanged; same-nonce/twice/no-lead guards untouched. Retirement still
    goes through the real `Apply identity` host control while a run is
    held (beyond the synthetic epoch-bump check).
  - Secretary retry opens the real `Meeting settings` dialog, waits for the
    `Secretary error` card there, presses `Retry secretary (same envelope)`,
    observes `Secretary working...` progress; same-envelope/twice/no-lead
    guards preserved.
  - apiStub serves the idle activity DTO (no console-filter broadening).
- `qa/navigation.cjs` (all invariants preserved)
  - Alpha-board sidebar click waits for the real row (auth-gated query).
  - New backend-truth contract checks: auth-status shape, board/meeting
    capabilities, unknown/mismatched 404s, activity DTO shape + unknown 404.

## Validation

- `node --check` passes on all three files. No runtime was executed here
  (no services/browser/process control per task); primary reruns against
  compiled candidate `0f6147f`. No all-PASS claim is made.