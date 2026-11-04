# Material Review 4 fixes (2d1658a independent review)

All 4 source-traced P2s fixed; no test-symptom-only changes.

1. Research fallback race: effective fallback inputs now resolve from FRESH cur
   inside the SAME SetupLock/Atomic snapshot that captures name/profile/version/epoch
   before changing the dossier. No pre-lock preRes fallback. Explicit input
   semantics/validation preserved; explicit empty-URL contract preserved.

2. ContextCurator trimming: tracks COMPLETE source blocks (single-line) with
   metadata/pins/evidence; builds packet from retained blocks atomically with the
   corresponding manifest. Preserves essential 3 paragraphs + question and honest
   budget; transcript metadata reflects retained lines. SourceEpoch guard untouched.

3. Raw POST /api/roster: always ValidateSavedProfile for JSON objects (legacy
   objects pass, universal 20k/4k enforced). Plain-text legacy remains accepted
   within 20k for compat. Equivalent PUT already enforced; chat parity restored.
   Character suppliedProfile path aligned.

4. Research FailTerminal: only guard categories map 403/409 (res-restored 409,
   revoked 401, denied 403, gone 404); storage faults use CommitOutcome.StorageFault
   502 with honest no-change. Code-only FailCleanupFault seam for QA; no suppressed
   exception.

QA: qa/material-review4-qa.mjs (static + HTTP bounds/semantics, primary executes
with owned ports/DBs) and qa/MaterialReview4Probe (in-process packet/validator/
fault-mapping proofs, memory only). Primary owns 15971/72, 5159/5257/5258/5152,
5271/2, 119-suite reruns; this change ran only build/publish/selftest/node-check
plus the new memory probe.

## Closure proof (7ad500c + cc842 seam correction)

FailTerminal seam is AFTER the failure mutations (ResearchJson failed marker,
UpdatedAt, UnapproveBoardCopies, roster write, Flush) but still inside the
Atomic unit. The injected storage fault therefore rolls back a real mutation,
not an empty unit. Probe `actual-fault-mutation-observed-before-throw` records
job=="", draftStatus failed, board approval false inside the seam callback, so
a pre-mutation seam cannot pass; `actual-fault-strong-rollback-row/version`
and `actual-fault-strong-board-approval-restored` prove the row and linked
board approval restore, with storage 502 (never 403), runtime/live/progress
cleared, GET not running, retry allowed, plus no-fault/deny/epoch controls.

Packet QA now asserts exact source identity (GUID filename block + pin +
evidence, nonzero retained/dropped), wiki retained AllowedUse exact-once with
dropped guidance absent (memory builder, no network), and a forced transcript
drop (12 long messages, tight budget): some old removed, newest retained,
manifest exact rendered seqs, all 3 paragraphs + current question + latest
lead tail present, packet fits UserCharBudget. Creation bounds add 4001
reject/4000 accept inside sub-20k JSON, character object/string legacy and
oversize parity, and partial-canonical rejection. Empty-research asserts
200 honest terminal + persisted inputs with QA_FAKE, else 200 terminal or
supported 502, never 401/403/503.