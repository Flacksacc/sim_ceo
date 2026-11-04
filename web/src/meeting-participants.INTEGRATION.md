# Meeting participants integration (for the central App.tsx integrator)

No App.tsx edits in this branch. Wire-up below. Component files:
`web/src/meeting-participants.tsx` + `web/src/meeting-participants.css`
(presentational only: zero API calls, zero timers, zero SignalR).

## 1. Import CSS + component once

```tsx
import { MeetingParticipants, type MeetingParticipant } from "./meeting-participants";
import "./meeting-participants.css";
```

## 2. Build props from data the parent already owns

- `participants`: EVERY board seat for this meeting (included AND excluded),
  plus the secretary seat, in roster order. One entry per seat:
  - `key`: internal stable id (roster/board-advisor id; secretary e.g.
    `"secretary"`). Never rendered; used only as React key.
  - `displayName`: advisor display name, or `"Secretary"`.
  - `roleLabel?`: human role only (e.g. "Operations"). Never an id.
  - `portraitUrl`: the already-authorized accepted-image URL for the
    SELECTED portrait (`/api/images/{id}` authed blob URL the app already
    resolves), or null when absent. Component shows initials fallback, or a
    neutral "S" disc for the secretary. No generation, no invented URLs.
  - `activity`: the ACTUAL per-seat state from the activity snapshot/events
    (backend owner contract): one of `idle | queued | considering |
    responding | waiting-for-clarification | failed | excluded | pending`.
    Map excluded seats to `excluded`; do NOT mark approved-but-silent seats
    as responding; do NOT derive responding from any global pending flag.
    Secretary privacy: only reveal its private activity to the authorized
    requesting user (backend scopes it; render what the snapshot allows).
  - `isSecretary`: true only for the secretary seat.
- `live`: boolean the parent sets while its SignalR/poll subscription is
  connected. Label only.
- `heading?`: default "In this meeting".

## 3. Mount beside the conversation (desktop rail, narrow strip)

```tsx
<MeetingParticipants participants={presence} live={presenceLive} />
```

Place inside the meeting room layout next to the message list (desktop:
vertical rail; CSS collapses to a horizontal scroll strip under 760px).
Do NOT place inside Meeting settings. Decisions/Evidence move belongs to
the central owner.

## 4. Truthfulness rules the mount must preserve

- Badge + ring + human label reflect ONLY `activity`. `pending` ("Waiting
  for reply") and `responding` ("Responding") are distinct; approval is not
  activity.
- No ids or technical labels in user-visible text (keys stay in `key=`).
- `role="status"` line announces only derived counts ("2 of 6 responding
  or about to respond"), never model internals.

## Not wired (honest limits)

- No backend activity snapshot/routes here; parent + backend owner supply
  them. Until wired, pass the parent`s current per-seat knowledge with
  silent seats as `idle` (never `responding`).
- No Send/progress changes here (hotfix owner). No Decisions/Evidence move.
- Not yet rendered in App: this branch adds no App.tsx usage.

## 5. Backend vocabulary mapping (activity contract 2026-11-03)

The parent maps the backend snapshot to the component `activity` prop.
The component renders exactly what it is given and invents nothing.

Advisor entries (`discussion.advisors[].state`, exact `advisor.state` strings):

| Backend `advisor.state` | Component `activity` | Human label |
|---|---|---|
| `queued` | `queued` | Queued |
| (run started, advisor not yet bid) | `waiting-for-selection` | Waiting to be considered |
| `considering` | `considering` | Considering |
| `responding` | `responding` | Responding |
| (draft done, awaiting commit) | `waiting-for-publication` | Waiting for publication |
| `complete` | `complete` | Responded |
| `abstained` + reason (`bid-declined`, `abstained`, `cap-omitted`, `already-replied-this-turn`, `not-eligible`, `yielded`, `run-ended`) | `abstained` | Abstained |
| `failed` + reason (`provider-error`, `evidence-revoked`, `stale-profile`, `run-failed`) | `failed` | Response failed |
| run `interrupted` / reason `run-interrupted` on a non-terminal seat | `interrupted` | Interrupted |
| reason `reapproval-required` | `needs-approval` | Needs approval |
| seat excluded from this meeting | `excluded` | Not in this meeting |
| meeting-included seat with no entry in the current run | `idle` | Listening |
| lead posted, run not yet started, no finer state known | `pending` | Waiting for reply |

Secretary entries (`secretary[].status`, caller-owned only):

| Backend `secretary.status` | Component `activity` (recommended) |
|---|---|
| `pending` | `pending` |
| `inflight`, `answering` | `responding` (or `queued` before model start, if known) |
| `needs-clarification` | `waiting-for-clarification` |
| `completed` | `complete` |
| `failed` | `failed` |
| `discarded` | `abstained` |
| `interrupted` | `interrupted` |

Rules the parent must preserve:

- `pending` (Waiting for reply) is a run-level wait only and NEVER means
  approval is pending. Approval gates map to `needs-approval`.
- Never mark an approved-but-silent seat as `responding`, and never derive
  per-seat activity from any global pending flag.
- Discussion-level `interrupted` / `failed` must move affected non-terminal
  seats to `interrupted` (or their terminal state where known) so the rail
  never shows endless fictional activity. Restart recovery that marks
  in-memory runs interrupted flows through the same mapping.
- `waiting-for-selection` and `waiting-for-publication` render only when the
  snapshot (or a documented backend waiting state added during repair)
  provides them. Until then, meeting-included seats without run entries stay
  `idle`. The component never invents transitions.
- The aggregate line counts actual states only: `N members, M working.`
  when any seat is queued / waiting / considering / responding, otherwise the
  real per-status counts (for example `5 members: 2 responded, 1 sat out,
  2 not in this meeting.`). It never promises that queued seats will respond.
