# SimCEO messaging interface concepts

Fifteen generated visual explorations based on the [boardroom design schematic](../../DESIGN.md). These are concept images with illustrative content, not screenshots of the running app. Text, data, sources, stance labels, and approval states in the images are mockups; verify them during implementation.

| # | Concept | Messaging idea |
|---|---|---|
| 1 | [Warm editorial](01-warm-editorial.png) | Paper-like conversation with compact advisor rows and a calm context rail. |
| 2 | [Midnight command center](02-midnight-command-center.png) | Dark, high-contrast workspace with a live roster and source chips. |
| 3 | [Executive memo](03-executive-memo.png) | Long-form advisor analysis with clear takeaways and a prominent decision draft. |
| 4 | [Debate comparison](04-debate-comparison.png) | Opposing recommendations side by side, followed by threaded discussion. |
| 5 | [Mobile boardroom](05-mobile-boardroom.png) | One-column advisor replies with mobile topic navigation and a fixed composer. |
| 6 | [Deep thread](06-deep-thread.png) | Parent recommendation remains visible beside detailed debate and sources. |
| 7 | [Meeting timeline](07-meeting-timeline.png) | Rounds and follow-ups arranged as a chronological meeting record. |
| 8 | [Minimal monochrome](08-minimal-monochrome.png) | Dense but restrained message list with expandable support and citations. |
| 9 | [Decision triage](09-decision-triage.png) | Stance labels, directed participation, and a pending CEO choice. |
| 10 | [Analytical cockpit](10-analytical-cockpit.png) | Multi-round, high-density discussion with source and agent-progress rails. |

## Concept 10 refinements

The user selected **10** as the baseline for the messaging interface. These five refinements keep its board-member roster, nested advisor replies, stance tags, document summaries, provisional proposal, and bottom composer while reducing visual clutter. Advisor messages stay on the left; the CEO's messages move to the right.

| # | Refinement | Theme | Distinct emphasis |
|---|---|---|---|
| 11 | [Calm boardroom](11-calm-light-boardroom.png) | Light | Spacious left-aligned advisors and a right-aligned CEO response. |
| 12 | [Calm boardroom](12-calm-dark-boardroom.png) | Dark | Clear CEO question, advisor replies, and a compact nested risk response. |
| 13 | [Conversation first](13-conversation-first-light.png) | Light | Wider chat and two CEO turns framing the conversation. |
| 14 | [Roster first](14-calm-dark-roster.png) | Dark | Strong board-member list and minimal untimed topic navigation. |
| 15 | [Evidence forward](15-evidence-forward-light.png) | Light | Source links directly beneath advisor messages. |

These concepts intentionally remove meeting clocks, per-topic time windows, round headings, and advisor progress. Some generated labels or document metadata may still contain incidental dates or imperfect wording; they are visual examples, not content specifications.

The selected implementation direction is documented in the [concept 12 messaging interface specification](12-messaging-interface-spec.md).
