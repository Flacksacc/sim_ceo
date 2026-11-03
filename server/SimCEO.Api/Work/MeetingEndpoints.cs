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
      if (PeopleOps.Check(s, req, m.BoardId, id, "discuss") is { } deniedTr) return deniedTr;
      if (PeopleOps.Guard(gw, req) is { } capped) return capped;
      if (audio is null || audio.Length == 0) return Results.BadRequest("No audio.");
      if (audio.Length > 10 * 1024 * 1024) return Results.BadRequest("Audio exceeds 10 MB.");
      using var ms = new MemoryStream();
      await audio.CopyToAsync(ms);
      string transcript;
      try
      {
        (transcript, _) = await gw.TranscribeAsync(ms.ToArray(), audio.ContentType ?? "audio/webm",
          string.IsNullOrWhiteSpace(audio.FileName) ? "mic.webm" : audio.FileName,
          ownerOverride: PeopleOps.IsOwner(req), boardId: m.BoardId, meetingId: id);
      }
      catch (Exception ex) when (ex is CapExceededException or ProviderException) { return PeopleOps.ModelError(ex); }
      if (string.IsNullOrWhiteSpace(transcript))
        return Results.Json(new { error = "No speech recognized; nothing posted." }, statusCode: 422);
      // Re-authorize AFTER the model await: the caller may have been revoked during transcription.
      if (PeopleOps.BadToken(s, req) is { } badTr2) return badTr2;
      string trUser = "";
      if (PeopleOps.IsSecure(s))
      {
        if (!AuthOps.TrySession(s, req, out var tru)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        trUser = tru;
      }
      else trUser = PeopleOps.UserOf(s, req);
      if (PeopleOps.Check(s, req, m.BoardId, id, "discuss") is { } deniedTr2) return deniedTr2;
      var turn = new VoiceTurn
      {
        BoardId = m.BoardId, MeetingId = id, CreatorKey = trUser, State = "draft",
        Transcript = transcript, AudioRetained = false,
      };
      s.VoiceTurns[turn.Id] = turn;
      return Results.Created($"/api/voice/{turn.Id}", new { turn = turn.Id, transcript });
    }).DisableAntiforgery();

    app.MapPatch("/api/meetings/{id:guid}", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (PeopleOps.Check(s, req, m.BoardId, id, "contribute") is { } deniedPatch) return deniedPatch;
      lock (s.MessageLock)
      {
        // Recheck CURRENT authority against a fresh fetch inside the lock (TOCTOU).
        if (!s.Meetings.TryGetValue(id, out var curP)) return Results.NotFound("meeting");
        if (PeopleOps.Check(s, req, curP.BoardId, id, "contribute") is { } deniedPatch2) return deniedPatch2;
        if (body.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String)
        {
          var title = t.GetString() ?? "";
          if (!string.IsNullOrWhiteSpace(title)) curP.Title = title.Trim();
        }
        if (body.TryGetProperty("participantIds", out var parts) && parts.ValueKind == JsonValueKind.Array)
      {
        var ids = new List<Guid>();
        foreach (var e in parts.EnumerateArray())
          if (e.ValueKind == JsonValueKind.String && Guid.TryParse(e.GetString(), out var g)
            && s.Advisors.TryGetValue(g, out var pa) && pa.BoardId == curP.BoardId && !pa.Removed) ids.Add(g);
        var nextParts = JsonSerializer.Serialize(ids);
        // Lane B: participant-set change invalidates any in-flight generation so it discards.
        if (!string.Equals(curP.ParticipantIdsJson, nextParts, StringComparison.Ordinal)) { curP.ParticipantIdsJson = nextParts; curP.Generation++; }
      }
      if (body.TryGetProperty("brief", out var b) && b.ValueKind == JsonValueKind.String)
        {
          curP.Brief = b.GetString() ?? "";
          if (!string.IsNullOrWhiteSpace(curP.Brief) && curP.State == MeetingState.AwaitingBrief)
            curP.State = MeetingState.Active;
        }
        s.Meetings.Flush();
        return Results.Ok(curP);
      }
    });

    app.MapPost("/api/meetings/{id:guid}/close", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (PeopleOps.Check(s, req, m.BoardId, id, "manage") is { } deniedClose) return deniedClose;
      var withRecord = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("withRecord", out var w) && w.GetBoolean();
      lock (s.MessageLock)
      {
        if (!s.Meetings.TryGetValue(id, out var cur)) return Results.NotFound("meeting");
        if (PeopleOps.Check(s, req, cur.BoardId, id, "manage") is { } deniedClose2) return deniedClose2;
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
      if (PeopleOps.Check(s, req, m.BoardId, id, "manage") is { } deniedReopen) return deniedReopen;
      lock (s.MessageLock)
      {
        if (!s.Meetings.TryGetValue(id, out var cur)) return Results.NotFound("meeting");
        if (PeopleOps.Check(s, req, cur.BoardId, id, "manage") is { } deniedReopen2) return deniedReopen2;
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
      if (PeopleOps.Check(s, req, m.BoardId, id, "read") is { } deniedSearch) return deniedSearch;
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
      if (PeopleOps.Check(s, req, m.BoardId, id, "read") is { } deniedDel) return deniedDel;
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
      if (PeopleOps.Check(s, req, m.BoardId, id, "read") is { } deniedNotes) return deniedNotes;
      var notes = s.Notes.Values.Where(n => n.MeetingId == id);
      if (!string.IsNullOrWhiteSpace(kind)) notes = notes.Where(n => n.Kind == kind);
      return Results.Ok(notes.OrderByDescending(n => n.CreatedAt).Take(100));
    });

    app.MapPost("/api/meetings/{id:guid}/notes", (InMemoryStore s, HttpRequest req, Guid id, Note input) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (PeopleOps.Check(s, req, m.BoardId, id, "contribute") is { } deniedNotePost) return deniedNotePost;
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
      if (PeopleOps.Check(s, req, m.BoardId, id, "contribute") is { } deniedBr) return deniedBr;
      if (PeopleOps.Guard(gw, req) is { } cappedBr) return cappedBr;
      var topic = body.TryGetProperty("topic", out var t) ? (t.GetString() ?? "") : "";
      if (string.IsNullOrWhiteSpace(topic)) return Results.BadRequest("topic is required.");
      if (m.State is not (MeetingState.Active or MeetingState.AwaitingBrief))
        return Results.Conflict("Meeting is not active; resume to request a briefing.");
      // Capture generation + eligible-input fingerprint BEFORE the provider
      // await: a policy change, exclusion, revocation, or index-generation
      // change during generation must discard the stale draft instead of
      // publishing it (P1 #3/#4). The fingerprint pins the exact eligible
      // set with per-source version, index generation, content hash, and
      // section-graph shape, so a same-bytes/version reindex that swaps
      // text still discards the in-flight draft.
      var genBefore = m.Generation;
      var epochBefore = s.SourceEpoch;
      List<string> EligibleFingerprint() => SourceGovernance.EligibleFingerprint(s, m.BoardId, id);
      var fpBefore = EligibleFingerprint();
      var evidenceBefore = SourceGovernance.ResolveEvidence(s, EvidenceRef.ParseList(body, "evidence"), m.BoardId, id);
      string text;
      try
      {
        text = await gw.CompleteAsync(ModelPolicy.SparkFor(s, m.BoardId), "briefing",
        $"Provisional briefing on '{topic}' from saved board context only.", ContextBudget.BidTokens, 2048,
        ownerOverride: PeopleOps.IsOwner(req));
      }
      catch (ProviderException ex) { return PeopleOps.ProviderError(ex); }
      // Re-authorize AFTER the model await: the caller may have been revoked during generation.
      if (PeopleOps.BadToken(s, req) is { } badBr2) return badBr2;
      if (PeopleOps.Check(s, req, m.BoardId, id, "contribute") is { } deniedBr2) return deniedBr2;
      if (!s.Meetings.TryGetValue(id, out m)) return Results.NotFound("meeting");
      // Publication boundary: recheck state, generation, and the eligible
      // input fingerprint under the governance locks before storing.
      lock (s.SetupLock)
      {
        lock (s.MessageLock)
        {
          if (!s.Meetings.TryGetValue(id, out var cur) || cur.State is not (MeetingState.Active or MeetingState.AwaitingBrief))
            return Results.Conflict("Meeting state changed during briefing; draft discarded.");
          if (PeopleOps.Check(s, req, cur.BoardId, id, "contribute") is { } deniedBrIn) return deniedBrIn;
          if (cur.Generation != genBefore || s.SourceEpoch != epochBefore)
            return Results.Conflict("Source evidence changed during briefing; draft discarded.");
          if (!EligibleFingerprint().SequenceEqual(fpBefore))
            return Results.Conflict("Source evidence changed during briefing; draft discarded.");
            var resolved = SourceGovernance.ResolveEvidence(s, evidenceBefore, m.BoardId, id);
          var note = new Note
          {
            BoardId = m.BoardId, MeetingId = id, Kind = "briefing",
            Title = topic, Body = text, Scope = "meeting", Provisional = true,
            EvidenceJson = EvidenceRef.ToJsonList(resolved),
          };
          s.Notes[note.Id] = note;
          return Results.Created($"/api/notes/{note.Id}", note);
        }
      }
    });

    app.MapGet("/api/meetings/{id:guid}/voice", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (PeopleOps.Check(s, req, m.BoardId, id, "read") is { } deniedVoiceList) return deniedVoiceList;
      var __vu = PeopleOps.UserOf(s, req);
      // Unsent drafts are visible only to their creator (no manager bypass); sent content stays readable.
      return Results.Ok(s.VoiceTurns.Values.Where(v => v.MeetingId == id && (v.State == "sent" || string.Equals(v.CreatorKey ?? "", __vu, StringComparison.OrdinalIgnoreCase)))
        .Select(v => new { v.Id, v.State, v.Transcript, v.AudioRetained }).OrderByDescending(v => v.Id));
    });

    app.MapGet("/api/boards/{bid:guid}/directions", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (PeopleOps.Check(s, req, bid, null, "read") is { } deniedDir) return deniedDir;
      return Results.Ok(s.Notes.Values
        .Where(n => n.BoardId == bid && n.Kind == "direction" && !n.Provisional)
        .OrderByDescending(n => n.CreatedAt).Take(200));
    });

    app.MapPost("/api/boards/{bid:guid}/directions", (InMemoryStore s, HttpRequest req, Guid bid, JsonElement body) =>
    {
      if (PeopleOps.Check(s, req, bid, null, "manage") is { } deniedDirPost) return deniedDirPost;
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
        EvidenceJson = EvidenceRef.ToJsonList(SourceGovernance.ResolveEvidence(s, EvidenceRef.ParseList(body, "evidence"), bid, meetingId == Guid.Empty ? null : meetingId)),
      };
      s.Notes[note.Id] = note;
      s.Audit.Add(new AuditEvent { BoardId = bid, Action = "direction.adopt", Detail = JsonSerializer.Serialize(new { scope, meetingId, text }) });
      return Results.Created($"/api/notes/{note.Id}", note);
    });
  }
}
