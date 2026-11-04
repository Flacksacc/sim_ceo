/* Meeting participants presence rail - presentational only.
   Parent (App.tsx, owned by central meeting UI owner) owns ALL data:
   GET activity snapshot, live updates, and auth plus portrait URLs from the
   existing authorized accepted-image path. This component makes NO API calls,
   owns no timers, and never infers activity from approval or any global
   pending flag - it renders exactly the per-participant activity prop.
   Vocabulary matches the backend activity contract documented in
   meeting-participants.INTEGRATION.md: idle, queued, waiting-for-selection,
   considering, responding, waiting-for-publication, complete, abstained,
   waiting-for-clarification, failed, interrupted, excluded, needs-approval,
   pending. checking/unavailable are rail-level availability states: while the
   hook reports loading/paused/unavailable, seats render checking/unavailable
   and the summary reports checking/unavailable instead of false Listening. */

export type ParticipantActivity =
  | "idle" | "queued" | "waiting-for-selection" | "considering" | "responding"
  | "waiting-for-publication" | "complete" | "abstained"
  | "waiting-for-clarification" | "failed" | "interrupted"
  | "excluded" | "needs-approval" | "pending" | "checking" | "unavailable";

export interface MeetingParticipant {
  /* Stable internal key (roster/board-advisor id). Never rendered as text. */
  key: string;
  /* Human display name shown under the portrait. */
  displayName: string;
  /* Optional human role line (e.g. Operations). Never an ID. */
  roleLabel?: string;
  /* Authorized portrait URL from the parent (accepted-image path). Null means fallback. */
  portraitUrl?: string | null;
  /* Actual per-participant activity supplied by the parent snapshot/events. */
  activity: ParticipantActivity;
  /* True for the secretary seat (neutral fallback avatar, same rail). */
  isSecretary?: boolean;
}

export interface MeetingParticipantsProps {
  participants: MeetingParticipant[];
  /* True while the parent holds a live activity subscription. Pure label. */
  live?: boolean;
  /* Explicit hook availability: loading/paused/unavailable override the summary. */
  availability?: "available" | "loading" | "paused" | "unavailable";
  /* Optional human heading override. Defaults to In this meeting. */
  heading?: string;
  variant?: "rail" | "composer";
}

const LABEL: Record<ParticipantActivity, string> = {
  idle: "Listening",
  queued: "Queued",
  "waiting-for-selection": "Waiting to be considered",
  considering: "Considering",
  responding: "Responding",
  "waiting-for-publication": "Waiting for publication",
  complete: "Responded",
  abstained: "Abstained",
  "waiting-for-clarification": "Needs clarification",
  failed: "Response failed",
  interrupted: "Interrupted",
  excluded: "Not in this meeting",
  "needs-approval": "Needs approval",
  pending: "Waiting for reply",
  checking: "Checking activity",
  unavailable: "Activity unavailable",
};

/* Lowercase count phrases for the honest aggregate line. */
const COUNT: Record<ParticipantActivity, string> = {
  idle: "listening",
  queued: "queued",
  "waiting-for-selection": "waiting to be considered",
  considering: "considering",
  responding: "responding",
  "waiting-for-publication": "waiting for publication",
  complete: "responded",
  abstained: "sat out",
  "waiting-for-clarification": "needs clarification",
  failed: "failed",
  interrupted: "interrupted",
  excluded: "not in this meeting",
  "needs-approval": "needs approval",
  pending: "waiting for reply",
  checking: "checking activity",
  unavailable: "activity unavailable",
};

/* Canonical order for stable aggregate output. */
const ORDER: ParticipantActivity[] = [
  "responding", "considering", "queued",
  "waiting-for-selection", "waiting-for-publication",
  "waiting-for-clarification", "pending", "needs-approval",
  "complete", "abstained", "failed", "interrupted", "checking", "unavailable", "idle", "excluded",
];

/* Seats with genuinely live run activity behind them. */
const WORKING: ParticipantActivity[] = [
  "queued", "waiting-for-selection", "considering",
  "responding", "waiting-for-publication",
];

const LIVE_DOT: Partial<Record<ParticipantActivity, boolean>> = {
  queued: true,
  "waiting-for-selection": true,
  considering: true,
  responding: true,
  "waiting-for-publication": true,
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function activityLabel(a: ParticipantActivity): string { return LABEL[a]; }

export function MeetingParticipants(p: MeetingParticipantsProps) {
  const list = Array.isArray(p.participants) ? p.participants : [];
  const avail = (p as any)?.availability ?? "available";
  const working = list.filter((m) => WORKING.indexOf(m.activity) >= 0).length;
  let statusLine = "No participants yet.";
  if (list.length > 0) {
    if (avail === "loading" || avail === "paused") {
      statusLine = list.length + " members, checking activity.";
    } else if (avail === "unavailable") {
      statusLine = list.length + " members, activity unavailable.";
    } else if (working > 0) {
      statusLine = list.length + " members, " + working + " working.";
    } else if (list.every((m) => m.activity === "idle")) {
      statusLine = list.length + " members, all listening.";
    } else {
      const parts: string[] = [];
      for (const a of ORDER) {
        const n = list.filter((m) => m.activity === a).length;
        if (n > 0) parts.push(n + " " + COUNT[a]);
      }
      statusLine = list.length + " members: " + parts.join(", ") + ".";
    }
  }
  return (
    <section className={"meet-participants" + (p.variant === "composer" ? " is-composer" : "")} aria-label={p.heading || "In this meeting"}>
      <div className="mp-head">
        <h3>{p.heading || "In this meeting"}</h3>
        {p.live && avail !== "unavailable" && <span className="badge live">live</span>}
      </div>
      <p className="muted mp-status" role="status">{statusLine}</p>
      {list.length === 0 ? (
        <p className="muted">Participants appear here once the meeting has members.</p>
      ) : (
        <ul className="mp-rail" aria-label="Participant activity">
          {list.map((m) => {
            const hasPortrait = typeof m.portraitUrl === "string" && m.portraitUrl.length > 0;
            return (
              <li key={m.key} data-activity={m.activity} title={m.displayName + ": " + LABEL[m.activity]} className={"mp-seat act-" + m.activity + (m.isSecretary ? " is-sec" : "")}>
                <span className="mp-avatar" data-active={LIVE_DOT[m.activity] ? "true" : "false"}>
                  {hasPortrait ? (
                    <img src={m.portraitUrl as string} alt={"Portrait of " + m.displayName} loading="lazy" />
                  ) : (
                    <span
                      className={"mp-fallback" + (m.isSecretary ? " sec" : "")}
                      aria-hidden="true">{m.isSecretary ? "S" : initials(m.displayName)}</span>
                  )}
                  {LIVE_DOT[m.activity] && <span className="mp-pulse" aria-hidden="true" />}
                </span>
                <span className="mp-meta">
                  <span className="mp-name">{m.displayName}{m.isSecretary ? " (Secretary)" : ""}</span>
                  {m.roleLabel && <span className="mp-role muted">{m.roleLabel}</span>}
                  <span className={"badge mp-badge st-" + m.activity}>{LABEL[m.activity]}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
