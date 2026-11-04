# Advisor Integrated QA — contract notes (Muse-authored)

Companion to `qa/advisor-integrated-qa.mjs`. Read this before executing.
No App/server changes were made for this QA; only this QA file + this doc exist.

## What primary provides (not this author)

- Final coherent root with the QA file ported to `qa/advisor-integrated-qa.mjs`.
- Running stack at `QA_WEB=http://127.0.0.1:15300` (compiled web/ copied as the
  published API wwwroot, fake-backed) or `:15180` (owned compiled Docker, real
  provider, needs `ALLOW_LIVE_PROVIDER=1`).
- Fake prompt log at `QA_FAKE=http://127.0.0.1:15302` (standard
  `qa/fake-provider.mjs`: `GET /__log`, `DELETE /__log`, full-prompt capture,
  `COMPILE-CHARACTER-PARAGRAPHS` / `YOUR TURN` / `Reply with exactly YES or NO`
  markers, `QA-SLEEP-*` pacing). Required on the 15300 path.

## Assumed UI contracts (verified in source, not invented)

- Auth bootstrap: `localStorage` keys `simceo-token` / `simceo-user`.
- Tabs via nav buttons: Boards, Roster, Board Advisors, Meetings, Profile;
  routes `#/profile`, `#/roster`, `#/meet?board=&meeting=`.
- CreateAdvisor: `section[aria-label="Create advisor"]`, `#cc-name`,
  `#cc-description`, `#cc-background`,
  `input[aria-label="Inspiration link N of 3"]`, `Create draft`,
  `Run research on this draft`, `#cc-research-status` (`Research status:`),
  `Character paragraphs` fieldset with 3 textareas, `Use compiled draft`,
  `Save draft changes`. Fresh creation auto-starts research.
- Meeting: `.composer-bar textarea` with
  `aria-label="Message. Press Enter to send, Shift and Enter for a new line."`,
  `.composer-bar button.primary`, statuses `Sending message...` /
  `Requesting advisor responses...` / `Responses complete.`, secretary prefix
  `secretary:` with `(provisional)` note.
- Activity vocabulary (only honest values): idle, queued,
  waiting-for-selection, considering, responding, waiting-for-publication,
  complete, abstained, waiting-for-clarification, failed, interrupted,
  excluded, needs-approval, pending. `pending` is a run-level wait, never
  approval.
- Profile tab fields were NOT text-verified in source (lead-form JSX labels
  unseen); the script fills by label/placeholder with
  name/background/familiar/simpler/communication patterns and FAILs loudly
  naming the assumption if absent. Frontend mount WIP is reported, not worked
  around.

## Verified HTTP contracts used

- `POST /api/auth/register`, `GET /api/auth/me` (Bearer).
- `GET/POST /api/profile` (404 before save; versioned saves; bob-isolation).
- `POST /api/boards` -> 201 `{id}`; `GET/POST /api/boards/{b}/lead`.
- `POST /api/roster/quick` -> 201; `GET /api/roster?accountId=`; `PUT/GET`
  `/api/roster/{id}` + `/research` (`stage` done requires evidenceCount>=1).
- Portrait: `POST /api/roster/{id}/image/upload` (multipart `file`) -> 201,
  `GET .../images`, `POST /api/images/{img}/review {decision:accept}` -> 200.
- Attach: `POST /api/roster/{id}/copy {boardId, boardRole}` -> 201, duplicate
  -> 409; `POST /api/boards/{b}/advisors/{a}/approve` -> 200;
  `.../sync-roster` -> 200; `GET /api/boards/{b}/advisors` canonical list.
- Meetings: `POST /api/boards/{b}/meetings` -> 201;
  `GET /api/boards/{b}/meetings/{m}` (unwrapped canonical detail);
  `PATCH /api/meetings/{m}` participants; `POST .../run {}` -> 200;
  `GET .../messages?take=100`; `GET .../activity`;
  `GET .../secretary/requests`.
- Roster chat: `POST /api/roster/{id}/chat {message, history?}` -> 200
  `{answer,...}`; stateless (never meeting messages).

## Budgets / honesty rules

- Research bounded 185s, run bounded 150s, overall 420s (all enforced).
- Real provider/unsupported research is an honest FAIL, never forced approval.
- No `page.route` stubs, no forced-approval, no datastore hacks, no global
  cleanup/backup/restore/reconcile/reset, no private-key reads, no token or
  raw JSON in logs. Failed setup aborts (exit 2), never cascades false-pass.
- Live `:15180` mode: prompt-log proof falls back to published-reply proof
  and is labeled as such in output.
- Remaining limits after this QA: real-provider wording/timing and any
  physical-mic path are NOT covered here (no audio assertions).
