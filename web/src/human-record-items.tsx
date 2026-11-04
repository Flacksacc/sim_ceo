import { useEffect, useMemo, useRef, useState } from "react";
import {
  describeItemChanges,
  newItemKey,
  parseRecordItems,
} from "./human-format";
import { StatusChip, type StatusTone } from "./human-disclosure";
import "./human-feedback.css";

// Readable decision list. Decision text is the title; stable references
// are never headlines. Selection travels by reference key only; the list
// never rewrites the draft payload.
export function RecordItemList(props: {
  itemsJson: string;
  selectable?: boolean;
  selected?: string[];
  onToggle?: (key: string, checked: boolean) => void;
  emptyHint?: string;
}) {
  const parsed = useMemo(() => parseRecordItems(props.itemsJson), [props.itemsJson]);
  if (parsed.problem !== null) {
    return (
      <p className="human-empty">
        {parsed.problem === "empty"
          ? (props.emptyHint ?? "No decisions in this draft yet.")
          : "This draft could not be displayed. Request a fresh revision to continue from a clean copy."}
      </p>
    );
  }
  return (
    <ol className="human-item-list">
      {parsed.items.map((it, i) => {
        const key = it.key === "" ? "row-" + String(i) : it.key;
        const checked = (props.selected ?? []).indexOf(it.key) >= 0;
        return (
          <li key={key} className="human-item">
            {props.selectable ? (
              <label className="human-item-check">
                <input
                  type="checkbox"
                  aria-label={"Select decision " + String(i + 1)}
                  checked={checked}
                  disabled={it.key === ""}
                  onChange={(e) => props.onToggle?.(it.key, e.target.checked)}
                />
              </label>
            ) : null}
            <div className="human-item-body">
              <span className="human-item-text">{it.text === "" ? "(empty decision — edit to add text)" : it.text}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export interface EditorRowMeta {
  decisions: number;
  added: number;
  removed: number;
  valid: boolean;
  editedByUser: boolean;
}

export interface EditorRow {
  key: string;
  text: string;
  detail: string;
  status: string;
  scope: string;
  raw: unknown;
  edited: boolean;
}

function rowText(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Lossless parse: every stored row keeps its original object (including
// unknown and server-managed metadata). Only text/detail edits mark a row
// edited, and only edited rows are rebuilt — unedited rows emit their
// original object byte-identically. Multiline text stays one decision;
// nothing is ever split, merged, or re-identified.
export function parseEditorRows(json: string): EditorRow[] {
  let raw: unknown = null;
  try {
    raw = JSON.parse(json ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const rec = entry as Record<string, unknown>;
      const id = typeof rec.id === "string" && rec.id !== "" ? rec.id : newItemKey();
      return {
        key: id,
        text: rowText(rec.text),
        detail: rowText(rec.detail),
        status: rowText(rec.status),
        scope: rowText(rec.scope),
        raw: entry,
        edited: false,
      };
    }
    return {
      key: newItemKey(),
      text: typeof entry === "string" ? entry : "",
      detail: "",
      status: "",
      scope: "",
      raw: entry,
      edited: false,
    };
  });
}

export function emitEditorRows(rows: EditorRow[]): string {
  return JSON.stringify(
    rows.map((r) => {
      if (!r.edited) return r.raw;
      const base =
        r.raw !== null && typeof r.raw === "object" && !Array.isArray(r.raw)
          ? { ...(r.raw as Record<string, unknown>) }
          : {};
      base.id = r.key;
      base.text = r.text;
      if (r.detail !== "") base.detail = r.detail;
      else delete base.detail;
      return base;
    }),
  );
}

// Structured revision editor: one textarea per decision. Multiline text
// remains a single decision. Unknown and server-managed properties ride
// along untouched. Nothing is emitted on mount or on hydration — onChange
// fires only for genuine user edits (typing, add, remove), so host
// revision counters keep distinguishing user changes from automatic
// refills. Late hydration under the same draft key is accepted while the
// editor is pristine; user typing always wins over refills.
export function RecordItemEditor(props: {
  draftKey: string;
  initialJson: string;
  onChange: (itemsJson: string, meta: EditorRowMeta) => void;
}) {

  const [baseKeys, setBaseKeys] = useState<string[]>(() => parseEditorRows(props.initialJson).map((r) => r.key));
  const [rows, setRows] = useState<EditorRow[]>(() => parseEditorRows(props.initialJson));
  const keyRef = useRef(props.draftKey);
  const baseJsonRef = useRef(props.initialJson);
  const dirtyRef = useRef(false);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;

  const publish = (next: EditorRow[]) => {
    setRows(next);
    dirtyRef.current = true;
    const keys = new Set(next.map((r) => r.key));
    const baseSet = new Set(baseKeys);
    let added = 0;
    for (const k of keys) if (!baseSet.has(k)) added++;
    let removed = 0;
    for (const k of baseSet) if (!keys.has(k)) removed++;
    const nonEmpty = next.filter((r) => r.text.trim() !== "").length;
    onChangeRef.current(emitEditorRows(next), {
      decisions: next.length,
      added,
      removed,
      valid: nonEmpty > 0,
      editedByUser: true,
    });
  };

  // New draft context (different draft id/version): full reset.
  useEffect(() => {
    if (keyRef.current === props.draftKey) return;
    keyRef.current = props.draftKey;
    baseJsonRef.current = props.initialJson;
    const fresh = parseEditorRows(props.initialJson);

    setBaseKeys(fresh.map((r) => r.key));
    setRows(fresh);
    dirtyRef.current = false;
  }, [props.draftKey, props.initialJson]);

  // Same draft, newer content (e.g. refetch after save): accept while
  // pristine so the editor never shows stale text; preserve typing.
  useEffect(() => {
    if (baseJsonRef.current === props.initialJson) return;
    baseJsonRef.current = props.initialJson;
    const fresh = parseEditorRows(props.initialJson);

    setBaseKeys(fresh.map((r) => r.key));
    if (!dirtyRef.current) setRows(fresh);
  }, [props.initialJson]);

  const editRow = (key: string, patch: Partial<Pick<EditorRow, "text" | "detail">>) => {
    publish(rows.map((r) => (r.key === key ? { ...r, ...patch, edited: true } : r)));
  };
  const addRow = () => {
    publish([...rows, { key: newItemKey(), text: "", detail: "", status: "", scope: "", raw: {}, edited: true }]);
  };
  const removeRow = (key: string) => {
    publish(rows.filter((r) => r.key !== key));
  };

  const nonEmpty = rows.filter((r) => r.text.trim() !== "").length;
  return (
    <div className="human-editor">
      <ol className="human-item-list">
        {rows.map((r, i) => (
          <li key={r.key} className="human-item">
            <div className="human-item-body">
              <label className="human-editor-label" htmlFor={"human-decision-" + props.draftKey + "-" + i}>
                Decision {i + 1}
              </label>
              <textarea
                id={"human-decision-" + props.draftKey + "-" + i}
                className="human-editor-text"
                value={r.text}
                rows={Math.max(2, Math.min(6, r.text.split("\n").length + 1))}
                onChange={(e) => editRow(r.key, { text: e.target.value })}
                placeholder="Write one decision"
              />
              <label className="human-editor-label" htmlFor={"human-detail-" + props.draftKey + "-" + i}>
                Supporting detail (optional)
              </label>
              <textarea
                id={"human-detail-" + props.draftKey + "-" + i}
                className="human-editor-text"
                value={r.detail}
                rows={2}
                onChange={(e) => editRow(r.key, { detail: e.target.value })}
                placeholder="Why this decision, if it needs saying"
              />
              {(r.status !== "" || r.scope !== "") && (
                <p className="muted">
                  {r.status !== "" ? "Status: " + r.status + ". " : ""}
                  {r.scope !== "" ? "Scope: " + r.scope + "." : ""}
                </p>
              )}
              <div className="meetctl">
                <button type="button" className="btn ghost" onClick={() => removeRow(r.key)}>
                  Remove decision {i + 1}
                </button>
              </div>
            </div>
          </li>
        ))}
      </ol>
      <div className="meetctl">
        <button type="button" onClick={addRow}>
          Add decision
        </button>
      </div>
      <p className="human-editor-status" role="status">
        {rows.length === 0
          ? "No decisions yet — add the first one above."
          : rows.length + (rows.length === 1 ? " decision" : " decisions") +
            (nonEmpty === 0 ? " · add text to at least one decision to continue" : "")}
      </p>
    </div>
  );
}

// Plain-language version comparison: Added / Updated / Removed with the
// decision text first. References stay out of headlines.
export function RecordComparison(props: { prevJson: string; curJson: string }) {
  const changes = describeItemChanges(props.prevJson, props.curJson);
  if (changes.length === 0) return <p className="human-empty">Identical decision sets.</p>;
  return (
    <div className="human-compare">
      <p className="human-compare-summary" role="status">
        {changes.length + (changes.length === 1 ? " change" : " changes") + " since the compared version."}
      </p>
      <ul className="human-compare-list">
        {changes.map((c, i) => (
          <li key={String(i)} className={"human-change human-change-" + c.kind}>
            <span className="human-change-kind">{c.headline}</span>
            <span className="human-change-text">{c.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Version row: human status first. Integrity references travel in the
// protocol and export files, never as on-screen codes.
export function RecordVersionRow(props: {
  version: number;
  statusLabel: string;
  tone: StatusTone;
  decided: boolean;
  selected: boolean;
  onSelect: () => void;
  testId?: string;
}) {
  return (
    <div className={"human-version" + (props.selected ? " human-version-selected" : "")}>
      <button
        type="button"
        className="human-version-pick"
        data-testid={props.testId}
        aria-current={props.selected}
        onClick={props.onSelect}
      >
        Version {props.version}
      </button>
      <StatusChip label={props.statusLabel} tone={props.tone} />
      {props.decided ? <span className="muted">Decided</span> : null}
    </div>
  );
}

export type { HumanRecordItem } from "./human-format";
