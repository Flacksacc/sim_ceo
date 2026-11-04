import { useEffect, useRef, useState } from "react";
import "./meeting-attachments.css";

type Source = { id: string; fileName: string; scope: string; meetingId?: string; isCurrent: boolean; indexState: string; indexTruncated?: boolean; approved: boolean; excluded: boolean; policyAllows: boolean };
type Transport = { get: <T>(url: string) => Promise<T>; upload: <T>(url: string, data: FormData) => Promise<T> };
type Pending = { name: string; state: "working" | "error" | "done"; message: string };

export function MeetingAttachments({ boardId, meetingId, canUpload, transport }: { boardId: string; meetingId: string; canUpload: boolean; transport: Transport }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const busy = useRef(false);
  const endpoint = `/api/boards/${boardId}/sources`;
  async function refresh() {
    try {
      const rows = await transport.get<Source[]>(endpoint);
      if (active.current) { setSources(rows.filter(x => x.scope === "meeting" && x.meetingId === meetingId && x.isCurrent && x.approved && !x.excluded && x.policyAllows && x.indexState === "completed")); setLoadError(false); }
    } catch { if (active.current) setLoadError(true); }
  }
  useEffect(() => { active.current = true; void refresh(); return () => { active.current = false; }; }, [boardId, meetingId]);
  async function add(files: File[]) {
    if (!canUpload || busy.current || !files.length) return;
    busy.current = true;
    setPending(files.map(file => ({ name: file.name, state: "working", message: "Waiting to upload…" })));
    for (let i = 0; i < files.length; i++) {
      if (!active.current) break;
      const file = files[i];
      const update = (state: Pending["state"], message: string) => {
        if (active.current) setPending(rows => rows.map((row, index) => index === i ? { ...row, state, message } : row));
      };
      try {
        if (!file.size) throw new Error("This file is empty.");
        if (file.size > 10 * 1024 * 1024) throw new Error("Choose a file smaller than 10 MB.");
        update("working", "Uploading and reading…");
        const data = new FormData();
        data.append("file", file); data.append("scope", "meeting"); data.append("meetingId", meetingId); data.append("addToMeetingContext", "true");
        const row = await transport.upload<Source>(`${endpoint}/upload`, data);
        if (!row.isCurrent || !row.approved || row.excluded || row.indexState !== "completed") throw new Error("The file could not be added to context.");
        if (active.current) {
          setSources(rows => [row, ...rows.filter(x => x.id !== row.id && x.fileName !== row.fileName)]);
          update("done", "");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Upload failed. Please try again.";
        // Network/API helpers already convert server failures to readable errors.
        update("error", message.length < 260 && !/[{}]/.test(message) ? message : "Could not read or upload this file. Check the format and try again.");
      }
    }
    busy.current = false;
    if (active.current) { setPending(rows => rows.filter(x => x.message)); void refresh(); }
  }
  const working = pending.some(x => x.state === "working");
  return <section className="meeting-attachments" aria-label="Meeting attachments">
    <button type="button" className={`attachment-drop${dragging ? " dragging" : ""}`} disabled={!canUpload || working}
      onClick={() => picker.current?.click()}
      onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (canUpload && !working) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); e.stopPropagation(); setDragging(false); void add(Array.from(e.dataTransfer.files)); }}>
      <span aria-hidden="true">＋</span> Drop attachments here or choose files
      <small>{canUpload ? "Added automatically to this meeting’s context · up to 10 MB each" : "Attachments are read-only for this meeting"}</small>
    </button>
    <input ref={picker} type="file" multiple hidden accept=".txt,.md,.markdown,.csv,.json,.pdf,.docx,.pptx,.xlsx" onChange={e => { void add(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
    <small className="muted">Text, PDF with selectable text, and Office documents</small>
    <div aria-live="polite" aria-atomic="false">
      {pending.map((row, index) => row.message && <div className="attachment-row" key={index}><span className={row.state === "working" ? "attachment-spinner" : ""} aria-hidden="true">{row.state === "error" ? "!" : ""}</span><span>{row.name} — {row.message}</span></div>)}
      {sources.map(row => <div className="attachment-row" key={row.id}><span aria-hidden="true">✓</span><span>{row.fileName} <small>{row.indexTruncated ? "First 12,000 characters available in context" : "Ready in meeting context"}</small></span></div>)}
      {loadError && <small role="status">Could not refresh the attachment list. <button type="button" onClick={() => void refresh()}>Retry</button></small>}
    </div>
  </section>;
}
