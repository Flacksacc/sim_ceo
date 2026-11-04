# Guests natural-expiry sweep probe (QA-ONLY)

Project: `qa/GuestsExpirySweepProbe` (console exe, own Kestrel host, loopback `127.0.0.1:15344`).
Author: Muse, sole QA author. No production changes. `qa/GuestsGetCommitProbe` untouched.

## What it proves

- Sessions are MEMORY ONLY with an issued lifetime of ~14 days, read from the actual
  in-memory `Session` row after registration through the ACTUAL `/api/auth/register` route.
- A QA-owned guest session keeps its row and token while ONLY `ExpiresAt` is shortened
  (under the owned `RootGate`). No logout, revoke, delete, clock seam, SQL, PG, or Docker.
- With real wallclock passing the shortened `ExpiresAt` and BEFORE the next 30 second sweep,
  the ACTUAL `BoardHub.PublishMeeting` delivers the exact owner CONTROL marker with ZERO
  guest markers, and the ACTUAL `BoardHub.PublishPrivateMeeting` delivers ZERO guest markers.
- The REAL 30 second sweep started by `BoardHub.Wire` then emits `access-revoked` AND closes
  the guest hub connection, while the owner connection continues and still receives markers.
- After the sweep the same publisher is still owner-positive and guest-zero, the protected
  People REST route returns 401 for the guest token, `GET /api/auth/me` returns 200 with
  `authenticated: false`, the owner REST path stays 200, the expired session row is retained,
  and `RevokedTokens` is untouched (no revoke path faked expiry).

## Exact cases (exit nonzero on any FAIL; no empty-array passes)

`preflight-port-occupied`, `memory-backend-not-null`, `host-started`, `register-owner`,
`register-guest`, `issued-lifetime-owner-14d`, `issued-lifetime-guest-14d`,
`issued-expiry-future`, `seed-board-meeting`, `grant-guest-discuss`, `guest-join`,
`signalr-connected`, `guest-join-meeting-hub`, `owner-join-meeting-hub`,
`positive-publish-meeting-both`, `positive-private-guest-only`, `positive-private-owner-only`,
`fixture-row-retained`, `fixture-expiry-reached`, `expired-presweep-owner-positive`,
`expired-presweep-guest-zero`, `expired-presweep-private-guest-zero`, `presweep-sweep-not-yet`,
`sweep-access-revoked-event`, `sweep-guest-connection-closed`, `sweep-owner-continues`,
`postsweep-owner-positive`, `postsweep-guest-zero`, `postsweep-rest-401`,
`postsweep-authme-unauthenticated`, `postsweep-owner-rest-200`, `expired-row-still-present`,
`no-revoke-path-used`, `probe-threw`, `budget-75s`, `listener-cleanup`.

## Run (PRIMARY only, after independent inspection and review)

- Fixed loopback preflight: the probe refuses to start unless `127.0.0.1:15344` is free, and
  exits nonzero if the listener is still bound after cleanup.
- Shared overall bound ~75 seconds; every wait is bounded and cleanup runs in `finally`.
- Command: `dotnet run --project qa/GuestsExpirySweepProbe/GuestsExpirySweepProbe.csproj -p:SkipStagePostgres=true`
- Do NOT run with `USE_POSTGRES=1`; the probe fail-closes unless `Pg.Backend` is null.
- Source and build by Muse; PRIMARY executes the network host probe.

## Explicitly NOT executed

- A real 14 day wait. The probe shortens ONE QA-owned session to prove the natural wallclock
  expiry path; it does not claim 14 days elapsed.
- Two guest connections or multi-meeting fan-out (bounded runtime; minimum is both publisher
  paths with a single valid subscription positive each).
- PG-backed sessions: there is no session table; sessions are memory only by production design.

No acceptance is claimed. The run output lists exact pass/fail cases; anything unexecuted
above stays unexecuted.
