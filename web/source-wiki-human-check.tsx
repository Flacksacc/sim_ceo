import { renderToString } from "react-dom/server";
import { actionLabel, contextSummary, friendlyAttempt, friendlySyncState, historyText, indexLabel, meetingTitle, originLabel, recallKindLabel, recallTitle, relativeTime, resourceLabel, reviewLabel, safeIndexHelp, safeRequestMessage, safeRowHelp, safeSyncHelp, scopeLabel, wikiScopeLabel } from "./src/human-source-format";
import SourcesGovernance from "./src/sources-governance";
import type { GovTransport } from "./src/sources-governance";
import WikiResources from "./src/wiki-resources";
import type { WikiApi, WikiResourceDto } from "./src/wiki-resources";

let passed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (!cond) throw new Error("FAIL " + name + (extra ? " :: " + extra : ""));
  passed++;
  console.log("ok - " + name);
}
function visible(html: string): string {
  return html.replace(/<!--[^-]*-->/g, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
const GUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}[0-9a-fA-F-]*";
function shownHasGuid(text: string): boolean {
  return new RegExp(GUID).test(text);
}
function namesOf(html: string): string[] {
  const out: string[] = [];
  const re = /aria-label="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

const meetings = [
  { id: "11111111-2222-3333-4444-555555555555", title: "Quarterly Planning" },
  { id: "22222222-2222-3333-4444-555555555555", title: "Hiring Review" },
];

const govTransport: GovTransport = {
  get: async () => { throw new Error("fixture governance transport stays idle"); },
  post: async () => { throw new Error("fixture governance transport stays idle"); },
  put: async () => { throw new Error("fixture governance transport stays idle"); },
  del: async () => { throw new Error("fixture governance transport stays idle"); },
  upload: async () => { throw new Error("fixture governance transport stays idle"); },
  download: async () => { throw new Error("fixture governance transport stays idle"); },
  origin: () => ({ epoch: 1, token: "t", user: "owner" }),
  stale: () => false,
};

const wikiApi: WikiApi = {
  get: async () => { throw new Error("fixture wiki api stays idle"); },
  post: async () => { throw new Error("fixture wiki api stays idle"); },
  patch: async () => { throw new Error("fixture wiki api stays idle"); },
  del: async () => { throw new Error("fixture wiki api stays idle"); },
};
// Helper units on authored payloads. IDs and raw backend text go in;
// readable human copy must come out with no identifiers leaking.
check("helper: meeting title resolves", meetingTitle(meetings, "11111111-2222-3333-4444-555555555555") === "Quarterly Planning");
check("helper: meeting unknown is null", meetingTitle(meetings, "99999999-2222-3333-4444-555555555555") === null);
check("helper: scope board", scopeLabel("board", null) === "Board file");
check("helper: scope meeting title", scopeLabel("meeting", "Quarterly Planning") === "Meeting file - Quarterly Planning");
check("helper: wiki scope meeting", wikiScopeLabel("meeting", "Quarterly Planning") === "Meeting - Quarterly Planning");
check("helper: origin upload", originLabel("upload") === "Added by upload");
check("helper: origin wiki", originLabel("wiki") === "Added from Wiki connector");
check("helper: review pending", reviewLabel("pending", false).label === "Waiting for review");
check("helper: review excluded", reviewLabel("pending", true).label === "Temporarily hidden");
check("helper: review approved", reviewLabel("approved", false).label === "Approved");
check("helper: review rejected", reviewLabel("rejected", false).label === "Not kept");
check("helper: index ready", indexLabel("completed", true) === "Ready for meetings");
check("helper: index failed", indexLabel("failed", false) === "Search unavailable for now");
check("helper: index help fixed", safeIndexHelp().indexOf("re-upload") >= 0 && !shownHasGuid(safeIndexHelp()));
check("helper: action label", actionLabel("Enable connector", "Team handbook (board)") === "Enable connector Team handbook (board)");
check("helper: resource label", resourceLabel("Team handbook", "https://wiki.example.com", "board", null) === "Team handbook (board)");
check("helper: resource label meeting", resourceLabel("", "https://wiki.example.com", "meeting", "Quarterly Planning") === "https://wiki.example.com (meeting Quarterly Planning)");
const ctxText = contextSummary({ total: 4, approved: 2, pending: 1, rejected: 1, excluded: 1, indexed: 3, indexFailed: 1, policy: "wikiOnly", extraction: "local deterministic sections; no vector index", hindsight: "PostgreSQL remains authoritative" });
check("helper: context counts", ctxText.indexOf("4 files") >= 0 && ctxText.indexOf("2 ready for meetings") >= 0 && ctxText.indexOf("1 waiting for review") >= 0);
check("helper: context policy + failures", ctxText.indexOf("Wiki connector only") >= 0 && ctxText.indexOf("1 needs attention") >= 0);
check("helper: context allowlist", ctxText.indexOf("vector") < 0 && ctxText.indexOf("hindsight") < 0 && ctxText.indexOf("PostgreSQL") < 0);
check("helper: context unknown", contextSummary(null).indexOf("unavailable") >= 0);
const hApprove = historyText("approve", "v2");
check("helper: history approve", hApprove.headline === "Approved" && hApprove.detail === "Version 2.");
const hIndex = historyText("index", "gen2 sections5");
check("helper: history index", hIndex.headline === "Search updated" && hIndex.detail.indexOf("5 sections ready") >= 0);
const hUpload = historyText("upload", "scope=meeting");
check("helper: history scope", hUpload.detail === "Meeting file.");
const hFail = historyText("index-failed", "pq: syntax error at /var/lib/data with id 11111111-2222-3333-4444-555555555555");
check("helper: history failure hides backend", hFail.headline === "Search could not finish" && !shownHasGuid(hFail.detail) && hFail.detail.indexOf("/var") < 0 && hFail.detail.indexOf("pq:") < 0);
check("helper: recall source kind", recallKindLabel("source") === "Source");
check("helper: recall record kind", recallKindLabel("record") === "Board record");
check("helper: recall direction kind", recallKindLabel("direction") === "Meeting direction");
check("helper: recall title kept", recallTitle("source", "Evidence.txt v2") === "Evidence.txt v2");
check("helper: recall guid hidden", recallTitle("record", "55555555-2222-3333-4444-555555555555#aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") === null);
check("helper: request validation kept", safeRequestMessage("Description is required before enable; set it now.") === "Description is required before enable; set it now.");
check("helper: request conflict human", safeRequestMessage("Error: 409 conflict") === "That change conflicts with a newer update. Refresh and try again.");
check("helper: request strips json", safeRequestMessage("400 {error: bad}") !== "400 {error: bad}" && safeRequestMessage("400 {error: bad}").indexOf("{") < 0);
check("helper: request meeting scope", safeRequestMessage("meetingId is required for meeting scope").indexOf("Pick a meeting") >= 0);
check("helper: request guid hidden", !shownHasGuid(safeRequestMessage("deny 11111111-2222-3333-4444-555555555555")));
check("helper: sync failed", friendlySyncState("failed", true) === "Last sync did not finish");
check("helper: sync synced", friendlySyncState("succeeded", true) === "Synced");
check("helper: sync disabled", friendlySyncState("succeeded", false) === "Disabled");
check("helper: attempt running", friendlyAttempt("running") === "Sync running...");
check("helper: attempt idle", friendlyAttempt("idle") === "Idle");
check("helper: sync help fixed", safeSyncHelp().indexOf("sync again") >= 0);
check("helper: row help enable", safeRowHelp("/enable").indexOf("Could not enable") >= 0);
check("helper: relative just now", relativeTime(new Date().toISOString()) === "just now");
check("helper: relative hours", (relativeTime(new Date(Date.now() - 2 * 3600 * 1000).toISOString()) ?? "").indexOf("2 hours ago") >= 0);
check("helper: relative bad", relativeTime("not-a-date") === null && relativeTime(null) === null);
// Authored governance fixture. GUIDs and raw backend payloads are injected
// known fields, never user-authored content. Visible copy must stay human.
const govFixture = {
  groups: [
    {
      familyKey: "fk-evidence", fileName: "Evidence.txt", scope: "board", meetingId: null,
      origin: "upload", currentId: "33333333-2222-3333-4444-555555555555", hasCurrent: true,
      versions: [
        { id: "99999999-2222-3333-4444-555555555555", boardId: "b1", fileName: "Evidence.txt", contentHash: "cc3", version: 3, approved: false, excluded: false, reviewState: "pending", origin: "upload", familyKey: "fk-evidence", indexState: "queued", indexGeneration: 0, indexError: "", sectionCount: 0, isHead: true, isCurrent: false, currentId: "33333333-2222-3333-4444-555555555555", scope: "board", meetingId: null, createdAt: "2026-10-03T12:00:00.000Z" },
        { id: "33333333-2222-3333-4444-555555555555", boardId: "b1", fileName: "Evidence.txt", contentHash: "cc2", version: 2, approved: true, excluded: false, reviewState: "approved", origin: "upload", familyKey: "fk-evidence", indexState: "completed", indexGeneration: 2, indexError: "", indexCompletedAt: "2026-10-02T12:00:00.000Z", sectionCount: 2, isHead: false, isCurrent: true, currentId: "33333333-2222-3333-4444-555555555555", scope: "board", meetingId: null, createdAt: "2026-10-02T12:00:00.000Z" },
        { id: "44444444-2222-3333-4444-555555555555", boardId: "b1", fileName: "Evidence.txt", contentHash: "cc1", version: 1, approved: false, excluded: false, reviewState: "rejected", origin: "upload", familyKey: "fk-evidence", indexState: "failed", indexGeneration: 1, indexError: "pq: could not read /var/lib/data segment", sectionCount: 0, isHead: false, isCurrent: false, currentId: "33333333-2222-3333-4444-555555555555", scope: "board", meetingId: null, createdAt: "2026-10-01T12:00:00.000Z" },
      ],
    },
    {
      familyKey: "fk-minutes", fileName: "Minutes.txt", scope: "meeting", meetingId: "11111111-2222-3333-4444-555555555555",
      origin: "wiki", currentId: null, hasCurrent: false,
      versions: [
        { id: "55555555-2222-3333-4444-555555555555", boardId: "b1", fileName: "Minutes.txt", contentHash: "dd1", version: 1, approved: false, excluded: true, reviewState: "pending", origin: "wiki", familyKey: "fk-minutes", indexState: "queued", indexGeneration: 0, indexError: "", sectionCount: 0, isHead: true, isCurrent: false, currentId: null, scope: "meeting", meetingId: "11111111-2222-3333-4444-555555555555", createdAt: "2026-10-04T12:00:00.000Z" },
      ],
    },
  ],
  policy: { blockedTypes: "exe, zip", mode: "wikiOnly" },
  ctx: { total: 4, approved: 2, pending: 1, rejected: 1, excluded: 1, indexed: 3, indexFailed: 1, policy: "wikiOnly", extraction: "local deterministic sections; no vector index", hindsight: "PostgreSQL remains authoritative" },
  recallHits: [
    { kind: "source", ref: "Evidence.txt v2", text: "Solar arrays passed inspection.", score: 9 },
    { kind: "record", ref: "aaaaaaaa-2222-3333-4444-555555555555#bbbbbbbb-cccc-dddd-eeee-ffffffffffff", text: "Approve the hiring plan.", score: 7 },
    { kind: "direction", ref: "66666666-2222-3333-4444-555555555555", text: "Focus on onboarding.", score: 6 },
  ],
  hist: {
    "33333333-2222-3333-4444-555555555555": [
      { id: "h1", action: "approve", detail: "v2", createdAt: "2026-10-02T13:00:00.000Z", version: 2 },
      { id: "h2", action: "index", detail: "gen2 sections2", createdAt: "2026-10-02T12:30:00.000Z", version: 2 },
    ],
    "99999999-2222-3333-4444-555555555555": [
      { id: "h3", action: "upload", detail: "scope=board", createdAt: "2026-10-03T12:00:00.000Z", version: 3 },
    ],
  },
  secs: {
    "33333333-2222-3333-4444-555555555555": {
      sourceId: "33333333-2222-3333-4444-555555555555", version: 2, contentHash: "cc2", indexState: "completed", indexGeneration: 2, indexError: "",
      sections: [
        { id: "sec-a", ordinal: 1, heading: "Findings", location: "sec-1#1", text: "Solar arrays passed inspection.", indexGeneration: 2 },
        { id: "sec-b", ordinal: 2, heading: "", location: "sec-1#2", text: "Second paragraph of findings.", indexGeneration: 2 },
      ],
    },
  },
};

const govHtml = renderToString(<SourcesGovernance boardId="b1" meetingId="11111111-2222-3333-4444-555555555555" meetings={meetings} actAs="owner" canManage transport={govTransport} fixture={govFixture} />);
const govText = visible(govHtml);
const govNames = namesOf(govHtml);
check("gov: meeting title shown", govText.indexOf("Quarterly Planning") >= 0);
check("gov: no meeting id shown", !shownHasGuid(govText));
check("gov: review badges human", govText.indexOf("Waiting for review") >= 0 && govText.indexOf("Temporarily hidden") >= 0 && govText.indexOf("Approved") >= 0 && govText.indexOf("Not kept") >= 0);
check("gov: index badges human", govText.indexOf("Ready for meetings") >= 0 && govText.indexOf("Search unavailable for now") >= 0 && govText.indexOf("Search unavailable") >= 0);
check("gov: no index internals", govText.indexOf("index:") < 0 && govText.indexOf(" g1") < 0 && govText.indexOf("g2") < 0 && govText.indexOf("sec-") < 0);
check("gov: current copy", govText.indexOf("Current: version 2") >= 0 && govText.indexOf("never fall back") >= 0);
check("gov: scope + origin human", govText.indexOf("Board file") >= 0 && govText.indexOf("Meeting file - Quarterly Planning") >= 0 && govText.indexOf("Added by upload") >= 0 && govText.indexOf("Added from Wiki connector") >= 0);
check("gov: context summary human", govText.indexOf("4 files") >= 0 && govText.indexOf("2 ready for meetings") >= 0 && govText.indexOf("Wiki connector only") >= 0 && govText.indexOf("vector") < 0);
check("gov: summary counts human", govText.indexOf("1 waiting for review") >= 0 && govText.indexOf("1 not kept") >= 0 && govText.indexOf("1 need attention") >= 0);
check("gov: policy human", govText.indexOf("Wiki connector only") >= 0 && govText.indexOf("exe, zip") >= 0 && govText.indexOf("wikiOnly") < 0 && govText.indexOf("allowAll") < 0);
check("gov: history summary", govText.indexOf("Version history (2)") >= 0);
check("gov: history approve row", govText.indexOf("Approved - version 2. Version 2.") >= 0);
check("gov: history index row", govText.indexOf("2 sections ready") >= 0);
check("gov: history no raw action", govText.indexOf("gen2") < 0 && govText.indexOf("scope=") < 0);
check("gov: sections human", govText.indexOf("Saved sections (2)") >= 0 && govText.indexOf("Findings") >= 0 && govText.indexOf("Section 2") >= 0 && govText.indexOf("Solar arrays passed inspection.") >= 0);
check("gov: failure help fixed", govText.indexOf("pq:") < 0 && govText.indexOf("/var") < 0);
check("gov: recall kinds human", govText.indexOf("Board record") >= 0 && govText.indexOf("Meeting direction") >= 0);
check("gov: recall title kept", govText.indexOf("Evidence.txt v2") >= 0);
check("gov: recall generic provenance", govText.indexOf("Relevant material") >= 0);
check("gov: recall no score or ref", govText.indexOf("score") < 0 && govText.indexOf(" ref") < 0);
check("gov: upload scope human", govText.indexOf("Whole board") >= 0 && govText.indexOf("One meeting") >= 0);
check("gov: no raw json", govText.indexOf("{") < 0 && govText.indexOf("}") < 0);
check("gov: names human", govNames.indexOf("Upload scope") >= 0 && govNames.indexOf("Recall query") >= 0 && govNames.indexOf("Policy mode") >= 0);
check("gov: names clean", govNames.every((n) => !shownHasGuid(n)));
check("gov: action controls mounted", govText.indexOf("Approve") >= 0 && govText.indexOf("Reindex") >= 0 && govText.indexOf("Download original") >= 0 && govText.indexOf("History") >= 0 && govText.indexOf("Sections") >= 0);
// Authored connector fixture. Raw sync failures and rule patterns go in;
// readable sync state and plain rule labels must come out.
const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
const oneHourAhead = new Date(Date.now() + 3600 * 1000).toISOString();
const wikiItems: WikiResourceDto[] = [
  {
    id: "77777777-2222-3333-4444-555555555555", boardId: "b1", scope: "board", meetingId: null,
    baseUrl: "https://wiki.example.com", description: "Team handbook", allowedUse: "Handbook lookup for board discussion only",
    setupUse: false, manualOnly: false, allowlist: ["/guides/**", "/runbooks/**"], exclusions: ["/guides/draft-**"],
    requiredTags: ["handbook"], locale: "en", enabled: true, configRevision: 3, attemptGeneration: 2, attemptStatus: "running",
    syncIntervalMinutes: 60, nextSyncAt: oneHourAhead, status: "failed", lastError: "pq: password authentication failed at /var/lib/wiki segments",
    lastCompletedAt: null, lastSuccessRevision: 1, lastSuccessAt: null, usablePages: 0, importedPages: 5, sourceDocs: 5,
    eligibleDocs: 1, hasCredential: false, protocol: "wikijs-2.x-graphql-readonly", createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-05T12:00:00.000Z",
  },
  {
    id: "88888888-2222-3333-4444-555555555555", boardId: "b1", scope: "meeting", meetingId: "11111111-2222-3333-4444-555555555555",
    baseUrl: "https://wiki.example.com", description: "", allowedUse: "Runbook sync for hiring reviews",
    setupUse: true, manualOnly: true, allowlist: ["/hiring/**"], exclusions: [],
    requiredTags: [], locale: "", enabled: true, configRevision: 1, attemptGeneration: 1, attemptStatus: "idle",
    syncIntervalMinutes: 30, nextSyncAt: null, status: "succeeded", lastError: "",
    lastCompletedAt: twoHoursAgo, lastSuccessRevision: 1, lastSuccessAt: twoHoursAgo, usablePages: 2, importedPages: 2, sourceDocs: 2,
    eligibleDocs: 2, hasCredential: true, protocol: "wikijs-2.x-graphql-readonly", createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-05T12:00:00.000Z",
  },
];

const wikiHtml = renderToString(<WikiResources boardId="b1" meetingId="11111111-2222-3333-4444-555555555555" meetings={meetings} api={wikiApi} fixture={{ items: wikiItems }} />);
const wikiText = visible(wikiHtml);
const wikiNames = namesOf(wikiHtml);
check("wiki: titles human", wikiText.indexOf("Team handbook") >= 0 && wikiText.indexOf("https://wiki.example.com") >= 0);
check("wiki: meeting title shown", wikiText.indexOf("Quarterly Planning") >= 0);
check("wiki: no meeting id shown", !shownHasGuid(wikiText));
check("wiki: sync states human", wikiText.indexOf("Sync: Last sync did not finish") >= 0 && wikiText.indexOf("Sync: Synced") >= 0);
check("wiki: attempt human", wikiText.indexOf("Sync running...") >= 0 && wikiText.indexOf("Idle") >= 0);
check("wiki: revision + credential human", wikiText.indexOf("Revision 3") >= 0 && wikiText.indexOf("No credential") >= 0 && wikiText.indexOf("Credential saved") >= 0);
check("wiki: counts human", wikiText.indexOf("Usable pages: 0") >= 0 && wikiText.indexOf("Eligible pages: 1 of 5") >= 0 && wikiText.indexOf("Usable pages: 2") >= 0);
const badRaw = ["rev 3", "sync:failed", "sync:disabled", "sync:pending", "sync:succeeded", "attempt:", "configRevision"].filter((k) => wikiText.indexOf(k) >= 0);
check("wiki: no raw states", badRaw.length === 0, badRaw.map((k) => k + " at " + wikiText.indexOf(k) + ": " + wikiText.slice(Math.max(0, wikiText.indexOf(k) - 60), wikiText.indexOf(k) + 60)).join(" ;; "));
check("wiki: rules plain labels", wikiText.indexOf("Allowed paths:") >= 0 && wikiText.indexOf("Excluded paths:") >= 0 && wikiText.indexOf("Required tags:") >= 0 && wikiText.indexOf("Language:") >= 0 && wikiText.indexOf("Purpose:") >= 0);
check("wiki: rule patterns kept", wikiText.indexOf("/guides/**") >= 0 && wikiText.indexOf("/runbooks/**") >= 0 && wikiText.indexOf("/guides/draft-**") >= 0);
check("wiki: old rule labels gone", wikiText.indexOf("Allow:") < 0 && wikiText.indexOf("Exclude:") < 0 && wikiText.indexOf("Locale:") < 0 && wikiText.indexOf("Tags:") < 0);
check("wiki: run times human", wikiText.indexOf("Next sync:") >= 0 && wikiText.indexOf("Last finished:") >= 0 && wikiText.indexOf("2 hours ago") >= 0 && wikiText.indexOf("(never)") < 0 && wikiText.indexOf("(due now") < 0);
check("wiki: failure help fixed", wikiText.indexOf("sync again") >= 0 && wikiText.indexOf("pq:") < 0 && wikiText.indexOf("/var") < 0 && wikiText.indexOf("password authentication") < 0);
check("wiki: form fields readable", wikiHtml.indexOf("rows=\"3\"") >= 0 && wikiHtml.indexOf("rows=\"4\"") >= 0 && wikiHtml.indexOf("type=\"password\"") >= 0);
check("wiki: scope labels human", wikiText.indexOf("Whole board") >= 0 && wikiText.indexOf("One meeting") >= 0);
check("wiki: names unique + human", wikiNames.indexOf("Enable connector Team handbook (board)") >= 0 && wikiNames.indexOf("Disable connector https://wiki.example.com (meeting Quarterly Planning)") >= 0);
check("wiki: names clean + unique", wikiNames.every((n) => !shownHasGuid(n)) && new Set(wikiNames).size === wikiNames.length);
check("wiki: ids retained for actions", wikiHtml.indexOf("data-resource-id=\"77777777-2222-3333-4444-555555555555\"") >= 0 && wikiHtml.indexOf("data-resource-id=\"88888888-2222-3333-4444-555555555555\"") >= 0);
check("wiki: no raw json", wikiText.indexOf("{") < 0 && wikiText.indexOf("}") < 0);

console.log("source-wiki-human checks passed: " + passed);
