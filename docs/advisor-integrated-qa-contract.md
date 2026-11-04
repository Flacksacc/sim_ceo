# Advisor Integrated QA — contract (Muse sole-QA author, current 562)

Companion to `qa/advisor-integrated-qa.mjs` + `qa/own-local-stack.mjs`. Muse is the sole
author of QA/helper/contract. Production (`web/`, `server/`) is frozen at 562
(`a84743b` merge of 5623fe1); no App/server edits to make QA pass. Primary independently
built and ran the frozen production (180 PASS / 0 FAIL, 138240ms,
`.tmp/primary-advisor-a847-integrated.log`, native PG37
`.tmp/primary-character-562-current-pg.log`).

## What this QA proves on the OWN stack (15396 API + 15398 fake, own headless Edge)

- Trusted pre-mutation gates: `/health` instance `qa-author-15396`, `/ready`
  inmemory, fake `__log` fresh empty, OWN `manifest.json` (DLL + wwwroot +
  QA + fake sha256 + commit + nonce) bound before the first `POST /auth/register`.
  Any mismatch FAILs closed (exit 2). No mutation of a foreign/PG stack.
- Profile: UI save + HTTP readback, boards inherit default, explicit override,
  second save, version stability (`override-version-stable` strict positive ints).
- Creation (real dialog `+ Create new Advisor`, dialog-scoped): visible live
  research progress (working + stage + elapsed), owned fetched evidence
  (`research-evidence-owned-fetched`), dossier prompt owned, fetched excerpt in
  dossier prompt and dossier in compile prompt (`research-excerpt-dossier-compile`),
  deterministic compile exact + 3 paras + editor==draft, owner markers roundtrip,
  version bump.
- Portraits + attach: upload 201, accept 200, copy 201, duplicate 409, approve 200,
  distinct PNG bytes, board advisors resolve roster.
- Meeting send once (POST messages x1, PATCH x1, POST run x1, exact participant set,
  one control area): paired working (2 good samples raw+visible badge+human label),
  exact `responding` raw + visible `Responding` badge (`activity-responding-badge-exact`),
  progress visible, terminal complete, mapped badges honest, working observed.
- Secretary: exact POST requestId/nonce/StripPrefix input, same-ID completed GET,
  provisional persisted exact body + parent, provisional positive, tray rendered,
  no-decision (zero non-provisional direction + snapshot unchanged),
  in-flight request + in-rail seat progress (`secretary-inflight-seat-progress`),
  overlapping second request with two distinct completed IDs
  (`secretary-overlap-two-requests`).
- Focused mounted states (not backend mapping alone): `QA-ABSTAIN` meeting reaches
  raw `abstained` + mounted `act-abstained` seat with human label;
  `QA-REPLYERR` reaches raw `failed` + mounted `act-failed` seat with human label.
- Bid paras: owned `Reply with exactly YES or NO` prompts carry current full paras
  (`bid-current-paras-owned`).
- Rerun: canonical reopen == canonical (not draftProfile), rerun lead posts unique
  `RERUN-` marker + ordinary question only, run 200, published, promptlog carries
  exact owned YOUR TURN + current full paras with no stale leak.
- Roster chat: fresh-entry identity, singular `div[data-roster-chat]` (exact + visible
  counts agree), board-free contract, controls, FULL message shape (all fields
  including `CreatedAt` ISO, strict integer sequence, no omission/coercion),
  baseline valid, UI reply, request via response `request()` pairing (exact URL +
  exact `message` key, no `content`/`body`), UI==answer, stateless (full snapshots
  including `CreatedAt` identical), current paras in direct-chat prompt
  (`roster-chat-current-paras-owned`).
- Audition: `POST /api/auditions` 200 + current paras in isolated audition prompt
  (`audition-current-paras-owned`); comm prefs preserved via owned markers.
- Navigation: 12 rail destinations with scoped section+heading+exact entity (or
  explicitly verified empty: records `Pick a meeting first`/`No records`, sources
  `No sources`), rail click recorded separately (`nav-rail-clickable-*`, no wizard
  direct fallback counts), direct routes + back/forward with same predicates,
  exact one pre-save 404, no unexpected failures.
- Debug: same collector+detector on every tag; visible GUID/JSON-string/object/array/
  primitive values exclusively inside inputs/textareas verified collected;
  hidden/visibility-hidden/display-none/attribute carriers verified ignored.
- Deadlines: one absolute `DEADLINE_MS` (420s-30s reserve); `remainingMs()` has no
  floor past deadline; `boundedTimeout` throws past deadline; `req`/upload/fake
  track full body consumption; `drainPending` aborts before waiting; browser/context
  close bounded (15s); launcher start/stop have absolute budgets including checks +
  TCP probes. Failed setup throws to `finally` cleanup (browser always closes),
  exit 2, dependent cases never run (no cascade).

## Explicitly NOT claimed here (separate gates)

- Real-provider wording/timing (live `:15180` fails closed `promptlog-live-UNPROVED`).
- Physical microphone / audio paths (no audio assertions).
- Wizard progress/error/CAS: this monolith only visits the wizard destination;
  wizard CAS/progress/error are covered by dedicated wizard suites, not claimed here.
- Legacy recovery, preserved memberships/history/metadata, cross-account boundaries,
  narrow-screen behavior: covered by focused suites, not this monolith.
- Focused-suite reruns themselves (backend, Send, lifecycle, Nav 247/2, character
  audition/bid/direct details, usage/activity browser) must still PASS under primary.
- PostgreSQL persistence/restart, Docker, human ports, `.env`/real keys/real provider:
  never touched here (OWN 15396/15398 + owned Edge only).

## Run

`QA_WEB=http://127.0.0.1:15396 QA_FAKE=http://127.0.0.1:15398 node qa/advisor-integrated-qa.mjs`
Allowlist: 15396 OWN native (default), 15300 legacy primary app, 15180 owned Docker
primary-only with `ALLOW_LIVE_PROVIDER=1`. Refuses 5173/5080/9333/15180-without-flag,
other hosts/ports, credential URLs. Exit 0 PASS, 1 FAIL, 2 FATAL/setup.
Owned rows left for forensics (exact-ID scope only). No global cleanup/restore.