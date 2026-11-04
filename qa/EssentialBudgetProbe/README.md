# Essential Budget Probe (P2#1 closure)

Sole-code-author scope: `ContextCurator.cs` + `Endpoints.cs` + this probe.
Parallel owners untouched: `CharacterResearch.cs` (explicit-input worker),
`qa/MaterialReview4Probe/*` (QA probe author).

## Defect (from .tmp/finalbackend-85635d6-closure-review.txt P2#1)
- `ContextCurator.BuildPacket` returned an oversized essential prefix fallback
  (essential behavior + 4k question + 4k latest lead over
  `ModelGateway.UserCharBudget("advisor-reply", 8000)`), and the meeting sender
  (`Endpoints.cs` ~1430) used gateway `CompleteAsync` with default
  `truncatePrompt:true`, silently cutting the latest-lead tail.
- The sender appended the `YOUR TURN...` instruction AFTER the builder budget,
  so even a near-full packet overran the delivered budget + manifest.

## Fix contract
- Single shared suffixes on `ContextCurator`
  (`AdvisorReplySuffix`, `AdvisorBidSuffix`): the builder reserves
  `suffix.Length` inside `UserCharBudget` and the sender appends the same
  constant. No duplicated magic margin; actual newline lengths used.
- `BidPacket` / `BuildPacket` throw typed
  `EssentialBudgetExceededException` with human wording
  `advisor profile and question are too long together ...` when
  essential + suffix cannot fit. No silent cropping; metadata never describes
  trimmed text. Manifest `TokenEstimate` covers the delivered
  `packet + suffix`.
- Sender defense in depth: both `advisor-bid` and `advisor-reply`
  `CompleteAsync` calls use `truncatePrompt:false`, so any residual over-budget
  slips reject at the gateway instead of cutting tails. No global gateway
  behavior changes.
- Preserved: activity terminal classification (`failed`/`provider-error`),
  partial other-advisor results, locks, source epoch, auth, canonical 3
  criteria. Per-advisor packet faults stay per-advisor yields.

## Honest reachability (no fake LLM proof)
- Oversized legal legacy fixture (profile JSON 19955 chars with 19.9k
  strengths + 4k description + 4k question + distinct 4k lead) is rejected at
  the BID stage first (`BID-REJECTED`), so the reply stage is never reached
  in production. The probe asserts BOTH stages reject with the clear
  category; it never claims a provider round-trip for the oversized case.
- Sender `truncatePrompt:false` text evidence is labeled a source check only.
  Provider-side honesty is shown with an in-process fake transport authored
  and executed here (canned `hello`, captured `messages[1].content`), which
  proves the delivered USER content equals `packet + suffix` exactly and fits
  `inputBudget*4`. Fake only; no real-LLM claim.
- Legal profile maxima unchanged (3x2000 + 20k JSON + 4k background intact).

## Run (no services/ports; pure build + in-process probe)
`dotnet run --project qa/EssentialBudgetProbe/EssentialBudgetProbe.csproj -c Release`
