import { useEffect, useState } from "react";

type GovSource = {
  id: string; boardId: string; fileName: string; contentHash: string; version: number;
  approved: boolean; excluded: boolean; reviewState: string; origin: string;
  familyKey: string; indexState: string; indexGeneration: number; indexError: string;
  indexCompletedAt?: string | null; sectionCount: number; isHead: boolean;
  isCurrent: boolean; currentId?: string | null; scope: string; meetingId?: string | null;
  createdAt: string;
};
type ReviewGroup = {
  familyKey: string; fileName: string; scope: string; meetingId?: string | null;
  origin: string; currentId?: string | null; hasCurrent: boolean; versions: GovSource[];
};
type HistEvent = { id: string; action: string; detail: string; createdAt: string; version: number };
type SecRow = { id: string; ordinal: number; heading: string; location: string; text: string; indexGeneration: number };
type SecResp = { sourceId: string; version: number; contentHash: string; indexState: string; indexGeneration: number; indexError: string; indexCompletedAt?: string | null; sections: SecRow[] };

function authHeaders(actAs: string): Record<string, string> {
  const h: Record<string, string> = {};
  const t = localStorage.getItem("simceo-token");
  if (t) (h as Record<string, string>)["Authorization"] = "Bearer " + t;
  // Demo identity comes from the host app's selected identity prop — the same
  // transport every other app request uses. No window-global substitute.
  const act = (actAs ?? "").trim();
  if (act) (h as Record<string, string>)["X-User"] = act;
  return h;
}
async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(r.status + " " + (await r.text()).slice(0, 400));
  return r.json() as Promise<T>;
}
const get = <T,>(actAs: string, u: string): Promise<T> => fetch(u, { headers: authHeaders(actAs) }).then(j<T>);
const post = <T,>(actAs: string, u: string, b?: unknown): Promise<T> =>
  fetch(u, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(actAs) }, body: JSON.stringify(b ?? {}) }).then(j<T>);
const putPolicy = (actAs: string, bid: string, blockedTypes: string, mode: string) =>
  fetch("/api/boards/" + bid + "/source-policy", { method: "PUT", headers: { "Content-Type": "application/json", ...authHeaders(actAs) }, body: JSON.stringify({ blockedTypes, mode }) }).then(j<unknown>);

export default function SourcesGovernance(props: { boardId: string; meetingId: string; meetings: { id: string; title: string }[]; actAs: string; readOnly?: boolean; canManage?: boolean }) {
  const { boardId, meetingId, meetings, actAs, readOnly, canManage } = props;
  const canWrite = !readOnly;
  const canManagePolicy = canManage === true;
  const [groups, setGroups] = useState<ReviewGroup[] | null>(null);
  const [policy, setPolicy] = useState<{ blockedTypes: string; mode: string } | null>(null);
  const [blocked, setBlocked] = useState("");
  const [mode, setMode] = useState("allowAll");
  const [loading, setLoading] = useState(true);
  const [conflict, setConflict] = useState("");
  const [notice, setNotice] = useState("");
  const [hist, setHist] = useState<Record<string, HistEvent[]>>({});
  const [secs, setSecs] = useState<Record<string, SecResp | null>>({});
  const [ctx, setCtx] = useState<unknown>(null);
  const [recallQ, setRecallQ] = useState("");
  const [recallHits, setRecallHits] = useState<{ kind: string; ref: string; text: string; score: number }[]>([]);
  const [uploadScope, setUploadScope] = useState("board");
  // File-input key: selecting a file bumps the key so the control resets.
  // Picking the SAME file again after choosing a meeting reliably fires a
  // change event instead of being swallowed as "no change".
  const [fileKey, setFileKey] = useState(0);
  // (move-target meeting resolves after its state declaration below)
  async function refresh() {
    if (!boardId) return;
    setLoading(true); setConflict("");
    try {
      const g = await get<ReviewGroup[]>(actAs, "/api/boards/" + boardId + "/sources/review");
      setGroups(g);
      if (canWrite) {
        try {
          const [p, c] = await Promise.all([
            get<{ blockedTypes: string; mode: string }>(actAs, "/api/boards/" + boardId + "/source-policy"),
            get<unknown>(actAs, "/api/boards/" + boardId + "/context"),
          ]);
          setPolicy(p); setBlocked(p.blockedTypes ?? ""); setMode(p.mode ?? "allowAll"); setCtx(c);
        } catch (e) { setConflict(String(e)); }
      }
    } catch (e) {
      setConflict(String(e));
    } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); }, [boardId]);

  async function downloadFile(id: string, name: string) {
    setConflict("");
    try {
      const r = await fetch("/api/sources/" + id + "/download", { headers: authHeaders(actAs) });
      if (!r.ok) throw new Error(r.status + " " + (await r.text()));
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name || "source.bin";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { setConflict(String(e)); }
  }
  async function act(id: string, op: string) {
    setConflict(""); setNotice("");
    try {
      await post(actAs, "/api/sources/" + id + "/" + op, {});
      if (op === "approve" || op === "reject" || op === "exclude" || op === "restore") setNotice("Meeting evidence re-evaluated; affected active meetings paused.");
      await refresh();
    } catch (e) { setConflict(String(e)); }
  }
  async function savePolicy() {
    setConflict(""); setNotice("");
    try { await putPolicy(actAs, boardId, blocked, mode); setNotice("Policy applies immediately; affected meetings paused. Board discussion-policy activation is separate."); await refresh(); }
    catch (e) { setConflict(String(e)); }
  }
  const [uploadMeetingId, setUploadMeetingId] = useState("");
  const effUploadMeeting = uploadScope === "meeting" ? (uploadMeetingId || meetingId || "") : "";
  async function uploadFile(f: File | undefined) {
    // Single upload POST (P2 #5): the response of this one request decides
    // success, conflict, or failure. A meeting scope without a chosen meeting
    // is blocked client-side and rejected server-side — never widened to board.
    if (!f || !boardId) return;
    setConflict(""); setNotice("");
    try {
      if (uploadScope === "meeting" && !effUploadMeeting)
        throw new Error("Pick a meeting for meeting scope; uploads never silently fall back to board.");
      const fd = new FormData();
      fd.append("file", f);
      fd.append("scope", uploadScope);
      if (uploadScope === "meeting" && effUploadMeeting) fd.append("meetingId", effUploadMeeting);
      const res = await fetch("/api/boards/" + boardId + "/sources/upload", { method: "POST", headers: authHeaders(actAs), body: fd });
      if (!res.ok) throw new Error(res.status + " " + (await res.text()).slice(0, 400));
      setNotice("Uploaded as pending; explicit approval required before it becomes evidence.");
      await refresh();
    } catch (e) { setConflict(String(e)); }
  }
  async function loadHist(id: string) {
    try { const h = await get<HistEvent[]>(actAs, "/api/sources/" + id + "/history"); setHist((m) => ({ ...m, [id]: h })); }
    catch (e) { setConflict(String(e)); }
  }
  async function loadSecs(id: string) {
    try { const s = await get<SecResp>(actAs, "/api/sources/" + id + "/sections"); setSecs((m) => ({ ...m, [id]: s })); }
    catch (e) { setConflict(String(e)); }
  }
  async function runRecall() {
    setConflict("");
    try {
      const hits = await get<{ kind: string; ref: string; text: string; score: number }[]>(actAs, "/api/boards/" + boardId + "/recall?q=" + encodeURIComponent(recallQ) + (meetingId ? "&meetingId=" + meetingId : ""));
      setRecallHits(hits);
    } catch (e) { setConflict(String(e)); }
  }

  const flat: GovSource[] = (groups ?? []).flatMap((g) => g.versions);
  const pending = flat.filter((s) => s.reviewState === "pending" && !s.excluded).length;
  const approvedCur = flat.filter((s) => s.isCurrent).length;
  const rejected = flat.filter((s) => s.reviewState === "rejected").length;
  const excluded = flat.filter((s) => s.excluded).length;
  const failed = flat.filter((s) => s.indexState === "failed").length;

  return (
    <div>
      <p>Uploads enter an approval inbox as pending. Approval is explicit; new versions never auto-approve. Excluding or revoking the current version produces no fallback to an older version. Rejecting and excluding are distinct. Each version&apos;s board/meeting scope is immutable: moving a file means uploading it again in the destination scope as a new pending version. Policy changes apply immediately and pause affected meetings.</p>
      {loading && <p role="status">Loading sources…</p>}
      {!loading && conflict && <p role="alert">Request failed: {conflict}</p>}
      {notice && <p role="status">{notice}</p>}
      {canManagePolicy && (<div className="card">
        <h3>Source policy</h3>
        <p>Mode applies to every entry path (upload, inline creation, retry, recall, discussion). Wiki-only denies ordinary uploads. Exclusions win. Board discussion-policy activation is separate.</p>
        <label>Mode <select aria-label="Policy mode" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="allowAll">Allow all with blocked extensions</option>
          <option value="wikiOnly">Wiki-only</option>
        </select></label>
        <label> Blocked file types (comma-separated extensions) <input value={blocked} onChange={(e) => setBlocked(e.target.value)} placeholder="exe, zip" /></label>
        <div className="meetctl"><button onClick={savePolicy}>Save policy</button>
        {policy && <span className="badge">current: {policy.mode} · blocked: {policy.blockedTypes || "none"}</span>}</div>
        {ctx !== null && <details><summary>Index status</summary><pre>{JSON.stringify(ctx, null, 2)}</pre></details>}
      </div>)}
      {!loading && !conflict && flat.length === 0 && <p role="status">No sources yet — upload a file to start review.</p>}
      <p role="status" className="source-summary">
        <span className="badge">{pending} pending</span> <span className="badge ok">{approvedCur} current-approved</span> <span className="badge">{rejected} rejected</span> <span className="badge">{excluded} excluded</span> <span className="badge">{failed} index-failed</span>
      </p>
      {canWrite && (<div className="meetctl">
        <label>Upload file <input key={fileKey} type="file" onChange={(e) => { const f = e.target.files?.[0]; setFileKey((k) => k + 1); uploadFile(f); }} /></label>
        <label>Scope <select aria-label="Upload scope" value={uploadScope} onChange={(e) => setUploadScope(e.target.value)}><option value="board">board</option><option value="meeting">meeting</option></select></label>
        {uploadScope === "meeting" && (
          <label>Meeting <select aria-label="Upload meeting" value={effUploadMeeting} onChange={(e) => setUploadMeetingId(e.target.value)}>
            <option value="">Pick a meeting…</option>
            {meetings.map((m) => <option key={m.id} value={m.id}>{m.title} · {m.id.slice(0, 8)}</option>)}
          </select></label>
        )}
      </div>)}
      {(groups ?? []).map((g) => (
        <div className="card" key={g.familyKey}>
          <b>{g.fileName}</b> <span className="badge">{g.scope}{g.meetingId ? " · " + g.meetingId.slice(0, 8) : ""} · {g.origin}</span>
          {g.hasCurrent ? <span className="badge ok">current: {g.versions.find((v) => v.isCurrent)?.version ? "v" + g.versions.find((v) => v.isCurrent)!.version : ""}</span> : <span className="badge">No current version (head excluded/revoked — no fallback)</span>}
          {g.versions.map((s) => (
            <div key={s.id} style={{ borderTop: "1px solid var(--line)", marginTop: 8, paddingTop: 8 }}>
              <span className="badge">v{s.version}</span> <span className="badge">{s.reviewState}</span>
              {s.excluded && <span className="badge">excluded (temporary)</span>}
              <span className="badge">index:{s.indexState} g{s.indexGeneration}</span>
              {s.isCurrent && <span className="badge ok">CURRENT</span>}
              {s.isHead && <span className="badge">head</span>}
              {s.indexState === "failed" && <span className="badge">evidence blocked{s.indexError ? ": " + s.indexError.slice(0, 120) : ""}</span>}
              <div className="meetctl">
                {canWrite && (<button onClick={() => act(s.id, "approve")} disabled={s.reviewState !== "pending"}>Approve</button>)}
                {canWrite && (<button onClick={() => act(s.id, "reject")} disabled={s.reviewState !== "pending"}>Reject</button>)}
                {canWrite && (<button onClick={() => act(s.id, "exclude")} disabled={s.excluded}>Exclude</button>)}
                {canWrite && (<button onClick={() => act(s.id, "restore")} disabled={!s.excluded}>Restore</button>)}
                <span className="badge">Scope is immutable &mdash; to place this file in another scope, upload it again there as a new pending version.</span>
                {canWrite && (<button onClick={() => act(s.id, "reindex")}>Reindex</button>)}
                {canWrite && (<button onClick={() => act(s.id, "retry")}>Retry extraction</button>)}
                <button onClick={() => downloadFile(s.id, s.fileName)}>Download original</button>
                <button onClick={() => loadHist(s.id)}>History</button>
                <button onClick={() => loadSecs(s.id)}>Sections</button>
              </div>
              {hist[s.id] && (
                <details open><summary>Version history ({hist[s.id].length})</summary>
                  {hist[s.id].map((h) => <div key={h.id}>{h.createdAt} · {h.action} · v{h.version} · {h.detail}</div>)}
                </details>
              )}
              {secs[s.id] && (
                <details open><summary>Persisted sections ({secs[s.id]!.sections.length}) · {secs[s.id]!.indexState} g{secs[s.id]!.indexGeneration}</summary>
                  {secs[s.id]!.sections.map((sec) => (
                    <div key={sec.id}><b>{sec.heading || sec.location}</b> <span className="badge">{sec.location}</span><p>{sec.text}</p></div>
                  ))}
                  {secs[s.id]!.sections.length === 0 && <p role="status">No sections — {secs[s.id]!.indexError || "index incomplete; not usable as evidence."}</p>}
                </details>
              )}
            </div>
          ))}
        </div>
      ))}
      <div className="card">
        <h3>Recall approved material</h3>
        <input aria-label="Recall query" value={recallQ} onChange={(e) => setRecallQ(e.target.value)} placeholder="Search approved sources, records, directions" />
        <button onClick={runRecall}>Recall</button>
        {recallHits.length === 0 && <p role="status">No recall results yet.</p>}
        {recallHits.map((h, i) => (
          <div key={i}><span className="badge">{h.kind}</span> <b>{h.ref}</b> (score {h.score}): {h.text}</div>
        ))}
        <p>External hits that cannot resolve to eligible sources are dropped server-side and never become evidence.</p>
      </div>
    </div>
  );
}
