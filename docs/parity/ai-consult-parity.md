# ai_consult -> SimCEO parity plan (tracking)

> Human-testing handoff, 2026-11-03: the selected essentials, Secretary assistant, and meeting dictation milestone is deployed at http://localhost:5173. The compiled UI and API run together in the dedicated `simceo-essentials` Docker project, bound to localhost and backed by new PostgreSQL volumes. The original API on 5080 remains alive for rollback; the old development Vite server was stopped only after fresh preservation captures. The older phase-status comments below describe the November 2 checkpoint. Full parity acceptance remains open; this milestone does not complete every phase.
>
> Verification: final production application source matches reviewed `f64d637`; the final browser run passed 333 assertions, the server/evidence probe passed 315, all nine selected API/browser groups passed, and the real text plus spoken-audio provider gate passed 48. The running production container also passed its live model connection test, health/readiness checks, and a restart with all business content and six messages preserved. Restored data includes three boards (two archived), two meetings, two record drafts, two notes, thirteen roster entries, seventeen advisors, three wizard drafts, and ten images. PostgreSQL timestamp precision differs by at most nine 100-nanosecond ticks after restart; full sub-microsecond timestamp fidelity is not claimed. Physical microphone behavior remains for human testing.
>
> Evidence: `.tmp/primary-ui11-final-browser-qa.log`, `.tmp/primary-candidate-evidence-probe.log`, `.tmp/primary-final-all-qa.log`, `.tmp/primary-real-provider-qa.log`, `.tmp/essentials-ui11-closure-independent-review.txt`, `.tmp/essentials-human-preservation-third-independent-review.txt`, and `.tmp/essentials-human-handoff-independent-review.txt`. The fresh private capture is `.tmp/human-handoff-quiescent-20261103-2014/`; it excludes unsupported legacy account/session export, so the original in-memory API is retained. Do not replay this capture over newer human-test work. Wiki expansion, guest expansion, advanced usage dashboards, and background jobs remain deferred until the user has tested this milestone.

Source: ai_consult Boardroom (Telegram .NET advisory board) capabilities
ported to SimCEO web idioms (REST + React, adapted semantics).
Checked off with verification evidence as each phase lands.
> Status 2026-11-02 (America/New_York, MAIN ONLY, primary review): phases 0-3 ACCEPTED on backend commit 94d5ce0 with actual runtime evidence below. API code unchanged between backend/live runs and final UI. Phases 4-10 stay unchecked (not accepted). Planned tag after commit: phase03-verified-20261102.

## Phase 0 -- Foundations
- [x] Plan persisted here as the tracking checklist.
- [x] Shared EvidenceRef shape reused by dossiers, briefings, records.
- [x] Versioned board-configuration snapshot (version, exportedAt) with hash-verified import.
- [x] Per-phase harness: `qa/run-qa.ps1 -Pg -Browser` (full backend + browser); `qa/run-qa.ps1 -BrowserOnly` reruns frontend checks only and is explicitly NOT backend acceptance. Evidence: `.tmp/primary-combined-qa.log`, `.tmp/primary-combined-qa2.log` (backend legs), `.tmp/primary-browser-qa5.log` (BrowserOnly), `.tmp/live-text-gate-primary6.log` (live generated text), `.tmp/primary-restored-live-navigation.log` (restored-app read-only smoke).

## Phase 1 -- Trusted advisors
- [x] Dossier-backed profiles (real Meta grounded research in live gate 76; rendered dossier excerpts 15; roster evidence and approval negatives on both backends).
- [x] Attach blocked while research pending; approve checks version + evidence + research-complete (actual negative cases ran via fake provider QA-BADENVELOPE / QA-RESEARCHERR controls; prior insufficient-evidence-only-code-verified note retired).
- [x] Portrait accept/retry review with provenance (BrowserOnly profile 19 + dossier 15; roster seed 90 + roster 87/89; persist-write 12 / verify 17 across owned :5100 restart).
- [x] Per-field setup provenance (LeadSetup ProvenanceJson per field, rendered per-field in setup UI; versioned saves, stale-save 409 covered by selftest lead-version). Draft/activate mechanics continue in Phase 2/3.
- [x] Tests: 409s version-mismatch / pending-research / portrait / dup-attach ran live against disposable backends (memory 182 + backup 6; published PG 182 + backup 6); identity-boundary 30 on PG after pg+backup and before persist-write.

## Phase 2 -- Conversational setup interview
- [x] One-question-at-a-time turns with background analysis + checkpoints (BrowserOnly wizard 57).
- [x] Failure durability (turns persisted before LLM call; GET draft resume + UI hydrate; backup v2 keeps drafts; review returns per-field set/missing; actual pending-research / interview restart + SQL rollback probes ran on the PG leg).
- [x] Field inspection + targeted edits (review fields checklist in interview + review cards; ApplyFieldUpdate via interview; fast-path form; create 409-gated on blockers).
- [x] Wizard fast path shares the same draft store (interview writes FieldsJson; wizard form saves/loads same draft; create consumes it). Independent closure: `.tmp/wizard-guide-final-closure-review.txt` (setup-guide bypass closed in source + bounded probes).

## Phase 3 -- Discussion fidelity
- [x] Group caps with recorded yield reasons + single overflow note (discussion regression 40 mem + 40 PG).
- [x] Re-bid rules, adapted (every run re-bids from scratch against the new prompt; explicit participant picks honored invitation-led; unapproved pool never speaks unless picked).
- [x] Limits end in yield, never approval (one reply per advisor per lead turn; declines/abstains/errors become yields; owner interruption discards unsent drafts via 409; run publishes messages only, no approval path).
- [x] Secretary pre-check (import/interview regression 30 mem + 30 PG; core-snapshot 16 mem + 16 PG).
- [x] Adopt-and-record verbatim path (BrowserOnly from-direction 201 + exact multiline byte roundtrip, unapproved draft / current watermark / hash; manual raw JSON path compatible).
- [x] Live-text vs deterministic distinction: actual Meta generated text proved only by `.tmp/live-text-gate-primary6.log` (LIVE GATE PASS 76: wizard interview, grounded Grace Hopper dossier, fictional advisor + discussion, ledger + usage). Deterministic provider API behavior proved separately by real C# gateway envelope x8 on own loopback :5202 (no external sockets) + storage-failure x7 + public-evidence fetch 105 with injected fixtures only. Independent closures: `.tmp/phase03-nonwizard-final-closure-review.txt`, `.tmp/public-evidence-ancestor-closure-review.txt`.

## Scope limits for the 0-3 acceptance
- `.tmp/primary-combined-qa.log` and `.tmp/primary-combined-qa2.log` each FAILED on UI-only legs (first: app 22+1 fail, profile/wizard FATALS; second: wizard 4 fails + FATAL) and are NOT whole-PASS; backend legs listed above passed. Final BrowserOnly `.tmp/primary-browser-qa5.log` passes frontend only (app 30, profile 19, dossier 15, wizard 57, nav 222) and does not re-prove the backend.
- API code unchanged between backend/live and final UI; final UI verified on repaired App.tsx plus primary independent desktop / dark / mobile views.
- Original 3 boards (2 archived) restored on :5080/:5173 with their saved contents and archival states preserved; read-only live smoke `.tmp/primary-restored-live-navigation.log` 9/0.
- Honest unverified limits preserved: ASR codec path, image-live behavior, readiness/runtime beyond the logged runs, and phase 9 accounting depth are not claimed by this checkpoint.

## Phase 4 -- Secretary depth
- [ ] Direct routing (Secretary, ...) bypassing bids; may interrupt unsent work. (Delivered in the essentials checkpoint, with selected API/browser verification; full-phase acceptance remains open pending human feedback and the complete requirement audit.)
- [ ] Labeled provisional notes with update/reversal + history; never decisions. (Delivered in the essentials checkpoint; earlier rejected lane checkpoints are historical, not the deployed source. Full-phase acceptance remains open.)
- [ ] Briefings strictly from approved sources + directions + context, with excerpts. (Included in the selected Secretary implementation and evidence checks; full-phase acceptance remains open.)
- [ ] Clarifying question on ambiguous requests. (Delivered and exercised in the selected API/browser checks, including reload/retry/answer recovery; full-phase acceptance remains open.)

## Phase 5 -- Records review UX
- [ ] One-document review: working notes, items, excerpts, recent input; per-item approve/revise/discard + approve-all. (Basic review, selected/all approval, and whole-draft revision/discard are delivered. Granular item revision/discard controls remain pending: `itemRevise`/`itemDiscard` handlers exist, but the current rendered editor uses whole-draft JSON and draft discard. Do not count helper definitions as completed UI.)
- [ ] Empty-draft guard: no approval control at all. (Delivered and covered by the final browser checks; full-phase acceptance remains open.)
- [ ] Hash/version/watermark + supersession shown; 409 on drift. (Delivered in basic review; the selected browser checks exercise conflict display and an explicit refresh POST. Full-phase acceptance remains open.)

## Phase 6 -- Source governance depth
- [ ] pending -> approved/rejected state machine with per-version states. (Backend routes and validators are present in MAIN; selected source/restore checks passed. Full source-governance workflow acceptance is not established by the essentials checkpoint.)
- [ ] Type policies (wiki-only / allow-all-with-exclusions); changes invalidate pending replies + pause. (Shared policy/publication protections are included in the delivered core; full policy workflow acceptance remains open.)
- [ ] Per-source indexing state + explicit reindex with completion status. (Source index/reindex endpoints are present; complete phase-specific UI and lifecycle acceptance remains open.)
- [ ] Section-level persisted excerpts. (Source section/version/history endpoints and selected preservation checks are present; full-phase acceptance remains open.)

## Phase 7 -- Read-only Wiki.js connector
- [ ] Resource lifecycle (URL, server-side key, description, allowlist, exclusions-win, tags, locale, explicit enable). (Deferred. Resource endpoint code is present, but the complete connector workflow is unaccepted.)
- [ ] Board vs single-meeting scope; sync on enable/rule change/schedule + manual. (Deferred. Do not infer scheduled-sync or scope acceptance from endpoint presence.)
- [ ] Read-only, per-fetch rule recheck, failed sync blocks connector evidence. (Deferred; requires its own full connector verification after the human-testing checkpoint.)

## Phase 8 -- Meeting-scoped guests
- [ ] Discuss-only access to one meeting + read-only settings access, revocable. (Basic access controls support the delivered milestone; expanded meeting-guest workflow acceptance is deferred.)
- [ ] Join tracking; leaving revokes. (Deferred; full guest lifecycle acceptance remains open.)

## Phase 9 -- Usage accounting depth
- [ ] Installation scope; hidden roles included; missing/unallocated labeled. (Durable model-call/usage accounting supports the delivered features. Complete installation/hidden-role/unallocated reporting and dashboard acceptance is deferred.)

## Phase 10 -- Verify-first (prove, do not rebuild unless missing)
- [ ] Jobs idempotent retry; backup/restore hash semantics; readiness/liveness; admin diagnostics. (Hash-verified restore, persistent startup, readiness/liveness, and the human container restart are verified for the delivered milestone. Background-job retry/execution and the complete diagnostics audit remain open. See the timestamp precision limit above.)
- [ ] Auth stays session-based; voice stays sim_ceo-only. (Session-based access and meeting dictation support the delivered milestone; physical microphone testing and the complete phase acceptance audit remain pending.)

## Explicit non-goals
Telegram transport, group/topic mechanics, BotFather UI, verbatim command grammar, separate ai_consult web UI, new paid-service requirements.

## Navigation + secure UI completion (Muse lane, unaccepted)

Scope: entire-app navigation (hash routes, normalization, board/meeting/record scope, wrong-parent, unknown/missing/archived/deleted/denied, public invite join, recovery, back/forward) and secure UI (fail-closed private queries/rendering, canonical Bearer-first applied identity + auth epoch, server-derived role caps for every tab/action, server stateValid-gated record approval, identity-aware transport/downloads/refresh/exports, held-response and A-B-A invalidation).

Contracts for Wiki/Secretary lanes: docs/nav-completion-interface.md and .tmp/nav-completion-interface.txt (host GovTransport adapter, origin/epoch/selection rules, capability matrix).

Evidence: qa/nav-secure-qa.cjs (real-memory API :5129 + web :5197 + owned Edge CDP :9336; registered admin/owner/contribute/readonly/discuss/unrelated/anonymous/expired/revoked identities; actual interactions, request authority, deny AND positive DOM, held-response/revocation/A-B-A, all-tab back/forward + direct links, desktop/mobile light/dark, no console errors/fetch failures). Run log: .tmp/nav-secure-*.log (git-ignored).

Status: implementation + browser QA authored by Muse; acceptance requires primary + dedicated-AI review (no self-acceptance).
