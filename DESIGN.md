# Sim CEO boardroom design template

## Current meeting layout (2026-11-04)

The Boards navigation badge matches the board rows in the current Active,
Archived or All view. Board and roster creation actions sit below their
scrollable lists in a fixed footer, remaining visible when the lists overflow.
The separate New board button in the main board view is removed.

The 280px meeting team and attachment panel stays pinned on the right on desktop.
Advisors use ten fixed slots arranged in two rows of five, with 44px portraits;
unused slots show open seats. The Orchestrator and Secretary appear separately
below the ten advisor slots. Names, activity and hover descriptions remain
available. Long conversations scroll independently of the panel.

The full meeting header (name, brief, status and search) spans the conversation
and tools, and stays pinned above them. A ResizeObserver keeps the tools below
the current header height during resize or renaming. The duplicate sidebar brief
and its Hide/Show control are removed. Narrow layouts place tools below the pinned
header, retain the same two-row grid, and clear the phone toolbar.

Meeting settings lives next to the microphone in the composer. Its existing
command menu keeps keyboard navigation, focus return and viewport placement.
Orchestrator and Secretary use Muse-generated 3D cartoon avatars matching the
Sim CEO logo, rather than photographic people. Existing advisor portraits remain
unchanged. The schematic below is an older design reference.

## Layout schematic

```text
Desktop >= 1200 px
┌───────────────┬──────────────────────────────────────┬───────────────────┐
│ Board +       │ Meeting title · live state · actions │ Context           │
│ meetings      ├──────────────────────────────────────┤ Agenda            │
│               │ Topic tabs · decision focus          │ Advisor roster    │
│ Inbox         ├──────────────────────────────────────┤ Sources           │
│ Records       │ Round: lead question                 │ Draft decision    │
│               │  CFO → recommendation + evidence    │                   │
│               │  CMO → recommendation + response    │                   │
│               ├──────────────────────────────────────┤                   │
│               │ Recipient · text/voice · Send        │                   │
└───────────────┴──────────────────────────────────────┴───────────────────┘

Tablet: rail collapses; context opens as a drawer.
Phone: one focused conversation column; topic selector and context drawer; composer stays visible.
```

## Reference translation

| Reference | Image observation | Sim CEO pattern |
|---|---|---|
| Slack | Parent message remains visible while a side thread opens. | Keep a recommendation in the round; open detailed debate in a thread drawer. |
| Discord | Persistent channels and member roster make the room feel inhabited. | Show the attached board advisors, roles, and real activity state. |
| Zulip | Channel and topic names make parallel conversations legible. | Use agenda topics within a meeting; retain explicit topic on each round. |
| Teams | Recap gathers speakers, timeline, notes, and materials. | Close meetings into a reviewable recap with draft records and source links. |
| Telegram | Compact topic rail keeps mobile navigation close to the conversation. | Use a narrow topic strip and one-column mobile conversation. |
| Linear | Quiet dark surface, crisp type, and priority grouping reduce visual noise. | Use restrained color and a focused decisions inbox. |

## Information hierarchy

1. Always show the active board, meeting, topic, and recipient before Send.
2. Group responses by lead turn and discussion round; label advisor identity and role once per response.
3. Lead with a one-sentence recommendation; place reasoning and citations behind an explicit disclosure.
4. Make reply targets and disagreements visible. Preserve the original response when a detail thread opens.
5. Separate `Proposed`, `Approved`, and `Rejected` record states. Approval requires an explicit owner action.
6. Show only activity states backed by real events: queued, reviewing, responding, finished, failed.

## Selected messaging direction (2026-10-28)

Use [concept 10 and its five refinements](docs/ui-concepts/README.md) as the visual baseline for the conversation screen. Keep the left board-member roster, simple meeting/topic list, central message stream, right document summaries and provisional proposal, and bottom composer. Align the CEO's own messages to the right and all advisors' messages to the left. Nest an advisor's direct reply beneath its parent and mark the relationship with a short stance tag such as `Agrees`, `Disagrees`, `Raises risk`, or `Proposes alternative`. Make the tag match the actual content of the reply; generated concept text is not reliable enough to define behavior.

Reduce clutter: omit visible message timestamps by default, agenda time windows, meeting countdowns, round separators, and the advisor-progress panel. Preserve a coherent chronological order and provide metadata on demand where needed for audit or record review. Show only an actual current activity state if it helps the lead understand why a response is pending. Keep document summaries and proposed decisions visible, but never equate a proposal with an approved record.

## Visual system

Use a warm paper canvas, ink-navy navigation, subtle blue-gray dividers, and amber only for active meeting/decision emphasis. Each advisor gets an initials avatar and role label; portrait assets may replace initials only when the board selected them. Use a humanist sans for the UI, tabular numerals for timestamps and counts, and a serif accent only for large editorial headings. Comfortable and compact density share the same layout and interaction targets. Both light and dark themes must keep text and controls at WCAG 2.2 AA contrast.

## State and behavior contract

- Empty, loading, ready, queued, streaming, paused, failed, and access-denied states need distinct copy and actions.
- The composer draft is stored per meeting; changing topic or opening a drawer does not clear it.
- Voice transcript is editable in the same composer and is never an approval command.
- On new messages, preserve the reader's scroll position unless they are already at the bottom; show a `New responses` control otherwise.
- Keep older history paged and virtualized, measure variable-height rows, and batch stream updates. The current app already uses TanStack Virtual; the preview does not simulate a long history.
- Source cards include scope, version, approval state, and a direct path to the cited excerpt.
- The prototype uses mock data and local interactions. Its buttons never claim to publish real records or invoke advisors.

## Implementation mapping

The preview route is `/boardroom-template.html` in the Vite app. The current app has React 18, strict TypeScript, Vite 6, TanStack Query/Virtual, and SignalR. Integrate the template as components around the existing meeting APIs; do not replace server authorization, ordering, record approval, or source-scope rules with frontend state. Size-based CSS container queries can adapt the conversation column when the context pane is present. TanStack Virtual should measure expanded responses and restore scroll offsets when navigating. Monitor LCP, INP, and CLS for real board sessions.

Current platform guidance: [MDN container queries](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40container), [TanStack React Virtual](https://tanstack.com/virtual/latest/docs/framework/react/react-virtual), [TanStack measurement and restoration](https://tanstack.com/virtual/latest/docs/api/virtualizer), [web.dev Web Vitals](https://web.dev/articles/vitals).

## Acceptance checks for integration

- Desktop 1440×900, tablet 900×700, and phone 390×844: no horizontal overflow; Send and meeting identity remain visible.
- Light/dark and comfortable/compact; keyboard order, visible focus, screen-reader labels, reduced motion.
- Topic and recipient switches preserve the unsent draft. Paused and failed runs communicate recovery.
- New replies do not yank the reader; long history and roster remain responsive.
- A proposed decision cannot appear approved without the owner action; citations resolve to approved in-scope sources.
