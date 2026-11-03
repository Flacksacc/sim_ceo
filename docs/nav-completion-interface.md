# Navigation-completion canonical contracts (Muse lane)

Sole UI/transport authority: web/src/App.tsx, web/src/main.tsx, navigation modules, small shared identity transport, navigation/auth role browser QA. Secretary domain callbacks stay with Secretary lane; wiki-resources and sources-governance components stay with Wiki lane. Both lanes consume the contracts below and MUST NOT duplicate them.

## 1. Canonical applied identity (Bearer precedes applied demo)

- canonicalUser(): currentToken() ? (currentUser() || owner) : (appliedActAs || owner). Unapplied draft text is never identity.
- withUser(): Authorization Bearer when a session token exists, else X-User applied label. No window-global substitute.
- main.tsx identityKey + simceo-auth-change remount + epoch bump on token/user/storage changes.
- secIdentity() aliases canonicalUser. Secretary envelopes keyed by canonical identity + board + meeting + epoch.

## 2. Auth epoch + stale-callback rule

- __simceoEpoch increments on identity change, Apply identity, purge, and new submissions.
- Every async origin captures { epoch, token, user } (+ board/meeting/record selection). Late callbacks compare against live values and discard on mismatch. No comparison against mutable draft globals.
- fetchAuth/fetchPublic consume the full body, then recheck epoch/identity BEFORE callbacks, storage writes, downloads, or error display. Current-session 401 dispatches simceo-auth-failed; stale-identity 401 is discarded silently.
- purgePrivate(reason): stops hub/media, revokes blob URLs, removes ALL private query families, resets board/meeting-owned UI state, clears secretary pending markers, navigates to #/boards. Per-user localStorage drafts are preserved under identity keys.

## 3. Private rendering + query gating

- privateHidden = sessExpired || sessPending-with-token. While set, main renders only AuthPanel + InviteClaim + verification note.
- Every private query gates enabled on !sessGate. Board/meeting/record lookups additionally gate on parent validity.
- 404 on a singular lookup (or verified parent mismatch) clears that route segment with replace navigation. Non-404 errors gate without clearing. 403 renders a denied card with recovery (Back to board meetings / Close board), never a broken empty view.
- Approval DOM additionally requires a current successful review (no fail-open on missing validity).

## 4. Capability contracts (server-derived caps only)

- canManageBoard (board manage), canWriteBoard (manage/contribute), canManageMeeting (board manage or meeting manage), canActMeeting (board write or meeting contribute/manage), canDiscussMeeting (canActMeeting or meeting discuss), capsAdmin (installation admin), isGuest.
- manage: board archive, settings save/activate/import/export, invites, grants, advisor approve/attach, record approve/amend, backup/restore.
- contribute: meeting create, notes/directions/briefing, record prepare/revise/discard, chat/audition, sources upload/reindex, export.
- discuss (one designated meeting only): composer send + Run/rebid + read-only effective settings. No management, notes, records, sources, or admin.
- read: no mutation controls enabled.
- spending/jobs/audit/model-status/installation usage: capsAdmin only. Usage scope selector offers installation only to admins; others fall back to board scope.

## 5. Host transport for embedded panels

- WikiResources and SourcesGovernance receive transport={ get, post, put, del, upload, download, origin, stale } from App. No direct fetch, no own tokens.
- download() pins origin identity at fetch and rechecks at click; account switch discards.
- Every state update rechecks origin()/stale() plus board/sequence guards.
- Source approve/reject/exclude/restore/policy require canManage; upload/reindex/refresh require canWrite (contribute).

## 6. Record refresh/export contract

- refreshReview(): immutable origin + guardOf(draft) GET review, compare watermarks, POST /refresh only when stale; errors stored under canonical identity+token key and rendered as role=alert.
- exportRecord(): authedDownload (identity-aware), never a plain anchor.

## 7. Navigation contract

- Hash routes #/tab?board=&meeting=&mtab=&ctab=&rec=. Unknown tab/mtab/ctab normalize to defaults. Bounded lists never establish absence.
- Valid switches push (Back works); mount/traversal dedup and invalid-parent cleanup replace. Reload preserves route; StrictMode-safe draft keys per user.
- Guest deny recovers to the allowed meeting; forbidden scopes show denied cards, never leaks.
