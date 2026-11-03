# Sim CEO product context

Latest advisor direction (2026-11-03): [Advisor character and meeting behavior](docs/advisor-character-behavior.md) governs the current advisor work. Use one research-and-edit flow, three short character-based paragraphs, canonical roster membership and edits, roster-only direct chat, and character-aware meeting selection and answers. This supersedes older fixed-tone controls and independent board profile copies. Implementation is still being verified; the specification does not establish deployment.

Sim CEO is a web workspace for creating advisory boards, holding continuing meetings, and turning discussion into owner-approved, traceable decisions. One account may own multiple isolated boards. Each board may have many meetings and at most ten attached advisors; the account Advisor Roster is unlimited. The board lead can type or dictate, edit the transcript before sending, address the board, a specific advisor, or the secretary, and inspect sources. Advisors and the secretary reply in text.

The primary audience is a person making business or personal decisions with a panel of AI advisors. The interface must help the lead compare recommendations, spot disagreement, understand what evidence was used, and decide what becomes part of the durable record. Provisional messages and draft decisions must remain visibly distinct from approved records. Board-specific context never crosses to another board through a reusable roster profile.

The canonical feature and trust specification is [sim-ceo-product-overview.md](sim-ceo-product-overview.md). The current React/Vite app is an early implementation; this project's design preview is an isolated template, not a live board or an approval workflow.

Evidence for the conversation design is documented in [docs/ui-references/README.md](docs/ui-references/README.md).

## Source governance (phase 6)

Board evidence lives in versioned source documents. Every version carries an explicit review decision (pending, approved, rejected) plus a separate temporary exclusion; new uploads and re-uploads always start pending and only explicit review transitions change the decision. Rejected versions are never auto-approved; approving an older version after a newer approval is rejected as superseded. Each board/scope/meeting/origin/file family keeps a durable promoted head: excluding, revoking, or moving the current version never revives an older version, and moving a version into an occupied family is rejected.

Only currently eligible sources supply evidence: approved, not excluded, head-pinned, policy-allowed, scope-valid, and backed by persisted index sections that match the exact source, version, content hash, and generation. There is no raw-text fallback. Board policy is allow-all with blocked extensions or wiki-only; policy, exclusion, scope, and review changes pause affected active meetings, bump their generation, and are rechecked at publication so revoked evidence is never published. Briefings capture the evidence fingerprint before generation and discard the draft when it changes. Unresolvable or out-of-scope recall hits are dropped, and caller-supplied quotations are verified against stored sections before they are kept.

The Resources and Inbox tab is the review inbox: uploads enter as pending with one request per file, meeting uploads require a chosen meeting, existing versions can move scope with clear pending-review effects, and review (approve/reject), exclusion, policy, reindex status, and exact section excerpts read as distinct concepts.

## Wiki connector resources (phase 7)

Board evidence may also come from a read-only Wiki.js 2.x GraphQL connector. Each resource pins a board (or one valid meeting), an origin-only Base URL, path allow/exclude rules, exact locale, and all-required tags. Resources are explicitly disabled by default; enabling, rule edits, manual sync, and scheduled sync run one bounded single-flight sync that imports new or revised pages only as pending review. Only the current successful sync's rule-allowed pages are usable evidence; failed, disabled, or stale resources block cached connector evidence without deleting history. The Resources and Inbox tab shows Wiki.js 2.x read-only status, sync state, and actionable errors; credentials are server-held and never shown. Deleting a connector preserves its imported rows as detached evidence; backups record known-deleted connector IDs so restores stay exact and still reject any other dangling graph.
