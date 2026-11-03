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
      var restoreBeforeTr = s.RestoreEpochId;
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
      try
      {
        Atomic.Run(s, () =>
        {
          if (!s.Meetings.TryGetValue(id, out var curM) || curM is null) throw new InvalidOperationException("gone");
          if (!AuthOps.TrySession(s, req, out var tu) && PeopleOps.IsSecure(s)) throw new UnauthorizedAccessException("revoked");
          var tu2 = PeopleOps.IsSecure(s) ? tu! : PeopleOps.UserOf(s, req);
          if (PeopleOps.Check(s, req, curM.BoardId, id, "discuss") is not null) throw new UnauthorizedAccessException("revoked");
          if (s.RestoreEpochId != restoreBeforeTr) throw new InvalidOperationException("restored");
          if (!string.Equals(tu2, trUser, StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("session changed during transcription");
          turn.BoardId = curM.BoardId;
          turn.CreatorKey = tu2;
          s.VoiceTurns[turn.Id] = turn;
        });
      }
      catch (UnauthorizedAccessException) { return Results.Json(new { error = "Authentication required." }, statusCode: 401); }
      catch (InvalidOperationException iox) when (iox.Message == "restored") { return Results.Conflict("Domain was restored during transcription; retry."); }
      catch (InvalidOperationException) { return Results.NotFound("meeting"); }
      catch (Exception ex) { return Results.Json(new { error = "Transcription store failed; no state changed: " + ex.Message }, statusCode: 500); }
      return Results.Created($"/api/voice/{turn.Id}", new { turn = turn.Id, transcript });
    }).DisableAntiforgery();

    app.MapPatch("/api/meetings/{id:guid}", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (PeopleOps.Check(s, req, m.BoardId, id, "contribute") is { } deniedPatch) return deniedPatch;
      try
      {
        Atomic.Run(s, () =>
        {
        // Recheck CURRENT authority against a fresh fetch inside the unit (TOCTOU).
        if (!s.Meetings.TryGetValue(id, out var curP)) throw new InvalidOperationException("Meeting is gone.");
        if (PeopleOps.Check(s, req, curP.BoardId, id, "contribute") is not null) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
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
        s.Meetings[curP.Id] = curP;
        });
      }
      catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
      catch (InvalidOperationException) { return Results.NotFound("meeting"); }
      catch (Exception ex) { return Results.Json(new { error = "Meeting update failed; no state changed: " + ex.Message }, statusCode: 500); }
      if (!s.Meetings.TryGetValue(id, out var savedP) || savedP is null) return Results.NotFound("meeting");
      return Results.Ok(savedP);
    });

    app.MapPost("/api/meetings/{id:guid}/close", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (PeopleOps.Check(s, req, m.BoardId, id, "manage") is { } deniedClose) return deniedClose;
      var withRecord = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("withRecord", out var w) && w.GetBoolean();
      try
      {
        Atomic.Run(s, () =>
        {
          if (!s.Meetings.TryGetValue(id, out var cur)) throw new InvalidOperationException("Meeting is gone.");
          if (PeopleOps.Check(s, req, cur.BoardId, id, "manage") is not null) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
          cur.State = withRecord ? MeetingState.ClosedWithRecord : MeetingState.ClosedWithoutPublication;
          cur.Generation++;
          s.Meetings[cur.Id] = cur;
          Atomic.Audit(s, new AuditEvent { BoardId = cur.BoardId, Action = "meeting.close", Detail = JsonSerializer.Serialize(new { meeting = id, withRecord }) });
        });
      }
      catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
      catch (InvalidOperationException) { return Results.NotFound("meeting"); }
      catch (Exception ex) { return Results.Json(new { error = "Meeting close failed; no state changed: " + ex.Message }, statusCode: 500); }
      if (!s.Meetings.TryGetValue(id, out var closed) || closed is null) return Results.NotFound("meeting");
      return Results.Ok(closed);
    });

    app.MapPost("/api/meetings/{id:guid}/reopen", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (PeopleOps.Check(s, req, m.BoardId, id, "manage") is { } deniedReopen) return deniedReopen;
      try
      {
        Atomic.Run(s, () =>
        {
          if (!s.Meetings.TryGetValue(id, out var cur)) throw new InvalidOperationException("Meeting is gone.");
          if (PeopleOps.Check(s, req, cur.BoardId, id, "manage") is not null) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
          cur.State = MeetingState.Active;
          cur.Generation++;
          s.Meetings[cur.Id] = cur;
          Atomic.Audit(s, new AuditEvent { BoardId = cur.BoardId, Action = "meeting.reopen", Detail = JsonSerializer.Serialize(new { meeting = id }) });
        });
      }
      catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
      catch (InvalidOperationException) { return Results.NotFound("meeting"); }
      catch (Exception ex) { return Results.Json(new { error = "Meeting reopen failed; no state changed: " + ex.Message }, statusCode: 500); }
      if (!s.Meetings.TryGetValue(id, out var reopened) || reopened is null) return Results.NotFound("meeting");
      return Results.Ok(reopened);
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
      if (!PeopleOps.Can(s, req, m.BoardId, id, "read")) return PeopleOps.Denied();
      var notes = s.Notes.Values.Where(n => n.MeetingId == id && n.BoardId == m.BoardId);
      if (!string.IsNullOrWhiteSpace(kind))
      {
        var k = kind.Trim();
        notes = notes.Where(n => n.Kind == k);
      }
      else
      {
        notes = notes.Where(n => !SecretaryContext.IsOperationalNote(n) && n.NoteStatus == "current");
      }
      return Results.Ok(notes.OrderByDescending(n => n.CreatedAt).Take(100).ToList());
    });

    app.MapPost("/api/meetings/{id:guid}/notes", (InMemoryStore s, HttpRequest req, Guid id, Note input) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (PeopleOps.Check(s, req, m.BoardId, id, "contribute") is { } deniedNotePost) return deniedNotePost;
      var title = (input.Title ?? "").Trim();
      var bodyIn = (input.Body ?? "").Trim();
      if (string.IsNullOrWhiteSpace(bodyIn)) return Results.BadRequest("body is required.");
      if (bodyIn.Length > 12000) return Results.BadRequest("body too long.");
      var kind = (input.Kind ?? "note").Trim().ToLowerInvariant();
      if (kind is not ("note" or "briefing")) kind = "note";
      Note? created = null;
      IResult? gateErr = null;
      lock (s.SetupLock) { lock (s.MessageLock) {
        try { gateErr = Atomic.Run<IResult?>(s, () =>
        {
          if (!s.Meetings.TryGetValue(id, out var cur) || cur.BoardId != m.BoardId) throw new InvalidOperationException("meeting moved");
          if (!PeopleOps.Can(s, req, cur.BoardId, id, "contribute")) return PeopleOps.Denied();
          var note = new Note { BoardId = cur.BoardId, MeetingId = id, Kind = kind, Title = string.IsNullOrWhiteSpace(title) ? (kind == "briefing" ? "Briefing" : "Working note") : title, Body = bodyIn, Scope = "meeting", Provisional = true, EvidenceJson = "[]", RootId = Guid.Empty, Revision = 1, PredecessorId = null, NoteStatus = "current", CreatedAt = DateTime.UtcNow };
          note.RootId = note.Id;
          s.Notes[note.Id] = note;
          var h = new NoteHistory { BoardId = cur.BoardId, MeetingId = id, NoteId = note.Id, RootId = note.RootId, Revision = 1, Title = note.Title, Body = note.Body, EvidenceJson = note.EvidenceJson, Action = "created", CreatedAt = DateTime.UtcNow };
          s.NoteHistories[h.Id] = h;
          s.Notes.Flush(); s.NoteHistories.Flush();
          created = note;
          return null;
        }); } catch (Exception ncEx)
        {
          if (ncEx is InvalidOperationException && (ncEx.Message ?? "").Contains("meeting moved", StringComparison.OrdinalIgnoreCase))
            gateErr = Results.Json(new { error = "Meeting moved during note creation; retry." }, statusCode: 409);
          else if (SimCEO.Api.Work.SecretaryEndpoints.IsStorageFault(ncEx))
            gateErr = Results.Json(new { error = "Storage fault during note creation; safe to retry." }, statusCode: 502);
          else throw;
        }
      } }
      if (gateErr is not null) return gateErr;
      return Results.Created($"/api/notes/{created!.Id}", created);
    });

    app.MapPost("/api/meetings/{id:guid}/briefings", async (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (PeopleOps.Check(s, req, m.BoardId, id, "contribute") is { } deniedBr) return deniedBr;
      if (PeopleOps.Guard(gw, req) is { } cappedBr) return cappedBr;
      var topic = body.TryGetProperty("topic", out var t) ? (t.GetString() ?? "") : "";
      if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("input", out var iv2) && iv2.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(iv2.GetString())) topic = iv2.GetString() ?? topic;
      if (string.IsNullOrWhiteSpace(topic)) return Results.BadRequest("topic is required.");
      var callerRaw = EvidenceRef.ParseList(body, "evidence");
      SecretarySnapshot snapBefore = null!;
      var restoreBeforeB = s.RestoreEpochId;
      List<EvidenceRef> deliveredB = new();
      List<string> omittedB = new();
      string promptBText = "";
      List<EvidenceRef> callerCanonPre = new();
      IResult? prepErr = null;
      try
      {
        lock (s.SetupLock) { lock (s.MessageLock) {
          prepErr = Atomic.Run<IResult?>(s, () =>
          {
          if (!s.Meetings.TryGetValue(id, out var curB)) return Results.NotFound("meeting");
          // Fresh authority INSIDE the preparation unit (not just outer check): re-authorize against live meeting/board.
          if (PeopleOps.Check(s, req, curB.BoardId, id, "contribute") is { } deniedBrPre) return deniedBrPre;
          if (curB.State is not (MeetingState.Active or MeetingState.AwaitingBrief))
            return Results.Conflict("Meeting is not active; resume to request a briefing.");
          snapBefore = SecretaryContext.CaptureSnapshot(s, curB, callerRaw);
          callerCanonPre = SecretaryContext.CanonicalizeCaller(s, curB.BoardId, id, callerRaw);
          const string bhead = "You are the board secretary. Return a provisional briefing as JSON with kind briefing, title and body. Ground only in the packet; state limitations when evidence is missing.\n";
          string btail = "\nBRIEFING TOPIC: " + topic.Trim() + "\n";
          int bbudget = 32000 - bhead.Length - btail.Length - 1000;
          if (bbudget < 4000) throw new ProviderException(502, "Secretary prompt exceeds budget; essential context cannot fit.");
          var tmpB = new List<EvidenceRef>(); var omB = new List<string>();
          string packetB = SecretaryContext.BuildPacket(s, curB, topic.Trim(), callerCanonPre, tmpB, bbudget, omB);
          string bfooter = omB.Count > 0 ? "\nOMITTED FROM PACKET (not cited as evidence): " + string.Join("; ", omB) + "\n" : "";
          string fullB = bhead + packetB + bfooter + btail;
          if (fullB.Length > 32000) throw new ProviderException(502, "Secretary prompt exceeds budget; essential context cannot fit.");
          foreach (var d in tmpB.ToList())
          {
            if (string.IsNullOrWhiteSpace(d.Excerpt) || !fullB.Contains(d.Excerpt!, StringComparison.Ordinal))
            {
              bool isCallerB = callerCanonPre.Any(c => c.Kind == d.Kind && c.Ref == d.Ref && (c.SectionId ?? "") == (d.SectionId ?? ""));
              if (isCallerB) throw new ProviderException(502, "Secretary caller evidence exceeds prompt budget.");
              tmpB.Remove(d);
            }
          }
          deliveredB = tmpB; omittedB = omB; promptBText = fullB;
          return null;
          });
        } }
        if (prepErr is not null) return prepErr;
      }
      catch (ProviderException pexB) { return PeopleOps.ProviderError(pexB); }
      string text;
      try
      {
        text = await gw.CompleteAsync(ModelPolicy.SparkFor(s, m.BoardId), "secretary",
        promptBText, SecretaryDirect.InputTokens, 2048,
        ownerOverride: PeopleOps.IsOwner(req), boardId: m.BoardId, meetingId: id, truncatePrompt: false);
      }
      catch (ProviderException ex) { return PeopleOps.ProviderError(ex); }
      SecretaryOutcome bout;
      try { bout = SecretaryOutcomeParser.Parse(text); }
      catch (ProviderException pex) { return PeopleOps.ProviderError(pex); }
      if (bout.Kind != "secretary-briefing") return Results.Json(new { error = "Briefing model returned non-briefing outcome." }, statusCode: 502);
      // Re-authorize AFTER the model await: the caller may have been revoked or expired during generation.
      if (PeopleOps.BadToken(s, req) is { } badBr2) return badBr2;
      if (PeopleOps.Check(s, req, m.BoardId, id, "contribute") is { } deniedBr2) return deniedBr2;
      lock (s.SetupLock)
      {
        lock (s.MessageLock)
        {
          return Atomic.Run<IResult>(s, () =>
          {
            if (!s.Meetings.TryGetValue(id, out var cur) || cur.State is not (MeetingState.Active or MeetingState.AwaitingBrief))
              return Results.Conflict("Meeting state changed during briefing; draft discarded.");
            // Identical immutable caller selection for both captures: cited-message bits must match when nothing changed.
            var nowSnap = SecretaryContext.CaptureSnapshot(s, cur, callerRaw);
            if (!SecretaryContext.SnapshotEquals(snapBefore, nowSnap))
              return Results.Json(new { error = SecretaryContext.SnapshotMismatchReason(snapBefore, nowSnap) }, statusCode: 409);
            if (s.RestoreEpochId != restoreBeforeB)
              return Results.Json(new { error = "Domain was restored during briefing; retry." }, statusCode: 409);
            if (PeopleOps.Check(s, req, cur.BoardId, id, "contribute") is { } deniedBrIn) return deniedBrIn;
            var bodyText = bout.Body;
            if (deliveredB.Count == 0) bodyText = bodyText + " [Limitation: No eligible approved sources, adopted directions, or approved records were available for this meeting.]";
            if (omittedB.Count > 0) bodyText = bodyText + " [Omitted from packet (not cited as evidence): " + string.Join("; ", omittedB) + "]";
            var note = new Note
            {
              BoardId = cur.BoardId, MeetingId = id, Kind = "secretary-briefing",
              Title = string.IsNullOrWhiteSpace(bout.Title) ? topic.Trim() : bout.Title, Body = bodyText, Scope = "meeting", Provisional = true,
              EvidenceJson = EvidenceRef.ToJsonList(deliveredB), RootId = Guid.Empty, Revision = 1, NoteStatus = "current", CreatedAt = DateTime.UtcNow,
            };
            note.RootId = note.Id;
            s.Notes[note.Id] = note;
            var hb = new NoteHistory { BoardId = cur.BoardId, MeetingId = id, NoteId = note.Id, RootId = note.RootId, Revision = 1, Title = note.Title, Body = note.Body, EvidenceJson = note.EvidenceJson, Action = "created", CreatedAt = DateTime.UtcNow };
            s.NoteHistories[hb.Id] = hb;
            s.Notes.Flush(); s.NoteHistories.Flush();
            return Results.Created($"/api/notes/{note.Id}", note);
          });
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
        EvidenceJson = EvidenceRef.ToJsonList(SourceGovernance.ResolveEvidence(s, req, EvidenceRef.ParseList(body, "evidence"), bid, meetingId == Guid.Empty ? null : meetingId)),
        RootId = Guid.Empty, Revision = 1, PredecessorId = null, NoteStatus = "current",
      };
      note.RootId = note.Id;
      var newNote = note;
      try
      {
        Atomic.Run(s, () =>
        {
          if (!s.Boards.ContainsKey(bid)) throw new InvalidOperationException("Board is gone.");
          if (PeopleOps.Check(s, req, bid, newNote.MeetingId == Guid.Empty ? null : newNote.MeetingId, "manage") is not null) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
          if (newNote.Scope == "meeting" && (!s.Meetings.TryGetValue(newNote.MeetingId, out var mm) || mm.BoardId != bid)) throw new InvalidOperationException("Meeting is gone.");
          s.Notes[newNote.Id] = newNote;
          Atomic.Audit(s, new AuditEvent { BoardId = bid, Action = "direction.adopt", Detail = JsonSerializer.Serialize(new { scope, meetingId, text }) });
        });
      }
      catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
      catch (InvalidOperationException) { return Results.NotFound(); }
      catch (Exception ex) { return Results.Json(new { error = "Direction adoption failed; no state changed: " + ex.Message }, statusCode: 500); }
      return Results.Created($"/api/notes/{newNote.Id}", newNote);
    });
  }
}
