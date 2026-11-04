import { useState } from "react";

export interface WizardRosterChoice {
  entry: { id: string; name: string; description: string; profileJson?: string; tags?: string };
  complete: boolean;
}

export function WizardRosterPicker({ rows, selected, disabled, loading, error, onRetry, onToggle }: {
  rows: WizardRosterChoice[];
  selected: { rosterEntryId?: string; name: string; role: string }[];
  disabled: boolean;
  loading: boolean;
  error: boolean;
  onRetry(): void;
  onToggle(id: string, checked: boolean): void;
}) {
  const [search, setSearch] = useState("");
  const choices = selected.filter(s => !!s.rosterEntryId);
  const selectedIds = new Set(choices.map(s => s.rosterEntryId));
  const query = search.trim().toLocaleLowerCase();
  const visible = rows.filter(r => [r.entry.name, r.entry.description, r.entry.tags, r.entry.profileJson].some(value => value?.toLocaleLowerCase().includes(query)));
  const missing = loading || error ? [] : choices.filter(s => !rows.some(r => r.entry.id === s.rosterEntryId));
  return <div className="wizard-roster-picker">
    <label>Search roster<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search advisors" /></label>
    <p role="status">{choices.length} of 10 advisors selected{choices.length === 10 ? ". Uncheck an advisor to choose another." : "."}</p>
    {loading && <p role="status">Loading your roster…</p>}
    {error && <p role="alert">Could not load your roster. <button type="button" onClick={onRetry}>Try again</button></p>}
    {!loading && !error && <>
      <div className="wizard-roster-options" role="group" aria-label="Roster advisors">
        {visible.map(row => {
          const checked = selectedIds.has(row.entry.id);
          return <label key={row.entry.id} className={"wizard-roster-option" + (checked ? " selected" : "")}>
            <input type="checkbox" checked={checked} disabled={disabled || (!checked && (!row.complete || choices.length >= 10))}
              onChange={e => onToggle(row.entry.id, e.target.checked)} />
            <span><strong>{row.entry.name}</strong><span className="muted">{row.entry.description}</span>
              {!row.complete && <small>Finish this advisor's profile in the roster before adding them.</small>}</span>
          </label>;
        })}
        {rows.length === 0 && <p>Your roster is empty. Create an advisor in the Roster first.</p>}
        {rows.length > 0 && visible.length === 0 && <p>No advisors match your search.</p>}
      </div>
      {choices.length > 0 && <p className="muted">Selected: {choices.map(s => s.name || s.role).join(", ")}</p>}
      {missing.map(s => <p key={s.rosterEntryId} role="alert">{s.name || s.role} is no longer available in your roster. <button type="button" disabled={disabled} onClick={() => onToggle(s.rosterEntryId!, false)}>Remove selection</button></p>)}
    </>}
  </div>;
}
