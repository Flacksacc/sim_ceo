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

    app.MapPost("/api/jobs/{id:guid}/retry", (InMemoryStore s, Guid id) =>
    {
      if (!s.Jobs.TryGetValue(id, out var job)) return Results.NotFound();
      if (job.State != "failed")
        return Results.Conflict("Only a failed step offers Retry; otherwise the last checkpoint stands.");
      job.State = "pending";
      job.UpdatedAt = DateTime.UtcNow;
      s.Audit.Add(new AuditEvent { Action = "job.retry", Detail = JsonSerializer.Serialize(new { id, job.Kind, job.IdempotencyKey }) });
      return Results.Ok(job);
    });

    app.MapGet("/api/boards/{bid:guid}/status", (InMemoryStore s, Guid bid) =>
    {
      if (!s.Boards.TryGetValue(bid, out var b)) return Results.NotFound();
      var advisors = s.Advisors.Values.Where(a => a.BoardId == bid && !a.Removed).ToList();
      var meetings = s.Meetings.Values.Where(m => m.BoardId == bid).ToList();
      return Results.Ok(new
      {
        board = b.Name,
        active = b.ActiveConfig,
        dirty = !string.Equals(b.DraftJson, b.ActiveJson, StringComparison.Ordinal),
        name = !string.IsNullOrWhiteSpace(b.Name),
        lead = LeadSetup.ResolveLead(s) is not null,
        leadVersion = LeadSetup.ResolveLead(s)?.Version ?? 0,
        advisors = new { total = advisors.Count, approved = advisors.Count(a => a.Approved) },
        meetings = new
        {
          total = meetings.Count,
          active = meetings.Count(m => m.State is MeetingState.Active or MeetingState.Paused),
        },
        sourcesPending = s.Sources.Values.Count(x => x.BoardId == bid && !x.Approved && !x.Excluded),
        jobsFailed = s.Jobs.Values.Count(j => j.State == "failed"),
        policy = b.DiscussionPolicy,
        retainAudio = b.RetainAudio,
      });
    });

    app.MapGet("/api/boards/{bid:guid}/recall", async (InMemoryStore s, HttpRequest req, Guid bid, string q, int take = 8) =>
    {
      if (!PeopleOps.Can(s, req, bid, null, "read")) return PeopleOps.Denied();
      if (string.IsNullOrWhiteSpace(q)) return Results.BadRequest("q is required.");
      var local = ContextCurator.Recall(s, bid, q, take);
      var remote = await Hindsight.SearchAsync(bid, q, take);
      if (remote.Count == 0) return Results.Ok(local);
      return Results.Ok(local.Concat(remote)
        .OrderByDescending(h => h.Score).Take(Math.Clamp(take, 1, 20)).ToList());
    });

    app.MapGet("/api/boards/{bid:guid}/export", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (!s.Boards.TryGetValue(bid, out var b)) return Results.NotFound();
      if (!PeopleOps.Can(s, req, bid, null, "manage")) return PeopleOps.Denied();
      var snapshot = new
      {
        version = 1,
        board = b,
        lead = s.LeadProfiles.Values.Where(l => l.BoardId == bid).OrderByDescending(l => l.Version).FirstOrDefault(),
        advisors = s.Advisors.Values.Where(a => a.BoardId == bid && !a.Removed).ToList(),
        exportedAt = DateTime.UtcNow,
      };
      // Web (camelCase) casing: /api/boards/import reads lowercase property names.
      var json = JsonSerializer.Serialize(snapshot, new JsonSerializerOptions(JsonSerializerDefaults.Web));
      return Results.Ok(new { snapshot = json, hash = Hashing.FullHash(Encoding.UTF8.GetBytes(json)) });
    });

    app.MapPost("/api/boards/import", (InMemoryStore s, JsonElement body) =>
    {
      var snapshot = body.TryGetProperty("snapshot", out var sn) ? sn.GetString() ?? "" : "";
      var hash = body.TryGetProperty("hash", out var h) ? h.GetString() ?? "" : "";
      if (string.IsNullOrWhiteSpace(snapshot)) return Results.BadRequest("snapshot is required.");
      if (!string.Equals(Hashing.FullHash(Encoding.UTF8.GetBytes(snapshot)), hash, StringComparison.OrdinalIgnoreCase))
        return Results.Conflict("Snapshot hash mismatch; import the exact exported text.");
      JsonDocument doc;
      try { doc = JsonDocument.Parse(snapshot); }
      catch (JsonException) { return Results.BadRequest("snapshot is not valid JSON."); }
      var root = doc.RootElement;
      if (!root.TryGetProperty("version", out var v) || v.GetInt32() != 1)
        return Results.BadRequest("Unsupported snapshot version.");
      var src = root.GetProperty("board");
      var board = new Board
      {
        Name = src.GetProperty("name").GetString() ?? "Imported",
        Mission = src.TryGetProperty("mission", out var mi) ? mi.GetString() ?? "" : "",
        Stage = src.TryGetProperty("stage", out var st) ? st.GetString() ?? "" : "",
        ActiveConfig = false,
      };
      s.Boards[board.Id] = board;
      if (root.TryGetProperty("lead", out var lead) && lead.ValueKind == JsonValueKind.Object)
      {
        var lp = new LeadProfile
        {
          BoardId = board.Id, Version = 1,
          Name = lead.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "",
          RoleLabel = "Board Lead",
          Background = lead.TryGetProperty("background", out var bg) ? bg.GetString() ?? "" : "",
        };
        s.LeadProfiles[lp.Id] = lp;
        board.LeadProfileVersion = 1;
      }
      var copied = 0;
      if (root.TryGetProperty("advisors", out var advs) && advs.ValueKind == JsonValueKind.Array)
        foreach (var a in advs.EnumerateArray())
        {
          s.Advisors[Guid.NewGuid()] = new BoardAdvisor
          {
            Id = Guid.NewGuid(), BoardId = board.Id,
            RosterEntryId = a.TryGetProperty("rosterEntryId", out var re) ? re.GetGuid() : Guid.Empty,
            RosterVersion = a.TryGetProperty("rosterVersion", out var rv) ? rv.GetInt32() : 1,
            BoardRole = a.TryGetProperty("boardRole", out var br) ? br.GetString() ?? "" : "",
            Approved = false,
          };
          copied++;
        }
      s.Audit.Add(new AuditEvent { BoardId = board.Id, Action = "setup.import", Detail = JsonSerializer.Serialize(new { advisors = copied, reReview = true }) });
      return Results.Created($"/api/boards/{board.Id}/setup",
        new { board, advisors = copied, note = "Imported configuration needs review: advisors are unapproved and nothing is activated." });
    });

    app.MapPost("/api/wizard/{id:guid}/extract", (InMemoryStore s, Guid id, JsonElement body) =>
    {
      if (!s.WizardDrafts.TryGetValue(id, out var d)) return Results.NotFound();
      if (!body.TryGetProperty("sourceId", out var se) || se.ValueKind != JsonValueKind.String
        || !Guid.TryParse(se.GetString(), out var sourceId) || sourceId == Guid.Empty)
        return Results.BadRequest("sourceId is required.");
      if (!s.Sources.TryGetValue(sourceId, out var doc)) return Results.NotFound("source");
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
        approved = doc.Approved,
        extractedAt = DateTime.UtcNow,
        chars = doc.Original?.Length ?? 0,
        extractor = "direct-read",
      };
      log.Add(checkpoint);
      d.ProvenanceJson = JsonSerializer.Serialize(log);
      d.UpdatedAt = DateTime.UtcNow;
      return Results.Ok(new { checkpoints = log.Count, latest = checkpoint });
    });

    app.MapGet("/api/wizard/{id:guid}/extract", (InMemoryStore s, Guid id) =>
      !s.WizardDrafts.TryGetValue(id, out var d) ? Results.NotFound()
      : Results.Ok(new { checkpoints = d.ProvenanceJson }));

    app.MapGet("/api/backup", (InMemoryStore s, HttpRequest req) =>
    {
      if (!PeopleOps.IsOwner(req))
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
        sources = s.Sources.Values.ToList(),
        blobs = s.Sources.Values.ToDictionary(
          x => x.Id.ToString(), x => x.Original is null ? "" : Convert.ToBase64String(x.Original)),
        leads = s.LeadProfiles.Values.ToList(),
          wizardDrafts = s.WizardDrafts.Values.ToList(),
        grants = s.Grants.Values.ToList(),
        invites = s.Invites.Values.ToList(),
        images = s.Images.Values.Select(i => new { i.Id, i.RosterEntryId, i.BoardAdvisorId, i.Kind, i.Provenance, i.ContentType, data = i.Data is null ? null : Convert.ToBase64String(i.Data) }).ToList(),
      };
      var json = JsonSerializer.Serialize(snapshot);
      return Results.Ok(new { snapshot = json, hash = Hashing.FullHash(Encoding.UTF8.GetBytes(json)), bytes = json.Length });
    });

    app.MapPost("/api/backup/restore", (InMemoryStore s, HttpRequest req, JsonElement body) =>
    {
      if (!PeopleOps.IsOwner(req))
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
      lock (s.SetupLock)
      {
        s.Boards.Clear(); s.Roster.Clear(); s.Advisors.Clear(); s.Meetings.Clear(); s.Messages.Clear();
        s.Notes.Clear(); s.Drafts.Clear(); s.Sources.Clear();
        s.LeadProfiles.Clear(); s.Grants.Clear(); s.Invites.Clear(); s.Images.Clear(); s.WizardDrafts.Clear();
        foreach (var b in restored.boards) s.Boards[b.Id] = b;
        foreach (var r in restored.roster) s.Roster[r.Id] = r;
        foreach (var a in restored.advisors) s.Advisors[a.Id] = a;
        foreach (var m in restored.meetings) s.Meetings[m.Id] = m;
        foreach (var kv in restored.messages)
          if (Guid.TryParse(kv.Key, out var mid)) s.Messages[mid] = MessageList.Detached(mid, kv.Value);
        foreach (var n in restored.notes) s.Notes[n.Id] = n;
        foreach (var d in restored.drafts) s.Drafts[d.Id] = d;
        foreach (var x in restored.sources) s.Sources[x.Id] = x;
        foreach (var kv in restored.blobs)
          if (Guid.TryParse(kv.Key, out var bid2))
            if (s.Sources.TryGetValue(bid2, out var bdoc))
              try { bdoc.Original = Convert.FromBase64String(kv.Value); } catch (FormatException) { }
        s.Sources.Flush();
        foreach (var img in restored.images)
        {
          byte[]? data = null;
          if (img.data is not null) try { data = Convert.FromBase64String(img.data); } catch (FormatException) { }
          s.Images[img.id] = new AdvisorImage
          {
            Id = img.id, RosterEntryId = img.rosterEntryId, BoardAdvisorId = img.boardAdvisorId,
            Kind = img.kind ?? "upload", Provenance = img.provenance ?? "",
            ContentType = img.contentType ?? "image/png", Data = data,
          };
        }
        foreach (var l in restored.leads) s.LeadProfiles[l.Id] = l;
        foreach (var g in restored.grants) s.Grants[g.Id] = g;
        foreach (var i in restored.invites) s.Invites[i.Id] = i;
        if (restored.wizardDrafts is not null) foreach (var w in restored.wizardDrafts) s.WizardDrafts[w.Id] = w;
        s.Audit.Add(new AuditEvent { Action = "backup.restore", Detail = JsonSerializer.Serialize(new { restored.at, boards = restored.boards.Count }) });
      }
      return Results.Ok(new { restored = restored.boards.Count, at = restored.at });
    });

    app.MapGet("/api/commands", () => Results.Ok(CommandMap.All));

    app.MapGet("/api/spending", (InMemoryStore s) =>
    {
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
      if (!PeopleOps.IsOwner(req))
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
}

public sealed record BackupImage(Guid id, Guid? rosterEntryId, Guid? boardAdvisorId,
  string kind, string provenance, string contentType, string? data);

public sealed record BackupSnapshot(int version, DateTime at,
  List<Board> boards, List<RosterEntry> roster, List<BoardAdvisor> advisors,
  List<Meeting> meetings, Dictionary<string, List<Message>> messages,
  List<Note> notes, List<RecordDraft> drafts, List<SourceDoc> sources,
  Dictionary<string, string> blobs, List<LeadProfile> leads,
  List<Grant> grants, List<Invite> invites, List<BackupImage> images, List<Domain.WizardDraft>? wizardDrafts = null);

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
