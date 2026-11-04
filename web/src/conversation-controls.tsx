import { AdvisorSummary } from "./advisor-summary";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

// Unified conversation controls for the Sim CEO meeting room.
// Presentational + local dialog behavior only: App.tsx owns all data
// fetching, SignalR, auth, permissions, and server mutations. This file
// defines the user mental model (meeting lifecycle vs requesting advisor
// responses) and the layout pieces the integrator wires to existing
// handlers.
//
// Mental model (show these two groups, never mix them):
//   1. Meeting lifecycle: open/create/pause/resume/end + settings.
//      Labels: "New meeting", "Meeting settings", "Pause meeting",
//      "Resume meeting", "End discussion".
//      Creating a meeting only opens a new separate conversation; it never
//      asks advisors anything and never invokes a model.
//   2. Advisor work: ONE primary action "Request advisor responses".
//      It never fires implicitly; it is disabled until a brief exists,
//      the meeting is open, and the caller may discuss. While running it
//      shows "Advisors drafting...".

export type MeetingLifecycleState =
  | "AwaitingBrief" | "Active" | "Yielded" | "Paused"
  | "WrappingUp" | "ClosedWithRecord" | "ClosedWithoutPublication" | string;

export function isMeetingOpen(state: MeetingLifecycleState | number): boolean {
  if (typeof state === "number") return state === 0 || state === 1 || state === 2;
  return state === "AwaitingBrief" || state === "Active" || state === "Yielded";
}
export function meetingStateLabel(state: MeetingLifecycleState | number): string {
  if (typeof state === "number") {
    return ["Awaiting brief", "Active", "Yielded", "Paused", "Wrapping up",
      "Awaiting record decision", "Closed with record", "Closed without publication"][state] ?? String(state);
  }
  return String(state).replace(/([a-z])([A-Z])/g, "$1 $2");
}

export interface ParticipantPick { id: string; role: string; description?: string; portraitUrl?: string | null; included: boolean; locked?: boolean; }

export interface LifecycleProps {
  meetingTitle: string;
  meetingBrief: string;
  stateLabel: string;
  live: boolean;
  messageCount: number | null;
  canManageMeeting: boolean;
  canDiscussMeeting: boolean;
  pauseAvailable: boolean;
  resumeAvailable: boolean;
  endAvailable: boolean;
  briefReady: boolean;
  requestPending: boolean;
  requestAvailable: boolean;
  onRename?: (title: string) => Promise<void>;
  onOpenSettings: () => void;
  onPause: () => void;
  onResume: () => void;
  onEnd: () => void;
  onRequestResponses: () => void;
}

// Single conversation header: lifecycle + the ONE advisor-request action.
// Integrator: replace the current .meet-head .meetctl button cluster with
// <ConversationHeader {...} />. Keep pause/resume/end permission gating
// exactly as today (canManageMeeting + state checks); the request button
// is gated on the dedicated requestAvailable flag (discuss capability +
// brief + open meeting), never on the lifecycle endAvailable flag.
export function ConversationHeader(p: LifecycleProps) {
  const requestDisabled = p.requestPending || !p.requestAvailable;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(p.meetingTitle);
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState("");
  useEffect(() => { if (!p.canManageMeeting) setEditing(false); }, [p.canManageMeeting]);
  const cancelRename = () => { setEditing(false); setRenameError(""); };
  const rename = async () => {
    if (!title.trim() || saving || !p.onRename || !p.canManageMeeting) return;
    setSaving(true); setRenameError("");
    try { await p.onRename(title.trim()); setEditing(false); }
    catch { setRenameError("Could not save the meeting name. Your changes are still here; try again."); }
    finally { setSaving(false); }
  };
  return (
    <div className="conv-head">
      <div className="conv-title">
        <div className="eyebrow">Discussion</div>
        {editing ? <form className="conv-title-editor" onSubmit={e => { e.preventDefault(); void rename(); }}>
          <label>Meeting name<input autoFocus value={title} disabled={saving} onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === "Escape" && !saving) { e.preventDefault(); cancelRename(); } }} /></label>
          <div className="meetctl"><button type="submit" disabled={!title.trim() || saving}>{saving ? "Saving…" : "Save name"}</button>
            <button type="button" className="btn ghost" disabled={saving} onClick={cancelRename}>Cancel</button></div>
          {renameError && <p role="alert">{renameError}</p>}
        </form> : <div className="conv-title-row"><h2>{p.meetingTitle || "Meeting"}</h2>
          {p.canManageMeeting && p.onRename && <button type="button" className="btn ghost" onClick={() => { setTitle(p.meetingTitle); setRenameError(""); setEditing(true); }}>Rename meeting</button>}
        </div>}
        {p.meetingBrief && <p className="muted conv-brief">{p.meetingBrief}</p>}
        <p role="status" className="status-line conv-status">
          <span className="badge">{p.stateLabel}</span>
          {p.messageCount != null && <span>{p.messageCount} messages</span>}
          {p.live && <span className="badge live">live</span>}
          {p.requestPending && <span className="badge live">Advisors drafting...</span>}
        </p>
      </div>
      <div className="conv-actions" role="group" aria-label="Meeting and advisor controls">
        <div className="conv-group" role="group" aria-label="Meeting lifecycle">
          <button type="button" className="btn ghost" onClick={p.onOpenSettings}>Meeting settings</button>
          {p.canManageMeeting && (
            <>
              <button type="button" onClick={p.onPause} disabled={!p.pauseAvailable}
                title={p.pauseAvailable ? undefined : "Pause is available while the meeting is Active"}>Pause meeting</button>
              <button type="button" onClick={p.onResume} disabled={!p.resumeAvailable}
                title={p.resumeAvailable ? undefined : "Resume is available while the meeting is Paused"}>Resume meeting</button>
              <button type="button" onClick={p.onEnd} disabled={!p.endAvailable}>End discussion</button>
            </>
          )}
        </div>
        <div className="conv-group conv-request" role="group" aria-label="Advisor responses">
          <button type="button" className="primary" onClick={p.onRequestResponses}
            disabled={requestDisabled}
            title={!p.briefReady ? "Add a brief before requesting advisor responses" : (!p.canDiscussMeeting ? "Discuss access is required" : undefined)}>
            {p.requestPending ? "Advisors drafting..." : "Request advisor responses"}
          </button>
          {!p.briefReady && <span className="muted conv-hint">A brief is required before advisors respond.</span>}
          <span className="muted conv-hint">Asks the advisors in the current meeting to respond. Nothing runs until you press this.</span>
        </div>
      </div>
    </div>
  );
}

export interface SettingsProps {
  open: boolean;
  title: string;
  brief: string;
  policy: string;
  participants: ParticipantPick[];
  canManageMeeting: boolean;
  meetingSelected: boolean;
  meetingOpen: boolean;
  meetingClosed: boolean;
  onClose: () => void;
  onTitle: (v: string) => void;
  onBrief: (v: string) => void;
  onPolicy: (v: string) => void;
  onToggleParticipant: (id: string) => void;
  onSelectAll: () => void;
  onSave: () => void;
  onCloseWithRecord: () => void;
  onCloseWithoutPublication: () => void;
  onReopen: () => void;
  children?: ReactNode;
}

// Meeting settings dialog: owns participants / allowed advisors / title /
// brief / policy that used to live in the removed left control block.
// Rendered as a native modal dialog: Escape dismisses, focus moves inside on
// open and returns to the invoking control on close, and the top layer
// contains tab order while open. Close/reopen actions are gated on valid
// meeting state as well as permission; save requires a selected meeting.
export function MeetingSettingsDialog(p: SettingsProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const triggerRef = useRef<Element | null>(null);
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (p.open) {
      try {
        triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      } catch { triggerRef.current = null; }
      if (!el.open) {
        try { el.showModal(); } catch { /* already open */ }
      }
      const first = el.querySelector<HTMLElement>("textarea, input, select, button");
      try { first?.focus(); } catch { /* noop */ }
    } else {
      if (el.open) {
        try { el.close(); } catch { /* noop */ }
      }
      const t = triggerRef.current;
      if (t instanceof HTMLElement) {
        try { t.focus(); } catch { /* noop */ }
        triggerRef.current = null;
      }
    }
  }, [p.open]);
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onCancel = (e: Event) => { e.preventDefault(); p.onClose(); };
    const onClick = (e: MouseEvent) => { if (e.target === el) p.onClose(); };
    el.addEventListener("cancel", onCancel);
    el.addEventListener("click", onClick as EventListener);
    return () => {
      el.removeEventListener("cancel", onCancel);
      el.removeEventListener("click", onClick as EventListener);
    };
  }, [p.onClose]);
  const saveEnabled = p.canManageMeeting && p.meetingSelected;
  const closeEnabled = p.canManageMeeting && p.meetingOpen;
  const reopenEnabled = p.canManageMeeting && p.meetingClosed;
  return (
    <dialog ref={dialogRef} className="conv-settings" aria-labelledby="conv-settings-title" onClose={p.onClose}>
      <section aria-label="Meeting settings">
        <h3 id="conv-settings-title">Meeting settings</h3>
        <p className="muted">Participants, brief, and discussion rules for this meeting. Closing a meeting archives it; reopening keeps history intact.</p>
        {!p.canManageMeeting && (
          <p className="muted" role="note">Read-only: you can view this meeting&apos;s settings but only a board manager can change them.</p>
        )}
        <label>Title
          <input value={p.title} onChange={(e) => p.onTitle(e.target.value)} disabled={!p.canManageMeeting} aria-label="Meeting title" />
        </label>
        <label>Brief (required before advisor responses)
          <textarea value={p.brief} onChange={(e) => p.onBrief(e.target.value)} disabled={!p.canManageMeeting} rows={4} aria-label="Meeting brief" placeholder="What should the advisors respond to?" />
        </label>
        <label>Discussion policy
          <select value={p.policy} onChange={(e) => p.onPolicy(e.target.value)} disabled={!p.canManageMeeting} aria-label="Discussion policy">
            <option value="focused">Focused (3,2 - max 5)</option>
            <option value="balanced">Balanced (4,4,2 - max 10)</option>
            <option value="open">Open (4s - max 10)</option>
          </select>
        </label>
        <fieldset className="conv-picks">
          <legend>Allowed advisors for this meeting (all when untouched)</legend>
          {p.participants.map((a) => (
            <label key={a.id} className="checkline advisor-member-choice">
              <input type="checkbox" checked={a.included} disabled={!p.canManageMeeting || a.locked === true} title={a.locked === true ? "At least one advisor stays included — an empty list would silently mean everyone. Use Include everyone below to reopen the meeting to all." : undefined} onChange={() => p.onToggleParticipant(a.id)} /> <AdvisorSummary name={a.role} description={a.description} portraitUrl={a.portraitUrl} />
            </label>
          ))}
          <div className="meetctl">
            <button type="button" onClick={p.onSelectAll} disabled={!p.canManageMeeting}>Include everyone</button>
          </div>
          {p.participants.length > 0 && p.participants.every((a) => a.included) && (
            <p className="muted" role="note">No restrictions: every board advisor may respond. Uncheck anyone to limit this meeting to the rest.</p>
          )}
        </fieldset>
        {p.children != null && (
          <div className="conv-decisions">
            <h4>Decisions &amp; evidence</h4>
            <p className="muted">Provisional material for this meeting: key takeaways, options, the decision draft, and cited evidence. Review and approval controls stay here with their permissions; nothing is decided by discussion alone.</p>
            {p.children}
          </div>
        )}
        <div className="meetctl">
          <button type="button" onClick={p.onSave} disabled={!saveEnabled}>Save title + brief</button>
          <button type="button" onClick={p.onCloseWithRecord} disabled={!closeEnabled}
            title={closeEnabled ? undefined : "Closing is available while the meeting is open"}>Close with record</button>
          <button type="button" onClick={p.onCloseWithoutPublication} disabled={!closeEnabled}
            title={closeEnabled ? undefined : "Closing is available while the meeting is open"}>Close without publication</button>
          <button type="button" onClick={p.onReopen} disabled={!reopenEnabled}
            title={reopenEnabled ? undefined : "Reopening is available for closed meetings"}>Reopen (history intact)</button>
          <button type="button" className="btn ghost" onClick={p.onClose}>Done</button>
        </div>
      </section>
    </dialog>
  );
}

export interface SearchProps {
  value: string;
  onChange: (v: string) => void;
  onSearch: () => void;
  resultCount: number | null;
}

// Search sits DIRECTLY above the message list (never below the composer).
export function ConversationSearchField(p: SearchProps) {
  return (
    <form className="conv-search" role="search" aria-label="Search this conversation"
      onSubmit={(e) => { e.preventDefault(); p.onSearch(); }}>
      <input aria-label="Search messages" value={p.value} onChange={(e) => p.onChange(e.target.value)} placeholder="Search this conversation" />
      <button type="submit">Search</button>
      {p.resultCount != null && <span className="muted" role="status">{p.resultCount} matches</span>}
    </form>
  );
}

// Narrow helper for the integrator: which legacy labels map where.
// "Start meeting" -> ConversationHeader "New meeting" (lifecycle group).
// "Run discussion" -> "Request advisor responses" (advisor group, single).
// "Pause"/"Resume"/"End discussion" stay but gain explicit nouns.
// "Meeting setup" details + advisor checkbox card -> MeetingSettingsDialog.
// Bottom "Search this conversation" details -> ConversationSearchField above messages.
export function useConversationSettings(initial = false) {
  const [open, setOpen] = useState(initial);
  return { open, openSettings: () => setOpen(true), closeSettings: () => setOpen(false) };
}
