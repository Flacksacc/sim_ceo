# Advisor final closure (eight-findings iteration)

Eight review findings, one coherent production iteration. No services,
browser, Docker, or provider keys. Build/node checks only.

## What changed

1. Activity polling is independent from SignalR transport.
`useMeetingActivity` resolves `available | loading | paused | unavailable`
from the actual HTTP query only (request-stale origin, fetch failure,
enabled, data, React Query pause, page hidden/offline gate, post-resume
freshness gate) and withholds the snapshot unless `available`. A successful
fresh owned HTTP snapshot establishes `available` even when the hub start
failed or is stopped; `live === false` never gates fresh polls. Hidden tab /
offline pauses the retained snapshot; resume requires a fresh HTTP poll
before reuse. Visibility/focus/online listeners resync explicitly and
unsubscribe; the hub effect handles `onreconnecting`/`onclose` (drop Live,
refresh HTTP), rejoins with resync on `onreconnected`, and restarts on the
domain-restore generation bump without ID changes. The Live badge renders
only for actual transport + `available`; polling-only states show honest
response badges without raw Live. No false all-listening.
2. Research banner derives from the owned GET snapshot. The entire outer
banner (state/version/proof/stage/running, terminal metadata, error,
loading) renders from `roster-research` data, never from cached
`selRow.researchedAt` priority: running beats everything, terminal
failed/unsupported/superseded/interrupted render honestly with retry
guidance, and loading/error states are explicit (no unexplained "not yet").
The 2.5s poll stays while open; run->terminal and version edges refresh the
canonical roster families so the banner and row meta converge.
3. Character errors never leak technical text. `characterFriendlyError`
prioritizes authentication, then research-conflict guidance, both before any
other mapping; the generic record/discussion mapper is no longer consulted
from this translator at all (`FriendlyError` display kept). Only exact known
client-validation sentences pass through as fixed copy (never a matched raw
substring, so `Name is required; SQLSTATE ...` cannot leak). Research
409s/running/conflict and provider/deadline failures use fixed human copy.
Raw 409/version flow internals and draft/owner text are preserved; the PUT
verify note never interpolates raw status.
4. Confirmed PUTs invalidate immediately. `onInvalidated` fires right after a
confirmed PUT when the captured auth origin is still valid, before the held
verification GET and before op-ownership/unmount checks; invalidation only
refreshes caches (the captured callback never selects rows or closes
modals). All editor writes and creation callbacks invalidate; old-identity
completions stay silent while same-identity unmounted writes still
invalidate. Text adoption stays independently ownership-gated.
5. Apply identity retires every Secretary mutation. Initial/retry/answer plus
briefing, note-edit, and note-reverse observers reset with their latches
(`secPendingRef`, edit session/visit, history revision, epoch/envelope
revisions). Queued mutation variables freeze board/meeting/user/epoch/origin
at click; dispatch-time checks retire stale attempts before any POST;
callbacks check captured origin + operation ownership so old settlements
cannot clear a new action. Envelopes/Profile guards and the three direct
Secretary paths are unchanged.
6. Secretary aggregation prefers live work. Among overlapping owned
requests, actual `inflight`/`answering` wins over newer `pending` (the user
sees Responding while one request answers), then clarification, then newest
terminal history. Bounded, private caller scope only.
7. Lifecycle acceptance is mounted, not mirrored. New
`qa/advisor-final-lifecycle-browser.mjs` drives the real compiled App with
React Query through Playwright (in-process static server on an ephemeral
127.0.0.1 port, owned headless Edge, deferred route fixtures; no shared or
human CDP): held activity error, hidden-tab pause, offline resume, healthy
HTTP with hub stopped, recovery, research live->terminal->rerun->failed,
confirmed PUT with held verify + unmount, creation invalidation before text
adopt, queued held briefing/edit/reverse across Apply identity with new-op
positive controls. Request barriers plus real assertions throughout: no
sleep-only waits, no vacuous placeholders.
8. Precursors kept honest. The 172 SSR/helper checks and 36 source-wiring
assertions remain as precursors only (the always-passing `|| true` was
removed and stale live-gating expectations were corrected to the HTTP-
authority contract); they are not lifecycle acceptance. Doc scope
corrected here.

Kept intact: three-paragraph/fresh-creation/version floors/Profile guards,
Send core, and navigation (concurrent-owner `qa/navigation.cjs`,
`qa/fixtures.cjs` plus nav doc excluded from this commit).

## Verify

- Rebuild web first so `web/dist` matches source: `npm run build` in `web`
(or `npx tsc --noEmit -p web` for typecheck only)
- `node qa/advisor-final-lifecycle-browser.mjs` (mounted lifecycle
acceptance; primary runs this immediately after commit)
- `node qa/advisor-final-closure-qa.cjs` (precursor: behavioral render
suite over the actual modules plus actual-source wiring assertions; asserts
the three concurrent-owner files are excluded from the staged payload)
- `node qa/frontend-integration-behavioral.cjs`
