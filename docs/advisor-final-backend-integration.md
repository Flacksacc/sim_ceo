# Advisor FINAL backend integration (isolated branch)

Branch: `muse/advisor-final-backend` from `2d2c032` (MAIN `fb72e77` acceptedProfile + acceptedSend latest `e808745` picked by parallel release owner, source current stable).

## Order

1. ACCEPTED JOINED backend `d0f45cf` first (accepted roster `e21f3c8` + activity `ad3bdcf` onto MAIN `bd3e392`).
2. Character ENGINE only actual seven commits `a667a05`, `3c03d50`, `a6cc956`, `e99f1e6`, `9d5a699`, `204c891`, `f4b5b0b` from `.tmp/character-advisor-engine`.

Excluded by design (NOT ported): engine branch ancestors `0892f60`, old frontend `342b68b`/`f71822a`/`9e23a06`, wholesale restore `Program`/`LeadSetup`/`Ops`/`Wizard`/`Entities`/`PostgresDb` (engine base OLD, missing accepted profile/source-auth/roster fixes). No frontend modifications except already-base Send+Profile; no central UI yet.

Muse authorship: primary prose orchestration only; exact code picked per slice. Primary cannot code.

## Three-way semantic merges (BASE/MINE/THEIRS) - FINAL accepted source of ALL slices wins

- `Program.cs`: BASE `bd3e392` / MINE `2d2c032` (SendRootGate+generation/epoch/MessageList rollback `e808745`) / THEIRS `d0f45cf` (roster reconciliation selftest + canonical projection + activity recovery). Result: `d0f45cf` full file + re-applied send hunk (`savedGenMsg`/`savedRestoreIdMsg`/`savedRestoreRevMsg`, generation+restoreEpoch envelope). Then character deltas only: POST `/api/roster` name/desc bounds + `ValidateSavedProfile` gate; approve map adds `research-failed`/`research-interrupted`/`research-unsupported` (keeps `recovered-incomplete`). Rejected `f4b5b0b` old list/count predicates and old recon selftest (inferior to `d0f45cf`).
- `Entities.cs`: MINE adds `LeadProfile.OwnerKey`; THEIRS adds `RosterEntry.ResearchInputsJson` (+comment). Result: BOTH (disjoint hunks).
- `PostgresDb.cs`: MINE adds `LeadProfiles.OwnerKey` + index (41/42); THEIRS adds `RosterEntries.ResearchInputsJson` in 3 places (CREATE TABLE col, DDL 38, `ExecuteSqlRaw` with `{{}}` escaping from `3c03d50` P1). Result: BOTH (4 lines total, byte-identical to sources).
- `LeadSetup.cs` / `OpsEndpoints.cs`: MINE-only (global profile/default inheritance/export disclosure boundaries). THEIRS empty. Result: MINE preserved byte-identical.
- `ModelGateway.cs` / `PublicEvidence.cs` / `fake-provider.mjs`: MINE==BASE, THEIRS character-only. Result: take THEIRS (`UserCharBudget` root formula + cancellation preserved never-502 from `e99f1e6`; `MaxSubjectTokens` 12 default / 24 research path from `3c03d50`; `COMPILE-CHARACTER-PARAGRAPHS` + `QA-SLEEP-R/C` kinds).
- `WizardGuide.cs` / `Secretary.cs`: MINE large (profile + activity `TryCaptureContributor`/epoch/publish hooks). THEIRS 2-line `TaskCanceledException` each (`a667a05`). Result: MINE + add `TaskCanceledException` to `wizard.guide-fallback` catch and 2 secretary catches. MINE already had `TaskCanceled` in wizard line 210 and secretary `IsTransient`.
- `ContextCurator.cs`: MINE canonical `CanonicalPacketSection` + `lead?.Version` manifest fix; THEIRS essential-first packets (`FitEssentialFirst`), `LatestLeadMessage` full-4000 tails, seed context, dev-aware `UserCharBudget`, dossier-trim budget. Result: take THEIRS file, re-apply MINE manifest (`lead?.Version` + comment, not `board?.LeadProfileVersion`).
- `Endpoints.cs`: MINE activity hooks + profile/lead/default/export + `MapMeetingActivity`/`MapRosterChat`/`MapRosterReconciliation`; THEIRS `BidInputTokens`, stale-profile `why` mapping, `MapCharacterResearch`. Result: MINE + 3 THEIRS deltas (bid tokens, `stale-profile`/`stale-context` why, insert `MapCharacterResearch` between `MapRosterChat` and `MapRosterReconciliation`). LaneB `stale-profile` fingerprint already in MINE.
- `RosterIntegrity.cs` / `RosterChatEndpoints.cs`: `d0f45cf` vs `f4b5b0b` diff is pure character upgrade (no auth regression). Result: take `f4b5b0b` (`BehaviorSection` 3-paragraph FULL + dossier-trim cap 1500-8000; roster-chat RootGate snapshot + `FitEssentialFirst` + 499/409/403/401 discard).
- `RosterEndpoints.cs` (hardest, 17 hunks `d0f45cf..f4b5b0b`):
  - ADD `ResearchTerminalStatus`/`ResearchMissingReason` (`a667a05` honest dossier); MERGE into `DataCompleteness`/`Completeness` KEEPING `recovered` placeholder line + terminal-aware `missing` (not `f4b` deletion).
  - ApprovalGate: KEEP `recovered-incomplete` FIRST, then add terminal `research-unsupported`/`research-failed`/`research-interrupted` + `research-pending` (merge, not `f4b` replacement).
  - REJECT `f4b` regressions: `CanWriteRoster` strict `MutationOwnerKey` removal, `CanReadRoster` `OwnerMatches`->`OwnerKey` equals, attach `EffectiveOwnerKey` removal. FINAL strict canonical roster owner + shared legacy compat preserved.
  - TAKE character: `InvalidateDossier` identity comment, `PreserveResearchOnBehaviorSave`/`IsSubjectChange`/`HasBackgroundProperty`/`TryProfileBackground`/`ProfileBackground`/`SameSourceUrls` (`a667a05`+`e99f1e6`+`9d5a699`); PUT name/desc bounds + profileJson object/string + sourceUrls + `subjectChanged` + `backgroundChanged` vs fresh `cur.ProfileJson` (`204c891` ordering fix) + `ResearchInputsJson` sync + behavior-save preserve; creation name/role/problem/desc bounds + canonical `ValidateSavedProfile` + inline `ValidateInlineProfile`; audition RootGate snapshot + `BehaviorSection`+seed + `FitEssentialFirst` + 499/409 + immutable-final recheck; research routes DELETED here (moved to `CharacterResearch.MapCharacterResearch`).
  - `TryCopy` signature + `__canSrcAttach`+`EffectiveOwnerKey`, 410 retired chat, research GET progress signal, recovered tag-strip hook all from `d0f45cf` preserved (in head region before splice).
  - Splice: head `1-500` (strict) + `f4b` PUT..audition `480-968` + tail image-upload..end (preserves strict head, takes character middle, keeps tail).
- `CharacterResearch.cs` (new from `f4b`): full engine (deadline 504/abort 499 no-502-wrap, conditional background inputs, `ResearchInputsJson` persist, dossier `done`/`unsupported` proof). ADD missing `d0` recovered tag-strip on `grounded` (strip `recovered` only when grounded; unsupported keeps tag). Auth via `CanWrite`/`CanRead` (strict-preserved).
- `CharacterBehavior.cs` (new from `f4b`): 3-paragraph selection + reason/style every run/chat/audition/seed context/full-4000 tails; `MaxBackgroundChars`/4000, `MaxProfileJsonChars`, `ValidateSavedProfile`/`ValidateInlineProfile`/`FitEssentialFirst`/`SeedContextSection`/`EssentialQuestion`.
- `RosterReconciliation.cs` / `RosterReconcileApply.cs`: MINE (`d0`) 981 lines superset vs THEIRS 481 (old). Result: keep MINE (activity stage aliases character-honest preserved; no character delta in these files).
- `BoardHub.cs` / `MeetingActivity.cs` / `MeetingActivityProbe` / `meeting-activity-*` / `roster-backend/pg/chat-contract/integrity` / `sigsub` / `.gitignore` / `docs/roster-integrity-integration.md`: take `d0f45cf` (accepted). Engine `0892` base predates them; `f4b` deletes activity QA (683 lines). Keep `d0`.
- `MeetingEndpoints.cs` / `Tables.cs` / `web/*`: keep MINE SendRootGate/generation/epoch + Send+Profile (engine never touched Meeting/Tables; engine frontend excluded).

## Validation (this session, pure only - no services/browser/process/Docker/.env/human ports/global cleanup)

- `dotnet build SimCEO.Api -c Release`: PASS 0 errors.
- `dotnet build SimCEO.Api -c Debug`: PASS 0 errors (58 pre-existing nullable/NU warnings only).
- `dotnet publish SimCEO.Api -c Release`: PASS (publish/ folder).
- `node --check` `character-advisor/maxsize/character-pg/meeting-activity/roster-backend/fake-provider`: ALL PASS exit 0.
- `dotnet run -- --selftest`: PASS (`SELFTEST PASS: advisor-cap, sequence, ...`).
- NOT rerun (primary-owned harness later, no autorun servers): joined `d0` FULL DEBUG/roster 119HTTP+23PG/activity 119SignalR+29PG+8probe/default-profile 120 real-PG; engine `f4b`+`204c` FULL publish HTTP159/native-PG37/maxsize15 + `character-engine-204c891-final-review.txt`; send `e808745` 85HTTP+37actual-restore+129stub+30real-provider + `send-e808745-final-review.txt`; profile 81/5c2 guards; backend-joined `d0f45cf-final-review`/`send-e808745-final-review`. No integration tests claimed from precursors; dedicated reviews cited as precursor evidence only.

## Remaining gates (primary QA owns)

- Full QA harness reruns on joined tree (roster/activity/profile/send/character) by primary; no servers autorun here.
- PG/native and HTTP/SignalR suites need owned ports/DBs (primary).
- No central UI yet (deferred by design).

Source: Muse-authored; primary prose orchestration only, no code written by primary. Scope is FULL implemented (not narrow compat shim/throwaway). No `usertmp.txt`. Batched read+patch, no line-escaped helper scripts.
