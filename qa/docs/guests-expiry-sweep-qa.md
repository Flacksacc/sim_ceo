# Guests natural-expiry sweep probe (QA-ONLY)

Project: `qa/GuestsExpirySweepProbe` (console exe, own Kestrel, loopback `127.0.0.1:15344`).
Author: Muse, sole QA author. No production changes. `qa/GuestsGetCommitProbe` untouched.

## What it proves

- Sessions are MEMORY ONLY with an issued lifetime of ~14 days, read from the actual
  in-memory `Session` row after registration through the ACTUAL `/api/auth/register` route.
- A QA-owned guest session keeps its row and token while ONLY `ExpiresAt` is shortened
  (under the owned `RootGate`). No logout, revoke, delete, clock seam, SQL, PG, or Docker.
- With real wallclock passing the shortened `ExpiresAt` and BEFORE the next 30 second sweep,
  the ACTUAL `BoardHub.PublishMeeting` delivers the exact owner CONTROL marker with ZERO
  guest markers, and the ACTUAL `BoardHub.PublishPrivateMeeting` delivers ZERO guest markers.
- Pre-sweep publisher-guard proof observes the REAL server removal boundary, not the client
  `Closed` callback: a QA-only forwarding `IHubContext<BoardHub>`/`IGroupManager` decorator
  is passed to `BoardHub.Wire`, forwards real `Groups`/`Clients` unchanged, but records the
  START of the actual `RemoveFromGroupAsync` for the EXACT guest connection/group BEFORE
  calling the real method. The probe requires zero recorded removal starts both BEFORE and
  AFTER the post-expiry `PublishMeeting`/`PublishPrivateMeeting` + observation, with positive
  pre-expiry joined-subscription deliveries and zero `access-revoked`. If removals already
  began, the pre-sweep checks fail explicitly as boundary-violated; a false `Closed`
  callback is never accepted as the boundary. No mirrored auth predicate, no clock seam,
  no shipping hook.
- The actual 30s sweep timer from `BoardHub.Wire` is retained. `Wire` is called AFTER setup
  and pre-expiry positives (inspected: `Wire` only sets static `Ctx`/`Services` and starts
  the 30s timer; `Join`/`Publish` use per-call hub/store plus static `Conns`/`JoinedGroups`,
  so delayed `Wire` is safe and keeps slow setup out of the sweep window). Same QA-owned
  Session row `ExpiresAt` shortened to 8s real wallclock. Clock/sweep never disabled or
  restarted manually.
- The REAL 30 second sweep then emits `access-revoked` AND closes the guest hub connection,
  while the owner connection continues and still receives markers.
- The SAME protected MapPeople route `GET /api/boards/{bid}/capabilities?meetingId={mid}`
  (actual `MapPeople`, `BadToken`/`TrySession`) is guest-200 AND owner-200 BEFORE expiry,
  guest-401 AFTER the sweep with owner-200 AFTER. No mirror route; no
  `/api/meetings/{id}/messages` (production `Program` map, not `MapPeople`, would 404 here).
- After the sweep the same publisher is still owner-positive and guest-zero, the SAME
  capabilities route returns 401 for the guest token, `GET /api/auth/me` returns 200 with
  `authenticated === false` by strict JSON parse, the SAME owner REST path stays 200,
  the expired session row is retained,
  and `RevokedTokens` is untouched (no revoke path faked expiry).

## Exact cases (exit nonzero on any FAIL; no empty-array passes)

`preflight-port-occupied`, `memory-backend-not-null`, `host-started-bounded`, `host-started`,
`register-owner-bounded`, `register-owner`,
`register-guest-bounded`, `register-guest`, `issued-lifetime-owner-14d`,
`issued-lifetime-guest-14d`,
`issued-expiry-future`, `seed-board-meeting`, `grant-guest-discuss-bounded`,
`grant-guest-discuss`, `guest-join-bounded`, `guest-join`,
`signalr-owner-start-bounded`, `signalr-guest-start-bounded`, `signalr-connected`,
`guest-join-meeting-hub-bounded`, `guest-join-meeting-hub`,
`owner-join-meeting-hub-bounded`, `owner-join-meeting-hub`,
`positive-publish-meeting-bounded`, `positive-private-guest-bounded`,
`positive-private-owner-bounded`, `positive-observe-bounded`,
`positive-publish-meeting-both`, `positive-private-guest-only`, `positive-private-owner-only`,
`positive-rest-guest-200-bounded`, `positive-rest-guest-200`,
`positive-rest-owner-200-bounded`, `positive-rest-owner-200`,
`sweep-wired-after-prepositive`,
`fixture-row-retained`, `fixture-expiry-reached`,
`presweep-removal-zero-before`,
`expired-presweep-owner-positive`, `expired-presweep-guest-zero`,
`expired-presweep-private-guest-zero`,
`presweep-publish-meeting-bounded`, `presweep-publish-private-bounded`,
`presweep-observe-bounded`,
`presweep-removal-zero-after`, `presweep-revoked-zero`, `presweep-sweep-not-yet`,
`sweep-access-revoked-event`, `sweep-guest-connection-closed`, `sweep-owner-continues`,
`postsweep-publish-bounded`, `postsweep-observe-bounded`,
`postsweep-owner-positive`, `postsweep-guest-zero`,
`postsweep-rest-401-bounded`, `postsweep-rest-401`,
`postsweep-authme-bounded`, `postsweep-authme-unauthenticated`,
`postsweep-owner-rest-bounded`, `postsweep-owner-rest-200`,
`expired-row-still-present`,
`no-revoke-path-used`, `probe-threw`, `budget-75s`,
`cleanup-guest-stop-bounded`, `cleanup-owner-stop-bounded`,
`cleanup-guest-dispose-bounded`, `cleanup-owner-dispose-bounded`,
`cleanup-guest-unclosed-or-hung`, `cleanup-owner-unclosed-or-hung`,
`cleanup-app-stop-bounded`, `listener-cleanup`.

## Run (PRIMARY only, after independent inspection and review)

- Fixed loopback preflight: the probe refuses to start unless `127.0.0.1:15344` is free, and
  exits nonzero if the listener is still bound after cleanup.
- One TOTAL 75s stopwatch+CTS covers host startup inside `try`/`finally` plus every HTTP,
  hub start/invoke/publish/observation/client-close/`Dispose`/app-shutdown wait. Each wait
  uses the remaining TOTAL budget with `CancellationToken` where supported, otherwise a
  bounded `Task.WhenAny` + fault observation. Timeouts record FAIL and never immediately
  re-await the same hung task unbounded; `Dispose` gets its own bounded wait with a final
  unclosed failure; cleanup and listener proof still run; no hidden pending exceptions.
- Prerequisite gating: if the pre-expiry SAME-route positives fail, the three post-sweep REST
  cases fail fast as `skipped-prereq` instead of asserting against a broken fixture.
- If any real removal start is already recorded before the pre-sweep publish, the pre-sweep
  publisher checks fail explicitly as boundary-violated instead of claiming a guard proof.
- Command: `dotnet run --project qa/GuestsExpirySweepProbe/GuestsExpirySweepProbe.csproj -p:SkipStagePostgres=true`
- Do NOT run with `USE_POSTGRES=1`; the probe fail-closes unless `Pg.Backend` is null.
- Source and build by Muse; PRIMARY executes the network host probe.

## Explicitly NOT executed

- A real 14 day wait. The probe shortens ONE QA-owned session to prove the natural wallclock
  expiry path; it does not claim 14 days elapsed.
- Two guest connections or multi-meeting fan-out (bounded runtime; minimum is both publisher
  paths with a single valid subscription positive each).
- PG-backed sessions: there is no session table; sessions are memory only by production design.
- Network execution by Muse: this closure is source-only build; PRIMARY runs the live probe.

No acceptance is claimed. The run output lists exact pass/fail cases; anything unexecuted
above stays unexecuted.
