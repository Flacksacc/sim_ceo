# UI generation standards (standing laws)

Source: user directive, 2026-11-02. Applies to EVERYTHING generated from
that point forward. Stored here because the Memory Palace MCP server is
unreachable from this runtime.

## Rule 1 — no inner scroll boxes, ever

Nothing renders inside its own scroll container. No `overflow: auto/scroll`
paired with a fixed/capped height on any pane, card, tab row, list, or
message area. If content does not fit, the container grows; if the page
gets long, the page scrolls. The browser scrollbar is the only scrollbar
(except the OS default where genuinely unavoidable). This already applies
to: side rail, tab rows, chat/message panes, meeting columns, roster
detail. Sticky elements (composer, pills) must offset for the top bar.

## Rule 2 — no raw data in front of the user

Never show machine formats (JSON, hashes, IDs, debug dumps) in the UI.
Structured data is broken out into individual labeled fields. Applies at
minimum to advisor profiles (background, strengths, methods, evidence
needed, limits, collaboration as separate fields with graceful fallback
for missing fields). Open question: whether research dossiers and other
debug-style outputs fall under this rule too (assumed profile-only until
told otherwise).

## Rule 3 — PENDING (user was cut off mid-sentence)

"Third, when generating random things." — full text not yet received.
Do NOT guess it. Ask the user to finish the sentence before applying.

## Scope note (2026-11-02, applied in Roster regeneration)
Rule 2 confirmed to cover the research dossier too: dossier claims now
render as a structured list (subject, support warning, angled claims,
note), never raw JSON. Audition answers were already prose.

Enforcement note (2026-11-02): AI-drafted profiles are stored as clean
JSON (model instructed JSON-only, server strips code fences); the UI
parses with a prose fallback and never renders raw JSON or code.
