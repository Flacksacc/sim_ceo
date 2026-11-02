# SimCEO messaging interface — concept 12 specification

**Status:** design and implementation specification, 2026-10-28  
**Visual baseline:** [12 · Calm dark boardroom](12-calm-dark-boardroom.png)  
**Product authority:** [SimCEO product overview](../../sim-ceo-product-overview.md) and [selected design direction](../../DESIGN.md)  
**Scope:** the meeting conversation screen, not the complete board setup or records workflow.

Concept 12 is a visual direction, not a literal screen to reproduce. Its mock dates, content, and advisor claims are placeholders. The implementation must follow SimCEO's board isolation, source approval, access control, and owner-approved decision rules.

## 1. Screen structure

```text
┌──────────────────────┬─────────────────────────────────────────────┬────────────────────────┐
│ Board + meeting      │ Meeting title and state                     │ Source excerpts        │
│ Untimed topic list   │                                             │ Document summaries     │
│                      │ CEO messages                 → right        │                        │
│ Board members        │ ← advisor messages and nested replies       │ Provisional proposal   │
│ Name + role          │ Stance tags and cited evidence             │ Review status          │
│                      │                                             │                        │
│                      │ Recipient · mic · editable text · Send     │                        │
└──────────────────────┴─────────────────────────────────────────────┴────────────────────────┘
```

Desktop uses three independently scrollable regions: left navigation, center conversation, right context. The header and composer remain visible while only the message list scrolls. Give the conversation the most width. At tablet width, collapse the left rail to a button and turn the right rail into a drawer. On phones, show one conversation column; topic, roster, documents, and proposal open as focused sheets. Keep the board, meeting, recipient, mic, and Send action visible without horizontal scrolling. Size-based [CSS container queries](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40container) may adapt message internals when the center pane changes width; viewport media queries still control the overall shell.

Use the dark palette in concept 12: ink-charcoal navigation, a slightly lighter conversation surface, warm white text, restrained amber for the active topic and primary action, sage for agreement, and muted rust for disagreement or risk. Use color **with text**, never color alone. Avoid nested cards around every row; spacing and subtle separators carry most of the hierarchy. Light theme can reuse the same layout and semantic tokens.

## 2. UI elements and actions

| Element | Visible content | Click, keyboard, and state behavior |
|---|---|---|
| Board identity | Current board name and board role at upper left. | Opens the board switcher. Switching boards saves the current unsent draft and closes board-specific drawers. Do not show another board's messages or sources during transition. |
| Meeting heading | Meeting title, short purpose, and a small `Active`, `Paused`, or `Closed` label. | Heading opens meeting details. Pause/resume actions appear in a compact actions menu. Do not show a countdown or agenda time windows. |
| Topic list | Short, untimed labels such as `Pricing strategy`, `Operations`, `Decision`. Active item uses an amber marker. | Selects the conversation focus without clearing the draft. Topic labels are navigation, not separate timed sessions. On narrow screens, expose them in a picker. |
| Board-member roster | Up to 10 attached advisors plus the board lead. Avatar or initials, name, board-specific role, optional real availability state. | Selecting a member opens a profile/capability sheet. An advisor can also be selected as the composer recipient. The account-level Advisor Roster is a different destination and must not be confused with these board copies. |
| Conversation heading | `Discussion` plus topic or meeting context. | Allows search within the meeting. Keep controls compact; do not add visible round headings or an advisor-progress panel. Internal rounds may still drive orchestration. |
| CEO message | Right-aligned, modest tinted bubble; `You` and the current lead role. | Selecting opens actions such as copy, quote, or inspect details. Own pending and failed sends have inline status. The visible sequence remains chronological. |
| Advisor message | Left-aligned avatar, name, role, recommendation-first text. | Message action row offers reply, copy, expand reasoning, and open citations. Long reasoning starts collapsed. The advisor's identity remains stable even if the roster profile is later edited. |
| Reply connector | Indented message immediately below its parent, with a subtle connector and a label such as `Replying to Priya`. | Clicking the parent reference scrolls to and briefly highlights the parent. If the parent is outside the loaded window, fetch its surrounding messages. Preserve the actual parent ID; visual indentation alone is insufficient. |
| Stance tag | Short text: `Agrees`, `Disagrees`, `Raises risk`, `Proposes alternative`, or no tag. | Hover/focus may explain what the tag refers to. Tags must match the reply's content and target, be editable/correctable where AI assigned, and never be inferred from color. They are a summary, not a vote or an approved decision. |
| Evidence link | Source title and optional page/section under an advisor claim. | Opens a source excerpt beside the conversation with document scope, version, approval state, and cited passage. A removed or excluded source must be labeled stale and must not be presented as current evidence. |
| Source-excerpts panel | Two or three compact approved document summaries by default; `View all` opens the full list. | Selecting a document opens its relevant excerpt, not merely the file cover. Lazy-load previews and larger images. Keep the source list independent of message scrolling. |
| Provisional proposal | Proposed direction, author/source of draft, unresolved conditions, `Provisional` state. | Opens a review flow in Records. `Draft`, `Revise`, or `Open review` may be offered here; **Approve** requires the existing explicit owner review endpoint and permission checks. Never make a message or transcript implicitly approve it. |
| Recipient control | `Message to Everyone`, one advisor, or `Secretary`, with board and meeting scope close to the composer. | Changing recipient affects the next send only; it does not erase draft text. The chosen recipient is included in the request and shown in the pending message. |
| Composer | Auto-growing text field, attachment control, mic icon, and Send button, pinned below the message list. | Enter sends; Shift+Enter inserts a newline. Send is disabled for empty/whitespace-only text, during a non-retryable send, or without permission. Keep the field editable during advisor activity. |
| Mic button | Recognizable microphone icon with label/tooltip `Record message`; active state shows `Stop recording`. | Click or keyboard activation starts/stops capture. It transcribes into the editable composer. The user reviews and explicitly sends the text. Do not send on stop. |
| New-responses chip | `3 new responses` when messages arrive while the reader is above the bottom. | Clicking jumps to the newest committed message and restores follow mode. Do not move the scroll position before that click. |

The right rail may show a concise pending activity line such as `Amara is reviewing sources` only when that state comes from a real event. No per-advisor progress bars, invented percentages, or permanent progress section.

## 3. Mouse, hover, and focus

- Hovering a message reveals its small action row without shifting message height. The same actions are reachable by keyboard focus and a persistent menu button on touch devices.
- Hovering a stance tag or source link gives a short explanation. Tooltips open after a brief delay and close on pointer leave or Escape; essential information is still in visible text.
- Hovering a roster member highlights the row; selection opens a profile sheet. It never sends a message by itself.
- Hovering a document row reveals `Open excerpt` and perhaps `More`; the whole row remains a clear target.
- The active topic and selected recipient use distinct selected states. Focus rings are visible on the dark surface and do not rely on color alone.
- The composer, mic, Send, and proposal controls have comfortable pointer/touch targets. No required action exists only on hover.

Follow [WAI keyboard focus guidance](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/): focus order follows visual/reading order; after closing a sheet or dialog, focus returns to its invoking control. Use standard accessible dialog, tab, and menu patterns rather than custom key behavior for every widget.

## 4. Motion and animation

Motion should explain state changes without making the message list feel restless. Respect [`prefers-reduced-motion`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40media/prefers-reduced-motion); under reduced motion, use immediate state changes and retain all labels.

| Event | Motion |
|---|---|
| New committed message at the bottom | One short opacity fade (about 120–180 ms). Avoid sliding older messages or animating the entire list. |
| CEO send | Render a stable-height pending bubble on the right immediately. Replace its status in place when the server acknowledges; show a retry action in place if it fails. |
| Advisor generation | A single compact activity line may pulse softly while real work is underway. Stream text into one reserved message area; update in batches. Finish by removing the temporary status and committing the final message without a large layout jump. |
| Reply parent jump | Scroll to the parent and briefly tint its background, then clear the tint. No bouncing or repeated flash. |
| Context drawer | Fade in the backdrop and translate the drawer over roughly 160–220 ms. Restore focus on close. |
| Reasoning expansion | Expand only the selected message; measure its new height for virtualization and preserve the reader's anchor. Keep animation short or immediate if it risks scroll instability. |
| Mic state | Change icon/label to `Stop recording`, display a clear recording indicator and elapsed recording time **inside the mic control only** if useful. This is recording feedback, not a meeting timer. |

Use CSS transitions on opacity and transform where possible. Avoid continuous glows, bouncing, long skeleton animations, or simultaneous animations across many messages.

## 5. New messages and stable scrolling

1. The server assigns a monotonic sequence number within a meeting. Render messages ordered by that sequence; preserve reply parent IDs and event IDs.
2. On the CEO's Send action, show one optimistic right-side item with a temporary client ID and `Sending` status. On acknowledgment, replace it with the server ID/sequence. Use an idempotency key so a retry or reconnect cannot duplicate it.
3. Advisor events arrive over the meeting's SignalR group. Deduplicate by server event/message ID. A committed event inserts or updates one item in the message cache; do not refetch the full history for every event.
4. If the reader is within a small threshold of the bottom and has not selected older content, follow new committed messages. Otherwise preserve the first visible message and offset, increment the `New responses` chip, and leave scroll untouched.
5. A direct reply remains immediately beneath its parent in the visible conversation, with a connector and target label. If strict chronology and nesting conflict, keep a single authoritative sequence in the data and derive a display tree that preserves understandable order; a link always resolves to the actual target. Do not silently reparent replies to make the visual layout convenient.
6. On reconnect, rejoin the meeting group, request all events after the last committed sequence, then reconcile by ID. Show `Reconnecting` inline; preserve the draft. SignalR automatic reconnect is opt-in and requires client handling of the reconnected state ([Microsoft documentation](https://learn.microsoft.com/en-us/aspnet/core/signalr/javascript-client?view=aspnetcore-10.0)).
7. If a message is edited, removed, or made inaccessible, update that item without replacing the entire list. A referenced parent that is no longer available gets a truthful `Original message unavailable` marker.

## 6. Keyboard and composer contract

| Shortcut | Result |
|---|---|
| **Enter** in the composer | Send the trimmed draft to the visibly selected recipient. Do nothing if empty, composing with an IME, recording is stopping, or Send is already pending. |
| **Shift+Enter** in the composer | Insert a newline. |
| **Ctrl+Enter / Cmd+Enter** in the composer | Also send, for users accustomed to that shortcut. |
| **Escape** | Close the open menu, tooltip, or sheet; cancel a pending recipient picker. Never discard a draft without confirmation. |
| **Ctrl+K / Cmd+K** | Open meeting search or command navigation, unless a modal already owns the shortcut. |
| **Tab / Shift+Tab** | Move through recipient, attachment, mic, text field, and Send in a predictable order. |

Implement Enter handling on the composer element, not a global key listener. Check `KeyboardEvent.isComposing` and the composition lifecycle so Enter used to confirm Asian-language text does not send. Prevent the browser's default newline only when a send is actually allowed. Maintain a visible keyboard hint near the composer. Do not hijack Enter inside menus, dialogs, source search, or other inputs. The current app sends with Ctrl/Cmd+Enter; concept 12 requires the new Enter/Shift+Enter behavior.

The draft is keyed by board **and** meeting (and optionally topic), stored locally for recovery, and cleared only after the server accepts the send. Recipient changes, drawer opening, connection loss, and voice transcription do not erase it. Avoid persisting sensitive draft text beyond the user's intended local recovery policy.

## 7. Microphone and transcription flow

1. Mic button has an accessible name (`Record message`), a visible microphone glyph, and text on hover/focus. Ask for microphone permission only after activation.
2. On grant, show a clear recording state and a large `Stop` target. Allow cancel; cancellation discards the captured audio and leaves the original draft intact. If permission is denied or no device exists, keep typing available and show a targeted explanation.
3. Capture via browser [`getUserMedia`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) and [`MediaRecorder`](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder). `getUserMedia` needs a secure context and user permission. Detect supported MIME type instead of assuming WebM works everywhere. Stop media tracks on completion, cancel, unmount, or error.
4. Upload bounded audio chunks or the final blob to SimCEO's transcription endpoint backed by Muse Voice Transcribe. Show `Transcribing`; do not put partial speech into the meeting thread. When the final transcript arrives, insert it at the cursor or append with a separator to the draft, then focus the editor for correction.
5. The user edits the transcript and presses Enter or Send. The transcript is a normal message draft; it cannot approve a decision, grant access, or silently invoke an advisor. Respect the board's audio-retention setting.
6. On upload or transcription failure, retain the editable typed draft and offer `Retry transcription` if the recorded blob remains available under the retention policy. Never imply that speech was sent when only a transcript draft exists.

The current web app already records microphone audio and puts the returned transcript into the draft. Its current implementation uses a single final upload and a stub-backed service; live partial transcription, robust recovery, MIME negotiation, and real Muse integration are further work.

## 8. Performance architecture for thousands of messages

**Rendering:** Use the existing `@tanstack/react-virtual` adapter to render only visible message rows plus a small overscan. A 10,000-message meeting should not create 10,000 DOM message elements. Each message or reply group gets a stable key; estimate row height, then measure real height as text, citations, or reasoning expand. TanStack's [`measureElement`](https://tanstack.com/virtual/latest/docs/api/virtualizer) and scroll-position adjustment support variable-height items. Keep the composer and side rails outside the virtualized scroller.

**Data transfer:** Query the newest page first (for example 50–100 messages). Add a `beforeSequence` cursor endpoint for older pages, and `afterSequence` for reconnect catch-up. Use the existing `(meeting_id, sequence)` database index and a bounded page size; avoid offset-based deep scans. Search on the server and fetch a small window around a hit. A reply-target jump may fetch the parent window separately.

**Client cache:** Use TanStack Query v5 `useInfiniteQuery` with previous/next cursors and a measured `maxPages` limit so older pages do not accumulate forever in memory. On revisit, fetch evicted pages from the server. Keep a small bounded normalized map for currently visible messages and pending sends; do not copy all pages on every token. `maxPages` and bidirectional paging are documented by [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries).

**Streaming:** SignalR carries small event envelopes such as `message.created`, `message.updated`, and `run.state`, scoped to one meeting. Batch high-frequency text deltas into at most one UI commit per animation frame or a short interval; avoid a full conversation rerender for every token. Keep the active streaming item separate from immutable older rows. A completed reply becomes one committed item with server sequence, parent ID, and stance. This is an implementation recommendation; the current app mainly invalidates the latest-message query when SignalR says a message arrived.

**Scroll stability:** Before prepending older pages, capture the first visible sequence and pixel offset. After insertion and measurement, restore that anchor. Reserve image/avatar dimensions to prevent late layout shifts. When a row expands above the viewport, let the virtualizer adjust the scroll offset. `New responses` appears instead of automatic scrolling when the reader is browsing history.

**React work:** Separate memoized message rows from the composer and side rails. Pass stable primitive props and callbacks to rows; avoid putting the entire message array in a context that rerenders every child. Decode and sanitize rich text once per message revision, not per render. Lazy-load heavy document viewers, full portraits, and export screens. Use thumbnail dimensions and browser lazy loading for offscreen media. Debounce meeting search, and cancel obsolete requests via TanStack Query's `AbortSignal` ([query-function guidance](https://tanstack.com/query/latest/docs/framework/react/guides/query-functions)).

**Server work:** Persist messages durably with unique `(meeting_id, sequence)`, stable IDs, parent relationship, advisor identity/version, stance, and citation references. Enforce authorization and board scope on pages, search, source excerpts, and real-time delivery. Avoid sending full meeting history to agents: SimCEO's Context Curator already specifies bounded per-agent context packets. Keep the UI's 10,000-message requirement distinct from model context size.

**Measurements:** The product plan targets p75 LCP ≤ 2.5 s, INP ≤ 200 ms, and CLS ≤ 0.1, following [Core Web Vitals](https://web.dev/articles/vitals). Test a 10,000-message meeting on a midrange phone and desktop while loading older pages, opening reasoning, jumping to replies, searching, reconnecting, and transcribing. Record DOM row count, memory growth, network bytes, long tasks, and typing latency; tune page size and overscan from evidence rather than treating a library choice as proof of performance.

## 9. Current implementation gaps

This document describes the target. The current app at [App.tsx](../../web/src/App.tsx) and [Program.cs](../../server/SimCEO.Api/Program.cs) provides a starting point, not the finished concept-12 behavior:

- It virtualizes the latest message list, but the UI currently requests only the latest 60 and does not page backward. The API supports `after` but not a `before` cursor.
- It invalidates and refetches the latest-message query on SignalR events, with a four-second poll fallback. Delta reconciliation and reconnect catch-up are needed.
- The message entity currently lacks a stored `replyToMessageId`, stance, citation IDs, and immutable advisor profile version. Those must be added before the nested reply UI can be reliable.
- It currently sends with Ctrl/Cmd+Enter, has a single-line input, and lacks Enter-send/Shift+Enter newline behavior.
- The current mic records then transcribes into the draft, but lacks the full recovery and live-partial flow described above.
- The current demo/template and concept artwork are separate from the production conversation view. Do not represent this specification as already implemented.

The canonical plan mentions visible message times and round grouping. The user's selected concept-12 direction supersedes their **default visual presentation**: keep sequence, timestamps, and internal rounds in the data and audit view, while omitting clock labels and round bars from the ordinary conversation. Keep one compact truthful activity indication when useful; do not recreate the removed advisor-progress panel.

## 10. Acceptance criteria

- CEO messages appear on the right; all advisor and secretary messages appear on the left. A direct advisor reply appears beneath and links to its actual parent; stance wording matches its meaning.
- Board members, untimed topics, document summaries, provisional proposal, recipient, mic, and Send are easy to locate at desktop and phone widths.
- Enter sends, Shift+Enter inserts a newline, IME confirmation does not send, and voice transcription always lands in an editable unsent draft.
- Reading older messages is stable during live arrivals. The `New responses` control works; a failed send remains retryable without losing text.
- A 10,000-message meeting keeps a bounded DOM and cache; older-page loads, reply jumps, and source previews stay responsive on the representative devices in the product QA plan.
- Keyboard-only and screen-reader users can reach every message action, source, recipient choice, mic control, and proposal review. Test in both themes and with reduced motion.
- No message, stance tag, transcript, or proposal becomes an approved record without the authorized owner review action.
