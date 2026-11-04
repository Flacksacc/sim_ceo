import { renderToString } from "react-dom/server";
import { actionLabel, contextSummary, currentLabel, friendlyAttempt, friendlySyncState, historyText, indexLabel, meetingTitle, originLabel, promotedGroupLabel, promotedLabel, recallExcerpt, recallKindLabel, recallTitle, relativeTime, resourceLabel, reviewLabel, safeIndexHelp, safeRequestMessage, safeRowHelp, safeSyncHelp, scopeLabel, sourceActionLabel, usableLabel, visibilityLabel, wikiScopeLabel } from "./src/human-source-format";
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
check("helper: origin inline human", originLabel("inline") === "Added inline in a meeting");
check("helper: origin unknown fail-closed", originLabel("sftp-drop") === "Added manually");
// Approval and visibility stay independent: exclusion never rewrites approval.
check("helper: review approved stays under exclusion", reviewLabel("approved", true).label === "Approved");
check("helper: review rejected stays under exclusion", reviewLabel("rejected", true).label === "Not kept");
check("helper: review pending stays under exclusion", reviewLabel("pending", true).label === "Waiting for review");
check("helper: visibility hidden", visibilityLabel(true).label === "Temporarily hidden");
check("helper: visibility shown", visibilityLabel(false).label === "Visible");
check("helper: promoted head", promotedLabel(true) === "Promoted version" && promotedLabel(false) === null);
check("helper: usable current", usableLabel(true) === "Usable now" && usableLabel(false) === null);
check("helper: current usable copy", currentLabel(true, 2) === "Usable now: version 2.");
check("helper: current none copy", currentLabel(false).indexOf("never fall back") >= 0 && currentLabel(false).toLowerCase().indexOf("usable version") >= 0);
check("helper: promoted group copy", promotedGroupLabel(2) === "Promoted: version 2." && promotedGroupLabel(null) === null);
check("helper: index ready", indexLabel("completed", true) === "Ready for meetings");
check("helper: index failed", indexLabel("failed", false) === "Search unavailable for now");
check("helper: index help fixed", safeIndexHelp().indexOf("re-upload") >= 0 && !shownHasGuid(safeIndexHelp()));
check("helper: action label", actionLabel("Enable connector", "Team handbook (board)") === "Enable connector Team handbook (board)");
check("helper: resource label", resourceLabel("Team handbook", "https://wiki.example.com", "board", null) === "Team handbook (board)");
check("helper: resource label meeting", resourceLabel("", "https://wiki.example.com", "meeting", "Quarterly Planning") === "https://wiki.example.com (meeting Quarterly Planning)");
const dupA = "Team handbook for onboarding new engineers across every department and region north-A";
const dupB = "Team handbook for onboarding new engineers across every department and region north-B";
check("helper: duplicate descriptions stay unique", resourceLabel(dupA, "https://wiki.example.com", "board", null, 1, 2) !== resourceLabel(dupB, "https://wiki.example.com", "board", null, 2, 2));
check("helper: ordinals carried", resourceLabel(dupA, "https://wiki.example.com", "board", null, 1, 2).indexOf("1 of 2") >= 0 && resourceLabel(dupB, "https://wiki.example.com", "board", null, 2, 2).indexOf("2 of 2") >= 0);
check("helper: source action unique", sourceActionLabel("Approve", "Evidence.txt", 2, 1, 3) !== sourceActionLabel("Approve", "Evidence.txt", 2, 2, 3));
check("helper: actual permission exact maps to access", safeRequestMessage("Access revoked or not granted for this scope.") === "You do not have access to do that. Ask a board manager for access.");
check("helper: actual permission 403 envelope keeps access", safeRequestMessage("403 {\"error\":\"Access revoked or not granted for this scope.\"}") === "You do not have access to do that. Ask a board manager for access.");
check("helper: actual permission 403 plain keeps access", safeRequestMessage("403 Access revoked or not granted for this scope.") === "You do not have access to do that. Ask a board manager for access.");
check("helper: actual permission no keyword echo", safeRequestMessage("Access revoked or not granted for this scope.").indexOf("revoked") < 0 && safeRequestMessage("Access revoked or not granted for this scope.").indexOf("scope.") < 0);
check("helper: quoted credential string unwrapped", safeRequestMessage("400 \"Token is malformed.\"") === "That credential does not look complete. Check it and try again.");
check("helper: quoted envelope credential unwrapped", safeRequestMessage("400 {\"error\":\"Token is malformed.\"}") === "That credential does not look complete. Check it and try again.");
check("helper: quoted arbitrary stays generic", safeRequestMessage("400 \"/guides/runbook\"") === "That did not finish. Try again. If it keeps failing, ask a board manager." && safeRequestMessage("400 \"/guides/runbook\"").indexOf("/guides") < 0);
check("helper: quoted truncated stays generic", safeRequestMessage("400 \"Token is mal") === "That did not finish. Try again. If it keeps failing, ask a board manager.");
check("helper: row actual permission keeps access", safeRowHelp("/enable", "403 Access revoked or not granted for this scope.") === "You do not have access to do that. Ask a board manager for access.");
check("helper: row quoted credential keeps guidance", safeRowHelp("/enable", "400 \"Token is malformed.\"") === "That credential does not look complete. Check it and try again.");
check("helper: source action cross-family unique", sourceActionLabel("Approve", "Evidence.txt", 1, 1, 1, "Board file", 1, 2) !== sourceActionLabel("Approve", "Evidence.txt", 1, 1, 1, "Meeting file - Quarterly Planning", 2, 2));
check("helper: source action scope family carried", sourceActionLabel("Approve", "Evidence.txt", 1, 1, 1, "Board file", 1, 2).indexOf("Board file") >= 0 && sourceActionLabel("Approve", "Evidence.txt", 1, 1, 1, "Board file", 1, 2).indexOf("family 1 of 2") >= 0 && sourceActionLabel("Approve", "Evidence.txt", 1, 1, 1, "Meeting file - Quarterly Planning", 2, 2).indexOf("Quarterly Planning") >= 0);
check("helper: source action no guid", !shownHasGuid(sourceActionLabel("Approve", "Evidence.txt", 1, 1, 1, "Board file", 1, 2)));
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
const hCreateBoard = historyText("create", "scope=board");
check("helper: history create board", hCreateBoard.headline === "Added" && hCreateBoard.detail === "Board file.");
const hCreateInline = historyText("create", "inline scope=meeting");
check("helper: history create inline meeting", hCreateInline.headline === "Added" && hCreateInline.detail === "Meeting file.");
const hWikiImport = historyText("wiki-import", "rev3 Handbook");
check("helper: history wiki-import", hWikiImport.headline === "Wiki pages added" && hWikiImport.detail === "Handbook synced.");
const hWikiImportPath = historyText("wiki-import", "rev3 /guides/runbook");
check("helper: history wiki-import path fail-closed", hWikiImportPath.detail === "Wiki pages synced." && hWikiImportPath.detail.indexOf("/guides") < 0);
const hWikiRepair = historyText("wiki-index-repair", "rev3");
check("helper: history wiki-index-repair", hWikiRepair.headline === "Search repaired" && hWikiRepair.detail === "Search index repaired." && hWikiRepair.detail.indexOf("rev3") < 0);
const hPolicy = historyText("policy", "wikiOnly|exe, zip");
check("helper: history policy", hPolicy.headline === "Policy updated" && hPolicy.detail.indexOf("Only Wiki connector material") >= 0 && hPolicy.detail.indexOf("exe, zip") >= 0 && hPolicy.detail.indexOf("wikiOnly|") < 0);
const hMigrate = historyText("migrate-version", "v1->v3");
check("helper: history migrate", hMigrate.headline === "Version numbering repaired" && hMigrate.detail.indexOf("history") >= 0);
const hWeird = historyText("weird-action", "some {json} blob /etc/passwd 11111111-2222-3333-4444-555555555555");
check("helper: history unknown fail-closed", hWeird.detail === "No extra detail." && !shownHasGuid(visible(hWeird.detail)) && hWeird.detail.indexOf("{") < 0);
const hFail = historyText("index-failed", "pq: syntax error at /var/lib/data with id 11111111-2222-3333-4444-555555555555");
check("helper: history failure hides backend", hFail.headline === "Search could not finish" && !shownHasGuid(hFail.detail) && hFail.detail.indexOf("/var") < 0 && hFail.detail.indexOf("pq:") < 0);
check("helper: recall source kind", recallKindLabel("source") === "Source");
check("helper: recall record kind", recallKindLabel("record") === "Board record");
check("helper: recall direction kind", recallKindLabel("direction") === "Meeting direction");
check("helper: recall title kept", recallTitle("source", "Evidence.txt v2") === "Evidence.txt v2");
check("helper: recall guid hidden", recallTitle("record", "55555555-2222-3333-4444-555555555555#aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") === null);
check("helper: recall record never titled", recallTitle("record", "Minutes v2") === null && recallTitle("direction", "66666666-2222-3333-4444-555555555555") === null);
check("helper: recall path hidden", recallTitle("source", "/guides/runbook") === null && recallTitle("source", "C:\\wiki\\runbook") === null);
check("helper: recall partial id hidden", recallTitle("source", "rev3 scope=board") === null && recallTitle("source", "11111111-2222") === null);
check("helper: recall record prefix stripped", recallExcerpt("record", "[aaaaaaaa-1111-2222-3333-444444444444] record v3: Approve the hiring plan.") === "Approve the hiring plan.");
check("helper: recall excerpt source kept", recallExcerpt("source", "Solar arrays passed inspection.") === "Solar arrays passed inspection.");
check("helper: recall excerpt backend fail-closed", recallExcerpt("record", "pq: password failure {\"error\":1}").indexOf("pq:") < 0 && recallExcerpt("record", "pq: password failure {\"error\":1}").indexOf("{") < 0);
check("helper: request validation mapped not echoed", safeRequestMessage("Description is required before enable; set it now.") === "Set a description before enabling, then enable again.");
check("helper: request extension fix copy", safeRequestMessage("Blocked type '.exe' is not a plain extension.").indexOf("plain extension") >= 0 && safeRequestMessage("Blocked type '.exe' is not a plain extension.").indexOf(".exe") < 0);
check("helper: request blocked type", safeRequestMessage("Source type '.zip' is blocked on this board.").indexOf("blocked on this board") >= 0);
check("helper: request disabled enable-first", safeRequestMessage("Resource is disabled; enable it first.").indexOf("enable it first") >= 0);
check("helper: request credential", safeRequestMessage("Configure a credential before enabling.").indexOf("credential") >= 0);
check("helper: request allowlist", safeRequestMessage("Set a non-empty path allowlist before enabling; blank allowlist denies all.").indexOf("blank allowlist denies everything") >= 0);
check("helper: request rule echo refused", safeRequestMessage("Rule pattern '/guides/**' is invalid.").indexOf("/guides") < 0 && safeRequestMessage("Rule pattern '/guides/**' is invalid.").indexOf("rules needs fixing") >= 0);
check("helper: request denied access", safeRequestMessage("403 {\"error\":\"Access denied for this scope.\"}").indexOf("do not have access") >= 0);
check("helper: request conflict human", safeRequestMessage("Error: 409 conflict") === "That change conflicts with a newer update. Refresh and try again.");
check("helper: request truncated json fail-closed", safeRequestMessage("400 {\"error\":\"Description is required") === "That did not finish. Try again. If it keeps failing, ask a board manager.");
check("helper: request strips json", safeRequestMessage("400 {error: bad}") !== "400 {error: bad}" && safeRequestMessage("400 {error: bad}").indexOf("{") < 0);
check("helper: request meeting scope", safeRequestMessage("meetingId is required for meeting scope").indexOf("Pick a meeting") >= 0);
check("helper: request guid hidden", !shownHasGuid(safeRequestMessage("deny 11111111-2222-3333-4444-555555555555")));
check("helper: request unknown generic", safeRequestMessage("frobnicate the widget") === "That did not finish. Try again. If it keeps failing, ask a board manager.");
check("helper: row denied keeps access", safeRowHelp("/enable", "403 Access denied").indexOf("do not have access") >= 0);
check("helper: row disabled keeps enable-first", safeRowHelp("/sync", "Error: Resource is disabled; enable it first.").indexOf("enable it first") >= 0);
check("helper: row enable fallback", safeRowHelp("/enable").indexOf("Could not enable") >= 0);
check("helper: row sync fallback", safeRowHelp("/sync").indexOf("Sync did not finish") >= 0);
check("helper: sync failed", friendlySyncState("failed", true) === "Last sync did not finish");
check("helper: sync synced", friendlySyncState("succeeded", true) === "Synced");
check("helper: sync disabled", friendlySyncState("succeeded", false) === "Disabled");
check("helper: attempt running", friendlyAttempt("running") === "Sync running...");
check("helper: attempt idle", friendlyAttempt("idle") === "Idle");
check("helper: sync help fixed", safeSyncHelp().indexOf("sync again") >= 0);
check("helper: relative just now", relativeTime(new Date().toISOString()) === "just now");
check("helper: relative hours", (relativeTime(new Date(Date.now() - 2 * 3600 * 1000).toISOString()) ?? "").indexOf("2 hours ago") >= 0);
check("helper: relative bad", relativeTime("not-a-date") === null && relativeTime(null) === null);
// Governance fixture mirrors server invariants: the usable current version
// is the promoted head (current implies head), uploads do not run under a
// wiki-only policy, and recall carries the real server record-text contract.
const govFixture = {
  groups: [
    {
      familyKey: "fk-evidence", fileName: "Evidence.txt", scope: "board", meetingId: null,
      origin: "wiki", currentId: "33333333-2222-3333-4444-555555555555", hasCurrent: true,
      versions: [
        { id: "99999999-2222-3333-4444-555555555555", boardId: "b1", fileName: "Evidence.txt", contentHash: "cc3", version: 3, approved: false, excluded: false, reviewState: "pending", origin: "wiki", familyKey: "fk-evidence", indexState: "queued", indexGeneration: 0, indexError: "", sectionCount: 0, isHead: false, isCurrent: false, currentId: "33333333-2222-3333-4444-555555555555", scope: "board", meetingId: null, createdAt: "2026-10-03T12:00:00.000Z" },
        { id: "33333333-2222-3333-4444-555555555555", boardId: "b1", fileName: "Evidence.txt", contentHash: "cc2", version: 2, approved: true, excluded: false, reviewState: "approved", origin: "wiki", familyKey: "fk-evidence", indexState: "completed", indexGeneration: 2, indexError: "", indexCompletedAt: "2026-10-02T12:00:00.000Z", sectionCount: 2, isHead: true, isCurrent: true, currentId: "33333333-2222-3333-4444-555555555555", scope: "board", meetingId: null, createdAt: "2026-10-02T12:00:00.000Z" },
        { id: "44444444-2222-3333-4444-555555555555", boardId: "b1", fileName: "Evidence.txt", contentHash: "cc1", version: 1, approved: false, excluded: false, reviewState: "rejected", origin: "wiki", familyKey: "fk-evidence", indexState: "failed", indexGeneration: 1, indexError: "pq: could not read /var/lib/data segment", sectionCount: 0, isHead: false, isCurrent: false, currentId: "33333333-2222-3333-4444-555555555555", scope: "board", meetingId: null, createdAt: "2026-10-01T12:00:00.000Z" },
      ],
    },
    {
      familyKey: "fk-minutes", fileName: "Minutes.txt", scope: "meeting", meetingId: "11111111-2222-3333-4444-555555555555",
      origin: "wiki", currentId: null, hasCurrent: false,
      versions: [
        { id: "55555555-2222-3333-4444-555555555555", boardId: "b1", fileName: "Minutes.txt", contentHash: "dd1", version: 1, approved: false, excluded: true, reviewState: "pending", origin: "wiki", familyKey: "fk-minutes", indexState: "queued", indexGeneration: 0, indexError: "", sectionCount: 0, isHead: true, isCurrent: false, currentId: null, scope: "meeting", meetingId: "11111111-2222-3333-4444-555555555555", createdAt: "2026-10-04T12:00:00.000Z" },
      ],
    },
    {
      familyKey: "fk-policy", fileName: "Policy.txt", scope: "board", meetingId: null,
      origin: "wiki", currentId: null, hasCurrent: false,
      versions: [
        { id: "aaaaaaaa-2222-3333-4444-555555555555", boardId: "b1", fileName: "Policy.txt", contentHash: "ee2", version: 2, approved: true, excluded: true, reviewState: "approved", origin: "wiki", familyKey: "fk-policy", indexState: "completed", indexGeneration: 1, indexError: "", sectionCount: 1, isHead: true, isCurrent: false, currentId: null, scope: "board", meetingId: null, createdAt: "2026-10-05T12:00:00.000Z" },
        { id: "bbbbbbbb-2222-3333-4444-555555555555", boardId: "b1", fileName: "Policy.txt", contentHash: "ee1", version: 1, approved: false, excluded: false, reviewState: "rejected", origin: "wiki", familyKey: "fk-policy", indexState: "failed", indexGeneration: 1, indexError: "pq: segment gone", sectionCount: 0, isHead: false, isCurrent: false, currentId: null, scope: "board", meetingId: null, createdAt: "2026-10-01T12:00:00.000Z" },
      ],
    },
  ],
  policy: { blockedTypes: "exe, zip", mode: "wikiOnly" },
  ctx: { total: 4, approved: 2, pending: 1, rejected: 1, excluded: 1, indexed: 3, indexFailed: 1, policy: "wikiOnly", extraction: "local deterministic sections; no vector index", hindsight: "PostgreSQL remains authoritative" },
  recallHits: [
    { kind: "source", ref: "Evidence.txt v2", text: "Solar arrays passed inspection.", score: 9 },
    { kind: "record", ref: "aaaaaaaa-2222-3333-4444-555555555555#bbbbbbbb-cccc-dddd-eeee-ffffffffffff", text: "[bbbbbbbb-cccc-dddd-eeee-ffffffffffff] record v3: Approve the hiring plan.", score: 7 },
    { kind: "direction", ref: "66666666-2222-3333-4444-555555555555", text: "Focus on onboarding.", score: 6 },
    { kind: "source", ref: "/guides/runbook", text: "Runbook body.", score: 5 },
  ],
  hist: {
    "33333333-2222-3333-4444-555555555555": [
      { id: "h1", action: "approve", detail: "v2", createdAt: "2026-10-02T13:00:00.000Z", version: 2 },
      { id: "h2", action: "index", detail: "gen2 sections2", createdAt: "2026-10-02T12:30:00.000Z", version: 2 },
      { id: "h2b", action: "wiki-index-repair", detail: "rev2", createdAt: "2026-10-02T12:35:00.000Z", version: 2 },
    ],
    "44444444-2222-3333-4444-555555555555": [
      { id: "h0", action: "wiki-import", detail: "rev1 Evidence.txt", createdAt: "2026-10-01T11:00:00.000Z", version: 1 },
      { id: "h0b", action: "reject", detail: "v1", createdAt: "2026-10-01T12:00:00.000Z", version: 1 },
    ],
    "99999999-2222-3333-4444-555555555555": [
      { id: "h3", action: "upload", detail: "scope=board", createdAt: "2026-10-03T12:00:00.000Z", version: 3 },
    ],
    "55555555-2222-3333-4444-555555555555": [
      { id: "h4", action: "exclude", detail: "v1", createdAt: "2026-10-04T13:00:00.000Z", version: 1 },
    ],
    "aaaaaaaa-2222-3333-4444-555555555555": [
      { id: "h5", action: "policy", detail: "wikiOnly|exe, zip", createdAt: "2026-10-05T13:00:00.000Z", version: 2 },
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
check("gov: approval badges stay independent", govText.indexOf("Waiting for review") >= 0 && govText.indexOf("Approved") >= 0 && govText.indexOf("Not kept") >= 0 && govText.indexOf("Temporarily hidden") >= 0 && govText.indexOf("Visible") >= 0);
check("gov: current usable copy", govText.indexOf("Usable now: version 2.") >= 0 && govText.indexOf("never fall back") >= 0);
check("gov: promoted head copy", govText.indexOf("Promoted: version 2.") >= 0 && govText.indexOf("Promoted: version 1.") >= 0 && govText.indexOf("Promoted version") >= 0);
check("gov: no current copy for hidden", govText.indexOf("No usable version") >= 0);
check("gov: index badges human", govText.indexOf("Ready for meetings") >= 0 && govText.indexOf("Search unavailable for now") >= 0);
check("gov: no index internals", govText.indexOf("index:") < 0 && govText.indexOf(" g1") < 0 && govText.indexOf("g2") < 0 && govText.indexOf("sec-") < 0);
check("gov: scope + origin human", govText.indexOf("Board file") >= 0 && govText.indexOf("Meeting file - Quarterly Planning") >= 0 && govText.indexOf("Added by upload") < 0 && govText.indexOf("Added from Wiki connector") >= 0);
check("gov: context summary human", govText.indexOf("4 files") >= 0 && govText.indexOf("2 ready for meetings") >= 0 && govText.indexOf("Wiki connector only") >= 0 && govText.indexOf("vector") < 0);
check("gov: summary counts human", govText.indexOf("1 waiting for review") >= 0 && govText.indexOf("2 not kept") >= 0 && govText.indexOf("2 need attention") >= 0);
check("gov: policy human", govText.indexOf("Wiki connector only") >= 0 && govText.indexOf("exe, zip") >= 0 && govText.indexOf("wikiOnly") < 0 && govText.indexOf("allowAll") < 0);
check("gov: history summary", govText.indexOf("Version history (3)") >= 0);
check("gov: history approve row", govText.indexOf("Approved - version 2. Version 2.") >= 0);
check("gov: history index row", govText.indexOf("2 sections ready") >= 0);
check("gov: history wiki-import row", govText.indexOf("Wiki pages added - version 1. Evidence.txt synced.") >= 0);
check("gov: history wiki-index-repair row", govText.indexOf("Search repaired - version 2. Search index repaired.") >= 0 && govText.indexOf("rev2") < 0);
check("gov: history policy row", govText.indexOf("Policy updated - version 2. Only Wiki connector material is accepted.") >= 0 && govText.indexOf("wikiOnly|") < 0);
check("gov: history no raw action", govText.indexOf("gen2") < 0 && govText.indexOf("scope=") < 0 && govText.indexOf("rev3") < 0 && govText.indexOf("rev1") < 0);
check("gov: sections human", govText.indexOf("Saved sections (2)") >= 0 && govText.indexOf("Findings") >= 0 && govText.indexOf("Section 2") >= 0 && govText.indexOf("Solar arrays passed inspection.") >= 0);
check("gov: failure help fixed", govText.indexOf("pq:") < 0 && govText.indexOf("/var") < 0);
check("gov: recall kinds human", govText.indexOf("Board record") >= 0 && govText.indexOf("Meeting direction") >= 0);
check("gov: recall server text cleaned", govText.indexOf("Approve the hiring plan.") >= 0 && govText.indexOf("record v3") < 0 && govText.indexOf("[") < 0);
check("gov: recall path ref generic", govText.indexOf("Runbook body.") >= 0 && govText.indexOf("/guides/runbook") < 0);
check("gov: recall title kept", govText.indexOf("Evidence.txt v2") >= 0);
check("gov: recall generic provenance", govText.indexOf("Relevant material") >= 0);
check("gov: recall no score or ref", govText.indexOf("score") < 0 && govText.indexOf(" ref") < 0);
check("gov: upload scope human", govText.indexOf("Whole board") >= 0 && govText.indexOf("One meeting") >= 0);
check("gov: no raw json", govText.indexOf("{") < 0 && govText.indexOf("}") < 0);
check("gov: names human", govNames.indexOf("Upload scope") >= 0 && govNames.indexOf("Recall query") >= 0 && govNames.indexOf("Policy mode") >= 0);
check("gov: source actions unique scoped family", govNames.indexOf("Approve Evidence.txt version 2 Board file (family 1 of 3, version 2 of 3)") >= 0 && govNames.indexOf("Approve Minutes.txt version 1 Meeting file - Quarterly Planning (family 2 of 3, version 1 of 1)") >= 0 && new Set(govNames).size === govNames.length);
check("gov: source actions carry scope family", govNames.some((n) => n.indexOf("Board file") >= 0 && n.indexOf("family 1 of 3") >= 0) && govNames.some((n) => n.indexOf("Quarterly Planning") >= 0 && n.indexOf("family 2 of 3") >= 0));
const dupGroups = [
  {
    familyKey: "fk-dup-board", fileName: "Evidence.txt", scope: "board", meetingId: null,
    origin: "wiki", currentId: null, hasCurrent: false,
    versions: [
      { id: "11111111-aaaa-4444-5555-555555555555", boardId: "b1", fileName: "Evidence.txt", contentHash: "dup1", version: 1, approved: false, excluded: false, reviewState: "pending", origin: "wiki", familyKey: "fk-dup-board", indexState: "queued", indexGeneration: 0, indexError: "", sectionCount: 0, isHead: true, isCurrent: false, currentId: null, scope: "board", meetingId: null, createdAt: "2026-10-06T12:00:00.000Z" },
    ],
  },
  {
    familyKey: "fk-dup-meeting", fileName: "Evidence.txt", scope: "meeting", meetingId: "11111111-2222-3333-4444-555555555555",
    origin: "wiki", currentId: null, hasCurrent: false,
    versions: [
      { id: "22222222-bbbb-4444-5555-555555555555", boardId: "b1", fileName: "Evidence.txt", contentHash: "dup2", version: 1, approved: false, excluded: false, reviewState: "pending", origin: "wiki", familyKey: "fk-dup-meeting", indexState: "queued", indexGeneration: 0, indexError: "", sectionCount: 0, isHead: true, isCurrent: false, currentId: null, scope: "meeting", meetingId: "11111111-2222-3333-4444-555555555555", createdAt: "2026-10-06T12:00:00.000Z" },
    ],
  },
];
const dupHtml = renderToString(<SourcesGovernance boardId="b1" meetingId="11111111-2222-3333-4444-555555555555" meetings={meetings} actAs="owner" canManage transport={govTransport} fixture={{ groups: dupGroups }} />);
const dupNames = namesOf(dupHtml);
check("gov: duplicate families unique", dupNames.indexOf("Approve Evidence.txt version 1 Board file (family 1 of 2, version 1 of 1)") >= 0 && dupNames.indexOf("Approve Evidence.txt version 1 Meeting file - Quarterly Planning (family 2 of 2, version 1 of 1)") >= 0 && new Set(dupNames).size === dupNames.length);
check("gov: duplicate no guid transport kept", dupNames.every((n) => !shownHasGuid(n)) && dupHtml.indexOf("11111111-aaaa-4444-5555-555555555555") < 0 && visible(dupHtml).indexOf("11111111-aaaa") < 0);

check("gov: names clean", govNames.every((n) => !shownHasGuid(n)));
check("gov: action controls mounted", govText.indexOf("Approve") >= 0 && govText.indexOf("Reindex") >= 0 && govText.indexOf("Download original") >= 0 && govText.indexOf("History") >= 0 && govText.indexOf("Sections") >= 0);
// Connector fixture: two resources share an 80-character description prefix
// in the same scope, so only live-collection ordinals keep action names unique.
const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
const oneHourAhead = new Date(Date.now() + 3600 * 1000).toISOString();
const dupDescA = "Team handbook for onboarding new engineers across every department and region north-A";
const dupDescB = "Team handbook for onboarding new engineers across every department and region north-B";
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
  {
    id: "99999999-2222-3333-4444-555555555555", boardId: "b1", scope: "board", meetingId: null,
    baseUrl: "https://wiki.example.com", description: dupDescA, allowedUse: "North handbook overflow",
    setupUse: false, manualOnly: false, allowlist: ["/north/**"], exclusions: [],
    requiredTags: [], locale: "en", enabled: false, configRevision: 1, attemptGeneration: 1, attemptStatus: "idle",
    syncIntervalMinutes: 60, nextSyncAt: null, status: "disabled", lastError: "",
    lastCompletedAt: null, lastSuccessRevision: 0, lastSuccessAt: null, usablePages: 0, importedPages: 0, sourceDocs: 0,
    eligibleDocs: 0, hasCredential: false, protocol: "wikijs-2.x-graphql-readonly", createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-05T12:00:00.000Z",
  },
  {
    id: "aaaaaaaa-2222-3333-4444-555555555555", boardId: "b1", scope: "board", meetingId: null,
    baseUrl: "https://wiki.example.com", description: dupDescB, allowedUse: "North handbook overflow",
    setupUse: false, manualOnly: false, allowlist: ["/north/**"], exclusions: [],
    requiredTags: [], locale: "en", enabled: false, configRevision: 1, attemptGeneration: 1, attemptStatus: "idle",
    syncIntervalMinutes: 60, nextSyncAt: null, status: "disabled", lastError: "",
    lastCompletedAt: null, lastSuccessRevision: 0, lastSuccessAt: null, usablePages: 0, importedPages: 0, sourceDocs: 0,
    eligibleDocs: 0, hasCredential: false, protocol: "wikijs-2.x-graphql-readonly", createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-05T12:00:00.000Z",
  },
];

const wikiHtml = renderToString(<WikiResources boardId="b1" meetingId="11111111-2222-3333-4444-555555555555" meetings={meetings} api={wikiApi} fixture={{ items: wikiItems }} />);
const wikiText = visible(wikiHtml);
const wikiNames = namesOf(wikiHtml);
check("wiki: titles human", wikiText.indexOf("Team handbook") >= 0 && wikiText.indexOf("https://wiki.example.com") >= 0);
check("wiki: meeting title shown", wikiText.indexOf("Quarterly Planning") >= 0);
check("wiki: no meeting id shown", !shownHasGuid(wikiText));
check("wiki: no protocol internals", wikiText.indexOf("pages.list") < 0 && wikiText.indexOf("pages.single") < 0 && wikiText.indexOf("POST /graphql") < 0 && wikiText.indexOf("Bearer token") < 0);
check("wiki: read-only pending copy", wikiText.indexOf("review inbox as pending") >= 0 && wikiText.indexOf("until explicitly approved") >= 0);
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
check("wiki: form fields readable", wikiHtml.indexOf("rows=") >= 0 && wikiHtml.indexOf("type=") >= 0 && wikiHtml.indexOf("password") >= 0);
check("wiki: scope labels human", wikiText.indexOf("Whole board") >= 0 && wikiText.indexOf("One meeting") >= 0);
check("wiki: duplicate descriptions unique", wikiNames.indexOf("Enable connector " + dupDescA.slice(0, 80).trimEnd() + "... (board) - 3 of 4") >= 0 && wikiNames.indexOf("Enable connector " + dupDescB.slice(0, 80).trimEnd() + "... (board) - 4 of 4") >= 0);
check("wiki: names clean + unique", wikiNames.every((n) => !shownHasGuid(n)) && new Set(wikiNames).size === wikiNames.length);
check("wiki: ids retained for actions", wikiHtml.indexOf("data-resource-id=") >= 0 && wikiHtml.indexOf("77777777-2222-3333-4444-555555555555") >= 0 && wikiHtml.indexOf("88888888-2222-3333-4444-555555555555") >= 0);
check("wiki: no raw json", wikiText.indexOf("{") < 0 && wikiText.indexOf("}") < 0);

console.log("source-wiki-human checks passed: " + passed);
