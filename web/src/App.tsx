import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer, useWindowVirtualizer } from "@tanstack/react-virtual";
import { HubConnectionBuilder, type HubConnection } from "@microsoft/signalr";
import { convertRecordedBlobToWav } from "./voiceCodec";
type Board = { id: string; name: string; mission: string };
type Meeting = { id: string; title: string; state: number };
type Msg = {
  sequence: number;
  sender: string;
  advisorName?: string;
  content: string;
  status?: string;
  createdAt?: string;
  parentSequence?: number | null;
  stance?: string;
};
type Excerpt = { kind: string; ref: string; text: string; score: number };
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (
    (parts[0][0] ?? "?") +
    (parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "")
  ).toUpperCase();
}
function hue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
type Cite = { kind: "source" | "record"; label: string };
type Stance =
  | "Agrees"
  | "Disagrees"
  | "Raises risk"
  | "Proposes alternative"
  | "Supports"
  | "Prefers alternative"
  | "";
function parseMsg(content: string): {
  text: string;
  challenged: boolean;
  cites: Cite[];
  stance: Stance;
  replyTo: string;
} {
  let text = content;
  let challenged = false;
  let stance: Stance = "";
  let replyTo = "";
  const sm = text.match(/\[(stance|tag):\s*([^\]]+)\]/i);
  if (sm) {
    const v = sm[2].trim().toLowerCase();
    if (v.indexOf("disagree") === 0) stance = "Disagrees";
    else if (v.indexOf("agree") === 0) stance = "Agrees";
    else if (v.indexOf("risk") >= 0) stance = "Raises risk";
    else if (v.indexOf("alternative") >= 0 || v.indexOf("propos") >= 0)
      stance = "Proposes alternative";
    else if (v.indexOf("support") >= 0) stance = "Supports";
    else if (v.indexOf("prefer") >= 0) stance = "Prefers alternative";
    text = text.replace(sm[0], "").trim();
  }
  const rm = text.match(
    /\[(replying to|reply to|in reply to|responding to):\s*([^\]]+)\]/i,
  );
  if (rm) {
    replyTo = rm[2].trim();
    text = text.replace(rm[0], "").trim();
  }
  const ch = text.match(/\[challenge:\s*([^\]]+)\]/i);
  if (ch) {
    challenged = true;
    text = text.replace(ch[0], "").trim();
  }
  const cites: Cite[] = [];
  text = text
    .replace(
      /\[(source|record):([^\]]+)\]/gi,
      (_m: string, k: string, v: string) => {
        cites.push({
          kind: k.toLowerCase() === "record" ? "record" : "source",
          label: v.trim(),
        });
        return "";
      },
    )
    .trim();
  return { text, challenged, cites, stance, replyTo };
}
type Advisor = {
  id: string;
  boardRole: string;
  approved: boolean;
  removed: boolean;
};
type Preset = {
  key: string;
  title: string;
  roles: string[];
  question: string;
  agenda: string;
  deliverable: string;
};
type Lead = {
  id: string;
  boardId: string;
  version: number;
  name: string;
  roleLabel: string;
  background: string;
  familiarTopics: string;
  simplerTopics: string;
  commPrefs: string;
  updatedAt: string;
  provenanceJson: string;
};
type Setup = {
  board: {
    id: string;
    name: string;
    mission: string;
    stage: string;
    activeConfig: boolean;
    leadProfileVersion: number;
    retainAudio: boolean;
    discussionPolicy: string;
    dataUse: string;
  };
  draftJson: string;
  activeJson: string;
  draftHash: string;
  dirty: boolean;
  lead: Lead | null;
  advisors: { total: number; approved: number };
};
type RosterRow = {
  entry: {
    id: string;
    accountId: string;
    type: number;
    name: string;
    description: string;
    profileJson: string;
    version: number;
    archived: boolean;
    tags: string;
    updatedAt: string;
    researchedAt: string | null;
    researchRequested: boolean;
    evidenceCount: number;
    researchJson?: string;
    ownerKey?: string;
  };
  imageCount: number;
  complete: boolean;
  missing: string[];
  boards: { boardId: string; board: string; role: string; approved: boolean }[];
};
type AdvisorFull = Advisor & {
  rosterEntryId: string;
  rosterVersion: number;
  imageProvenance: string;
};
type MeetingFull = Meeting & { brief: string; boardId: string };
const MEETING_STATES = [
  "Awaiting brief",
  "Active",
  "Yielded",
  "Paused",
  "Wrapping up",
  "Awaiting record decision",
  "Closed with record",
  "Closed without publication",
] as const;
function meetingStateLabel(state: number): string {
  return MEETING_STATES[state] ?? String(state);
}
function meetingIsOpen(state: number): boolean {
  return (
    state === 0 ||
    state === 1 ||
    state === 2 ||
    state === 3 ||
    state === 4 ||
    state === 5
  );
}
type Note = {
  id: string;
  boardId: string;
  meetingId: string;
  kind: string;
  scope: string;
  title: string;
  body: string;
  provisional: boolean;
  createdAt: string;
};
type Source = {
  id: string;
  boardId: string;
  meetingId?: string;
  fileName: string;
  contentHash: string;
  version: number;
  approved: boolean;
  excluded: boolean;
  scope: string;
};
type RecordDraft = {
  id: string;
  boardId: string;
  meetingId: string;
  version: number;
  hash: string;
  watermark: number;
  itemsJson: string;
  decided: boolean;
  status: string;
  approvedJson: string;
  supersedesJson: string;
};
type Invite = {
  id: string;
  boardId: string;
  email: string;
  role: string;
  state: string;
};
type Grant = {
  id: string;
  boardId: string;
  meetingId?: string;
  userKey: string;
  access: string;
};
type Job = {
  id: string;
  kind: string;
  state: string;
  idempotencyKey: string;
  updatedAt: string;
};
type UsageRow = {
  kind: string;
  model: string;
  inputTokens: number;
  cost?: number;
  note: string;
  boardId?: string;
  meetingId?: string;
  at: string;
};
type Cmd = { command: string; view: string; action: string };
type BoardStatus = {
  board: string;
  active: boolean;
  dirty: boolean;
  name: boolean;
  lead: boolean;
  leadVersion: number;
  advisors: { total: number; approved: number };
  meetings: { total: number; active: number };
  sourcesPending: number;
  jobsFailed: number;
  policy: string;
  retainAudio: boolean;
};
type ModelStatus = {
  configured: boolean;
  source: string;
  model: string;
  chatOverride: string;
  keyHint: string;
  lastTestAt: string | null;
  lastTestOk: boolean;
  lastTestModel: string;
  lastTestError: string;
};
type Spending = {
  month: string;
  monthlyCapUsd?: number;
  mode: string;
  knownSpendUsd: number;
  unknownCostCalls: number;
  overCap: boolean;
  enforced: boolean;
  note: string;
};
async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}
let actAs = "";
const withUser = (): Record<string, string> => {
  const h: Record<string, string> = actAs ? { "X-User": actAs } : {};
  const t = localStorage.getItem("simceo-token");
  if (t) h["Authorization"] = `Bearer ${t}`;
  return h;
};
const get = <T,>(u: string): Promise<T> =>
  fetch(u, { headers: withUser() }).then(j<T>);
const post = <T,>(u: string, b: unknown): Promise<T> =>
  fetch(u, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...withUser() },
    body: JSON.stringify(b ?? {}),
  }).then(j<T>);
const patch = <T,>(u: string, b: unknown): Promise<T> =>
  fetch(u, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...withUser() },
    body: JSON.stringify(b ?? {}),
  }).then(j<T>);
const upload = <T,>(u: string, f: FormData): Promise<T> =>
  fetch(u, { method: "POST", headers: withUser(), body: f }).then(j<T>);
type Tab =
  | "boards"
  | "wizard"
  | "profile"
  | "settings"
  | "roster"
  | "advisors"
  | "meet"
  | "sources"
  | "records"
  | "people"
  | "activity"
  | "help";
const navGroups: { label: string; items: [Tab, string][] }[] = [
  { label: "", items: [["boards", "Boards"]] },
  {
    label: "Build",
    items: [
      ["roster", "Roster"],
      ["advisors", "Board Advisors"],
    ],
  },
  {
    label: "Run",
    items: [
      ["meet", "Meetings"],
      ["sources", "Sources"],
      ["records", "Records"],
    ],
  },
  {
    label: "Manage",
    items: [
      ["people", "People"],
      ["activity", "Activity"],
    ],
  },
  {
    label: "",
    items: [
      ["settings", "Settings"],
      ["profile", "Profile"],
      ["help", "Help"],
    ],
  },
];
const needsBoard: Tab[] = [
  "advisors",
  "meet",
  "sources",
  "records",
  "people",
  "activity",
];
type NavRoute = {
  tab: Tab;
  board: string;
  meeting: string;
  mtab: "chat" | "takeaways" | "options" | "decision";
  ctab: "members" | "context" | "decisions";
  rec: string;
};
const ALL_TABS: Tab[] = [
  "boards",
  "wizard",
  "profile",
  "settings",
  "roster",
  "advisors",
  "meet",
  "sources",
  "records",
  "people",
  "activity",
  "help",
];
const MEET_VIEWS = ["chat", "takeaways", "options", "decision"] as const;
const CTX_VIEWS = ["members", "context", "decisions"] as const;
function emptyRoute(): NavRoute {
  return {
    tab: "boards",
    board: "",
    meeting: "",
    mtab: "chat",
    ctab: "context",
    rec: "",
  };
}
function parseHash(): NavRoute {
  const fallback = emptyRoute();
  try {
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw) return fallback;
    const qi = raw.indexOf("?");
    const path = (qi >= 0 ? raw.slice(0, qi) : raw).replace(/\/+$/, "") || "/";
    const params = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : "");
    const seg = path.split("/").filter(Boolean)[0] ?? "";
    const tab = (ALL_TABS as string[]).includes(seg) ? (seg as Tab) : "boards";
    const mraw = params.get("mtab") ?? "";
    const mtab = (MEET_VIEWS as readonly string[]).includes(mraw)
      ? (mraw as NavRoute["mtab"])
      : "chat";
    const craw = params.get("ctab") ?? "";
    const ctab = (CTX_VIEWS as readonly string[]).includes(craw)
      ? (craw as NavRoute["ctab"])
      : "context";
    return {
      tab,
      board: params.get("board") ?? "",
      meeting: params.get("meeting") ?? "",
      mtab,
      ctab,
      rec: params.get("rec") ?? "",
    };
  } catch {
    return fallback;
  }
}
function isNotFound(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("404");
}
function buildHash(r: {
  tab: Tab;
  board: string;
  meeting: string;
  mtab: string;
  ctab: string;
  rec: string;
}): string {
  const q = new URLSearchParams();
  if (r.board) q.set("board", r.board);
  if (r.meeting) q.set("meeting", r.meeting);
  if (r.tab === "meet" && r.mtab !== "chat") q.set("mtab", r.mtab);
  if (r.tab === "meet" && r.ctab !== "context") q.set("ctab", r.ctab);
  if (r.tab === "records" && r.rec) q.set("rec", r.rec);
  const qs = q.toString();
  return "#/" + r.tab + (qs ? "?" + qs : "");
}
function NavIcon({ name, size = 16 }: { name: string; size?: number }) {
  const paths: Record<string, JSX.Element> = {
    boards: (
      <>
        {" "}
        <rect x="2.5" y="2.5" width="5" height="5" rx="1.2" />{" "}
        <rect x="8.5" y="2.5" width="5" height="5" rx="1.2" />{" "}
        <rect x="2.5" y="8.5" width="5" height="5" rx="1.2" />{" "}
        <rect x="8.5" y="8.5" width="5" height="5" rx="1.2" />{" "}
      </>
    ),
    roster: (
      <>
        {" "}
        <rect x="2.5" y="3" width="11" height="10" rx="2" />{" "}
        <path d="M5.5 6.5h5M5.5 9h5M5.5 11.5h3" />{" "}
      </>
    ),
    advisors: (
      <>
        {" "}
        <circle cx="6.5" cy="5.5" r="2.5" />{" "}
        <path d="M2.5 13.5c.6-2.4 2.2-3.6 4-3.6s3.4 1.2 4 3.6" />{" "}
        <path d="M10.5 8.5l1.5 1.5 3-3" />{" "}
      </>
    ),
    profile: (
      <>
        {" "}
        <circle cx="8" cy="5.2" r="2.6" />{" "}
        <path d="M3 13.5c.8-2.6 2.7-4 5-4s4.2 1.4 5 4" />{" "}
      </>
    ),
    meet: (
      <>
        {" "}
        <path d="M13.5 9.5a5.5 5.5 0 0 1-5.5 5.5c-1 0-2-.3-2.8-.7L2.5 15l.8-2.9A5.5 5.5 0 1 1 13.5 9.5Z" />{" "}
      </>
    ),
    sources: (
      <>
        {" "}
        <path d="M4 2h5.5L12.5 5v9H4V2Z" /> <path d="M9.5 2v3h3" />{" "}
      </>
    ),
    records: (
      <>
        {" "}
        <rect x="2.5" y="3.5" width="11" height="3" rx="1" />{" "}
        <path d="M4 6.5v6h8v-6M7 9.5h2" />{" "}
      </>
    ),
    people: (
      <>
        {" "}
        <circle cx="5.8" cy="5.5" r="2.3" />{" "}
        <path d="M2 13.5c.5-2.2 2-3.3 3.8-3.3s3.3 1.1 3.8 3.3" />{" "}
        <circle cx="11" cy="6" r="1.8" />{" "}
        <path d="M11.2 10.3c1.4.2 2.4 1.2 2.8 3" />{" "}
      </>
    ),
    activity: (
      <>
        {" "}
        <rect x="2.5" y="2.5" width="11" height="11" rx="2" />{" "}
        <path d="M5 9.5l2-2 1.5 1.5 2.5-3" />{" "}
      </>
    ),
    help: (
      <>
        {" "}
        <circle cx="8" cy="8" r="5.5" />{" "}
        <path d="M6.2 6.2c.2-1 1-1.7 2-1.7 1.1 0 2 .8 2 1.9 0 1.4-1.6 1.6-2 2.9" />{" "}
        <circle cx="8.2" cy="11.6" r="0.2" />{" "}
      </>
    ),
    gear: (
      <>
        {" "}
        <circle cx="8" cy="8" r="2.2" />{" "}
        <path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.9 3.9l1.3 1.3M10.8 10.8l1.3 1.3M12.1 3.9l-1.3 1.3M5.2 10.8l-1.3 1.3" />{" "}
      </>
    ),
    mail: (
      <>
        {" "}
        <rect x="2.5" y="4" width="11" height="8" rx="1.5" />{" "}
        <path d="M3.5 5.5 8 9l4.5-3.5" />{" "}
      </>
    ),
    logout: (
      <>
        {" "}
        <path d="M9.5 3.5H4v9h5.5M6.5 8h7M11 5.5 13.5 8 11 10.5" />{" "}
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {" "}
      {paths[name] ?? paths.boards}{" "}
    </svg>
  );
}
function cleanProfileText(pj: string): string {
  let t = (pj ?? "").trim();
  if (t.startsWith("```")) {
    const nl = t.indexOf("\n");
    const end = t.lastIndexOf("```");
    if (nl >= 0 && end > nl) t = t.slice(nl + 1, end).trim();
  }
  return t;
}
function provText(provJson: string | undefined, key: string): string {
  try {
    const o = JSON.parse(provJson ?? "{}") as Record<string, { source?: unknown; at?: unknown }>;
    const p = o[key];
    if (p && typeof p.source === "string") return p.source + (p.at ? " · " + new Date(String(p.at)).toLocaleString() : "");
  } catch { /* ignore */ }
  return "";
}
function ProfileFields({ profileJson }: { profileJson: string }) {
  let o: Record<string, unknown> = {};
  try {
    const p: unknown = JSON.parse(cleanProfileText(profileJson));
    if (p && typeof p === "object" && !Array.isArray(p)) o = p as Record<string, unknown>;
  } catch { o = {}; }
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []).filter((s) => s.length > 0);
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  const background = text(o.background ?? o.description);
  const pname = text(o.name);
  const collaboration = text(o.collaboration);
  const groups: { label: string; items: string[] }[] = [
    { label: "Strengths", items: list(o.strengths) },
    { label: "Methods", items: list(o.methods) },
    { label: "Evidence needed", items: list(o.evidenceNeeded) },
    { label: "Limits", items: list(o.limits) },
    { label: "Challenge triggers", items: list(o.challengeTriggers) },
    { label: "Can handle", items: list(o.canHandle) },
  ].filter((g) => g.items.length > 0);
  const rawText = cleanProfileText(profileJson);
  const looksJson = rawText.startsWith("{") || rawText.startsWith("[");
  if (!background && !pname && !collaboration && groups.length === 0) {
    if (rawText && !looksJson) return (<div className="profile-fields"><p>{rawText}</p></div>);
    return null;
  }
  return (
    <div className="profile-fields">
      {" "}
      {pname && <h4>{pname}</h4>}{" "}
      {background && <p>{background}</p>}{" "}
      {groups.map((g) => (
        <div key={g.label}>
          {" "}
          <h4>{g.label}</h4>{" "}
          <ul>
            {" "}
            {g.items.map((it, ix) => (
              <li key={ix}>{it}</li>
            ))}{" "}
          </ul>{" "}
        </div>
      ))}{" "}
      {collaboration && (<p className="muted">{" "}How they work: {collaboration}{" "}</p>)}{" "}
    </div>
  );
}
function dossierIsSafeHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u.trim());
}
function dossierPick(o: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return "";
}
function DossierView({ raw }: { raw: string }) {
  let d: Record<string, unknown> = {};
  try {
    const p: unknown = JSON.parse(raw);
    if (p && typeof p === "object" && !Array.isArray(p)) d = p as Record<string, unknown>;
  } catch { return null; }
  const claims: unknown[] = Array.isArray(d.claims) ? (d.claims as unknown[]) : (Array.isArray(d.Claims) ? (d.Claims as unknown[]) : []);
  const subject = dossierPick(d, "subject", "Subject");
  const note = dossierPick(d, "note", "Note");
  const supported = typeof d.supported === "boolean" ? d.supported : (typeof d.Supported === "boolean" ? (d.Supported as boolean) : undefined);
  return (
    <div className="card">{" "}
      <h3>Latest dossier</h3>{" "}
      {subject && <p className="muted">{subject}</p>}{" "}
      {supported === false && (<p role="note">Unverified research — treat claims as unsupported until cross-checked.</p>)}{" "}
      <ul>{" "}
        {claims.map((c, ci) => {
          const cobj = (c && typeof c === "object" && !Array.isArray(c) ? c as Record<string, unknown> : {});
          const ctextPicked = dossierPick(cobj, "text", "Text");
          const ctext = ctextPicked ? ctextPicked : JSON.stringify(c);
          const angle = dossierPick(cobj, "angle", "Angle");
          const srcs: unknown[] = Array.isArray(cobj.sources) ? (cobj.sources as unknown[]) : (Array.isArray(cobj.Sources) ? (cobj.Sources as unknown[]) : []);
          const refs: unknown[] = Array.isArray(cobj.refs) ? (cobj.refs as unknown[]) : (Array.isArray(cobj.Refs) ? (cobj.Refs as unknown[]) : []);
          type DossierEv = { kind: string; ref: string; url: string; title: string; excerpt: string };
          const seen = new Set<string>();
          const evidence: DossierEv[] = [];
          const pushEv = (kind: string, ref: string, url: string, title: string, excerpt: string) => {
            const k = (kind.trim() || "source").toLowerCase();
            const u = url.trim();
            const key = u ? "u:" + u.toLowerCase() : "k:" + k + ":" + ref.trim().toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            evidence.push({ kind: k, ref: ref.trim(), url: u, title: title.trim(), excerpt });
          };
          for (const r of refs) {
            const ro = (r && typeof r === "object" && !Array.isArray(r) ? r as Record<string, unknown> : {});
            const kind = dossierPick(ro, "kind", "Kind") || "source";
            const ref = dossierPick(ro, "ref", "Ref", "id", "Id");
            const url = dossierPick(ro, "url", "Url");
            const title = dossierPick(ro, "title", "Title");
            const rawEx = typeof ro.excerpt === "string" ? (ro.excerpt as string) : (typeof ro.Excerpt === "string" ? (ro.Excerpt as string) : "");
            pushEv(kind, ref || url, url, title, rawEx);
          }
          for (const s of srcs) {
            const so = (s && typeof s === "object" && !Array.isArray(s) ? s as Record<string, unknown> : {});
            const url = dossierPick(so, "url", "Url");
            const title = dossierPick(so, "title", "Title");
            if (!url && !title) continue;
            pushEv("source", url, url, title, "");
          }
          const withExcerpt = evidence.filter((e) => e.excerpt.trim() !== "");
          const withoutExcerpt = evidence.filter((e) => e.excerpt.trim() === "");
          const labelFor = (e: DossierEv) => e.title ? e.title : (e.url ? e.url : (e.kind + ":" + (e.ref || "?")));
          return (<li key={ci}>{angle ? (<b>{angle}: </b>) : null}{ctext}
            {withExcerpt.length > 0 && (<ul>{withExcerpt.map((e, ei) => {
              const label = labelFor(e);
              const safe = !!e.url && dossierIsSafeHttpUrl(e.url);
              return (<li key={ei}>{safe ? (<a href={e.url} target="_blank" rel="noreferrer">{label}</a>) : (<span>{label}</span>)}
                <div className="excerpt"><div>{e.excerpt}</div></div></li>);
            })}</ul>)}
            {withoutExcerpt.length > 0 && (<ul>{withoutExcerpt.map((e, ei) => {
              const label = labelFor(e);
              const safe = !!e.url && dossierIsSafeHttpUrl(e.url);
              return (<li key={"u" + ei} className="muted">{safe ? (<a href={e.url} target="_blank" rel="noreferrer">{label}</a>) : (<span>{label}</span>)}<span> (no excerpt)</span></li>);
            })}</ul>)}
            {withExcerpt.length === 0 && (<p role="note">Unsupported — no excerpt in cited evidence.</p>)}</li>);
        })}{" "}
      </ul>{" "}
      {note && <p className="muted">{note}</p>}{" "}
    </div>
  );
}
export default function App() {
  const qc = useQueryClient();
  const initialRoute = useRef<NavRoute | null>(null);
  if (initialRoute.current === null) {
    try {
      initialRoute.current = parseHash();
    } catch {
      initialRoute.current = emptyRoute();
    }
  }
  const route0: NavRoute = initialRoute.current ?? emptyRoute();
  const [tab, setTab] = useState<Tab>(route0.tab);
  const [boardId, setBoardId] = useState(route0.board);
  const [meetingId, setMeetingId] = useState(route0.meeting);
  const prevBoard = useRef<string | null>(null);
  const prevMeeting = useRef<string | null>(null);
  const navReplace = useRef(false);
  // Board-owned UI state (advisor selection/test chat, participant picks,
  // recall excerpts). URL context (board/meeting/record) is never cleared
  // here; it comes from the route or the switch guards below.
  const resetBoardOwnedState = () => {
    setMeetPicks([]);
    setSelAdv("");
    setChatAdv("");
    setChatHist([]);
    setChatMsg("");
    setChatErr("");
    setExcerpts([]);
  };
  // Meeting-owned UI state (composer reply target, note/briefing/direction
  // drafts, message search, record review/compare state, setup form cache).
  const resetMeetingOwnedState = () => {
    setReplyTo(null);
    setSelItems([]);
    setCmpVer("");
    setRevText("");
    setMLoaded("");
    setMtitle("");
    setMbrief("");
    setSq("");
    setHits([]);
    setExcerpts([]);
    setNtitle("");
    setNbody("");
    setBtopic("");
    setDtext("");
  };
  useEffect(() => {
    if (prevBoard.current === null) {
      // Mount: keep any deep-linked board/meeting from the URL.
      prevBoard.current = boardId;
      return;
    }
    if (prevBoard.current !== boardId) {
      prevBoard.current = boardId;
      setMeetingId("");
      resetBoardOwnedState();
      setReplyTo(null);
      setRecId("");
      setSelItems([]);
      setCmpVer("");
      setRevText("");
      setMLoaded("");
      setSq("");
      setHits([]);
    }
  }, [boardId]);
  const [draft, setDraftState] = useState("");
  const draftKey = `simceo-draft:${boardId}:${meetingId}`;
  const setDraft = (v: string | ((prev: string) => string)) =>
    setDraftState((prev) =>
      typeof v === "function" ? (v as (prev: string) => string)(prev) : v,
    );
  useEffect(() => {
    try {
      setDraftState(localStorage.getItem(draftKey) ?? "");
    } catch {
      setDraftState("");
    }
  }, [draftKey]);
  useEffect(() => {
    try {
      localStorage.setItem(draftKey, draft);
    } catch {
      /* private-mode: keep draft in memory only */
    }
  }, [draft, draftKey]);
  const [policy, setPolicy] = useState("balanced");
  const [presetKey, setPresetKey] = useState("strategy");
  type WizardSeat = { role: string; name: string };
  const [wizard, setWizard] = useState({
    name: "",
    mission: "",
    stage: "",
    step: 1,
    seats: [] as WizardSeat[],
    lead: {
      name: "",
      roleLabel: "Board Lead",
      background: "",
      familiarTopics: "",
      simplerTopics: "",
      commPrefs: "",
    },
  });
  const [seatRole, setSeatRole] = useState("");
  const [seatName, setSeatName] = useState("");
  const [accountId] = useState(() => {
    const k = "simceo-account";
    let a = localStorage.getItem(k);
    if (!a) {
      a = crypto.randomUUID();
      localStorage.setItem(k, a);
    }
    return a;
  });
  const [actAsState, setActAsState] = useState("");
  const [mq, setMq] = useState("");
  const [mstate, setMstate] = useState("");
  const [uday, setUday] = useState("");
  const [ufrom, setUfrom] = useState("");
  const [uto, setUto] = useState("");
  const boards = useQuery({
    queryKey: ["boards"],
    queryFn: () => get<Board[]>("/api/boards"),
  });
  // Selected-board authority is the singular detail lookup, never the
  // bounded (newest-100) board list. A 404 clears the route; absence from
  // the list window means nothing. Non-404 errors gate without clearing.
  const boardDetail = useQuery({
    queryKey: ["board-detail", boardId],
    queryFn: () => get<Board>(`/api/boards/${boardId}`),
    enabled: !!boardId,
    retry: false,
  });
  // Bounded board list (newest 100) never establishes absence: only a 404
  // on the singular board lookup clears the route. Pending/non-404 errors
  // gate downstream queries without clearing.
  const boardMissing =
    !!boardId && boardDetail.isError && isNotFound(boardDetail.error);
  const boardValid =
    boardId === "" ||
    (boardDetail.isSuccess && (boardDetail.data as Board | undefined)?.id === boardId);
  const boardOk = boardValid;
  const presets = useQuery({
    queryKey: ["presets"],
    queryFn: () => get<Preset[]>("/api/presets"),
    enabled: tab === "wizard",
  });
  const advisors = useQuery({
    queryKey: ["advisors", boardId],
    queryFn: () => get<AdvisorFull[]>(`/api/boards/${boardId}/advisors`),
    enabled: !!boardId && boardOk,
  });
  const meetings = useQuery({
    queryKey: ["meetings", boardId, mq, mstate],
    queryFn: () =>
      get<MeetingFull[]>(
        `/api/boards/${boardId}/meetings?${new URLSearchParams({ ...(mq ? { q: mq } : {}), ...(mstate ? { state: mstate } : {}) })}`,
      ),
    enabled: !!boardId && boardOk,
  });
  const allMeetings = useQuery({
    queryKey: ["meetings", boardId, "all"],
    queryFn: () => get<MeetingFull[]>(`/api/boards/${boardId}/meetings`),
    enabled: !!boardId && boardOk,
  });
  // Selected-meeting authority is the scoped singular lookup, which also
  // verifies the parent board. Absence from capped lists never clears.
  const meetingDetail = useQuery({
    queryKey: ["meeting-detail", boardId, meetingId],
    queryFn: () =>
      get<MeetingFull>(`/api/boards/${boardId}/meetings/${meetingId}`),
    enabled: !!boardId && !!meetingId && boardValid,
    retry: false,
  });
  // Bounded meeting windows (newest 200, filtered views) never establish
  // absence. Only a 404 on the scoped lookup (unknown id or parent-board
  // mismatch, which the server also reports as 404) clears the route.
  const meetingParentMismatch =
    meetingDetail.isSuccess &&
    meetingDetail.data != null &&
    (meetingDetail.data.boardId !== boardId ||
      (meetingDetail.data as MeetingFull).id !== meetingId);
  const meetingMissing =
    (!!meetingId &&
      !!boardId &&
      boardValid &&
      meetingDetail.isError &&
      isNotFound(meetingDetail.error)) ||
    (!!meetingId && !!meetingParentMismatch);
  const meetingValid =
    meetingId === "" ||
    (meetingDetail.isSuccess &&
      meetingDetail.data != null &&
      meetingDetail.data.boardId === boardId &&
      (meetingDetail.data as MeetingFull).id === meetingId);
  const meetingOk = boardOk && meetingValid;
  const messages = useQuery({
    queryKey: ["messages", meetingId],
    queryFn: () => get<Msg[]>(`/api/meetings/${meetingId}/messages?take=60`),
    enabled: !!meetingId && meetingOk,
    refetchInterval: 4000,
  });
  const hubRef = useRef<HubConnection | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!meetingId || !meetingOk) return;
    let cancelled = false;
    const conn = new HubConnectionBuilder()
      .withUrl("/hubs/board")
      .withAutomaticReconnect()
      .build();
    hubRef.current = conn;
    const onMsg = () => {
      qc.invalidateQueries({ queryKey: ["messages", meetingId] });
    };
    const onRun = () => {
      qc.invalidateQueries({ queryKey: ["messages", meetingId] });
      qc.invalidateQueries({ queryKey: ["delivery", meetingId] });
    };
    conn.on("message", onMsg);
    conn.on("run-complete", onRun);
    conn
      .start()
      .then(() => {
        if (cancelled) {
          conn.stop();
          return;
        }
        setLive(true);
        conn.invoke("JoinMeeting", meetingId).catch(() => {});
      })
      .catch(() => {
        if (!cancelled) setLive(false);
      });
    conn.onreconnected(() => {
      conn.invoke("JoinMeeting", meetingId).catch(() => {});
    });
    return () => {
      cancelled = true;
      setLive(false);
      conn.stop();
      hubRef.current = null;
    };
  }, [meetingId, meetingOk, qc]);
  const msgParentRef = useRef<HTMLDivElement | null>(null);
  const msgList = messages.data ?? [];
  const rows = useMemo(() => {
    const bySeq = new Map(msgList.map((m) => [m.sequence, m]));
    const topAncestor = (m: Msg): Msg => {
      let cur = m;
      const seen = new Set<number>();
      while (
        cur.parentSequence != null &&
        bySeq.has(cur.parentSequence) &&
        !seen.has(cur.sequence)
      ) {
        seen.add(cur.sequence);
        cur = bySeq.get(cur.parentSequence)!;
      }
      return cur;
    };
    const kids = new Map<number, Msg[]>();
    const tops: Msg[] = [];
    for (const m of msgList) {
      const top = topAncestor(m);
      if (top === m) tops.push(m);
      else {
        const arr = kids.get(top.sequence) ?? [];
        arr.push(m);
        kids.set(top.sequence, arr);
      }
    }
    const out: { m: Msg; depth: number; parent: Msg | null }[] = [];
    for (const t of tops) {
      out.push({ m: t, depth: 0, parent: null });
      for (const k of (kids.get(t.sequence) ?? []).sort(
        (a, b) => a.sequence - b.sequence,
      ))
        out.push({
          m: k,
          depth: 1,
          parent:
            k.parentSequence != null
              ? (bySeq.get(k.parentSequence) ?? null)
              : null,
        });
    }
    return out;
  }, [msgList]);
  const msgVirtual = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 120,
    overscan: 8,
    measureElement: (el) => el?.getBoundingClientRect().height ?? 120,
  });
  const [meetTab, setMeetTab] = useState<
    "chat" | "takeaways" | "options" | "decision"
  >(route0.mtab);
  const [audience, setAudience] = useState("everyone");
  const [replyTo, setReplyTo] = useState<{ seq: number; who: string } | null>(
    null,
  );
  useEffect(() => {
    if (prevMeeting.current === null) {
      // Mount: keep any deep-linked record context from the URL.
      prevMeeting.current = meetingId;
    } else if (prevMeeting.current !== meetingId) {
      prevMeeting.current = meetingId;
      // A hash traversal pre-sets prevMeeting in apply(), so this branch
      // only runs for user switches (which keep a Back entry via push).
      setRecId("");
      resetMeetingOwnedState();
    } else {
      setReplyTo(null);
    }
    firstAuto.current = true;
    setAtBottom(true);
  }, [meetingId]);
  const [excerpts, setExcerpts] = useState<Excerpt[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const lastSeen = useRef(0);
  const latestSeq = msgList.length ? msgList[msgList.length - 1].sequence : 0;
  useEffect(() => {
    if (!latestSeq) return;
    if (atBottom) {
      lastSeen.current = latestSeq;
      setNewCount(0);
    } else setNewCount(Math.max(0, latestSeq - lastSeen.current));
  }, [latestSeq, atBottom]);
  const firstAuto = useRef(true);
  useEffect(() => {
    if (atBottom && latestSeq) {
      if (firstAuto.current) { firstAuto.current = false; }
      else window.scrollTo({ top: document.documentElement.scrollHeight });
    }
  }, [latestSeq, atBottom]);
  useEffect(() => {
    prevLatest.current = latestSeq;
  });
  const jumpToMessage = (seq: number | null | undefined) => {
    if (seq == null) return;
    const el = document.getElementById("msg-" + seq);
    if (!el) {
      notify("That message is outside the loaded window.");
      return;
    }
    el.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "center",
    });
    el.classList.add("flash");
    window.setTimeout(() => el.classList.remove("flash"), 1200);
  };
  useEffect(() => {
    const onScroll = () => {
      const el = document.documentElement;
      setAtBottom(window.innerHeight + window.scrollY >= el.scrollHeight - 60);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [meetingId]);
  const scrollToLatest = () => {
    window.scrollTo({ top: document.documentElement.scrollHeight });
    setAtBottom(true);
  };
  const [theme, setTheme] = useState(
    () => localStorage.getItem("simceo-theme") ?? "light",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("simceo-theme", theme);
  }, [theme]);
  const [density, setDensity] = useState(
    () => localStorage.getItem("simceo-density") ?? "comfortable",
  );
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    setNavOpen(false);
  }, [tab]);
  // Mobile nav focus + inert: a closed drawer must be untabbable, Escape or
  // the backdrop returns focus to the opener, and opening moves focus in.
  // The breakpoint subscription keeps inert/aria-hidden correct when the
  // viewport crosses 820px without a nav toggle (e.g. mobile to desktop).
  const navOpenRef = useRef(navOpen);
  navOpenRef.current = navOpen;
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const mq = window.matchMedia("(max-width: 820px)");
    const focusFirst = (tries: number) => {
      if (!navOpenRef.current) return;
      const el = nav.querySelector("button") as HTMLElement | null;
      el?.focus?.();
      // inert removal is processed asynchronously by the browser; a single
      // deferred focus() can still land while the subtree is inert (a silent
      // no-op), so retry until focus sticks or the drawer closes.
      if (el && document.activeElement !== el && tries < 12) {
        window.setTimeout(() => focusFirst(tries + 1), 50);
      }
    };
    const syncMode = (isMobile: boolean) => {
      if (navOpenRef.current) {
        nav.removeAttribute("inert");
        nav.removeAttribute("aria-hidden");
        const ae =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        // Preserve the external opener across breakpoint changes: never
        // overwrite it with a rail child (which becomes inert on narrow).
        if (!ae || !nav.contains(ae)) {
          openerRef.current = ae;
        }
        if (isMobile) window.setTimeout(() => focusFirst(0), 0);
      } else {
        if (nav.contains(document.activeElement)) {
          const opener =
            openerRef.current ??
            document.querySelector('[aria-label="Open navigation"]');
          (opener as HTMLElement | null)?.focus();
        }
        if (isMobile) {
          nav.setAttribute("inert", "");
          nav.setAttribute("aria-hidden", "true");
        } else {
          nav.removeAttribute("inert");
          nav.removeAttribute("aria-hidden");
        }
      }
    };
    syncMode(mq.matches);
    const onChange = (e: MediaQueryListEvent) => syncMode(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [navOpen]);
  const railListRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // Arrow/Home/End travel between rail destinations; Escape is global.
  const railKeys = (e: {
    key: string;
    preventDefault(): void;
    target: EventTarget | null;
  }) => {
    if (
      e.key !== "ArrowDown" &&
      e.key !== "ArrowUp" &&
      e.key !== "Home" &&
      e.key !== "End"
    )
      return;
    const btns = Array.from(
      navRef.current?.querySelectorAll("button") ?? [],
    ) as HTMLElement[];
    const i = btns.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    const n =
      e.key === "ArrowDown"
        ? (i + 1) % btns.length
        : e.key === "ArrowUp"
          ? (i + btns.length - 1) % btns.length
          : e.key === "Home"
            ? 0
            : btns.length - 1;
    btns[n]?.focus();
  };
  const listpanelRowsRef = useRef<HTMLDivElement | null>(null);
  const listpanelScroll = useRef<Record<string, number>>({});
  useEffect(() => {
    const el = listpanelRowsRef.current;
    const saved = listpanelScroll.current[tab];
    if (el && saved) el.scrollTop = saved;
  }, [tab]);
  const [pill, setPill] = useState({ top: 0, height: 0, show: false });
  const [navTip, setNavTip] = useState<{ label: string; top: number; left: number } | null>(null);
  const showNavTip = (label: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setNavTip({ label, top: r.top + r.height / 2, left: r.right + 10 });
  };
  const hideNavTip = () => setNavTip(null);
  useEffect(() => {
    const measure = () => {
      const root = railListRef.current;
      if (!root) return;
      const active = root.querySelector(
        '[aria-current="page"]',
      ) as HTMLElement | null;
      if (!active) {
        setPill((p) => (p.show ? { ...p, show: false } : p));
        return;
      }
      let top = 0;
      let el: HTMLElement | null = active;
      while (el && el !== root) {
        top += el.offsetTop;
        el = el.offsetParent as HTMLElement | null;
      }
      setPill({ top, height: active.offsetHeight, show: true });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [tab, boardId, navOpen]);
  const [contextTab, setContextTab] = useState<
    "members" | "context" | "decisions"
  >(route0.ctab);
  const [contextCollapsed, setContextCollapsed] = useState(false);
  const [recordFlash, setRecordFlash] = useState(false);
  const prevRecordKey = useRef("");
  const prevLatest = useRef(0);
  const [fbUser, setFbUser] = useState(() => {
    try {
      return localStorage.getItem("simceo-fb-user-v2") ?? "";
    } catch {
      return "";
    }
  });
  const fbSignIn = () => {
    const name = "Steve Wellauer";
    try {
      localStorage.setItem("simceo-fb-user-v2", name);
    } catch {}
    setFbUser(name);
    notify("Signed in with Facebook (demo profile).");
  };
  const fbSignOut = () => {
    try {
      localStorage.removeItem("simceo-fb-user-v2");
    } catch {}
    setFbUser("");
    notify("Signed out.");
  };
  useEffect(() => {
    document.documentElement.dataset.density = density;
    localStorage.setItem("simceo-density", density);
  }, [density]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && navOpen) {
        e.preventDefault();
        setNavOpen(false);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        if (tab === "meet" && draft.trim()) {
          e.preventDefault();
          submitDraft();
        }
        return;
      }
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT")
      )
        return;
      if (e.altKey && !e.ctrlKey && !e.metaKey && /^[0-9]$/.test(e.key)) {
        const i = e.key === "0" ? 9 : Number(e.key) - 1;
        const visible = navGroups
          .flatMap((g) => g.items)
          .filter(([k]) => boardId || !needsBoard.includes(k));
        if (i < visible.length) {
          e.preventDefault();
          setTab(visible[i][0]);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    if (!boardId && needsBoard.includes(tab)) setTab("boards");
  }, [boardId, tab]);
  const sources = useQuery({
    queryKey: ["sources", boardId],
    queryFn: () => get<Source[]>(`/api/boards/${boardId}/sources`),
    enabled: !!boardId && boardOk && tab === "sources",
  });
  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: () => get<Job[]>("/api/activity/jobs"),
    enabled: tab === "activity",
  });
  const usage = useQuery({
    queryKey: ["usage", uday, ufrom, uto, boardId],
    queryFn: () =>
      get<UsageRow[]>(
        `/api/usage?${new URLSearchParams({ ...(boardId ? { boardId } : {}), ...(uday ? { day: uday } : {}), ...(ufrom ? { from: ufrom } : {}), ...(uto ? { to: uto } : {}) })}`,
      ),
    enabled: tab === "activity" && (!boardId || boardOk),
  });
  const lead = useQuery({
    queryKey: ["lead", boardId],
    queryFn: () => get<Lead>(`/api/boards/${boardId}/lead`),
    enabled:
      !!boardId && (tab === "profile" || tab === "meet"),
    retry: false,
  });
  const setup = useQuery({
    queryKey: ["setup", boardId],
    queryFn: () => get<Setup>(`/api/boards/${boardId}/setup`),
    enabled: !!boardId && boardOk && tab === "boards",
  });
  const [leadForm, setLeadForm] = useState({
    name: "",
    roleLabel: "Board Lead",
    background: "",
    familiarTopics: "",
    simplerTopics: "",
    commPrefs: "",
  });
  const [leadLoaded, setLeadLoaded] = useState("");
  const [leadBoard, setLeadBoard] = useState("");
  useEffect(() => {
    if (!boardId) return;
    // P2 #9: track board identity independently from fetched lead identity, so
    // switching boards always clears the form synchronously, even when both
    // boards have no saved lead (leadLoaded === "" on both sides).
    if (leadBoard !== boardId) {
      setLeadBoard(boardId);
      setLeadLoaded("");
      setLeadForm({ name: "", roleLabel: "Board Lead", background: "", familiarTopics: "", simplerTopics: "", commPrefs: "" });
      return;
    }
    const key = lead.data ? boardId + ":" + lead.data.id + ":" + String(lead.data.version) : "";
    if (!lead.data) {
      if (leadLoaded !== "") {
        setLeadForm({ name: "", roleLabel: "Board Lead", background: "", familiarTopics: "", simplerTopics: "", commPrefs: "" });
        setLeadLoaded("");
      }
      return;
    }
    // Ignore a stale arrival from another board during refetch: the payload must
    // belong to the current board or the global fallback. Same-board background
    // refetch still cannot clobber unsaved edits unless the fetched
    // identity/version actually changed (key check below).
    const dataBoard: string = lead.data.boardId || "";
    if (dataBoard !== "" && dataBoard !== boardId && dataBoard !== "00000000-0000-0000-0000-000000000000") return;
    if (key !== leadLoaded) {
      setLeadForm({
        name: lead.data.name,
        roleLabel: lead.data.roleLabel,
        background: lead.data.background,
        familiarTopics: lead.data.familiarTopics,
        simplerTopics: lead.data.simplerTopics,
        commPrefs: lead.data.commPrefs,
      });
      setLeadLoaded(key);
    }
  }, [lead.data, boardId, leadLoaded, leadBoard]);
  const saveLead = useMutation({
    mutationFn: () =>
      post<Lead>(`/api/boards/${boardId}/lead`, {
        ...leadForm,
        version: lead.data?.version ?? 0,
      }),
    onSuccess: () => {
      refresh("lead", "setup");
    },
    onError: (e) => alert(`Save rejected (refresh and re-apply): ${String(e)}`),
  });
  const [boardForm, setBoardForm] = useState({
    name: "",
    mission: "",
    stage: "",
  });
  const [boardLoaded, setBoardLoaded] = useState("");
  useEffect(() => {
    if (!setup.data) return;
    const key =
      setup.data.board.id +
      "|" +
      setup.data.draftHash +
      "|" +
      setup.data.board.name +
      "|" +
      setup.data.board.mission +
      "|" +
      setup.data.board.stage;
    if (boardLoaded !== key) {
      setBoardForm({
        name: setup.data.board.name,
        mission: setup.data.board.mission,
        stage: setup.data.board.stage,
      });
      setBoardLoaded(key);
    }
  }, [setup.data, boardLoaded]);
  const saveBoard = useMutation({
    mutationFn: () => patch<Board>(`/api/boards/${boardId}`, boardForm),
    onMutate: () => ({ originBoardId: boardId }),
    onSuccess: (r, _v, ctx) => {
      const returned = r as Board | undefined;
      const key = returned?.id ?? (ctx as { originBoardId?: string } | undefined)?.originBoardId ?? boardId;
      qc.setQueryData(["board-detail", key], r);
      refresh("boards", "board-detail", "setup");
    },
  });
  const activate = useMutation({
    mutationFn: (hash: string) =>
      post<Board>(`/api/boards/${boardId}/setup/activate`, { hash }),
    onSuccess: () => {
      refresh("setup", "boards");
      notify("Configuration activated.");
    },
    onError: (e) => alert(`Activation blocked: ${String(e)}`),
  });
  const saveBoardOpts = useMutation({
    mutationFn: (b: unknown) => patch<Board>(`/api/boards/${boardId}`, b),
    onMutate: () => ({ originBoardId: boardId }),
    onSuccess: (r, _v, ctx) => {
      const returned = r as Board | undefined;
      const key = returned?.id ?? (ctx as { originBoardId?: string } | undefined)?.originBoardId ?? boardId;
      qc.setQueryData(["board-detail", key], r as Board);
      refresh("setup", "boards", "board-detail");
    },
  });
  const status = useQuery({
    queryKey: ["status", boardId],
    queryFn: () => get<BoardStatus>(`/api/boards/${boardId}/status`),
    enabled: !!boardId && boardOk && tab === "boards",
  });
  const [wizId, setWizId] = useState(
    () => localStorage.getItem("simceo-wizard") ?? "",
  );
  const [wizVersion, setWizVersion] = useState<number | null>(null);
  // P2 finding2: latest-value refs keep the wizard save/hydrate lifecycles
  // auditable. Saves capture the fields/step visible at click time instead of
  // a stale render closure; hydration compares late arrivals against newer
  // local progress before applying them.
  const wizIdRef = useRef(wizId);
  wizIdRef.current = wizId;
  const wizVersionRef = useRef<number | null>(wizVersion);
  wizVersionRef.current = wizVersion;
  const wizardRef = useRef(wizard);
  wizardRef.current = wizard;
  const presetKeyRef = useRef(presetKey);
  presetKeyRef.current = presetKey;
  // Exact payload of the last attempted save. Hydration still adopts the
  // server version but keeps newer local fields/step when they differ from
  // what was sent (typed during the save/GET flight). A rejected save stores
  // a sentinel mismatch so the next hydration also keeps local progress
  // until the user successfully saves again.
  const wizLastSentRef = useRef<{ step: number; presetKey: string; fields: string } | null>(null);
  // P2: synchronous identity-aware known-version store. Render-synced refs
  // update only during React render, so two responses settling in the same
  // tick can both pass a stale comparison and commit a downgrade (known v2,
  // enqueue v4, enqueue v3, commit v3). Every version-accept path advances
  // this store synchronously in the response handler instead.
  const wizKnownRef = useRef<{ id: string; version: number | null }>({ id: "", version: null });
  // TEST-ANCHOR-START: nextKnownWizVersion
  const nextKnownWizVersion = (known: { id: string; version: number | null }, id: string, v: number) => {
    if (typeof v !== "number") return known;
    if (known.id !== id || known.version == null || v >= known.version) return { id, version: v };
    return known;
  };
  // TEST-ANCHOR-END: nextKnownWizVersion
  // Monotonic state update for the current draft: advances the synchronous
  // store and only enqueues a React state change when it actually moves.
  // Stale responses for the same draft return the identical store object and
  // enqueue nothing, so a delayed older GET can never downgrade the guard.
  const acceptWizVersion = (id: string, v: number) => {
    const next = nextKnownWizVersion(wizKnownRef.current, id, v);
    if (next !== wizKnownRef.current) {
      wizKnownRef.current = next;
      setWizVersion(v);
    }
  };
  // Version-only refresh after a rejected save: adopts the fresh strict
  // version guard without touching local fields/step, so the next save
  // retries with the current inputs instead of silently discarding them.
  const refreshWizVersionOnly = (id?: string) => {
    const target = id ?? wizIdRef.current;
    if (!target) return;
    get<{ version: number }>(`/api/wizard/${target}`).then((d) => {
      if (wizIdRef.current !== target) return;
      // Synchronous identity-aware monotonic update: a delayed older response
      // is ignored entirely and can never downgrade the strict guard.
      if (typeof d.version === "number") acceptWizVersion(target, d.version);
    }).catch(() => { /* keep local edits; version stays for explicit retry */ }).finally(() => {
      refresh("wizreview");
    });
  };
  const [guide, setGuide] = useState<{
    suggestion: string;
    nextQuestion: string;
    fields?: {
      mission?: string;
      stage?: string;
      roles?: { role: string; why?: string }[];
      lead?: Record<string, string>;
    };
  } | null>(null);
  const wizSave = useMutation({
    // The optional argument persists the intended next step explicitly:
    // Continue passes the step it advances to locally, so the server draft
    // and the local progress agree even before the delayed hydration lands.
    mutationFn: (nextStep?: number) => {
      const w = wizardRef.current;
      const stepToSave = typeof nextStep === "number" ? nextStep : w.step;
      const presetToSave = presetKeyRef.current;
      const fieldsJson = JSON.stringify({
        name: w.name,
        mission: w.mission,
        stage: w.stage,
        lead: w.lead,
        advisors: w.seats,
      });
      wizLastSentRef.current = { step: stepToSave, presetKey: presetToSave, fields: fieldsJson };
      return post<{ id: string; version: number }>("/api/wizard", {
        id: wizIdRef.current || undefined,
        ...(wizVersionRef.current != null ? { version: wizVersionRef.current } : {}),
        accountId,
        step: stepToSave,
        presetKey: presetToSave,
        fieldsJson,
      });
    },
    onSuccess: (r) => {
      setWizId(r.id);
      if (typeof r.version === "number") acceptWizVersion(r.id, r.version);
      localStorage.setItem("simceo-wizard", r.id);
      refresh("wizreview");
    },
    onError: (e) => {
      alert(String(e));
      // Never auto-hydrate fields/step after a rejected save: that would
      // silently overwrite the unsaved inputs the user just typed.
      wizLastSentRef.current = { step: -1, presetKey: "\0", fields: "\0" };
      refreshWizVersionOnly();
    },
  });
  const wizReview = useQuery({
    queryKey: ["wizreview", wizId],
    queryFn: () =>
      get<{
        step: number;
        preset: string;
        status: string;
        blockers: { field: string; step: number; message: string }[];
        fields: { field: string; step: number; status: string }[];
      }>(`/api/wizard/${wizId}/review`),
    enabled: tab === "wizard" && !!wizId,
  });
  const guideInput = () => {
    if (wizard.step === 2)
      return `Advisors so far: ${wizard.seats.map((s) => s.role).join(", ") || "none"}. Mission: ${wizard.mission}`;
    if (wizard.step === 3)
      return `Lead so far: ${wizard.lead.name} ${wizard.lead.roleLabel} ${wizard.lead.background}`;
    return `${wizard.name} ${wizard.mission} ${wizard.stage}`;
  };
  const suggest = useMutation({
    mutationFn: () =>
      post<{ suggestion: string; nextQuestion: string; fields?: unknown }>(
        `/api/wizard/${wizId}/suggest`,
        { step: wizard.step, input: guideInput() },
      ),
    onSuccess: (r) =>
      setGuide({
        suggestion: r.suggestion,
        nextQuestion: r.nextQuestion,
        fields: (
          r as {
            fields?: {
              mission?: string;
              stage?: string;
              roles?: { role: string; why?: string }[];
              lead?: Record<string, string>;
            };
          }
        ).fields,
      }),
    onError: (e) => alert(String(e)),
  });
  const [ianswer, setIanswer] = useState("");
  const [iturns, setIturns] = useState<{ question: string; answer: string; analysis: string }[]>([]);
  const [ichecks, setIchecks] = useState<{ at: string; text: string }[]>([]);
  const [iquestion, setIquestion] = useState("");
  const hydrateWizard = async (targetId?: string) => {
    const id = targetId ?? wizIdRef.current;
    if (!id) return;
    const beforeSnap = JSON.stringify({ w: wizardRef.current, p: presetKeyRef.current });
    try {
      const d = await get<{ presetKey: string; step: number; version: number; fieldsJson: string; interviewJson: string }>(`/api/wizard/${id}`);
      // Discard late arrivals whose draft changed or was retired in flight
      // (a new draft started, or create-board consumed the id and cleared it).
      if (wizIdRef.current !== id) return;
      // Monotonic version within the same draft: a delayed older GET (fresh
      // save v3 then stale GET v2) must neither downgrade the strict guard
      // nor rewind fields to its older snapshot — ignore it entirely.
      const srvVer = typeof d.version === "number" ? d.version : null;
      if (srvVer != null) {
        // Stale responses for this draft are ignored entirely: no version
        // downgrade and no field rewind. Fresh responses advance the
        // synchronous store before any state below is applied.
        const k = wizKnownRef.current;
        if (k.id === id && k.version != null && srvVer < k.version) return;
        acceptWizVersion(id, srvVer);
      }
      // Discard stale hydration when newer local edits/progress changed
      // during the GET flight; the version above is still adopted so the next
      // save carries the strict guard without losing local inputs.
      const afterSnap = JSON.stringify({ w: wizardRef.current, p: presetKeyRef.current });
      if (afterSnap !== beforeSnap) return;
      // Discard when local progress is newer than the last attempted save
      // (typed during the save flight, before this GET even started). The
      // first resume in a fresh session has no sent baseline, so real resume
      // GETs still apply below.
      const sent = wizLastSentRef.current;
      // Unsaved field/preset edits reject the whole arrival (fields AND step).
      // An explicit local step change (Back) since the last clean sync keeps
      // the local step while still adopting the version and newer fields, so
      // a later interview extract can apply without an intermediate save.
      let keepLocalStep = false;
      if (sent) {
        const w = wizardRef.current;
        const currentFields = JSON.stringify({
          name: w.name,
          mission: w.mission,
          stage: w.stage,
          lead: w.lead,
          advisors: w.seats,
        });
        if (currentFields !== sent.fields || presetKeyRef.current !== sent.presetKey) return;
        keepLocalStep = w.step !== sent.step;
      }
      const f = JSON.parse(d.fieldsJson || "{}");
      // Snapshot pre-apply state: the baseline below must describe exactly
      // what this accepted hydration writes (same fallbacks as the setters).
      const wPrev = wizardRef.current;
      const mergedLead = { ...wPrev.lead, ...(f.lead ?? {}) };
      const mergedSeats: { role: string; name: string }[] = Array.isArray(f.advisors)
        ? f.advisors.map((s: { role: string; name: string }) => ({ role: s.role ?? "", name: s.name ?? "" }))
        : wPrev.seats;
      setWizard((w) => ({
        ...w,
        name: f.name ?? w.name,
        mission: f.mission ?? w.mission,
        stage: f.stage ?? w.stage,
        seats: Array.isArray(f.advisors) ? f.advisors.map((s: { role: string; name: string }) => ({ role: s.role ?? "", name: s.name ?? "" })) : w.seats,
        lead: { ...w.lead, ...(f.lead ?? {}) },
      }));
      if (d.presetKey) setPresetKey(d.presetKey);
      // A background arrival never yanks explicit local navigation: when the
      // user moved (Back) since the last clean sync, fields still apply but
      // the local step stands until the next save makes it the baseline.
      if (!keepLocalStep && typeof d.step === "number" && d.step >= 1 && d.step <= 4)
        setWizard((w) => ({ ...w, step: d.step }));
      // The server state was accepted above: advance the last-clean baseline
      // to what was just applied, so a later hydration (e.g. the second of
      // two interview GETs) is not rejected as newer local edits. Dirty local
      // edits never reach here — the guards above return early when present.
      // When the local step was kept, the baseline still records the server
      // step so later arrivals keep respecting the explicit navigation.
      wizLastSentRef.current = {
        step: (typeof d.step === "number" && d.step >= 1 && d.step <= 4) ? d.step : wPrev.step,
        presetKey: d.presetKey || presetKeyRef.current,
        fields: JSON.stringify({
          name: f.name ?? wPrev.name,
          mission: f.mission ?? wPrev.mission,
          stage: f.stage ?? wPrev.stage,
          lead: mergedLead,
          advisors: mergedSeats,
        }),
      };
      try {
        const ij = JSON.parse(d.interviewJson || "{}");
        if (Array.isArray(ij.turns)) setIturns(ij.turns);
        if (Array.isArray(ij.checkpoints)) setIchecks(ij.checkpoints);
        if (typeof ij.pendingQuestion === "string" && ij.pendingQuestion) setIquestion(ij.pendingQuestion);
      } catch { /* keep current interview state */ }
    } catch { /* draft may be gone; keep local edits */ }
  };
  useEffect(() => { if (wizId) { hydrateWizard(wizId); } }, [wizId]);
  const askInterview = useMutation({
    mutationFn: (answer: string) =>
      post<{ question: string; analysis: string; applied: string[]; turns: { question: string; answer: string; analysis: string }[]; checkpoints: { at: string; text: string }[]; version: number }>(
        `/api/wizard/${wizId}/interview`, { answer, ...(wizVersion != null ? { version: wizVersion } : {}) },
      ),
    onSuccess: (r) => {
      setIturns(r.turns ?? []);
      setIchecks(r.checkpoints ?? []);
      setIquestion(r.question ?? "");
      if (typeof r.version === "number") acceptWizVersion(wizIdRef.current, r.version);
      setIanswer("");
      hydrateWizard();
      refresh("wizreview");
    },
    onError: (e) => {
      alert(String(e));
      // Same 409 protection as wizSave: adopt the fresh version only, never
      // overwrite unsaved inputs with a conflicting hydration.
      wizLastSentRef.current = { step: -1, presetKey: "\0", fields: "\0" };
      refreshWizVersionOnly();
    },
  });
  const applyGuideRoles = (roles?: { role: string }[]) => {
    if (!roles || roles.length === 0) return;
    const have = new Set(wizard.seats.map((s) => s.role.toLowerCase()));
    const add = roles
      .filter((r) => r.role && !have.has(r.role.toLowerCase()))
      .slice(0, 10 - wizard.seats.length)
      .map((r) => ({ role: r.role, name: "" }));
    if (add.length > 0)
      setWizard({ ...wizard, seats: [...wizard.seats, ...add] });
  };
  const createBoardFromWizard = useMutation({
    mutationFn: () =>
      post<{ board: Board; advisors: { advisor: string; role: string }[] }>(
        `/api/wizard/${wizId}/create`,
        { ...(wizVersion != null ? { version: wizVersion } : {}) },
      ),
    onSuccess: (r) => {
      // Seed the new board into the list + detail caches before the
      // invalidated list returns, so a delayed refresh never discards the
      // just-created selection as "absent".
      qc.setQueryData<Board[]>(["boards"], (old) =>
        old
          ? [...old.filter((b) => b.id !== r.board.id), r.board]
          : [r.board],
      );
      qc.setQueryData(["board-detail", r.board.id], r.board);
      setBoardId(r.board.id);
      setMeetingId("");
      refresh("boards", "board-detail", "advisors", "roster", "roster-count", "roster-names", "lead");
      // Consume the completed wizard draft only after success: retire the
      // id, storage, fields and interview state so the next New board is a
      // fresh Step 1 that creates a DISTINCT board. Unfinished drafts survive
      // logo/ordinary navigation because this runs solely on success.
      try { localStorage.removeItem("simceo-wizard"); } catch { /* private-mode */ }
      setWizId("");
      setWizVersion(null);
      // Retire the save baseline with the completed draft: a late hydration
      // for the old id is already discarded by the wizId check, and the next
      // new draft starts with no sent baseline so its resume applies.
      wizLastSentRef.current = null;
      // Keep draft identity separate: the next draft must not inherit this
      // draft's known version through the synchronous store.
      wizKnownRef.current = { id: "", version: null };
      setWizard({
        name: "",
        mission: "",
        stage: "",
        step: 1,
        seats: [],
        lead: {
          name: "",
          roleLabel: "Board Lead",
          background: "",
          familiarTopics: "",
          simplerTopics: "",
          commPrefs: "",
        },
      });
      setSeatRole("");
      setSeatName("");
      setPresetKey("strategy");
      setGuide(null);
      setIturns([]);
      setIchecks([]);
      setIquestion("");
      setIanswer("");
      setTab("advisors");
      notify("Board created. Accept a portrait for each advisor, then approve.");
    },
    onError: (e) => alert(String(e)),
  });
  const [rq, setRq] = useState("");
  const [rtype, setRtype] = useState("");
  const [rtag, setRtag] = useState("");
  const rosterList = useQuery({
    queryKey: ["roster", accountId, rq, rtype, rtag],
    queryFn: () =>
      get<RosterRow[]>(
        `/api/roster?${new URLSearchParams({ accountId, ...(rq ? { q: rq } : {}), ...(rtype ? { type: rtype } : {}), ...(rtag ? { tag: rtag } : {}) })}`,
      ),
    enabled: tab === "roster",
  });
  const rosterRows = rosterList.data ?? [];
  const [selRoster, setSelRoster] = useState("");
  const selRow = (rosterRows ?? []).find((r) => r.entry.id === selRoster);
  const selImages = useQuery({
    queryKey: ["roster-images", selRoster],
    queryFn: () =>
      get<{ id: string; kind: string; provenance: string; review: string }[]>(`/api/roster/${selRoster}/images`),
    enabled: !!selRoster,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const closeCreate = () => setCreateOpen(false);
  const reviewImg = useMutation({
    mutationFn: (args: { id: string; decision: string }) =>
      post<unknown>(`/api/images/${args.id}/review`, { decision: args.decision }),
    onSuccess: () => refresh("roster-images", "roster", "roster-names", "advisors"),
    onError: (e) => alert(String(e)),
  });
  const selectRoster = (id: string) => {
    setSelRoster(id);
    setAudId(id);
    setAq("");
    setAudResult("");
    setDossier("");
    const row = (rosterRows ?? []).find((r) => r.entry.id === id);
    const saved = row?.entry.researchJson;
    if (saved && saved !== "{}") {
      try { setDossier(JSON.stringify(JSON.parse(saved), null, 1)); } catch { setDossier(saved); }
    }
  };
const rosterNames = useQuery({
  queryKey: ["roster-names", accountId],
  queryFn: () =>
    get<RosterRow[]>(
      `/api/roster?${new URLSearchParams({ accountId })}`,
    ),
});

const rosterCount = useQuery({
  queryKey: ["roster-count", accountId],
  queryFn: () =>
    get<{ total: number }>(
      `/api/roster/count?${new URLSearchParams({ accountId })}`,
    ),
});
const tabCount = (k: Tab): number | null => {
  if (k === "boards") return boards.data ? boards.data.length : null;
  if (k === "roster") return rosterCount.data ? rosterCount.data.total : null;
  return null;
};

  const rosterParentRef = useRef<HTMLDivElement | null>(null);
  const rosterVirtual = useVirtualizer({
    count: rosterRows.length,
    getScrollElement: () => rosterParentRef.current,
    estimateSize: () => 150,
    overscan: 4,
  });
  const copyAdv = useMutation({
    mutationFn: (row: RosterRow) =>
      post<unknown>(`/api/roster/${row.entry.id}/copy`, {
        boardId,
        boardRole: row.entry.name,
      }),
    onSuccess: () => {
      refresh("roster", "roster-count", "roster-names", "advisors");
    },
    onError: (e) => alert(String(e)),
  });
  const archiveRoster = useMutation({
    mutationFn: (row: RosterRow) =>
      post<unknown>(`/api/roster/${row.entry.id}/archive`, {
        archived: !row.entry.archived,
      }),
    onSuccess: () => refresh("roster", "roster-count", "roster-names"),
  });
  const [cname, setCname] = useState("");
  const createNameRef = useRef<HTMLInputElement | null>(null);
  const focusCreateForm = () => {
    setCnewId("");
    setCreateOpen(true);
    window.setTimeout(() => createNameRef.current?.focus(), 100);
  };
  const [cdesc, setCdesc] = useState("");
  const [cnewId, setCnewId] = useState("");
  const [cportraitUrl, setCportraitUrl] = useState("");
  const [cportraitMsg, setCportraitMsg] = useState("");
  const createChar = useMutation({
    mutationFn: () =>
      post<{ id: string }>("/api/roster/quick", {
        accountId,
        name: cname,
        description: cdesc,
      }),
    onSuccess: (r) => {
      setCnewId(r.id);
      setCportraitMsg("");
      refresh("roster", "roster-count", "roster-names");
    },
    onError: (e) => alert(String(e)),
  });
  const uploadNewPortrait = async (f: File | undefined) => {
    if (!f || !cnewId) return;
    const fd = new FormData();
    fd.append("file", f);
    try {
      await upload<unknown>(`/api/roster/${cnewId}/image/upload`, fd);
      setCportraitMsg("Portrait added.");
      refresh("roster", "roster-images");
    } catch (e) {
      setCportraitMsg(String(e));
    }
  };
  const urlNewPortrait = useMutation({
    mutationFn: () =>
      post<unknown>(`/api/roster/${cnewId}/image/url`, { url: cportraitUrl, source: "owner-provided" }),
    onSuccess: () => {
      setCportraitUrl("");
      setCportraitMsg("Portrait added.");
      refresh("roster", "roster-images");
    },
    onError: (e) => setCportraitMsg(String(e)),
  });
  const genNewPortrait = useMutation({
    mutationFn: () => post<unknown>(`/api/roster/${cnewId}/image/generate`, { count: 1 }),
    onSuccess: () => {
      setCportraitMsg("Portrait generated.");
      refresh("roster", "roster-images");
    },
    onError: (e) => setCportraitMsg(String(e)),
  });
  const finishNewEntry = () => {
    const doneId = cnewId;
    setCnewId("");
    setCname("");
    setCdesc("");
    setCportraitMsg("");
    setCportraitUrl("");
    refresh("roster", "roster-count", "roster-names");
    setCreateOpen(false);
    if (doneId) { setSelRoster(doneId); setAudId(doneId); }
  };
  const [ainame, setAiname] = useState("");
  const [airole, setAirole] = useState("");
  const [aifocus, setAifocus] = useState("");
  const [aiMsg, setAiMsg] = useState("");
  const aiDraft = useMutation({
    mutationFn: () =>
      post<{ entry: { id: string }; researched: boolean; citations: number; note: string }>("/api/roster/ai-draft", {
        accountId,
        name: ainame,
        role: airole,
        focus: aifocus,
      }),
    onSuccess: (r) => {
      setCnewId(r.entry.id);
      setAiMsg(`Drafted. ${r.note}`);
      setAiname("");
      setAirole("");
      setAifocus("");
      refresh("roster", "roster-count", "roster-names");
    },
    onError: (e) => setAiMsg(String(e)),
  });
  const [audId, setAudId] = useState("");
  const [aq, setAq] = useState("");
  const [audResult, setAudResult] = useState("");
  const runAud = useMutation({
    mutationFn: () =>
      post<{ answer: string }>(`/api/auditions`, {
        rosterId: audId || undefined,
        question: aq,
      }),
    onSuccess: (r) => setAudResult(r.answer),
    onError: (e) => alert(String(e)),
  });
  const syncRoster = useMutation({
    mutationFn: (a: AdvisorFull) =>
      post<unknown>(`/api/boards/${boardId}/advisors/${a.id}/sync-roster`, {}),
    onSuccess: () => refresh("advisors"),
    onError: (e) => alert(String(e)),
  });
  const [selAdv, setSelAdv] = useState("");
  const [chatAdv, setChatAdv] = useState("");
  const [chatMsg, setChatMsg] = useState("");
  const [chatHist, setChatHist] = useState<{ role: string; content: string }[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatErr, setChatErr] = useState("");
  const chatSelAdvisor = (advisors.data ?? []).find((a) => a.id === chatAdv);
  const chatSelRoster = chatSelAdvisor ? (rosterNames.data ?? []).find((r) => r.entry.id === chatSelAdvisor.rosterEntryId) : undefined;
  const chatBlocked = !!chatSelAdvisor && chatSelRoster !== undefined && !chatSelRoster.complete;
  const sendChat = async () => {
    if (!boardId || !chatAdv || !chatMsg.trim() || chatBusy) return;
    setChatBusy(true);
    setChatErr("");
    const msg = chatMsg.trim();
    setChatMsg("");
    const hist = [...chatHist, { role: "lead", content: msg }];
    setChatHist(hist);
    try {
      const r = await post<{ answer: string }>(
        `/api/boards/${boardId}/advisors/${chatAdv}/chat`,
        { message: msg, history: hist.slice(-10) },
      );
      setChatHist([...hist, { role: "advisor", content: r.answer }]);
    } catch (e) {
      setChatErr(String(e));
      setChatHist(hist);
    } finally {
      setChatBusy(false);
    }
  };
  const [imgUrl, setImgUrl] = useState("");
  const [imgMsg, setImgMsg] = useState("");
  const selAdvisor = (advisors.data as AdvisorFull[] | undefined)?.find(
    (a) => a.id === selAdv,
  );
  const imgList = useQuery({
    queryKey: ["images", selAdvisor?.rosterEntryId],
    queryFn: () =>
      get<{ id: string; kind: string; provenance: string }[]>(
        `/api/roster/${selAdvisor?.rosterEntryId}/images`,
      ),
    enabled: tab === "advisors" && !!selAdvisor?.rosterEntryId,
  });
  const uploadImg = async (f: File | undefined) => {
    if (!f || !selAdvisor) return;
    const fd = new FormData();
    fd.append("file", f);
    try {
      await upload<unknown>(
        `/api/roster/${selAdvisor.rosterEntryId}/image/upload`,
        fd,
      );
      setImgMsg("Uploaded. Select it below to use.");
      refresh("images");
    } catch (e) {
      setImgMsg(String(e));
    }
  };
  const urlImg = useMutation({
    mutationFn: () =>
      post<unknown>(`/api/roster/${selAdvisor?.rosterEntryId}/image/url`, {
        url: imgUrl,
        source: "owner-provided",
      }),
    onSuccess: () => {
      setImgUrl("");
      setImgMsg("Imported. Select it below to use.");
      refresh("images");
    },
    onError: (e) => setImgMsg(String(e)),
  });
  const genImg = useMutation({
    mutationFn: () =>
      post<unknown>(`/api/roster/${selAdvisor?.rosterEntryId}/image/generate`, {
        count: 2,
      }),
    onSuccess: () => setImgMsg("Generated."),
    onError: (e) => setImgMsg(String(e)),
  });
  const selectImg = useMutation({
    mutationFn: (imgId: string) =>
      post<unknown>(`/api/images/${imgId}/select`, { boardAdvisorId: selAdv }),
    onSuccess: () => {
      refresh("advisors");
      setImgMsg("Selected for this board copy.");
    },
    onError: (e) => setImgMsg(String(e)),
  });
  const [mtitle, setMtitle] = useState("");
  const [mbrief, setMbrief] = useState("");
  const [mLoaded, setMLoaded] = useState("");
  // Headings and forms use the authoritative selected-entity detail first,
  // even when the meeting is outside every capped/filtered list window.
  const curMeeting =
    (meetingValid ? meetingDetail.data : undefined) ??
    (allMeetings.data ?? []).find((m) => m.id === meetingId) ??
    (meetings.data ?? []).find((m) => m.id === meetingId);
  useEffect(() => {
    if (curMeeting && mLoaded !== curMeeting.id + curMeeting.brief) {
      setMtitle(curMeeting.title);
      setMbrief(curMeeting.brief ?? "");
      setMLoaded(curMeeting.id + curMeeting.brief);
    }
  }, [curMeeting, mLoaded]);
  const briefText = curMeeting?.brief ?? "";
  useEffect(() => {
    if (tab !== "meet" || !meetingId || !boardId || !briefText.trim()) return;
    let dead = false;
    get<Excerpt[]>(
      `/api/boards/${boardId}/recall?q=${encodeURIComponent(briefText)}&take=5`,
    )
      .then((r) => {
        if (!dead) setExcerpts(r);
      })
      .catch(() => {
        if (!dead) setExcerpts([]);
      });
    return () => {
      dead = true;
    };
  }, [tab, meetingId, boardId, briefText]);
  const saveMeeting = useMutation({
    mutationFn: () =>
      patch<MeetingFull>(`/api/meetings/${meetingId}`, {
        title: mtitle,
        brief: mbrief,
      }),
    onMutate: () => ({ originBoardId: boardId, originMeetingId: meetingId }),
    onSuccess: (r, _v, ctx) => {
      const returned = r as MeetingFull | undefined;
      const keyBoard = returned?.boardId ?? (ctx as { originBoardId?: string } | undefined)?.originBoardId ?? boardId;
      const keyMeeting = (returned as { id?: string } | undefined)?.id ?? (ctx as { originMeetingId?: string } | undefined)?.originMeetingId ?? meetingId;
      qc.setQueryData(["meeting-detail", keyBoard, keyMeeting], r);
      refresh("meetings", "meeting-detail", "delivery");
    },
  });
  const closeMeeting = (withRecord: boolean) => {
    const originBoardId = boardId;
    const originMeetingId = meetingId;
    return post<MeetingFull>(`/api/meetings/${originMeetingId}/close`, { withRecord }).then((r) => {
      const keyBoard = (r as MeetingFull)?.boardId ?? originBoardId;
      const keyMeeting = (r as unknown as { id?: string })?.id ?? originMeetingId;
      qc.setQueryData(["meeting-detail", keyBoard, keyMeeting], r);
      refresh("meetings", "meeting-detail", "delivery");
    });
  };
  const reopenMeeting = () => {
    const originBoardId = boardId;
    const originMeetingId = meetingId;
    return post<MeetingFull>(`/api/meetings/${originMeetingId}/reopen`, {}).then((r) => {
      const keyBoard = (r as MeetingFull)?.boardId ?? originBoardId;
      const keyMeeting = (r as unknown as { id?: string })?.id ?? originMeetingId;
      qc.setQueryData(["meeting-detail", keyBoard, keyMeeting], r);
      refresh("meetings", "meeting-detail", "delivery");
    });
  };
  const delivery = useQuery({
    queryKey: ["delivery", meetingId],
    queryFn: () =>
      get<{
        state: string;
        deliveredRevision: number;
        messages: number;
        lastSequence: number;
      }>(`/api/meetings/${meetingId}/delivery`),
    enabled: !!meetingId && meetingOk && tab === "meet",
  });
  const [sq, setSq] = useState("");
  const [hits, setHits] = useState<
    {
      sequence: number;
      sender: string;
      advisorName?: string;
      excerpt: string;
    }[]
  >([]);
  const searchMsgs = () =>
    get<
      {
        sequence: number;
        sender: string;
        advisorName?: string;
        excerpt: string;
      }[]
    >(`/api/meetings/${meetingId}/messages/search?q=${encodeURIComponent(sq)}`)
      .then(setHits)
      .catch((e) => alert(String(e)));
  const notes = useQuery({
    queryKey: ["notes", meetingId],
    queryFn: () => get<Note[]>(`/api/meetings/${meetingId}/notes`),
    enabled: !!meetingId && meetingOk && tab === "meet",
  });
  const [ntitle, setNtitle] = useState("");
  const [nbody, setNbody] = useState("");
  const addNote = useMutation({
    mutationFn: () =>
      post<Note>(`/api/meetings/${meetingId}/notes`, {
        title: ntitle,
        body: nbody,
        kind: "note",
      }),
    onSuccess: () => {
      setNtitle("");
      setNbody("");
      refresh("notes");
    },
  });
  const [btopic, setBtopic] = useState("");
  const askBriefing = useMutation({
    mutationFn: () =>
      post<Note>(`/api/meetings/${meetingId}/briefings`, { topic: btopic }),
    onSuccess: () => {
      setBtopic("");
      refresh("notes");
    },
    onError: (e) => alert(String(e)),
  });
  const directions = useQuery({
    queryKey: ["directions", boardId],
    queryFn: () => get<Note[]>(`/api/boards/${boardId}/directions`),
    enabled: !!boardId && boardOk && tab === "meet",
  });
  const [dtext, setDtext] = useState("");
  const [dscope, setDscope] = useState("meeting");
  const adopt = useMutation({
    mutationFn: () =>
      post<Note>(`/api/boards/${boardId}/directions`, {
        text: dtext,
        scope: dscope,
        meetingId,
      }),
    onSuccess: () => {
      setDtext("");
      refresh("directions");
      notify("Direction adopted with the exact shown text.");
    },
    onError: (e) => alert(String(e)),
  });
  const fromDirection = useMutation({
    mutationFn: (noteId: string) =>
      post<RecordDraft>(`/api/meetings/${meetingId}/record/from-direction`, { noteId }),
    onMutate: () => ({ originBoardId: boardId, originMeetingId: meetingId }),
    onSuccess: (r, _v, ctx) => {
      const origin = ctx as { originBoardId?: string; originMeetingId?: string } | undefined;
      const keyMeeting = (r as RecordDraft)?.meetingId ?? origin?.originMeetingId ?? meetingId;
      const keyBoard = (r as RecordDraft)?.boardId ?? origin?.originBoardId ?? boardId;
      // Seed the staged draft by its returned identity before the invalidated
      // list returns, and only render it under the origin parents: the live
      // selection ref (not captured promise values) decides, so switching
      // meetings while the request is in flight never redirects or poisons
      // another selection's cache. setRecId + setTab batch into one render, so
      // the hash effect publishes records+newId once (push) with no split
      // invalid-parent entry under a stale review.
      qc.setQueryData<RecordDraft[] | undefined>(
        ["records", keyMeeting],
        (old) => (old ? [...old.filter((x) => x.id !== r.id), r] : [r]),
      );
      qc.setQueryData(["record", r.id], r);
      const live = liveSelRef.current;
      if (live.boardId === keyBoard && live.meetingId === keyMeeting) {
        setRecId(r.id);
        setTab("records");
      }
      refresh("records", "record");
      notify("Direction staged for review as draft " + r.id + ".");
    },
    onError: (e) => alert(String(e)),
  });
  const [blocked, setBlocked] = useState("");
  const srcOp = (id: string, op: string, body?: unknown) => {
    const p =
      op === "approve"
        ? patch<Source>(`/api/sources/${id}`, { approved: true })
        : op === "exclude"
          ? patch<Source>(`/api/sources/${id}`, { excluded: true })
          : op === "scope"
            ? patch<Source>(`/api/sources/${id}`, body ?? {})
            : post<Source>(`/api/sources/${id}/${op}`, body ?? {});
    return p.then(() => refresh("sources"));
  };
  const uploadSrc = async (f: File | undefined, scope: string) => {
    if (!f || !boardId) return;
    const fd = new FormData();
    fd.append("file", f);
    fd.append("scope", scope);
    if (scope === "meeting") fd.append("meetingId", meetingId);
    try {
      await upload<unknown>(`/api/boards/${boardId}/sources/upload`, fd);
      refresh("sources");
    } catch (e) {
      alert(String(e));
    }
  };
  const savePolicy = useMutation({
    mutationFn: () =>
      fetch(`/api/boards/${boardId}/source-policy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...withUser() },
        body: JSON.stringify({ blockedTypes: blocked }),
      }).then(j<unknown>),
    onSuccess: () => refresh("sources"),
  });
  const scopeDlg = useRef<HTMLDialogElement | null>(null);
  const [scopeId, setScopeId] = useState("");
  const [scopeSel, setScopeSel] = useState("board");
  const [scopeMeeting, setScopeMeeting] = useState("");
  const saveScope = () => {
    if (!scopeId) return;
    patch<Source>(`/api/sources/${scopeId}`, {
      scope: scopeSel,
      ...(scopeSel === "meeting" && scopeMeeting
        ? { meetingId: scopeMeeting }
        : {}),
    })
      .then(() => {
        scopeDlg.current?.close();
        refresh("sources");
      })
      .catch((e) => alert(String(e)));
  };
  const [cmpVer, setCmpVer] = useState("");
  function diffItems(
    prevJson: string,
    curJson: string,
  ): { key: string; mark: string; text: string }[] {
    let prev: { id?: string; text?: string }[] = [];
    let cur: { id?: string; text?: string }[] = [];
    try {
      prev = JSON.parse(prevJson);
    } catch {
      /* keep empty */
    }
    try {
      cur = JSON.parse(curJson);
    } catch {
      /* keep empty */
    }
    const pm = new Map(prev.map((i) => [i.id ?? i.text ?? "", i.text ?? ""]));
    const cm = new Map(cur.map((i) => [i.id ?? i.text ?? "", i.text ?? ""]));
    const out: { key: string; mark: string; text: string }[] = [];
    for (const [k, t] of pm) {
      if (!cm.has(k)) out.push({ key: k, mark: "−", text: t });
      else if (cm.get(k) !== t)
        out.push({ key: k, mark: "~", text: `${t} → ${cm.get(k)}` });
    }
    for (const [k, t] of cm)
      if (!pm.has(k)) out.push({ key: k, mark: "+", text: t });
    return out;
  }
  const recs = useQuery({
    queryKey: ["records", meetingId],
    queryFn: () => get<RecordDraft[]>(`/api/meetings/${meetingId}/records`),
    enabled: !!meetingId && meetingOk && (tab === "records" || tab === "meet"),
  });
  const latestDraft = (recs.data ?? [])
    .slice()
    .sort((a, b) => b.version - a.version)[0];
  const [recId, setRecId] = useState(route0.rec);
  const liveSelRef = useRef({ boardId, meetingId, recId });
  liveSelRef.current = { boardId, meetingId, recId };
  useEffect(() => {
    const key = latestDraft
      ? `${latestDraft.id}:${latestDraft.decided}:${latestDraft.status}`
      : "";
    if (key && key !== prevRecordKey.current) {
      prevRecordKey.current = key;
      if (latestDraft && latestDraft.decided) {
        setRecordFlash(true);
        const t = window.setTimeout(() => setRecordFlash(false), 1300);
        return () => window.clearTimeout(t);
      }
    }
  }, [latestDraft]);
  const recDetail = useQuery({
    queryKey: ["record", recId],
    queryFn: () => get<RecordDraft>(`/api/records/${recId}`),
    enabled: !!recId && !!boardId && !!meetingId && boardOk && meetingOk && tab === "records",
    retry: false,
  });
  // Record authority is the singular detail lookup plus a parent check: the
  // draft must belong to the selected meeting and board. The newest-50 list
  // window never establishes absence.
  const recParentOk =
    recId === "" ||
    (!!boardId &&
      !!meetingId &&
      boardOk &&
      meetingOk &&
      recDetail.isSuccess &&
      recDetail.data?.id === recId &&
      recDetail.data?.boardId === boardId &&
      recDetail.data?.meetingId === meetingId);
  const recOk = recParentOk;
  // Bounded record window (newest 50) never establishes absence. Only a 404
  // on the singular record lookup, or a verified parent mismatch, clears the
  // selection. Validation runs on the records tab where the lookup is active;
  // other tabs keep the id until records-tab validation runs.
  const recParentMismatch =
    recDetail.isSuccess &&
    recDetail.data != null &&
    (recDetail.data.id !== recId ||
      recDetail.data.boardId !== boardId ||
      recDetail.data.meetingId !== meetingId);
  const recMissing =
    !!recId &&
    !!boardId &&
    !!meetingId &&
    tab === "records" &&
    boardOk &&
    meetingOk &&
    ((recDetail.isError && isNotFound(recDetail.error)) ||
      !!recParentMismatch);
  // Navigation keeps document scroll at top on destination/context change
  // (tab/board/meeting/record); list-panel scroll is preserved separately
  // via listpanelScroll and drafts are untouched.
  useEffect(() => {
    document.documentElement.scrollTop = 0;
    try { window.scrollTo(0, 0); } catch { /* noop */ }
  }, [tab, boardId, meetingId, recId]);
  const [selItems, setSelItems] = useState<string[]>([]);
  const [revText, setRevText] = useState("");
  useEffect(() => {
    if (recDetail.data) {
      setRevText(recDetail.data.itemsJson);
      try {
        const ids = (JSON.parse(recDetail.data.itemsJson) as { id?: string }[])
          .map((i) => i.id ?? "")
          .filter(Boolean);
        setSelItems(ids);
      } catch {
        setSelItems([]);
      }
    }
  }, [recDetail.data]);
  const approveRec = (all: boolean) => {
    if (!recOk) return;
    const d = recDetail.data;
    if (!d) return;
    if (d.boardId !== boardId || d.meetingId !== meetingId) return;
    let ids = selItems;
    if (all) {
      try {
        ids = (JSON.parse(d.itemsJson) as { id?: string }[])
          .map((i) => i.id ?? "")
          .filter(Boolean);
      } catch {
        ids = selItems;
      }
    }
    const originMeetingId = meetingId;
    const originBoardId = boardId;
    const originDraftId = d.id;
    post<unknown>(`/api/meetings/${originMeetingId}/record/approve`, {
      draftId: originDraftId,
      hash: d.hash,
      watermark: d.watermark,
      itemIds: ids,
    })
      .then((r) => {
        const parsed = r as unknown as { approved?: string[]; draft?: string } | undefined;
        const keyId = (parsed as { draft?: string } | undefined)?.draft ?? originDraftId;
        const approvedJson = JSON.stringify((parsed as { approved?: string[] } | undefined)?.approved ?? ids);
        qc.setQueryData<RecordDraft | undefined>(["record", keyId], (old) =>
          old && old.id === keyId ? { ...old, decided: true, status: "approved", approvedJson } : old,
        );
        qc.setQueryData<RecordDraft[] | undefined>(["records", originMeetingId], (old) =>
          old
            ? old.map((x) => (x.id === keyId ? { ...x, decided: true, status: "approved", approvedJson } : x))
            : old,
        );
        void originBoardId;
        refresh("records", "record");
        notify(`Approved ${ids.length} item(s).`);
      })
      .catch((e) => alert(String(e)));
  };
  const reviseRec = (amend: boolean) => {
    if (!recOk) return;
    const d = recDetail.data;
    if (!d) return;
    if (d.boardId !== boardId || d.meetingId !== meetingId) return;
    let items: unknown = [];
    try {
      items = JSON.parse(revText);
    } catch {
      alert("Revision body must be JSON.");
      return;
    }
    const originMeetingId = meetingId;
    const originBoardId = boardId;
    const originDraftId = d.id;
    void originDraftId;
    const originRecId = recId;
    post<RecordDraft>(`/api/records/${d.id}/${amend ? "amend" : "revise"}`, {
      items,
    })
      .then((r) => {
        // Seed the revised/amended draft by its returned identity so a delayed
        // refresh never discards the just-saved selection, and never render it
        // under the wrong parent if the user switched while saving.
        const keyMeeting = (r as RecordDraft)?.meetingId ?? originMeetingId;
        const keyBoard = (r as RecordDraft)?.boardId ?? originBoardId;
        qc.setQueryData<RecordDraft[] | undefined>(
          ["records", keyMeeting],
          (old) => (old ? [...old.filter((x) => x.id !== r.id), r] : [r]),
        );
        qc.setQueryData(["record", r.id], r);
        const live = liveSelRef.current;
        if (live.boardId === keyBoard && live.meetingId === keyMeeting && live.recId === originRecId) setRecId(r.id);
        refresh("records", "record");
      })
      .catch((e) => alert(String(e)));
  };
  const discardRec = () => {
    if (!recOk || !recDetail.data) return Promise.resolve();
    const d = recDetail.data;
    if (d.boardId !== boardId || d.meetingId !== meetingId) return Promise.resolve();
    const originDraftId = d.id;
    return post<unknown>(`/api/records/${originDraftId}/discard`, {}).then((r) => {
      const updated = r as unknown as RecordDraft | undefined;
      if (updated && (updated as RecordDraft).id) qc.setQueryData(["record", (updated as RecordDraft).id], updated);
      refresh("records", "record");
    });
  };
  const [draftItems, setDraftItems] = useState(
    '[{"id":"1","text":"","detail":"","status":"proposed","scope":"meeting"}]',
  );
  const prepareDraft = () => {
    if (!boardId || !meetingId || !boardOk || !meetingOk) return;
    const originBoardId = boardId;
    const originMeetingId = meetingId;
    const originRecId = recId;
    return post<RecordDraft>(
      `/api/meetings/${originMeetingId}/record/draft`,
      JSON.parse(draftItems),
    )
      .then((r) => {
        // Seed the freshly drafted record by its returned identity before the
        // invalidated list returns, and never render it under the wrong parent
        // if the user switched while saving.
        const keyMeeting = (r as RecordDraft)?.meetingId ?? originMeetingId;
        const keyBoard = (r as RecordDraft)?.boardId ?? originBoardId;
        qc.setQueryData<RecordDraft[] | undefined>(
          ["records", keyMeeting],
          (old) => (old ? [...old.filter((x) => x.id !== r.id), r] : [r]),
        );
        qc.setQueryData(["record", r.id], r);
        const live = liveSelRef.current;
        if (live.boardId === keyBoard && live.meetingId === keyMeeting && live.recId === originRecId) setRecId(r.id);
        refresh("records", "record");
      })
      .catch((e) => alert(String(e)));
  };
  const invites = useQuery({
    queryKey: ["invites", boardId],
    queryFn: () => get<Invite[]>(`/api/boards/${boardId}/invites`),
    enabled: !!boardId && boardOk && tab === "people",
  });
  const grants = useQuery({
    queryKey: ["grants", boardId],
    queryFn: () => get<Grant[]>(`/api/boards/${boardId}/grants`),
    enabled: !!boardId && boardOk && tab === "people",
  });
  const [iemail, setIemail] = useState("");
  const [irole, setIrole] = useState("collaborator");
  const invite = useMutation({
    mutationFn: () =>
      post<Invite>(`/api/boards/${boardId}/invites`, {
        email: iemail,
        role: irole,
      }),
    onSuccess: () => {
      setIemail("");
      refresh("invites");
    },
    onError: (e) => alert(String(e)),
  });
  const [guser, setGuser] = useState("");
  const [gaccess, setGaccess] = useState("read");
  const grant = useMutation({
    mutationFn: () =>
      post<Grant>(`/api/boards/${boardId}/grants`, {
        userKey: guser,
        meetingId: meetingId || undefined,
        access: gaccess,
      }),
    onSuccess: () => {
      setGuser("");
      refresh("grants");
    },
    onError: (e) => alert(String(e)),
  });
  const audit = useQuery({
    queryKey: ["audit"],
    queryFn: () =>
      get<{ action: string; detail: string; createdAt: string }[]>(
        "/api/activity/audit",
      ),
    enabled: tab === "activity",
  });
  const modelCalls = useQuery({
    queryKey: ["modelcalls"],
    queryFn: () =>
      get<
        {
          model: string;
          purpose: string;
          inputTokens: number;
          outputTokens: number;
          latencyMs: number;
          ranSearch: boolean;
        }[]
      >("/api/models/calls"),
    enabled: tab === "activity",
  });
  const retryJob = (j: Job) =>
    post<Job>(`/api/jobs/${j.id}/retry`, {})
      .then(() => refresh("jobs"))
      .catch((e) => alert(String(e)));
  const spending = useQuery({
    queryKey: ["spending"],
    queryFn: () => get<Spending>("/api/spending"),
    enabled: tab === "activity",
  });
  const [capInput, setCapInput] = useState("");
  const [capMode, setCapMode] = useState("warn");
  const [capLoaded, setCapLoaded] = useState("");
  useEffect(() => {
    if (
      spending.data &&
      capLoaded !== spending.data.month + spending.data.mode
    ) {
      setCapInput(spending.data.monthlyCapUsd?.toString() ?? "");
      setCapMode(spending.data.mode);
      setCapLoaded(spending.data.month + spending.data.mode);
    }
  }, [spending.data, capLoaded]);
  const saveSpending = useMutation({
    mutationFn: () =>
      fetch("/api/spending", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...withUser() },
        body: JSON.stringify({
          monthlyCapUsd: capInput.trim() === "" ? null : Number(capInput),
          mode: capMode,
        }),
      }).then(j<unknown>),
    onSuccess: () => refresh("spending"),
    onError: (e) => alert(String(e)),
  });
const modelStatus = useQuery({
  queryKey: ["model-status"],
  queryFn: () => get<ModelStatus>("/api/model/status"),
});
const [modelKey, setModelKey] = useState("");
const [modelChat, setModelChat] = useState("");
const [modelChatLoaded, setModelChatLoaded] = useState("~unloaded~");
const [modelMsg, setModelMsg] = useState("");
useEffect(() => {
  const cur = modelStatus.data?.chatOverride ?? "";
  if (modelStatus.data && modelChatLoaded !== cur) {
    setModelChat(cur);
    setModelChatLoaded(cur);
  }
}, [modelStatus.data, modelChatLoaded]);
const saveModel = useMutation({
  mutationFn: () =>
    fetch("/api/model/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...withUser() },
      body: JSON.stringify({ apiKey: modelKey, chatModel: modelChat }),
    }).then(j<unknown>),
  onSuccess: () => {
    setModelKey("");
    setModelMsg("Saved. Run Test connection to verify.");
    refresh("model-status");
  },
  onError: (e) => setModelMsg(String(e)),
});
const testModel = useMutation({
  mutationFn: () =>
    post<{ ok: boolean; model: string; latencyMs?: number; error?: string }>("/api/model/test", {}),
  onSuccess: (r) => {
    setModelMsg(r.ok ? `Connected (${r.model}).` : `Test failed: ${r.error ?? "unknown error"}`);
    refresh("model-status");
  },
  onError: (e) => setModelMsg(String(e)),
});

  const cmds = useQuery({
    queryKey: ["commands"],
    queryFn: () => get<Cmd[]>("/api/commands"),
    enabled: tab === "help",
  });
  const [hq, setHq] = useState("");
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () =>
      get<{ user: string; authenticated: boolean }>("/api/auth/me"),
  });
  type VoiceOp = {
    id: number;
    boardId: string;
    meetingId: string;
    navGen: number;
    stream: MediaStream | null;
    recorder: MediaRecorder | null;
    chunks: Blob[];
    timer: number | null;
    abort: AbortController;
    cancelled: boolean;
  };
  const recRef = useRef<MediaRecorder | null>(null);
  const voiceOpIdRef = useRef(0);
  const voiceOpRef = useRef<VoiceOp | null>(null);
  const voiceStartingRef = useRef(false);
  const voiceNavGenRef = useRef(0);
  const voiceMountedRef = useRef(true);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const isOwnerOp = (op: VoiceOp): boolean => voiceOpRef.current?.id === op.id;
  const isVoiceAbort = (op: VoiceOp, e: unknown): boolean =>
    op.abort.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
  const endVoiceOp = (op: VoiceOp, error?: string | null): boolean => {
    if (voiceOpRef.current?.id !== op.id) return false;
    voiceOpRef.current = null;
    voiceStartingRef.current = false;
    if (recRef.current === op.recorder) recRef.current = null;
    setRecording(false);
    setTranscribing(false);
    if (error !== undefined) setVoiceError(error);
    return true;
  };
  const cancelActiveVoiceOp = (resetUi: boolean) => {
    const op = voiceOpRef.current;
    voiceOpRef.current = null;
    voiceStartingRef.current = false;
    if (op) {
      op.cancelled = true;
      try { op.abort.abort(); } catch { /* ignore */ }
      if (op.timer !== null) {
        try { window.clearTimeout(op.timer); } catch { /* ignore */ }
        op.timer = null;
      }
      try {
        if (op.recorder && op.recorder.state !== "inactive") op.recorder.stop();
      } catch { /* ignore */ }
      try {
        op.stream?.getTracks().forEach((tr) => tr.stop());
      } catch { /* ignore */ }
      if (recRef.current === op.recorder) recRef.current = null;
    }
    if (resetUi) {
      setRecording(false);
      setTranscribing(false);
    }
  };
  const isOpAlive = (op: VoiceOp): boolean => {
    if (op.cancelled) return false;
    if (!voiceMountedRef.current) return false;
    if (voiceOpRef.current?.id !== op.id) return false;
    if (voiceNavGenRef.current !== op.navGen) return false;
    const live = liveSelRef.current;
    if (live.boardId !== op.boardId || live.meetingId !== op.meetingId) return false;
    return true;
  };
  useEffect(() => {
    voiceMountedRef.current = true;
    return () => {
      voiceMountedRef.current = false;
      cancelActiveVoiceOp(false);
    };
  }, []);
  useEffect(() => {
    voiceNavGenRef.current += 1;
    if (voiceOpRef.current) cancelActiveVoiceOp(true);
  }, [boardId, meetingId, tab]);
  const toggleRec = async () => {
    const cur = voiceOpRef.current;
    if (voiceStartingRef.current || (cur && !cur.cancelled)) {
      const liveStop = cur;
      if (liveStop && !liveStop.cancelled && liveStop.recorder) {
        try {
          if (liveStop.recorder.state !== "inactive") liveStop.recorder.stop();
        } catch { /* ignore */ }
      }
      return;
    }
    const originBoardId = boardId;
    const originMeetingId = meetingId;
    if (!originMeetingId) {
      alert("Pick a meeting first.");
      return;
    }
    setVoiceError(null);
    const myId = voiceOpIdRef.current + 1;
    voiceOpIdRef.current = myId;
    const abort = new AbortController();
    const op: VoiceOp = {
      id: myId,
      boardId: originBoardId,
      meetingId: originMeetingId,
      navGen: voiceNavGenRef.current,
      stream: null,
      recorder: null,
      chunks: [],
      timer: null,
      abort,
      cancelled: false,
    };
    voiceOpRef.current = op;
    voiceStartingRef.current = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (isOwnerOp(op) && voiceMountedRef.current && voiceNavGenRef.current === op.navGen) {
        const live = liveSelRef.current;
        if (live.boardId === op.boardId && live.meetingId === op.meetingId) {
          endVoiceOp(op);
          alert("Microphone unavailable.");
          return;
        }
        endVoiceOp(op);
        return;
      }
      if (isOwnerOp(op)) endVoiceOp(op);
      return;
    }
    if (!voiceMountedRef.current || op.cancelled || voiceOpRef.current?.id !== op.id || voiceNavGenRef.current !== op.navGen) {
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      if (isOwnerOp(op)) endVoiceOp(op);
      return;
    }
    {
      const live = liveSelRef.current;
      if (live.boardId !== op.boardId || live.meetingId !== op.meetingId) {
        try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
        endVoiceOp(op);
        return;
      }
    }
    op.stream = stream;
    let mime: string | undefined;
    try {
      mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
        (cand) => {
          try {
            return MediaRecorder.isTypeSupported(cand);
          } catch {
            return false;
          }
        },
      );
    } catch {
      mime = undefined;
    }
    let mr: MediaRecorder;
    try {
      mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      try { stream.getTracks().forEach((tr) => tr.stop()); } catch { /* ignore */ }
      op.stream = null;
      if (isOwnerOp(op)) endVoiceOp(op);
      voiceStartingRef.current = false;
      alert("Microphone unavailable.");
      return;
    }
    op.recorder = mr;
    recRef.current = mr;
    op.chunks = [];
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size) op.chunks.push(e.data);
    };
    mr.onstop = async () => {
      if (op.timer !== null) {
        try { window.clearTimeout(op.timer); } catch { /* ignore */ }
        op.timer = null;
      }
      const stillCurrent = voiceOpRef.current?.id === op.id && !op.cancelled;
      try {
        op.stream?.getTracks().forEach((tr) => tr.stop());
      } catch { /* ignore */ }
      if (!stillCurrent || !voiceMountedRef.current || voiceNavGenRef.current !== op.navGen) {
        if (isOwnerOp(op)) endVoiceOp(op);
        if (recRef.current === mr) recRef.current = null;
        return;
      }
      if (recRef.current === mr) recRef.current = null;
      setRecording(false);
      const live = liveSelRef.current;
      if (live.boardId !== op.boardId || live.meetingId !== op.meetingId) {
        endVoiceOp(op);
        return;
      }
      const recorded = new Blob(op.chunks, { type: mr.mimeType || "audio/webm" });
      op.chunks = [];
      if (recorded.size === 0) {
        endVoiceOp(op, "No audio captured; try again.");
        return;
      }
      setTranscribing(true);
      let wavBlob: Blob;
      try {
        const conv = await convertRecordedBlobToWav(recorded, 16000, { signal: op.abort.signal });
        if (!isOpAlive(op)) { if (isOwnerOp(op)) endVoiceOp(op); return; }
        wavBlob = conv.wavBlob;
      } catch (e) {
        if (isVoiceAbort(op, e)) {
          if (isOwnerOp(op)) endVoiceOp(op);
          return;
        }
        if (!isOwnerOp(op) || !voiceMountedRef.current || op.cancelled || voiceNavGenRef.current !== op.navGen) return;
        const live2 = liveSelRef.current;
        if (live2.boardId !== op.boardId || live2.meetingId !== op.meetingId) {
          endVoiceOp(op);
          return;
        }
        endVoiceOp(op, e instanceof Error ? e.message : String(e));
        return;
      }
      if (!isOpAlive(op)) { if (isOwnerOp(op)) endVoiceOp(op); return; }
      const fd = new FormData();
      fd.append("audio", wavBlob, "mic.wav");
      try {
        const resp = await fetch(`/api/meetings/${op.meetingId}/transcribe`, {
          method: "POST",
          headers: withUser(),
          body: fd,
          signal: op.abort.signal,
        });
        if (!isOpAlive(op)) { if (isOwnerOp(op)) endVoiceOp(op); return; }
        const live3 = liveSelRef.current;
        if (live3.boardId !== op.boardId || live3.meetingId !== op.meetingId) {
          endVoiceOp(op);
          return;
        }
        if (!resp.ok) {
          const t = await resp.text().catch(() => "");
          throw new Error(`${resp.status} ${t}`);
        }
        const r = (await resp.json()) as { transcript: string };
        if (!isOpAlive(op)) { if (isOwnerOp(op)) endVoiceOp(op); return; }
        const live4 = liveSelRef.current;
        if (live4.boardId !== op.boardId || live4.meetingId !== op.meetingId) {
          endVoiceOp(op);
          return;
        }
        const text = (r.transcript || "").trim();
        if (!text) {
          endVoiceOp(op, "No speech recognized; nothing posted.");
          return;
        }
        setDraft((prev) => (prev ? `${prev} ${text}` : text));
        notify("Dictation transcribed into the draft.");
        endVoiceOp(op);
      } catch (e) {
        if (isVoiceAbort(op, e)) {
          if (isOwnerOp(op)) endVoiceOp(op);
          return;
        }
        if (!isOwnerOp(op) || !voiceMountedRef.current || op.cancelled || voiceNavGenRef.current !== op.navGen) return;
        const live5 = liveSelRef.current;
        if (live5.boardId !== op.boardId || live5.meetingId !== op.meetingId) {
          endVoiceOp(op);
          return;
        }
        endVoiceOp(op, e instanceof Error ? e.message : String(e));
      }
    };
    try {
      mr.start();
    } catch {
      try { stream.getTracks().forEach((tr) => tr.stop()); } catch { /* ignore */ }
      op.stream = null;
      if (isOwnerOp(op)) {
        if (voiceMountedRef.current && voiceNavGenRef.current === op.navGen) {
          endVoiceOp(op);
          alert("Microphone unavailable.");
        } else {
          endVoiceOp(op);
        }
      }
      voiceStartingRef.current = false;
      return;
    }
    voiceStartingRef.current = false;
    if (voiceOpRef.current?.id !== op.id || op.cancelled || !voiceMountedRef.current || voiceNavGenRef.current !== op.navGen) {
      try { if (mr.state !== "inactive") mr.stop(); } catch { /* ignore */ }
      try { stream.getTracks().forEach((tr) => tr.stop()); } catch { /* ignore */ }
      return;
    }
    setRecording(true);
    if (op.timer !== null) {
      try { window.clearTimeout(op.timer); } catch { /* ignore */ }
      op.timer = null;
    }
    const myTimer = window.setTimeout(() => {
      if (voiceOpRef.current?.id !== op.id || op.cancelled) return;
      try {
        if (op.recorder && op.recorder.state !== "inactive") op.recorder.stop();
      } catch { /* ignore */ }
    }, 300000);
    op.timer = myTimer;
  };


  const [dossier, setDossier] = useState("");
  const research = (id: string) =>
    post<unknown>(`/api/roster/${id}/research`, {})
      .then((r) => {
        setDossier(JSON.stringify(r, null, 1));
        refresh("roster", "roster-names");
      })
      .catch((e) => alert(String(e)));
  const [recallQ, setRecallQ] = useState("");
  const [recallHits, setRecallHits] = useState<
    { kind: string; ref: string; text: string; score: number }[]
  >([]);
  const runRecall = () =>
    get<{ kind: string; ref: string; text: string; score: number }[]>(
      `/api/boards/${boardId}/recall?q=${encodeURIComponent(recallQ)}`,
    )
      .then(setRecallHits)
      .catch((e) => alert(String(e)));
  const [expText, setExpText] = useState("");
  const [expHash, setExpHash] = useState("");
  const doExport = () =>
    get<{ snapshot: string; hash: string }>(`/api/boards/${boardId}/export`)
      .then((r) => {
        setExpText(r.snapshot);
        setExpHash(r.hash);
      })
      .catch((e) => alert(String(e)));
  const doImport = () =>
    post<unknown>("/api/boards/import", { snapshot: expText, hash: expHash, accountId })
      .then(() => {
        refresh("boards");
        notify("Imported as a new board; advisors need re-approval.");
      })
      .catch((e) => alert(String(e)));
  const [bakText, setBakText] = useState("");
  const [bakHash, setBakHash] = useState("");
  const doBackup = () =>
    get<{ snapshot: string; hash: string }>(`/api/backup`)
      .then((r) => {
        setBakText(r.snapshot);
        setBakHash(r.hash);
      })
      .catch((e) => alert(String(e)));
  const doRestore = () =>
    post<unknown>("/api/backup/restore", { snapshot: bakText, hash: bakHash })
      .then(() => {
        qc.invalidateQueries();
        notify("Backup restored and hash-verified.");
      })
      .catch((e) => alert(String(e)));
  const refresh = (...keys: string[]) =>
    keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const toggleBoardAdvisor = async (row: RosterRow) => {
    const existing = (advisors.data ?? []).find((a) => a.rosterEntryId === row.entry.id);
    try {
      if (existing) {
        await fetch(`/api/boards/${boardId}/advisors/${existing.id}`, { method: "DELETE", headers: withUser() }).then(j<unknown>);
      } else {
        await post<unknown>(`/api/roster/${row.entry.id}/copy`, { boardId, boardRole: row.entry.name });
      }
      refresh("advisors", "roster", "roster-names", "setup");
    } catch (e) {
      alert(String(e));
    }
  };
  const [meetPicks, setMeetPicks] = useState<string[]>([]);
  const toggleMeetPick = (id: string) => {
    const all = (advisors.data ?? []).map((a) => a.id);
    if (meetPicks.length === 0) setMeetPicks(all.filter((x) => x !== id));
    else if (meetPicks.includes(id)) setMeetPicks(meetPicks.filter((x) => x !== id));
    else setMeetPicks([...meetPicks, id]);
  };
  const createMeeting = useMutation({
    mutationFn: () =>
      post<Meeting>(`/api/boards/${boardId}/meetings`, {
        title: "Meeting",
        brief: "",
        participantIds: meetPicks,
      }),
    onMutate: () => ({ originBoardId: boardId }),
    onSuccess: (m, _v, ctx) => {
      const origin = (ctx as { originBoardId?: string } | undefined)?.originBoardId ?? boardId;
      const returned = m as Partial<MeetingFull> & { id: string; boardId?: string };
      const keyBoard = returned?.boardId ?? origin;
      const full = { ...returned, brief: (returned as Partial<MeetingFull>).brief ?? "" } as MeetingFull;
      qc.setQueryData<MeetingFull[] | undefined>(
        ["meetings", keyBoard, "all"],
        (old) => (old ? [...old.filter((x) => x.id !== m.id), full] : [full]),
      );
      qc.setQueryData(["meeting-detail", keyBoard, m.id], full);
      refresh("meetings");
      if ((boardId ?? "") === keyBoard) setMeetingId(m.id);
    },
  });
  const send = useMutation({
    mutationFn: () =>
      post<Msg>(`/api/meetings/${meetingId}/messages`, {
        sender: "lead",
        content: draft,
        parentSequence: replyTo ? replyTo.seq : null,
      }),
    onSuccess: () => {
      setDraft("");
      setReplyTo(null);
      refresh("messages");
    },
    onError: (e) => alert(String(e)),
  });
  const submitDraft = () => {
    if (!draft.trim()) return;
    if (audience === "secretary") askSecretary.mutate();
    else send.mutate();
  };
  const runSummary = (r: { published: Msg[]; yielded: { advisor: string; reason: string }[]; overflow: { omitted: string[]; cap: number; policy: string } | null }) => {
    const oc = r.overflow && r.overflow.omitted ? r.overflow.omitted.join(", ") : "";
    return "Published " + (r.published ?? []).length + "; yielded " + (r.yielded ?? []).length + "." + (oc ? " Overflow omits " + oc + " (cap " + (r.overflow ? r.overflow.cap : 0) + ")." : "");
  };
  const runDiscussion = useMutation({
    mutationFn: () =>
      post<{ published: Msg[]; yielded: { advisor: string; reason: string }[]; abstained: string[]; overflow: { omitted: string[]; cap: number; policy: string } | null }>(`/api/meetings/${meetingId}/run`, {
        policy,
        prompt: draft || "Continue the discussion.",
        evidenceSupported: false,
        ...(lead.data ? { leadVersion: lead.data.version } : {}),
      }),
    onSuccess: (r) => {
      refresh("messages");
      notify(runSummary(r));
    },
    onError: (e) => alert(String(e)),
  });
  const askSecretary = useMutation({
    mutationFn: () =>
      post<{ answer: string }>(`/api/meetings/${meetingId}/secretary`, {
        request: draft || "Summarize the state so far.",
      }),
    onSuccess: (r) => notify(`Secretary (provisional): ${r.answer}`),
    onError: (e) => alert(String(e)),
  });
  const meetingCtl = (op: string) => {
    const originBoardId = boardId;
    const originMeetingId = meetingId;
    return post<MeetingFull>(`/api/meetings/${originMeetingId}/${op}`, {}).then((r) => {
      const keyBoard = (r as MeetingFull)?.boardId ?? originBoardId;
      const keyMeeting = (r as unknown as { id?: string })?.id ?? originMeetingId;
      qc.setQueryData(["meeting-detail", keyBoard, keyMeeting], r);
      refresh("meetings", "meeting-detail", "delivery");
    });
  };
  const [toasts, setToasts] = useState<
    { id: number; text: string; err: boolean }[]
  >([]);
  const toastId = useRef(0);
  const notify = (text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, text, err: false }]);
    window.setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      7000,
    );
  };
  const alert = (m: unknown) => {
    const text = String(m);
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, text, err: true }]);
    window.setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      7000,
    );
  };
  // ---- URL-addressable navigation (hash routes; Vite/static-safe) ----
  const firstNav = useRef(true);
  const lastSync = useRef({ board: route0.board, meeting: route0.meeting });
  useEffect(() => {
    // Effective ids: only an authoritative 404 (or a verified parent
    // mismatch) proves an id invalid. Bounded lists (boards newest 100,
    // meetings newest 200, records newest 50) and filtered views never
    // establish absence, so they must not clear the route. Pending or
    // non-404 lookup errors keep the id while gating downstream queries.
    // Never publish the previous board/meeting's context under a new one
    // while the switch-reset effects are still queued in this commit.
    let vBoard = boardMissing ? "" : boardId;
    let vMeeting = vBoard === "" ? "" : meetingMissing ? "" : meetingId;
    let vRec = vMeeting === "" ? "" : recMissing ? "" : recId;
    let effBoard = vBoard;
    let effMeeting = vMeeting;
    let effRec = vRec;
    let switched = false;
    if (lastSync.current.board !== vBoard) {
      effMeeting = "";
      effRec = "";
      switched = true;
    } else if (lastSync.current.meeting !== vMeeting) {
      effRec = "";
      switched = true;
    }
    const cleaned =
      effBoard !== boardId || effMeeting !== meetingId || effRec !== recId;
    // Authoritative 404/mismatch cleanup must never publish a transient
    // dependent route (for example boardless "#/meet"): fall back to Boards
    // immediately when the board is gone, so the invalid entry is replaced
    // once instead of pushing "#/meet" then "#/boards".
    const effTab: Tab =
      effBoard === "" && (needsBoard as Tab[]).includes(tab) ? "boards" : tab;
    // Authoritative detail lookups confirm the context, so the selection can
    // publish immediately: a pending lookup keeps the id (never strips it),
    // and only a confirmed 404/mismatch clears it above. Downstream data
    // queries stay gated on boardOk/meetingOk/recOk until then.
    const h = buildHash({
      tab: effTab,
      board: effBoard,
      meeting: effMeeting,
      mtab: meetTab,
      ctab: contextTab,
      rec: effRec,
    });
    if (window.location.hash === h) {
      firstNav.current = false;
      navReplace.current = false;
      lastSync.current = { board: effBoard, meeting: effMeeting };
      return;
    }
    // Push valid user context switches so Back restores the prior
    // board/meeting; REPLACE mount/traversal dedup and authoritative
    // invalid-parent cleanup. Replacing the invalid entry lets Back leave for
    // the previous valid route; pushing would trap Forward/Back on a transient
    // dependent route ("#/meet" then "#/boards"). A valid board switch that
    // still carries the previous board\u2019s meeting (stale child) pushes once;
    // only a board that is itself 404, or a child that is 404 without a board
    // change, replaces.
    const boardInvalid = vBoard !== boardId;
    const boardChanged = lastSync.current.board !== vBoard;
    const childInvalidWithoutBoardChange =
      !boardInvalid && !boardChanged && (vMeeting !== meetingId || vRec !== recId);
    const invalidCleanup = boardInvalid || childInvalidWithoutBoardChange;
    void switched;
    void cleaned;
    if (firstNav.current || navReplace.current || invalidCleanup) {
      window.history.replaceState(null, "", h);
    } else {
      window.history.pushState(null, "", h);
    }
    firstNav.current = false;
    navReplace.current = false;
    lastSync.current = { board: effBoard, meeting: effMeeting };
  }, [
    tab,
    boardId,
    meetingId,
    meetTab,
    contextTab,
    recId,
    boardMissing,
    meetingMissing,
    recMissing,
  ]);
  // Reconcile ids that no longer exist (authoritative 404 or verified parent
  // mismatch): clear them without firing requests for the stale ids (queries
  // above are gated on boardOk/meetingOk/recOk). Bounded-list absence never
  // clears here.
  useEffect(() => {
    if (boardMissing) {
      navReplace.current = true;
      setBoardId("");
      setMeetingId("");
      setRecId("");
    }
  }, [boardMissing]);
  useEffect(() => {
    if (meetingMissing) {
      navReplace.current = true;
      setMeetingId("");
      setRecId("");
    }
  }, [meetingMissing]);
  useEffect(() => {
    if (recMissing) {
      navReplace.current = true;
      setRecId("");
    }
  }, [recMissing]);
  useEffect(() => {
    const apply = () => {
      // Document anchors (e.g. #main from the skip link) are not routes:
      // leave every selection untouched instead of parsing Boards.
      const raw = window.location.hash.replace(/^#/, "");
      if (!raw.startsWith("/")) return;
      const r = parseHash();
      // Traversal restores URL context but must still reset the state owned
      // by the board/meeting being left, mirroring the switch guards (the
      // pre-set refs below keep those guards from double-clearing).
      if (r.board !== boardId) resetBoardOwnedState();
      if (r.meeting !== meetingId) resetMeetingOwnedState();
      prevBoard.current = r.board;
      prevMeeting.current = r.meeting;
      lastSync.current = { board: r.board, meeting: r.meeting };
      setTab((t) => (t === r.tab ? t : r.tab));
      setBoardId((v) => (v === r.board ? v : r.board));
      setMeetingId((v) => (v === r.meeting ? v : r.meeting));
      setMeetTab((v) => (v === r.mtab ? v : r.mtab));
      setContextTab((v) => (v === r.ctab ? v : r.ctab));
      setRecId((v) => (v === r.rec ? v : r.rec));
    };
    window.addEventListener("hashchange", apply);
    window.addEventListener("popstate", apply);
    return () => {
      window.removeEventListener("hashchange", apply);
      window.removeEventListener("popstate", apply);
    };
  });
  return (
    <div className={"shell" + (navOpen ? " nav-open" : "") + (tab === "boards" || tab === "roster" || tab === "meet" ? "" : " no-panel")}>
      {" "}
      <nav
        className="rail"
        aria-label="Board navigation"
        ref={navRef}
        onKeyDown={railKeys}
      >
        {" "}
        <h1 className="brand rail-logo">
          {" "}
          <button
            type="button"
            className="rail-home"
            onClick={() => {
              setTab("boards");
              setNavOpen(false);
            }}
            aria-label="Sim CEO — go to Boards"
            title="Boards"
          >
            {" "}
            <img src="/logo.webp" alt="" width="32" height="32" className="brand-logo" />{" "}
          </button>{" "}
        </h1>{" "}

        <div className="rail-items" ref={railListRef}>
          {" "}
          <span
            className="rail-pill"
            style={{
              top: pill.top,
              height: pill.height,
              opacity: pill.show ? 1 : 0,
            }}
            aria-hidden="true"
          />{" "}
          {navGroups.map((g, gi) => {
            const items = g.items.filter(
              ([k]) => boardId || !needsBoard.includes(k),
            );
            if (items.length === 0) return null;
            return (
              <div key={"nav-" + (g.label ? g.label : "top") + "-" + gi}>
                {" "}
                {g.label && (
                  <div className="navgroup" aria-hidden="true">
                    {" "}
                    {g.label}{" "}
                  </div>
                )}{" "}
                {items.map(([k, label]) => (
                  <div key={k} className="navitem">
                    {" "}
                    <button
                      type="button"
                      aria-label={label}
                      onMouseEnter={(e) => showNavTip(label, e.currentTarget)}
                      onMouseLeave={hideNavTip}
                      onFocus={(e) => showNavTip(label, e.currentTarget)}
                      onBlur={hideNavTip}
                      aria-current={tab === k ? "page" : undefined}
                      className={tab === k ? "active" : ""}
                      onClick={() => {
                        setTab(k);
                        setNavOpen(false);
                      }}
                    >
                      {" "}
                      <span className="nav-ic" aria-hidden="true">
                        {" "}
                        <NavIcon name={k} />{" "}
                      </span>{" "}
                      {k === "meet" && meetingId && live && (
                        <span className="nav-dot-live" aria-hidden="true" />
                      )}{" "}
                      {tabCount(k) != null && (
                        <span className="nav-badge">{tabCount(k)}</span>
                      )}{" "}
                    </button>{" "}
                  </div>
                ))}{" "}


              </div>
            );
          })}{" "}
        </div>{" "}
          {navTip && (
            <div className="navtip" role="tooltip" style={{ top: navTip.top, left: navTip.left }}>
              {navTip.label}
            </div>
          )}{" "}
        <div className="railfoot">
          <div className="profile-wrap rail-profile">
            {" "}
            {!fbUser ? (
              <button type="button" className="usercard" onClick={fbSignIn}>
                {" "}
                <span className="avatar" aria-hidden="true">
                  {" "}?{" "}
                  {modelStatus.data?.lastTestOk && (
                    <span className="avatar-dot" aria-hidden="true" />
                  )}{" "}
                </span>{" "}

                <span className="usercard-meta">
                  {" "}
                  <b>Sign in</b>{" "}
                  <span className="muted">Continue with Facebook</span>{" "}
                </span>{" "}
              </button>
            ) : (
              <>
                {" "}
                <button
                  type="button"
                  className="usercard"
                  onClick={() => { setTab("profile"); setNavOpen(false); }}
                  aria-label="Open profile"
                >
                  {" "}
                  <span className="avatar" aria-hidden="true">
                    {" "}
                              {initials(fbUser)}{" "}
                              {modelStatus.data?.lastTestOk && (
                                <span className="avatar-dot" aria-hidden="true" />
                              )}{" "}

                  </span>{" "}
                  <span className="usercard-meta">
                    {" "}
                    <b>{fbUser}</b>{" "}
                    <span className="muted">Facebook (demo)</span>{" "}
                  </span>{" "}
                </button>{" "}
              </>
            )}{" "}
          </div>{" "}
        </div>{" "}
      </nav>{" "}

      {(tab === "boards" || tab === "roster" || tab === "meet") && (
        <aside
          className="listpanel"
          aria-label={tab === "boards" ? "Boards" : tab === "roster" ? "Roster" : "Meetings"}
        >
          {" "}
          <div className="listpanel-head">
            {" "}
            <div className="listpanel-title">
              {tab === "boards" ? "Boards" : tab === "roster" ? "Roster" : "Meetings"}
            </div>{" "}
            <div className="listpanel-sub">
              {tab === "boards"
                ? `${(boards.data ?? []).length} boards`
                : tab === "roster"
                  ? `${(rosterNames.data ?? []).length} people`
                  : `${(meetings.data ?? []).length} meetings`}{" "}
              {tab !== "boards" && boardId && (
                <>
                  {" "}· {boardDetail.data?.name ?? (boards.data ?? []).find((b) => b.id === boardId)?.name ?? "Board"}{" "}
                </>
              )}{" "}
            </div>{" "}
          </div>{" "}
          {tab === "roster" && (
            <div className="listpanel-filters">
              {" "}
              <input aria-label="Search roster" placeholder="Search name or profile" value={rq} onChange={(e) => setRq(e.target.value)} />{" "}
              <select aria-label="Type filter" value={rtype} onChange={(e) => setRtype(e.target.value)}>
                {" "}
                <option value="">All types</option>{" "}
                <option value="FictionalCharacter">Fictional character</option>{" "}
                <option value="PublicFigure">Public figure</option>{" "}
                <option value="UnnamedRole">Unnamed role</option>{" "}
              </select>{" "}
              <input aria-label="Tag filter" placeholder="tag" value={rtag} onChange={(e) => setRtag(e.target.value)} />{" "}
            </div>
          )}{" "}
          <div className="listpanel-rows" role="list" ref={listpanelRowsRef} onScroll={(e) => { listpanelScroll.current[tab] = e.currentTarget.scrollTop; }}>
            {" "}
            {tab === "boards" &&
              (boards.data ?? []).map((b) => (
                <button
                  key={b.id}
                  type="button"
                  role="listitem"
                  className={b.id === boardId ? "lprow active" : "lprow"}
                  title={b.mission || b.name}
                  aria-current={b.id === boardId ? "true" : undefined}
                  onClick={() => setBoardId(b.id)}
                >
                  {" "}
                  <span className="lprow-name">{b.name}</span>{" "}
                  <span className="lprow-sub">{b.mission || "No mission yet"}</span>{" "}
                </button>
              ))}{" "}
            {tab === "boards" && (boards.data ?? []).length === 0 && (
              <div className="sub-empty">No boards yet</div>
            )}{" "}
            {tab === "roster" &&
              (rosterNames.data ?? []).map((r) => (
                <button
                  key={r.entry.id}
                  type="button"
                  role="listitem"
                  className={r.entry.id === selRoster ? "lprow active" : "lprow"}
                  title={`${r.entry.name} · ${r.boards.length} boards`}
                  onClick={() => selectRoster(r.entry.id)}
                  aria-current={r.entry.id === selRoster ? "true" : undefined}
                >
                  {" "}
                  <span className="lprow-name">{r.entry.name}</span>{" "}
                  <span className="lprow-sub">
                    {r.boards.length === 1 ? "1 board" : `${r.boards.length} boards`}
                  </span>{" "}
                </button>
              ))}{" "}
            {tab === "roster" && (rosterNames.data ?? []).length === 0 && (
              <div className="sub-empty">Roster is empty</div>
            )}{" "}
            {tab === "roster" && (
              <button type="button" className="lprow create" onClick={() => { setCreateOpen(true); setTimeout(() => createNameRef.current?.focus(), 50); }}>{" "}
                <span className="lprow-name">+ Create new Advisor</span>{" "}
              </button>
            )}{" "}
            {tab === "meet" && !boardId && (
              <div className="sub-empty">Select a board first</div>
            )}{" "}
            {tab === "meet" &&
              (meetings.data ?? []).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="listitem"
                  className={m.id === meetingId ? "lprow active" : "lprow"}
                  title={m.title}
                  onClick={() => setMeetingId(m.id)}
                >
                  {" "}
                  <span className="lprow-name">{m.title}</span>{" "}
                  <span className="lprow-sub">{meetingStateLabel(m.state)}</span>{" "}
                </button>
              ))}{" "}
          </div>{" "}
        </aside>
      )}{" "}

      <button
        type="button"
        className="backdrop"
        aria-label="Close navigation"
        onClick={() => {
          setNavOpen(false);
          const opener = document.querySelector(
            '[aria-label="Open navigation"]',
          );
          (opener as HTMLElement | null)?.focus();
        }}
      />{" "}
      <div className="maincol">
        {" "}
        <a
          href="#main"
          className="skip"
          onClick={(e) => {
            // Move focus without touching the hash: the route owns the URL,
            // so a "#main" fragment must never parse as a Boards navigation.
            e.preventDefault();
            document.getElementById("main")?.focus();
          }}
        >
          {" "}
          Skip to main content{" "}
        </a>{" "}
        <div className="mobilebar">
          {" "}
          <button
            type="button"
            className="btn ghost icon rail-toggle"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
          >
            {" "}
            <svg
              width="18"
              height="18"
              viewBox="0 0 18 18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              {" "}
              <path d="M2 4.5h14M2 9h14M2 13.5h14" />{" "}
            </svg>{" "}
          </button>{" "}
          {boardId ? (
            <span className="boardname">
              {" "}
              Open board: {boardDetail.data?.name ?? (boards.data ?? []).find((b) => b.id === boardId)?.name ?? boardId.slice(0, 8)}{" "}
              <button
                type="button"
                className="btn ghost"
                title="Close this board and pick another"
                aria-label="Close board"
                onClick={() => {
                  setBoardId("");
                  setMeetingId("");
                  setMeetPicks([]);
                }}
              >
                {" "}✕{" "}
              </button>{" "}
            </span>
          ) : (
            <span className="boardname">{" "}Sim CEO — pick a board{" "}</span>
          )}{" "}
          {meetingId && live && <span className="badge live">live</span>}{" "}
        </div>{" "}
        <main className="main" id="main" tabIndex={-1}>
          {" "}
          {tab === "boards" && (
            <section aria-label="Boards">
              {" "}
              <h2>Boards</h2>{" "}
              {boardId && (
                <div className="card" aria-label="Current board">
                  {" "}
                  <h3>
                    {" "}
                    Open board:{" "}
                    {boardDetail.data?.name ??
                      (boards.data ?? []).find((b) => b.id === boardId)?.name ??
                      boardId.slice(0, 8)}{" "}
                  </h3>{" "}
                  <div className="meetctl">
                    {" "}
                    <button
                      type="button"
                      className="primary"
                      onClick={() => setTab("meet")}
                    >
                      {" "}
                      Meetings{" "}
                    </button>{" "}

                    <button type="button" onClick={() => setTab("advisors")}>
                      {" "}
                      Advisors{" "}
                    </button>{" "}
                    <button type="button" onClick={() => setTab("sources")}>
                      {" "}
                      Sources{" "}
                    </button>{" "}
                    <button type="button" onClick={() => setTab("records")}>
                      {" "}
                      Records{" "}
                    </button>{" "}
                    <button type="button" onClick={() => setTab("people")}>
                      {" "}
                      People{" "}
                    </button>{" "}
                    <button
                      type="button"
                      className="btn ghost"
                      title="Close this board and pick another"
                      onClick={() => {
                        setBoardId("");
                        setMeetingId("");
                        setMeetPicks([]);
                      }}
                    >
                      {" "}
                      Close board{" "}
                    </button>{" "}
                  </div>{" "}
                </div>
              )}{" "}
              {boardId && (
                <div className="card" aria-label="Board settings">
                  {" "}
                  <h3>Board settings</h3>{" "}
              {setup.data && (
                    <>
                      {" "}
                      <p role="status">
                        {" "}
                        {setup.data.board.activeConfig
                          ? "Active configuration present"
                          : "Not yet activated"}{" "}
                        {setup.data.dirty
                          ? " · draft has unreviewed changes"
                          : " · draft matches active"}{" "}
                      </p>{" "}
                      <label>
                        {" "}
                        Board name{" "}
                        <input
                          value={boardForm.name}
                          onChange={(e) =>
                            setBoardForm({ ...boardForm, name: e.target.value })
                          }
                        />{" "}
                      </label>{" "}
                      <label>
                        {" "}
                        Mission{" "}
                        <input
                          value={boardForm.mission}
                          onChange={(e) =>
                            setBoardForm({ ...boardForm, mission: e.target.value })
                          }
                        />{" "}
                      </label>{" "}
                      <label>
                        {" "}
                        Stage{" "}
                        <input
                          value={boardForm.stage}
                          onChange={(e) =>
                            setBoardForm({ ...boardForm, stage: e.target.value })
                          }
                        />{" "}
                      </label>{" "}
                      <button onClick={() => saveBoard.mutate()}>Save draft</button>{" "}
                      <h3>Activation checklist</h3>{" "}
                      <ul>
                        {" "}
                        <li>
                          {" "}
                          {boardForm.name.trim() || setup.data.board.name
                            ? "✓"
                            : "✗"}{" "}
                          Board name{" "}
                        </li>{" "}
                        <li>
                          {" "}
                          {setup.data.lead
                            ? `✓ Lead profile v${setup.data.lead.version}`
                            : "✗ Reviewed lead profile (see Profile)"}{" "}
                        </li>{" "}
                        <li>
                          {" "}
                          {setup.data.advisors.approved >= 1
                            ? `✓ ${setup.data.advisors.approved} approved advisor(s)`
                            : "✗ At least one approved advisor"}{" "}
                        </li>{" "}
                      </ul>{" "}
                      <p>
                        {" "}
                        Reviewed draft hash:{" "}
                        <code>{setup.data.draftHash}</code>{" "}
                      </p>{" "}
                      <button onClick={() => activate.mutate(setup.data.draftHash)}>
                        {" "}
                        Activate configuration{" "}
                      </button>{" "}
                      <h3>Export / import</h3>{" "}
                      <button onClick={doExport}>
                        {" "}
                        Export reviewed configuration{" "}
                      </button>{" "}
                      {expText && (
                        <p role="status">
                          {" "}
                          Hash <code>{expHash}</code> · {expText.length} chars —
                          paste into a new board import for re-review.{" "}
                        </p>
                      )}{" "}
                      <label>
                        {" "}
                        Snapshot JSON{" "}
                        <input
                          value={expText}
                          onChange={(e) => setExpText(e.target.value)}
                          placeholder="paste exported snapshot"
                        />{" "}
                      </label>{" "}
                      <label>
                        {" "}
                        Snapshot hash{" "}
                        <input
                          value={expHash}
                          onChange={(e) => setExpHash(e.target.value)}
                        />{" "}
                      </label>{" "}
                      <button onClick={doImport}>
                        {" "}
                        Import as new board (advisors unapproved){" "}
                      </button>{" "}
                      <h3>Common settings</h3>{" "}
                      <label>
                        {" "}
                        Discussion rhythm{" "}
                        <select
                          value={setup.data.board.discussionPolicy}
                          onChange={(e) =>
                            saveBoardOpts.mutate({
                              discussionPolicy: e.target.value,
                            })
                          }
                        >
                          {" "}
                          <option value="focused">
                            {" "}
                            Focused (3,2 · max 5){" "}
                          </option>{" "}
                          <option value="balanced">
                            {" "}
                            Balanced (4,4,2 · max 10){" "}
                          </option>{" "}
                          <option value="open">Open (4s · max 10)</option>{" "}
                        </select>{" "}
                      </label>{" "}
                      <label>
                        {" "}
                        <input
                          type="checkbox"
                          checked={setup.data.board.retainAudio}
                          onChange={(e) =>
                            saveBoardOpts.mutate({ retainAudio: e.target.checked })
                          }
                        />{" "}
                        Retain original voice audio (default off; transcripts always
                        kept as drafts){" "}
                      </label>{" "}
                      <label>
                        {" "}
                        Model data use{" "}
                        <select
                          value={setup.data.board.dataUse}
                          onChange={(e) =>
                            saveBoardOpts.mutate({ dataUse: e.target.value })
                          }
                        >
                          {" "}
                          <option value="standard">
                            {" "}
                            Standard (private board content never trains Meta
                            models){" "}
                          </option>{" "}
                          <option value="contributor">
                            {" "}
                            Contributor (~10x cheaper Spark; Meta may train on this
                            board's content){" "}
                          </option>{" "}
                        </select>{" "}
                      </label>{" "}
                    </>
                  )}{" "}
                </div>
              )}{" "}
              {(boards.data ?? []).length === 0 && (
                <div className="card">
                  {" "}
                  <h3>Welcome to Sim CEO</h3>{" "}
                  <p>
                    {" "}
                    Sim CEO convenes a fictional advisory board for your
                    project: give it a mission, staff it with advisors, run
                    meetings, and publish records of what was decided. Nothing
                    here is real — every advisor is generated, every message
                    labeled.{" "}
                  </p>{" "}
                  <button
                    type="button"
                    className="primary"
                    onClick={() => setTab("wizard")}
                  >
                    {" "}
                    Create your first board{" "}
                  </button>{" "}
                </div>
              )}{" "}
              {(boards.data ?? []).length > 0 && (
                <div className="meetctl">
                  {" "}
                  <button
                    type="button"
                    className="primary"
                    onClick={() => setTab("wizard")}
                  >
                    {" "}
                    New board{" "}
                  </button>{" "}
                </div>
              )}{" "}
              {(boards.data ?? []).map((b) => (
                <div className="card" key={b.id}>
                  {" "}
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => {
                      setBoardId(b.id);
                      setMeetingId("");
                      setTab("meet");
                    }}
                  >
                    {" "}
                    {b.name}{" "}
                  </button>{" "}
                  {b.mission && <div>{b.mission}</div>}{" "}
                  <div className="meetctl">
                    {" "}
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() =>
                        patch<Board>(`/api/boards/${b.id}`, {
                          archived: true,
                        }).then(() => refresh("boards"))
                      }
                    >
                      {" "}
                      Archive{" "}
                    </button>{" "}
                  </div>{" "}
                </div>
              ))}{" "}
              {boardId && status.data && (
                <div className="card" aria-label="Board readiness">
                  {" "}
                  <h3>Readiness — {status.data.board}</h3>{" "}
                  <ul>
                    {" "}
                    <li>{status.data.name ? "✓" : "✗"} Name</li>{" "}
                    <li>
                      {" "}
                      {status.data.lead
                        ? `✓ Lead profile v${status.data.leadVersion}`
                        : "✗ Lead profile"}{" "}
                    </li>{" "}
                    <li>
                      {" "}
                      {status.data.advisors.approved >= 1
                        ? `✓ Advisors ${status.data.advisors.approved}/${status.data.advisors.total} approved`
                        : `✗ Advisors (${status.data.advisors.total}/10)`}{" "}
                    </li>{" "}
                    <li>
                      {" "}
                      {status.data.active
                        ? "✓ Active configuration"
                        : "✗ Not activated"}{" "}
                      {status.data.dirty
                        ? " (draft has unreviewed changes)"
                        : ""}{" "}
                    </li>{" "}
                    <li>
                      {" "}
                      Meetings: {status.data.meetings.total} total,{" "}
                      {status.data.meetings.active} open{" "}
                    </li>{" "}
                    <li>
                      {" "}
                      Sources pending review: {status.data.sourcesPending} ·
                      failed jobs: {status.data.jobsFailed}{" "}
                    </li>{" "}
                    <li>
                      {" "}
                      Policy: {status.data.policy} · audio retention:{" "}
                      {status.data.retainAudio ? "on" : "off"}{" "}
                    </li>{" "}
                  </ul>{" "}
                </div>
              )}{" "}
            </section>
          )}{" "}
          {tab === "wizard" && (
            <section aria-label="New-board wizard">
              {" "}
              <h2>Create a board</h2>{" "}
              <ol className="steps" aria-label="Progress">
                {" "}
                {["About", "Advisors", "Lead", "Review"].map((s, i) => (
                  <li
                    key={s}
                    aria-current={wizard.step === i + 1 ? "step" : undefined}
                    className={
                      wizard.step === i + 1
                        ? "now"
                        : wizard.step > i + 1
                          ? "done"
                          : ""
                    }
                  >
                    {" "}
                    {i + 1}. {s}{" "}
                  </li>
                ))}{" "}
              </ol>{" "}
              <p role="status">
                {" "}
                {wizId
                  ? (wizVersion == null ? "Loading saved draft\u2026" : "Draft saved on this device.")
                  : "Draft not saved yet on this device."}{" "}
              </p>{" "}
              {!!wizId && wizVersion == null && (
                <p className="muted">
                  {" "}
                  Loading the saved draft before editing protects server data.{" "}
                  <button type="button" className="btn ghost" onClick={() => hydrateWizard()}>{" "}Retry load{" "}</button>{" "}
                </p>
              )}{" "}
              {wizard.step === 1 && (
                <div className="card">
                  {" "}
                  <h3>What is this board about?</h3>{" "}
                  <label>
                    {" "}
                    Board name{" "}
                    <input
                      disabled={!!wizId && wizVersion == null}
                      value={wizard.name}
                      onChange={(e) =>
                        setWizard({ ...wizard, name: e.target.value })
                      }
                      placeholder="e.g. Pricing review"
                    />{" "}
                  </label>{" "}
                  <label>
                    {" "}
                    Mission{" "}
                    <input
                      disabled={!!wizId && wizVersion == null}
                      value={wizard.mission}
                      onChange={(e) =>
                        setWizard({ ...wizard, mission: e.target.value })
                      }
                      placeholder="What should the board help you decide?"
                    />{" "}
                  </label>{" "}
                  <label>
                    {" "}
                    Stage{" "}
                    <input
                      disabled={!!wizId && wizVersion == null}
                      value={wizard.stage}
                      onChange={(e) =>
                        setWizard({ ...wizard, stage: e.target.value })
                      }
                      placeholder="e.g. Early idea, deciding this month"
                    />{" "}
                  </label>{" "}
                  <label>
                    {" "}
                    Starting shape{" "}
                    <select
                      disabled={!!wizId && wizVersion == null}
                      value={presetKey}
                      onChange={(e) => setPresetKey(e.target.value)}
                    >
                      {" "}
                      {(presets.data ?? []).map((p) => (
                        <option key={p.key} value={p.key}>
                          {" "}
                          {p.title}{" "}
                        </option>
                      ))}{" "}
                    </select>{" "}
                  </label>{" "}
                  <div className="meetctl">
                    {" "}
                    <button type="button" disabled={wizSave.isPending || (!!wizId && wizVersion == null)} onClick={() => wizSave.mutate(undefined)}>
                      {" "}
                      Save draft{" "}
                    </button>{" "}
                    <button
                      type="button"
                      className="primary"
                      disabled={!wizard.name.trim() || wizSave.isPending || (!!wizId && wizVersion == null)}
                      onClick={() => {
                        wizSave.mutate(2);
                        setWizard({ ...wizard, step: 2 });
                      }}
                    >
                      {" "}
                      Continue{" "}
                    </button>{" "}
                  </div>{" "}
                </div>
              )}{" "}
              {wizard.step === 2 && (
                <div className="card">
                  {" "}
                  <h3>
                    {" "}
                    Who should be on the board? ({wizard.seats.length}/10){" "}
                  </h3>{" "}
                  <p>
                    {" "}
                    Seats become advisor profiles when the board is created. You
                    review and approve each one afterwards.{" "}
                  </p>{" "}
                  {wizard.seats.map((s, i) => (
                    <div key={i} className="takenote">
                      {" "}
                      <b>{s.role}</b> {s.name && <span> · {s.name}</span>}{" "}
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() =>
                          setWizard({
                            ...wizard,
                            seats: wizard.seats.filter((_, j) => j !== i),
                          })
                        }
                      >
                        {" "}
                        Remove{" "}
                      </button>{" "}
                    </div>
                  ))}{" "}
                  {wizard.seats.length === 0 && (
                    <p className="muted">
                      {" "}
                      No seats yet. Add roles below or ask the guide for
                      recommendations.{" "}
                    </p>
                  )}{" "}
                  <label>
                    {" "}
                    Role{" "}
                    <input
                      disabled={!!wizId && wizVersion == null}
                      value={seatRole}
                      onChange={(e) => setSeatRole(e.target.value)}
                      placeholder="e.g. Finance reviewer"
                    />{" "}
                  </label>{" "}
                  <label>
                    {" "}
                    Name, optional{" "}
                    <input
                      disabled={!!wizId && wizVersion == null}
                      value={seatName}
                      onChange={(e) => setSeatName(e.target.value)}
                      placeholder="Leave blank to decide later"
                    />{" "}
                  </label>{" "}
                  <div className="meetctl">
                    {" "}
                    <button
                      type="button"
                      disabled={!seatRole.trim() || wizard.seats.length >= 10 || (!!wizId && wizVersion == null)}
                      onClick={() => {
                        setWizard({
                          ...wizard,
                          seats: [
                            ...wizard.seats,
                            { role: seatRole.trim(), name: seatName.trim() },
                          ],
                        });
                        setSeatRole("");
                        setSeatName("");
                      }}
                    >
                      {" "}
                      Add seat{" "}
                    </button>{" "}
                  </div>{" "}
                  <div className="meetctl">
                    {" "}
                    <button type="button" disabled={wizSave.isPending || (!!wizId && wizVersion == null)} onClick={() => wizSave.mutate(undefined)}>
                      {" "}
                      Save draft{" "}
                    </button>{" "}
                    <button
                      type="button"
                      onClick={() => setWizard({ ...wizard, step: 1 })}
                    >
                      {" "}
                      Back{" "}
                    </button>{" "}
                    <button
                      type="button"
                      className="primary"
                      disabled={wizard.seats.length === 0 || wizSave.isPending || (!!wizId && wizVersion == null)}
                      onClick={() => {
                        wizSave.mutate(3);
                        setWizard({ ...wizard, step: 3 });
                      }}
                    >
                      {" "}
                      Continue{" "}
                    </button>{" "}
                  </div>{" "}
                </div>
              )}{" "}
              {wizard.step === 3 && (
                <div className="card">
                  {" "}
                  <h3>Who leads this board?</h3>{" "}
                  <label>
                    {" "}
                    Name{" "}
                    <input
                      disabled={!!wizId && wizVersion == null}
                      value={wizard.lead.name}
                      onChange={(e) =>
                        setWizard({
                          ...wizard,
                          lead: { ...wizard.lead, name: e.target.value },
                        })
                      }
                    />{" "}
                  </label>{" "}
                  <label>
                    {" "}
                    Role label{" "}
                    <select
                      disabled={!!wizId && wizVersion == null}
                      value={wizard.lead.roleLabel}
                      onChange={(e) =>
                        setWizard({
                          ...wizard,
                          lead: { ...wizard.lead, roleLabel: e.target.value },
                        })
                      }
                    >
                      {" "}
                      {[
                        "Board Lead",
                        "CEO",
                        "Founder",
                        "Project Lead",
                        "Care Lead",
                        "Organizer",
                      ].map((r) => (
                        <option key={r} value={r}>
                          {" "}
                          {r}{" "}
                        </option>
                      ))}{" "}
                    </select>{" "}
                  </label>{" "}
                  <label>
                    {" "}
                    Background{" "}
                    <input
                      disabled={!!wizId && wizVersion == null}
                      value={wizard.lead.background}
                      onChange={(e) =>
                        setWizard({
                          ...wizard,
                          lead: { ...wizard.lead, background: e.target.value },
                        })
                      }
                      placeholder="What should advisors know about you?"
                    />{" "}
                  </label>{" "}
                  <label>
                    {" "}
                    Subjects already familiar{" "}
                    <input
                      disabled={!!wizId && wizVersion == null}
                      value={wizard.lead.familiarTopics}
                      onChange={(e) =>
                        setWizard({
                          ...wizard,
                          lead: {
                            ...wizard.lead,
                            familiarTopics: e.target.value,
                          },
                        })
                      }
                    />{" "}
                  </label>{" "}
                  <label>
                    {" "}
                    Subjects needing simpler explanation{" "}
                    <input
                      disabled={!!wizId && wizVersion == null}
                      value={wizard.lead.simplerTopics}
                      onChange={(e) =>
                        setWizard({
                          ...wizard,
                          lead: {
                            ...wizard.lead,
                            simplerTopics: e.target.value,
                          },
                        })
                      }
                    />{" "}
                  </label>{" "}
                  <label>
                    {" "}
                    Communication preferences{" "}
                    <input
                      disabled={!!wizId && wizVersion == null}
                      value={wizard.lead.commPrefs}
                      onChange={(e) =>
                        setWizard({
                          ...wizard,
                          lead: { ...wizard.lead, commPrefs: e.target.value },
                        })
                      }
                      placeholder="e.g. Blunt and brief"
                    />{" "}
                  </label>{" "}
                  <div className="meetctl">
                    {" "}
                    <button type="button" disabled={wizSave.isPending || (!!wizId && wizVersion == null)} onClick={() => wizSave.mutate(undefined)}>
                      {" "}
                      Save draft{" "}
                    </button>{" "}
                    <button
                      type="button"
                      onClick={() => setWizard({ ...wizard, step: 2 })}
                    >
                      {" "}
                      Back{" "}
                    </button>{" "}
                    <button
                      type="button"
                      className="primary"
                      disabled={!wizard.lead.name.trim() || wizSave.isPending || (!!wizId && wizVersion == null)}
                      onClick={() => {
                        wizSave.mutate(4);
                        setWizard({ ...wizard, step: 4 });
                      }}
                    >
                      {" "}
                      Continue{" "}
                    </button>{" "}
                  </div>{" "}
                </div>
              )}{" "}
              {wizard.step < 4 && (
                <div className="card" aria-label="Guided interview">{" "}
                  <h3>Guided interview</h3>{" "}
                  <p>Answer one question at a time. Answers save to the draft and fill fields.</p>{" "}
                  {iturns.map((t, i) => (
                    <div key={i} className="takenote">{" "}
                      <div><b>Guide:</b> {t.question}</div>{" "}
                      {t.answer && <div><b>You:</b> {t.answer}</div>}{" "}
                      {t.analysis && <div className="muted">{t.analysis}</div>}{" "}
                    </div>
                  ))}{" "}
                  {iquestion && <p><b>Next question:</b> {iquestion}</p>}{" "}
                  <label>Your answer<input disabled={!!wizId && wizVersion == null} value={ianswer} onChange={(e) => setIanswer(e.target.value)} placeholder="Answer in your own words" /></label>{" "}
                  <div className="meetctl">{" "}
                    <button type="button" disabled={!wizId || wizVersion == null || askInterview.isPending} onClick={() => askInterview.mutate(ianswer)}>Send answer</button>{" "}
                    <button type="button" className="btn ghost" disabled={!wizId || wizVersion == null} onClick={() => askInterview.mutate("")}>Start interview</button>{" "}
                  </div>{" "}
                  {ichecks.length > 0 && (<div><h4>Checkpoints</h4><ul>{ichecks.map((c, i) => <li key={i}>{c.text}</li>)}</ul></div>)}{" "}
                  {(wizReview.data?.fields ?? []).length > 0 && (<div><h4>Setup fields</h4><ul>{(wizReview.data?.fields ?? []).map((f) => <li key={f.field}>Step {f.step} - {f.field}: {f.status}</li>)}</ul></div>)}{" "}
                </div>
              )}{" "}
              {wizard.step < 4 && (
                <div className="card" aria-label="Board setup guide">
                  {" "}
                  <h3>Setup guide</h3>{" "}
                  {!guide && (
                    <p>
                      {" "}
                      Stuck? The guide asks one question at a time and suggests
                      entries you can apply or ignore. Nothing is filled in
                      without you saying so.{" "}
                    </p>
                  )}{" "}
                  <div className="meetctl">
                    {" "}
                    <button
                      type="button"
                      onClick={() => suggest.mutate()}
                      disabled={!wizId || wizVersion == null || suggest.isPending}
                    >
                      {" "}
                      {suggest.isPending
                        ? "Guide is thinking…"
                        : guide
                          ? "Ask again"
                          : "Ask the guide"}{" "}
                    </button>{" "}
                    {guide && (
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => setGuide(null)}
                      >
                        {" "}
                        Dismiss{" "}
                      </button>
                    )}{" "}
                  </div>{" "}
                  {guide && (
                    <>
                      {" "}
                      <p>{guide.suggestion}</p>{" "}
                      <p>
                        {" "}
                        <b>Next question:</b> {guide.nextQuestion}{" "}
                      </p>{" "}
                      {guide.fields?.mission && (
                        <div className="meetctl">
                          {" "}
                          <span className="muted">
                            {" "}
                            Suggested mission: {guide.fields.mission}{" "}
                          </span>{" "}
                          <button
                            type="button"
                            disabled={!!wizId && wizVersion == null}
                            onClick={() => {
                              setWizard({
                                ...wizard,
                                mission:
                                  guide.fields?.mission ?? wizard.mission,
                              });
                              setGuide(null);
                            }}
                          >
                            {" "}
                            Apply mission{" "}
                          </button>{" "}
                        </div>
                      )}{" "}
                      {guide.fields?.stage && (
                        <div className="meetctl">
                          {" "}
                          <span className="muted">
                            {" "}
                            Suggested stage: {guide.fields.stage}{" "}
                          </span>{" "}
                          <button
                            type="button"
                            disabled={!!wizId && wizVersion == null}
                            onClick={() => {
                              setWizard({
                                ...wizard,
                                stage: guide.fields?.stage ?? wizard.stage,
                              });
                              setGuide(null);
                            }}
                          >
                            {" "}
                            Apply stage{" "}
                          </button>{" "}
                        </div>
                      )}{" "}
                      {guide.fields?.lead && (
                        <div className="meetctl">
                          {" "}
                          <span className="muted">
                            {" "}
                            Suggested lead details received.{" "}
                          </span>{" "}
                          <button
                            type="button"
                            disabled={!!wizId && wizVersion == null}
                            onClick={() => {
                              const l = guide.fields?.lead ?? {};
                              setWizard({
                                ...wizard,
                                lead: {
                                  name: l.name || wizard.lead.name,
                                  roleLabel:
                                    l.roleLabel || wizard.lead.roleLabel,
                                  background:
                                    l.background || wizard.lead.background,
                                  familiarTopics:
                                    l.familiarTopics ||
                                    wizard.lead.familiarTopics,
                                  simplerTopics:
                                    l.simplerTopics ||
                                    wizard.lead.simplerTopics,
                                  commPrefs:
                                    l.commPrefs || wizard.lead.commPrefs,
                                },
                              });
                              setGuide(null);
                            }}
                          >
                            {" "}
                            Apply lead details{" "}
                          </button>{" "}
                        </div>
                      )}{" "}
                      {guide.fields?.roles && guide.fields.roles.length > 0 && (
                        <div>
                          {" "}
                          <h4>Suggested seats</h4>{" "}
                          {(guide.fields.roles ?? []).map((r, i) => (
                            <div key={i} className="takenote">
                              {" "}
                              <b>{r.role}</b> {r.why && <div>{r.why}</div>}{" "}
                              <button
                                type="button"
                                disabled={
                                  (!!wizId && wizVersion == null) ||
                                  wizard.seats.length >= 10 ||
                                  wizard.seats.some(
                                    (s) =>
                                      s.role.toLowerCase() ===
                                      r.role.toLowerCase(),
                                  )
                                }
                                onClick={() =>
                                  setWizard({
                                    ...wizard,
                                    seats: [
                                      ...wizard.seats,
                                      { role: r.role, name: "" },
                                    ],
                                  })
                                }
                              >
                                {" "}
                                Add seat{" "}
                              </button>{" "}
                            </div>
                          ))}{" "}
                          <button
                            type="button"
                            disabled={wizard.seats.length >= 10 || (!!wizId && wizVersion == null)}
                            onClick={() => applyGuideRoles(guide.fields?.roles)}
                          >
                            {" "}
                            Add all suggested{" "}
                          </button>{" "}
                        </div>
                      )}{" "}
                    </>
                  )}{" "}
                </div>
              )}{" "}
              {wizard.step >= 4 && (
                <div className="card">
                  {" "}
                  <h3>Review and create</h3>{" "}
                  <p>
                    {" "}
                    <b>{wizard.name || "Unnamed board"}</b> ·{" "}
                    {wizard.mission || "No mission yet."}{" "}
                    {wizard.stage && <span> · {wizard.stage}</span>}{" "}
                  </p>{" "}
                  <p>
                    {" "}
                    Advisors ({wizard.seats.length}):{" "}
                    {wizard.seats.map((s) => s.role).join(", ") || "none"}{" "}
                  </p>{" "}
                  <p>
                    {" "}
                    Lead: {wizard.lead.name || "not set"} ({" "}
                    {wizard.lead.roleLabel}){" "}
                  </p>{" "}
                  <p role="status">
                    {" "}
                    {wizId
                      ? (wizReview.data?.status ?? "Checking…")
                      : "Save the draft first."}{" "}
                  </p>{" "}
                  {(wizReview.data?.blockers ?? []).length > 0 && (
                    <ul>
                      {" "}
                      {(wizReview.data?.blockers ?? []).map((b) => (
                        <li key={b.field}>
                          {" "}
                          Step {b.step}: {b.message}{" "}
                        </li>
                      ))}{" "}
                    </ul>
                  )}{" "}
                  {(wizReview.data?.fields ?? []).length > 0 && (<div><h4>Setup fields</h4><ul>{(wizReview.data?.fields ?? []).map((f) => <li key={f.field}>Step {f.step} - {f.field}: {f.status}</li>)}</ul></div>)}{" "}
                  {wizId && (wizReview.data?.blockers ?? []).length === 0 && (
                    <p>
                      {" "}
                      Ready to create. Advisor profiles stay drafts until you
                      approve each one.{" "}
                    </p>
                  )}{" "}
                  <div className="meetctl">
                    {" "}
                    <button
                      type="button"
                      onClick={() => setWizard({ ...wizard, step: 3 })}
                    >
                      {" "}
                      Back{" "}
                    </button>{" "}
                    <button
                      type="button"
                      className="primary"
                      disabled={
                        !wizId ||
                        createBoardFromWizard.isPending ||
                        (wizReview.data?.blockers ?? []).length > 0
                      }
                      onClick={() => createBoardFromWizard.mutate()}
                    >
                      {" "}
                      {createBoardFromWizard.isPending
                        ? "Creating…"
                        : "Create board"}{" "}
                    </button>{" "}
                  </div>{" "}
                </div>
              )}{" "}
            </section>
          )}{" "}
          {tab === "profile" && (
            <section aria-label="Profile">
              {" "}
              <h2>Profile</h2>{" "}
              <div className="card" aria-label="Account">
                {" "}
                <h3>Account</h3>{" "}
                <p role="status">
                  {" "}
                  {fbUser
                    ? `${fbUser} · Signed in with Facebook (demo)`
                    : "Not signed in"}{" "}
                </p>{" "}
                <div className="meetctl">
                  {" "}
                  <button type="button" onClick={() => setTab("help")}>
                    {" "}
                    Help{" "}
                  </button>{" "}
                  <button
                    type="button"
                    onClick={() =>
                      setTheme(theme === "dark" ? "light" : "dark")
                    }
                  >
                    {" "}
                    {theme === "dark" ? "Switch to light" : "Switch to dark"}{" "}
                  </button>{" "}
                  {fbUser && (
                    <button type="button" onClick={fbSignOut}>
                      {" "}
                      Sign out{" "}
                    </button>
                  )}{" "}
                </div>{" "}
              </div>{" "}

              <p>
                One lead profile per board — this is who you are in that board's meetings.
              </p>
              <>
                {" "}
                <p role="status">
                  {" "}
                  {lead.data
                    ? `Saved version ${lead.data.version} · updated ${lead.data.updatedAt}`
                    : "No saved profile yet — saving creates version 1."}{" "}
                </p>{" "}
                <p>
                  {" "}
                  Saving here takes effect immediately for future meeting
                  context. Other setup fields stay draft until activation in
                  Settings.{" "}
                </p>{" "}
                <label>
                  {" "}
                  Name{" "}
                  <input
                    value={leadForm.name}
                    onChange={(e) =>
                      setLeadForm({ ...leadForm, name: e.target.value })
                    }
                  />{" "}
                    <div className="muted">{" "}Provenance: {provText(lead.data?.provenanceJson, "name") || "not saved yet"}{" "}</div>
                </label>{" "}
                <label>
                  {" "}
                  Role label for this board{" "}
                  <select
                    value={leadForm.roleLabel}
                    onChange={(e) =>
                      setLeadForm({ ...leadForm, roleLabel: e.target.value })
                    }
                  >
                    {" "}
                    {[
                      "Board Lead",
                      "CEO",
                      "Founder",
                      "Project Lead",
                      "Care Lead",
                      "Organizer",
                    ].map((r) => (
                      <option key={r} value={r}>
                        {" "}
                        {r}{" "}
                      </option>
                    ))}{" "}
                  </select>{" "}
                    <div className="muted">{" "}Provenance: {provText(lead.data?.provenanceJson, "roleLabel") || "not saved yet"}{" "}</div>
                </label>{" "}
                <label>
                  {" "}
                  Background{" "}
                  <input
                    value={leadForm.background}
                    onChange={(e) =>
                      setLeadForm({ ...leadForm, background: e.target.value })
                    }
                  />{" "}
                    <div className="muted">{" "}Provenance: {provText(lead.data?.provenanceJson, "background") || "not saved yet"}{" "}</div>
                </label>{" "}
                <label>
                  {" "}
                  Subjects already familiar{" "}
                  <input
                    value={leadForm.familiarTopics}
                    onChange={(e) =>
                      setLeadForm({
                        ...leadForm,
                        familiarTopics: e.target.value,
                      })
                    }
                  />{" "}
                    <div className="muted">{" "}Provenance: {provText(lead.data?.provenanceJson, "familiarTopics") || "not saved yet"}{" "}</div>
                </label>{" "}
                <label>
                  {" "}
                  Subjects needing simpler explanation{" "}
                  <input
                    value={leadForm.simplerTopics}
                    onChange={(e) =>
                      setLeadForm({
                        ...leadForm,
                        simplerTopics: e.target.value,
                      })
                    }
                  />{" "}
                    <div className="muted">{" "}Provenance: {provText(lead.data?.provenanceJson, "simplerTopics") || "not saved yet"}{" "}</div>
                </label>{" "}
                <label>
                  {" "}
                  Communication preferences{" "}
                  <input
                    value={leadForm.commPrefs}
                    onChange={(e) =>
                      setLeadForm({ ...leadForm, commPrefs: e.target.value })
                    }
                  />{" "}
                    <div className="muted">{" "}Provenance: {provText(lead.data?.provenanceJson, "commPrefs") || "not saved yet"}{" "}</div>
                </label>{" "}
                {!boardId ? (
                  <p role="status">
                    {" "}
                    Select a board to save your lead profile for that board.{" "}
                    <button type="button" onClick={() => setTab("boards")}>
                      {" "}
                      Select board{" "}
                    </button>{" "}
                  </p>
                ) : (
                  <button
                    onClick={() => saveLead.mutate()}
                    disabled={!leadForm.name.trim() || saveLead.isPending}
                  >
                    {" "}
                    Save profile{" "}
                  </button>
                )}{" "}
              </>
            </section>
          )}{" "}
          {tab === "settings" && (
            <section aria-label="Settings">
              {" "}
              <h2>Settings</h2>{" "}

              <div className="card">
                {" "}
                <h3>Model connection (owner only)</h3>{" "}
                {modelStatus.data && (
                  <p role="status">
                    {" "}
                    {modelStatus.data.configured
                      ? `Key: ${modelStatus.data.source} ${modelStatus.data.keyHint}`
                      : "Key: not configured"}{" "}
                    · Model: {modelStatus.data.model}{" "}
                    ·{" "}
                    {modelStatus.data.lastTestAt
                      ? modelStatus.data.lastTestOk
                        ? `Tested OK ${modelStatus.data.lastTestAt}`
                        : `Test failed: ${modelStatus.data.lastTestError}`
                      : "Not tested yet"}{" "}
                  </p>
                )}{" "}
                <label>
                  {" "}
                  API key (stored in backend only){" "}
                  <input
                    type="password"
                    value={modelKey}
                    onChange={(e) => setModelKey(e.target.value)}
                    placeholder="leave blank to keep current"
                    autoComplete="off"
                  />{" "}
                </label>{" "}
                <label>
                  {" "}
                  Chat model{" "}
                  <select
                    value={modelChat}
                    onChange={(e) => setModelChat(e.target.value)}
                  >
                    {" "}
                    <option value="">Default (muse-spark-1.3)</option>{" "}
                    <option value="muse-spark-1.3">muse-spark-1.3</option>{" "}
                    <option value="muse-spark-1.3-contributor">
                      {" "}
                      muse-spark-1.3-contributor{" "}
                    </option>{" "}
                    <option value="muse-wonder-1.0">muse-wonder-1.0</option>{" "}
                  </select>{" "}
                </label>{" "}
                <div className="meetctl">
                  {" "}
                  <button onClick={() => saveModel.mutate()} disabled={saveModel.isPending}>
                    {" "}
                    {saveModel.isPending ? "Saving..." : "Save model settings"}{" "}
                  </button>{" "}
                  <button onClick={() => testModel.mutate()} disabled={testModel.isPending}>
                    {" "}
                    {testModel.isPending ? "Testing..." : "Test connection"}{" "}
                  </button>{" "}
                </div>{" "}
                {modelMsg && (
                  <p role="status">
                    {" "}
                    {modelMsg}{" "}
                  </p>
                )}{" "}
              </div>{" "}
            </section>
          )}{" "}
          {tab === "roster" && (
            <section aria-label="My Advisor Roster">
              {" "}
              <h2>{selRow ? selRow.entry.name : "My Advisor Roster (unlimited)"}{" "}</h2>{" "}
              <p>
                {" "}
                Roster entries are reusable profile templates. Board copies are
                independent; no messages or sources travel with a copy.{" "}
              </p>{" "}
                <div className="roster-detail" aria-label="Selected advisor">
                  {" "}
                  {selRow ? (
                    <div className="card">{" "}
                      <h3>{selRow.entry.name}</h3>{" "}
                      <span className="badge">{" "}{selRow.complete ? "complete" : "incomplete: " + selRow.missing.join(", ")}{" "}</span>{" "}
                      <span className="badge">{" "}{selRow.imageCount} portrait{selRow.imageCount === 1 ? "" : "s"}{" "}</span>{" "}
                      <span className="badge">{" "}v{selRow.entry.version}{" "}</span>{" "}
                      <p>{selRow.entry.description}</p>{" "}
                      <ProfileFields profileJson={selRow.entry.profileJson} />{" "}
                      {selRow.entry.researchRequested ? (selRow.entry.researchedAt ? (<p className="muted">{" "}Researched · {selRow.entry.evidenceCount} evidence claims{" "}</p>) : (<p role="status">{" "}Research in progress…{" "}</p>)) : (<p className="muted">{" "}No research yet — use Research dossier below to gather evidence.{" "}</p>)}
                      {(selImages.data ?? []).length > 0 ? (
                        <div aria-label="Portraits awaiting review">
                          <h4>Portraits - accept one before approval</h4>
                          {(selImages.data ?? []).map((im) => {
                            const status = !im.review || im.review === "accepted" ? "accepted" : im.review === "pending" ? "pending" : "rejected";
                            return (
                              <div className="card portrait-review" key={im.id}>
                                <img src={`/api/images/${im.id}`} alt="Portrait option" className="portrait-thumb" />
                                <div>
                                  <div>
                                    <span className="badge">{im.kind}</span>
                                    <span className={status === "accepted" ? "badge ok" : status === "pending" ? "badge live" : "badge warn"}>{status === "pending" ? "needs review" : status === "rejected" ? "needs replacement" : "accepted"}</span>
                                  </div>
                                  <p className="muted">Source: {im.provenance || "owner-provided"}</p>
                                  {status !== "accepted" && (
                                    <div className="meetctl">
                                      <button disabled={reviewImg.isPending} onClick={() => reviewImg.mutate({ id: im.id, decision: "accept" })}>Accept portrait</button>
                                      <button disabled={reviewImg.isPending} onClick={() => reviewImg.mutate({ id: im.id, decision: "retry" })}>Request new</button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p role="status">{" "}No portrait yet - add one to complete this advisor.{" "}</p>
                      )}{" "}
                      <div className="meetctl">
                        {" "}
                        <button disabled={!boardId || !selRow.complete} title={!boardId ? "Pick a board first" : selRow.complete ? "Attach to current board" : "Complete this entry first: " + selRow.missing.join(", ")} onClick={() => copyAdv.mutate(selRow)}>{" "}Add to current board{" "}</button>{" "}
                        <button onClick={() => { archiveRoster.mutate(selRow); setSelRoster(""); }}>{" "}Archive{" "}</button>{" "}
                        <button onClick={() => { setCnewId(selRow.entry.id); setCportraitMsg(""); setCreateOpen(true); }}>{" "}Add portrait{" "}</button>{" "}
                      </div>{" "}
                      <h4>{" "}Audition (never a meeting message){" "}</h4>{" "}
                      <label>{" "}Sample question{" "}
                        <input value={aq} onChange={(e) => setAq(e.target.value)} placeholder="Ask the starter question" />{" "}</label>{" "}
                      <button disabled={!aq.trim() || runAud.isPending} onClick={() => runAud.mutate()}>{" "}Run audition{" "}</button>{" "}
                      {audResult && <div className="btext">{audResult}</div>}{" "}
                      <h4>{" "}Research dossier{" "}</h4>{" "}
                      <button onClick={() => research(selRow.entry.id)}>{" "}Research dossier{" "}</button>{" "}
                      <DossierView raw={dossier} />{" "}
                    </div>
                  ) : (
                  <p className="muted">Select an advisor from the list to see their record.</p>
                  )}{" "}
                </div>{" "}
              {createOpen && (
                <div className="modal-backdrop" onClick={closeCreate}>
                  {" "}
                  <div className="modal" role="dialog" aria-modal="true" aria-label="Create new advisor" onClick={(e) => e.stopPropagation()}>
                    {" "}
                    <div className="meetctl">
                      {" "}
                      <h3>{" "}Create new advisor{" "}</h3>{" "}
                      <button type="button" className="btn ghost" onClick={closeCreate} aria-label="Close">{" "}✕{" "}</button>{" "}
                    </div>{" "}
                    {!cnewId && (
                      <>
                      {" "}
                      <label>
                        {" "}
                        Name{" "}
                        <input ref={createNameRef} value={cname} onChange={(e) => setCname(e.target.value)} />{" "}
                      </label>{" "}
                      <label>{" "}Description (required){" "}
                        <textarea value={cdesc} onChange={(e) => setCdesc(e.target.value)} rows={3} placeholder="A sentence or more about this advisor" />{" "}</label>{" "}
                      <button disabled={!cname.trim() || cdesc.trim().length < 5 || createChar.isPending} onClick={() => createChar.mutate()}>{" "}Create advisor{" "}</button>{" "}
                      <div className="card">{" "}
                        <h3>{" "}AI-guided advisor{" "}</h3>{" "}
                        <p>{" "}The model researches the role and drafts a full profile. Add a portrait after to complete the entry.{" "}</p>{" "}
                        <label>{" "}Name{" "}
                          <input value={ainame} onChange={(e) => setAiname(e.target.value)} />{" "}</label>{" "}
                        <label>{" "}Role{" "}
                          <input value={airole} onChange={(e) => setAirole(e.target.value)} placeholder="e.g. Growth Hacker" />{" "}</label>{" "}
                        <label>{" "}Focus{" "}
                          <input value={aifocus} onChange={(e) => setAifocus(e.target.value)} placeholder="What should it research?" />{" "}</label>{" "}
                        <button disabled={!ainame.trim() || !airole.trim() || aiDraft.isPending} onClick={() => aiDraft.mutate()}>{" "}{aiDraft.isPending ? "Researching…" : "Research and draft"}{" "}</button>{" "}
                        {aiMsg && <p role="status">{aiMsg}</p>}{" "}
                      </div>{" "}
                      </>
                    )}{" "}
                    {cnewId && (
                      <div className="card">{" "}
                        <h3>{" "}Add a portrait — required{" "}</h3>{" "}
                        <p>{" "}Draft saved. Add a portrait to complete this advisor so it can join a board and be approved.{" "}</p>{" "}
                        <label>{" "}Upload image{" "}
                          <input type="file" accept="image/*" onChange={(e) => uploadNewPortrait(e.target.files?.[0])} />{" "}</label>{" "}
                        <label>{" "}Use image URL{" "}
                          <input value={cportraitUrl} onChange={(e) => setCportraitUrl(e.target.value)} placeholder="https://…" />{" "}</label>{" "}
                        <button disabled={!cportraitUrl || urlNewPortrait.isPending} onClick={() => urlNewPortrait.mutate()}>{" "}Import URL{" "}</button>{" "}
                        <button disabled={genNewPortrait.isPending} onClick={() => genNewPortrait.mutate()}>{" "}Generate portrait{" "}</button>{" "}
                        {cportraitMsg && <p role="status">{cportraitMsg}</p>}{" "}
                        <button onClick={finishNewEntry}>{" "}Done{" "}</button>{" "}
                      </div>
                    )}{" "}
                  </div>{" "}
                </div>
              )}{" "}
            </section>
          )}{" "}
          {tab === "advisors" && (
            <section aria-label="This Board's Advisors">
              {" "}
              <h2>
                {" "}
                This Board's Advisors — {(advisors.data ?? []).length}/10{" "}
              </h2>{" "}
              {!boardId && <p>Pick a board first.</p>}{" "}
              <div className="card">{" "}
                <h3>{" "}Board seats — pick from your roster{" "}</h3>{" "}
                <p>{" "}Check to add, uncheck to remove. Only complete entries (description, profile, portrait) can join.{" "}</p>{" "}
                {!boardId ? (
                  <p>No board open — pick a board to see seats.</p>
                ) : (
                  <>
                {(rosterNames.data ?? []).map((row) => {
                  const attached = (advisors.data ?? []).find((a) => a.rosterEntryId === row.entry.id);
                  const full = (advisors.data ?? []).length >= 10;
                  return (
                    <label key={row.entry.id}>{" "}
                      <input type="checkbox" disabled={!boardId || (!attached && (full || !row.complete))} checked={!!attached} onChange={() => toggleBoardAdvisor(row)} />{" "}
                      {row.entry.name}{" "}{attached ? (attached.approved ? "(approved)" : "(pending approval)") : row.complete ? "" : "(incomplete: " + row.missing.join(", ") + ")"}{" "}
                    </label>
                  );
                })}{" "}
                  </>
                )}{" "}
                <button type="button" onClick={() => setTab("roster")}>{" "}Create new Advisor{" "}</button>{" "}
              </div>{" "}
              {(advisors.data ?? []).length >= 10 && (
                <p>Remove an advisor to add another.</p>
              )}{" "}
              {(advisors.data ?? []).map((a) => (
                <div className="card" key={a.id}>
                  {" "}
                  {a.boardRole}{" "}
                  <span className="badge">
                    {" "}
                    {a.approved ? "approved" : "pending"}{" "}
                  </span>{" "}
                  <span className="badge">
                    {" "}
                    roster v{a.rosterVersion} · {a.imageProvenance}{" "}
                  {(() => { const re = (rosterNames.data ?? []).find((r) => r.entry.id === a.rosterEntryId); return re && re.entry.version > a.rosterVersion ? (<span className="badge">{" "}roster updated — sync first{" "}</span>) : null; })()}
                  </span>{" "}
                  {!a.approved && (
                    <button
                      onClick={() =>
                        post<unknown>(
                          `/api/boards/${boardId}/advisors/${a.id}/approve`,
                          {},
                        ).then(() => refresh("advisors", "setup")).catch((e) => alert(String(e)))
                      }
                    >
                      {" "}
                      Approve{" "}
                    </button>
                  )}{" "}
                  <button
                    title="Pull the newest roster template version into this board copy"
                    onClick={() => syncRoster.mutate(a)}
                  >
                    {" "}
                    Update from roster{" "}
                  </button>{" "}
                </div>
              ))}{" "}
                            <div className="card">
                {" "}
                <h3>{" "}Chat directly with an advisor{" "}</h3>{" "}
                <p>{" "}<span className="badge">fictional advisor</span>{" "}Isolated test chat — never creates meeting messages, records, or memory.{" "}</p>{" "}
                <label>{" "}Board advisor{" "}
                  <select value={chatAdv} onChange={(e) => { setChatAdv(e.target.value); setChatHist([]); setChatErr(""); }}>{" "}
                    <option value="">—</option>{" "}
                    {(advisors.data ?? []).map((a) => (<option key={a.id} value={a.id}>{" "}{a.boardRole}{" "}</option>))}{" "}
                  </select>{" "}</label>{" "}
                {chatSelAdvisor && chatBlocked ? (
                  <p role="alert">{" "}Finish creating this advisor ({chatSelRoster?.missing.join(", ")}) before chatting.{" "}</p>
                ) : (
                  <div className="chatwrap">{" "}
                    <div>{" "}
                      {chatHist.map((t, idx) => {
                        const adv = t.role !== "lead";
                        return (
                          <div key={idx} className={"msg-row " + (adv ? "advisor" : "lead")}>
                            <div className="bubble">
                              <div className="bhead"><b>{adv ? (chatSelAdvisor?.boardRole ?? "Advisor") : "You"}</b></div>
                              <div className="btext">{t.content}</div>
                            </div>
                          </div>
                        );
                      })}{" "}
                    </div>{" "}
                  </div>
                )}{" "}
                <label>{" "}Message{" "}
                  <input disabled={chatBlocked} value={chatMsg} onChange={(e) => setChatMsg(e.target.value)} placeholder="Ask this advisor directly" onKeyDown={(e) => { if (e.key === "Enter") sendChat(); }} />{" "}</label>{" "}
                <button disabled={!boardId || !chatAdv || !chatMsg.trim() || chatBusy || chatBlocked} onClick={sendChat}>{" "}{chatBusy ? "Sending…" : "Send"}{" "}</button>{" "}
                {chatErr && <p role="alert">{chatErr}</p>}{" "}
              </div>{" "}
<div className="card">
                {" "}
                <h3>
                  {" "}
                  Portraits (explicit choices only — nothing generates
                  automatically){" "}
                </h3>{" "}
                <label>
                  {" "}
                  Board advisor{" "}
                  <select
                    value={selAdv}
                    onChange={(e) => setSelAdv(e.target.value)}
                  >
                    {" "}
                    <option value="">—</option>{" "}
                    {(advisors.data ?? []).map((a) => (
                      <option key={a.id} value={a.id}>
                        {" "}
                        {a.boardRole}{" "}
                      </option>
                    ))}{" "}
                  </select>{" "}
                </label>{" "}
                {selAdv && (
                  <>
                    {" "}
                    <label>
                      {" "}
                      Upload image{" "}
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => uploadImg(e.target.files?.[0])}
                      />{" "}
                    </label>{" "}
                    <label>
                      {" "}
                      Use image URL{" "}
                      <input
                        value={imgUrl}
                        onChange={(e) => setImgUrl(e.target.value)}
                        placeholder="https://…"
                      />{" "}
                    </label>{" "}
                    <button disabled={!imgUrl} onClick={() => urlImg.mutate()}>
                      {" "}
                      Import URL{" "}
                    </button>{" "}
                    <button
                      title="Opt-in: starts image generation"
                      onClick={() => genImg.mutate()}
                    >
                      {" "}
                      Generate 2 options{" "}
                    </button>{" "}
                    {imgMsg && <p role="status">{imgMsg}</p>}{" "}
                    {(imgList.data ?? []).map((img) => (
                      <div key={img.id}>
                        {" "}
                        <span className="badge">{img.kind}</span>{" "}
                        {img.provenance.slice(0, 80)}{" "}
                        <button onClick={() => selectImg.mutate(img.id)}>
                          {" "}
                          Use this image{" "}
                        </button>{" "}
                      </div>
                    ))}{" "}
                  </>
                )}{" "}
              </div>{" "}
            </section>
          )}{" "}
          {tab === "meet" && (
            <section
              aria-label="Meetings and conversation"
              className="boardroom"
            >
              {" "}
              {!boardId && <p>Pick a board first.</p>}{" "}
              {boardId && (
                <>
                  {" "}
                  <div className="meet-left">
                    {" "}
                    <div className="meetctl">
                      {" "}
                      <button
                        type="button"
                        className="primary"
                        onClick={() => createMeeting.mutate()}
                      >
                        {" "}
                        Start meeting{" "}
                      </button>{" "}
                    <div className="card">{" "}
                      Advisors for the next meeting (all when untouched){" "}
                      {(advisors.data ?? []).map((a) => (
                        <label key={a.id}>{" "}
                          <input type="checkbox" disabled={!boardId} checked={meetPicks.length === 0 || meetPicks.includes(a.id)} onChange={() => toggleMeetPick(a.id)} />{" "}
                          {a.boardRole}{" "}
                        </label>
                      ))}{" "}
                    </div>{" "}
                    </div>{" "}
                    <input
                      aria-label="Search meetings"
                      placeholder="Search title or brief"
                      value={mq}
                      onChange={(e) => setMq(e.target.value)}
                    />{" "}
                    <select
                      aria-label="State filter"
                      value={mstate}
                      onChange={(e) => setMstate(e.target.value)}
                    >
                      {" "}
                      <option value="">All states</option>{" "}
                      <option value="AwaitingBrief">Awaiting brief</option>{" "}
                      <option value="Active">Active</option>{" "}
                      <option value="Paused">Paused</option>{" "}
                      <option value="WrappingUp">Wrapping up</option>{" "}
                      <option value="ClosedWithRecord">
                        {" "}
                        Closed with record{" "}
                      </option>{" "}
                      <option value="ClosedWithoutPublication">
                        {" "}
                        Closed without publication{" "}
                      </option>{" "}
                    </select>{" "}
                    <ol className="agenda" aria-label="Meetings">
                      {" "}
                      {(meetings.data ?? []).map((m, i) => (
                        <li key={m.id}>
                          {" "}
                          <button
                            type="button"
                            className={m.id === meetingId ? "active" : ""}
                            aria-current={
                              m.id === meetingId ? "true" : undefined
                            }
                            onClick={() => setMeetingId(m.id)}
                          >
                            {" "}
                            <span className="agenda-n" aria-hidden="true">
                              {" "}
                              {i + 1}{" "}
                            </span>{" "}
                            <span className="agenda-t" title={m.title}>
                              {" "}
                              {m.title}{" "}
                            </span>{" "}
                          </button>{" "}
                        </li>
                      ))}{" "}
                    </ol>{" "}
                    {(meetings.data ?? []).length === 0 &&
                      (allMeetings.data ?? []).length === 0 && (
                        <p>No meetings yet — start one above.</p>
                      )}{" "}
                    {(meetings.data ?? []).length === 0 &&
                      (allMeetings.data ?? []).length > 0 && (
                        <p role="status">
                          No meetings match this filter — the open meeting
                          stays selected below.
                        </p>
                      )}{" "}
                  </div>{" "}
                  {meetingId && (
                    <>
                      {" "}
                      <div className="meet-center">
                        {" "}
                        <div className="meet-head">
                          {" "}
                          <div>
                            {" "}
                            <div className="eyebrow">Discussion</div>{" "}
                            <h2>{curMeeting?.title ?? "Meeting"}</h2>{" "}
                            {curMeeting?.brief && (
                              <p className="muted">{curMeeting.brief}</p>
                            )}{" "}
                          </div>{" "}
                          <div className="meetctl">
                            {" "}
                            <button
                              type="button"
                              onClick={() => meetingCtl("pause")}
                              disabled={curMeeting?.state !== 1}
                              title={
                                curMeeting?.state !== 1
                                  ? "Pause is available while the meeting is Active"
                                  : undefined
                              }
                            >
                              {" "}
                              Pause{" "}
                            </button>{" "}
                            <button
                              type="button"
                              onClick={() => meetingCtl("resume")}
                              disabled={curMeeting?.state !== 3}
                              title={
                                curMeeting?.state !== 3
                                  ? "Resume is available while the meeting is Paused"
                                  : undefined
                              }
                            >
                              {" "}
                              Resume{" "}
                            </button>{" "}
                            <button
                              type="button"
                              onClick={() => meetingCtl("end")}
                              disabled={
                                curMeeting == null ||
                                !meetingIsOpen(curMeeting.state)
                              }
                            >
                              {" "}
                              End discussion{" "}
                            </button>{" "}
                            <button
                              type="button"
                              className="primary"
                              onClick={() => runDiscussion.mutate()}
                              disabled={
                                runDiscussion.isPending ||
                                !briefText.trim() ||
                                (curMeeting != null &&
                                  !meetingIsOpen(curMeeting.state))
                              }
                              title={
                                !briefText.trim()
                                  ? "Add a brief before running the discussion"
                                  : undefined
                              }
                            >
                              {" "}
                              {runDiscussion.isPending
                                ? "Advisors drafting…"
                                : "Run discussion"}{" "}
                            </button>{" "}
                          </div>{" "}
                        </div>{" "}
                        {delivery.data && curMeeting && (
                          <p
                            role="status"
                            className="status-line"
                            title={`Revision ${delivery.data.deliveredRevision}`}
                          >
                            {" "}
                            <span className="badge">
                              {" "}
                              {meetingStateLabel(curMeeting.state)}{" "}
                            </span>{" "}
                            <span>{delivery.data.messages} messages</span>{" "}
                            {live && (
                              <span className="badge live">live</span>
                            )}{" "}
                          </p>
                        )}{" "}
                        <details className="setup">
                          {" "}
                          <summary>Meeting setup</summary>{" "}
                          <label>
                            {" "}
                            Title{" "}
                            <input
                              value={mtitle}
                              onChange={(e) => setMtitle(e.target.value)}
                            />{" "}
                          </label>{" "}
                          <label>
                            {" "}
                            Brief (a meeting needs a brief before discussion){" "}
                            <input
                              value={mbrief}
                              onChange={(e) => setMbrief(e.target.value)}
                            />{" "}
                          </label>{" "}
                          <label>
                            {" "}
                            Policy{" "}
                            <select
                              value={policy}
                              onChange={(e) => setPolicy(e.target.value)}
                            >
                              {" "}
                              <option value="focused">
                                {" "}
                                Focused (3,2 · max 5){" "}
                              </option>{" "}
                              <option value="balanced">
                                {" "}
                                Balanced (4,4,2 · max 10){" "}
                              </option>{" "}
                              <option value="open">
                                {" "}
                                Open (4s · max 10){" "}
                              </option>{" "}
                            </select>{" "}
                          </label>{" "}
                          <div className="meetctl">
                            {" "}
                            <button
                              type="button"
                              onClick={() => saveMeeting.mutate()}
                            >
                              {" "}
                              Save title + brief{" "}
                            </button>{" "}
                            <button
                              type="button"
                              onClick={() => closeMeeting(true)}
                            >
                              {" "}
                              Close with record{" "}
                            </button>{" "}
                            <button
                              type="button"
                              onClick={() => closeMeeting(false)}
                            >
                              {" "}
                              Close without publication{" "}
                            </button>{" "}
                            <button type="button" onClick={reopenMeeting}>
                              {" "}
                              Reopen (history intact){" "}
                            </button>{" "}
                          </div>{" "}
                        </details>{" "}
                        <div
                          className="ctabs"
                          role="tablist"
                          aria-label="Meeting views"
                        >
                          {" "}
                          {(
                            [
                              "chat",
                              "takeaways",
                              "options",
                              "decision",
                            ] as const
                          ).map((t) => (
                            <button
                              key={t}
                              type="button"
                              role="tab"
                              aria-selected={meetTab === t}
                              className={meetTab === t ? "active" : ""}
                              onClick={() => setMeetTab(t)}
                              onKeyDown={(e) => {
                                if (
                                  e.key !== "ArrowRight" &&
                                  e.key !== "ArrowLeft"
                                )
                                  return;
                                e.preventDefault();
                                const order = [
                                  "chat",
                                  "takeaways",
                                  "options",
                                  "decision",
                                ] as const;
                                const i = order.indexOf(t);
                                const n =
                                  e.key === "ArrowRight"
                                    ? (i + 1) % order.length
                                    : (i + order.length - 1) % order.length;
                                setMeetTab(order[n]);
                                const sibs = Array.from(
                                  e.currentTarget.parentElement?.querySelectorAll(
                                    "[role=tab]",
                                  ) ?? [],
                                );
                                (sibs[n] as HTMLElement | undefined)?.focus();
                              }}
                            >
                              {" "}
                              {t === "chat"
                                ? "Discussion"
                                : t === "takeaways"
                                  ? "Key takeaways"
                                  : t === "options"
                                    ? "Options"
                                    : "Decision"}{" "}
                            </button>
                          ))}{" "}
                        </div>{" "}
                        {meetTab === "chat" && (
                          <>
                            {" "}
                            <div className="chatwrap">
                              {" "}
                              {newCount > 0 && (
                                <button
                                  type="button"
                                  className="newpill"
                                  onClick={scrollToLatest}
                                >
                                  {" "}
                                  {newCount} new message{" "}
                                  {newCount === 1 ? "" : "s"} ↓{" "}
                                </button>
                              )}{" "}
                              <div
                                ref={msgParentRef}
                                className="chatscroll"
                                aria-label="Conversation messages"
                              >
                                {" "}
                                <div
                                  style={{
                                    height: msgVirtual.getTotalSize(),
                                    position: "relative",
                                  }}
                                >
                                  {" "}
                                  {msgVirtual.getVirtualItems().map((vi) => {
                                    const row = rows[vi.index];
                                    if (!row) return null;
                                    const m = row.m;
                                    const isFresh =
                                      m.sequence === latestSeq &&
                                      prevLatest.current !== latestSeq;
                                    const parsed = parseMsg(m.content);
                                    const who =
                                      m.advisorName ||
                                      (m.sender === "lead"
                                        ? (lead.data?.name ?? "Board lead")
                                        : m.sender);
                                    const isLead =
                                      m.sender === "lead" && !m.advisorName;
                                    const when = m.createdAt
                                      ? new Date(m.createdAt).toLocaleString()
                                      : "";
                                    const stance = m.stance || parsed.stance;
                                    const parentWho = row.parent
                                      ? row.parent.advisorName ||
                                        (row.parent.sender === "lead"
                                          ? (lead.data?.name ?? "Board lead")
                                          : row.parent.sender)
                                      : null;
                                    return (
                                      <div
                                        key={m.sequence}
                                        id={"msg-" + m.sequence}
                                        data-index={vi.index}
                                        ref={msgVirtual.measureElement}
                                        className={isFresh ? "msg-new" : undefined}
                                        style={{
                                          position: "absolute",
                                          top: 0,
                                          left: 0,
                                          width: "100%",
                                          transform: `translateY(${vi.start}px)`,
                                        }}
                                      >
                                        {" "}
                                        <div
                                          className={
                                            "msg-row " +
                                            (isLead ? "lead" : "advisor") +
                                            (row.depth > 0
                                              ? " thread-child"
                                              : "")
                                          }
                                        >
                                          {" "}
                                          <div
                                            className={
                                              parsed.replyTo ||
                                              m.parentSequence != null
                                                ? "bubble reply"
                                                : "bubble"
                                            }
                                          >
                                            {" "}
                                            <div className="bhead">
                                              {" "}
                                              {!isLead && (
                                                <span
                                                  className="avatar sm"
                                                  style={{
                                                    backgroundColor: `hsl(${hue(who)} 30% 32%)`,
                                                  }}
                                                  aria-hidden="true"
                                                >
                                                  {" "}
                                                  {initials(who)}{" "}
                                                </span>
                                              )}{" "}
                                              <b>{who}</b>{" "}
                                              <span className="bmeta">
                                                {" "}
                                                #{m.sequence}{" "}
                                              </span>{" "}
                                              {stance && (
                                                <span className="badge stance">
                                                  {" "}
                                                  {stance}{" "}
                                                </span>
                                              )}{" "}
                                              {parsed.challenged && (
                                                <span className="badge warn">
                                                  {" "}
                                                  Challenged{" "}
                                                </span>
                                              )}{" "}
                                            </div>{" "}
                                            {(m.parentSequence != null ||
                                              parsed.replyTo) && (
                                              <button
                                                type="button"
                                                className="reply-link"
                                                onClick={() =>
                                                  jumpToMessage(
                                                    m.parentSequence,
                                                  )
                                                }
                                                title="Jump to the message this replies to"
                                              >
                                                {" "}
                                                Replying to{" "}
                                                {parentWho ??
                                                  parsed.replyTo ??
                                                  "#" + m.parentSequence}{" "}
                                              </button>
                                            )}{" "}
                                            <div className="btext">
                                              {" "}
                                              {parsed.text}{" "}
                                            </div>{" "}
                                            <div className="mactions">
                                              {" "}
                                              <button
                                                type="button"
                                                className="reply-link"
                                                onClick={() =>
                                                  setReplyTo({
                                                    seq: m.sequence,
                                                    who,
                                                  })
                                                }
                                              >
                                                {" "}
                                                Reply in thread{" "}
                                              </button>{" "}
                                            </div>{" "}
                                            {(when ||
                                              (m.status &&
                                                m.status !== "committed")) && (
                                              <details className="bmeta">
                                                {" "}
                                                <summary>Details</summary>{" "}
                                                <span>
                                                  {" "}
                                                  {when}{" "}
                                                  {when &&
                                                  m.status &&
                                                  m.status !== "committed"
                                                    ? " · "
                                                    : ""}{" "}
                                                  {m.status &&
                                                  m.status !== "committed"
                                                    ? m.status
                                                    : ""}{" "}
                                                </span>{" "}
                                              </details>
                                            )}{" "}
                                            {parsed.cites.length > 0 && (
                                              <div className="cites">
                                                {" "}
                                                {parsed.cites.map((c, i) => (
                                                  <button
                                                    key={i}
                                                    type="button"
                                                    className="btn ghost"
                                                    onClick={() =>
                                                      setTab(
                                                        c.kind === "record"
                                                          ? "records"
                                                          : "sources",
                                                      )
                                                    }
                                                  >
                                                    {" "}
                                                    [{c.kind}: {c.label}]{" "}
                                                  </button>
                                                ))}{" "}
                                              </div>
                                            )}{" "}
                                          </div>{" "}
                                        </div>{" "}
                                      </div>
                                    );
                                  })}{" "}
                                </div>{" "}
                              </div>{" "}
                            </div>{" "}
                            {runDiscussion.isPending && (
                              <div className="thinking" role="status">
                                <span
                                  className="avatar sm thinking"
                                  aria-hidden="true"
                                >
                                  ✦
                                </span>
                                <span>
                                  Advisors are drafting
                                  <span
                                    className="thinking-dots"
                                    aria-hidden="true"
                                  />
                                </span>
                              </div>
                            )}{" "}
                            <div className="composer-bar">
                              {" "}
                              <div className="topline">
                                {" "}
                                <span id="composer-scope">To:</span>{" "}
                                <select
                                  aria-labelledby="composer-scope"
                                  aria-label="Message audience"
                                  value={audience}
                                  onChange={(e) => setAudience(e.target.value)}
                                >
                                  {" "}
                                  <option value="everyone">
                                    {" "}
                                    Everyone{" "}
                                  </option>{" "}
                                  <option value="secretary">
                                    {" "}
                                    Secretary (direct){" "}
                                  </option>{" "}
                                </select>{" "}
                                <span className="muted">
                                  {" "}
                                  {curMeeting?.title}{" "}
                                </span>{" "}
                                <span className="char-count">
                                  {" "}
                                  {draft.length}/4000{" "}
                                </span>{" "}
                              </div>{" "}
                              {replyTo && (
                                <div className="reply-chip" role="status">
                                  {" "}
                                  <span>
                                    {" "}
                                    Replying to #{replyTo.seq} with{" "}
                                    {replyTo.who}{" "}
                                  </span>{" "}
                                  <button
                                    type="button"
                                    className="btn ghost"
                                    onClick={() => setReplyTo(null)}
                                    aria-label="Cancel reply"
                                  >
                                    {" "}
                                    x{" "}
                                  </button>{" "}
                                </div>
                              )}{" "}
                              <div className="composer">
                                {" "}
                                <textarea
                                  aria-label="Message. Press Enter to send, Shift and Enter for a new line."
                                  value={draft}
                                  maxLength={4000}
                                  rows={2}
                                  onChange={(e) => setDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (
                                      e.key === "Enter" &&
                                      !e.shiftKey &&
                                      !(e.nativeEvent as KeyboardEvent)
                                        .isComposing
                                    ) {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      submitDraft();
                                    }
                                  }}
                                  placeholder="Type, dictate, or address the secretary"
                                />{" "}
                                <button
                                  type="button"
                                  className={
                                    recording ? "btn icon rec" : "btn icon"
                                  }
                                  onClick={toggleRec}
                                  title={
                                    recording
                                      ? "Stop dictation"
                                      : "Dictate (mic): transcribes into this draft for editing before send"
                                  }
                                  aria-label={
                                    recording
                                      ? "Stop dictation"
                                      : "Dictate with microphone"
                                  }
                                  aria-pressed={recording}
                                >
                                  {" "}
                                  <svg
                                    width="16"
                                    height="16"
                                    viewBox="0 0 16 16"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.6"
                                    aria-hidden="true"
                                  >
                                    {" "}
                                    <rect
                                      x="6"
                                      y="1"
                                      width="4"
                                      height="8"
                                      rx="2"
                                    />{" "}
                                    <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2" />{" "}
                                  </svg>{" "}
                                </button>{" "}
                                <button
                                  type="button"
                                  className="primary"
                                  onClick={() => submitDraft()}
                                  disabled={!draft.trim()}
                                >
                                  {" "}
                                  Send{" "}
                                </button>{" "}
                              </div>{" "}
                              <div
                                className="muted"
                                style={{ fontSize: "0.78rem" }}
                              >
                                {" "}
                                Enter to send · Shift+Enter for a new line{" "}
                                {transcribing ? " · Transcribing…" : ""}
                                {voiceError ? " · Dictation failed: " + voiceError + " (retry)" : ""}{" "}
                              </div>{" "}
                            </div>{" "}
                            <details className="setup">
                              {" "}
                              <summary>Search this conversation</summary>{" "}
                              <input
                                aria-label="Search messages"
                                value={sq}
                                onChange={(e) => setSq(e.target.value)}
                                placeholder="Server-side search"
                              />{" "}
                              <button type="button" onClick={searchMsgs}>
                                {" "}
                                Search{" "}
                              </button>{" "}
                              {hits.map((h) => (
                                <div key={h.sequence}>
                                  {" "}
                                  #{h.sequence} {h.sender}{" "}
                                  {h.advisorName ? ` · ${h.advisorName}` : ""}:{" "}
                                  {h.excerpt}{" "}
                                </div>
                              ))}{" "}
                            </details>{" "}
                          </>
                        )}{" "}
                        {meetTab === "takeaways" && (
                          <div className="card">
                            {" "}
                            <h3>
                              {" "}
                              Key takeaways (provisional — never decisions){" "}
                            </h3>{" "}
                            {(notes.data ?? [])
                              .filter((n) => n.kind === "briefing")
                              .map((n) => (
                                <div key={n.id} className="takenote">
                                  {" "}
                                  <b>{n.title}</b>{" "}
                                  {n.body.length > 400 ? (
                                    <details>
                                      {" "}
                                      <summary>Show full briefing</summary>{" "}
                                      <div>{n.body}</div>{" "}
                                    </details>
                                  ) : (
                                    <div>{n.body}</div>
                                  )}{" "}
                                </div>
                              ))}{" "}
                            {(notes.data ?? []).filter(
                              (n) => n.kind === "briefing",
                            ).length === 0 && <p>No briefings yet.</p>}{" "}
                            <label>
                              {" "}
                              Briefing topic{" "}
                              <input
                                value={btopic}
                                onChange={(e) => setBtopic(e.target.value)}
                              />{" "}
                            </label>{" "}
                            <button
                              type="button"
                              onClick={() => askBriefing.mutate()}
                            >
                              {" "}
                              Prepare briefing{" "}
                            </button>{" "}
                            <h3>Working notes</h3>{" "}
                            {(notes.data ?? [])
                              .filter((n) => n.kind !== "briefing")
                              .map((n) => (
                                <div key={n.id} className="takenote">
                                  {" "}
                                  <b>{n.title}</b>{" "}
                                  <div>{n.body.slice(0, 300)}</div>{" "}
                                </div>
                              ))}{" "}
                            <label>
                              {" "}
                              Note title{" "}
                              <input
                                value={ntitle}
                                onChange={(e) => setNtitle(e.target.value)}
                              />{" "}
                            </label>{" "}
                            <label>
                              {" "}
                              Note body{" "}
                              <input
                                value={nbody}
                                onChange={(e) => setNbody(e.target.value)}
                              />{" "}
                            </label>{" "}
                            <button
                              type="button"
                              onClick={() => addNote.mutate()}
                            >
                              {" "}
                              Save note{" "}
                            </button>{" "}
                          </div>
                        )}{" "}
                        {meetTab === "options" && (
                          <div className="card">
                            {" "}
                            <h3>Options on the table</h3>{" "}
                            <p>
                              {" "}
                              Adopted directions narrow what advisors argue for.
                              Only exact shown text is adopted.{" "}
                            </p>{" "}
                            {(directions.data ?? []).map((n) => (
                              <div key={n.id} className="takenote">
                                {" "}
                                <b>
                                  {" "}
                                  [{n.scope}] {n.title}:{" "}
                                </b>{" "}
                                {n.body.length > 200 ? (
                                  <details>
                                    {" "}
                                    <summary>Show full text</summary>{" "}
                                    <div>{n.body}</div>{" "}
                                  </details>
                                ) : (
                                  <span> {n.body}</span>
                                )}{" "}
                                <button
                                  type="button"
                                  className="btn ghost"
                                  disabled={!meetingId || fromDirection.isPending}
                                  onClick={() => fromDirection.mutate(n.id)}
                                  title="Stage this exact direction text for record review"
                                >
                                  {" "}
                                  Record this direction{" "}
                                </button>{" "}
                              </div>
                            ))}{" "}
                            {(directions.data ?? []).length === 0 && (
                              <p>No directions adopted yet.</p>
                            )}{" "}
                            <label>
                              {" "}
                              Exact text{" "}
                              <textarea
                                rows={4}
                                value={dtext}
                                onChange={(e) => setDtext(e.target.value)}
                              />{" "}
                            </label>{" "}
                            <label>
                              {" "}
                              Scope{" "}
                              <select
                                value={dscope}
                                onChange={(e) => setDscope(e.target.value)}
                              >
                                {" "}
                                <option value="meeting">
                                  {" "}
                                  Adopt for this meeting{" "}
                                </option>{" "}
                                <option value="board">
                                  {" "}
                                  Adopt board-wide{" "}
                                </option>{" "}
                              </select>{" "}
                            </label>{" "}
                            <button
                              type="button"
                              className="primary"
                              disabled={!dtext.trim()}
                              onClick={() => adopt.mutate()}
                            >
                              {" "}
                              Adopt exact text{" "}
                            </button>{" "}
                          </div>
                        )}{" "}
                        {meetTab === "decision" && (
                          <div className="card key">
                            <h3>Decision state</h3>{" "}
                            {latestDraft ? (
                              <>
                                {" "}
                                <p>
                                  {" "}
                                  Draft v{latestDraft.version} ·{" "}
                                  {latestDraft.status}{" "}
                                  {latestDraft.decided ? " · decided" : ""}{" "}
                                </p>{" "}
                                <p className="muted">
                                  {" "}
                                  Hash <code>{latestDraft.hash}</code> ·
                                  watermark {latestDraft.watermark}{" "}
                                </p>{" "}
                                <button
                                  type="button"
                                  className="primary"
                                  onClick={() => {
                                    setRecId(latestDraft.id);
                                    setTab("records");
                                  }}
                                >
                                  {" "}
                                  Review and approve in Records{" "}
                                </button>{" "}
                              </>
                            ) : (
                              <p>
                                {" "}
                                No record draft yet. End the discussion to
                                prepare one.{" "}
                              </p>
                            )}{" "}
                          </div>
                        )}{" "}
                      </div>{" "}
                      <div
                        className={
                          contextCollapsed
                            ? "meet-right collapsed"
                            : "meet-right"
                        }
                      >
                        {" "}
                        <div className="context-bar">
                          {" "}
                          <div
                            className="ctabs"
                            role="tablist"
                            aria-label="Meeting context"
                          >
                            {" "}
                            {(["members", "context", "decisions"] as const).map(
                              (t) => (
                                <button
                                  key={t}
                                  type="button"
                                  role="tab"
                                  aria-selected={contextTab === t}
                                  onClick={() => setContextTab(t)}
                                >
                                  {" "}
                                  {t === "members"
                                    ? "Board members"
                                    : t === "context"
                                      ? "Context"
                                      : "Decisions"}{" "}
                                </button>
                              ),
                            )}{" "}
                          </div>{" "}
                          <button
                            type="button"
                            className="btn ghost icon"
                            onClick={() => setContextCollapsed(true)}
                            aria-label="Hide meeting context"
                          >
                            {" "}
                            Hide{" "}
                          </button>{" "}
                        </div>{" "}
                        {!contextCollapsed && (
                          <div className="context-body">
                            {" "}
                            {contextTab === "members" && (
                              <>
                                {" "}
                                <h3>
                                  {" "}
                                  Board members ({(advisors.data ?? []).length}
                                  ){" "}
                                </h3>{" "}
                                <ul className="members">
                                  {" "}
                                  {lead.data && (
                                    <li>
                                      {" "}
                                      <span
                                        className="avatar"
                                        style={{
                                          backgroundColor: `hsl(${hue(lead.data.name)} 30% 32%)`,
                                        }}
                                        aria-hidden="true"
                                      >
                                        {" "}
                                        {initials(lead.data.name)}{" "}
                                      </span>{" "}
                                      <span className="member-n">
                                        {" "}
                                        {lead.data.name}{" "}
                                        <span className="member-r">
                                          {" "}
                                          {lead.data.roleLabel} · You{" "}
                                        </span>{" "}
                                      </span>{" "}
                                      <span
                                        className="dot on"
                                        role="img"
                                        aria-label="present"
                                      />{" "}
                                    </li>
                                  )}{" "}
                                  {(advisors.data ?? []).map((a) => (
                                    <li key={a.id}>
                                      {" "}
                                      <span
                                        className="avatar"
                                        style={{
                                          backgroundColor: `hsl(${hue(a.boardRole)} 30% 32%)`,
                                        }}
                                        aria-hidden="true"
                                      >
                                        {" "}
                                        {initials(a.boardRole)}{" "}
                                      </span>{" "}
                                      <span className="member-n">
                                        {" "}
                                        {a.boardRole}{" "}
                                        <span className="member-r">
                                          {" "}
                                          {a.approved
                                            ? "approved"
                                            : "pending"}{" "}
                                        </span>{" "}
                                      </span>{" "}
                                      <span
                                        className={
                                          a.approved ? "dot on" : "dot idle"
                                        }
                                        role="img"
                                        aria-label={
                                          a.approved ? "approved" : "pending"
                                        }
                                      />{" "}
                                    </li>
                                  ))}{" "}
                                </ul>{" "}
                              </>
                            )}{" "}
                            {contextTab === "context" && (
                              <>
                                {" "}
                                <div className="card">
                                  {" "}
                                  <h3>Brief</h3>{" "}
                                  <p>
                                    {" "}
                                    {curMeeting?.brief || "No brief yet."}{" "}
                                  </p>{" "}
                                </div>{" "}
                                <div className="card">
                                  {" "}
                                  <h3>Evidence</h3>{" "}
                                  {excerpts.length === 0 && (
                                    <p>No excerpts for this brief yet.</p>
                                  )}{" "}
                                  {excerpts.map((h, i) => (
                                    <div key={i} className="excerpt">
                                      {" "}
                                      <span className="badge">
                                        {" "}
                                        {h.kind}{" "}
                                      </span>{" "}
                                      <b>{h.ref}</b> <div>{h.text}</div>{" "}
                                    </div>
                                  ))}{" "}
                                  <button
                                    type="button"
                                    className="btn ghost"
                                    onClick={() => setTab("sources")}
                                  >
                                    {" "}
                                    Open sources{" "}
                                  </button>{" "}
                                </div>{" "}
                              </>
                            )}{" "}
                            {contextTab === "decisions" && (
                              <>
                                {" "}
                                <div
                                  className={
                                    recordFlash ? "card flash-accent" : "card"
                                  }
                                >
                                  {" "}
                                  <h3>Record</h3>{" "}
                                  {latestDraft ? (
                                    <p>
                                      {" "}
                                      v{latestDraft.version} ·{" "}
                                      {latestDraft.status}{" "}
                                      {latestDraft.decided
                                        ? " · decided"
                                        : ""}{" "}
                                    </p>
                                  ) : (
                                    <p className="muted">No draft.</p>
                                  )}{" "}
                                  <button
                                    type="button"
                                    className="btn ghost"
                                    onClick={() => {
                                      if (latestDraft) setRecId(latestDraft.id);
                                      setTab("records");
                                    }}
                                  >
                                    {" "}
                                    Open records{" "}
                                  </button>{" "}
                                </div>{" "}
                              </>
                            )}{" "}
                          </div>
                        )}{" "}
                      </div>{" "}
                      {contextCollapsed && (
                        <button
                          type="button"
                          className="context-fab"
                          onClick={() => setContextCollapsed(false)}
                        >
                          {" "}
                          Show context{" "}
                        </button>
                      )}{" "}
                    </>
                  )}{" "}
                </>
              )}{" "}
            </section>
          )}{" "}
          {tab === "sources" && (
            <section aria-label="Resources and Inbox">
              {" "}
              <h2>Resources and Inbox</h2>{" "}
              <p>
                {" "}
                Uploads enter an approval inbox. Excluded sources never serve as
                current evidence.{" "}
              </p>{" "}
              <p role="status" className="source-summary">
                {" "}
                <span className="badge">
                  {" "}
                  {
                    (sources.data ?? []).filter(
                      (s) => !s.approved && !s.excluded,
                    ).length
                  }{" "}
                  pending{" "}
                </span>{" "}
                <span className="badge ok">
                  {" "}
                  {(sources.data ?? []).filter((s) => s.approved).length}{" "}
                  approved{" "}
                </span>{" "}
                <span className="badge">
                  {" "}
                  {(sources.data ?? []).filter((s) => s.excluded).length}{" "}
                  excluded{" "}
                </span>{" "}
              </p>{" "}
              <div className="meetctl">
                {" "}
                <label>
                  {" "}
                  Upload file{" "}
                  <input
                    type="file"
                    onChange={(e) =>
                      uploadSrc(
                        e.target.files?.[0],
                        meetingId ? "meeting" : "board",
                      )
                    }
                  />{" "}
                </label>{" "}
              </div>{" "}
              {(sources.data ?? []).map((s) => (
                <div className="card" key={s.id}>
                  {" "}
                  <b>{s.fileName}</b>{" "}
                  <span className="badge">
                    {" "}
                    v{s.version} · {s.scope}{" "}
                  </span>{" "}
                  <span className="badge">
                    {" "}
                    {s.approved ? "approved" : "pending"}{" "}
                  </span>{" "}
                  {s.excluded && <span className="badge">excluded</span>}{" "}
                  <div>
                    {" "}
                    <button
                      onClick={() => srcOp(s.id, "approve")}
                      disabled={s.approved}
                    >
                      {" "}
                      Approve{" "}
                    </button>{" "}
                    <button
                      onClick={() => srcOp(s.id, "exclude")}
                      disabled={s.excluded}
                    >
                      {" "}
                      Exclude{" "}
                    </button>{" "}
                    <button
                      onClick={() => srcOp(s.id, "restore")}
                      disabled={!s.excluded}
                    >
                      {" "}
                      Restore{" "}
                    </button>{" "}
                    <button onClick={() => srcOp(s.id, "retry")}>
                      {" "}
                      Retry extraction{" "}
                    </button>{" "}
                    <button
                      onClick={() => {
                        setScopeId(s.id);
                        setScopeSel(s.scope);
                        setScopeMeeting(s.meetingId ?? meetingId);
                        scopeDlg.current?.showModal();
                      }}
                    >
                      {" "}
                      Set scope…{" "}
                    </button>{" "}
                    <a href={`/api/sources/${s.id}/download`}>
                      {" "}
                      Download original{" "}
                    </a>{" "}
                  </div>{" "}
                </div>
              ))}{" "}
              <dialog
                ref={scopeDlg}
                aria-label="Set source scope"
                onClose={() => setScopeId("")}
              >
                {" "}
                <h3>Source scope</h3>{" "}
                <label>
                  {" "}
                  <input
                    type="radio"
                    name="scope"
                    value="board"
                    checked={scopeSel === "board"}
                    onChange={() => setScopeSel("board")}
                  />{" "}
                  Whole board{" "}
                </label>{" "}
                <label>
                  {" "}
                  <input
                    type="radio"
                    name="scope"
                    value="meeting"
                    checked={scopeSel === "meeting"}
                    onChange={() => setScopeSel("meeting")}
                  />{" "}
                  One meeting{" "}
                </label>{" "}
                {scopeSel === "meeting" && (
                  <label>
                    {" "}
                    Meeting{" "}
                    <select
                      value={scopeMeeting}
                      onChange={(e) => setScopeMeeting(e.target.value)}
                    >
                      {" "}
                      <option value="">— pick —</option>{" "}
                      {(meetings.data ?? []).map((m) => (
                        <option key={m.id} value={m.id}>
                          {" "}
                          {m.title}{" "}
                        </option>
                      ))}{" "}
                    </select>{" "}
                  </label>
                )}{" "}
                <div className="meetctl">
                  {" "}
                  <button
                    disabled={scopeSel === "meeting" && !scopeMeeting}
                    onClick={saveScope}
                  >
                    {" "}
                    Save scope{" "}
                  </button>{" "}
                  <button onClick={() => scopeDlg.current?.close()}>
                    {" "}
                    Cancel{" "}
                  </button>{" "}
                </div>{" "}
              </dialog>{" "}
              <div className="card">
                {" "}
                <h3>Recall approved material (local ranked search)</h3>{" "}
                <input
                  aria-label="Recall query"
                  value={recallQ}
                  onChange={(e) => setRecallQ(e.target.value)}
                  placeholder="Search approved sources, records, directions"
                />{" "}
                <button onClick={runRecall}>Recall</button>{" "}
                {recallHits.map((h, i) => (
                  <div key={i}>
                    {" "}
                    <span className="badge">{h.kind}</span> <b>{h.ref}</b>{" "}
                    (score {h.score}): {h.text}{" "}
                  </div>
                ))}{" "}
              </div>{" "}
              <div className="card">
                {" "}
                <h3>Source policy</h3>{" "}
                <label>
                  {" "}
                  Blocked file types (comma-separated extensions){" "}
                  <input
                    value={blocked}
                    onChange={(e) => setBlocked(e.target.value)}
                    placeholder="exe, zip"
                  />{" "}
                </label>{" "}
                <button onClick={() => savePolicy.mutate()}>
                  {" "}
                  Save policy{" "}
                </button>{" "}
              </div>{" "}
            </section>
          )}{" "}
          {tab === "records" && (
            <section aria-label="Records">
              {" "}
              <h2>Records</h2>{" "}
              <p>
                {" "}
                Review drafts, approve selected or all with hash + watermark
                checks, request revision, or discard. Free-text agreement never
                approves.{" "}
              </p>{" "}
              {!meetingId && <p>Pick a meeting first.</p>}{" "}
              {meetingId && (
                <>
                  {" "}
                  <div className="card">
                    {" "}
                    <h3>Prepare draft</h3>{" "}
                    <label>
                      {" "}
                      Items JSON{" "}
                      <input
                        value={draftItems}
                        onChange={(e) => setDraftItems(e.target.value)}
                      />{" "}
                    </label>{" "}
                    <button onClick={prepareDraft}>
                      {" "}
                      Prepare draft from items{" "}
                    </button>{" "}
                  </div>{" "}
                  {(recs.data ?? []).map((r) => (
                    <div className="card" key={r.id}>
                      {" "}
                      <button onClick={() => setRecId(r.id)}>
                        {" "}
                        v{r.version} · {r.status}{r.decided ? " · decided" : ""}{" "}
                      </button>{" "}
                      <span className="badge">
                        {" "}
                        {r.hash} @ {r.watermark}{" "}
                      </span>{" "}
                    </div>
                  ))}{" "}
                  {recOk && recDetail.data && (
                    <div className="card key">
                      {" "}
                      <h3>
                        {" "}
                        Review v{recDetail.data.version} ({" "}
                        {recDetail.data.status}){" "}
                      </h3>{" "}
                      <p>
                        {" "}
                        Hash <code>{recDetail.data.hash}</code> · watermark{" "}
                        {recDetail.data.watermark}{" "}
                      </p>{" "}
                      {(() => {
                        try {
                          return (
                            JSON.parse(recDetail.data.itemsJson) as {
                              id?: string;
                              text?: string;
                            }[]
                          ).map((it) => (
                            <label key={it.id ?? it.text}>
                              {" "}
                              <input
                                type="checkbox"
                                checked={selItems.includes(it.id ?? "")}
                                onChange={(e) =>
                                  setSelItems(
                                    e.target.checked
                                      ? [...selItems, it.id ?? ""]
                                      : selItems.filter(
                                          (x) => x !== (it.id ?? ""),
                                        ),
                                  )
                                }
                              />{" "}
                              [{it.id}] {it.text}{" "}
                            </label>
                          ));
                        } catch {
                          return <p>Unparseable items.</p>;
                        }
                      })()}{" "}
                      <div className="card">
                        {" "}
                        <h3>Compare with another version</h3>{" "}
                        <label>
                          {" "}
                          Earlier version{" "}
                          <select
                            value={cmpVer}
                            onChange={(e) => setCmpVer(e.target.value)}
                          >
                            {" "}
                            <option value="">— pick —</option>{" "}
                            {(recs.data ?? [])
                              .filter((r) => r.id !== recDetail.data.id)
                              .map((r) => (
                                <option key={r.id} value={r.id}>
                                  {" "}
                                  v{r.version} · {r.status}{" "}
                                </option>
                              ))}{" "}
                          </select>{" "}
                        </label>{" "}
                        {cmpVer &&
                          (() => {
                            const other = (recs.data ?? []).find(
                              (r) => r.id === cmpVer,
                            );
                            if (!other) return null;
                            const rows =
                              recDetail.data.version >= other.version
                                ? diffItems(
                                    other.itemsJson,
                                    recDetail.data.itemsJson,
                                  )
                                : diffItems(
                                    recDetail.data.itemsJson,
                                    other.itemsJson,
                                  );
                            return rows.length === 0 ? (
                              <p>Identical item sets.</p>
                            ) : (
                              <ul>
                                {" "}
                                {rows.map((d, i) => (
                                  <li key={i}>
                                    {" "}
                                    <b>{d.mark}</b> [{d.key}] {d.text}{" "}
                                  </li>
                                ))}{" "}
                              </ul>
                            );
                          })()}{" "}
                      </div>{" "}
                      <div>
                        {" "}
                        <button onClick={() => approveRec(false)}>
                          {" "}
                          Approve selected{" "}
                        </button>{" "}
                        <button onClick={() => approveRec(true)}>
                          {" "}
                          Approve all{" "}
                        </button>{" "}
                        <a
                          href={`/api/records/${recDetail.data.id}/export?format=concise`}
                        >
                          {" "}
                          Export concise{" "}
                        </a>{" "}
                        <span> </span>{" "}
                        <a
                          href={`/api/records/${recDetail.data.id}/export?format=detailed`}
                        >
                          {" "}
                          Export detailed{" "}
                        </a>{" "}
                      </div>{" "}
                      <label>
                        {" "}
                        Revised items JSON{" "}
                        <input
                          value={revText}
                          onChange={(e) => setRevText(e.target.value)}
                        />{" "}
                      </label>{" "}
                      <button onClick={() => reviseRec(false)}>
                        {" "}
                        Request revision (new version){" "}
                      </button>{" "}
                      <button onClick={() => reviseRec(true)}>
                        {" "}
                        Amend (name superseded IDs){" "}
                      </button>{" "}
                      <button onClick={discardRec}>Discard draft</button>{" "}
                    </div>
                  )}{" "}
                </>
              )}{" "}
            </section>
          )}{" "}
          {tab === "people" && (
            <section aria-label="People">
              {" "}
              <h2>People</h2>{" "}
              <p>
                {" "}
                Board-scoped invitations and meeting grants live here.
                Revocation stops new reads and live updates.{" "}
              </p>{" "}
              {!boardId && <p>Pick a board first.</p>}{" "}
              <div className="card">
                {" "}
                <h3>Identity</h3>{" "}
                <p role="status">
                  {" "}
                  {me.data
                    ? `${me.data.user}${me.data.authenticated ? " · signed in" : " · demo identity"}`
                    : "…"}{" "}
                </p>{" "}
                <p>
                  {" "}
                  Sign in or out from the top bar. Collaborators join by
                  invitation below and are bound by grants.{" "}
                </p>{" "}
              </div>{" "}
              {boardId && (
                <>
                  {" "}
                  <div className="card">
                    {" "}
                    <h3>Act as (demo identity for grant checks)</h3>{" "}
                    <input
                      aria-label="Act as user"
                      value={actAsState}
                      onChange={(e) => setActAsState(e.target.value)}
                      placeholder="owner (default)"
                    />{" "}
                    <button
                      onClick={() => {
                        actAs = actAsState.trim();
                        qc.invalidateQueries();
                      }}
                    >
                      {" "}
                      Apply identity{" "}
                    </button>{" "}
                  </div>{" "}
                  <div className="card">
                    {" "}
                    <h3>Invitations</h3>{" "}
                    <label>
                      {" "}
                      Email{" "}
                      <input
                        value={iemail}
                        onChange={(e) => setIemail(e.target.value)}
                      />{" "}
                    </label>{" "}
                    <label>
                      {" "}
                      Role{" "}
                      <select
                        value={irole}
                        onChange={(e) => setIrole(e.target.value)}
                      >
                        {" "}
                        <option value="viewer">Viewer (read)</option>{" "}
                        <option value="collaborator">
                          {" "}
                          Collaborator (contribute){" "}
                        </option>{" "}
                        <option value="manager">Manager (manage)</option>{" "}
                      </select>{" "}
                    </label>{" "}
                    <button onClick={() => invite.mutate()}>Invite</button>{" "}
                    {(invites.data ?? []).map((i) => (
                      <div key={i.id}>
                        {" "}
                        {i.email} · {i.role} ·{" "}
                        <span className="badge">{i.state}</span>{" "}
                        {i.state === "pending" && (
                          <button
                            onClick={() =>
                              post<unknown>(
                                `/api/invites/${i.id}/revoke`,
                                {},
                              ).then(() => refresh("invites", "grants"))
                            }
                          >
                            {" "}
                            Revoke{" "}
                          </button>
                        )}{" "}
                      </div>
                    ))}{" "}
                  </div>{" "}
                  <div className="card">
                    {" "}
                    <h3>
                      {" "}
                      Grants (empty board = open; adding one enforces
                      checks){" "}
                    </h3>{" "}
                    <label>
                      {" "}
                      User{" "}
                      <input
                        value={guser}
                        onChange={(e) => setGuser(e.target.value)}
                        placeholder="email or label"
                      />{" "}
                    </label>{" "}
                    <label>
                      {" "}
                      Access{" "}
                      <select
                        value={gaccess}
                        onChange={(e) => setGaccess(e.target.value)}
                      >
                        {" "}
                        <option value="read">Read</option>{" "}
                        <option value="contribute">Contribute</option>{" "}
                        <option value="manage">Manage</option>{" "}
                      </select>{" "}
                    </label>{" "}
                    <p>
                      {" "}
                      Scope:{" "}
                      {meetingId
                        ? `this meeting (${meetingId.slice(0, 8)})`
                        : "whole board"}{" "}
                      . Pick a meeting in Meetings to scope a grant to it.{" "}
                    </p>{" "}
                    <button onClick={() => grant.mutate()}>Set grant</button>{" "}
                    {(grants.data ?? []).map((g) => (
                      <div key={g.id}>
                        {" "}
                        {g.userKey} · {g.access}{" "}
                        {g.meetingId
                          ? ` · meeting ${g.meetingId.slice(0, 8)}`
                          : " · board"}{" "}
                        <button
                          onClick={() =>
                            fetch(`/api/grants/${g.id}`, {
                              method: "DELETE",
                              headers: withUser(),
                            }).then(() => refresh("grants"))
                          }
                        >
                          {" "}
                          Revoke{" "}
                        </button>{" "}
                      </div>
                    ))}{" "}
                  </div>{" "}
                </>
              )}{" "}
            </section>
          )}{" "}
          {tab === "activity" && (
            <section aria-label="Activity and Usage">
              {" "}
              <h2>Activity and Usage</h2>{" "}
              <div className="meetctl">
                {" "}
                <label>
                  {" "}
                  Day{" "}
                  <input
                    type="date"
                    value={uday}
                    onChange={(e) => setUday(e.target.value)}
                  />{" "}
                </label>{" "}
                <label>
                  {" "}
                  From{" "}
                  <input
                    type="date"
                    value={ufrom}
                    onChange={(e) => setUfrom(e.target.value)}
                  />{" "}
                </label>{" "}
                <label>
                  {" "}
                  To{" "}
                  <input
                    type="date"
                    value={uto}
                    onChange={(e) => setUto(e.target.value)}
                  />{" "}
                </label>{" "}
              </div>{" "}
              <h3>Jobs</h3>{" "}
              {(jobs.data ?? []).map((j) => (
                <div key={j.id}>
                  {" "}
                  {j.kind} · <span className="badge">{j.state}</span>{" "}
                  {j.state === "failed" && (
                    <button onClick={() => retryJob(j)}>
                      {" "}
                      Retry (same identity){" "}
                    </button>
                  )}{" "}
                </div>
              ))}{" "}
              {(jobs.data ?? []).length === 0 && <p>No jobs.</p>}{" "}
              <div className="card">
                {" "}
                <h3>Spending cap (owner only)</h3>{" "}
                {spending.data && (
                  <p role="status">
                    {" "}
                    {spending.data.month}: known ${spending.data.knownSpendUsd}{" "}
                    {spending.data.monthlyCapUsd != null
                      ? ` / cap $${spending.data.monthlyCapUsd}`
                      : " / no cap"}{" "}
                    {" · "} {spending.data.unknownCostCalls} unknown-cost calls{" "}
                    {spending.data.overCap ? " · OVER CAP" : ""}{" "}
                    {spending.data.enforced
                      ? " · blocking non-owner calls"
                      : ""}{" "}
                  </p>
                )}{" "}
                {spending.data && <p>{spending.data.note}</p>}{" "}
                <label>
                  {" "}
                  Monthly cap USD (empty = none){" "}
                  <input
                    value={capInput}
                    onChange={(e) => setCapInput(e.target.value)}
                    placeholder="e.g. 50"
                  />{" "}
                </label>{" "}
                <label>
                  {" "}
                  At cap{" "}
                  <select
                    value={capMode}
                    onChange={(e) => setCapMode(e.target.value)}
                  >
                    {" "}
                    <option value="warn">
                      {" "}
                      Warn (calls continue, status shows over){" "}
                    </option>{" "}
                    <option value="block">
                      {" "}
                      Block non-owner model calls (owner override always
                      works){" "}
                    </option>{" "}
                  </select>{" "}
                </label>{" "}
                <button onClick={() => saveSpending.mutate()}>
                  {" "}
                  Save spending controls{" "}
                </button>{" "}
              </div>{" "}

              <h3>Usage (live ledger)</h3>{" "}
              <div className="table-scroll">
                {" "}
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Kind</th><th>Model</th><th className="num">In</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(usage.data ?? []).map((u, i) => (
                      <tr key={i}>
                        <td>{u.kind}</td><td>{u.model}</td>
                        <td className="num">{u.inputTokens}</td>
                        <td>{u.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>{" "}
              </div>{" "}
              <h3>Model calls</h3>{" "}
              <div className="table-scroll">
                {" "}
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Model</th><th>Purpose</th>
                      <th className="num">In/out</th>
                      <th className="num">Latency</th><th>Search</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(modelCalls.data ?? []).map((m, i) => (
                      <tr key={i}>
                        <td>{m.model}</td><td>{m.purpose}</td>
                        <td className="num">{m.inputTokens}/{m.outputTokens}</td>
                        <td className="num">{m.latencyMs}ms</td>
                        <td>{m.ranSearch ? "grounded" : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>{" "}
              </div>{" "}
              <div className="card">
                {" "}
                <h3>Compare models (live ledger)</h3>{" "}
                {(() => {
                  const byModel = new Map<
                    string,
                    {
                      calls: number;
                      inTok: number;
                      outTok: number;
                      ms: number;
                      searches: number;
                    }
                  >();
                  for (const m of modelCalls.data ?? []) {
                    const e = byModel.get(m.model) ?? {
                      calls: 0,
                      inTok: 0,
                      outTok: 0,
                      ms: 0,
                      searches: 0,
                    };
                    e.calls++;
                    e.inTok += m.inputTokens;
                    e.outTok += m.outputTokens;
                    e.ms += m.latencyMs;
                    if (m.ranSearch) e.searches++;
                    byModel.set(m.model, e);
                  }
                  const rows = [...byModel.entries()];
                  return rows.length === 0 ? (
                    <p>No model calls yet.</p>
                  ) : (
                    <ul>
                      {" "}
                      {rows.map(([model, e]) => (
                        <li key={model}>
                          {" "}
                          <b>{model}</b> · {e.calls} calls · {e.inTok}/{" "}
                          {e.outTok} in/out tokens · avg{" "}
                          {Math.round(e.ms / Math.max(1, e.calls))}ms ·{" "}
                          {e.searches} grounded{" "}
                        </li>
                      ))}{" "}
                    </ul>
                  );
                })()}{" "}
              </div>{" "}
              <div className="card">
                {" "}
                <h3>Backup / restore (owner only, hash-verified)</h3>{" "}
                <button onClick={doBackup}>Export full backup</button>{" "}
                {bakText && (
                  <p role="status">
                    {" "}
                    Hash <code>{bakHash}</code> · {bakText.length} chars
                    including originals and images.{" "}
                  </p>
                )}{" "}
                <label>
                  {" "}
                  Backup snapshot{" "}
                  <input
                    value={bakText}
                    onChange={(e) => setBakText(e.target.value)}
                    placeholder="paste backup snapshot"
                  />{" "}
                </label>{" "}
                <label>
                  {" "}
                  Backup hash{" "}
                  <input
                    value={bakHash}
                    onChange={(e) => setBakHash(e.target.value)}
                  />{" "}
                </label>{" "}
                <button onClick={doRestore}>
                  {" "}
                  Restore (replaces current data){" "}
                </button>{" "}
              </div>{" "}
              <h3>Audit</h3>{" "}
              <div className="table-scroll">
                {" "}
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Action</th><th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(audit.data ?? []).slice(0, 50).map((a, i) => (
                      <tr key={i}>
                        <td>{a.action}</td>
                        <td title={a.detail}>{a.detail.slice(0, 140)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>{" "}
              </div>{" "}
            </section>
          )}{" "}
          {tab === "help" && (
            <section aria-label="Help">
              {" "}
              <h2>Help — command coverage</h2>{" "}
              <div className="card">
                {" "}
                <h3>Keyboard shortcuts</h3>{" "}
                <ul>
                  {" "}
                  <li>
                    {" "}
                    <b>Alt+1 … Alt+9, Alt+0</b> — switch rail tabs in order{" "}
                  </li>{" "}
                  <li>
                    {" "}
                    <b>Ctrl+Enter</b> (or Cmd+Enter) — send the meeting composer
                    message{" "}
                  </li>{" "}
                </ul>{" "}
              </div>{" "}
              <input
                aria-label="Search commands"
                placeholder="Search commands or views"
                value={hq}
                onChange={(e) => setHq(e.target.value)}
              />{" "}
              {(cmds.data ?? [])
                .filter(
                  (c) =>
                    !hq ||
                    c.command.includes(hq) ||
                    c.view.toLowerCase().includes(hq.toLowerCase()),
                )
                .map((c, i) => (
                  <div className="card" key={i}>
                    {" "}
                    <b>{c.command}</b> → {c.view}: {c.action}{" "}
                  </div>
                ))}{" "}
            </section>
          )}{" "}
        </main>{" "}
      </div>{" "}
      <div className="toasts" aria-live="polite">
        {" "}
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.err ? "alert" : "status"}
            className={t.err ? "toast err" : "toast"}
          >
            {" "}
            {t.text}{" "}
          </div>
        ))}{" "}
      </div>{" "}
    </div>
  );
}
