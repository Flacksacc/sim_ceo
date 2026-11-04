# Records browser CB final — independent review follow-up (Muse)

Scope: sole code/test author for `qa/browser/records-phase5-onedoc-ui.cjs` plus this distinct doc
`docs/records-browser-cb-final.md`. Parallel other-file author owns remaining files.
No production or other QA files touched. Frozen production `181140d` plus accepted
formatter `19dcda0` preserved. Launcher `qa/records-phase5-launch.mjs` not edited.

Primary evidence (unchanged, owned by primary): exact combined `c971b55`,
fresh 226 HTTP / 234 browser, 0 failures, 73431 ms, cleanup closed, passed.
Static findings 4–7 remained open after that green run; a green run does not
close static review. This change addresses the static findings only.

## Finding 4 — exact expected-error allowances

- Replaced loose `expectConsoleError(path,status)` with
  `expectConsoleError(method,path,status,label)` carrying exact method
  (`GET`/`POST`), exact path (`/api/records/<id>[/...]`), exact status
  (`409`/`403`/`404`/`ERR`), and exact context (`main`/`stranger`/`reader`).
- Added `netLog` (owned `/api/records/*` method/path/status/label/at from
  `watchResponses(pg,label)`) and `stubLog` (routeGuard 403/abort/JSON stub
  interceptions with method/path/at). `consumeExpectedConsole(combined,txt,label)`
  now requires all of: label match, path substring, status substring,
  recency ≤30 s with expiry, plus request-correlation (matching `netLog`
  entry for HTTP statuses; matching `stubLog` abort for `ERR`).
  The old `path OR recency<30s` fallback is removed.
- Removed blanket suppressions: hub/transport (`/hubs/board`, `Failed to start
  the transport`, `WebSocket…`, handshake), navigation-window transport
  (`__navAt`/`__navAny`/`__recentAbortAt` windows), and owned-origin
  reader/stranger 403 blanket. `consoleAllowed(txt,loc,label)` now allows only:
  exact correlated `409`/`403` on `/api/records/`, non-`/api/` `404`,
  non-owned-origin `net::ERR_`, fonts CDN, and correlated `/api/records/` `ERR_`.
- `attachCollectors(pg,label)` no longer tracks nav/WS windows for suppression;
  `pageerror` always records. Stranger visits now carry two exact expectations
  each (detail + review `GET 403`) instead of relying on the removed blanket.

## Finding 5 — Reload child-state and recovered-editor submit

- 403/abort scenarios now edit actual per-item children: R2 whole-editor text
  (`nth(2)`) and detail (`nth(3)`) with `STALE-403`/`STALE-ABORT` markers, plus
  real per-item revise inputs (`Revised text for decision N`) with
  `Bears child R1/R2 403|abort`. Old claim that unchanged
  `Bears reload two revised` proved child preservation is removed.
- 403/abort failure now asserts: whole text/detail preserved, actual R2
  text/detail preserved, per-item R1/R2 preserved, `canonState` unchanged,
  unknown `customMeta`/`customRef` retained via API, editor still mounted
  (≥4 fields), and App hides `Approve*`/`Request revision` controls
  (`allApproveControls()===0` + `Request revision` count 0).
- Recovery is SAME-KEY explicit refetch on the same mounted editor with no
  remount and no fixture bypass: clear `__stubReviewOnce`, click
  `Reload editor from current review` on the same `rid`, verify authority
  (`external-abort`, both `r1DetailInit`/`r2DetailInit`, `revised` R2),
  per-item cleared to authority, controls restored, unknown retained.
- Final `Request revision` submit happens from that recovered editor BEFORE
  any `page.reload`/remount. Successor checks compare complete state:
  R1 text `FINAL`, R2 text `revised`, both details exact, R2 refs complete
  (`kind/message/ref/title/customRef` exact, length 1), both `customMeta`
  exact, plus unknown markers. Added `both-details`, `complete-refs`,
  and `complete-meta` oks alongside the preserved text/201/successor checks.

## Finding 6 — missing manager validity independently exercised

- False-validity (`stateValid:false`) and missing-validity (no `stateValid`)
  payloads are now consumed via independent fresh fetch/remount:
  `page.goto` then `page.reload`, plus `page.reload` for the missing case
  (not a same-URL `goto` that could reuse the cached false response).
- RouteGuard marks `__stubReviewJson.seen/hits/lastAt` and `stubLog json`
  on each interception. Tests assert `false-intercepted` and
  `missing-intercepted` (≥1 hit) and `missing-distinct` (no `stateValid` key),
  proving each distinct payload was actually fetched, not satisfied by the
  prior response. No-approve control enumeration for both cases is preserved.

## Finding 7 — pending-child / current-head matrix

- Owner pending-child (`amBaseId`): added current-card heading
  `Approved decisions (current record)`, scoped card contents (alpha+beta),
  approving versions (`versions 1 to 1`/`version 1`/`Review v1`), and exclusion
  of pending replacement (`alpha replaced`) from the card.
- Owner v2 (`amV2`): added current-card heading check; preserved
  inherited+replaced with manager versions and guest-wording exclusion.
- Owner partial (`pid`): added heading, scoped card (approved without pending),
  and approving version (`version 1`/`versions 1`/`Review v1`).
- Guest v2: added current-card heading and scoped contents alongside preserved
  `approved in version 2/1`.
- Guest partial (`pid`): added current-card heading, explicit
  `not historical` assertion, and scoped card (approved without pending)
  alongside preserved `approved in version 1` and protocol exclusions.
- Guest pending-child (`qBaseId`): added current-card heading, scoped
  alpha+beta, `approved in version 1`, and exclusion of `alpha replaced`.
- Guest v1 historical/effective: added `approved in version` in effective card.

## Cooperative work deadline and cleanup

- Added `RECORDS_QA_WORK_DEADLINE_EPOCH_MS` (cooperative, from launcher when
  present; launcher itself untouched) and `RECORDS_QA_CLEANUP_MS` (default
  `20000`). Own watchdog is `min(T.overall, deadline-now-OWN_CLEANUP_MS)`,
  so own teardown (contexts/browser close + final exit) reserves its cleanup
  earlier than the parent deadline. Retained owned-browser exit
  (`browser.close` via `cleanup()` + bounded final-exit). Logs own
  watchdog/deadline/cleanup values at startup.

## Preserved checks, frozen scope, and limits

- All genuine prior oks/preflights preserved (only strengthened; no deletions
  except the two false child-preservation assertions replaced with actual
  stale-marker checks).
- No `server/`, `web/`, launcher, formatter, or other `qa/` files touched.
- CODE ONLY: edits limited to the two owned paths. No services, network,
  browser, processes, PG, Docker, providers, `.env`, human actions, or other
  worktree mutations were performed in this change.
- Validation in this change: `node --check` syntax plus in-process file probes
  only. No fresh build/runtime/browser review was run here; combined fresh
  build/runtime/review remains owned by the primary (cited above).
  Static fixes are presented for independent re-review, not as a self-closed
  runtime claim.

## Files

- `qa/browser/records-phase5-onedoc-ui.cjs` (203 insertions, 65 deletions)
- `docs/records-browser-cb-final.md` (this file)
