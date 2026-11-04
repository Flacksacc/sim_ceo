import { useState } from "react";
import { createRoot } from "react-dom/client";
import SourcesGovernance from "./sources-governance";
import type { GovTransport } from "./sources-governance";
import WikiResources from "./wiki-resources";
import type { WikiApi, WikiResourceDto } from "./wiki-resources";

declare global {
  interface Window {
    __mount: {
      calls: string[];
      downloads: string[];
      uploads: { url: string; scope: string; meetingId: string }[];
      govActError: string | null;
      govRecallError: string | null;
      wikiOpError: string | null;
    };
  }
}

const meetings = [
  { id: "11111111-2222-3333-4444-555555555555", title: "Quarterly Planning" },
  { id: "22222222-2222-3333-4444-555555555555", title: "Hiring Review" },
];

const V3 = "99999999-2222-3333-4444-555555555555";
const V2 = "33333333-2222-3333-4444-555555555555";
const V1 = "44444444-2222-3333-4444-555555555555";
const M1 = "55555555-2222-3333-4444-555555555555";

const groups = [
  {
    familyKey: "fk-evidence", fileName: "Evidence.txt", scope: "board", meetingId: null,
    origin: "wiki", currentId: V2, hasCurrent: true,
    versions: [
      { id: V3, boardId: "b1", fileName: "Evidence.txt", contentHash: "cc3", version: 3, approved: false, excluded: false, reviewState: "pending", origin: "wiki", familyKey: "fk-evidence", indexState: "queued", indexGeneration: 0, indexError: "", sectionCount: 0, isHead: false, isCurrent: false, currentId: V2, scope: "board", meetingId: null, createdAt: "2026-10-03T12:00:00.000Z" },
      { id: V2, boardId: "b1", fileName: "Evidence.txt", contentHash: "cc2", version: 2, approved: true, excluded: false, reviewState: "approved", origin: "wiki", familyKey: "fk-evidence", indexState: "completed", indexGeneration: 2, indexError: "", indexCompletedAt: "2026-10-02T12:00:00.000Z", sectionCount: 2, isHead: true, isCurrent: true, currentId: V2, scope: "board", meetingId: null, createdAt: "2026-10-02T12:00:00.000Z" },
      { id: V1, boardId: "b1", fileName: "Evidence.txt", contentHash: "cc1", version: 1, approved: false, excluded: false, reviewState: "rejected", origin: "wiki", familyKey: "fk-evidence", indexState: "failed", indexGeneration: 1, indexError: "pq: backend failure", sectionCount: 0, isHead: false, isCurrent: false, currentId: V2, scope: "board", meetingId: null, createdAt: "2026-10-01T12:00:00.000Z" },
    ],
  },
  {
    familyKey: "fk-minutes", fileName: "Minutes.txt", scope: "meeting", meetingId: "11111111-2222-3333-4444-555555555555",
    origin: "wiki", currentId: null, hasCurrent: false,
    versions: [
      { id: M1, boardId: "b1", fileName: "Minutes.txt", contentHash: "dd1", version: 1, approved: false, excluded: true, reviewState: "pending", origin: "wiki", familyKey: "fk-minutes", indexState: "queued", indexGeneration: 0, indexError: "", sectionCount: 0, isHead: true, isCurrent: false, currentId: null, scope: "meeting", meetingId: "11111111-2222-3333-4444-555555555555", createdAt: "2026-10-04T12:00:00.000Z" },
    ],
  },
];

const histFor: Record<string, { id: string; action: string; detail: string; createdAt: string; version: number }[]> = {
  [V3]: [{ id: "h3", action: "upload", detail: "scope=board", createdAt: "2026-10-03T12:00:00.000Z", version: 3 }],
  [V2]: [
    { id: "h1", action: "approve", detail: "v2", createdAt: "2026-10-02T13:00:00.000Z", version: 2 },
    { id: "h2", action: "wiki-index-repair", detail: "rev2", createdAt: "2026-10-02T12:35:00.000Z", version: 2 },
  ],
  [V1]: [{ id: "h0", action: "wiki-import", detail: "rev1 Evidence.txt", createdAt: "2026-10-01T11:00:00.000Z", version: 1 }],
  [M1]: [{ id: "h4", action: "exclude", detail: "v1", createdAt: "2026-10-04T13:00:00.000Z", version: 1 }],
};

const secsFor: Record<string, unknown> = {
  [V2]: {
    sourceId: V2, version: 2, contentHash: "cc2", indexState: "completed", indexGeneration: 2, indexError: "",
    sections: [
      { id: "sec-a", ordinal: 1, heading: "Findings", location: "sec-1#1", text: "Solar arrays passed inspection.", indexGeneration: 2 },
    ],
  },
};

const recallHits = [
  { kind: "source", ref: "Evidence.txt v2", text: "Solar arrays passed inspection.", score: 9 },
  { kind: "record", ref: "aaaaaaaa-2222-3333-4444-555555555555#bbbbbbbb-cccc-dddd-eeee-ffffffffffff", text: "[bbbbbbbb-cccc-dddd-eeee-ffffffffffff] record v3: Approve the hiring plan.", score: 7 },
];

const wikiSeed: WikiResourceDto[] = [
  {
    id: "77777777-2222-3333-4444-555555555555", boardId: "b1", scope: "board", meetingId: null,
    baseUrl: "https://wiki.example.com", description: "Team handbook", allowedUse: "Handbook lookup for board discussion only",
    setupUse: false, manualOnly: false, allowlist: ["/guides/**"], exclusions: [],
    requiredTags: ["handbook"], locale: "en", enabled: true, configRevision: 3, attemptGeneration: 2, attemptStatus: "idle",
    syncIntervalMinutes: 60, nextSyncAt: null, status: "succeeded", lastError: "",
    lastCompletedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), lastSuccessRevision: 1, lastSuccessAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), usablePages: 1, importedPages: 1, sourceDocs: 1,
    eligibleDocs: 1, hasCredential: true, protocol: "wikijs-2.x-graphql-readonly", createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-05T12:00:00.000Z",
  },
];

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function GovApp() {
  const [readOnly, setReadOnly] = useState(false);
  const transport: GovTransport = {
    get: async (u: string) => {
      window.__mount.calls.push("GET " + u);
      await wait(25);
      if (u.endsWith("/sources/review")) return structuredClone(groups) as never;
      if (u.endsWith("/source-policy")) return { blockedTypes: "exe, zip", mode: "wikiOnly" } as never;
      if (u.endsWith("/context")) return { total: 2, approved: 1, pending: 1, rejected: 0, excluded: 1, indexed: 1, indexFailed: 0, policy: "wikiOnly" } as never;
      if (u.indexOf("/recall") >= 0) {
        if (window.__mount.govRecallError) { const e = window.__mount.govRecallError; throw new Error(e); }
        return structuredClone(recallHits) as never;
      }
      const hm = u.match(/\/api\/sources\/([^/]+)\/history/);
      if (hm) return structuredClone(histFor[hm[1]] ?? []) as never;
      const sm = u.match(/\/api\/sources\/([^/]+)\/sections/);
      if (sm) return structuredClone(secsFor[sm[1]] ?? null) as never;
      throw new Error("unexpected GET " + u);
    },
    post: async (u: string) => {
      window.__mount.calls.push("POST " + u);
      await wait(25);
      if (window.__mount.govActError) { const e = window.__mount.govActError; throw new Error(e); }
      return {} as never;
    },
    put: async (u: string) => {
      window.__mount.calls.push("PUT " + u);
      await wait(25);
      return {} as never;
    },
    del: async (u: string) => {
      window.__mount.calls.push("DELETE " + u);
      await wait(25);
      return {} as never;
    },
    upload: async (u: string, f: FormData) => {
      await wait(25);
      const scope = String(f.get("scope") ?? "");
      const meetingId = String(f.get("meetingId") ?? "");
      window.__mount.uploads.push({ url: u, scope, meetingId });
      window.__mount.calls.push("UPLOAD " + u + " scope=" + scope + " meeting=" + meetingId);
      return {} as never;
    },
    download: async (u: string, filename: string) => {
      await wait(10);
      window.__mount.downloads.push(u + "|" + filename);
    },
    origin: () => ({ epoch: 1, token: "t", user: "owner" }),
    stale: () => false,
  };
  return (
    <div>
      <button aria-label="Toggle read-only test" onClick={() => setReadOnly((v) => !v)}>Toggle read-only</button>
      <SourcesGovernance boardId="b1" meetingId="11111111-2222-3333-4444-555555555555" meetings={meetings} actAs="owner" readOnly={readOnly} canManage={!readOnly} transport={transport} />
    </div>
  );
}

function WikiApp() {
  const api: WikiApi = {
    get: async (u: string) => {
      window.__mount.calls.push("GET " + u);
      await wait(25);
      if (u.endsWith("/wiki-resources")) return structuredClone(wikiSeed) as never;
      throw new Error("unexpected GET " + u);
    },
    post: async (u: string) => {
      window.__mount.calls.push("POST " + u);
      await wait(25);
      if (window.__mount.wikiOpError) { const e = window.__mount.wikiOpError; throw new Error(e); }
      return {} as never;
    },
    patch: async (u: string) => {
      window.__mount.calls.push("PATCH " + u);
      await wait(25);
      if (window.__mount.wikiOpError) { const e = window.__mount.wikiOpError; throw new Error(e); }
      return {} as never;
    },
    del: async (u: string) => {
      window.__mount.calls.push("DELETE " + u);
      await wait(25);
      return {} as never;
    },
  };
  return <WikiResources boardId="b1" meetingId="11111111-2222-3333-4444-555555555555" meetings={meetings} api={api} onChanged={() => { window.__mount.calls.push("CHANGED"); }} />;
}

window.__mount = { calls: [], downloads: [], uploads: [], govActError: null, govRecallError: null, wikiOpError: null };

createRoot(document.getElementById("root")!).render(
  <div>
    <GovApp />
    <WikiApp />
  </div>
);
