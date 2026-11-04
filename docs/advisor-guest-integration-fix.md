# Advisor guest integration fix (Muse, base 2a35930)

Own root: `.tmp/advisor-guest-integration-fix`, branch `muse/advisor-guest-integration-fix`.
Sibling `.tmp/advisor-roster-chat-fix` untouched (App sibling keys + portrait owned elsewhere).

## Production fixes

### P1 — expiry private My meetings names (web/src/App.tsx)
- Central `purgePrivate` now `cancelQueries` + `removeQueries` for `["my-memberships"]` (was `invalidateQueries`-only, retained private meeting titles/board names through session-verification `AuthPanel`).
- `AuthPanel` query keys now carry CURRENT identity/epoch ownership: `["me", token, user, epoch]` and `["my-memberships", token, user, epoch]`; `mine` enabled only on `!!token && me.authenticated`.
- Rendering gates on CURRENT verified authority (`!!token && me.authenticated`), not retained `mine` data/token alone.
- Public `auth-status` retained (required sign-in); all other private families already removed; `sess` still invalidated for re-verification.
- `fetchAuth` stale guards (epoch/token/user) + once-only expired-purge dedupe preserved: anonymous (empty token) never purges; late held old responses discarded.

### P2 — /api/me/memberships omits owners/admins (server/SimCEO.Api/Work/PeopleEndpoints.cs)
- Active + inactive branches now evaluate CURRENT authority via authoritative `PeopleOps.AccessFor(board, meeting, user) != "none"` (covers owner manage, installation-admin manage, board/meeting grants, open), retaining parent validation (`Meetings.BoardId == Membership.BoardId`) and explicit-rejoin restrictions.
- Active/inactive meanings preserved; revoked/left meeting-grant guests stay hidden (no implicit-rejoin bypass); board-wide-grant inactive remains rejoinable and explicit `/join` reactivates with live authority.
- Invite hints unchanged.

### P3 — inherited network under outer Root (server/SimCEO.Api/Work/Endpoints.cs)
- Per-round commit applies synchronous SyncRoundCommit INSIDE SetupLock-MessageLock plus Atomic unit immediately after success while holding outer ROOT; ONLY network publish deferred until after exit (per-round drain flag).
- `LaneBFail` finishes discussion state inside but defers `PublishDiscussionAsync` via `Monitor.IsEntered(RootGate)` flag when under ROOT; outside ROOT it publishes immediately (existing bidding/draft paths unchanged, already outside ROOT).
- No Task.Run-delay-yield inside ROOT; no Hub-to-Root inversion (recipient path releases HubGate before acquiring ROOT for per-recipient auth; sends await outside both).
- Zero NEW committed-round publication on failed round (throw skips flag set); existing finalizer still publishes honest interruption after rollback (retained, not suppressed).
- Origin-generation-failure-completion preserved; LaneBFail deferred-drain returns and operation identity and rollback behavior unchanged; messages durable via same commit; Sync under ROOT closes committed-abstain race.

### Roster intro copy (web/src/App.tsx only)
- `Roster entries are reusable profile templates. Profile changes apply across boards; messages and sources stay scoped to their board.`
- Chat keys untouched.

## QA (isolated memory, exact loopback, bounded finally)
- `dotnet build server/SimCEO.Api` — 0 errors.
- `npm --prefix web run build` — tsc + vite ok.
- P2 `node qa/advisor-guest-fix-p2-qa.mjs` vs `http://127.0.0.1:15390` (ephemeral, memory-only) — 23 pass: owner join/list without grant + titles, unrelated 403/empty, guest grant/join/active, leave hidden (no resurrect), board-wide inactive rejoinable + explicit rejoin active, owner still listed.
- P1 `node qa/advisor-guest-fix-p1-qa.mjs` — 18 pass: populated titles before expiry, 401 + 200-false after logout with no titles, anon demo false + public status retained, QueryClient populated -> cancel/remove zero immediately, relogin-other empty, late-old no repopulate current, gate expired/anon false + valid true.
- P3 `dotnet run --project qa/RootProbe` (in-process fakeHub + real `MeetingActivity.PublishDiscussionAsync`/`BoardHub.PublishMeeting`) — 5 pass: committed publish outside ROOT (Root NOT held at Send, message durable), inside-ROOT observes held (boundary observable, old pattern), rollback no publish, failure publish outside ROOT. New in-ROOT Sync race ordering unexecuted here: source change plus build only, no new endpoint run; actual mapped endpoint probe owned elsewhere.
- Ports: API 15390 only; no 5173/15180/9333/shared 15300/02, no PG/Docker/.env/keys/real provider, no global kills (filtered 15390 stop only).

## Limitations
- No runtime deadlock claimed for P3 (retained baseline issue was boundary-only per review).
- No PostgreSQL, mounted accessibility/layout, or browser runtime executed beyond headless-safe probes; web build only.
- P3 new ordering precise source change documented above; dedicated new race proof (pause plus activity-reconcile between unlock and Sync) not executed in this scope.
- Review `advisor-next-2a35930-integration-review.txt` NOT accepted; portrait findings (`ece1763`) and duplicate roster-chat defect remain open/assigned elsewhere.
