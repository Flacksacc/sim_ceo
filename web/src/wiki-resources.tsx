
import { useEffect, useRef, useState } from "react";
import { actionLabel, friendlyAttempt, friendlySyncState, meetingTitle, relativeTime, resourceLabel, safeRequestMessage, safeRowHelp, safeSyncHelp, wikiScopeLabel } from "./human-source-format";

export type WikiApi = {
  get: <T>(u: string) => Promise<T>;
  post: <T>(u: string, b?: unknown) => Promise<T>;
  patch: <T>(u: string, b?: unknown) => Promise<T>;
  del: <T>(u: string) => Promise<T>;
};

export type WikiResourceDto = {
  id: string; boardId: string; scope: string; meetingId?: string | null;
  baseUrl: string; description: string; allowedUse: string;
  setupUse: boolean; manualOnly: boolean;
  allowlist: string[]; exclusions: string[]; requiredTags: string[]; locale: string;
  enabled: boolean; configRevision: number; attemptGeneration: number;
  attemptStatus: string; syncIntervalMinutes: number;
  nextSyncAt?: string | null; status: string; lastError: string;
  lastCompletedAt?: string | null; lastSuccessRevision: number;
  lastSuccessAt?: string | null; usablePages: number;
  importedPages: number; sourceDocs: number; eligibleDocs: number;
  hasCredential: boolean; protocol: string; createdAt: string; updatedAt: string;
};
function fallbackApi(): WikiApi {
  const headers = (): Record<string, string> => {
    const h: Record<string, string> = {};
    try {
      const t = localStorage.getItem("simceo-token");
      if (t) h["Authorization"] = "Bearer " + t;
    } catch { }
    return h;
  };
  const j = async <T,>(r: Response): Promise<T> => {
    if (!r.ok) throw new Error(r.status + " " + (await r.text()).slice(0, 500));
    return r.json() as Promise<T>;
  };
  return {
    get: <T,>(u: string) => fetch(u, { headers: headers() }).then(j<T>),
    post: <T,>(u: string, b?: unknown) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json", ...headers() }, body: JSON.stringify(b ?? {}) }).then(j<T>),
    patch: <T,>(u: string, b?: unknown) => fetch(u, { method: "PATCH", headers: { "Content-Type": "application/json", ...headers() }, body: JSON.stringify(b ?? {}) }).then(j<T>),
    del: <T,>(u: string) => fetch(u, { method: "DELETE", headers: headers() }).then(j<T>),
  };
}
export default function WikiResources(props: {
  boardId: string; meetingId: string;
  meetings: { id: string; title: string }[];
  api?: WikiApi; onChanged?: () => void; fixture?: { items?: WikiResourceDto[] | null };
}) {
  const { boardId, meetingId, meetings } = props;
  const api = props.api ?? fallbackApi();
  const [items, setItems] = useState<WikiResourceDto[] | null>(props.fixture?.items ?? null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(props.fixture === undefined);
  const seqRef = useRef(0);
  const boardRef = useRef(boardId);
  boardRef.current = boardId;
  // Row-local operation errors persist across unrelated refreshes; a
  // successful refresh never clears another row's error (F16).
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [baseUrl, setBaseUrl] = useState("");
  const [description, setDescription] = useState("");
  const [allowedUse, setAllowedUse] = useState("");
  const [setupUse, setSetupUse] = useState(false);
  const [scope, setScope] = useState("board");
  const [scopeMeeting, setScopeMeeting] = useState("");
  const [allow, setAllow] = useState("/guides/**");
  const [excl, setExcl] = useState("");
  const [tags, setTags] = useState("");
  const [locale, setLocale] = useState("");
  const [manualOnly, setManualOnly] = useState(false);
  const [interval, setInterval] = useState("60");
  const [token, setToken] = useState("");
  const [editing, setEditing] = useState<Record<string, boolean>>({});

  function notifyChanged() {
    try { if (props.onChanged) props.onChanged(); } catch { }
    try { window.dispatchEvent(new CustomEvent("wiki-changed", { detail: { boardId } })); } catch { }
  }

  async function refresh() {
    const myBoard = boardId;
    // Guard origin board BEFORE touching shared sequence/state: an obsolete
    // closure for another board must never displace current-board data (F16).
    if (boardRef.current !== myBoard) return;
    if (!myBoard) return;
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const list = await api.get<WikiResourceDto[]>("/api/boards/" + myBoard + "/wiki-resources");
      if (seqRef.current !== seq || boardRef.current !== myBoard) return;
      setItems(list);
    } catch (e) { if (seqRef.current === seq && boardRef.current === myBoard) setError(String(e)); }
    finally { if (seqRef.current === seq && boardRef.current === myBoard) setLoading(false); }
  }
  useEffect(() => { setError(""); refresh(); }, [boardId]);
  useEffect(() => {
    const h = (ev: Event) => {
      try { if ((ev as CustomEvent).detail?.boardId !== undefined && (ev as CustomEvent).detail.boardId !== boardRef.current) return; } catch { }
      refresh();
    };
    window.addEventListener("wiki-changed", h);
    return () => window.removeEventListener("wiki-changed", h);
  }, [boardId]);
  const lines = (v: string) => v.split("\n").map((s) => s.trim()).filter(Boolean);
  async function create() {
    setError(""); setNotice("");
    const tok = token.trim();
    setToken("");
    try {
      if (!baseUrl.trim()) throw new Error("Base URL is required (origin only, no query/fragment).");
      if (!description.trim()) throw new Error("Description is required before enable; set it now.");
      if (!allowedUse.trim()) throw new Error("Allowed use is required before enable; set it now.");
      const body: Record<string, unknown> = {
        baseUrl: baseUrl.trim(), description: description.trim(), allowedUse: allowedUse.trim(),
        setupUse, manualOnly, scope, allowlist: lines(allow), exclusions: lines(excl),
        requiredTags: lines(tags), locale: locale.trim(),
        syncIntervalMinutes: Math.max(5, Math.min(1440, parseInt(interval || "60", 10) || 60)),
      };
      if (scope === "meeting") {
        const mid = scopeMeeting || meetingId;
        if (!mid) throw new Error("Pick a meeting for meeting scope; resources never silently widen to board.");
        body["meetingId"] = mid;
      }
      if (tok) body["token"] = tok;
      await api.post("/api/boards/" + boardId + "/wiki-resources", body);
      setNotice("Wiki.js 2.x read-only connector created disabled; set rules, credential, then enable explicitly. Imported pages enter the review inbox as pending.");
      await refresh(); notifyChanged();
    } catch (e) { setError(String(e)); await refresh(); notifyChanged(); }
    finally { setToken(""); }
  }
  async function op(id: string, path: string, method: "post" | "patch" | "del" = "post", body?: unknown) {
    setError(""); setNotice("");
    const opBoard = boardId;
    setRowErrors((m) => { const n = { ...m }; delete n[id]; return n; });
    try {
      if (method === "post") await api.post("/api/wiki-resources/" + id + path, body ?? {});
      else if (method === "patch") await api.patch("/api/wiki-resources/" + id, body ?? {});
      else await api.del("/api/wiki-resources/" + id);
      if (boardRef.current !== opBoard) return;
      if (path === "/enable") setNotice("Enabled; a bounded sync now runs. Imported pages stay pending until explicitly approved.");
      if (path === "/disable") setNotice("Disabled; cached connector evidence is unavailable until re-enabled and successfully synced.");
      if (path === "/sync") setNotice("Manual sync finished; only the current successful sync pages are usable.");
    } catch (e) {
      if (boardRef.current !== opBoard) return;
      setRowErrors((m) => ({ ...m, [id]: safeRowHelp(path) }));
      return;
    }
    finally { if (boardRef.current === opBoard) { await refresh(); notifyChanged(); } }
  }
  return (
    <div className="card" aria-label="Wiki.js connector resources">
      <h3>Wiki.js 2.x connector (read-only GraphQL)</h3>
      <p>
        Pinned protocol: pages.list + pages.single over POST /graphql with Bearer token.
        No mutations are ever emitted. No Wiki.js 3 REST claim. Disabled by default; blank allowlist denies all;
        exclusions win. Locale exact, every required tag must match. Failed or disabled resources block all cached
        connector evidence until a successful current sync; history stays inspectable. Credentials are server-held only.
      </p>
      {loading && <p role="status">Loading Wiki resources...</p>}
      {error && <p role="alert">{safeRequestMessage(error)}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="meetctl">
        <label>Base URL (origin only) <input aria-label="Wiki base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://wiki.example.com" /></label>
        <label>Description <textarea aria-label="Wiki description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Team handbook" rows={3} /></label>
      </div>
      <div className="meetctl">
        <label>Allowed use (required) <textarea aria-label="Wiki allowed use" value={allowedUse} onChange={(e) => setAllowedUse(e.target.value)} rows={4} placeholder="Handbook lookup for board discussion only" /></label>
        <label><input type="checkbox" checked={setupUse} onChange={(e) => setSetupUse(e.target.checked)} /> Setup use (off by default)</label>
      </div>
      <div className="meetctl">
        <label>Scope <select aria-label="Wiki scope" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="board">Whole board</option><option value="meeting">One meeting</option>
        </select></label>
        {scope === "meeting" && (
          <label>Meeting <select aria-label="Wiki meeting" value={scopeMeeting || meetingId} onChange={(e) => setScopeMeeting(e.target.value)}>
            <option value="">Pick a meeting...</option>
            {meetings.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select></label>
        )}
      </div>
      <div className="meetctl">
        <label>Allowed paths (exact or prefix/**, one per line) <textarea aria-label="Wiki allowlist" value={allow} onChange={(e) => setAllow(e.target.value)} rows={4} /></label>
        <label>Excluded paths (win over allowed paths) <textarea aria-label="Wiki exclusions" value={excl} onChange={(e) => setExcl(e.target.value)} rows={4} /></label>
      </div>
      <div className="meetctl">
        <label>Required tags (all must match, one per line) <textarea aria-label="Wiki required tags" value={tags} onChange={(e) => setTags(e.target.value)} rows={3} /></label>
        <label>Locale (exact; empty = any) <input aria-label="Wiki locale" value={locale} onChange={(e) => setLocale(e.target.value)} placeholder="en" /></label>
        <label>Sync interval (min, 5-1440) <input aria-label="Wiki sync interval" value={interval} onChange={(e) => setInterval(e.target.value)} inputMode="numeric" /></label>
        <label><input type="checkbox" checked={manualOnly} onChange={(e) => setManualOnly(e.target.checked)} /> Manual-only (refresh off)</label>
        <label>Credential token (never echoed; cleared after submit) <input aria-label="Wiki token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" /></label>
      </div>
      <div className="meetctl"><button onClick={create}>Create disabled resource</button></div>
      {(items ?? []).map((r) => (
        <div key={r.id} data-resource-id={r.id} style={{ borderTop: "1px solid var(--line)", marginTop: 8, paddingTop: 8 }}>
          <b>{r.description || r.baseUrl}</b> <span className="badge">{wikiScopeLabel(r.scope, meetingTitle(meetings, r.meetingId))}</span> {r.description && r.description !== r.baseUrl ? <span className="muted">{r.baseUrl}</span> : null}
          <span className="badge">{"Revision " + r.configRevision}</span>
          <span className="badge">{r.enabled ? "Enabled" : "Disabled"}</span>
          <span className="badge">{"Sync: " + friendlySyncState(r.status, r.enabled)}</span>
          <span className="badge">{friendlyAttempt(r.attemptStatus)}</span>
          <span className="badge">{r.hasCredential ? "Credential saved" : "No credential"}</span>
          <span className="badge">{"Usable pages: " + r.usablePages}</span>
          <span className="badge">{"Eligible pages: " + r.eligibleDocs + " of " + r.sourceDocs}</span>
          
          {r.status === "failed" && <p role="alert">{safeSyncHelp()}</p>}
          {rowErrors[r.id] && <p role="alert">{rowErrors[r.id]}</p>}
          <div className="meetctl">
            <button aria-label={actionLabel("Enable connector", resourceLabel(r.description, r.baseUrl, r.scope, meetingTitle(meetings, r.meetingId)))} onClick={() => op(r.id, "/enable")}>Enable</button>
            <button aria-label={actionLabel("Disable connector", resourceLabel(r.description, r.baseUrl, r.scope, meetingTitle(meetings, r.meetingId)))} onClick={() => op(r.id, "/disable")}>Disable</button>
            <button aria-label={actionLabel("Sync connector now", resourceLabel(r.description, r.baseUrl, r.scope, meetingTitle(meetings, r.meetingId)))} onClick={() => op(r.id, "/sync")}>Sync now</button>
            <button aria-label={actionLabel(editing[r.id] ? "Close editor for" : "Edit connector", resourceLabel(r.description, r.baseUrl, r.scope, meetingTitle(meetings, r.meetingId)))} onClick={() => setEditing((m) => ({ ...m, [r.id]: !m[r.id] }))}>{editing[r.id] ? "Close editor" : "Edit resource"}</button>
            <button aria-label={actionLabel("Delete connector", resourceLabel(r.description, r.baseUrl, r.scope, meetingTitle(meetings, r.meetingId)))} onClick={() => { if (confirm("Delete this Wiki resource? Cached evidence becomes unavailable; history stays.")) op(r.id, "", "del"); }}>Delete</button>
          </div>
          <details><summary>Rules + membership</summary>
            <div>Allowed paths: {(r.allowlist ?? []).length ? (r.allowlist ?? []).join(", ") : "none - nothing can sync until paths are added"}</div>
            <div>Excluded paths: {(r.exclusions ?? []).length ? (r.exclusions ?? []).join(", ") : "none"}</div>
            <div>Required tags: {(r.requiredTags ?? []).length ? (r.requiredTags ?? []).join(", ") : "none"} - Language: {r.locale || "any"} - Sync every {r.syncIntervalMinutes} minutes{r.manualOnly ? ", manual refresh only" : ""}</div>
            <div>Purpose: {r.allowedUse || "not set - enabling is blocked until this is set"} - Setup use: {r.setupUse ? "on" : "off"}</div>
            <div>Next sync: {relativeTime(r.nextSyncAt) ?? "due now when enabled"} - Last finished: {relativeTime(r.lastCompletedAt) ?? "never"}</div>
          </details>
          {editing[r.id] && (
            <EditRules key={r.id} r={r} meetings={meetings} meetingId={meetingId} onSaved={(msg) => { setNotice(msg); setEditing((m) => ({ ...m, [r.id]: false })); setRowErrors((m) => { const n = { ...m }; delete n[r.id]; return n; }); refresh(); notifyChanged(); }} onError={(e) => { setRowErrors((m) => ({ ...m, [r.id]: safeRequestMessage(String(e)) })); }} onRefresh={() => { refresh(); notifyChanged(); }} api={api} />
          )}
        </div>
      ))}
      {!loading && (items ?? []).length === 0 && <p role="status">No Wiki resources yet - create one disabled, then enable after rules + credential.</p>}
    </div>
  );
}
function EditRules(props: { r: WikiResourceDto; meetings: { id: string; title: string }[]; meetingId: string; onSaved: (m: string) => void; onError: (e: string) => void; onRefresh: () => void; api: WikiApi }) {
  const { r, meetings, meetingId, onSaved, onError, onRefresh, api } = props;
  const [baseUrl, setBaseUrl] = useState(r.baseUrl ?? "");
  const [description, setDescription] = useState(r.description ?? "");
  const [allowedUse, setAllowedUse] = useState((r as unknown as Record<string, string>).allowedUse ?? "");
  const [setupUse, setSetupUse] = useState(!!(r as unknown as Record<string, boolean>).setupUse);
  const [scope, setScope] = useState(r.scope ?? "board");
  const [scopeMeeting, setScopeMeeting] = useState(r.meetingId ?? meetingId ?? "");
  const [allow, setAllow] = useState((r.allowlist ?? []).join("\n"));
  const [excl, setExcl] = useState((r.exclusions ?? []).join("\n"));
  const [tags, setTags] = useState((r.requiredTags ?? []).join("\n"));
  const [locale, setLocale] = useState(r.locale ?? "");
  const [interval, setInterval] = useState(String(r.syncIntervalMinutes ?? 60));
  const [manualOnly, setManualOnly] = useState(!!(r as unknown as Record<string, boolean>).manualOnly);
  const [token, setToken] = useState("");
  const [clearCred, setClearCred] = useState(false);
  const lines = (v: string) => v.split("\n").map((s) => s.trim()).filter(Boolean);
  async function save() {
    const tok = token.trim();
    setToken("");
    try {
      const body: Record<string, unknown> = {
        baseUrl: baseUrl.trim(), description: description.trim(), allowedUse: allowedUse.trim(),
        setupUse, manualOnly, scope,
        allowlist: lines(allow), exclusions: lines(excl),
        requiredTags: lines(tags), locale: locale.trim(),
        syncIntervalMinutes: Math.max(5, Math.min(1440, parseInt(interval || "60", 10) || 60)),
      };
      if (scope === "meeting") {
        if (!scopeMeeting) throw new Error("Pick a meeting for meeting scope.");
        body["meetingId"] = scopeMeeting;
      } else { body["meetingId"] = null; }
      if (tok) body["token"] = tok;
      if (clearCred) body["clearCredential"] = true;
      await api.patch("/api/wiki-resources/" + r.id, body);
      onSaved("Saved; revision bumped and cached evidence blocked until the next successful sync.");
    } catch (e) { onError(String(e)); onRefresh(); }
    finally { setToken(""); }
  }
  return (
    <div className="meetctl">
      <label>Base URL <input aria-label="Edit base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>
      <label>Description <textarea aria-label="Edit description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} /></label>
      <label>Allowed use <textarea aria-label="Edit allowed use" value={allowedUse} onChange={(e) => setAllowedUse(e.target.value)} rows={4} /></label>
      <label><input type="checkbox" checked={setupUse} onChange={(e) => setSetupUse(e.target.checked)} /> Setup use</label>
      <label>Scope <select aria-label="Edit scope" value={scope} onChange={(e) => setScope(e.target.value)}><option value="board">Whole board</option><option value="meeting">One meeting</option></select></label>
      {scope === "meeting" && (<label>Meeting <select aria-label="Edit meeting" value={scopeMeeting} onChange={(e) => setScopeMeeting(e.target.value)}><option value="">Pick a meeting...</option>{meetings.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label>)}
      <label>Allowed paths <textarea aria-label="Edit allowlist" value={allow} onChange={(e) => setAllow(e.target.value)} rows={4} /></label>
      <label>Excluded paths <textarea aria-label="Edit exclusions" value={excl} onChange={(e) => setExcl(e.target.value)} rows={4} /></label>
      <label>Required tags <textarea aria-label="Edit required tags" value={tags} onChange={(e) => setTags(e.target.value)} rows={3} /></label>
      <label>Locale <input aria-label="Edit locale" value={locale} onChange={(e) => setLocale(e.target.value)} /></label>
      <label>Interval <input aria-label="Edit interval" value={interval} onChange={(e) => setInterval(e.target.value)} inputMode="numeric" /></label>
      <label><input type="checkbox" checked={manualOnly} onChange={(e) => setManualOnly(e.target.checked)} /> Manual-only</label>
      <label>New token <input aria-label="Edit token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" /></label>
      <label><input type="checkbox" checked={clearCred} onChange={(e) => setClearCred(e.target.checked)} /> Clear credential</label>
      <button onClick={save}>Save resource</button>
      <span className="badge">{"Revision " + r.configRevision + " will increase when you save"}</span>
    </div>
  );
}

