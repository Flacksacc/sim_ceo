# Advisor final closure (827c00c follow-up)

Six review findings, one production commit. No services, browser, Docker,
or provider keys. Build/node checks only.

## What changed

1. Activity availability is explicit end to end. `useMeetingActivity`
resolves `available | loading | paused | unavailable` from the actual query
(req stale, fetch failed, enabled, data, paused/offline, live flag) and
withholds the snapshot unless `available`. `buildPresence` applies the
snapshot only when `available`; otherwise approved seats render
`checking`/`unavailable`. The renderer summary reports checking/unavailable
instead of false all-listening. Identity/restore ownership is preserved:
stale origins and failed fetches map to `unavailable`.
2. Research cards refresh. The roster `roster-research` query polls every
2.5s while the detail is open (working, terminal, save, and new-run
states). Saves and creation invalidate `roster-research` alongside the
canonical families. The card shows working first: running beats a cached
`researchedAt`, so a rerun never hides behind Researched.
3. Errors stay human. `characterFriendlyError` only passes through explicit
allowlisted client validation; arbitrary short statusless text (including
GUID/technical shapes) maps to a generic human note. Generic 409s never
claim already-running: only an explicit already-running reason does;
profile-changed/newer/version conflicts demand review-and-retry. The PUT
verify note no longer interpolates raw status/JSON. Raw stale/version flow
internals are preserved; 401 still maps to sign-in-again (never hidden).
4. Canonical saves invalidate. Every confirmed PUT invalidates, including
the known-newer/conflict path via `onInvalidated` (no stale adoption, no
owner-text overwrite). Creation `onCreated`/`onInvalidated` invalidate the
linked board families (`advisors`, `setup`, `status`, `meetings`,
`meeting-detail`) plus `roster-research`.
5. Secretary aggregation prefers work. Overlapping owned nonces/tabs
aggregate active `pending`/`inflight`/`answering` first, then clarification,
then newest terminal history. A newer terminal from one tab can no longer
hide another tab that is still working. Private caller scope only.
6. Apply identity unblocks Send. The Apply identity transition synchronously
clears `secPendingRef` and resets the held secretary mutation observers
(initial/retry/answer) plus the envelope/hydration revisions and epoch, so a
new Send is usable without waiting for the old callback. Old callbacks stay
silent via epoch/origin/op guards; a new op cannot be cleared by an old
settlement. Recoverable envelopes in storage are retained.

Kept intact: three-paragraph/fresh-creation/version floors/Profile guards,
Send core, and navigation.

## Verify

- `node qa/advisor-final-closure-qa.cjs` (behavioral render suite over the
actual modules plus actual-source wiring assertions; asserts the three
concurrent-owner files are untouched)
- `node qa/frontend-integration-behavioral.cjs`
- `npm run build` in `web` (or `npx tsc --noEmit -p web`)
