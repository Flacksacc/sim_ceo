# Frontend integration (central owner)

Worktree: `.tmp/feedback-integration` (this checkout). All changes are under
`web/` plus behavioral QA under `qa/`. No server code is edited; no main
checkout, human ports (5173/5080), CDP (9333), Docker, env, or user data is
touched. Source-only worker: no services started/stopped by hand, no global
process cleanup; the browser proof spawns and reaps only its own children.

## What is mounted in web/src/App.tsx

- Profile: accepted account-default editor (GET/POST /api/profile, GLOBAL board-free Save, roomy textareas, default communication preferences) with immutable CAS base/version/origin/gate, frozen offline B->C, conflict freeze until confirmed Reload, own same-identity Apply retires op guard + reloading false, and no stale UI writes. Editor/cache ownership is identity-scoped (epoch/token/user) so one account's edits never hydrate or submit as another; the base advances after the editor's own save even when newer typing is kept. No provenance/raw-id/version-number leaks in the UI.
- One advisor flow: manual and AI-guided buttons replaced by one
  `CreateAdvisor` dialog (brief -> optional grounded research -> editable
  draft -> explicit save). Research status reflects real server results only.
- Roster links: board advisors show canonical roster authority only
  (`BoardAdvisorLinkPanel`, `RosterLinkBadge`); no duplicate editable dossier
  on the board. Board role/participation and approval-state display kept.
- Roster-only chat: `RosterChatPanel` mounts only for the selected roster
  advisor, keyed by roster id with the roster version watched: replies
  retire on character-version change without losing the composer draft,
  history sent is preceding-only, retry never duplicates the turn.
- Meeting presence: `MeetingParticipants` (portrait component lane,
  integrated from its committed branch) renders EVERY board seat plus the
  Secretary as an always-visible rail beside the conversation - independent
  of the collapsible Meeting context panel, horizontal strip on narrow
  screens. Portraits come from the existing authorized accepted-image path
  (`ImageProvenance` kind:image-id resolved through authed blob URLs);
  absent portraits show initials, the secretary a neutral fallback. Activity
  is honest: needs-approval / excluded / idle from owned membership data;
  approval is never shown as responding and no global pending flag is
  consulted. A snapshot map seam accepts future authorized run states
  (queued/considering/responding/complete/abstained/interrupted/waiting)
  without letting non-members show as responding.
- Decisions & evidence in Meeting settings: the Discussion-area tabs and
  the right-pane Decisions tab are gone. Key takeaways (incl. secretary
  provisional notes with review/approval/history), Options, Decision state,
  and the cited-evidence card now render as children of
  `MeetingSettingsDialog` under a Decisions & evidence section, with the
  same handlers, permissions, and navigation (Open records / Open sources
  close the dialog first, then navigate). The right pane keeps the presence
  rail plus a collapsible brief card.
- Conversation: one lifecycle group (New meeting, Meeting settings,
  Pause/Resume/End discussion) and ONE explicit `Request advisor responses`
  action. Request gating is actual run state (AwaitingBrief/Active) plus
  brief plus discuss access - Paused/WrappingUp/AwaitingRecordDecision stay
  disabled with no model call. New meeting and settings saves never call
  the model. Search sits directly above messages and is guarded by
  identity/board/meeting/query generation. The last-participant uncheck is
  locked with human help (empty still means everyone via Include everyone).
- Human-readable UI: raw identifiers/GUIDs/JSON/debug removed from meeting
  surfaces (takeaways, availability/recall references, history, grants,
  invites, My meetings); export/download keep human labels. Friendly errors
  carry a Copy-error-report action; technical text is never shown.
  User/advisor message content is never altered.
- CharacterEditor seam: a marked mount point beside the roster chat waits
  for the canonical 3-paragraph editor contract (separate lane);
  advisor-creation.tsx is untouched in this pass.

## Verification (all green on the owned stack, 2026-11-04)

- `npx tsc --noEmit` in `web/`: clean.
- `npx vite build` in `web/`: clean.
- `node qa/frontend-integration-behavioral.cjs`: 82/82 rendered-behavior
  checks pass (real components via react-dom/server - presence mapping and
  rail, settings children, locks, record codec, friendly errors). No static
  file/string checks.
- `node qa/frontend-interaction-proof.cjs`: 28/28 interaction scenarios
  pass on the owned stack only (API :5181, web :5191, fake model :5259,
  fresh Edge profile, fresh in-memory DB per run). Profile save / stale-
  base conflict / typing-survives-refetch / identity-switch reset / base-
  advance; first-meeting shell with zero model calls; settings save +
  meeting-identity binding + focus/Escape/restore; participant exclusion
  persistence + last-uncheck lock + explicit include-everyone; presence
  rail always visible with every seat + Secretary, needs-approval and
  exclusion states honest, independent of context collapse; request gating
  incl. paused with draft preserved and zero model calls; explicit request
  -> advisor replies; search results guarded by meeting/identity/generation;
  settings/people/records expanded surfaces free of raw identifiers;
  records lossless structured revision with stable ids + unknown metadata;
   roster chat draft isolation, preceding-only history, retry without
   duplicates, friendly failure, pending retired on character-version
   change; portraits resolve accepted-only selected-image metadata first
   (pending/rejected/revoked never render; raw blob identity fixed so
   accepted bytes load and decode) with same-page accept/reject/re-accept
   and no reload; bearer A/B on one browser keep roster drafts private per
   effective identity. Report lands in `qa/proof/last-run.json`. The script supports an
  ONLY= substring filter for focused reruns (skipped entries carry a
  distinct skipped status, never pass:true; zero executed scenarios fail the
  run) and fails fast with cleanup when setup fails.
- `qa/proof/shots/` (gitignored) holds fixture-only screenshots captured
  in-run: presence rail at 1440px light and 390px dark plus the settings
  dialog placement, asserted in-run (seats, loaded portraits vs initials
  fallbacks, DOM order, sticky rail, no horizontal overflow).

## Release status: profile accepted port landed, remaining gates open

Accepted Profile UI (MAIN 5c2a32e / candidate 81fc7bd, 101 browser + 15 HTTP PASS) is ported here via semantic merge: direct GET/POST /api/profile with immutable CAS base/version/origin/gate, frozen offline B->C, conflict freeze until confirmed Reload, own same-identity Apply retires op guard + reloading false, no stale UI writes, larger paragraphs + default comm prefs + GLOBAL save without board, explicit overrides preserved. Isolated QA PROFILE shim remains explicit until joined integration; no real API integration is claimed from the shim. Primary will run the 101 shared profile browser against this App + real backend later.

Meeting layout closure is in this pass: ONE meeting collection/navigation list (outer mail listpanel hidden for Meetings; inner Search/State/agenda kept as a single collapsible <details> with all navigation/permissions) reclaims ~300px for the conversation on desktop; the selector starts collapsed on 390px viewports (desktop starts open) so the toolbar, first messages, and composer are visible on load, expanding on tap with filters/nav intact, and the member tray stays sticky with the composer static so toolbar/settings stay reachable. Decisions/Evidence stay inside Settings; lifecycle controls + search-above-messages preserved; no new features, no dual desktop panels, no unrelated restyling.

Portrait closure: accepted-only metadata revalidated on focus/visibility/advisor-query refresh clears a rejected blob even when the selection id is unchanged (raw epoch/token identity, never pending/other-entry, unique legacy8), proven by a dedicated two-tab QA (reject in B while A mounted, return to A with no reload, old blob gone, fallback kept).

Search closure: same-document A-held -> UI-navigate B without B search -> release A asserts no stale hits in B, plus a real positive B search, with no page.goto reload masking.

Visual closure: 1440 light/dark + 390 dark/light with settled animations (opacity 1), overflow/loaded-portrait/fallback assertions, desktop chat-width regain, and opaque-settings captures. Mobile toolbar/composer/message steps assert actual geometry (rect inside viewport below the sticky tray, elementFromPoint tap-center hit, readable text) with real tap focus, not visibility/enabled/fill alone.

Still open: backend activity snapshot/events, send-hotfix lane, canonical character editor (contract .tmp/character-advisor-contract.md now fresh Creation prop; seams retained, no unaccepted ports), and the joined backend (.tmp/feedback-backend-joined d0f45cf with accepted MAIN default profile + roster/activity, primary join review pending). Nothing here is deployed.

## Seams and dependencies (not claimed as done here)

- Backend activity snapshot/events: the activity lane was rejected and is
  under repair; nothing unreviewed is ported and the rail invents no
  activity. The snapshot seam (`PresenceInput.snapshot`) is ready.
- Send-hotfix lane (board Send -> request replies with truthful progress):
  not committed; not duplicated here. Secretary/dictation preserved.
- Character editor lane (canonical 3-paragraph contract): rejected findings
  under repair; only the mount seam exists here.
- Profile micro-fix lane: final QA/review owned there; this pass documents
  the pattern, ports nothing further, and does not claim it complete.
- Backend `/api/profile` full routes: accepted MAIN default profile is LIVE (5c2a32e); the isolated fixtures here capture the same contract (per-caller versioning, 409 with superseded text) explicitly as UI-behavior fixtures until the joined integration (d0f45cf) clears primary review. No server code is copied here and no real API integration is claimed from the shim.
- Full advisor functionality is integrated in meetings only to the extent
  above; nothing here is deployed.
