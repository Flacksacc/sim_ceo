using System.Text;
using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

namespace SimCEO.Api;

// Operations: safe job retry (failed steps only, same identity), board
// readiness, the visible command-coverage map, wizard review blockers, and
// onboarding suggestions (metered stub; the manual form stays usable).
public static class OpsEndpoints
{
  public static void MapOps(this WebApplication app)
  {
    var gw = new ModelGateway(app.Services.GetRequiredService<InMemoryStore>());

    app.MapPost("/api/jobs/{id:guid}/retry", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badRetry) return badRetry;
      if (PeopleOps.IsSecure(s))
      {
        if (!AuthOps.TrySession(s, req, out var jr)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        if (!PeopleOps.IsInstallationAdmin(s, jr)) return PeopleOps.Denied();
      }
      if (!s.Jobs.TryGetValue(id, out var job)) return Results.NotFound();
      if (job.State != "failed")
        return Results.Conflict("Only a failed step offers Retry; otherwise the last checkpoint stands.");
      job.State = "pending";
      job.UpdatedAt = DateTime.UtcNow;
      s.Jobs.Flush();
      s.Audit.Add(new AuditEvent { Action = "job.retry", Detail = JsonSerializer.Serialize(new { id, job.Kind, job.IdempotencyKey }) });
      return Results.Ok(job);
    });

    app.MapGet("/api/boards/{bid:guid}/status", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (!s.Boards.TryGetValue(bid, out var b)) return Results.NotFound();
      if (PeopleOps.BadToken(s, req) is { } badSt) return badSt;
      if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      var stUser = PeopleOps.UserOf(s, req);
      var stGuest = !PeopleOps.Can(s, req, bid, null, "read") && PeopleOps.GuestMeetingIds(s, stUser, bid).Count > 0;
      if (!PeopleOps.Can(s, req, bid, null, "read") && !stGuest) return PeopleOps.Denied();
      var stIsAdmin = PeopleOps.IsInstallationAdmin(s, stUser);
      var stCanContrib = PeopleOps.Can(s, req, bid, null, "contribute") || PeopleOps.Can(s, req, bid, null, "manage");
      var advisors = s.Advisors.Values.Where(a => a.BoardId == bid && !a.Removed).ToList();
      var meetings = s.Meetings.Values.Where(m => m.BoardId == bid).ToList();
      return Results.Ok(new
      {
        board = b.Name,
        active = b.ActiveConfig,
        dirty = !string.Equals(b.DraftJson, b.ActiveJson, StringComparison.Ordinal),
        name = !string.IsNullOrWhiteSpace(b.Name),
        lead = LeadSetup.ResolveLeadFor(s, bid) is not null,
        leadVersion = LeadSetup.ResolveLeadFor(s, bid)?.Version ?? 0,
        advisors = new { total = advisors.Count, approved = advisors.Count(a => a.Approved) },
        meetings = new
        {
          total = stGuest ? PeopleOps.GuestMeetingIds(s, stUser, bid).Count : meetings.Count,
          active = stGuest ? 0 : meetings.Count(m => m.State is MeetingState.Active or MeetingState.Paused),
        },
        sourcesPending = stCanContrib ? s.Sources.Values.Count(x => x.BoardId == bid && string.Equals(string.IsNullOrWhiteSpace(x.ReviewState) ? (x.Approved ? "approved" : "pending") : x.ReviewState, "pending", StringComparison.OrdinalIgnoreCase) && !x.Excluded) : 0,
        jobsFailed = stIsAdmin ? s.Jobs.Values.Count(j => j.State == "failed") : 0,
        policy = b.DiscussionPolicy,
        retainAudio = b.RetainAudio,
        guest = stGuest,
      });
    });

    app.MapGet("/api/boards/{bid:guid}/recall", async (InMemoryStore s, HttpRequest req, Guid bid, string q, int take = 8, Guid? meetingId = null) =>
    {
      if (PeopleOps.Check(s, req, bid, meetingId, "read") is { } deniedRecall) return deniedRecall;
      if (string.IsNullOrWhiteSpace(q)) return Results.BadRequest("q is required.");
      Guid? recallMeeting = null; if (req.Query.TryGetValue("meetingId", out var rmv) && Guid.TryParse(rmv.ToString(), out var rmg)) recallMeeting = rmg;
      var isBoardReader = PeopleOps.Can(s, req, bid, null, "read");
      if (!isBoardReader)
      {
        var ru = PeopleOps.UserOf(s, req);
        var rallowed = PeopleOps.GuestMeetingIds(s, ru, bid);
        if (!recallMeeting.HasValue || !rallowed.Contains(recallMeeting.Value)) return PeopleOps.Denied();
      }
      var local = ContextCurator.Recall(s, bid, q, take, recallMeeting);
      var remoteRaw = await Hindsight.SearchAsync(bid, q, take);
      var remote = SourceGovernance.FilterExternalHits(s, bid, remoteRaw, recallMeeting);
      if (remote.Count == 0) return Results.Ok(local);
      return Results.Ok(local.Concat(remote)
        .OrderByDescending(h => h.Score).Take(Math.Clamp(take, 1, 20)).ToList());
    });

    app.MapGet("/api/boards/{bid:guid}/export", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (!s.Boards.TryGetValue(bid, out var b)) return Results.NotFound();
      if (PeopleOps.Check(s, req, bid, null, "manage") is { } deniedExp) return deniedExp;
      var copies = s.Advisors.Values.Where(a => a.BoardId == bid && !a.Removed).ToList();
      var rosterIds = copies.Select(a => a.RosterEntryId).ToHashSet();
      var ownLead = s.LeadProfiles.Values.Where(l => l.BoardId == bid).OrderByDescending(l => l.Version).FirstOrDefault();
      object? effLead = ownLead;
      if (effLead is null)
      {
        try { if (PeopleOps.IsInstallationAdmin(s, PeopleOps.UserOf(s, req))) effLead = LeadSetup.ResolveLead(s); } catch { effLead = null; }
      }
      var rosterRows = s.Roster.Values.Where(r => rosterIds.Contains(r.Id)).ToList();
      var topAccount = rosterRows.Where(r => r.AccountId != Guid.Empty).Select(r => r.AccountId).FirstOrDefault();
      var snapshot = new
      {
        version = 1,
        accountId = topAccount == Guid.Empty ? "" : topAccount.ToString(),
        board = b,
        lead = effLead,
        leadSource = ownLead is not null ? "board" : effLead is not null ? "global" : "none",
        advisors = copies,
        roster = rosterRows,
        exportedAt = DateTime.UtcNow,
      };
      // Web (camelCase) casing: /api/boards/import reads lowercase property names.
      var json = JsonSerializer.Serialize(snapshot, new JsonSerializerOptions(JsonSerializerDefaults.Web));
      return Results.Ok(new { snapshot = json, hash = Hashing.FullHash(Encoding.UTF8.GetBytes(json)) });
    });

    app.MapPost("/api/boards/import", (InMemoryStore s, HttpRequest req, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badImp) return badImp;
      var snapshot = body.TryGetProperty("snapshot", out var sn) ? sn.GetString() ?? "" : "";
      var hash = body.TryGetProperty("hash", out var h) ? h.GetString() ?? "" : "";
      if (string.IsNullOrWhiteSpace(snapshot)) return Results.BadRequest("snapshot is required.");
      if (!string.Equals(Hashing.FullHash(Encoding.UTF8.GetBytes(snapshot)), hash, StringComparison.OrdinalIgnoreCase))
        return Results.Conflict("Snapshot hash mismatch; import the exact exported text.");
      JsonDocument doc;
      try { doc = JsonDocument.Parse(snapshot); }
      catch (JsonException) { return Results.BadRequest("snapshot is not valid JSON."); }
      var root = doc.RootElement;
      if (!root.TryGetProperty("exportedAt", out var xa) || xa.ValueKind != JsonValueKind.String
          || !DateTime.TryParse(xa.GetString(), out _))
        return Results.BadRequest("Snapshot is missing exportedAt; import the exact exported text.");
      if (!root.TryGetProperty("version", out var v) || v.ValueKind != JsonValueKind.Number || !v.TryGetInt32(out var vv) || vv != 1)
        return Results.BadRequest("Unsupported snapshot version.");
      if (!root.TryGetProperty("board", out var src) || src.ValueKind != JsonValueKind.Object
          || !src.TryGetProperty("name", out var bn) || bn.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(bn.GetString()))
        return Results.BadRequest("Snapshot board is missing a name.");
      if (root.TryGetProperty("roster", out var rvx) && rvx.ValueKind != JsonValueKind.Array)
        return Results.BadRequest("Snapshot roster must be an array.");
      if (root.TryGetProperty("advisors", out var avx) && avx.ValueKind != JsonValueKind.Array)
        return Results.BadRequest("Snapshot advisors must be an array.");
      if (root.TryGetProperty("lead", out var lvx) && lvx.ValueKind != JsonValueKind.Object && lvx.ValueKind != JsonValueKind.Null)
        return Results.BadRequest("Snapshot lead must be an object.");
      foreach (var pn in new[] { "mission", "stage", "blockedTypes" })
        if (src.TryGetProperty(pn, out var pvx) && pvx.ValueKind != JsonValueKind.String)
          return Results.BadRequest("Snapshot board field must be a string.");
      if (src.TryGetProperty("retainAudio", out var rax) && rax.ValueKind != JsonValueKind.True && rax.ValueKind != JsonValueKind.False)
        return Results.BadRequest("Snapshot board.retainAudio must be a boolean.");
      foreach (var pn in new[] { "discussionPolicy", "dataUse" })
        if (src.TryGetProperty(pn, out var pvy) && pvy.ValueKind != JsonValueKind.String)
          return Results.BadRequest("Snapshot board field must be a string.");
      // Phase 6 contract: the source policy round-trips with the configuration
      // (P2 #8). Validate BEFORE any mutation; unknown modes are rejected.
      var snapshotPolicy = "allowAll";
      if (src.TryGetProperty("sourcePolicyMode", out var spmEl))
      {
        if (spmEl.ValueKind != JsonValueKind.String)
          return Results.BadRequest("Snapshot board sourcePolicyMode must be a string.");
        var spmRaw = (spmEl.GetString() ?? "").Trim();
        if (!string.IsNullOrEmpty(spmRaw))
        {
          var spmLower = spmRaw.ToLowerInvariant();
          if (spmLower is not ("allowall" or "allow-all" or "wikionly" or "wiki-only" or "wiki_only"))
            return Results.BadRequest("Snapshot board sourcePolicyMode must be allowAll or wikiOnly.");
          snapshotPolicy = spmLower.StartsWith("wiki") ? "wikiOnly" : "allowAll";
        }
      }
      Guid? overrideAccount = null;
      if (body.TryGetProperty("accountId", out var bac) && bac.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(bac.GetString())) {
        if (!Guid.TryParse(bac.GetString(), out var bag) || bag == Guid.Empty)
          return Results.BadRequest("accountId must be a non-empty GUID string.");
        overrideAccount = bag;
      } else if (body.TryGetProperty("accountId", out var bacBad) && bacBad.ValueKind != JsonValueKind.String && bacBad.ValueKind != JsonValueKind.Undefined && bacBad.ValueKind != JsonValueKind.Null) {
        return Results.BadRequest("accountId must be a GUID string.");
      }
      Guid? snapshotAccount = null;
      if (root.TryGetProperty("accountId", out var sac)) {
        if (sac.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(sac.GetString())) {
          if (!Guid.TryParse(sac.GetString(), out var sag) || sag == Guid.Empty)
            return Results.BadRequest("Snapshot accountId must be a GUID string.");
          snapshotAccount = sag;
        } else if (sac.ValueKind != JsonValueKind.Null && sac.ValueKind != JsonValueKind.String) {
          return Results.BadRequest("Snapshot accountId must be a GUID string.");
        }
      }
      var targetAccount = overrideAccount ?? snapshotAccount;
      var rosterIds = new HashSet<string>(StringComparer.Ordinal);
      if (root.TryGetProperty("roster", out var rex2) && rex2.ValueKind == JsonValueKind.Array)
        foreach (var r in rex2.EnumerateArray())
        {
          if (r.ValueKind != JsonValueKind.Object) return Results.BadRequest("Snapshot roster entries must be objects.");
          if (!r.TryGetProperty("name", out var rn2) || rn2.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(rn2.GetString()))
            return Results.BadRequest("Snapshot roster entries must carry a name.");
          if (r.TryGetProperty("id", out var oi2x) && oi2x.ValueKind != JsonValueKind.String)
            return Results.BadRequest("Snapshot roster id must be a string.");
          var rid = r.TryGetProperty("id", out var oi2) && oi2.ValueKind == JsonValueKind.String ? oi2.GetString() ?? "" : "";
          if (!string.IsNullOrWhiteSpace(rid) && !rosterIds.Add(rid))
            return Results.BadRequest("Snapshot roster contains a duplicate id.");
          foreach (var pn in new[] { "description", "profileJson", "tags", "researchJson" })
            if (r.TryGetProperty(pn, out var rvx2) && rvx2.ValueKind != JsonValueKind.String)
              return Results.BadRequest("Snapshot roster field must be a string.");
          if (r.TryGetProperty("version", out var rver) && (rver.ValueKind != JsonValueKind.Number || !rver.TryGetInt32(out _)))
            return Results.BadRequest("Snapshot roster version must be an integer.");
          if (r.TryGetProperty("researchRequested", out var rrqx) && rrqx.ValueKind != JsonValueKind.True && rrqx.ValueKind != JsonValueKind.False)
            return Results.BadRequest("Snapshot roster researchRequested must be a boolean.");
          if (r.TryGetProperty("accountId", out var racx)) {
            if (racx.ValueKind != JsonValueKind.String && racx.ValueKind != JsonValueKind.Null)
              return Results.BadRequest("Snapshot roster accountId must be a GUID string.");
            if (racx.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(racx.GetString()) && !Guid.TryParse(racx.GetString(), out _))
              return Results.BadRequest("Snapshot roster accountId must be a GUID string.");
          }
        }
      var advCount = 0;
      var usedRoster = new HashSet<string>(StringComparer.Ordinal);
      if (root.TryGetProperty("advisors", out var advs2) && advs2.ValueKind == JsonValueKind.Array)
        foreach (var a in advs2.EnumerateArray())
        {
          if (a.ValueKind != JsonValueKind.Object) return Results.BadRequest("Snapshot advisors must be objects.");
          advCount++;
          if (a.TryGetProperty("rosterVersion", out var arvx) && (arvx.ValueKind != JsonValueKind.Number || !arvx.TryGetInt32(out _)))
            return Results.BadRequest("Snapshot advisor rosterVersion must be an integer.");
          if (a.TryGetProperty("boardRole", out var abrx) && abrx.ValueKind != JsonValueKind.String)
            return Results.BadRequest("Snapshot advisor boardRole must be a string.");
          if (!a.TryGetProperty("rosterEntryId", out var re2x) || re2x.ValueKind != JsonValueKind.String)
            return Results.Json(new { error = "Snapshot advisor references a missing roster entry; import the exact exported text." }, statusCode: 422);
          var oldRe = re2x.GetString() ?? "";
          if (string.IsNullOrWhiteSpace(oldRe) || !rosterIds.Contains(oldRe))
            return Results.Json(new { error = "Snapshot advisor references a missing roster entry; import the exact exported text." }, statusCode: 422);
          if (!usedRoster.Add(oldRe))
            return Results.Json(new { error = "Snapshot attaches the same roster entry twice." }, statusCode: 422);
        }
      if (advCount > 10)
        return Results.Json(new { error = "Snapshot holds more than ten advisors; a board holds at most ten." }, statusCode: 422);
      if (root.TryGetProperty("lead", out var leadChk) && leadChk.ValueKind == JsonValueKind.Object) {
        if (!leadChk.TryGetProperty("name", out var lnChk) || lnChk.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(lnChk.GetString()))
          return Results.BadRequest("Snapshot lead is missing a name.");
        foreach (var pn in new[] { "roleLabel", "background", "familiarTopics", "simplerTopics", "commPrefs", "provenanceJson" })
          if (leadChk.TryGetProperty(pn, out var lv2) && lv2.ValueKind != JsonValueKind.String)
            return Results.BadRequest("Snapshot lead field must be a string.");
      }
      var board = new Board
      {
        Name = bn.GetString()!,
        OwnerKey = PeopleOps.UserOf(s, req),
        Mission = src.TryGetProperty("mission", out var mi) ? mi.GetString() ?? "" : "",
        Stage = src.TryGetProperty("stage", out var st) ? st.GetString() ?? "" : "",
        ActiveConfig = false,
        RetainAudio = src.TryGetProperty("retainAudio", out var ra) && ra.ValueKind == JsonValueKind.True,
        DiscussionPolicy = src.TryGetProperty("discussionPolicy", out var dp) && dp.ValueKind == JsonValueKind.String
          && (dp.GetString() is "focused" or "balanced" or "open") ? dp.GetString()! : "balanced",
        DataUse = src.TryGetProperty("dataUse", out var du) && du.ValueKind == JsonValueKind.String
          && (du.GetString() is "standard" or "contributor") ? du.GetString()! : "contributor",
        BlockedTypes = src.TryGetProperty("blockedTypes", out var bt) && bt.ValueKind == JsonValueKind.String ? bt.GetString() ?? "" : "",
        SourcePolicyMode = snapshotPolicy,
      };
      Dictionary<string, Guid> rosterMap = new();
      var plannedRoster = new List<RosterEntry>();
      var ownerKey = PeopleOps.UserOf(s, req);
      if (root.TryGetProperty("roster", out var rex) && rex.ValueKind == JsonValueKind.Array)
        foreach (var r in rex.EnumerateArray())
        {
          if (r.ValueKind != JsonValueKind.Object) return Results.BadRequest("Snapshot roster entries must be objects.");
          var oldId = r.TryGetProperty("id", out var oi) && oi.ValueKind == JsonValueKind.String ? oi.GetString() ?? "" : "";
          var researched = r.TryGetProperty("researchRequested", out var rrq) && rrq.ValueKind == JsonValueKind.True;
          Guid entryAccount = Guid.Empty;
          if (targetAccount.HasValue) entryAccount = targetAccount.Value;
          else if (r.TryGetProperty("accountId", out var rac) && rac.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(rac.GetString()) && Guid.TryParse(rac.GetString(), out var rag) && rag != Guid.Empty) entryAccount = rag;
          var entry = new RosterEntry
          {
            Id = Guid.NewGuid(),
            AccountId = entryAccount,
            OwnerKey = ownerKey,
            Name = r.TryGetProperty("name", out var rn) && rn.ValueKind == JsonValueKind.String ? rn.GetString() ?? "Imported" : "Imported",
            Description = r.TryGetProperty("description", out var rd) && rd.ValueKind == JsonValueKind.String ? rd.GetString() ?? "" : "",
            ProfileJson = r.TryGetProperty("profileJson", out var rp) && rp.ValueKind == JsonValueKind.String ? rp.GetString() ?? "{}" : "{}",
            Version = r.TryGetProperty("version", out var rv2) && rv2.ValueKind == JsonValueKind.Number && rv2.TryGetInt32(out var riv) ? riv : 1,
            Tags = r.TryGetProperty("tags", out var rt) && rt.ValueKind == JsonValueKind.String ? rt.GetString() ?? "" : "",
            ResearchRequested = researched,
            ResearchJson = r.TryGetProperty("researchJson", out var rrj) && rrj.ValueKind == JsonValueKind.String ? rrj.GetString() ?? "{}" : "{}",
            ResearchedAt = null,
            EvidenceCount = 0,
            UpdatedAt = DateTime.UtcNow,
          };
          if (!string.IsNullOrWhiteSpace(oldId)) rosterMap[oldId] = entry.Id;
          plannedRoster.Add(entry);
        }
      LeadProfile? plannedLead = null;
      if (root.TryGetProperty("lead", out var leadPre) && leadPre.ValueKind == JsonValueKind.Object)
      {
        plannedLead = new LeadProfile
        {
          Id = Guid.NewGuid(),
          BoardId = board.Id, Version = 1,
          Name = leadPre.TryGetProperty("name", out var ln0) && ln0.ValueKind == JsonValueKind.String ? ln0.GetString() ?? "" : "",
          RoleLabel = leadPre.TryGetProperty("roleLabel", out var rl0) && rl0.ValueKind == JsonValueKind.String ? rl0.GetString() ?? "Board Lead" : "Board Lead",
          Background = leadPre.TryGetProperty("background", out var bg0) && bg0.ValueKind == JsonValueKind.String ? bg0.GetString() ?? "" : "",
          FamiliarTopics = leadPre.TryGetProperty("familiarTopics", out var ft0) && ft0.ValueKind == JsonValueKind.String ? ft0.GetString() ?? "" : "",
          SimplerTopics = leadPre.TryGetProperty("simplerTopics", out var st0) && st0.ValueKind == JsonValueKind.String ? st0.GetString() ?? "" : "",
          CommPrefs = leadPre.TryGetProperty("commPrefs", out var cp0) && cp0.ValueKind == JsonValueKind.String ? cp0.GetString() ?? "" : "",
          ProvenanceJson = leadPre.TryGetProperty("provenanceJson", out var pj0) && pj0.ValueKind == JsonValueKind.String ? pj0.GetString() ?? "{}" : "{}",
        };
      }
      var plannedAdvisors = new List<BoardAdvisor>();
      if (root.TryGetProperty("advisors", out var advsPre) && advsPre.ValueKind == JsonValueKind.Array)
        foreach (var a in advsPre.EnumerateArray())
        {
          if (a.ValueKind != JsonValueKind.Object) return Results.BadRequest("Snapshot advisors must be objects.");
          var oldRe = a.TryGetProperty("rosterEntryId", out var re0) && re0.ValueKind == JsonValueKind.String ? re0.GetString() ?? "" : "";
          if (string.IsNullOrWhiteSpace(oldRe) || !rosterMap.ContainsKey(oldRe))
            return Results.Json(new { error = "Snapshot advisor references a missing roster entry; import the exact exported text." }, statusCode: 422);
          plannedAdvisors.Add(new BoardAdvisor
          {
            Id = Guid.NewGuid(), BoardId = board.Id,
            RosterEntryId = rosterMap[oldRe],
            RosterVersion = a.TryGetProperty("rosterVersion", out var rv0) && rv0.ValueKind == JsonValueKind.Number && rv0.TryGetInt32(out var rvv) ? rvv : 1,
            BoardRole = a.TryGetProperty("boardRole", out var br0) && br0.ValueKind == JsonValueKind.String ? br0.GetString() ?? "" : "",
            Approved = false,
          });
        }
      int imported;
      lock (s.SetupLock)
      {
        imported = Atomic.Run(() =>
        {
          s.Boards[board.Id] = board;
          foreach (var pe in plannedRoster) s.Roster[pe.Id] = pe;
          if (plannedLead is not null)
          {
            s.LeadProfiles[plannedLead.Id] = plannedLead;
            board.LeadProfileVersion = 1;
          }
          var copied = 0;
          foreach (var copy in plannedAdvisors)
          {
            s.Advisors[copy.Id] = copy;
            copied++;
          }
          s.Boards.Flush();
          s.Roster.Flush();
          s.Advisors.Flush();
          s.LeadProfiles.Flush();
          s.Audit.Add(new AuditEvent { BoardId = board.Id, Action = "setup.import", Detail = JsonSerializer.Serialize(new { advisors = copied, reReview = true }) });
          return copied;
        });
      }
      return Results.Created($"/api/boards/{board.Id}/setup",
        new { board, advisors = imported, note = "Imported configuration needs review: advisors are unapproved and nothing is activated." });
    });

    app.MapPost("/api/wizard/{id:guid}/extract", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.WizardDrafts.TryGetValue(id, out var d)) return Results.NotFound();
      if (!WizardGuide.TryWizardUser(s, req, d, out _, out var deniedWx)) return deniedWx;
      if (!body.TryGetProperty("sourceId", out var se) || se.ValueKind != JsonValueKind.String
        || !Guid.TryParse(se.GetString(), out var sourceId) || sourceId == Guid.Empty)
        return Results.BadRequest("sourceId is required.");
      if (!s.Sources.TryGetValue(sourceId, out var doc)) return Results.NotFound("source");
      // Authorize the referenced source: caller must read its actual scope.
      if (PeopleOps.Check(s, req, doc.BoardId, doc.MeetingId, "read") is { } deniedDoc) return deniedDoc;
      List<object> log;
      try
      {
        log = JsonSerializer.Deserialize<List<object>>(string.IsNullOrWhiteSpace(d.ProvenanceJson) ? "[]" : d.ProvenanceJson) ?? new();
      }
      catch (JsonException) { log = new(); }
      var checkpoint = new
      {
        sourceId,
        fileName = doc.FileName,
        version = doc.Version,
        contentHash = doc.ContentHash,
        approved = doc.Approved, reviewState = doc.ReviewState, eligible = SourceGovernance.IsEligible(s, doc, doc.Scope == "meeting" ? doc.MeetingId : null), indexState = doc.IndexState,
        extractedAt = DateTime.UtcNow,
        chars = doc.Original?.Length ?? 0,
        extractor = "direct-read",
      };
      log.Add(checkpoint);
      d.ProvenanceJson = JsonSerializer.Serialize(log);
      d.UpdatedAt = DateTime.UtcNow;
      s.WizardDrafts.Flush();
      return Results.Ok(new { checkpoints = log.Count, latest = checkpoint });
    });

    app.MapGet("/api/wizard/{id:guid}/extract", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.WizardDrafts.TryGetValue(id, out var d)) return Results.NotFound();
      if (!WizardGuide.TryWizardUser(s, req, d, out _, out var deniedWxg)) return deniedWxg;
      return Results.Ok(new { checkpoints = d.ProvenanceJson });
    });

    app.MapGet("/api/backup", (InMemoryStore s, HttpRequest req) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badBk) return badBk;
      if (PeopleOps.IsSecure(s))
      {
        if (!AuthOps.TrySession(s, req, out var bk)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        var admBk = PeopleOps.AdminEmail(s);
        if (string.IsNullOrWhiteSpace(admBk) || !string.Equals(admBk, bk, StringComparison.OrdinalIgnoreCase)) return Results.Json(new { error = "Only the installation admin can export backups." }, statusCode: 403);
      }
      else if (!PeopleOps.IsOwner(req))
        return Results.Json(new { error = "Only the owner can export backups." }, statusCode: 403);
      var snapshot = new
      {
        version = 2,
        at = DateTime.UtcNow,
        boards = s.Boards.Values.ToList(),
        roster = s.Roster.Values.ToList(),
        advisors = s.Advisors.Values.ToList(),
        meetings = s.Meetings.Values.ToList(),
        messages = s.Messages.ToDictionary(kv => kv.Key.ToString(), kv => kv.Value),
        notes = s.Notes.Values.ToList(),
        drafts = s.Drafts.Values.ToList(),
        sources = s.Sources.Values.ToList(), sections = s.SourceSections.Values.ToList(), heads = s.SourceHeads.Values.ToList(), events = s.SourceEvents.Values.ToList(),
        blobs = s.Sources.Values.ToDictionary(
          x => x.Id.ToString(), x => x.Original is null ? "" : Convert.ToBase64String(x.Original)),
        leads = s.LeadProfiles.Values.ToList(),
          wizardDrafts = s.WizardDrafts.Values.ToList(),
        grants = s.Grants.Values.ToList(),
        invites = s.Invites.Values.ToList(),
        images = s.Images.Values.Select(i => new { i.Id, i.RosterEntryId, i.BoardAdvisorId, i.Kind, i.Provenance, i.ContentType, i.Review, i.CreatedAt, data = i.Data is null ? null : Convert.ToBase64String(i.Data) }).ToList(),
      };
      var json = JsonSerializer.Serialize(snapshot);
      return Results.Ok(new { snapshot = json, hash = Hashing.FullHash(Encoding.UTF8.GetBytes(json)), bytes = json.Length });
    });

    app.MapPost("/api/backup/restore", (InMemoryStore s, HttpRequest req, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badBr) return badBr;
      if (PeopleOps.IsSecure(s))
      {
        if (!AuthOps.TrySession(s, req, out var br)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        var admBr = PeopleOps.AdminEmail(s);
        if (string.IsNullOrWhiteSpace(admBr) || !string.Equals(admBr, br, StringComparison.OrdinalIgnoreCase)) return Results.Json(new { error = "Only the installation admin can restore backups." }, statusCode: 403);
      }
      else if (!PeopleOps.IsOwner(req))
        return Results.Json(new { error = "Only the owner can restore backups." }, statusCode: 403);
      var snapshot = body.TryGetProperty("snapshot", out var sn) ? sn.GetString() ?? "" : "";
      var hash = body.TryGetProperty("hash", out var h) ? h.GetString() ?? "" : "";
      if (!string.Equals(Hashing.FullHash(Encoding.UTF8.GetBytes(snapshot)), hash, StringComparison.OrdinalIgnoreCase))
        return Results.Conflict("Backup hash mismatch; restore the exact exported text.");
      JsonDocument doc;
      try { doc = JsonDocument.Parse(snapshot); }
      catch (JsonException) { return Results.BadRequest("snapshot is not valid JSON."); }
      if (!doc.RootElement.TryGetProperty("version", out var v) || v.GetInt32() is not (1 or 2))
        return Results.BadRequest("Unsupported backup version.");
      var restored = JsonSerializer.Deserialize<BackupSnapshot>(snapshot,
        new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
      if (restored is null) return Results.BadRequest("Unrecognized backup shape.");
      // Restore boundary (explicit, documented): domain backup restores ONLY domain entities.
      // Installation security authority (Accounts/Sessions/SecurityStates), current ACL
      // (Grants/Invites/Memberships) and revocation decisions are NEVER cleared or replaced
      // by an old snapshot. Snapshot grant/invite rows are IGNORED so old snapshots cannot
      // resurrect revoked or left access. No credentials or session tokens are exported.
      if (restored.boards is null || restored.roster is null || restored.advisors is null || restored.meetings is null || restored.messages is null || restored.notes is null || restored.drafts is null || restored.sources is null || restored.leads is null || restored.blobs is null || restored.images is null) return Results.BadRequest("Backup is missing required collections.");
      // Deep graph validation BEFORE any destructive mutation: non-null entries, unique
      // IDs, complete parent relationships, valid GUID keys and strict base64 binaries.
      var graphError = ValidateRestoreGraph(restored);
      if (graphError is not null) return Results.BadRequest(graphError);
      // Phase 6 graph validation: canonical identities, uniqueness, parent
      // relationships, heads, section metadata, legal states. Malformed or
      // forged graphs are rejected with zero partial state.
      if (!SourceGovernance.ValidateRestoreGraph(restored, out var srcGraphErr))
        return Results.Json(new { error = "Backup graph rejected: " + srcGraphErr }, statusCode: 422);
      // Fresh generation base: in-flight publications captured gen <= live max. Restored
      // meetings restart strictly above it, so stale runs can never commit (no snapshot reuse).
      var liveMaxGen = 0L;
      try { liveMaxGen = s.Meetings.Values.Any() ? s.Meetings.Values.Max(m => m.Generation) : 0L; } catch { liveMaxGen = 0L; }
      var memMode = SimCEO.Api.Data.Pg.Backend is null;
      var snapBoards = memMode ? s.Boards.Values.ToList() : new System.Collections.Generic.List<Domain.Board>();
      var snapRoster = memMode ? s.Roster.Values.ToList() : new System.Collections.Generic.List<Domain.RosterEntry>();
      var snapAdvisors = memMode ? s.Advisors.Values.ToList() : new System.Collections.Generic.List<Domain.BoardAdvisor>();
      var snapMeetings = memMode ? s.Meetings.Values.ToList() : new System.Collections.Generic.List<Domain.Meeting>();
      var snapNotes = memMode ? s.Notes.Values.ToList() : new System.Collections.Generic.List<Domain.Note>();
      var snapDrafts = memMode ? s.Drafts.Values.ToList() : new System.Collections.Generic.List<Domain.RecordDraft>();
      var snapSources = memMode ? s.Sources.Values.ToList() : new System.Collections.Generic.List<Domain.SourceDoc>();
      var snapSections = memMode ? s.SourceSections.Values.ToList() : new System.Collections.Generic.List<Domain.SourceSection>();
      var snapHeads = memMode ? s.SourceHeads.Values.ToList() : new System.Collections.Generic.List<Domain.SourceFamilyHead>();
      var snapEvents = memMode ? s.SourceEvents.Values.ToList() : new System.Collections.Generic.List<Domain.SourceEvent>();
      var snapLeads = memMode ? s.LeadProfiles.Values.ToList() : new System.Collections.Generic.List<Domain.LeadProfile>();
      var snapImages = memMode ? s.Images.Values.ToList() : new System.Collections.Generic.List<Domain.AdvisorImage>();
      var snapWiz = memMode ? s.WizardDrafts.Values.ToList() : new System.Collections.Generic.List<Domain.WizardDraft>();
      var snapMessages = memMode ? s.Messages.ToDictionary(kv => kv.Key, kv => kv.Value.ToList()) : new System.Collections.Generic.Dictionary<Guid, System.Collections.Generic.List<Domain.Message>>();
      int restoredCount = 0;
      lock (s.SetupLock)
      {
        lock (s.MessageLock)
        {
          try
          {
            restoredCount = Atomic.Run(() =>
            {
              s.Boards.Clear(); s.Roster.Clear(); s.Advisors.Clear(); s.Meetings.Clear(); s.Messages.Clear();
              s.Notes.Clear(); s.Drafts.Clear(); s.Sources.Clear(); s.SourceSections.Clear(); s.SourceHeads.Clear(); s.SourceEvents.Clear();
              s.LeadProfiles.Clear(); s.Images.Clear(); s.WizardDrafts.Clear();
              foreach (var b in restored.boards) s.Boards[b.Id] = b;
              foreach (var r in restored.roster) s.Roster[r.Id] = r;
              foreach (var a in restored.advisors) s.Advisors[a.Id] = a;
              foreach (var m in restored.meetings)
              {
                m.Generation = System.Math.Max(m.Generation, liveMaxGen) + 1;
                s.Meetings[m.Id] = m;
              }
              foreach (var kv in restored.messages)
              {
                if (Guid.TryParse(kv.Key, out var mid)) s.Messages[mid] = MessageList.Detached(mid, kv.Value);
              }
              foreach (var n in restored.notes) s.Notes[n.Id] = n;
              foreach (var d in restored.drafts) s.Drafts[d.Id] = d;
              foreach (var x in restored.sources) s.Sources[x.Id] = x;
              if (restored.sections is not null) foreach (var ss in restored.sections) s.SourceSections[ss.Id] = ss;
              if (restored.heads is not null) foreach (var hh in restored.heads) s.SourceHeads[hh.Id] = hh;
              if (restored.events is not null) foreach (var ee in restored.events) s.SourceEvents[ee.Id] = ee;
              // Deliberate legacy migration: pre-phase-6 snapshots carry
              // Approved=true with no ReviewState field. The "" sentinel promotes
              // those to "approved" without touching explicit decisions (rejected
              // rows stay rejected); empty legacy family keys are canonicalized;
              // completed-without-sections metadata is failed-closed until
              // reindex; established heads cover families the snapshot left
              // headless. All inside this same transaction.
              SourceGovernance.MigrateRestoredSources(s);
              foreach (var kv in restored.blobs)
              {
                if (Guid.TryParse(kv.Key, out var bid2))
                  if (s.Sources.TryGetValue(bid2, out var bdoc) && !string.IsNullOrEmpty(kv.Value))
                    try { bdoc.Original = Convert.FromBase64String(kv.Value); } catch (FormatException) { }
              }
              s.Sources.Flush();
              foreach (var img in restored.images)
              {
                byte[]? data = null;
                if (!string.IsNullOrEmpty(img.data)) try { data = Convert.FromBase64String(img.data); } catch (FormatException) { }
                s.Images[img.id] = new AdvisorImage
                {
                  Id = img.id, RosterEntryId = img.rosterEntryId, BoardAdvisorId = img.boardAdvisorId,
                  Kind = img.kind ?? "upload", Provenance = img.provenance ?? "",
                  Review = string.IsNullOrWhiteSpace(img.review) ? "pending" : img.review,
                  ContentType = img.contentType ?? "image/png", Data = data,
                  CreatedAt = img.createdAt == default ? DateTime.UtcNow : DateTime.UtcNow,
                };
              }
              foreach (var l in restored.leads) s.LeadProfiles[l.Id] = l;
              // ACL preserved: restored.grants / restored.invites are IGNORED by design.
              if (restored.wizardDrafts is not null) foreach (var w in restored.wizardDrafts) s.WizardDrafts[w.Id] = w;
              return restored.boards.Count;
            });
            // Replacement succeeded: advance the runtime epoch and retire all
            // outstanding index reservations so in-flight extraction and
            // publication work fails closed instead of committing against the
            // replaced state. No generation reuse is observable afterwards.
            s.ActiveIndexJobs.Clear();
            s.SourceEpoch++;
            s.Audit.Add(new AuditEvent { Action = "backup.restore", Detail = JsonSerializer.Serialize(new { restored.at, boards = restoredCount, aclPreserved = true }) });
          }
          catch (Exception __ex)
          {
            if (memMode)
            {
              // Real memory rollback: validation passed but a write failed; restore snapshots.
              try
              {
                s.Boards.Clear(); foreach (var b in snapBoards) s.Boards[b.Id] = b;
                s.Roster.Clear(); foreach (var r in snapRoster) s.Roster[r.Id] = r;
                s.Advisors.Clear(); foreach (var a in snapAdvisors) s.Advisors[a.Id] = a;
                s.Meetings.Clear(); foreach (var m in snapMeetings) s.Meetings[m.Id] = m;
                s.Messages.Clear(); foreach (var kv in snapMessages) s.Messages[kv.Key] = MessageList.Detached(kv.Key, kv.Value);
                s.Notes.Clear(); foreach (var n in snapNotes) s.Notes[n.Id] = n;
                s.Drafts.Clear(); foreach (var d in snapDrafts) s.Drafts[d.Id] = d;
                s.Sources.Clear(); foreach (var x in snapSources) s.Sources[x.Id] = x;
                s.SourceSections.Clear(); foreach (var ss in snapSections) s.SourceSections[ss.Id] = ss;
                s.SourceHeads.Clear(); foreach (var hh in snapHeads) s.SourceHeads[hh.Id] = hh;
                s.SourceEvents.Clear(); foreach (var ee in snapEvents) s.SourceEvents[ee.Id] = ee;
                s.LeadProfiles.Clear(); foreach (var l in snapLeads) s.LeadProfiles[l.Id] = l;
                s.Images.Clear(); foreach (var im in snapImages) s.Images[im.Id] = im;
                s.WizardDrafts.Clear(); foreach (var w in snapWiz) s.WizardDrafts[w.Id] = w;
              }
              catch { }
            }
            return Results.Json(new { error = "Restore failed; prior domain state was restored: " + __ex.Message }, statusCode: 500);
          }
        }
      }
      return Results.Ok(new { restored = restoredCount, at = restored.at });
    });

    app.MapGet("/api/commands", () => Results.Ok(CommandMap.All));

    app.MapGet("/api/spending", (InMemoryStore s, HttpRequest req) =>
    {
      if (PeopleOps.IsSecure(s))
      {
        if (PeopleOps.BadToken(s, req) is { } badSp) return badSp;
        if (!AuthOps.TrySession(s, req, out var sp)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        var admSp = PeopleOps.AdminEmail(s);
        var isAdmSp = !string.IsNullOrWhiteSpace(admSp) && string.Equals(admSp, sp, StringComparison.OrdinalIgnoreCase);
        if (!isAdmSp) return PeopleOps.Denied();
      }
      var now = DateTime.UtcNow;
      var (known, unknown) = ModelGateway.MonthSpend(s);
      var cap = s.Spend.MonthlyCapUsd;
      return Results.Ok(new
      {
        month = $"{now.Year:D4}-{now.Month:D2}",
        monthlyCapUsd = cap,
        mode = s.Spend.Mode,
        knownSpendUsd = known,
        unknownCostCalls = unknown,
        overCap = cap.HasValue && known >= cap.Value,
        enforced = s.Spend.Mode == "block" && cap.HasValue,
        note = unknown > 0
          ? "Some calls have unknown cost (stubs); enforcement counts known costs only."
          : "All recorded costs known.",
      });
    });

    app.MapPut("/api/spending", (InMemoryStore s, HttpRequest req, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badSpP) return badSpP;
      if (PeopleOps.IsSecure(s))
      {
        if (!AuthOps.TrySession(s, req, out var spp)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        var admSpP = PeopleOps.AdminEmail(s);
        if (string.IsNullOrWhiteSpace(admSpP) || !string.Equals(admSpP, spp, StringComparison.OrdinalIgnoreCase))
          return Results.Json(new { error = "Only the installation admin can change spending controls." }, statusCode: 403);
      }
      else if (!PeopleOps.IsOwner(req))
        return Results.Json(new { error = "Only the owner can change spending controls." }, statusCode: 403);
      lock (s.SpendLock)
      {
        if (body.TryGetProperty("monthlyCapUsd", out var c))
          s.Spend.MonthlyCapUsd = c.ValueKind == JsonValueKind.Number ? c.GetDecimal()
            : c.ValueKind == JsonValueKind.Null ? null : s.Spend.MonthlyCapUsd;
        if (body.TryGetProperty("mode", out var m) && m.GetString() is { } mode
            && (mode == "warn" || mode == "block"))
          s.Spend.Mode = mode;
        s.Audit.Add(new AuditEvent { Action = "spending.set", Detail = JsonSerializer.Serialize(new { s.Spend.MonthlyCapUsd, s.Spend.Mode }) });
        return Results.Ok(new { s.Spend.MonthlyCapUsd, s.Spend.Mode });
      }
    });
  }

  // Deep restore-graph validation: every collection entry present, IDs unique,
  // all parent references resolve inside the snapshot, GUID keys parse, binaries
  // are strict base64, messages are well-formed per meeting. Runs BEFORE mutation.
  private static string? ValidateRestoreGraph(BackupSnapshot r)
  {
    string Err(string m) => m;
    bool NullEntry<T>(System.Collections.Generic.IEnumerable<T>? xs, string name, out string? err)
    {
      err = null;
      if (xs is null) { err = "Backup is missing required collection: " + name + "."; return true; }
      foreach (var e in xs) if (e is null) { err = "Backup contains a null entry in " + name + "."; return true; }
      return false;
    }
    string? e0;
    if (NullEntry(r.boards, "boards", out e0)) return e0;
    if (NullEntry(r.roster, "roster", out e0)) return e0;
    if (NullEntry(r.advisors, "advisors", out e0)) return e0;
    if (NullEntry(r.meetings, "meetings", out e0)) return e0;
    if (NullEntry(r.notes, "notes", out e0)) return e0;
    if (NullEntry(r.drafts, "drafts", out e0)) return e0;
    if (NullEntry(r.sources, "sources", out e0)) return e0;
    if (NullEntry(r.leads, "leads", out e0)) return e0;
    if (NullEntry(r.images, "images", out e0)) return e0;
    if (r.messages is null) return Err("Backup is missing required collection: messages.");
    if (r.blobs is null) return Err("Backup is missing required collection: blobs.");
    if (r.wizardDrafts is not null) foreach (var wz in r.wizardDrafts) if (wz is null) return Err("Backup contains a null entry in wizardDrafts.");
    bool Dup(System.Collections.Generic.IEnumerable<Guid> ids, string name, out string? err)
    {
      err = null;
      var seen = new System.Collections.Generic.HashSet<Guid>();
      foreach (var i in ids) if (!seen.Add(i)) { err = "Backup contains a duplicate id in " + name + "."; return true; }
      return false;
    }
    if (Dup(r.boards.Select(b => b.Id), "boards", out e0)) return e0;
    if (Dup(r.roster.Select(x => x.Id), "roster", out e0)) return e0;
    if (Dup(r.advisors.Select(x => x.Id), "advisors", out e0)) return e0;
    if (Dup(r.meetings.Select(x => x.Id), "meetings", out e0)) return e0;
    if (Dup(r.notes.Select(x => x.Id), "notes", out e0)) return e0;
    if (Dup(r.drafts.Select(x => x.Id), "drafts", out e0)) return e0;
    if (Dup(r.sources.Select(x => x.Id), "sources", out e0)) return e0;
    if (Dup(r.leads.Select(x => x.Id), "leads", out e0)) return e0;
    if (Dup(r.images.Select(x => x.id), "images", out e0)) return e0;
    if (r.wizardDrafts is not null && Dup(r.wizardDrafts.Select(x => x.Id), "wizardDrafts", out e0)) return e0;
    var bids = new System.Collections.Generic.HashSet<Guid>(r.boards.Select(b => b.Id));
    var mids = new System.Collections.Generic.HashSet<Guid>(r.meetings.Select(m => m.Id));
    var meetingBoard = r.meetings.ToDictionary(m => m.Id, m => m.BoardId);
    var rosterIds = new System.Collections.Generic.HashSet<Guid>(r.roster.Select(x => x.Id));
    var sourceIds = new System.Collections.Generic.HashSet<Guid>(r.sources.Select(x => x.Id));
    foreach (var m in r.meetings) if (!bids.Contains(m.BoardId)) return Err("Backup graph: meeting references unknown board.");
    foreach (var x in r.sources)
    {
      if (!bids.Contains(x.BoardId)) return Err("Backup graph: source references unknown board.");
      if (x.MeetingId.HasValue && (!mids.Contains(x.MeetingId.Value) || meetingBoard[x.MeetingId.Value] != x.BoardId))
        return Err("Backup graph: source references unknown or foreign meeting.");
    }
    foreach (var n in r.notes)
    {
      if (!bids.Contains(n.BoardId)) return Err("Backup graph: note references unknown board.");
      if (!mids.Contains(n.MeetingId) || meetingBoard[n.MeetingId] != n.BoardId)
        return Err("Backup graph: note references unknown or foreign meeting.");
    }
    foreach (var d in r.drafts)
    {
      if (!bids.Contains(d.BoardId)) return Err("Backup graph: record references unknown board.");
      if (!mids.Contains(d.MeetingId) || meetingBoard[d.MeetingId] != d.BoardId)
        return Err("Backup graph: record references unknown or foreign meeting.");
    }
    foreach (var l in r.leads) if (!bids.Contains(l.BoardId)) return Err("Backup graph: lead references unknown board.");
    foreach (var a in r.advisors)
    {
      if (!bids.Contains(a.BoardId)) return Err("Backup graph: advisor references unknown board.");
      if (!rosterIds.Contains(a.RosterEntryId)) return Err("Backup graph: advisor references missing roster entry.");
    }
    foreach (var im in r.images)
    {
      if (im.id == Guid.Empty) return Err("Backup graph: image has no id.");
      if (im.rosterEntryId.HasValue && !rosterIds.Contains(im.rosterEntryId.Value))
        return Err("Backup graph: image references missing roster entry.");
    }
    foreach (var kv in r.blobs)
    {
      if (!Guid.TryParse(kv.Key, out var bk)) return Err("Backup graph: blob key is not a GUID.");
      if (!sourceIds.Contains(bk)) return Err("Backup graph: blob references unknown source.");
      if (!string.IsNullOrEmpty(kv.Value))
      {
        try { Convert.FromBase64String(kv.Value); }
        catch (FormatException) { return Err("Backup graph: blob is not valid base64."); }
      }
    }
    foreach (var kv in r.messages)
    {
      if (!Guid.TryParse(kv.Key, out var mk)) return Err("Backup graph: message key is not a GUID.");
      if (!mids.Contains(mk)) return Err("Backup graph: messages reference unknown meeting.");
      if (kv.Value is null) return Err("Backup graph: message list is null.");
      var seqs = new System.Collections.Generic.HashSet<long>();
      foreach (var mm in kv.Value)
      {
        if (mm is null) return Err("Backup graph: message entry is null.");
        if (mm.MeetingId != mk) return Err("Backup graph: message meeting mismatch.");
        if (mm.BoardId != meetingBoard[mk]) return Err("Backup graph: message board mismatch.");
        if (mm.Sequence <= 0) return Err("Backup graph: message sequence invalid.");
        if (!seqs.Add(mm.Sequence)) return Err("Backup graph: duplicate message sequence.");
      }
    }
    if (r.wizardDrafts is not null) foreach (var wz in r.wizardDrafts)
    {
      if (wz.Id == Guid.Empty) return Err("Backup graph: wizard draft has no id.");
    }
    return null;
  }
}

public sealed record BackupImage(Guid id, Guid? rosterEntryId, Guid? boardAdvisorId,
  string kind, string provenance, string contentType, string? data,
  string? review = null, DateTime createdAt = default);

public sealed record BackupSnapshot(int version, DateTime at,
  List<Board> boards, List<RosterEntry> roster, List<BoardAdvisor> advisors,
  List<Meeting> meetings, Dictionary<string, List<Message>> messages,
  List<Note> notes, List<RecordDraft> drafts, List<SourceDoc> sources,
  Dictionary<string, string> blobs, List<LeadProfile> leads,
  List<Grant> grants, List<Invite> invites, List<BackupImage> images, List<Domain.WizardDraft>? wizardDrafts = null, List<Domain.SourceSection>? sections = null, List<Domain.SourceFamilyHead>? heads = null, List<Domain.SourceEvent>? events = null);

public static class CommandMap
{
  public static readonly IReadOnlyList<object> All = new List<object>
  {
    new { command = "/app", view = "Boards", action = "Board list and switcher" },
    new { command = "/setup", view = "Wizard", action = "Create-board wizard; autosaves each step" },
    new { command = "/setup review", view = "Wizard", action = "Review blockers with links to each field" },
    new { command = "/setup activate", view = "Settings", action = "Activate configuration (reviewed hash)" },
    new { command = "/setup set ceo-name", view = "Your Profile", action = "Save lead profile immediately" },
    new { command = "/setup advisors", view = "Board Advisors", action = "Add / approve / remove (10-seat cap)" },
    new { command = "/setup research", view = "Board Advisors", action = "Research again (metered stub)" },
    new { command = "/advisor add", view = "Board Advisors", action = "Add-advisor form" },
    new { command = "roster", view = "Roster", action = "Search, copy to board, archive, character drafts" },
    new { command = "audition", view = "Roster", action = "Try this advisor (never a meeting message)" },
    new { command = "/setup portrait", view = "Board Advisors", action = "Upload / URL / explicit Generate" },
    new { command = "/meetings", view = "Meetings", action = "List with state filter and search" },
    new { command = "/begin /resume", view = "Meeting header", action = "Start / Resume discussion" },
    new { command = "/pause", view = "Meeting header", action = "Pause (implies no record)" },
    new { command = "/end", view = "Meeting header", action = "End discussion and prepare record" },
    new { command = "/secretary", view = "Composer", action = "Direct-secretary mode (bypasses advisors)" },
    new { command = "/briefing", view = "Meeting inspector", action = "Prepare briefing; discussion continues" },
    new { command = "/summary", view = "Meeting inspector", action = "Provisional notes panel" },
    new { command = "/record", view = "Records", action = "Open / prepare current draft" },
    new { command = "/record approve", view = "Records", action = "Approve selected / all (hash + watermark)" },
    new { command = "/record revise", view = "Records", action = "Request revision (new version)" },
    new { command = "/record discard", view = "Records", action = "Discard draft; conversation preserved" },
    new { command = "adopt ...", view = "Meetings", action = "Adopt exact text meeting / board-wide" },
    new { command = "/sources", view = "Sources", action = "Paged table: scope, version, state, access" },
    new { command = "/sources disable|enable", view = "Sources", action = "Per-source access toggle" },
    new { command = "/context status", view = "Sources", action = "Extraction and index status" },

    new { command = "/people ...", view = "People", action = "Invites, meeting grants, revoke" },
    new { command = "/usage ...", view = "Activity", action = "Usage by meeting / board / day / range" },
    new { command = "/status", view = "Boards", action = "Readiness card + Activity status" },
    new { command = "/help", view = "Help", action = "This searchable coverage map" },
  };
}
