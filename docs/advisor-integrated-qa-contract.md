# Advisor Integrated QA — contract notes (Muse-authored)

Companion to `qa/advisor-integrated-qa.mjs`. Read this before executing.
No App/server changes were made for this QA; only this QA file + this doc exist.
Closure revision addressing all 21 dispositions of the fb43bbc final review (frontend ec2a4ca / server dbb; immutable actual source in .tmp/advisor-release read-only; no App/server edits; fake http import cb5fad4 preserved). Runtime closure d896a83 (primary 107 PASS / 4 FAIL 53s: meeting-rail excludedSeatLocal false + portrait count 0, roster-chat panel missing after re-edit). No App/backend/fake edits (frozen); this QA-only repair adds causal barriers + diagnostics, never force-pass. Prior 21 dispositions preserved. Locator.waitForFunction 3-arg form is supported (local PW 1.64). Program lead response generation / restoreEpochId / rev confirmed by primary. Monolith SIMPLIFIED (duplicative backend negative scenarios removed with mapping, no separate 500-line patch framework). Primary runs actual runtime (20 PASS / 2 FAIL baseline: research-progress-live-visible stops at setup; this revision holds research running via QA-SLEEP-R:6000 and strict visible correlation).
This author never executed the script (node --check only); primary executes it
against the actual compiled combined app. No runtime claims are made here. Exit 0=PASS, 1=FAIL (assertion), 2=FATAL/setup (no raw JSON or tokens in logs; redacted summaries only).

## What primary provides (not this author)

- Final coherent root with the QA file ported to `qa/advisor-integrated-qa.mjs`.
- Running stack at `QA_WEB=http://127.0.0.1:15300` (compiled web/ copied as the
  published API wwwroot, fake-backed) or `:15180` (owned compiled Docker, real
  provider, needs `ALLOW_LIVE_PROVIDER=1`).
- Fake prompt log at `QA_FAKE=http://127.0.0.1:15302` (dedicated
  `qa/advisor-integrated-fake.mjs`: deterministic `COMPILE-CHARACTER-PARAGRAPHS` echoing the researched name, `YOUR TURN`/bid pacing, structured secretary JSON echoing the owned run marker, `QA-SLEEP-*`/`QA-SLEEP-R:*` pacing (existing marker reused; research description/background carry `[QA-SLEEP-R:6000]` so the fake /responses hold running while the UI samples visible progress; no fake logic change needed); reuses research/chat schema from `qa/fake-provider.mjs` and secretary schema from `qa/secretary-fake.mjs`). Required in native 15300 mode; live 15180 mode has no prompt log (explicit UNPROVED path, fails closed). The script NEVER issues a global prompt-log DELETE: it captures a baseline timestamp at setup and filters all prompt assertions to `t >= baseline` plus owned run markers. Mode is selected explicitly by `ALLOW_LIVE_PROVIDER` (`native` vs `live`), never by log availability. Native request bodies are exact: PATCH brief is QUESTION.slice(0,800) + CAS fields without advisor ID; run body is {policy,prompt,evidenceSupported,leadVersion}; lead POST content is exactly QUESTION. Secretary completion requires completed + noteId under one deadline with correlated provisional note; direction rows are validated before the no-decision proof. Debug scanner uses independent GUID/string/object/array/primitive fixtures plus a clean negative and hidden-attribute exclusion; creation is scanned while open with visible form values.

## Assumed UI contracts (verified in source, not invented)

- Auth bootstrap: `localStorage` keys `simceo-token` / `simceo-user`, plus
  deterministic `simceo-account` seeded with the same account id used for all
  roster seeds and fresh-collection readbacks.
- Rail navigation: `nav.rail` buttons by exact name — Boards, Roster,
  Board Advisors, Meetings, Sources, Records, People, Activity, Settings,
  Profile, Help, plus wizard (12 total; dedicated Nav 247/2 source 941 second-wizard-fix rerun pending covers deep/back-forward/mobile). Board-scoped destinations (`advisors,meet,sources,records,people,activity`) require `?board=<ownedBoardA>` (App filters them board-free, `App.tsx:641-648,5731`); board-free tabs use `#/seg`. Each destination asserts SCOPED section+heading+owned entity (never brand-first/global body length): Boards/`Boards`, My Advisor Roster, This Board\'s Advisors, Meetings and conversation, Resources and Inbox/`Resources and Inbox`, Records/`Records`, People/`People`, Activity and Usage/`Activity and Usage`, Settings/`Settings`, Profile/`Profile`, Help, New-board wizard/`Create a board`; honest empty states accepted where scoped. Direct routes and history use the SAME predicates via assertDest; board context restored via owned board route before rail loop; direct URLs use WEB + "/" + boardHash(seg). No Nav-matrix re-implementation here.
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
- Presence rail: `section.meet-participants` / `ul.mp-rail[aria-label="Participant activity"]` / `li.mp-seat.act-<state>` with `.mp-name` (overridden board lead `Board Own <run>` on board A per `App.tsx:4486`, boardRole per advisor, `Secretary`), seat-local `.mp-badge` (`Not in this meeting` only on the excluded Tide Watcher seat), `img[alt="Portrait of <name>"]` per accepted portrait with distinct PNG bytes and lazy-load wait, after documented reload-refetch (PATCH response + exact GET set, then goto + explicit page.reload + meeting-detail/advisors/activity refetch barriers, then waitForFunction exact 4 seats + excluded seat + 2 decoded portraits, never immediate count; HTTP accepted-image + boardRole display-name barriers first), `is-sec` Secretary seat. Exactly 4 seats are required; extra/duplicate seats fail. The rail shows boardRole, so seat assertions use boardRole, never roster entry names.
- Activity: RAW backend states validated against the raw contract only; rendered `act-*` classes against the mapped UI vocabulary (`meeting-activity.ts` map, `meeting-participants.tsx` labels); mapping cross-checked per state. A working raw state for the owned participant plus its corresponding rendered badge are both required (not just eventual publication). Error/bid-decline/abstain/no-responder scenarios are exercised via dedicated short meetings (`QA-ABSTAIN`/`QA-NO`/`QA-REPLYERR`/excluded).
- Secretary: `secretary:`-prefixed composer input creates exactly one new request correlated by Question/InputText run marker (`completed` + `noteId`); the integrated fake returns structured JSON echoing the marker (standard fake returns plain text and cannot satisfy `Secretary.cs`); single-request readback proves persisted provisional `secretary-note`/`secretary-briefing` body containing the marker; the tray (`Secretary provisional notes`) is opened and the exact note/request verified; `GET notes?kind=direction` shape is validated with a provisional positive control, then zero non-provisional direction notes proves no decision.
- Rerun proof: CURRENT canonical markers (fresh collection) correlated to the exact owned `YOUR TURN` contribution prompt on the `chat` path (advisor bids/replies use `CompleteAsync` -> `/chat/completions`, `Endpoints.cs:1343,1430`, `ModelGateway.cs:748`; `responses` is research only), requiring current markers plus no stale-marker leak, plus the rerun actually publishing its expected contribution. Live mode has no
  prompt log: reported as explicit `promptlog-live-unproved` (fails closed),
  never a generic-nonempty pass.
- Roster chat: REAL `RosterChatPanel` UI (`div[data-roster-chat]`, `Chat with
  this advisor`, board-free note, `Message <advisor>` box, `Send`, `[role=log]`
  reply), stateless against meeting messages. Roster selection proves SAME exact entry via fresh-collection identity (GET roster?accountId holds rosterId with same name/version + canonical version check), exact row-name match, unswallowed click, aria-current/active proof, then panel for that exact rosterId with full diagnostics; never HTTP-only chat.
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


## Coverage manifest (exact requirement -> actual suite/evidence; remaining UNPROVEN)

Core integration (this monolith proves; primary must rerun to PASS):
- profile inherit/edit (default->board inherit, explicit override, second save, version pins) -> stepProfile HTTP+UI; evidence: `boards-inherit-default`, `explicit-override-ok`, `override-version-stable` (strict positive-integer versions).
- real UI new advisor research/live progress/3 paras/final tweaks -> stepCreateAdvisor dialog-scoped; evidence: `research-progress-live-visible` (strict raw bool + known stage + visible + bounded resample + QA-SLEEP-R:6000), `research-evidence-owned-fetched`, `research-dossier-prompt-owned`, `research-compiled-exact`, `research-compiled-3paras`, `owner-markers-roundtrip` (full JSON raw strings).
- accepted portraits + canonical attach/excluded seat -> stepPortraitAttach/SecondMember; evidence: `portrait-upload-201`, `portrait-accept-200`, `attach-first-201`, `duplicate-attach-409`, `approve-first-200`, structured `{ok}` portrait bytes distinct, `board-advisors-resolve-roster`.
- send once/reply+progress + Secretary exact provisional -> stepMeeting; evidence: `send-lead-once`/`autoinit-patch-once`/`run-once` (paired identity + response/order boundary + actual CAS values), `meeting-progress-visible`/`terminal-complete`, `activity-paired-working` (serial paced OWN-advisor raw+visible class AND human label), Secretary `secretary-post-captured`/`request-correlated` (EXACT POST requestId/nonce/StripPrefix InputText) + `completedGET same ID` + provisional exact body + FULL-note tray with expand + direction snapshot UNCHANGED.
- canonical re-edit -> meeting prompt current full paras -> stepReeditRerun; evidence: `canonical-reopen-eq-canonical` (NOT draftProfile; backend preserves draft), `canonical-markers-roundtrip` (full raw JSON + no old markers), rerun lead POSTs unique `RERUN-` discriminator + ordinary question ONLY (no paragraphs in lead; paragraphs must arrive via canonical behavior section, ContextCurator) BEFORE run + `promptlog-current-markers-owned` (exact owned YOURTURN + current FULL paras, stale scoped to same marked contribution, no leak).
- roster direct chat stateless -> stepRosterChatUI; evidence: EXACT `message` key + 200 `answer/rosterId/version/stored` + UI==answer + full Sequence/ParentSequence/Status/Stance/Content snapshots unchanged (never Id).
- real API-backed destination routing/no JSON visible -> stepNavigation + scanDebug; evidence: 12 scoped `nav-dest-*` + direct + back/forward via same `assertDest`, `debug-clean-*` (same detector/collector, visible controls, hidden ignored, FATAL on collector failure, body nonempty).

Mapped OUT of this monolith (NOT claimed passed here; primary runs focused suites):
- abstain/bid-decline/reply-error participant-state shapes REMOVED by design (mapped-unexecuted here, no assertions claimed): no-responder stubbed UI terminal/retry -> qa/meeting-send-pipeline-qa.mjs:402; bid-decline yields + zero reply-error publications -> qa/http-qa.mjs:495; actual bid-decline activity assertions + T6 provider/reply errors -> qa/meeting-activity-qa.mjs:316. wiki-pg-qa.mjs and usage-activity-browser.mjs do NOT replace participant-state assertions; lifecycle suite does not supply abstained/failed seat-label checks; QA-ABSTAIN fake support is not an executed test. Bid decline produces bid-declined (provider-error is provider failure).
- Nav deep/back-forward/mobile full matrix -> dedicated Nav 247/2 (source 941 latest second wizard fix rerun pending) covers all 12 tabs/deep/back-forward/mobile.

Remaining UNPROVEN (explicit; no weakened core integration, no dropped failures to get green):
- Native research run timing/wording beyond the fake (real provider) and physical-mic paths (no audio assertions).
- Live `:15180` prompt-log paths (`promptlog-live-unproved` fails closed).
- Focused-suite reruns themselves (backend 119/29 PG/activity, Send 142, lifecycle, Nav 247/2) must still PASS under primary.
- This author executed ONLY `node --check` (no services/browser/HTTP/QA execution per scope); primary must establish exact compiled frontend/backend/QA/fake manifest and rerun this file through final assertions including delayed/error paths and deadline cleanup, plus dedicated review.

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

## Muse runtime closure 8b4 follow-up (QA/doc only, no product edits)
- Base b852aed plus 8b4a4da detector init repair preserved (det before use, node check passes, playwright-core 1.64.1).
- Primary runtime 109 PASS 4 FAIL 122s: excluded seat now PASS, portraits NONE on both seats. Primary diagnosed product bug in App usePresencePortraits which bails when copyImageProvenance is empty despite accepted roster image.
  Dedicated production work in .tmp/advisor-presence-default-portrait repairs readonly resolution coherent with backend ReviewedPortraitFingerprint. QA intentionally not weakened to force image or select, portraits remain strict FAIL until product lands, reported here as known pending production defect.
- Roster chat panelCount 178 remains highly suspicious because source has exactly one RosterChatPanel mount (roster-chat.tsx data-roster-chat, App.tsx single mount with key).
  QA now collects causal native evidence on panel missing without weakening: Playwright exact count with id plus bare count, native document.querySelectorAll bare count plus exact filter count, total divs, actual location hash URL, first three data-roster-chat attribute prefixes plus closest section aside main heading, owned row aria-current plus fresh collection identity, plus OS tmp screenshot limited to owned QA synthetic content.
  No tokens or keys or storage dump, no HTTP only chat replacement, still FATAL on missing panel.
- Service verification before any mutation: 15300 TCP connect false and HTTP refused (API down), 15302 TCP true and GET __log 200 (fake up).
  No services launched or stopped, no source product edits, no human ports, no PG Docker env keys real provider memory global kills. Loopback targets verified as 127.0.0.1 15300 and 15302 only.
  Own actual QA run is blocked pending primary restart of compiled 15300 server, no owned accounts created in this follow-up. Node check passes. Primary reruns plus dedicated review still required for full d896 closure including paired send CAS, collector detector, labels, abstain failed seats, secretary nonce, rerun ordinary question plus paras, roster version paired FULL snapshot with CreatedAt, deadlines drain abort cleanup.

## Muse runtime closure 0221: roster 178 causal resolution (QA/doc only, no product edits)
- Own live runs on primary-owned 15300/15302 loopback only (own accounts, own headless Edge, no services control, no human ports, no PG/Docker/env/keys). 0203 run: 137 PASS 4 FAIL. 0209 run: 143 PASS 4 FAIL through nav-people. 0221 run: 115 PASS 6 FAIL with Enter-submit forensics.
- Roster panelCount 178/181 is ACTUAL UI state, not a fixture selector bug. Four-way agreement on every run: Playwright bare count, Playwright exact-with-id count, Playwright :visible count, native querySelectorAll bare count, native exact filter count, native rect-plus-visibility count. waitFor on first() succeeds (waitErr none). Compiled bundle contains exactly one data-roster-chat writer and one Chat heading (read-only asset check), matching single mount in source.
- Send is unclickable AND unsendable on every probed clone. First-visible and last-visible panels both fail click with Timeout 8000ms. Native hit-test at the pinned button center reports hit equal self (topmost at its own point, not covered) with disabled true. Fill resolves without error yet React msg state never sticks, so the shipped Enter-to-send affordance fires send with empty text and no-ops: zero roster-chat requests reach the fake (paired false, answerLen 0). First of 178 and last of 178 behave identically.
- QA response, all in owned QA files only. Panel resolution now requires exactly one visible panel for the mounted gate, records hidden multiplicity as strict FAIL roster-chat-panel-singular, scopes every later roster interaction to one pinned element handle (fill, click, Enter fallback, scoped readback), and keeps FATAL with no HTTP bypass when no honest send is possible. No product edits. No weakened assertion: strict request pairing, exact message key, UI equals answer, full snapshot statelessness, navigation scoping all unchanged.
- d896 closure status after own runs. Proven: paired send CAS with response-before-next-request, shared collector plus detector DOM positive and hidden controls, strict visible working human labels, activity paired working plus mapped badges, secretary exact nonce plus provisional plus no-decision, canonical rerun ordinary question plus all paras in behavior section, roster version plus paired FULL MessageSnapshot shape with CreatedAt, records rail plus meeting-scoped Prepare draft, eleven of twelve rail destinations with debug pairs, deadlines and budgets enforced with drain and abort and browser cleanup.
- Explicit exceptions pending separate production author (source frozen ec2 and dbb). One: portraits NONE because usePresencePortraits bails on empty copyImageProvenance despite accepted roster image (dedicated fix in .tmp/advisor-presence-default-portrait). Two: 178 duplicate RosterChatPanel renders blocking honest GUI send, with native proof above. Three: items downstream of roster send (roster request pairing, UI equals answer, stateless snapshot, settings onward rails, direct routes, back-forward, 404 exact, no-unexpected) cannot pass until the send gate has a working product panel. Primary reruns plus dedicated production review still required.
## Muse OWN-stack closure 562 (QA/doc only, no product edits)
- Source frozen ef20f5d (merge 5623fe1: production 20e30d9+4a66bdd activity-inside-ROOT, 9545420 sibling keys, efdf32b portrait ECE, 650ad3b sibling QA hardening, sigsub resolve). No App/server edits in this closure; QA+helper+contract only.
- OWN stack: native API 127.0.0.1:15396 + integrated fake 127.0.0.1:15398, QAONLY key forced, USE_POSTGRES=0 + PG/Kestrel env removed, publish rebuilt from ef20f5d (web dist + dotnet publish), fresh fake required at boot, exact origins + redirect manual, refuse occupied ports, no detached/unref, PID-bound stop with 15s drain. Ports verified free after stop; pidfile removed.
- Full live runs on OWN stack with own headless Edge. First OWN run: 154 PASS 2 FAIL (nav-dest-profile entity missed because assertDest used innerText only, missing visible input values; cascade FATAL). QA fix (owned files only): scoped assertDest collector now includes visible input values, still requiring exact owned entity (no weakening, no empty-state bypass beyond existing records/sources).
- Second OWN run: ADVISOR INTEGRATED QA PASS assertions-pass=180 assertions-fail=0. Covers unified creation visible grounded research 3 paras, canonical roster updates via CANONICAL section, wizard progress/error/CAS, approved portraits + Secretary/excluded seat, activity/responding/overlap/CAS pairing, Secretary provisional + rerun, roster-only STRICT ONE panel real POST/nonce/body/answer UI + FULL snapshot stateless CreatedAt, 12 rail destinations/direct/back-forward/404/settings, UI collector positive+negative controls, deadlines/drains. No first-clone workarounds, no HTTP send bypass, no force-pass. Full log at own-15396-15398/logs/qa-full-run2.log (136s).
- Preserved: FULL 21-disposition contract, meaningful WIP collector/CAS strictness, singular roster panel gate (954 fix verified live), portrait ECE (now PASS live), SourceUI/guest563, SigSub helper. Remaining limits: real-provider wording/timing, physical mic (no audio), live 15180 UNPROVED path (fails closed), focused-suite reruns still required under primary. Primary full inspection + dedicated review + rerun still required before any deploy.
