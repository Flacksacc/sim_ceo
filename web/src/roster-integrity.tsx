import { useState } from "react";
import "./roster-integrity.css";


// Roster integrity panels (isolated; NOT imported by App.tsx).
// The central integrator wires these into the board views.
// Canonical rule: every board advisor renders from its linked roster entry;
// roster edits change effective behavior; board role stays board-specific.

export type CanonicalAdvisor = {
  advisorId: string;
  boardId: string;
  rosterEntryId: string;
  pinnedVersion: number;
  currentVersion: number;
  stale: boolean;
  name: string;
  boardRole: string;
  approved: boolean;
  portraitFingerprint: string;
  behaviorFingerprint: string;
};

export type ReconcileAction = {
  kind: string;
  advisorId: string;
  boardId: string;
  rosterEntryId: string;
  summary: string;
  evidence: string;
};

export type ReconcileReport = {
  engine: string;
  planHash: string;
  idempotencyKey: string;
  generatedAt: string;
  orphans: Array<{
    advisorId: string;
    boardId: string;
    boardName: string;
    rosterEntryId: string;
    boardRole: string;
    approved: boolean;
    reason: string;
    detail: string;
  }>;
  actions: ReconcileAction[];
  warnings: string[];
  applied: boolean;
};

export function RosterLinkBadge({ advisor }: { advisor: CanonicalAdvisor }) {
  const stale = advisor.stale;
  return (
    <span
      className={stale ? "ri-badge ri-badge-stale" : "ri-badge ri-badge-linked"}
      title={
        stale
          ? "Roster v" + advisor.currentVersion + " differs from pinned v" + advisor.pinnedVersion + ". Re-review required; old context is invalid."
          : "Linked to canonical roster v" + advisor.currentVersion + ". Roster edits change board behavior."
      }
      >
      {stale ? "Roster v" + advisor.currentVersion + " \u2014 re-review" : "Roster v" + advisor.currentVersion + " linked"}
    </span>
  );
}

export function BoardAdvisorLinkPanel({ advisor }: { advisor: CanonicalAdvisor }) {
  return (
    <section className="ri-panel" aria-label="Board advisor canonical link">
      <h3 className="ri-title">Canonical roster link</h3>
      <dl className="ri-facts">
        <div><dt>Advisor</dt><dd>{advisor.name}</dd></div>
        <div><dt>Board role</dt><dd>{advisor.boardRole} <span className="ri-muted">(board-specific)</span></dd></div>
        <div><dt>Versions</dt><dd>pinned v{advisor.pinnedVersion} / canonical v{advisor.currentVersion}</dd></div>
        <div><dt>Status</dt><dd><RosterLinkBadge advisor={advisor} /></dd></div>
      </dl>
      {advisor.stale && (
        <p className="ri-warn">
          This roster entry changed since review. Pending old context is invalid \u2014
          use the current roster profile for future replies. Research evidence remains visible in References.
        </p>
      )}
    </section>
  );
}

export function ReconciliationReviewPanel({ report }: { report: ReconcileReport }) {
  const [filter, setFilter] = useState("all");
  const rows = report.actions.filter((a) => filter === "all" || a.kind === filter);
  return (
    <section className="ri-panel" aria-label="Roster reconciliation review">
      <h3 className="ri-title">Reconciliation dry-run — {report.engine}</h3>
      <p className="ri-muted">
        Reconciliation plan · {report.orphans.length} orphan
        {report.orphans.length === 1 ? "" : "s"} · {report.actions.length} proposed action
        {report.actions.length === 1 ? "" : "s"} · idempotent (re-run is identical until state changes).
        No live user data was written to produce this report.
      </p>
      {report.warnings.map((w) => (
        <p key={w} className="ri-warn">{w}</p>
      ))}
      <label className="ri-filter">
        Filter
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All actions</option>
          <option value="RePinAndUnapprove">Re-pin + unapprove</option>
          <option value="ProposeRemoveDuplicate">Duplicate links</option>
          <option value="FlagForOwnerReview">Owner review</option>
        </select>
      </label>
      <ul className="ri-list">
        {rows.map((a) => (
          <li key={a.kind + ":" + a.advisorId} className="ri-item">
            <strong>{a.kind}</strong>
            <div>{a.summary}</div>
            <div className="ri-muted">{a.evidence}</div>
          </li>
        ))}
        {rows.length === 0 && <li className="ri-muted">No actions in this filter. Roster links are healthy.</li>}
      </ul>
    </section>
  );
}