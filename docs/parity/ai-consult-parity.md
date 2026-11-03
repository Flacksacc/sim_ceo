# ai_consult -> SimCEO parity plan (tracking)

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
- [ ] Direct routing (Secretary, ...) bypassing bids; may interrupt unsent work. (Not implemented; unchanged.)
- [ ] Labeled provisional notes with update/reversal + history; never decisions. (Not implemented; unchanged.)
- [ ] Briefings strictly from approved sources + directions + context, with excerpts. (Not implemented; unchanged.)
- [ ] Clarifying question on ambiguous requests. (Not implemented; unchanged.)

## Phase 5 -- Records review UX
- [ ] One-document review: working notes, items, excerpts, recent input; per-item approve/revise/discard + approve-all. (Not implemented; unchanged.)
- [ ] Empty-draft guard: no approval control at all. (Not implemented; unchanged.)
- [ ] Hash/version/watermark + supersession shown; 409 on drift. (Not implemented; unchanged.)

## Phase 6 -- Source governance depth
- [ ] pending -> approved/rejected state machine with per-version states. (Review rejected; 13 defects in fresh Muse fixing; PRODUCT skill creation owned by phase 6, not Main.)
- [ ] Type policies (wiki-only / allow-all-with-exclusions); changes invalidate pending replies + pause. (Same phase-6 rework; unchanged.)
- [ ] Per-source indexing state + explicit reindex with completion status. (Same phase-6 rework; unchanged.)
- [ ] Section-level persisted excerpts. (Same phase-6 rework; unchanged.)

## Phase 7 -- Read-only Wiki.js connector
- [ ] Resource lifecycle (URL, server-side key, description, allowlist, exclusions-win, tags, locale, explicit enable). (Not implemented; unchanged.)
- [ ] Board vs single-meeting scope; sync on enable/rule change/schedule + manual. (Not implemented; unchanged.)
- [ ] Read-only, per-fetch rule recheck, failed sync blocks connector evidence. (Not implemented; unchanged.)

## Phase 8 -- Meeting-scoped guests
- [ ] Discuss-only access to one meeting + read-only settings access, revocable. (Working in separate worktree; unaccepted in MAIN.)
- [ ] Join tracking; leaving revokes. (Working in separate worktree; unaccepted in MAIN.)

## Phase 9 -- Usage accounting depth
- [ ] Installation scope; hidden roles included; missing/unallocated labeled. (Working in separate worktree; unaccepted in MAIN; accounting limits not claimed.)

## Phase 10 -- Verify-first (prove, do not rebuild unless missing)
- [ ] Jobs idempotent retry; backup/restore hash semantics; readiness/liveness; admin diagnostics. (Not implemented; unchanged.)
- [ ] Auth stays session-based; voice stays sim_ceo-only. (Unchanged.)

## Explicit non-goals
Telegram transport, group/topic mechanics, BotFather UI, verbatim command grammar, separate ai_consult web UI, new paid-service requirements.
