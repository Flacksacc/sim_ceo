# Boards archive contract for the UI worker (server-owned note, no UI edits)

## Endpoint
`GET /api/boards?includeArchived=true` — same auth, same scoped DTOs, same
role/privacy rules as the default list; the only difference is archived rows
are included. Default (`false`/absent) still excludes archived boards.

## Visibility (unchanged per row)
- Non-secure demo: all boards (active + archived when requested).
- Secure: session required; installation admin sees all; owners and users
  with current `manage` see full rows; users with current `read` (board
  grants honoring present revocation state) see the scoped DTO; meeting-only
  guests see the minimal guest DTO. Deleted/revoked grants never surface a
  private board (server rechecks `PeopleOps.Can(read)` per row instead of
  trusting raw grant-row existence).
- The current user workspace has 3 boards (2 archived): with
  `includeArchived=true` the UI can discover both archived cards; without it
  they are invisible (by design, unchanged).

## Restore
`PATCH /api/boards/{id}` `{ archived: false }` with `manage` on that board
restores it to the active list. Non-managers get 403; logged-out holders get
401. Archived boards remain individually GETtable (`GET /api/boards/{id}`
has no archive gate) with the same scoped DTO as the list.

## UI guidance (no menu framework)
Pass `includeArchived=true` only for the archived-cards view; keep the
default list as-is. A restored board returns to the default list on next
fetch. Treat 401 as session-dead (re-auth), 403 as not-permitted.
