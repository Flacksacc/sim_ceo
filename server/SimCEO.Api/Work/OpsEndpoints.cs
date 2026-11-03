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
      try
      {
        Atomic.Run(s, () =>
        {
          // Job identity + retryable state rechecked inside the unit: only a
          // still-failed job transitions to pending, exactly once.
          if (PeopleOps.BadToken(s, req) is not null) throw new UnauthorizedAccessException("revoked");
          if (PeopleOps.IsSecure(s))
          {
            if (!AuthOps.TrySession(s, req, out var jrIn)) throw new UnauthorizedAccessException("revoked");
            if (!PeopleOps.IsInstallationAdmin(s, jrIn)) throw new UnauthorizedAccessException("denied");
          }
          if (!s.Jobs.TryGetValue(id, out var cur) || cur is null) throw new InvalidOperationException("Job is gone.");
          if (cur.State != "failed") throw new InvalidOperationException("not-failed");
          cur.State = "pending";
          cur.UpdatedAt = DateTime.UtcNow;
          s.Jobs[cur.Id] = cur;
          Atomic.Audit(s, new AuditEvent { Action = "job.retry", Detail = JsonSerializer.Serialize(new { id, cur.Kind, cur.IdempotencyKey }) });
        });
      }
      catch (InvalidOperationException iox) when (iox.Message == "not-failed")
      {
        return Results.Conflict("Only a failed step offers Retry; otherwise the last checkpoint stands.");
      }
      catch (UnauthorizedAccessException uex) when (uex.Message == "revoked") { return Results.Json(new { error = "Authentication required." }, statusCode: 401); }
      catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
      catch (InvalidOperationException iox) when (CommitOutcome.IsMissing(iox, "Job is gone.")) { return Results.NotFound(); }
      catch (InvalidOperationException iox) { return CommitOutcome.StorageFault("Job retry", iox); }
      catch (Exception ex) { return CommitOutcome.MapCommitFailure(ex, "Job retry") ?? Results.Json(new { error = "Job retry failed; no state changed: " + ex.Message }, statusCode: 500); }
      if (!s.Jobs.TryGetValue(id, out var done) || done is null) return Results.NotFound();
      return Results.Ok(done);
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
        lead = (LeadSetup.ResolveLeadForStrict(s, bid) ?? (LeadSetup.InheritsGlobalLead(s, b) ? LeadSetup.ResolveLead(s) : null)) is not null,
        leadVersion = (LeadSetup.ResolveLeadForStrict(s, bid) ?? (LeadSetup.InheritsGlobalLead(s, b) ? LeadSetup.ResolveLead(s) : null))?.Version ?? 0,
        advisors = new { total = advisors.Count, approved = advisors.Count(a => a.Approved) },
        meetings = new
        {
          total = stGuest ? PeopleOps.GuestMeetingIds(s, stUser, bid).Count : meetings.Count,
          active = stGuest ? 0 : meetings.Count(m => m.State is MeetingState.Active or MeetingState.Paused),
        },
        sourcesPending = stCanContrib ? s.Sources.Values.Count(x => x.BoardId == bid && string.Equals(string.IsNullOrWhiteSpace(x.ReviewState) ? (x.Approved ? "approved" : "pending") : x.ReviewState, "pending", StringComparison.OrdinalIgnoreCase) && !x.Excluded) : 0,
        jobsFailed = stIsAdmin ? s.Jobs.Values.Count(j => j.State == "failed") : 0,
        policy = LeadSetup.EffectiveView(s, b).policy,
        dataUse = LeadSetup.EffectiveView(s, b).dataUse,
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
      if (body.ValueKind != JsonValueKind.Object) return Results.BadRequest("body must be a JSON object.");
      string snapshot = "";
      if (body.TryGetProperty("snapshot", out var sn))
      {
        if (sn.ValueKind != JsonValueKind.String) return Results.BadRequest("snapshot must be a string.");
        snapshot = sn.GetString() ?? "";
      }
      string hash = "";
      if (body.TryGetProperty("hash", out var h))
      {
        if (h.ValueKind != JsonValueKind.String) return Results.BadRequest("hash must be a string.");
        hash = h.GetString() ?? "";
      }
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
        imported = Atomic.Run(s, () =>
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
          Atomic.Audit(s, new AuditEvent { BoardId = board.Id, Action = "setup.import", Detail = JsonSerializer.Serialize(new { advisors = copied, reReview = true }) });
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
      // Setup-use purpose gate for Wiki connectors (F9): missing resources,
      // disabled/setup-off/failed/stale/pending/removed-page sources, and
      // unauthorized scopes all reject WITHOUT adding a checkpoint. Only a
      // healthy authorized setup-use positive control passes.
      if (string.Equals((doc.Origin ?? "").Trim(), "wiki", System.StringComparison.OrdinalIgnoreCase))
      {
        static (bool ok, string error) WikiSetupAllowed(InMemoryStore s, HttpRequest req, SourceDoc d, out WikiResource? wrOut)
        {
          wrOut = null;
          if (!d.ResourceId.HasValue || !s.WikiResources.TryGetValue(d.ResourceId.Value, out var wr)) return (false, "Wiki connector for this source is missing; reconfigure the connector before wizard extraction.");
          wrOut = wr;
          if (!wr.SetupUse) return (false, "This Wiki connector is not enabled for setup use; enable setup-use on the resource before wizard extraction.");
          if (!wr.Enabled || !string.Equals(wr.LastStatus ?? "", "succeeded", StringComparison.OrdinalIgnoreCase)
            || wr.ConfigRevision != wr.LastSuccessRevision || wr.LastSuccessRevision <= 0)
            return (false, "Wiki connector evidence is not currently healthy; sync successfully before wizard extraction.");
          HashSet<string> members;
          try
          {
            var list = JsonSerializer.Deserialize<List<string>>(string.IsNullOrWhiteSpace(wr.SuccessPagesJson) ? "[]" : wr.SuccessPagesJson);
            members = new HashSet<string>(list ?? new(), StringComparer.Ordinal);
          }
          catch { return (false, "Wiki connector evidence is not currently healthy; sync successfully before wizard extraction."); }
          if (!members.Contains(d.FamilyKey ?? "")) return (false, "Wiki page is not in the current successful sync; sync successfully before wizard extraction.");
          if (!SourceGovernance.IsEligible(s, d, d.Scope == "meeting" ? d.MeetingId : null))
            return (false, "Wiki source is not eligible (pending, excluded, unindexed, or removed); approve and sync before wizard extraction.");
          if (!WikiAuth.CanReadResource(s, req, wr.BoardId, wr.Scope, wr.MeetingId))
            return (false, "Access revoked or not granted for this scope.");
          return (true, "");
        }
        var (setupOk, setupErr) = WikiSetupAllowed(s, req, doc, out _);
        if (!setupOk) return Results.Json(new { error = setupErr }, statusCode: 409);
      }
      // Checkpoint append shares one store-bound unit: the draft and source are
      // freshly re-fetched and re-authorized inside; a revoked source or a
      // concurrently replaced draft cannot receive the checkpoint.
      List<object>? addedLog = null;
      object? addedCheckpoint = null;
      var docId = doc.Id; var docHash = doc.ContentHash; var docVer = doc.Version;
      try
      {
        Atomic.Run(s, () =>
        {
          if (!s.WizardDrafts.TryGetValue(id, out var cur) || cur is null) throw new InvalidOperationException("Draft is gone.");
          if (!WizardGuide.TryWizardUser(s, req, cur, out _, out _)) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
          if (!s.Sources.TryGetValue(docId, out var fresh) || fresh is null) throw new InvalidOperationException("Source is gone.");
          if (PeopleOps.Check(s, req, fresh.BoardId, fresh.MeetingId, "read") is not null) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
          if (!string.Equals(fresh.ContentHash ?? "", docHash ?? "", StringComparison.Ordinal) || fresh.Version != docVer)
            throw new InvalidOperationException("Source changed during extraction; retry.");
          List<object> log;
          try
          {
            log = JsonSerializer.Deserialize<List<object>>(string.IsNullOrWhiteSpace(cur.ProvenanceJson) ? "[]" : cur.ProvenanceJson) ?? new();
          }
          catch (JsonException) { log = new(); }
          var checkpoint = new
          {
            sourceId,
            fileName = fresh.FileName,
            version = fresh.Version,
            contentHash = fresh.ContentHash,
            approved = fresh.Approved, reviewState = fresh.ReviewState, eligible = SourceGovernance.IsEligible(s, fresh, fresh.Scope == "meeting" ? fresh.MeetingId : null), indexState = fresh.IndexState,
            extractedAt = DateTime.UtcNow,
            chars = fresh.Original?.Length ?? 0,
            extractor = "direct-read",
          };
          log.Add(checkpoint);
          cur.ProvenanceJson = JsonSerializer.Serialize(log);
          cur.UpdatedAt = DateTime.UtcNow;
          s.WizardDrafts[cur.Id] = cur;
          addedLog = log; addedCheckpoint = checkpoint;
        });
      }
      catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
      catch (InvalidOperationException iox) when (iox.Message == "Source changed during extraction; retry.") { return Results.Conflict(iox.Message); }
      catch (InvalidOperationException iox) when (CommitOutcome.IsMissing(iox, "Draft is gone.", "Source is gone.")) { return Results.NotFound(); }
      catch (InvalidOperationException iox) { return CommitOutcome.StorageFault("Wizard extraction", iox); }
      catch (Exception ex) { return CommitOutcome.MapCommitFailure(ex, "Wizard extraction") ?? Results.Json(new { error = "Wizard extraction failed; no state changed: " + ex.Message }, statusCode: 500); }
      return Results.Ok(new { checkpoints = (addedLog ?? new List<object>()).Count, latest = addedCheckpoint });
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
      // Deterministic canonical ordering: every collection is sorted by
      // identity (dictionaries by key) so backups hash stably and restores
      // round-trip byte-identically (modulo the fresh export timestamp).
      // Coherent capture: the whole graph is read under the shared serialization gate.
      object snapshot;
      string json;
      // Serialize INSIDE the shared serialization gate: the snapshot holds
      // live entity references, so serializing after lock release could emit
      // a mixed graph torn by a concurrent mutator.
      lock (s.SetupLock) { lock (s.MessageLock) {
      snapshot = new
      {
        version = 4,
        at = DateTime.UtcNow,
        boards = s.Boards.Values.OrderBy(x => x.Id).ToList(),
        roster = s.Roster.Values.OrderBy(x => x.Id).ToList(),
        advisors = s.Advisors.Values.OrderBy(x => x.Id).ToList(),
        meetings = s.Meetings.Values.OrderBy(x => x.Id).ToList(),
        messages = s.Messages.OrderBy(kv => kv.Key).ToDictionary(kv => kv.Key.ToString(), kv => kv.Value),
        notes = s.Notes.Values.OrderBy(x => x.Id).ToList(),
        drafts = s.Drafts.Values.OrderBy(x => x.Id).ToList(),
        sources = s.Sources.Values.OrderBy(x => x.Id).ToList(), sections = s.SourceSections.Values.OrderBy(x => x.Id).ToList(), heads = s.SourceHeads.Values.OrderBy(x => x.Id).ToList(), events = s.SourceEvents.Values.OrderBy(x => x.Id).ToList(),
        wikiResources = WikiBackup.Export(s),
        deletedWikiResourceIds = WikiBackup.DeletedWikiResourceIds(s),
        blobs = s.Sources.Values.OrderBy(x => x.Id).ToDictionary(
          x => x.Id.ToString(), x => x.Original is null ? "" : Convert.ToBase64String(x.Original)),
        leads = s.LeadProfiles.Values.OrderBy(x => x.Id).ToList(),
          wizardDrafts = s.WizardDrafts.Values.OrderBy(x => x.Id).ToList(),
        jobs = s.Jobs.Values.OrderBy(x => x.Id).ToList(),
        voiceTurns = s.VoiceTurns.Values.OrderBy(x => x.Id).ToList(),
        images = s.Images.Values.OrderBy(i => i.Id).Select(i => new { i.Id, i.RosterEntryId, i.BoardAdvisorId, i.Kind, i.Provenance, i.ContentType, i.Review, i.CreatedAt, data = i.Data is null ? null : Convert.ToBase64String(i.Data) }).ToList(),
        secretaryRequests = s.SecretaryRequests.Values.OrderBy(x => x.Id).ToList(),
        noteHistories = s.NoteHistories.Values.OrderBy(x => x.Id).ToList(),
      };
      json = JsonSerializer.Serialize(snapshot);
      } }
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
      if (body.ValueKind != JsonValueKind.Object) return Results.BadRequest("body must be a JSON object.");
      string snapshot = "";
      if (body.TryGetProperty("snapshot", out var sn))
      {
        if (sn.ValueKind != JsonValueKind.String) return Results.BadRequest("snapshot must be a string.");
        snapshot = sn.GetString() ?? "";
      }
      string hash = "";
      if (body.TryGetProperty("hash", out var h))
      {
        if (h.ValueKind != JsonValueKind.String) return Results.BadRequest("hash must be a string.");
        hash = h.GetString() ?? "";
      }
      if (!string.Equals(Hashing.FullHash(Encoding.UTF8.GetBytes(snapshot)), hash, StringComparison.OrdinalIgnoreCase))
        return Results.Conflict("Backup hash mismatch; restore the exact exported text.");
      JsonDocument doc;
      try { doc = JsonDocument.Parse(snapshot); }
      catch (JsonException) { return Results.BadRequest("snapshot is not valid JSON."); }
      // Controlled wrong-type root: an array/string/number/null root is a
      // 400 here, never a 500 from TryGetProperty on a non-object.
      if (doc.RootElement.ValueKind != JsonValueKind.Object) return Results.BadRequest("snapshot is not a JSON object.");
      if (!doc.RootElement.TryGetProperty("version", out var v) || v.ValueKind != JsonValueKind.Number || !v.TryGetInt32(out var vv) || vv is not (1 or 2 or 3 or 4))
        return Results.BadRequest("Unsupported backup version.");
      BackupSnapshot? restored;
      try
      {
        restored = JsonSerializer.Deserialize<BackupSnapshot>(snapshot,
          new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
      }
      catch (Exception ex) when (ex is JsonException || ex is NotSupportedException || ex is InvalidOperationException || ex is FormatException)
      {
        return Results.Json(new { error = "Backup snapshot has invalid typed data: " + ex.GetType().Name }, statusCode: 422);
      }
      if (restored is null) return Results.BadRequest("Unrecognized backup shape.");
      if (restored.jobs is not null)
      {
        var seenJ = new HashSet<Guid>();
        foreach (var j in restored.jobs)
        {
          if (j is null || j.Id == Guid.Empty) return Results.BadRequest("Backup job is null or missing id.");
          if (!seenJ.Add(j.Id)) return Results.BadRequest("Backup job ids are not unique.");
          if (Work.JobWorker.KnownKinds.Contains(j.Kind ?? "")) { if (!string.IsNullOrWhiteSpace(j.Payload)) { try { using var _ = JsonDocument.Parse(j.Payload); } catch { return Results.BadRequest("Backup job payload is not valid JSON."); } } }
        }
      }
      if (restored.voiceTurns is not null)
      {
        var seenV = new HashSet<Guid>();
        foreach (var vt in restored.voiceTurns)
        {
          if (vt is null || vt.Id == Guid.Empty) return Results.BadRequest("Backup voice turn is null or missing id.");
          if (!seenV.Add(vt.Id)) return Results.BadRequest("Backup voice turn ids are not unique.");
        }
      }
      // Restore boundary (explicit, documented): domain backup restores ONLY domain entities.
      // Installation security authority (Accounts/Sessions/SecurityStates), current ACL
      // (Grants/Invites/Memberships) and revocation decisions are NEVER cleared or replaced
      // by an old snapshot. Snapshot grant/invite rows are IGNORED so old snapshots cannot
      // resurrect revoked or left access. No credentials or session tokens are exported.
      if (restored.boards is null || restored.roster is null || restored.advisors is null || restored.meetings is null || restored.messages is null || restored.notes is null || restored.drafts is null || restored.sources is null || restored.leads is null || restored.blobs is null || restored.images is null) return Results.BadRequest("Backup is missing required collections.");
      // Deep graph validation BEFORE any destructive mutation: non-null entries, unique
      // IDs, complete parent relationships, valid GUID keys and strict base64 binaries.
      var graphError = ValidateRestoreGraph(restored);
      if (graphError is not null)
      {
        // Record-graph rejection (F2): a well-formed backup whose staged record
        // graph fails the complete validator (wiped modern history, forged
        // lifecycle, bad correspondence) rejects as 422 with the exact cause,
        // matching the other domain-graph rejections below. Malformed shapes
        // (missing collections, nulls, dups, dangling lineage) stay 400.
        if (graphError.StartsWith("Backup record ", StringComparison.Ordinal))
          return Results.Json(new { error = graphError }, statusCode: 422);
        return Results.BadRequest(graphError);
      }
      // Phase 6 graph validation: canonical identities, uniqueness, parent
      // relationships, heads, section metadata, legal states. Malformed or
      // forged graphs are rejected with zero partial state.
      if (!SourceGovernance.ValidateRestoreGraph(restored, out var srcGraphErr))
        return Results.Json(new { error = "Backup graph rejected: " + srcGraphErr }, statusCode: 422);
      // Typed Wiki graph prevalidation BEFORE any clear: strict required IDs,
      // exact scopes, snapshot meeting parents, strict rule JSON, preserved
      // history, and source/section graph validation. Secrets, dangling,
      // cross-board, and malformed graphs reject without partial writes.
      // Absent wikiResources validates as empty (backward compatible).
      List<WikiBackupRecord>? wikiValidated = null;
      try
      {
        // Secretary-domain strict graph check (preserved): typed nested validation
        {
          string? secGraphError = BackupGraphValidator.Validate(restored);
          if (secGraphError is not null) return Results.Json(new { error = secGraphError }, statusCode: 422);
          foreach (var kv in restored.messages)
          {
            if (!Guid.TryParse(kv.Key, out _)) return Results.Json(new { error = "Backup message key is not a meeting id." }, statusCode: 422);
          }
        }
        using var vdoc = JsonDocument.Parse(snapshot);
        var (recs, werr) = WikiBackup.Validate(vdoc.RootElement, s);
        if (werr is not null) return Results.BadRequest(werr);
        wikiValidated = recs;
      }
      catch (JsonException) { return Results.BadRequest("Snapshot wikiResources are malformed."); }
      int restoredCount = 0;
      lock (s.SetupLock)
      {
        lock (s.MessageLock)
        {
          // Invalidation base AND rollback snapshots are captured INSIDE the
          // shared serialization boundary (never sampled before the lock): a
          // concurrent commit between sampling and replacement can neither
          // slip below the generation floor nor be erased by a failed-restore
          // rollback.
          var liveMaxGen = 0L;
          try { liveMaxGen = s.Meetings.Values.Any() ? s.Meetings.Values.Max(m => m.Generation) : 0L; } catch { liveMaxGen = 0L; }
          // Deep rollback snapshots are owned by the store-bound unit below
          // (exact deep capture in memory mode; EF transaction in PG mode).
          try
          {
            restoredCount = Atomic.Run(s, () =>
            {
              // Fresh authority INSIDE the unit, BEFORE any Clear: a logout
              // or permission change during pre-validation fails closed here.
              // There is no admin fallback for an invalid request: a blank
              // or logged-out held request must never restore.
              string restoreAdmin;
              if (PeopleOps.IsSecure(s))
              {
                if (!AuthOps.TrySession(s, req, out var radmIn))
                  throw new RestoreAuthException(401, "Authentication required.");
                var admNow = PeopleOps.AdminEmail(s);
                if (string.IsNullOrWhiteSpace(admNow) || !string.Equals(admNow, radmIn, StringComparison.OrdinalIgnoreCase))
                  throw new RestoreAuthException(403, "Only the installation admin can restore backups.");
                restoreAdmin = radmIn;
              }
              else
              {
                if (!PeopleOps.IsOwner(req))
                  throw new RestoreAuthException(403, "Only the owner can restore backups.");
                restoreAdmin = PeopleOps.UserOf(s, req);
              }
              var priorBoards = s.Boards.Values.ToDictionary(b => b.Id, b => (b.OwnerKey, b.AccessEnforced));
              s.Boards.Clear(); s.Roster.Clear(); s.Advisors.Clear(); s.Meetings.Clear(); s.Messages.Clear();
              s.Notes.Clear(); s.Drafts.Clear(); s.Sources.Clear(); s.SourceSections.Clear(); s.SourceHeads.Clear(); s.SourceEvents.Clear();
              s.LeadProfiles.Clear(); s.Images.Clear(); s.WizardDrafts.Clear();
              s.WikiResources.Clear(); s.WikiSecrets.Clear();
              s.SecretaryRequests.Clear(); s.NoteHistories.Clear();
              if (restored.jobs is not null) s.Jobs.Clear();
              if (restored.voiceTurns is not null) s.VoiceTurns.Clear();
              foreach (var b in restored.boards) { if (priorBoards.TryGetValue(b.Id, out var prior)) { b.OwnerKey = prior.OwnerKey; b.AccessEnforced = prior.AccessEnforced; } else if (!string.IsNullOrWhiteSpace(restoreAdmin)) { b.OwnerKey = restoreAdmin; } s.Boards[b.Id] = b; }
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
              foreach (var n in restored.notes) { if (n.RootId == Guid.Empty) n.RootId = n.Id; s.Notes[n.Id] = n; }
              foreach (var d in restored.drafts) s.Drafts[d.Id] = d;
              foreach (var x in restored.sources) s.Sources[x.Id] = x;
              if (restored.sections is not null) foreach (var ss in restored.sections) s.SourceSections[ss.Id] = ss;
              if (restored.heads is not null) foreach (var hh in restored.heads) s.SourceHeads[hh.Id] = hh;
              if (restored.events is not null) foreach (var ee in restored.events) s.SourceEvents[ee.Id] = ee;
              if (restored.secretaryRequests is not null) foreach (var sr in restored.secretaryRequests) { if (sr.Status == "pending" || sr.Status == "inflight" || sr.Status == "answering") { sr.Status = "interrupted"; sr.Error = "Restored as interrupted; old workers are invalid. Retry with the same nonce."; sr.UpdatedAt = DateTime.UtcNow; } s.SecretaryRequests[sr.Id] = sr; }
              if (restored.noteHistories is not null) foreach (var hh in restored.noteHistories) s.NoteHistories[hh.Id] = hh;
              if (restored.jobs is not null) foreach (var j in restored.jobs) { if (string.Equals(j.State, "running", System.StringComparison.OrdinalIgnoreCase)) { j.State = "interrupted"; j.Error = "Restored from backup; retry explicitly to resume."; j.UpdatedAt = DateTime.UtcNow; } s.Jobs[j.Id] = j; }
              if (restored.voiceTurns is not null) foreach (var vt in restored.voiceTurns) s.VoiceTurns[vt.Id] = vt;
            // Typed Wiki restore: exact validated export round-trips resource IDs,
            // history, URLs, rules, scope, and schedule; credentials are absent
            // and every resource is DISABLED with blocked cached sources.
            // Validated BEFORE clear; applied atomically inside the same boundary.
            // No grants/invites/ACL are restored here by design (see ACL note below).
            if (wikiValidated is not null)
              foreach (var w in wikiValidated)
              {
                var r = new Domain.WikiResource
                {
                  Id = w.Id, BoardId = w.BoardId, Scope = w.Scope, MeetingId = w.MeetingId,
                  BaseUrl = w.BaseUrl, Description = w.Description ?? "", AllowedUse = w.AllowedUse ?? "",
                  SetupUse = w.SetupUse, ManualOnly = w.ManualOnly,
                  AllowlistJson = w.AllowlistJson, ExclusionsJson = w.ExclusionsJson,
                  RequiredTagsJson = w.RequiredTagsJson, Locale = w.Locale ?? "",
                  ConfigRevision = w.ConfigRevision, AttemptGeneration = 1, AttemptStatus = "idle",
                  SyncIntervalMinutes = w.SyncIntervalMinutes, CreatedAt = w.CreatedAt,
                  Enabled = false, LastStatus = "disabled",
                  LastError = "Restored from backup; reconfigure the credential and re-enable.",
                  LastCompletedAt = null, LastSuccessAt = null,
                  HasCredential = false, SuccessPagesJson = "[]", LastSuccessRevision = 0,
                  NextSyncAt = null, UpdatedAt = DateTime.UtcNow,
                };
                if (!s.Boards.TryGetValue(r.BoardId, out _)) throw new InvalidOperationException("validated invariant violated: wiki board missing.");
                if (r.Scope == "meeting" && (!r.MeetingId.HasValue || !s.Meetings.TryGetValue(r.MeetingId.Value, out var wmt) || wmt.BoardId != r.BoardId)) throw new InvalidOperationException("validated invariant violated: wiki meeting missing.");
                s.WikiResources[r.Id] = r;
              }
              // Deliberate legacy migration: pre-phase-6 snapshots carry
              // Approved=true with no ReviewState field. The "" sentinel promotes
              // those to "approved" without touching explicit decisions (rejected
              // rows stay rejected); empty legacy family keys are canonicalized;
              // completed-without-sections metadata is failed-closed until
              // reindex; established heads cover families the snapshot left
              // headless. All inside this same transaction.
              // Effective binaries were validated BEFORE clear; decode must succeed here.
              // Any failure throws and triggers real rollback (never silent Data=null loss).
              foreach (var kv in restored.blobs)
              {
                if (Guid.TryParse(kv.Key, out var bid2))
                  if (s.Sources.TryGetValue(bid2, out var bdoc) && !string.IsNullOrEmpty(kv.Value))
                  {
                    try { bdoc.Original = Convert.FromBase64String(kv.Value); }
                    catch (FormatException) { throw new InvalidOperationException("Backup blob is not valid base64."); }
                  }
              }
              SourceGovernance.MigrateRestoredSources(s);
              s.Sources.Flush();
              foreach (var img in restored.images)
              {
                byte[]? data = null;
                if (!string.IsNullOrEmpty(img.data))
                {
                  try { data = Convert.FromBase64String(img.data); }
                  catch (FormatException) { throw new InvalidOperationException("Backup image data is not valid base64."); }
                }
                s.Images[img.id] = new AdvisorImage
                {
                  Id = img.id, RosterEntryId = img.rosterEntryId, BoardAdvisorId = img.boardAdvisorId,
                  Kind = img.kind ?? "upload", Provenance = img.provenance ?? "",
                  Review = string.IsNullOrWhiteSpace(img.review) ? "pending" : img.review,
                  ContentType = img.contentType ?? "image/png", Data = data,
                  CreatedAt = img.createdAt == default ? DateTime.UtcNow : img.createdAt,
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
            // Fresh global restore identity + revision: every in-flight domain
            // publisher holding the previous identity fails closed at commit.
            s.RestoreEpochId = Guid.NewGuid();
            s.RestoreEpochRev++;
            Atomic.Audit(s, new AuditEvent { Action = "backup.restore", Detail = JsonSerializer.Serialize(new { restored.at, boards = restoredCount, aclPreserved = true }) });
          }
          catch (Exception __ex)
          {
            // No manual restore here: the store-bound unit above already
            // restored exact deep state (memory mode) or rolled back the PG
            // transaction. A shallow re-fill would reintroduce shared row refs.
            // Honest outcome mapping: authority failures carry their own
            // status; a post-commit effect failure means the restore COMMITTED
            // (never claim prior state was restored for it).
            if (__ex is RestoreAuthException rae) return Results.Json(new { error = rae.Message }, statusCode: rae.Status);
            if (__ex is SimCEO.Api.Data.CommitUnknownException cux)
            {
              s.ActiveIndexJobs.Clear();
              s.SourceEpoch++;
              s.RestoreEpochId = Guid.NewGuid();
              s.RestoreEpochRev++;
              return Results.Json(new { error = "Restore outcome is unknown (the replacement may have committed); stale publishers invalidated, refresh and verify before retrying: " + cux.Message }, statusCode: 500);
            }
            if (__ex is SimCEO.Api.Data.PostCommitException pce)
            {
              s.ActiveIndexJobs.Clear();
              s.SourceEpoch++;
              s.RestoreEpochId = Guid.NewGuid();
              s.RestoreEpochRev++;
              return Results.Json(new { error = "Restore committed; a post-commit effect failed: " + pce.Message }, statusCode: 500);
            }
            if (__ex is AggregateException) return Results.Json(new { error = "Restore failed and rollback is uncertain; prior state may be partial: " + __ex.Message }, statusCode: 500);
            return Results.Json(new { error = "Restore failed; prior domain state was restored: " + __ex.Message }, statusCode: 500);
          }
        }
      }
      return Results.Ok(new { restored = restoredCount, at = restored.at });
    });

    app.MapGet("/api/jobs/{id:guid}", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badJg) return badJg;
      if (!s.Jobs.TryGetValue(id, out var job) || job is null) return Results.NotFound();
      // Caller-scoped read: installation admin sees all; anyone else must hold
      // read on the job target's board. Unresolvable payloads are admin-only.
      if (PeopleOps.IsSecure(s))
      {
        if (!AuthOps.TrySession(s, req, out var ju)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        if (!PeopleOps.IsInstallationAdmin(s, ju))
        {
          Guid? jb = null;
          try
          {
            using var jd = System.Text.Json.JsonDocument.Parse(string.IsNullOrWhiteSpace(job.Payload) ? "{}" : job.Payload);
            if (jd.RootElement.TryGetProperty("targetId", out var jt) && jt.ValueKind == JsonValueKind.String && Guid.TryParse(jt.GetString(), out var jg))
            {
              if (string.Equals(job.Kind, "index", System.StringComparison.OrdinalIgnoreCase) && s.Sources.TryGetValue(jg, out var js)) jb = js.BoardId;
              else if (string.Equals(job.Kind, "wiki-sync", System.StringComparison.OrdinalIgnoreCase) && s.WikiResources.TryGetValue(jg, out var jw)) jb = jw.BoardId;
            }
          }
          catch (JsonException) { }
          if (!jb.HasValue || !s.Boards.ContainsKey(jb.Value)) return PeopleOps.Denied();
          if (!PeopleOps.Can(s, req, jb.Value, null, "read")) return PeopleOps.Denied();
        }
      }
      else if (!PeopleOps.IsOwner(req)) return PeopleOps.Denied();
      return Results.Ok(job);
    });

    app.MapPost("/api/jobs/{id:guid}/execute", async (InMemoryStore s, Work.WikiSyncService sync, HttpRequest req, Guid id) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badJx) return badJx;
      // Claim: exactly one executor wins. Revalidates session/authority inside
      // the unit, captures the restore epoch + attempt, transitions to running.
      Guid claimBoard = Guid.Empty;
      Guid claimTarget = Guid.Empty;
      string claimKind = "";
      int claimAttempt = 0;
      Guid claimEpoch = Guid.Empty;
      Work.JobWorker.JobTarget? claimT = null;
      try
      {
        Atomic.Run(s, () =>
        {
          if (PeopleOps.BadToken(s, req) is not null) throw new UnauthorizedAccessException("revoked");
          if (PeopleOps.IsSecure(s))
          {
            if (!AuthOps.TrySession(s, req, out var jx)) throw new UnauthorizedAccessException("revoked");
            if (!PeopleOps.IsInstallationAdmin(s, jx))
            {
              if (!s.Jobs.TryGetValue(id, out var pre) || pre is null) throw new InvalidOperationException("gone");
              throw new UnauthorizedAccessException("denied");
            }
          }
          else if (!PeopleOps.IsOwner(req)) throw new UnauthorizedAccessException("denied");
          if (!s.Jobs.TryGetValue(id, out var cur) || cur is null) throw new InvalidOperationException("gone");
          if (cur.State == "running") throw new InvalidOperationException("running");
          if (cur.State is not ("pending" or "failed" or "interrupted")) throw new InvalidOperationException("terminal");
          Work.JobWorker.JobTarget? tt = null;
          try
          {
            using var jd = System.Text.Json.JsonDocument.Parse(string.IsNullOrWhiteSpace(cur.Payload) ? "{}" : cur.Payload);
            if (jd.RootElement.TryGetProperty("kind", out var kk) && kk.ValueKind == JsonValueKind.String
              && jd.RootElement.TryGetProperty("targetId", out var tv) && tv.ValueKind == JsonValueKind.String && Guid.TryParse(tv.GetString(), out var tg))
              tt = new Work.JobWorker.JobTarget((kk.GetString() ?? "").Trim().ToLowerInvariant(), tg);
          }
          catch (JsonException) { }
          if (tt is null || !Work.JobWorker.KnownKinds.Contains(tt.Kind)) throw new InvalidOperationException("badkind");
          if (tt.Kind == "index")
          {
            if (!s.Sources.TryGetValue(tt.TargetId, out var ds) || ds is null) throw new InvalidOperationException("gone-target");
            if (PeopleOps.Check(s, req, ds.BoardId, ds.MeetingId, "contribute") is not null) throw new UnauthorizedAccessException("denied-scope");
            claimBoard = ds.BoardId;
          }
          else
          {
            if (!s.WikiResources.TryGetValue(tt.TargetId, out var dw) || dw is null) throw new InvalidOperationException("gone-target");
            if (!Work.WikiAuth.CanManageResource(s, req, dw.BoardId, (dw.Scope ?? "board") == "meeting" ? "meeting" : "board", dw.MeetingId)) throw new UnauthorizedAccessException("denied-scope");
            claimBoard = dw.BoardId;
          }
          cur.State = "running";
          cur.Attempts += 1;
          cur.Error = "";
          cur.UpdatedAt = DateTime.UtcNow;
          s.Jobs[cur.Id] = cur;
          claimTarget = tt.TargetId; claimKind = tt.Kind; claimAttempt = cur.Attempts;
          claimEpoch = s.RestoreEpochId; claimT = tt;
        });
      }
      catch (UnauthorizedAccessException uex) when (uex.Message == "revoked") { return Results.Json(new { error = "Authentication required." }, statusCode: 401); }
      catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
      catch (InvalidOperationException iox) when (iox.Message == "running") { return Results.Json(new { error = "Job is already running; wait for its attempt." }, statusCode: 409); }
      catch (InvalidOperationException iox) when (iox.Message == "terminal") { return Results.Json(new { error = "Only pending, failed, or interrupted jobs execute." }, statusCode: 409); }
      catch (InvalidOperationException iox) when (iox.Message == "badkind") { return Results.Json(new { error = "Unknown job kind." }, statusCode: 422); }
      catch (InvalidOperationException iox) when (CommitOutcome.IsMissing(iox, "gone", "gone-target")) { return Results.NotFound(); }
      catch (InvalidOperationException iox) { return CommitOutcome.StorageFault("Job claim", iox); }
      catch (Exception ex) { return CommitOutcome.MapCommitFailure(ex, "Job claim") ?? Results.Json(new { error = "Job claim failed; no state changed: " + ex.Message }, statusCode: 500); }
      if (claimT is null) return Results.NotFound();
      // Domain work runs OUTSIDE every lock/gate (async provider/extractor/network
      // stays outside the unit). Only the claim above and the commit below are units.
      bool wok = false;
      string werr = "";
      object? wdetail = null;
      try
      {
        if (claimKind == "index")
        {
          if (!SourceGovernance.TryBeginIndex(s, req, claimTarget, "contribute", out var res, out _) || res is null)
            throw new InvalidOperationException("index reservation refused");
          SourceDoc? snapDoc = null;
          lock (s.SetupLock) { lock (s.MessageLock) { if (s.Sources.TryGetValue(claimTarget, out var sd)) snapDoc = sd; } }
          if (snapDoc is null || snapDoc.Original is null) throw new InvalidOperationException("source bytes unavailable");
          var ext = await Work.Extraction.ExtractAsync(snapDoc.Original, snapDoc.FileName ?? "source");
          wdetail = new { jobId = res.JobId };
          Atomic.Run(s, () =>
          {
            if (s.RestoreEpochId != claimEpoch) throw new InvalidOperationException("restored");
            Work.SourceGovernance.StampExtraction(s, req, res, Work.Extraction.ToJson(ext), "contribute");
            var (fok, fstale, flost, ferr, fstatus) = Work.SourceGovernance.FinishIndex(s, req, res, true, "contribute");
            _ = flost;
            if (!fok) throw new InvalidOperationException("finish:" + ferr + ":" + fstatus);
            wdetail = new { jobId = res.JobId };
          });
          wok = true;
        }
        else
        {
          string callerX = "";
          string? callerTok = null;
          if (PeopleOps.IsSecure(s))
          {
            if (!AuthOps.TrySession(s, req, out var sx)) throw new UnauthorizedAccessException("revoked");
            callerX = sx;
            try
            {
              var ahX = req.Headers["Authorization"].ToString() ?? "";
              if (ahX.StartsWith("Bearer ", System.StringComparison.OrdinalIgnoreCase)) callerTok = ahX["Bearer ".Length..].Trim();
            }
            catch { }
            if (string.IsNullOrWhiteSpace(callerTok)) throw new UnauthorizedAccessException("revoked");
          }
          else callerX = PeopleOps.UserOf(s, req);
          var (sok, serr, sstatus) = await sync.SyncAsync(claimTarget, "job:" + id.ToString("N"), callerX, false, default, callerTok);
          if (!sok) throw new InvalidOperationException("wikisync:" + serr + ":" + sstatus);
          wok = true;
        }
      }
      catch (UnauthorizedAccessException) { werr = "Access revoked during execution."; }
      catch (InvalidOperationException iex) { werr = iex.Message; }
      catch (Exception ex) { werr = ex.GetType().Name + ": " + ex.Message; }
      // Commit: fresh fetch + attempt match + epoch pin; records terminal state.
      try
      {
        Atomic.Run(s, () =>
        {
          if (!s.Jobs.TryGetValue(id, out var fin) || fin is null) throw new InvalidOperationException("gone");
          if (fin.State != "running" || fin.Attempts != claimAttempt) throw new InvalidOperationException("superseded");
          if (s.RestoreEpochId != claimEpoch)
          {
            fin.State = "failed"; fin.Error = "Domain was restored during execution; safe to retry."; fin.UpdatedAt = DateTime.UtcNow;
            s.Jobs[fin.Id] = fin;
            Atomic.Audit(s, new AuditEvent { BoardId = claimBoard == Guid.Empty ? null : claimBoard, Action = "job.restored-discard", Detail = System.Text.Json.JsonSerializer.Serialize(new { job = id }) });
            return;
          }
          if (!wok)
          {
            fin.State = "failed"; fin.Error = werr; fin.UpdatedAt = DateTime.UtcNow;
            s.Jobs[fin.Id] = fin;
            Atomic.Audit(s, new AuditEvent { BoardId = claimBoard == Guid.Empty ? null : claimBoard, Action = "job.failed", Detail = System.Text.Json.JsonSerializer.Serialize(new { job = id, error = werr }) });
            return;
          }
          fin.State = "succeeded"; fin.Error = ""; fin.UpdatedAt = DateTime.UtcNow;
          s.Jobs[fin.Id] = fin;
          Atomic.Audit(s, new AuditEvent { BoardId = claimBoard == Guid.Empty ? null : claimBoard, Action = "job.succeeded", Detail = System.Text.Json.JsonSerializer.Serialize(new { job = id }) });
        });
      }
      catch (SimCEO.Api.Data.CommitUnknownException cux) { return Results.Json(new { error = "Job completion outcome is unknown (the commit may have succeeded); re-read the job before retrying: " + cux.Message }, statusCode: 500); }
      catch (SimCEO.Api.Data.PostCommitException pcx) { return Results.Json(new { error = "Job completion committed, but a post-commit effect failed: " + pcx.Message }, statusCode: 500); }
      catch (AggregateException agx) { return Results.Json(new { error = "Job completion failed and rollback is uncertain: " + agx.Message }, statusCode: 500); }
      catch (InvalidOperationException iox) when (iox.Message == "superseded" || iox.Message == "restored") { return Results.Conflict("Job moved on during execution; re-read before retrying."); }
      catch (InvalidOperationException iox) when (CommitOutcome.IsMissing(iox, "gone")) { return Results.NotFound(); }
      catch (InvalidOperationException iox) { return CommitOutcome.StorageFault("Job completion", iox); }
      catch (Exception ex) { return Results.Json(new { error = "Job completion failed: " + ex.Message }, statusCode: 500); }
      if (!s.Jobs.TryGetValue(id, out var done) || done is null) return Results.NotFound();
      if (done.State == "succeeded") return Results.Ok(new { job = done, detail = wdetail });
      return Results.Json(new { error = done.Error, job = done }, statusCode: 502);
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
      else if (!PeopleOps.IsOwner(req)) return PeopleOps.Denied();
      var now = DateTime.UtcNow;
      var (known, unknown) = ModelGateway.MonthSpend(s);
      decimal? cap; string spendMode;
      try { (cap, spendMode) = PolicyStore.ReadSpend(s); }
      catch (SimCEO.Api.Data.PolicyUnavailableException) { return Results.Json(new { error = "Installation policy store unavailable." }, statusCode: 503); }
      var storageMode = Pg.Backend is null ? "memory-session-lifetime" : "postgres-durable";
      return Results.Ok(new
      {
        month = now.ToString("yyyy-MM"),
        monthlyCapUsd = cap,
        mode = spendMode,
        knownSpendUsd = known,
        unknownCostCalls = unknown,
        overCap = cap.HasValue && known >= cap.Value,
        enforced = spendMode == "block" && cap.HasValue,
        note = unknown > 0
          ? "Some calls have unknown cost (unpriced models or unobservable units); enforcement counts known costs only. Costs are ESTIMATES, not provider invoices."
          : "All recorded costs known. Costs are ESTIMATES, not provider invoices.",
        pricingBasis = new
        {
          checkedDate = UsageAccounting.PricingCheckedDate,
          pricing = UsageAccounting.PricingDocs,
          searchGrounding = UsageAccounting.SearchDocs,
          speechToText = UsageAccounting.SpeechDocs,
          imageGeneration = UsageAccounting.ImageDocs,
        },
        storage = storageMode,
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
      // Parse + type-validate the FULL payload first: a bad mode value
      // or a non-numeric cap fails 400 with zero state change. Unknown mode
      // wording is rejected honestly instead of silently keeping the old mode.
      if (body.ValueKind != JsonValueKind.Object) return Results.BadRequest("body must be a JSON object.");
      decimal? newCap = null; var capPresent = false;
      string? newMode = null; var modePresent = false;
      if (body.TryGetProperty("monthlyCapUsd", out var pc))
      {
        if (pc.ValueKind != JsonValueKind.Number && pc.ValueKind != JsonValueKind.Null)
          return Results.BadRequest("monthlyCapUsd must be a number or null.");
        capPresent = true;
        if (pc.ValueKind == JsonValueKind.Number)
        {
          if (!decimal.TryParse(pc.GetRawText(), System.Globalization.NumberStyles.Number, System.Globalization.CultureInfo.InvariantCulture, out var capDec))
            return Results.BadRequest("monthlyCapUsd is out of range.");
          newCap = capDec;
        }
        else newCap = null;
      }
      if (body.TryGetProperty("mode", out var pm))
      {
        if (pm.ValueKind != JsonValueKind.String)
          return Results.BadRequest("mode must be \"warn\" or \"block\".");
        var mv = (pm.GetString() ?? "").Trim();
        if (mv != "warn" && mv != "block") return Results.BadRequest("Unknown spending mode.");
        modePresent = true; newMode = mv;
      }
      {
        IResult? gateErrSp = null;
        try { Atomic.Run(s, () =>
        {
          if (PeopleOps.IsSecure(s))
          {
            if (!AuthOps.TrySession(s, req, out var sppIn)) { gateErrSp = Results.Json(new { error = "Authentication required." }, statusCode: 401); return; }
            var admSpIn = PeopleOps.AdminEmail(s);
            if (string.IsNullOrWhiteSpace(admSpIn) || !string.Equals(admSpIn, sppIn, StringComparison.OrdinalIgnoreCase)) { gateErrSp = Results.Json(new { error = "Only the installation admin can change spending controls." }, statusCode: 403); return; }
          }
          else if (!PeopleOps.IsOwner(req)) { gateErrSp = Results.Json(new { error = "Only the owner can change spending controls." }, statusCode: 403); return; }
          var (curCap, curMode) = PolicyStore.ReadSpend(s);
          var wantCap = capPresent ? newCap : curCap;
          var wantMode = modePresent ? newMode! : (string.IsNullOrWhiteSpace(curMode) ? "warn" : curMode);
          PolicyStore.WriteSpend(s, wantCap, wantMode);
          Atomic.Audit(s, new AuditEvent { Action = "spending.set", Detail = JsonSerializer.Serialize(new { MonthlyCapUsd = wantCap, Mode = wantMode }) });
        }); }
        catch (SimCEO.Api.Data.PolicyUnavailableException) { return Results.Json(new { error = "Installation policy store unavailable." }, statusCode: 503); }
        if (gateErrSp is not null) return gateErrSp;
        decimal? finCap; string finMode;
        try { (finCap, finMode) = PolicyStore.ReadSpend(s); }
        catch (SimCEO.Api.Data.PolicyUnavailableException) { return Results.Json(new { error = "Installation policy store unavailable." }, statusCode: 503); }
        return Results.Ok(new { MonthlyCapUsd = finCap, Mode = finMode });
      }
    });
  }

  // Thrown inside the restore unit when fresh authority fails: maps to 401
  // (session dead) or 403 (not admin/owner) with NO admin fallback, so a
  // blank or logged-out held request can never restore.
  private sealed class RestoreAuthException(int status, string message) : Exception(message)
  {
    public int Status => status;
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
    if (r.secretaryRequests is not null) foreach (var sr in r.secretaryRequests) if (sr is null) return Err("Backup contains a null entry in secretaryRequests.");
    if (r.noteHistories is not null) foreach (var hh in r.noteHistories) if (hh is null) return Err("Backup contains a null entry in noteHistories.");
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
      // Only board-wide notes (e.g. adopted directions) may carry an empty
      // meeting id. A meeting-scoped note with an empty meeting id is malformed.
      var nscope = (n.Scope ?? "").Trim().ToLowerInvariant();
      if (nscope != "board" && nscope != "meeting")
        return Err("Backup graph: note has an unknown scope.");
      if (nscope == "meeting" && n.MeetingId == Guid.Empty)
        return Err("Backup graph: meeting-scoped note is missing its meeting.");
      if (n.MeetingId != Guid.Empty && (!mids.Contains(n.MeetingId) || meetingBoard[n.MeetingId] != n.BoardId))
        return Err("Backup graph: note references unknown or foreign meeting.");
    }
    foreach (var d in r.drafts)
    {
      if (!bids.Contains(d.BoardId)) return Err("Backup graph: record references unknown board.");
      if (!mids.Contains(d.MeetingId) || meetingBoard[d.MeetingId] != d.BoardId)
        return Err("Backup graph: record references unknown or foreign meeting.");
    }
    // Global leads legitimately carry an empty board id; only board-owned
    // leads must resolve to an exported board.
    foreach (var l in r.leads) if (l.BoardId != Guid.Empty && !bids.Contains(l.BoardId)) return Err("Backup graph: lead references unknown board.");
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
    // Blob linkage, encoding, and byte-identity are owned by the Phase 6 graph
    // validator (422 with exact cause); the legacy structural pass defers them.
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
      if (wz is null) return Err("Backup graph: wizard draft is null.");
      if (wz.Id == Guid.Empty) return Err("Backup graph: wizard draft has no id.");
    }
    foreach (var im in r.images)
    {
      if (im is null) return Err("Backup graph: image entry is null.");
      // Every binary is validated BEFORE any mutation: malformed image data
      // must reject the snapshot instead of throwing mid-replacement.
      if (!string.IsNullOrEmpty(im.data))
      {
        try { Convert.FromBase64String(im.data); }
        catch (FormatException) { return Err("Backup graph: image data is not valid base64."); }
      }
    }
    return null;
  }
}

public static class BackupGraphValidator
{
  static bool Empty(Guid g) => g == Guid.Empty;
  // Full graph validation BEFORE any write. Correct-hash invalid graphs must
  // fail here, never mid-restore. Returns an error string or null when valid.
  public static string? Validate(BackupSnapshot r)
  {
    if (r.boards is null || r.meetings is null || r.messages is null || r.notes is null || r.drafts is null
      || r.sources is null || r.blobs is null || r.leads is null || r.images is null)
      return "Backup snapshot is missing required collections.";
    foreach (var b in r.boards) if (b is null || Empty(b.Id)) return "Backup board missing id.";
    if (r.boards.Select(b => b!.Id).Distinct().Count() != r.boards.Count) return "Backup board ids are not unique.";
    foreach (var m in r.meetings) if (m is null || Empty(m.Id) || Empty(m.BoardId)) return "Backup meeting missing lineage.";
    var boardIds = new HashSet<Guid>(r.boards.Select(b => b!.Id));
    var meetingById = new Dictionary<Guid, Meeting>();
    foreach (var m in r.meetings)
    {
      if (m is null) return "Backup meeting is null.";
      if (!boardIds.Contains(m.BoardId)) return "Backup meeting references a missing board.";
      if (meetingById.ContainsKey(m.Id)) return "Backup meeting ids are not unique.";
      meetingById[m.Id] = m;
    }
    foreach (var l in r.leads) if (l is null || Empty(l.Id)) return "Backup lead is null or missing id.";
    foreach (var x in r.roster) if (x is null || Empty(x.Id)) return "Backup roster entry is null or missing id.";
    foreach (var a in r.advisors) if (a is null || Empty(a.Id) || Empty(a.BoardId) || Empty(a.RosterEntryId)) return "Backup advisor missing lineage.";
    foreach (var g in r.grants ?? Enumerable.Empty<Grant>()) if (g is null || Empty(g.Id)) return "Backup grant missing id.";
    foreach (var iv in r.invites ?? Enumerable.Empty<Invite>()) if (iv is null || Empty(iv.Id)) return "Backup invite missing id.";
    if (r.jobs is not null) { var sj = new HashSet<Guid>(); foreach (var j in r.jobs) { if (j is null || Empty(j.Id)) return "Backup job missing id."; if (!sj.Add(j.Id)) return "Backup job ids are not unique."; } }
    if (r.voiceTurns is not null) { var sv = new HashSet<Guid>(); foreach (var vt in r.voiceTurns) { if (vt is null || Empty(vt.Id)) return "Backup voice turn missing id."; if (!sv.Add(vt.Id)) return "Backup voice turn ids are not unique."; }
      foreach (var vt in r.voiceTurns) {
        if (Empty(vt.BoardId)) return "Backup voice turn missing board.";
        if (Empty(vt.MeetingId)) return "Backup voice turn missing meeting.";
        if (!boardIds.Contains(vt.BoardId)) return "Backup voice turn references a missing board.";
        if (!meetingById.TryGetValue(vt.MeetingId, out var vmt)) return "Backup voice turn references a missing meeting.";
        if (vmt.BoardId != vt.BoardId) return "Backup voice turn board/meeting mismatch.";
        if (vt.State != "draft" && vt.State != "sent") return "Backup voice turn has illegal state.";
      } }
    foreach (var g in r.grants ?? Enumerable.Empty<Grant>()) if (g is null || Empty(g.Id) || Empty(g.BoardId)) return "Backup grant missing lineage.";
    foreach (var i in r.invites ?? Enumerable.Empty<Invite>()) if (i is null || Empty(i.Id) || Empty(i.BoardId)) return "Backup invite missing lineage.";
    foreach (var w in r.wizardDrafts ?? new List<Domain.WizardDraft>()) if (w is null || Empty(w.Id)) return "Backup wizard draft is null or missing id.";
    foreach (var hh in r.heads ?? new List<Domain.SourceFamilyHead>()) if (hh is null || Empty(hh.Id)) return "Backup source head is null or missing id.";
    foreach (var ee in r.events ?? new List<Domain.SourceEvent>()) if (ee is null || Empty(ee.Id)) return "Backup source event is null or missing id.";
    foreach (var img in r.images) if (img is null || Empty(img.id)) return "Backup image is null or missing id.";
    foreach (var kv in r.messages)
    {
      if (kv.Value is null) continue;
      foreach (var mm in kv.Value)
      {
        if (mm is null) return "Backup message row is null.";
        if (mm.Sender is null || mm.Content is null) return "Backup message has null sender or content.";
      }
    }
    foreach (var x in r.sources) if (x is null || Empty(x.Id) || Empty(x.BoardId)) return "Backup source missing lineage.";
    foreach (var ss in r.sections ?? new List<Domain.SourceSection>()) if (ss is null || Empty(ss.Id) || Empty(ss.SourceId)) return "Backup source section missing lineage.";
    // Record graphs are validated by the ONE shared complete staged validator (Records F2): typed history
    // + final revision/token/actor/item correspondence, approved/discarded disjointness, supersedes
    // parent/cycle, snapshot declared-ref/approved/version/dedup, scope IDs/hash/state. The legacy inline
    // loop (which demanded SupersedesJson OBJECTS while healthy amend writes STRING ids) is REPLACED here,
    // not stacked: this call is the only record-graph gate before destructive replacement.
    // Staged source-version maps (F3/P1): built from the staged graph's own
    // sources+migrate-version events via the shared helper, so alias and
    // canonical validation reflect actual staged provenance, never caller invention.
    // Canonical identity is the referenced row's own Version (never the head/max).
    var (sourceOriginals, sourceCanonicals) = RecordsOps.BuildSourceVersionMaps(
      r.sources ?? Enumerable.Empty<Domain.SourceDoc>(),
      r.events ?? Enumerable.Empty<Domain.SourceEvent>());
    // Controlled old-schema legacy-marker import (F2/P1): pre-marker backups (version<4)
    // carry no LegacyReview property, so missing (null) markers become true ONLY where
    // the recognized old prehistory shape and genuine base contract validate. Modern v4
    // exports always carry an explicit marker, so a wiped v4 row retains null/false and
    // fails closed below. No decisions or history are invented.
    if (r.drafts is not null) RecordsOps.ApplyLegacyMarkerBackfill(r.drafts, r.version);
    // Adoptability tokens for newly marked legacy rows (F2/P1): the existing fresh-review
    // and copy workflows match on the review token, so a backfilled legacy row with a blank
    // token would be unreviewable. Assign the deterministic boot-style legacy token ONLY to
    // just-marked rows that still lack one; user bytes, hashes, decisions, and history are
    // untouched, and modern rows (explicit marker or non-blank history) never match.
    if (r.drafts is not null)
      foreach (var ld in r.drafts)
        if (ld is not null && ld.LegacyReview == true && string.IsNullOrWhiteSpace(ld.ReviewToken)
          && ld.ReviewRevision <= 1 && RecordsOps.IsBlankJsonArray(ld.HistoryJson)
          && RecordsOps.IsBlankJsonArray(ld.EvidenceSnapshotJson))
          ld.ReviewToken = RecordsOps.LegacyReviewToken(ld.Id, ld.Version, ld.Hash ?? "");
    var recordErr = RecordsOps.ValidateRestoreEntries(r.drafts, sourceOriginals, sourceCanonicals);
    if (recordErr is not null) return recordErr;
    // Effective binaries must decode before any live mutation: malformed base64 rejects (no silent Data=null loss).
    if (r.blobs is not null)
    {
      foreach (var kv in r.blobs)
      {
        if (string.IsNullOrEmpty(kv.Value)) continue;
        try { Convert.FromBase64String(kv.Value); }
        catch (FormatException) { return "Backup blob is not valid base64."; }
      }
    }
    var noteIds = new HashSet<Guid>();
    foreach (var n in r.notes)
    {
      if (n is null || Empty(n.Id)) return "Backup note missing id.";
      if (!string.IsNullOrWhiteSpace(n.EvidenceJson))
      {
        try
        {
          using var _ne = System.Text.Json.JsonDocument.Parse(n.EvidenceJson);
          if (_ne.RootElement.ValueKind != System.Text.Json.JsonValueKind.Array) return "Backup note evidence must be an array.";
          foreach (var _el in _ne.RootElement.EnumerateArray())
          {
            if (EvidenceRef.Parse(_el) is null) return "Backup note evidence entry must carry kind and ref.";
          }
        }
        catch (System.Text.Json.JsonException) { return "Backup note evidence is not valid JSON."; }
      }
      if (!noteIds.Add(n.Id)) return "Backup note ids are not unique.";
      if (Empty(n.RootId)) n.RootId = n.Id;
      if (Empty(n.BoardId)) return "Backup note missing parent scope.";
      if (n.Kind != "direction" || n.Scope != "board") { if (Empty(n.MeetingId)) return "Backup note missing parent scope."; }
      else if (!Empty(n.MeetingId)) return "Backup board-wide note must not carry a meeting scope.";
      if (!Empty(n.MeetingId))
      {
        if (!meetingById.TryGetValue(n.MeetingId, out var pm) || pm.BoardId != n.BoardId) return "Backup note references a missing parent meeting.";
      }
      else if (!boardIds.Contains(n.BoardId)) return "Backup note references a missing parent board.";
      if (n.Revision < 1) return "Backup note revision invalid.";
      if (n.NoteStatus != "current" && n.NoteStatus != "superseded" && n.NoteStatus != "reversed") return "Backup note status invalid.";
    }
    var byId = r.notes.ToDictionary(n => n!.Id);
    var currentsPerRoot = new Dictionary<Guid, int>();
    foreach (var n in r.notes)
    {
      var root = n!.RootId;
      if (!byId.TryGetValue(root, out var head)) return "Backup note root has no chain head.";
      if (head.BoardId != n.BoardId || head.MeetingId != n.MeetingId) return "Backup note chain crosses board or meeting scope.";
      if (head.Revision != 1 || head.PredecessorId.HasValue) return "Backup note root is not the chain head revision.";
      if (n.NoteStatus == "current") currentsPerRoot[root] = currentsPerRoot.TryGetValue(root, out var c) ? c + 1 : 1;
      if (n.Revision > 1 && !n.PredecessorId.HasValue) return "Backup note revision above one requires a predecessor.";
      if (n.PredecessorId.HasValue)
      {
        if (!byId.TryGetValue(n.PredecessorId.Value, out var pred)) return "Backup note predecessor missing.";
        if ((pred.RootId == Guid.Empty ? pred.Id : pred.RootId) != root) return "Backup note predecessor crosses lineage.";
        if (pred.BoardId != n.BoardId || pred.MeetingId != n.MeetingId) return "Backup note predecessor crosses scope.";
        if (pred.Revision != n.Revision - 1) return "Backup note revision chain is not continuous.";
        var steps = 0;
        var walk = n;
        while (walk!.PredecessorId.HasValue && steps <= r.notes.Count)
        {
          walk = byId[walk.PredecessorId.Value];
          steps++;
          if (walk.Id == n.Id) return "Backup note lineage contains a cycle.";
        }
        if (steps > r.notes.Count) return "Backup note lineage contains a cycle.";
      }
    }
    foreach (var kv in currentsPerRoot) if (kv.Value != 1) return "Backup note root has duplicate current revisions.";
    // Linear unique chain: no duplicate revisions, no forks, single terminal tip consistent.
    {
      var byRoot = new Dictionary<Guid, List<Domain.Note>>();
      foreach (var n in r.notes)
      {
        var rt = n!.RootId == Guid.Empty ? n.Id : n.RootId;
        if (!byRoot.TryGetValue(rt, out var lst)) { lst = new List<Domain.Note>(); byRoot[rt] = lst; }
        lst.Add(n);
      }
      foreach (var kv in byRoot)
      {
        var chain = kv.Value.OrderBy(x => x.Revision).ToList();
        // No duplicate revisions per root
        if (chain.Select(x => x.Revision).Distinct().Count() != chain.Count) return "Backup note revisions are not unique per chain.";
        // Non-root revision-1 forbidden: revision 1 must be the self-identifying root
        foreach (var nn in chain)
        {
          var isRoot = nn.Id == kv.Key;
          if (nn.Revision == 1 && !isRoot) return "Backup note revision 1 must be the chain root.";
          if (isRoot && nn.Revision != 1) return "Backup note root must be revision 1.";
          if (isRoot && nn.PredecessorId.HasValue) return "Backup note root must not have a predecessor.";
        }
        // No forks: each predecessor may have at most one successor
        var succCount = new Dictionary<Guid, int>();
        foreach (var nn in chain)
        {
          if (nn.PredecessorId.HasValue)
          {
            var pk = nn.PredecessorId.Value;
            succCount[pk] = succCount.TryGetValue(pk, out var c) ? c + 1 : 1;
            if (succCount[pk] > 1) return "Backup note chain has a fork.";
          }
        }
        // Terminal tip consistent: at most one current per chain; when present it must be the max revision.
        // Backward compatible: legacy/operational chains with zero currents remain readable (no auto-repair).
        var maxRev = chain.Max(x => x.Revision);
        var currents = chain.Where(x => x.NoteStatus == "current").ToList();
        if (currents.Count > 1) return "Backup note chain must have exactly one current tip.";
        if (currents.Count == 1 && currents[0].Revision != maxRev) return "Backup note current tip is not the terminal revision.";
        if (currents.Count == 0)
        {
          var tip0 = chain.OrderByDescending(x => x.Revision).First();
          bool legacyReadable = chain.All(x => !x.Provisional) || chain.All(x => x.Kind == "direction");
          if (tip0.NoteStatus != "reversed" && !legacyReadable) return "Backup note chain has no current or reversed terminal tip.";
        }
        // Backward-compatible operational notes / board directions: they share the same linear shape above.
      }
    }
    var histIds = new HashSet<Guid>();
    foreach (var h in r.noteHistories ?? new List<Domain.NoteHistory>())
    {
      if (h is null || Empty(h.Id) || Empty(h.RootId) || Empty(h.NoteId)) return "Backup history row missing lineage.";
      if (Empty(h.BoardId) || Empty(h.MeetingId)) return "Backup history row missing parent scope.";
      if (!byId.TryGetValue(h.NoteId, out var hn)) return "Backup history references a missing note.";
      var hroot = hn.RootId == Guid.Empty ? hn.Id : hn.RootId;
      if (h.RootId != hroot) return "Backup history root does not match its note lineage.";
      if (h.BoardId != hn.BoardId || h.MeetingId != hn.MeetingId) return "Backup history scope does not match its note.";
      if (h.Revision != hn.Revision) return "Backup history revision does not match its note revision.";
      if (!histIds.Add(h.Id)) return "Backup history ids are not unique.";
      if (h.Action != "created" && h.Action != "edited" && h.Action != "superseded" && h.Action != "reversed") return "Backup history action is not a known lifecycle action.";
      // History must match its EXACT addressed note (not any same-numbered sibling).
      if (!string.Equals(hn.Title ?? "", h.Title ?? "", StringComparison.Ordinal) || !string.Equals(hn.Body ?? "", h.Body ?? "", StringComparison.Ordinal) || !string.Equals(hn.EvidenceJson ?? "[]", h.EvidenceJson ?? "[]", StringComparison.Ordinal))
        return "Backup history body does not match its referenced revision content.";
      if (!string.IsNullOrWhiteSpace(h.EvidenceJson))
      {
        try
        {
          using var _he = System.Text.Json.JsonDocument.Parse(h.EvidenceJson);
          if (_he.RootElement.ValueKind != System.Text.Json.JsonValueKind.Array) return "Backup history evidence must be an array.";
          foreach (var _hel in _he.RootElement.EnumerateArray())
          {
            if (EvidenceRef.Parse(_hel) is null) return "Backup history evidence entry must carry kind and ref.";
          }
        }
        catch { return "Backup history evidence is not valid JSON."; }
      }
    }
    var noncePerMeeting = new Dictionary<string, int>();
    var reqIds = new HashSet<Guid>();
    var reqNoteIds = new HashSet<Guid?>();
    foreach (var sr in r.secretaryRequests ?? new List<Domain.SecretaryRequest>())
    {
      if (sr is null || Empty(sr.Id)) return "Backup secretary request missing id.";
      if (!reqIds.Add(sr.Id)) return "Backup secretary request ids are not unique.";
      if (Empty(sr.BoardId) || Empty(sr.MeetingId)) return "Backup secretary request missing parent scope.";
      if (!meetingById.TryGetValue(sr.MeetingId, out var rm) || rm.BoardId != sr.BoardId) return "Backup secretary request references a missing parent meeting.";
      if (string.IsNullOrWhiteSpace(sr.ClientNonce)) return "Backup secretary request missing nonce.";
      var key = sr.MeetingId + "|" + sr.ClientNonce.Trim();
      if (noncePerMeeting.ContainsKey(key)) return "Backup secretary request nonce is not unique per meeting.";
      noncePerMeeting[key] = 1;
      if (sr.Status != "pending" && sr.Status != "inflight" && sr.Status != "answering" && sr.Status != "needs-clarification" && sr.Status != "completed" && sr.Status != "failed" && sr.Status != "discarded" && sr.Status != "interrupted")
        return "Backup secretary request status invalid.";
      if (sr.Phase != "initial" && sr.Phase != "continuation") return "Backup secretary request phase invalid.";
      if (string.IsNullOrWhiteSpace(sr.InputHash) || string.IsNullOrWhiteSpace(sr.InputText)) return "Backup secretary request missing input identity.";
      // Complete phase/question/answer/status relationships: initial must have no question/answer; continuation must have question.
      if (sr.Phase == "initial" && !string.IsNullOrWhiteSpace(sr.Question)) return "Backup initial request must not carry a question.";
      if (sr.Phase == "initial" && !string.IsNullOrWhiteSpace(sr.Answer)) return "Backup initial request must not carry an answer.";
      if (sr.Phase == "continuation" && string.IsNullOrWhiteSpace(sr.Question)) return "Backup continuation request missing question lineage.";
      if (!string.IsNullOrWhiteSpace(sr.Answer) && string.IsNullOrWhiteSpace(sr.Question)) return "Backup answer is missing its question lineage.";
      // Unusable accepted state: initial + question + failed must reject (neither endpoint can use it).
      if (sr.Phase == "initial" && !string.IsNullOrWhiteSpace(sr.Question)) return "Backup request has unusable initial+question state.";
      if (sr.Status == "answering" && (sr.Phase != "continuation" || string.IsNullOrWhiteSpace(sr.Question))) return "Backup answering request must be a continuation with a question.";
      if (sr.Status == "needs-clarification" && (sr.Phase != "continuation" || string.IsNullOrWhiteSpace(sr.Question))) return "Backup needs-clarification request must be a continuation with a question.";
      if (sr.NoteId.HasValue)
      {
        if (!byId.TryGetValue(sr.NoteId.Value, out var rn)) return "Backup secretary request references a missing note.";
        if (rn.BoardId != sr.BoardId || rn.MeetingId != sr.MeetingId) return "Backup secretary request note crosses board or meeting scope.";
        if (sr.Status != "completed") return "Backup secretary request note pointer without completed status.";
      }
      if (sr.Status == "completed" && !sr.NoteId.HasValue) return "Backup completed request is missing its note pointer.";
      if (sr.Status == "completed" && sr.Phase == "continuation" && (string.IsNullOrWhiteSpace(sr.Answer) || sr.AnswerAttemptId == Guid.Empty)) return "Backup completed continuation is missing its answer lineage.";
      if (!SimCEO.Api.Work.SecretaryContext.TryParseSnapshot(sr.SnapshotJson, out _)) return "Backup secretary request snapshot is invalid.";
      if (Empty(sr.AttemptId)) return "Backup secretary request is missing its attempt identity.";
      if (!string.IsNullOrWhiteSpace(sr.CallerRefsJson))
      {
        try { using var d = System.Text.Json.JsonDocument.Parse(sr.CallerRefsJson); if (d.RootElement.ValueKind != System.Text.Json.JsonValueKind.Array) return "Backup caller refs are not an array."; }
        catch { return "Backup caller refs are not valid JSON."; }
        var rehydrated = SimCEO.Api.Work.SecretaryDirect.RehydrateRawCallerRefs(sr.CallerRefsJson);
        var recanon = SimCEO.Api.Work.SecretaryDirect.RawCallerIdentityJson(rehydrated);
        List<SimCEO.Api.Work.EvidenceRef> resorted;
        try
        {
          using var ds = System.Text.Json.JsonDocument.Parse(sr.CallerRefsJson);
          resorted = new List<SimCEO.Api.Work.EvidenceRef>();
          foreach (var el in ds.RootElement.EnumerateArray())
          {
            var one = SimCEO.Api.Work.EvidenceRef.Parse(el);
            if (one is not null) resorted.Add(one);
          }
        }
        catch { return "Backup caller refs are not valid JSON."; }
        var storedCanon = SimCEO.Api.Work.SecretaryDirect.RawCallerIdentityJson(resorted);
        if (!string.Equals(recanon, storedCanon, StringComparison.Ordinal)) return "Backup caller refs identity is inconsistent.";
        if (!string.IsNullOrWhiteSpace(sr.SubmissionHash))
        {
          var recomputed = SimCEO.Api.Work.Hashing.HashOf((sr.InputText ?? "") + "\n||SUBMIT||\n" + storedCanon);
          var subOk = string.Equals(recomputed, sr.SubmissionHash, StringComparison.OrdinalIgnoreCase);
          if (!subOk && SimCEO.Api.Work.SecretaryDirect.IsLegacyCallerIdentityJson(sr.CallerRefsJson))
          {
            var legacyCanon = SimCEO.Api.Work.SecretaryDirect.RawCallerIdentityJsonLegacy(resorted);
            var legacyRecomputed = SimCEO.Api.Work.Hashing.HashOf((sr.InputText ?? "") + "\n||SUBMIT||\n" + legacyCanon);
            subOk = string.Equals(legacyRecomputed, sr.SubmissionHash, StringComparison.OrdinalIgnoreCase);
          }
          if (!subOk) return "Backup submission hash does not match its input identity (request " + sr.Id + ").";
        }
      }
      else if (!string.IsNullOrWhiteSpace(sr.SubmissionHash)) return "Backup submission hash has no caller identity.";
      if ((sr.Status == "inflight" || sr.Status == "answering" || sr.Status == "pending") && sr.AnswerAttemptId == Guid.Empty && sr.AttemptId == Guid.Empty)
        return "Backup in-flight request is missing its attempt identity.";
      if (!string.IsNullOrWhiteSpace(sr.Answer) && sr.AnswerAttemptId == Guid.Empty && (sr.Status == "answering" || sr.Status == "completed"))
        return "Backup answered request is missing its continuation attempt identity.";
      if (!string.IsNullOrWhiteSpace(sr.Answer) && sr.AnswerAttemptId == Guid.Empty)
        return "Backup continuation answer is missing its attempt identity.";
      if (!string.IsNullOrWhiteSpace(sr.DeliveredRefsJson))
      {
        try
        {
          using var _dr = System.Text.Json.JsonDocument.Parse(sr.DeliveredRefsJson);
          if (_dr.RootElement.ValueKind != System.Text.Json.JsonValueKind.Array) return "Backup delivered refs must be an array.";
          foreach (var _el in _dr.RootElement.EnumerateArray())
          {
            if (EvidenceRef.Parse(_el) is null) return "Backup delivered ref entry must carry kind and ref.";
          }
        }
        catch { return "Backup delivered refs are not valid JSON."; }
      }
      // Omitted manifest (persisted complete omission list) must be an array when present.
      try
      {
        var _om = sr.OmittedJson;
        if (!string.IsNullOrWhiteSpace(_om))
        {
          using var _do = System.Text.Json.JsonDocument.Parse(_om);
          if (_do.RootElement.ValueKind != System.Text.Json.JsonValueKind.Array) return "Backup omitted manifest must be an array.";
          foreach (var _oe in _do.RootElement.EnumerateArray())
          {
            if (_oe.ValueKind != System.Text.Json.JsonValueKind.String) return "Backup omitted manifest entries must be strings.";
          }
        }
      }
      catch { return "Backup omitted manifest is not valid JSON."; }
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
  List<BackupImage> images, List<Domain.WizardDraft>? wizardDrafts = null, List<Domain.SourceSection>? sections = null, List<Domain.SourceFamilyHead>? heads = null, List<Domain.SourceEvent>? events = null, List<Domain.SecretaryRequest>? secretaryRequests = null, List<Domain.NoteHistory>? noteHistories = null, List<JobRow>? jobs = null, List<VoiceTurn>? voiceTurns = null, List<Grant>? grants = null, List<Invite>? invites = null);

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
