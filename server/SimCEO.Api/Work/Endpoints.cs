using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using Microsoft.AspNetCore.SignalR;
using SimCEO.Api.Hubs;
using SimCEO.Api.Work;

namespace SimCEO.Api;

public static class SimCEOEndpoints
{
  public static void MapExtended(this WebApplication app)
  {
    var gw = new ModelGateway(app.Services.GetRequiredService<InMemoryStore>());

    app.MapGet("/api/presets", () => Results.Ok(PresetLibrary.All));
    app.MapGet("/api/presets/{key}", (string key) =>
      PresetLibrary.Find(key) is { } p ? Results.Ok(p) : Results.NotFound());

    // ---- Board lead profile ("Your Profile"): explicit versioned save ----
    app.MapGet("/api/boards/{bid:guid}/lead", (InMemoryStore s, Guid bid) =>
    {
      var cur = s.LeadProfiles.Values.Where(l => l.BoardId == bid).OrderByDescending(l => l.Version).FirstOrDefault();
      return cur is null ? Results.NotFound() : Results.Ok(cur);
    });
    app.MapPost("/api/boards/{bid:guid}/lead", (InMemoryStore s, Guid bid, LeadProfile input) =>
    {
      var (saved, error, status) = LeadSetup.SaveLead(s, bid, input);
      return saved is not null ? Results.Ok(saved) : Results.Json(new { error }, statusCode: status);
    });
    app.MapGet("/api/lead", (InMemoryStore s) =>
    {
      var cur = LeadSetup.ResolveLead(s);
      return cur is null ? Results.NotFound() : Results.Ok(cur);
    });
    app.MapPost("/api/lead", (InMemoryStore s, LeadProfile input) =>
    {
      var (gsaved, gerror, gstatus) = LeadSetup.SaveLead(s, Guid.Empty, input);
      return gsaved is not null ? Results.Ok(gsaved) : Results.Json(new { error = gerror }, statusCode: gstatus);
    });

    // ---- Board fields edit (stays a draft until setup activation) ----
    app.MapPatch("/api/boards/{id:guid}", (InMemoryStore s, Guid id, JsonElement body) =>
    {
      if (!s.Boards.TryGetValue(id, out var b)) return Results.NotFound();
      lock (s.SetupLock)
      {
        if (body.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String) b.Name = n.GetString() ?? "";
        if (body.TryGetProperty("mission", out var m) && m.ValueKind == JsonValueKind.String) b.Mission = m.GetString() ?? "";
        if (body.TryGetProperty("stage", out var st) && st.ValueKind == JsonValueKind.String) b.Stage = st.GetString() ?? "";
        if (body.TryGetProperty("retainAudio", out var ra) && (ra.ValueKind == JsonValueKind.True || ra.ValueKind == JsonValueKind.False)) b.RetainAudio = ra.GetBoolean();
        if (body.TryGetProperty("discussionPolicy", out var dp) && dp.GetString() is { } pol
            && (pol == "focused" || pol == "balanced" || pol == "open")) b.DiscussionPolicy = pol;
        if (body.TryGetProperty("dataUse", out var du) && du.GetString() is { } dataUse
            && (dataUse == "standard" || dataUse == "contributor")) b.DataUse = dataUse;
        if (body.TryGetProperty("archived", out var ar)
            && (ar.ValueKind == JsonValueKind.True || ar.ValueKind == JsonValueKind.False)) b.Archived = ar.ValueKind == JsonValueKind.True;
        b.DraftJson = JsonSerializer.Serialize(new { b.Name, b.Mission, b.Stage, b.RetainAudio, b.DiscussionPolicy, at = DateTime.UtcNow });
        return Results.Ok(b);
      }
    });

    // ---- Setup review + activation (exact reviewed draft only) ----
    app.MapGet("/api/boards/{bid:guid}/setup", (InMemoryStore s, Guid bid) =>
    {
      if (!s.Boards.TryGetValue(bid, out var b)) return Results.NotFound();
      var lead = LeadSetup.ResolveLead(s);
      var total = s.Advisors.Values.Count(a => a.BoardId == bid && !a.Removed);
      var approved = s.Advisors.Values.Count(a => a.BoardId == bid && !a.Removed && a.Approved);
      return Results.Ok(new
      {
        board = new { b.Id, b.Name, b.Mission, b.Stage, b.ActiveConfig, b.LeadProfileVersion, b.RetainAudio, b.DiscussionPolicy, b.DataUse },
        draftJson = b.DraftJson, activeJson = b.ActiveJson,
        draftHash = Hashing.HashOf(b.DraftJson),
        dirty = !string.Equals(b.DraftJson, b.ActiveJson, StringComparison.Ordinal),
        lead, advisors = new { total, approved },
      });
    });
    app.MapPost("/api/boards/{bid:guid}/setup/activate", (InMemoryStore s, Guid bid, JsonElement body) =>
    {
      string? hash = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("hash", out var h)
        ? h.GetString() : null;
      var (board, error, status) = LeadSetup.Activate(s, bid, hash);
      return board is not null ? Results.Ok(board) : Results.Json(new { error }, statusCode: status);
    });

    // ---- Wizard drafts (resumable, autosaved) ----
    app.MapPost("/api/wizard", (InMemoryStore s, WizardDraft d) =>
    {
      d.Id = d.Id == Guid.Empty ? Guid.NewGuid() : d.Id;
      d.Status = "Saved";
      d.UpdatedAt = DateTime.UtcNow;
      s.WizardDrafts[d.Id] = d;
      return Results.Ok(d);
    });
    app.MapGet("/api/wizard/{id:guid}", (InMemoryStore s, Guid id) =>
    {
      if (!s.WizardDrafts.TryGetValue(id, out var d)) return Results.NotFound();
      WizardGuide.NormalizeInterview(d);
      return Results.Ok(d);
    });

    // ---- Voice: draft-first, explicit send; voice never approves/grants ----
    app.MapPost("/api/meetings/{id:guid}/voice", (InMemoryStore s, Guid id, JsonElement body) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      var t = new VoiceTurn
      {
        BoardId = m.BoardId, MeetingId = id, State = "draft",
        Transcript = body.TryGetProperty("partial", out var p) ? (p.GetString() ?? "") : "",
        AudioRetained = body.TryGetProperty("retainAudio", out var r) && r.GetBoolean(),
      };
      s.VoiceTurns[t.Id] = t;
      s.Usage.Add(new UsageRow { Kind = "voice-transcribe", Model = "muse-voice-transcribe", InputTokens = 0, Note = "metered; cost unknown (stub)", BoardId = m.BoardId, MeetingId = id });
      return Results.Created($"/api/voice/{t.Id}", t);
    });
    app.MapPost("/api/voice/{id:guid}/finalize", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.VoiceTurns.TryGetValue(id, out var t)) return Results.NotFound();
      if (!PeopleOps.Can(s, req, t.BoardId, t.MeetingId, "contribute")) return PeopleOps.Denied();
      if (t.State != "draft") return Results.Conflict("Already finalized.");
      t.Transcript = body.TryGetProperty("transcript", out var x) ? (x.GetString() ?? t.Transcript) : t.Transcript;
      t.State = "sent";
      if (s.Meetings.TryGetValue(t.MeetingId, out var fm)) fm.Generation++;
      if (s.Boards.TryGetValue(t.BoardId, out var vb) && !vb.RetainAudio) t.AudioRetained = false;
      lock (s.MessageLock)
      {
        var list = s.Messages.GetOrAdd(t.MeetingId, _ => new List<Message>());
        var msg = new Message
        {
          MeetingId = t.MeetingId, BoardId = t.BoardId,
          Sequence = (list.Count == 0 ? 0 : list.Max(m => m.Sequence)) + 1,
          Sender = "lead", Content = t.Transcript, Status = "committed",
        };
        list.Add(msg);
        if (s.Meetings.TryGetValue(t.MeetingId, out var mtg)) mtg.DeliveredRevision = msg.Sequence;
        return Results.Ok(msg);
      }
    });

    // ---- Sources: approval inbox; excluded/replaced never current ----
    app.MapGet("/api/boards/{bid:guid}/sources", (InMemoryStore s, Guid bid) =>
      Results.Ok(s.Sources.Values.Where(x => x.BoardId == bid).OrderByDescending(x => x.Version)));
    app.MapPost("/api/boards/{bid:guid}/sources", (InMemoryStore s, Guid bid, SourceDoc d) =>
    {
      d.Id = Guid.NewGuid();
      d.BoardId = bid;
      d.Version = 1;
      d.Approved = false;
      s.Sources[d.Id] = d;
      return Results.Created($"/api/sources/{d.Id}", d);
    });
    app.MapPost("/api/sources/{id:guid}/approve", (InMemoryStore s, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var d)) return Results.NotFound();
      d.Approved = true;
      d.Excluded = false;
      return Results.Ok(d);
    });
    app.MapPost("/api/sources/{id:guid}/exclude", (InMemoryStore s, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var d)) return Results.NotFound();
      d.Excluded = true;
      return Results.Ok(d);
    });

    // ---- Jobs with idempotency + safe retry ----
    app.MapGet("/api/activity/jobs", (InMemoryStore s) => Results.Ok(s.Jobs.Values.OrderByDescending(j => j.UpdatedAt).Take(100)));
    app.MapPost("/api/jobs", (InMemoryStore s, JobRow j) =>
    {
      var existing = s.Jobs.Values.FirstOrDefault(x => x.IdempotencyKey == j.IdempotencyKey && j.IdempotencyKey != "");
      if (existing is not null) return Results.Ok(existing); // no duplicates
      j.Id = Guid.NewGuid();
      j.UpdatedAt = DateTime.UtcNow;
      s.Jobs[j.Id] = j;
      return Results.Created($"/api/jobs/{j.Id}", j);
    });

    // ---- Usage + audit + model-call ledger ----
    app.MapGet("/api/usage", (InMemoryStore s, Guid? boardId, Guid? meetingId, string? day, string? from, string? to) =>
    {
      var q = s.Usage.AsEnumerable();
      if (boardId.HasValue) q = q.Where(u => u.BoardId == boardId);
      if (meetingId.HasValue) q = q.Where(u => u.MeetingId == meetingId);
      if (day is not null && DateOnly.TryParse(day, out var d))
        q = q.Where(u => DateOnly.FromDateTime(u.At) == d);
      if (from is not null && DateOnly.TryParse(from, out var f))
        q = q.Where(u => DateOnly.FromDateTime(u.At) >= f);
      if (to is not null && DateOnly.TryParse(to, out var t))
        q = q.Where(u => DateOnly.FromDateTime(u.At) <= t);
      return Results.Ok(q.OrderByDescending(u => u.At).Take(500));
    });
    app.MapGet("/api/activity/audit", (InMemoryStore s) => Results.Ok(s.Audit.OrderByDescending(a => a.CreatedAt).Take(200)));
    app.MapGet("/api/models/calls", (InMemoryStore s) => Results.Ok(s.ModelCalls.Take(200)));

    // ---- Meeting controls ----
    foreach (var (path, state) in new[] { ("pause", MeetingState.Paused), ("resume", MeetingState.Active), ("end", MeetingState.WrappingUp) })
      app.MapPost($"/api/meetings/{{id:guid}}/{path}", (InMemoryStore s, Guid id) =>
      {
        if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound();
        m.State = state;
        return Results.Ok(m);
      });

    // ---- Discussion run: bids -> challenge -> drafts -> ordered publish ----
    app.MapPost("/api/meetings/{id:guid}/run", async (InMemoryStore s, IHubContext<BoardHub> hub, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (!PeopleOps.Can(s, req, m.BoardId, id, "contribute")) return PeopleOps.Denied();
      if (PeopleOps.Guard(gw, req) is { } cappedRun) return cappedRun;
      var policy = body.TryGetProperty("policy", out var p) ? (p.GetString() ?? "balanced") : "balanced";
      var prompt = body.TryGetProperty("prompt", out var q) ? (q.GetString() ?? "") : "";
      var revisionBefore = m.DeliveredRevision;
      s.Boards.TryGetValue(m.BoardId, out var runBoard);
    var lead = LeadSetup.ResolveLead(s);
    var leadVersion = lead?.Version ?? 0;
      if (body.TryGetProperty("leadVersion", out var lv) && lv.ValueKind == JsonValueKind.Number
          && lv.GetInt32() != leadVersion)
        return Results.Conflict("Lead profile changed; refresh and retry with the current version.");
      if (m.State == MeetingState.Paused)
        return Results.Conflict("Meeting is paused; resume to run discussion.");
      var approved = s.Advisors.Values.Where(a => a.BoardId == m.BoardId && !a.Removed && a.Approved).ToList();
      var eligible = approved;
      var pickedCount = 0;
      try
      {
        using var pdoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(m.ParticipantIdsJson) ? "[]" : m.ParticipantIdsJson);
        if (pdoc.RootElement.ValueKind == JsonValueKind.Array)
        {
          var picked = new HashSet<Guid>();
          foreach (var pe in pdoc.RootElement.EnumerateArray())
            if (pe.ValueKind == JsonValueKind.String && Guid.TryParse(pe.GetString(), out var pg)) picked.Add(pg);
          if (picked.Count > 0) { pickedCount = picked.Count; eligible = s.Advisors.Values.Where(a => a.BoardId == m.BoardId && !a.Removed && picked.Contains(a.Id)).ToList(); }
        }
      }
      catch (JsonException) { }
      if (eligible.Count == 0)
        return Results.Json(new { error = "No advisors available for discussion.", fixes = pickedCount > 0 ? new[] { "Re-pick participants from this board's current advisors." } : new[] { "Approve at least one advisor on this board before running discussion." } }, statusCode: 409);
      var ownerOverride = PeopleOps.IsOwner(req);
      var spark = ModelPolicy.SparkFor(s, m.BoardId);
      Board? board = runBoard;
        var gen = m.Generation;
      using var bidSem = new SemaphoreSlim(4);
      (BoardAdvisor adv, double score, string text, string? error)[] bidResults;
      try
      {
        bidResults = await Task.WhenAll(eligible.Select(async adv =>
        {
          await bidSem.WaitAsync();
          try
          {
            var bidText = await gw.CompleteAsync(spark, "advisor-bid",
              ContextCurator.BidPacket(s, m, adv, prompt, board) + "\nReply with exactly YES or NO, then one line why.",
              ContextBudget.BidTokens, 512, ownerOverride: ownerOverride, boardId: m.BoardId, meetingId: id);
            var yes = bidText.TrimStart().StartsWith("YES", StringComparison.OrdinalIgnoreCase);
            return (adv, score: yes ? 10.0 + (adv.BoardRole.Length % 7) : 0.0, text: bidText, error: (string?)null);
          }
          catch (Exception ex) when (ex is CapExceededException or ProviderException)
          {
            return (adv, score: 0.0, text: "", error: (string?)ex.Message);
          }
          finally { bidSem.Release(); }
        }));
      }
      catch (Exception ex) when (ex is CapExceededException or ProviderException) { return PeopleOps.ModelError(ex); }
      if (m.Generation != gen || m.DeliveredRevision != revisionBefore)
        return Results.Conflict("Interrupted: new owner turn arrived; unsent drafts discarded.");
      var bidScores = bidResults.ToDictionary(b => b.adv.Id, b => b.score);
      var willing = eligible.Where(a => bidScores.TryGetValue(a.Id, out var sc) && sc > 0).ToList();
      if (willing.Count == 0) willing = eligible;
      var rounds = DiscussionPolicy.SelectRounds(policy, willing, a => bidScores.TryGetValue(a.Id, out var sc) ? sc : 0.0);
      var abstained = bidResults.Where(b => b.score <= 0).Select(b => b.adv.BoardRole).ToList();
      var bidErrors = bidResults.Where(b => b.error is not null).Select(b => new { advisor = b.adv.BoardRole, error = b.error }).ToList();
      var yielded = new List<object>();
      foreach (var b in bidResults.Where(b => b.score <= 0 && b.error is null)) yielded.Add(new { advisor = b.adv.BoardRole, reason = "bid-declined" });
      var evSupported = body.TryGetProperty("evidenceSupported", out var e) && e.GetBoolean();
      var published = new List<Message>();
      var manifests = new List<object>();
      using var draftSem = new SemaphoreSlim(4);
      string? lastChallenged = null;
      foreach (var round in rounds)
      {
        var drafts = await Task.WhenAll(round.Select(async adv =>
        {
          await draftSem.WaitAsync();
          try
          {
            var (packet, manifest) = ContextCurator.BuildPacket(s, m, adv, prompt, board, lead);
            var text = await gw.CompleteAsync(spark, "advisor-reply",
              packet + "\nYOUR TURN. Cite [source:name] or [record:version] where used; if you add nothing, reply with exactly ABSTAIN. If your reply takes a clear position on the lead question or another advisor point, end with [stance: Agrees|Disagrees|Raises risk|Proposes alternative]; otherwise omit the tag.",
              ContextBudget.DraftTokens, 4096, ownerOverride: ownerOverride, boardId: m.BoardId, meetingId: id);
            return (adv, text: (string?)text, manifest: (CuratorManifest?)manifest, error: (string?)null);
          }
          catch (Exception ex) when (ex is CapExceededException or ProviderException)
          {
            return (adv, text: (string?)null, manifest: (CuratorManifest?)null, error: (string?)ex.Message);
          }
          finally { draftSem.Release(); }
        }));
        if (m.Generation != gen || m.DeliveredRevision != revisionBefore)
          return Results.Conflict("Interrupted: new owner turn arrived; unsent drafts discarded.");
        if (drafts.Any(d => d.manifest is not null && d.manifest.SourceIds.Count > 0)) evSupported = true;
        var challenged = DiscussionPolicy.AssignChallenge(round, evSupported, a => (double)(a.BoardRole.Length % 5));
        lastChallenged = challenged?.BoardRole ?? lastChallenged;
        lock (s.MessageLock)
        {
          var list = s.Messages.GetOrAdd(id, _ => new List<Message>());
          foreach (var (adv, text, manifest, error) in drafts)
          {
            if (text is null || error is not null) { yielded.Add(new { advisor = adv.BoardRole, reason = "provider-error" }); continue; }
            if (string.IsNullOrWhiteSpace(text) || text.TrimStart().StartsWith("ABSTAIN", StringComparison.OrdinalIgnoreCase)) { abstained.Add(adv.BoardRole); yielded.Add(new { advisor = adv.BoardRole, reason = "abstained" }); continue; }
            if (list.Any(x => x.AdvisorName == adv.BoardRole && x.Sequence > revisionBefore))
              { yielded.Add(new { advisor = adv.BoardRole, reason = "already-replied-this-turn" }); continue; } // at most one reply per advisor per lead turn
            var leadSeq = list.Where(x => x.Sender == "lead").OrderByDescending(x => x.Sequence).Select(x => (long?)x.Sequence).FirstOrDefault();
            var (clean, stance) = MessageTags.SplitStance(text);
            var msg = new Message
            {
              MeetingId = id, BoardId = m.BoardId,
              Sequence = (list.Count == 0 ? 0 : list.Max(x => x.Sequence)) + 1,
              Sender = "advisor", AdvisorName = adv.BoardRole,
              Content = clean + (adv == challenged ? " [challenge: evidence-supported]" : ""),
              ParentSequence = leadSeq,
              Stance = stance,
              Status = "committed",
            };
            list.Add(msg);
            m.DeliveredRevision = msg.Sequence;
            published.Add(msg);
            if (manifest is not null)
              manifests.Add(new { advisor = adv.BoardRole, sources = manifest.SourceIds, seqs = manifest.MessageSeqs, tokens = manifest.TokenEstimate });
          }
        }
      }
      s.Audit.Add(new AuditEvent { BoardId = m.BoardId, Action = "discussion.run", Detail = JsonSerializer.Serialize(new { policy, rounds = rounds.Count, published = published.Count, leadVersion, generation = gen, bids = bidResults.Length, abstained, bidErrors = bidErrors.Count, manifests }) });
      await hub.Clients.Group($"meeting:{id}").SendAsync("run-complete",
        new { meetingId = id, published = published.Count, revision = m.DeliveredRevision });
      var selectedIds = new HashSet<Guid>(rounds.SelectMany(r => r).Select(a => a.Id));
      var omitted = willing.Where(a => !selectedIds.Contains(a.Id)).Select(a => a.BoardRole).ToList();
      object? overflow = omitted.Count == 0 ? null : new { omitted, cap = DiscussionPolicy.MaxReplies(policy), policy };
      return Results.Ok(new { rounds = rounds.Select(r => r.Select(a => a.BoardRole)), published, challenged = lastChallenged, abstained, bidErrors, yielded, overflow });

    });

    // ---- Secretary: provisional answers, never decisions by themselves ----
    app.MapPost("/api/meetings/{id:guid}/secretary", async (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (!PeopleOps.Can(s, req, m.BoardId, id, "contribute")) return PeopleOps.Denied();
      var setupFixes = new List<string>();
      if (LeadSetup.ResolveLead(s) is null) setupFixes.Add("Save the board-lead profile.");
      if (!s.Advisors.Values.Any(a => a.BoardId == m.BoardId && !a.Removed && a.Approved)) setupFixes.Add("Approve at least one advisor on this board.");
      if (setupFixes.Count > 0) return Results.Json(new { error = "Board setup is incomplete.", fixes = setupFixes }, statusCode: 409);
      if (PeopleOps.Guard(gw, req) is { } cappedSec) return cappedSec;
      var text = body.TryGetProperty("request", out var r) ? (r.GetString() ?? "") : "";
      string answer;
      try
      {
        answer = await gw.CompleteAsync(ModelPolicy.SparkFor(s, m.BoardId), "secretary", text, ContextBudget.BidTokens, 2048,
        ownerOverride: PeopleOps.IsOwner(req));
      }
      catch (ProviderException ex) { return PeopleOps.ProviderError(ex); }
      return Results.Ok(new { answer, provisional = true });
    });

    app.MapRoster();
    app.MapWizardGuide();
    app.MapMeetingExtras();
    app.MapRecords();
    app.MapSourcesX();
    app.MapPeople();
    app.MapAuth();
    app.MapOps();
    app.MapModelSettings();
  }
}
