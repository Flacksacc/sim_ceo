# Advisor grounded-claims fix (independent review 13412a7: all eight findings)

Stored dossier ../primary-advisor-real-15190-v2-dossier.json confirms the original defect: all twelve substantive claims carry the same three citations, including one empty excerpt and two unrelated passages.
This change fixes provenance, origin honesty, URI identity, inventory, display, fixtures, and prompt budget with actual code, not rebuttal.

## 1 Origin plus multi-passage (P1) -- actual gateway fetch provenance end-to-end (follow-up)
Pool retains MULTIPLE passages per URI with Fetched plus Origin: owner-batch successes are owner-fetch (fetched), provider snippets are provider-search (provenance only, never fetched), successful application fetches are application-fetch (fetched).
ModelGateway.Citation carries optional Fetched/Origin metadata (compatible 3-arg construction preserved): provider web_search snippets are recorded fetched=false with origin provider-search (unfetched when no snippet), url_citation annotations as unfetched.
PublicEvidenceFetcher.HydrateAsync success returns fetched=true plus origin application-fetch and preserves already-excerpted citations as-is; the gateway hydration step keeps that metadata (no gateway rewrite).
CharacterResearch propagates it: dossier citations with fetched=true are added as fetched with their gateway origin (never downgraded to provider-search); a failed owner fetch followed by a provider snippet stays unfetched/provider-search; post-dossier hydration records the actual fetch result and CollectUnfetchedUrls (fetched-aware) avoids redundant refetch of already-fetched URLs.
ai-draft propagates it the same way in pool passages, inventory evidenceRefs, and validated claim refs instead of hardcoding fetched=false.
evidenceRefs carry honest fetched plus origin via IsUrlFetched/PoolOriginFor (PoolOriginFor prefers the actual fetched passage origin). Quote linkage proves passage provenance only, never claim truth.

## 2 ai-draft format plus map-before-compile (P1)
ai-draft requests KIND-EVIDENCE grammar via BuildAiDraftDossierPrompt, maps BEFORE the second model call, and builds the profile prompt via BuildAiDraftProfilePrompt from VERIFIED claims only. Raw dossier text no longer informs the profile.

## 3 Unsupported terminal plus response state (P1)
ai-draft persists draftStatus done or unsupported, ResearchedAt only when grounded, EvidenceCount zero when unsupported. ResearchTerminalStatus names unsupported. DataCompleteness and Completeness exclude unsupported from research-missing (staging allowed). ApprovalGate returns research-unsupported (approval blocked).
Creation response derives researched, supported, draftStatus, evidenceCount from the committed validated outcome, not RanSearch. Endpoint plus live verification of this lifecycle is separately assigned and still pending (see Tests).

## 4 Strict URI identity (P2) -- end-to-end via shared helper
EvidenceUri is the single shared strict-identity root (scheme/host case-insensitive, default ports equivalent, path/query case-SENSITIVE, trailing slash significant except bare root) used for source-input dedup, fetch candidates, fetch cache, pool lookup, prompt excerpt lookup, inventory, and claim-ref emission.
No case-insensitive full-URL dictionary remains in this pipeline (Ordinal storage plus strict scan; SID-keyed maps are not URL-keyed).
Lookup returns the retained pool URL: MapOne emits the canonical pool key spelling, not the model-resolved spelling. Distinct resources (/Case vs /case, query case, trailing slash) never share excerpts.

## 5 Discovered-source inventory (P2)
Post-dossier hydrated URLs are added to citedUrls, so a URL appearing only in a structured claim and fetched afterward appears in claim refs, source inventory, evidence count, and UI data.

## 6 Fact and interpretation display (P2)
Verified facts serialize as angle dossier, verified interpretations as dossier [interpretation], unverified as dossier [unverified]. Frontend renders Fact, Interpretation, Cited passage, Unsupported with provenance captions. Operational paragraphs still forbid label copying.

## 7 Fixtures plus assertions (P2)
fake-provider and advisor-integrated-fake now emit FACT plus INTERPRETATION lines with EVIDENCE quotes exactly matching the web_search_call snippets. Assertions updated to Verified grounded claims plus Explicit limits wording while retaining grounded completion and lifecycle checks. No assertion weakened for unsupported output.

## 8 Delivered prompt budget (P2)
BuildDossierPrompt reserves the mandatory grammar FIRST within the delivered gateway budget. Head plus format never trim. Seed, background, and owner excerpts trim in order with explicit markers. SID bindings are never cut. Max-input regression proves fit plus complete instructions plus accurate SIDs.

## Architecture preserved
Two model calls maximum per research (one grounded dossier plus one compile; ai-draft likewise one plus one). No third validator, no retries, no recursion, no new LLM calls. Whole-research deadline stays bounded at 180s with linked cancel and deadline tokens and existing safe fetcher caps (DNS/SSRF/pinned-connect/redirect/public-IP/whole-URL 5s/3-URLs-per-call/concurrency caps unchanged). No API/env test bypass (probe injection is constructor-only). Saved paragraph, version CAS, restore epoch, identity, cancel, recovery, explicit-save, and approval controls preserved.

## Tests (code-only; no Docker, PG, providers, env, or ports)
qa/ClaimEvidenceProbe: 29 of 29 PASS. qa/AdvisorGroundedClaimsProbe: 49 of 49 PASS (34 helper/in-memory checks plus 15 source-text assertions; no HTTP orchestration, retrieval, rendering, or live-provider coverage -- endpoint/live verification pending, separately assigned).
qa/PublicEvidenceProvenanceProbe (new, focused production-fetch probe): 19 of 19 PASS via in-process injected HTTP/DNS PublicEvidenceFetcher (strict /Case vs /case, query case, trailing slash; failed owner then provider snippet; actual successful fetch true plus application-fetch origin with honest mapping and no redundant refetch; distinct same-URL passages) using the actual fetcher, not manual passage flags.
qa/PublicEvidenceProbe security regression: 105 PASS, 0 FAIL (existing DNS/SSRF/redirect/public-IP/whole-URL-5s/3-URLs-per-call/concurrency caps all preserved).
dotnet build server/SimCEO.Api Release: 0 errors. No live provider, PG, Docker, env keys, human ports, persistent services, or browser used.

## Remaining gates (for PRIMARY)
PRIMARY to run a real-provider new isolated attempt (fresh 15xxx stack, exact PID cleanup, no resume) to confirm structured KIND-EVIDENCE compliance and verified links for genuinely supported claims. Semantic entailment still requires dedicated AI review on actual samples. Quote matching establishes retained-passage provenance only, never semantic acceptance.
