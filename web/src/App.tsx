import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer, useWindowVirtualizer } from "@tanstack/react-virtual";
import { HubConnectionBuilder, type HubConnection } from "@microsoft/signalr";
import SourcesGovernance from "./sources-governance";
import { CreateAdvisor, CharacterEditor, CANONICAL_SAVE_INVALIDATIONS, fetchFreshCanonicalEntry, isRosterResearchRunning, shouldShowResearchWorking } from "./advisor-creation";
import { useMeetingActivity } from "./meeting-activity";
import {
  ConversationHeader,
  ConversationSearchField,
  MeetingSettingsDialog,
  useConversationSettings,
} from "./conversation-controls";
import "./conversation-controls.css";
import { RosterChatPanel } from "./roster-chat";
import "./roster-chat.css";
import { BoardAdvisorLinkPanel, RosterLinkBadge } from "./roster-integrity";
import { MeetingParticipants } from "./meeting-participants";
import "./meeting-participants.css";
import { buildPresence, normalizeDisplayImageId } from "./meeting-presence";
import "./roster-integrity.css";
import { HumanDisclosure, FriendlyError, StatusChip } from "./human-disclosure";
import { RecordComparison, RecordItemEditor, RecordItemList, RecordVersionRow } from "./human-record-items";
import { friendlyError, friendlyRecordStatus, humanizeOmission, parseRecordItems } from "./human-format";
import "./human-feedback.css";
import { convertRecordedBlobToWav } from "./voiceCodec";
import WikiResources from "./wiki-resources";
type Board = { id: string; name: string; mission: string; archived?: boolean };
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
  displayPortraitImageId?: string | null;
};
type MeetingFull = Meeting & { brief: string; boardId: string; participantIdsJson?: string };
const DEFAULT_COMM_PREFS = "Be clear and direct. Explain unfamiliar terms, use practical examples, and finish with actionable next steps.";
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
function ReviewAlert({ message }: { message: string }) {
  const plain = friendlyError(message);
  return plain ? (
    <FriendlyError friendly={plain} technical={message} />
  ) : (
    <p role="alert">{message}</p>
  );
}
function humanWhen(v: string): string {
  try {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d.toLocaleString();
  } catch { /* noop */ }
  return "";
}
function humanAuditAction(action: string): string {
  const a = (action ?? "").toLowerCase();
  if (a.indexOf("backup") >= 0) return "Backup";
  if (a.indexOf("restore") >= 0) return "Restore";
  if (a.indexOf("roster") >= 0 && a.indexOf("research") >= 0) return "Advisor research";
  if (a.indexOf("roster") >= 0) return "Roster change";
  if (a.indexOf("approve") >= 0) return "Approval";
  if (a.indexOf("record") >= 0) return "Record change";
  if (a.indexOf("meeting") >= 0) return "Meeting change";
  if (a.indexOf("spending") >= 0 || a.indexOf("cap") >= 0) return "Spending control";
  if (a.indexOf("invite") >= 0 || a.indexOf("grant") >= 0) return "Access change";
  if (a.indexOf("source") >= 0 || a.indexOf("wiki") >= 0) return "Source change";
  const words = (action ?? "").replace(/[._-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Activity";
}
function toastErr(e: unknown): void {
  try {
    alert(friendlyError(String(e)) || "Something went wrong. Please try again.");
  } catch { /* noop */ }
}
function meetingSendOpen(state: unknown): boolean { return state === 0 || state === 1; }
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
type SecEvidence = { kind: string; ref: string; version?: number; title?: string; excerpt?: string };
type SecRequest = { id: string; boardId: string; meetingId: string; clientNonce: string; status: string; question: string; answer: string; noteId?: string; };
type Note = {
  id: string;
  boardId: string;
  meetingId: string;
  kind: string;
  scope: string;
  title: string;
  body: string;
  provisional: boolean;
  rootId?: string;
  revision?: number;
  predecessorId?: string;
  noteStatus?: string;
  evidenceJson?: string;
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
  discardedJson: string;
  reviewRevision: number;
  reviewToken: string;
  historyJson: string;
  supersedesJson: string;
  legacyReview?: boolean | null;
};
type RecordReviewNote = { id: string; kind: string; title: string; body: string; createdAt: string };
type RecordReviewMsg = { sequence: number; sender: string; advisorName?: string | null; content: string };
type RecordEvidence = { itemId: string; kind: string; ref: string; version?: number | null; title: string; excerpt: string; currentEligible: boolean; historical: boolean; missing: boolean };
type LineageEffect = { id: string; text: string; status: string; fromVersion: number; toVersion: number };
type RecordReview = {
  stateValid: boolean;
  stateError: string;
  draft: RecordDraft;
  approved: string[];
  discarded: string[];
  pending: string[];
  notes: RecordReviewNote[];
  recentMessages: RecordReviewMsg[];
  predecessors: string[];
  successors: string[];
  evidence: RecordEvidence[];
  lineageEffects?: LineageEffect[];
  historyCount: number;
  meetingWatermark: number;
  legacyReview?: boolean | null;
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
  id?: string;
  kind: string;
  model: string;
  inputTokens: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  searchCalls?: number;
  latencyMs?: number;
  ranSearch?: boolean;
  status?: string;
  providerCallId?: string | null;
  costBasis?: string | null;
  cost?: number | null;
  note: string;
  boardId?: string | null;
  meetingId?: string | null;
  at: string;
  scope?: string;
  allocationLabel?: string;
  hiddenPurpose?: boolean;
  unknownCost?: boolean;
};
type UsageSummaryEnvelope = {
  rows: UsageRow[];
  total: number;
  returned: number;
  scope: string;
  boardId?: string | null;
  meetingId?: string | null;
  summary: { total: number; knownCostUsd: number; unknownCostCalls: number; allocated: number; unallocated: number; missing: number };
  pricingBasis: { checkedDate: string; pricing: string; searchGrounding: string; speechToText: string; imageGeneration: string; note: string; storage: string };
  storage: string;
};
type ModelCallRow = {
  id?: string;
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  latencyMs: number;
  ranSearch: boolean;
  searchCalls?: number;
  providerCallId?: string | null;
  status?: string;
  cost?: number | null;
  costBasis?: string | null;
  boardId?: string | null;
  meetingId?: string | null;
  searchNote?: string | null;
  at: string;
  scope?: string;
  allocationLabel?: string;
  hiddenPurpose?: boolean;
  unknownCost?: boolean;
};
type ModelCallsEnvelope = {
  rows: ModelCallRow[];
  total: number;
  returned: number;
  scope: string;
  storage: string;
  pricingBasis: { checkedDate: string; note: string; storage: string };
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
function canonicalUser(): string {
  try {
    const tok = currentToken();
    if (tok) return currentUser() || "owner";
  } catch { /* fall through to demo label */ }
  try { return (actAs || "").trim() || "owner"; } catch { return "owner"; }
}
function fullIdentityToken(): string {
  try { return currentToken() || ""; } catch { return ""; }
}
function epochNow(): number {
  try { return (window as unknown as { __simceoEpoch?: number }).__simceoEpoch ?? 0; } catch { return 0; }
}
function currentToken(): string {
  try { return localStorage.getItem("simceo-token") ?? ""; } catch { return ""; }
}
function currentUser(): string {
  try { return localStorage.getItem("simceo-user") ?? ""; } catch { return ""; }
}
function scopedKey(base: string): string {
  try { const u = localStorage.getItem("simceo-user") ?? "anon"; return base + ":" + (u || "anon"); } catch { return base; }
}
const withUser = (): Record<string, string> => {
  const h: Record<string, string> = {};
  if (currentToken()) h["Authorization"] = `Bearer ${currentToken()}`;
  else if (actAs) h["X-User"] = actAs;
  return h;
};
function setAuthSession(email: string, token: string): void {
  try {
    if (token) localStorage.setItem("simceo-token", token);
    else localStorage.removeItem("simceo-token");
    if (email) localStorage.setItem("simceo-user", email);
    else localStorage.removeItem("simceo-user");
  } catch {}
  try { window.dispatchEvent(new Event("simceo-auth-change")); } catch {}
}
function isPublicUrl(u: string): boolean {
  // Credential-free routes: stale bearers must never block re-authentication or public lookup.
  // /api/auth/me stays credential-carrying: it reports the CURRENT session and tolerates stale bearers server-side.
  return u.startsWith("/api/auth/login") || u.startsWith("/api/auth/register") || u.startsWith("/api/auth/status") || u.includes("/invites/") && u.endsWith("/public");
}
async function fetchAuth<T>(u: string, init: RequestInit, wantJson = true): Promise<T> {
  const myEpoch = epochNow();
  const myToken = currentToken();
  const myUser = currentUser();
  const r = await fetch(u, init);
  // Consume full body first, then recheck epoch/identity BEFORE callbacks/storage/download side effects.
  let text = "";
  try { text = await r.text(); } catch { text = ""; }
  if (epochNow() !== myEpoch || currentToken() !== myToken || currentUser() !== myUser) throw Object.assign(new Error("stale response discarded (identity changed)"), { stale: true });
  if (r.status === 401) {
    const latest = currentToken();
    if (latest && latest !== myToken) { const e = Object.assign(new Error("stale 401 discarded (signed in as another identity)"), { stale: true }); throw e; }
    // Anonymous (never-signed-in) 401s never raise the expired-session
    // banner; only a previously held session token expires the identity.
    if (latest === myToken && myToken) {
      // Current-session failure: let the app expire this identity (stop hub, purge
      // private state, gate rendering, navigate safe). Never auto-clear the token here.
      try { window.dispatchEvent(new CustomEvent("simceo-auth-failed", { detail: { epoch: myEpoch, token: myToken, user: myUser } })); } catch {}
    }
  }
  // CURRENT-expiry synchronous retirement: /auth/me 200 + authenticated:false with a
  // held nonempty token retires transport authority SYNCHRONOUSLY at receipt,
  // before any held blob/download continuation can run. The originating
  // epoch/token/user must still match CURRENT identity (protects fresh login
  // from a queued old result); empty-token anonymous never retires. The
  // dispatch is synchronous, so the purge (epoch bump + abort + revoke)
  // executes before continuations. Once-only dedupe is shared in the handler.
  if (r.ok && u.includes("/api/auth/me") && myToken) {
    try {
      const __parsed = text ? JSON.parse(text) : null;
      if (__parsed && (__parsed as { authenticated?: boolean }).authenticated === false) {
        if (epochNow() === myEpoch && currentToken() === myToken && currentUser() === myUser) {
          try { window.dispatchEvent(new CustomEvent("simceo-auth-failed", { detail: { epoch: myEpoch, token: myToken, user: myUser } })); } catch {}
        }
      }
    } catch {}
  }
  if (!r.ok) throw new Error(`${r.status} ${text}`);
  // HTTP 204 means deliberate no-content success (e.g. grant/invite delete);
  // accept it explicitly. Other empty bodies still fail closed for JSON calls.
  if (r.status === 204) return undefined as unknown as T;
  if (!wantJson) return undefined as unknown as T;
  if (!text) throw Object.assign(new Error("empty response discarded"), { stale: false });
  try { return JSON.parse(text) as T; } catch { throw new Error("malformed response discarded"); }
}
async function fetchPublic<T>(u: string, init: RequestInit): Promise<T> {
  const myEpoch = epochNow();
  const myToken = currentToken();
  const myUser = currentUser();
  const r = await fetch(u, init);
  let text = "";
  try { text = await r.text(); } catch { text = ""; }
  if (epochNow() !== myEpoch || currentToken() !== myToken || currentUser() !== myUser) throw Object.assign(new Error("stale response discarded (identity changed)"), { stale: true });
  if (!r.ok) throw new Error(`${r.status} ${text}`);
  if (!text) throw new Error("empty response discarded");
  try { return JSON.parse(text) as T; } catch { throw new Error("malformed response discarded"); }
}
const stripAuth = (h: Record<string, string>): Record<string, string> => {
  const c = { ...h };
  delete c["Authorization"]; delete c["X-User"];
  return c;
};
const get = <T,>(u: string): Promise<T> =>
  fetchAuth<T>(u, { headers: isPublicUrl(u) ? stripAuth(withUser()) : withUser() });
const post = <T,>(u: string, b: unknown): Promise<T> =>
  fetchAuth<T>(u, { method: "POST", headers: { "Content-Type": "application/json", ...withUser() }, body: JSON.stringify(b ?? {}) });
const patch = <T,>(u: string, b: unknown): Promise<T> =>
  fetchAuth<T>(u, { method: "PATCH", headers: { "Content-Type": "application/json", ...withUser() }, body: JSON.stringify(b ?? {}) });
const postPublic = <T,>(u: string, b: unknown): Promise<T> =>
  fetchPublic<T>(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b ?? {}) });
const getPublic = <T,>(u: string): Promise<T> =>
  fetchPublic<T>(u, {});
const upload = <T,>(u: string, f: FormData): Promise<T> =>
  fetchAuth<T>(u, { method: "POST", headers: withUser(), body: f });
const put = <T,>(u: string, b: unknown): Promise<T> =>
  fetchAuth<T>(u, { method: "PUT", headers: { "Content-Type": "application/json", ...withUser() }, body: JSON.stringify(b ?? {}) });
const del = <T,>(u: string): Promise<T> =>
  fetchAuth<T>(u, { method: "DELETE", headers: withUser() });
// Blob identity follows the bytes: the originating epoch/token/user travel
// with the object URL so every consumer (click, render) rechecks them
// instead of trusting fetch-time identity.
const authedBlobUrl = async (u: string): Promise<{ url: string; epoch: number; token: string; user: string }> => {
  const myEpoch = epochNow();
  const myToken = currentToken();
  const myUser = currentUser();
  const ctrl = new AbortController();
  try { (window as unknown as { __simceoAbort?: AbortController }).__simceoAbort = ctrl;
    try { var arr = (((window as unknown as { __simceoAborts?: AbortController[] }).__simceoAborts) ?? []); arr.push(ctrl); (window as unknown as { __simceoAborts?: AbortController[] }).__simceoAborts = arr; } catch {} } catch {}
  const r = await fetch(u, { headers: withUser(), signal: ctrl.signal });
  // Blob transport joins the central 401 transition: an expired or revoked
  // session expires the app identity instead of failing silently.
  if (r.status === 401) {
    try {
      const latest = currentToken();
      // Empty-token anonymous never enters the expired-session purge; only a
      // held nonempty token whose originating epoch/user still match CURRENT
      // identity expires. Once-only dedupe is shared in the handler.
      if (myToken && latest === myToken && epochNow() === myEpoch && currentUser() === myUser) window.dispatchEvent(new CustomEvent("simceo-auth-failed", { detail: { epoch: myEpoch, token: myToken, user: myUser } }));
    } catch {}
  }
  const buf = await r.arrayBuffer();
  if (epochNow() !== myEpoch || currentToken() !== myToken || currentUser() !== myUser) throw Object.assign(new Error("stale blob discarded"), { stale: true });
  if (!r.ok) { let tx = ""; try { tx = new TextDecoder().decode(buf); } catch {} throw new Error(`${r.status} ${tx}`); }
  const b = new Blob([buf]);
  const url = URL.createObjectURL(b);
  // Track for late revocation even if unmounted.
  try { (window as unknown as { __simceoBlobs?: string[] }).__simceoBlobs = [...(((window as unknown as { __simceoBlobs?: string[] }).__simceoBlobs) ?? []), url]; setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 60000); } catch {}
  return { url, epoch: myEpoch, token: myToken, user: myUser };
};
// Identity triple uses the raw stored values (token + simceo-user), never the
// canonical display label: comparing canonicalUser() ("owner" fallback) against
// currentUser() ("") made every logged-out blob look stale, so portraits never
// loaded in demo mode. Raw-to-raw keeps the guard exact in all modes.
const blobStale = (b: { epoch: number; token: string; user: string }) =>
  epochNow() !== b.epoch || currentToken() !== b.token || currentUser() !== b.user;
const authedDownload = async (u: string, filename: string, isLive?: () => boolean): Promise<void> => {
  const b = await authedBlobUrl(u);
  // Re-verify the originating identity AT click time: an account switch
  // between fetch and click revokes the URL instead of downloading it.
  if (blobStale(b)) { try { URL.revokeObjectURL(b.url); } catch {} throw Object.assign(new Error("stale download discarded (identity changed)"), { stale: true }); }
  // Optional narrow view/visit predicate (record export): re-checked after the fetch and BEFORE the download click side effect; revokes instead of clicking.
  if (isLive) { let ok = false; try { ok = !!isLive(); } catch { ok = false; } if (!ok) { try { URL.revokeObjectURL(b.url); } catch {} throw Object.assign(new Error("stale download discarded (view changed)"), { stale: true }); } }
  try {
    const a = document.createElement("a");
    a.href = b.url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  } finally { setTimeout(() => URL.revokeObjectURL(b.url), 10000); }
};
// Shared applied transport (demo identity + Bearer + auth epoch) passed to
// the Wiki connector UI; every Wiki call carries the same applied identity
// as the rest of the app (no window-global substitute).
const wikiApi = { get, post, patch, del, put, upload };
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
function isDenied(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("403");
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
          const ctext = ctextPicked ? ctextPicked : "(details unavailable)";
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
function AuthPanel() {
  const qcPanel = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const status = useQuery({ queryKey: ["auth-status"], queryFn: () => getPublic<{ authRequired: boolean; hasAccounts: boolean; accountCount: number; admin: string }>("/api/auth/status") });
  const meQ = useQuery({ queryKey: ["me"], queryFn: () => get<{ user: string; authenticated: boolean }>("/api/auth/me") });
  type MineRow = { id: string; boardId: string; meetingId: string; userKey: string; active?: boolean; canRejoin?: boolean; meetingTitle?: string; boardName?: string; inviteId?: string };
  const mine = useQuery({ queryKey: ["my-memberships"], queryFn: () => get<MineRow[]>("/api/me/memberships"), enabled: !!meQ.data?.authenticated });
  const [rejoinBusy, setRejoinBusy] = useState("");
  const rejoinOpRef = useRef(0);
  const rejoin = async (m: MineRow) => {
    // Per-rejoin operation claim: a newer rejoin retires this callback.
    // Origin identity for THIS rejoin: the selected row plus the requesting
    // account. A changed account retires this callback: it must never
    // announce success for another identity.
    const __reOp = (rejoinOpRef.current += 1);
    const __reEpoch = epochNow(); const __reToken = currentToken(); const __reUser = currentUser();
    const __reAlive = (): boolean => rejoinOpRef.current === __reOp && epochNow() === __reEpoch && currentToken() === __reToken && currentUser() === __reUser;
    const __selBoard = String(m.boardId); const __selMeet = String(m.meetingId); const __selUser = String(m.userKey);
    setMsg("");
    setRejoinBusy(m.meetingId);
    try {
      // Scoped invite hint: accept first so /join sees the fresh grant.
      if ((m as MineRow).inviteId) {
        try { await post<unknown>(`/api/invites/${(m as MineRow).inviteId}/accept`, {}); } catch (e) {
          const s = String(e);
          if (!s.includes("not pending") && !s.includes("already") && !s.includes("accepted")) throw e;
        }
      }
      if (!__reAlive()) return;
      // Typed /join capture: the returned Membership DTO (Id/BoardId/MeetingId/
      // UserKey/Active per Domain.Entities Membership) binds THIS result. Accept
      // either casing; Active must be an explicit boolean true below.
      const __joined = await post<Record<string, unknown>>(`/api/meetings/${m.meetingId}/join`, {});
      if (!__reAlive()) return;
      const __jId = String((__joined as Record<string, unknown>)["id"] ?? (__joined as Record<string, unknown>)["Id"] ?? "");
      const __jBoard = String((__joined as Record<string, unknown>)["boardId"] ?? (__joined as Record<string, unknown>)["BoardId"] ?? "");
      const __jMeet = String((__joined as Record<string, unknown>)["meetingId"] ?? (__joined as Record<string, unknown>)["MeetingId"] ?? "");
      const __jUser = String((__joined as Record<string, unknown>)["userKey"] ?? (__joined as Record<string, unknown>)["UserKey"] ?? "");
      const __jActive = ((__joined as Record<string, unknown>)["active"] ?? (__joined as Record<string, unknown>)["Active"]);
      // The /join result must resolve to THIS selection: exact board + meeting
      // + user with active === true and a returned membership id. A restore of
      // the meeting onto another board (or another user) resolves elsewhere
      // and must fail here, never claim the selected row rejoined.
      if (!__jId || __jBoard !== __selBoard || __jMeet !== __selMeet || __jUser.toLowerCase() !== __selUser.toLowerCase()) throw new Error("Rejoin verification failed: join resolved a different board/meeting/user.");
      if (__jActive !== true) throw new Error("Rejoin verification failed: join did not activate membership.");
      // Fresh readback verification: the readback row must EXACTLY match the
      // returned membership (id + board + meeting + user) with active === true.
      // Missing active never counts (strict true only). Readback errors, empty
      // lists, or a row for another board/meeting/user never announce success.
      let __fresh: MineRow[] = [];
      try {
        __fresh = await get<MineRow[]>(`/api/me/memberships`);
      } catch (e) {
        throw new Error("Rejoin verification failed: membership readback failed.");
      }
      if (!__reAlive()) return;
      const __ok = (__fresh ?? []).some((r) => String((r as MineRow).id ?? (r as unknown as Record<string, unknown>)["Id"] ?? "") === __jId && String((r as MineRow).boardId) === __selBoard && String((r as MineRow).meetingId) === __selMeet && String((r as MineRow).userKey ?? "").toLowerCase() === __selUser.toLowerCase() && (r as MineRow).active === true);
      if (!__ok) throw new Error("Rejoin verification failed: no active membership for this board/meeting/user.");
      // Identity + operation guard: a changed account or a newer rejoin
      // retires this callback instead of announcing a stale success.
      if (!__reAlive()) return;
      try { await qcPanel.refetchQueries({ queryKey: ["my-memberships"] }); } catch {}
      if (!__reAlive()) return;
      try { qcPanel.invalidateQueries({ queryKey: ["meetings"] }); } catch {}
      try { qcPanel.invalidateQueries({ queryKey: ["messages", m.meetingId] }); } catch {}
      setMsg("Rejoined meeting.");
    } catch (e) { if (!__reAlive()) return; setMsg(String(e)); }
    finally { if (rejoinOpRef.current === __reOp) setRejoinBusy(""); }
  };
  const doRegister = async () => {
    setMsg("");
    try {
      const r = await postPublic<{ email: string; token: string }>("/api/auth/register", { email, password });
      setAuthSession(r.email, r.token);
      setMsg("Registered and signed in as " + r.email);
    } catch (e) { setMsg(String(e)); }
  };
  const doLogin = async () => {
    setMsg("");
    try {
      const r = await postPublic<{ email: string; token: string }>("/api/auth/login", { email, password });
      setAuthSession(r.email, r.token);
      setMsg("Signed in as " + r.email);
    } catch (e) { setMsg(String(e)); }
  };
  const doLogout = async () => {
    const myEpoch = epochNow(); const myToken = currentToken(); const myUser = currentUser();
    try { await post<unknown>("/api/auth/logout", {}); } catch (e) { if ((e as Error & { stale?: boolean })?.stale) return; }
    if (epochNow() !== myEpoch || currentToken() !== myToken || currentUser() !== myUser) return;
    try { (window as unknown as { __simceoAbort?: AbortController }).__simceoAbort?.abort(); } catch {}
    try { for (const u of ((window as unknown as { __simceoBlobs?: string[] }).__simceoBlobs ?? [])) { try { URL.revokeObjectURL(u); } catch {} } } catch {}
    try { window.dispatchEvent(new CustomEvent("simceo-hub-stop")); } catch {}
    setAuthSession("", "");
    try { window.location.hash = "#/boards"; } catch {}
    setMsg("Signed out.");
  };
  const leave = async (mid: string) => {
    try {
      await post<unknown>(`/api/meetings/${mid}/leave`, {});
      try { qcPanel.invalidateQueries({ queryKey: ["messages", mid] }); } catch {}
      try { qcPanel.invalidateQueries({ queryKey: ["delivery", mid] }); } catch {}
      try { qcPanel.invalidateQueries({ queryKey: ["my-memberships"] }); } catch {}
      try { qcPanel.invalidateQueries({ queryKey: ["meetings"] }); } catch {}
      try { qcPanel.removeQueries({ queryKey: ["messages", mid] }); } catch {}
      try { window.dispatchEvent(new CustomEvent("simceo-meeting-left", { detail: { mid } })); } catch {}
      try { const h = window.location.hash; if (h.includes(mid)) window.location.hash = "#/boards"; } catch {}
      setMsg("Left meeting.");
    } catch (e) { setMsg(String(e)); }
  };
  return (
    <div className="card">
      <h3>Accounts</h3>
      <p role="status">
        {status.data ? (status.data.authRequired ? `Secure mode � admin ${status.data.admin || "(migrating)"} � ${status.data.accountCount} account(s)` : "Local demo (no accounts yet)") : "�"}
        {meQ.data ? ` � ${meQ.data.user}${meQ.data.authenticated ? " � signed in" : " � demo identity"}` : ""}
      </p>
      <div className="row">
        <label>Email <input aria-label="Account email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></label>
        <label>Password (12+ chars) <input aria-label="Account password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      </div>
      <div className="row">
        <button type="button" onClick={doRegister}>Register</button>
        <button type="button" onClick={doLogin}>Sign in</button>
        <button type="button" onClick={doLogout}>Sign out</button>
      </div>
      {msg && <p role="status">{msg}</p>}
      {(mine.data ?? []).length > 0 && (
        <div>
          <h4>My meetings</h4>
          {(mine.data ?? []).map((m) => {
            const mm = m as MineRow;
            const nm = (mm.meetingTitle && mm.meetingTitle.trim()) ? mm.meetingTitle : "An assigned meeting";
            const sub = (mm.boardName && mm.boardName.trim()) ? ` (${mm.boardName})` : "";
            const isActive = mm.active !== false;
            const canRejoin = !!mm.canRejoin && !isActive;
            return (
              <div key={mm.id} className="row"><span>{nm}{sub}{isActive ? "" : " (left)"}</span><button type="button" onClick={() => { try { window.location.hash = buildHash({ tab: "meet", board: mm.boardId, meeting: mm.meetingId, mtab: "chat", ctab: "context", rec: "" }); } catch {} }}>Open</button>{isActive ? (<button type="button" onClick={() => leave(mm.meetingId)}>Leave</button>) : null}{canRejoin ? (<button type="button" disabled={rejoinBusy === mm.meetingId} onClick={() => rejoin(mm)}>{rejoinBusy === mm.meetingId ? "Joining..." : "Join again"}</button>) : null}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}
function AuthedImg({ id, alt, className }: { id: string; alt: string; className?: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let live = true;
    let fresh = true;
    let obj = "";
    authedBlobUrl(`/api/images/${id}`).then((b) => { if (live && fresh && !blobStale(b)) { obj = b.url; setUrl(b.url); } }).catch(() => { if (live) setUrl(""); });
    return () => { live = false; fresh = false; if (obj) URL.revokeObjectURL(obj); };
  }, [id]);
  if (!url) return <span className="muted">loading portrait�</span>;
  return <img src={url} alt={alt} className={className} />;
}
// Presence portraits via authorized advisors DTO displayPortraitImageId
// (server RosterDisplayOps.ResolveDisplayPortrait, same authority as reviewed identity).
// Loads exact bytes through the existing authorized image path (authed blob URLs),
// identity-scoped with unmount cleanup. Reject or revoke (even with an unchanged
// selection id) clears the blob and falls back to initials: the caller bumps
// rev on every review or selection change and rev is part of the resolution key,
// and the auth epoch is in the key so a demo Apply-identity still re-resolves.
// Invalid ids never load; wrong-identity bytes are impossible because the server
// already scoped the id to the advisor roster entry.
// Freshness: focus, visibility, and advisor refresh re-query the authoritative
// advisors DTO for the computed display id before loading bytes. Bytes alone
// cannot prove freshness because an owner-readable image endpoint may still
// serve a rejected image; the DTO review gate is the authority.
function useDisplayPortraits(boardId: string, entries: { key: string; displayImageId: string | null | undefined }[], rev: number, queryTick: number = 0): Map<string, string> {
  const [urls, setUrls] = useState<Map<string, string>>(() => new Map());
  const ownedRef = useRef<string[]>([]);
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    let dead = false;
    const bump = () => { if (!dead) setFocusTick((v) => v + 1); };
    const onVis = () => { try { if (!document.hidden) bump(); } catch {} };
    try { window.addEventListener("focus", bump); } catch {}
    try { document.addEventListener("visibilitychange", onVis); } catch {}
    return () => {
      dead = true;
      try { window.removeEventListener("focus", bump); } catch {}
      try { document.removeEventListener("visibilitychange", onVis); } catch {}
    };
  }, []);
  const key = currentToken() + "\n" + currentUser() + "\n" + String(epochNow()) + "\n" + String(boardId ?? "") + "\n" + String(rev) + "\n" + String(queryTick) + "\n" + String(focusTick) + "\n" + entries.map((e) => e.key + "=" + (normalizeDisplayImageId(e.displayImageId) ?? "")).join("|");
  useEffect(() => {
    let live = true;
    const myEpoch = epochNow();
    const myToken = currentToken();
    const myUser = currentUser();
    // Immediate clear: revoke owned blobs and fall back to initials while
    // re-resolving, so a revoke/auth change never leaves a stale portrait up.
    for (const u of ownedRef.current) { try { URL.revokeObjectURL(u); } catch { /* noop */ } }
    ownedRef.current = [];
    setUrls(new Map());
    const retired = () => !live || epochNow() !== myEpoch || currentToken() !== myToken || currentUser() !== myUser;
    const made: string[] = [];
    (async () => {
      const next = new Map<string, string>();
      // Fail-closed freshness: require a successful fresh array DTO for this
      // board. On failed, malformed, omitted, or null metadata keep initials;
      // never rescue with cached metadata, since owner-readable bytes may
      // still serve a rejected or removed image.
      if (!live || retired()) return;
      let freshList: any[] | null = null;
      try {
        if (!boardId) return;
        const fresh = await get<any[]>(`/api/boards/${boardId}/advisors`);
        if (!live || retired()) return;
        if (!Array.isArray(fresh)) return;
        freshList = fresh;
      } catch {
        return;
      }
      if (!live || retired() || freshList === null) return;
      const freshByKey = new Map<string, string | null>();
      for (const a of freshList) {
        const fid = String((a as any)?.id ?? (a as any)?.Id ?? "");
        if (!fid) continue;
        const dispRaw = (a as any)?.displayPortraitImageId ?? (a as any)?.DisplayPortraitImageId ?? null;
        freshByKey.set(fid, dispRaw ? String(dispRaw) : null);
      }
      if (!live || retired()) return;
      for (const e of entries) {
        if (!live) return;
        try {
          // Require a matching current advisor key and valid display id from
          // the successful fresh DTO; omitted or null stays fallback.
          if (!freshByKey.has(e.key)) continue;
          const raw = freshByKey.get(e.key);
          const id = normalizeDisplayImageId(raw ?? null);
          if (!id) continue;
          if (retired()) return;
          const b = await authedBlobUrl("/api/images/" + id);
          if (!live || blobStale(b)) { try { URL.revokeObjectURL(b.url); } catch { /* noop */ } continue; }
          if (retired()) { try { URL.revokeObjectURL(b.url); } catch { /* noop */ } return; }
          made.push(b.url);
          next.set(e.key, b.url);
        } catch { /* unaccepted/absent portrait: fallback avatar stays */ }
      }
      if (retired()) { for (const u of made) { try { URL.revokeObjectURL(u); } catch { /* noop */ } } return; }
      ownedRef.current = made.slice();
      setUrls(next);
    })();
    // Intentionally keyed on the derived string: identity, epoch, board,
    // review generation, advisor refresh, focus, and display id changes all
    // re-resolve from authorized DTO metadata.
    return () => { live = false; };
  }, [key]);
  useEffect(() => () => { for (const u of ownedRef.current) { try { URL.revokeObjectURL(u); } catch { /* noop */ } } ownedRef.current = []; }, []);
  return urls;
}
function InviteClaim() {
  const qcInvite = useQueryClient();
  const [inviteId, setInviteId] = useState(() => {
    try {
      const h = window.location.hash;
      const hm = h.match(/invite=([0-9a-f-]{36})/i);
      if (hm) { try { sessionStorage.setItem("simceo-pending-invite", hm[1]); } catch {} return hm[1]; }
      const sq = new URLSearchParams(window.location.search);
      const sqv = sq.get("invite") ?? "";
      if (sqv) { try { sessionStorage.setItem("simceo-pending-invite", sqv); } catch {} return sqv; }
      try { return sessionStorage.getItem("simceo-pending-invite") ?? ""; } catch { return ""; }
    } catch { return ""; }
  });
  const [msg, setMsg] = useState("");
  const [opened, setOpened] = useState<{ board: string; meeting: string | null } | null>(null);
  useEffect(() => { try { if (inviteId) sessionStorage.setItem("simceo-pending-invite", inviteId); } catch {} }, [inviteId]);
  useEffect(() => {
    try {
      const onHash = () => { try { const h = window.location.hash; const m = h.match(/invite=([0-9a-f-]{36})/i); if (m && m[1] !== inviteId) { setInviteId(m[1]); try { sessionStorage.setItem("simceo-pending-invite", m[1]); } catch {} } } catch {} };
      window.addEventListener("hashchange", onHash);
      return () => window.removeEventListener("hashchange", onHash);
    } catch { return; }
  }, [inviteId]);
  const pub = useQuery({
    queryKey: ["invite-public", inviteId],
    queryFn: () => getPublic<{ id: string; boardId: string; meetingId: string | null; state: string; boardName: string; meetingTitle: string }>(`/api/invites/${inviteId}/public`),
    enabled: !!inviteId,
    retry: false,
  });
  const accept = async () => {
    setMsg("");
    setOpened(null);
    try {
      // Lookup must complete before accept so binding uses the current board/meeting.
      let info = pub.data;
      if (!info) {
        try { const rr = await pub.refetch(); info = rr.data ?? undefined; } catch {}
      }
      if (!info) { setMsg("Invite lookup failed; check the ID and try again."); return; }
      const r = await post<{ meetingId: string | null }>(`/api/invites/${inviteId}/accept`, {});
      const bid = info.boardId ?? "";
      if (r.meetingId) {
        try { await post<unknown>(`/api/meetings/${r.meetingId}/join`, {}); }
        catch (je) { setMsg("Invite accepted but join failed: " + String(je)); return; }
      }
      try { qcInvite.invalidateQueries({ queryKey: ["boards"] }); } catch {}
      try { qcInvite.invalidateQueries({ queryKey: ["meetings"] }); } catch {}
      try { qcInvite.invalidateQueries({ queryKey: ["my-memberships"] }); } catch {}
      try { qcInvite.invalidateQueries({ queryKey: ["invite-public"] }); } catch {}
      try { sessionStorage.removeItem("simceo-pending-invite"); } catch {}
      setOpened({ board: bid, meeting: r.meetingId });
      setMsg("Invite accepted" + (r.meetingId ? " for meeting " + r.meetingId : "") + ".");
    } catch (e) { setMsg(String(e)); }
  };
  return (
    <div className="card">
      <h3>Guest invite</h3>
      <label>Invite ID <input aria-label="Invite ID" value={inviteId} onChange={(e) => { const v = e.target.value.trim(); setInviteId(v); try { if (v) sessionStorage.setItem("simceo-pending-invite", v); else sessionStorage.removeItem("simceo-pending-invite"); } catch {} }} placeholder="paste invite id" /></label>
      <div className="row"><button type="button" onClick={accept} disabled={!inviteId || pub.isPending || pub.isFetching}>Accept invite</button></div>
      {pub.data && <p role="status">Board: {pub.data.boardName} Meeting: {pub.data.meetingTitle} {pub.data.state}</p>}
      {msg && <p role="status">{msg}</p>}
      {opened && opened.meeting && <div className="row"><button type="button" onClick={() => { try { window.location.hash = buildHash({ tab: "meet", board: opened.board, meeting: opened.meeting ?? "", mtab: "chat", ctab: "context", rec: "" }); } catch {} }}>Open meeting</button></div>}
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
      setUsageMeeting("");
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
  // Effective draft identity: Bearer session user wins; otherwise the actually
  // applied demo label (module transport), else the default owner. Unapplied
  // input never defines identity. Each identity keeps its own intact draft.
  const effectiveDraftUser = (() => { try { return canonicalUser(); } catch { return "owner"; } })();
  const draftKey = `simceo-draft:${boardId}:${meetingId}:${effectiveDraftUser}`;
  const legacyDraftKey = `simceo-draft:${boardId}:${meetingId}:${(() => { try { return localStorage.getItem("simceo-user") ?? "anon"; } catch { return "anon"; } })()}`;
  const readDraft = (k: string): string => {
    try { return localStorage.getItem(k) ?? ""; } catch { return ""; }
  };
  // SAFE legacy compatibility: the default demo owner (no applied label, no
  // Bearer) may adopt the pre-existing legacy "anon" draft once. Applied A/B
  // identities never read anon/other-user drafts. Legacy bytes are kept
  // (never deleted) and no token is stored in draft keys.
  const readDraftWithLegacy = (k: string): string => {
    try {
      // PRESENT-but-empty ("") is a real cleared draft and must never fall
      // back to legacy anon bytes. Only a MISSING key (null) may adopt.
      const raw = localStorage.getItem(k);
      if (raw !== null) return raw;
      try { if (localStorage.getItem("simceo-token")) return ""; } catch {}
      let applied = "";
      try { applied = (typeof actAs === "string" ? actAs : "").trim(); } catch { applied = ""; }
      if (applied) return "";
      if (effectiveDraftUser !== "owner") return "";
      if (k === legacyDraftKey) return "";
      try { return localStorage.getItem(legacyDraftKey) ?? ""; } catch { return ""; }
    } catch { return ""; }
  };
  const [draft, setDraftState] = useState(() => readDraftWithLegacy(draftKey));
  // Last persisted/loaded snapshot. The save effect intentionally depends on
  // [draft] only: on a key change (board/meeting/account switch, late board
  // hydration after reload) the load effect below adopts the stored text for
  // the new key, and no save runs with the previous key's stale closure, so a
  // full reload under StrictMode can never clobber the stored draft with "".
  const draftSavedRef = useRef<{ key: string; text: string } | null>(null);
  const setDraft = (v: string | ((prev: string) => string)) =>
    setDraftState((prev) =>
      typeof v === "function" ? (v as (prev: string) => string)(prev) : v,
    );
  useEffect(() => {
    const stored = readDraftWithLegacy(draftKey);
    draftSavedRef.current = { key: draftKey, text: stored };
    setDraftState(stored);
  }, [draftKey]);
  useEffect(() => {
    const last = draftSavedRef.current;
    if (last !== null && last.key === draftKey && last.text === draft) return;
    draftSavedRef.current = { key: draftKey, text: draft };
    try {
      localStorage.setItem(draftKey, draft);
    } catch {
      /* private-mode: keep draft in memory only */
    }
  }, [draft]);
  const [policy, setPolicy] = useState("balanced");
  const { open: settingsOpen, openSettings, closeSettings } = useConversationSettings(false);
  // Meeting settings are bound to the meeting they were opened for: a
  // meeting change (including browser-back navigation while the modal is
  // open) closes the dialog and resets the participant draft, so a draft
  // from A can never be saved onto B.
  const settingsMeetingRef = useRef("");
  const closeMeetingSettings = () => {
    setMeetPartKey("");
    closeSettings();
  };
  useEffect(() => {
    if (!settingsOpen) { settingsMeetingRef.current = ""; return; }
    if (settingsMeetingRef.current === "") { settingsMeetingRef.current = meetingId; return; }
    if (settingsMeetingRef.current !== meetingId) closeMeetingSettings();
  }, [settingsOpen, meetingId]);
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
      commPrefs: DEFAULT_COMM_PREFS,
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
  const [actAsState, setActAsState] = useState(() => { try { return typeof actAs === "string" ? actAs : ""; } catch { return ""; } });
  // Applied demo identity: the value actually sent as X-User by every app
  // request, updated ONLY through "Apply identity". The draft input above
  // stays editable without affecting traffic until applied.
  // Initialized from the module transport so a remount keeps the same applied identity.
  const [appliedActAs, setAppliedActAs] = useState(() => { try { return typeof actAs === "string" ? actAs : ""; } catch { return ""; } });
  const [mq, setMq] = useState("");
  // Meeting selector starts collapsed on narrow viewports so the toolbar,
  // first messages, and composer are visible on load; desktop starts open.
  // One collection only: filters + agenda nav stay inside, expandable.
  const [meetNavOpen, setMeetNavOpen] = useState<boolean>(() => {
    try { return !window.matchMedia("(max-width: 820px)").matches; } catch { return true; }
  });
  const [mstate, setMstate] = useState("");
  const [uday, setUday] = useState("");
  const [ufrom, setUfrom] = useState("");
  const [uto, setUto] = useState("");
  const [usageScope, setUsageScope] = useState("installation");
  const [usageMeeting, setUsageMeeting] = useState("");
  const [usagePurpose, setUsagePurpose] = useState("");
  const authStatusQ = useQuery({ queryKey: ["auth-status"], queryFn: () => getPublic<{ authRequired: boolean; hasAccounts: boolean; accountCount: number; admin: string }>("/api/auth/status") });
  const anonPrivateBlocked = !currentToken() && authStatusQ.data?.authRequired !== false;
  const sessQ = useQuery({ queryKey: ["sess"], queryFn: async () => {
    // No global request-origin store: the synchronous 200-false retirement in
    // fetchAuth carries the originating epoch/token/user bound to THAT result.
    // A passive fallback keyed off the latest request origin is removed so a
    // queued old result can never purge a fresh identity.
    return get<{ user: string; authenticated: boolean }>(`/api/auth/me`);
  }, retry: false, refetchInterval: 30000 });
  const [sessExpiredFlag, setSessExpiredFlag] = useState(false);
  useEffect(() => { try { if (sessQ.data && sessQ.data.authenticated) setSessExpiredFlag(false); } catch {} }, [sessQ.data]);
  const sessExpired = sessExpiredFlag || (() => { try { return !!currentToken() && !!sessQ.data && !sessQ.data.authenticated; } catch { return false; } })();
  // Protected queries and private rendering must not start before the session
  // is verified: a stored token with no /auth/me answer yet gates everything.
  const sessPending = (() => { try { return !!currentToken() && sessQ.data === undefined; } catch { return false; } })();
  const sessGate = sessExpired || sessPending;
  // Fail-closed private rendering: while the session is expired or still
  // unverified, no private names, missions, or cached content render — only
  // the re-authentication surface and public invite lookup stay visible.
  const privateHidden = sessGate;
  // Selected-board authority is the singular detail lookup, never the
  // bounded (newest-100) board list. A 404 clears the route; absence from
  // the list window means nothing. Non-404 errors gate without clearing.
  // Board discovery scope: the default active list hides archived boards, so
  // archived boards are undiscoverable without an explicit archived view.
  const [boardScope, setBoardScope] = useState<"active" | "archived" | "all">("active");
  const boards = useQuery({
    queryKey: ["boards", boardScope],
    queryFn: () => get<Board[]>("/api/boards?includeArchived=true"),
    enabled: !sessGate && !anonPrivateBlocked,
  });
  // Profile operation revision: retired synchronously by every private-state
  // purge (expiry, revocation, leave) BEFORE any held save/reload callback can
  // resolve, so stale completions can never repopulate cleared state.
  const profileOpRef = useRef(0);
  // Once-only dedupe for CURRENT-expiry purges (shared by 401 and 200-false):
  // key is the stable nonempty session TOKEN (opaque unique session id,
  // independent of purge epoch and demo display user), retained across
  // purges/polls so the same expired token purges once. A new successful
  // login issues a new token, naturally distinct. Anonymous (no token) and
  // fresh-login (authenticated or identity-changed) never purge.
  const lastExpiredPurgeRef = useRef("");
  // Central private-state purge: stop hub/media, drop ALL private caches and
  // selections, navigate to a safe view. Used by expiry, revocation, and leave.
  const purgePrivate = (why: string) => {
    try { (window as unknown as { __simceoEpoch?: number }).__simceoEpoch = (((window as unknown as { __simceoEpoch?: number }).__simceoEpoch) ?? 0) + 1; } catch {}
    try { window.dispatchEvent(new CustomEvent("simceo-hub-stop")); } catch {}
    try { try { for (const c of (((window as unknown as { __simceoAborts?: AbortController[] }).__simceoAborts) ?? [])) { try { c.abort(); } catch {} } } catch {}
    try { (window as unknown as { __simceoAborts?: AbortController[] }).__simceoAborts = []; } catch {}
    try { (window as unknown as { __simceoAbort?: AbortController }).__simceoAbort = undefined; } catch {}
    profileOpRef.current++; } catch {}
    try { setProfileReloading(false); } catch {}
    try { (window as unknown as { __simceoAbort?: AbortController }).__simceoAbort?.abort(); } catch {}
    try { for (const u of ((window as unknown as { __simceoBlobs?: string[] }).__simceoBlobs ?? [])) { try { URL.revokeObjectURL(u); } catch {} } } catch {}
    try { (window as unknown as { __simceoBlobs?: string[] }).__simceoBlobs = []; } catch {}
    try { cancelActiveVoiceOp(true); } catch {}
    try { recRef.current = null; } catch {}
    try {
      // Every private cache family: boards, meetings, messages, delivery,
      // records, setup/lead, sources, notes, directions, roster/advisors,
      // portraits, people, jobs/usage/audit/spending, review state, caps.
      // Public presets/commands/invite-public are intentionally retained.
      for (const k of ["messages", "delivery", "meeting-detail", "board-detail", "boards",
        "meetings", "records", "record", "record-review", "setup", "guest-settings", "lead", "profile",
        "sources", "notes", "notes-history", "directions", "roster", "roster-count", "roster-names", "roster-images",
        "images", "advisors", "invites", "grants", "jobs", "usage", "audit", "spending",
        "modelcalls", "status", "model-status", "caps", "voice", "wizreview", "meeting-views", "briefings", "briefing", "me"]) {
        try { qc.removeQueries({ queryKey: [k] }); } catch {}
      }
      qc.invalidateQueries({ queryKey: ["my-memberships"] });
      qc.invalidateQueries({ queryKey: ["sess"] });
    } catch {}
    // Secretary continuations join the central transition: bump the epoch so
    // in-flight submissions resolve stale, and drop the pending marker whose
    // origin identity no longer holds. Per-user drafts in localStorage are
    // preserved for re-authentication under the same identity key.
    try { secEpoch.current++; } catch {}
    try { retirePipeline(submitOpRef.current); } catch {}
    try { secPendingRef.current = null; } catch {}
    try { secHydRef.current++; } catch {}
    try { secEnvelopeRev.current++; } catch {}
    try { resetMeetingOwnedState(); } catch {}
    try { resetBoardOwnedState(); } catch {}
    try { setMeetingId(""); } catch {}
    try { window.location.hash = "#/boards"; } catch {}
    try { setLive(false); } catch {}
  };
  // No passive sessQ.data fallback: every 200-false retires synchronously at
  // receipt inside fetchAuth with the originating epoch/token/user bound to
  // THAT result. A data-effect fallback keyed off cached data or the latest
  // request origin is removed so it can neither reset dedupe nor re-dispatch.
  useEffect(() => {
    const onAuthFailed = (e: Event) => {
      try {
        const d = (e as CustomEvent<{ epoch: number; token: string; user: string }>).detail;
        if (!d || !d.token) return; // empty-token anonymous never purges
        // Fresh-login / stale protection: originating epoch/token/user must
        // still match CURRENT identity at receipt time.
        if (epochNow() !== d.epoch || currentToken() !== d.token || currentUser() !== d.user) return;
        // Once-only per expired session TOKEN, shared by 401 and 200-false
        // paths (both route through this event with originating detail).
        // The purge bumps the epoch but retains the token, so later polls for
        // the SAME expired token dedupe instead of purging again. Freshness
        // (origin epoch/token/user still current) is enforced above; only the
        // stable token forms the dedupe key.
        const key = d.token;
        try {
          const seen = (window as unknown as { __simceoExpiredPurgeKey?: string }).__simceoExpiredPurgeKey ?? lastExpiredPurgeRef.current;
          if (seen === key) return;
        } catch {}
        try { lastExpiredPurgeRef.current = key; } catch {}
        try { (window as unknown as { __simceoExpiredPurgeKey?: string }).__simceoExpiredPurgeKey = key; } catch {}
        setSessExpiredFlag(true);
        purgePrivate("expired");
      } catch {}
    };
    const onMeetingLeft = (e: Event) => {
      try {
        purgePrivate("left");
      } catch {}
    };
    // Identity reactivity: sign-in/out applies a new token without reloading.
    // Refresh verification + public capability immediately so private queries
    // enable (or gate) on the current identity instead of the 30s poll.
    const onAuthChange = () => {
      try { qc.invalidateQueries({ queryKey: ["sess"] }); } catch {}
      try { qc.invalidateQueries({ queryKey: ["auth-status"] }); } catch {}
      try { qc.invalidateQueries({ queryKey: ["me"] }); } catch {}
    };
    try {
      window.addEventListener("simceo-auth-failed", onAuthFailed);
      window.addEventListener("simceo-meeting-left", onMeetingLeft);
      window.addEventListener("simceo-auth-change", onAuthChange);
    } catch {}
    return () => {
      try { window.removeEventListener("simceo-auth-failed", onAuthFailed); } catch {}
      try { window.removeEventListener("simceo-meeting-left", onMeetingLeft); } catch {}
      try { window.removeEventListener("simceo-auth-change", onAuthChange); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc]);
  const boardDetail = useQuery({
    queryKey: ["board-detail", boardId],
    queryFn: () => get<Board>(`/api/boards/${boardId}`),
    enabled: !!boardId && !sessGate,
    retry: false,
  });
  // Bounded board list (newest 100) never establishes absence: only a 404
  // on the singular board lookup clears the route. Pending/non-404 errors
  // gate downstream queries without clearing.
  const boardMissing =
    !!boardId && boardDetail.isError && isNotFound(boardDetail.error);
  // A 403 on the singular lookup proves the current identity may not read
  // this board. The route is kept (unlike a 404) so the user can recover to
  // an allowed board; detail rendering goes fail-closed instead.
  const boardDenied =
    !!boardId && !!boardDetail.error && isDenied(boardDetail.error);
  const boardValid =
    boardId === "" ||
    (boardDetail.isSuccess && (boardDetail.data as Board | undefined)?.id === boardId);
  const boardOk = boardValid;
  // Exact scope rows from ACTUAL server data: the list is fetched with
  // includeArchived=true (the endpoint supports it), so the Archived/All
  // scopes filter the returned rows and additionally surface the
  // directly-opened selected board when it is archived and absent from the
  // list. Counts below always match the rows actually displayed.
  const boardDetailArchivedExtra = (() => {
    const sel = boardDetail.data as Board | undefined;
    if (!sel || !boardId || sel.id !== boardId || sel.archived !== true) return null;
    if ((boards.data ?? []).some((b) => b.id === boardId)) return null;
    return sel;
  })();
  const activeRows = (boards.data ?? []).filter((b) => (b as Board).archived !== true);
  const archivedRows = boardDetailArchivedExtra
    ? [...(boards.data ?? []).filter((b) => (b as Board).archived === true), boardDetailArchivedExtra]
    : (boards.data ?? []).filter((b) => (b as Board).archived === true);
  const allRows = boardDetailArchivedExtra ? [...(boards.data ?? []), boardDetailArchivedExtra] : (boards.data ?? []);
  const scopeRows = boardScope === "active" ? activeRows : boardScope === "archived" ? archivedRows : allRows;
  // Server-derived selected-scope capabilities govern every tab and action.
  // The legacy board-DTO guest flag never grants or hides by itself.
  const caps = useQuery({
    queryKey: ["caps", boardId, meetingId],
    queryFn: () =>
      get<{ board: string; meeting: string | null; meetings: string[]; guest: boolean; admin: boolean }>(
        `/api/boards/${boardId}/capabilities${meetingId ? `?meetingId=${meetingId}` : ""}`,
      ),
    enabled: !!boardId && !sessGate,
    retry: false,
  });
  const capBoard = (caps.data as { board?: string } | undefined)?.board ?? "none";
  const capMeeting = (caps.data as { meeting?: string | null } | undefined)?.meeting ?? null;
  const canManageBoard = capBoard === "manage";
  const canWriteBoard = canManageBoard || capBoard === "contribute";
  const canManageMeeting = canManageBoard || capMeeting === "manage";
  // Mutations on meeting scope (chat/run/briefing/notes/records/voice/upload):
  // board writers always qualify; otherwise the selected meeting grant must
  // confer contribute or manage. Discuss/read-only never mutates.
  const canActMeeting = canWriteBoard || capMeeting === "contribute" || capMeeting === "manage";
  // Discuss-only meeting guests may use the designated meeting composer
  // (discuss/send/rebid) plus read-only effective settings. Every other
  // mutation stays behind canActMeeting (contribute+) or manage gates.
  const canDiscussMeeting = canActMeeting || capMeeting === "discuss";
  // Effective usage scope: installation billing is privileged (installation
  // admin only). Board collaborators transparently fall back to board scope;
  // without a board the installation query stays disabled (never 403 noise).

  const capsAdmin = (caps.data as { admin?: boolean } | undefined)?.admin === true;
  const effUsageScope = capsAdmin ? usageScope : (usageScope === "installation" ? "board" : usageScope);
  const isGuest = (caps.data as { guest?: boolean } | undefined)?.guest === true;
  const presets = useQuery({
    queryKey: ["presets"],
    queryFn: () => get<Preset[]>("/api/presets"),
    enabled: tab === "wizard",
  });
  const advisors = useQuery({
    queryKey: ["advisors", boardId],
    queryFn: () => get<AdvisorFull[]>(`/api/boards/${boardId}/advisors`),
    enabled: !!boardId && boardOk && !sessGate,
  });
  const meetings = useQuery({
    queryKey: ["meetings", boardId, mq, mstate],
    queryFn: () =>
      get<MeetingFull[]>(
        `/api/boards/${boardId}/meetings?${new URLSearchParams({ ...(mq ? { q: mq } : {}), ...(mstate ? { state: mstate } : {}) })}`,
      ),
    enabled: !!boardId && boardOk && !sessGate && caps.isSuccess && !isGuest,
  });
  const allMeetings = useQuery({
    queryKey: ["meetings", boardId, "all"],
    queryFn: () => get<MeetingFull[]>(`/api/boards/${boardId}/meetings`),
    enabled: !!boardId && boardOk && !sessGate && caps.isSuccess && !isGuest,
  });
  // Selected-meeting authority is the scoped singular lookup, which also
  // verifies the parent board. Absence from capped lists never clears.
  const meetingDetail = useQuery({
    queryKey: ["meeting-detail", boardId, meetingId],
    queryFn: () =>
      get<MeetingFull>(`/api/boards/${boardId}/meetings/${meetingId}`),
    enabled: !!boardId && !!meetingId && boardValid && !sessGate,
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
  // A 403 on the scoped singular lookup proves the current identity may not
  // read this meeting. Keep the board route and recover to an allowed
  // meeting instead of rendering a broken empty view.
  const meetingDenied =
    !!meetingId &&
    !!boardId &&
    boardValid &&
    !meetingParentMismatch &&
    !!meetingDetail.error &&
    isDenied(meetingDetail.error);
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
    enabled: !!meetingId && meetingOk && !sessGate,
    refetchInterval: 4000,
  });
  const hubRef = useRef<HubConnection | null>(null);
  const [live, setLive] = useState(false);
  // Hub generation: bumped on every confirmed domain restore so the
  // connection effect below restarts even when board/meeting IDs are
  // unchanged (the restore stops the hub via simceo-hub-stop).
  const [hubRev, setHubRev] = useState(0);
  useEffect(() => {
    const bump = () => { try { setHubRev((v) => v + 1); } catch {} };
    try { window.addEventListener("simceo-domain-restored", bump); } catch {}
    return () => { try { window.removeEventListener("simceo-domain-restored", bump); } catch {} };
  }, []);
  useEffect(() => {
    const onStop = () => { try { hubRef.current?.stop(); } catch {} try { setLive(false); } catch {} };
    const onLeft = (e: Event) => { try { const mid = (e as CustomEvent<{ mid: string }>).detail?.mid; if (mid) { try { qc.removeQueries({ queryKey: ["messages", mid] }); } catch {} try { qc.invalidateQueries({ queryKey: ["my-memberships"] }); } catch {} } } catch {} onStop(); };
    try { window.addEventListener("simceo-hub-stop", onStop); window.addEventListener("simceo-meeting-left", onLeft); } catch {}
    return () => { try { window.removeEventListener("simceo-hub-stop", onStop); window.removeEventListener("simceo-meeting-left", onLeft); } catch {} };
  }, [qc]);
  useEffect(() => {
    if (!meetingId || !meetingOk) return;
    let cancelled = false;
    const conn = new HubConnectionBuilder()
      .withUrl("/hubs/board", { accessTokenFactory: () => currentToken() })
      .withAutomaticReconnect()
      .build();
    hubRef.current = conn;
    const onRevoked = (payload?: { boardId?: string; meetingId?: string }) => {
      try {
        const mid = (payload as { meetingId?: string } | undefined)?.meetingId ?? meetingId;
        const bid = (payload as { boardId?: string } | undefined)?.boardId ?? boardId;
        const affectsCurrent = (mid && mid === meetingId) || (bid && bid === boardId && !mid);
        if (affectsCurrent) {
          try { conn.stop(); } catch {}
          purgePrivate("revoked");
        } else {
          try { qc.invalidateQueries({ queryKey: ["messages", meetingId] }); } catch {}
          try { qc.invalidateQueries({ queryKey: ["delivery", meetingId] }); } catch {}
          try { qc.invalidateQueries({ queryKey: ["my-memberships"] }); } catch {}
          try { setLive(false); } catch {}
        }
      } catch {
        try { setLive(false); } catch {}
      }
    };
    const onMsg = () => {
      qc.invalidateQueries({ queryKey: ["messages", meetingId] });
    };
    const onRun = () => {
      qc.invalidateQueries({ queryKey: ["messages", meetingId] });
      qc.invalidateQueries({ queryKey: ["delivery", meetingId] });
    };
    conn.on("message", onMsg);
    conn.on("run-complete", onRun);
    const onActivity = (payload: any) => {
      try {
        const mid = (payload as any)?.meetingId ?? "";
        const bid = (payload as any)?.boardId ?? "";
        if (mid && mid !== meetingId) return;
        if (bid && bid !== boardId) return;
        try { qc.invalidateQueries({ queryKey: ["activity", boardId, meetingId] }); } catch {}
      } catch {}
    };
    const onSecretaryActivity = (payload: any) => {
      try {
        const mid = (payload as any)?.meetingId ?? "";
        if (mid && mid !== meetingId) return;
        try { qc.invalidateQueries({ queryKey: ["activity", boardId, meetingId] }); } catch {}
      } catch {}
    };
    conn.on("meeting-activity", onActivity);
    conn.on("secretary-activity", onSecretaryActivity);
    conn.on("access-revoked", onRevoked);
    conn
      .start()
      .then(async () => {
        if (cancelled) { try { await conn.stop(); } catch {} return; }
        try {
          await conn.invoke("JoinMeeting", meetingId);
          if (!cancelled) setLive(true);
        } catch { if (!cancelled) setLive(false); }
      })
      .catch(() => {
        if (!cancelled) setLive(false);
      });
    // Transport transitions mark polling explicitly: reconnecting/close
    // drop Live and refresh the HTTP snapshot; a successful rejoin sets
    // Live and resyncs via a fresh HTTP poll. HTTP polling stays the
    // independent authority (see useMeetingActivity): live===false never
    // gates fresh snapshots.
    conn.onreconnecting(() => {
      if (cancelled) return;
      try { setLive(false); } catch {}
      try { qc.invalidateQueries({ queryKey: ["activity", boardId, meetingId] }); } catch {}
    });
    conn.onclose(() => {
      if (cancelled) return;
      try { setLive(false); } catch {}
    });
    conn.onreconnected(async () => {
      if (cancelled) return;
      try {
        await conn.invoke("JoinMeeting", meetingId);
        if (!cancelled) setLive(true);
        try { qc.invalidateQueries({ queryKey: ["activity", boardId, meetingId] }); } catch {}
      } catch {
        // Rejoin rejected (revoked/expired): reset live state instead of staying stale-live.
        if (!cancelled) {
          try { setLive(false); } catch {}
          try { onRevoked(); } catch {}
        }
      }
    });
    return () => {
      cancelled = true;
      setLive(false);
      conn.stop();
      hubRef.current = null;
    };
  }, [meetingId, meetingOk, qc, hubRev]);
  // Resume freshness: hidden->visible, offline->online, or window focus
  // triggers a fresh HTTP activity poll so the hook post-resume gate clears
  // on real data instead of reusing a retained snapshot. Listeners
  // unsubscribe on unmount/meeting change; no polling loop here.
  useEffect(() => {
    try {
      const refreshActivity = () => {
        try {
          const hidden = typeof document !== "undefined" ? !!(document as any).hidden : false;
          const offline = typeof navigator !== "undefined" ? (navigator as any).onLine === false : false;
          if (!hidden && !offline) {
            try { qc.invalidateQueries({ queryKey: ["activity", boardId, meetingId] }); } catch {}
          }
        } catch {}
      };
      try { document.addEventListener("visibilitychange", refreshActivity); } catch {}
      try { window.addEventListener("online", refreshActivity); } catch {}
      try { window.addEventListener("focus", refreshActivity); } catch {}
      return () => {
        try { document.removeEventListener("visibilitychange", refreshActivity); } catch {}
        try { window.removeEventListener("online", refreshActivity); } catch {}
        try { window.removeEventListener("focus", refreshActivity); } catch {}
      };
    } catch { return undefined; }
  }, [qc, boardId, meetingId]);
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
    try { if (currentToken()) { const myEpoch = epochNow(); const myToken = currentToken(); const myUser = currentUser(); post<unknown>("/api/auth/logout", {}).catch((e) => { if ((e as Error & { stale?: boolean })?.stale) return; }).finally(() => { if (epochNow() !== myEpoch || currentToken() !== myToken || currentUser() !== myUser) return; try { hubRef.current?.stop(); } catch {} setAuthSession("", ""); }); } } catch {}
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
        try {
          if ((e as KeyboardEvent).repeat) return;
          if ((e as KeyboardEvent).isComposing) return;
          if (e.shiftKey) return;
        } catch {}
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
    enabled: !!boardId && boardOk && !sessGate && tab === "sources" && !sessGate,
  });
  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: () => get<Job[]>("/api/activity/jobs"),
    enabled: tab === "activity" && capsAdmin && !sessGate,
  });
  const usage = useQuery({
    queryKey: ["usage", uday, ufrom, uto, boardId, effUsageScope, usageMeeting, usagePurpose],
    queryFn: () => {
      const params: Record<string, string> = { summary: "true" };
      if (effUsageScope !== "installation" && boardId) params.boardId = boardId;
      if (effUsageScope === "meeting" && usageMeeting) params.meetingId = usageMeeting;
      if (uday) params.day = uday;
      if (ufrom) params.from = ufrom;
      if (uto) params.to = uto;
      if (usagePurpose) params.purpose = usagePurpose;
      return get<UsageSummaryEnvelope>(`/api/usage?${new URLSearchParams(params)}`);
    },
    enabled: tab === "activity" && (effUsageScope === "installation" ? capsAdmin : (!!boardId && boardOk)) && (effUsageScope !== "meeting" || !!usageMeeting) && !sessGate,
  });
  const lead = useQuery({
    queryKey: ["lead", boardId],
    queryFn: () => get<Lead>(`/api/boards/${boardId}/lead`),
    enabled:
      !!boardId && boardOk && (tab === "profile" || tab === "meet") && !sessGate,
    retry: false,
  });
  const setup = useQuery({
    queryKey: ["setup", boardId],
    queryFn: () => get<Setup>(`/api/boards/${boardId}/setup`),
    enabled: !!boardId && boardOk && boardDetail.isSuccess && !sessGate && tab === "boards",
  });
  const guestSettings = useQuery({
    queryKey: ["guest-settings", boardId],
    queryFn: () => get<{ id: string; name: string; mission: string; stage: string; discussionPolicy: string; dataUse: string; lead: { name: string; roleLabel: string } | null; meetingIds: string[] }>(`/api/boards/${boardId}/guest-settings`),
    enabled: !!boardId && boardOk && !sessGate && (tab === "boards" || tab === "meet" || tab === "settings"),
    retry: false,
  });
  // Fresh session-gate read for async profile completions: the render-time
  // sessGate const can be stale after a purge, so callbacks consult the live
  // session cache and token instead of closing over render scope.
  const profileGatedNow = (): boolean => {
    try {
      if (!currentToken()) return false;
      const sess = qc.getQueryData(["sess"]) as { authenticated?: boolean } | undefined;
      if (!sess) return true;
      return !sess.authenticated;
    } catch { return true; }
  };
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () => get<Lead>("/api/profile"),
    enabled: !sessGate && (tab === "profile" || tab === "meet"),
    retry: false,
  });
  const [leadForm, setLeadForm] = useState({
    name: "",
    roleLabel: "Board Lead",
    background: "",
    familiarTopics: "",
    simplerTopics: "",
    commPrefs: DEFAULT_COMM_PREFS,
  });
  const [profileLoaded, setProfileLoaded] = useState("");
  const [profileBase, setProfileBase] = useState({ id: "", version: 0 });
  const [saveMsg, setSaveMsg] = useState("");
  const [saveErr, setSaveErr] = useState("");
  const profileEditRev = useRef(0);
  const profileSnap = useRef("");
  const profileWho = useRef("");
  const bumpProfileEdit = (next: { name: string; roleLabel: string; background: string; familiarTopics: string; simplerTopics: string; commPrefs: string }) => {
    profileEditRev.current += 1;
    setLeadForm(next);
  };
  const profileSnapNow = JSON.stringify(leadForm);
  const profileDirty = profileSnap.current !== "" && profileSnapNow !== profileSnap.current;
  const [profileConflict, setProfileConflict] = useState<null | { id: string; version: number }>(null);
  const [profileReloading, setProfileReloading] = useState(false);
  type ProfileSaveAttempt = {
    name: string;
    roleLabel: string;
    background: string;
    familiarTopics: string;
    simplerTopics: string;
    commPrefs: string;
    baseId: string;
    baseVersion: number;
    op: number;
    editRev: number;
    epoch: number;
    token: string;
    user: string;
  };
  const profileResolved = profile.isSuccess || isNotFound(profile.error);
  const profileLookupFailed = !sessGate && profile.isError && !isNotFound(profile.error) && !profileResolved;
  const profileFieldsDisabled = sessGate || !profileResolved || profileReloading;
  useEffect(() => {
    const whoNow = String(epochNow()) + "|" + currentToken() + "|" + canonicalUser();
    if (profileWho.current !== whoNow) {
      profileWho.current = whoNow;
      profileEditRev.current = 0;
      const fresh = { name: "", roleLabel: "Board Lead", background: "", familiarTopics: "", simplerTopics: "", commPrefs: DEFAULT_COMM_PREFS };
      setLeadForm(fresh);
      profileSnap.current = JSON.stringify(fresh);
      setProfileLoaded("");
      setProfileBase({ id: "", version: 0 });
      setProfileConflict(null);
      setProfileReloading(false);
      setSaveMsg("");
      setSaveErr("");
      return;
    }
    if (sessGate) return;
    if (saveLead.isPending) return;
    if (profileReloading) return;
    const remote = profile.data;
    const key = remote ? remote.id + ":" + String(remote.version) : "";
    if (!remote) {
      if ((profile.isSuccess || isNotFound(profile.error)) && profileLoaded !== "" && !profileDirty && profileConflict === null) {
        const fresh = { name: "", roleLabel: "Board Lead", background: "", familiarTopics: "", simplerTopics: "", commPrefs: DEFAULT_COMM_PREFS };
        setLeadForm(fresh);
        profileSnap.current = JSON.stringify(fresh);
        setProfileLoaded("");
        setProfileBase({ id: "", version: 0 });
        setProfileConflict(null);
      }
      return;
    }
    if (key !== profileLoaded) {
      if (!profileDirty && profileConflict === null) {
        const adopted = {
          name: remote.name ?? "",
          roleLabel: remote.roleLabel || "Board Lead",
          background: remote.background ?? "",
          familiarTopics: remote.familiarTopics ?? "",
          simplerTopics: remote.simplerTopics ?? "",
          commPrefs: remote.commPrefs ?? "",
        };
        setProfileBase({ id: remote.id, version: remote.version });
        setProfileLoaded(key);
        setLeadForm(adopted);
        profileSnap.current = JSON.stringify(adopted);
        setProfileConflict(null);
      } else if (remote.id !== profileBase.id || remote.version > profileBase.version) {
        if (!profileConflict || profileConflict.id !== remote.id || profileConflict.version !== remote.version) {
          setProfileConflict({ id: remote.id, version: remote.version });
          setSaveErr("Another saved version arrived while you were editing. Your edits are kept and nothing was overwritten. Saving is paused until you reload the saved profile, review it, and reapply your changes.");
        }
      }
    }
  }, [profile.data, profile.isSuccess, profile.error, profileLoaded, profileDirty, profileBase, profileConflict, profileReloading, sessGate]);
  const saveLead = useMutation({
    mutationFn: async (attempt: ProfileSaveAttempt) => {
      if (attempt.op !== profileOpRef.current || profileGatedNow() || epochNow() !== attempt.epoch || currentToken() !== attempt.token || canonicalUser() !== attempt.user) {
        throw Object.assign(new Error("stale save discarded (identity changed)"), { stale: true });
      }
      return post<Lead>("/api/profile", {
        name: attempt.name,
        roleLabel: attempt.roleLabel,
        background: attempt.background,
        familiarTopics: attempt.familiarTopics,
        simplerTopics: attempt.simplerTopics,
        commPrefs: attempt.commPrefs,
        version: attempt.baseVersion,
      });
    },
    onMutate: (attempt) => {
      setSaveMsg("");
      setSaveErr("");
      return { attempt };
    },
    onSuccess: (response, attempt) => {
      if (attempt.op !== profileOpRef.current) return;
      if (profileGatedNow() || epochNow() !== attempt.epoch || currentToken() !== attempt.token || canonicalUser() !== attempt.user) return;
      const rr = response;
      if (!rr || !rr.id) return;
      const nkey = rr.id + ":" + String(rr.version);
      const acknowledged = {
        name: rr.name ?? "",
        roleLabel: rr.roleLabel || "Board Lead",
        background: rr.background ?? "",
        familiarTopics: rr.familiarTopics ?? "",
        simplerTopics: rr.simplerTopics ?? "",
        commPrefs: rr.commPrefs ?? "",
      };
      setProfileBase({ id: rr.id, version: rr.version });
      setProfileLoaded(nkey);
      profileSnap.current = JSON.stringify(acknowledged);
      setProfileConflict(null);
      if (profileEditRev.current !== attempt.editRev) {
        setSaveMsg("Saved as your account default. Your newer edits are still in the form; save again to apply them.");
      } else {
        setLeadForm(acknowledged);
        setSaveMsg("Profile saved as your account default for all boards.");
      }
      try { qc.setQueryData(["profile"], rr); } catch { /* keep server truth on next refetch */ }
      refresh("profile", "lead", "setup");
    },
    onError: (error, attempt) => {
      if (attempt.op !== profileOpRef.current) return;
      if (profileGatedNow() || epochNow() !== attempt.epoch || currentToken() !== attempt.token || canonicalUser() !== attempt.user) return;
      setSaveMsg("");
      if (error instanceof Error && error.message.startsWith("409")) {
        setProfileConflict({ id: attempt.baseId, version: attempt.baseVersion });
        setSaveErr("Another save landed first. Your edits are kept and nothing was overwritten. Saving is paused until you reload the saved profile, review it, and reapply your changes.");
        return;
      } else if (error instanceof Error && (error as { stale?: boolean }).stale) {
        return;
      } else {
        setSaveErr("Save was rejected. Your text is kept. Try again.");
      }
    },
  });
  const reloadSavedProfile = async () => {
    if (profileConflict === null || sessGate || profile.isFetching || profileReloading) return;
    if (!window.confirm("Reload the saved profile? This discards your unsaved edits.")) return;
    const origin = { op: profileOpRef.current, rev: profileEditRev.current, epoch: epochNow(), token: currentToken(), user: canonicalUser() };
    setProfileReloading(true);
    let latest: Lead | undefined;
    try {
      latest = await get<Lead>("/api/profile");
    } catch {
      latest = undefined;
    }
    if (origin.op !== profileOpRef.current || profileGatedNow() || epochNow() !== origin.epoch || currentToken() !== origin.token || canonicalUser() !== origin.user) return;
    if (profileEditRev.current !== origin.rev) {
      setProfileReloading(false);
      setSaveErr("Newer edits were typed during reload. They are kept — confirm reload again to discard them, or keep editing.");
      return;
    }
    if (!latest || !latest.id) {
      setProfileReloading(false);
      setSaveErr("Could not reload the saved profile. Your edits are kept. Try reloading again.");
      return;
    }
    const adopted = {
      name: latest.name ?? "",
      roleLabel: latest.roleLabel || "Board Lead",
      background: latest.background ?? "",
      familiarTopics: latest.familiarTopics ?? "",
      simplerTopics: latest.simplerTopics ?? "",
      commPrefs: latest.commPrefs ?? "",
    };
    setLeadForm(adopted);
    profileSnap.current = JSON.stringify(adopted);
    setProfileBase({ id: latest.id, version: latest.version });
    setProfileLoaded(latest.id + ":" + String(latest.version));
    setProfileConflict(null);
    setProfileReloading(false);
    setSaveMsg("Reloaded the saved profile. Reapply any changes, then save.");
    setSaveErr("");
    try { qc.setQueryData(["profile"], latest); } catch { /* reload already adopted locally */ }
  };

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
    onError: (e) => toastErr(`Activation blocked. ${String(e)}`),
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
    enabled: !!boardId && boardOk && !sessGate && tab === "boards" && !sessGate,
  });
  const [wizId, setWizId] = useState(
    () => { try { const u = localStorage.getItem("simceo-user") ?? "anon"; return localStorage.getItem("simceo-wizard:"+(u||"anon")) ?? ""; } catch { return ""; } },
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
  // Auth8: identity-carried wizard save guards (epoch/token/user) so late
  // callbacks after an account switch are ignored; per-user draft keys.
  const wizSaveIdentityRef = useRef<{ epoch: number; token: string; user: string } | null>(null);
  const wizOwnerRef = useRef<string>("");
  // Synchronously retired completed wizard ids. setWizId/setWizard enqueue a
  // render, so render-synced refs still hold the old id until the next render.
  // A wizSave success or hydrate GET resolving in that window must not
  // resurrect the consumed draft; this set retires them synchronously at
  // confirmed create success. Only success retires, so unknown-commit retry
  // with the same id still replays idempotently and unfinished drafts survive.
  const wizCompletedRef = useRef<Set<string>>(new Set());
  // Version-only refresh after a rejected save: adopts the fresh strict
  // version guard without touching local fields/step, so the next save
  // retries with the current inputs instead of silently discarding them.
  const refreshWizVersionOnly = (id?: string) => {
    const target = id ?? wizIdRef.current;
    if (!target) return;
    get<{ version: number }>(`/api/wizard/${target}`).then((d) => {
      if (wizCompletedRef.current.has(target)) return;
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
      wizSaveIdentityRef.current = { epoch: epochNow(), token: currentToken(), user: currentUser() };
      wizOwnerRef.current = currentUser();
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
      // Identity-carried callback: ignore late success after an account switch.
      const cap = wizSaveIdentityRef.current;
      if (!cap || epochNow() !== cap.epoch || currentToken() !== cap.token || currentUser() !== cap.user) return;
      if (wizCompletedRef.current.has(r.id)) return;
      setWizId(r.id);
      if (typeof r.version === "number") acceptWizVersion(r.id, r.version);
      { try { const u = cap.user || "anon"; localStorage.setItem("simceo-wizard:"+u, r.id); localStorage.removeItem("simceo-wizard"); } catch {} }
      refresh("wizreview");
    },
    onError: (e) => {
      toastErr(e);
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
    enabled: tab === "wizard" && !!wizId && !sessGate,
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
    onError: (e) => toastErr(e),
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
      if (wizCompletedRef.current.has(id)) return;
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
      toastErr(e);
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
    onMutate: () => ({ originWizId: wizId, origin: originIdentity(), originOwner: wizOwnerRef.current || currentUser() }),
    onSuccess: (r, _v, ctx) => {
      const o = ctx as { originWizId?: string; origin?: { epoch: number; token: string; user: string }; originOwner?: string } | undefined;
      // Consume the completed wizard only under the originating identity:
      // a late completion after an account switch must not seed caches,
      // switch boards, or retire another account's draft pointer.
      if (!o?.origin || originStale(o.origin)) return;
      if (wizIdRef.current !== o.originWizId) return;
      // Synchronous retirement of the completed wizard BEFORE seeded caches or
      // React state flush: render-synced refs still hold the old id until the
      // next render, so a wizSave success or hydrate GET resolving in that
      // window would otherwise resurrect Step 4 and replay the same wizard id
      // (idempotent fixture returns the SAME board). Mark the origin id
      // completed and clear the live refs now; late arrivals for the old id
      // are discarded by the completed-set checks. Only success retires, so
      // unknown-commit retry keeps the id and unfinished drafts survive.
      try { if (o.originWizId) wizCompletedRef.current.add(o.originWizId); } catch {}
      wizIdRef.current = "";
      wizVersionRef.current = null;
      wizKnownRef.current = { id: "", version: null };
      wizLastSentRef.current = null;
      try {
        (wizardRef as any).current = {
          name: "", mission: "", stage: "", step: 1, seats: [],
          lead: {
            name: "", roleLabel: "Board Lead", background: "",
            familiarTopics: "", simplerTopics: "", commPrefs: "",
          },
        };
      } catch {}
      // Seed the new board into the list + detail caches before the
      // invalidated list returns, so a delayed refresh never discards the
      // just-created selection as "absent".
      // Seed the scoped boards cache (query key includes the discovery scope).
      qc.setQueryData<Board[]>(["boards", boardScope], (old) =>
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
      try { const key = "simceo-wizard:" + (currentUser() || "anon"); try { if (localStorage.getItem(key) === o?.originWizId) { localStorage.removeItem(key); } } catch {} try { if (localStorage.getItem("simceo-wizard") === o?.originWizId) { localStorage.removeItem("simceo-wizard"); } } catch {} wizOwnerRef.current = ""; } catch { /* private-mode */ }
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
    onError: (e) => toastErr(e),
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
    enabled: tab === "roster" && !sessGate,
  });
  const rosterRows = rosterList.data ?? [];
  const [selRoster, setSelRoster] = useState("");
  const selImages = useQuery({
    queryKey: ["roster-images", selRoster],
    queryFn: () =>
      get<{ id: string; kind: string; provenance: string; review: string }[]>(`/api/roster/${selRoster}/images`),
    enabled: !!selRoster && !sessGate,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const closeCreate = () => setCreateOpen(false);
  const [portraitRev, setPortraitRev] = useState(0);
  const reviewImg = useMutation({
    mutationFn: (args: { id: string; decision: string }) =>
      post<unknown>(`/api/images/${args.id}/review`, { decision: args.decision }),
    onSuccess: () => { try { setPortraitRev((v) => v + 1); } catch {} refresh("roster-images", "roster", "roster-names", "advisors"); },
    onError: (e) => toastErr(e),
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
    enabled: !sessGate && !anonPrivateBlocked,
});
// Selection provenance: the clickable roster list renders from rosterNames
// (unfiltered) while rosterRows is the filtered search list. Resolve detail
// from the same source as the list when the search list lags, so a selected
// entry always shows its detail and portraits.
const selRow = (rosterRows ?? []).find((r) => r.entry.id === selRoster)
  ?? (rosterNames.data ?? []).find((r) => r.entry.id === selRoster);
const selResearch = useQuery({
  queryKey: ["roster-research", selRow?.entry.id, accountId],
  queryFn: () => get<any>(`/api/roster/${selRow!.entry.id}/research`),
  enabled: !!selRow?.entry.id && tab === "roster" && !sessGate,
  refetchInterval: !!selRow?.entry.id && tab === "roster" && !sessGate ? 2500 : false,
  retry: false,
});
const selResearchRunning = isRosterResearchRunning((selResearch as any)?.data);
// Owned GET research snapshot: the single authority for the outer banner
// (state/version/proof/stage/running, terminal metadata, error, loading).
// Cached roster-row fields (researchedAt/requested/evidenceCount) never take
// priority for a failed rerun or a live run.
const selResearchData = (selResearch as any)?.data ?? null;
const selResearchDataError = (selResearch as any)?.error ?? null;
const selResearchFetching = !!((selResearch as any)?.isFetching);
const selResearchLoading = !selResearchData && (!!((selResearch as any)?.isLoading) || selResearchFetching);

const rosterCount = useQuery({
  queryKey: ["roster-count", accountId],
  queryFn: () =>
    get<{ total: number }>(
      `/api/roster/count?${new URLSearchParams({ accountId })}`,
    ),
    enabled: !sessGate && !anonPrivateBlocked,
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
    onError: (e) => toastErr(e),
  });
  const archiveRoster = useMutation({
    mutationFn: (row: RosterRow) =>
      post<unknown>(`/api/roster/${row.entry.id}/archive`, {
        archived: !row.entry.archived,
      }),
    onSuccess: () => refresh("roster", "roster-count", "roster-names"),
  });
  const createNameRef = useRef<HTMLInputElement | null>(null);
  const [portraitUrl, setPortraitUrl] = useState("");
  const [portraitMsg, setPortraitMsg] = useState("");
  const uploadPortrait = async (f: File | undefined) => {
    if (!f || !selRow) return;
    const fd = new FormData();
    fd.append("file", f);
    try {
      await upload<unknown>(`/api/roster/${selRow.entry.id}/image/upload`, fd);
      setPortraitMsg("Portrait added.");
      refresh("roster", "roster-images");
    } catch (e) {
      setPortraitMsg(String(e));
    }
  };
  const urlPortrait = useMutation({
    mutationFn: (url: string) =>
      post<unknown>(`/api/roster/${selRow?.entry.id}/image/url`, { url, source: "owner-provided" }),
    onSuccess: () => {
      setPortraitUrl("");
      setPortraitMsg("Portrait added.");
      refresh("roster", "roster-images");
    },
    onError: (e) => setPortraitMsg(String(e)),
  });
  const genPortrait = useMutation({
    mutationFn: () =>
      post<unknown>(`/api/roster/${selRow?.entry.id}/image/generate`, { count: 1 }),
    onSuccess: () => {
      setPortraitMsg("Portrait generated.");
      refresh("roster", "roster-images");
    },
    onError: (e) => setPortraitMsg(String(e)),
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
    onError: (e) => toastErr(e),
  });
  const syncRoster = useMutation({
    mutationFn: (a: AdvisorFull) =>
      post<unknown>(`/api/boards/${boardId}/advisors/${a.id}/sync-roster`, {}),
    onSuccess: () => refresh("advisors"),
    onError: (e) => toastErr(e),
  });
  const [selAdv, setSelAdv] = useState("");
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
    enabled: tab === "advisors" && !!selAdvisor?.rosterEntryId && !sessGate,
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
      refresh("images", "roster-images");
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
      refresh("images", "roster-images");
    },
    onError: (e) => setImgMsg(String(e)),
  });
  const genImg = useMutation({
    mutationFn: () =>
      post<unknown>(`/api/roster/${selAdvisor?.rosterEntryId}/image/generate`, {
        count: 2,
      }),
    onSuccess: () => {
      refresh("images", "roster-images");
      setImgMsg("Generated.");
    },
    onError: (e) => setImgMsg(String(e)),
  });
  const selectImg = useMutation({
    mutationFn: (imgId: string) =>
      post<unknown>(`/api/images/${imgId}/select`, { boardAdvisorId: selAdv }),
    onSuccess: () => {
      refresh("advisors");
      try { setPortraitRev((v) => v + 1); } catch {} setImgMsg("Selected for this board copy.");
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
    if (settingsOpen) return;
    if (curMeeting && mLoaded !== curMeeting.id + curMeeting.brief) {
      setMtitle(curMeeting.title);
      setMbrief(curMeeting.brief ?? "");
      setMLoaded(curMeeting.id + curMeeting.brief);
    }
  }, [curMeeting, mLoaded, settingsOpen]);
  const briefText = curMeeting?.brief ?? "";
  useEffect(() => {
    if (tab !== "meet" || !meetingId || !boardId || !briefText.trim()) return;
    // Board-scoped recall requires board read access: guests without a board
    // grant must not issue a request the server will deny.
    if (!caps.isSuccess || isGuest) return;
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
        participantIds: meetPartDraft,
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
    enabled: !!meetingId && meetingOk && tab === "meet" && !sessGate,
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
  const searchGenRef = useRef(0);
  // Live selection snapshot. The request captures its own board/meeting/
  // query, but resolution compares against THESE current refs (not the
  // captured render copies, which always equal themselves). Navigation
  // retires outstanding searches even when no new search is issued.
  const searchLiveRef = useRef({ board: "", meeting: "", q: "" });
  searchLiveRef.current = { board: boardId, meeting: meetingId, q: sq };
  const searchMsgs = () => {
    const origin = originIdentity();
    const board = boardId;
    const meeting = meetingId;
    const q = sq;
    const gen = searchGenRef.current + 1;
    searchGenRef.current = gen;
    get<
      {
        sequence: number;
        sender: string;
        advisorName?: string;
        excerpt: string;
      }[]
    >(`/api/meetings/${meetingId}/messages/search?q=${encodeURIComponent(sq)}`)
      .then((r) => {
        if (originStale(origin)) return;
        if (searchGenRef.current !== gen) return;
        const live = searchLiveRef.current;
        if (live.board !== board || live.meeting !== meeting) return;
        if (live.q !== q) return;
        setHits(r);
      })
      .catch((e) => {
        if (originStale(origin)) return;
        if (searchGenRef.current !== gen) return;
        const live = searchLiveRef.current;
        if (live.board !== board || live.meeting !== meeting) return;
        toastErr(e);
      });
  };
  // Any board/meeting navigation retires outstanding searches, even when
  // no new search is issued: a held A response released after switching
  // to B must never populate B.
  useEffect(() => { searchGenRef.current++; }, [boardId, meetingId]);
  const notes = useQuery({
    queryKey: ["notes", meetingId],
    queryFn: () => get<Note[]>(`/api/meetings/${meetingId}/notes`),
    enabled: !!meetingId && meetingOk && tab === "meet" && !sessGate,
  });
  const notesHistoryAll = useQuery({
    queryKey: ["notes-history", meetingId],
    queryFn: () => get<any[]>(`/api/meetings/${meetingId}/notes/history`),
    enabled: !!meetingId && meetingOk && tab === "meet" && !sessGate,
  });
  const [ntitle, setNtitle] = useState("");
  const [nbody, setNbody] = useState("");
  const noteVisitRef = useRef(0);
  const noteDraftRev = useRef(0);
  const briefVisitRef = useRef(0);
  const optVisitRef = useRef(0);
  // Actual view visits: leaving the takeaways/manual-note/briefing/history view (selection, tab, or sub-tab change) retires in-flight briefing and history callbacks via their visit revisions. Close bumps secHistRef directly; leave and return bump it here so a late loadHistory never populates a new visit.
  useEffect(() => { noteVisitRef.current++; try { briefVisitRef.current++; } catch { /* noop */ } try { secHistRef.current++; } catch { /* noop */ } try { noteDraftRev.current++; } catch { /* noop */ } try { optVisitRef.current++; } catch { /* noop */ } }, [boardId, meetingId, meetTab, tab]);
  const addNote = useMutation({
    mutationFn: () =>
      post<Note>(`/api/meetings/${meetingId}/notes`, {
        title: ntitle,
        body: nbody,
        kind: "note",
      }),
    onMutate: () => ({ oB: boardId, oM: meetingId, origin: originIdentity(), title: ntitle, body: nbody, visit: noteVisitRef.current, drev: noteDraftRev.current }),
    onSuccess: (_r: unknown, _v: unknown, ctx: unknown) => { const o = ctx as any; if (!o || !o.origin || originStale(o.origin)) return; const live = liveSelRef.current; if (live.boardId !== o.oB || live.meetingId !== o.oM) return; if (o.visit !== noteVisitRef.current || o.drev !== noteDraftRev.current) return; if (ntitle === o.title && nbody === o.body) { setNtitle(""); setNbody(""); } refresh("notes"); notify("Note saved."); },
    onError: (e, _v, ctx) => { const o = ctx as any; if (!o || !o.origin || originStale(o.origin)) return; const live = liveSelRef.current; if (live.boardId !== o.oB || live.meetingId !== o.oM) return; if (o.visit !== noteVisitRef.current) return; toastErr(e); },
  });
  const [btopic, setBtopic] = useState("");
  const askBriefing = useMutation({
    mutationFn: (v: any) => {
      // Queued-attempt validation BEFORE dispatch: navigation, Clear, Apply
      // identity, or a newer attempt retires this one before any POST of the
      // frozen click-time intent.
      const vv = (v ?? {}) as any;
      if (!vv.origin || originStale(vv.origin)) throw Object.assign(new Error("Briefing submission retired before dispatch."), { stale: true });
      if (vv.oB !== boardId || vv.oM !== meetingId || vv.oU !== secIdentity() || secEpoch.current !== vv.oEp) throw Object.assign(new Error("Briefing submission retired before dispatch."), { stale: true });
      if (vv.opId && secPendingRef.current?.id !== vv.opId) throw Object.assign(new Error("Briefing submission retired before dispatch."), { stale: true });
      // Frozen click-time intent (never resume-time refs).
      const oB = vv.oB; const oM = vv.oM; const oU = vv.oU; const oEp = vv.oEp;
      const submitted = vv.topic;
      const originAtClick = vv.origin;
      const opIdAtClick = vv.opId;
      return post<Note>(`/api/meetings/${oM}/briefings`, { topic: submitted }).then((r) => ({ r, oB, oM, oU, oEp, submitted, origin: originAtClick, opId: opIdAtClick }));
    },
    onMutate: (v: any) => { const vv = (v ?? {}) as any; const opId = vv.opId ?? ("brief-" + (++opSeq.current)); secPendingRef.current = { kind: "briefing", id: opId }; return { oB: vv.oB ?? boardId, oM: vv.oM ?? meetingId, oU: vv.oU ?? secIdentity(), oEp: vv.oEp ?? secEpoch.current, opId, origin: vv.origin ?? originIdentity(), visit: vv.visit ?? briefVisitRef.current, submitted: vv.topic ?? btopic }; },
    onSuccess: (pack: any, _v: unknown, ctx: unknown) => {
      const o = ctx as any;
      if (!(pack as any)?.origin || originStale((pack as any).origin)) return;
      const live = liveSelRef.current;
      let liveUser = secIdentity();
      if (live.boardId !== (pack as any)?.oB || live.meetingId !== (pack as any)?.oM || liveUser !== (pack as any)?.oU || (pack as any)?.oEp !== secEpoch.current) return;
      if (!o || !o.origin || originStale(o.origin) || o.visit !== briefVisitRef.current) return;
      if (!o.opId || secPendingRef.current?.id !== o.opId) return;
      if (btopic === (pack as any)?.submitted) setBtopic("");
      try { const omB = parseOmittedManifest((pack as any)?.r?.omitted ?? (pack as any)?.omitted) ?? parseOmittedRow((pack as any)?.r ?? (pack as any)); if (omB !== null) { setSecOmitted(omB); secOmittedReq.current = ""; } } catch { }
      refresh("notes");
      notify("Briefing prepared from grounded packet.");
    },
    onError: (e, _v, ctx) => {
      const o = ctx as any;
      const live = liveSelRef.current;
      let liveUser = secIdentity();
      if (o && (o as any).origin && originStale((o as any).origin)) return;
      if (o && (live.boardId !== o.oB || live.meetingId !== o.oM || liveUser !== o.oU || o.oEp !== secEpoch.current)) return;
      // A briefing error belongs to its captured topic/edit visit and attempt.
      if (!o || !o.opId || secPendingRef.current?.id !== o.opId) return;
      if (o.visit !== briefVisitRef.current) return;
      if (btopic !== o.submitted) return;
      toastErr(e);
    },
    onSettled: (_r: unknown, _e: unknown, _v: unknown, ctx: unknown) => { const o = ctx as any; if (o && o.opId && secPendingRef.current?.id === o.opId) secPendingRef.current = null; },
  });
  const directions = useQuery({
    queryKey: ["directions", boardId],
    queryFn: () => get<Note[]>(`/api/boards/${boardId}/directions`),
    enabled: !!boardId && boardOk && !sessGate && tab === "meet" && caps.isSuccess && !isGuest,
  });
  const [dtext, setDtext] = useState("");
  const dtextRev = useRef(0);
  const [dscope, setDscope] = useState("meeting");
  const adopt = useMutation({
    mutationFn: () =>
      post<Note>(`/api/boards/${boardId}/directions`, {
        text: dtext,
        scope: dscope,
        meetingId,
      }),
    onMutate: () => ({ ...captureRecOrigin(), submitted: dtext, submittedRev: dtextRev.current, optVisit: optVisitRef.current }),
    onSuccess: (_r, _v, ctx) => {
      const o = ctx as { boardId: string; meetingId: string; recId: string; visit: number; epoch: number; token: string; user: string; submitted?: string } | undefined;
      if (!o || !recOriginLive(o)) return;
      if ((o as any)?.optVisit !== optVisitRef.current) return;
      // Clear only the submitted revision: newer typed text (including an X->Z->X retype) survives a held success.
      if (dtextRev.current === (o as any)?.submittedRev && dtext === o.submitted) setDtext("");
      refresh("directions");
      notify("Direction adopted with the exact shown text.");
    },
    onError: (e, _v, ctx) => {
      const o = ctx as { boardId: string; meetingId: string; recId: string; visit: number; epoch: number; token: string; user: string } | undefined;
      if (!o || !recOriginLive(o)) return;
      if ((o as any)?.optVisit !== optVisitRef.current) return;
      toastErr(e);
    },
  });
  const fromDirection = useMutation({
    mutationFn: (noteId: string) =>
      post<RecordDraft>(`/api/meetings/${meetingId}/record/from-direction`, { noteId }),
    onMutate: () => ({ originBoardId: boardId, originMeetingId: meetingId, originRecId: recId, recVisit: recVisitRef.current, optVisit: optVisitRef.current, origin: originIdentity() }),
    onSuccess: (r, _v, ctx) => {
      const origin = ctx as { originBoardId?: string; originMeetingId?: string; originRecId?: string; recVisit?: number; origin?: { epoch: number; token: string; user: string } } | undefined;
      const keyMeeting = (r as RecordDraft)?.meetingId ?? origin?.originMeetingId ?? meetingId;
      const keyBoard = (r as RecordDraft)?.boardId ?? origin?.originBoardId ?? boardId;
      // Never seed caches, select, or notify under a stale identity or
      // selection: identity/epoch/token plus board/meeting/record must all
      // still match, or the result is discarded silently.
      const live = liveSelRef.current;
      const og = origin?.origin;
      if (!og || originStale(og)) return;
      // Record-visit ownership: an A→B→A return retires the old callback even
      // when board, meeting, record, token, and user coincide.
      const roFrom = { boardId: origin?.originBoardId ?? "", meetingId: origin?.originMeetingId ?? "", recId: origin?.originRecId ?? "", visit: origin?.recVisit ?? -1, epoch: og.epoch, token: og.token, user: og.user };
      if (!recOriginLive(roFrom)) return;
      if ((origin as any)?.optVisit !== optVisitRef.current) return;
      if (live.boardId !== keyBoard || live.meetingId !== keyMeeting || live.recId !== (origin?.originRecId ?? "") || live.user !== og.user) return;
      qc.setQueryData<RecordDraft[] | undefined>(
        ["records", keyMeeting],
        (old) => (old ? [...old.filter((x) => x.id !== r.id), r] : [r]),
      );
      qc.setQueryData(["record", r.id], r);
      setRecId(r.id);
      setTab("records");
      refresh("records", "record");
      notify("Direction staged for review as draft " + r.id + ".");
    },
    onError: (e, _v, ctx) => {
      const origin = ctx as { originBoardId?: string; originMeetingId?: string; originRecId?: string; recVisit?: number; origin?: { epoch: number; token: string; user: string } } | undefined;
      const og = origin?.origin;
      if (!og || originStale(og)) return;
      const roErr = { boardId: origin?.originBoardId ?? "", meetingId: origin?.originMeetingId ?? "", recId: origin?.originRecId ?? "", visit: origin?.recVisit ?? -1, epoch: og.epoch, token: og.token, user: og.user };
      if (!recOriginLive(roErr)) return;
      if ((origin as any)?.optVisit !== optVisitRef.current) return;
      noteReviewError(e, { boardId: roErr.boardId, meetingId: roErr.meetingId, recId: roErr.recId, user: roErr.user, token: roErr.token });
    },
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
      toastErr(e);
    }
  };
  const savePolicy = useMutation({
    mutationFn: () =>
      put<unknown>(`/api/boards/${boardId}/source-policy`, { blockedTypes: blocked }),
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
      .catch((e) => toastErr(e));
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
    enabled: !!meetingId && meetingOk && (tab === "records" || tab === "meet") && !sessGate,
  });
  const latestDraft = (recs.data ?? [])
    .slice()
    .sort((a, b) => b.version - a.version)[0];
  const [recId, setRecId] = useState(route0.rec);
  // Record-visit generation: incremented on every record selection so a
  // same-record A-B-A return cannot validate a stale first-visit callback.
  const recVisitRef = useRef(0);
  // Record view visits: leaving or (re)entering the Records tab retires held record callbacks even when the record ID is unchanged (A-away-A). Operation-owned settlement still protects newer operations.
  useEffect(() => { recVisitRef.current++; }, [recId, tab]);
  const liveSelRef = useRef({ boardId, meetingId, recId, user: currentToken() ? currentUser() : (actAs || "owner") });
  liveSelRef.current = { boardId, meetingId, recId, user: currentToken() ? currentUser() : (actAs || "owner") };
  // Immutable origin identity for async callbacks: the effective session
  // identity when a session exists, else the demo act-as label. Epoch and
  // token are captured so a later account switch or re-login invalidates
  // stale callbacks even when the label coincides.
  const originIdentity = () => ({
    epoch: epochNow(),
    token: currentToken(),
    user: canonicalUser(),
  });
  const originStale = (o: { epoch: number; token: string; user: string }) =>
    epochNow() !== o.epoch || currentToken() !== o.token || canonicalUser() !== o.user;
  const originRevision = () => String(epochNow()) + "|" + currentToken() + "|" + canonicalUser();
  const resolveCanonicalEntry = async (id: string) => {
    try {
      return await fetchFreshCanonicalEntry({ get, accountId, originIdentity: originIdentity as () => unknown, originStale: originStale as (o: unknown) => boolean }, id);
    } catch {
      return null;
    }
  };
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
    enabled: !!recId && !!boardId && !!meetingId && boardOk && meetingOk && tab === "records" && !sessGate,
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
  const revTextRev = useRef(0);
  const revTextOwner = useRef("");
  // Whole-draft ownership retires with its context: board and meeting switches
  // and record deselect clear the owner so a deliberate same-ID reselect
  // rehydrates. Same-draft refetches keep the owner and preserve newer typing.
  useEffect(() => { try { revTextOwner.current = ""; } catch { /* noop */ } }, [boardId, meetingId]);
  useEffect(() => { if (!recId) { try { revTextOwner.current = ""; } catch { /* noop */ } } }, [recId]);
  useEffect(() => {
    if (recDetail.data) {
      const nid = (recDetail.data as RecordDraft).id;
      // Whole-draft editor ownership: only a deliberate record selection
      // (new draft id, first load, or board/meeting switch) replaces newer
      // typing. Same-draft detail refreshes preserve in-progress edits.
      if (revTextOwner.current !== nid) {
        // Draft item text is redacted server-side for read-only roles: coerce
        // to empty string so the editor stays controlled and the list below
        // renders the restricted notice instead of crashing on undefined.
        setRevText(recDetail.data.itemsJson ?? "");
        revTextOwner.current = nid;
        try {
          const ids = (JSON.parse(recDetail.data.itemsJson) as { id?: string }[])
            .map((i) => i.id ?? "")
            .filter(Boolean);
          setSelItems(ids);
        } catch {
          setSelItems([]);
        }
      }
    }
  }, [recDetail.data]);
  const recReview = useQuery({
    queryKey: ["record-review", recId],
    queryFn: () => get<RecordReview>(`/api/records/${recId}/review`),
    enabled: !!recId && !!boardId && !!meetingId && boardOk && meetingOk && tab === "records" && !sessGate,
    retry: false,
  });
  const [reviewError, setReviewError] = useState<{ key: string; message: string } | null>(null);
  const errKey = `${boardId}:${meetingId}:${recId}:${canonicalUser()}:${fullIdentityToken()}`;
  useEffect(() => {
    setReviewError(null);
  }, [boardId, meetingId, recId]);
  const showReviewError = reviewError !== null && reviewError.key === errKey;

  // Authoritative persisted-state validity: the SERVER-computed stateValid
  // flag (StrictStateCheck) is required === true. A missing flag, a false
  // flag, a failed/empty review, or a non-manage grant hides EVERY approval
  // control, including the selection checkboxes. An empty draft (no pending
  // items) likewise shows no approval controls.
  const reviewPendingCount = (recReview.data?.pending ?? []).length;
  const stateValid = recOk && !!recReview.data && !recReview.isError && !showReviewError && reviewPendingCount > 0 && recReview.data.stateValid === true;
  const canApproveRecord = canManageMeeting && stateValid === true;
  const [itemTexts, setItemTexts] = useState<Record<string, string>>({});
  const itemTextRev = useRef<Record<string, number>>({});
  const editKey = (draftId: string, itemId: string) => `${draftId}:${itemId}`;
  useEffect(() => {
    setItemTexts({});
    itemTextRev.current = {};
  }, [boardId, meetingId, recId]);
  const refreshReview = async () => {
    if (!recOk) return;
    // Full origin + record-visit capture BEFORE the initial GET: a held GET
    // plus same-user new token, an account switch, or a record A-B-A return
    // must not POST or mutate the new context. Every state/error write below
    // revalidates; the POST uses the staged GET payload guards, never stale
    // captured detail.
    const origin = captureRecOrigin();
    const stillLive = () => recOriginLive(origin);
    try {
      setReviewError(null);
      const fresh = await get<RecordReview>(`/api/records/${origin.recId}/review`);
      if (!stillLive()) return;
      const fd = fresh.draft;
      qc.setQueryData(["record", fd.id], fd);
      refresh("records", "record");
      await recReview.refetch();
      if (!stillLive()) return;
      // Narrow legacy adoptable exception: a genuine legacy true pending row
      // may POST explicit Refresh even when watermarks match; server
      // validates full base/state/auth and mints new history. Non-legacy
      // equal-watermark rows stay read-only with no approve path.
      const legacyAdoptable = (fd as RecordDraft).legacyReview === true && (fresh.pending ?? []).length > 0;
      if (fd.watermark === fresh.meetingWatermark && !legacyAdoptable) {
        notify("Review is already current; approve deliberately.");
        return;
      }
      const r = await post<unknown>(`/api/records/${fd.id}/refresh`, guardOf(fd));
      if (!stillLive()) return;
      const rd = (r as unknown as { draft?: RecordDraft })?.draft;
      if (rd && (rd as RecordDraft).id) qc.setQueryData(["record", (rd as RecordDraft).id], rd);
      refresh("records", "record");
      void recReview.refetch();
      notify("Review refreshed to current meeting input; choose deliberately.");
    } catch (e) {
      if (!stillLive()) return;
      noteReviewError(e, origin);
    }
  };
  const guardOf = (d: RecordDraft) => ({
    version: d.version,
    hash: d.hash,
    reviewToken: d.reviewToken,
    watermark: d.watermark,
  });
  // Record export travels the identity-aware transport (never a plain anchor):
  // the originating identity is pinned before fetch and rechecked at click,
  // and late completion after an account switch is discarded silently.
  const exportRecord = (format: string) => {
    if (!recOk || !recDetail.data || !canActMeeting) return;
    const d = recDetail.data;
    const origin = captureRecOrigin();
    // Local visit/identity guard BEFORE the download side effect: a stale selection, record switch, or A-B-A return never starts the fetch, and the predicate is re-checked after the fetch before the click.
    if (!recOriginLive(origin)) return;
    authedDownload(`/api/records/${d.id}/export?format=${format}`, `record-${d.id}-${format}.json`, () => recOriginLive(origin))
      .then(() => {
        if (!recOriginLive(origin)) return;
        notify(`Exported ${format} record v${d.version}.`);
      })
      .catch((e) => {
        if ((e as Error & { stale?: boolean })?.stale) return;
        if (!recOriginLive(origin)) return;
        notify(String(e));
      });
  };
  const applyDraft = (r: unknown) => {
    const upd = r as unknown as RecordDraft | undefined;
    if (upd && (upd as RecordDraft).id) {
      qc.setQueryData(["record", (upd as RecordDraft).id], upd);
      qc.setQueryData<RecordDraft[] | undefined>(
        ["records", (upd as RecordDraft).meetingId],
        (old) =>
          old
            ? old.map((x) =>
                x.id === (upd as RecordDraft).id ? { ...x, ...(upd as RecordDraft) } : x,
              )
            : old,
      );
      refresh("records", "record");
      void recReview.refetch();
    } else {
      refresh("records", "record");
      void recReview.refetch();
    }
  };
  // Full record-origin capture: selection + record-visit generation + the
  // canonical authority (epoch, token, user). Late callbacks must revalidate
  // ALL of it; a same-user new token or a record A-B-A return invalidates.
  const captureRecOrigin = () => ({ boardId, meetingId, recId, visit: recVisitRef.current, ...originIdentity() });
  const recOriginLive = (o: { boardId: string; meetingId: string; recId: string; visit: number; epoch: number; token: string; user: string }) => {
    const live = liveSelRef.current;
    if (live.boardId !== o.boardId || live.meetingId !== o.meetingId || live.recId !== o.recId || live.user !== o.user) return false;
    if (o.visit !== recVisitRef.current) return false;
    return !originStale({ epoch: o.epoch, token: o.token, user: o.user });
  };
  const noteReviewError = (e: unknown, origin: { boardId: string; meetingId: string; recId: string; user: string; token?: string }) => {

    const msg = String(e);
    const message = msg.includes("409")
      ? `${msg} — the review changed or the meeting moved on. Use Refresh review below, then choose again deliberately. No automatic retry was made.`
      : msg;
    setReviewError({ key: `${origin.boardId}:${origin.meetingId}:${origin.recId}:${origin.user}:${origin.token !== undefined ? origin.token : fullIdentityToken()}`, message });
  };
  const itemApprove = (itemId: string) => {
    if (!recOk || !canManageMeeting) return;
    const d = recReview.data?.draft ?? recDetail.data;
    if (!d) return;
    if (d.boardId !== boardId || d.meetingId !== meetingId) return;
    const origin = captureRecOrigin();
    post<unknown>(`/api/records/${d.id}/items/approve`, { ...guardOf(d), itemId })
      .then((r) => {
        const live = liveSelRef.current;
        if (!recOriginLive(origin)) return;
        applyDraft(r);
        const st = (r as unknown as RecordDraft)?.status;
        notify(st === "approved" ? `Approved ${itemId}; review complete.` : `Approved ${itemId}.`);
      })
      .catch((e) => {
        const live = liveSelRef.current;
        if (!recOriginLive(origin)) return;
        noteReviewError(e, origin);
      });
  };
  const itemRevise = (itemId: string) => {
    if (!recOk || !canManageMeeting) return;
    const d = recReview.data?.draft ?? recDetail.data;
    if (!d) return;
    if (d.boardId !== boardId || d.meetingId !== meetingId) return;
    const reviseKey = editKey(d.id, itemId);
    const shown = itemTexts[reviseKey] ?? "";
    const revCap = itemTextRev.current[reviseKey] ?? 0;
    const text = shown.trim();
    if (!text) {
      alert("Revised text must be non-empty plain text.");
      return;
    }
    const origin = captureRecOrigin();
    const originDraftId = d.id;
    post<unknown>(`/api/records/${d.id}/items/revise`, { ...guardOf(d), itemId, text })
      .then((r) => {
        const live = liveSelRef.current;
        if (!recOriginLive(origin)) return;
        applyDraft(r);
        // Delete only the submitted revision: newer typing in the same box (including an X->Z->X retype or trim-equivalent edit) survives a held success. Pure updater (StrictMode-safe).
        if ((itemTextRev.current[reviseKey] ?? 0) !== revCap) return;
        setItemTexts((old) => {
          if ((old[reviseKey] ?? "") !== shown) return old;
          const next = { ...old };
          delete next[reviseKey];
          return next;
        });
        delete itemTextRev.current[reviseKey];
        notify(`Revised ${itemId}; approved text untouched.`);
      })
      .catch((e) => {
        const live = liveSelRef.current;
        if (!recOriginLive(origin)) return;
        noteReviewError(e, origin);
      });
  };
  const itemDiscard = (itemId: string) => {
    if (!recOk || !canManageMeeting) return;
    const d = recReview.data?.draft ?? recDetail.data;
    if (!d) return;
    if (d.boardId !== boardId || d.meetingId !== meetingId) return;
    const origin = captureRecOrigin();
    post<unknown>(`/api/records/${d.id}/items/discard`, { ...guardOf(d), itemId })
      .then((r) => {
        const live = liveSelRef.current;
        if (!recOriginLive(origin)) return;
        applyDraft(r);
        notify(`Discarded ${itemId}; approved items preserved.`);
      })
      .catch((e) => {
        const live = liveSelRef.current;
        if (!recOriginLive(origin)) return;
        noteReviewError(e, origin);
      });
  };
  const approveAllFresh = () => {
    if (!recOk || !canManageMeeting) return;
    const d = recReview.data?.draft ?? recDetail.data;
    if (!d) return;
    if (d.boardId !== boardId || d.meetingId !== meetingId) return;
    const origin = captureRecOrigin();
    post<unknown>(`/api/records/${d.id}/approve-all`, guardOf(d))
      .then((r) => {
        const live = liveSelRef.current;
        if (!recOriginLive(origin)) return;
        applyDraft(r);
        notify("Approved all pending items.");
      })
      .catch((e) => {
        const live = liveSelRef.current;
        if (!recOriginLive(origin)) return;
        noteReviewError(e, origin);
      });
  };
  const approveRec = (all: boolean) => {
    if (!recOk || !canManageMeeting) return;
    const d = recReview.data?.draft ?? recDetail.data;
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
    const origin = captureRecOrigin();
    const originDraftId = d.id;
    post<unknown>(`/api/meetings/${origin.meetingId}/record/approve`, {
      draftId: originDraftId,
      version: d.version,
      hash: d.hash,
      reviewToken: d.reviewToken,
      watermark: d.watermark,
      itemIds: ids,
    })
      .then((r) => {
        const live = liveSelRef.current;
        if (!recOriginLive(origin)) return;
        applyDraft({ ...(d as RecordDraft), ...((r as unknown as { draft?: string })?.draft ? {} : {}) });
        const parsed = r as unknown as { approved?: string[]; draft?: string; status?: string; pending?: string[] } | undefined;
        const keyId = parsed?.draft ?? originDraftId;
        void keyId;
        refresh("records", "record");
        void recReview.refetch();
        notify(`Approved ${ids.length} item(s).`);
      })
      .catch((e) => {
        const live = liveSelRef.current;
        if (!recOriginLive(origin)) return;
        noteReviewError(e, origin);
      });
  };
  const reviseRec = (amend: boolean) => {
    if (!recOk || !canActMeeting) return;
    const d = recReview.data?.draft ?? recDetail.data;
    if (!d) return;
    if (d.boardId !== boardId || d.meetingId !== meetingId) return;
    let items: unknown = [];
    try {
      items = JSON.parse(revText);
    } catch {
      alert("Revision body must be JSON.");
      return;
    }
    const origin = captureRecOrigin();
    const submittedRevTextRev = revTextRev.current;
    const submittedRevOwner = revTextOwner.current;
    void submittedRevTextRev;
    void submittedRevOwner;
    post<RecordDraft>(`/api/records/${d.id}/${amend ? "amend" : "revise"}`, {
      ...guardOf(d),
      items,
    })
      .then((r) => {
        const keyMeeting = (r as RecordDraft)?.meetingId ?? origin.meetingId;
        const keyBoard = (r as RecordDraft)?.boardId ?? origin.boardId;
        const live = liveSelRef.current;
        if (!recOriginLive(origin)) return;
        if (live.boardId !== keyBoard || live.meetingId !== keyMeeting) return;
        qc.setQueryData<RecordDraft[] | undefined>(
          ["records", keyMeeting],
          (old) => (old ? [...old.filter((x) => x.id !== r.id), r] : [r]),
        );
        qc.setQueryData(["record", r.id], r);
        // Whole-draft editor ownership: cache the created version but
        // preserve newer typing. Only auto-select when the editor still
        // holds the submitted revision; a deliberate record selection later
        // replaces via the owned hydration effect above.
        if (revTextRev.current !== submittedRevTextRev) {
          refresh("records", "record");
          void recReview.refetch();
          return;
        }
        setRecId(r.id);
        refresh("records", "record");
        void recReview.refetch();
      })
      .catch((e) => {
        const live = liveSelRef.current;
        if (!recOriginLive(origin)) return;
        noteReviewError(e, origin);
      });
  };
  const discardRec = () => {
    if (!recOk || !canActMeeting || !recDetail.data) return Promise.resolve();
    const d = recReview.data?.draft ?? recDetail.data;
    if (d.boardId !== boardId || d.meetingId !== meetingId) return Promise.resolve();
    const origin = captureRecOrigin();
    return post<unknown>(`/api/records/${d.id}/discard`, guardOf(d))
      .then((r) => {
        const live = liveSelRef.current;
        if (!recOriginLive(origin)) return;
        applyDraft(r);
      })
      .catch((e) => {
        const live = liveSelRef.current;
        if (!recOriginLive(origin)) return;
        noteReviewError(e, origin);
      });
  };  const [draftItems, setDraftItems] = useState(
    '[{"id":"1","text":"","detail":"","status":"proposed","scope":"meeting"}]',
  );
  const prepareDraft = () => {
    if (!boardId || !meetingId || !boardOk || !meetingOk || !canActMeeting) return;
    const origin = captureRecOrigin();
    return post<RecordDraft>(
      `/api/meetings/${origin.meetingId}/record/draft`,
      JSON.parse(draftItems),
    )
      .then((r) => {
        // Never seed caches, select, or render under a stale identity or
        // selection: an account switch or navigation while saving discards.
        const keyMeeting = (r as RecordDraft)?.meetingId ?? origin.meetingId;
        const keyBoard = (r as RecordDraft)?.boardId ?? origin.boardId;
        const live = liveSelRef.current;
        if (!recOriginLive(origin)) return;
        if (live.boardId !== keyBoard || live.meetingId !== keyMeeting) return;
        qc.setQueryData<RecordDraft[] | undefined>(
          ["records", keyMeeting],
          (old) => (old ? [...old.filter((x) => x.id !== r.id), r] : [r]),
        );
        qc.setQueryData(["record", r.id], r);
        setRecId(r.id);
        refresh("records", "record");
      })
      .catch((e) => {
        if (!recOriginLive(origin)) return;
        const msg = String(e);
        setReviewError({ key: `${origin.boardId}:${origin.meetingId}:${origin.recId}:${origin.user}:${(origin as any).token ?? fullIdentityToken()}`, message: msg });
      });
  };
  const invites = useQuery({
    queryKey: ["invites", boardId],
    queryFn: () => get<Invite[]>(`/api/boards/${boardId}/invites`),
    enabled: !!boardId && boardOk && canManageBoard && !sessGate && tab === "people",
  });
  const grants = useQuery({
    queryKey: ["grants", boardId],
    queryFn: () => get<Grant[]>(`/api/boards/${boardId}/grants`),
    enabled: !!boardId && boardOk && canManageBoard && !sessGate && tab === "people",
  });
  const [iemail, setIemail] = useState("");
  const [irole, setIrole] = useState("contributor");
  const invite = useMutation({
    mutationFn: () =>
      post<Invite>(`/api/boards/${boardId}/invites`, {
        email: iemail,
        role: irole,
        meetingId: meetingId || undefined,
      }),
    onSuccess: () => {
      setIemail("");
      refresh("invites");
    },
    onError: (e) => toastErr(e),
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
    onError: (e) => toastErr(e),
  });
  const audit = useQuery({
    queryKey: ["audit"],
    queryFn: () =>
      get<{ action: string; detail: string; createdAt: string }[]>(
        "/api/activity/audit",
      ),
    enabled: tab === "activity" && capsAdmin && !sessGate,
  });
  const modelCalls = useQuery({
    queryKey: ["modelcalls", boardId, effUsageScope, usageMeeting, usagePurpose, uday, ufrom, uto],
    queryFn: () => {
      const params: Record<string, string> = { summary: "true", limit: "200" };
      if (effUsageScope !== "installation" && boardId) params.boardId = boardId;
      if (effUsageScope === "meeting" && usageMeeting) params.meetingId = usageMeeting;
      if (usagePurpose) params.purpose = usagePurpose;
      if (uday) params.day = uday;
      if (ufrom) params.from = ufrom;
      if (uto) params.to = uto;
      return get<ModelCallsEnvelope>(`/api/models/calls?${new URLSearchParams(params)}`);
    },
    enabled: tab === "activity" && (effUsageScope === "installation" ? capsAdmin : (!!boardId && boardOk)) && (effUsageScope !== "meeting" || !!usageMeeting) && !sessGate,
  });
  const retryJob = (j: Job) =>
    post<Job>(`/api/jobs/${j.id}/retry`, {})
      .then(() => refresh("jobs"))
      .catch((e) => toastErr(e));
  const spending = useQuery({
    queryKey: ["spending"],
    queryFn: () => get<Spending>("/api/spending"),
    enabled: tab === "activity" && capsAdmin && !sessGate,
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
      put<unknown>("/api/spending", {
        monthlyCapUsd: capInput.trim() === "" ? null : Number(capInput),
        mode: capMode,
      }),
    onSuccess: () => refresh("spending"),
    onError: (e) => toastErr(e),
  });
const modelStatus = useQuery({
  queryKey: ["model-status"],
  queryFn: () => get<ModelStatus>("/api/model/status"),
  // Installation-admin only: verified via board-scope caps. Never probe for
  // readers, guests, or anonymous identities.
  enabled: !!boardId && boardOk && capsAdmin && !sessGate,
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
    put<unknown>("/api/model/settings", { apiKey: modelKey, chatModel: modelChat }),
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
    retry: false,
    enabled: !sessGate && !anonPrivateBlocked,
  });
  type VoiceOp = {
    id: number;
    boardId: string;
    meetingId: string;
    navGen: number;
    // Originating identity: late callbacks after an account switch or token
    // refresh never touch UI, storage, or newer ops (Auth8 boundary).
    epoch: number;
    token: string;
    user: string;
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
  // Visible pending while awaiting microphone permission: Cancel is usable
  // before getUserMedia resolves, during recording, and during transcription.
  const [voiceStarting, setVoiceStarting] = useState(false);
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
    setVoiceStarting(false);
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
      setVoiceStarting(false);
    }
  };
  // Usable Cancel: discards the active dictation op during permission wait,
  // recording, or transcription/held body. Never auto-sends; a late permission
  // stream or completion finds a nulled owner and disposes silently. Only the
  // owning op's tracks are stopped.
  const cancelVoice = () => {
    if (!voiceOpRef.current && !voiceStartingRef.current) return;
    cancelActiveVoiceOp(true);
  };
  const isOpAlive = (op: VoiceOp): boolean => {
    if (op.cancelled) return false;
    if (!voiceMountedRef.current) return false;
    if (voiceOpRef.current?.id !== op.id) return false;
    if (voiceNavGenRef.current !== op.navGen) return false;
    if (epochNow() !== op.epoch || currentToken() !== op.token || currentUser() !== op.user) return false;
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
    // Capture originating identity; every late callback rechecks it.
    const opEpoch = epochNow(); const opToken = currentToken(); const opUser = currentUser();
    const op: VoiceOp = {
      id: myId,
      boardId: originBoardId,
      meetingId: originMeetingId,
      navGen: voiceNavGenRef.current,
      epoch: opEpoch,
      token: opToken,
      user: opUser,
      stream: null,
      recorder: null,
      chunks: [],
      timer: null,
      abort,
      cancelled: false,
    };
    voiceOpRef.current = op;
    voiceStartingRef.current = true;
    setVoiceStarting(true);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (isOwnerOp(op) && voiceMountedRef.current && voiceNavGenRef.current === op.navGen
        && epochNow() === op.epoch && currentToken() === op.token && currentUser() === op.user) {
        const live = liveSelRef.current;
        if (live.boardId === op.boardId && live.meetingId === op.meetingId) {
          endVoiceOp(op, "Microphone unavailable or permission denied. Grant microphone access, then choose Record again.");
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
        // Canonical identity transport: captures Bearer/token/user before the
        // request and rechecks after the full body read; a same-user new
        // token, an account switch, or expiry invalidates this op instead of
        // posting another identity transcript into the draft. 401 joins the
        // central session transition like every other private call.
        const r = await fetchAuth<{ transcript: string }>(`/api/meetings/${op.meetingId}/transcribe`, {
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
        // Stale-identity completions (same-user new token, account switch,
        // expiry) end silently: the central transition already purged or
        // replaced this op, and its transcript must never touch the draft.
        {
          const emsg = e instanceof Error ? e.message : String(e);
          const staleFlag = (e as { stale?: boolean } | null)?.stale === true;
          if (staleFlag || /stale (response|401|blob|download) discarded/i.test(emsg)) {
            if (isOwnerOp(op)) endVoiceOp(op);
            return;
          }
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
          endVoiceOp(op, "Microphone unavailable or permission denied. Grant microphone access, then choose Record again.");
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
      setVoiceStarting(false);
      return;
    }
    setRecording(true);
    setVoiceStarting(false);
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
      .catch((e) => toastErr(e));
  const [recallQ, setRecallQ] = useState("");
  const [recallHits, setRecallHits] = useState<
    { kind: string; ref: string; text: string; score: number }[]
  >([]);
  const runRecall = () =>
    get<{ kind: string; ref: string; text: string; score: number }[]>(
      `/api/boards/${boardId}/recall?q=${encodeURIComponent(recallQ)}`,
    )
      .then(setRecallHits)
      .catch((e) => toastErr(e));
  const [expText, setExpText] = useState("");
  const [expHash, setExpHash] = useState("");
  const doExport = () =>
    get<{ snapshot: string; hash: string }>(`/api/boards/${boardId}/export`)
      .then((r) => {
        setExpText(r.snapshot);
        setExpHash(r.hash);
      })
      .catch((e) => toastErr(e));
  const doImport = () =>
    post<unknown>("/api/boards/import", { snapshot: expText, hash: expHash, accountId })
      .then(() => {
        refresh("boards");
        notify("Imported as a new board; advisors need re-approval.");
      })
      .catch((e) => toastErr(e));
  const [bakText, setBakText] = useState("");
  const [bakHash, setBakHash] = useState("");
  const doBackup = () =>
    get<{ snapshot: string; hash: string }>(`/api/backup`)
      .then((r) => {
        setBakText(r.snapshot);
        setBakHash(r.hash);
      })
      .catch((e) => toastErr(e));
  // Central UI/domain-generation boundary for a CONFIRMED successful restore:
  // invalidates outstanding transport callbacks (global epoch), query/media/
  // voice/hub state, and Secretary pending/hydration/envelope intent, then
  // reconciles fresh server data. Unsent composer/manual drafts are preserved
  // (no localStorage wipe, no credential clearing); Secretary recovery
  // envelopes are invalidated so a held pre-restore success with unchanged
  // IDs cannot apply afterwards. Genuine restore errors stay visible and
  // never claim a rollback.
  const domainRestoredTransition = () => {
    try { window.dispatchEvent(new CustomEvent("simceo-hub-stop")); } catch {}
    try { (window as unknown as { __simceoAbort?: AbortController }).__simceoAbort?.abort(); } catch {}
    try { for (const u of ((window as unknown as { __simceoBlobs?: string[] }).__simceoBlobs ?? [])) { try { URL.revokeObjectURL(u); } catch {} } } catch {}
    try { (window as unknown as { __simceoBlobs?: string[] }).__simceoBlobs = []; } catch {}
    try { cancelActiveVoiceOp(true); } catch {}
    try { recRef.current = null; } catch {}
    try { (window as unknown as { __simceoEpoch?: number }).__simceoEpoch = (((window as unknown as { __simceoEpoch?: number }).__simceoEpoch) ?? 0) + 1; } catch {}
    try { secEpoch.current++; } catch {}
    try { secEnvelopeRev.current++; } catch {}
    try { secHydRef.current++; } catch {}
    try { secHistRef.current++; } catch {}
    try { secEditSess.current++; } catch {}
    try { secPendingRef.current = null; } catch {}
    try {
      const dropPrefixes = ["sec-envelope:", "sec-answer-envelope:", "sec-submit:", "sec-pending:"];
      const victims: string[] = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i) ?? "";
          if (dropPrefixes.some((pr) => k.startsWith(pr))) victims.push(k);
        }
      } catch {}
      for (const k of victims) { try { localStorage.removeItem(k); } catch {} }
    } catch {}
    try { setSecQuestion(""); } catch {}
    try { setSecRequestId(""); } catch {}
    try { setSecAnswer(""); } catch {}
    try { setSecError(""); } catch {}
    try { setSecOmitted([]); } catch {}
    try { secAnsOwnerReq.current = ""; secAnsOwnerHyd.current = false; secOmittedReq.current = ""; } catch {}
    try { setSecHistory(null); } catch {}
    try { setSecEditId(""); } catch {}
    try { setSecEditBody(""); } catch {}
    try { qc.cancelQueries(); } catch {}
    try { qc.invalidateQueries(); } catch {}
    try { window.dispatchEvent(new Event("simceo-domain-restored")); } catch {}
  };
  const doRestore = () =>
    post<unknown>("/api/backup/restore", { snapshot: bakText, hash: bakHash })
      .then(() => {
        try { domainRestoredTransition(); } catch {}
        try { qc.invalidateQueries(); } catch {}
        notify("Backup restored and hash-verified.");
      })
      .catch((e) => toastErr(e));
  const refresh = (...keys: string[]) =>
    keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  // Canonical meta refresh on research transitions: a live run that lands a
  // terminal version, or a version bump under the open row, invalidates the
  // cached roster families so the owned GET snapshot and the row meta
  // converge instead of the banner reverting to stale cached claims.
  const prevResearchRunRef = useRef<boolean>(false);
  const prevResearchVerRef = useRef<number | null>(null);
  useEffect(() => {
    try {
      const d = selResearchData as any;
      if (!selRow || !d) {
        try { prevResearchRunRef.current = isRosterResearchRunning(d); } catch {}
        return;
      }
      const running = isRosterResearchRunning(d);
      const ver = typeof d?.version === "number" ? d.version : null;
      const wasRunning = prevResearchRunRef.current;
      const prevVer = prevResearchVerRef.current;
      if (wasRunning && !running) {
        try { refresh("roster", "roster-names", "roster-count"); } catch {}
      }
      if (ver !== null && prevVer !== null && ver !== prevVer) {
        try { refresh("roster", "roster-names"); } catch {}
      }
      prevResearchRunRef.current = running;
      if (ver !== null) prevResearchVerRef.current = ver;
    } catch {}
  }, [selResearchData, selRow?.entry.id]);
  const toggleBoardAdvisor = async (row: RosterRow) => {
    const existing = (advisors.data ?? []).find((a) => a.rosterEntryId === row.entry.id);
    try {
      if (existing) {
        await del<unknown>(`/api/boards/${boardId}/advisors/${existing.id}`);
      } else {
        await post<unknown>(`/api/roster/${row.entry.id}/copy`, { boardId, boardRole: row.entry.name });
      }
      refresh("advisors", "roster", "roster-names", "setup");
    } catch (e) {
      toastErr(e);
    }
  };
  const [meetPicks, setMeetPicks] = useState<string[]>([]);
  const toggleMeetPick = (id: string) => {
    const all = (advisors.data ?? []).map((a) => a.id);
    if (meetPicks.length === 0) setMeetPicks(all.filter((x) => x !== id));
    else if (meetPicks.includes(id)) setMeetPicks(meetPicks.filter((x) => x !== id));
    else setMeetPicks([...meetPicks, id]);
  };
  // Selected-meeting participant draft: hydrated from the meeting stored
  // participantIdsJson and reset whenever the meeting (or its stored list)
  // changes. Empty means everyone, matching the server convention. This is
  // separate from meetPicks, which only seeds newly created meetings.
  const [meetPartDraft, setMeetPartDraft] = useState<string[]>([]);
  const [meetPartKey, setMeetPartKey] = useState("");
  useEffect(() => {
    const rawIds = (curMeeting as MeetingFull | undefined)?.participantIdsJson ?? "";
    const key = meetingId + ":" + rawIds;
    if (key === meetPartKey) return;
    setMeetPartKey(key);
    try {
      const arr = JSON.parse(rawIds || "[]");
      setMeetPartDraft(Array.isArray(arr) ? arr.map((x) => String(x)) : []);
    } catch {
      setMeetPartDraft([]);
    }
  }, [meetingId, curMeeting, meetPartKey]);
  // Never silently revert to everyone: refusing the uncheck that would
  // empty the list (an empty list means unrestricted, server convention).
  const toggleMeetPart = (id: string) => {
    const all = (advisors.data ?? []).map((a) => a.id);
    if (meetPartDraft.length === 0) {
      const next = all.filter((x) => x !== id);
      if (next.length === 0) return;
      setMeetPartDraft(next);
    }
    else if (meetPartDraft.includes(id)) {
      if (meetPartDraft.length === 1) return;
      setMeetPartDraft(meetPartDraft.filter((x) => x !== id));
    }
    else setMeetPartDraft([...meetPartDraft, id]);
  };
  const { advisorSnapshot, secretaryActivity, activityAvailability } = useMeetingActivity({
    boardId: boardId,
    meetingId: meetingId,
    boardValid: boardValid,
    meetingValid: meetingValid,
    sessGate: sessGate,
    tab: tab,
    get: get,
    isOriginStale: originStale,
    originOf: originIdentity,
    originRevision: originRevision(),
    live: live,
  });
  // Meeting presence rail data: every board seat (included and excluded) plus
  // the secretary seat, from data App already owns. Per-seat activity is
  // idle/excluded until the backend activity snapshot/events land; approval
  // is never shown as responding and no global pending flag is consulted.
  const presenceEntries = useMemo(() => tab === "meet" ? (((advisors.data as AdvisorFull[] | undefined) ?? []).filter((a) => !a.removed).map((a) => ({ key: a.id, displayImageId: ((a as AdvisorFull).displayPortraitImageId ?? null) as string | null }))) : [], [tab, advisors.data]);
  const advisorsTick = (advisors as unknown as { dataUpdatedAt?: number })?.dataUpdatedAt ?? 0;
  const presenceUrls = useDisplayPortraits(boardId, presenceEntries, portraitRev, advisorsTick);
  const presence = useMemo(() => buildPresence({
    leadName: lead.data?.name ?? "",
    leadRoleLabel: lead.data ? lead.data.roleLabel + " \u00B7 You" : "Board lead",
    advisors: (((advisors.data as AdvisorFull[] | undefined) ?? []).filter((a) => !a.removed).map((a) => ({ id: a.id, boardRole: a.boardRole, approved: a.approved, portraitUrl: presenceUrls.get(a.id) ?? null }))),
    includedIds: meetPartDraft,
    snapshot: advisorSnapshot as any,
    availability: (activityAvailability as any) ?? "available",
    secretaryActivity: (secretaryActivity as any) ?? null,
  }), [lead.data, advisors.data, meetPartDraft, presenceUrls, advisorSnapshot, activityAvailability, secretaryActivity]);
  const presenceWithSecretary = useMemo(() => presence, [presence]);
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
  const submitBusyRef = useRef(false);
  const submitOpRef = useRef<string | null>(null);
  const [sendPhase, setSendPhase] = useState("idle");
  const [sendStatus, setSendStatus] = useState("");
  const [sendRetryCtx, setSendRetryCtx] = useState<any>(null);
  const [sendConflict, setSendConflict] = useState<null | { kind: string }>(null);
  const phaseOpRef = useRef<string | null>(null);
  const chainedOpRef = useRef<string | null>(null);
  useEffect(() => { setSendPhase("idle"); setSendStatus(""); setSendRetryCtx(null); setSendConflict(null); submitBusyRef.current = false; submitOpRef.current = null; phaseOpRef.current = null; chainedOpRef.current = null; }, [boardId, meetingId]);
  const pipelineOwns = (op: unknown, pack: { origin?: any; originBoardId?: string; originMeetingId?: string; originUser?: string; originEpoch?: number }): boolean => {
    if (typeof op !== "string" || !op || submitOpRef.current !== op) return false;
    if (!pack || !pack.origin || originStale(pack.origin)) return false;
    const live = liveSelRef.current;
    if (live.boardId !== pack.originBoardId || live.meetingId !== pack.originMeetingId) return false;
    if (secIdentity() !== pack.originUser || pack.originEpoch !== secEpoch.current) return false;
    return true;
  };
  const showPhase = (op: string, phase: "sending" | "working" | "complete" | "no-contributions" | "error", status: string): void => {
    phaseOpRef.current = op;
    setSendPhase(phase);
    setSendStatus(status);
  };
  const takePipeline = (op: string, phase: "sending" | "working", status: string): void => {
    submitBusyRef.current = true;
    submitOpRef.current = op;
    phaseOpRef.current = op;
    setSendPhase(phase);
    setSendStatus(status);
  };
  const settlePipeline = (op: unknown, phase: "complete" | "no-contributions" | "error", status: string, retryCtx: any): boolean => {
    if (typeof op !== "string" || !op || submitOpRef.current !== op) return false;
    submitBusyRef.current = false;
    submitOpRef.current = null;
    phaseOpRef.current = null;
    if (chainedOpRef.current === op) chainedOpRef.current = null;
    setSendPhase(phase);
    setSendStatus(status);
    setSendRetryCtx(retryCtx);
    return true;
  };
  const retirePipeline = (op: unknown): void => {
    if (typeof op !== "string" || !op) return;
    if (submitOpRef.current === op) { submitBusyRef.current = false; submitOpRef.current = null; }
    if (chainedOpRef.current === op) { chainedOpRef.current = null; }
    if (phaseOpRef.current === op) { phaseOpRef.current = null; setSendPhase("idle"); setSendStatus(""); setSendRetryCtx(null); setSendConflict(null); }
  };
  const parseRunError = (e: unknown): { status: number; serverError: string; serverFixes: string[]; hay: string } => {
    const raw = String((e as any)?.message ?? e);
    const m = /^(\d{3})\s([\s\S]*)$/.exec(raw);
    const status = m ? parseInt(m[1], 10) : 0;
    const bodyText = m ? m[2] : raw;
    let serverError = "";
    let serverFixes: string[] = [];
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed && typeof parsed.error === "string") serverError = parsed.error;
      if (Array.isArray(parsed?.fixes)) serverFixes = parsed.fixes.filter((x: unknown) => typeof x === "string");
    } catch { /* body is not JSON: match on text */ }
    return { status, serverError, serverFixes, hay: (serverError + " " + bodyText).toLowerCase() };
  };
  const runErrorKind = (e: unknown): string | null => {
    const p = parseRunError(e);
    if (p.hay.includes("lead profile changed")) return "lead-version";
    return null;
  };
  const runErrorMessage = (e: unknown, leadSaved: boolean): string => {
    const p = parseRunError(e);
    const status = p.status;
    const hay = p.hay;
    const definitive = status >= 400 && status < 500;
    if (status === 401 || (definitive && hay.includes("authentication required"))) return "Your session changed. Sign in again, then retry responses.";
    if (status === 403 || (definitive && (hay.includes("not granted") || hay.includes("access revoked") || hay.includes("denied")))) return "Access changed for this meeting. Reopen it from Boards, then retry.";
    if (status === 404 || (definitive && hay.includes("meeting is gone"))) return "This meeting is gone. Reopen it from Boards.";
    if (hay.includes("lead profile changed")) return "Lead profile changed since you sent. Review the current lead profile, then retry with the current version.";
    if (hay.includes("already in progress")) return "A response run is already in progress for this meeting. Wait for it to finish.";
    if (hay.includes("no advisors available")) {
      if (p.serverFixes.some((x) => x.toLowerCase().includes("re-pick"))) return "No selected participants can respond. Re-pick participants from this board\u2019s current advisors, then retry.";
      return "No approved advisors yet. Approve at least one advisor on this board, then retry.";
    }
    if (hay.includes("paused")) return "Meeting is paused. Resume it, then retry responses.";
    if (hay.includes("interrupted")) return "The run was interrupted by a meeting change or a new message. Review the latest messages, then retry responses.";
    if (status === 402 || hay.includes("usage cap") || hay.includes("cap exceeded")) return "Advisor usage cap reached. Check spending, then retry later.";
    if (status === 502 || status === 503 || hay.includes("provider") || hay.includes("model service") || hay.includes("unavailable")) return leadSaved ? "Advisor service is unavailable right now. The lead message is saved; retry responses shortly." : "Advisor service is unavailable right now. Retry responses shortly.";
    return leadSaved ? "Could not get advisor responses. The lead message is saved; retry responses." : "Could not get advisor responses. Retry responses shortly.";
  };
  const sendErrorMessage = (e: unknown): string => {
    const raw = String((e as any)?.message ?? e);
    const m = /^(\d{3})\s([\s\S]*)$/.exec(raw);
    if (m) {
      const status = parseInt(m[1], 10);
      const hay = m[2].toLowerCase();
      if (status === 401 || ((status >= 400 && status < 500) && hay.includes("authentication required"))) return "Your session changed. Sign in again, then resend your message.";
      if (status === 403 || ((status >= 400 && status < 500) && (hay.includes("not granted") || hay.includes("access revoked") || hay.includes("denied")))) return "Access changed for this meeting. Reopen it from Boards, then resend.";
      if (status === 404 || ((status >= 400 && status < 500) && hay.includes("meeting is gone"))) return "This meeting is gone. Reopen it from Boards.";
      return "Could not confirm your message was saved. The server response was unclear: check the conversation and resend only if it does not appear.";
    }
    return "Could not confirm your message was saved. Check the conversation: if it appears, do not resend; otherwise resend.";
  };
  const briefErrorMessage = (e: unknown): string => {
    const raw = String((e as any)?.message ?? e);
    const m = /^(\d{3})\s([\s\S]*)$/.exec(raw);
    const hay = (m ? m[2] : raw).toLowerCase();
    const status = m ? parseInt(m[1], 10) : 0;
    const definitive = status >= 400 && status < 500;
    if (status === 401 || (definitive && hay.includes("authentication required"))) return "Your session changed. Sign in again, then retry responses.";
    if (status === 403 || (definitive && (hay.includes("not granted") || hay.includes("access revoked") || hay.includes("denied") || hay.includes("contribute")))) return "Only contributors can save the brief. Ask a contributor to add a brief, then retry responses.";
    if (status === 409) {
      const hay409 = hay;
      if (hay409.includes("already set") || hay409.includes("already updated")) return "The brief was already updated. Your question is saved; review the current brief, then retry responses.";
      if (hay409.includes("superseded") || hay409.includes("newer message")) return "A newer message was sent. Your question is saved; review the latest messages, then retry responses.";
      if (hay409.includes("meeting changed")) return "The meeting changed. Your question is saved; review and retry responses.";
      if (hay409.includes("restored")) return "The workspace was restored. Your question is saved; reopen it from Boards, then retry responses.";
      return "Your message was saved but the brief could not be updated. Retry responses.";
    }
    return "Your message was saved but the brief could not be updated. Retry responses.";
  };
  const send = useMutation({
    mutationFn: (v: any) => {
      // Queued-attempt validation: a paused (offline) dispatch posts exactly the click-time snapshot, never resume-time composer or selection refs.
      if (!v || !v.submitOp || submitOpRef.current !== v.submitOp) throw Object.assign(new Error('Message send retired before dispatch.'), { stale: true });
      if (v.boardId !== boardId || v.meetingId !== meetingId || secIdentity() !== v.user || secEpoch.current !== v.epoch || originStale(v.origin)) throw Object.assign(new Error('Message send retired before dispatch.'), { stale: true });
      // Frozen click-time payload (never resume-time refs).
      const originBoardId = v.boardId;
      const originMeetingId = v.meetingId;
      const originUser = v.user;
      const originEpoch = v.epoch;
      const submittedDraft = v.draft || '';
      const submitVer = v.submitVer;
      const originCap = v.origin;
      const replySeq = v.replySeq ?? null;
      const leadVersionAtClick = (v.leadVersion !== undefined && v.leadVersion !== null) ? v.leadVersion : null;
      const policyAtClick = v.policy ? v.policy : policy;
      const briefAtClick = v.briefAtClick ? v.briefAtClick : "";
      const meetingStateAtClick = v.meetingStateAtClick;
      const canContributeAtClick = !!v.canContributeAtClick;
      if (!submittedDraft.trim()) throw Object.assign(new Error('Message send retired before dispatch.'), { stale: true });
      return post<Msg>(`/api/meetings/${originMeetingId}/messages`, {
        sender: "lead",
        content: submittedDraft,
        parentSequence: replySeq,
      }).then((r) => ({ r, originBoardId, originMeetingId, originUser, originEpoch, submittedDraft, submitVer, origin: originCap, submitOp: v.submitOp, leadVersion: leadVersionAtClick, policy: policyAtClick, briefAtClick: briefAtClick, meetingStateAtClick: meetingStateAtClick, canContributeAtClick: canContributeAtClick }));
    },
    onMutate: (v: any) => ({ originBoardId: v.boardId, originMeetingId: v.meetingId, originUser: v.user, originEpoch: v.epoch, origin: v.origin, submitOp: v.submitOp, retired: !v || v.boardId !== boardId || v.meetingId !== meetingId || v.user !== secIdentity() || v.epoch !== secEpoch.current || originStale(v.origin) }),
    onSuccess: (pack: any, _v: unknown, ctx: unknown) => {
      { const __o = ctx as any; if (__o && (__o as any).retired) return; }
      if (!(pack as any)?.origin || originStale((pack as any).origin)) return;
      const live = liveSelRef.current;
      let liveUser = secIdentity();
      if (live.boardId !== (pack as any)?.originBoardId || live.meetingId !== (pack as any)?.originMeetingId || liveUser !== (pack as any)?.originUser || (pack as any)?.originEpoch !== secEpoch.current) return;
      if (draft === (pack as any)?.submittedDraft && secDraftVer.current === (pack as any)?.submitVer) { setDraft(""); setReplyTo(null); }
      refresh("messages");
      if (!pipelineOwns((pack as any)?.submitOp, pack as any)) return;
      const st = (pack as any)?.meetingStateAtClick;
      const op = (pack as any)?.submitOp;
      if (!meetingSendOpen(st)) { settlePipeline(op, "error", "Meeting is not open for advisor responses.", null); setSendConflict(null); return; }
      const frozenPrompt = (pack as any)?.submittedDraft ?? "";
      const frozenLeadVersion = (pack as any)?.leadVersion ?? null;
      const frozenPolicy = (pack as any)?.policy ?? policy;
      const frozenBrief = (pack as any)?.briefAtClick ?? "";
      const frozenCanContribute = !!(pack as any)?.canContributeAtClick;
      const oB = (pack as any)?.originBoardId; const oM = (pack as any)?.originMeetingId; const oU = (pack as any)?.originUser; const oE = (pack as any)?.originEpoch; const oOrigin = (pack as any)?.origin;
      const savedLead = (pack as any)?.r ?? null;
      const savedSeq = (savedLead as any)?.sequence ?? (savedLead as any)?.Sequence ?? null;
      const savedContent = (savedLead as any)?.content ?? (savedLead as any)?.Content ?? frozenPrompt;
      const savedGen = (savedLead as any)?.generation ?? (savedLead as any)?.Generation ?? null;
      const savedRestoreId = (savedLead as any)?.restoreEpochId ?? (savedLead as any)?.RestoreEpochId ?? null;
      const savedRestoreRev = (savedLead as any)?.restoreEpochRev ?? (savedLead as any)?.RestoreEpochRev ?? null;
      const savedReplySeq = (_v as any)?.replySeq ?? null;
      const leadCtx = { boardId: oB, meetingId: oM, user: oU, epoch: oE, prompt: frozenPrompt, leadVersion: frozenLeadVersion, policy: frozenPolicy, origin: oOrigin, submitOp: op, saveConfirmed: true, replySeq: savedReplySeq, leadSequence: savedSeq, leadContent: savedContent, generation: savedGen, restoreEpochId: savedRestoreId, restoreEpochRev: savedRestoreRev };
      if (!String(frozenBrief ?? "").trim()) {
        if (!frozenCanContribute) { settlePipeline(op, "error", "Add a brief before requesting advisor responses.", leadCtx); setSendConflict(null); return; }
        showPhase(op, "working", "Requesting advisor responses...");
        chainedOpRef.current = op;
        const autoBrief = String(savedContent ?? frozenPrompt).slice(0, 800);
        const autoBody = { brief: autoBrief, briefAutoInit: true, expectedBrief: "", expectBriefEmpty: true, leadSequence: savedSeq, leadContent: savedContent, expectedGeneration: savedGen, restoreEpochId: savedRestoreId, restoreEpochRev: savedRestoreRev };
        patch("/api/meetings/" + oM, autoBody).then(() => {
          if (!pipelineOwns(op, pack as any)) { retirePipeline(op); return; }
          refresh("meetings", "meeting-detail");
          showPhase(op, "working", "Requesting advisor responses...");
          chainedOpRef.current = op; runDiscussion.mutate({ meetingId: oM, prompt: frozenPrompt, policy: frozenPolicy, leadVersion: frozenLeadVersion, origin: oOrigin, submitOp: op, boardId: oB, user: oU, epoch: oE, leadCtx: leadCtx });
        }).catch((pe: any) => {
          if ((pe as any)?.stale) { retirePipeline(op); return; }
          if (!pipelineOwns(op, pack as any)) { retirePipeline(op); return; }
          settlePipeline(op, "error", briefErrorMessage(pe), leadCtx);
        });
        return;
      }
      showPhase(op, "working", "Requesting advisor responses...");
      chainedOpRef.current = op; runDiscussion.mutate({ meetingId: oM, prompt: frozenPrompt, policy: frozenPolicy, leadVersion: frozenLeadVersion, origin: oOrigin, submitOp: op, boardId: oB, user: oU, epoch: oE, leadCtx: leadCtx });
    },
    onSettled: (_r: unknown, _e: unknown, _v: unknown, ctx: unknown) => { const o = ctx as any; if (!o || !o.submitOp) return; if (chainedOpRef.current === o.submitOp) return; retirePipeline(o.submitOp); },
    onError: (e, _v, ctx) => {
      const o = ctx as any;
      if ((e as any)?.stale) { retirePipeline((o as any)?.submitOp); return; }
      if (!o || !(o as any).origin || originStale((o as any).origin)) { retirePipeline((o as any)?.submitOp); return; }
      if ((ctx as any)?.retired) { retirePipeline((o as any)?.submitOp); return; }
      if (!pipelineOwns(o.submitOp, o)) { retirePipeline(o.submitOp); return; }
      settlePipeline(o.submitOp, "error", sendErrorMessage(e), null); setSendConflict(null);
    },
  });
  const [secQuestion, setSecQuestion] = useState("");
  const [secRequestId, setSecRequestId] = useState("");
  const [secAnswer, setSecAnswer] = useState("");
  const [secOmitted, setSecOmitted] = useState<string[]>([]);
  // Request owning the displayed omission manifest ("" = none/briefing-scoped).
  // Missing/invalid manifests are UNKNOWN and never fabricated as [].
  const secOmittedReq = useRef("");
  const [secError, setSecError] = useState("");
  const [secHistory, setSecHistory] = useState<any>(null);
  const [secEditId, setSecEditId] = useState("");
  const [secEditBody, setSecEditBody] = useState("");
  const secHasPrefix = (v: string) => { const t = (v ?? "").replace(/^\s+/, ""); return /^secretary,/i.test(t.slice(0, 10)) || /^secretary:/i.test(t.slice(0, 10)); };
  // Global canonical authority: Bearer session user precedes; otherwise the
  // explicitly APPLIED demo label. Unapplied draft text is never identity.
  const secIdentity = () => canonicalUser();
  type SecEnvelope = { identity: string; boardId: string; meetingId: string; requestId: string; nonce: string; input: string; evidence: any[]; phase: string; question: string; answer: string; epoch: number; submittedRev: number; omitted?: string[] };
  const secEnvelopeKey = (u: string, b: string, m: string) => "sec-envelope:" + u + ":" + b + ":" + m;
  const secAnsEnvelopeKey = (u: string, b: string, m: string) => "sec-answer-envelope:" + u + ":" + b + ":" + m;
  const readEnvelope = (key: string): SecEnvelope | null => { try { const raw = localStorage.getItem(key); if (!raw) return null; const p = JSON.parse(raw); if (!p || typeof p.nonce !== "string") return null; return p as SecEnvelope; } catch { return null; } };
  const secPendingRef = useRef<{ kind: string; id: string } | null>(null);
  const opSeq = useRef(0);
  const secEnvelopeRev = useRef(0);
  const secHydRef = useRef(0);
  const secHistRef = useRef(0);
  const secHistSel = useRef("");
  const secEditSess = useRef(0);
  const secComposerTouched = useRef(false);
  const secEditVisit = useRef(0);
  // Displayed-answer ownership: which request owns the answer input text and
  // whether it arrived via hydration (supersedable) or genuine typing.
  // Bytes alone never prove identity (X→Z→X retype), so replacements and the
  // answer-success clear require owner + secAnsVer freshness, not equality.
  const secAnsOwnerReq = useRef("");
  const secAnsOwnerHyd = useRef(false);
  const secLastHyd = useRef("");
  const secSubmitKey = (u: string, b: string, m: string) => "sec-submit:" + u + ":" + b + ":" + m;
  const secPendingKey = (u: string, b: string, m: string) => "sec-pending:" + u + ":" + b + ":" + m;
  const secEpoch = useRef(0);
  const secDraftVer = useRef(0);
  const secAnsVer = useRef(0);
  const secLastSel = useRef({ boardId: "", meetingId: "", identity: "" });
  // Omitted-manifest helpers (null = UNKNOWN manifest, never known-empty []).
  // The persisted contract exposes `omitted` as null when missing/invalid and
  // as an array when known (including known-empty). UNKNOWN preserves the
  // known same-request manifest or re-reads the persisted request under the
  // same origin/intent; it never substitutes [] and never erases a manifest.
  const parseOmittedManifest = (v: unknown): string[] | null => {
    try {
      // Strict known-manifest rule: a non-string element poisons the whole payload to UNKNOWN (null). [1] must never become known-empty [].
      if (Array.isArray(v)) { for (const x of v) if (typeof x !== "string") return null; return v as string[]; }
      if (typeof v === "string" && v) {
        try {
          const p = JSON.parse(v);
          if (Array.isArray(p)) { for (const x of p) if (typeof x !== "string") return null; return p as string[]; }
        } catch { /* invalid => unknown */ }
        return null;
      }
      return null;
    } catch { return null; }
  };
  const parseOmittedRow = (row: any): string[] | null => {
    try {
      if (!row || typeof row !== "object") return null;
      const top = (row as any).omitted !== undefined ? (row as any).omitted : (row as any).Omitted;
      if (top !== undefined && top !== null) {
        const p = parseOmittedManifest(top);
        if (p !== null) return p;
      }
      const j = (row as any).omittedJson !== undefined ? (row as any).omittedJson : (row as any).OmittedJson;
      if (typeof j === "string" && j) return parseOmittedManifest(j);
      if (Array.isArray(j)) return parseOmittedManifest(j);
      return null;
    } catch { return null; }
  };
  const fetchPersistedOmitted = (reqId: string, snap: { oB: string; oM: string; oU: string; oEp: number; oOrigin: { epoch: number; token: string; user: string }; envRev: number; hydRev: number }) => {
    try {
      if (!reqId) return;
      get<any>(`/api/meetings/${snap.oM}/secretary/requests/${reqId}`).then((body: any) => {
        if (secEnvelopeRev.current !== snap.envRev || secHydRef.current !== snap.hydRev) return;
        if (originStale(snap.oOrigin)) return;
        const live = liveSelRef.current;
        if (live.boardId !== snap.oB || live.meetingId !== snap.oM || secIdentity() !== snap.oU || snap.oEp !== secEpoch.current) return;
        // Single request GET carries the row shape: omittedJson fallback included.
        // Fallback persistence writes ONLY the currently matched request envelopes,
        // preserving every payload/nonce/answer byte; UNKNOWN never fabricates [].
        const om = parseOmittedRow(body);
        if (om === null) return;
        setSecOmitted(om); secOmittedReq.current = reqId;
        try {
          const ek = secEnvelopeKey(snap.oU, snap.oB, snap.oM);
          const ak = secAnsEnvelopeKey(snap.oU, snap.oB, snap.oM);
          const e1 = readEnvelope(ek);
          if (e1 && String(e1.requestId) === String(reqId)) { (e1 as SecEnvelope).omitted = om; try { localStorage.setItem(ek, JSON.stringify(e1)); } catch { /* noop */ } }
          const e2 = readEnvelope(ak);
          if (e2 && String(e2.requestId) === String(reqId)) { (e2 as SecEnvelope).omitted = om; try { localStorage.setItem(ak, JSON.stringify(e2)); } catch { /* noop */ } }
        } catch { /* preserve-only */ }
      }).catch(() => {});
    } catch { }
  };
  const adoptOmittedRow = (row: any, reqId: string, snap: { oB: string; oM: string; oU: string; oEp: number; oOrigin: { epoch: number; token: string; user: string } }) => {
    const om = parseOmittedRow(row);
    if (om !== null) { setSecOmitted(om); secOmittedReq.current = reqId || ""; return; }
    // Display adoption from the validated same-identity/board/meeting/request envelope (known [] preserved, UNKNOWN never fabricated) BEFORE the fallback GET.
    // Covers both row-reconciliation branches (arow + target) when the list row carries UNKNOWN metadata: the envelope rewrite above already preserved the
    // manifest in storage, so restore it to display here instead of leaving the warning lost while the fallback GET hangs/fails.
    try { const eIv = readEnvelope(secEnvelopeKey(snap.oU, snap.oB, snap.oM)); if (eIv && eIv.boardId === snap.oB && eIv.meetingId === snap.oM && eIv.identity === snap.oU && String(eIv.requestId) === String(reqId)) { const eIvOm = parseOmittedManifest((eIv as any)?.omitted); if (eIvOm !== null) { setSecOmitted(eIvOm); secOmittedReq.current = reqId || ""; return; } } } catch { /* preserve-only */ }
    try { const eAv = readEnvelope(secAnsEnvelopeKey(snap.oU, snap.oB, snap.oM)); if (eAv && eAv.boardId === snap.oB && eAv.meetingId === snap.oM && eAv.identity === snap.oU && String(eAv.requestId) === String(reqId)) { const eAvOm = parseOmittedManifest((eAv as any)?.omitted); if (eAvOm !== null) { setSecOmitted(eAvOm); secOmittedReq.current = reqId || ""; return; } } } catch { /* preserve-only */ }
    if (!reqId || (secOmittedReq.current || "") === (reqId || "")) return;
    fetchPersistedOmitted(reqId, { ...snap, envRev: secEnvelopeRev.current, hydRev: secHydRef.current });
  };
  const adoptOmittedResponse = (resp: any, reqId: string) => {
    // Replay/answer responses already carry the persisted truth: adopt known
    // manifests, preserve the display when the manifest is UNKNOWN.
    const om = parseOmittedManifest((resp as any)?.omitted) ?? parseOmittedRow(resp);
    if (om !== null) { setSecOmitted(om); secOmittedReq.current = reqId || ""; }
  };
  // Epoch/reset guard: data-query resolution (e.g. /auth/me settling) must
  // not clear live secretary inputs. Reset only when the effective selection
  // or the effective transport identity actually changes.
  useEffect(() => {
    const u = secIdentity();
    const last = secLastSel.current;
    if (last.boardId !== boardId || last.meetingId !== meetingId || last.identity !== u) {
      secLastSel.current = { boardId, meetingId, identity: u };
      secEpoch.current++;
      try { secComposerTouched.current = false; } catch { }
      try { secEditVisit.current++; } catch { }
      setSecQuestion(""); setSecRequestId(""); setSecAnswer(""); setSecError(""); setSecHistory(null); setSecOmitted([]); setSecEditId(""); setSecEditBody(""); secAnsOwnerReq.current = ""; secAnsOwnerHyd.current = false; secOmittedReq.current = "";
    }
  }, [boardId, meetingId, appliedActAs]);
  useEffect(() => {
    if (!meetingId || !boardId || !meetingOk) return;
    const u = secIdentity();
    const oEp = secEpoch.current;
    const hk = u + "|" + boardId + "|" + meetingId + "|" + oEp;
    if (secHydRef.current > 0 && (secLastHyd.current || "") === hk) return;
    secLastHyd.current = hk;
    const hid = ++secHydRef.current;
    const envRev0 = secEnvelopeRev.current;
    // Input-revision capture: every hydration write below must refuse to run
    // when the user typed after this point (composer draft, answer input, or
    // a same-user token change). A newer edit always wins over hydration.
    const dver0 = secDraftVer.current;
    const aver0 = secAnsVer.current;
    const tok0 = currentToken();
    // Pre-hydration answer snapshot for StrictMode-pure replacement below: the revision guards prove no typing interleaves after this point, so decisions use this value instead of mutating refs inside a state updater.
    let preHydAns = secAnswer;
    // Synchronous immutable-envelope restore: runs before any user input can
    // interleave. A saved answer envelope (requestId + accepted answer) is
    // restored into the inputs so a reload never loses the recovery payload.
    // Server reconciliation below only confirms, adopts, or clears it.
    try {
      // Synchronous envelope restore must never shadow a newer server row or
      // clobber typed input: only fill an untouched composer. Server
      // reconciliation below adopts, supersedes, or clears it.
      if (!secComposerTouched.current) {
        const aenv0 = readEnvelope(secAnsEnvelopeKey(u, boardId, meetingId));
        if (aenv0 && aenv0.boardId === boardId && aenv0.meetingId === meetingId && aenv0.identity === u && aenv0.requestId && aenv0.answer) {
          setSecQuestion(aenv0.question || ""); setSecRequestId(aenv0.requestId); setSecAnswer(aenv0.answer); preHydAns = aenv0.answer;
          secAnsOwnerReq.current = aenv0.requestId; secAnsOwnerHyd.current = true;
          try { const __om0 = parseOmittedManifest((aenv0 as any)?.omitted); if (__om0 !== null) { setSecOmitted(__om0); secOmittedReq.current = aenv0.requestId; } else { try { const __ienv0 = readEnvelope(secEnvelopeKey(u, boardId, meetingId)); if (__ienv0 && __ienv0.boardId === boardId && __ienv0.meetingId === meetingId && __ienv0.identity === u && String(__ienv0.requestId) === String(aenv0.requestId)) { const __omI0 = parseOmittedManifest((__ienv0 as any)?.omitted); if (__omI0 !== null) { setSecOmitted(__omI0); secOmittedReq.current = aenv0.requestId; } } } catch { /* preserve-only */ } } } catch { /* noop */ }
        }
      }
    } catch { }
    get<any>(`/api/meetings/${meetingId}/secretary/requests`).then((rs: any) => {
      if (hid !== secHydRef.current || envRev0 !== secEnvelopeRev.current || secComposerTouched.current || secDraftVer.current !== dver0 || secAnsVer.current !== aver0 || currentToken() !== tok0) return;
      const live = liveSelRef.current;
      let liveUser = secIdentity();
      if (live.boardId !== boardId || live.meetingId !== meetingId || liveUser !== u || oEp !== secEpoch.current) return;
      const statusOf = (r: any) => (r.status || r.Status);
      const list = Array.isArray(rs) ? rs : [];
      const mine = list.filter((r: any) => (r.boardId ?? r.BoardId) === boardId && (r.meetingId ?? r.MeetingId) === meetingId);
      const byTime = mine.slice().sort((a: any, b: any) => String(b.createdAt ?? b.CreatedAt ?? "").localeCompare(String(a.createdAt ?? a.CreatedAt ?? "")));
      const ienv = readEnvelope(secEnvelopeKey(u, boardId, meetingId));
      const aenv = readEnvelope(secAnsEnvelopeKey(u, boardId, meetingId));
      const matchRow = (env: SecEnvelope | null) => {
        if (!env) return null;
        if (env.requestId) { const hit = byTime.find((r: any) => String(r.id || r.Id) === String(env.requestId)); if (hit) return hit; }
        if (env.nonce) return byTime.find((r: any) => (r.clientNonce || r.ClientNonce) === env.nonce) ?? null;
        return null;
      };
      // Answer-envelope reconciliation: the saved requestId wins; a stored
      // nonce reconciles a lost response. Completed clears; recoverable
      // phases hydrate into a usable retry; the durable server answer is
      // adopted only into an empty input (never over user typing).
      const arow = matchRow(aenv);
      const tsOf = (r: any) => String(r.createdAt ?? r.CreatedAt ?? "");
      // Newest initial-phase failure (questionless). A stale answer
      // envelope from an older clarification must never shadow it.
      const initFail = byTime.find((r: any) => ["interrupted", "discarded", "failed"].includes(statusOf(r)) && !(r.question || r.Question));
      const arowFresh = !!arow && (!initFail || tsOf(arow) >= tsOf(initFail));
      // Newest-valid-active selection: a newer live clarification/recoverable row for a different request supersedes an older saved answer envelope.
      const isClarRow = (r: any) => statusOf(r) === "needs-clarification";
      const isRecovRow = (r: any) => ["interrupted", "discarded", "failed"].includes(statusOf(r)) && !!(r.question || r.Question);
      // Newest-valid-active across clarification AND recovery rows: byTime is
      // newest-first, so the first match of either kind is the newest row that
      // may still accept work. A clarification must never shadow a newer
      // recoverable row (or vice versa); timestamp order decides.
      const newestActiveEarly = byTime.find((r: any) => isClarRow(r) || isRecovRow(r)) ?? null;
      const arowSuperseded = !!arow && !!newestActiveEarly && String((newestActiveEarly.id || newestActiveEarly.Id) || "") !== String((arow.id || arow.Id) || "") && tsOf(newestActiveEarly) > tsOf(arow);
      // Newest-first across both live kinds, computed BEFORE any old-input
      // restore: an old saved answer envelope must never shadow a newer live
      // row that still accepts work.
      const clarEarly = byTime.find((r: any) => statusOf(r) === "needs-clarification");
      const recovEarly = byTime.find((r: any) => ["interrupted", "discarded", "failed"].includes(statusOf(r)) && !!(r.question || r.Question));
      const targetEarly = (clarEarly && recovEarly) ? (tsOf(clarEarly) >= tsOf(recovEarly) ? clarEarly : recovEarly) : (clarEarly ?? recovEarly ?? null);
      const aenvShadowed = !!targetEarly && !!aenv && !!aenv.requestId && String((targetEarly as any).id ?? (targetEarly as any).Id ?? "") !== String(aenv.requestId);
      if (arow && arowFresh && !arowSuperseded) {
        if (hid !== secHydRef.current || envRev0 !== secEnvelopeRev.current || secComposerTouched.current || secDraftVer.current !== dver0 || secAnsVer.current !== aver0 || currentToken() !== tok0) return;
        const aq = arow.question || arow.Question || "";
        const arid = arow.id || arow.Id || "";
        const ast = statusOf(arow);
        const aans = (arow.answer || arow.Answer || "") || (aenv?.answer ?? "");
        if (ast === "completed") {
          setSecQuestion(""); setSecRequestId(""); setSecAnswer(""); setSecError(""); setSecOmitted([]); secAnsOwnerReq.current = ""; secAnsOwnerHyd.current = false; secOmittedReq.current = "";
          try { localStorage.removeItem(secAnsEnvelopeKey(u, boardId, meetingId)); } catch { }
          try { const ie = readEnvelope(secEnvelopeKey(u, boardId, meetingId)); if (ie && String(ie.requestId) === String(arid)) localStorage.removeItem(secEnvelopeKey(u, boardId, meetingId)); } catch { }
          refresh("messages", "notes", "notes-history"); return;
        }
        if (["needs-clarification", "interrupted", "discarded", "failed", "answering"].includes(ast)) {
          setSecQuestion(aq); setSecRequestId(arid);
          // StrictMode-pure replacement: decide from the guarded pre-hydration snapshot, never by mutating refs inside a state updater. Older hydration-owned text is replaced; genuine typing is preserved and never relabeled.
          if (aans && (preHydAns === "" || secAnsOwnerHyd.current)) { secAnsOwnerReq.current = arid; secAnsOwnerHyd.current = true; setSecAnswer(aans); }
          else if (!aans) { secAnsOwnerReq.current = arid; secAnsOwnerHyd.current = true; }
          try {
            const env: SecEnvelope = { identity: u, boardId, meetingId, requestId: arid, nonce: arow.clientNonce || arow.ClientNonce || aenv?.nonce || "", input: arow.inputText || arow.InputText || aenv?.input || "", evidence: [], phase: "continuation", question: aq, answer: aans, epoch: oEp, submittedRev: secDraftVer.current };
            try {
              const __rowOm = parseOmittedManifest((arow as any)?.omitted) ?? parseOmittedRow(arow);
              if (__rowOm !== null) env.omitted = __rowOm;
              else { try { const __prevInitOm = (ienv && ienv.boardId === boardId && ienv.meetingId === meetingId && ienv.identity === u && String(ienv.requestId) === String(arid)) ? parseOmittedManifest((ienv as any)?.omitted) : null; if (__prevInitOm !== null) env.omitted = __prevInitOm; else if (aenv && aenv.boardId === boardId && aenv.meetingId === meetingId && aenv.identity === u && String(aenv.requestId) === String(arid)) { const __prevOm = parseOmittedManifest((aenv as any)?.omitted); if (__prevOm !== null) env.omitted = __prevOm; } } catch { /* preserve-only */ } }
            } catch { /* preserve-only */ }
            localStorage.setItem(secAnsEnvelopeKey(u, boardId, meetingId), JSON.stringify(env));
            secEnvelopeRev.current++;
          } catch { }
          // Omitted-manifest adoption runs AFTER the envelope write above so the persisted-GET snapshot is not self-staled by our own bump.
          try { adoptOmittedRow(arow, arid, { oB: boardId, oM: meetingId, oU: u, oEp, oOrigin: originIdentity() }); } catch { }
          if (ast === "needs-clarification") {
            // An accepted answer whose generation failed stays retryable:
            // surface the durable error instead of silently clearing it.
            const rowErr = (arow.error || arow.Error || "");
            if (aans && rowErr) setSecError("Secretary answer failed; retry sends the saved answer for the same request.");
            else setSecError("");
          }
          else setSecError("Secretary continuation is recoverable after reload. Retry sends the saved answer for the same request.");
          return;
        }
      } else if (!arowSuperseded && aenv && aenv.requestId && !initFail && !aenvShadowed) {
        if (hid !== secHydRef.current || envRev0 !== secEnvelopeRev.current || secComposerTouched.current || secDraftVer.current !== dver0 || secAnsVer.current !== aver0 || currentToken() !== tok0) return;
        setSecQuestion(aenv.question || ""); setSecRequestId(aenv.requestId);
        // StrictMode-pure replacement: decide from the guarded pre-hydration snapshot (same rule as above).
        if (aenv.answer && (preHydAns === "" || secAnsOwnerHyd.current)) { secAnsOwnerReq.current = aenv.requestId; secAnsOwnerHyd.current = true; setSecAnswer(aenv.answer); }
        else if (!aenv.answer) { secAnsOwnerReq.current = aenv.requestId; secAnsOwnerHyd.current = true; }
        try {
          const __omE = parseOmittedManifest((aenv as any)?.omitted);
          if (__omE !== null) { setSecOmitted(__omE); secOmittedReq.current = aenv.requestId; }
          // UNKNOWN envelope manifest preserves a known same-request display but never attributes another request manifest to this one.
          else if ((secOmittedReq.current || "") !== (aenv.requestId || "")) { setSecOmitted([]); secOmittedReq.current = ""; }
        } catch { }
        setSecError("Saved answer has no matching server request; retry may report not found. Clear saved retry to start over.");
        return;
      }
      // Reuse the newest-first selection computed before old-envelope
      // adoption above: never let an older clarification win over a newer
      // recoverable row.
      const clar = clarEarly; const recov = recovEarly; const target = targetEarly;
      const targetFresh = !!target && (!initFail || tsOf(target) >= tsOf(initFail));
      if (targetFresh && target) {
        if (hid !== secHydRef.current || envRev0 !== secEnvelopeRev.current || secComposerTouched.current || secDraftVer.current !== dver0 || secAnsVer.current !== aver0 || currentToken() !== tok0) return;
        const q = target.question || target.Question || "";
        const rid = target.id || target.Id || "";
        const tAns = target.answer || target.Answer || "";
        setSecQuestion(q); setSecRequestId(rid);
        // Durable-only recovery: hydrate accepted server answer bytes so retry is enabled without typing. Older hydration-owned text is replaced with
          // the new request's bytes; genuine typing is preserved and never relabeled.
        // StrictMode-pure replacement: decide from the guarded pre-hydration snapshot (same rule as above). Older hydration-owned text is replaced with the new request bytes; genuine typing is preserved.
        if (tAns && (preHydAns === "" || secAnsOwnerHyd.current)) { secAnsOwnerReq.current = rid; secAnsOwnerHyd.current = true; setSecAnswer(tAns); }
        else if (!tAns) { secAnsOwnerReq.current = rid; secAnsOwnerHyd.current = true; }
          if (!tAns && (!aenv || String(aenv.requestId || "") !== String(rid))) { setSecAnswer(""); secAnsOwnerReq.current = rid; secAnsOwnerHyd.current = true; }
        setSecError("");
        try {
          const env: SecEnvelope = { identity: u, boardId, meetingId, requestId: rid, nonce: target.clientNonce || target.ClientNonce || "", input: target.inputText || target.InputText || "", evidence: [], phase: "continuation", question: q, answer: target.answer || target.Answer || "", epoch: oEp, submittedRev: secDraftVer.current };
          try {
            const __tRowOm = parseOmittedManifest((target as any)?.omitted) ?? parseOmittedRow(target);
            if (__tRowOm !== null) env.omitted = __tRowOm;
            else { try { const __tPrevInitOm = (ienv && ienv.boardId === boardId && ienv.meetingId === meetingId && ienv.identity === u && String(ienv.requestId) === String(rid)) ? parseOmittedManifest((ienv as any)?.omitted) : null; if (__tPrevInitOm !== null) env.omitted = __tPrevInitOm; else if (aenv && aenv.boardId === boardId && aenv.meetingId === meetingId && aenv.identity === u && String(aenv.requestId) === String(rid)) { const __tPrevOm = parseOmittedManifest((aenv as any)?.omitted); if (__tPrevOm !== null) env.omitted = __tPrevOm; } } catch { /* preserve-only */ } }
          } catch { /* preserve-only */ }
          localStorage.setItem(secEnvelopeKey(u, boardId, meetingId), JSON.stringify(env));
          secEnvelopeRev.current++;
          if (env.answer) localStorage.setItem(secAnsEnvelopeKey(u, boardId, meetingId), JSON.stringify(env));
        } catch { }
          // Omitted-manifest adoption runs AFTER the envelope write above so the persisted-GET snapshot is not self-staled by our own bump.
          try { adoptOmittedRow(target, rid, { oB: boardId, oM: meetingId, oU: u, oEp, oOrigin: originIdentity() }); } catch { }
        if (!clar && recov) setSecError("Secretary continuation is recoverable after reload. Review the question and retry the same answer.");
        return;
      }
      const inflight = byTime.find((r: any) => ["pending", "inflight", "answering"].includes(statusOf(r)));
      if (inflight) { if (hid !== secHydRef.current || envRev0 !== secEnvelopeRev.current || secComposerTouched.current || secDraftVer.current !== dver0 || secAnsVer.current !== aver0 || currentToken() !== tok0) return; setSecError("Secretary work is in flight for this meeting; reload to resume. Retry reuses the same envelope."); return; }
      // Initial-phase failure (no question) hydration: turn the durable
      // initial envelope into a usable retry action instead of a dead card.
      if (initFail) {
        const iid = initFail.id || initFail.Id || "";
        const inonce = initFail.clientNonce || initFail.ClientNonce || "";
        const linked = ienv && (String(ienv.requestId) === String(iid) || (!!ienv.nonce && ienv.nonce === inonce));
        if (linked || inonce) {
          if (hid !== secHydRef.current || envRev0 !== secEnvelopeRev.current || secComposerTouched.current || secDraftVer.current !== dver0 || secAnsVer.current !== aver0 || currentToken() !== tok0) return;
          if (!linked) {
            try {
              const env: SecEnvelope = { identity: u, boardId, meetingId, requestId: iid, nonce: inonce, input: initFail.inputText || initFail.InputText || "", evidence: [], phase: "initial", question: "", answer: "", epoch: oEp, submittedRev: secDraftVer.current };
              localStorage.setItem(secEnvelopeKey(u, boardId, meetingId), JSON.stringify(env));
              secEnvelopeRev.current++;
            } catch { }
          }
          setSecQuestion(""); setSecRequestId(iid || "");
          // Initial-provider-failure hydration reads the persisted manifest
          // (OmittedJson via the single request GET), never an explicit [].
          try { adoptOmittedRow(initFail, iid || "", { oB: boardId, oM: meetingId, oU: u, oEp, oOrigin: originIdentity() }); } catch { }
          setSecError("Secretary submission failed; retry reuses the saved envelope for the same nonce.");
          return;
        }
      }
      // Lost-response reconciliation: a pre-response envelope carries a nonce
      // but no requestId; adopt the durable server row when it appears.
      if (ienv && !ienv.requestId && ienv.nonce) {
        const hit = byTime.find((r: any) => (r.clientNonce || r.ClientNonce) === ienv.nonce);
        if (hit) {
          if (hid !== secHydRef.current || envRev0 !== secEnvelopeRev.current || secComposerTouched.current || secDraftVer.current !== dver0 || secAnsVer.current !== aver0 || currentToken() !== tok0) return;
          const hrid = hit.id || hit.Id || "";
          try {
            const env: SecEnvelope = { identity: u, boardId, meetingId, requestId: hrid, nonce: ienv.nonce, input: ienv.input, evidence: [], phase: "initial", question: hit.question || hit.Question || "", answer: "", epoch: oEp, submittedRev: secDraftVer.current };
            localStorage.setItem(secEnvelopeKey(u, boardId, meetingId), JSON.stringify(env));
            secEnvelopeRev.current++;
          } catch { }
          const hst = statusOf(hit);
          if (hst === "needs-clarification") { setSecQuestion(hit.question || hit.Question || ""); setSecRequestId(hrid); setSecError(""); return; }
          if (hst === "completed") { setSecQuestion(""); setSecRequestId(""); setSecAnswer(""); setSecError(""); setSecOmitted([]); secAnsOwnerReq.current = ""; secAnsOwnerHyd.current = false; secOmittedReq.current = ""; refresh("messages", "notes", "notes-history"); return; }
          if (["failed", "discarded", "interrupted"].includes(hst)) { setSecRequestId(hrid); setSecError("Secretary submission failed; retry reuses the saved envelope for the same nonce."); return; }
        }
      }
      if (hid !== secHydRef.current || envRev0 !== secEnvelopeRev.current || secComposerTouched.current || secDraftVer.current !== dver0 || secAnsVer.current !== aver0 || currentToken() !== tok0) return;
      try {
        const env = readEnvelope(secEnvelopeKey(u, boardId, meetingId));
        if (env && env.requestId && env.boardId === boardId && env.meetingId === meetingId && env.identity === u) {
          const done = byTime.find((r: any) => String(r.id || r.Id) === String(env.requestId) && (r.status || r.Status) === "completed");
          if (done) { setSecQuestion(""); setSecRequestId(""); setSecAnswer(""); setSecError(""); setSecOmitted([]); secAnsOwnerReq.current = ""; secAnsOwnerHyd.current = false; secOmittedReq.current = ""; refresh("messages", "notes", "notes-history"); return; }
        }
        const raw = localStorage.getItem(secPendingKey(u, boardId, meetingId));
        if (raw) { const pend = JSON.parse(raw); if (pend && pend.requestId) { setSecQuestion(pend.question || ""); setSecRequestId(pend.requestId || ""); } }
      } catch { }
    }).catch(() => {});
  }, [boardId, meetingId, appliedActAs, meetingOk]);
  const submitDraft = () => {
    if (!draft.trim()) return;
    // Synchronous pending guard: React pending flags flip a render later, so
    // rapid double-Enter (or Enter+click) must also hit this same-tick ref.
    if (submitBusyRef.current) return;
    if (secPendingRef.current || askSecretary.isPending || retrySecretary.isPending || answerSecretary.isPending || send.isPending || runDiscussion.isPending) return;
    if (sendPhase === "sending" || sendPhase === "working") return;
    const submitOp = "submit-" + (++opSeq.current);
    submitBusyRef.current = true;
    submitOpRef.current = submitOp;
    const direct = audience === "secretary" || secHasPrefix(draft);
    if (direct) {
      // Genuine new attempt: advance exactly once BEFORE capturing caps so
      // older held hydration/callback intents retire; onMutate/mutationFn/
      // success/error compare these same new caps without extra bumps.
      try { secEnvelopeRev.current++; } catch { }
      try { secHydRef.current++; } catch { }
      // Freeze the full attempt intent BEFORE queuing: a paused (offline) dispatch must never read a newer meeting, draft, or identity at resume time.
      const uAsk = secIdentity();
      askSecretary.mutate({
        opId: "init-" + (++opSeq.current),
        boardId, meetingId, user: uAsk, epoch: secEpoch.current, origin: originIdentity(),
        draft, submitVer: secDraftVer.current, prevReq: secRequestId, submitOp,
        envRevCap: secEnvelopeRev.current, hydRevCap: secHydRef.current,
        nonce: (typeof crypto !== "undefined" && "randomUUID" in crypto) ? crypto.randomUUID() : String(Date.now()) + "-" + String(Math.floor(Math.random() * 1000000)),
      });
    }
    else {
      if (!meetingValid || curMeeting == null) { settlePipeline(submitOp, "error", "Meeting is still loading. Wait for the meeting to load, then retry.", null); setSendConflict(null); return; } if (!meetingSendOpen((curMeeting as any).state)) { settlePipeline(submitOp, "error", "Meeting is not open for advisor responses.", null); setSendConflict(null); return; } takePipeline(submitOp, "sending", "Sending message..."); setSendRetryCtx(null); setSendConflict(null);
      send.mutate({ boardId, meetingId, user: secIdentity(), epoch: secEpoch.current, origin: originIdentity(), draft, submitVer: secDraftVer.current, replySeq: replyTo ? replyTo.seq : null, submitOp, leadVersion: lead.data ? lead.data.version : null, policy: policy, briefAtClick: briefText, meetingStateAtClick: curMeeting ? (curMeeting as any).state : null, canContributeAtClick: canActMeeting });
    }
  };
  const runSummary = (r: { published: Msg[]; yielded: { advisor: string; reason: string }[]; overflow: { omitted: string[]; cap: number; policy: string } | null }) => {
    const oc = r.overflow && r.overflow.omitted ? r.overflow.omitted.join(", ") : "";
    return "Published " + (r.published ?? []).length + "; yielded " + (r.yielded ?? []).length + "." + (oc ? " Overflow omits " + oc + " (cap " + (r.overflow ? r.overflow.cap : 0) + ")." : "");
  };
  const runDiscussion = useMutation({
    mutationFn: (v: any) => {
      // Queued-attempt validation: a paused dispatch posts exactly the click-time snapshot, never a newer meeting, prompt, or identity.
      if (!v || !v.submitOp || submitOpRef.current !== v.submitOp) throw Object.assign(new Error("Discussion run retired before dispatch."), { stale: true });
      if (!v || v.meetingId !== meetingId || originStale(v.origin)) throw Object.assign(new Error("Discussion run retired before dispatch."), { stale: true });
      return post<{ published: Msg[]; yielded: { advisor: string; reason: string }[]; abstained: string[]; overflow: { omitted: string[]; cap: number; policy: string } | null }>(`/api/meetings/${v.meetingId}/run`, {
        policy: v.policy,
        prompt: v.prompt,
        evidenceSupported: false,
        ...(v.leadVersion != null ? { leadVersion: v.leadVersion } : {}),
      });
    },
    onMutate: (v: any) => ({ submitOp: v?.submitOp, origin: v?.origin, originBoardId: v?.boardId, originMeetingId: v?.meetingId, originUser: v?.user, originEpoch: v?.epoch, meetingId: v?.meetingId, leadCtx: (v as any)?.leadCtx ?? null, retired: !v || !v.submitOp || submitOpRef.current !== v.submitOp || v.meetingId !== meetingId || originStale(v.origin) }),
    onSuccess: (r, _v, ctx) => {
      const o = ctx as any;
      if ((o as any)?.retired) { retirePipeline((o as any)?.submitOp); return; }
      if (!pipelineOwns(o.submitOp, o)) { retirePipeline(o.submitOp); return; }
      refresh("messages");
      const pubs = (r as any)?.published ?? [];
      if (!pubs || pubs.length === 0) { if (chainedOpRef.current === o.submitOp) chainedOpRef.current = null; settlePipeline(o.submitOp, "no-contributions", "No advisors contributed. Adjust participants or the brief, then retry responses.", (o as any)?.leadCtx ?? null); }
      else { if (chainedOpRef.current === o.submitOp) chainedOpRef.current = null; settlePipeline(o.submitOp, "complete", "Responses complete.", null); setSendConflict(null); }
      notify(runSummary(r as { published: Msg[]; yielded: { advisor: string; reason: string }[]; overflow: { omitted: string[]; cap: number; policy: string } | null }));
    },
    onError: (e, _v, ctx) => {
      const o = ctx as any;
      if ((e as any)?.stale) { retirePipeline((o as any)?.submitOp); return; }
      if (!o || (o as any).retired) { retirePipeline((o as any)?.submitOp); return; }
      if (!pipelineOwns(o.submitOp, o)) { retirePipeline(o.submitOp); return; }
      const frozen = (o as any)?.leadCtx ?? null;
      const kind = runErrorKind(e);
      if (kind === "lead-version" && frozen) { try { refresh("lead"); } catch {} }
      if (chainedOpRef.current === o.submitOp) chainedOpRef.current = null;
      settlePipeline(o.submitOp, "error", runErrorMessage(e, !!(frozen && (frozen as any).saveConfirmed)), frozen);
      setSendConflict(kind === "lead-version" && frozen ? { kind } : null);
    },
    onSettled: (_r: unknown, _e: unknown, _v: unknown, ctx: unknown) => { const o = ctx as any; if (!o || !o.submitOp) return; if ((o as any).retired) retirePipeline(o.submitOp); },
  });
  const retryResponses = (rc: any): void => {
    if (!rc || rc.meetingId !== meetingId || !rc.origin || originStale(rc.origin)) return;
    if (submitBusyRef.current || runDiscussion.isPending || send.isPending) return;
    const op = "submit-" + (++opSeq.current);
    submitBusyRef.current = true;
    submitOpRef.current = op;
    const rcLeadSeq = (rc as any)?.leadSequence ?? null;
    const rcLeadContent = (rc as any)?.leadContent ?? rc.prompt;
    const rcGen = (rc as any)?.generation ?? null;
    const rcRestoreId = (rc as any)?.restoreEpochId ?? null;
    const rcRestoreRev = (rc as any)?.restoreEpochRev ?? null;
    const rcReplySeq = (rc as any)?.replySeq ?? null;
    const leadCtx = { boardId: rc.boardId, meetingId: rc.meetingId, user: rc.user, epoch: rc.epoch, prompt: rc.prompt, leadVersion: rc.leadVersion, policy: rc.policy, origin: rc.origin, submitOp: op, saveConfirmed: !!(rc as any).saveConfirmed, replySeq: rcReplySeq, leadSequence: rcLeadSeq, leadContent: rcLeadContent, generation: rcGen, restoreEpochId: rcRestoreId, restoreEpochRev: rcRestoreRev };
    const needBrief = !String(briefText ?? "").trim();
    if (needBrief && !canActMeeting) { settlePipeline(op, "error", "Add a brief before requesting advisor responses.", leadCtx); setSendConflict(null); return; }
    showPhase(op, "working", "Requesting advisor responses...");
    if (needBrief) {
      chainedOpRef.current = op;
      const retryBrief = String(rcLeadContent ?? rc.prompt).slice(0, 800);
      const retryBody = { brief: retryBrief, briefAutoInit: true, expectedBrief: "", expectBriefEmpty: true, leadSequence: rcLeadSeq, leadContent: rcLeadContent, expectedGeneration: rcGen, restoreEpochId: rcRestoreId, restoreEpochRev: rcRestoreRev };
      patch("/api/meetings/" + rc.meetingId, retryBody).then(() => {
        if (submitOpRef.current !== op || !rc.origin || originStale(rc.origin)) { retirePipeline(op); return; }
        const live = liveSelRef.current;
        if (live.boardId !== rc.boardId || live.meetingId !== rc.meetingId) { retirePipeline(op); return; }
        refresh("meetings", "meeting-detail");
        showPhase(op, "working", "Requesting advisor responses...");
        runDiscussion.mutate({ meetingId: rc.meetingId, prompt: rc.prompt, policy: rc.policy, leadVersion: rc.leadVersion, origin: rc.origin, submitOp: op, boardId: rc.boardId, user: rc.user, epoch: rc.epoch, leadCtx: leadCtx });
      }).catch((pe: any) => {
        if ((pe as any)?.stale) { retirePipeline(op); return; }
        if (submitOpRef.current !== op || !rc.origin || originStale(rc.origin)) { retirePipeline(op); return; }
        const live = liveSelRef.current;
        if (live.boardId !== rc.boardId || live.meetingId !== rc.meetingId) { retirePipeline(op); return; }
        settlePipeline(op, "error", briefErrorMessage(pe), leadCtx);
      });
      return;
    }
    runDiscussion.mutate({ meetingId: rc.meetingId, prompt: rc.prompt, policy: rc.policy, leadVersion: rc.leadVersion, origin: rc.origin, submitOp: op, boardId: rc.boardId, user: rc.user, epoch: rc.epoch, leadCtx: leadCtx });
  };
  const requestFreshResponses = (): void => {
    if (submitBusyRef.current || runDiscussion.isPending || send.isPending) return;
    if (!canDiscussMeeting || !briefText.trim()) return;
    if (!meetingValid || curMeeting == null) return; if (curMeeting != null && !meetingIsOpen((curMeeting as any).state)) return;
    const op = "submit-" + (++opSeq.current);
    submitBusyRef.current = true;
    submitOpRef.current = op;
    const origin = originIdentity();
    const st = (curMeeting as any).state;
    if (!meetingSendOpen(st)) { settlePipeline(op, "error", "Meeting is not open for advisor responses.", null); setSendConflict(null); return; }
    const prompt = draft || "Continue the discussion.";
    const leadCtx = { boardId: boardId, meetingId: meetingId, user: secIdentity(), epoch: secEpoch.current, prompt: prompt, leadVersion: lead.data ? lead.data.version : null, policy: policy, origin: origin, submitOp: op, saveConfirmed: false };
    showPhase(op, "working", "Requesting advisor responses...");
    runDiscussion.mutate({ meetingId: meetingId, prompt: prompt, policy: policy, leadVersion: lead.data ? lead.data.version : null, origin: origin, submitOp: op, boardId: boardId, user: secIdentity(), epoch: secEpoch.current, leadCtx: leadCtx });
  };
  const askSecretary = useMutation({
    mutationFn: (v: any) => {
      // Queued-attempt validation (offline pause, held dispatch): navigation, Clear, or a newer attempt retires this one BEFORE any storage write or POST.
      if (!v || secPendingRef.current?.id !== v.opId) throw Object.assign(new Error("Secretary submission retired before dispatch."), { stale: true });
      if (v.boardId !== boardId || v.meetingId !== meetingId || secIdentity() !== v.user || secEpoch.current !== v.epoch || originStale(v.origin)) throw Object.assign(new Error("Secretary submission retired before dispatch."), { stale: true });
      if (v.envRevCap !== secEnvelopeRev.current || v.hydRevCap !== secHydRef.current) throw Object.assign(new Error("Secretary submission retired before dispatch."), { stale: true });
      // Frozen click-time intent (never resume-time refs).
      const originBoardId = v.boardId;
      const originMeetingId = v.meetingId;
      const originUser = v.user;
      const originEpoch = v.epoch;
      const raw = v.draft || "";
      const submitVer = v.submitVer;
      const nonce = v.nonce;
      const prevReqAsk = v.prevReq; const envRevAsk = v.envRevCap; const originAsk = v.origin;
      const env: SecEnvelope = { identity: originUser, boardId: originBoardId, meetingId: originMeetingId, requestId: "", nonce, input: raw, evidence: [], phase: "initial", question: "", answer: "", epoch: originEpoch, submittedRev: submitVer };
      try { localStorage.setItem(secEnvelopeKey(originUser, originBoardId, originMeetingId), JSON.stringify(env)); } catch { }
      try { localStorage.setItem(secSubmitKey(originUser, originBoardId, originMeetingId), JSON.stringify({ nonce, input: raw })); } catch { }
      return post<any>(`/api/meetings/${originMeetingId}/secretary`, { input: raw, clientNonce: nonce }).then((r) => ({ r, originBoardId, originMeetingId, originUser, originEpoch, nonce, submittedDraft: raw, submitVer, prevReq: prevReqAsk, envRevCap: envRevAsk, origin: originAsk, opId: v.opId }));
    },
    onMutate: (v: any) => { const opId = v.opId; if (!v || v.boardId !== boardId || v.meetingId !== meetingId || v.user !== secIdentity() || v.epoch !== secEpoch.current || originStale(v.origin)) return { originBoardId: v.boardId, originMeetingId: v.meetingId, originUser: v.user, originEpoch: v.epoch, opId, origin: v.origin, submitOp: v.submitOp, envRev: v.envRevCap, hydRev: v.hydRevCap, retired: true }; if ((v as any).envRevCap !== secEnvelopeRev.current || (v as any).hydRevCap !== secHydRef.current) return { originBoardId: v.boardId, originMeetingId: v.meetingId, originUser: v.user, originEpoch: v.epoch, opId, origin: v.origin, submitOp: v.submitOp, envRev: v.envRevCap, hydRev: v.hydRevCap, retired: true }; secPendingRef.current = { kind: "secretary-initial", id: opId }; const u0 = v.user; try { localStorage.removeItem(secAnsEnvelopeKey(u0, v.boardId, v.meetingId)); } catch { } setSecAnswer(""); try { secAnsOwnerReq.current = ""; } catch { } try { secAnsOwnerHyd.current = false; } catch { } setSecOmitted([]); try { secOmittedReq.current = ""; } catch { } setSecEditId(""); setSecEditBody(""); setSecHistory(null); setSecQuestion(""); setSecRequestId(""); setSecError(""); try { secEditSess.current++; } catch { /* noop */ } try { secEditVisit.current++; } catch { /* noop */ } try { secHistSel.current = ""; } catch { /* noop */ } try { secHistRef.current++; } catch { /* noop */ } return { originBoardId: v.boardId, originMeetingId: v.meetingId, originUser: v.user, originEpoch: v.epoch, opId, origin: v.origin, submitOp: v.submitOp, envRev: v.envRevCap, hydRev: v.hydRevCap, retired: false }; },
    onSuccess: (pack: any, _v: unknown, ctx: unknown) => {
      const r = (pack as any)?.r ?? pack;
      const originMeetingId = (pack as any)?.originMeetingId ?? meetingId;
      const originBoardId = (pack as any)?.originBoardId ?? boardId;
      const originUser = (pack as any)?.originUser ?? secIdentity();
      const originEpoch = (pack as any)?.originEpoch ?? secEpoch.current;
      const submittedDraft = (pack as any)?.submittedDraft ?? "";
      const live = liveSelRef.current;
      let liveUser = secIdentity();
      if (live.boardId !== originBoardId || live.meetingId !== originMeetingId || liveUser !== originUser || originEpoch !== secEpoch.current) return;
      if (!(pack as any)?.origin || originStale((pack as any).origin)) return;
      if ((pack as any)?.envRevCap !== secEnvelopeRev.current) return;
      // Per-attempt ownership: a superseded or cleared attempt never touches storage or state.
      if ((pack as any)?.opId !== secPendingRef.current?.id) return;
      { const __o = ctx as any; if (!__o || (__o as any).retired || __o.opId !== secPendingRef.current?.id || __o.envRev !== secEnvelopeRev.current || __o.hydRev !== secHydRef.current) return; }
      if (r && (r as any).requestId) {
        try {
          const u = originUser;
          if ((r as any).status === "needs-clarification") localStorage.setItem(secPendingKey(u, originBoardId, originMeetingId), JSON.stringify({ requestId: (r as any).requestId, question: (r as any).question ?? "", nonce: (pack as any)?.nonce ?? "" }));
          else localStorage.removeItem(secPendingKey(u, originBoardId, originMeetingId));
        } catch { }
      }
      const submittedVer = (pack as any)?.submitVer ?? -1;
      if (draft === submittedDraft && secDraftVer.current === submittedVer) { setDraft(""); setReplyTo(null); }
      if (r && r.status === "needs-clarification") {
        setSecQuestion(r.question ?? ""); setSecRequestId(r.requestId ?? ""); setSecError(""); setSecAnswer(""); try { secAnsOwnerReq.current = (r as any).requestId ?? ""; } catch { } try { secAnsOwnerHyd.current = true; } catch { } try { adoptOmittedResponse(r, (r as any).requestId ?? ""); } catch { } notify("Secretary needs one clarification.");
        try {
          // Persist only a KNOWN omitted manifest; UNKNOWN stays absent, never fabricated [].
          const __omAsk = parseOmittedManifest((r as any)?.omitted) ?? parseOmittedRow(r);
          const env: SecEnvelope = { identity: originUser, boardId: originBoardId, meetingId: originMeetingId, requestId: (r as any).requestId ?? "", nonce: (pack as any)?.nonce ?? "", input: submittedDraft, evidence: [], phase: "continuation", question: (r as any).question ?? "", answer: "", epoch: originEpoch, submittedRev: submittedVer };
          if (__omAsk !== null) env.omitted = __omAsk;
          else { try { const __prevAsk = readEnvelope(secEnvelopeKey(originUser, originBoardId, originMeetingId)); if (__prevAsk && String(__prevAsk.requestId) === String((r as any).requestId ?? "")) { const __prevAskOm = parseOmittedManifest((__prevAsk as any)?.omitted); if (__prevAskOm !== null) env.omitted = __prevAskOm; } } catch { /* preserve-only */ } }
          localStorage.setItem(secEnvelopeKey(originUser, originBoardId, originMeetingId), JSON.stringify(env));
        } catch { }
      }
      else if (r && r.note) { setSecQuestion(""); setSecRequestId(""); setSecAnswer(""); try { secAnsOwnerReq.current = ""; } catch { } try { secAnsOwnerHyd.current = false; } catch { } setSecError(""); try { adoptOmittedResponse(r, (r as any).requestId ?? ""); } catch { } try { localStorage.removeItem(secSubmitKey(originUser, originBoardId, originMeetingId)); } catch { } try { localStorage.removeItem(secPendingKey(originUser, originBoardId, originMeetingId)); } catch { } try { localStorage.removeItem(secEnvelopeKey(originUser, originBoardId, originMeetingId)); } catch { } try { localStorage.removeItem(secAnsEnvelopeKey(originUser, originBoardId, originMeetingId)); } catch { } notify("Secretary note saved as provisional."); }
      else if (r && (r as any).answer) { try { adoptOmittedResponse(r, (r as any).requestId ?? ""); } catch { /* noop */ } notify("Secretary (provisional): " + (r as any).answer); }
      refresh("messages", "notes", "notes-history");
    },
    onError: (e, _v: unknown, ctx: unknown) => {
      const o = ctx as any;
      const live = liveSelRef.current;
      let liveUser = secIdentity();
      if (!o || !(o as any).origin || originStale((o as any).origin)) return;
      if (live.boardId !== o.originBoardId || live.meetingId !== o.originMeetingId || liveUser !== o.originUser || o.originEpoch !== secEpoch.current) return;
      // Cleared or superseded attempts never recreate errors or clear a new question.
      if (!o.opId || secPendingRef.current?.id !== o.opId) return;
      if ((o as any).retired) return;
      if (o.envRev !== secEnvelopeRev.current || o.hydRev !== secHydRef.current) return;
      // Failed submission is initial-phase: any displayed question/request
      // belongs to an older flow and must not select the answer-retry
      // button for this error.
      setSecQuestion(""); setSecRequestId("");
      setSecError(String((e as Error)?.message ?? e));
    },
    onSettled: (_r: unknown, _e: unknown, _v: unknown, ctx: unknown) => { const o = ctx as any; if (o && o.opId && secPendingRef.current?.id === o.opId) secPendingRef.current = null; if (o && o.submitOp && submitOpRef.current === o.submitOp) { try { submitBusyRef.current = false; } catch { /* noop */ } try { submitOpRef.current = null; } catch { /* noop */ } } },
  });
  const retrySecretary = useMutation({
    mutationFn: (v: any) => {
      // Queued-attempt validation: navigation, Clear, or a newer attempt retires this one BEFORE any POST of the frozen envelope.
      if (!v || secPendingRef.current?.id !== v.opId) throw Object.assign(new Error("Secretary retry retired before dispatch."), { stale: true });
      if (v.boardId !== boardId || v.meetingId !== meetingId || secIdentity() !== v.user || secEpoch.current !== v.epoch || originStale(v.origin)) throw Object.assign(new Error("Secretary retry retired before dispatch."), { stale: true });
      if (v.envRevCap !== secEnvelopeRev.current || v.hydRevCap !== secHydRef.current) throw Object.assign(new Error("Secretary retry retired before dispatch."), { stale: true });
      // Frozen click-time envelope (never resume-time storage reads).
      const env = v.env;
      if (!env || env.boardId !== v.boardId || env.meetingId !== v.meetingId || env.identity !== v.user) throw new Error("No saved secretary submission for this meeting and identity.");
      const originBoardId = env.boardId; const originMeetingId = env.meetingId; const originUser = env.identity; const originEpoch = v.epoch; const originCap = v.origin;
      const envRev = v.envRevCap;
      return post<any>(`/api/meetings/${originMeetingId}/secretary`, { input: env.input, clientNonce: env.nonce }).then((r) => ({ r, originBoardId, originMeetingId, originUser, originEpoch, nonce: env.nonce, submittedDraft: env.input, submitVer: env.submittedRev, retried: true, envRev, origin: originCap, opId: v.opId }));
    },
    onMutate: (v: any) => { const opId = v.opId; if (!v || v.boardId !== boardId || v.meetingId !== meetingId || v.user !== secIdentity() || v.epoch !== secEpoch.current || originStale(v.origin)) return { originBoardId: v.boardId, originMeetingId: v.meetingId, originUser: v.user, originEpoch: v.epoch, opId, origin: v.origin, envRev: v.envRevCap, hydRev: v.hydRevCap, retired: true }; if ((v as any).envRevCap !== secEnvelopeRev.current || (v as any).hydRevCap !== secHydRef.current) return { originBoardId: v.boardId, originMeetingId: v.meetingId, originUser: v.user, originEpoch: v.epoch, opId, origin: v.origin, envRev: v.envRevCap, hydRev: v.hydRevCap, retired: true }; secPendingRef.current = { kind: "secretary-retry", id: opId }; return { originBoardId: v.boardId, originMeetingId: v.meetingId, originUser: v.user, originEpoch: v.epoch, opId, origin: v.origin, envRev: v.envRevCap, hydRev: v.hydRevCap, retired: false }; },
    onSuccess: (pack: any, _v: unknown, ctx: unknown) => {
      const r = (pack as any)?.r ?? pack;
      const originBoardId = (pack as any)?.originBoardId ?? boardId;
      const originMeetingId = (pack as any)?.originMeetingId ?? meetingId;
      const originUser = (pack as any)?.originUser ?? secIdentity();
      const originEpoch = (pack as any)?.originEpoch ?? secEpoch.current;
      const submittedDraft = (pack as any)?.submittedDraft ?? "";
      const submittedVer = (pack as any)?.submitVer ?? -1;
      const live = liveSelRef.current;
      let liveUser = secIdentity();
      if (live.boardId !== originBoardId || live.meetingId !== originMeetingId || liveUser !== originUser || originEpoch !== secEpoch.current) return;
      if (!(pack as any)?.origin || originStale((pack as any).origin)) return;
      if ((pack as any)?.envRev !== secEnvelopeRev.current) return;
      if ((pack as any)?.opId !== secPendingRef.current?.id) return;
      { const __o = ctx as any; if (!__o || (__o as any).retired || __o.opId !== secPendingRef.current?.id || __o.envRev !== secEnvelopeRev.current || __o.hydRev !== secHydRef.current) return; }
      if (r && (r as any).requestId) {
        try {
          if ((r as any).status === "needs-clarification") {
            // Persist only a KNOWN omitted manifest; UNKNOWN stays absent, never fabricated [].
            const __omRetry = parseOmittedManifest((r as any)?.omitted) ?? parseOmittedRow(r);
            const env: SecEnvelope = { identity: originUser, boardId: originBoardId, meetingId: originMeetingId, requestId: (r as any).requestId ?? "", nonce: (pack as any)?.nonce ?? "", input: submittedDraft, evidence: [], phase: "continuation", question: (r as any).question ?? "", answer: "", epoch: originEpoch, submittedRev: submittedVer };
            if (__omRetry !== null) env.omitted = __omRetry;
            else { try { const __prevRe = readEnvelope(secEnvelopeKey(originUser, originBoardId, originMeetingId)); if (__prevRe && String(__prevRe.requestId) === String((r as any).requestId ?? "")) { const __prevReOm = parseOmittedManifest((__prevRe as any)?.omitted); if (__prevReOm !== null) env.omitted = __prevReOm; } } catch { /* preserve-only */ } }
            localStorage.setItem(secEnvelopeKey(originUser, originBoardId, originMeetingId), JSON.stringify(env));
          } else localStorage.removeItem(secPendingKey(originUser, originBoardId, originMeetingId));
        } catch { }
      }
      if (draft === submittedDraft && secDraftVer.current === submittedVer) { setDraft(""); setReplyTo(null); }
      if (r && r.status === "needs-clarification") { setSecQuestion(r.question ?? ""); setSecRequestId(r.requestId ?? ""); setSecError(""); try { adoptOmittedResponse(r, (r as any).requestId ?? ""); } catch { } notify("Secretary needs one clarification."); }
      else if (r && r.note) { setSecQuestion(""); setSecRequestId(""); setSecAnswer(""); try { secAnsOwnerReq.current = ""; } catch { } try { secAnsOwnerHyd.current = false; } catch { } setSecError(""); try { adoptOmittedResponse(r, (r as any).requestId ?? ""); } catch { } try { localStorage.removeItem(secEnvelopeKey(originUser, originBoardId, originMeetingId)); } catch { } try { localStorage.removeItem(secAnsEnvelopeKey(originUser, originBoardId, originMeetingId)); } catch { } notify("Secretary note saved as provisional."); }
      refresh("messages", "notes", "notes-history");
    },
    onError: (e, _v: unknown, ctx: unknown) => {
      const o = ctx as any;
      const live = liveSelRef.current;
      let liveUser = secIdentity();
      if (!o || !(o as any).origin || originStale((o as any).origin)) return;
      if (live.boardId !== o?.originBoardId || live.meetingId !== o?.originMeetingId || liveUser !== o?.originUser || o?.originEpoch !== secEpoch.current) return;
      if (!o.opId || secPendingRef.current?.id !== o.opId) return;
      if ((o as any).retired) return;
      if (o.envRev !== secEnvelopeRev.current || o.hydRev !== secHydRef.current) return;
      // Failed retry is initial-phase: drop any older continuation display
      // so this error offers the same-envelope retry.
      setSecQuestion(""); setSecRequestId("");
      setSecError(String((e as Error)?.message ?? e));
    },
    onSettled: (_r: unknown, _e: unknown, _v: unknown, ctx: unknown) => { const o = ctx as any; if (o && o.opId && secPendingRef.current?.id === o.opId) secPendingRef.current = null; },
  });
  // Click-time frozen answer intent: resolves saved-vs-live from the VISIBLE editor and hydration ownership at click, never response-time refs. A queued (paused) dispatch validates and posts exactly this snapshot.
  const buildAnswerVars = () => {
    // Genuine new answer attempt: advance exactly once BEFORE capturing caps
    // so older held hydration/callback intents retire; downstream gates
    // compare these same new caps without extra bumps. Untouched saved
    // composer still advances (rev bump, not touched-flag).
    try { secEnvelopeRev.current++; } catch { }
    try { secHydRef.current++; } catch { }
    const u = secIdentity();
    const saved = readEnvelope(secAnsEnvelopeKey(u, boardId, meetingId));
    const sameReq = !!saved && !!saved.requestId && !!saved.answer && saved.boardId === boardId && saved.meetingId === meetingId && saved.identity === u && String(saved.requestId) === String(secRequestId) && String(secRequestId) !== "";
    const reuseSaved = sameReq && secAnswer === (saved as SecEnvelope).answer;
    return {
      opId: "ans-" + secRequestId + "-" + (++opSeq.current),
      boardId, meetingId, user: u, epoch: secEpoch.current, origin: originIdentity(),
      req: reuseSaved ? (saved as SecEnvelope).requestId : secRequestId,
      answer: reuseSaved ? (saved as SecEnvelope).answer : secAnswer,
      question: reuseSaved ? ((saved as SecEnvelope).question || secQuestion) : secQuestion,
      savedNonce: saved?.nonce ?? "",
      usedSaved: reuseSaved,
      ansVer: secAnsVer.current,
      ansOwner: secAnsOwnerReq.current,
      envRevCap: secEnvelopeRev.current,
      hydRevCap: secHydRef.current,
    };
  };
  const answerSecretary = useMutation({
    mutationFn: (v: any) => {
      // Queued-attempt validation (offline pause, held dispatch): navigation, Clear, or a newer attempt retires this one BEFORE any storage write or POST. The per-attempt revision is frozen once in variables; freshness gates stay intact.
      if (!v || secPendingRef.current?.id !== v.opId) throw Object.assign(new Error("Secretary answer retired before dispatch."), { stale: true });
      if (v.boardId !== boardId || v.meetingId !== meetingId || secIdentity() !== v.user || secEpoch.current !== v.epoch || originStale(v.origin)) throw Object.assign(new Error("Secretary answer retired before dispatch."), { stale: true });
      if (v.envRevCap !== secEnvelopeRev.current || v.hydRevCap !== secHydRef.current) throw Object.assign(new Error("Secretary answer retired before dispatch."), { stale: true });
      // Frozen click-time intent (never resume-time or response-time refs).
      const originBoardId = v.boardId;
      const originMeetingId = v.meetingId;
      const originUser = v.user;
      const originEpoch = v.epoch;
      const originCap = v.origin;
      const ansVerCap = v.ansVer;
      const ansOwnerCap = v.ansOwner;
      let envRev = v.envRevCap;
      // First-attempt persistence uses the frozen click-time payload: the builder already resolved saved-vs-live from the visible editor, so the editor always matches the submitted bytes for the same request.
      if (!v.usedSaved) {
        try {
          const env: SecEnvelope = { identity: originUser, boardId: originBoardId, meetingId: originMeetingId, requestId: v.req, nonce: v.savedNonce ?? "", input: "", evidence: [], phase: "continuation", question: v.question, answer: v.answer, epoch: originEpoch, submittedRev: secDraftVer.current };
          try { const __prevAns = readEnvelope(secAnsEnvelopeKey(originUser, originBoardId, originMeetingId)); if (__prevAns && __prevAns.boardId === originBoardId && __prevAns.meetingId === originMeetingId && __prevAns.identity === originUser && String(__prevAns.requestId) === String(v.req)) { const __prevAnsOm = parseOmittedManifest((__prevAns as any)?.omitted); if (__prevAnsOm !== null) env.omitted = __prevAnsOm; } if ((env as any).omitted === undefined) { try { const __prevInit = readEnvelope(secEnvelopeKey(originUser, originBoardId, originMeetingId)); if (__prevInit && __prevInit.boardId === originBoardId && __prevInit.meetingId === originMeetingId && __prevInit.identity === originUser && String(__prevInit.requestId) === String(v.req)) { const __prevInitOm = parseOmittedManifest((__prevInit as any)?.omitted); if (__prevInitOm !== null) env.omitted = __prevInitOm; } } catch { /* preserve-only */ } } } catch { /* preserve-only */ }
          localStorage.setItem(secAnsEnvelopeKey(originUser, originBoardId, originMeetingId), JSON.stringify(env));
          // The per-attempt revision was frozen once at click (variables); the
          // success gate compares that immutable revision, so a first answer is
          // never discarded as stale.
          envRev = v.envRevCap;
        } catch { }
      }
      if (!v.req) throw new Error("No secretary request to answer.");
      if (!(v.answer || "").trim()) throw new Error("Answer is required.");
      return post<any>(`/api/meetings/${originMeetingId}/secretary/answer`, { requestId: v.req, answer: v.answer }).then((r) => ({ r, originBoardId, originMeetingId, originUser, originEpoch, originReq: v.req, submittedAnswer: v.answer, envRev, usedSaved: v.usedSaved, origin: originCap, opId: v.opId, ansVerCap, ansOwnerCap }));
    },
    onMutate: (v: any) => { const opId = v.opId; if (!v || v.boardId !== boardId || v.meetingId !== meetingId || v.user !== secIdentity() || v.epoch !== secEpoch.current || originStale(v.origin)) return { originBoardId: v.boardId, originMeetingId: v.meetingId, originUser: v.user, originEpoch: v.epoch, originReq: v.req, opId, origin: v.origin, envRev: v.envRevCap, hydRev: v.hydRevCap, ansVer: v.ansVer, ansOwner: v.ansOwner, retired: true }; if ((v as any).envRevCap !== secEnvelopeRev.current || (v as any).hydRevCap !== secHydRef.current) return { originBoardId: v.boardId, originMeetingId: v.meetingId, originUser: v.user, originEpoch: v.epoch, originReq: v.req, opId, origin: v.origin, envRev: v.envRevCap, hydRev: v.hydRevCap, ansVer: v.ansVer, ansOwner: v.ansOwner, retired: true }; secPendingRef.current = { kind: "secretary-answer", id: opId }; return { originBoardId: v.boardId, originMeetingId: v.meetingId, originUser: v.user, originEpoch: v.epoch, originReq: v.req, opId, origin: v.origin, envRev: v.envRevCap, hydRev: v.hydRevCap, ansVer: v.ansVer, ansOwner: v.ansOwner, retired: false }; },
    onSuccess: (pack: any, _v: unknown, ctx: unknown) => {
      const r = (pack as any)?.r ?? pack;
      const originBoardId = (pack as any)?.originBoardId ?? boardId;
      const originMeetingId = (pack as any)?.originMeetingId ?? meetingId;
      const originUser = (pack as any)?.originUser ?? secIdentity();
      const originEpoch = (pack as any)?.originEpoch ?? secEpoch.current;
      const originReq = (pack as any)?.originReq ?? "";
      const submittedAnswer = (pack as any)?.submittedAnswer ?? "";
      const live = liveSelRef.current;
      let liveUser = secIdentity();
      if (!(pack as any)?.origin || originStale((pack as any).origin)) return;
      if ((pack as any)?.envRev !== secEnvelopeRev.current) return;
      if ((pack as any)?.opId !== secPendingRef.current?.id) return;
      { const __o = ctx as any; if (!__o || (__o as any).retired || __o.opId !== secPendingRef.current?.id || __o.envRev !== secEnvelopeRev.current || __o.hydRev !== secHydRef.current) return; }
      if (live.boardId !== originBoardId || live.meetingId !== originMeetingId || liveUser !== originUser || originEpoch !== secEpoch.current) return;
      if (originReq !== secRequestId) return;
      if (r && r.note) {
        // Bytes-equal is not same-edit: clear only when no keystroke and no
        // ownership change happened since dispatch (an X→Z→X retype keeps text).
        if ((pack as any)?.ansVerCap === secAnsVer.current && (pack as any)?.ansOwnerCap === secAnsOwnerReq.current && secAnswer === submittedAnswer) { setSecAnswer(""); try { secAnsOwnerReq.current = ""; } catch { } try { secAnsOwnerHyd.current = false; } catch { } } setSecQuestion(""); setSecRequestId(""); setSecError(""); try { adoptOmittedResponse(r, originReq); } catch { } try { localStorage.removeItem(secPendingKey(originUser, originBoardId, originMeetingId)); } catch { } try { localStorage.removeItem(secAnsEnvelopeKey(originUser, originBoardId, originMeetingId)); } catch { } notify("Secretary note saved as provisional."); refresh("messages", "notes", "notes-history"); }
    },
    onError: (e, _v: unknown, ctx: unknown) => {
      const o = ctx as any;
      const live = liveSelRef.current;
      let liveUser = secIdentity();
      if (!o || !(o as any).origin || originStale((o as any).origin)) return;
      if (live.boardId !== o.originBoardId || live.meetingId !== o.originMeetingId || liveUser !== o.originUser || o.originEpoch !== secEpoch.current || (o.originReq && o.originReq !== secRequestId)) return;
      if (!o.opId || secPendingRef.current?.id !== o.opId) return;
      if ((o as any).retired) return;
      if (o.envRev !== secEnvelopeRev.current || o.hydRev !== secHydRef.current) return;
      setSecError(String((e as Error)?.message ?? e));
    },
    onSettled: (_r: unknown, _e: unknown, _v: unknown, ctx: unknown) => { const o = ctx as any; if (o && o.opId && secPendingRef.current?.id === o.opId) secPendingRef.current = null; },
  });
  const editNote = useMutation({
    mutationFn: (v: any) => {
      // Queued-attempt validation BEFORE dispatch: Apply identity,
      // navigation, or a newer attempt retires this one before any POST of
      // the frozen click-time variables.
      const vv = (v ?? {}) as any;
      if (!vv.origin || originStale(vv.origin)) throw Object.assign(new Error("Note edit retired before dispatch."), { stale: true });
      if (vv.oB !== boardId || vv.oM !== meetingId || vv.oU !== secIdentity() || secEpoch.current !== vv.oEp) throw Object.assign(new Error("Note edit retired before dispatch."), { stale: true });
      if (vv.opId && secPendingRef.current?.id !== vv.opId) throw Object.assign(new Error("Note edit retired before dispatch."), { stale: true });
      return post<Note>(`/api/notes/${vv.id}/edit`, { expectedRevision: vv.revision, body: vv.body });
    },
    onMutate: (v: any) => { const vv = (v ?? {}) as any; const opId = vv.opId ?? ("edit-" + vv.id + "-" + vv.revision + "-" + (++opSeq.current)); secPendingRef.current = { kind: "note-edit", id: opId }; const sess = ++secEditSess.current; return { oB: vv.oB ?? boardId, oM: vv.oM ?? meetingId, oU: vv.oU ?? secIdentity(), oEp: vv.oEp ?? secEpoch.current, id: vv.id, rev: vv.revision, body: vv.body, opId, sess, visit: secEditVisit.current, histSel: secHistSel.current, histRef: secHistRef.current, view: noteVisitRef.current, origin: vv.origin ?? originIdentity() }; },
    onSuccess: (_r, _v, ctx) => {
      const o = ctx as any;
      const live = liveSelRef.current;
      let liveUser = secIdentity();
      // Operation/editor/history ownership: old save must not clear a newer editor session, changed typing, or different history selection.
      if (!o || live.boardId !== o.oB || live.meetingId !== o.oM || liveUser !== o.oU || o.oEp !== secEpoch.current) return;
      if (!o.origin || originStale(o.origin)) return;
      if (secEditId !== o.id) return;
      if (o.sess !== secEditSess.current) return;
        // Visit revision: an older save (or a save for a closed/reopened editor) must never clear a newer editor visit.
      if (o.visit !== secEditVisit.current) return;
      // View close/reopen: leaving the takeaways/app view and returning
      // retires the in-flight editor generation; its late success clears nothing.
      if (o.view !== noteVisitRef.current) return;
      if (!o.opId || secPendingRef.current?.id !== o.opId) return;
      if (secEditBody !== o.body) return;
      // History isolation: only clear history when it was selected for this same note chain; never clear History B.
      const histForSame = (!secHistSel.current || secHistSel.current === o.id) && secHistRef.current === o.histRef;
      setSecEditId(""); setSecEditBody("");
      try { secEditSess.current++; } catch { }
      if (histForSame) setSecHistory(null);
      // Storage/cache ownership: only clear pending op when it is still ours.
      refresh("notes", "notes-history"); notify("Note revision saved.");
    },
    onError: (e, _v, ctx) => {
      const o = ctx as any;
      const live = liveSelRef.current;
      let liveUser = secIdentity();
      if (!o || live.boardId !== o.oB || live.meetingId !== o.oM || liveUser !== o.oU || o.oEp !== secEpoch.current) return;
      if (!o.origin || originStale(o.origin)) return;
      if (secEditId !== o.id) return;
      if (o.sess !== secEditSess.current) return;
      if (o.visit !== secEditVisit.current) return;
      if (o.view !== noteVisitRef.current) return;
      if (!o.opId || secPendingRef.current?.id !== o.opId) return;
      // Error must not touch history/storage of another selection.
      toastErr(e);
    },
    onSettled: (_r: unknown, _e: unknown, _v: unknown, ctx: unknown) => { const o = ctx as any; if (o && o.opId && secPendingRef.current?.id === o.opId) secPendingRef.current = null; },
  });
  const reverseNote = useMutation({
    mutationFn: (v: any) => {
      // Queued-attempt validation BEFORE dispatch: Apply identity,
      // navigation, or a newer attempt retires this one before any POST of
      // the frozen click-time variables.
      const vv = (v ?? {}) as any;
      if (!vv.origin || originStale(vv.origin)) throw Object.assign(new Error("Note reverse retired before dispatch."), { stale: true });
      if (vv.oB !== boardId || vv.oM !== meetingId || vv.oU !== secIdentity() || secEpoch.current !== vv.oEp) throw Object.assign(new Error("Note reverse retired before dispatch."), { stale: true });
      if (vv.opId && secPendingRef.current?.id !== vv.opId) throw Object.assign(new Error("Note reverse retired before dispatch."), { stale: true });
      return post<Note>(`/api/notes/${vv.id}/reverse`, { expectedRevision: vv.revision });
    },
    onMutate: (v: any) => { const vv = (v ?? {}) as any; const opId = vv.opId ?? ("rev-" + vv.id + "-" + (++opSeq.current)); secPendingRef.current = { kind: "note-reverse", id: opId }; return { oB: vv.oB ?? boardId, oM: vv.oM ?? meetingId, oU: vv.oU ?? secIdentity(), oEp: vv.oEp ?? secEpoch.current, id: vv.id, opId, view: noteVisitRef.current, editVisit: secEditVisit.current, origin: vv.origin ?? originIdentity() }; },
    onSuccess: (_r, _v, ctx) => {
      const o = ctx as any;
      const live = liveSelRef.current;
      let liveUser = secIdentity();
      if (!o || !o.origin || originStale(o.origin)) return;
      if (live.boardId !== o.oB || live.meetingId !== o.oM || liveUser !== o.oU || o.oEp !== secEpoch.current) return;
      if (!o.opId || secPendingRef.current?.id !== o.opId) return;
      if (o.view !== noteVisitRef.current || o.editVisit !== secEditVisit.current) return;
      refresh("notes", "notes-history"); notify("Note reversed; prior text kept in history.");
    },
    onError: (e, _v, ctx) => {
      const o = ctx as any;
      if (!o || !o.origin || originStale(o.origin)) return;
      const live = liveSelRef.current;
      let liveUser = secIdentity();
      if (live.boardId !== o.oB || live.meetingId !== o.oM || liveUser !== o.oU || o.oEp !== secEpoch.current) return;
      if (!o.opId || secPendingRef.current?.id !== o.opId) return;
      if (o.view !== noteVisitRef.current || o.editVisit !== secEditVisit.current) return;
      toastErr(e);
    },
    onSettled: (_r: unknown, _e: unknown, _v: unknown, ctx: unknown) => { const o = ctx as any; if (o && o.opId && secPendingRef.current?.id === o.opId) secPendingRef.current = null; },
  });
  const loadHistory = (id: string) => {
    const oB = boardId; const oM = meetingId; const oEp = secEpoch.current; const oOrigin = originIdentity();
    const oU = secIdentity();
    const myHist = ++secHistRef.current;
    secHistSel.current = id;
    const wantId = id;
    const wantHist = myHist;
    get<any>(`/api/notes/${id}/history`).then((h: any) => {
      if (myHist !== secHistRef.current) return;
      if (wantId !== secHistSel.current) return;
      const live = liveSelRef.current;
      let liveUser = secIdentity();
      if (live.boardId !== oB || live.meetingId !== oM || liveUser !== oU || oEp !== secEpoch.current || wantId !== id || wantHist !== secHistRef.current || originStale(oOrigin)) return;
      // Storage/cache ownership: only populate history when selection still matches.
      setSecHistory(h);
    }).catch((e) => {
      if (myHist !== secHistRef.current) return;
      const live = liveSelRef.current;
      let liveUser = secIdentity();
      if (live.boardId !== oB || live.meetingId !== oM || liveUser !== oU || oEp !== secEpoch.current || originStale(oOrigin)) return;
      toastErr(e);
    });
  };
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
  // A 403 on the singular board lookup proves the current identity may not
  // read this board. Each board-scoped tab renders an inline denied card with
  // recovery; the route keeps the board id and only a 404 clears it.
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
    <div className={"shell" + (navOpen ? " nav-open" : "") + (tab === "boards" || tab === "roster" ? "" : " no-panel")}>
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

      {(tab === "boards" || tab === "roster") && (
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
                ? (boards.isLoading || boards.data === undefined ? `... boards` : `${scopeRows.length} boards`)
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
              scopeRows.map((b) => (
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
            {tab === "boards" && !boards.isLoading && !boards.isError && boards.data !== undefined && scopeRows.length === 0 && (
              <div className="sub-empty">{boardScope === "archived" ? "No archived boards." : boardScope === "all" ? "No boards in this view." : "No boards yet"}</div>
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
              {boardDenied ? "Not authorized for this board." : (<>Open board: {boardDetail.data?.name ?? (boards.data ?? []).find((b) => b.id === boardId)?.name ?? "board"}</>)}{" "}
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
          {sessExpired && (<p role="alert">Session expired. Sign in again to continue; private data is hidden until re-authentication.</p>)}
          {privateHidden ? (
            <section aria-label="Session verification">
              <AuthPanel />
              <InviteClaim />
              <p role="status">Session verification pending — private content is hidden until the current session is verified. Unsent per-account drafts are preserved for re-authentication.</p>
            </section>
          ) : (<>
          {tab === "boards" && (
            <section aria-label="Boards">
              <AuthPanel />
              <InviteClaim />
              {" "}
              <h2>Boards</h2>{" "}
              {boardId && (
                <div className="card" aria-label="Current board">
                  {" "}
                  {boardDenied ? (
                    <>
                      {" "}
                      <h3>Not authorized for this board.</h3>{" "}
                      <p role="status">The current identity may not read this board. Pick an allowed board below, or close this one.</p>{" "}
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => {
                          setBoardId("");
                          setMeetingId("");
                          setMeetPicks([]);
                        }}
                      >
                        {" "}
                        Close board{" "}
                      </button>{" "}
                    </>
                  ) : (
                    <>
                      {" "}
                  <h3>
                    {" "}
                    Open board:{" "}
                    {boardDetail.data?.name ??
                      (boards.data ?? []).find((b) => b.id === boardId)?.name ??
                      "board"}{" "}
                  </h3>{" "}
                  {(boardDetail.data as Board | undefined)?.archived === true && (
                    <p role="status">
                      {" "}
                      This board is archived. It stays readable; the active board list hides it until restored.{" "}
                      {!canManageBoard && "Ask a board manager to restore it."}{" "}
                    </p>
                  )}{" "}
                  {canManageBoard && (boardDetail.data as Board | undefined)?.archived === true && (
                    <button
                      type="button"
                      onClick={() =>
                        patch<Board>(`/api/boards/${boardId}`, {
                          archived: false,
                        }).then(() => {
                          refresh("boards");
                          refresh("board-detail");
                        })
                      }
                    >
                      {" "}
                      Restore board{" "}
                    </button>
                  )}{" "}
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
                    </>
                  )}{" "}
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
                          disabled={!canManageBoard}
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
                          disabled={!canManageBoard}
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
                          disabled={!canManageBoard}
                          value={boardForm.stage}
                          onChange={(e) =>
                            setBoardForm({ ...boardForm, stage: e.target.value })
                          }
                        />{" "}
                      </label>{" "}
                      {canManageBoard && (<button onClick={() => saveBoard.mutate()}>Save draft</button>)}{" "}
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
                        Reviewed draft on file — activation checks it automatically.{" "}
                      </p>{" "}
                      {canManageBoard && (<button onClick={() => activate.mutate(setup.data.draftHash)}>
                        {" "}
                        Activate configuration{" "}
                      </button>)}{" "}
                      <h3>Export / import</h3>{" "}
                      {canManageBoard && (<button onClick={doExport}>
                        {" "}
                        Export reviewed configuration{" "}
                      </button>)}{" "}
                      {expText && (
                        <p role="status">
                          {" "}
                          Export ready — {expText.length} characters. Paste into a new board import for re-review. The file carries its own check code.{" "}
                        </p>
                      )}{" "}
                      <label>
                        {" "}
                        Configuration snapshot{" "}
                        <input
                          value={expText}
                          onChange={(e) => setExpText(e.target.value)}
                          placeholder="paste exported snapshot"
                        />{" "}
                      </label>{" "}
                      <label>
                        {" "}
                        Snapshot check code{" "}
                        <input
                          value={expHash}
                          onChange={(e) => setExpHash(e.target.value)}
                        />{" "}
                      </label>{" "}
                      {canManageBoard && (<button onClick={doImport}>
                        {" "}
                        Import as new board (advisors unapproved){" "}
                      </button>)}{" "}
                      {canManageBoard && (<>
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
                      <label className="checkline">
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
                      </>)}{" "}
                    </>
                  )}{" "}
                  {!setup.data && isGuest && guestSettings.data && (
                    <>
                      <p role="status">Read-only guest settings for your assigned meeting.</p>
                      <dl>
                        <dt>Board</dt><dd>{guestSettings.data.name}</dd>
                        <dt>Mission</dt><dd>{guestSettings.data.mission}</dd>
                        <dt>Stage</dt><dd>{guestSettings.data.stage}</dd>
                        <dt>Discussion rhythm</dt><dd>{guestSettings.data.discussionPolicy}</dd>
                        <dt>Lead</dt><dd>{guestSettings.data.lead ? `${guestSettings.data.lead.name} (${guestSettings.data.lead.roleLabel})` : "\u2014"}</dd>
                      </dl>
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
              <div className="card" aria-label="Board list scope">
                {" "}
                <div className="meetctl" role="group" aria-label="Board list scope">
                  {(["active", "archived", "all"] as const).map((sc) => (
                    <button key={sc} type="button" className={boardScope === sc ? "btn primary" : "btn ghost"} aria-pressed={boardScope === sc} onClick={() => setBoardScope(sc)}>
                      {" "}
                      {boards.isLoading || boards.data === undefined ? (sc === "active" ? `Active (...)` : sc === "archived" ? `Archived (...)` : `All (...)`) : sc === "active" ? `Active (${activeRows.length})` : sc === "archived" ? `Archived (${archivedRows.length})` : `All (${allRows.length})`}{" "}
                    </button>
                  ))}{" "}
                  <button type="button" className="btn ghost" onClick={() => { refresh("boards"); refresh("board-detail"); }}>Reload boards</button>{" "}
                </div>{" "}
                {boards.isLoading && (<p className="muted">Loading boards…</p>)}{" "}{boards.isError && (<p role="alert">Could not load boards.</p>)}{" "}{boardScope !== "active" && !boards.isLoading && !boards.isError && scopeRows.length === 0 && (<p className="muted">{boardScope === "archived" ? "No archived boards." : "No boards in this view."}</p>)}{" "}
              </div>{" "}
              {scopeRows.map((b) => (
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
                  {canManageBoard && b.id === boardId && (<div className="meetctl">
                    {" "}
                    {(b as Board).archived !== true && (<button
                      type="button"
                      className="btn ghost"
                      onClick={() =>
                        patch<Board>(`/api/boards/${b.id}`, {
                          archived: true,
                        }).then(() => { refresh("boards"); if (b.id === boardId) refresh("board-detail"); })
                      }
                    >
                      {" "}
                      Archive{" "}
                    </button>)}{" "}
                    {(b as Board).archived === true && (<button
                      type="button"
                      className="btn ghost"
                      onClick={() => { patch<Board>(`/api/boards/${b.id}`, { archived: false }).then(() => { refresh("boards"); if (b.id === boardId) refresh("board-detail"); notify("Board restored to active."); }).catch((e) => notify(String(e))); }}
                    >
                      {" "}
                      Restore{" "}
                    </button>)}{" "}
                  </div>)}{" "}
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
                    <textarea
                      rows={4}
                      className="profile-area"
                      disabled={!!wizId && wizVersion == null}
                      value={wizard.lead.background}
                      onChange={(e) =>
                        setWizard({
                          ...wizard,
                          lead: { ...wizard.lead, background: e.target.value },
                        })
                      }
                      placeholder="What should advisors know about you?"
                    ></textarea>{" "}
                  </label>{" "}
                  <label>
                    {" "}
                    Subjects already familiar{" "}
                    <textarea
                      rows={4}
                      className="profile-area"
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
                    ></textarea>{" "}
                  </label>{" "}
                  <label>
                    {" "}
                    Subjects needing simpler explanation{" "}
                    <textarea
                      rows={4}
                      className="profile-area"
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
                    ></textarea>{" "}
                  </label>{" "}
                  <label>
                    {" "}
                    Communication preferences{" "}
                    <textarea
                      rows={5}
                      className="profile-area"
                      disabled={!!wizId && wizVersion == null}
                      value={wizard.lead.commPrefs}
                      onChange={(e) =>
                        setWizard({
                          ...wizard,
                          lead: { ...wizard.lead, commPrefs: e.target.value },
                        })
                      }
                      placeholder="e.g. Blunt and brief"
                    ></textarea>{" "}
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
                Your account default: shared by all your boards unless a board saves its own override.
              </p>
              <>
                {" "}
                <p role="status">
                  {" "}
                  {profile.data
                    ? "Saved profile loaded."
                    : "No saved profile yet."}{" "}
                </p>{" "}
                <p>
                  {" "}
                  Saving here updates your account default immediately for future meeting
                  context on all your boards. Boards with their own saved profile keep that profile.{" "}
                </p>{" "}
                {(!profileResolved && !sessGate && !profile.isError) && (
                  <p role="status">Loading the saved profile. Fields and Save stay disabled until the current profile is confirmed.</p>
                )}{" "}
                {profileLookupFailed && (
                  <div className="meetctl">
                    {" "}
                    <button type="button" onClick={() => { void profile.refetch(); }}>
                      {" "}
                      Retry profile lookup{" "}
                    </button>{" "}
                  </div>
                )}{" "}
                <label>
                  {" "}
                  Name{" "}
                  <input
                    value={leadForm.name}
                    disabled={profileFieldsDisabled}
                    onChange={(e) =>
                      bumpProfileEdit({ ...leadForm, name: e.target.value })
                    }
                  />{" "}
                </label>{" "}
                <label>
                  {" "}
                  Role label{" "}
                  <select
                    value={leadForm.roleLabel}
                    disabled={profileFieldsDisabled}
                    onChange={(e) =>
                      bumpProfileEdit({ ...leadForm, roleLabel: e.target.value })
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
                  <textarea
                    rows={3}
                    className="profile-area"
                    value={leadForm.background}
                    disabled={profileFieldsDisabled}
                    onChange={(e) =>
                      bumpProfileEdit({ ...leadForm, background: e.target.value })
                    }
                  ></textarea>{" "}
                </label>{" "}
                <label>
                  {" "}
                  Subjects already familiar{" "}
                  <textarea
                    rows={3}
                    className="profile-area"
                    value={leadForm.familiarTopics}
                    disabled={profileFieldsDisabled}
                    onChange={(e) =>
                      bumpProfileEdit({
                        ...leadForm,
                        familiarTopics: e.target.value,
                      })
                    }
                  ></textarea>{" "}
                </label>{" "}
                <label>
                  {" "}
                  Subjects needing simpler explanation{" "}
                  <textarea
                    rows={3}
                    className="profile-area"
                    value={leadForm.simplerTopics}
                    disabled={profileFieldsDisabled}
                    onChange={(e) =>
                      bumpProfileEdit({
                        ...leadForm,
                        simplerTopics: e.target.value,
                      })
                    }
                  ></textarea>{" "}
                </label>{" "}
                <label>
                  {" "}
                  Communication preferences{" "}
                  <textarea
                    rows={4}
                    className="profile-area"
                    value={leadForm.commPrefs}
                    disabled={profileFieldsDisabled}
                    onChange={(e) =>
                      bumpProfileEdit({ ...leadForm, commPrefs: e.target.value })
                    }
                  ></textarea>{" "}
                </label>{" "}
                <div className="meetctl">
                  {" "}
                  <button
                    onClick={() => {
                      if (profileConflict !== null || !profileResolved || sessGate) return;
                      const attempt: ProfileSaveAttempt = {
                        name: leadForm.name,
                        roleLabel: leadForm.roleLabel,
                        background: leadForm.background,
                        familiarTopics: leadForm.familiarTopics,
                        simplerTopics: leadForm.simplerTopics,
                        commPrefs: leadForm.commPrefs,
                        baseId: profileBase.id,
                        baseVersion: profileBase.version,
                      op: profileOpRef.current,
                        editRev: profileEditRev.current,
                        epoch: epochNow(),
                        token: currentToken(),
                        user: canonicalUser(),
                      };
                      saveLead.mutate(attempt);
                    }}
                    disabled={!leadForm.name.trim() || saveLead.isPending || sessGate || !profileResolved || profileConflict !== null}
                  >
                    {" "}
                    {saveLead.isPending ? "Saving..." : "Save profile"}{" "}
                  </button>{" "}
                </div>{" "}
                {profileConflict !== null && (
                  <div className="meetctl">
                    {" "}
                    <button type="button" onClick={() => { void reloadSavedProfile(); }} disabled={profile.isFetching || sessGate || profileReloading}>
                      {" "}
                      Reload saved profile{" "}
                    </button>{" "}
                  </div>
                )}{" "}
                {profileConflict !== null && (
                  <p role="status">Reloading discards unsaved edits after confirmation.</p>
                )}{" "}
                {profileDirty && !saveLead.isPending && (
                  <p role="status">Unsaved changes.</p>
                )}{" "}
                {!leadForm.name.trim() && (
                  <p role="status">Enter your name to enable saving.</p>
                )}{" "}
                {saveLead.isPending && <p role="status">Saving...</p>}{" "}
                {saveMsg && <p role="status">{saveMsg}</p>}{" "}
                {saveErr && <p role="alert">{saveErr}</p>}{" "}
              </>
</section>
          )}{" "}
          {tab === "settings" && (
            <section aria-label="Settings">
              {" "}
              <h2>Settings</h2>{" "}

              <div className="card">
                {" "}
                <h3>Model connection (installation admin only)</h3>{" "}
                {!boardId && (<p role="status">Select a board to verify installation-admin controls.</p>)}{" "}
                {!!boardId && !capsAdmin && (<p role="status">Restricted to installation admins.</p>)}{" "}
                {capsAdmin && (<>
                {" "}
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
                        : "Connection test failed"
                      : "Not tested yet"}{" "}
                  </p>
                )}{" "}
                {modelStatus.data && modelStatus.data.lastTestAt && !modelStatus.data.lastTestOk && !!modelStatus.data.lastTestError && (
                  <ReviewAlert message={String(modelStatus.data.lastTestError)} />
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
                </>)}{" "}
              </div>{" "}
              {boardId && isGuest && guestSettings.data && (
                <div className="card">
                  {" "}
                  <p role="status">Read-only guest settings for your assigned meeting.</p>{" "}
                  <dl>
                    <dt>Board</dt><dd>{guestSettings.data.name}</dd>
                    <dt>Mission</dt><dd>{guestSettings.data.mission}</dd>
                    <dt>Stage</dt><dd>{guestSettings.data.stage}</dd>
                    <dt>Discussion rhythm</dt><dd>{guestSettings.data.discussionPolicy}</dd>
                    <dt>Lead</dt><dd>{guestSettings.data.lead ? `${guestSettings.data.lead.name} (${guestSettings.data.lead.roleLabel})` : "\u2014"}</dd>
                  </dl>{" "}
                </div>
              )}{" "}
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
                    <div className="card" data-roster-entry-id={selRow.entry.id}>{" "}
                      <h3>{selRow.entry.name}</h3>{" "}
                      <span className="badge">{" "}{selRow.complete ? "complete" : "incomplete: " + selRow.missing.join(", ")}{" "}</span>{" "}
                      <span className="badge">{" "}{selRow.imageCount} portrait{selRow.imageCount === 1 ? "" : "s"}{" "}</span>{" "}
                      <span className="badge">{" "}v{selRow.entry.version}{" "}</span>{" "}
                      <p>{selRow.entry.description}</p>{" "}
                      <ProfileFields profileJson={selRow.entry.profileJson} />{" "}
                      {(() => {
                        const d = selResearchData as any;
                        const err = selResearchDataError;
                        if (selResearchLoading) return (<p role="status">{" "}Checking research\u2026{" "}</p>);
                        if (err) return (<p className="muted">Research state unavailable. <button type="button" onClick={() => void selResearch.refetch()} disabled={selResearch.isFetching}>Check research status</button></p>);
                        const running = isRosterResearchRunning(d);
                        if (running) {
                          const ev = typeof d?.evidenceCount === "number" ? d.evidenceCount : selRow.entry.evidenceCount;
                          const st = String(d?.stage ?? "");
                          return (<p role="status">{" "}Research in progress{st ? " \u00b7 " + st : ""} \u00b7 {ev} evidence claims{" "}</p>);
                        }
                        if (d) {
                          const ev = typeof d?.evidenceCount === "number" ? d.evidenceCount : 0;
                          const ds = String(d?.draftStatus ?? "");
                          const st = String(d?.stage ?? "");
                          const verLabel = typeof d?.version === "number" ? " v" + d.version : " v" + selRow.entry.version;
                          if (d?.researchedAt && (ds === "draft" || ds === "done" || ds === "saved") && ev > 0) return (<p className="muted">{" "}Researched{verLabel} \u00b7 {ev} evidence claims{" "}</p>);
                          if (st === "failed" || ds === "failed") return (<p className="muted">{" "}Research failed — retry in the editor below.{" "}</p>);
                          if (st === "unsupported" || ds === "unsupported") return (<p className="muted">{" "}Research incomplete \u2014 no grounded evidence. Editable below.{" "}</p>);
                          if (st === "superseded" || ds === "superseded") return (<p className="muted">{" "}A newer version won on the server \u2014 review, then run research again if needed.{" "}</p>);
                          if (st === "interrupted" || ds === "interrupted") return (<p className="muted">{" "}Research interrupted \u2014 use Check again.{" "}</p>);
                          if (d?.researchedAt) return (<p className="muted">{" "}Researched{verLabel} \u00b7 {ev} evidence claims{" "}</p>);
                          if (d?.researchRequested) return (<p className="muted">{" "}Research requested \u2014 not running. Open the editor below for its result and retry if needed.{" "}</p>);
                          return (<p className="muted">{" "}No research yet \u2014 use Research dossier below to gather evidence.{" "}</p>);
                        }
                        if (selRow.entry.researchedAt) return (<p className="muted">{" "}Researched\u2026{" "}</p>);
                        if (selRow.entry.researchRequested) return (<p className="muted">{" "}Research requested \u2014 not running. Open the editor below for its result and retry if needed.{" "}</p>);
                        return (<p className="muted">{" "}No research yet \u2014 use Research dossier below to gather evidence.{" "}</p>);
                      })()}
                      {(selImages.data ?? []).length > 0 ? (
                        <div aria-label="Portraits awaiting review">
                          <h4>Portraits - accept one before approval</h4>
                          {(selImages.data ?? []).map((im) => {
                            const status = !im.review || im.review === "accepted" ? "accepted" : im.review === "pending" ? "pending" : "rejected";
                            return (
                              <div className="card portrait-review" key={im.id} data-portrait-id={im.id} data-roster-entry-id={selRow.entry.id}>
                                <AuthedImg id={im.id} alt="Portrait option" className="portrait-thumb" />
                                <div>
                                  <div>
                                    <span className="badge">{im.kind === "generated" ? "Generated" : im.kind === "url" ? "Link" : "Uploaded"}</span>
                                    <span className={status === "accepted" ? "badge ok" : status === "pending" ? "badge live" : "badge warn"}>{status === "pending" ? "needs review" : status === "rejected" ? "needs replacement" : "accepted"}</span>
                                  </div>
                                  <p className="muted">{im.kind === "generated" ? "Generated for this advisor" : im.kind === "url" ? "Imported from a link" : "Uploaded by the owner"}</p>
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
                        <button disabled={!boardId || !canManageBoard || !selRow.complete} title={!boardId ? "Pick a board first" : selRow.complete ? "Attach to current board" : "Complete this entry first: " + selRow.missing.join(", ")} onClick={() => copyAdv.mutate(selRow)}>{" "}Add to current board{" "}</button>{" "}
                        <button onClick={() => { archiveRoster.mutate(selRow); setSelRoster(""); }}>{" "}Archive{" "}</button>{" "}
                        <button onClick={() => { try { document.getElementById("roster-portrait")?.scrollIntoView({ block: "nearest" }); } catch { /* noop */ } }}>{" "}Add portrait{" "}</button>{" "}
                      </div>{" "}
                      <h4>{" "}Audition (never a meeting message){" "}</h4>{" "}
                      <label>{" "}Sample question{" "}
                        <input value={aq} onChange={(e) => setAq(e.target.value)} placeholder="Ask the starter question" />{" "}</label>{" "}
                      <button disabled={!canActMeeting || !aq.trim() || runAud.isPending} onClick={() => runAud.mutate()}>{" "}Run audition{" "}</button>{" "}
                      {audResult && <div className="btext">{audResult}</div>}{" "}
                      <h4>{" "}Research dossier{" "}</h4>{" "}
                      <button onClick={() => research(selRow.entry.id)}>{" "}Research dossier{" "}</button>{" "}
                      <DossierView raw={dossier} />{" "}
                      <div className="card" id="roster-portrait">{" "}
                        <h4>{" "}Add a portrait{" "}</h4>{" "}
                        <p className="muted">{" "}Portraits are explicit choices only — nothing generates automatically.{" "}</p>{" "}
                        <label>{" "}Upload image{" "}
                          <input type="file" accept="image/*" onChange={(e) => uploadPortrait(e.target.files?.[0])} />{" "}</label>{" "}
                        <label>{" "}Use image URL{" "}
                          <input value={portraitUrl} onChange={(e) => setPortraitUrl(e.target.value)} placeholder="https://..." />{" "}</label>{" "}
                        <div className="meetctl">{" "}
                          <button disabled={!portraitUrl || urlPortrait.isPending} onClick={() => urlPortrait.mutate(portraitUrl)}>{" "}Import URL{" "}</button>{" "}
                          <button disabled={genPortrait.isPending} onClick={() => genPortrait.mutate()}>{" "}Generate portrait{" "}</button>{" "}
                        </div>{" "}
                        {portraitMsg && <p role="status">{portraitMsg}</p>}{" "}
                      </div>{" "}
                      {selRow && (
                        <RosterChatPanel
                          key={selRow.entry.id}
                          rosterId={selRow.entry.id}
                          identity={canonicalUser()}
                          advisorName={selRow.entry.name}
                          rosterVersion={selRow.entry.version}
                          complete={selRow.complete}
                          missing={selRow.missing}
                          canChat={!!selRow}
                          api={{ post }}
                        />
                      )}{" "}
                      {selRow && (
                        <CharacterEditor
                          key={selRow.entry.id}
                          entry={{ researchJson: "", researchJobId: "", researchBaseVersion: 0, ...selRow.entry } as any}
                          get={get}
                          post={post}
                          put={put}
                          originIdentity={originIdentity}
                          originStale={originStale}
                          originRevision={originRevision()}
                          resolveCanonicalEntry={resolveCanonicalEntry}
                          freshCreation={false}
                          onSaved={() => {
                            refresh(...CANONICAL_SAVE_INVALIDATIONS, "roster-research");
                          }}
                          onInvalidated={() => {
                            refresh(...CANONICAL_SAVE_INVALIDATIONS, "roster-research");
                          }}
                        />
                      )}{" "}
                    </div>
                  ) : (
                  <p className="muted">Select an advisor from the list to see their record.</p>
                  )}{" "}
                </div>{" "}
              {createOpen && (
                <div className="modal-backdrop" onClick={closeCreate}>
                  {" "}
                  <div className="modal" role="dialog" aria-modal="true" aria-label="Create advisor" onClick={(e) => e.stopPropagation()}>
                    {" "}
                    <div className="meetctl">
                      {" "}
                      <button type="button" className="btn ghost" onClick={closeCreate} aria-label="Close">{" "}X{" "}</button>{" "}
                    </div>{" "}
                    <CreateAdvisor
                      accountId={accountId}
                      get={get}
                      post={post}
                      put={put}
                      originIdentity={originIdentity}
                      originStale={originStale}
                      originRevision={originRevision()}
                      resolveCanonicalEntry={resolveCanonicalEntry}
                      onCreated={(entry) => {
                        refresh(...CANONICAL_SAVE_INVALIDATIONS, "roster-research");
                        try { setSelRoster(entry.id); setAudId(entry.id); } catch { /* noop */ }
                      }}
                      onInvalidated={() => {
                        refresh(...CANONICAL_SAVE_INVALIDATIONS, "roster-research");
                      }}
                      onClose={closeCreate}
                    />{" "}
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
                    <label key={row.entry.id} className="checkline">{" "}
                      <input type="checkbox" disabled={!boardId || !canManageBoard || (!attached && (full || !row.complete))} checked={!!attached} onChange={() => toggleBoardAdvisor(row)} />{" "}
                      {row.entry.name}{" "}{attached ? (attached.approved ? "(approved)" : "(pending approval)") : row.complete ? "" : "(incomplete: " + row.missing.join(", ") + ")"}{" "}
                    </label>
                  );
                })}{" "}
                  </>
                )}{" "}
                {canManageBoard && (<button type="button" onClick={() => setTab("roster")}>{" "}Create new Advisor{" "}</button>)}{" "}
              </div>{" "}
              {(advisors.data ?? []).length >= 10 && (
                <p>Remove an advisor to add another.</p>
              )}{" "}
              {(advisors.data ?? []).map((a) => (
                <div className="card" key={a.id} data-advisor-id={a.id} data-roster-entry-id={a.rosterEntryId}>
                  {" "}
                  {a.boardRole}{" "}
                  <span className="badge">
                    {" "}
                    {a.approved ? "approved" : "pending"} · roster v{a.rosterVersion}{" "}
                  </span>{" "}
                  {(() => {
                    const re = (rosterNames.data ?? []).find((r) => r.entry.id === a.rosterEntryId);
                    const current = re ? re.entry.version : a.rosterVersion;
                    const stale = current > a.rosterVersion;
                    const link = { advisorId: a.id, boardId, rosterEntryId: a.rosterEntryId, pinnedVersion: a.rosterVersion, currentVersion: current, stale, name: a.boardRole, boardRole: a.boardRole, approved: a.approved, portraitFingerprint: a.imageProvenance, behaviorFingerprint: "roster v" + current };
                    return (
                      <>
                        {" "}
                        <RosterLinkBadge advisor={link} />{" "}
                        <BoardAdvisorLinkPanel advisor={link} />{" "}
                        {stale && (<p role="status">{" "}The roster profile changed since this board copy was pinned — update from the roster and re-review before approving.{" "}</p>)}{" "}
                      </>
                    );
                  })()}{" "}
                  {!a.approved && canManageBoard && (
                    <button
                      onClick={() =>
                        post<unknown>(
                          `/api/boards/${boardId}/advisors/${a.id}/approve`,
                          {},
                        ).then(() => refresh("advisors", "setup")).catch((e) => toastErr(e))
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
                        <span className="badge">{img.kind === "generated" ? "Generated" : img.kind === "url" ? "Link" : "Uploaded"}</span>{" "}
                        <span className="muted">{img.kind === "generated" ? "Generated for this advisor" : img.kind === "url" ? "Imported from a link" : "Uploaded by the owner"}</span>{" "}
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
                  {boardDenied ? (
                    <div className="card" role="alert">
                      {" "}
                      <p>Not authorized for this board. Pick an allowed board below, or close this one.</p>{" "}
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => {
                          setBoardId("");
                          setMeetingId("");
                          setMeetPicks([]);
                        }}
                      >
                        {" "}
                        Close board{" "}
                      </button>{" "}
                    </div>
                  ) : (
                    <>
                  {" "}
                  <details className="meet-left" open={meetNavOpen} onToggle={(e) => { try { setMeetNavOpen((e.target as HTMLDetailsElement).open); } catch {} }}>
                    {" "}
                    <summary>Meetings ({(meetings.data ?? []).length}) — {curMeeting?.title ?? "Select a meeting"}</summary>{" "}
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
                        <p>{isGuest ? "Your assigned meeting is open in the discussion panel." : "No meetings yet"}</p>
                      )}{" "}
                    {(meetings.data ?? []).length === 0 &&
                      (allMeetings.data ?? []).length > 0 && (
                        <p role="status">
                          No meetings match this filter — the open meeting
                          stays selected below.
                        </p>
                      )}{" "}
                  </details>{" "}
                  {meetingDenied ? (
                    <div className="card" role="alert">
                      {" "}
                      <p>Not authorized for this meeting. The board route is kept; pick an allowed meeting from the list, or return to the board.</p>{" "}
                      <button
                        type="button"
                        onClick={() => {
                          setMeetingId("");
                          setRecId("");
                        }}
                      >
                        {" "}
                        Back to board meetings{" "}
                      </button>{" "}
                    </div>
                  ) : (
                    meetingId ? (
                      <>
                        {" "}
                        <div className="meet-center">
                        {" "}
                        <ConversationHeader
                          meetingTitle={curMeeting?.title ?? "Meeting"}
                          meetingBrief={curMeeting?.brief ?? ""}
                          stateLabel={curMeeting ? meetingStateLabel(curMeeting.state) : "No meeting"}
                          live={live}
                          messageCount={delivery.data?.messages ?? null}
                          canManageMeeting={canManageMeeting}
                          canCreateMeeting={canManageBoard}
                          canDiscussMeeting={canDiscussMeeting}
                          pauseAvailable={curMeeting?.state === 1}
                          resumeAvailable={curMeeting?.state === 3}
                          endAvailable={curMeeting != null && meetingIsOpen(curMeeting.state)}
                          briefReady={!!briefText.trim()}
                          requestPending={runDiscussion.isPending}
                          requestAvailable={canDiscussMeeting && !!briefText.trim() && curMeeting != null && (curMeeting.state === 0 || curMeeting.state === 1)}
                          onNewMeeting={() => createMeeting.mutate()}
                          onOpenSettings={openSettings}
                          onPause={() => meetingCtl("pause")}
                          onResume={() => meetingCtl("resume")}
                          onEnd={() => meetingCtl("end")}
                          onRequestResponses={() => {
                            if (!(canDiscussMeeting && !!briefText.trim() && curMeeting != null && (curMeeting.state === 0 || curMeeting.state === 1))) {
                              toastErr("Request advisor responses is available while the meeting is awaiting a brief or active, with a brief and discuss access. Paused or closed meetings stay untouched — the composer draft is preserved.");
                              return;
                            }
                            const rc = sendRetryCtx; if (rc && (rc as any).meetingId === meetingId) { retryResponses(rc); return; } requestFreshResponses();
                          }}
                        />{" "}
                        <MeetingSettingsDialog
                          open={settingsOpen}
                          title={mtitle}
                          brief={mbrief}
                          policy={policy}
                          participants={(advisors.data ?? []).map((a) => {
                            const included = meetPartDraft.length === 0 || meetPartDraft.includes(a.id);
                            const wouldEmpty = meetPartDraft.length === 0
                              ? (advisors.data ?? []).length <= 1
                              : (meetPartDraft.length === 1 && meetPartDraft.includes(a.id));
                            return { id: a.id, role: a.boardRole, included, locked: included && wouldEmpty };
                          })}
                          canManageMeeting={canManageMeeting}
                          meetingSelected={!!meetingId}
                          meetingOpen={curMeeting != null && meetingIsOpen(curMeeting.state)}
                          meetingClosed={curMeeting != null && !meetingIsOpen(curMeeting.state)}
                          onClose={closeMeetingSettings}
                          onTitle={setMtitle}
                          onBrief={setMbrief}
                          onPolicy={setPolicy}
                          onToggleParticipant={toggleMeetPart}
                          onSelectAll={() => setMeetPartDraft([])}
                          onSave={() => saveMeeting.mutate()}
                          onCloseWithRecord={() => closeMeeting(true)}
                          onCloseWithoutPublication={() => closeMeeting(false)}
                          onReopen={reopenMeeting}
                        >
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

                                <button
                                  type="button"
                                  className="primary"
                                  onClick={() => {
                                    closeMeetingSettings(); if (latestDraft) setRecId(latestDraft.id);
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
                                {canActMeeting && (<button
                                  type="button"
                                  className="btn ghost"
                                  disabled={!meetingId || fromDirection.isPending}
                                  onClick={() => fromDirection.mutate(n.id)}
                                  title="Stage this exact direction text for record review"
                                >
                                  {" "}
                                  Record this direction{" "}
                                </button>)}{" "}
                              </div>
                            ))}{" "}
                            {(directions.data ?? []).length === 0 && (
                              <p>No directions adopted yet.</p>
                            )}{" "}
                            {canActMeeting && (<>
                            <label>
                              {" "}
                              Exact text{" "}
                              <textarea
                                rows={4}
                                value={dtext}
                                onChange={(e) => { dtextRev.current++; setDtext(e.target.value); }}
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
                              disabled={!canActMeeting || !dtext.trim()}
                              onClick={() => adopt.mutate()}
                            >
                              {" "}
                              Adopt exact text{" "}
                            </button>
                            </>)}{" "}
                          </div>
                          <div className="card">
                            {" "}
                            <h3>
                              {" "}
                              Key takeaways (provisional — never decisions){" "}
                            </h3>{" "}
                            {(notes.data ?? [])
                              .filter((n) => n.kind === "briefing" || n.kind === "secretary-briefing")
                              .map((n) => {
                                let exs: any[] = [];
                                try { exs = JSON.parse(n.evidenceJson ?? "[]"); } catch { exs = []; }
                                return (
                                <div key={n.id} className="takenote">
                                  {" "}
                                  <b>{n.title}</b>{" "}
                                  <span className="muted">Provisional</span>{" "}
                                  {n.body.length > 400 ? (
                                    <details>
                                      {" "}
                                      <summary>Show full briefing</summary>{" "}
                                      <div>{n.body}</div>{" "}
                                    </details>
                                  ) : (
                                    <div>{n.body}</div>
                                  )}{" "}
                                  {exs.length > 0 && (
                                    <div className="excerpts">{exs.slice(0, 6).map((e: any, i: number) => (<div key={i} className="excerpt-card"><b>{e.title ?? (e.kind === "record" ? "Record excerpt" : "Source excerpt")}</b><div>{e.excerpt ?? ""}</div><div className="muted">{e.kind === "record" ? "Record" : "Source"}{e.version ? " · version " + e.version : ""}</div></div>))}</div>
                                  )}{" "}
                                  {n.body.indexOf("Limitation:") >= 0 && <div className="muted">No eligible sources were available for this meeting.</div>}{" "}
                                </div>
                                );
                              })}{" "}
                            {(notes.data ?? []).filter((n) => n.kind === "briefing" || n.kind === "secretary-briefing").length === 0 && <p>No briefings yet.</p>}{" "}
                            {canActMeeting && (<div className="card"><b>Prepare briefing</b><div className="muted">Grounded in approved sources, adopted directions, and approved records for this meeting.</div><label>Briefing topic<input value={btopic} onChange={(e) => { try { briefVisitRef.current++; } catch { /* noop */ } setBtopic(e.target.value); }} placeholder="e.g. pricing risks" /></label>{" "}<button type="button" onClick={() => { if (!askBriefing.isPending && btopic.trim()) askBriefing.mutate({ oB: boardId, oM: meetingId, oU: secIdentity(), oEp: secEpoch.current, origin: originIdentity(), topic: btopic, visit: briefVisitRef.current, opId: "brief-" + (++opSeq.current) }); }} disabled={!canActMeeting || !btopic.trim() || askBriefing.isPending}>{askBriefing.isPending ? "Preparing..." : "Prepare briefing"}</button></div>)}{" "}
                            {secQuestion && (
                              <div className="card" role="status">
                                <b>Secretary clarification</b>
                                <div>{secQuestion}</div>
                                {secOmitted.length > 0 && (<div className="muted">Omitted from packet (not cited): {humanizeOmission(secOmitted)}</div>)}
                                <label>Answer<input value={secAnswer} onChange={(e) => { try { secComposerTouched.current = true; } catch { } try { secAnsVer.current++; } catch { /* noop */ } try { secAnsOwnerReq.current = secRequestId; } catch { } try { secAnsOwnerHyd.current = false; } catch { } setSecAnswer(e.target.value); }} /></label>{" "}
                                <button type="button" onClick={() => { if (!answerSecretary.isPending) answerSecretary.mutate(buildAnswerVars()); }} disabled={!secAnswer.trim() || answerSecretary.isPending}>{answerSecretary.isPending ? "Sending..." : "Send answer"}</button>{" "}
                              </div>
                            )}{" "}
                            {secError && (<div className="card" role="alert"><b>Secretary error</b><FriendlyError friendly={friendlyError(secError) || "The secretary request did not complete. Check the setup guidance above, then retry."} technical={secError} />{secRequestId && secQuestion ? (<button type="button" onClick={() => { if (!answerSecretary.isPending && !secPendingRef.current) answerSecretary.mutate(buildAnswerVars()); }} disabled={!secAnswer.trim() || answerSecretary.isPending}>Retry answer (same request)</button>) : (<button type="button" onClick={() => { if (!retrySecretary.isPending && !secPendingRef.current) { const uRet = secIdentity(); try { secEnvelopeRev.current++; } catch { } try { secHydRef.current++; } catch { } retrySecretary.mutate({ opId: "retry-" + (++opSeq.current), boardId, meetingId, user: uRet, epoch: secEpoch.current, origin: originIdentity(), envRevCap: secEnvelopeRev.current, hydRevCap: secHydRef.current, env: readEnvelope(secEnvelopeKey(uRet, boardId, meetingId)) }); } }} disabled={retrySecretary.isPending}>Retry secretary (same envelope)</button>)}<button type="button" onClick={() => { try { secHydRef.current++; } catch { } try { secEnvelopeRev.current++; } catch { } const u = secIdentity(); try { localStorage.removeItem(secEnvelopeKey(u, boardId, meetingId)); localStorage.removeItem(secAnsEnvelopeKey(u, boardId, meetingId)); localStorage.removeItem(secPendingKey(u, boardId, meetingId)); localStorage.removeItem(secSubmitKey(u, boardId, meetingId)); } catch { } try { secHistRef.current++; } catch { /* noop */ } try { secEditSess.current++; } catch { /* noop */ } try { secEditVisit.current++; } catch { /* noop */ } try { secHistSel.current = ""; } catch { /* noop */ } setSecError(""); setSecQuestion(""); setSecRequestId(""); setSecAnswer(""); try { secAnsOwnerReq.current = ""; } catch { } try { secAnsOwnerHyd.current = false; } catch { } setSecOmitted([]); try { secOmittedReq.current = ""; } catch { } setSecEditId(""); setSecEditBody(""); setSecHistory(null); }}>Clear saved retry</button></div>)}{" "}
                            {secOmitted.length > 0 && (<div className="muted">Omitted from packet (not cited): {humanizeOmission(secOmitted)}</div>)}
                            <h3>Secretary provisional notes</h3>{" "}
                            {(notes.data ?? [])
                              .filter((n) => (n.kind === "secretary-note" || n.kind === "secretary-briefing" || n.kind === "note" || n.kind === "briefing") && !(n.kind ?? "").startsWith("run-") )
                              .map((n) => {
                                let exs2: any[] = [];
                                try { exs2 = JSON.parse(n.evidenceJson ?? "[]"); } catch { exs2 = []; }
                                const rev = (n as any).revision ?? 1;
                                const st = (n as any).noteStatus ?? "current";
                                const isCur = st === "current";
                                return (
                                <div key={n.id} className="takenote">
                                  <b>{n.title}</b>{" "}
                                  <span className="muted">Provisional rev {rev} {st}{isCur ? "" : " (read-only)"}</span>{" "}
                                  {n.body.length > 400 ? (<details open={false}><summary>Show full note (rev {rev})</summary><div>{n.body}</div></details>) : (<div>{n.body}</div>)}{" "}
                                  {exs2.length > 0 && (<div className="excerpts">{exs2.map((e: any, i: number) => (<div key={i} className="excerpt-card"><b>{e.title ?? (e.kind === "record" ? "Record excerpt" : "Source excerpt")}</b><div>{e.excerpt ?? ""}</div><div className="muted">{e.kind === "record" ? "Record" : "Source"}{e.version ? " · version " + e.version : ""}{e.location ? " " + e.location : ""}{e.indexGeneration != null ? " snapshot " + e.indexGeneration : ""}</div><div className="muted">Historical quote; current availability is resolved in History view per reference.</div></div>))}</div>)}{" "}
                                  {n.body.indexOf("Limitation:") >= 0 && <div className="muted">No eligible sources were available for this meeting.</div>}{" "}
                                  <button type="button" onClick={() => { try { secHistSel.current = n.id; } catch { } loadHistory(n.id); }}>History</button>{" "}
                                  {isCur && canActMeeting ? (<><button type="button" onClick={() => { setSecEditId(n.id); setSecEditBody(n.body); try { secEditSess.current++; } catch { } try { secHistSel.current = n.id; } catch { } try { secEditVisit.current++; } catch { } }} disabled={editNote.isPending}>Edit</button>{" "}<button type="button" onClick={() => { if (!reverseNote.isPending) reverseNote.mutate({ id: n.id, revision: rev, oB: boardId, oM: meetingId, oU: secIdentity(), oEp: secEpoch.current, origin: originIdentity(), opId: "rev-" + n.id + "-" + rev + "-" + (++opSeq.current) }); }} disabled={reverseNote.isPending}>Reverse</button></>) : (<span className="muted">{isCur ? " Requires contribute access to edit." : " Superseded/reversed: read-only; open History for full text."}</span>)}{" "}
                                  {secEditId === n.id && (<div><textarea rows={4} value={secEditBody} onChange={(e) => { setSecEditBody(e.target.value); try { secEditSess.current++; } catch { } }} /><button type="button" onClick={() => editNote.mutate({ id: n.id, revision: rev, body: secEditBody, oB: boardId, oM: meetingId, oU: secIdentity(), oEp: secEpoch.current, origin: originIdentity(), opId: "edit-" + n.id + "-" + rev + "-" + (++opSeq.current) })}>Save revision</button><button type="button" className="btn ghost" onClick={() => { setSecEditId(""); try { secEditVisit.current++; } catch { } try { secEditSess.current++; } catch { } }}>Cancel</button></div>)}{" "}
                                </div>
                                );
                              })}{" "}
                            <h3>All note history (including reversed)</h3>{" "}
                            {((notesHistoryAll.data ?? []) as any[]).length === 0 && <p className="muted">No note history yet. Reversed notes remain discoverable here after reload.</p>}{" "}
                            {((notesHistoryAll.data ?? []) as any[]).map((g: any) => (
                              <div key={g.root} className="takenote">
                                {" "}<b>Record group</b>{" "}
                                <span className="muted">{(g.current && (g.current.noteStatus || g.current.NoteStatus)) || ""} rev {(g.current && (g.current.revision ?? g.current.Revision)) ?? ""}</span>{" "}
                                <div>{(g.current && (g.current.title || g.current.Title)) || ""}</div>{" "}
                                <button type="button" onClick={() => loadHistory(g.current.id || g.current.Id)}>History</button>{" "}
                              </div>
                            ))}{" "}
                            {secHistory && (<div className="card"><b>History</b><div>Record group</div>{((secHistory as any).availability ?? []).length > 0 && (<div className="excerpts">{((secHistory as any).availability ?? []).map((a: any, i: number) => (<div key={i} className="excerpt-card"><b>{a.title ?? (a.kind === "record" ? "Record excerpt" : "Source excerpt")}</b><div className="muted">{a.kind === "record" ? "Record" : "Source"} current availability: {a.available ? "available" : "unavailable"} ({a.reason})</div></div>))}</div>)}{((secHistory as any).revisions ?? []).map((r: any) => (<details key={r.id}><summary>rev {r.revision} {r.noteStatus}: {r.title}</summary><div>{r.body}</div></details>))}{((secHistory as any).history ?? []).map((h: any) => (<details key={h.id}><summary>{h.action} rev {h.revision}</summary><div>{h.body}</div></details>))}<button type="button" onClick={() => { setSecHistory(null); try { secHistSel.current = ""; } catch { } try { secHistRef.current++; } catch { } }}>Close</button></div>)}{" "}
                            <label>
                              {" "}
                              Note title{" "}
                              <input
                                value={ntitle}
                                onChange={(e) => { try { noteVisitRef.current++; noteDraftRev.current++; } catch { /* noop */ } setNtitle(e.target.value); }}
                              />{" "}
                            </label>{" "}
                            <label>
                              {" "}
                              Note body{" "}
                              <input
                                value={nbody}
                                onChange={(e) => { try { noteVisitRef.current++; noteDraftRev.current++; } catch { /* noop */ } setNbody(e.target.value); }}
                              />{" "}
                            </label>{" "}
                            {canActMeeting && (<button
                              type="button"
                              onClick={() => addNote.mutate()}
                            >
                              {" "}
                              Save note{" "}
                            </button>)}{" "}
                          </div>
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
                                      <b>{h.kind === "record" ? "Record excerpt" : "Source excerpt"}</b> <div>{h.text}</div>{" "}
                                    </div>
                                  ))}{" "}
                                  <button
                                    type="button"
                                    className="btn ghost"
                                    onClick={() => { closeMeetingSettings(); setTab("sources"); }}
                                  >
                                    {" "}
                                    Open sources{" "}
                                  </button>{" "}
                                </div>{" "}
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
                                      closeMeetingSettings();
                                      if (latestDraft) setRecId(latestDraft.id);
                                      setTab("records");
                                    }}
                                  >
                                    {" "}
                                    Open records{" "}
                                  </button>{" "}
                                </div>{" "}
                        </MeetingSettingsDialog>{" "}


                            <ConversationSearchField value={sq} onChange={setSq} onSearch={searchMsgs} resultCount={hits.length > 0 ? hits.length : null} />{" "}
                            {hits.length > 0 && (
                              <ul className="search-hits" aria-label="Conversation search results">
                                {" "}
                                {hits.map((h) => (
                                  <li key={h.sequence}>
                                    {" "}
                                    <button type="button" className="btn ghost" onClick={() => jumpToMessage(h.sequence)}>
                                      {" "}
                                      Message from {h.advisorName || (h.sender === "lead" ? (lead.data?.name ?? "Board lead") : h.sender)}{" "}
                                    </button>{": "}{h.excerpt}{" "}
                                  </li>
                                ))}{" "}
                              </ul>
                            )}{" "}
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
                            {sendPhase !== "idle" && (<div role="status" className="status-line"><span className="badge live">{sendPhase === "sending" ? "Sending" : sendPhase === "working" ? "Working" : sendPhase === "complete" ? "Complete" : sendPhase === "no-contributions" ? "No contributions" : "Error"}</span><span>{sendStatus || sendPhase}</span></div>)}{" "}
                            {(sendPhase === "error" || sendPhase === "no-contributions") && sendRetryCtx && sendRetryCtx.meetingId === meetingId && (<div className="card" role="alert"><b>{sendPhase === "error" ? "Advisor responses failed" : "No advisor responses"}</b><div>{sendStatus}</div><div className="muted">{sendRetryCtx.saveConfirmed ? "Retry sends only the responses step for the same lead message." : "Retry sends only the advisor-responses step again."}</div><button type="button" onClick={() => retryResponses(sendRetryCtx)} disabled={runDiscussion.isPending || send.isPending}>Retry responses (same lead)</button>{" "}{sendConflict && sendConflict.kind === "lead-version" && (<span><button type="button" onClick={() => { const rc = sendRetryCtx; if (!rc || rc.meetingId !== meetingId) return; const v = lead.data ? lead.data.version : null; if (v == null) return; retryResponses({ ...rc, leadVersion: v }); }} disabled={runDiscussion.isPending || send.isPending}>Retry with current lead profile{typeof (lead.data ? lead.data.version : null) === "number" ? " (v" + String(lead.data ? lead.data.version : null) + ")" : ""}</button>{" "}</span>)}{" "}<button type="button" className="btn ghost" onClick={() => { setSendPhase("idle"); setSendStatus(""); setSendRetryCtx(null); setSendConflict(null); phaseOpRef.current = null; }}>Dismiss</button></div>)}{" "}
                            {(askSecretary.isPending || retrySecretary.isPending || answerSecretary.isPending) && (<div role="status" className="status-line"><span className="badge live">Secretary</span><span>Secretary working...</span></div>)}{" "}
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
                                  {canActMeeting && (<option value="secretary">
                                    {" "}
                                    Secretary (direct){" "}</option>)}
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
                                  onChange={(e) => { secDraftVer.current++; setDraft(e.target.value); }}
                                  onKeyDown={(e) => {
                                    if ((e.nativeEvent as KeyboardEvent).repeat) return;
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
                                      ? "Stop and transcribe into draft"
                                      : "Dictate (mic): transcribes into this draft for editing before send"
                                  }
                                  aria-label={
                                    recording
                                      ? "Stop and transcribe into draft"
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
                                {(voiceStarting || recording || transcribing) && (
                                  <button
                                    type="button"
                                    onClick={() => cancelVoice()}
                                    title="Cancel dictation (discards this attempt, never sends)"
                                    aria-label="Cancel dictation"
                                  >
                                    Cancel
                                  </button>
                                )}{" "}
                                <button
                                  type="button"
                                  className="primary"
                                  onClick={() => submitDraft()}
                                  disabled={!meetingValid || curMeeting == null || !canDiscussMeeting || !draft.trim() || askSecretary.isPending || retrySecretary.isPending || answerSecretary.isPending || send.isPending || runDiscussion.isPending || submitBusyRef.current || sendPhase === "sending" || sendPhase === "working"}
                                >
                                  {" "}
                                  {(askSecretary.isPending || retrySecretary.isPending || answerSecretary.isPending) ? "Sending secretary..." : sendPhase === "sending" ? "Sending..." : sendPhase === "working" ? "Requesting responses..." : "Send"}{" "}
                                </button>{" "}
                              </div>{" "}
                              <div
                                className="muted"
                                style={{ fontSize: "0.78rem" }}
                              >
                                {" "}
                                Enter to send · Shift+Enter for a new line{" "}
                                {voiceStarting ? " · Requesting microphone…" : ""}{recording ? " · Recording… (mic stops and transcribes, Cancel discards)" : ""}{transcribing ? " · Transcribing…" : ""}
                                {voiceError && !recording && !transcribing ? " · Dictation failed: " + voiceError : ""}{" "}
                              </div>{" "}
                              {voiceError && !recording && !transcribing && (
                                <div role="alert" className="card" aria-label="Dictation failed">
                                  {" "}
                                  <b>Dictation failed</b>{" "}
                                  <div>{voiceError}</div>{" "}
                                  <div className="meetctl">
                                    {" "}
                                    <button type="button" onClick={() => { setVoiceError(null); void toggleRec(); }}>Record again</button>{" "}
                                    <button type="button" className="btn ghost" onClick={() => setVoiceError(null)}>Dismiss</button>{" "}
                                  </div>{" "}
                                </div>
                              )}{" "}
                            </div>{" "}

                      </div>{" "}
                      <div
                        className={
                          contextCollapsed
                            ? "meet-right collapsed"
                            : "meet-right"
                        }
                      >
                        {" "}
                        <MeetingParticipants participants={presenceWithSecretary} live={live && activityAvailability === "available"} availability={(activityAvailability as any) ?? "available"} />
                        {" "}
                        <div className="context-bar">
                          {" "}
                          <span className="muted">Meeting context</span>{" "}
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

                            {" "}
                                {" "}
                                <div className="card">
                                  {" "}
                                  <h3>Brief</h3>{" "}
                                  <p>
                                    {" "}
                                    {curMeeting?.brief || "No brief yet."}{" "}
                                  </p>{" "}
                                </div>{" "}
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
                    ) : (
                      <div className="meet-center">
                        {" "}
                        <div className="card" aria-label="No meeting selected">
                          {" "}
                          <h2>No meeting selected</h2>{" "}
                          <p className="muted">{" "}New meetings start a separate conversation. Pick a meeting from the list, or start one.{" "}</p>{" "}
                          {canManageBoard ? (
                            <button type="button" className="primary" onClick={() => createMeeting.mutate()} disabled={createMeeting.isPending}>
                              {" "}
                              {createMeeting.isPending ? "Creating…" : "New meeting"}{" "}
                            </button>
                          ) : (
                            <p role="status">{" "}Ask a board manager to start a meeting, or pick one from the list.{" "}</p>
                          )}{" "}
                        </div>{" "}
                      </div>
                    )
                  )}{" "}
                    </>)}
                </>
              )}{" "}
            </section>
          )}{" "}
          {tab === "sources" && (
            <section aria-label="Resources and Inbox">
              {" "}
              <h2>Resources and Inbox</h2>{" "}
              {boardDenied ? (
                <div className="card" role="alert">
                  {" "}
                  <p>Not authorized for this board. Pick an allowed board below, or close this one.</p>{" "}
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => {
                      setBoardId("");
                      setMeetingId("");
                      setMeetPicks([]);
                    }}
                  >
                    {" "}
                    Close board{" "}
                  </button>{" "}
                </div>
              ) : (
                <>
              {" "}
              <WikiResources boardId={boardId} meetingId={meetingId} meetings={(meetings.data ?? []).map((m: any) => ({ id: m.id, title: m.title }))} api={wikiApi} onChanged={() => { try { qc.invalidateQueries(); } catch {} }} />
                <SourcesGovernance boardId={boardId} meetingId={meetingId} meetings={(meetings.data ?? []).map((m: any) => ({ id: m.id, title: m.title }))} actAs={appliedActAs} readOnly={!(canWriteBoard || canActMeeting)} canManage={canManageBoard} canReadBoard={canWriteBoard || capBoard === "read" || canManageBoard} allowedMeetings={((caps.data as { meetings?: string[] } | undefined)?.meetings ?? [])} transport={{ get, post, put, del, upload, download: (u: string, f: string) => authedDownload(u, f), origin: () => originIdentity(), stale: (o: { epoch: number; token: string; user: string }) => originStale(o) }} />
                </>)}
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
              {boardDenied ? (
                <div className="card" role="alert">
                  {" "}
                  <p>Not authorized for this board. Pick an allowed board below, or close this one.</p>{" "}
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => {
                      setBoardId("");
                      setMeetingId("");
                      setMeetPicks([]);
                    }}
                  >
                    {" "}
                    Close board{" "}
                  </button>{" "}
                </div>
              ) : meetingId && (
                <>
                  {" "}
                  <div className="card">
                    {" "}
                    <h3>Prepare draft</h3>{" "}
                    <RecordItemEditor
                      draftKey="new-draft"
                      initialJson={draftItems}
                      onChange={(json) => setDraftItems(json)}
                    />{" "}
                    {canActMeeting && (<button onClick={prepareDraft} disabled={!parseRecordItems(draftItems).items.length}>
                      {" "}
                      Prepare draft from the list above{" "}
                    </button>)}{" "}
                  </div>{" "}
                  {(recs.data ?? []).map((r) => (
                    <div className="card" key={r.id}>
                      {" "}
                      <RecordVersionRow
                        version={r.version}
                        statusLabel={friendlyRecordStatus(r.status, r.decided).label}
                        tone={friendlyRecordStatus(r.status, r.decided).tone}
                        decided={r.decided}
                        selected={r.id === recId}
                        onSelect={() => setRecId(r.id)}
                      />{" "}
                    </div>
                  ))}{" "}
                  {recOk && recDetail.data && (
                    <div className="card key">
                      {" "}
                      <h3>
                        {" "}
                        Review version {recDetail.data.version}{" "}
                      </h3>{" "}
                      <StatusChip
                        label={friendlyRecordStatus(recDetail.data.status, recDetail.data.decided).label}
                        tone={friendlyRecordStatus(recDetail.data.status, recDetail.data.decided).tone}
                      />{" "}

                      {showReviewError && reviewError && (<ReviewAlert message={reviewError.message} />)}{" "}
                      {recOk && recDetail.data && !!recReview.data && !recReview.isError && !showReviewError && canManageMeeting && stateValid !== true && (<ReviewAlert message={recReview.data.stateValid !== true && recReview.data.stateError ? "Review state invalid: " + recReview.data.stateError : (reviewPendingCount === 0 ? "No pending items; nothing to approve." : "Review state invalid: explicit repair required; approval disabled")} />)}{" "}
                      {canActMeeting && (<button type="button" onClick={() => { void refreshReview(); }}>
                        {" "}
                        Refresh review{" "}
                      </button>)}{" "}
                      <RecordItemList
                        itemsJson={recDetail.data.itemsJson}
                        selectable={canApproveRecord}
                        selected={selItems}
                        onToggle={(key, checked) =>
                          setSelItems(
                            checked ? [...selItems, key] : selItems.filter((x) => x !== key),
                          )
                        }
                      />{" "}
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
                                  Version {r.version} · {friendlyRecordStatus(r.status, r.decided).label}{" "}
                                </option>
                              ))}{" "}
                          </select>{" "}
                        </label>{" "}
                          {cmpVer && (
                          (() => {
                            const other = (recs.data ?? []).find((r) => r.id === cmpVer);
                          if (!other) return null;
                            const olderFirst = recDetail.data.version >= other.version;
                            return (
                              <RecordComparison
                                prevJson={olderFirst ? other.itemsJson : recDetail.data.itemsJson}
                                curJson={olderFirst ? recDetail.data.itemsJson : other.itemsJson}
                              />
                            );
                          })()
                        )}{" "}
                      </div>{" "}
                      <div>
                        {" "}
                        {canApproveRecord && (<button onClick={() => approveRec(false)}>
                          {" "}
                          Approve selected{" "}
                        </button>)}{" "}
                        {canApproveRecord && (<button onClick={() => approveRec(true)}>
                          {" "}
                          Approve all{" "}
                        </button>)}{" "}
                        {!canApproveRecord && (<span className="muted">Approval requires a manage grant and a current valid review.</span>)}{" "}
                        {canActMeeting && (<button type="button" onClick={() => exportRecord("concise")}>
                          {" "}
                          Export concise{" "}
                        </button>)}{" "}
                        <span> </span>{" "}
                        {canActMeeting && (<button type="button" onClick={() => exportRecord("detailed")}>
                          {" "}
                          Export detailed{" "}
                        </button>)}{" "}
                      </div>{" "}
                      <RecordItemEditor
                        draftKey={recDetail.data.id + "-v" + recDetail.data.version}
                        initialJson={revText}
                        onChange={(json) => { try { revTextRev.current++; } catch { /* noop */ } setRevText(json); }}
                      />{" "}
                      {canActMeeting && (<button onClick={() => reviseRec(false)}>
                        {" "}
                        Request revision (new version){" "}
                      </button>)}{" "}
                      {canApproveRecord && (<button onClick={() => reviseRec(true)}>
                        {" "}
                        Amend approved record{" "}
                      </button>)}{" "}
                      {canActMeeting && (<button onClick={discardRec}>Discard draft</button>)}{" "}
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
                    <h3>Preview access as</h3>{" "}
                    <p>{" "}Type a name to preview what that person can see. This never changes their real access.{" "}</p>{" "}
                    <input
                      aria-label="Act as user"
                      value={actAsState}
                      onChange={(e) => setActAsState(e.target.value)}
                      placeholder="owner (default)"
                    />{" "}
                    <button
                      onClick={() => {
                        actAs = actAsState.trim();
                        setAppliedActAs(actAs);
                        // Profile origin transition: retire the previous
                        // operation guard and reset this origin's busy latch
                        // synchronously. Held save/reload completions capture
                        // op/epoch/token/user and return fully silent on any
                        // mismatch, so they can neither clear the new busy
                        // state nor write into the reset UI.
                        try { profileOpRef.current++; } catch {}
                        try { setProfileReloading(false); } catch {}
                        try { retirePipeline(submitOpRef.current); } catch {}
                        try { (window as unknown as { __simceoEpoch?: number }).__simceoEpoch = (((window as unknown as { __simceoEpoch?: number }).__simceoEpoch) ?? 0) + 1; } catch {}
                        try { secEpoch.current++; } catch {}
                        try { secPendingRef.current = null; } catch {}
                        try { askSecretary.reset(); } catch {}
                        try { retrySecretary.reset(); } catch {}
                        try { answerSecretary.reset(); } catch {}
                        try { askBriefing.reset(); } catch {}
                        try { editNote.reset(); } catch {}
                        try { reverseNote.reset(); } catch {}
                        try { secEditSess.current++; } catch {}
                        try { secEditVisit.current++; } catch {}
                        try { secHistRef.current++; } catch {}
                        try { secEnvelopeRev.current++; } catch {}
                        try { secHydRef.current++; } catch {}
                        try { send.reset(); } catch {}
                        try { runDiscussion.reset(); } catch {}
                        try { qc.clear(); } catch {}
                        qc.invalidateQueries();
                      }}
                    >
                      {" "}
                      Apply identity{" "}
                    </button>{" "}
                  </div>{" "}
                  {canManageBoard && (<>
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
                    {canManageBoard && (<button onClick={() => invite.mutate()}>Invite</button>)}{" "}
                      {(invites.data ?? []).map((i) => (
                        <div key={i.id}>
                          {" "}
                          {i.email} · {i.role} ·{" "}
                          <StatusChip label={i.state === "pending" ? "Waiting for reply" : (i.state === "accepted" || i.state === "joined") ? "Joined" : (i.state === "revoked" || i.state === "expired") ? "Closed" : i.state} tone={i.state === "pending" ? "open" : (i.state === "accepted" || i.state === "joined") ? "done" : "muted"} />{" "}
                        {i.state === "pending" && canManageBoard && (
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
                        ? (meetings.data ?? []).find((m) => m.id === meetingId)?.title ?? "One meeting"
                        : "Whole board"}{" "}
                      . Pick a meeting in Meetings to scope a grant to it.{" "}
                    </p>{" "}
                    {canManageBoard && (<button onClick={() => grant.mutate()}>Set grant</button>)}{" "}
                    {(grants.data ?? []).map((g) => (
                      <div key={g.id}>
                        {" "}
                        {g.userKey} · {g.access === "read" ? "Can read" : g.access === "contribute" ? "Can contribute" : g.access === "manage" ? "Can manage" : g.access}{" "}
                        {g.meetingId
                          ? <span> · {(meetings.data ?? []).find((m) => m.id === g.meetingId)?.title ?? "One meeting"}</span>
                          : " · Whole board"}{" "}
                        {canManageBoard && (<button
                          onClick={() =>
                            del<unknown>(`/api/grants/${g.id}`).then(() => refresh("grants"))
                          }
                        >
                          {" "}
                          Revoke{" "}
                        </button>)}{" "}
                      </div>
                    ))}{" "}
                  </div>
                  </>)}{" "}
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
                  Scope{" "}
                  <select
                    aria-label="Usage scope"
                    value={effUsageScope}
                    onChange={(e) => setUsageScope(e.target.value)}
                  >
                    {" "}
                    {capsAdmin && (<option value="installation">Installation (privileged)</option>)}{" "}
                    <option value="board">Board</option>{" "}
                  </select>
                </label>{" "}
                {!capsAdmin && (<span className="muted">Installation jobs, spending, and audit require installation admin. Usage below is board-scoped.</span>)}{" "}
              </div>{" "}
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
              {capsAdmin && (<>
              <h3>Jobs</h3>{" "}
              {(jobs.data ?? []).map((j) => (
                <div key={j.id}>
                  {" "}
                  {j.kind} · <StatusChip label={j.state === "queued" ? "Waiting" : j.state === "running" ? "Working" : j.state === "failed" ? "Needs attention" : j.state === "done" ? "Finished" : j.state} tone={j.state === "failed" ? "progress" : j.state === "done" ? "done" : (j.state === "queued" || j.state === "running") ? "open" : "muted"} />{" "}
                  {j.state === "failed" && (
                    <button onClick={() => retryJob(j)}>
                      {" "}
                      Retry (same identity){" "}
                    </button>
                  )}{" "}
                </div>
              ))}{" "}
              {(jobs.data ?? []).length === 0 && <p>No jobs.</p>}{" "}
              </>)}
              {capsAdmin && (<div className="card">
                {" "}
                <h3>Spending cap (installation admin only)</h3>{" "}
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
              </div>)}{" "}

              <h3>Usage (live ledger)</h3>{" "}
              <div className="table-scroll">
                {" "}
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Used for</th><th>Model</th><th className="num">Words in (approx. words)</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {((usage.data as UsageSummaryEnvelope | undefined)?.rows ?? []).map((u, i) => (
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
                      <th className="num">Wait</th><th>Web lookup</th>
                    </tr>
                  </thead>
                  <tbody>
                    {((modelCalls.data as ModelCallsEnvelope | undefined)?.rows ?? []).map((m, i) => (
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
                  for (const m of ((modelCalls.data as ModelCallsEnvelope | undefined)?.rows ?? [])) {
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
                    Backup ready — {bakText.length} characters saved, originals and images included.{" "}
                  </p>
                )}{" "}

                <label>
                  {" "}
                  Paste a backup snapshot{" "}
                  <input
                    value={bakText}
                    onChange={(e) => setBakText(e.target.value)}
                    placeholder="paste backup snapshot"
                  />{" "}
                </label>{" "}
                <label>
                  {" "}
                  Paste its check code{" "}
                  <input
                    value={bakHash}
                    onChange={(e) => setBakHash(e.target.value)}
                  />{" "}
                </label>{" "}
                {canManageBoard && (<button onClick={doRestore}>
                  {" "}
                  Restore (replaces current data){" "}
                </button>)}{" "}
              </div>{" "}
              {capsAdmin && (<>
              <h3>Audit</h3>{" "}
              <div className="table-scroll">
                {" "}
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(audit.data ?? []).slice(0, 50).map((a, i) => (
                      <tr key={i}>
                        <td>{humanAuditAction(a.action)}{humanWhen(a.createdAt) ? " · " + humanWhen(a.createdAt) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>{" "}
              </div>
              </>)}{" "}
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
                    <span>{c.action}</span> <span className="muted">in {c.view}</span>{" "}
                  </div>
                ))}{" "}
            </section>
          )}{" "}
          </>)}
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
