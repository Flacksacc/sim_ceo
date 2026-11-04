import { createPortal } from "react-dom";
import { AdvisorSummary } from "./advisor-summary";
import { useEffect, useId, useRef, useState } from "react";
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
  controlsTarget?: HTMLElement | null;
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
  secretaryAvailable?: boolean;
  secretaryPending?: boolean;
  onSecretaryCommand?: (input: string) => boolean;
  onPrepareBriefing?: (topic: string) => boolean;
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [promptKind, setPromptKind] = useState<"secretary" | "briefing" | null>(null);
  const [commandText, setCommandText] = useState("");
  const menuId = useId();
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const positionMenu = () => {
      const button = menuButton.current;
      const menu = menuRoot.current?.querySelector<HTMLElement>('[role="menu"]');
      if (!button || !menu) return;
      const anchor = button.getBoundingClientRect();
      const below = window.innerHeight - anchor.bottom - 12;
      const above = anchor.top - 12;
      const upwards = below < 360 && above > below;
      menu.style.left = Math.max(12, Math.min(anchor.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 12)) + "px";
      menu.style.right = "auto";
      menu.style.maxHeight = Math.max(60, Math.min(600, (upwards ? above : below) - 6)) + "px";
      menu.style.top = upwards ? "auto" : (anchor.bottom + 6) + "px";
      menu.style.bottom = upwards ? (window.innerHeight - anchor.top + 6) + "px" : "auto";
    };
    positionMenu();
    menuRoot.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    const outside = (event: PointerEvent) => { if (!menuRoot.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", positionMenu); window.removeEventListener("scroll", positionMenu, true); };
  }, [menuOpen]);
  const closeMenu = () => { setMenuOpen(false); menuButton.current?.focus(); };
  const runMenu = (action: () => void) => { closeMenu(); action(); };
  const openPrompt = (kind: "secretary" | "briefing") => { closeMenu(); setCommandText(""); setPromptKind(kind); };
  const cancelPrompt = () => { setPromptKind(null); menuButton.current?.focus(); };
  const menuKeys = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
    if (event.key === "Tab") { setMenuOpen(false); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(menuRoot.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  const controls = (
      <div className="conv-actions" role="group" aria-label="Meeting and advisor controls">
        <div className="meeting-command-root" ref={menuRoot}>
          <button type="button" className="btn ghost" ref={menuButton} aria-label="Meeting settings"
            aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? menuId : undefined}
            onClick={() => setMenuOpen(open => !open)} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setMenuOpen(true); } }}>Meeting settings <span aria-hidden="true">▾</span></button>
          {menuOpen && <div id={menuId} className="meeting-command-menu" role="menu" aria-label="Meeting commands" onKeyDown={menuKeys}>
            <div role="group" aria-label="Orchestrator commands">
              <div className="meeting-command-heading" aria-hidden="true">Orchestrator</div>
              <button role="menuitem" type="button" disabled={requestDisabled} onClick={() => runMenu(p.onRequestResponses)}>{p.requestPending ? "Advisors drafting…" : "Request advisor responses"}</button>
              {p.canManageMeeting && <>
                <button role="menuitem" type="button" disabled={!p.pauseAvailable} onClick={() => runMenu(p.onPause)}>Pause meeting</button>
                <button role="menuitem" type="button" disabled={!p.resumeAvailable} onClick={() => runMenu(p.onResume)}>Resume meeting</button>
                <button role="menuitem" type="button" disabled={!p.endAvailable} onClick={() => runMenu(p.onEnd)}>End discussion</button>
              </>}
            </div>
            <div role="group" aria-label="Secretary commands">
              <div className="meeting-command-heading" aria-hidden="true">Secretary</div>
              <button role="menuitem" type="button" disabled={!p.secretaryAvailable || !p.onSecretaryCommand} onClick={() => openPrompt("secretary")}>Ask the Secretary…</button>
              <button role="menuitem" type="button" disabled={!p.secretaryAvailable || !p.onSecretaryCommand} onClick={() => runMenu(() => { p.onSecretaryCommand?.("Summarize this meeting so far: key points, decisions, unresolved questions, and next steps. Use only the conversation and available evidence."); })}>Summarize meeting</button>
              <button role="menuitem" type="button" disabled={!p.secretaryAvailable || !p.onPrepareBriefing} onClick={() => openPrompt("briefing")}>Prepare briefing…</button>
            </div>
            <div className="meeting-command-general"><button role="menuitem" type="button" onClick={() => runMenu(p.onOpenSettings)}>General settings</button></div>
          </div>}
        </div>
        {promptKind && <form className="conv-command-prompt" onSubmit={event => { event.preventDefault(); if (!commandText.trim() || !p.secretaryAvailable) return; const accepted = promptKind === "briefing" ? p.onPrepareBriefing?.(commandText.trim()) : p.onSecretaryCommand?.(commandText.trim()); if (accepted) cancelPrompt(); }}>
          <h3>{promptKind === "briefing" ? "Prepare briefing" : "Ask the Secretary"}</h3>
          <label>{promptKind === "briefing" ? "Briefing topic" : "Secretary request"}<textarea autoFocus rows={3} maxLength={4000} value={commandText} onChange={event => setCommandText(event.target.value)}
            onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancelPrompt(); } }} /></label>
          <div className="meetctl"><button type="submit" disabled={!commandText.trim() || !p.secretaryAvailable}>{promptKind === "briefing" ? "Prepare briefing" : "Send to Secretary"}</button><button type="button" className="btn ghost" onClick={cancelPrompt}>Cancel</button></div>
        </form>}
      </div>
  );
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
          {p.secretaryPending && <span className="badge live">Secretary working…</span>}
        </p>
      </div>
      {p.controlsTarget ? createPortal(controls, p.controlsTarget) : p.controlsTarget === undefined ? controls : null}
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
