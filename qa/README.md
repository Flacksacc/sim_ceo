# SimCEO navigation QA

Reproducible browser QA for the app navigation repairs (hash routes, rail +
list panel, drawer, Back/Forward, deep links, creation flows).

## Modes

- Fixture mode (default): deterministic `page.route` fixtures. The user API
  on `:5080` is never touched; the worktree bundle is served on `:5175`.
  `node navigation.cjs [--base=http://localhost:5175/] [--cdp=http://localhost:9333]`
- Live smoke (read-only): `node navigation.cjs --live`. Skips honestly when
  the backend is unreachable. Never creates data; selects a board and, when a
  meeting exists, opens it, then reloads and visits Profile/Help.

Env overrides: `QA_BASE`, `CDP_URL`, `QA_SHOTS` (default `.tmp/qa`, git-ignored).

## Fixtures (`fixtures.cjs`)

Mirror the real server shapes AND its real limits:

- `GET /api/boards` returns the newest-100 window. `b-old` ("Old Archive
  Board") is valid via `GET /api/boards/:id` but outside the window.
- `GET /api/boards/:bid/meetings` returns the newest-200 window. `m-old`
  ("Ancient pricing debate") is valid via the scoped lookup
  `GET /api/boards/:bid/meetings/:mid` (parent-board mismatch is also 404)
  but outside the unfiltered window; it still matches a fitting `q=` search.
- `GET /api/meetings/:mid/records` returns the newest-50 window. `r-old` is
  valid via `GET /api/records/:id` for `m-old` but omitted from that list.
- Validation 404s (unknown id / parent mismatch) are expected and stay in
  the request log without counting as unhandled fixture gaps.
- One-shot delays: `GET /api/__qa/delay?key=boards|meetings|records&ms=N`
  delays the next matching list response, for delayed-refresh tests.
- Wizard: `POST /api/wizard` (stores the draft name), `GET` review (no
  blockers), `POST /:id/create` (adds the board to later list responses).
- Populated advisors (`a-1`/`a-2` on `b-alpha`), advisor chat, message
  search hits, and second record versions exist so isolation tests use real
  state instead of empty fixtures.

## Suites (fixture mode)

Desktop 1440 (exact hashes, authoritative detail lookups, omitted entities,
delayed refreshes, create-board/record + revise, compare reset, search/chat
isolation with Back traversal, exact-view Back, skip link, dark theme),
mobile 390 (drawer inert/visibility, focus-in, genuine ArrowDown/ArrowUp
travel, Escape, backdrop, dark drawer), resize (breakpoint inert/aria-hidden
transitions 1440 <-> 390). Screenshots land in `.tmp/qa` (git-ignored).

## Dependencies

Portable: `npm --prefix qa ci` installs the pinned `playwright-core` from
`qa/package-lock.json`. The suite drives the EXISTING Edge CDP
(`http://localhost:9333`, CPU-only `--headless=new` is fine) with its own
contexts and never closes the user browser.
