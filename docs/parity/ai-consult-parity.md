# ai_consult -> SimCEO parity plan (tracking)

Source: ai_consult Boardroom (Telegram .NET advisory board) capabilities
ported to SimCEO web idioms (REST + React, adapted semantics).
Checked off with verification evidence as each phase lands.

## Phase 0 -- Foundations
- [x] Plan persisted here as the tracking checklist.
- [ ] Shared EvidenceRef shape reused by dossiers, briefings, records.
- [ ] Versioned board-configuration snapshot (version, exportedAt) with hash-verified import.
- [ ] Per-phase harness: API selftest, HTTP E2E (memory + Postgres), tsc && vite build, live gate only for generated text.

## Phase 1 -- Trusted advisors
- [x] Dossier-backed profiles (2026-11-02 E2E: research returns 21 claims w/ sources+excerpts, supported flag, unsupported-note; DossierView renders structured, no raw JSON).
- [x] Attach blocked while research pending; approve checks version + evidence + research-complete (2026-11-02 E2E: 409 research-in-progress on attach; 409 version-mismatch then sync then approve; 409 pending-portrait then accept then approve).
- [x] Portrait accept/retry review with provenance (2026-11-02: upload=pending, explicit accept/retry UI w/ thumbnails in roster detail, approve requires accepted-or-grandfathered; E2E verified).
- [x] Per-field setup provenance (LeadSetup ProvenanceJson per field, rendered per-field in setup UI; versioned saves, stale-save 409 covered by selftest lead-version). Draft/activate mechanics continue in Phase 2/3.
- [x] Tests: 409s version-mismatch/pending-research/portrait/dup-attach verified live; insufficient-evidence gate code-verified (not naturally triggerable); selftest PASS incl. roster-copy; 12-case HTTP E2E green. Also: attach now requires full completeness (portrait) via Completeness; new PUT /api/roster/{id} edit endpoint bumps version.

## Phase 2 -- Conversational setup interview
- [x] One-question-at-a-time turns with background analysis + checkpoints (2026-11-02 E2E+browser: POST interview start/answer, LLM analysis + field extraction, step checkpoints, retry-with-repair on unparseable output).
- [x] Failure durability (turns persisted before LLM call; GET draft resume + UI hydrate; backup v2 keeps drafts; review returns per-field set/missing).
- [x] Field inspection + targeted edits (review fields checklist in interview + review cards; ApplyFieldUpdate via interview; fast-path form; create 409-gated on blockers).
- [x] Wizard fast path shares the same draft store (interview writes FieldsJson; wizard form saves/loads same draft; create consumes it).

## Phase 3 -- Discussion fidelity
- [x] Group caps with recorded yield reasons + single overflow note (2026-11-02 E2E: run returns yielded[{advisor,reason}] for bid-declined/abstained/provider-error/already-replied, abstained + bidErrors preserved, overflow{omitted,cap,policy}; omitted-selection covered by selftest focused-overflow).
- [x] Re-bid rules, adapted (every run re-bids from scratch against the new prompt; explicit participant picks are honored invitation-led; unapproved pool never speaks unless picked).
- [x] Limits end in yield, never approval (one reply per advisor per lead turn; declines/abstains/errors become yields; owner interruption discards unsent drafts via 409; run publishes messages only, no approval path).
- [x] Secretary pre-check (2026-11-02 E2E: 409 + fixes on bare board; 200 provisional on set-up board).
- [x] Adopt-and-record verbatim path (2026-11-02 E2E: directions stored byte-exact incl. $5/brackets; record approve hash+watermark gated with 409s on mismatch/double-approve; export contains approved items only).

## Phase 4 -- Secretary depth
- [ ] Direct routing (Secretary, ...) bypassing bids; may interrupt unsent work.
- [ ] Labeled provisional notes with update/reversal + history; never decisions.
- [ ] Briefings strictly from approved sources + directions + context, with excerpts.
- [ ] Clarifying question on ambiguous requests.

## Phase 5 -- Records review UX
- [ ] One-document review: working notes, items, excerpts, recent input; per-item approve/revise/discard + approve-all.
- [ ] Empty-draft guard: no approval control at all.
- [ ] Hash/version/watermark + supersession shown; 409 on drift.

## Phase 6 -- Source governance depth
- [ ] pending -> approved/rejected state machine with per-version states.
- [ ] Type policies (wiki-only / allow-all-with-exclusions); changes invalidate pending replies + pause.
- [ ] Per-source indexing state + explicit reindex with completion status.
- [ ] Section-level persisted excerpts.

## Phase 7 -- Read-only Wiki.js connector
- [ ] Resource lifecycle (URL, server-side key, description, allowlist, exclusions-win, tags, locale, explicit enable).
- [ ] Board vs single-meeting scope; sync on enable/rule change/schedule + manual.
- [ ] Read-only, per-fetch rule recheck, failed sync blocks connector evidence.

## Phase 8 -- Meeting-scoped guests
- [ ] Discuss-only access to one meeting + read-only settings access, revocable.
- [ ] Join tracking; leaving revokes.

## Phase 9 -- Usage accounting depth
- [ ] Installation scope; hidden roles included; missing/unallocated labeled.

## Phase 10 -- Verify-first (prove, do not rebuild unless missing)
- [ ] Jobs idempotent retry; backup/restore hash semantics; readiness/liveness; admin diagnostics.
- [ ] Auth stays session-based; voice stays sim_ceo-only.

## Explicit non-goals
Telegram transport, group/topic mechanics, BotFather UI, verbatim command grammar, separate ai_consult web UI, new paid-service requirements.
