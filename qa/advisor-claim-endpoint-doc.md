# Advisor claim endpoint gateway/commit regression (claim-endpoint)

Sole author: Muse. Production frozen at 67a902f; existing fixtures untouched.
New files only: qa/advisor-claim-endpoint-fake.mjs, qa/advisor-claim-endpoint-qa.mjs, this doc.

## What it proves via actual endpoints (no static source as proof)

- Owns exact loopback stack API 127.0.0.1:15500 + fake 127.0.0.1:15502, dummy key,
  unique instance qa-claim-endpoint-15500, unique keyring, refuses occupied ports,
  exact owned-child cleanup, no other worktrees, no PG/Docker, env real provider human.
- Registers a real private QA user, then actual POST /api/roster/ai-draft twice:
  unsupported (focus CLAIMENDPOINT-UNSUPPORTED) and supported max-budget (2000-char focus).
- Fake captures delivered prompts and returns mixed lines: FACT alpha + INTERPRETATION beta
  + second FACT gamma sharing the fact URL (distinct passage) + one unsupported note.
  Each supported line has a distinct exact quote+URL relationship; web_search_call
  snippets match exactly.
- Profile call proof: fake log shows only verified lines + seed reach the profile
  prompt; the unsupported note never appears there; dossier map happens before compile.
- Unsupported coherence AFTER the real Atomic commit: POST returns researched false,
  draftStatus unsupported, evidenceCount 0; GET /research stage unsupported (not
  interrupted/running), researchedAt null; canonical read contains the entry;
  tags-only PUT preserves the terminal; completeness has no research-missing.
- Staging uses a provider-generated portrait (POST image/generate via the same fake,
  no external fetch) so Completeness portrait gate clears while research gate stays
  open for unsupported: copy stages 201; approve blocks 409 research-unsupported
  with grounded-evidence wording.
- Supported honesty: evidenceRefs fetched false + origin provider-search; strict
  URI negatives absent (lowercase path, query-case change, trailing slash);
  evidenceCount 2 distinct although 3 supported passages exist (multi-passage retained).
- Grammar budget: max-length focus still delivers EXACT format + KIND/EVIDENCE and 201s.
- Character flow with the same fixture: POST /character, POST /research (no sourceUrls),
  GET research done, tags PUT save; no ResearchJson forcing, no DB writes.
- Bounds: exactly 3 responses + 3 chat calls (2 per flow, no third validator);
  per-flow elapsed well under the 150s research deadline; pidfile removed, ports closed.

## Run (only when 15500/15502 free and safe)

node qa/advisor-claim-endpoint-qa.mjs

Exit 0 PASS, 1 FAIL, 2 FATAL/setup. Leaves owned rows for forensics (exact-ID scope only).

## Unexecuted and why

- Owner-fetch positive: loopback URLs are SSRF-pinned non-public by design;
  PublicEvidenceFetcher restrictions stay with no bypass; covered separately via
  real public fixtures, not this loopback fake.
- Localhost/SSRF weakening negatives: not attempted by design.
- Paid-network provider wording/timing: fakes only.
- Fault-injection seams (FailCleanupFault etc.): never set.
- PG/Docker/human ports/.env keys: never touched.
- Parallel readonly review may read but never changes production.
