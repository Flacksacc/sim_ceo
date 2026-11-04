# Roster integrity — backend integration record (backend profile)

All scaffold services are now functionally integrated. Base: 9e23a06 worktree
`C:/Users/War/scrach/sim_ceo/.tmp/feedback-backend`, branch `muse/feedback-backend`.
No live user-data writes were performed during development; QA ran against
isolated fixtures only: memory-mode API on 127.0.0.1:15971 with fake provider on
127.0.0.1:15972, plus native-PG engine + HTTP suites on NEW unique databases on
15441 (created for each run, verified absent afterwards). Human ports
5173/5080/9333/5099 probed read-only and left alone; no Docker, no existing-DB
contact, no main-checkout contact, no private env touched.

## Live-diagnostic follow-up: legacy blank-owner visibility + empty-link recovery

Primary diagnostic (MAIN .tmp/roster-live-diagnostic.md): the human app has ZERO
missing roster targets — 5 active attachments link existing entries, all 13 roster
rows carry blank legacy OwnerKey under one historical AccountId, boards have
non-empty owners, and a random browser-local account filter hid the existing
attached entries from list/count.

Fixes in this worktree (server + focused QA only):
- `GET /api/roster` and `GET /api/roster/count` (Program.cs) no longer let a
  non-matching accountId hide attached entries: visibility = account match OR
  attached-to-a-readable-board OR unambiguous legacy-owner match. Count uses the
  identical predicate (list/count parity). Unattached foreign entries stay hidden.
- `CanWriteRoster` hook (RosterEndpoints.cs, 5-line BACKEND-PROFILE block): a
  blank-OwnerKey entry whose linked boards share one non-empty owner grants that
  owner write authority (no invented ownership, no cross-account merge). See the
  cross-profile conflict note below.
- Empty-link advisors are now RECOVERED, not left flagged: one deterministic
  entry per advisor (`StableEmptyLinkId(board, advisor)`), honest role placeholder,
  membership/history/role/images preserved, unapproved re-pin. Ownerless-board
  empties stay flagged (no identity to recover).


## User rule implemented (overrides old independent-board-copy design)

- A board advisor can ONLY link an advisor already in the owner-authorized
  roster. `RosterOps.TryCopy` is the single attach choke point (advisor POST +
  roster copy) and now routes through `RosterIntegrity.CheckAttach`
  (existence, non-archived, caller roster-read auth, board manage, cap 10,
  unique (board, roster), completeness). Portrait completeness stays as the
  board-usability gate (ApprovalGate parity).
- Reconciliation (`POST /api/admin/roster-reconcile/plan|apply`, owner-only):
  dry-run plan (read-only, deterministic PlanHash, backup snapshot) then apply
  with exact-plan-hash concurrency guard + idempotencyKey replay guard.
  Repairs: stale-version re-pin (Approved=false), duplicate-link removal
  (earliest CreatedAt wins; messages, board-linked images and meeting
  participant lists re-pointed to the survivor; removed role in audit),
  missing-link RECOVERY (not detach/remove): reconstruct the canonical roster
  entry UNDER THE STABLE MISSING ID (one entry even when several boards share
  the id under one owner; owner/account inferred from board owners; never
  cross-account merged), re-link board-local images, and re-pin the PRESERVED
  advisor links (same Id, membership, role, history; Approved=false). The
  reconstructed profile is an honest stub (tagged recovered, provenance note,
  no invented credentials) and surfaces as incomplete until the owner completes
  it / runs research. Guid.Empty links carry no identity: never grouped, never
  merged, never removed - flagged for owner review only. Archived links stay
  visible in roster + board projections with policy (approval) preserved.
  live owner decision). No name-based merging anywhere; ownership validation
  skips repairs when board and roster entry carry differing non-empty owner
  keys. Markers are JobRows (restore-safe; note markers would fail backup
  validation for missing parent meeting).
- Canonical roster edits change board behavior: manager advisor projection
  carries canonical name/current version/stale pin/behavior fingerprint;
  `ContextCurator.BuildPacket` embeds `RosterIntegrity.CanonicalPacketSection`
  (live profile + dossier + version pin, STALE label); discussion commit gate
  re-checks reviewed-input fingerprints (stale-profile yield); secretary
  DossierHash snapshot discards on roster change; research completion has
  base-version/supersede guards; roster edit/archive unapproves copies.
- 10-member cap, auth/account isolation, completeness/research/approval
  guards, version concurrency and backup/restore validation preserved.
- `app.MapRosterChat()` wired. Roster chat is the ONLY direct-chat path
  (canonical current fields, CanReadRoster, stateless, 4000-char guard).
  Board-scoped direct advisor chat (`/api/boards/{bid}/advisors/{aid}/chat`)
  now returns 410 Gone with the canonical `/api/roster/{id}/chat` route.
  Board group discussion (`/api/meetings/{id}/run`) is unaffected.
- Unified create flow: `GET /api/roster/{id}/research` now also returns
  `researchRequested`, `evidenceCount`, `version`, `researchBaseVersion` and
  `running` so the frontend can poll real progress while POST /research is in
  flight. `POST /api/roster/ai-draft` already returns the researched entry
  synchronously (no fake). No `feedback-backend-needed.txt` existed in MAIN
  `.tmp`; no additional server support was required beyond the additive GET
  fields, so no coordination file was created.

## Files owned/changed by backend profile (server + focused QA only)

- `server/SimCEO.Api/Work/Endpoints.cs` — wire `MapRosterChat`,
  `MapRosterReconciliation`.
- `server/SimCEO.Api/Work/RosterEndpoints.cs` — TryCopy via CheckAttach,
  retired board chat (410), research GET progress fields.
- `server/SimCEO.Api/Work/RosterReconcileApply.cs` — NEW: Apply engine +
  MapRosterReconciliation.
- `server/SimCEO.Api/Work/RosterReconciliation.cs` — Scan/Plan scope filter.
- `server/SimCEO.Api/Work/ContextCurator.cs` — canonical packet section.
- `server/SimCEO.Api/Program.cs` — attach auth booleans, canonical advisor
  projection, extended `--selftest` reconciliation fixture.
- `qa/roster-backend-qa.mjs` — NEW: 56-check isolated HTTP suite.
- `qa/roster-chat-contract.mjs`, `qa/roster-integrity-qa.mjs` — updated to
  assert the integrated state (old scaffold asserted files untouched).

## Untouched (other owners) + conflict note

- `web/**` untouched. Frontend owns mount + unified-create UI.
- Profile-owner areas untouched: `LeadSetup.cs`, `Entities.cs`,
  `OpsEndpoints.cs`, `WizardGuide.cs`. CONFLICT NOTE for profile owner:
  `WizardGuide.cs:356` calls `RosterOps.TryCopy` with the new optional auth
  params defaulting to true (legacy behavior preserved; build green). When
  integrating, pass explicit `callerCanReadRoster`/`canAttachBoard` for the
  wizard-created entries. `TryCopy` defaults keep the in-process `--selftest`
- Character-engine agent owns `RosterEndpoints.cs` / `ContextCurator.cs` in their lane.
  EXACT CONFLICT REPORT (no overwrite by me; cherry-pick aid): the ONLY
  RosterEndpoints.cs edit in this worktree is the 5-line BACKEND-PROFILE hook in
  `CanWriteRoster` (single call to `RosterLegacyAccess.CallerMatchesEffectiveOwner`,
  placed right after the explicit-OwnerKey return; comment-tagged
  `BACKEND-PROFILE HOOK`). All legacy-ownership logic lives in the NEW file
  `server/SimCEO.Api/Work/RosterLegacyAccess.cs` (no overlap with their work).
  `ContextCurator.cs`: one-line canonical-section call from the prior commit,
  untouched in this round. If their lane rewrites those regions, keep the hook
  call (or replicate its one-line effect) so legacy blank-owner writes keep working.
  callers unchanged too.

## Validation (actual, in isolated fixtures)

- `dotnet build` 0 errors; `--selftest` SELFTEST PASS: legacy store fixture
  (stale re-pin, dup dedupe + history repoint, missing recovery incl. shared-ref
  single entry, empty per-advisor recovery + ownerless flag-only, owner-mismatch
  refusal, archived flag-only, hash guard, clean re-plan, replay) plus a secure-mode
  ownership fixture (effective owner writes without a grant; strangers denied read
  and write; removed-history-only legacy entry readable/writable by its unanimous
  owner, denied to strangers).
- `node qa/roster-backend-qa.mjs` PASS 119 checks (incl. removed-history owner full canonical projection with profile/research fields): attach/cap/dup/rosterless/404
  gates; stranger 403s; canonical projection + stale pin + fingerprint change;
  roster-chat canonical prompt proof via fake-provider log; 410 with roster route;
  ai-draft + research progress; roster-chat edit/restore races prove the post-await guards (dispatch-observed, 409 with stale/restore signal, no leaked provider text); baseline run publishes; mid-run edit then sync plus re-approve discarded with
  stale-profile yield with provider proven healthy (successful draft in flight pre-edit, zero
  provider errors, bids dispatched, no reply prompt with post-edit content), zero advisor messages, post-repair run
  publishes; plan/apply/replay/409 paths; concurrent same-plan apply settles with
  exactly-once repairs; plan-mutation refused with fresh hash; restore-during-generation discard with restore-specific 409 signal and zero new messages; restore-backed dedupe
  with history retarget; cross-account owner-mismatch refusal; legacy blank-owner
  visibility under a random client account (attached shown, unattached foreign
  hidden from strangers, count == list); effective-owner edit allowed, non-owner
  edit denied, board projection checks, archived visibility + approval preserved +
  flag-only; recovered placeholder blocked even with accepted portrait, research
  with evidence unblocks approval, re-tag re-blocks, owner tag-clear unblocks;
  secure admin (bearer) may reconcile, secure non-admin denied, secure admin apply
  succeeds; non-admin historical-only parity over bearer (removed-link unanimous owner reads list/count/direct/chat/write, strangers denied); revoked-session chat refused post-generation (401, no leak, dispatch-observed); scoped shared-missing refused with explicit global-required reason (nothing applied, still reported, global plan still reports); privacy fixture exists post-restore and is owner-readable; recovered placeholder reported incomplete with actionable missing fields; in-process selftest.
- Reconciliation hardening (review findings): removed links count as ownership
  evidence with unknown-owner conflict (no silent Alice->Bob transfer, no vanishing
  ownership); empty-link branch terminates (no Guid.Empty entry, zero-ID guards);
  plan hash binds full action inputs (targets, survivors, versions, owners, history
  counts); in-unit plan revalidation aborts concurrent mutations with 409;
  duplicate ordering matches apply (CreatedAt,Id); replay detects new actionable
  empties (409/re-plan); recovered entries stay explicitly incomplete until owner
  completion or evidenced research; roster chat revalidates version/archive/restore/
  session/access post-generation; reconcile allows owner demo or authenticated
  installation admin (bearer sessions no longer locked out); plan hash is one canonical JSON document serialized ONLY via JsonSerializer from explicit typed structures (sorted keys/arrays, full IDs, leaf escaping; no manual delimiters, so delimiter-collision repros move the hash), binding full entry fields (full IDs, actual entry owner/version/archive/profile, all historical links plus board ownership, exact message/image/participant rows, account/provenance inputs; human Summary/Evidence never hashed) with author-perturbation tests (entry-owner change, count-preserving history-row replacement, target owner/archive/version) on memory plus native PG; one strict ownership rule gates every repair mutation (explicit canonical owner authoritative, otherwise unambiguous history-aware ownership; unknown historical missing board or blank owner fails closed, including duplicate/stale paths); existing deterministic targets validate ownership/archive/version and dry-run relink (never attach foreign/archived); replay is driven by repair action kinds so ownership-blocked orphans never force re-plan; read parity via a single OwnerMatches predicate on list/count/direct/chat/write (unanimous removed-link owners included); scoped dry-run marks shared missing targets RequiresGlobalScope with exact inside/outside targets; plan hash binds complete mutation inputs (duplicate boardOwner/roles, empty account/board, missing full entry fields plus boardRoles/images, stale boardOwner) with author-perturbation tests (role, board-owner, account, provenance, board-name each move the hash and force 409); replay treats an unlinked advisor with an existing deterministic target as actionable (409/re-plan, never already-applied); recovered stubs are explicitly incomplete in Completeness/DataCompleteness until tag-strip or evidenced research; historical conflicting ownership fails closed at every write fallback (unanimous removed-link access retained).- `node qa/roster-chat-contract.mjs` 37 checks; `node qa/roster-integrity-qa.mjs` ALL PASS.
- `--selftest-pg seed|verify` PGSELFTEST PASS (two processes, fresh unique DB,
  restart between phases): recovery, stable ids, shared refs, history, image relink, scoped shared-missing refusal plus contained scoped success,
  empty-link recovery + ownerless flag-only, foreign-no-entry, job-marker
  persistence, replay, recovered completeness gate (incomplete with actionable missing, tag-strip completes), plan-mutation 409, idempotent re-apply.
- `SIMCEO_PG_SUPER=... node qa/roster-pg-qa.mjs` PASS 23 checks: fresh unique DB,
  API boot on Postgres, attach/approve/chat, kill + reboot, projection + chat still
  canonical after restart, backup/restore roundtrip, reconcile clean, mutated-plan 409 with fresh-hash re-apply, idempotent replay no-op, secure admin/non-admin reconcile boundary, fresh-instance restart proof (old PID exited, port closed, new PID differs, behavior persists), DB dropped in finally (any owned-cleanup failure fails the harness via fail/exit 1; negative drop/keyring probes through the real finally/report path return nonzero), verified temp keyrings only.
  Existing DBs/volumes untouched (listing verified empty of rosterqa* before/after).

## Known limitations

- Missing/empty-link orphans cannot be created through current HTTP paths (restore
  and setup-import lineage guards rightly refuse); covered in-process (memory +
  native PG), not over HTTP.
- Research POST is synchronous (provider-bound); progress is exposed via GET
  polling fields, not push/SSE.
- Full secure-mode HTTP coverage (login flows) is out of scope here; secure
  ownership boundaries are covered in-process plus HTTP negatives over
  the same code paths; revoke-during-generation is covered over HTTP for roster chat (401 post-generation, no leak), discussion-run revocation races beyond that remain in-process only.