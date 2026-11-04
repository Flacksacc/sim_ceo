using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using Microsoft.AspNetCore.SignalR;
using SimCEO.Api.Hubs;
using SimCEO.Api.Work;

namespace SimCEO.Api;

public static class SimCEOEndpoints
{
  // P1 #5 helper: deterministic effective-lead identity/content fingerprint.
  // ID + owning scope + version + full content; a missing lead is "lead:none".
  // Captured BEFORE model work and compared against a fresh ResolveLeadFor
  // immediately under the publication locks, so a same-version identity or
  // content swap discards the stale reply instead of publishing it.
  static string DiscussionDirFingerprint(SimCEO.Api.Data.InMemoryStore s, Guid boardId, Guid meetingId)
    {
      try { var parts = s.Notes.Values.Where(n => n.BoardId == boardId && (n.MeetingId == meetingId || n.Scope == "board") && n.Kind == "direction").OrderBy(n => n.Id).Select(n => n.Id.ToString("N") + "|" + (n.Scope ?? "") + "|" + n.MeetingId.ToString("N") + "|" + (n.Body ?? "")); return SimCEO.Api.Work.Hashing.HashOf(string.Join("\n", parts)); }
      catch { return ""; }
    }
  static string DiscussionEffFingerprint(SimCEO.Api.Data.InMemoryStore s, Guid boardId, Guid meetingId)
    {
      // Exact per-item content + approving owner identity, hashed: a same-length text
      // swap (BUY->CUT) or an owner change (A v1 -> B v2) always changes the fingerprint.
      // RecordDraft has no identity-bearing ToString; pin head id+version explicitly.
      try
      {
        var views = global::SimCEO.Api.RecordsOps.EffectiveChains(s.Drafts.Values.Where(x => x.BoardId == boardId && x.MeetingId == meetingId));
        var parts = new System.Collections.Generic.List<string>();
        foreach (var v in views.OrderBy(v => v.Head.Id.ToString()))
        {
          parts.Add("head:" + v.Head.Id.ToString("N") + ":v" + v.Head.Version);
          foreach (var id in v.EffectiveIds.OrderBy(x => x, System.StringComparer.Ordinal))
          {
            var tx = v.EffectiveTexts.TryGetValue(id, out var t) ? t : "";
            var ow = v.EffectiveOwners.TryGetValue(id, out var o) ? (o.RecordId + ":v" + o.Version) : "unowned";
            parts.Add(id + "=" + ow + "=" + tx);
          }
        }
        return SimCEO.Api.Work.Hashing.HashOf(string.Join("\n", parts));
      }
      catch { return ""; }
    }

  private static string LeadIdentityFingerprint(LeadProfile? lead) =>
    lead is null ? "lead:none"
    : JsonSerializer.Serialize(new
    {
      id = lead.Id,
      boardId = lead.BoardId,
      version = lead.Version,
      name = lead.Name ?? "",
      roleLabel = lead.RoleLabel ?? "",
      background = lead.Background ?? "",
      familiarTopics = lead.FamiliarTopics ?? "",
      simplerTopics = lead.SimplerTopics ?? "",
      commPrefs = lead.CommPrefs ?? "",
    });

  // Finding 2: atomic authoritative discussion capture. The restore pin AND the
  // FULL context it protects (meeting, board, policy, lead, candidates,
  // eligibility, connection model, generation, fingerprints, lead floor,
  // invitations, reviewed-input prints, effective cap) are read inside ONE root
  // boundary BEFORE any dependent read, eligibility decision, or bookkeeping.
  // A restore before this block is fully described by the fresh context (the
  // pin matches the new epoch); a restore after it fails the pin at the first
  // pin-checked bookkeeping write, so stale context never acquires the new
  // restore identity. Snapshots are carried unchanged through every async
  // branch; live re-reads happen only inside commit units that compare
  // against them. Never hold the root across a provider await: this capture
  // is fully synchronous (policy/store reads only, no dispatch).
  private static T CloneDetached<T>(T row) where T : class
  {
    var json = JsonSerializer.Serialize(row);
    return JsonSerializer.Deserialize<T>(json)!;
  }

  // P1 finding 1: every live-store packet input is observed atomically under
  // Root AFTER the original restore pin, the relevant captured fingerprints,
  // and current authority are rechecked. Packet strings are fully constructed
  // synchronously inside the Root gate; the provider await stays outside, so a
  // packet never observes uncommitted/torn/rejected input and never acquires
  // a new restore identity. Covers BidPacket + BuildPacket and every other
  // live packet read inside BuildPacket (roster profile/dossier, recent
  // messages, approved records, directions, sources/wiki). Post-await
  // publication checks below are preserved unchanged.
  private static void CheckPacketFreshnessLocked(InMemoryStore s, HttpRequest req, DiscussionCapture cap, Meeting m, BoardAdvisor adv)
  {
    PublicationGuard.Check(s, cap.PublishPin, req, m.BoardId, m.Id, "discuss");
    if (s.SourceEpoch != cap.EpochBefore)
      throw new InvalidOperationException("source-changed");
    if (s.RestoreEpochId != cap.RestoreBefore)
      throw new InvalidOperationException("restored");
    if (s.Meetings.TryGetValue(m.Id, out var curM) && curM is not null)
    {
      if (curM.Generation != cap.Gen)
        throw new InvalidOperationException("generation-changed");
    }
    LeadProfile? curLead = null;
    if (s.Boards.TryGetValue(m.BoardId, out var curBoard) && curBoard is not null)
      curLead = LeadSetup.ResolveLeadForBoard(s, curBoard);
    else
      curLead = LeadSetup.ResolveLeadFor(s, m.BoardId);
    if ((curLead?.Version ?? 0) != cap.LeadVersion
      || !string.Equals(LeadIdentityFingerprint(curLead), cap.LeadFingerprint, StringComparison.Ordinal))
      throw new InvalidOperationException("lead-changed");
    if (s.Boards.TryGetValue(m.BoardId, out var freshBoard) && freshBoard is not null)
    {
      var fv = LeadSetup.EffectiveView(s, freshBoard);
      if (!string.Equals(fv.name ?? "", cap.BoardNameBefore, StringComparison.Ordinal)
        || !string.Equals(fv.mission ?? "", cap.BoardMissionBefore, StringComparison.Ordinal)
        || !string.Equals(fv.stage ?? "", cap.BoardStageBefore, StringComparison.Ordinal))
        throw new InvalidOperationException("board-changed");
    }
    if (!string.Equals(DiscussionDirFingerprint(s, m.BoardId, m.Id), cap.DirBefore, StringComparison.Ordinal))
      throw new InvalidOperationException("directions-changed");
    if (!string.Equals(DiscussionEffFingerprint(s, m.BoardId, m.Id), cap.EffBefore, StringComparison.Ordinal))
      throw new InvalidOperationException("records-changed");
    if (!cap.LaneBPrints.TryGetValue(adv.Id, out var wanted)
      || !string.Equals(RosterOps.ReviewedInputFingerprint(s, adv), wanted, StringComparison.Ordinal))
      throw new InvalidOperationException("roster-changed");
  }

  private static string BuildBidPacketPinned(InMemoryStore s, HttpRequest req, DiscussionCapture cap, Meeting m, BoardAdvisor adv, string prompt, Board? board)
  {
    lock (s.RootGate)
    {
      CheckPacketFreshnessLocked(s, req, cap, m, adv);
      return ContextCurator.BidPacket(s, m, adv, prompt, board);
    }
  }

  private static (string packet, CuratorManifest manifest) BuildDiscussionPacketPinned(InMemoryStore s, HttpRequest req, DiscussionCapture cap, Meeting m, BoardAdvisor adv, string prompt, Board? board, LeadProfile? lead, string? reviewContext = null)
  {
    lock (s.RootGate)
    {
      CheckPacketFreshnessLocked(s, req, cap, m, adv);
      return ContextCurator.BuildPacket(s, m, adv, prompt, board, lead, reviewContext is null ? ContextBudget.DraftTokens : ContextBudget.MaxTokens, reviewContext);
    }
  }

  private sealed record DiscussionCapture(
    Meeting Meeting,
    Board? RunBoard,
    string Policy,
    LeadProfile? Lead,
    int LeadVersion,
    string LeadFingerprint,
    List<BoardAdvisor> Candidates,
    List<BoardAdvisor> Eligible,
    List<object> Yielded,
    int PickedCount,
    string Spark,
    (Guid epochId, long epochRev) PublishPin,
    long EpochBefore,
    Guid RestoreBefore,
    long Gen,
    string DirBefore,
    string EffBefore,
    long LeadFloor,
    HashSet<Guid> InvitedIds,
    Dictionary<Guid, string> LaneBPrints,
    int RequestedCap,
    int EffectiveCap,
    Guid PriorCapNoteId,
    string BoardNameBefore,
    string BoardMissionBefore,
    string BoardStageBefore);

  private static bool TryCaptureDiscussionContext(InMemoryStore s, Guid id, Meeting m, JsonElement body, HttpRequest req,
    out DiscussionCapture? cap, out IResult? error)
  {
    cap = null; error = null;
    Meeting snapM = m;
    Board? runBoard = null;
    string policy = "balanced";
    LeadProfile? lead = null;
    List<BoardAdvisor> candidates = new();
    List<object> yielded = new();
    int pickedCount = 0;
    List<BoardAdvisor> eligible = new();
    string spark = "";
    int leadVersion = 0;
    string leadFingerprint = "lead:none";
    string boardNameBefore = "";
    string boardMissionBefore = "";
    string boardStageBefore = "";
    (Guid epochId, long epochRev) publishPin = default;
    long epochBefore = 0; Guid restoreBefore = Guid.Empty;
    long gen = 0; string dirBefore = ""; string effBefore = ""; long leadFloor = 0;
    var invitedIds = new HashSet<Guid>();
    var laneBPrints = new Dictionary<Guid, string>();
    int requestedCap = 10; int effectiveCap = 10; Guid priorCapNoteId = Guid.Empty;
    lock (s.RootGate)
    {
      publishPin = PublicationGuard.Capture(s); epochBefore = s.SourceEpoch; restoreBefore = s.RestoreEpochId;
      // Fresh meeting handle inside the same boundary: the context below must
      // describe the pinned instant, not a pre-restore reference.
      if (!s.Meetings.TryGetValue(id, out var freshM) || freshM is null)
      {
        error = Results.NotFound("meeting");
        return false;
      }
      snapM = freshM;
      policy = EffectiveDiscussionPolicy(s, snapM.BoardId);
      try { if (!PeopleOps.Can(s, req, snapM.BoardId, id, "contribute") && s.Boards.TryGetValue(snapM.BoardId, out var polB)) { policy = polB.DiscussionPolicy; try { if (polB.ActiveConfig && !string.IsNullOrWhiteSpace(polB.ActiveJson)) { using var __aj = System.Text.Json.JsonDocument.Parse(polB.ActiveJson); if (__aj.RootElement.TryGetProperty("discussionPolicy", out var __dp) && __dp.ValueKind == System.Text.Json.JsonValueKind.String && !string.IsNullOrWhiteSpace(__dp.GetString())) policy = __dp.GetString()!; } } catch { } } } catch { }
      if (policy is not ("focused" or "balanced" or "open")) policy = "balanced";
      s.Boards.TryGetValue(snapM.BoardId, out runBoard);
      lead = runBoard is null ? LeadSetup.ResolveLeadFor(s, snapM.BoardId) : LeadSetup.ResolveLeadForBoard(s, runBoard);
      candidates = s.Advisors.Values.Where(a => a.BoardId == snapM.BoardId && !a.Removed && a.Approved).ToList();
      try
      {
        using var pdoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(snapM.ParticipantIdsJson) ? "[]" : snapM.ParticipantIdsJson);
        if (pdoc.RootElement.ValueKind == JsonValueKind.Array)
        {
          var picked = new HashSet<Guid>();
          foreach (var pe in pdoc.RootElement.EnumerateArray())
            if (pe.ValueKind == JsonValueKind.String && Guid.TryParse(pe.GetString(), out var pg)) picked.Add(pg);
          if (picked.Count > 0) { pickedCount = picked.Count; candidates = s.Advisors.Values.Where(a => a.BoardId == snapM.BoardId && !a.Removed && picked.Contains(a.Id)).ToList(); }
        }
      }
      catch (JsonException) { }
      foreach (var cand in candidates)
      {
        var gate = RosterOps.ApprovalGate(s, cand);
        if (gate is null) eligible.Add(cand);
        else yielded.Add(new { advisor = cand.BoardRole, reason = gate });
      }
      try { spark = ModelPolicy.SparkFor(s, snapM.BoardId); }
      catch (SimCEO.Api.Data.PolicyUnavailableException)
      {
        error = Results.Json(new { error = "Installation policy store unavailable." }, statusCode: 503);
        return false;
      }
      gen = snapM.Generation;
      dirBefore = DiscussionDirFingerprint(s, snapM.BoardId, id);
      effBefore = DiscussionEffFingerprint(s, snapM.BoardId, id);
      leadFloor = MeetingTurns.LeadSeqAfter(s, id, 0);
      try
      {
        using var inviteDoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(snapM.ParticipantIdsJson) ? "[]" : snapM.ParticipantIdsJson);
        if (inviteDoc.RootElement.ValueKind == JsonValueKind.Array)
          foreach (var inviteEl in inviteDoc.RootElement.EnumerateArray())
            if (inviteEl.ValueKind == JsonValueKind.String && Guid.TryParse(inviteEl.GetString(), out var inviteGuid)) invitedIds.Add(inviteGuid);
      }
      catch (JsonException) { }
      foreach (var ea in eligible)
        laneBPrints[ea.Id] = RosterOps.ReviewedInputFingerprint(s, ea);
      requestedCap = DiscussionPolicy.MaxReplies(policy);
      effectiveCap = requestedCap;
      int? priorCap = null;
      foreach (var capNote in s.Notes.Values.Where(n => n.MeetingId == id && n.Kind == "run-cap").ToList())
      {
        try
        {
          using var capDoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(capNote.Body) ? "{}" : capNote.Body);
          if (capDoc.RootElement.TryGetProperty("leadSeq", out var capSeq) && capSeq.ValueKind == JsonValueKind.Number
            && capSeq.GetInt64() == leadFloor
            && capDoc.RootElement.TryGetProperty("cap", out var capVal) && capVal.ValueKind == JsonValueKind.Number
            && capVal.TryGetInt32(out var capInt))
          {
            priorCap = priorCap.HasValue ? Math.Min(priorCap.Value, capInt) : capInt;
            if (priorCapNoteId == Guid.Empty) priorCapNoteId = capNote.Id;
          }
        }
        catch (JsonException) { }
      }
      if (priorCap.HasValue) effectiveCap = Math.Min(priorCap.Value, requestedCap);
      // Detached snapshot inside the SAME root boundary: lead identity,
      // board effective content, and every object that leaves the root are
      // copied here. A failed concurrent mutation that rolls back can never
      // mutate the run packet source. Never hold the root across an await.
      leadVersion = lead?.Version ?? 0;
      leadFingerprint = LeadIdentityFingerprint(lead);
      if (runBoard is not null)
      {
        var effView = LeadSetup.EffectiveView(s, runBoard);
        boardNameBefore = effView.name ?? "";
        boardMissionBefore = effView.mission ?? "";
        boardStageBefore = effView.stage ?? "";
      }
      snapM = CloneDetached(snapM);
      if (runBoard is not null) runBoard = CloneDetached(runBoard);
      if (lead is not null) lead = CloneDetached(lead);
      candidates = candidates.Select(CloneDetached).ToList();
      eligible = eligible.Select(CloneDetached).ToList();
      yielded = new List<object>(yielded);
      invitedIds = new HashSet<Guid>(invitedIds);
      laneBPrints = new Dictionary<Guid, string>(laneBPrints);
    }
    cap = new DiscussionCapture(snapM, runBoard, policy, lead, leadVersion, leadFingerprint,
      candidates, eligible, yielded, pickedCount, spark, publishPin, epochBefore, restoreBefore,
      gen, dirBefore, effBefore, leadFloor, invitedIds, laneBPrints, requestedCap, effectiveCap, priorCapNoteId,
      boardNameBefore, boardMissionBefore, boardStageBefore);
    return true;
  }

    private static string EffectiveDiscussionPolicy(InMemoryStore s, Guid boardId)
    {
      try
      {
        if (!s.Boards.TryGetValue(boardId, out var b) || b is null) return "balanced";
        if (b.ActiveConfig && !string.IsNullOrWhiteSpace(b.ActiveJson))
        {
          using var aj = System.Text.Json.JsonDocument.Parse(b.ActiveJson);
          if (aj.RootElement.TryGetProperty("discussionPolicy", out var dp) && dp.ValueKind == System.Text.Json.JsonValueKind.String
            && !string.IsNullOrWhiteSpace(dp.GetString())) return dp.GetString()!;
        }
        return string.IsNullOrWhiteSpace(b.DiscussionPolicy) ? "balanced" : b.DiscussionPolicy;
      }
      catch { return "balanced"; }
    }

  public static void MapExtended(this WebApplication app)
  {
    var gw = new ModelGateway(app.Services.GetRequiredService<InMemoryStore>());

    app.MapGet("/api/presets", () => Results.Ok(PresetLibrary.All));
    app.MapGet("/api/presets/{key}", (string key) =>
      PresetLibrary.Find(key) is { } p ? Results.Ok(p) : Results.NotFound());

    // ---- Board lead profile ("Your Profile"): explicit versioned save ----
    app.MapGet("/api/boards/{bid:guid}/lead", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (bid == Guid.Empty) return Results.NotFound();
      if (PeopleOps.BadToken(s, req) is { } badLG) return badLG;
      if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _))
        return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      var user = PeopleOps.UserOf(s, req);
      if (!PeopleOps.Can(s, req, bid, null, "read") && PeopleOps.GuestMeetingIds(s, user, bid).Count == 0) return PeopleOps.Denied();
      Board? effBoard = null;
      try { s.Boards.TryGetValue(bid, out effBoard); } catch { effBoard = null; }
      var owned = LeadSetup.ResolveLeadForStrict(s, bid);
      LeadProfile? cur = owned;
      if (cur is null && effBoard is not null) cur = LeadSetup.ResolveLeadForBoard(s, effBoard);
      if (cur is null) cur = LeadSetup.ResolveLeadFor(s, bid);
      if (cur is null) return Results.NotFound();
      var fallback = LeadSetup.IsFallback(cur, bid);
      var source = LeadSetup.LeadSource(cur, bid);
      var caller = PeopleOps.UserOf(s, req);
      bool isInstAdmin = false;
      try { isInstAdmin = PeopleOps.IsInstallationAdmin(s, caller); }
      catch (InvalidOperationException) { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
      if (!PeopleOps.Can(s, req, bid, null, "read"))
      {
        // Meeting guests: minimal board-owned identity only; never fallback content.
        if (fallback) return Results.NotFound();
        return Results.Ok(new { cur.Id, cur.BoardId, cur.Version, cur.Name, cur.RoleLabel, source });
      }
      // Board readers+: full board-owned or owner-default profile; legacy global stays installation data.
      if (source == "global" && !isInstAdmin)
        return Results.Json(new { error = "No board lead profile saved; save the board lead profile to continue." }, statusCode: 404);
      return Results.Ok(new { cur.Id, cur.BoardId, cur.Version, cur.Name, cur.RoleLabel, cur.Background, cur.FamiliarTopics, cur.SimplerTopics, cur.CommPrefs, cur.ProvenanceJson, cur.UpdatedAt, source, isFallback = fallback });
    });
    app.MapPost("/api/boards/{bid:guid}/lead", (InMemoryStore s, HttpRequest req, Guid bid, LeadProfile input) =>
    {
      if (bid == Guid.Empty) return Results.NotFound();
      if (PeopleOps.BadToken(s, req) is { } badLead) return badLead;
      if (PeopleOps.Check(s, req, bid, null, "contribute") is { } deniedLead) return deniedLead;
      LeadProfile saved = null; string error = null; int status = 200;
      try { var r = LeadSetup.SaveLead(s, bid, input, req, "contribute"); saved = r.saved; error = r.error; status = r.status; }
      catch (UnauthorizedAccessException uex) when (uex.Message == "revoked") { return Results.Json(new { error = "Authentication required." }, statusCode: 401); }
        catch (InvalidOperationException iox) when (iox.Message == "security-unavailable") { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
        catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
      catch (Exception ex) { return SimCEO.Api.Work.CommitOutcome.MapCommitFailure(ex, "Lead save") ?? Results.Json(new { error = "Lead save failed; no state changed: " + ex.Message }, statusCode: 500); }
      return saved is not null ? Results.Ok(saved) : Results.Json(new { error }, statusCode: status);
    });
    app.MapGet("/api/lead", (InMemoryStore s, HttpRequest req) =>
    {
      try {
      if (PeopleOps.IsSecure(s))
      {
        if (!AuthOps.TrySession(s, req, out var le)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        if (!PeopleOps.IsInstallationAdmin(s, le)) return Results.Json(new { error = "Installation admin only." }, statusCode: 403);
      }} catch (InvalidOperationException) { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
      var cur = LeadSetup.ResolveLead(s);
      return cur is null ? Results.NotFound() : Results.Ok(cur);
    });
    app.MapPost("/api/lead", (InMemoryStore s, HttpRequest req, LeadProfile input) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badGlead) return badGlead;
      try {
      if (PeopleOps.IsSecure(s))
      {
        if (!AuthOps.TrySession(s, req, out var le2)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        if (!PeopleOps.IsInstallationAdmin(s, le2)) return Results.Json(new { error = "Installation admin only." }, statusCode: 403);
      }} catch (InvalidOperationException) { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
      LeadProfile gsaved = null; string gerror = null; int gstatus = 200;
      try { var gr = LeadSetup.SaveLead(s, Guid.Empty, input, req, "admin"); gsaved = gr.saved; gerror = gr.error; gstatus = gr.status; }
      catch (UnauthorizedAccessException uex) when (uex.Message == "revoked") { return Results.Json(new { error = "Authentication required." }, statusCode: 401); }
      catch (UnauthorizedAccessException) { return Results.Json(new { error = "Installation admin only." }, statusCode: 403); }
      catch (InvalidOperationException) { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
      catch (Exception ex) { return SimCEO.Api.Work.CommitOutcome.MapCommitFailure(ex, "Lead save") ?? Results.Json(new { error = "Lead save failed; no state changed: " + ex.Message }, statusCode: 500); }
      return gsaved is not null ? Results.Ok(gsaved) : Results.Json(new { error = gerror }, statusCode: gstatus);
    });
    // ---- Per-account default profile ("Default profile"): one per person ----
    // Boards inherit this default unless they carry an explicit board override.
    // Saving here NEVER writes board rows and NEVER touches another account:
    // identity is always the caller (session email or demo X-User), with 401
    // when unauthenticated in secure mode and per-owner version guards (409).
    app.MapGet("/api/profile", (InMemoryStore s, HttpRequest req) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badProf) return badProf;
      try {
        if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _))
          return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      } catch (InvalidOperationException) { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
      var cur = LeadSetup.ResolveDefaultForCaller(s, req);
      if (cur is null) return Results.NotFound();
      return Results.Ok(new { cur.Id, cur.BoardId, cur.Version, cur.Name, cur.RoleLabel, cur.Background, cur.FamiliarTopics, cur.SimplerTopics, cur.CommPrefs, cur.ProvenanceJson, cur.UpdatedAt, source = "default" });
    });
    app.MapPost("/api/profile", (InMemoryStore s, HttpRequest req, LeadProfile input) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badProfPost) return badProfPost;
      LeadProfile? saved = null; string? error = null; int status = 200;
      try { var r = LeadSetup.SaveDefault(s, input, req); saved = r.saved; error = r.error; status = r.status; }
      catch (UnauthorizedAccessException uex) when (uex.Message == "revoked") { return Results.Json(new { error = "Authentication required." }, statusCode: 401); }
      catch (InvalidOperationException iox) when (iox.Message == "security-unavailable") { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
      catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
      catch (Exception ex) { return SimCEO.Api.Work.CommitOutcome.MapCommitFailure(ex, "Default save") ?? Results.Json(new { error = "Default save failed; no state changed: " + ex.Message }, statusCode: 500); }
      if (saved is not null) return Results.Ok(new { saved.Id, saved.BoardId, saved.Version, saved.Name, saved.RoleLabel, saved.Background, saved.FamiliarTopics, saved.SimplerTopics, saved.CommPrefs, saved.ProvenanceJson, saved.UpdatedAt, source = "default" });
      return Results.Json(new { error }, statusCode: status);
    });

    // ---- Board fields edit (stays a draft until setup activation) ----
    app.MapPatch("/api/boards/{id:guid}", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badBoard) return badBoard;
      if (!s.Boards.TryGetValue(id, out var b)) return Results.NotFound();
      if (PeopleOps.Check(s, req, id, null, "manage") is { } deniedBoard) return deniedBoard;
      lock (s.SetupLock)
      {
        // Fetch, authority, mutation and flush share one store-bound unit: the
        // pre-lock row must not source the mutation after an intervening
        // tracker-clearing rollback, and a failed PATCH commits nothing.
        try
        {
          Atomic.Run(s, () =>
          {
            if (!s.Boards.TryGetValue(id, out var cur) || cur is null) throw new InvalidOperationException("Board is gone.");
            if (PeopleOps.Check(s, req, id, null, "manage") is not null) throw PeopleOps.AuthFault(s, req);
            if (body.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String) cur.Name = n.GetString() ?? "";
            if (body.TryGetProperty("mission", out var m) && m.ValueKind == JsonValueKind.String) cur.Mission = m.GetString() ?? "";
            if (body.TryGetProperty("stage", out var st) && st.ValueKind == JsonValueKind.String) cur.Stage = st.GetString() ?? "";
            if (body.TryGetProperty("retainAudio", out var ra) && (ra.ValueKind == JsonValueKind.True || ra.ValueKind == JsonValueKind.False)) cur.RetainAudio = ra.GetBoolean();
            if (body.TryGetProperty("discussionPolicy", out var dp) && dp.GetString() is { } pol
                && (pol == "focused" || pol == "balanced" || pol == "open")) cur.DiscussionPolicy = pol;
            if (body.TryGetProperty("dataUse", out var du) && du.GetString() is { } dataUse
                && (dataUse == "standard" || dataUse == "contributor")) cur.DataUse = dataUse;
            if (body.TryGetProperty("archived", out var ar)
                && (ar.ValueKind == JsonValueKind.True || ar.ValueKind == JsonValueKind.False)) cur.Archived = ar.ValueKind == JsonValueKind.True;
            cur.DraftJson = JsonSerializer.Serialize(new { cur.Name, cur.Mission, cur.Stage, cur.RetainAudio, cur.DiscussionPolicy, at = DateTime.UtcNow });
            s.Boards[cur.Id] = cur;
          });
        }
        catch (UnauthorizedAccessException uex) when (uex.Message == "revoked") { return Results.Json(new { error = "Authentication required." }, statusCode: 401); }
        catch (InvalidOperationException iox) when (iox.Message == "security-unavailable") { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
        catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
        catch (InvalidOperationException iox) when (SimCEO.Api.Work.CommitOutcome.IsMissing(iox, "Board is gone.")) { return Results.NotFound(); }
        catch (InvalidOperationException iox) { return SimCEO.Api.Work.CommitOutcome.StorageFault("Board update", iox); }
        catch (Exception ex) { return SimCEO.Api.Work.CommitOutcome.MapCommitFailure(ex, "Board update") ?? Results.Json(new { error = "Board update failed; no state changed: " + ex.Message }, statusCode: 500); }
        if (!s.Boards.TryGetValue(id, out var saved) || saved is null) return Results.NotFound();
        return Results.Ok(saved);
      }
    });

    // ---- Setup review + activation (exact reviewed draft only) ----
    app.MapGet("/api/boards/{bid:guid}/setup", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (bid == Guid.Empty) return Results.NotFound();
      if (PeopleOps.Check(s, req, bid, null, "read") is { } deniedSetup) return deniedSetup;
      if (!s.Boards.TryGetValue(bid, out var b)) return Results.NotFound();
      // Effective board lead: strict override, else owner default, else legacy global (admin-only).
      var effLead = LeadSetup.ResolveLeadForBoard(s, b);
      object? lead = effLead;
      bool isViewerAdmin = false;
      try { isViewerAdmin = PeopleOps.IsInstallationAdmin(s, PeopleOps.UserOf(s, req)); }
      catch { isViewerAdmin = false; }
      bool hideGlobal = false;
      try
      {
        if (effLead is not null && LeadSetup.LeadSource(effLead, bid) == "global" && !isViewerAdmin) { lead = null; hideGlobal = true; }
      }
      catch { lead = null; hideGlobal = true; }
      var total = s.Advisors.Values.Count(a => a.BoardId == bid && !a.Removed);
      var approved = s.Advisors.Values.Count(a => a.BoardId == bid && !a.Removed && a.Approved);
      var canonicalFull = LeadSetup.CanonicalDraftJson(s, b);
      var activeFull = b.ActiveJson ?? "";
      // Dirty status is a config fact, not a display artifact: compute it on
      // unredacted snapshots before any viewer-based redaction, so redaction
      // alone never flips an unchanged activated board to dirty for non-admins.
      bool dirtyFull = !string.Equals(canonicalFull, activeFull, StringComparison.Ordinal);
      var canonical = canonicalFull;
      var shownActive = activeFull;
      if (hideGlobal)
      {
        // A hidden top-level lead is not enough: canonical/active JSON embed the
        // full legacy-global profile. Serve redacted views (lead null) so the
        // installation content never leaks to non-admin readers.
        canonical = LeadSetup.CanonicalDraftJsonWithLead(s, b, null);
        shownActive = LeadSetup.RedactLeadJson(shownActive);
      }
      else if (!isViewerAdmin)
      {
        // Historical snapshots are independent of current resolution: an
        // admin-owned board activated under legacy global keeps that profile
        // inside ActiveJson even after a default/override takes over. Never
        // expose stored snapshot lead content to non-admin viewers.
        shownActive = LeadSetup.RedactLeadJson(shownActive);
      }
      return Results.Ok(new
      {
        board = new { b.Id, b.Name, b.Mission, b.Stage, b.ActiveConfig, b.LeadProfileVersion, b.RetainAudio, b.DiscussionPolicy, b.DataUse },
        draftJson = b.DraftJson, activeJson = shownActive,
        canonicalJson = canonical,
        draftHash = Hashing.HashOf(canonical),
        dirty = dirtyFull,
        lead, advisors = new { total, approved },
      });
    });
    app.MapPost("/api/boards/{bid:guid}/setup/activate", (InMemoryStore s, HttpRequest req, Guid bid, JsonElement body) =>
    {
      if (bid == Guid.Empty) return Results.NotFound();
      if (PeopleOps.BadToken(s, req) is { } badAct) return badAct;
      if (PeopleOps.Check(s, req, bid, null, "manage") is { } deniedAct) return deniedAct;
      string? hash = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("hash", out var h)
        ? h.GetString() : null;
      Board actBoard = null; string actError = null; int actStatus = 200;
      try { var ar = LeadSetup.Activate(s, bid, hash, req); actBoard = ar.board; actError = ar.error; actStatus = ar.status; }
      catch (UnauthorizedAccessException uex) when (uex.Message == "revoked") { return Results.Json(new { error = "Authentication required." }, statusCode: 401); }
        catch (InvalidOperationException iox) when (iox.Message == "security-unavailable") { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
        catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
      catch (Exception ex) { return SimCEO.Api.Work.CommitOutcome.MapCommitFailure(ex, "Activation") ?? Results.Json(new { error = "Activation failed; no state changed: " + ex.Message }, statusCode: 500); }
      return actBoard is not null ? Results.Ok(actBoard) : Results.Json(new { error = actError }, statusCode: actStatus);
    });

    // ---- Wizard drafts (resumable, autosaved) ----
    app.MapPost("/api/wizard", (InMemoryStore s, HttpRequest req, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badWiz) return badWiz;
      var id = body.TryGetProperty("id", out var wid) && wid.ValueKind == JsonValueKind.String
        && Guid.TryParse(wid.GetString(), out var wg) && wg != Guid.Empty ? wg : Guid.NewGuid();
      var sem = s.DraftLocks.GetOrAdd(id, _ => new SemaphoreSlim(1, 1));
      if (!sem.Wait(0)) return Results.Conflict("Draft is busy (interview running); retry.");
      try
      {
        // Fetch, authority, version-guard and mutation share one store-bound
        // unit against freshly fetched rows: nothing is mutated before every
        // guard passes, so a denied or stale save changes nothing.
        IResult? wizDenied = null;
        try
        {
          Atomic.Run(s, () =>
          {
            var has = s.WizardDrafts.TryGetValue(id, out var cur);
            if (has)
            {
              if (!WizardGuide.TryWizardUser(s, req, cur, out _, out var deniedSv)) { wizDenied = deniedSv; return; }
            }
            cur ??= new WizardDraft { Id = id, Version = 1 };
            if (!has)
            {
              if (!WizardGuide.TryWizardUser(s, req, null, out var newOwner, out var deniedNew)) { wizDenied = deniedNew; return; }
              cur.OwnerKey = newOwner;
            }
            // Lane B: existing saves require an explicitly present integer expected version.
            if (has)
            {
              if (!body.TryGetProperty("version", out var vw) || vw.ValueKind != JsonValueKind.Number
                  || !vw.TryGetInt32(out var want) || want != cur.Version)
                throw new InvalidOperationException("stale");
            }
            if (!has)
            {
              if (body.TryGetProperty("accountId", out var ac)) cur.AccountId = ac.ValueKind == JsonValueKind.String
                && Guid.TryParse(ac.GetString(), out var ag) ? ag : Guid.Empty;
              cur.Status = "Saved";
            }
            if (body.TryGetProperty("step", out var st) && st.ValueKind == JsonValueKind.Number) cur.Step = st.GetInt32();
            if (body.TryGetProperty("presetKey", out var pk) && pk.ValueKind == JsonValueKind.String) cur.PresetKey = pk.GetString() ?? "";
            if (body.TryGetProperty("fieldsJson", out var fj) && fj.ValueKind == JsonValueKind.String) cur.FieldsJson = fj.GetString() ?? "{}";
            if (body.TryGetProperty("interviewJson", out var ij) && ij.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(ij.GetString())) cur.InterviewJson = ij.GetString()!;
            if (body.TryGetProperty("provenanceJson", out var pj2) && pj2.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(pj2.GetString())) cur.ProvenanceJson = pj2.GetString()!;
            WizardGuide.NormalizeInterview(cur);
            cur.Version++;
            cur.UpdatedAt = DateTime.UtcNow;
            s.WizardDrafts[cur.Id] = cur;
          });
        }
        catch (InvalidOperationException iox) when (iox.Message == "stale")
        {
          return Results.Conflict("Stale wizard draft; refresh and re-apply your edit with the current version.");
        }
        catch (Exception ex)
        {
          return SimCEO.Api.Work.CommitOutcome.MapCommitFailure(ex, "Wizard save") ?? Results.Json(new { error = "Wizard save failed; no state changed: " + ex.Message }, statusCode: 500);
        }
        if (wizDenied is not null) return wizDenied;
        if (!s.WizardDrafts.TryGetValue(id, out var saved) || saved is null) return Results.NotFound();
        return Results.Ok(saved);
      }
      finally { sem.Release(); }
    });
    app.MapGet("/api/wizard/{id:guid}", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.WizardDrafts.TryGetValue(id, out var d)) return Results.NotFound();
      if (!WizardGuide.TryWizardUser(s, req, d, out _, out var deniedWg)) return deniedWg;
      var probe = new WizardDraft { InterviewJson = d.InterviewJson };
      WizardGuide.NormalizeInterview(probe);
      if (!string.Equals(probe.InterviewJson ?? "", d.InterviewJson ?? "", StringComparison.Ordinal))
      {
        var normId = d.Id;
        try
        {
          Atomic.Run(s, () =>
          {
            if (!s.WizardDrafts.TryGetValue(normId, out var cur) || cur is null) throw new InvalidOperationException("gone");
            if (!WizardGuide.TryWizardUser(s, req, cur, out _, out _)) throw PeopleOps.AuthFault(s, req);
            // Re-normalize the fresh row: normalization is idempotent, and the
            // unit guarantees no concurrent interview write slips between the
            // read and this save.
            WizardGuide.NormalizeInterview(cur);
            cur.UpdatedAt = DateTime.UtcNow;
            s.WizardDrafts[cur.Id] = cur;
          });
        }
        catch (UnauthorizedAccessException uex) when (uex.Message == "revoked") { return Results.Json(new { error = "Authentication required." }, statusCode: 401); }
        catch (InvalidOperationException iox) when (iox.Message == "security-unavailable") { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
        catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
        catch (InvalidOperationException iox) when (SimCEO.Api.Work.CommitOutcome.IsMissing(iox, "gone")) { return Results.NotFound(); }
        catch (InvalidOperationException iox) { return SimCEO.Api.Work.CommitOutcome.StorageFault("Wizard read", iox); }
        catch (Exception ex) { return SimCEO.Api.Work.CommitOutcome.MapCommitFailure(ex, "Wizard read") ?? Results.Json(new { error = "Wizard read failed: " + ex.Message }, statusCode: 500); }
        if (!s.WizardDrafts.TryGetValue(normId, out var nd) || nd is null) return Results.NotFound();
        return Results.Ok(nd);
      }
      return Results.Ok(d);
    });

    // ---- Voice: draft-first, explicit send; voice never approves/grants ----
    app.MapPost("/api/meetings/{id:guid}/voice", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badVoice) return badVoice;
      if (body.ValueKind != JsonValueKind.Object) return Results.BadRequest("body must be a JSON object.");
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (PeopleOps.Check(s, req, m.BoardId, id, "discuss") is { } deniedVoice) return deniedVoice;
      if (body.TryGetProperty("partial", out var pv) && pv.ValueKind != JsonValueKind.String && pv.ValueKind != JsonValueKind.Null) return Results.BadRequest("partial must be a string.");
      if (body.TryGetProperty("retainAudio", out var rv) && rv.ValueKind != JsonValueKind.True && rv.ValueKind != JsonValueKind.False && rv.ValueKind != JsonValueKind.Null) return Results.BadRequest("retainAudio must be a boolean.");
      var newTurn = new VoiceTurn
      {
        MeetingId = id, State = "draft",
        Transcript = body.TryGetProperty("partial", out var p) && p.ValueKind == JsonValueKind.String ? (p.GetString() ?? "") : "",
        AudioRetained = body.TryGetProperty("retainAudio", out var r) && r.ValueKind == JsonValueKind.True,
      };
      IResult gateErrVd = null;
      try
      {
        Atomic.Run(s, () =>
        {
          if (!s.Meetings.TryGetValue(id, out var cur) || cur is null) { gateErrVd = Results.NotFound("meeting"); return; }
          if (PeopleOps.BadToken(s, req) is not null) { gateErrVd = Results.Json(new { error = "Invalid or expired session token." }, statusCode: 401); return; }
          if (PeopleOps.Check(s, req, cur.BoardId, id, "discuss") is { } deniedVd) { gateErrVd = deniedVd; return; }
          newTurn.BoardId = cur.BoardId;
          newTurn.MeetingId = id;
          newTurn.CreatorKey = PeopleOps.UserOf(s, req);
          s.VoiceTurns[newTurn.Id] = newTurn;
        });
      }
      catch (Exception ex) { return SimCEO.Api.Work.CommitOutcome.MapCommitFailure(ex, "Voice draft") ?? Results.Json(new { error = "Voice draft failed; no state changed: " + ex.Message }, statusCode: 500); }
      if (gateErrVd is not null) return gateErrVd;
      return Results.Created($"/api/voice/{newTurn.Id}", newTurn);
    });
    app.MapPost("/api/voice/{id:guid}/finalize", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (body.ValueKind != JsonValueKind.Object) return Results.BadRequest("body must be a JSON object.");
      if (!s.VoiceTurns.TryGetValue(id, out var t)) return Results.NotFound();
      var finPin = PublicationGuard.Capture(s);
      if (PeopleOps.Check(s, req, t.BoardId, t.MeetingId, "discuss") is { } deniedFin) return deniedFin;
      { var __fu = PeopleOps.UserOf(s, req); var __fmgr = PeopleOps.Can(s, req, t.BoardId, null, "manage"); if (!__fmgr && !string.Equals(t.CreatorKey ?? "", __fu, System.StringComparison.OrdinalIgnoreCase)) return PeopleOps.Denied(); }
      lock (s.MessageLock)
      {
        // Authoritative finalize inside the backend transaction gate: fresh fetch,
        // session + permission + creator check, single state flip, single commit.
        // Unsent drafts are creator-private (no manager bypass); exactly once.
        Message? doneMsg = null;
        IResult? gateErr = null;
        try
        {
        Atomic.Run(s, () =>
        {
          if (!s.VoiceTurns.TryGetValue(id, out var vt) || vt is null) { gateErr = Results.NotFound(); return; }
          if (PeopleOps.BadToken(s, req) is { }) { gateErr = Results.Json(new { error = "Invalid or expired session token." }, statusCode: 401); return; }
          try { PublicationGuard.Check(s, finPin, req, vt.BoardId, vt.MeetingId, "discuss"); }
          catch (Exception finPx) { var finPm = PublicationGuard.MapGuardFailure(finPx); if (finPm is not null) { gateErr = finPm; return; } throw; }
          string vu = "";
          if (PeopleOps.IsSecure(s))
          {
            if (!AuthOps.TrySession(s, req, out var vs)) { gateErr = Results.Json(new { error = "Authentication required." }, statusCode: 401); return; }
            vu = vs;
          }
          else vu = PeopleOps.UserOf(s, req);
          if (PeopleOps.Check(s, req, vt.BoardId, vt.MeetingId, "discuss") is { } deniedV) { gateErr = deniedV; return; }
          if (!string.Equals(vt.CreatorKey ?? "", vu, System.StringComparison.OrdinalIgnoreCase)) { gateErr = PeopleOps.Denied(); return; }
          if (vt.State != "draft") { gateErr = Results.Conflict("Already finalized."); return; }
          if (!s.Meetings.TryGetValue(vt.MeetingId, out var fm) || fm is null) { gateErr = Results.NotFound("meeting"); return; }
          if (fm.BoardId != vt.BoardId) { gateErr = Results.Json(new { error = "Voice turn board/meeting mismatch; restore repair required." }, statusCode: 409); return; }
          if (body.TryGetProperty("transcript", out var x) && x.ValueKind != System.Text.Json.JsonValueKind.String && x.ValueKind != System.Text.Json.JsonValueKind.Null) { gateErr = Results.BadRequest("transcript must be a string."); return; }
          vt.Transcript = body.TryGetProperty("transcript", out var x2) && x2.ValueKind == System.Text.Json.JsonValueKind.String ? (x2.GetString() ?? vt.Transcript) : vt.Transcript;
          vt.State = "sent";
          fm.Generation++;
          if (s.Boards.TryGetValue(vt.BoardId, out var vb) && !vb.RetainAudio) vt.AudioRetained = false;
          var list = s.Messages.GetOrAdd(vt.MeetingId, _ => new List<Message>());
          var msg = new Message
          {
            MeetingId = vt.MeetingId, BoardId = vt.BoardId,
            Sequence = (list.Count == 0 ? 0 : list.Max(m => m.Sequence)) + 1,
            Sender = "lead", Content = vt.Transcript, Status = "committed",
          };
          list.Add(msg);
          fm.DeliveredRevision = msg.Sequence;
          s.VoiceTurns.Flush();
          s.Meetings.Flush();
          doneMsg = msg;
        });
        }
        catch (Exception finEx2) { var finMapped2 = SimCEO.Api.Work.CommitOutcome.MapCommitFailure(finEx2, "Voice finalize"); if (finMapped2 is not null) return finMapped2; throw; }
        if (gateErr is not null) return gateErr;
        return Results.Ok(doneMsg);
      }
    });

    // ---- Sources: governed via SourceEndpoints (single predicate); these are compatibility shims ----
    app.MapPost("/api/boards/{bid:guid}/sources", async (InMemoryStore s, HttpRequest req, Guid bid, SourceDoc d) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badSrc) return badSrc;
      if (!s.Boards.TryGetValue(bid, out var bboard)) return Results.NotFound("Board not found.");
      if (PeopleOps.Check(s, req, bid, null, "contribute") is { } deniedSrcPost) return deniedSrcPost;
      // Public inline creation is always server-owned "upload" provenance: the
      // caller cannot claim wiki origin or any connector identity (P2 #11).
      // Wiki-only policy therefore denies every inline document unconditionally.
      if (SourceGovernance.PolicyModeOf(bboard) == "wikiOnly")
        return Results.Json(new { error = "Board policy is wiki-only; uploads are disabled. Add a Wiki connector resource instead." }, statusCode: 415);
      var fname = string.IsNullOrWhiteSpace(d.FileName) ? "untitled.txt" : d.FileName;
      if (!SourceGovernance.PolicyAllows(bboard, new SourceDoc { FileName = fname, Origin = "upload" }))
        return Results.Json(new { error = "Source type is blocked on this board." }, statusCode: 415);
      var effScope = d.Scope == "meeting" ? "meeting" : "board";
      Guid? effMeeting = effScope == "meeting" ? d.MeetingId : null;
      if (effScope == "meeting")
      {
        if (!effMeeting.HasValue) return Results.BadRequest("meetingId is required for meeting scope.");
        if (!s.Meetings.TryGetValue(effMeeting.Value, out var mmtg) || mmtg.BoardId != bid)
          return Results.Json(new { error = "Meeting does not belong to this board." }, statusCode: 409);
      }
      var familyKey = SourceGovernance.FamilyKeyFor(bid, effScope, effMeeting, "upload", fname);
      // The caller-supplied extraction JSON is untrusted: the server derives
      // content bytes first, then runs actual extraction itself (textual
      // formats decode locally, binary goes to the extractor) under the
      // index reservation. Nothing caller-supplied becomes indexed text.
      var inlineText = Extraction.MarkdownOf(d.ExtractionJson) ?? "";
      var inlineRaw = d.Original ?? (string.IsNullOrEmpty(inlineText) ? Array.Empty<byte>() : Encoding.UTF8.GetBytes(inlineText));
      if (inlineRaw.Length > 10 * 1024 * 1024) return Results.BadRequest("Inline content exceeds 10 MB.");
      // Server-computed content hash over the stored bytes: caller
      // ContentHash is never trusted and is never copied into index sections.
      var serverHash = Convert.ToHexString(SHA256.HashData(inlineRaw)).ToLowerInvariant();
      d.Id = Guid.NewGuid();
      d.BoardId = bid;
      d.FileName = fname;
      d.ContentHash = serverHash;
      d.Origin = "upload";
      d.ResourceId = null;
      d.FamilyKey = familyKey;
      d.Approved = false; d.Excluded = false; d.ReviewState = "pending";
      d.Scope = effScope; d.MeetingId = effMeeting;
      d.IndexState = "queued"; d.IndexGeneration = 0; d.IndexError = ""; d.IndexCompletedAt = null;
      d.ExtractionJson = "{}";
      d.Original = inlineRaw;
      // Allocation AND insertion happen in one serialized transaction so two
      // concurrent creations can never reserve and store the same version.
      SourceDoc? inlineDoc = null;
      string? inlineDup = null;
      string? inlineDenied = null;
      int inlineDeniedStatus = 403;
      lock (s.SetupLock)
      {
        lock (s.MessageLock)
        {
          Atomic.Run(s, () =>
          {
            // Fresh board/scope/caller/policy validation inside the backend
            // unit: revocation, meeting moves, or wiki-only switches between
            // the entry check and insertion fail closed with zero write.
            if (!s.Boards.TryGetValue(bid, out var curBoard) || curBoard is null)
            { inlineDenied = "Board not found."; inlineDeniedStatus = 404; return; }
            if (PeopleOps.Check(s, req, bid, effMeeting, "contribute") is { } deniedIc)
            { inlineDenied = "Access revoked or not granted for this scope."; return; }
            if (SourceGovernance.PolicyModeOf(curBoard) == "wikiOnly")
            { inlineDenied = "Board policy is wiki-only; uploads are disabled. Add a Wiki connector resource instead."; inlineDeniedStatus = 415; return; }
            if (!SourceGovernance.PolicyAllows(curBoard, new SourceDoc { FileName = fname, Origin = "upload" }))
            { inlineDenied = "Source type is blocked on this board."; inlineDeniedStatus = 415; return; }
            if (effScope == "meeting" && (!effMeeting.HasValue
              || !s.Meetings.TryGetValue(effMeeting.Value, out var curMtg) || curMtg.BoardId != bid))
            { inlineDenied = "Meeting does not belong to this board."; inlineDeniedStatus = 409; return; }
            var dupe = s.Sources.Values.FirstOrDefault(x => x.BoardId == bid && x.FamilyKey == familyKey && x.ContentHash == d.ContentHash);
            if (dupe is not null) { inlineDup = $"Identical content already stored as {dupe.Id} (v{dupe.Version})."; return; }
            d.Version = SourceGovernance.ReserveVersion(s, bid, familyKey);
            s.Sources[d.Id] = d;
            s.Sources.Flush();
            SourceGovernance.RecordEvent(s, d, "create", "inline scope=" + effScope);
            inlineDoc = d;
          });
        }
      }
      if (inlineDenied is not null) return Results.Json(new { error = inlineDenied }, statusCode: inlineDeniedStatus);
      if (inlineDoc is null) return Results.Conflict(inlineDup ?? "Identical content already stored.");
      if (!SourceGovernance.TryBeginIndex(s, req, inlineDoc.Id, "contribute", out var inlineRes, out var inlineBeginErr) || inlineRes is null)
        return Results.Json(new { error = inlineBeginErr }, statusCode: 500);
      var inlineExt = await Extraction.ExtractAsync(inlineRaw, fname);
      SourceGovernance.StampExtraction(s, req, inlineRes, Extraction.ToJson(inlineExt), "contribute");
      var (inlineOk, inlineStale, _, inlineErr, inlineStatus) = SourceGovernance.FinishIndex(s, req, inlineRes, false, "contribute");
      if (!inlineOk)
        return Results.Json(new { error = inlineErr, stale = inlineStale }, statusCode: inlineStatus);
      if (!s.Sources.TryGetValue(inlineDoc.Id, out var created) || created is null) return Results.NotFound();
      return Results.Created($"/api/sources/{created.Id}", created);
    });
    app.MapPost("/api/sources/{id:guid}/exclude", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badEx) return badEx;
      var (exOk, exErr, exStatus) = SourceGovernance.SetExcludedById(s, req, id, true); if (!exOk) return Results.Json(new { error = exErr }, statusCode: exStatus); if (!s.Sources.TryGetValue(id, out var exd) || exd is null) return Results.NotFound(); return Results.Ok(exd);
      // (exclude shim returns the fresh row above; auth runs inside the helper)
    });
    // ---- Jobs with idempotency + safe retry ----
    app.MapGet("/api/activity/jobs", (InMemoryStore s, HttpRequest req) =>
    {
      if (PeopleOps.IsSecure(s))
      {
        if (PeopleOps.BadToken(s, req) is { } badJ) return badJ;
        if (!AuthOps.TrySession(s, req, out var ju)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        var admin = PeopleOps.AdminEmail(s);
        var isAdmin = !string.IsNullOrWhiteSpace(admin) && string.Equals(admin, ju, StringComparison.OrdinalIgnoreCase);
        if (!isAdmin) return PeopleOps.Denied();
      }
      return Results.Ok(s.Jobs.Values.OrderByDescending(j => j.UpdatedAt).Take(100));
    });
    app.MapPost("/api/jobs", (InMemoryStore s, HttpRequest req, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badJob) return badJob;
      if (PeopleOps.IsSecure(s))
      {
        if (!AuthOps.TrySession(s, req, out var ju2)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        var admin2 = PeopleOps.AdminEmail(s);
        var isAdmin2 = !string.IsNullOrWhiteSpace(admin2) && string.Equals(admin2, ju2, StringComparison.OrdinalIgnoreCase);
        if (!isAdmin2) return PeopleOps.Denied();
      }
      else if (!PeopleOps.IsOwner(req)) return PeopleOps.Denied();
      // Strict known-kind/target submission: unknown kinds and invalid targets
      // reject BEFORE any job row exists. Canonical payload identity gives
      // same-payload-same-job replay; the same key with a different payload
      // is a 409 conflict, never a silent duplicate.
      if (!Work.JobWorker.TryParseTarget(body, out var target, out var targetErr) || target is null)
        return Results.Json(new { error = targetErr }, statusCode: 422);
      var key = body.TryGetProperty("idempotencyKey", out var kk) && kk.ValueKind == JsonValueKind.String ? (kk.GetString() ?? "") : "";
      if (string.IsNullOrWhiteSpace(key)) return Results.BadRequest("idempotencyKey is required.");
      JobRow? dup = null;
      JobRow? created = null;
      string? submitError = null;
      int submitStatus = 400;
      IResult? submitOutcomeErr = null;
      try
      {
        Atomic.Run(s, () =>
        {
          // Fresh authority inside the unit: a logout/admin-revocation between
          // the entry check and this commit must not let a stale admin submit.
          if (PeopleOps.BadToken(s, req) is not null) throw new UnauthorizedAccessException("revoked");
          if (PeopleOps.IsSecure(s))
          {
            if (!AuthOps.TrySession(s, req, out var juIn)) throw new UnauthorizedAccessException("revoked");
            if (!PeopleOps.IsInstallationAdmin(s, juIn)) throw new UnauthorizedAccessException("denied");
          }
          else if (!PeopleOps.IsOwner(req)) throw new UnauthorizedAccessException("denied");
          // Target must exist and the caller must hold the scope the worker
          // will act under (contribute for index sources, manage for wiki).
          if (target.Kind == "index")
          {
            if (!s.Sources.TryGetValue(target.TargetId, out var tdoc) || tdoc is null) throw new InvalidOperationException("gone");
            if (PeopleOps.Check(s, req, tdoc.BoardId, tdoc.MeetingId, "contribute") is not null) throw new UnauthorizedAccessException("denied-scope");
          }
          else
          {
            if (!s.WikiResources.TryGetValue(target.TargetId, out var twr) || twr is null) throw new InvalidOperationException("gone");
            if (!Work.WikiAuth.CanManageResource(s, req, twr.BoardId, (twr.Scope ?? "board") == "meeting" ? "meeting" : "board", twr.MeetingId)) throw new UnauthorizedAccessException("denied-scope");
          }
          var canonical = Work.JobWorker.CanonicalPayload(target);
          var fp = Work.JobWorker.Fingerprint(canonical);
          var keyed = s.Jobs.Values.FirstOrDefault(x => x.IdempotencyKey == key && !string.IsNullOrWhiteSpace(key));
          if (keyed is not null)
          {
            var keyFp = "";
            try
            {
              using var kd = System.Text.Json.JsonDocument.Parse(string.IsNullOrWhiteSpace(keyed.Payload) ? "{}" : keyed.Payload);
              if (kd.RootElement.TryGetProperty("kind", out var kkv) && kkv.ValueKind == JsonValueKind.String
                && kd.RootElement.TryGetProperty("targetId", out var ktv) && ktv.ValueKind == JsonValueKind.String
                && Guid.TryParse(ktv.GetString(), out var kg))
                keyFp = Work.JobWorker.Fingerprint(Work.JobWorker.CanonicalPayload(new Work.JobWorker.JobTarget((kkv.GetString() ?? "").Trim().ToLowerInvariant(), kg)));
            }
            catch (JsonException) { }
            if (keyFp != fp) throw new InvalidOperationException("conflict");
            dup = keyed;
            return;
          }
          var same = Work.JobWorker.FindSamePayload(s, target);
          if (same is not null) { dup = same; return; }
          var nj = new JobRow
          {
            Id = Guid.NewGuid(),
            IdempotencyKey = key,
            Kind = target.Kind,
            State = "pending",
            Payload = canonical,
            Attempts = 0,
            Error = "",
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
          };
          s.Jobs[nj.Id] = nj;
          Atomic.Audit(s, new AuditEvent { Action = "job.submit", Detail = JsonSerializer.Serialize(new { job = nj.Id, kind = nj.Kind }) });
          created = nj;
        });
      }
      catch (UnauthorizedAccessException uex) when (uex.Message == "revoked") { return Results.Json(new { error = "Authentication required." }, statusCode: 401); }
        catch (InvalidOperationException iox) when (iox.Message == "security-unavailable") { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
        catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
      catch (InvalidOperationException iox) when (iox.Message == "conflict") { return Results.Json(new { error = "Conflicting payload for the same idempotency key." }, statusCode: 409); }
      catch (InvalidOperationException iox) when (SimCEO.Api.Work.CommitOutcome.IsMissing(iox, "gone")) { return Results.NotFound(); }
      catch (InvalidOperationException iox) { return SimCEO.Api.Work.CommitOutcome.StorageFault("Job submission", iox); }
      catch (Exception ex) { submitOutcomeErr = SimCEO.Api.Work.CommitOutcome.MapCommitFailure(ex, "Job submission"); submitError = ex.Message; submitStatus = 500; }
      if (submitOutcomeErr is not null) return submitOutcomeErr;
      if (submitError is not null) return Results.Json(new { error = "Job submission failed; no state changed: " + submitError }, statusCode: submitStatus);
      if (dup is not null) return Results.Ok(dup);
      return Results.Created($"/api/jobs/{created!.Id}", created);
    });

    // ---- Usage + audit + model-call ledger (Phase 9) ----
    app.MapGet("/api/usage", (InMemoryStore s, HttpRequest req, Guid? boardId, Guid? meetingId, string? day, string? from, string? to, string? purpose, string? status, string? allocation, string? summary, int? limit) =>
    {
      if (meetingId.HasValue)
      {
        if (!s.Meetings.TryGetValue(meetingId.Value, out var mtgU)) return Results.NotFound("meeting");
        if (boardId.HasValue && mtgU.BoardId != boardId.Value) return Results.Json(new { error = "board/meeting mismatch." }, statusCode: 400);
        if (!PeopleOps.Can(s, req, mtgU.BoardId, meetingId, "read")) return PeopleOps.Denied();
      }
      else if (boardId.HasValue)
      {
        if (!s.Boards.ContainsKey(boardId.Value)) return Results.NotFound("board");
        if (!PeopleOps.Can(s, req, boardId.Value, null, "read")) return PeopleOps.Denied();
      }
      else
      {
        // Integration adapter (Auth8): global installation views require the
        // installation admin in secure mode; the open demo keeps IsOwner.
        if (PeopleOps.IsSecure(s))
        {
          if (PeopleOps.BadToken(s, req) is { } badUg) return badUg;
          if (!AuthOps.TrySession(s, req, out var ugu)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
          var admUg = PeopleOps.AdminEmail(s);
          if (string.IsNullOrWhiteSpace(admUg) || !string.Equals(admUg, ugu, StringComparison.OrdinalIgnoreCase)) return PeopleOps.Denied();
        }
        else if (!PeopleOps.IsOwner(req)) return PeopleOps.Denied();
      }
      DateOnly? dayD = null, fromD = null, toD = null;
      if (day is not null)
      {
        if (!DateOnly.TryParseExact(day, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var ddp)) return Results.Json(new { error = "Invalid day; expected ISO date YYYY-MM-DD (UTC date)." }, statusCode: 400);
        dayD = ddp;
      }
      if (from is not null)
      {
        if (!DateOnly.TryParseExact(from, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var ffp)) return Results.Json(new { error = "Invalid from; expected ISO date YYYY-MM-DD (UTC date)." }, statusCode: 400);
        fromD = ffp;
      }
      if (to is not null)
      {
        if (!DateOnly.TryParseExact(to, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var ttp)) return Results.Json(new { error = "Invalid to; expected ISO date YYYY-MM-DD (UTC date)." }, statusCode: 400);
        toD = ttp;
      }
      if (fromD.HasValue && toD.HasValue && fromD.Value > toD.Value)
        return Results.Json(new { error = "Invalid range: from must not be after to." }, statusCode: 400);
      var q = s.Usage.AsEnumerable();
      if (meetingId.HasValue) q = q.Where(u => u.MeetingId == meetingId);
      else if (boardId.HasValue) q = q.Where(u => u.BoardId == boardId);
      if (!string.IsNullOrWhiteSpace(purpose)) q = q.Where(u => string.Equals(u.Kind, purpose, StringComparison.OrdinalIgnoreCase));
      if (!string.IsNullOrWhiteSpace(status)) q = q.Where(u => string.Equals(u.Status, status, StringComparison.OrdinalIgnoreCase));
      if (dayD.HasValue)
        q = q.Where(u => DateOnly.FromDateTime(u.At) == dayD.Value);
      if (fromD.HasValue)
        q = q.Where(u => DateOnly.FromDateTime(u.At) >= fromD.Value);
      if (toD.HasValue)
        q = q.Where(u => DateOnly.FromDateTime(u.At) <= toD.Value);
      List<Domain.UsageRow> ordered;
      lock (s.RootGate) { ordered = q.OrderByDescending(u => u.At).ToList(); }
      if (!string.IsNullOrWhiteSpace(allocation))
        ordered = ordered.Where(u => string.Equals(UsageAccounting.AllocationFor(u.BoardId, u.MeetingId, s), allocation, StringComparison.OrdinalIgnoreCase)).ToList();
      var lim = Math.Clamp(limit ?? 500, 1, 2000);
      var wantSummary = string.Equals(summary, "true", StringComparison.OrdinalIgnoreCase) || summary == "1";
      if (!wantSummary) return Results.Ok(ordered.Take(lim));
      var scoped = ordered.Take(lim).ToList();
      var enriched = scoped.Select(u => new
      {
        u.Id, u.Kind, u.Model, u.InputTokens, u.OutputTokens, u.CachedInputTokens, u.SearchCalls,
        u.LatencyMs, u.RanSearch, u.Status, u.ProviderCallId, u.CostBasis, u.Cost,
        u.BoardId, u.MeetingId, u.At, u.Note,
        scope = UsageAccounting.ScopeLabel(u.BoardId, u.MeetingId),
        allocationLabel = UsageAccounting.AllocationFor(u.BoardId, u.MeetingId, s),
        hiddenPurpose = UsageAccounting.IsHiddenPurpose(u.Kind),
        unknownCost = !u.Cost.HasValue,
      }).ToList();
      var storageMode = Pg.Backend is null ? "memory-session-lifetime" : "postgres-durable";
      return Results.Ok(new
      {
        rows = enriched,
        total = ordered.Count,
        returned = enriched.Count,
        scope = meetingId.HasValue ? "meeting" : boardId.HasValue ? "board" : "installation",
        boardId, meetingId,
        summary = UsageAccounting.ScopeSummary(ordered, s),
        pricingBasis = new
        {
          checkedDate = UsageAccounting.PricingCheckedDate,
          pricing = UsageAccounting.PricingDocs,
          searchGrounding = UsageAccounting.SearchDocs,
          speechToText = UsageAccounting.SpeechDocs,
          imageGeneration = UsageAccounting.ImageDocs,
          note = "Costs are ESTIMATES from the pinned basis above, not provider invoices. Unknown models or unobservable units are unknown (Cost null), never fabricated zero. Known 0 only when actually known.",
          storage = storageMode,
        },
        storage = storageMode,
      });
    });
    app.MapGet("/api/activity/audit", (InMemoryStore s, HttpRequest req) =>
    {
      if (PeopleOps.IsSecure(s))
      {
        if (PeopleOps.BadToken(s, req) is { } badAu) return badAu;
        if (!AuthOps.TrySession(s, req, out var au)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        var adminA = PeopleOps.AdminEmail(s);
        var isAdminA = !string.IsNullOrWhiteSpace(adminA) && string.Equals(adminA, au, StringComparison.OrdinalIgnoreCase);
        if (!isAdminA) return PeopleOps.Denied();
      }
      return Results.Ok(s.Audit.OrderByDescending(a => a.CreatedAt).Take(200));
    });

    app.MapGet("/api/models/calls", (InMemoryStore s, HttpRequest req, Guid? boardId, Guid? meetingId, string? purpose, string? status, string? day, string? from, string? to, string? summary, int? limit) =>
    {
      if (meetingId.HasValue)
      {
        if (!s.Meetings.TryGetValue(meetingId.Value, out var mtgC)) return Results.NotFound("meeting");
        if (boardId.HasValue && mtgC.BoardId != boardId.Value) return Results.Json(new { error = "board/meeting mismatch." }, statusCode: 400);
        if (!PeopleOps.Can(s, req, mtgC.BoardId, meetingId, "read")) return PeopleOps.Denied();
      }
      else if (boardId.HasValue)
      {
        if (!s.Boards.ContainsKey(boardId.Value)) return Results.NotFound("board");
        if (!PeopleOps.Can(s, req, boardId.Value, null, "read")) return PeopleOps.Denied();
      }
      else
      {
        // Integration adapter (Auth8): global installation views require the
        // installation admin in secure mode; the open demo keeps IsOwner.
        if (PeopleOps.IsSecure(s))
        {
          if (PeopleOps.BadToken(s, req) is { } badUg) return badUg;
          if (!AuthOps.TrySession(s, req, out var ugu)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
          var admUg = PeopleOps.AdminEmail(s);
          if (string.IsNullOrWhiteSpace(admUg) || !string.Equals(admUg, ugu, StringComparison.OrdinalIgnoreCase)) return PeopleOps.Denied();
        }
        else if (!PeopleOps.IsOwner(req)) return PeopleOps.Denied();
      }
      DateOnly? dayDc = null, fromDc = null, toDc = null;
      if (day is not null)
      {
        if (!DateOnly.TryParseExact(day, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var ddcp)) return Results.Json(new { error = "Invalid day; expected ISO date YYYY-MM-DD (UTC date)." }, statusCode: 400);
        dayDc = ddcp;
      }
      if (from is not null)
      {
        if (!DateOnly.TryParseExact(from, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var ffcp)) return Results.Json(new { error = "Invalid from; expected ISO date YYYY-MM-DD (UTC date)." }, statusCode: 400);
        fromDc = ffcp;
      }
      if (to is not null)
      {
        if (!DateOnly.TryParseExact(to, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var ttcp)) return Results.Json(new { error = "Invalid to; expected ISO date YYYY-MM-DD (UTC date)." }, statusCode: 400);
        toDc = ttcp;
      }
      if (fromDc.HasValue && toDc.HasValue && fromDc.Value > toDc.Value)
        return Results.Json(new { error = "Invalid range: from must not be after to." }, statusCode: 400);
      var qc = s.ModelCalls.AsEnumerable();
      if (meetingId.HasValue) qc = qc.Where(c => c.MeetingId == meetingId);
      else if (boardId.HasValue) qc = qc.Where(c => c.BoardId == boardId);
      if (!string.IsNullOrWhiteSpace(purpose)) qc = qc.Where(c => string.Equals(c.Purpose, purpose, StringComparison.OrdinalIgnoreCase));
      if (!string.IsNullOrWhiteSpace(status)) qc = qc.Where(c => string.Equals(c.Status, status, StringComparison.OrdinalIgnoreCase));
      if (dayDc.HasValue)
        qc = qc.Where(c => DateOnly.FromDateTime(c.At) == dayDc.Value);
      if (fromDc.HasValue)
        qc = qc.Where(c => DateOnly.FromDateTime(c.At) >= fromDc.Value);
      if (toDc.HasValue)
        qc = qc.Where(c => DateOnly.FromDateTime(c.At) <= toDc.Value);
      List<ModelCall> orderedc;
      lock (s.RootGate) { orderedc = qc.OrderByDescending(c => c.At).ToList(); }
      var limc = Math.Clamp(limit ?? 200, 1, 2000);
      var wantSummaryc = string.Equals(summary, "true", StringComparison.OrdinalIgnoreCase) || summary == "1";
      if (!wantSummaryc) return Results.Ok(orderedc.Take(limc));
      var scopedc = orderedc.Take(limc).ToList();
      var storageModec = Pg.Backend is null ? "memory-session-lifetime" : "postgres-durable";
      return Results.Ok(new
      {
        rows = scopedc.Select(c => new
        {
          c.Id, c.Model, c.Purpose, c.InputTokens, c.OutputTokens, c.CachedInputTokens,
          c.LatencyMs, c.RanSearch, c.SearchCalls, c.ProviderCallId, c.Status, c.Cost, c.CostBasis,
          c.BoardId, c.MeetingId, c.SearchNote, c.At,
          scope = UsageAccounting.ScopeLabel(c.BoardId, c.MeetingId),
          allocationLabel = UsageAccounting.AllocationFor(c.BoardId, c.MeetingId, s),
          hiddenPurpose = UsageAccounting.IsHiddenPurpose(c.Purpose),
          unknownCost = !c.Cost.HasValue,
        }).ToList(),
        total = orderedc.Count,
        returned = Math.Min(limc, orderedc.Count),
        scope = meetingId.HasValue ? "meeting" : boardId.HasValue ? "board" : "installation",
        boardId, meetingId,
        storage = storageModec,
        pricingBasis = new
        {
          checkedDate = UsageAccounting.PricingCheckedDate,
          pricing = UsageAccounting.PricingDocs,
          searchGrounding = UsageAccounting.SearchDocs,
          speechToText = UsageAccounting.SpeechDocs,
          imageGeneration = UsageAccounting.ImageDocs,
          note = "Costs are ESTIMATES, not provider invoices. Unknown costs are null.",
          storage = storageModec,
        },
      });
    });

    // ---- Meeting controls ----
    foreach (var (path, state) in new[] { ("pause", MeetingState.Paused), ("resume", MeetingState.Active), ("end", MeetingState.WrappingUp) })
      app.MapPost($"/api/meetings/{{id:guid}}/{path}", (InMemoryStore s, HttpRequest req, Guid id) =>
      {
        if (PeopleOps.BadToken(s, req) is { } badCtl) return badCtl;
        if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound();
        if (PeopleOps.Check(s, req, m.BoardId, id, "manage") is { } deniedCtl) return deniedCtl;
        try
        {
          Atomic.Run(s, () =>
          {
            if (!s.Meetings.TryGetValue(id, out var cur)) throw new InvalidOperationException("Meeting is gone.");
            if (PeopleOps.Check(s, req, cur.BoardId, id, "manage") is not null) throw PeopleOps.AuthFault(s, req);
            cur.State = state;
            cur.Generation++;
            s.Meetings[cur.Id] = cur;
            Atomic.Audit(s, new AuditEvent { BoardId = cur.BoardId, Action = "meeting." + path, Detail = System.Text.Json.JsonSerializer.Serialize(new { meeting = id }) });
          });
        }
        catch (UnauthorizedAccessException uex) when (uex.Message == "revoked") { return Results.Json(new { error = "Authentication required." }, statusCode: 401); }
        catch (InvalidOperationException iox) when (iox.Message == "security-unavailable") { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
        catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
        catch (InvalidOperationException iox) when (SimCEO.Api.Work.CommitOutcome.IsMissing(iox, "Meeting is gone.")) { return Results.NotFound(); }
        catch (InvalidOperationException iox) { return SimCEO.Api.Work.CommitOutcome.StorageFault("Meeting control", iox); }
        catch (Exception ex) { return SimCEO.Api.Work.CommitOutcome.MapCommitFailure(ex, "Meeting control") ?? Results.Json(new { error = "Meeting control failed; no state changed: " + ex.Message }, statusCode: 500); }
        if (!s.Meetings.TryGetValue(id, out var done) || done is null) return Results.NotFound();
        return Results.Ok(done);
      });

    // ---- Discussion: orchestrator -> parallel immediate replies -> one peer-review wave ----
    app.MapPost("/api/meetings/{id:guid}/run", async (InMemoryStore s, IHubContext<BoardHub> hub, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (PeopleOps.Check(s, req, m.BoardId, id, "discuss") is { } deniedRun) return deniedRun;
      if (PeopleOps.Guard(gw, req) is { } cappedRun) return cappedRun;
      lock (s.MessageLock)
      {
        if (!s.RunningRuns.Add(id))
          return Results.Conflict("A discussion run is already in progress for this meeting; wait for it to finish.");
      }
      Guid activityOpId = Guid.Empty;
      using var runCancel = CancellationTokenSource.CreateLinkedTokenSource(req.HttpContext.RequestAborted);
      using var draftSem = new SemaphoreSlim(10);
      var inFlightDrafts = new List<Task<(BoardAdvisor adv, string? text, CuratorManifest? manifest, string? error)>>();
      try
      {
      // Finding 2: the authoritative context and the restore pin are captured
      // together inside one root boundary (TryCaptureDiscussionContext above)
      // BEFORE any dependent read, eligibility decision, or bookkeeping write.
      // The snapshots below are carried unchanged through every async branch;
      // live re-reads happen only inside commit units that compare against
      // them. A restore before the capture is fully described by the fresh
      // context; a restore after it fails the pin at the first pin-checked
      // bookkeeping write (stale run rejected before any domain write).
      var prompt = body.TryGetProperty("prompt", out var q) ? (q.GetString() ?? "") : "";
      if (!TryCaptureDiscussionContext(s, id, m, body, req, out var dx, out var dxError)) return dxError;
      m = dx!.Meeting;
      var policy = dx.Policy;
      var lead = dx.Lead;
      var leadVersion = dx.LeadVersion;
      var leadFingerprint = dx.LeadFingerprint;
      var eligible = dx.Eligible;
      var yielded = dx.Yielded;
      var pickedCount = dx.PickedCount;
      var spark = dx.Spark;
      var publishPin = dx.PublishPin;
      var epochBefore = dx.EpochBefore;
      var restoreBefore = dx.RestoreBefore;
      var gen = dx.Gen;
      var dirBefore = dx.DirBefore;
      var effBefore = dx.EffBefore;
      var leadFloor = dx.LeadFloor;
      var invitedIds = dx.InvitedIds;
      var laneBPrints = dx.LaneBPrints;
      var boardNameBefore = dx.BoardNameBefore;
      var boardMissionBefore = dx.BoardMissionBefore;
      var boardStageBefore = dx.BoardStageBefore;
      string LaneBFingerprint(BoardAdvisor laneBAdv) => RosterOps.ReviewedInputFingerprint(s, laneBAdv);
      var effectiveCap = dx.EffectiveCap;
      var priorCapNoteId = dx.PriorCapNoteId;
      Board? board = dx.RunBoard;
      if (body.TryGetProperty("leadVersion", out var lv) && lv.ValueKind == JsonValueKind.Number
          && lv.GetInt32() != leadVersion)
        return Results.Conflict("Lead profile changed; refresh and retry with the current version.");
      { MeetingState preState = m.State; try { if (s.Meetings.TryGetValue(id, out var preMtg) && preMtg is not null) preState = preMtg.State; } catch { } if (preState == MeetingState.Paused)
        return Results.Conflict("Meeting is paused; resume to run discussion."); }
      if (eligible.Count == 0)
        return Results.Json(new { error = "No advisors available for discussion.", fixes = pickedCount > 0 ? new[] { "Re-pick participants from this board's current advisors." } : new[] { "Approve at least one advisor on this board before running discussion." }, yielded }, statusCode: 409);
      activityOpId = Guid.NewGuid();
      MeetingActivity.DiscussionStarted(s, id, m.BoardId, activityOpId, gen, leadFloor, eligible, dx.RestoreBefore);
      _ = MeetingActivity.PublishDiscussionAsync(hub, s, id);
      var ownerOverride = PeopleOps.IsOwner(req);
      var capBody = JsonSerializer.Serialize(new { leadSeq = leadFloor, cap = effectiveCap, policy });
      try
      {
      Atomic.Run(s, () =>
      {
          PublicationGuard.Check(s, publishPin, req, m.BoardId, id, "discuss");
          var capBoard = m.BoardId;
          if (s.Meetings.TryGetValue(id, out var capMtg) && capMtg is not null) capBoard = capMtg.BoardId;
          if (priorCapNoteId != Guid.Empty && s.Notes.TryGetValue(priorCapNoteId, out var priorCapNote))
          {
            priorCapNote.Body = capBody;
            s.Notes[priorCapNoteId] = priorCapNote;
          }
          else
          {
            var freshCapNote = new Note { BoardId = capBoard, MeetingId = id, Kind = "run-cap", Scope = "meeting", Provisional = false, Title = "cap:" + leadFloor, Body = capBody, RootId = Guid.Empty, Revision = 1, PredecessorId = null, NoteStatus = "current" };
            freshCapNote.RootId = freshCapNote.Id;
            s.Notes[freshCapNote.Id] = freshCapNote;
          }
          s.Notes.Flush();
      });
      }
      catch (Exception capEx) { var capMapped = PublicationGuard.MapGuardFailure(capEx); if (capMapped is not null) return capMapped; throw; }
      int CommittedThisTurn()
      {
        lock (s.MessageLock)
          return s.Messages.TryGetValue(id, out var cl) && cl is not null
            ? cl.Where(x => x.AdvisorId != Guid.Empty && x.Sequence > leadFloor).Select(x => x.AdvisorId).Distinct().Count() : 0;
      }
      // P3: deferred network publication only. SyncRoundCommit (synchronous activity state) runs
      // INSIDE SetupLock/MessageLock + Atomic unit immediately after the successful commit, while
      // still holding the outer ROOT aliases; ONLY async network PublishDiscussionAsync is deferred
      // until after all ROOT exit. Never Task.Run/delay/yield inside ROOT, never Hub->Root inversion
      // (recipient path releases HubGate before acquiring ROOT for per-recipient auth), never rollback-event
      // publish (throw skips flag set; finalizer interruption after rollback is retained).
      bool __deferredActivityPublish = false;
      // Lane B: declared before bidding so every interruption path reports accurate yields/counts.
      var published = new List<Message>();
      var manifests = new List<object>();
      var abstained = new List<string>();
      var bidErrors = new List<object>();
      object? overflow = null;
      var outcome = new Note
      {
        BoardId = m.BoardId, MeetingId = id, Kind = "run-outcome", Scope = "meeting", Provisional = true,
        Title = "Run in progress",
        Body = JsonSerializer.Serialize(new { policy, leadVersion, generation = gen, revision = m.DeliveredRevision, rounds = 0, published = 0, leadSeq = leadFloor, cap = effectiveCap }),
      };
      try
      {
      Atomic.Run(s, () =>
      {
        PublicationGuard.Check(s, publishPin, req, m.BoardId, id, "discuss");
        s.Notes[outcome.Id] = outcome;
        s.Notes.Flush();
      });
      }
      catch (Exception initEx) { var initMapped = PublicationGuard.MapGuardFailure(initEx); if (initMapped is not null) return initMapped; throw; }
      var completedGroups = 0;
      long LaneBRevision()
      {
        lock (s.MessageLock)
        {
          if (s.Messages.TryGetValue(id, out var laneBList) && laneBList is not null && laneBList.Count > 0)
            return laneBList.Max(x => x.Sequence);
          return m.DeliveredRevision;
        }
      }
      // Lane B: every interrupted return updates the initial in-progress outcome into a terminal one.
      IResult LaneBFail(string laneBReason, int laneBPlannedRounds, List<string> laneBRemaining)
      {
        // Pin + authority BEFORE touching bookkeeping: a restore or a lost
        // grant between dispatch and this interruption discards the stale
        // outcome write instead of recreating it. The check runs under the
        // root gate (and inside the outer publication unit when nested), so
        // it is authoritative for the write below.
        try { PublicationGuard.Check(s, publishPin, req, m.BoardId, id, "discuss"); }
        catch (Exception laneBPreEx) { var laneBPreMapped = PublicationGuard.MapGuardFailure(laneBPreEx); if (laneBPreMapped is not null) return laneBPreMapped; throw; }
        try { MeetingActivity.FinishDiscussion(s, id, activityOpId, "interrupted", laneBReason); if (System.Threading.Monitor.IsEntered(s.RootGate)) { __deferredActivityPublish = true; } else { _ = MeetingActivity.PublishDiscussionAsync(hub, s, id); } } catch { }
        var laneBRev = LaneBRevision();
        var laneBTitle = "Run interrupted: " + laneBReason;
        var laneBBody = JsonSerializer.Serialize(new { policy, leadVersion, generation = gen, revision = laneBRev, rounds = laneBPlannedRounds, completedGroups, published = published.Count, yielded, abstained, bidErrorCount = bidErrors.Count, overflow, status = "interrupted", reason = laneBReason, remaining = laneBRemaining });
        IResult? laneBWriteErr = null;
        try
        {
        Atomic.Run(s, () =>
        {
          PublicationGuard.Check(s, publishPin, req, m.BoardId, id, "discuss");
          if (!s.Notes.TryGetValue(outcome.Id, out var laneBCur) || laneBCur is null) throw new InvalidOperationException("gone");
          laneBCur.Title = laneBTitle;
          laneBCur.Body = laneBBody;
          s.Notes[laneBCur.Id] = laneBCur;
          s.Notes.Flush();
        });
        }
        catch (Exception laneBWEx) { laneBWriteErr = PublicationGuard.MapGuardFailure(laneBWEx); if (laneBWriteErr is null) throw; }
        if (laneBWriteErr is not null) return laneBWriteErr;
        return Results.Conflict("Interrupted: " + laneBReason + "; partial progress preserved in run outcome.");
      }
      (BoardAdvisor adv, double score, string text, string? error)[] bidResults;
      try
      {
        string selectionPacket;
        lock (s.RootGate)
        {
          foreach (var adv in eligible) CheckPacketFreshnessLocked(s, req, dx, m, adv);
          selectionPacket = AdvisorDialogue.SelectionPacket(s, m, board, lead, eligible, prompt);
        }
        var selectionText = await gw.CompleteAsync(spark, "advisor-select", selectionPacket,
          AdvisorDialogue.SelectionTokens, 2048, runCancel.Token, ownerOverride: ownerOverride, boardId: m.BoardId, meetingId: id, truncatePrompt: false);
        var selected = AdvisorDialogue.Selected(selectionText, eligible);
        var explicitRequests = new HashSet<Guid>();
        lock (s.RootGate)
        {
          foreach (var adv in eligible)
          {
            CheckPacketFreshnessLocked(s, req, dx, m, adv);
            var name = s.Roster.TryGetValue(adv.RosterEntryId, out var entry) ? entry.Name : adv.BoardRole;
            if (AdvisorDialogue.ExplicitlyRequested(prompt + "\n" + ContextCurator.LatestLeadMessage(s, id), name, adv.BoardRole))
            { selected.Add(adv.Id); explicitRequests.Add(adv.Id); }
          }
        }
        bidResults = eligible.Select(a => (a, score: selected.Contains(a.Id) ? (explicitRequests.Contains(a.Id) ? 100.0 : 10.0) : 0.0,
          text: selected.Contains(a.Id) ? "orchestrator-selected" : "not-selected", error: (string?)null)).ToArray();
        MeetingActivity.SelectionFinished(id, activityOpId);
      }
      catch (Exception ex) when (ex is not OperationCanceledException)
      {
        if (ex is ContextCurator.EssentialBudgetExceededException)
        {
          LaneBFail("advisor selection context is too large", 0, eligible.Select(a => a.BoardRole).ToList());
          return Results.Json(new { error = ex.Message }, statusCode: 413);
        }
        if (ex is InvalidOperationException && ex.Message is "lead-changed" or "roster-changed" or "generation-changed" or "board-changed" or "source-changed" or "directions-changed" or "records-changed")
          return LaneBFail(ex.Message == "lead-changed" ? "lead profile changed; refresh and retry with the current version" : "context changed during advisor selection; refresh and retry", 0, eligible.Select(a => a.BoardRole).ToList());
        MeetingActivity.FinishDiscussion(s, id, activityOpId, "failed", "Advisor selection failed; retry responses.");
        _ = MeetingActivity.PublishDiscussionAsync(hub, s, id);
        var interrupted = LaneBFail("advisor selection failed", 0, eligible.Select(a => a.BoardRole).ToList());
        return PublicationGuard.MapGuardFailure(ex) ?? (ex is ProviderException or CapExceededException ? PeopleOps.ModelError(ex) : Results.Json(new { error = "Could not select advisors. Retry responses; your question is saved." }, statusCode: 502));
      }
      catch (OperationCanceledException)
      {
        LaneBFail("advisor selection cancelled", 0, eligible.Select(a => a.BoardRole).ToList());
        return Results.StatusCode(499);
      }
      { long freshGenAfterBid = gen; MeetingState freshStateAfterBid = MeetingState.Active; try { if (s.Meetings.TryGetValue(id, out var freshAfterBid) && freshAfterBid is not null) { freshGenAfterBid = freshAfterBid.Generation; freshStateAfterBid = freshAfterBid.State; } } catch { }
      if (freshStateAfterBid is not (MeetingState.Active or MeetingState.AwaitingBrief))
      {
        var laneBRemainStateAfterBid = eligible.Where(a => !published.Any(p => p.AdvisorId == a.Id)).Select(a => a.BoardRole).ToList();
        return LaneBFail("meeting state changed; unsent drafts discarded", 0, laneBRemainStateAfterBid);
      }
      if (freshGenAfterBid != gen || MeetingTurns.LeadSeqAfter(s, id, leadFloor) > leadFloor)
      {
        var laneBRemainAfterBid = eligible.Where(a => !published.Any(p => p.AdvisorId == a.Id)).Select(a => a.BoardRole).ToList();
        return LaneBFail("new owner turn arrived; unsent drafts discarded", 0, laneBRemainAfterBid);
      } }
      var bidScores = bidResults.ToDictionary(b => b.adv.Id, b => b.score);
      var willing = eligible.Where(a => bidScores.TryGetValue(a.Id, out var sc) && sc > 0).ToList();
      // Lane B: enforce the durable per-lead minimum before selection and again at commit.
      var turnCap = effectiveCap;
      var alreadyIds = new HashSet<Guid>();
      lock (s.MessageLock)
      {
        if (s.Messages.TryGetValue(id, out var al) && al is not null)
          foreach (var x in al.Where(x => x.AdvisorId != Guid.Empty && x.Sequence > leadFloor))
            alreadyIds.Add(x.AdvisorId);
      }
      foreach (var a in willing.Where(a => alreadyIds.Contains(a.Id)))
        yielded.Add(new { advisor = a.BoardRole, reason = "already-replied-this-turn" });
      var freshWilling = willing.Where(a => !alreadyIds.Contains(a.Id)).ToList();
      var roundsAll = DiscussionPolicy.SelectRounds(policy, freshWilling, a => bidScores.TryGetValue(a.Id, out var sc) ? sc : 0.0);
      var rounds = new List<List<BoardAdvisor>>();
      {
        var room = Math.Max(0, turnCap - CommittedThisTurn());
        foreach (var grp in roundsAll)
        {
          if (room <= 0) break;
          var take = grp.Take(room).ToList();
          if (take.Count > 0) rounds.Add(take);
          room -= take.Count;
        }
      }
      var selectedIds = new HashSet<Guid>(rounds.SelectMany(r => r).Select(a => a.Id));
      var omitted = freshWilling.Where(a => !selectedIds.Contains(a.Id)).Select(a => a.BoardRole).ToList();
      overflow = omitted.Count == 0 ? null : new { omitted, cap = turnCap, policy };
      foreach (var o in omitted) yielded.Add(new { advisor = o, reason = "cap-omitted" });
      abstained.AddRange(bidResults.Where(b => b.score <= 0).Select(b => b.adv.BoardRole));
      bidErrors.AddRange(bidResults.Where(b => b.error is not null).Select(b => new { advisor = b.adv.BoardRole, error = b.error }));
      foreach (var b in bidResults.Where(b => b.error is not null)) yielded.Add(new { advisor = b.adv.BoardRole, reason = "provider-error" });
      foreach (var b in bidResults.Where(b => b.score <= 0 && b.error is null)) yielded.Add(new { advisor = b.adv.BoardRole, reason = "bid-declined" });
      try { MeetingActivity.SyncSelection(id, activityOpId, bidResults.Select(b => (b.adv.Id, b.adv.BoardRole, b.score, b.error)).ToList(), selectedIds, alreadyIds); _ = MeetingActivity.PublishDiscussionAsync(hub, s, id); } catch { }
      var firstWave = rounds.SelectMany(r => r).ToList();
      rounds = firstWave.Select(a => new List<BoardAdvisor> { a }).ToList();
      string? lastChallenged = null;
      var firstReplies = new List<Message>();
      for (var wave = 0; wave < 2; wave++)
      {
        var followup = wave == 1;
        List<BoardAdvisor> waveAdvisors;
        if (!followup) waveAdvisors = firstWave;
        else
        {
          lock (s.RootGate)
          {
            var turnMessages = s.Messages.TryGetValue(id, out var stored) ? stored.Where(x => x.AdvisorId != Guid.Empty && x.Sequence > leadFloor).ToList() : new List<Message>();
            firstReplies = turnMessages.GroupBy(x => x.AdvisorId).Select(g => CloneDetached(g.OrderBy(x => x.Sequence).First())).ToList();
            waveAdvisors = firstReplies.Count < 2 ? new List<BoardAdvisor>() : eligible.Where(a =>
              turnMessages.Count(x => x.AdvisorId == a.Id) == 1 && (selectedIds.Contains(a.Id) || alreadyIds.Contains(a.Id))).ToList();
          }
          if (waveAdvisors.Count > 0)
          {
            rounds.AddRange(waveAdvisors.Select(a => new List<BoardAdvisor> { a }));
            MeetingActivity.ReviewStarted(id, activityOpId, waveAdvisors);
            _ = MeetingActivity.PublishDiscussionAsync(hub, s, id);
          }
        }
        var waveFinished = new HashSet<Guid>();
        List<string> WaveRemaining() => waveAdvisors.Where(a => !waveFinished.Contains(a.Id)).Select(a => a.BoardRole).ToList();
        var reviewContext = followup ? AdvisorDialogue.ReviewContext(firstReplies) : null;
        inFlightDrafts.Clear();
        inFlightDrafts.AddRange(waveAdvisors.Select(async adv =>
        {
          await draftSem.WaitAsync(runCancel.Token);
          try { MeetingActivity.SetAdvisor(id, activityOpId, adv.Id, adv.BoardRole, "responding", null); _ = MeetingActivity.PublishDiscussionAsync(hub, s, id); } catch { }
          try
          {
            string packet;
            CuratorManifest? manifest;
            try { var built = BuildDiscussionPacketPinned(s, req, dx, m, adv, prompt, board, lead, reviewContext); packet = built.packet; manifest = built.manifest; }
            catch (Exception pktEx) { try { MeetingActivity.SetAdvisor(id, activityOpId, adv.Id, adv.BoardRole, "failed", "provider-error"); _ = MeetingActivity.PublishDiscussionAsync(hub, s, id); } catch { } return (adv, text: (string?)null, manifest: (CuratorManifest?)null, error: (string?)pktEx.Message); }
            var text = await gw.CompleteAsync(spark, "advisor-reply",
              packet + ContextCurator.AdvisorReplySuffix,
              followup ? ContextBudget.MaxTokens : ContextBudget.DraftTokens, 2048, runCancel.Token, ownerOverride: ownerOverride, boardId: m.BoardId, meetingId: id, truncatePrompt: false);
            try
            {
              if (string.IsNullOrWhiteSpace(text) || text.TrimStart().StartsWith("ABSTAIN", StringComparison.OrdinalIgnoreCase)) MeetingActivity.SetAdvisor(id, activityOpId, adv.Id, adv.BoardRole, "abstained", "abstained");
              else MeetingActivity.SetAdvisor(id, activityOpId, adv.Id, adv.BoardRole, "awaiting-publication", null);
              _ = MeetingActivity.PublishDiscussionAsync(hub, s, id);
            }
            catch { }
            return (adv, text: (string?)text, manifest: (CuratorManifest?)manifest, error: (string?)null);
          }
          catch (OperationCanceledException) when (runCancel.IsCancellationRequested) { throw; }
          catch (Exception ex) when (ex is CapExceededException or ProviderException or TaskCanceledException or HttpRequestException or JsonException)
          {
            try { MeetingActivity.SetAdvisor(id, activityOpId, adv.Id, adv.BoardRole, "failed", "provider-error"); _ = MeetingActivity.PublishDiscussionAsync(hub, s, id); } catch { } return (adv, text: (string?)null, manifest: (CuratorManifest?)null, error: (string?)ex.Message);
          }
          finally { draftSem.Release(); }
        }));
        var pendingDrafts = inFlightDrafts.ToList();
        while (pendingDrafts.Count > 0)
        {
        var finished = await Task.WhenAny(pendingDrafts);
        pendingDrafts.Remove(finished);
        (BoardAdvisor adv, string? text, CuratorManifest? manifest, string? error) draft;
        try { draft = await finished; }
        catch (OperationCanceledException) { return LaneBFail("response run cancelled", rounds.Count, WaveRemaining()); }
        var drafts = new[] { draft };
        var round = new List<BoardAdvisor> { draft.adv };
        try { MeetingActivity.SyncDraftOutcome(id, activityOpId, drafts.Select(d => (d.adv.Id, d.adv.BoardRole, d.text, d.error)).ToList()); _ = MeetingActivity.PublishDiscussionAsync(hub, s, id); } catch { }
        { long freshGenBetween = gen; try { if (s.Meetings.TryGetValue(id, out var freshBetween) && freshBetween is not null) freshGenBetween = freshBetween.Generation; } catch { }
        if (freshGenBetween != gen || MeetingTurns.LeadSeqAfter(s, id, leadFloor) > leadFloor)
        {
          var laneBRemainBetween = WaveRemaining();
          return LaneBFail("new owner turn arrived; unsent drafts discarded", rounds.Count, laneBRemainBetween);
        } }
        // Lane B: final publication holds SetupLock THEN MessageLock (roster writers serialize on
        // SetupLock; pause/resume/end/close use MessageLock only, so this order never inverts).
        // Meeting, advisor and roster rows are fresh-fetched here; captured generation, lead sequence,
        // allowed state and reviewed-input fingerprints are compared immediately before commit.
        int __actPub0 = published.Count;
        int __actY0 = yielded.Count;
        IResult? __roundGateOuter = null;
        lock (s.SetupLock)
        {
          lock (s.MessageLock)
          {
            // Authoritative commit inside the actual backend transaction gate: fetch, authorize,
            // validate and mutate here so a concurrent failed transaction cannot detach our objects.
            IResult? laneBGate = null;
            Atomic.Run(s, () =>
            {
            List<string> LaneBRemaining() => WaveRemaining();
            if (!s.Meetings.TryGetValue(id, out var cur) || cur.State is not (MeetingState.Active or MeetingState.AwaitingBrief))
              { laneBGate = LaneBFail("meeting state changed; unsent drafts discarded", rounds.Count, LaneBRemaining()); return; }
            if (cur.Generation != gen || MeetingTurns.LeadSeqAfter(s, id, leadFloor) > leadFloor)
              { laneBGate = LaneBFail("new owner turn arrived; unsent drafts discarded", rounds.Count, LaneBRemaining()); return; }
              // Re-authorize AFTER the model await: a caller revoked or expired during
              // generation must not publish (Auth8 publication boundary).
              { var __tok2 = ""; try { var __ah2 = req.Headers["Authorization"].ToString(); if (__ah2.StartsWith("Bearer ", System.StringComparison.OrdinalIgnoreCase)) __tok2 = __ah2["Bearer ".Length..].Trim(); } catch { } string __em2 = ""; bool __sessOk2 = false; try { if (!string.IsNullOrEmpty(__tok2) && s.Sessions.TryGetValue(__tok2, out var __ss2) && __ss2.ExpiresAt > System.DateTime.UtcNow) { __sessOk2 = true; __em2 = __ss2.Email; } } catch { } if (string.IsNullOrEmpty(__em2)) { try { __em2 = PeopleOps.UserOf(s, req); } catch { } } if (PeopleOps.IsSecure(s) && !__sessOk2) { laneBGate = LaneBFail("session revoked or expired; publication refused", rounds.Count, LaneBRemaining()); return; } try { var __have2 = PeopleOps.AccessFor(s, cur.BoardId, id, __em2); bool __ok2 = PeopleOps.IsSecure(s) ? (__have2 is "manage" or "contribute" or "discuss") : (__have2 == "open" || __have2 is "manage" or "contribute" or "discuss"); if (!__ok2) { laneBGate = LaneBFail("access revoked; publication refused", rounds.Count, LaneBRemaining()); return; } } catch { laneBGate = LaneBFail("security unavailable; publication refused", rounds.Count, LaneBRemaining()); return; } }
              if (s.SourceEpoch != epochBefore)
                { laneBGate = LaneBFail("source evidence changed during generation; unsent drafts discarded", rounds.Count, LaneBRemaining()); return; }
              if (s.RestoreEpochId != restoreBefore)
                { laneBGate = LaneBFail("domain was restored during generation; unsent drafts discarded", rounds.Count, LaneBRemaining()); return; }
              if (!string.Equals(DiscussionDirFingerprint(s, cur.BoardId, id), dirBefore, StringComparison.Ordinal))
                { laneBGate = LaneBFail("adopted directions changed during generation; unsent drafts discarded", rounds.Count, LaneBRemaining()); return; }
              if (!string.Equals(DiscussionEffFingerprint(s, cur.BoardId, id), effBefore, StringComparison.Ordinal))
                { laneBGate = LaneBFail("approved record context changed during generation; unsent drafts discarded", rounds.Count, LaneBRemaining()); return; }
            var curLead = s.Boards.TryGetValue(cur.BoardId, out var curBoard) ? LeadSetup.ResolveLeadForBoard(s, curBoard) : LeadSetup.ResolveLeadFor(s, cur.BoardId);
            var curLeadVersion = curLead?.Version ?? 0;
            if (curLeadVersion != leadVersion
                || !string.Equals(LeadIdentityFingerprint(curLead), leadFingerprint, StringComparison.Ordinal))
              { laneBGate = LaneBFail("lead profile changed; refresh and retry with the current version", rounds.Count, LaneBRemaining()); return; }
            var policyNow = EffectiveDiscussionPolicy(s, cur.BoardId);
            if (!string.Equals(policyNow, policy, StringComparison.Ordinal)) { laneBGate = LaneBFail("discussion policy changed; refresh and retry with the current version", rounds.Count, LaneBRemaining()); return; }
            // Narrow board-content compare from the detached capture: the packet
            // embeds the effective name/mission/stage, so a committed board edit
            // during generation must discard instead of publishing stale content.
            // A failed board PATCH that rolled back leaves live content equal to
            // the capture, so it does not discard.
            { string freshName = ""; string freshMission = ""; string freshStage = "";
              try { if (s.Boards.TryGetValue(cur.BoardId, out var freshBoard) && freshBoard is not null) { var fv = LeadSetup.EffectiveView(s, freshBoard); freshName = fv.name ?? ""; freshMission = fv.mission ?? ""; freshStage = fv.stage ?? ""; } } catch { }
              if (!string.Equals(freshName, boardNameBefore, StringComparison.Ordinal) || !string.Equals(freshMission, boardMissionBefore, StringComparison.Ordinal) || !string.Equals(freshStage, boardStageBefore, StringComparison.Ordinal))
                { laneBGate = LaneBFail("board content changed during generation; unsent drafts discarded", rounds.Count, LaneBRemaining()); return; } }
            // Lane B: re-derive the durable minimum at commit; it can only stay equal or shrink.
            var commitCap = effectiveCap;
            foreach (var capNote in s.Notes.Values.Where(n => n.MeetingId == id && n.Kind == "run-cap").ToList())
            {
              try
              {
                using var capDoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(capNote.Body) ? "{}" : capNote.Body);
                if (capDoc.RootElement.TryGetProperty("leadSeq", out var capSeq) && capSeq.ValueKind == JsonValueKind.Number
                  && capSeq.GetInt64() == leadFloor
                  && capDoc.RootElement.TryGetProperty("cap", out var capVal) && capVal.ValueKind == JsonValueKind.Number
                  && capVal.TryGetInt32(out var capInt))
                  commitCap = Math.Min(commitCap, capInt);
              }
              catch (JsonException) { }
            }
            var list = s.Messages.GetOrAdd(id, _ => new List<Message>());
            var next = list.Count == 0 ? 0 : list.Max(x => x.Sequence);
            var room = Math.Max(0, commitCap * 2 - list.Count(x => x.AdvisorId != Guid.Empty && x.Sequence > leadFloor));
            var batch = new List<Message>();
            foreach (var (adv, text, manifest, error) in drafts)
            {
              if (text is null || error is not null) { var why = error is string emStale && (emStale.Contains("roster-changed") || emStale.Contains("generation-changed") || emStale.Contains("restored") || emStale.Contains("source-changed") || emStale.Contains("lead-changed") || emStale.Contains("board-changed") || emStale.Contains("directions-changed") || emStale.Contains("records-changed")) ? (emStale.Contains("roster-changed") ? "stale-profile" : "stale-context") : "provider-error"; yielded.Add(new { advisor = adv.BoardRole, reason = why }); continue; }
              if (string.IsNullOrWhiteSpace(text) || text.TrimStart().StartsWith("ABSTAIN", StringComparison.OrdinalIgnoreCase)) { abstained.Add(adv.BoardRole); yielded.Add(new { advisor = adv.BoardRole, reason = "abstained" }); continue; }
              // Lane B: fresh-fetch; a sync or edit/review during generation yields/discards the stale response.
              if (!s.Advisors.TryGetValue(adv.Id, out var freshAdv) || freshAdv.Removed || freshAdv.BoardId != cur.BoardId)
                { yielded.Add(new { advisor = adv.BoardRole, reason = "not-eligible" }); continue; }
              if (!invitedIds.Contains(adv.Id) && !freshAdv.Approved)
                { yielded.Add(new { advisor = adv.BoardRole, reason = "reapproval-required" }); continue; }
              if (RosterOps.ApprovalGate(s, freshAdv) is { } gate)
                { yielded.Add(new { advisor = adv.BoardRole, reason = "not-eligible" }); continue; }
              if (!laneBPrints.TryGetValue(adv.Id, out var laneBWanted) || !string.Equals(LaneBFingerprint(freshAdv), laneBWanted, StringComparison.Ordinal))
                { yielded.Add(new { advisor = adv.BoardRole, reason = "stale-profile" }); continue; }
              if (SourcePubCheck.ManifestRevoked(s, manifest, id)) { yielded.Add(new { advisor = adv.BoardRole, reason = "evidence-revoked" }); continue; } if (list.Count(x => x.AdvisorId == adv.Id && x.Sequence > leadFloor) >= (followup ? 2 : 1) || batch.Any(x => x.AdvisorId == adv.Id))
                { yielded.Add(new { advisor = adv.BoardRole, reason = "already-replied-this-turn" }); continue; } // at most one initial reply and one optional peer-review reply
              if (room <= 0)
                { yielded.Add(new { advisor = adv.BoardRole, reason = "cap-omitted" }); continue; }
              room--;
            var leadSeq = list.Where(x => x.Sender == "lead").OrderByDescending(x => x.Sequence).Select(x => (long?)x.Sequence).FirstOrDefault();
            var followupReply = followup ? AdvisorDialogue.Followup(text, adv.Id, firstReplies) : (Text: text, ReplyTo: (long?)null);
            var (clean, stance) = MessageTags.SplitStance(followupReply.Text);
            if (string.IsNullOrWhiteSpace(clean) || clean.TrimStart().StartsWith("ABSTAIN", StringComparison.OrdinalIgnoreCase))
              { abstained.Add(adv.BoardRole); yielded.Add(new { advisor = adv.BoardRole, reason = "abstained" }); continue; }
            if (followup && stance == "Disagrees") lastChallenged = adv.BoardRole;
            var msg = new Message
            {
              MeetingId = id, BoardId = cur.BoardId, AdvisorId = adv.Id,
              Sequence = ++next,
              Sender = "advisor", AdvisorName = adv.BoardRole,
              Content = clean,
              ParentSequence = followupReply.ReplyTo ?? leadSeq,
              Stance = stance,
              Status = "committed",
            };
            batch.Add(msg);
            published.Add(msg);
            if (manifest is not null)
              manifests.Add(new { advisor = adv.BoardRole, sources = manifest.SourceIds, seqs = manifest.MessageSeqs, tokens = manifest.TokenEstimate, evidence = manifest.Evidence });
          }
            var grpTitle = "Run: " + published.Count + " replies, " + yielded.Count + " yields";
            Atomic.Run(s, () =>
            {
              // Lane B: revision set BEFORE the same atomic commit that inserts group messages.
              if (batch.Count > 0) cur.DeliveredRevision = batch.Max(x => x.Sequence);
              s.Messages.AddRangeCommitted(id, batch);
              s.Meetings.Flush();
              if (!s.Notes.TryGetValue(outcome.Id, out var grpCur) || grpCur is null) throw new InvalidOperationException("gone");
              grpCur.Title = grpTitle;
              grpCur.Body = JsonSerializer.Serialize(new { policy, leadVersion, generation = gen, revision = cur.DeliveredRevision, rounds = rounds.Count, completedGroups = completedGroups + 1, published = published.Count, yielded, abstained, bidErrorCount = bidErrors.Count, overflow, leadSeq = leadFloor, cap = commitCap });
              s.Notes[grpCur.Id] = grpCur;
              s.Notes.Flush();
            });
            if (laneBGate is null) completedGroups++;
            }); // end Atomic gate: authoritative fetch/authorize/validate/mutate in one backend transaction
            // Success path: apply SyncRoundCommit synchronously HERE, still holding the
            // outer ROOT aliases, immediately after the successful Atomic commit above.
            __roundGateOuter = laneBGate;
            try
            {
              var __actNewPub = new HashSet<Guid>(published.Skip(__actPub0).Select(p => p.AdvisorId));
              var __actNewY = new List<(string advisor, string reason)>();
              foreach (var __ye in yielded.Skip(__actY0))
              {
                try
                {
                  using var __yd = JsonDocument.Parse(JsonSerializer.Serialize(__ye));
                  var __yar = __yd.RootElement.TryGetProperty("advisor", out var __yav) ? __yav.GetString() ?? "" : "";
                  var __yrn = __yd.RootElement.TryGetProperty("reason", out var __yrv) ? __yrv.GetString() ?? "" : "";
                  if (!string.IsNullOrWhiteSpace(__yar)) __actNewY.Add((__yar, string.IsNullOrWhiteSpace(__yrn) ? "yielded" : __yrn));
                }
                catch { }
              }
              if (laneBGate is null)
              {
                var __capRound = round.Select(a => (a.Id, a.BoardRole)).ToList();
                try { MeetingActivity.SyncRoundCommit(id, activityOpId, __capRound, __actNewPub, __actNewY); } catch { }
                __deferredActivityPublish = true;
              }
              // Failure path (laneBGate set): LaneBFail already applied FinishDiscussion synchronously
              // inside and set deferred publish; nothing to sync here. Only the async network
              // publish is deferred below. Rollback (throw) never reaches here, so no rollback-event
              // publish exists.
            }
            catch { }
          }
        }
        // AFTER all outer ROOT aliases (SetupLock/MessageLock) + commit exit: network
        // publish only. SyncRoundCommit already ran inside ROOT above. Never under ROOT,
        // never Task.Run inside ROOT, no Hub->Root inversion (recipient path releases
        // HubGate before acquiring ROOT for per-recipient auth). Rollback (throw) skips this block because the flag is set only after a committed unit.
        if (__deferredActivityPublish)
        {
          __deferredActivityPublish = false;
          try { _ = MeetingActivity.PublishDiscussionAsync(hub, s, id); } catch { }
        }
        if (__roundGateOuter is not null) return __roundGateOuter;
        waveFinished.Add(draft.adv.Id);
        foreach (var message in published.Skip(__actPub0))
          await BoardHub.PublishMeeting(hub, s, id, "message", new { meetingId = id, sequence = message.Sequence }, "read");
        }
      }
      { Guid auditBoard = m.BoardId; try { if (s.Meetings.TryGetValue(id, out var auditMtg) && auditMtg is not null) auditBoard = auditMtg.BoardId; } catch { }
      Atomic.Audit(s, new AuditEvent { BoardId = auditBoard, Action = "discussion.run", Detail = JsonSerializer.Serialize(new { policy, rounds = rounds.Count, published = published.Count, leadVersion, generation = gen, bids = bidResults.Length, abstained, bidErrors = bidErrors.Count, manifests }) }); }
      await SimCEO.Api.Hubs.BoardHub.PublishMeeting(hub, s, id, "run-complete",
        new { meetingId = id, published = published.Count, revision = (s.Meetings.TryGetValue(id, out var __bc) ? __bc.DeliveredRevision : m.DeliveredRevision) }, "read");
      var finalTitle = "Run: " + published.Count + " replies, " + yielded.Count + " yields";
      try
      {
      Atomic.Run(s, () =>
      {
        PublicationGuard.Check(s, publishPin, req, m.BoardId, id, "discuss");
        var finalRev = m.DeliveredRevision;
        if (s.Meetings.TryGetValue(id, out var finalMtg) && finalMtg is not null) finalRev = finalMtg.DeliveredRevision;
        if (!s.Notes.TryGetValue(outcome.Id, out var finalCur) || finalCur is null) throw new InvalidOperationException("gone");
        finalCur.Title = finalTitle;
        finalCur.Body = JsonSerializer.Serialize(new { policy, leadVersion, generation = gen, revision = finalRev, rounds = rounds.Count, completedGroups, published = published.Count, yielded, abstained, bidErrorCount = bidErrors.Count, overflow, leadSeq = leadFloor, cap = effectiveCap, status = "completed" });
        s.Notes[finalCur.Id] = finalCur;
        s.Notes.Flush();
        s.Meetings.Flush();
      });
      }
      catch (Exception finEx) { var finMapped = PublicationGuard.MapGuardFailure(finEx); if (finMapped is not null) return finMapped; throw; }
      MeetingActivity.FinishDiscussion(s, id, activityOpId, "completed", null);
      _ = MeetingActivity.PublishDiscussionAsync(hub, s, id);
            return Results.Ok(new { rounds = rounds.Select(r => r.Select(a => a.BoardRole)), published, challenged = lastChallenged, abstained, bidErrors, yielded, overflow });
      }
      finally
      {
        runCancel.Cancel();
        try { await Task.WhenAll(inFlightDrafts); } catch { }
        try { MeetingActivity.FinishIfRunning(s, id, activityOpId, "interrupted", "run ended"); _ = MeetingActivity.PublishDiscussionAsync(hub, s, id); } catch { }
        lock (s.MessageLock) { s.RunningRuns.Remove(id); }
      }

    });


    app.MapSecretary();
    app.MapMeetingActivity();
    app.MapRoster();
    app.MapRosterChat();
    app.MapCharacterResearch();
    app.MapRosterReconciliation();
    app.MapWizardGuide();
    app.MapMeetingExtras();
    app.MapRecords();
    app.MapSourcesX();
    app.MapWiki();
    app.MapPeople();
    app.MapAuth();
    app.MapOps();
    app.MapModelSettings();
  }
}
