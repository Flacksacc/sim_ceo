import { useEffect, useRef, useState } from "react";
import "./advisor-creation.css";

// CreateAdvisor — the single character-based advisor creation flow, plus
// CharacterEditor for later roster-edit reuse (central App owner mounts it;
// this file edits nothing outside itself).
//
// One flow, no alternatives: brief -> create (seeded draft) -> research runs
// as part of the flow -> compiled paragraphs appear editable -> owner tweaks
// -> explicit save. There is no manual-vs-AI choice, no tone dropdowns, no
// fixed adjective settings: voice comes from the three paragraphs.
//
// EXACT backend contract (character-advisor-engine working tree; backend
// owner implements, this file only consumes — never invents routes/keys):
//   POST /api/roster/quick  {accountId, name, description, background?,
//     sourceUrls?[]} -> 201 RosterEntry. Seeds profileJson with the three
//     exact behavior keys marked as seeds (characterSeed:true, researched:
//     false) and ResearchJson {seed, pendingBackground, pendingSourceUrls}.
//   POST /api/roster/{id}/research {focus?, background?, sourceUrls?[]} ->
//     bounded (<=180s) run: fetch owner URLs for real, one grounded dossier
//     call, one compile call -> {subject, searched, supported, claims,
//     responseIds, version, evidenceRefs[{url,title,excerpt,ownerSupplied}],
//     draftProfile:{contributionCriteria,reasoningApproach,responseStyle},
//     draftStatus}. Terminal: done (grounded only), unsupported (editable, never complete), failed, superseded.
//     (ResearchedAt null), never a fake completion. 409 while a run is live,
//     504 on deadline, 499 on client cancel.
//   GET /api/roster/{id}/research -> {researchJson, researchedAt,
//     researchRequested, evidenceCount, version, researchBaseVersion,
//     running, stage, stageError, sources, draftProfile, draftStatus}.
//     Live stages while a run is in flight: starting, fetching-sources,
//     researching, compiling; terminal: done, failed, unsupported, interrupted, not-started. Polls terminate honestly. — no fake
//     percentages, no simulated progress.
//   PUT /api/roster/{id} {name?, description?, profileJson?, tags?} ->
//     updated entry (version+1). V2: identity edits invalidate the dossier; paragraph-only saves preserve proof (draftStatus saved).
//     fictional, name, background, sourceUrls, contributionCriteria,
//     reasoningApproach, responseStyle. Every other stored key
//     (server defaults, security/version/review markers, future backend
//     fields) is preserved verbatim by mergeCharacterProfile — never
//     rebuilt, never silently rewritten.
// Canonical storage may use existing ProfileJson; no schema churn needed.
//
// Honesty rules enforced here:
// - Paragraph fields show ONLY server-returned text (create-seeds or
//   compiled draft) or owner-typed text. Local assembly (e.g. stitching
//   dossier claims into personality prose) is forbidden: work criticisms
//   are not responseStyle.
// - Compiled drafts adopt into a field only when the field is empty or
//   still holds the known server seed; owner-typed text is never
//   overwritten (per-field "Use compiled draft" offered instead).
// - "done" is shown only for draftStatus "draft" + supported evidence +
//   ResearchedAt set. Unsupported/no-evidence results render as
//   "incomplete": editable, explicitly not complete.
// - Failed research preserves brief, draft, and version; retry and
//   cancel/refresh are offered. Cancel stops waiting, never claims the
//   server run stopped.
// - Final saves re-read research state: proof kept shows, markers honored,
//   a cleared snapshot is reported honestly. Never auto-reruns: no save->invalidate->rerun loop.
// - Source URLs travel in the explicit sourceUrls request fields and are
//   fetched by the backend; they are never just pasted into a focus string
//   or stored-only. Saved profiles keep sourceUrls as provenance metadata.
// - Creation and saving never attach a board copy and never place model
//   calls except the in-flow research run. Board seats (with portrait)
//   are granted later from This Board's Advisors.
//
// HANDOFF (central App owner, no App edits in this change):
//   import { CharacterEditor } from "./advisor-creation";
//   <CharacterEditor key={entry.id} entry={entry} get={get} post={post} put={put}
//     originIdentity={originIdentity} originStale={originStale} originRevision={originRevision}
//     resolveCanonicalEntry={resolveCanonicalEntry} freshCreation={isNewlyCreatedThisFlow} onSaved={...} onClose={...} />
//   - Key by roster entry id so switching drafts remounts (an internal
//     identity guard reseeds as backstop). Never reuse one mount across ids.
//   - Version guards: version is re-read from GET research and PUT
//     responses and shown only as saved/dirty state, never invented. PUT
//     has no server version precondition (last-writer-wins); research
//     conflicts surface as 409/stale via researchBaseVersion. Two tabs
//     editing one draft: last save wins. Same-ID prop updates reconcile by version: clean adopts, dirty keeps draft plus explicit Reload.
//   - Frozen intent: after explicit save the stored paragraphs are
//     canonical; newer server drafts never overwrite owner text
//     (compiled adoption is seed-or-empty only; per-field override explicit).
//   Roster editing is NOT wired until that mount lands; do not claim it.

export interface RosterEntryDto {
  id: string;
  accountId: string;
  type: string | number;
  name: string;
  description: string;
  profileJson: string;
  version: number;
  archived: boolean;
  tags: string;
  researchJson: string;
  researchedAt: string | null;
  researchRequested: boolean;
  evidenceCount: number;
  researchJobId: string;
  researchBaseVersion: number;
  updatedAt: string;
}

export interface OriginIdentity {
  epoch: number;
  token: string;
  user: string;
}

export interface CreateAdvisorApi {
  accountId: string;
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body: unknown) => Promise<T>;
  put: <T>(path: string, body: unknown) => Promise<T>;
  originIdentity: () => OriginIdentity;
  originStale: (o: OriginIdentity) => boolean;
  originRevision: string;
  resolveCanonicalEntry: (id: string) => Promise<RosterEntryDto | null>;
}

function captureOrigin(api: { originIdentity?: () => OriginIdentity }): OriginIdentity | null {
  try {
    if (!api.originIdentity) return null;
    return api.originIdentity();
  } catch {
    return null;
  }
}

function originDead(api: { originStale?: (o: OriginIdentity) => boolean }, o: OriginIdentity | null): boolean {
  if (!o) return true;
  try {
    if (!api.originStale) return true;
    return !!api.originStale(o);
  } catch {
    return true;
  }
}

export interface CreateAdvisorProps extends CreateAdvisorApi {
  onCreated?: (entry: RosterEntryDto) => void;
  onClose?: () => void;
}

export interface CharacterEditorProps {
  entry: RosterEntryDto;
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body: unknown) => Promise<T>;
  put: <T>(path: string, body: unknown) => Promise<T>;
  autoStartResearch?: boolean;
  background?: string;
  sourceUrls?: string[];
  onSaved?: (entry: RosterEntryDto) => void;
  onClose?: () => void;
  originIdentity: () => OriginIdentity;
  originStale: (o: OriginIdentity) => boolean;
  originRevision: string;
  resolveCanonicalEntry: (id: string) => Promise<RosterEntryDto | null>;
  freshCreation: boolean;
}

// Exact canonical profile keys (CharacterBehavior.cs). Labels stay human.
export const CHARACTER_PARAGRAPH_KEYS = [
  "contributionCriteria",
  "reasoningApproach",
  "responseStyle",
] as const;

export type CharacterParagraphKey = (typeof CHARACTER_PARAGRAPH_KEYS)[number];

export interface CharacterParagraphs {
  contributionCriteria: string;
  reasoningApproach: string;
  responseStyle: string;
}

export const EMPTY_PARAGRAPHS: CharacterParagraphs = {
  contributionCriteria: "",
  reasoningApproach: "",
  responseStyle: "",
};

// Visible paragraph boundary, matching the backend's accepted limit
// (contract v2 / CharacterBehavior.MaxAcceptedParagraphChars = 2000; PUT
// rejects oversize with a 400 naming the key and length). Enforced here with
// a counter and an explicit save error — never silently truncated. Whole
// profile cap (20000) is pre-checked on save with the same explicit error.
export const PARAGRAPH_MAX = 2000;
export const PROFILE_MAX = 20000;

const HUMAN_STAGE: Record<string, string> = {
  starting: "Starting",
  "fetching-sources": "Reading your links",
  researching: "Researching",
  compiling: "Writing the three paragraphs",
  done: "Finished",
  failed: "Stopped",
  unsupported: "Incomplete — no evidence",
  interrupted: "Interrupted",
  saved: "Saved",
  superseded: "Superseded",
  running: "Running",
  "not-started": "Not started",
};

function humanStage(stage: string): string {
  const s = (stage || "").trim();
  if (!s) return "";
  return HUMAN_STAGE[s] !== undefined ? HUMAN_STAGE[s] : s;
}

function initialEditorLinks(profileJson: string, propUrls?: string[]): string[] {
  const fromProfile = parseCharacterProfile(profileJson).sourceUrls;
  const initial = normLinks([...(propUrls ?? []), ...fromProfile]);
  return [...initial.slice(0, 3), "", "", ""].slice(0, 3);
}

// Canonical URL normalization shared by the editor inputs, the dirty check,
// and the saved snapshot: trim, drop empties, add a scheme to bare www
// hosts, dedupe case-insensitively (matching server AbsoluteUri semantics).
// Comparing padded inputs against normalized snapshots caused false dirty
// state; every comparison and every save goes through this function.
function normLinks(urls: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of urls) {
    let t = (v || "").trim().replace(/\s+/g, "");
    if (!t) continue;
    if (/^www\./i.test(t)) t = "https://" + t;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

function parseStoredResearch(raw: string): {
  claims: ResearchClaim[];
  sources: ResearchSource[];
  note: string;
  searched: number;
  supported: boolean;
  draftProfile: DraftProfile | null;
  draftStatus: string;
} {
  try {
    const top = JSON.parse(raw || "{}") as {
      claims?: ResearchClaim[];
      evidenceRefs?: ResearchSource[];
      note?: string;
      searched?: number;
      supported?: boolean;
      partial?: {
        claims?: ResearchClaim[];
        evidenceRefs?: ResearchSource[];
        note?: string;
        searched?: number;
        supported?: boolean;
      };
    };
    const r = top.partial ?? top;
    const draftStatus = typeof (r as { draftStatus?: unknown }).draftStatus === "string" ? String((r as { draftStatus?: unknown }).draftStatus) : "";
    const dp = (r as { draftProfile?: unknown }).draftProfile;
    const draftProfile =
      dp && typeof dp === "object"
        ? {
            contributionCriteria: asString((dp as DraftProfile).contributionCriteria ?? ""),
            reasoningApproach: asString((dp as DraftProfile).reasoningApproach ?? ""),
            responseStyle: asString((dp as DraftProfile).responseStyle ?? ""),
          }
        : null;
    return {
      claims: Array.isArray(r.claims) ? r.claims : [],
      sources: Array.isArray(r.evidenceRefs) ? r.evidenceRefs : [],
      note: typeof r.note === "string" ? r.note : "",
      searched: typeof r.searched === "number" ? r.searched : 0,
      supported: r.supported === true,
      draftProfile,
      draftStatus,
    };
  } catch {
    return { claims: [], sources: [], note: "", searched: 0, supported: false, draftProfile: null, draftStatus: "" };
  }
}

export type ResearchStatus =
  | "idle"
  | "working"
  | "done"
  | "incomplete"
  | "failed"
  | "stale";

export interface ResearchSource {
  url: string;
  title?: string;
  excerpt?: string;
  ownerSupplied?: boolean;
  unfetched?: boolean;
}

export interface ResearchClaim {
  angle: string;
  text: string;
  sources: { url: string; title?: string }[];
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v))
    return v
      .map((x) => String(x))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

// Parse the profile without dropping anything: the raw record round-trips
// through mergeCharacterProfile so unknown/security/version keys survive.
// Only the three EXACT canonical keys are read as paragraphs; legacy
// capability fields are left for backend interpretation (LegacyMapped),
// never mapped or rewritten here.
export function parseCharacterProfile(raw: string): {
  record: Record<string, unknown>;
  background: string;
  sourceUrls: string[];
  paragraphs: CharacterParagraphs;
  characterSeed: boolean;
  researched: boolean;
} {
  let record: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      record = parsed as Record<string, unknown>;
    }
  } catch {
    record = { background: raw.slice(0, 2000) };
  }
  return {
    record,
    background: asString(record.background),
    sourceUrls: asStringArray(record.sourceUrls),
    paragraphs: {
      contributionCriteria: asString(record.contributionCriteria),
      reasoningApproach: asString(record.reasoningApproach),
      responseStyle: asString(record.responseStyle),
    },
    characterSeed: record.characterSeed === true,
    researched: record.researched === true,
  };
}

// Merge owned keys over the existing record; every other key survives.
export function mergeCharacterProfile(
  raw: string,
  patch: {
    name?: string;
    background?: string;
    sourceUrls?: string[];
    paragraphs?: CharacterParagraphs;
    researched?: boolean;
    characterSeed?: boolean;
  }
): string {
  const parsed = parseCharacterProfile(raw);
  const next: Record<string, unknown> = { ...parsed.record, fictional: true };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.background !== undefined) next.background = patch.background;
  if (patch.sourceUrls !== undefined) next.sourceUrls = patch.sourceUrls;
  if (patch.paragraphs !== undefined) {
    for (const k of CHARACTER_PARAGRAPH_KEYS) next[k] = patch.paragraphs[k];
  }
  if (patch.researched !== undefined) next.researched = patch.researched;
  if (patch.characterSeed !== undefined) next.characterSeed = patch.characterSeed;
  return JSON.stringify(next);
}

// Adopt a server-compiled draft into fields that are still empty or still
// hold the known server seed. Owner-typed text is returned untouched; the
// caller offers per-field "Use compiled draft" for those.
export function adoptCompiledParagraphs(
  current: CharacterParagraphs,
  seed: CharacterParagraphs,
  compiled: CharacterParagraphs
): { paragraphs: CharacterParagraphs; updated: CharacterParagraphKey[] } {
  const next = { ...current };
  const updated: CharacterParagraphKey[] = [];
  for (const k of CHARACTER_PARAGRAPH_KEYS) {
    const cur = (current[k] || "").trim();
    if (cur === "" || cur === (seed[k] || "").trim()) {
      if ((compiled[k] || "").trim() && cur !== (compiled[k] || "").trim()) {
        next[k] = compiled[k];
        updated.push(k);
      }
    }
  }
  return { paragraphs: next, updated };
}

export function isValidSourceUrl(v: string): boolean {
  return /^(https?:\/\/|www\.)\S+\.\S+/.test(v.trim());
}

// Strict empty-snapshot check: only an explicitly empty, non-running
// snapshot without draftStatus/draftProfile/claims/evidence and without
// sources counts as cleared. Anything else is unknown, never cleared.
export function isEmptyResearchSnapshot(raw: unknown, sources: ResearchSource[], running: boolean): boolean {
  if (running) return false;
  if (sources.length > 0) return false;
  try {
    let top: unknown = raw;
    if (typeof raw === "string") {
      const s = (raw || "").trim();
      if (!s) return false;
      top = JSON.parse(s);
    }
    if (!top || typeof top !== "object" || Array.isArray(top)) return false;
    const rec = top as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length !== 0) return false;
    return true;
  } catch {
    return false;
  }
}

interface DraftProfile {
  contributionCriteria?: string;
  reasoningApproach?: string;
  responseStyle?: string;
}

interface ResearchGetResponse {
  researchJson?: unknown;
  researchedAt?: string | null;
  researchRequested?: boolean;
  evidenceCount?: number;
  version?: number;
  researchBaseVersion?: number;
  running?: boolean;
  stage?: string;
  stageError?: string | null;
  sources?: ResearchSource[];
  draftProfile?: DraftProfile | null;
  draftStatus?: string | null;
}

interface ResearchPostResponse {
  subject?: string;
  searched?: number;
  supported?: boolean;
  claims?: ResearchClaim[];
  responseIds?: string[];
  version?: number;
  evidenceRefs?: ResearchSource[];
  draftProfile?: DraftProfile;
  draftStatus?: string;
  note?: string;
}

const PARAGRAPH_META: {
  key: CharacterParagraphKey;
  id: string;
  label: string;
  hint: string;
  placeholder: string;
}[] = [
  {
    key: "contributionCriteria",
    id: "cc-contribute",
    label: "When to contribute",
    hint: "Expertise, useful questions, and criteria for contributing or staying out of a discussion.",
    placeholder: "When this character speaks up, and when they stay out.",
  },
  {
    key: "reasoningApproach",
    id: "cc-reason",
    label: "How to reason",
    hint: "The character's perspective, methods, evidence needs, limits, and when to agree, disagree, or challenge.",
    placeholder: "How this character thinks through a question.",
  },
  {
    key: "responseStyle",
    id: "cc-respond",
    label: "How to respond",
    hint: "Context-sensitive expression: when blunt, diplomatic, formal, detailed, or brief. Never a fixed generic tone.",
    placeholder: "How this character disagrees, concedes, and challenges.",
  },
];
export function CharacterEditor(props: CharacterEditorProps) {
  const { get, post, put } = props;
  const [entry, setEntry] = useState<RosterEntryDto>(props.entry);
  const [paragraphs, setParagraphs] = useState<CharacterParagraphs>(() => {
    return parseCharacterProfile(props.entry.profileJson).paragraphs;
  });
  const mountSeedRef = useRef<CharacterParagraphs>(parseCharacterProfile(props.entry.profileJson).paragraphs);
  const freshEligibleRef = useRef<boolean>(props.freshCreation === true);
  const [compiled, setCompiled] = useState<CharacterParagraphs>(() => {
    const dp = parseStoredResearch(props.entry.researchJson || "{}").draftProfile;
    return dp &&
      ((dp.contributionCriteria ?? "").trim() || (dp.reasoningApproach ?? "").trim() || (dp.responseStyle ?? "").trim())
      ? { ...EMPTY_PARAGRAPHS, ...dp }
      : { ...EMPTY_PARAGRAPHS };
  });
  const [hasCompiled, setHasCompiled] = useState(() => {
    const dp = parseStoredResearch(props.entry.researchJson || "{}").draftProfile;
    return !!(dp && ((dp.contributionCriteria ?? "").trim() || (dp.reasoningApproach ?? "").trim() || (dp.responseStyle ?? "").trim()));
  });
  const [links, setLinks] = useState<string[]>(() =>
    initialEditorLinks(props.entry.profileJson, props.sourceUrls)
  );
  const [savedSnapshot, setSavedSnapshot] = useState(() => ({
    paragraphs: parseCharacterProfile(props.entry.profileJson).paragraphs,
    links: normLinks(initialEditorLinks(props.entry.profileJson, props.sourceUrls)),
  }));
  const initialStored = parseStoredResearch(props.entry.researchJson || "{}");
  const [researchStatus, setResearchStatus] = useState<ResearchStatus>(() => {
    if (props.entry.researchedAt && initialStored.supported) return "done";
    if (props.entry.researchedAt) return "incomplete";
    if (initialStored.draftStatus === "failed") return "failed";
    if (initialStored.draftStatus === "superseded") return "stale";
    if (initialStored.draftStatus === "unsupported") return "incomplete";
    return "idle";
  });
  const [stage, setStage] = useState("");
  const [statusNote, setStatusNote] = useState(
    props.entry.researchedAt
      ? "Loaded with saved research proof. Review the paragraphs below, then save."
      : "Research runs as part of this flow. Paragraphs appear below when the server answers."
  );
  const [searched, setSearched] = useState(initialStored.searched);
  const [supported, setSupported] = useState(initialStored.supported);
  const [claims, setClaims] = useState<ResearchClaim[]>(initialStored.claims);
  const [sources, setSources] = useState<ResearchSource[]>(initialStored.sources);
  const [researchNote, setResearchNote] = useState(initialStored.note);
  const [adoptNote, setAdoptNote] = useState("");
  const [snapshotClearedNote, setSnapshotClearedNote] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [waitingCancelled, setWaitingCancelled] = useState(false);
  const [verifyUnknown, setVerifyUnknown] = useState(false);
  const [conflict, setConflict] = useState<{ version: number } | null>(null);
  const dirtyRef = useRef(false);
  const ownerSavedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const pollTimer = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const autoStarted = useRef(false);
  const entryRef = useRef<RosterEntryDto>(props.entry);
  const statusRef = useRef<ResearchStatus>("idle");
  const paraRef = useRef<CharacterParagraphs>(EMPTY_PARAGRAPHS);
  const opToken = useRef(0);
  const opOrigins = useRef(new Map<number, OriginIdentity | null>());
  function nextOp(): number {
    opToken.current += 1;
    try {
      opOrigins.current.set(opToken.current, captureOrigin(props));
    } catch {
      opOrigins.current.set(opToken.current, null);
    }
    if (opOrigins.current.size > 8) {
      const oldest = [...opOrigins.current.keys()].sort((a, b) => a - b)[0];
      opOrigins.current.delete(oldest);
    }
    return opToken.current;
  }
  // Ownership: an operation owns the UI only while its generation is
  // current AND the entry ID matches AND the originating auth identity is
  // still current. User cancellation is tracked separately (cancelledRef)
  // so Check again can resume cleanly.
  function isStaleOp(myOp: number | null, opId: string): boolean {
    return staleKind(myOp, opId) !== "ok";
  }
  // Three-way ownership: ok (current), superseded (a newer op or entry owns the view, touch nothing),
  // origin (same op/entry but the originating auth died, retire own busy/timers once, adopt nothing).
  function staleKind(myOp: number | null, opId: string): "ok" | "superseded" | "origin" {
    if (myOp === null) return entryRef.current.id !== opId ? "superseded" : "ok";
    if (opToken.current !== myOp || entryRef.current.id !== opId) return "superseded";
    const o = opOrigins.current.get(myOp) ?? null;
    return originDead(props, o) ? "origin" : "ok";
  }
  function retireOwnOp() {
    stopClocks();
    setBusy(false);
    setWaitingCancelled(false);
    cancelledRef.current = false;
  }

  // Monotonic acknowledgement of the canonical snapshot actually applied to
  // this view (id + version + profile content). Same-ID prop updates adopt
  // silently only when nothing changed; clean updates adopt fully; dirty
  // updates flag an explicit conflict instead of auto-rebasing owner text.
  const ackedRef = useRef({ id: props.entry.id, version: props.entry.version, profileJson: props.entry.profileJson });
  // Unified highest-observed floor: max canonical version seen per entry
  // (props, PUT result, GET version). Delayed older canonical/research
  // payloads below the floor are discarded wholesale and never reduce
  // conflict/reload targets or replace newer proof.
  const conflictVerRef = useRef(0);
  const observedCanonRef = useRef(new Map<string, number>());
  function conflictVersion(): number { return conflictVerRef.current; }
  function observeCanon(entryId: string, v: unknown): number {
    const cur = observedCanonRef.current.get(entryId) ?? 0;
    if (typeof v === "number" && v > cur) {
      observedCanonRef.current.set(entryId, v);
      return v;
    }
    return cur;
  }
  function canonFloor(entryId: string): number {
    return observedCanonRef.current.get(entryId) ?? 0;
  }
  const canonRecordRef = useRef(new Map<string, RosterEntryDto>());
  function observeCanonRecord(e: RosterEntryDto) {
    try {
      const prev = canonRecordRef.current.get(e.id);
      if (!prev || e.version > prev.version) canonRecordRef.current.set(e.id, e);
    } catch { /* noop */ }
  }
  function highestCanon(id: string): RosterEntryDto | null {
    return canonRecordRef.current.get(id) ?? null;
  }

  // Highest research response version applied per entry. Older responses are
  // discarded wholesale so a delayed poll can never overwrite newer proof,
  // status, or compiled drafts with stale content.
  try {
    const curInit = observedCanonRef.current.get(props.entry.id) ?? 0;
    if (props.entry.version > curInit) observedCanonRef.current.set(props.entry.id, props.entry.version);
  } catch { /* noop */ }
  try { observeCanonRecord(props.entry); } catch { /* noop */ }
  const seenResearch = useRef(new Map<string, number>());
  function noteResearchVersion(entryId: string, v: unknown): boolean {
    if (typeof v !== "number") return true;
    const prev = seenResearch.current.get(entryId);
    if (prev !== undefined && v < prev) return false;
    seenResearch.current.set(entryId, v);
    return true;
  }
  // Reseed all research-derived view state from a stored entry (mount,
  // identity switch, clean same-ID update). Owner paragraphs are set by the
  // caller; this restores proof/compiled/status honestly without inventing
  // completion. Unsupported with null researchedAt stays incomplete but
  // editable; failed/superseded clear obsolete alternatives.
  function applyStoredResearch(e: RosterEntryDto) {
    const s = parseStoredResearch(e.researchJson || "{}");
    setClaims(s.claims);
    setSources(s.sources);
    setResearchNote(s.note);
    setSearched(s.searched);
    setSupported(s.supported);
    const hasDraft = !!(s.draftProfile && ((s.draftProfile.contributionCriteria ?? "").trim() || (s.draftProfile.reasoningApproach ?? "").trim() || (s.draftProfile.responseStyle ?? "").trim()));
    if (e.researchedAt && s.supported && hasDraft) {
      setCompiled({ contributionCriteria: s.draftProfile!.contributionCriteria ?? "", reasoningApproach: s.draftProfile!.reasoningApproach ?? "", responseStyle: s.draftProfile!.responseStyle ?? "" });
      setHasCompiled(true);
      setResearchStatus("done");
      setStage("");
      setStatusNote("Loaded with saved research proof. Review the paragraphs below, then save.");
    } else if (s.draftStatus === "unsupported" && hasDraft) {
      setCompiled({ contributionCriteria: s.draftProfile!.contributionCriteria ?? "", reasoningApproach: s.draftProfile!.reasoningApproach ?? "", responseStyle: s.draftProfile!.responseStyle ?? "" });
      setHasCompiled(true);
      setResearchStatus("incomplete");
      setStage("");
      setStatusNote("Loaded unsupported research � editable draft, explicitly incomplete, never complete. Edit with care or retry.");
    } else if (s.draftStatus === "failed") {
      setCompiled({ ...EMPTY_PARAGRAPHS });
      setHasCompiled(false);
      setResearchStatus("failed");
      setStage("");
      setStatusNote("The recorded research failed; the saved text stands. Retry or edit directly.");
    } else if (s.draftStatus === "superseded") {
      setCompiled({ ...EMPTY_PARAGRAPHS });
      setHasCompiled(false);
      setResearchStatus("stale");
      setStage("");
      setStatusNote("A newer run or edit won on the server. Review the current draft, then run research again if needed.");
    } else if (e.researchedAt) {
      if (hasDraft) {
        setCompiled({ contributionCriteria: s.draftProfile!.contributionCriteria ?? "", reasoningApproach: s.draftProfile!.reasoningApproach ?? "", responseStyle: s.draftProfile!.responseStyle ?? "" });
        setHasCompiled(true);
      } else {
        setCompiled({ ...EMPTY_PARAGRAPHS });
        setHasCompiled(false);
      }
      setResearchStatus("incomplete");
      setStage("");
      setStatusNote("Loaded with saved research proof. Review the paragraphs below, then save.");
    } else {
      if (hasDraft) {
        setCompiled({ contributionCriteria: s.draftProfile!.contributionCriteria ?? "", reasoningApproach: s.draftProfile!.reasoningApproach ?? "", responseStyle: s.draftProfile!.responseStyle ?? "" });
        setHasCompiled(true);
      } else {
        setCompiled({ ...EMPTY_PARAGRAPHS });
        setHasCompiled(false);
      }
      setResearchStatus("idle");
      setStage("");
      setStatusNote("Research runs as part of this flow. Paragraphs appear below when the server answers.");
    }
  }
  function readError(e: unknown): string {
    if (e instanceof Error) return e.message;
    try {
      return JSON.stringify(e);
    } catch {
      return "Request failed.";
    }
  }

  function stopClocks() {
    if (timer.current !== null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }

  useEffect(() => {
    return () => {
      opToken.current += 1;
      opOrigins.current.clear();
      stopClocks();
    };
  }, []);

  const originRevRef = useRef(props.originRevision);
  useEffect(() => {
    if (originRevRef.current === props.originRevision) return;
    originRevRef.current = props.originRevision;
    const cur = opToken.current + 1;
    opToken.current = cur;
    retireOwnOp();
    setError(null);
    setVerifyUnknown(false);
    if (statusRef.current === "working") {
      setResearchStatus("idle");
      setStage("");
      setStatusNote("Session changed. The pending run was left behind; the current draft is unchanged. Run research again if needed.");
    } else {
      setStatusNote("Session changed. The current draft is unchanged; verify the roster before saving.");
    }
  }, [props.originRevision]);
  useEffect(() => {
    if (props.autoStartResearch && !autoStarted.current) {
      autoStarted.current = true;
      void runResearch();
    }
    // Run once on mount for the creation flow only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Identity guard: if the parent mounts a different roster entry through
  // the same component (missing key), reseed instead of editing stale
  // state. The documented mount uses key={entry.id}; this is a backstop.
  useEffect(() => {
    if (props.entry.id !== entry.id) {
      opToken.current += 1;
      cancelledRef.current = false;
      stopClocks();
      setBusy(false);
      setWaitingCancelled(false);
      setConflict(null);
      setVerifyUnknown(false);
      const p = parseCharacterProfile(props.entry.profileJson);
      const freshLinks = initialEditorLinks(props.entry.profileJson, props.sourceUrls);
      setEntry(props.entry);
      setParagraphs(p.paragraphs);
      setLinks(freshLinks);
      setSavedSnapshot({ paragraphs: p.paragraphs, links: normLinks(freshLinks) });
      applyStoredResearch(props.entry);
      freshEligibleRef.current = false;
      ownerSavedRef.current = false;
      mountSeedRef.current = { ...EMPTY_PARAGRAPHS };
      observeCanonRecord(props.entry);
      ackedRef.current = { id: props.entry.id, version: props.entry.version, profileJson: props.entry.profileJson };
      setAdoptNote("");
      setSnapshotClearedNote("");
      setStage("");
      setElapsed(0);
      setStatusNote("Loaded a different draft. Research runs on demand from here.");
      setError(null);
      setSavedAt(null);
    }
    // entry is intentionally read-only here; identity comes from props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.entry.id]);

  // Same-ID canonical updates: adopt cleanly when this mount has no unsaved
  // edits; otherwise keep the draft, flag the conflict, and offer an explicit
  // reload. Never auto-rebases owner text. Stale prop versions are ignored.
  useEffect(() => {
    if (props.entry.id !== entryRef.current.id) return;
    if (props.entry.id !== ackedRef.current.id) return;
    observeCanon(props.entry.id, props.entry.version);
    const floor = Math.max(ackedRef.current.version, canonFloor(props.entry.id));
    if (props.entry.version < floor) return;
    if (props.entry.version <= ackedRef.current.version && props.entry.profileJson === ackedRef.current.profileJson) return;
    const myOp = nextOp();
    cancelledRef.current = false;
    stopClocks();
    setBusy(false);
    setWaitingCancelled(false);
    setError(null);
    setVerifyUnknown(false);
    if (dirtyRef.current) {
      const prevV = (typeof conflictVersion() === "number" ? conflictVersion() as number : 0);
      const nv = Math.max(props.entry.version, floor, prevV);
      conflictVerRef.current = nv;
      setConflict({ version: nv });
      setStatusNote(
        "A newer saved version (v" + props.entry.version + ") exists. Your unsaved edits are kept — use Reload to review it."
      );
      return;
    }
    const p = parseCharacterProfile(props.entry.profileJson);
    const freshLinks = initialEditorLinks(props.entry.profileJson, props.sourceUrls);
    setEntry(props.entry);
    setParagraphs(p.paragraphs);
    setLinks(freshLinks);
    setSavedSnapshot({ paragraphs: p.paragraphs, links: normLinks(freshLinks) });
    applyStoredResearch(props.entry);
    ackedRef.current = { id: props.entry.id, version: props.entry.version, profileJson: props.entry.profileJson };
    observeCanon(props.entry.id, props.entry.version);
    observeCanonRecord(props.entry);
    conflictVerRef.current = 0;
    setConflict(null);
    setAdoptNote("");
    setSnapshotClearedNote("");
    void refreshResearch(props.entry.id, true, myOp);
    // entryRef/dirtyRef mirrors update on render; version prop is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.entry.id, props.entry.version]);

  function reloadCanonical() {
    const myOp = nextOp();
    cancelledRef.current = false;
    stopClocks();
    setBusy(false);
    setWaitingCancelled(false);
    setError(null);
    setVerifyUnknown(false);
    const floor = Math.max(ackedRef.current.version, canonFloor(props.entry.id));
    const best = highestCanon(props.entry.id);
    const target = best && best.version >= floor ? best : (props.entry.version >= floor ? props.entry : best);
    if (target && target.version >= floor) {
      const p = parseCharacterProfile(target.profileJson);
      const freshLinks = initialEditorLinks(target.profileJson, props.sourceUrls);
      setEntry(target);
      setParagraphs(p.paragraphs);
      setLinks(freshLinks);
      setSavedSnapshot({ paragraphs: p.paragraphs, links: normLinks(freshLinks) });
      applyStoredResearch(target);
      ownerSavedRef.current = false;
      ackedRef.current = { id: target.id, version: target.version, profileJson: target.profileJson };
      observeCanon(target.id, target.version);
      observeCanonRecord(target);
      conflictVerRef.current = 0;
      setConflict(null);
      setAdoptNote("");
      setSnapshotClearedNote("");
      setStatusNote("Reloaded saved version " + target.version + ". Your edits were replaced \u2014 nothing was saved.");
      void refreshResearch(target.id, false, myOp);
      return;
    }
    void (async () => {
      try {
        const row = await props.resolveCanonicalEntry(props.entry.id);
        if (staleKind(myOp, props.entry.id) !== "ok") return;
        if (row && row.id === props.entry.id && row.version >= floor) {
          const p = parseCharacterProfile(row.profileJson);
          const freshLinks = initialEditorLinks(row.profileJson, props.sourceUrls);
          setEntry(row);
          setParagraphs(p.paragraphs);
          setLinks(freshLinks);
          setSavedSnapshot({ paragraphs: p.paragraphs, links: normLinks(freshLinks) });
          applyStoredResearch(row);
          ownerSavedRef.current = false;
          ackedRef.current = { id: row.id, version: row.version, profileJson: row.profileJson };
          observeCanon(row.id, row.version);
          observeCanonRecord(row);
          conflictVerRef.current = 0;
          setConflict(null);
          setAdoptNote("");
          setSnapshotClearedNote("");
          setStatusNote("Reloaded saved version " + row.version + ". Your edits were replaced \u2014 nothing was saved.");
          void refreshResearch(row.id, false, myOp);
          return;
        }
      } catch { /* fall through */ }
      if (staleKind(myOp, props.entry.id) !== "ok") return;
      conflictVerRef.current = Math.max(conflictVerRef.current, floor);
      setConflict({ version: Math.max(conflictVerRef.current, floor) });
      setVerifyUnknown(true);
      setStatusNote("Reload could not confirm the newest version (v" + floor + "). Your draft is preserved \u2014 use Check again to retry; nothing old was adopted.");
    })();
  }

  function startClocks(entryId: string, myOp: number | null) {
    stopClocks();
    setElapsed(0);
    const t0 = Date.now();
    timer.current = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - t0) / 1000)),
      1000
    );
    pollTimer.current = window.setInterval(() => {
      void refreshResearch(entryId, true, myOp);
    }, 2500);
  }

  async function refreshResearch(entryId: string, quiet: boolean, myOp: number | null): Promise<ResearchGetResponse | null> {
    const opId = entryId;
    const myOrigin = opOrigins.current.get(myOp ?? -1) ?? null;
    try {
      const fresh = await get<ResearchGetResponse>("/api/roster/" + entryId + "/research");
      const kind = staleKind(myOp, opId);
      if (kind === "superseded") return null;
      if (kind === "origin") {
        if (opToken.current === myOp) {
          retireOwnOp();
          setResearchStatus("idle");
          setStage("");
          setStatusNote("Session changed. The pending run was left behind; the current draft is unchanged. Run research again if needed.");
        }
        return null;
      }
      if (cancelledRef.current && quiet) return fresh;
      applyResearchState(fresh, quiet, entryId, myOp);
      return fresh;
    } catch (e) {
      const kind2 = staleKind(myOp, opId);
      if (kind2 !== "ok") {
        if (kind2 === "origin" && opToken.current === myOp) {
          retireOwnOp();
          setResearchStatus("idle");
          setStage("");
          setStatusNote("Session changed. The pending run was left behind; the current draft is unchanged. Run research again if needed.");
        }
        return null;
      }
      if (!quiet) setError(readError(e));
      return null;
    }
  }

  function applyResearchState(fresh: ResearchGetResponse, quiet: boolean, entryId: string, myOp: number | null) {
    if (staleKind(myOp, entryId) === "superseded") return;
    if (staleKind(myOp, entryId) === "origin") {
      if (opToken.current === myOp) {
        retireOwnOp();
        setResearchStatus("idle");
        setStage("");
        setStatusNote("Session changed. The pending run was left behind; the current draft is unchanged. Run research again if needed.");
      }
      return;
    }
    if (typeof fresh.version === "number") {
      observeCanon(entryId, fresh.version);
      if (fresh.version < canonFloor(entryId)) return;
      if (!noteResearchVersion(entryId, fresh.version)) return;
    }
    if (typeof fresh.stage === "string" && fresh.stage) setStage(fresh.stage);
    if (Array.isArray(fresh.sources) && fresh.sources.length > 0) {
      if (!isStaleOp(myOp, entryId)) setSources(fresh.sources);
    }
    if (!quiet && fresh.stageError && !isStaleOp(myOp, entryId)) setError(String(fresh.stageError));
    const ds = String(fresh.draftStatus ?? "");
    const stg = String(fresh.stage ?? "");
    if (ds === "failed") {
      if (isStaleOp(myOp, entryId)) return;
      setCompiled({ ...EMPTY_PARAGRAPHS });
      setHasCompiled(false);
      setResearchStatus("failed");
      setStatusNote("The server run ended in failure. Your draft is unchanged; retry or edit the paragraphs directly.");
      stopClocks();
      setBusy(false);
      return;
    }
    if (ds === "superseded") {
      if (isStaleOp(myOp, entryId)) return;
      setCompiled({ ...EMPTY_PARAGRAPHS });
      setHasCompiled(false);
      setResearchStatus("stale");
      setStatusNote("A newer run or edit won on the server. Review the current draft, then run research again if needed.");
      stopClocks();
      setBusy(false);
      return;
    }
    if ((stg === "interrupted" || stg === "failed" || stg === "unsupported") && !fresh.running && !ds) {
      if (isStaleOp(myOp, entryId)) return;
      if (stg === "interrupted") {
        setResearchStatus("failed");
        setStatusNote("The server run was interrupted (for example by a restart) with no result. Your draft is unchanged; retry the run.");
      } else if (stg === "unsupported") {
        setResearchStatus("incomplete");
        setStatusNote("Research finished without grounded evidence. The draft below is editable but marked incomplete, not done.");
      } else {
        setResearchStatus("failed");
        setStatusNote("The server run ended in failure. Your draft is unchanged; retry or edit the paragraphs directly.");
      }
      stopClocks();
      setBusy(false);
      return;
    }
    if (stg === "interrupted" && !fresh.running) {
      if (isStaleOp(myOp, entryId)) return;
      setResearchStatus("failed");
      setStatusNote("The server run was interrupted (for example by a restart) with no result. Your draft is unchanged; retry the run.");
      stopClocks();
      setBusy(false);
      return;
    }
    if (!quiet) return;
    if (cancelledRef.current || statusRef.current !== "working") return;
    const resAt = (fresh.researchedAt ?? null) as string | null;
    const ev = typeof fresh.evidenceCount === "number" ? (fresh.evidenceCount as number) : 0;
    if ((ds === "draft" || ds === "done" || ds === "saved") && resAt && ev > 0) {
      const dp = fresh.draftProfile as DraftProfile | null;
      if (!dp) return;
      if (isStaleOp(myOp, entryId)) return;
      const stored = parseStoredResearch(String(fresh.researchJson ?? "{}"));
      completeFromServer({
        draft: dp, draftStatus: ds, resAt, supported: true, evCount: ev,
        sources: Array.isArray(fresh.sources) ? fresh.sources : [],
        claims: stored.claims, note: stored.note, searched: stored.searched,
      });
      stopClocks();
      if (!isStaleOp(myOp, entryId)) setBusy(false);
    } else if (ds === "unsupported") {
      const stored = parseStoredResearch(String(fresh.researchJson ?? "{}"));
      const udp = fresh.draftProfile as DraftProfile | null;
      if (isStaleOp(myOp, entryId)) return;
      completeFromServer({
        draft: udp, draftStatus: ds, resAt: (fresh.researchedAt ?? null) as string | null, supported: false, evCount: ev,
        sources: Array.isArray(fresh.sources) ? fresh.sources : [],
        claims: stored.claims, note: stored.note, searched: stored.searched,
      });
      stopClocks();
      if (!isStaleOp(myOp, entryId)) setBusy(false);
    } else if (ds === "interrupted") {
      setResearchStatus("failed");
      setStatusNote("The server run was interrupted (for example by a restart) with no result. Your draft is unchanged; retry the run.");
      stopClocks();
    }
  }

  function cleanLinks(): string[] {
    return normLinks(links).slice(0, 3);
  }
  // The in-flow research run: real bounded server work with live polled
  // stages. Never synthesizes paragraphs, progress, or completion.
  function completeFromServer(args: {
    draft: DraftProfile | null;
    draftStatus: string;
    resAt: string | null;
    supported: boolean;
    evCount: number;
    sources: ResearchSource[];
    claims: ResearchClaim[];
    note: string;
    searched: number;
  }): void {
    const d = args.draft;
    const ds = args.draftStatus;
    const seedEligible = freshEligibleRef.current === true;
    const baseline = seedEligible ? { ...mountSeedRef.current } : { ...EMPTY_PARAGRAPHS };
    const cur = { ...paraRef.current };
    const usable = ds === "draft" || ds === "done" || ds === "saved" || ds === "unsupported";
    if (d && usable) {
      const compiledNext: CharacterParagraphs = {
        contributionCriteria: (d.contributionCriteria ?? "").trim(),
        reasoningApproach: (d.reasoningApproach ?? "").trim(),
        responseStyle: (d.responseStyle ?? "").trim(),
      };
      if (!compiledNext.contributionCriteria || !compiledNext.reasoningApproach || !compiledNext.responseStyle) {
        setResearchStatus("incomplete");
        setStatusNote("Research returned an unusable compiled draft — marked incomplete, not done. Your draft is unchanged; edit the paragraphs directly or retry.");
        return;
      }
      setCompiled(compiledNext);
      setHasCompiled(true);
      const adopted = adoptCompiledParagraphs(cur, baseline, compiledNext);
      const kept = (Object.keys(adopted.paragraphs) as CharacterParagraphKey[]).filter(
        (k) => adopted.paragraphs[k] !== compiledNext[k] && compiledNext[k] !== ""
      );
      setParagraphs(adopted.paragraphs);
      setSources(args.sources);
      setClaims(args.claims);
      setSearched(args.searched);
      setSupported(args.supported && args.evCount > 0);
      setResearchNote(args.note);
      setStage("");
      const grounded = (ds === "draft" || ds === "done" || ds === "saved") && args.resAt && args.supported && args.evCount > 0;
      if (grounded) {
        setResearchStatus("done");
        setStatusNote("Research complete (" + args.sources.length + " sources). Review every paragraph below, then save — nothing saved itself.");
      } else {
        setResearchStatus("incomplete");
        setStatusNote(
          ds === "unsupported"
            ? "Research finished without grounded evidence — the compiled draft below is editable but marked incomplete, not done. Nothing is approved."
            : "Research returned a compiled draft but WITHOUT supported evidence — marked incomplete, not done. Edit with care or retry."
        );
      }
      freshEligibleRef.current = false;
      const parts: string[] = [];
      if (adopted.updated.length > 0) parts.push("Adopted the server-compiled draft into " + adopted.updated.length + " field" + (adopted.updated.length === 1 ? "" : "s") + " that still held seed text.");
      if (kept.length > 0) parts.push("Your text in " + kept.length + " field" + (kept.length === 1 ? "" : "s") + " was kept; use Use compiled draft per field to replace it.");
      setAdoptNote(parts.join(" "));
      return;
    }
    if (ds === "superseded") {
      setCompiled({ ...EMPTY_PARAGRAPHS });
      setHasCompiled(false);
      setResearchStatus("stale");
      setStatusNote("A newer run or edit won on the server. Review the current draft, then run research again if needed.");
      return;
    }
    if (ds === "failed") {
      setCompiled({ ...EMPTY_PARAGRAPHS });
      setHasCompiled(false);
      setSources(args.sources);
      setClaims(args.claims);
      setResearchNote(args.note);
      setSupported(false);
      setResearchStatus("failed");
      setStatusNote("Research failed on the server; the entry was left pending. Your draft and brief are unchanged.");
      setError(args.note ? args.note : "Research failed; entry left pending.");
      return;
    }
    if (ds === "") {
      setCompiled({ ...EMPTY_PARAGRAPHS });
      setHasCompiled(false);
      setClaims([]);
      setSources([]);
      setResearchNote("");
      setSearched(0);
      setSupported(false);
      setAdoptNote("");
      setResearchStatus("stale");
      setStatusNote("The draft changed on the server and cleared this result. Review the current draft, then run research again if needed.");
      return;
    }
    setResearchStatus("incomplete");
    setStatusNote("Research answered without a usable compiled draft  — marked incomplete, not done. Your draft is unchanged; edit the paragraphs directly or retry.");
  }
  async function runResearch() {
    const entryId = entry.id;
    const myOp = nextOp();
    setBusy(true);
    setError(null);
    setAdoptNote("");
    setSnapshotClearedNote("");
    setWaitingCancelled(false);
    cancelledRef.current = false;
    setVerifyUnknown(false);
    setResearchStatus("working");
    setStage("starting");
    setStatusNote("Research requested for this draft. Paragraphs change only when the server answers.");
    startClocks(entryId, myOp);
    try {
      const clean = cleanLinks();
      for (const l of clean) {
        if (!isValidSourceUrl(l)) throw new Error("Links must be URLs (http(s):// or www.). Got: " + l);
      }
      const body: Record<string, unknown> = { sourceUrls: clean };
      const bg = parseCharacterProfile(entry.profileJson).background;
      if (bg.trim()) body.background = bg.trim();
      const dossier = await post<ResearchPostResponse>("/api/roster/" + entryId + "/research", body);
      if (staleKind(myOp, entryId) === "superseded") return;
      if (staleKind(myOp, entryId) === "origin") {
        if (opToken.current === myOp) {
          retireOwnOp();
          setResearchStatus("idle");
          setStage("");
          setStatusNote("Session changed. The pending run was left behind; the current draft is unchanged. Run research again if needed.");
        }
        return;
      }
      stopClocks();
      if (cancelledRef.current) {
        setWaitingCancelled(true);
        setStatusNote("Waiting was cancelled; the server run may still complete. Use Check again to pick up its result.");
        return;
      }
      const fresh = await get<ResearchGetResponse>("/api/roster/" + entryId + "/research");
      if (staleKind(myOp, entryId) === "superseded") return;
      if (staleKind(myOp, entryId) === "origin") {
        if (opToken.current === myOp) {
          retireOwnOp();
          setResearchStatus("idle");
          setStage("");
          setStatusNote("Session changed. The pending run was left behind; the current draft is unchanged. Run research again if needed.");
        }
        return;
      }
      if (typeof fresh.version === "number") {
        observeCanon(entryId, fresh.version);
        if (fresh.version < canonFloor(entryId)) return;
        if (!noteResearchVersion(entryId, fresh.version)) {
          stopClocks();
          if (opToken.current === myOp) setBusy(false);
          return;
        }
      }
      observeCanon(entryId, typeof dossier.version === "number" ? dossier.version : undefined);
      const dVer = typeof dossier.version === "number" ? dossier.version : undefined;
      const fVer = typeof fresh.version === "number" ? fresh.version : undefined;
      const getNewer = fVer !== undefined && dVer !== undefined && fVer > dVer;
      if (getNewer) observeCanon(entryId, fVer);
      const draft = (getNewer ? (fresh.draftProfile ?? null) : (fresh.draftProfile ?? dossier.draftProfile ?? null)) as DraftProfile | null;
      const draftStatus = String(getNewer ? (fresh.draftStatus ?? "") : (fresh.draftStatus ?? dossier.draftStatus ?? ""));
      const resAt = (fresh.researchedAt ?? null) as string | null;
      const evCount = typeof fresh.evidenceCount === "number" ? (fresh.evidenceCount as number) : 0;
      if (getNewer && !draft) {
        const gds = draftStatus;
        const gst = String(fresh.stage ?? "");
        stopClocks();
        setCompiled({ ...EMPTY_PARAGRAPHS });
        setHasCompiled(false);
        setClaims([]);
        setSources([]);
        setResearchNote("");
        setSearched(0);
        setSupported(false);
        setAdoptNote("");
        if (gds === "superseded") {
          setResearchStatus("stale");
          setStatusNote("A newer run or edit won on the server. Review the current draft, then run research again if needed.");
        } else if (gst === "interrupted" || gds === "interrupted") {
          setResearchStatus("failed");
          setStatusNote("The server run was interrupted (for example by a restart) with no result. Your draft is unchanged; retry the run.");
        } else if (gds === "failed") {
          setResearchStatus("failed");
          setStatusNote("Research failed on the server; the entry was left pending. Your draft and brief are unchanged.");
        } else if (gds === "unsupported") {
          setResearchStatus("incomplete");
          setStatusNote("Research finished without grounded evidence \u2014 editable draft below is marked incomplete, not done. Nothing is approved.");
        } else {
          setResearchStatus("stale");
          setStatusNote("The draft changed while research ran (a newer version cleared this result). Review the current draft, then run research again if needed.");
        }
        if (opToken.current === myOp) setBusy(false);
        return;
      }
      const srcs = getNewer
        ? (Array.isArray(fresh.sources) ? fresh.sources : [])
        : (Array.isArray(fresh.sources) && fresh.sources.length > 0
          ? fresh.sources
          : Array.isArray(dossier.evidenceRefs) ? dossier.evidenceRefs : []);
      const storedD = { claims: Array.isArray(dossier.claims) ? dossier.claims : [], note: typeof dossier.note === "string" ? dossier.note : "", searched: typeof dossier.searched === "number" ? dossier.searched : 0 };
      const storedF = parseStoredResearch(String(fresh.researchJson ?? "{}"));
      const useClaims = getNewer ? storedF.claims : (storedF.claims.length > 0 ? storedF.claims : storedD.claims);
      const useNote = getNewer ? storedF.note : (storedF.note || storedD.note);
      const useSearched = getNewer ? storedF.searched : (storedF.searched !== 0 ? storedF.searched : storedD.searched);
      const useSupported = evCount > 0;
      setStage("");
      if (opToken.current === myOp && entryRef.current.id === entryId) {
        setEntry((prev) => (prev.id === entryId ? { ...prev, researchedAt: resAt, researchRequested: true } : prev));
      }
      completeFromServer({
        draft, draftStatus, resAt, supported: useSupported, evCount, sources: srcs,
        claims: useClaims,
        note: useNote,
        searched: useSearched,
      });
    } catch (e) {
      const k = staleKind(myOp, entryId);
      if (k === "superseded") return;
      if (k === "origin") {
        if (opToken.current === myOp) {
          retireOwnOp();
          setResearchStatus("idle");
          setStage("");
          setStatusNote("Session changed. The pending run was left behind; the current draft is unchanged. Run research again if needed.");
        }
        return;
      }
      stopClocks();
      const msg = readError(e);
      if (/already running/i.test(msg)) {
        setResearchStatus("stale");
        setStatusNote("Research is already running for this draft on the server. Wait, then use Check again — do not start a second run.");
      } else if (/409|superseded|changed during research/i.test(msg)) {
        setResearchStatus("stale");
        setStatusNote("The draft changed while research ran. Review the current draft, then run research again.");
      } else if (/deadline exceeded|504|499/i.test(msg)) {
        setResearchStatus("failed");
        setStatusNote("Research hit its time bound; the entry was left pending, nothing marked complete. Retry or edit the paragraphs directly.");
      } else {
        setResearchStatus("failed");
        setStatusNote("Research failed; the saved draft and your text are unchanged.");
      }
      setError(msg);
    } finally {
      const kf = staleKind(myOp, entryId);
      if (kf === "superseded") return;
      if (kf === "origin") {
        if (opToken.current === myOp) {
          stopClocks();
          setBusy(false);
        }
        return;
      }
      stopClocks();
      setBusy(false);
    }
  }

  function cancelWaiting() {
    cancelledRef.current = true;
    stopClocks();
    setWaitingCancelled(true);
    setBusy(false);
    setStatusNote("Stopped waiting; the server run may still complete. Use Check again to pick up its result — nothing is marked complete meanwhile.");
  }

  async function checkAgain() {
    const entryId = entry.id;
    const myOp = nextOp();
    let keepBusy = false;
    cancelledRef.current = false;
    setWaitingCancelled(false);
    setVerifyUnknown(false);
    setBusy(true);
    setError(null);
    try {
      const fresh = await refreshResearch(entryId, false, myOp);
      if (!fresh || staleKind(myOp, entryId) !== "ok") return;
      observeCanon(entryId, typeof fresh.version === "number" ? fresh.version : undefined);
      const ds = String(fresh.draftStatus ?? "");
      const resAt = (fresh.researchedAt ?? null) as string | null;
      const evCount = typeof fresh.evidenceCount === "number" ? (fresh.evidenceCount as number) : 0;
      if (typeof fresh.version === "number") {
        if (fresh.version < canonFloor(entryId)) return;
        if (!noteResearchVersion(entryId, fresh.version)) return;
      }
      if (staleKind(myOp, entryId) === "ok") {
        setEntry((prev) => (prev.id === entryId ? { ...prev, researchedAt: resAt, researchRequested: true } : prev));
      }
      if (ds === "draft" || ds === "done" || ds === "saved" || ds === "unsupported" || ds === "failed" || ds === "superseded") {
        const stored = parseStoredResearch(String(fresh.researchJson ?? ""));
        const dp = fresh.draftProfile as DraftProfile | null;
        completeFromServer({
          draft: dp, draftStatus: ds, resAt, supported: evCount > 0, evCount,
          sources: Array.isArray(fresh.sources) ? fresh.sources : [],
          claims: stored.claims, note: stored.note || (typeof fresh.stageError === "string" ? fresh.stageError : ""),
          searched: stored.searched,
        });
        setWaitingCancelled(false);
      } else if (fresh.running) {
        if (staleKind(myOp, entryId) !== "ok") return;
        setResearchStatus("working");
        setWaitingCancelled(false);
        cancelledRef.current = false;
        setStatusNote("The server run is still in flight (" + humanStage(fresh.stage || "running") + "). Waiting again with live stages.");
        startClocks(entryId, myOp);
        keepBusy = true;
        return;
      } else if (String(fresh.stage ?? "") === "interrupted") {
        if (isStaleOp(myOp, entryId)) return;
        setResearchStatus("failed");
        setStatusNote("The server run was interrupted (for example by a restart) with no result. Your draft is unchanged; retry the run.");
      } else {
        if (isStaleOp(myOp, entryId)) return;
        setResearchStatus("failed");
        setStatusNote("No completed research on the server for this draft. Retry the run or edit the paragraphs directly.");
      }
    } catch (e) {
      if (staleKind(myOp, entryId) === "superseded") return;
      if (staleKind(myOp, entryId) === "origin") {
        if (opToken.current === myOp) {
          retireOwnOp();
          setResearchStatus("idle");
          setStage("");
          setStatusNote("Session changed. The pending run was left behind; the current draft is unchanged. Run research again if needed.");
        }
        return;
      }
      stopClocks();
      setResearchStatus("failed");
      setStatusNote("Check again failed; the saved draft is unchanged.");
      setError(readError(e));
    } finally {
      if (staleKind(myOp, entryId) !== "ok") {
        if (staleKind(myOp, entryId) === "origin" && opToken.current === myOp && !keepBusy) {
          stopClocks();
          setBusy(false);
        }
        return;
      }
      if (keepBusy) return;
      stopClocks();
      setBusy(false);
    }
  }
  function adoptSavedDraft(fresh: ResearchGetResponse) {
    const adp = fresh.draftProfile as DraftProfile | null;
    if (adp && adp.contributionCriteria && adp.reasoningApproach && adp.responseStyle) {
      setCompiled({
        contributionCriteria: (adp.contributionCriteria ?? "").trim(),
        reasoningApproach: (adp.reasoningApproach ?? "").trim(),
        responseStyle: (adp.responseStyle ?? "").trim(),
      });
      setHasCompiled(true);
    }
  }

  function useCompiled(key: CharacterParagraphKey) {
    setParagraphs((prev) => ({ ...prev, [key]: compiled[key] }));
  }
  // Explicit final save (contract v2). Only genuinely changed keys are sent;
  // unknown profileJson keys are preserved by mergeCharacterProfile. Paragraphs
  // are hard-limited to PARAGRAPH_MAX and the whole profile to PROFILE_MAX,
  // both with explicit errors — never truncated. After the save the research
  // state is re-read from the server: proof kept (draft/saved + evidence),
  // unsupported/failed/superseded markers honored, cleared snapshot stated
  // honestly (expected when name/description/background changed). Never
  // auto-reruns: no save->invalidate->rerun loop. Stale-auth verification
  // failures are rethrown, never swallowed.
  async function saveEdits() {
    const opId = entry.id;
    const myOp = nextOp();
    setBusy(true);
    setError(null);
    try {
      const parsed = parseCharacterProfile(entry.profileJson);
      const clean = cleanLinks();
      for (const l of clean) {
        if (!isValidSourceUrl(l)) throw new Error("Links must be URLs (http(s):// or www.). Got: " + l);
      }
      for (const m of PARAGRAPH_META) {
        if (!paragraphs[m.key].trim()) {
          throw new Error(m.label + " must be a non-empty paragraph when saving character behavior.");
        }
        if (paragraphs[m.key].length > PARAGRAPH_MAX) {
          throw new Error(m.label + " is over the " + PARAGRAPH_MAX + "-character limit. Shorten it before saving — nothing is cut automatically.");
        }
      }
      const nextProfile = mergeCharacterProfile(entry.profileJson, {
        name: entry.name,
        background: parsed.background,
        sourceUrls: clean,
        paragraphs,
        researched: researchStatus === "done",
        characterSeed: false,
      });
      if (nextProfile.length > PROFILE_MAX) {
        throw new Error("Profile is over the " + PROFILE_MAX + "-character limit (got " + nextProfile.length + "). Shorten paragraphs or links — nothing is cut automatically.");
      }
      const normClean = normLinks(clean);
      const normSavedLinks = normLinks(savedSnapshot.links);
      const profileChanged = nextProfile !== entry.profileJson || JSON.stringify(normClean) !== JSON.stringify(normSavedLinks);
      if (!profileChanged) {
        setStatusNote("No changes to save — the stored draft is current.");
        return;
      }
      const hadProof = researchStatus === "done" || researchStatus === "incomplete";
      const urlsChangedSave = JSON.stringify(normClean) !== JSON.stringify(normSavedLinks);
      observeCanon(opId, entry.version);
      const normCleanPre = normLinks(clean);
      const updated = await put<RosterEntryDto>("/api/roster/" + entry.id, { profileJson: nextProfile, sourceUrls: normCleanPre });
      if (staleKind(myOp, opId) !== "ok") return;
      observeCanon(opId, updated.version);
      const myOriginSave = opOrigins.current.get(myOp) ?? null;
      let after: ResearchGetResponse | null = null;
      let verifyError: string | null = null;
      try {
        after = await get<ResearchGetResponse>("/api/roster/" + entry.id + "/research");
      } catch (e) {
        const kg = staleKind(myOp, opId);
        if (kg === "superseded") return;
        if (kg === "origin") return;
        if ((e as { stale?: boolean } | null)?.stale === true) {
          if (opToken.current === myOp) {
            retireOwnOp();
            setResearchStatus("idle");
            setStage("");
            setStatusNote("Session changed while verifying the save. The save reached the server; reload the roster to confirm before editing further.");
          }
          return;
        }
        verifyError = readError(e);
      }
      if (staleKind(myOp, opId) !== "ok") return;
      observeCanon(opId, updated.version);
      if (after && typeof after.version === "number") observeCanon(opId, after.version);
      // Canonical newer than PUT: a concurrent edit won between PUT and GET.
      // Never adopt or report the older PUT once a newer version is known.
      if (after && typeof after.version === "number" && after.version > updated.version) {
        const floorNow = canonFloor(opId);
        let canon: RosterEntryDto | null = null;
        let lookupFailed = false;
        try {
          canon = await props.resolveCanonicalEntry(opId);
        } catch {
          lookupFailed = true;
          canon = null;
        }
        if (staleKind(myOp, opId) !== "ok") return;
        const floorAfterResolve = canonFloor(opId);
        if (canon && canon.id === opId && canon.version >= floorAfterResolve && canon.version >= floorNow) {
          observeCanon(opId, canon.version);
          const cp = parseCharacterProfile(canon.profileJson);
          const cl = normLinks(initialEditorLinks(canon.profileJson));
          setEntry(canon);
          setParagraphs(cp.paragraphs);
          setLinks([...cl, "", "", ""].slice(0, 3));
          setSavedSnapshot({ paragraphs: cp.paragraphs, links: cl });
          applyStoredResearch(canon);
          ackedRef.current = { id: canon.id, version: canon.version, profileJson: canon.profileJson };
          conflictVerRef.current = 0;
          ownerSavedRef.current = true;
          freshEligibleRef.current = false;
          setSavedAt(new Date().toISOString());
          setConflict(null);
          setVerifyUnknown(false);
          setStatusNote("Saved, but a newer version (v" + canon.version + ") landed concurrently. Showing the newest saved draft.");
          if (staleKind(myOp, opId) === "ok") props.onSaved?.(canon);
          return;
        }
        // Known newer but no confirming canonical: preserve old text, surface
        // conflict + unknown verification, never adopt/report the older PUT.
        conflictVerRef.current = Math.max(conflictVerRef.current, floorAfterResolve);
        setConflict({ version: Math.max(conflictVerRef.current, floorAfterResolve) });
        setVerifyUnknown(true);
        setSupported(false);
        if (statusRef.current === "done") setResearchStatus("stale");
        setStatusNote("Saved on the server as v" + updated.version + ", but a newer version (v" + floorAfterResolve + ") was observed" + (lookupFailed ? " and the canonical lookup failed" : "") + ". Your previous text is preserved below \u2014 use Reload or Check again to confirm; the older save was not applied here.");
        return;
      }
      setEntry((prev) => (prev.id === updated.id ? updated : prev));
      const reparsed = parseCharacterProfile(updated.profileJson);
      setParagraphs(reparsed.paragraphs);
      setSavedSnapshot({ paragraphs: reparsed.paragraphs, links: normLinks(clean) });
      setSavedAt(new Date().toISOString());
      setConflict(null);
      freshEligibleRef.current = false;
      ownerSavedRef.current = true;
      observeCanonRecord(updated);
      ackedRef.current = { id: updated.id, version: updated.version, profileJson: updated.profileJson };
      if (!after) {
        if (staleKind(myOp, opId) !== "ok") return;
        observeCanon(opId, updated.version);
        setVerifyUnknown(true);
        setSupported(false);
        if (statusRef.current === "done") setResearchStatus("stale");
        setStatusNote("Draft saved. Research state could not be verified (" + (verifyError || "no response") + ") \u2014 use Check again to refresh. Still unapproved and not attached to any board.");
        if (staleKind(myOp, opId) === "ok") props.onSaved?.(updated);
        return;
      }
      const ev = typeof after.evidenceCount === "number" ? (after.evidenceCount as number) : 0;
      const ds = String(after.draftStatus ?? "");
      const stored = parseStoredResearch(String(after.researchJson ?? "{}"));
      const afterSources = Array.isArray(after.sources) ? after.sources : [];
      if (after.researchedAt && (ds === "draft" || ds === "done" || ds === "saved") && ev > 0) {
        setClaims(stored.claims);
        setSources(stored.sources.length > 0 ? stored.sources : afterSources);
        setResearchNote(stored.note);
        setSearched(stored.searched);
        setSupported(true);
        adoptSavedDraft(after);
        setResearchStatus("done");
        setSnapshotClearedNote("");
        setVerifyUnknown(false);
        setStatusNote("Draft saved. The server kept the research proof with your paragraphs — still unapproved and not attached to any board.");
      } else if (ds === "unsupported" || ((ds === "draft" || ds === "done" || ds === "saved") && !after.researchedAt)) {
        setClaims(stored.claims);
        setSources(stored.sources.length > 0 ? stored.sources : afterSources);
        setResearchNote(stored.note || "Server draft has no supporting evidence.");
        setSupported(false);
        setResearchStatus("incomplete");
        setSnapshotClearedNote("");
        setVerifyUnknown(false);
        adoptSavedDraft(after);
        setStatusNote("Draft saved. Research remains unsupported (no grounded evidence) — still unapproved and not attached to any board.");
      } else if (ds === "failed" || ds === "superseded") {
        setCompiled({ ...EMPTY_PARAGRAPHS });
        setHasCompiled(false);
        setClaims(stored.claims);
        setSources(stored.sources.length > 0 ? stored.sources : afterSources);
        setResearchNote(stored.note);
        setSupported(false);
        setResearchStatus(ds === "superseded" ? "stale" : "failed");
        setStatusNote(ds === "superseded" ? "Draft saved. A newer run or edit won on the server — review, then run research again if needed." : "Draft saved. The recorded research failed — the saved text stands; retry research or edit directly.");
      } else if (hadProof && urlsChangedSave && !after.researchedAt && !ds && after.running === false && (String(after.stage ?? "") === "not-started" || String(after.stage ?? "") === "") && isEmptyResearchSnapshot(after.researchJson, afterSources, false)) {
        setSnapshotClearedNote("Saved. The server cleared the research snapshot on save (expected when name, description, or background change). Your saved paragraphs are unchanged and canonical; nothing was re-run automatically.");
        setVerifyUnknown(false);
        setResearchStatus("idle");
        setClaims([]);
        setSources([]);
        setResearchNote("");
        setHasCompiled(false);
        setStatusNote("Draft saved. Still unapproved and not attached to any board.");
      } else if (hadProof) {
        setSupported(false);
        if (statusRef.current === "done") setResearchStatus("stale");
        setStatusNote("Draft saved, but the research snapshot state is unclear — use Check again to refresh it. Your saved paragraphs are unchanged and canonical.");
        setVerifyUnknown(true);
      } else {
        setStatusNote("Draft saved. Still unapproved and not attached to any board.");
      }
      observeCanon(opId, updated.version);
      if (after && typeof after.version === "number") observeCanon(opId, after.version);
      ackedRef.current = { id: updated.id, version: Math.max(updated.version, canonFloor(opId)), profileJson: updated.profileJson };
      conflictVerRef.current = 0;
      if (staleKind(myOp, opId) === "ok") props.onSaved?.(updated);
    } catch (e) {
      const kc = staleKind(myOp, opId);
      if (kc === "superseded") return;
      if (kc === "origin") {
        if (opToken.current === myOp) {
          retireOwnOp();
          setResearchStatus("idle");
          setStage("");
          setStatusNote("Session changed. The pending save was left behind; the current draft is unchanged.");
        }
        return;
      }
      if ((e as { stale?: boolean } | null)?.stale === true) {
        if (opToken.current === myOp) {
          retireOwnOp();
          setResearchStatus("idle");
          setStage("");
          setStatusNote("Session changed while verifying the save. The save reached the server; reload the roster to confirm before editing further.");
        }
        return;
      }
      setError(readError(e));
    } finally {
      const kf = staleKind(myOp, opId);
      if (kf === "superseded") return;
      if (kf === "origin") {
        if (opToken.current === myOp) {
          stopClocks();
          setBusy(false);
        }
        return;
      }
      setBusy(false);
    }
  }
  function setLink(i: number, v: string) {
    setLinks((prev) => {
      const next = [...prev];
      next[i] = v;
      return next;
    });
  }

  function setParagraph(k: CharacterParagraphKey, v: string) {
    setParagraphs((prev) => ({ ...prev, [k]: v }));
  }

  const researchBusy = busy && researchStatus === "working" && !waitingCancelled;
  const dirty =
    JSON.stringify({ paragraphs, links: normLinks(links) }) !==
    JSON.stringify({ paragraphs: savedSnapshot.paragraphs, links: savedSnapshot.links });
  const provenanceLinks = parseCharacterProfile(entry.profileJson).sourceUrls;
  entryRef.current = entry;
  statusRef.current = researchStatus;
  paraRef.current = paragraphs;
  dirtyRef.current =
    JSON.stringify({ paragraphs, links: normLinks(links) }) !==
    JSON.stringify({ paragraphs: savedSnapshot.paragraphs, links: savedSnapshot.links });

  return (
    <div className="cc-editor">
      <fieldset className="cc-step" disabled={busy}>
        <legend>Research — part of this flow</legend>
        <div className="cc-field cc-links" style={{ marginTop: "0.6rem" }}>
          <span id="cc-links-label">
            Inspiration links (optional, up to 3)
            <span className="cc-hint">We fetch these pages as background reading during research. They never become the character&apos;s credentials.</span>
          </span>
          <div role="group" aria-labelledby="cc-links-label">
            {links.map((l, i) => (
              <input
                key={i}
                value={l}
                onChange={(e) => setLink(i, e.target.value)}
                placeholder={"https://… (" + (i + 1) + " of 3)"}
                inputMode="url"
                autoComplete="off"
                aria-label={"Inspiration link " + (i + 1) + " of 3"}
              />
            ))}
          </div>
        </div>
      </fieldset>
      <div className="cc-actions" style={{ marginTop: "0.6rem" }}>
          <button type="button" onClick={() => void runResearch()} disabled={busy && !waitingCancelled}>
            {researchBusy ? "Research running…" : "Run research on this draft"}
          </button>
          {researchBusy && (
            <button type="button" onClick={cancelWaiting}>
              Cancel waiting
            </button>
          )}
          {(waitingCancelled || researchStatus === "stale" || verifyUnknown) && (
            <button type="button" onClick={() => void checkAgain()} disabled={busy}>
              Check again
            </button>
          )}
        </div>

      <div className="cc-status" id="cc-research-status" aria-live="polite">
        <strong>
          Research status: {researchStatus}
          {researchStatus === "working" && !waitingCancelled
            ? " — " + (stage ? humanStage(stage) + ", " : "") + elapsed + "s elapsed (live server run, bounded)"
            : ""}
        </strong>
        <div>{statusNote}</div>
        {(researchStatus === "done" || researchStatus === "incomplete") && (
          <div>
            Cited sources: {sources.length}. Backed by cited excerpts: {supported ? "yes" : "no — treat as incomplete"}.
          </div>
        )}
        <div>{savedAt ? (dirty ? "Saved " + savedAt + " — you have unsaved changes." : "Saved " + savedAt + ".") : "Not saved yet."}</div>
      </div>
      {conflict && (
        <div role="alert" style={{ marginTop: "0.6rem" }}>
          A newer saved version (v{conflict.version}) exists. Your unsaved edits are kept.
          <button type="button" onClick={reloadCanonical} disabled={busy} style={{ marginLeft: "0.5rem" }}>
            Reload saved version
          </button>
        </div>
      )}
      {error && (
        <div className="cc-err" role="alert">
          {error}{" "}
          {(researchStatus === "failed" || researchStatus === "stale" || researchStatus === "incomplete") && (
            <button type="button" onClick={() => void runResearch()} disabled={busy}>
              Retry research
            </button>
          )}
        </div>
      )}

      {sources.length > 0 && (
        <details className="cc-research-detail">
          <summary>Human research: {sources.length} cited sources + compiled summary</summary>
          <ul className="cc-sources">
            {sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.title || s.url}
                </a>
                {s.ownerSupplied ? <span> (your link)</span> : null}
                {s.excerpt ? (
                  <div className="cc-excerpt">{s.excerpt}</div>
                ) : s.unfetched ? (
                  <div className="cc-excerpt">Link could not be fetched — not used as evidence.</div>
                ) : null}
              </li>
            ))}
          </ul>
          {researchNote && <p>{researchNote}</p>}
          {claims.length > 0 && (
            <ul className="cc-sources">
              {claims.slice(0, 12).map((c, i) => (
                <li key={i}>
                  [{c.angle}] {c.text}
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
      {adoptNote && <p>{adoptNote}</p>}
      {snapshotClearedNote && <p>{snapshotClearedNote}</p>}

      <fieldset className="cc-step" disabled={busy}>
        <legend>Character paragraphs</legend>
        <p className="cc-lede">
          Three short paragraphs in the character&apos;s voice. When they step in, how they
          argue, and how they treat disagreement — bluntness, formality, and when they
          challenge versus defer. No fixed traits or sliders; context decides.
        </p>
        {PARAGRAPH_META.map((m) => {
          const compiledDiffers =
            hasCompiled && compiled[m.key].trim() !== "" && paragraphs[m.key].trim() !== compiled[m.key].trim();
          return (
            <div className="cc-field" key={m.key} style={{ marginTop: "0.6rem" }}>
              <label htmlFor={m.id}>
                <span>
                  {m.label}
                  <span className="cc-hint">{m.hint}</span>
                </span>
              </label>
              <textarea
                id={m.id}
                className="cc-area"
                value={paragraphs[m.key]}
                onChange={(e) => setParagraph(m.key, e.target.value)}
                rows={6}
                maxLength={PARAGRAPH_MAX}
                placeholder={m.placeholder}
                aria-describedby={m.id + "-count"}
              />
              <div className="cc-count" id={m.id + "-count"}>
                {paragraphs[m.key].length} / {PARAGRAPH_MAX} characters
              </div>
              {compiledDiffers && (
                <span>
                  <button type="button" onClick={() => useCompiled(m.key)} disabled={busy}>
                    Use compiled draft
                  </button>
                </span>
              )}
            </div>
          );
        })}
        <p style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
          Privacy: the roster stores reusable profile fields only. Board names, messages,
          sources, and decisions are never copied into roster drafts.
        </p>
      </fieldset>

      <fieldset className="cc-step" disabled={busy}>
        <legend>Save</legend>
        <p className="cc-lede" style={{ marginBottom: "0.4rem" }}>
          Saving stores this draft on the roster. It does not approve a seat, attach a
          board copy, or place any model call. Changing the character text clears the
          server research snapshot above (backend rule) — provenance links stay in the
          saved profile{provenanceLinks.length > 0 ? " (" + provenanceLinks.length + " kept)" : ""}.
          A portrait is still required before a board can attach this advisor; that happens
          from the roster record, not here.
        </p>
        <div className="cc-actions" style={{ marginTop: 0 }}>
          <button type="button" className="primary" onClick={() => void saveEdits()} disabled={busy}>
            Save draft changes
          </button>
          {props.onClose && (
            <button type="button" onClick={props.onClose} disabled={busy}>
              Close
            </button>
          )}
        </div>
      </fieldset>
    </div>
  );
}
export function CreateAdvisor(props: CreateAdvisorProps) {
  const { accountId, get, post, put } = props;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [background, setBackground] = useState("");
  const [links, setLinks] = useState<string[]>(["", "", ""]);
  const [entry, setEntry] = useState<RosterEntryDto | null>(null);
  const [briefLocked, setBriefLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState("Step 1 of 3: name the character and describe them. Nothing is saved yet.");
  const createOp = useRef(0);
  const createOrigin = useRef<OriginIdentity | null>(null);
  const createRevRef = useRef(props.originRevision);
  useEffect(() => {
    return () => { createOp.current += 1; };
  }, []);
  useEffect(() => {
    if (createRevRef.current === props.originRevision) return;
    createRevRef.current = props.originRevision;
    createOp.current += 1;
    setBusy(false);
    setError(null);
    setStatusNote("Session changed. The pending creation was left behind; your brief is intact. Start the draft again if needed.");
  }, [props.originRevision]);

  function readError(e: unknown): string {
    if (e instanceof Error) return e.message;
    try {
      return JSON.stringify(e);
    } catch {
      return "Request failed.";
    }
  }

  function setLink(i: number, v: string) {
    setLinks((prev) => {
      const next = [...prev];
      next[i] = v;
      return next;
    });
  }

  // Step 1 of the single flow: one seeded draft entry. Background and links
  // ride the explicit quick fields (background, sourceUrls) so the backend
  // fetches and seeds them — never pasted into a focus string. The brief
  // above is never cleared on failure.
  async function createDraft() {
    createOp.current += 1;
    const myCreate = createOp.current;
    let myCOrigin: OriginIdentity | null = null;
    try { myCOrigin = captureOrigin(props); createOrigin.current = myCOrigin; } catch { myCOrigin = null; createOrigin.current = null; }
    setBusy(true);
    setError(null);
    try {
      const nm = name.trim();
      if (!nm) throw new Error("Name is required.");
      if (nm.length > 120) throw new Error("Name must be 120 chars or fewer.");
      if (description.trim().length < 5) throw new Error("Description is required (a sentence or more).");
      if (entry) throw new Error("This draft already exists — continue below.");
      const clean: string[] = [];
      for (const v of links) {
        const t = v.trim();
        if (t && clean.indexOf(t) < 0) clean.push(t);
      }
      const sliced = clean.slice(0, 3);
      for (const l of sliced) {
        if (!isValidSourceUrl(l)) throw new Error("Links must be URLs (http(s):// or www.). Got: " + l);
      }
      setStatusNote("Creating the draft on the server.");
      const body: Record<string, unknown> = {
        accountId,
        name: nm,
        description: description.trim(),
      };
      if (background.trim()) body.background = background.trim();
      if (sliced.length > 0) body.sourceUrls = sliced;
      const created = await post<RosterEntryDto>("/api/roster/quick", body);
      if (myCreate !== createOp.current) return;
      if (originDead(props, myCOrigin)) return;
      setEntry(created);
      setBriefLocked(true);
      setStatusNote(
        "Draft created. Research starts automatically below; " +
          "nothing is approved and nothing is attached to a board."
      );
      if (myCreate === createOp.current && !originDead(props, myCOrigin)) props.onCreated?.(created);
    } catch (e) {
      if (myCreate !== createOp.current) return;
      if (originDead(props, myCOrigin)) return;
      setStatusNote("Creation failed before anything was saved. Your brief above is intact — fix the problem and retry.");
      setError(readError(e));
    } finally {
      if (myCreate !== createOp.current) return;
      if (originDead(props, myCOrigin)) {
        if (myCreate === createOp.current) setBusy(false);
        return;
      }
      setBusy(false);
    }
  }

  return (
    <section className="card cc-flow" aria-label="Create advisor">
      <h3>Create advisor</h3>
      <p className="cc-lede">
        One flow in three steps: brief, research with compiled paragraphs, explicit save.
        Drafts stay drafts until you save; nothing here approves a board seat or attaches this
        advisor to a board. Board seats are granted later from This Board&apos;s Advisors.
      </p>
      <p className="cc-fictional">
        Fictional character: research below describes real-world inspiration, not this
        character&apos;s own history. The character never claims real jobs, degrees, licenses,
        or endorsements.
      </p>

      <fieldset className="cc-step" disabled={busy || briefLocked}>
        <legend>Step 1 — Brief</legend>
        <div className="cc-grid">
          <label className="cc-field" htmlFor="cc-name">
            <span>Name (required)</span>
            <input
              id="cc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Advisor name"
              required
              autoComplete="off"
            />
          </label>
        </div>
        <label className="cc-field" htmlFor="cc-description" style={{ marginTop: "0.6rem" }}>
          <span>
            Description (required)
            <span className="cc-hint">A few sentences in your own words: who is this character and what are they for?</span>
          </span>
          <textarea
            id="cc-description"
            className="cc-area-short"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            required
            placeholder="Who they are, in plain language."
          />
        </label>
        <label className="cc-field" htmlFor="cc-background" style={{ marginTop: "0.6rem" }}>
          <span>
            Background (optional)
            <span className="cc-hint">A few sentences of color: where they come from, what shaped them. Fictional.</span>
          </span>
          <textarea
            id="cc-background"
            className="cc-area-short"
            value={background}
            onChange={(e) => setBackground(e.target.value)}
            rows={3}
            placeholder="Optional color for the character."
          />
        </label>
        <div className="cc-field cc-links" style={{ marginTop: "0.6rem" }}>
          <span id="cc-brief-links-label">
            Inspiration links (optional, up to 3)
            <span className="cc-hint">Pages that inspire the character. We read them during research; they stay inspiration, not credentials.</span>
          </span>
          <div role="group" aria-labelledby="cc-brief-links-label">
            {links.map((l, i) => (
              <input
                key={i}
                value={l}
                onChange={(e) => setLink(i, e.target.value)}
                placeholder={"https://… (" + (i + 1) + " of 3)"}
                inputMode="url"
                autoComplete="off"
                aria-label={"Inspiration link " + (i + 1) + " of 3"}
              />
            ))}
          </div>
        </div>
        {!entry && (
          <div className="cc-actions">
            <button type="button" className="primary" onClick={() => void createDraft()} disabled={busy}>
              {busy ? "Creating…" : "Create draft"}
            </button>
          </div>
        )}
      </fieldset>

      <div className="cc-status" id="cc-creation-status" aria-live="polite">
        <strong>Creation status</strong>
        <div>{statusNote}</div>
      </div>
      {error && (
        <div className="cc-err" role="alert">
          {error}
        </div>
      )}

      {entry && (
        <>
          <h4>Step 2 — Research and paragraphs</h4>
          <CharacterEditor
            entry={entry}
            get={get}
            post={post}
            put={put}
            originIdentity={props.originIdentity}
            originStale={props.originStale}
            originRevision={props.originRevision}
            resolveCanonicalEntry={props.resolveCanonicalEntry}
            freshCreation={true}
            autoStartResearch
            background={background}
            sourceUrls={links.map((l) => l.trim()).filter((l) => l.length > 0).slice(0, 3)}
            onSaved={(updated) => {
              setEntry(updated);
              props.onCreated?.(updated);
            }}
            onClose={props.onClose}
          />
        </>
      )}
      {!entry && props.onClose && (
        <div className="cc-actions">
          <button type="button" onClick={props.onClose} disabled={busy}>
            Close
          </button>
        </div>
      )}
    </section>
  );
}




