# Navigation QA actual contracts (Muse QA-only, production frozen)

Bundle under test: primary-owned compiled WEB at `http://127.0.0.1:15300/`
(CDP `http://localhost:9333`, own contexts, all `/api/**` stubbed via
`qa/fixtures.cjs`; human ports 5173/5080 and `.env`/keys untouched).
Production (`web/src`, server) was not read for editing and not modified;
only `qa/navigation.cjs`, `qa/fixtures.cjs`, and this doc changed.

## Obsolete UI contracts replaced (old -> actual current requirement)

- `getByRole("tab", Key takeaways/Options/Decision)` plus
  `Board members/Context/Decisions` context tabs -> ONE meeting messages
  area + `Meeting settings` dialog. New checks assert the messages area
  (`Hello board`, search field, `Request advisor responses`), that NO
  `tab` role renders, and that the dialog carries Decision state, Options
  on the table, Key takeaways (provisional), Evidence, Record, and the
  Allowed-advisors participant list (incl. CFO Ada). `Advanced JSON`
  disclosure was removed for human-readable text: suites assert its
  absence and exercise `RecordItemList` / `RecordComparison` /
  `RecordItemEditor` instead.
- Legacy `mtab`/`ctab` hashes: the source still parses and preserves them
  (`parseHash`/`buildHash`), but renders no tabs. Tests assert the exact
  legacy hash is preserved per source AND the screen stays unified
  (messages visible, settings holds takeaways content) for Back/Forward,
  reload, and deep-link cases.
- `Review vN` headings -> `Review version N`; `Review v` substring ->
  `Review version ` (wrong-parent/pending/error/transport cases kept).
- `Prepare draft from items` -> `Prepare draft from the list above`.
- `Approve a` / `Amend (name superseded IDs)` -> `Approve selected` /
  `Approve all` / `Amend approved record`, gated by the server-computed
  review `stateValid` (fixtures mirror it: true when pending items exist).
  The delayed-amend setup uses partial approval on the two-item draft
  r-2 (uncheck decision 2, approve selected) because full approval empties
  pending and hides Amend under current gating. Same delayed A->B
  preservation invariant, mapped to actual controls.
- Compare select: `Raise starter by $5` visible -> human-readable
  `Hold enterprise flat` plus `changes since` summary.
- `summary:has-text("Meeting setup")` + `Brief (a meeting needs...)` ->
  `Meeting settings` dialog + `Meeting brief`; brief assertions scoped to
  `div.conv-head` (the dialog textarea value also matches text queries).
  `Pause`/`Resume` -> `Pause meeting`/`Resume meeting`; close/reopen stay
  in the dialog (kept open across them, Done closes at the end).
- Message search `details/summary` -> `ConversationSearchField` form plus
  `ul[aria-label="Conversation search results"]`.
- Omitted-board heading `.listpanel-sub` (boards/roster tabs only) ->
  `.mobilebar .boardname` attached textContent (hidden on desktop widths
  by CSS; `attached` + textContent mirrors the existing created-board
  precedent and still proves authoritative detail over the capped list).
- Main board card switch lands on the meet tab (current `setTab("meet")`
  behavior): sidebar-meetings expectation -> meet `ol.agenda` shows the
  new board meetings and not the old ones.
- Board-scoped `Chat directly with an advisor` card no longer exists:
  private chat is roster-scoped (`RosterChatPanel`, "Chat with this
  advisor", explicitly not joined to any board). Board-owned isolation is
  now covered by the Portraits `Board advisor` pick (board-owned `selAdv`,
  cleared on switch, Back does not resurrect) plus per-board advisor
  lists; the suite asserts the old card is gone.

## Fixture additions (mirror current server shapes, truthful 404s)

- `GET /api/meetings/:id/notes/history` -> `[]` (known) / 404 unknown.
- `GET /api/meetings/:id/secretary/requests` -> `[]` / 404 unknown.
- `GET /api/boards/:id/guest-settings` -> board DTO / 404 unknown.
- `GET /api/profile` -> global lead or 404 when absent (mirrors resolve).
- `GET /api/boards/:id/wiki-resources` -> `[]` / 404 unknown.
- `GET /api/boards/:id/sources/review` -> `[]` / 404 unknown.
- `GET /api/boards/:id/source-policy` -> `{ blockedTypes: "", mode: "allowAll" }` / 404 unknown (matches the `?? "allowAll"` fallback).
- `GET /api/boards/:id/context` -> `null` / 404 unknown (index status hidden when null).
- Record review now carries `stateValid`/`stateError` (true when pending
  items exist), which the UI requires before showing approval controls.

## Reported defects (tests preserved, no weakening)

D1. Ungated secretary hydration fetch for invalid meetings.
  Repro A: `goto #/meet?board=NOPE&meeting=NOPE` -> `section Boards`
  lands on `#/boards`, but reqLog contains
  `GET /api/meetings/NOPE/secretary/requests`.
  Repro B: `goto #/meet?board=b-beta&meeting=m-one` (m-one belongs to
  b-alpha) -> meeting dropped, board kept, but reqLog contains
  `GET /api/meetings/m-one/secretary/requests`.
  Expected: only the scoped validation lookups fire; no meeting-scoped
  downstream fetch for the stale id (the checks `no messages fetch for
  bogus meeting` / `no meeting fetch for mismatched id` fail honestly).
  The hydration effect fires `get(.../secretary/requests)` on any
  `meetingId && boardId` without `meetingOk` gating.
D2. Completed wizard is not retired after successful create.
  Repro: Boards -> New board -> fill QA Created Board + mission ->
  add seat QA Reviewer -> lead QA Lead -> Create board (lands on
  `#/advisors?board=b-new-N`, board appears in list) -> Boards ->
  New board. Expected: fresh Step 1 (empty name). Actual: wizard still
  on Step 4 Review showing the just-created board ("QA Created Board -
  QA mission decides pricing ... Draft saved on this device.",
  screenshot fail-3.png in `.tmp/qa`), so `second New board is fresh
  Step1` fails and the Step-1 fill cannot run there. The committed
  handler intends retirement on success ("next New board is a fresh
  Step 1"); the bundle navigates/seeds but keeps stale wizard state.
  Consequence covered by the same defect: the recovered second create
  replays the completed wizard id and the fixture (correctly) returns
  the SAME board (idempotent replay), so `second board distinct from
  first` fails too. The suite records both failures, then recovers via
  the wizard Back buttons to Step 1 (user-equivalent navigation) so all
  independent later coverage (skip link, profile/help, dark theme,
  mobile, resize) still runs.

## Result

Clean rerun `node qa/navigation.cjs --base=http://127.0.0.1:15300/`
(log `C:/Users/War/scrach/sim_ceo/.tmp/muse-nav-qa-16b0411m.log`):
**passed: 245, failed: 4**.

All obsolete UI contracts pass (settings/messages/record/search/agenda/
portraits/board-heading/chat-removal/MS2/P1/Back/forward/reload/deep-link/
console/mobile/resize). The 4 failures are exactly the reported defects
above, with no weakening: D1 x2 (ungated secretary hydration fetch for
bogus/mismatched meetings) and D2 x2 (completed wizard not retired:
`second New board is fresh Step1` plus its replay consequence
`second board distinct from first`; recovery via wizard Back buttons
preserved all independent later coverage). `no unhandled fixture paths`
passes in desktop, mobile, and resize suites.
