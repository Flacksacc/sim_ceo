# Advisor Integrated QA — contract (Muse sole-QA author, current 562)

Companion to `qa/advisor-integrated-qa.mjs`. Muse is the sole author of this
QA script and this contract. Production (`web/`, `server/`) is frozen at 562
(`a84743b` merge of 5623fe1); no App/server edits to make QA pass. The OWN
loopback stack launcher (`qa/own-local-stack.mjs`, ports 15396 API + 15398
fake) is owned in parallel by the helper author; this QA consumes its
build manifest but never edits the launcher. Primary independently built and
ran the frozen production (180 PASS / 0 FAIL, 138240ms,
`.tmp/primary-advisor-a847-integrated.log`, native PG37
`.tmp/primary-character-562-current-pg.log`).

## Execution status of THIS revision (read first)

CODE ONLY. This revision closes all 11 findings of the
`../advisor-2adbcde-full-review.txt` review in source. No services, network,
browser, PG, Docker, `.env`, real keys, providers, or shared ports were
touched here: `node --check` clean only. Actual runtime is UNEXECUTED
pending the primary combined fresh build (helper + QA combined by primary).
No PASS is claimed for the new/strengthened assertions until that run.
Counts from prior executions (author 210/0 on the OWN stack, primary 180/0)
describe the previous source, not this revision.

## What this QA proves on the OWN stack (15396 API + 15398 fake, own headless Edge)

- Trusted pre-mutation gates: `/health` instance `qa-author-15396`, `/ready`
  inmemory, fake `__log` fresh empty, OWN manifest bound BEFORE the first
  `POST /auth/register`. The consumer verifies the build-time production
  input binding strictly: manifest nonce + commit + instance
  (`qa-author-15396`) + DLL sha + wwwroot sha + QA/fake/helper sha256, all
  present and well-formed; QA/fake/helper hashes equal the working-tree files;
  manifest nonce/commit equal the controller pidfile/run record
  (nonce/controller/child identity tied); manifest timestamp sane; served
  `/` index reachable and non-trivial. Any mismatch FAILs closed (exit 2)
  with the full identity detail in the assertion output. No mutation of a
  foreign/PG stack. Extended build-inventory fields documented by the helper
  author are verified when present (forward-compatible); the primary combines
  helper + QA before execution.
- Deadlines: one absolute `DEADLINE_MS` (420s-30s reserve) plus per-operation
  local windows that open BEFORE progress probing, send sampling, and
  Secretary polling (research local window, send operation window, Secretary
  overlap window). `remainingMs()` has no floor past deadline;
  `boundedTimeout` throws past deadline; every HTTP body is fully consumed
  under a cap; every browser acquisition, response-body read, and evaluate is
  asserted/capped against the remaining work clock. Cleanup runs on an
  INDEPENDENT clock (unclamped sleeps, 20s budget): pending operations are
  aborted then retained (never silently cleared after a settlement race),
  page/context/browser handles are closed and their exit verified, and any
  late handle FAILs closed instead of being discarded by the work clock.
- Profile: UI save + HTTP readback, boards inherit default, explicit override,
  second save, version stability (`override-version-stable` strict positive ints).
- Creation (real dialog `+ Create new Advisor`, dialog-scoped): visible live
  research progress (working + stage + elapsed/live-run) inside the local
  window, owned fetched evidence (`research-evidence-owned-fetched`), FULL
  exact fetched excerpt verbatim in the dossier prompt
  (`research-excerpt-full-in-dossier`, never a 24-char prefix), ACTUAL
  returned dossier-claim lines verbatim in the compile input
  (`research-dossier-content-full-in-compile`, never heading-only),
  deterministic compile exact + 3 paras + editor==draft, owner markers
  roundtrip, version bump.
- Portraits + attach: upload 201, accept 200, copy 201, duplicate 409, approve
  200, distinct PNG bytes, board advisors resolve roster. All portrait
  prerequisites are FATAL, including the second upload/review: any failure
  aborts the cascade, never proceeds into dependent setup.
- Meeting send once (POST messages x1, PATCH x1, POST run x1, exact
  participant set, one control area, exact CAS bodies): paired working (2 good
  samples raw+visible badge+human label), exact `responding` raw + visible
  `Responding` badge (`activity-responding-badge-exact`), progress visible,
  terminal complete, mapped badges honest, working observed.
- Secretary, first request: exact POST requestId/nonce/StripPrefix input,
  same-ID completed GET, provisional persisted exact body + parent,
  provisional positive, tray rendered, no-decision (zero non-provisional
  direction + snapshot unchanged).
- Secretary, TRUE overlap (not two sequential completions): request A is HELD
  (flight started, never awaited), then request B starts while A is live on the
  SAME meeting with a distinct nonce. Required: both POSTs 2xx with distinct
  IDs, nonce-exact backend rows for both, an observed sample with both live,
  and B still live with the exact visible seat badge after A reaches terminal
  (`secretary-overlap-seat-survives-terminal`) — A terminal/stale discard
  must not clear B's visible pending seat. Seat proof requires the exact
  visible human badge (`Responding`/`Waiting for reply`/… per the real
  mapping) plus visibility, correlated to nonce-specific backend state.
  Terminal KIND is recorded, never gated: backend semantics win, both-succeed
  is never required.
- Focused mounted states (not backend mapping alone): `QA-ABSTAIN` meeting
  reaches raw `abstained` + mounted `act-abstained` seat with the exact
  visible human text `Abstained`; `QA-REPLYERR` reaches raw `failed` +
  mounted `act-failed` seat with the exact visible human text
  `Response failed`. Non-empty text or classname alone never passes.
- Bid/chat/audition carry the CURRENT complete paras INCLUDING the decisive
  40-char tail (never 32-char head prefixes), BOTH before and after the
  canonical edit: bid before + bid after (no stale leak), roster-chat before
  (HTTP) + after (real UI), audition before + after.
  (`bid-current-paras-owned`, `bid-after-current-paras-owned`,
  `roster-chat-current-paras-before/owned`,
  `audition-current-paras-owned`, `audition-after-current-paras-owned`.)
- Real communication preferences DELIVERED + controlled authorized evidence
  retained in the MEETING reply prompt before and after the edit
  (`meeting-prompt-prefs-evidence-before/after`: exact lead `oc-<run>`
  prefs, exact QUESTION, full paras in YOUR TURN prompts). The stateless
  roster-chat prompt NEVER carries board/meeting evidence before or after
  (`roster-chat-no-board-leak-before/after`: no QUESTION, `BOARD:`,
  `MEETING BRIEF:`, `ADOPTED DIRECTION`, `CALLER `). Lead prefs stay
  exact on the board lead (`comm-prefs-preserved`).
- Rerun: canonical reopen == canonical (not draftProfile), rerun lead posts
  unique `RERUN-` marker + ordinary question only, run 200, published,
  promptlog carries exact owned YOUR TURN + current full paras with no stale
  leak.
- Roster chat: fresh-entry identity, singular `div[data-roster-chat]`
  (exact + visible counts agree), board-free contract, controls, FULL typed
  message shape (all fields including `CreatedAt` ISO, strict integer
  sequence, REQUIRED `parentSequence` + `advisorName` presence with raw
  null preserved and distinguished from `""`/missing — no
  String-coercion snapshots), baseline valid, UI reply, request via response
  `request()` pairing (exact URL + exact `message` key, no
  `content`/`body`), UI==answer, stateless (full typed snapshots
  including `CreatedAt` identical).
- Audition: `POST /api/auditions` 200 + current FULL paras in isolated
  audition prompts.
- Navigation: 11 rail destinations with scoped section+heading+exact entity
  (or explicitly verified empty: records `Pick a meeting first`/`No
  records`, sources `No sources`), each rail click recorded separately
  (`nav-rail-clickable-*`); the wizard is direct-only BY DESIGN
  (`nav-wizard-direct-only-truth` asserts no rail control exists —
  inventing a 12th rail would be wrong), direct routes + back/forward with the
  same predicates, exact one pre-save 404, no unexpected failures.
- Debug: same collector on every tag; FIVE isolated detector positives
  (guid/string/object/array/primitive, one value per probe, same collector) so
  narrowing any detector form fails its own case instead of hiding behind a
  combined aggregate; hidden/visibility-hidden/display-none/attribute carriers
  verified ignored.
- Setup/prereq discipline: every failed prerequisite throws to `finally`
  cleanup (browser always closes), exit 2, dependent cases never run (no
  cascade). No global cleanup/restore. Owned rows left for forensics
  (exact-ID scope only).

## Explicitly NOT claimed here (separate gates)

- Real-provider wording/timing (live `:15180` fails closed `promptlog-live-UNPROVED`).
- Physical microphone / audio paths (no audio assertions).
- Wizard progress/error/CAS: this monolith only visits the wizard destination;
  wizard CAS/progress/error are covered by dedicated wizard suites, not claimed here.
- Legacy recovery, preserved memberships/history/metadata, cross-account
  boundaries, narrow-screen behavior: covered by focused suites, not this monolith.
- Focused-suite reruns themselves (backend, Send, lifecycle, Nav 247/2,
  character audition/bid/direct details, usage/activity browser) must still
  PASS under primary.
- PostgreSQL persistence/restart, Docker, human ports, `.env`/real keys/real
  provider: never touched here (OWN 15396/15398 + owned Edge only).
- Helper-owned launcher hardening (process identity, env filtering,
  supervision/cleanup): owned by the parallel helper author in
  `qa/own-local-stack.mjs`; this QA only consumes and verifies its manifest
  binding. The primary combines both before execution.

## Run

`QA_WEB=http://127.0.0.1:15396 QA_FAKE=http://127.0.0.1:15398 node qa/advisor-integrated-qa.mjs`
Allowlist: 15396 OWN native (default), 15300 legacy primary app, 15180 owned
Docker primary-only with `ALLOW_LIVE_PROVIDER=1`. Refuses
5173/5080/9333/15180-without-flag, other hosts/ports, credential URLs.
Exit 0 PASS, 1 FAIL, 2 FATAL/setup. Owned rows left for forensics (exact-ID
scope only). No global cleanup/restore.

## Repair revision 2026-11-04 (CODE ONLY, UNEXECUTED)

Base `a054f19`. Primary confirmed regressions in the owned wrappers and setup binding; this round repairs exactly those, preserves every genuine assertion name, and weakens nothing. No production edits; no services/network/browser/PG/Docker/`.env`/providers/ports run here.

1. Bounded wrappers (same assertion surface, real operations): `ev` calls the live `page.evaluate(fn, arg)` under a 15s-vs-remaining-work-clock `Promise.race`, requires a live open page, and `trackPromise`s the op so late settlement is retained by `drainPending`, never silently cleared. `wft` sleeps via the existing bounded `sleep(min(want, rem))` (no self-recursion, no stack overflow). `respJson` races the real `r.json()` the same way with a missing-`json` fail-closed guard. `pev` races the real `pg.evaluate(fn, arg)` with a live-probe-page guard. All four keep the `assertDeadline`/remaining-clock gates; timeouts throw into `finally` cleanup, where the independent 20s cleanup clock closes and verifies page/context/browser handles.
2. Served-assets binding is now hash-bound: served `/` must be 200 AND `len > 500` (preserved) AND `sha256(utf8 body) == manifest wwwrootSha` (`shaEq`). Length alone no longer passes. Detail logs `shaEq=true/false` for audit.
3. Nonce/controller/child binding is now fully checked: pidfile nonce/commit must equal manifest nonce/commit AND pidfile `controllerPid` must equal manifest `controllerPid` (nonempty), pidfile `apiPid`/`fakePid` must equal manifest `apiPid`/`fakePid` (positive integers), and all four recorded identities (pidfile api/fake + manifest api/fake) must be well-formed (`status alive` + nonempty creation/cmd/exe) with matching cmd/creation across the two records. The `setup-build-input-nonce-controller-child` assertion keeps its name but now requires `ctrlOk && childPidOk && childIdentOk`; the trusted-binding gate and `identDetail` expose the new fields.

Validation this round: `node --check qa/advisor-integrated-qa.mjs` PASS plus an in-process replica check of the four wrappers (ev value 42, 200x wft loop without overflow, ev/respJson timeout bounded ~120ms, pev value 42). Full OWN-stack runtime (fresh manifest binding against helper build) is UNEXECUTED pending the primary combined fresh build/run after review; no new PASS counts are claimed here. The dedicated `../advisor-helper-e613-qa286-independent-review.txt` (landed 2026-11-04 06:02) was read; in-scope confirmed findings are addressed in the follow-up block below, the remainder (overlap causality F10, research/evidence/second-approval F11, uncapped-locator/Secretary-window F6-remainder) is explicitly left for the primary/parallel author with runtime (see below).

## Follow-up block: dedicated e613+qa286 independent review (read 2026-11-04, CODE ONLY)

In-scope confirmed findings fixed here (owned files only, no production edits, no invented global work):

- Fake identity exactness: initial fake validation now additionally requires the exact `--port 15398` (`--port=` accepted) argument in the recorded command line, alongside the existing absolute-script-substring + `node` basename + absolute-exe rules. The spawn vector itself is exact by construction (`node [EXPECTED_FAKE_JS, --port, FAKE_PORT]`); the API spawn is the exact absolute DLL (`dotnet [EXPECTED_API_DLL]`).
- Manifest globals are now reported, not just saved: new `setup-manifest-globals-reported` assertion checks `globalThis.__manifestNonce/__manifestCommit` equal the bound manifest nonce/commit, binding the emitted QA result to the verified build/run record. The trust chain is helper-`start` (pre-build inputs vs current inputs, DLL/deps/runtimeconfig/appsettings/publish-DLL-set/full-wwwroot vs manifest) then QA-setup (manifest + pidfile nonce/controller/child + served-index sha + QA/fake/helper hashes, all before the first mutation).

Explicitly NOT redesigned here (need executed runtime and/or non-owned files, left for primary/parallel author): F10 overlap true-both-live snapshot + seat-causality + 409-vs-rows handling; F11 research dossier-answer-vs-citation assertion (touches production `CharacterResearch.cs` semantics and the non-owned `qa/advisor-integrated-fake.mjs` fixture), authorized-evidence payload, second-advisor-approval stop; F6-remainder per-locator caps, context-acquisition budget, Secretary local-window placement, browser-disconnect/process-exit accounting. No assertion covering those was weakened; they keep their existing (unexecuted-here) semantics for the primary run to judge.

## Repair revision 2026-11-04 CODE ONLY, UNEXECUTED (this root, owned QA+fake only)

Base 0f8d066. No production edits; no services/network/browser/PG/Docker/.env/providers/ports run here. node --check clean only; in-process actual-helper probes only (no source-string assertion as behavioral proof). Primary does the fresh combined build/runtime and independent review.

- Deterministic overlap: OWN 15398 fake now holds overlap-A/B (__hold/__release/__holds; chat completions awaits the held marker up to 120s) so backend rows stay live deterministically. QA holds BOTH gates BEFORE either POST, starts A, proves A live, then starts B, requires BOTH nonces LIVE in ONE backend snapshot, releases A while B is HELD, requires A-terminal/B-live in ONE snapshot, then polls until the mounted App seat equals B-live exact act+human while the snapshot still shows A-term/B-live (held through observation, never stale A), releases B, and accepts each flight as 2xx-with-exact-requestId or 409 correlated to the same nonce row terminal kind (backend semantics win; both-succeed never required). No sleep500 assumed overlap. Existing overlap assertion names kept with stronger semantics.
- Dossier: compile proof now uses ONLY angle=dossier answer lines (whole-line+tail+order in ONE correlated compile input); citation excerpts (angle!=dossier) are separately stored and explicitly never required (production BuildCompileInput passes only g.Text). New citation-not-required assertion documents this.
- Evidence: QUESTION duplicate explicitly labeled NOT eligible evidence; runs use evidenceSupported:false by construction (actual sent run bodies); new eligible-evidence-controlled-absent assertions before/after edit enforce the distinction.
- Paragraphs: FULL whole-line+tail checks kept for bid/direct-chat/audition/meeting YOUR TURN before AND after canonical edit (M vs N markers, no stale leak). Second-advisor approval now FATALs on non-200 (no dependent cascade).
- Browser: context/page acquisition bounded with late-handle retention+close; closeBrowser on independent clock with independent context-timeout detection, browser-handle-disconnect check (handle-only, OS process exit helper-owned), late-handle/unsettled-op accounting. Fixed 8000ms waits now boundedTimeout-capped; meeting rail reads, composer fill/press, secretary fill/press, overlap seat reads raceCap-capped; first Secretary window opens BEFORE send; overlap POSTs use the overlap local remainder.
- Setup: live-process signal check (kill pid,0) for controller+children plus manifest/pidfile nonce/controller/child binding; ALL served wwwroot files raw-bytes sha256 vs build-manifest wwwrootAll plus served index sha; build-manifest commit agreement. Prior index/nonce/child gates preserved and strengthened, never weakened.

Explicitly NOT executed here: fresh OWN build/start/stop/status, served-asset HTTP reads, fake gate roundtrips, browser runs, PG/restart, real-provider/microphone, narrow-screen, legacy/cross-account/stale-output/research-failure/retry/portrait-retirement. Honest limits retained for primary runtime.
