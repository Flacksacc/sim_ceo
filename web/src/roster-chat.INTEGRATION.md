# Roster chat integration (for the central App.tsx integrator)

No App.tsx edits are in this branch. Wire-up is two steps below.

## 1. Mount the roster chat panel (roster detail only)

In `web/src/App.tsx`, inside the `tab === "roster"` selected-advisor card
(after the Research dossier block, ~line 6807 `<DossierView raw={dossier} />`),
add:

```tsx
import { RosterChatPanel } from "./roster-chat";

// inside the selRow card, after <DossierView raw={dossier} />:
{selRow && (
  <RosterChatPanel
    rosterId={selRow.entry.id}
    accountId={accountId}
    advisorName={selRow.entry.name}
    rosterVersion={selRow.entry.version}
    complete={selRow.complete}
    missing={selRow.missing}
    canChat={canActMeeting}
    api={{ post }}
  />
)}
```

Rules the mount preserves:
- The panel renders ONLY from selecting an advisor in My Advisor Roster
  (`selRow`). It takes no board id and sends no board context.
- `api={{ post }}` reuses the app authed transport (identity-safe).
- Drafts are keyed `roster-chat-draft:{accountId}:{rosterId}` in localStorage;
  switching advisors never shows another advisor`s draft.
- Audition (`Run audition` -> POST /api/auditions) stays as the stateless
  preview; the roster chat panel is the direct-conversation path. Both are
  stateless (`stored: false`): no saved-chat vs preview split exists in data,
  so no migration or legacy-history merge is needed. Legacy board-level
  `chatHist` state was ephemeral and is discarded with the removed block.

## 2. Remove the board-level advisor chat entry point

Delete this block in `web/src/App.tsx` (~lines 6934-6966, the
`Chat directly with an advisor` card inside the board advisors view),
including its `chatAdv` select:

```tsx
<div className="card">
  <h3>Chat directly with an advisor</h3>
  ... select value={chatAdv} ... chatHist ... sendChat ...
</div>
```

Board group messages are untouched. Also removable as dead code after the
block is gone: `chatAdv/setChatAdv`, `chatMsg/setChatMsg`,
`chatHist/setChatHist`, `chatBusy/setChatBusy`, `chatErr/setChatErr`,
`chatSelAdvisor/chatBlocked`, `sendChat`, and the `setChat*` resets in the
board-switch reset (~lines 1109-1112).

## 3. Server wiring (one line, owned by integrator)

New file `server/SimCEO.Api/Work/RosterChatEndpoints.cs` adds
`POST /api/roster/{id}/chat` (account-authorized via
`RosterEndpoints.CanReadRoster`, canonical roster `ProfileJson` at the
current `Version`, no board id/context). To serve it, add ONE line in
`server/SimCEO.Api/Work/Endpoints.cs` inside `MapExtended`, after
`app.MapRoster();`:

```csharp
app.MapRosterChat();
```

This branch does NOT edit `Endpoints.cs`, `RosterEndpoints.cs`, or
`Program.cs` (shared with parallel worktrees).