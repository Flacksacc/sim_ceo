# Advisor Integrated QA — contract notes (Muse-authored)

Companion to `qa/advisor-integrated-qa.mjs`. Read this before executing.
No App/server changes were made for this QA; only this QA file + this doc exist.
Closure revision addressing all 21 findings of the ce5b492 review (frontend 0e7230b+7b3986f in .tmp/advisor-final-frontend, server dbb698c; both read-only, no production edits; fake http import cb5fad4 preserved). Small function-local repairs only; primary runs actual runtime.
This author never executed the script (node --check only); primary executes it
against the actual compiled combined app. No runtime claims are made here. Exit 0=PASS, 1=FAIL (assertion), 2=FATAL/setup (no raw JSON or tokens in logs; redacted summaries only).

## What primary provides (not this author)

- Final coherent root with the QA file ported to `qa/advisor-integrated-qa.mjs`.
- Running stack at `QA_WEB=http://127.0.0.1:15300` (compiled web/ copied as the
  published API wwwroot, fake-backed) or `:15180` (owned compiled Docker, real
  provider, needs `ALLOW_LIVE_PROVIDER=1`).
- Fake prompt log at `QA_FAKE=http://127.0.0.1:15302` (dedicated
  `qa/advisor-integrated-fake.mjs`: deterministic `COMPILE-CHARACTER-PARAGRAPHS` echoing the researched name, `YOUR TURN`/bid pacing, structured secretary JSON echoing the owned run marker, `QA-SLEEP-*` pacing; reuses research/chat schema from `qa/fake-provider.mjs` and secretary schema from `qa/secretary-fake.mjs`). Required in native 15300 mode; live 15180 mode has no prompt log (explicit UNPROVED path, fails closed). The script NEVER issues a global prompt-log DELETE: it captures a baseline timestamp at setup and filters all prompt assertions to `t >= baseline` plus owned run markers. Mode is selected explicitly by `ALLOW_LIVE_PROVIDER` (`native` vs `live`), never by log availability. Native request bodies are exact: PATCH brief is QUESTION.slice(0,800) + CAS fields without advisor ID; run body is {policy,prompt,evidenceSupported,leadVersion}; lead POST content is exactly QUESTION. Secretary completion requires completed + noteId under one deadline with correlated provisional note; direction rows are validated before the no-decision proof. Debug scanner uses independent GUID/string/object/array/primitive fixtures plus a clean negative and hidden-attribute exclusion; creation is scanned while open with visible form values.

## Assumed UI contracts (verified in source, not invented)

- Auth bootstrap: `localStorage` keys `simceo-token` / `simceo-user`, plus
  deterministic `simceo-account` seeded with the same account id used for all
  roster seeds and fresh-collection readbacks.
- Rail navigation: `nav.rail` buttons by exact name — Boards, Roster,
  Board Advisors, Meetings, Sources, Records, People, Activity, Settings,
  Profile, Help. Board-scoped destinations (`advisors,meet,sources,records,people,activity`) require `?board=<ownedBoardA>` (App filters them board-free, `App.tsx:641-648,5731`); board-free tabs use `#/seg`. Hash arrival + board context + visible heading/section + owned entity are asserted per destination; back/forward assert the same. All eleven are visited; board context is restored via an owned board route before the rail loop; direct URLs use WEB + "/" + boardHash(seg).
- Creation: rail button `+ Create new Advisor` opens
  `div.modal[role=dialog][aria-label="Create advisor"]` containing
  `section[aria-label="Create advisor"]` with `#cc-name`, `#cc-description`,
  `#cc-background`, `input[aria-label="Inspiration link N of 3"]`,
  `Create draft`, `Run research on this draft`, `#cc-research-status`
  (`Research status: working — <HumanStage>, <n>s elapsed (live server run,
  bounded)`), `Character paragraphs` fieldset with 3 textareas,
  per-field `Use compiled draft`, `Save draft changes`, `Close`. Fresh creation
  auto-starts research; every creation locator is dialog-scoped because
  `onCreated` selects the new entry and mounts the detail `CharacterEditor`
  behind the modal. Later edits use only the single detail editor after the
  dialog is closed (asserted).
- Research fixture (honest grounding): documentation/example-domain teaching
  advisor + `https://example.com/?doc-seed-<run>` seed URL, mirroring the
  positive fetched baseline in backend `qa/character-presence-qa.mjs`
  (fetched:true evidence, dossier prompt carries the URL marker). Evidence AND
  dossier-prompt proof are both required; otherwise honest FAIL, never forced
  approval. The untouched quick second seed leaves `ResearchRequested=false`;
  completeness/research checks are conditional on that flag, so missing
  research is not an attach/approval blocker for it (completeness gate +
  canonical readback prove it instead).
- Canonical readback: `GET /api/roster?accountId=` rows `{entry, ...}` with
  exact-ID entry unwrap (the App `resolveCanonicalEntry` wrapper);
  `entry.profileJson` carries the three behavior paragraphs. `GET
  /api/roster/{id}/research` carries research state/version/draftProfile only.
- Meeting: `.composer-bar` textarea + `button.primary` (send enabled when a
  draft + loaded meeting exist); `QA-SLEEP:6000` rides in the lead content so
  the fake run holds transient states while the real per-advisor poll samples.
  Statuses `Sending message...` / `Requesting advisor responses...` /
  `Responses complete.` Exactly one `[aria-label="Meeting and advisor
  controls"]` area and one `.composer-bar`.
- Search: `ConversationSearchField` input `Search messages` directly above `.chatscroll[aria-label="Conversation messages"]` (`conversation-controls.tsx`, `App.tsx:8151-8152`); position is proven against the chatscroll, never a standalone Messages heading. Settings: EXACT `Meeting settings` button opening native `dialog.conv-settings` + `section[aria-label="Meeting settings"]` with visible `Decisions & evidence`; open state (`isVisible` + `dialog.open`) is required before Escape, and actual dismissal after. A global `/settings/i` first-match is forbidden.
- Presence rail: `section.meet-participants` / `ul.mp-rail[aria-label="Participant activity"]` / `li.mp-seat.act-<state>` with `.mp-name` (overridden board lead `Board Own <run>` on board A per `App.tsx:4486`, boardRole per advisor, `Secretary`), seat-local `.mp-badge` (`Not in this meeting` only on the excluded Tide Watcher seat), `img[alt="Portrait of <name>"]` per accepted portrait with distinct PNG bytes and lazy-load wait, `is-sec` Secretary seat. Exactly 4 seats are required; extra/duplicate seats fail. The rail shows boardRole, so seat assertions use boardRole, never roster entry names.
- Activity: RAW backend states validated against the raw contract only; rendered `act-*` classes against the mapped UI vocabulary (`meeting-activity.ts` map, `meeting-participants.tsx` labels); mapping cross-checked per state. A working raw state for the owned participant plus its corresponding rendered badge are both required (not just eventual publication). Error/bid-decline/abstain/no-responder scenarios are exercised via dedicated short meetings (`QA-ABSTAIN`/`QA-NO`/`QA-REPLYERR`/excluded).
- Secretary: `secretary:`-prefixed composer input creates exactly one new request correlated by Question/InputText run marker (`completed` + `noteId`); the integrated fake returns structured JSON echoing the marker (standard fake returns plain text and cannot satisfy `Secretary.cs`); single-request readback proves persisted provisional `secretary-note`/`secretary-briefing` body containing the marker; the tray (`Secretary provisional notes`) is opened and the exact note/request verified; `GET notes?kind=direction` shape is validated with a provisional positive control, then zero non-provisional direction notes proves no decision.
- Rerun proof: CURRENT canonical markers (fresh collection) correlated to the exact owned `YOUR TURN` contribution prompt on the `chat` path (advisor bids/replies use `CompleteAsync` -> `/chat/completions`, `Endpoints.cs:1343,1430`, `ModelGateway.cs:748`; `responses` is research only), requiring current markers plus no stale-marker leak, plus the rerun actually publishing its expected contribution. Live mode has no
  prompt log: reported as explicit `promptlog-live-unproved` (fails closed),
  never a generic-nonempty pass.
- Roster chat: REAL `RosterChatPanel` UI (`div[data-roster-chat]`, `Chat with
  this advisor`, board-free note, `Message <advisor>` box, `Send`, `[role=log]`
  reply), stateless against meeting messages.
- Profile tab fields use stable scoped `getByRole(textbox, /^<Label>(?:\\s|$)/)` inside
  `section[aria-label="Profile"]` (verified in `web/src/App.tsx` lead form; exact `getByLabel` stops matching after fill because textarea child text joins the accessible name):
  `Name`, `Background`, `Subjects already familiar`,
  `Subjects needing simpler explanation`, `Communication preferences`, saved
  via the exact scoped `Save profile` button. Before filling, the script
  awaits real UI/response barriers: the Profile section + heading mounted,
  the lookup-settled status (`No saved profile yet.` or
  `Saved profile loaded.`), and the scoped Name box present AND enabled
  (fields stay disabled until the current profile is confirmed). Each field
  must match exactly once, be enabled, and read back the filled value; any
  failure captures an artifact (scoped DOM snippet + recent failed-response /
  page-error summary, screenshot to the OS temp dir, no token or private
  values) and FAILs loudly naming the assumption. Frontend mount WIP is
  reported with that artifact, never worked around via HTTP-only profile
  writes or generic first-match fills. Stable scoped `getByRole(textbox, prefix)` is used because textarea child text becomes part of the accessible label after fill (exact `getByLabel` stops matching); single fill + immediate readback proves the value (the App preserves typed values, no refill loops claiming reverts).

## Verified HTTP contracts used

- `POST /api/auth/register`, `GET /api/auth/me` (Bearer).
- `GET/POST /api/profile` (404 before save; versioned saves; board isolation).
- `POST /api/boards` -> 201 `{id}`; `GET/POST /api/boards/{b}/lead`.
- `POST /api/roster/quick` -> 201 (quick seed: `ResearchRequested=false`);
  `GET /api/roster?accountId=` canonical wrapper; `PUT/GET /api/roster/{id}` +
  `/research` + `/completeness` (`stage` done requires owned fetched evidence).
- Portrait: `POST /api/roster/{id}/image/upload` (multipart `file`) -> 201,
  `GET .../images`, `POST /api/images/{img}/review {decision:accept}` -> 200.
- Attach: `POST /api/roster/{id}/copy {boardId, boardRole}` -> 201, duplicate
  -> 409; `POST /api/boards/{b}/advisors/{a}/approve` -> 200;
  `.../sync-roster` -> 200; `GET /api/boards/{b}/advisors` canonical list.
- Meetings: `POST /api/boards/{b}/meetings` -> 201;
  `GET /api/boards/{b}/meetings/{m}` (scoped unwrapped detail, brief +
  `participantIdsJson` exact set); `PATCH /api/meetings/{m}` participants;
  `POST .../run {}` -> 200; `GET .../messages?take=100`; `GET .../activity`
  (raw states); `GET .../secretary/requests` (+`/{reqId}` correlated note);
  `GET .../notes?kind=direction` (no-decision proof).
- Roster chat: `POST /api/roster/{id}/chat` via panel UI; stateless (never
  meeting messages); panel contract is board-free by construction.

## Budgets / honesty rules

- Research bounded 185s, run bounded 150s, overall 420s ENFORCED via shared deadline (`DEADLINE_MS` = start+420s-30s reserve; `assertDeadline` before sleeps/waits/requests; overrun throws into `finally` cleanup; intervals cleared and outstanding `AbortController` requests bound by `REQ_TIMEOUT`; the browser context always closes; a single `process.exit` runs only after cleanup). `waitForFunction` uses `(fn, undefined, {timeout})` (3-arg form); the 150s run and 90s secretary limits are real timeouts.
- Real provider/unsupported research is an honest FAIL, never forced approval.
- No `page.route` stubs, no forced-approval, no datastore hacks, no global
  cleanup/backup/restore/reconcile/reset, no private-key reads, no token or
  raw JSON in logs. Failed setup aborts (throws to cleanup, exit 2), never
  cascades false-pass.
- Expected 404s are narrowly scoped to PRE-SAVE `/api/profile` absence only (`profileSavedAt===0`); any later 404 is unexplained. Transport `requestfailed` events are tracked and fail the run. Failed setup/prerequisites abort immediately (throw to cleanup, exit 2), never cascade.
- Live `:15180` mode: prompt-log proof is an explicit UNPROVED failure, and
  the dossier grounding falls back to fetched-evidence proof only; both are
  labeled as such in output.
- Remaining limits after this QA: real-provider wording/timing and any
  physical-mic path are NOT covered (no audio assertions).
- Owned QA account/boards/roster/meetings are intentionally left for forensics
  (exact-ID scope only; no row cleanup by design). Browser/context cleanup is
  unconditional.
