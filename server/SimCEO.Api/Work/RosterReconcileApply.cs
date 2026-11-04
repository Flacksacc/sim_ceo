using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// Real repair executor + owner-authorized HTTP surface for roster reconciliation.
// Companion to RosterReconciliation (scan/plan/backup): this file performs the
// approved production repair exactly once per (idempotencyKey, planHash).
//
// Deterministic + idempotent: the caller first reviews POST
// /api/admin/roster-reconcile/plan (dry-run, writes nothing), then POSTs
// /api/admin/roster-reconcile/apply with the reviewed PlanHash. A fresh re-scan
// with a different hash refuses (409: state changed, re-plan). Per-board JobRow markers
// notes make same-key + same-hash replays a no-op success; same-key +
// different-hash refuses. Concurrency guard included: markers are re-checked
// inside the commit unit, and every repair step re-validates its target.
//
// Repairs performed (history-preserving, no invented content, no name merging):
//   stale-version  -> re-pin RosterVersion to current, Approved=false (re-review).
//   duplicate-link -> keep earliest (CreatedAt, Id); later links Removed=true;
//                     messages, board-linked images and meeting participant lists
//                     re-pointed to the survivor; removed role in the audit event.
//   missing-roster -> RECOVER the canonical roster entry under the stable missing id
//                     (single owner across all sharing boards; entry tagged recovered, honest
//                     stub profile, no invented credentials), re-link board-local images,
//                     and re-pin the PRESERVED advisor links (same Id, role, history).
//                     Advisors are NEVER detached/removed by reconciliation.
//   archived-roster -> NEVER auto-repaired (archival is a live owner decision); flagged.
//
// Ownership validation: a repair is skipped (flagged) only when both the board
// and the roster entry carry non-empty, differing owner keys. Identity is always
// the non-empty RosterEntryId link; names are never used to join people.
public static class RosterReconcileApply
{
  public sealed record ApplyOutcome(bool Ok, string Message, string PlanHash, List<string> Applied, List<string> Flagged, Dictionary<string, string> BoardMarkers, string BackupJson);

  public static bool OwnershipClear(InMemoryStore s, Domain.BoardAdvisor a, Domain.RosterEntry? rent)
  {
    if (rent is null) return true;
    if (!s.Boards.TryGetValue(a.BoardId, out var board) || board is null) return true;
    var bk = (board.OwnerKey ?? "").Trim();
    var rk = (rent.OwnerKey ?? "").Trim();
    if (bk.Length == 0 || rk.Length == 0) return true;
    return string.Equals(bk, rk, StringComparison.OrdinalIgnoreCase);
  }

  private const string MarkerKind = "roster-reconcile";
  // Restore-safe idempotency markers: JobRows (not notes) carry the reconcile receipt.
  // Note rows demand a real parent meeting for non-direction kinds and would fail backup
  // validation on restore; job rows validate by id only and round-trip cleanly.
  private static string MarkerPrefix(string idempotencyKey) => "reconcile:" + idempotencyKey + ":";
  private static Guid? MarkerBoard(Domain.JobRow j)
  {
    try
    {
      using var d = JsonDocument.Parse(string.IsNullOrWhiteSpace(j.Payload) ? "{}" : j.Payload);
      if (d.RootElement.ValueKind == JsonValueKind.Object && d.RootElement.TryGetProperty("board", out var b) && b.ValueKind == JsonValueKind.String && Guid.TryParse(b.GetString(), out var g)) return g;
    }
    catch (JsonException) { }
    return null;
  }
  private static List<Domain.JobRow> MarkersFor(InMemoryStore s, string idempotencyKey) =>
    s.Jobs.Values.Where(j => j.Kind == MarkerKind && (j.IdempotencyKey ?? "").StartsWith(MarkerPrefix(idempotencyKey), StringComparison.Ordinal)).ToList();
  // Owner boundary: the demo owner (no auth header) plus authenticated installation
  // admins (valid session, IsInstallationAdmin). Bearer sessions are NOT rejected:
  // IsOwner(req) alone would lock out secure-mode admins, so admin sessions pass here.
  internal static bool IsReconcileAuthorized(InMemoryStore s, HttpRequest req)
  {
    if (PeopleOps.IsOwner(req)) return true;
    try { if (AuthOps.TrySession(s, req, out var em) && PeopleOps.IsInstallationAdmin(s, em)) return true; }
    catch { }
    return false;
  }
  // Replay/complete gate: only auto-repairable work blocks an idempotent replay.
  // Driven by the fresh report ACTION kinds (Plan's own eligibility signal), so
  // ownership-blocked orphans (FlagForOwnerReview) never block a replay while
  // genuinely repairable work (including a scoped shared target that still
  // requires a global run) forces 409/re-plan instead of a false no-op success.
  private static bool HasActionableWork(InMemoryStore s, RosterReconciliation.ReconcileReport fresh)
  {
    foreach (var a in fresh.Actions)
    {
      if (a.Kind == "RePinAndUnapprove" || a.Kind == "RemoveDuplicateLink"
        || a.Kind == "RecoverMissingEntry" || a.Kind == "RecoverEmptyLink"
        || a.Kind == "RequiresGlobalScope") return true;
    }
    return false;
  }
  public static ApplyOutcome Apply(InMemoryStore s, string planHash, string idempotencyKey, Guid? scopeBoardId, out string error, out int status)
  {
    error = "";
    status = 200;
    var applied = new List<string>();
    var flagged = new List<string>();
    var markers = new Dictionary<string, string>();
    var fresh = RosterReconciliation.Plan(s, idempotencyKey, scopeBoardId);
    if (!string.Equals(fresh.PlanHash, planHash, StringComparison.Ordinal))
    {
      var exactTitle = "reconcile:" + idempotencyKey + ":" + planHash;
      var exactMarkers = MarkersFor(s, idempotencyKey).Where(j => j.IdempotencyKey == exactTitle && (!scopeBoardId.HasValue || MarkerBoard(j) == scopeBoardId.Value)).ToList();
      if (exactMarkers.Count > 0 && !HasActionableWork(s, fresh))
      {
        foreach (var em in exactMarkers) markers[(MarkerBoard(em) ?? Guid.Empty).ToString("N")] = "replay:already-applied";
        return new ApplyOutcome(true, "Idempotent replay: plan " + planHash + " already applied.", fresh.PlanHash, applied, flagged, markers, fresh.BackupJson ?? "");
      }
      error = "State changed since the dry-run plan; re-run plan and review the new report.";
      status = 409;
      return new ApplyOutcome(false, error, fresh.PlanHash, applied, flagged, markers, "");
    }
    var boards = fresh.Orphans.Select(o => o.BoardId).Distinct().OrderBy(b => b).ToList();
    foreach (var bid in boards)
    {
      var boardMarkers = MarkersFor(s, fresh.IdempotencyKey).Where(j => MarkerBoard(j) == bid).ToList();
      var clash = boardMarkers.FirstOrDefault();
      if (clash is not null && clash.IdempotencyKey != "reconcile:" + fresh.IdempotencyKey + ":" + fresh.PlanHash)
      {
        error = "Idempotency key " + fresh.IdempotencyKey + " was already used for a different plan on board " + bid + "; refusing to apply.";
        status = 409;
        return new ApplyOutcome(false, error, fresh.PlanHash, applied, flagged, markers, "");
      }
      if (clash is not null) markers[bid.ToString("N")] = "replay:already-applied";
    }
    if (boards.Count > 0 && markers.Count == boards.Count)
      return new ApplyOutcome(true, "Idempotent replay: plan " + fresh.PlanHash + " already applied.", fresh.PlanHash, applied, flagged, markers, fresh.BackupJson ?? "");
    // Dry-run honesty: a scoped plan that spans boards outside the scope carries
    // RequiresGlobalScope actions describing the exact shared targets. Refuse with
    // an explicit global-required reason instead of a partial silent repair.
    var globalNeeded = fresh.Actions.Where(a => a.Kind == "RequiresGlobalScope").ToList();
    if (scopeBoardId.HasValue && globalNeeded.Count > 0)
    {
      var outsideBoards = globalNeeded.SelectMany(a =>
      {
        try
        {
          using var md = JsonDocument.Parse(string.IsNullOrWhiteSpace(a.Mutation) ? "{}" : a.Mutation);
          if (md.RootElement.ValueKind == JsonValueKind.Object && md.RootElement.TryGetProperty("outside", out var oe) && oe.ValueKind == JsonValueKind.Array)
            return oe.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString() ?? "").Where(x => x.Length > 0).ToList();
        }
        catch (JsonException) { }
        return new List<string>();
      }).Distinct().OrderBy(b => b).ToList();
      error = "Shared missing roster " + string.Join(",", globalNeeded.Select(a => a.RosterEntryId.ToString("N")[..8])) + " is also linked from board(s) " + string.Join(",", outsideBoards.Select(b => b.Length >= 8 ? b[..8] : b)) + " outside this scope; run a global (unscoped) reconcile so every sharing link, image, and approval is repaired together.";
      status = 409;
      return new ApplyOutcome(false, error, fresh.PlanHash, applied, flagged, markers, fresh.BackupJson ?? "");
    }
    // Scoped-apply coherence guard: a missing roster target shared with boards outside
    // the scope cannot be repaired coherently here (out-of-scope links would stay
    // approved with stale pins and unlinked images while the plan goes clean). Refuse
    // with an explicit global-required reason instead of a partial silent repair.
    if (scopeBoardId.HasValue)
    {
      foreach (var sg in fresh.Orphans.Where(o => o.Reason == "missing-roster" && o.RosterEntryId != Guid.Empty).GroupBy(o => o.RosterEntryId))
      {
        var cross = s.Advisors.Values.Where(a => !a.Removed && a.RosterEntryId == sg.Key && a.BoardId != scopeBoardId.Value).Select(a => a.BoardId).Distinct().OrderBy(b => b).ToList();
        if (cross.Count > 0)
        {
          error = "Shared missing roster " + sg.Key.ToString("N")[..8] + " is also linked from board(s) " + string.Join(",", cross.Select(b => b.ToString("N")[..8])) + " outside this scope; run a global (unscoped) reconcile so every sharing link, image, and approval is repaired together.";
          status = 409;
          return new ApplyOutcome(false, error, fresh.PlanHash, applied, flagged, markers, fresh.BackupJson ?? "");
        }
      }
    }
    var dupGroups = fresh.Orphans.Where(o => o.Reason == "duplicate-link").GroupBy(o => new { o.BoardId, o.RosterEntryId }).ToList();
    var staleTargets = fresh.Orphans.Where(o => o.Reason == "stale-version").ToList();
    var missingTargets = fresh.Orphans.Where(o => o.Reason == "missing-roster" || o.Reason == "empty-link").ToList();
    foreach (var o in fresh.Orphans.Where(o => o.Reason == "archived-roster"))
      flagged.Add("archived:" + o.AdvisorId.ToString("N") + ":board:" + o.BoardId.ToString("N") + ":relink-or-unarchive-by-owner");
    try
    {
      Atomic.Run(s, () =>
      {
        // Holding-guard revalidation INSIDE the commit unit: recompute the dry-run over
        // live state and compare hashes. Any concurrent plan mutation (new orphans,
        // version/owner/role edits, moved history) aborts the whole unit with 409
        // instead of publishing a partially-stale repair. All-or-nothing by construction
        // (Atomic.Run rolls back memory / PG transaction on throw).
        var holding = RosterReconciliation.Plan(s, fresh.IdempotencyKey, scopeBoardId);
        if (!string.Equals(holding.PlanHash, fresh.PlanHash, StringComparison.Ordinal))
          throw new InvalidOperationException("plan-changed");
        foreach (var o in staleTargets)
        {
          if (!s.Advisors.TryGetValue(o.AdvisorId, out var adv) || adv is null || adv.Removed) continue;
          if (!s.Roster.TryGetValue(o.RosterEntryId, out var rent) || rent is null || rent.Archived) continue;
          var sblk = RosterLegacyAccess.RepairBlockReason(s, adv, rent, o.RosterEntryId);
          if (sblk is not null) { flagged.Add("stale:" + o.AdvisorId.ToString("N") + ":" + sblk); continue; }
          adv.RosterVersion = rent.Version;
          adv.Approved = false;
          s.Advisors[adv.Id] = adv;
          applied.Add("repin:" + adv.Id.ToString("N") + ":v" + rent.Version);
        }
        foreach (var g in dupGroups)
        {
          var links = s.Advisors.Values.Where(a => !a.Removed && a.BoardId == g.Key.BoardId && a.RosterEntryId == g.Key.RosterEntryId).OrderBy(a => a.CreatedAt).ThenBy(a => a.Id).ToList();
          if (links.Count < 2) continue;
          var survivor = links[0]!;
          s.Roster.TryGetValue(survivor.RosterEntryId, out var srent);
          var dblk = RosterLegacyAccess.RepairBlockReason(s, survivor, srent, survivor.RosterEntryId);
          if (dblk is not null) { flagged.Add("duplicate:board:" + survivor.BoardId.ToString("N") + ":" + dblk); continue; }
          foreach (var dup in links.Skip(1))
          {
            var removedRole = dup!.BoardRole ?? "";
            dup.Removed = true;
            s.Advisors[dup.Id] = dup;
            RepointHistoryLocked(s, dup.Id, survivor.Id, survivor.BoardId);
            Atomic.Audit(s, new AuditEvent { BoardId = survivor.BoardId, Action = "roster.reconcile.dedupe", Detail = JsonSerializer.Serialize(new { removed = dup.Id, survivor = survivor.Id, roster = survivor.RosterEntryId, preservedRole = removedRole }) });
            applied.Add("dedupe:" + dup.Id.ToString("N") + "->" + survivor.Id.ToString("N"));
          }
        }
        // Missing-link recovery: reconstruct the canonical roster entry UNDER THE STABLE
        // MISSING ID (never a new duplicate), then re-pin the PRESERVED advisors (same Id,
        // same board membership, same role, same history). Advisors are NEVER detached or
        // removed by reconciliation. Groups span boards: every non-removed advisor sharing
        // one non-empty missing RosterEntryId under ONE owner yields exactly ONE entry.
        // Ownership: all boards sharing the id must carry the same non-empty owner key,
        // else the group is flagged (never cross-account merged). Account: the owner's
        // account when known, else a stable owner-derived id (deterministic, idempotent).
        // Content honesty: the reconstructed profile states its provenance and needs owner
        // completion/research; no employment, credentials, or dossier facts are invented.
        // Guid.Empty links carry no identity: never grouped, never recovered, flagged only.
        foreach (var g in missingTargets.GroupBy(o => o.RosterEntryId))
        {
          var rid = g.Key;
          if (rid == Guid.Empty)
          {
            // Empty-link recovery: NO identity exists, so each advisor gets its OWN
            // deterministic entry (StableEmptyLinkId per board+advisor, never grouped).
            // Requires a non-empty board owner; ownerless boards stay flagged.
            foreach (var o in g)
            {
              if (!s.Advisors.TryGetValue(o.AdvisorId, out var ea) || ea is null || ea.Removed) continue;
              if (!s.Boards.TryGetValue(ea.BoardId, out var eb) || eb is null) { flagged.Add("empty-link:" + o.AdvisorId.ToString("N") + ":board-missing-owner-review-required"); continue; }
              var ebo = (eb.OwnerKey ?? "").Trim();
              if (ebo.Length == 0) { flagged.Add("empty-link:" + o.AdvisorId.ToString("N") + ":board:" + o.BoardId.ToString("N") + ":no-board-owner-review-required"); continue; }
              var nid = RosterLegacyAccess.StableEmptyLinkId(ea.BoardId, ea.Id);
              if (nid == Guid.Empty) { flagged.Add("empty-link:" + ea.Id.ToString("N") + ":deterministic-id-failure-owner-review-required"); continue; }
              s.Roster.TryGetValue(nid, out var ner);
              if (ner is not null)
              {
                if (ner.Archived) { flagged.Add("empty-link:" + ea.Id.ToString("N") + ":target-archived-owner-review-required"); continue; }
                var nto = (ner.OwnerKey ?? "").Trim();
                var ntok = nto.Length > 0
                  ? string.Equals(nto, ebo, StringComparison.OrdinalIgnoreCase)
                  : string.Equals(RosterLegacyAccess.MutationOwnerKey(s, nid) ?? "", ebo, StringComparison.OrdinalIgnoreCase);
                if (!ntok) { flagged.Add("empty-link:" + ea.Id.ToString("N") + ":target-owner-mismatch"); continue; }
              }
              if (ner is null)
              {
                var eacct = RosterLegacyAccess.AccountForOwner(s, ebo);
                var enm = (ea.BoardRole ?? "").Trim();
                if (enm.Length == 0) enm = "Recovered advisor";
                var enow = DateTime.UtcNow;
                ner = new RosterEntry
                {
                  Id = nid, AccountId = eacct, OwnerKey = ebo, Type = AdvisorType.FictionalCharacter,
                  Name = enm,
                  Description = "Recovered canonical roster entry for an unlinked board advisor on board " + eb.Name + ". Review and complete; run research as needed.",
                  ProfileJson = RosterLegacyAccess.HonestRecoveryStub(ea.BoardRole ?? "", "unlinked board advisor " + ea.Id.ToString("N")[..8] + " on board " + eb.Name),
                  Version = 1, Tags = "recovered", UpdatedAt = enow,
                };
                s.Roster[ner.Id] = ner;
                applied.Add("recover-empty:" + nid.ToString("N"));
                Atomic.Audit(s, new AuditEvent { BoardId = ea.BoardId, Action = "roster.reconcile.recover-empty", Detail = JsonSerializer.Serialize(new { advisor = ea.Id, roster = nid, owner = ebo, name = enm }) });
              }
              foreach (var eimg in s.Images.Values.Where(i => i.BoardAdvisorId == ea.Id && !i.RosterEntryId.HasValue).ToList())
              {
                eimg.RosterEntryId = nid;
                s.Images[eimg.Id] = eimg;
              }
              ea.RosterEntryId = nid;
              ea.RosterVersion = ner.Version;
              ea.Approved = false;
              s.Advisors[ea.Id] = ea;
              applied.Add("relink:" + ea.Id.ToString("N") + "->" + nid.ToString("N"));
            }
            continue;
          }
          var inScope = g.Select(o => s.Advisors.TryGetValue(o.AdvisorId, out var a) ? a : null).Where(a => a is not null && !a!.Removed).ToList();
          // Strict history-aware ownership: removed links count as evidence, unknown
          // owners conflict. No silent cross-account transfer, no vanishing ownership.
          var owner = RosterLegacyAccess.MutationOwnerKey(s, rid);
          if (rid == Guid.Empty) { foreach (var o in g) flagged.Add("missing:" + o.AdvisorId.ToString("N") + ":zero-id-forbidden"); continue; }
          if (owner is null)
          {
            foreach (var o in g) flagged.Add("missing:" + o.AdvisorId.ToString("N") + ":owner-mismatch-or-ambiguous");
            continue;
          }
          if (!s.Roster.TryGetValue(rid, out var rent) || rent is null)
          {
            var acct = RosterLegacyAccess.AccountForOwner(s, owner);
            // Global-first naming matches the dry-run exactly (scope-independent identity).
            var first = s.Advisors.Values.Where(a => !a.Removed && a.RosterEntryId == rid).OrderBy(a => a.CreatedAt).ThenBy(a => a.Id).FirstOrDefault();
            if (first is null) continue;
            var nm = (first.BoardRole ?? "").Trim();
            if (nm.Length == 0) nm = "Recovered advisor";
            var now = DateTime.UtcNow;
            rent = new RosterEntry
            {
              Id = rid, AccountId = acct, OwnerKey = owner, Type = AdvisorType.FictionalCharacter,
              Name = nm,
              Description = "Recovered canonical roster entry for legacy board link " + rid.ToString("N")[..8] + ". Review and complete; run research as needed.",
              ProfileJson = RosterLegacyAccess.HonestRecoveryStub(first.BoardRole ?? "", "legacy board-advisor link " + rid.ToString("N")[..8]),
              Version = 1, Tags = "recovered", UpdatedAt = now,
            };
            s.Roster[rent.Id] = rent;
            applied.Add("recover:" + rid.ToString("N"));
            Atomic.Audit(s, new AuditEvent { BoardId = first.BoardId, Action = "roster.reconcile.recover", Detail = JsonSerializer.Serialize(new { roster = rid, owner, name = nm, links = inScope.Count }) });
          }
          else if (rent.Archived)
          {
            foreach (var o in g) flagged.Add("missing:" + o.AdvisorId.ToString("N") + ":archived-target-owner-review-required");
            continue;
          }
          var inScopeIds = new HashSet<Guid>(inScope.Select(a => a!.Id));
          foreach (var img in s.Images.Values.Where(i => i.BoardAdvisorId.HasValue && inScopeIds.Contains(i.BoardAdvisorId.Value) && !i.RosterEntryId.HasValue).ToList())
          {
            img.RosterEntryId = rid;
            s.Images[img.Id] = img;
          }
          foreach (var adv in inScope)
          {
            adv!.RosterVersion = rent.Version;
            adv.Approved = false;
            s.Advisors[adv.Id] = adv;
            applied.Add("repin:" + adv.Id.ToString("N") + ":v" + rent.Version);
          }
        }
        s.Advisors.Flush();
        s.Images.Flush();
        s.Meetings.Flush();
        s.Notes.Flush();
        foreach (var bid in boards)
        {
          if (markers.ContainsKey(bid.ToString("N"))) continue;
          var markerTitle = "reconcile:" + fresh.IdempotencyKey + ":" + fresh.PlanHash;
          var existing = MarkersFor(s, fresh.IdempotencyKey).FirstOrDefault(j => j.IdempotencyKey == markerTitle && MarkerBoard(j) == bid);
          if (existing is not null) { markers[bid.ToString("N")] = "replay:already-applied"; continue; }
          var now = DateTime.UtcNow;
          var marker = new Domain.JobRow { Id = Guid.NewGuid(), IdempotencyKey = markerTitle, Kind = MarkerKind, State = "completed", Payload = JsonSerializer.Serialize(new { board = bid, engine = fresh.Engine, planHash = fresh.PlanHash, applied, flagged, backupChars = (fresh.BackupJson ?? "").Length }), Attempts = 1, Error = "", CreatedAt = now, UpdatedAt = now };
          s.Jobs[marker.Id] = marker;
          markers[bid.ToString("N")] = marker.Id.ToString("N");
        }
        s.Jobs.Flush();
      });
    }
    catch (UnauthorizedAccessException)
    {
      error = "Access revoked or not granted for this scope.";
      status = 403;
      return new ApplyOutcome(false, error, fresh.PlanHash, applied, flagged, markers, "");
    }
    catch (InvalidOperationException iox) when (iox.Message == "plan-changed") { error = "State changed during apply; re-run plan and review the new report."; status = 409; return new ApplyOutcome(false, error, RosterReconciliation.Plan(s, idempotencyKey, scopeBoardId).PlanHash, applied, flagged, markers, ""); }
    catch (InvalidOperationException iox) { error = "Repair failed; no state changed: " + iox.Message; status = 500; return new ApplyOutcome(false, error, fresh.PlanHash, applied, flagged, markers, ""); }
    catch (Exception ex)
    {
      var mapped = CommitOutcome.MapCommitFailure(ex, "Roster reconciliation");
      if (mapped is not null) { error = "Repair failed; no state changed."; status = 500; return new ApplyOutcome(false, error, fresh.PlanHash, applied, flagged, markers, ""); }
      throw;
    }
    return new ApplyOutcome(true, "Applied " + applied.Count + " repair(s); " + flagged.Count + " flagged for owner review.", fresh.PlanHash, applied, flagged, markers, fresh.BackupJson ?? "");
  }

  private static void RepointHistoryLocked(InMemoryStore s, Guid removedAdvisorId, Guid survivorAdvisorId, Guid boardId)
  {
    foreach (var mid in s.Messages.Select(kv => kv.Key).ToList())
    {
      if (!s.Messages.TryGetValue(mid, out var list) || list is null) continue;
      var touched = false;
      var rebuilt = new List<Domain.Message>(list.Count);
      foreach (var m in list)
      {
        if (m.AdvisorId == removedAdvisorId)
        {
          rebuilt.Add(new Domain.Message { BoardId = m.BoardId, MeetingId = m.MeetingId, Sequence = m.Sequence, AdvisorId = survivorAdvisorId, Sender = m.Sender, AdvisorName = m.AdvisorName, Content = m.Content, ParentSequence = m.ParentSequence, Stance = m.Stance, Status = m.Status, CreatedAt = m.CreatedAt });
          touched = true;
        }
        else rebuilt.Add(m);
      }
      if (touched) s.Messages[mid] = MessageList.Detached(mid, rebuilt);
    }
    foreach (var img in s.Images.Values.Where(i => i.BoardAdvisorId == removedAdvisorId).ToList())
    {
      img.BoardAdvisorId = survivorAdvisorId;
      s.Images[img.Id] = img;
    }
    foreach (var mtg in s.Meetings.Values.Where(m => m.BoardId == boardId).ToList())
    {
      List<Guid> parts;
      try
      {
        using var d = JsonDocument.Parse(string.IsNullOrWhiteSpace(mtg.ParticipantIdsJson) ? "[]" : mtg.ParticipantIdsJson);
        if (d.RootElement.ValueKind != JsonValueKind.Array) continue;
        parts = new List<Guid>();
        foreach (var e in d.RootElement.EnumerateArray())
          if (e.ValueKind == JsonValueKind.String && Guid.TryParse(e.GetString(), out var g)) parts.Add(g);
      }
      catch (JsonException) { continue; }
      if (!parts.Contains(removedAdvisorId)) continue;
      var swapped = parts.Select(p => p == removedAdvisorId ? survivorAdvisorId : p).Distinct().ToList();
      mtg.ParticipantIdsJson = JsonSerializer.Serialize(swapped);
      s.Meetings[mtg.Id] = mtg;
    }
  }

  public static void MapRosterReconciliation(this WebApplication app)
  {
    app.MapPost("/api/admin/roster-reconcile/plan", (InMemoryStore s, HttpRequest req, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badPlan) return badPlan;
      if (!IsReconcileAuthorized(s, req)) return PeopleOps.Denied();
      Guid? scope = null;
      if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("scopeBoardId", out var sb) && sb.ValueKind == JsonValueKind.String && Guid.TryParse(sb.GetString(), out var sg) && sg != Guid.Empty) scope = sg;
      var key = "roster-reconcile:manual";
      if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("idempotencyKey", out var ik) && ik.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(ik.GetString())) key = ik.GetString()!.Trim();
      if (scope.HasValue && !s.Boards.ContainsKey(scope.Value)) return Results.NotFound("Board not found.");
      var report = RosterReconciliation.Plan(s, key, scope);
      return Results.Ok(new { report.Engine, report.PlanHash, report.IdempotencyKey, report.GeneratedAt, scopeBoardId = scope, orphans = report.Orphans, actions = report.Actions, warnings = report.Warnings, applied = report.Applied });
    });

    app.MapPost("/api/admin/roster-reconcile/apply", (InMemoryStore s, HttpRequest req, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badApply) return badApply;
      if (!IsReconcileAuthorized(s, req)) return PeopleOps.Denied();
      if (body.ValueKind != JsonValueKind.Object) return Results.BadRequest("planHash and idempotencyKey are required.");
      var planHash = body.TryGetProperty("planHash", out var ph) && ph.ValueKind == JsonValueKind.String ? (ph.GetString() ?? "") : "";
      var key = body.TryGetProperty("idempotencyKey", out var ik2) && ik2.ValueKind == JsonValueKind.String ? (ik2.GetString() ?? "") : "";
      if (string.IsNullOrWhiteSpace(planHash) || string.IsNullOrWhiteSpace(key)) return Results.BadRequest("planHash and idempotencyKey are required.");
      Guid? scope = null;
      if (body.TryGetProperty("scopeBoardId", out var sb2) && sb2.ValueKind == JsonValueKind.String && Guid.TryParse(sb2.GetString(), out var sg2) && sg2 != Guid.Empty) scope = sg2;
      if (scope.HasValue && !s.Boards.ContainsKey(scope.Value)) return Results.NotFound("Board not found.");
      var outcome = Apply(s, planHash.Trim(), key.Trim(), scope, out var err, out var code);
      if (!outcome.Ok && code == 409) return Results.Conflict(new { error = err, freshPlanHash = outcome.PlanHash });
      if (!outcome.Ok) return Results.Json(new { error = err }, statusCode: code);
      return Results.Ok(new { message = outcome.Message, planHash = outcome.PlanHash, applied = outcome.Applied, flagged = outcome.Flagged, boardMarkers = outcome.BoardMarkers, backupChars = (outcome.BackupJson ?? "").Length, backupJson = outcome.BackupJson });
    });
  }
}