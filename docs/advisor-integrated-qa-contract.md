# Advisor Integrated QA — contract notes (Muse-authored)

Companion to `qa/advisor-integrated-qa.mjs`. Read this before executing.
No App/server changes were made for this QA; only this QA file + this doc exist.
Corrected revision addressing every concrete finding of the be958dc review.
This author never executed the script (node --check only); primary executes it
against the actual compiled combined app. No runtime claims are made here.

## What primary provides (not this author)

- Final coherent root with the QA file ported to `qa/advisor-integrated-qa.mjs`.
- Running stack at `QA_WEB=http://127.0.0.1:15300` (compiled web/ copied as the
  published API wwwroot, fake-backed) or `:15180` (owned compiled Docker, real
  provider, needs `ALLOW_LIVE_PROVIDER=1`).
- Fake prompt log at `QA_FAKE=http://127.0.0.1:15302` (standard
  `qa/fake-provider.mjs`: `GET /__log`, full-prompt capture,
  `COMPILE-CHARACTER-PARAGRAPHS` / `YOUR TURN` / `Reply with exactly YES or NO`
  markers, `QA-SLEEP-*` pacing). Required on the 15300 path. The script NEVER
  issues a global prompt-log DELETE: it captures a baseline timestamp at setup
  and filters all prompt assertions to `t >= baseline` plus owned run markers.

## Assumed UI contracts (verified in source, not invented)

- Auth bootstrap: `localStorage` keys `simceo-token` / `simceo-user`, plus
  deterministic `simceo-account` seeded with the same account id used for all
  roster seeds and fresh-collection readbacks.
- Rail navigation: `nav.rail` buttons by exact name — Boards, Roster,
  Board Advisors, Meetings, Sources, Records, People, Activity, Settings,
  Profile, Help (route convention `#/seg`, board context kept, as in
  `qa/navigation.cjs`). All eleven are visited; no skipped destinations.
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
- Search: labelled textbox `Search messages` (role textbox, never `searchbox`),
  positioned above Messages. Settings: EXACT `Meeting settings` button opening
  `section[aria-label="Meeting settings"]` with `Decisions & evidence` inside;
  native Escape dismissal (cancel path). A global `/settings/i` first-match is
  forbidden (it can hit navigation Settings and leave the composer).
- Presence rail: `section.meet-participants` /
  `ul.mp-rail[aria-label="Participant activity"]` / `li.mp-seat.act-<state>`
  with `.mp-name` (lead name, boardRole per advisor, `Secretary`), `.mp-badge`
  (`Not in this meeting` for excluded), `img[alt="Portrait of <name>"]` per
  accepted portrait, `is-sec` Secretary seat. The rail shows boardRole, so
  seat assertions use boardRole, never roster entry names.
- Activity: RAW backend states (`awaiting-selection`,
  `awaiting-publication`, ...) validated against the raw contract;
  rendered rail `act-*` classes validated against the mapped UI vocabulary
  (`waiting-for-selection`, `waiting-for-publication`, ...); mapping
  cross-checked per state. Raw and mapped are never mixed.
- Secretary: `secretary:`-prefixed composer input creates exactly one new
  request correlated by Question/InputText run marker (`completed` + `noteId`);
  single-request readback proves persisted provisional `secretary-note` /
  `secretary-briefing` body containing the marker; `GET notes?kind=direction`
  must show zero non-provisional direction notes (no decision).
- Rerun proof: CURRENT canonical markers (fresh collection) correlated to the
  same fake `responses` prompt as the owned advisor contribution (boardRole,
  roster name, or advisor id) with zero stale-marker leak. Live mode has no
  prompt log: reported as explicit `promptlog-live-unproved` (fails closed),
  never a generic-nonempty pass.
- Roster chat: REAL `RosterChatPanel` UI (`div[data-roster-chat]`, `Chat with
  this advisor`, board-free note, `Message <advisor>` box, `Send`, `[role=log]`
  reply), stateless against meeting messages.
- Profile tab fields were matched by label/placeholder with
  name/background/familiar/simpler/communication patterns (App lead-form
  labels verified) and FAIL loudly naming the assumption if absent. Frontend
  mount WIP is reported, not worked around.

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

- Research bounded 185s, run bounded 150s, overall 420s ENFORCED (overrun
  throws into `finally` cleanup; the browser context always closes; a single
  `process.exit` runs only after cleanup).
- Real provider/unsupported research is an honest FAIL, never forced approval.
- No `page.route` stubs, no forced-approval, no datastore hacks, no global
  cleanup/backup/restore/reconcile/reset, no private-key reads, no token or
  raw JSON in logs. Failed setup aborts (throws to cleanup, exit 2), never
  cascades false-pass.
- Expected 404s (pre-save `/api/profile` absence) are narrowly classified;
  all other page errors / failed responses fail the run.
- Live `:15180` mode: prompt-log proof is an explicit UNPROVED failure, and
  the dossier grounding falls back to fetched-evidence proof only; both are
  labeled as such in output.
- Remaining limits after this QA: real-provider wording/timing and any
  physical-mic path are NOT covered (no audio assertions).
- Owned QA account/boards/roster/meetings are intentionally left for forensics
  (exact-ID scope only; no row cleanup by design). Browser/context cleanup is
  unconditional.
