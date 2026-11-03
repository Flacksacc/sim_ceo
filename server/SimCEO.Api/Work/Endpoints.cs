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
      if (PeopleOps.BadToken(s, req) is { } badLG) return badLG;
      if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _))
        return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      var user = PeopleOps.UserOf(s, req);
      if (!PeopleOps.Can(s, req, bid, null, "read") && PeopleOps.GuestMeetingIds(s, user, bid).Count == 0) return PeopleOps.Denied();
      var owned = LeadSetup.ResolveLeadForStrict(s, bid);
      var fb = owned is null ? LeadSetup.ResolveLead(s) : null;
      var cur = owned ?? LeadSetup.ResolveLeadFor(s, bid);
      if (cur is null) return Results.NotFound();
      var fallback = LeadSetup.IsFallback(cur, bid);
      var caller = PeopleOps.UserOf(s, req);
      bool isInstAdmin = false;
      try { isInstAdmin = PeopleOps.IsInstallationAdmin(s, caller); }
      catch (InvalidOperationException) { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
      if (!PeopleOps.Can(s, req, bid, null, "read"))
      {
        // Meeting guests: minimal board-owned identity only; never global fallback content.
        if (fallback) return Results.NotFound();
        return Results.Ok(new { cur.Id, cur.BoardId, cur.Version, cur.Name, cur.RoleLabel });
      }
      // Board readers+: full board-owned profile; global fallback is installation data.
      if (fallback && !isInstAdmin)
        return Results.Json(new { error = "No board lead profile saved; save the board lead profile to continue." }, statusCode: 404);
      return Results.Ok(cur);
    });
    app.MapPost("/api/boards/{bid:guid}/lead", (InMemoryStore s, HttpRequest req, Guid bid, LeadProfile input) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badLead) return badLead;
      if (PeopleOps.Check(s, req, bid, null, "contribute") is { } deniedLead) return deniedLead;
      var (saved, error, status) = LeadSetup.SaveLead(s, bid, input);
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
      var (gsaved, gerror, gstatus) = LeadSetup.SaveLead(s, Guid.Empty, input);
      return gsaved is not null ? Results.Ok(gsaved) : Results.Json(new { error = gerror }, statusCode: gstatus);
    });

    // ---- Board fields edit (stays a draft until setup activation) ----
    app.MapPatch("/api/boards/{id:guid}", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badBoard) return badBoard;
      if (!s.Boards.TryGetValue(id, out var b)) return Results.NotFound();
      if (PeopleOps.Check(s, req, id, null, "manage") is { } deniedBoard) return deniedBoard;
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
        s.Boards.Flush();
        return Results.Ok(b);
      }
    });

    // ---- Setup review + activation (exact reviewed draft only) ----
    app.MapGet("/api/boards/{bid:guid}/setup", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (PeopleOps.Check(s, req, bid, null, "read") is { } deniedSetup) return deniedSetup;
      if (!s.Boards.TryGetValue(bid, out var b)) return Results.NotFound();
      // Board-owned lead only; global fallback content is installation data (admin-only).
      var leadOwned = LeadSetup.ResolveLeadForStrict(s, bid);
      object? lead = leadOwned;
      if (lead is null)
      {
        try { if (PeopleOps.IsInstallationAdmin(s, PeopleOps.UserOf(s, req))) lead = LeadSetup.ResolveLead(s); } catch { lead = null; }
      }
      var total = s.Advisors.Values.Count(a => a.BoardId == bid && !a.Removed);
      var approved = s.Advisors.Values.Count(a => a.BoardId == bid && !a.Removed && a.Approved);
      var canonical = LeadSetup.CanonicalDraftJson(s, b);
      return Results.Ok(new
      {
        board = new { b.Id, b.Name, b.Mission, b.Stage, b.ActiveConfig, b.LeadProfileVersion, b.RetainAudio, b.DiscussionPolicy, b.DataUse },
        draftJson = b.DraftJson, activeJson = b.ActiveJson,
        canonicalJson = canonical,
        draftHash = Hashing.HashOf(canonical),
        dirty = !string.Equals(canonical, b.ActiveJson, StringComparison.Ordinal),
        lead, advisors = new { total, approved },
      });
    });
    app.MapPost("/api/boards/{bid:guid}/setup/activate", (InMemoryStore s, HttpRequest req, Guid bid, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badAct) return badAct;
      if (PeopleOps.Check(s, req, bid, null, "manage") is { } deniedAct) return deniedAct;
      string? hash = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("hash", out var h)
        ? h.GetString() : null;
      var (board, error, status) = LeadSetup.Activate(s, bid, hash);
      return board is not null ? Results.Ok(board) : Results.Json(new { error }, statusCode: status);
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
        var has = s.WizardDrafts.TryGetValue(id, out var d);
        if (has)
        {
          if (!WizardGuide.TryWizardUser(s, req, d, out _, out var deniedSv)) return deniedSv;
        }
        d ??= new WizardDraft { Id = id, Version = 1 };
        if (!has)
        {
          if (!WizardGuide.TryWizardUser(s, req, null, out var newOwner, out var deniedNew)) return deniedNew;
          d.OwnerKey = newOwner;
        }
        // Lane B: existing saves require an explicitly present integer expected version.
        if (has)
        {
          if (!body.TryGetProperty("version", out var vw) || vw.ValueKind != JsonValueKind.Number
              || !vw.TryGetInt32(out var want) || want != d.Version)
            return Results.Conflict("Stale wizard draft; refresh and re-apply your edit with the current version.");
        }
        if (!has)
        {
          if (body.TryGetProperty("accountId", out var ac)) d.AccountId = ac.ValueKind == JsonValueKind.String
            && Guid.TryParse(ac.GetString(), out var ag) ? ag : Guid.Empty;
          d.Status = "Saved";
        }
        if (body.TryGetProperty("step", out var st) && st.ValueKind == JsonValueKind.Number) d.Step = st.GetInt32();
        if (body.TryGetProperty("presetKey", out var pk) && pk.ValueKind == JsonValueKind.String) d.PresetKey = pk.GetString() ?? "";
        if (body.TryGetProperty("fieldsJson", out var fj) && fj.ValueKind == JsonValueKind.String) d.FieldsJson = fj.GetString() ?? "{}";
        if (body.TryGetProperty("interviewJson", out var ij) && ij.ValueKind == JsonValueKind.String
            && !string.IsNullOrWhiteSpace(ij.GetString())) d.InterviewJson = ij.GetString()!;
        if (body.TryGetProperty("provenanceJson", out var pj2) && pj2.ValueKind == JsonValueKind.String
            && !string.IsNullOrWhiteSpace(pj2.GetString())) d.ProvenanceJson = pj2.GetString()!;
        WizardGuide.NormalizeInterview(d);
        d.Version++;
        d.UpdatedAt = DateTime.UtcNow;
        s.WizardDrafts[d.Id] = d;
        s.WizardDrafts.Flush();
        return Results.Ok(d);
      }
      finally { sem.Release(); }
    });
    app.MapGet("/api/wizard/{id:guid}", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.WizardDrafts.TryGetValue(id, out var d)) return Results.NotFound();
      if (!WizardGuide.TryWizardUser(s, req, d, out _, out var deniedWg)) return deniedWg;
      var before = d.InterviewJson;
      WizardGuide.NormalizeInterview(d);
      if (!string.Equals(before, d.InterviewJson, StringComparison.Ordinal))
      {
        d.UpdatedAt = DateTime.UtcNow;
        s.WizardDrafts.Flush();
      }
      return Results.Ok(d);
    });

    // ---- Voice: draft-first, explicit send; voice never approves/grants ----
    app.MapPost("/api/meetings/{id:guid}/voice", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badVoice) return badVoice;
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (PeopleOps.Check(s, req, m.BoardId, id, "discuss") is { } deniedVoice) return deniedVoice;
      var __vc = PeopleOps.UserOf(s, req);
      var t = new VoiceTurn
      {
        BoardId = m.BoardId, MeetingId = id, CreatorKey = __vc, State = "draft",
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
      if (PeopleOps.Check(s, req, t.BoardId, t.MeetingId, "discuss") is { } deniedFin) return deniedFin;
      { var __fu = PeopleOps.UserOf(s, req); var __fmgr = PeopleOps.Can(s, req, t.BoardId, null, "manage"); if (!__fmgr && !string.Equals(t.CreatorKey ?? "", __fu, System.StringComparison.OrdinalIgnoreCase)) return PeopleOps.Denied(); }
      lock (s.MessageLock)
      {
        // Authoritative finalize inside the backend transaction gate: fresh fetch,
        // session + permission + creator check, single state flip, single commit.
        // Unsent drafts are creator-private (no manager bypass); exactly once.
        Message? doneMsg = null;
        IResult? gateErr = null;
        Atomic.Run(() =>
        {
          if (!s.VoiceTurns.TryGetValue(id, out var vt) || vt is null) { gateErr = Results.NotFound(); return; }
          if (PeopleOps.BadToken(s, req) is { }) { gateErr = Results.Json(new { error = "Invalid or expired session token." }, statusCode: 401); return; }
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
          vt.Transcript = body.TryGetProperty("transcript", out var x) && x.ValueKind == System.Text.Json.JsonValueKind.String ? (x.GetString() ?? vt.Transcript) : vt.Transcript;
          vt.State = "sent";
          if (!s.Meetings.TryGetValue(vt.MeetingId, out var fm) || fm is null) { gateErr = Results.NotFound("meeting"); return; }
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
        if (gateErr is not null) return gateErr;
        return Results.Ok(doneMsg);
      }
    });

    // ---- Sources: approval inbox; excluded/replaced never current ----
    app.MapGet("/api/boards/{bid:guid}/sources", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badSL) return badSL;
      if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      if (PeopleOps.Can(s, req, bid, null, "read"))
        return Results.Ok(s.Sources.Values.Where(x => x.BoardId == bid).OrderByDescending(x => x.Version));
      var user = PeopleOps.UserOf(s, req);
      var allowed = PeopleOps.GuestMeetingIds(s, user, bid);
      if (allowed.Count == 0) return PeopleOps.Denied();
      return Results.Ok(s.Sources.Values.Where(x => x.BoardId == bid && x.Approved && !x.Excluded && (x.Scope == "board" || (x.MeetingId.HasValue && allowed.Contains(x.MeetingId.Value)))).OrderByDescending(x => x.Version));
    });
    app.MapPost("/api/boards/{bid:guid}/sources", (InMemoryStore s, HttpRequest req, Guid bid, SourceDoc d) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badSrc) return badSrc;
      if (!s.Boards.ContainsKey(bid)) return Results.NotFound("Board not found.");
      if (PeopleOps.Check(s, req, bid, null, "contribute") is { } deniedSrc) return deniedSrc;
      d.Id = Guid.NewGuid();
      d.BoardId = bid;
      d.Version = 1;
      d.Approved = false;
      d.Excluded = false;
      s.Sources[d.Id] = d;
      return Results.Created($"/api/sources/{d.Id}", d);
    });
    app.MapPost("/api/sources/{id:guid}/exclude", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var d)) return Results.NotFound();
      if (PeopleOps.BadToken(s, req) is { } badEx) return badEx;
      if (PeopleOps.Check(s, req, d.BoardId, d.MeetingId, "contribute") is { } deniedEx) return deniedEx;
      d.Excluded = true;
      s.Sources.Flush();
      return Results.Ok(d);
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
    app.MapPost("/api/jobs", (InMemoryStore s, HttpRequest req, JobRow j) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badJob) return badJob;
      if (PeopleOps.IsSecure(s))
      {
        if (!AuthOps.TrySession(s, req, out var ju2)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        var admin2 = PeopleOps.AdminEmail(s);
        var isAdmin2 = !string.IsNullOrWhiteSpace(admin2) && string.Equals(admin2, ju2, StringComparison.OrdinalIgnoreCase);
        if (!isAdmin2) return PeopleOps.Denied();
      }
      var existing = s.Jobs.Values.FirstOrDefault(x => x.IdempotencyKey == j.IdempotencyKey && j.IdempotencyKey != "");
      if (existing is not null) return Results.Ok(existing); // no duplicates
      j.Id = Guid.NewGuid();
      j.UpdatedAt = DateTime.UtcNow;
      s.Jobs[j.Id] = j;
      return Results.Created($"/api/jobs/{j.Id}", j);
    });

    // ---- Usage + audit + model-call ledger ----
    app.MapGet("/api/usage", (InMemoryStore s, HttpRequest req, Guid? boardId, Guid? meetingId, string? day, string? from, string? to) =>
    {
      if (PeopleOps.IsSecure(s))
      {
        if (PeopleOps.BadToken(s, req) is { } badU) return badU;
        if (!AuthOps.TrySession(s, req, out var uu)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        var adminU = PeopleOps.AdminEmail(s);
        var isAdminU = !string.IsNullOrWhiteSpace(adminU) && string.Equals(adminU, uu, StringComparison.OrdinalIgnoreCase);
        if (boardId.HasValue)
        {
          if (!s.Meetings.TryGetValue(meetingId ?? Guid.Empty, out _) && meetingId.HasValue) { }
          var bid = boardId.Value;
          var mid = meetingId;
          if (!PeopleOps.Can(s, req, bid, mid, "read")) return PeopleOps.Denied();
        }
        else
        {
          if (!isAdminU) return PeopleOps.Denied();
        }
      }
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
    app.MapGet("/api/models/calls", (InMemoryStore s, HttpRequest req) =>
    {
      if (PeopleOps.IsSecure(s))
      {
        if (PeopleOps.BadToken(s, req) is { } badMc) return badMc;
        if (!AuthOps.TrySession(s, req, out var mu)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        var adminM = PeopleOps.AdminEmail(s);
        var isAdminM = !string.IsNullOrWhiteSpace(adminM) && string.Equals(adminM, mu, StringComparison.OrdinalIgnoreCase);
        if (!isAdminM) return PeopleOps.Denied();
      }
      return Results.Ok(s.ModelCalls.Take(200));
    });

    // ---- Meeting controls ----
    foreach (var (path, state) in new[] { ("pause", MeetingState.Paused), ("resume", MeetingState.Active), ("end", MeetingState.WrappingUp) })
      app.MapPost($"/api/meetings/{{id:guid}}/{path}", (InMemoryStore s, HttpRequest req, Guid id) =>
      {
        if (PeopleOps.BadToken(s, req) is { } badCtl) return badCtl;
        if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound();
        if (PeopleOps.Check(s, req, m.BoardId, id, "manage") is { } deniedCtl) return deniedCtl;
        lock (s.MessageLock)
        {
          if (!s.Meetings.TryGetValue(id, out var cur)) return Results.NotFound();
          if (PeopleOps.Check(s, req, cur.BoardId, id, "manage") is { } deniedCtl2) return deniedCtl2;
          cur.State = state;
          cur.Generation++;
          s.Meetings.Flush();
          s.Audit.Add(new AuditEvent { BoardId = cur.BoardId, Action = "meeting." + path, Detail = System.Text.Json.JsonSerializer.Serialize(new { meeting = id }) });
          return Results.Ok(cur);
        }
      });

    // ---- Discussion run: bids -> challenge -> drafts -> ordered publish ----
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
      try
      {
      var policy = EffectiveDiscussionPolicy(s, m.BoardId);
      try { if (!PeopleOps.Can(s, req, m.BoardId, id, "contribute") && s.Boards.TryGetValue(m.BoardId, out var polB)) { policy = polB.DiscussionPolicy; try { if (polB.ActiveConfig && !string.IsNullOrWhiteSpace(polB.ActiveJson)) { using var __aj = System.Text.Json.JsonDocument.Parse(polB.ActiveJson); if (__aj.RootElement.TryGetProperty("discussionPolicy", out var __dp) && __dp.ValueKind == System.Text.Json.JsonValueKind.String && !string.IsNullOrWhiteSpace(__dp.GetString())) policy = __dp.GetString()!; } } catch { } } } catch { }
      if (policy is not ("focused" or "balanced" or "open")) policy = "balanced";
      var prompt = body.TryGetProperty("prompt", out var q) ? (q.GetString() ?? "") : "";
      s.Boards.TryGetValue(m.BoardId, out var runBoard);
    var lead = LeadSetup.ResolveLeadFor(s, m.BoardId);
    var leadVersion = lead?.Version ?? 0;
    // P1 #5: capture the full effective-lead identity/content fingerprint BEFORE
    // model work; commit compares the fresh fingerprint under the publication
    // locks. Version-only comparison would pass a same-version identity swap.
    var leadFingerprint = LeadIdentityFingerprint(lead);
      if (body.TryGetProperty("leadVersion", out var lv) && lv.ValueKind == JsonValueKind.Number
          && lv.GetInt32() != leadVersion)
        return Results.Conflict("Lead profile changed; refresh and retry with the current version.");
      if (m.State == MeetingState.Paused)
        return Results.Conflict("Meeting is paused; resume to run discussion.");
      var yielded = new List<object>();
      var candidates = s.Advisors.Values.Where(a => a.BoardId == m.BoardId && !a.Removed && a.Approved).ToList();
      var pickedCount = 0;
      try
      {
        using var pdoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(m.ParticipantIdsJson) ? "[]" : m.ParticipantIdsJson);
        if (pdoc.RootElement.ValueKind == JsonValueKind.Array)
        {
          var picked = new HashSet<Guid>();
          foreach (var pe in pdoc.RootElement.EnumerateArray())
            if (pe.ValueKind == JsonValueKind.String && Guid.TryParse(pe.GetString(), out var pg)) picked.Add(pg);
          if (picked.Count > 0) { pickedCount = picked.Count; candidates = s.Advisors.Values.Where(a => a.BoardId == m.BoardId && !a.Removed && picked.Contains(a.Id)).ToList(); }
        }
      }
      catch (JsonException) { }
      var eligible = new List<BoardAdvisor>();
      foreach (var cand in candidates)
      {
        var gate = RosterOps.ApprovalGate(s, cand);
        if (gate is null) eligible.Add(cand);
        else yielded.Add(new { advisor = cand.BoardRole, reason = gate });
      }
      if (eligible.Count == 0)
        return Results.Json(new { error = "No advisors available for discussion.", fixes = pickedCount > 0 ? new[] { "Re-pick participants from this board's current advisors." } : new[] { "Approve at least one advisor on this board before running discussion." }, yielded }, statusCode: 409);
      var ownerOverride = PeopleOps.IsOwner(req);
      var spark = ModelPolicy.SparkFor(s, m.BoardId);
      Board? board = runBoard;
      var gen = m.Generation;
      var leadFloor = MeetingTurns.LeadSeqAfter(s, id, 0);
      // Lane B: capture which candidates were explicitly invited; non-invited must stay Approved at commit.
      var invitedIds = new HashSet<Guid>();
      try
      {
        using var inviteDoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(m.ParticipantIdsJson) ? "[]" : m.ParticipantIdsJson);
        if (inviteDoc.RootElement.ValueKind == JsonValueKind.Array)
          foreach (var inviteEl in inviteDoc.RootElement.EnumerateArray())
            if (inviteEl.ValueKind == JsonValueKind.String && Guid.TryParse(inviteEl.GetString(), out var inviteGuid)) invitedIds.Add(inviteGuid);
      }
      catch (JsonException) { }
      // Lane B: reviewed-input fingerprint per candidate via shared RosterOps.ReviewedInputFingerprint.
      string LaneBFingerprint(BoardAdvisor laneBAdv) => RosterOps.ReviewedInputFingerprint(s, laneBAdv);
      var laneBPrints = eligible.ToDictionary(a => a.Id, a => LaneBFingerprint(a));
      // Lane B: per-lead cap cannot increase across runs. Persist the effective minimum selected cap
      // in a durable run-cap note keyed to the actual lead sequence; a new human lead resets the turn.
      var requestedCap = DiscussionPolicy.MaxReplies(policy);
      var effectiveCap = requestedCap;
      {
        int? priorCap = null;
        Guid priorCapNoteId = Guid.Empty;
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
        var capBody = JsonSerializer.Serialize(new { leadSeq = leadFloor, cap = effectiveCap, policy });
        if (priorCapNoteId != Guid.Empty && s.Notes.TryGetValue(priorCapNoteId, out var priorCapNote))
        {
          priorCapNote.Body = capBody;
          s.Notes[priorCapNoteId] = priorCapNote;
        }
        else
        {
          var freshCapNote = new Note { BoardId = m.BoardId, MeetingId = id, Kind = "run-cap", Scope = "meeting", Provisional = false, Title = "cap:" + leadFloor, Body = capBody };
          s.Notes[freshCapNote.Id] = freshCapNote;
        }
        s.Notes.Flush();
      }
      int CommittedThisTurn()
      {
        lock (s.MessageLock)
          return s.Messages.TryGetValue(id, out var cl) && cl is not null
            ? cl.Count(x => x.AdvisorId != Guid.Empty && x.Sequence > leadFloor) : 0;
      }
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
      s.Notes[outcome.Id] = outcome;
      s.Notes.Flush();
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
        var laneBRev = LaneBRevision();
        outcome.Title = "Run interrupted: " + laneBReason;
        outcome.Body = JsonSerializer.Serialize(new { policy, leadVersion, generation = gen, revision = laneBRev, rounds = laneBPlannedRounds, completedGroups, published = published.Count, yielded, abstained, bidErrorCount = bidErrors.Count, overflow, status = "interrupted", reason = laneBReason, remaining = laneBRemaining });
        s.Notes[outcome.Id] = outcome;
        s.Notes.Flush();
        return Results.Conflict("Interrupted: " + laneBReason + "; partial progress preserved in run outcome.");
      }
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
          catch (Exception ex) when (ex is CapExceededException or ProviderException or TaskCanceledException or HttpRequestException or JsonException)
          {
            return (adv, score: 0.0, text: "", error: (string?)ex.Message);
          }
          finally { bidSem.Release(); }
        }));
      }
      catch (Exception laneBEx) when (laneBEx is CapExceededException or ProviderException)
      {
        var laneBRemain = eligible.Where(a => !published.Any(p => p.AdvisorId == a.Id)).Select(a => a.BoardRole).ToList();
        LaneBFail("provider failure during bidding", 0, laneBRemain);
        return PeopleOps.ModelError(laneBEx);
      }
      if (m.State is not (MeetingState.Active or MeetingState.AwaitingBrief))
      {
        var laneBRemainStateAfterBid = eligible.Where(a => !published.Any(p => p.AdvisorId == a.Id)).Select(a => a.BoardRole).ToList();
        return LaneBFail("meeting state changed; unsent drafts discarded", 0, laneBRemainStateAfterBid);
      }
      if (m.Generation != gen || MeetingTurns.LeadSeqAfter(s, id, leadFloor) > leadFloor)
      {
        var laneBRemainAfterBid = eligible.Where(a => !published.Any(p => p.AdvisorId == a.Id)).Select(a => a.BoardRole).ToList();
        return LaneBFail("new owner turn arrived; unsent drafts discarded", 0, laneBRemainAfterBid);
      }
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
      var evSupported = body.TryGetProperty("evidenceSupported", out var e) && e.GetBoolean();
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
          catch (Exception ex) when (ex is CapExceededException or ProviderException or TaskCanceledException or HttpRequestException or JsonException)
          {
            return (adv, text: (string?)null, manifest: (CuratorManifest?)null, error: (string?)ex.Message);
          }
          finally { draftSem.Release(); }
        }));
        if (m.Generation != gen || MeetingTurns.LeadSeqAfter(s, id, leadFloor) > leadFloor)
        {
          var laneBRemainBetween = rounds.Skip(completedGroups).SelectMany(r => r).Where(a => !published.Any(p => p.AdvisorId == a.Id)).Select(a => a.BoardRole).ToList();
          return LaneBFail("new owner turn arrived; unsent drafts discarded", rounds.Count, laneBRemainBetween);
        }
        if (drafts.Any(d => d.manifest is not null && d.manifest.SourceIds.Count > 0)) evSupported = true;
        var challenged = DiscussionPolicy.AssignChallenge(round, evSupported, a => (double)(a.BoardRole.Length % 5));
        lastChallenged = challenged?.BoardRole ?? lastChallenged;
        // Lane B: final publication holds SetupLock THEN MessageLock (roster writers serialize on
        // SetupLock; pause/resume/end/close use MessageLock only, so this order never inverts).
        // Meeting, advisor and roster rows are fresh-fetched here; captured generation, lead sequence,
        // allowed state and reviewed-input fingerprints are compared immediately before commit.
        lock (s.SetupLock)
        {
          lock (s.MessageLock)
          {
            // Authoritative commit inside the actual backend transaction gate: fetch, authorize,
            // validate and mutate here so a concurrent failed transaction cannot detach our objects.
            IResult? laneBGate = null;
            Atomic.Run(() =>
            {
            List<string> LaneBRemaining() => rounds.Skip(completedGroups).SelectMany(r => r).Where(a => !published.Any(p => p.AdvisorId == a.Id)).Select(a => a.BoardRole).ToList();
            if (!s.Meetings.TryGetValue(id, out var cur) || cur.State is not (MeetingState.Active or MeetingState.AwaitingBrief))
              { laneBGate = LaneBFail("meeting state changed; unsent drafts discarded", rounds.Count, LaneBRemaining()); return; }
            if (cur.Generation != gen || MeetingTurns.LeadSeqAfter(s, id, leadFloor) > leadFloor)
              { laneBGate = LaneBFail("new owner turn arrived; unsent drafts discarded", rounds.Count, LaneBRemaining()); return; }
            { var __tok = ""; try { var __ah = req.Headers["Authorization"].ToString(); if (__ah.StartsWith("Bearer ", System.StringComparison.OrdinalIgnoreCase)) __tok = __ah["Bearer ".Length..].Trim(); } catch { } string __em = ""; bool __sessOk = false; try { if (!string.IsNullOrEmpty(__tok) && s.Sessions.TryGetValue(__tok, out var __ss) && __ss.ExpiresAt > System.DateTime.UtcNow) { __sessOk = true; __em = __ss.Email; } } catch { } if (PeopleOps.IsSecure(s) && !__sessOk) { laneBGate = LaneBFail("session revoked or expired; publication refused", rounds.Count, LaneBRemaining()); return; } try { var __have = PeopleOps.AccessFor(s, cur.BoardId, id, __em); bool __ok = PeopleOps.IsSecure(s) ? (__have is "manage" or "contribute" or "discuss") : (__have == "open" || __have is "manage" or "contribute" or "discuss"); if (!__ok) { laneBGate = LaneBFail("access revoked; publication refused", rounds.Count, LaneBRemaining()); return; } } catch { { laneBGate = LaneBFail("security unavailable; publication refused", rounds.Count, LaneBRemaining()); return; } } }
            var curLead = LeadSetup.ResolveLeadFor(s, cur.BoardId);
            var curLeadVersion = curLead?.Version ?? 0;
            if (curLeadVersion != leadVersion
                || !string.Equals(LeadIdentityFingerprint(curLead), leadFingerprint, StringComparison.Ordinal))
              { laneBGate = LaneBFail("lead profile changed; refresh and retry with the current version", rounds.Count, LaneBRemaining()); return; }
            var policyNow = EffectiveDiscussionPolicy(s, cur.BoardId);
            if (!string.Equals(policyNow, policy, StringComparison.Ordinal)) { laneBGate = LaneBFail("discussion policy changed; refresh and retry with the current version", rounds.Count, LaneBRemaining()); return; }
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
            var room = Math.Max(0, commitCap - list.Count(x => x.AdvisorId != Guid.Empty && x.Sequence > leadFloor));
            var batch = new List<Message>();
            foreach (var (adv, text, manifest, error) in drafts)
            {
              if (text is null || error is not null) { yielded.Add(new { advisor = adv.BoardRole, reason = "provider-error" }); continue; }
              if (string.IsNullOrWhiteSpace(text) || text.TrimStart().StartsWith("ABSTAIN", StringComparison.OrdinalIgnoreCase)) { abstained.Add(adv.BoardRole); yielded.Add(new { advisor = adv.BoardRole, reason = "abstained" }); continue; }
              // Lane B: fresh-fetch; a sync or edit/review during generation yields/discards the stale response.
              if (!s.Advisors.TryGetValue(adv.Id, out var freshAdv) || freshAdv.Removed || freshAdv.BoardId != m.BoardId)
                { yielded.Add(new { advisor = adv.BoardRole, reason = "not-eligible" }); continue; }
              if (!invitedIds.Contains(adv.Id) && !freshAdv.Approved)
                { yielded.Add(new { advisor = adv.BoardRole, reason = "reapproval-required" }); continue; }
              if (RosterOps.ApprovalGate(s, freshAdv) is { } gate)
                { yielded.Add(new { advisor = adv.BoardRole, reason = "not-eligible" }); continue; }
              if (!laneBPrints.TryGetValue(adv.Id, out var laneBWanted) || !string.Equals(LaneBFingerprint(freshAdv), laneBWanted, StringComparison.Ordinal))
                { yielded.Add(new { advisor = adv.BoardRole, reason = "stale-profile" }); continue; }
              if (list.Any(x => x.AdvisorId == adv.Id && x.Sequence > leadFloor) || batch.Any(x => x.AdvisorId == adv.Id))
                { yielded.Add(new { advisor = adv.BoardRole, reason = "already-replied-this-turn" }); continue; } // one reply per advisor per lead turn; stable advisor identity
              if (room <= 0)
                { yielded.Add(new { advisor = adv.BoardRole, reason = "cap-omitted" }); continue; }
              room--;
            var leadSeq = list.Where(x => x.Sender == "lead").OrderByDescending(x => x.Sequence).Select(x => (long?)x.Sequence).FirstOrDefault();
            var (clean, stance) = MessageTags.SplitStance(text);
            var msg = new Message
            {
              MeetingId = id, BoardId = m.BoardId, AdvisorId = adv.Id,
              Sequence = ++next,
              Sender = "advisor", AdvisorName = adv.BoardRole,
              Content = clean + (adv == challenged ? " [challenge: evidence-supported]" : ""),
              ParentSequence = leadSeq,
              Stance = stance,
              Status = "committed",
            };
            batch.Add(msg);
            published.Add(msg);
            if (manifest is not null)
              manifests.Add(new { advisor = adv.BoardRole, sources = manifest.SourceIds, seqs = manifest.MessageSeqs, tokens = manifest.TokenEstimate, evidence = manifest.Evidence });
          }
            Atomic.Run(() =>
            {
              // Lane B: revision set BEFORE the same atomic commit that inserts group messages.
              if (batch.Count > 0) cur.DeliveredRevision = batch.Max(x => x.Sequence);
              s.Messages.AddRangeCommitted(id, batch);
              s.Meetings.Flush();
              outcome.Title = "Run: " + published.Count + " replies, " + yielded.Count + " yields";
              outcome.Body = JsonSerializer.Serialize(new { policy, leadVersion, generation = gen, revision = cur.DeliveredRevision, rounds = rounds.Count, completedGroups = completedGroups + 1, published = published.Count, yielded, abstained, bidErrorCount = bidErrors.Count, overflow, leadSeq = leadFloor, cap = commitCap });
              s.Notes[outcome.Id] = outcome;
              s.Notes.Flush();
            });
            if (laneBGate is null) completedGroups++;
            }); // end Atomic gate: authoritative fetch/authorize/validate/mutate in one backend transaction
            if (laneBGate is not null) return laneBGate;
          }
        }
      }
      s.Audit.Add(new AuditEvent { BoardId = m.BoardId, Action = "discussion.run", Detail = JsonSerializer.Serialize(new { policy, rounds = rounds.Count, published = published.Count, leadVersion, generation = gen, bids = bidResults.Length, abstained, bidErrors = bidErrors.Count, manifests }) });
      await hub.Clients.Group($"meeting:{id:N}".ToLowerInvariant()).SendAsync("run-complete",
        new { meetingId = id, published = published.Count, revision = (s.Meetings.TryGetValue(id, out var __bc) ? __bc.DeliveredRevision : m.DeliveredRevision) });
      outcome.Title = "Run: " + published.Count + " replies, " + yielded.Count + " yields";
      outcome.Body = JsonSerializer.Serialize(new { policy, leadVersion, generation = gen, revision = m.DeliveredRevision, rounds = rounds.Count, completedGroups, published = published.Count, yielded, abstained, bidErrorCount = bidErrors.Count, overflow, leadSeq = leadFloor, cap = effectiveCap, status = "completed" });
      s.Notes[outcome.Id] = outcome;
      s.Notes.Flush();
      s.Meetings.Flush();
            return Results.Ok(new { rounds = rounds.Select(r => r.Select(a => a.BoardRole)), published, challenged = lastChallenged, abstained, bidErrors, yielded, overflow });
      }
      finally
      {
        lock (s.MessageLock) { s.RunningRuns.Remove(id); }
      }

    });

    // ---- Secretary: provisional answers, never decisions by themselves ----
    app.MapPost("/api/meetings/{id:guid}/secretary", async (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (PeopleOps.Check(s, req, m.BoardId, id, "contribute") is { } deniedSec) return deniedSec;
      var setupFixes = new List<string>();
      if (LeadSetup.ResolveLeadFor(s, m.BoardId) is null) setupFixes.Add("Save the board-lead profile.");
      if (!s.Advisors.Values.Any(a => a.BoardId == m.BoardId && !a.Removed && a.Approved && RosterOps.ApprovalGate(s, a) is null)) setupFixes.Add("Approve at least one eligible advisor on this board.");
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
