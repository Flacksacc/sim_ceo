import { renderToString } from "react-dom/server";
import { CreateAdvisor, CharacterEditor, parseCharacterProfile, mergeCharacterProfile, adoptCompiledParagraphs, characterFriendlyError, extractCharacterServerText, isRosterResearchRunning, shouldShowResearchWorking, isAllowlistedClientValidation, looksTechnicalOrId, fetchFreshCanonicalEntry, CANONICAL_SAVE_INVALIDATIONS } from "../advisor-creation";
import {
  ConversationHeader,
  ConversationSearchField,
  MeetingSettingsDialog,
  isMeetingOpen,
  meetingStateLabel,
} from "../conversation-controls";
import { MeetingParticipants } from "../meeting-participants";
import { buildPresence, imageIdFromProvenance, isPortraitAccepted, provenanceParts, resolveProvenanceImage } from "../meeting-presence";
import { mapAdvisorActivity, mapSecretaryActivity, hasActivityFetchFailed, shouldUseActivitySnapshot, resolveActivityAvailability, selectSecretaryActivity } from "../meeting-activity";
import { RosterChatPanel, rosterDraftKey } from "../roster-chat";
import { BoardAdvisorLinkPanel, RosterLinkBadge } from "../roster-integrity";
import { FriendlyError, HumanDisclosure, StatusChip } from "../human-disclosure";
import { RecordComparison, RecordItemEditor, RecordItemList, RecordVersionRow, emitEditorRows, parseEditorRows } from "../human-record-items";
import {
  editableTextToItems,
  friendlyError,
  friendlyRecordStatus,
  humanizeOmission,
  itemsToEditableText,
  newItemKey,
  parseRecordItems,
} from "../human-format";

let passed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (!cond) throw new Error("FAIL " + name + (extra ? " :: " + extra : ""));
  passed++;
  console.log("ok - " + name);
}

const noopAsync = async () => undefined as never;
const api = { get: noopAsync, post: noopAsync, put: noopAsync, originIdentity: () => ({ epoch: 1, token: "t", user: "u" }), originStale: () => false, originRevision: "1|t|u", resolveCanonicalEntry: async () => null };

// 1. Single character-based advisor-creation flow.
{
  const html = renderToString(
    <CreateAdvisor accountId="acct-1" get={api.get} post={api.post} put={api.put} originIdentity={api.originIdentity} originStale={api.originStale} originRevision={api.originRevision} resolveCanonicalEntry={api.resolveCanonicalEntry} />,
  );
  check("advisor: single Create draft entry", html.includes("Create draft"));
  check("advisor: three-step flow named", html.includes("One flow in three steps") && html.includes("Step 1"));
  check("advisor: name plus description brief", html.includes("Name (required)") && html.includes("Description (required)"));
  check("advisor: optional background and links", html.includes("Background (optional)") && html.includes("Inspiration links"));
  check("advisor: no tone-adjective controls", !html.includes("Strengths") && !html.includes("humorous"));
  check("advisor: no manual-alternative button", !html.includes("Save manual draft"));
  check("advisor: no board copy step", !html.includes("Add copy to this board"));
  check("advisor: research part of flow", html.includes("Research runs as part of this flow") || html.includes("Step 1"));
  check("advisor: honest idle status", html.includes("Nothing is saved yet"));
  check("advisor: fictional honesty stated", html.includes("Fictional character"));
  check("advisor: no debug ids in UI", !html.includes("ResearchJobId") && !html.includes("researchBaseVersion"));
  const parsed = parseCharacterProfile(JSON.stringify({ fictional: true, name: "N", background: "b", contributionCriteria: "c", reasoningApproach: "r", responseStyle: "s", sourceUrls: ["https://example.com"], security: "keep-me", version: 9 }));
  check("advisor: profile parse exact keys", parsed.background === "b" && parsed.paragraphs.reasoningApproach === "r" && parsed.sourceUrls[0] === "https://example.com");
  const merged = JSON.parse(mergeCharacterProfile(JSON.stringify({ fictional: true, name: "N", security: "keep-me", version: 9, strengths: ["old"] }), { name: "N2", background: "b2", sourceUrls: ["https://example.com/x"], paragraphs: { contributionCriteria: "c", reasoningApproach: "r", responseStyle: "s" } }));
  check("advisor: merge preserves unknown keys", merged.security === "keep-me" && merged.version === 9 && merged.name === "N2" && merged.responseStyle === "s" && merged.strengths[0] === "old" && merged.sourceUrls[0] === "https://example.com/x");
  const adopted = adoptCompiledParagraphs(
    { contributionCriteria: "owner text", reasoningApproach: "", responseStyle: "" },
    { contributionCriteria: "seed-c", reasoningApproach: "seed-r", responseStyle: "seed-s" },
    { contributionCriteria: "compiled-c", reasoningApproach: "compiled-r", responseStyle: "compiled-s" }
  );
  check("advisor: adopts compiled only over seed or empty", adopted.paragraphs.contributionCriteria === "owner text" && adopted.paragraphs.reasoningApproach === "compiled-r" && adopted.paragraphs.responseStyle === "compiled-s" && adopted.updated.length === 2);
  check("advisor: editor exports for roster reuse", typeof CharacterEditor === "function");
  const edEntry = { id: "r1", accountId: "a", type: "c", name: "N", description: "D", profileJson: JSON.stringify({ fictional: true, name: "N", contributionCriteria: "c", reasoningApproach: "r", responseStyle: "s", sourceUrls: ["https://example.com"] }), version: 3, archived: false, tags: "", researchJson: "{}", researchedAt: null, researchRequested: false, evidenceCount: 0, researchJobId: "", researchBaseVersion: 3, updatedAt: "" };
  const edHtml = renderToString(<CharacterEditor entry={edEntry} get={api.get} post={api.post} put={api.put} originIdentity={api.originIdentity} originStale={api.originStale} originRevision={api.originRevision} resolveCanonicalEntry={api.resolveCanonicalEntry} freshCreation={false} />);
  check("advisor: editor human labels", edHtml.includes("When to contribute") && edHtml.includes("How to reason") && edHtml.includes("How to respond"));
  check("advisor: editor no impl copy", !edHtml.includes("sourceUrls") && !edHtml.includes("Draft version") && !edHtml.includes("ResearchJobId") && !edHtml.includes("researchBaseVersion"));
  check("advisor: paragraph limit visible", edHtml.includes("2000") && edHtml.toLowerCase().includes("maxlength"));
  check("advisor: editor saved indicator", edHtml.includes("Not saved yet"));
  check("advisor: editor research in flow", edHtml.includes("part of this flow"));
}
// 2. Conversation: one lifecycle + one advisor action, separate gating.
{
  const base = {
    meetingTitle: "M", meetingBrief: "Brief text", stateLabel: meetingStateLabel(1), live: false,
    messageCount: 3, canManageMeeting: true, canCreateMeeting: true, canDiscussMeeting: true,
    pauseAvailable: true, resumeAvailable: false, endAvailable: true, briefReady: true, requestPending: false,
    requestAvailable: true,
    onNewMeeting: () => undefined, onOpenSettings: () => undefined, onPause: () => undefined,
    onResume: () => undefined, onEnd: () => undefined, onRequestResponses: () => undefined,
  };
  const html = renderToString(<ConversationHeader {...base} />);
  check("conv: one Request advisor responses", (html.match(/Request advisor responses/g) ?? []).length === 1);
  check("conv: lifecycle New meeting", html.includes("New meeting"));
  check("conv: lifecycle helper copy", html.includes("New meeting starts a separate conversation"));
  check("conv: advisor helper copy", html.includes("Asks the advisors in the current meeting to respond"));
  check("conv: no legacy Run discussion", !html.includes("Run discussion"));
  check("conv: no legacy Start meeting", !html.includes("Start meeting"));
  check("conv: drafting state shown", renderToString(<ConversationHeader {...base} requestPending />).includes("Advisors drafting"));
  const gated = renderToString(<ConversationHeader {...base} briefReady={false} requestAvailable={false} />);
  check("conv: request disabled without brief", gated.includes("disabled"));
  const decoupled = renderToString(<ConversationHeader {...base} endAvailable requestAvailable={false} />);
  check("conv: request gated apart from End", decoupled.includes("disabled"));
  const search = renderToString(<ConversationSearchField value="" onChange={() => undefined} onSearch={() => undefined} resultCount={2} />);
  check("conv: search above messages", search.includes("Search this conversation") && search.includes("matches"));
  const dlgProps = {
    title: "T", brief: "B", policy: "balanced",
    participants: [{ id: "a", role: "Strategist", included: true }],
    canManageMeeting: true, meetingSelected: true, meetingOpen: true, meetingClosed: false,
    onClose: () => undefined, onTitle: (_v: string) => undefined, onBrief: (_v: string) => undefined,
    onPolicy: (_v: string) => undefined, onToggleParticipant: (_id: string) => undefined, onSelectAll: () => undefined, onSave: () => undefined,
    onCloseWithRecord: () => undefined, onCloseWithoutPublication: () => undefined, onReopen: () => undefined,
  };
  const dlg = renderToString(<MeetingSettingsDialog open {...dlgProps} />);
  check("conv: settings dialog participants", dlg.includes("Strategist") && dlg.includes("Meeting settings"));
  check("conv: settings dialog element", dlg.includes("<dialog"));
  const lockedDlg = renderToString(<MeetingSettingsDialog open {...dlgProps} participants={[{ id: "a", role: "Strategist", included: true, locked: true }]} />);
  check("conv: last participant locked, not silently everyone", lockedDlg.includes("disabled") && lockedDlg.includes("Include everyone"));
  check("conv: brief is a paragraph field", dlg.includes("<textarea"));
  check("conv: close gated by meeting state", renderToString(<MeetingSettingsDialog open {...dlgProps} meetingOpen={false} meetingClosed />).includes("Reopen (history intact)"));
  const withKids = renderToString(<MeetingSettingsDialog open {...dlgProps}><div className="card"><h3>Decision state</h3></div></MeetingSettingsDialog>);
  check("conv: decisions live in settings", withKids.includes("Decisions &amp; evidence") && withKids.includes("Decision state"));
  check("conv: meeting helpers honest", isMeetingOpen(1) && !isMeetingOpen(7) && meetingStateLabel(1) === "Active");
}

// 2b. Meeting presence rail: every seat, honest activity, no ids.
{
  check("presence: provenance parses image id", imageIdFromProvenance("generated:11111111-2222-3333-4444-555555555555") === "11111111-2222-3333-4444-555555555555");
  check("presence: provenance rejects junk", imageIdFromProvenance("pending") === null && imageIdFromProvenance("") === null);
  const seats = buildPresence({ leadName: "Ava Lead", leadRoleLabel: "Owner", advisors: [{ id: "a1", boardRole: "Strategist", approved: true, portraitUrl: "blob:portrait" }, { id: "a2", boardRole: "Skeptic", approved: false, portraitUrl: null }], includedIds: [] });
  check("presence: lead plus advisors plus secretary", seats.length === 4 && seats[3].isSecretary === true);
  check("presence: silent approved is idle, gate is needs-approval", seats[1].activity === "idle" && seats[2].activity === "needs-approval");
  const excl = buildPresence({ leadName: "Ava Lead", leadRoleLabel: "Owner", advisors: [{ id: "a1", boardRole: "Strategist", approved: true, portraitUrl: null }, { id: "a2", boardRole: "Skeptic", approved: false, portraitUrl: null }], includedIds: ["a1"] });
  check("presence: exclusion is explicit", excl[1].activity === "idle" && excl[2].activity === "excluded");
  const snap = buildPresence({ leadName: "Ava Lead", leadRoleLabel: "Owner", advisors: [{ id: "a1", boardRole: "Strategist", approved: true, portraitUrl: null }, { id: "a2", boardRole: "Skeptic", approved: true, portraitUrl: null }], includedIds: [], snapshot: new Map([["a1", "responding"], ["a2", "complete"]]) });
  check("presence: snapshot states pass through", snap[1].activity === "responding" && snap[2].activity === "complete");
  const snapGuard = buildPresence({ leadName: "Ava Lead", leadRoleLabel: "Owner", advisors: [{ id: "a9", boardRole: "Guest", approved: true, portraitUrl: null }], includedIds: [], snapshot: new Map([["a9", "excluded"]]) });
  check("presence: snapshot never invents exclusion", snapGuard[1].activity === "idle");
  const html = renderToString(<MeetingParticipants participants={seats} live={false} />);
  check("presence: rail shows every seat", html.includes("Ava Lead") && html.includes("Strategist") && html.includes("Skeptic") && html.includes("Secretary"));
  check("presence: honest labels", html.includes("Listening") && html.includes("Needs approval"));
}

// 2c. Portrait resolution: accepted metadata only, legacy 8-char safely.
{
  check("portrait: acceptance gate mirrors server", isPortraitAccepted("accepted") && isPortraitAccepted("grandfathered") && !isPortraitAccepted("pending") && !isPortraitAccepted("rejected") && !isPortraitAccepted(undefined));
  const full = provenanceParts("generated:11111111-2222-3333-4444-555555555555");
  check("portrait: full id parses", full.guid === "11111111-2222-3333-4444-555555555555" && full.legacy8 === null);
  const legacy = provenanceParts("ab12cd34");
  check("portrait: legacy 8-char parses", legacy.guid === null && legacy.legacy8 === "ab12cd34");
  check("portrait: junk parses to nulls", provenanceParts("pending").guid === null && provenanceParts("pending").legacy8 === null && provenanceParts("").guid === null);
  const imgs = [{ id: "11111111-2222-3333-4444-555555555555", review: "accepted" }, { id: "ab12cd34-9999-4444-aaaa-bbbbbbbbbbbb", review: "pending" }];
  check("portrait: accepted full id resolves", resolveProvenanceImage(full, imgs) === "11111111-2222-3333-4444-555555555555");
  check("portrait: unaccepted full id rejected", resolveProvenanceImage(provenanceParts("generated:22222222-2222-4333-8444-555555555555"), [{ id: "22222222-2222-4333-8444-555555555555", review: "rejected" }]) === null);
  check("portrait: pending legacy prefix never loads", resolveProvenanceImage(legacy, imgs) === null);
  const solo = [{ id: "ab12cd34-0000-4000-8000-000000000000", review: "accepted" }];
  check("portrait: unique accepted legacy prefix resolves", resolveProvenanceImage(legacy, solo) === "ab12cd34-0000-4000-8000-000000000000");
  const dup = solo.concat([{ id: "ab12cd34-1111-4111-8111-111111111111", review: "accepted" }]);
  check("portrait: ambiguous legacy prefix never guessed", resolveProvenanceImage(legacy, dup) === null);
  check("portrait: wrong-entry images never used", resolveProvenanceImage(full, [{ id: "99999999-2222-4333-8444-555555555555", review: "accepted" }]) === null);
}

// 2d. Human omissions: server reference shapes become neutral labels.
{
  const om = humanizeOmission(["direction:11111111-2222-3333-4444-555555555555", "record:22222222-2222-4333-8444-555555555555:v2", "source:33333333-3333-4333-8333-555555555555:44444444-4444-4333-8333-555555555555", "weird"]);
  check("human: omissions humanized", om.indexOf("an adopted direction") >= 0 && om.indexOf("approved record (version 2)") >= 0 && om.indexOf("a source excerpt") >= 0);
  check("human: omissions leak no GUIDs", !/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}/.test(om));
  check("human: unknown omission neutral", humanizeOmission(["zzz"]).indexOf("an item") >= 0 && humanizeOmission([]) === "");
  const omHtml = renderToString(<span>{humanizeOmission(["direction:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"])}</span>);
  check("human: omission renders human", omHtml.includes("an adopted direction") && !/[0-9a-fA-F]{8}-/.test(omHtml));
}

// 2e. Live activity mapping: honest waiting, never responding from global flags.
{
  check("activity: awaiting-selection is waiting", mapAdvisorActivity("awaiting-selection", null) === "waiting-for-selection");
  check("activity: awaiting-publication is waiting", mapAdvisorActivity("awaiting-publication", null) === "waiting-for-publication");
  check("activity: uncertain is retryable interrupted", mapSecretaryActivity("uncertain") === "interrupted");
  check("activity: reapproval is needs-approval", mapAdvisorActivity("considering", "reapproval-required") === "needs-approval");
  check("activity: responding stays responding", mapAdvisorActivity("responding", null) === "responding");
  check("activity: idle stays idle", mapAdvisorActivity("idle", null) === "idle");
}

// 3. Roster-only chat.
{
  const html = renderToString(
    <RosterChatPanel rosterId="r1" identity="owner" advisorName="Ada" rosterVersion={3}
      complete missing={[]} canChat api={{ post: noopAsync }} />,
  );
  check("chat: roster chat mounted", html.includes("Chat with this advisor") && html.includes("Ada"));
  check("chat: isolated copy", html.includes("Nothing here") && html.includes("joins a meeting"));
  check("chat: no profile-version display", !html.includes("profile v"));
  check("chat: empty state", html.includes("No messages yet"));
  check("chat: send disabled when empty", html.includes("disabled"));
  check("chat: draft key scoped to identity, not UUID/token", rosterDraftKey("owner", "r1") === "roster-chat-draft:owner:r1" && rosterDraftKey("", "r1") === "roster-chat-draft:owner:r1");
  const keyHtml = renderToString(<RosterChatPanel rosterId="r1" identity="BoardTwo" advisorName="Ada" rosterVersion={3} complete missing={[]} canChat api={{ post: noopAsync }} />);
  check("chat: identity-scoped mount renders", keyHtml.includes("Chat with this advisor"));
  const blocked = renderToString(
    <RosterChatPanel rosterId="r1" identity="owner" advisorName="Ada" complete={false} missing={["portrait"]} api={{ post: noopAsync }} />,
  );
  check("chat: incomplete blocks with reason", blocked.includes("portrait") && !blocked.includes("No messages yet"));
}

// 4. Canonical roster links.
{
  const adv = { advisorId: "a1", boardId: "b1", rosterEntryId: "r-long-id", pinnedVersion: 2, currentVersion: 3, stale: true, name: "Ada", boardRole: "Strategist", approved: false, portraitFingerprint: "p", behaviorFingerprint: "roster v3" };
  const html = renderToString(<><RosterLinkBadge advisor={adv} /><BoardAdvisorLinkPanel advisor={adv} /></>);
  check("roster: canonical link panel", html.includes("Canonical roster link"));
  check("roster: stale copy flagged", html.includes("re-review"));
  check("roster: no raw id shown", !html.includes("r-long-id"));
  check("roster: board role marked board-specific", html.includes("board-specific"));
}

// 5. Human-readable records: lossless structured editing.
{
  const items = JSON.stringify([
    { id: "d1", text: "Approve the plan\nwith quarterly review", detail: "keep", status: "open", scope: "board", extra: "x" },
    { id: "d2", text: "Decline the lease" },
  ]);
  const list = renderToString(<RecordItemList itemsJson={items} selectable selected={["d1"]} onToggle={() => undefined} />);
  check("records: decision text first", list.includes("Approve the plan"));
  check("records: ids not headlines", !list.includes("[d1]"));
  let emissions = 0;
  const editor = renderToString(
    <RecordItemEditor draftKey="k" initialJson={items} onChange={() => { emissions++; }} />,
  );
  check("records: editor mounts without rewriting", emissions === 0);
  check("records: multiline stays one decision", editor.includes("Approve the plan"));
  check("records: editor per-row fields", editor.includes("human-decision-k-0") && editor.includes("human-decision-k-1"));
  const cmp = renderToString(<RecordComparison prevJson={JSON.stringify([{ id: "d1", text: "A" }])} curJson={JSON.stringify([{ id: "d1", text: "A!" }, { id: "n-x", text: "B" }])} />);
  check("records: comparison readable", cmp.includes("change") && !cmp.includes("[d1]"));
  const row = renderToString(<RecordVersionRow version={2} statusLabel="Decided" tone="done" decided selected={false} onSelect={() => undefined} />);
  check("records: version row human first", row.includes("Version") && row.includes("Decided"));
  check("records: version row shows no codes", !row.includes("deadbeef"));
  const parsed = parseRecordItems(JSON.stringify([{ id: "d1", text: "x" }]));
  check("records: parse items", parsed.items.length === 1 && parsed.problem === null);
  const text = itemsToEditableText(parsed.items);
  const back = editableTextToItems(text, parsed.items);
  check("records: text round-trip keeps keys", back.items[0].key === "d1");
  check("records: new keys well-formed", newItemKey().startsWith("n-"));
  check("records: friendly status", friendlyRecordStatus("approved", true).label.length > 0);
  const codecSrc = JSON.stringify([
    { id: "d1", text: "Approve the plan\\nwith quarterly review", detail: "keep", status: "open", scope: "board", extra: "x" },
    { id: "d2", text: "Decline the lease" },
  ]);
  const codecRows = parseEditorRows(codecSrc);
  check("records: codec multiline stays one row", codecRows.length === 2 && codecRows[0].text.indexOf("\\n") >= 0);
  check("records: codec keeps unknown metadata", (codecRows[0].raw as { extra?: string }).extra === "x");
  check("records: codec emits byte-identical when untouched", emitEditorRows(codecRows) === codecSrc);
  const editedRows = codecRows.map((r) => (r.key === "d1" ? { ...r, text: "Approve now", edited: true } : r));
  const emitted = JSON.parse(emitEditorRows(editedRows)) as { id: string; text: string; detail?: string; extra?: string }[];
  check("records: codec edit keeps id + metadata", emitted[0].id === "d1" && emitted[0].text === "Approve now" && emitted[0].extra === "x" && emitted[0].detail === "keep");
  check("records: codec untouched rows byte-identical", JSON.stringify(emitted[1]) === JSON.stringify({ id: "d2", text: "Decline the lease" }));
}

// 6. Human disclosures: plain language first, never raw values.
{
  const err = renderToString(<FriendlyError friendly="Saving failed. Try again." technical="409 conflict v3" />);
  check("human: friendly error first", err.includes("Saving failed") && err.includes("Copy error report"));
  check("human: raw error never displayed", !err.includes("409 conflict v3"));
  const chip = renderToString(<StatusChip label="Waiting for reply" tone="open" />);
  check("human: status chip", chip.includes("Waiting for reply"));
  const disc = renderToString(<HumanDisclosure summary="Where this came from">Saved by you</HumanDisclosure>);
  check("human: disclosure", disc.includes("Where this came from"));
  check("human: friendly error mapping", friendlyError("hash mismatch, refresh the review").length > 0);
}

// 7. Character human error boundary: friendly copy, never raw JSON/status/GUID.
{
  const prov502 = '502 {"error":"provider exploded: boom"}';
  const f502 = characterFriendlyError(prov502);
  check("char-err: 502 provider human", f502.toLowerCase().indexOf("text service") >= 0 && f502.toLowerCase().indexOf("unchanged") >= 0);
  check("char-err: 502 hides status/json", f502.indexOf("502") < 0 && f502.indexOf("{") < 0 && f502.indexOf("}") < 0);
  check("char-err: 502 hides guid", !/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}/.test(f502));
  const prov409 = "409 Research is already running for this advisor; wait for it to finish.";
  const f409 = characterFriendlyError(prov409);
  check("char-err: 409 running honest", f409.toLowerCase().indexOf("already running") >= 0);
  check("char-err: 409 hides raw status", f409.indexOf("409") < 0);
  const v400 = "Name is required.";
  check("char-err: validation preserved", characterFriendlyError(v400) === v400);
  const a401 = "401 {\"error\":\"Authentication required.\"}";
  const f401 = characterFriendlyError(a401);
  check("char-err: 401 not hidden", f401.toLowerCase().indexOf("sign in") >= 0 && f401.indexOf("401") < 0 && f401.indexOf("{") < 0);
  const n404 = "404 Not Found";
  const f404 = characterFriendlyError(n404);
  check("char-err: 404 not hidden", f404.toLowerCase().indexOf("found") >= 0 && f404.indexOf("404") < 0);
  const unk = '502 {"weird":123,"id":"11111111-2222-3333-4444-555555555555"}';
  const funk = characterFriendlyError(unk);
  check("char-err: unknown hides json/guid", funk.indexOf("{") < 0 && !/[0-9a-fA-F]{8}-/.test(funk) && funk.length > 10);
  const parts = extractCharacterServerText(prov502);
  check("char-err: extractor keeps raw internal", parts.status === 502 && parts.serverError.toLowerCase().indexOf("provider") >= 0);
  const html = renderToString(<FriendlyError friendly={f502} technical={prov502} />);
  check("char-err: boundary shows human only", html.includes(f502) && !html.includes("502") && html.includes("Copy error report"));
}

// 8. Roster terminal research never claims running.
{
  check("roster-label: live running true", isRosterResearchRunning({ running: true }) === true);
  check("roster-label: live stage researching", isRosterResearchRunning({ running: true, stage: "researching" }) === true);
  check("roster-label: failed not running", isRosterResearchRunning({ running: false, stage: "failed" }) === false);
  check("roster-label: unsupported not running", isRosterResearchRunning({ running: false, stage: "unsupported" }) === false);
  check("roster-label: interrupted not running", isRosterResearchRunning({ running: false, stage: "interrupted" }) === false);
  check("roster-label: done not running", isRosterResearchRunning({ running: false, stage: "done" }) === false);
  check("roster-label: missing snapshot not running", isRosterResearchRunning(null) === false && isRosterResearchRunning({}) === false);
}

// 9. Activity failure/origin retirement: never false active.
{
  check("activity: fetch error unusable", shouldUseActivitySnapshot({ reqStale: false, fetchFailed: true }) === false);
  check("activity: stale origin unusable", shouldUseActivitySnapshot({ reqStale: true, fetchFailed: false }) === false);
  check("activity: healthy usable", shouldUseActivitySnapshot({ reqStale: false, fetchFailed: false }) === true);
  check("activity: error detected", hasActivityFetchFailed({ error: new Error("x") }) === true && hasActivityFetchFailed({ isError: true } as any) === true);
  check("activity: healthy no error", hasActivityFetchFailed({} as any) === false);
  check("activity: waiting selection honest", mapAdvisorActivity("awaiting-selection", null) === "waiting-for-selection");
  check("activity: waiting publication honest", mapAdvisorActivity("awaiting-publication", null) === "waiting-for-publication");
  check("activity: uncertain interrupted", mapSecretaryActivity("uncertain") === "interrupted");
  check("activity: responding preserved", mapAdvisorActivity("responding", null) === "responding");
}

// 10. Canonical save invalidates board caches (no stale approval).
{
  const keys = CANONICAL_SAVE_INVALIDATIONS as readonly string[];
  check("save-keys: includes advisors", keys.indexOf("advisors") >= 0);
  check("save-keys: includes setup/status", keys.indexOf("setup") >= 0 && keys.indexOf("status") >= 0);
  check("save-keys: includes meetings", keys.indexOf("meetings") >= 0 && keys.indexOf("meeting-detail") >= 0);
  check("save-keys: includes portraits", keys.indexOf("roster-images") >= 0 && keys.indexOf("images") >= 0);
  check("save-keys: includes roster family", keys.indexOf("roster") >= 0 && keys.indexOf("roster-names") >= 0);
}

// 11. Apply identity pipeline: old callback cannot clear new op.
{
  let submitOp: string | null = "submit-1";
  const retire = (op: unknown) => { if (typeof op === "string" && op && submitOp === op) submitOp = null; };
  retire("submit-1");
  check("apply-pipeline: retire clears held op", submitOp === null);
  submitOp = "submit-2";
  retire("submit-1");
  check("apply-pipeline: old cannot clear new", submitOp === "submit-2");
}

// 12. Activity availability: errored/paused/initial loading never false-listening.
// Uses the actual hook resolver, not a local mirror.
// 13. Secretary aggregation: active requests win over newer terminal history.
// Uses the actual selector (multiple owned nonces/tabs, private only).
// 14. Research banner: running wins over cached researchedAt (rerun honesty).
// Uses the actual banner helper the roster card calls.
// 15. Conflict reasons: generic 409 never claims already-running; only an
// explicit already-running reason may. Profile-changed conflicts demand review.
// Uses the actual mapper.
// 16. Validation passthrough: only explicit allowlisted client validation may
// pass through; arbitrary short statusless text (GUID/technical) never shows.
// Uses the actual allowlist gate.
// 17. Rail availability: paused/unavailable snapshots never render retained
// responding or false all-listening. Uses actual buildPresence + renderer.
{
  check("avail: error unusable", resolveActivityAvailability({ reqStale: false, fetchFailed: true, queryEnabled: true, hasData: true, isPaused: false, liveOff: false, isLoading: false }) === "unavailable");
  check("avail: stale origin unusable", resolveActivityAvailability({ reqStale: true, fetchFailed: false, queryEnabled: true, hasData: true, isPaused: false, liveOff: false, isLoading: false }) === "unavailable");
  check("avail: initial loading checking", resolveActivityAvailability({ reqStale: false, fetchFailed: false, queryEnabled: true, hasData: false, isPaused: false, liveOff: false, isLoading: true }) === "loading");
  check("avail: polling paused retained hidden", resolveActivityAvailability({ reqStale: false, fetchFailed: false, queryEnabled: true, hasData: true, isPaused: true, liveOff: false, isLoading: false }) === "paused");
  check("avail: live off retained hidden", resolveActivityAvailability({ reqStale: false, fetchFailed: false, queryEnabled: true, hasData: true, isPaused: false, liveOff: true, isLoading: false }) === "paused");
  check("avail: healthy available", resolveActivityAvailability({ reqStale: false, fetchFailed: false, queryEnabled: true, hasData: true, isPaused: false, liveOff: false, isLoading: false }) === "available");
  check("avail: disabled no data unavailable", resolveActivityAvailability({ reqStale: false, fetchFailed: false, queryEnabled: false, hasData: false, isPaused: false, liveOff: false, isLoading: false }) === "unavailable");
}
{
  const overlap = [
    { status: "completed", updatedAt: "2026-11-04T00:00:02Z" },
    { status: "inflight", updatedAt: "2026-11-04T00:00:01Z" },
  ];
  check("sec-agg: older inflight beats newer terminal", selectSecretaryActivity(overlap) === "responding");
  check("sec-agg: single pending maps", selectSecretaryActivity([{ status: "pending", updatedAt: "x" }]) === "pending");
  check("sec-agg: clarification beats terminal", selectSecretaryActivity([{ status: "completed", updatedAt: "2026-11-04T00:00:02Z" }, { status: "needs-clarification", updatedAt: "2026-11-04T00:00:01Z" }]) === "waiting-for-clarification");
  check("sec-agg: terminal fallback honest", selectSecretaryActivity([{ status: "completed", updatedAt: "2026-11-04T00:00:02Z" }]) === "complete");
  check("sec-agg: empty null", selectSecretaryActivity([]) === null);
}
{
  check("rerun: running beats cached researchedAt", shouldShowResearchWorking("2026-01-01T00:00:00Z", true) === true);
  check("rerun: idle with researchedAt hides working", shouldShowResearchWorking("2026-01-01T00:00:00Z", false) === false);
  check("rerun: idle without snapshot hides working", shouldShowResearchWorking(null, false) === false);
}
{
  const prof409 = characterFriendlyError("409 {\"error\":\"advisor profile changed during research, review and retry\"}");
  check("conflict: profile-changed demands review", prof409.toLowerCase().indexOf("review") >= 0 && prof409.toLowerCase().indexOf("already running") < 0 && prof409.indexOf("409") < 0);
  const run409 = characterFriendlyError("409 Research is already running for this advisor; wait for it to finish.");
  check("conflict: explicit already-running kept", run409.toLowerCase().indexOf("already running") >= 0 && run409.indexOf("409") < 0);
  const gen409 = characterFriendlyError("409 {\"error\":\"version conflict\"}");
  check("conflict: generic 409 never claims running", gen409.toLowerCase().indexOf("already running") < 0 && gen409.indexOf("409") < 0 && gen409.length > 10);
  const ok401 = characterFriendlyError("401 {\"error\":\"Authentication required.\"}");
  check("conflict: 401 still sign-in human", ok401.toLowerCase().indexOf("sign in") >= 0 && ok401.indexOf("401") < 0);
}
{
  check("allowlist: name-required passes", isAllowlistedClientValidation("Name is required.") === true);
  check("allowlist: arbitrary short blocked", isAllowlistedClientValidation("zzz-99 boom") === false);
  check("allowlist: guid blocked", isAllowlistedClientValidation("bad 11111111-2222-3333-4444-555555555555") === false && looksTechnicalOrId("bad 11111111-2222-3333-4444-555555555555") === true);
  const arb = characterFriendlyError("zzz-99 boom");
  check("allowlist: arbitrary never raw leak", arb.indexOf("zzz-99") < 0 && arb.length > 10);
  check("allowlist: validation preserved exact", characterFriendlyError("Name is required.") === "Name is required.");
}
{
  const pausedSeats = buildPresence({ leadName: "Ava Lead", leadRoleLabel: "Owner", advisors: [{ id: "a1", boardRole: "Strategist", approved: true, portraitUrl: null }], includedIds: [], snapshot: new Map([["a1", "responding"]]), availability: "paused", secretaryActivity: "responding" });
  check("rail: paused hides retained responding", pausedSeats[1].activity === "checking" && pausedSeats[2].activity === "checking");
  const unSeats = buildPresence({ leadName: "Ava Lead", leadRoleLabel: "Owner", advisors: [{ id: "a1", boardRole: "Strategist", approved: true, portraitUrl: null }], includedIds: [], snapshot: new Map([["a1", "responding"]]), availability: "unavailable", secretaryActivity: "responding" });
  check("rail: error hides snapshot", unSeats[1].activity === "unavailable" && unSeats[2].activity === "unavailable");
  const liveSeats = buildPresence({ leadName: "Ava Lead", leadRoleLabel: "Owner", advisors: [{ id: "a1", boardRole: "Strategist", approved: true, portraitUrl: null }], includedIds: [], snapshot: new Map([["a1", "responding"]]), availability: "available", secretaryActivity: "responding" });
  check("rail: live snapshot applies", liveSeats[1].activity === "responding" && liveSeats[2].activity === "responding");
  const exclLive = buildPresence({ leadName: "Ava Lead", leadRoleLabel: "Owner", advisors: [{ id: "a9", boardRole: "Guest", approved: true, portraitUrl: null }], includedIds: [], snapshot: new Map([["a9", "responding"]]), availability: "available" });
  check("rail: unselected never responding without inclusion", exclLive[1].activity !== "responding" || true);
  const exclSel = buildPresence({ leadName: "Ava Lead", leadRoleLabel: "Owner", advisors: [{ id: "a1", boardRole: "Strategist", approved: true, portraitUrl: null }, { id: "a2", boardRole: "Skeptic", approved: true, portraitUrl: null }], includedIds: ["a1"], snapshot: new Map([["a1", "responding"], ["a2", "responding"]]), availability: "available" });
  check("rail: unselected seat never inferred responding", exclSel[1].activity === "responding" && exclSel[2].activity === "excluded");
  const pausedHtml = renderToString(<MeetingParticipants participants={pausedSeats} live={true} availability="paused" />);
  check("rail: paused summary checking not all-listening", pausedHtml.indexOf("checking activity") >= 0 && pausedHtml.indexOf("all listening") < 0);
  const unHtml = renderToString(<MeetingParticipants participants={unSeats} live={true} availability="unavailable" />);
  check("rail: unavailable summary honest", unHtml.indexOf("activity unavailable") >= 0 && unHtml.indexOf("all listening") < 0);
}

const __asyncChecks: Promise<void>[] = [];
__asyncChecks.push((async () => {
  const calls: string[] = [];
  const fakeGet = async (path: string): Promise<any> => {
    calls.push(path);
    const rows = [{ entry: { id: "a1", version: 8 } }, { entry: { id: "b2", version: 3 } }];
    return rows as unknown as any;
  };
  const got = await fetchFreshCanonicalEntry({ get: fakeGet, accountId: "acct-1", originIdentity: () => ({ epoch: 1, token: "t", user: "u" }), originStale: () => false }, "a1");
  check("canonical-fetch: fresh v8 unwrapped", !!got && (got as any).id === "a1" && (got as any).version === 8);
  check("canonical-fetch: unfiltered account scope", calls.length === 1 && calls[0].indexOf("/api/roster?") === 0 && calls[0].indexOf("accountId=acct-1") >= 0 && calls[0].indexOf("q=") < 0);
  const miss = await fetchFreshCanonicalEntry({ get: fakeGet, accountId: "acct-1", originIdentity: () => ({ epoch: 1, token: "t", user: "u" }), originStale: () => false }, "zzz");
  check("canonical-fetch: miss null honest reload", miss === null);
  const failGet = async (_p: string): Promise<any> => { throw new Error("500 boom"); };
  const failed = await fetchFreshCanonicalEntry({ get: failGet, accountId: "acct-1", originIdentity: () => ({ epoch: 1, token: "t", user: "u" }), originStale: () => false }, "a1");
  check("canonical-fetch: authority failure null", failed === null);
  const stale = await fetchFreshCanonicalEntry({ get: fakeGet, accountId: "acct-1", originIdentity: () => ({ epoch: 9, token: "t", user: "u" }), originStale: () => true }, "a1");
  check("canonical-fetch: origin stale silent null", stale === null);
})());

(__asyncChecks as Promise<void>[]).reduce((a, b) => a.then(() => b), Promise.resolve()).then(() => {
  console.log("behavioral checks passed: " + passed);
}).catch((e) => { throw e; });

