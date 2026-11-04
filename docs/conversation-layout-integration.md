# Conversation layout integration (central integrator owns App.tsx)
No App.tsx edit in this lane. Apply the replacements below in one pass.

## Goal
One conversation area: lifecycle (New meeting / Meeting settings / Pause meeting /
Resume meeting / End discussion) and ONE advisor action (Request advisor responses)
share the conversation header. Search sits directly above messages. The left
control block (Start meeting + advisor-pick card) is removed so the conversation
gets the width. Board/meeting navigation, back/deep-links, archive/pause/end/state
permissions, explicit participants/yields, secretary + dictation stay as-is.

## Wire-up (App.tsx, meet tab)
1. Import (top of App.tsx):
   import { ConversationHeader, MeetingSettingsDialog, ConversationSearchField, useConversationSettings } from "./conversation-controls";
   import "./conversation-controls.css";
   const { open: settingsOpen, openSettings, closeSettings } = useConversationSettings(false);
2. DELETE the left control block (~meet-left .meetctl with Start meeting + Advisors-for-next-meeting card).
   KEEP the meeting search/filter input, state filter select, and the meetings <ol className="agenda"> list
   (board/meeting navigation, back/deep-links preserved; guest copy preserved).
   Layout becomes: nav list rail + wide conversation column + context pane.
3. REPLACE the .meet-head .meetctl cluster (Pause/Resume/End discussion/Run discussion buttons)
   with:
   <ConversationHeader meetingTitle={curMeeting?.title ?? "Meeting"} meetingBrief={curMeeting?.brief ?? ""}
     stateLabel={meetingStateLabel(curMeeting?.state)} live={!!live} messageCount={delivery.data?.messages ?? null}
     canManageMeeting={canManageMeeting} canCreateMeeting={canManageBoard} canDiscussMeeting={canDiscussMeeting}
     pauseAvailable={curMeeting?.state === 1} resumeAvailable={curMeeting?.state === 3}
     endAvailable={curMeeting != null && meetingIsOpen(curMeeting.state)} briefReady={!!briefText.trim()}
     requestPending={runDiscussion.isPending} onNewMeeting={() => createMeeting.mutate()}
     onOpenSettings={openSettings} onPause={() => meetingCtl("pause")} onResume={() => meetingCtl("resume")}
     onEnd={() => meetingCtl("end")}
     onRequestResponses={() => runDiscussion.mutate({ meetingId, prompt: draft || "Continue the discussion.", policy, leadVersion: lead.data ? lead.data.version : null, origin: originIdentity() })} />
   Do NOT add a second Run/Request button anywhere else (no duplicate actions, no accidental AI calls).
4. MOVE the Meeting setup <details> + advisor picks into:
   <MeetingSettingsDialog open={settingsOpen} ... title={mtitle} brief={mbrief} policy={policy}
     participants={(advisors.data ?? []).map(a => ({ id: a.id, role: a.boardRole, included: meetPicks.length === 0 || meetPicks.includes(a.id) }))}
     onToggleParticipant={toggleMeetPick} onSave={() => saveMeeting.mutate()}
     onCloseWithRecord={() => closeMeeting(true)} onCloseWithoutPublication={() => closeMeeting(false)} onReopen={reopenMeeting} ... />
   Place once under the header.
5. MOVE the bottom <details>Search this conversation</details> to <ConversationSearchField> DIRECTLY above .chatwrap:
   <ConversationSearchField value={sq} onChange={setSq} onSearch={searchMsgs} resultCount={hits.length || null} />
   Keep the hit list rendering as-is beneath it. Delete the old bottom details.
6. Composer/audience To: Everyone/Secretary, secretary clarification, mic dictation, reply-in-thread,
   takeaways/options/decision tabs, context members/context/decisions, archive/close/reopen/stateperms: UNCHANGED.

## Label map (remove vague overlaps)
- Start meeting -> New meeting (lifecycle) | Run discussion -> Request advisor responses (sole AI trigger)
- Pause -> Pause meeting | Resume -> Resume meeting | End discussion (unchanged noun) | Meeting setup -> Meeting settings
- Pending: Advisors drafting... badge + thinking row retained, single source.

