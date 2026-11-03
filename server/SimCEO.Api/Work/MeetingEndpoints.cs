using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

namespace SimCEO.Api;

// Meeting lifecycle (rename, brief-to-active, pause/resume/end, close with or
// without record, reopen with history intact), server-side message search,
// delivery inspection, provisional notes/briefings, and exact-text directions.
public static class MeetingEndpoints
{
  public static void MapMeetingExtras(this WebApplication app)
  {
    var gw = new ModelGateway(app.Services.GetRequiredService<InMemoryStore>());
    app.MapPost("/api/meetings/{id:guid}/transcribe", async (InMemoryStore s, HttpRequest req, Guid id, IFormFile audio) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (!PeopleOps.Can(s, req, m.BoardId, id, "contribute")) return PeopleOps.Denied();
      if (PeopleOps.Guard(gw, req) is { } capped) return capped;
      if (audio is null || audio.Length == 0) return Results.BadRequest("No audio.");
      if (audio.Length > 10 * 1024 * 1024) return Results.BadRequest("Audio exceeds 10 MB.");
      using var ms = new MemoryStream();
      await audio.CopyToAsync(ms, req.HttpContext.RequestAborted);
      var bytes = ms.ToArray();
      if (req.HttpContext.RequestAborted.IsCancellationRequested) return Results.StatusCode(499);
      if (!VoiceAudio.TryValidate(bytes, audio.ContentType, audio.FileName,
          out var verr, out _, out var normType, out var normName))
        return Results.BadRequest(verr);
      string transcript;
      try
      {
        (transcript, _) = await gw.TranscribeAsync(bytes, normType,
          normName,
          req.HttpContext.RequestAborted,
          ownerOverride: PeopleOps.IsOwner(req), boardId: m.BoardId, meetingId: id);
      }
      catch (OperationCanceledException) { return Results.StatusCode(499); }
      catch (VoiceAudioException vex) { return Results.BadRequest(vex.Message); }
      catch (Exception ex) when (ex is CapExceededException or ProviderException) { return PeopleOps.ModelError(ex); }
      if (req.HttpContext.RequestAborted.IsCancellationRequested) return Results.StatusCode(499);
      if (string.IsNullOrWhiteSpace(transcript))
        return Results.Json(new { error = "No speech recognized; nothing posted." }, statusCode: 422);
      var turn = new VoiceTurn
      {
        BoardId = m.BoardId, MeetingId = id, State = "draft",
        Transcript = transcript, AudioRetained = false,
      };
      s.VoiceTurns[turn.Id] = turn;
      return Results.Created($"/api/voice/{turn.Id}", new { turn = turn.Id, transcript });
    }).DisableAntiforgery();

    app.MapPatch("/api/meetings/{id:guid}", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (!PeopleOps.Can(s, req, m.BoardId, id, "contribute")) return PeopleOps.Denied();
      lock (s.MessageLock)
      {
        if (body.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String)
        {
          var title = t.GetString() ?? "";
          if (!string.IsNullOrWhiteSpace(title)) m.Title = title.Trim();
        }
        if (body.TryGetProperty("participantIds", out var parts) && parts.ValueKind == JsonValueKind.Array)
      {
        var ids = new List<Guid>();
        foreach (var e in parts.EnumerateArray())
          if (e.ValueKind == JsonValueKind.String && Guid.TryParse(e.GetString(), out var g)
            && s.Advisors.TryGetValue(g, out var pa) && pa.BoardId == m.BoardId && !pa.Removed) ids.Add(g);
        var nextParts = JsonSerializer.Serialize(ids);
        // Lane B: participant-set change invalidates any in-flight generation so it discards.
        if (!string.Equals(m.ParticipantIdsJson, nextParts, StringComparison.Ordinal)) { m.ParticipantIdsJson = nextParts; m.Generation++; }
      }
      if (body.TryGetProperty("brief", out var b) && b.ValueKind == JsonValueKind.String)
        {
          m.Brief = b.GetString() ?? "";
          if (!string.IsNullOrWhiteSpace(m.Brief) && m.State == MeetingState.AwaitingBrief)
            m.State = MeetingState.Active;
        }
      }
      s.Meetings.Flush();
      return Results.Ok(m);
    });

    app.MapPost("/api/meetings/{id:guid}/close", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (!PeopleOps.Can(s, req, m.BoardId, id, "manage")) return PeopleOps.Denied();
      var withRecord = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("withRecord", out var w) && w.GetBoolean();
      lock (s.MessageLock)
      {
        if (!s.Meetings.TryGetValue(id, out var cur)) return Results.NotFound("meeting");
        cur.State = withRecord ? MeetingState.ClosedWithRecord : MeetingState.ClosedWithoutPublication;
        cur.Generation++;
        s.Meetings.Flush();
        s.Audit.Add(new AuditEvent { BoardId = cur.BoardId, Action = "meeting.close", Detail = JsonSerializer.Serialize(new { meeting = id, withRecord }) });
        return Results.Ok(cur);
      }
    });

    app.MapPost("/api/meetings/{id:guid}/reopen", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (!PeopleOps.Can(s, req, m.BoardId, id, "manage")) return PeopleOps.Denied();
      lock (s.MessageLock)
      {
        if (!s.Meetings.TryGetValue(id, out var cur)) return Results.NotFound("meeting");
        cur.State = MeetingState.Active;
        cur.Generation++;
        s.Meetings.Flush();
        s.Audit.Add(new AuditEvent { BoardId = cur.BoardId, Action = "meeting.reopen", Detail = JsonSerializer.Serialize(new { meeting = id }) });
        return Results.Ok(cur);
      }
    });

    app.MapGet("/api/meetings/{id:guid}/messages/search", (InMemoryStore s, HttpRequest req, Guid id, string q, int context = 3) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (!PeopleOps.Can(s, req, m.BoardId, id, "read")) return PeopleOps.Denied();
      if (string.IsNullOrWhiteSpace(q)) return Results.BadRequest("q is required.");
      context = Math.Clamp(context, 0, 10);
      lock (s.MessageLock)
      {
        if (!s.Messages.TryGetValue(id, out var list)) return Results.Ok(Array.Empty<object>());
        var hits = list.Where(x => x.Content.Contains(q, StringComparison.OrdinalIgnoreCase))
          .OrderBy(x => x.Sequence).Take(50)
          .Select(x => new
          {
            x.Sequence, x.Sender, x.AdvisorName,
            excerpt = x.Content.Length > 240 ? x.Content[..240] + "…" : x.Content,
            before = list.Where(y => y.Sequence < x.Sequence).OrderByDescending(y => y.Sequence).Take(context).OrderBy(y => y.Sequence).Select(y => y.Sequence),
            after = list.Where(y => y.Sequence > x.Sequence).OrderBy(y => y.Sequence).Take(context).Select(y => y.Sequence),
          }).ToList();
        return Results.Ok(hits);
      }
    });

    app.MapGet("/api/meetings/{id:guid}/delivery", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (!PeopleOps.Can(s, req, m.BoardId, id, "read")) return PeopleOps.Denied();
      lock (s.MessageLock)
      {
        var list = s.Messages.TryGetValue(id, out var l) ? l : new List<Message>();
        return Results.Ok(new
        {
          state = m.State.ToString(), deliveredRevision = m.DeliveredRevision,
          messages = list.Count, lastSequence = list.Count == 0 ? 0 : list.Max(x => x.Sequence),
        });
      }
    });

    app.MapGet("/api/meetings/{id:guid}/notes", (InMemoryStore s, HttpRequest req, Guid id, string? kind) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (!PeopleOps.Can(s, req, m.BoardId, id, "read")) return PeopleOps.Denied();
      var notes = s.Notes.Values.Where(n => n.MeetingId == id);
      if (!string.IsNullOrWhiteSpace(kind)) notes = notes.Where(n => n.Kind == kind);
      return Results.Ok(notes.OrderByDescending(n => n.CreatedAt).Take(100));
    });

    app.MapPost("/api/meetings/{id:guid}/notes", (InMemoryStore s, HttpRequest req, Guid id, Note input) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (!PeopleOps.Can(s, req, m.BoardId, id, "contribute")) return PeopleOps.Denied();
      input.Id = Guid.NewGuid();
      input.BoardId = m.BoardId;
      input.MeetingId = id;
      if (input.Kind is not ("note" or "briefing")) input.Kind = "note";
      input.Scope = "meeting";
      input.Provisional = true;
      input.CreatedAt = DateTime.UtcNow;
      s.Notes[input.Id] = input;
      return Results.Created($"/api/notes/{input.Id}", input);
    });

    app.MapPost("/api/meetings/{id:guid}/briefings", async (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (!PeopleOps.Can(s, req, m.BoardId, id, "contribute")) return PeopleOps.Denied();
      if (PeopleOps.Guard(gw, req) is { } cappedBr) return cappedBr;
      var topic = body.TryGetProperty("topic", out var t) ? (t.GetString() ?? "") : "";
      if (string.IsNullOrWhiteSpace(topic)) return Results.BadRequest("topic is required.");
      string text;
      try
      {
        text = await gw.CompleteAsync(ModelPolicy.SparkFor(s, m.BoardId), "briefing",
        $"Provisional briefing on '{topic}' from saved board context only.", ContextBudget.BidTokens, 2048,
        ownerOverride: PeopleOps.IsOwner(req));
      }
      catch (ProviderException ex) { return PeopleOps.ProviderError(ex); }
      var note = new Note
      {
        BoardId = m.BoardId, MeetingId = id, Kind = "briefing",
        Title = topic, Body = text, Scope = "meeting", Provisional = true,
        EvidenceJson = EvidenceRef.ToJsonList(EvidenceRef.ParseList(body, "evidence")),
      };
      s.Notes[note.Id] = note;
      return Results.Created($"/api/notes/{note.Id}", note);
    });

    app.MapGet("/api/meetings/{id:guid}/voice", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (!PeopleOps.Can(s, req, m.BoardId, id, "read")) return PeopleOps.Denied();
      return Results.Ok(s.VoiceTurns.Values.Where(v => v.MeetingId == id)
        .Select(v => new { v.Id, v.State, v.Transcript, v.AudioRetained }).OrderByDescending(v => v.Id));
    });

    app.MapGet("/api/boards/{bid:guid}/directions", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (!PeopleOps.Can(s, req, bid, null, "read")) return PeopleOps.Denied();
      return Results.Ok(s.Notes.Values
        .Where(n => n.BoardId == bid && n.Kind == "direction" && !n.Provisional)
        .OrderByDescending(n => n.CreatedAt).Take(200));
    });

    app.MapPost("/api/boards/{bid:guid}/directions", (InMemoryStore s, HttpRequest req, Guid bid, JsonElement body) =>
    {
      if (!PeopleOps.Can(s, req, bid, null, "manage")) return PeopleOps.Denied();
      var text = body.TryGetProperty("text", out var t) ? (t.GetString() ?? "") : "";
      var scope = body.TryGetProperty("scope", out var sc) ? (sc.GetString() ?? "meeting") : "meeting";
      if (string.IsNullOrWhiteSpace(text)) return Results.BadRequest("Exact direction text is required and shown back before commit.");
      if (scope is not ("meeting" or "board")) return Results.BadRequest("scope must be meeting or board.");
      Guid meetingId = Guid.Empty;
      if (scope == "meeting")
      {
        var mid = body.TryGetProperty("meetingId", out var mi) && mi.ValueKind == JsonValueKind.String
          && Guid.TryParse(mi.GetString(), out var g) ? g : Guid.Empty;
        if (mid == Guid.Empty) return Results.BadRequest("meetingId is required for meeting scope.");
        if (!s.Meetings.TryGetValue(mid, out var mtg) || mtg.BoardId != bid) return Results.NotFound("meeting");
        meetingId = mid;
      }
      var note = new Note
      {
        BoardId = bid, MeetingId = meetingId, Kind = "direction", Scope = scope,
        Title = scope == "board" ? "Adopted board-wide" : "Adopted for meeting",
        Body = text, Provisional = false,
        EvidenceJson = EvidenceRef.ToJsonList(EvidenceRef.ParseList(body, "evidence")),
      };
      s.Notes[note.Id] = note;
      s.Audit.Add(new AuditEvent { BoardId = bid, Action = "direction.adopt", Detail = JsonSerializer.Serialize(new { scope, meetingId, text }) });
      return Results.Created($"/api/notes/{note.Id}", note);
    });
  }
}
