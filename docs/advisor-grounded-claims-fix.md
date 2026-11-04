# Advisor grounded-claims fix (CharacterResearch provenance + voice-label separation)

Primary semantic review `advisor-real-15190-v2-semantic-review.txt` independently
CONFIRMS a real product defect at `CharacterResearch.cs:260` / `:321` and two
UX defects. This change fixes both properly with no generic fixed tone.

## Defects fixed

1. **Claim provenance (product defect):** every dossier line received the same
   `g.Citations.Take(3)` refs, including one empty excerpt and two unrelated
   excerpts (Doyle opinion, IsHolmesReal question) for 12 distinct facts.
   `grounded = citedExcerpts.Count > 0` then marked the run complete on any
   snippet. Independent corroboration of facts does not repair stored citation
   relationships.
2. **Research labels in voice (UX defect):** uppercase `VERIFIED` /
   `INTERPRETATION` annotations propagated from the dossier into compiled
   operational paragraphs and chat/audition answers. `QA persona` phrasing is
   seed-induced (owner description), not universal product injection; production
   must not inject it universally.

## Architecture (bounded, two model calls)

- Stay bounded `<=180s` per research (`CharacterBehavior.ResearchDeadline`,
  still capped at 180s) across URL fetches + model calls.
- At most TWO model calls per research: one grounded dossier
  (`CompleteGroundedAsync` `advisor-research`) + one paragraph compile
  (`CompleteAsync` `advisor-compile`). No extra LLM validation, retries,
  or recursion.
- First dossier call now requests structured per-claim source refs plus the
  exact supporting quote/passage and `FACT`/`INTERPRETATION` metadata. Owner
  links are indexed with source IDs (`S1..Sn`) and actual owner-fetched
  excerpts; web search supplies citation content as before.
- Never mechanically copy top-N cites onto all claims. Retained refs must be
  linked to THAT claim with a nonempty verified retrieved passage, never a
  title, search question, or unfetched URL.
- URL/ID and quote validated against actual retrieved text with
  whitespace-normalized exact matching. Unknown/mismatched citations get no
  verified badge and no grounding.
- Web-discovered URLs with missing excerpts use ONE bounded post-dossier fetch
  via the existing `PublicEvidenceFetcher` safety (SSRF-pinned, 5s per URL,
  max 3) under the same whole deadline and bounded remaining URL budget. No
  extra LLM call, no recursive walk.
- Quote linkage proves provenance only, never automatic claim truth. Honest
  `kind`/`verified` metadata is stored; semantic review still verifies
  entailment on actual samples.
- Unsupported/unmapped claims remain explicit `dossier [unverified]` notes
  with no support refs. Grounded completion requires real validated claim
  links, never any excerpt and never seed alone.
- Compile uses ONLY verified grounded claims + owner seed + explicit limits,
  still refining the current full saved behavior. Version CAS, restore epoch,
  identity, cancel (499)/deadline (504), failure/partial editable unsupported
  flow, and all previous engine fixes are preserved.
- Research status labels and citation metadata belong in the research summary
  only. Operational paragraphs are natural three-field prose with conditional
  agree/disagree and blunt/diplomatic/formal variation by character,
  expressing uncertainty plainly without mandatory labels in every answer.
  Owner intent and fictional-identity honesty are preserved (fictional persona,
  no real credentials/employment/degrees/licenses/endorsements).

## Changed contracts (backward compatible)

- `server/SimCEO.Api/Work/ClaimEvidenceMapper.cs` (new, pure, production
  callable, no HTTP/env/clock): `Normalize`, `BuildSidMap`, `TryResolveUrl`,
  `ParseClaimLine` (JSON + `KIND | text || EVIDENCE: url :: "quote"` + legacy
  plain), `MapOne`/`MapAll`, `CollectUnfetchedUrls`. Quote must appear
  verbatim whitespace-normalized in that source excerpt; SID or full URL must
  resolve into the retrieved pool.
- `CharacterResearch.cs`: dossier prompt requests `KIND | text || EVIDENCE`
  with SIDs + exact quotes; claim mapping via `ClaimEvidenceMapper`; one
  bounded web-fetch round; `grounded = validated.Any(verified)`; `supported`
  requires verified links; `EvidenceCount` counts distinct validated URLs;
  `BuildCompileInput` is now `public static` with label-prohibition rules and
  verified-only dossier input (`Verified grounded claims ... Explicit limits
  ...`). Claims serialize as `{angle,text,kind,verified,sources,refs}` where
  verified uses `angle:"dossier"` with per-claim refs (`excerpt` = exact
  quote) and unverified uses `angle:"dossier [unverified]"` with empty
  refs. `dossier [citation]` dumps remain for the summary only.
- `RosterEndpoints.cs` (`ai-draft`): same mapper applied; `supported`,
  `note`, `ResearchedAt` (null when unsupported), and `EvidenceCount` now
  derive from validated links instead of any excerpt.
- Frontend `advisor-creation.tsx` needs no change: `ResearchClaim`
  (`angle/text/sources`) ignores the added `kind`/`verified`/`refs` fields;
  `dossier [unverified]` renders honestly in the existing claims list.

## Tests (actual, code-only)

- `qa/ClaimEvidenceProbe` (new, `dotnet run`, 29/29 PASS, no HTTP/env):
  top-3 same-cites unrelated negative; empty/unfetched/unknown-URL/
  quote-mismatch and wrong-source duplicates unsupported; two distinct claims
  with exact correct quotes+sources verified; SID map + seed-only not
  grounded; JSON line format; compile prompt carries grounded content +
  current paras + seed while forbidding label copy and mandating limits;
  compile budget fail-closed; `ResearchDeadline <=180s`; exactly one
  `CompleteGroundedAsync` + one `CompleteAsync` in `CharacterResearch.cs`;
  hydrate rounds bounded.
- `dotnet build server/SimCEO.Api` Release PASS (0 errors).
- `qa/AtomicUnitProbe` memory section ALL PASS.
- No new HTTP/env/fault/clock seams. No `ModelGateway` global rewrite.
- No live provider, PG, Docker, `.env`/keys, or human ports touched in this
  branch. No shared/global kills. Other roots untouched.

## Remaining gates (for PRIMARY)

- PRIMARY to review source and run a real-provider new isolated attempt
  (fresh 15xxx stack, exact PID cleanup, no resume) to confirm the structured
  `KIND | text || EVIDENCE` format is followed by `muse-spark-1.3` and that
  verified links appear for genuinely supported claims while unsupported runs
  stay `unsupported` with editable drafts.
- Semantic entailment of validated quotes still requires dedicated AI review
  on actual samples; never claim all research quality from model self-rating
  or one sample.
- Frontend renders `dossier [unverified]` honestly; no behavior change needed
  unless product wants explicit `kind`/`verified` badges.
