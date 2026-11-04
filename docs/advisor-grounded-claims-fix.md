# Advisor grounded-claims fix (independent review 13412a7: all eight findings)

Stored dossier ../primary-advisor-real-15190-v2-dossier.json confirms the original defect: all twelve substantive claims carry the same three citations, including one empty excerpt and two unrelated passages.
This change fixes provenance, origin honesty, URI identity, inventory, display, fixtures, and prompt budget with actual code, not rebuttal.

## 1 Origin plus multi-passage (P1)
Pool retains MULTIPLE passages per URI with Fetched plus Origin: owner-batch successes are owner-fetch (fetched), provider snippets are provider-search (provenance only, never fetched), post-dossier hydration is hydrated-fetch (fetched).
MapOne verifies a quote against ANY passage for THAT strict-identity URL and returns the matched passage origin. CollectUnfetchedUrls (Fetched-aware) still hydrates snippet-only URLs. evidenceRefs carry honest fetched plus origin. Quote linkage proves passage provenance only, never claim truth.

## 2 ai-draft format plus map-before-compile (P1)
ai-draft requests KIND-EVIDENCE grammar via BuildAiDraftDossierPrompt, maps BEFORE the second model call, and builds the profile prompt via BuildAiDraftProfilePrompt from VERIFIED claims only. Raw dossier text no longer informs the profile.

## 3 Unsupported terminal plus response state (P1)
ai-draft persists draftStatus done or unsupported, ResearchedAt only when grounded, EvidenceCount zero when unsupported. ResearchTerminalStatus names unsupported. DataCompleteness and Completeness exclude unsupported from research-missing (staging allowed). ApprovalGate returns research-unsupported (approval blocked).
Creation response derives researched, supported, draftStatus, evidenceCount from the committed validated outcome, not RanSearch. Probe covers unsupported create through read, edit-save, staging allowed, approval blocked with no false running.

## 4 Strict URI identity (P2)
UrlsMatch is URI-aware: scheme and host case-insensitive, default ports equivalent, path and query case-SENSITIVE, trailing slash significant except bare root. Distinct resources never share excerpts. Lookup returns the actual retained source identity.

## 5 Discovered-source inventory (P2)
Post-dossier hydrated URLs are added to citedUrls, so a URL appearing only in a structured claim and fetched afterward appears in claim refs, source inventory, evidence count, and UI data.

## 6 Fact and interpretation display (P2)
Verified facts serialize as angle dossier, verified interpretations as dossier [interpretation], unverified as dossier [unverified]. Frontend renders Fact, Interpretation, Cited passage, Unsupported with provenance captions. Operational paragraphs still forbid label copying.

## 7 Fixtures plus assertions (P2)
fake-provider and advisor-integrated-fake now emit FACT plus INTERPRETATION lines with EVIDENCE quotes exactly matching the web_search_call snippets. Assertions updated to Verified grounded claims plus Explicit limits wording while retaining grounded completion and lifecycle checks. No assertion weakened for unsupported output.

## 8 Delivered prompt budget (P2)
BuildDossierPrompt reserves the mandatory grammar FIRST within the delivered gateway budget. Head plus format never trim. Seed, background, and owner excerpts trim in order with explicit markers. SID bindings are never cut. Max-input regression proves fit plus complete instructions plus accurate SIDs.

## Architecture preserved
Two model calls maximum per research (one grounded dossier plus one compile; ai-draft likewise one plus one). No third validator, no retries, no recursion. Whole-research deadline stays bounded at 180s with linked cancel and deadline tokens and existing safe fetcher caps. Saved paragraph, version CAS, restore epoch, identity, cancel, recovery, explicit-save, and approval controls preserved.

## Tests (code-only; no Docker, PG, providers, env, or ports)
qa/ClaimEvidenceProbe: 29 of 29 PASS. qa/AdvisorGroundedClaimsProbe (new): 49 of 49 PASS covering origin, multi-passage, strict identity, inventory, display, ai-draft prompts and commit order, unsupported lifecycle via Atomic plus RosterOps, delivered budget, fixtures, and call bounds.
dotnet build server/SimCEO.Api Release: 0 errors. npm web build (tsc plus vite): PASS. No live provider, PG, Docker, env keys, human ports, persistent services, or browser used.

## Remaining gates (for PRIMARY)
PRIMARY to run a real-provider new isolated attempt (fresh 15xxx stack, exact PID cleanup, no resume) to confirm structured KIND-EVIDENCE compliance and verified links for genuinely supported claims. Semantic entailment still requires dedicated AI review on actual samples. Quote matching establishes retained-passage provenance only, never semantic acceptance.
