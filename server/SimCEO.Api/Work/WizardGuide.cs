using System.Text.Json;
using System.Text.Json.Nodes;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// Guided new-board wizard: real review blockers, an onboarding guide that
// asks the next question and proposes fields, and one-step board creation
// with lead profile plus advisor seats.
public static class WizardGuide
{
  // One reusable owner/board resolver for every actual wizard route.
  internal static bool TryWizardUser(InMemoryStore s, HttpRequest req, WizardDraft? d, out string user, out IResult? denied)
  {
    user = "";
    if (PeopleOps.BadToken(s, req) is { } bad) { denied = bad; return false; }
    try
    {
      if (PeopleOps.IsSecure(s))
      {
        if (!AuthOps.TrySession(s, req, out var em)) { denied = Results.Json(new { error = "Authentication required." }, statusCode: 401); return false; }
        user = em;
      }
      else user = PeopleOps.UserOf(s, req);
    }
    catch (InvalidOperationException) { denied = Results.Json(new { error = "Security state unavailable." }, statusCode: 503); return false; }
    if (d is not null && !string.IsNullOrWhiteSpace(d.OwnerKey))
    {
      if (!string.Equals(d.OwnerKey, user, StringComparison.OrdinalIgnoreCase) && !PeopleOps.IsInstallationAdmin(s, user))
      { denied = PeopleOps.Denied(); return false; }
    }
    else if (d is not null && string.IsNullOrWhiteSpace(d.OwnerKey) && PeopleOps.IsSecure(s))
    {
      // Blank-owner drafts are legacy leftovers (migration adopts them to the admin).
      // Only the installation admin may touch an unadopted draft.
      try { if (!PeopleOps.IsInstallationAdmin(s, user)) { denied = PeopleOps.Denied(); return false; } }
      catch (InvalidOperationException) { denied = Results.Json(new { error = "Security state unavailable." }, statusCode: 503); return false; }
    }
    denied = null;
    return true;
  }

  public static void MapWizardGuide(this WebApplication app)
  {
    app.MapGet("/api/wizard/{id:guid}/review", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.WizardDrafts.TryGetValue(id, out var __wd0)) return Results.NotFound();
      if (!TryWizardUser(s, req, __wd0, out _, out var deniedRw)) return deniedRw;
      if (!s.WizardDrafts.TryGetValue(id, out var d)) return Results.NotFound();
      var blockers = Blockers(d);
      return Results.Ok(new
      {
        step = d.Step,
        preset = d.PresetKey,
        status = blockers.Count == 0 ? "Ready" : "Blocked",
        blockers,
        fields = FieldStates(d),
      });
    });

    app.MapPost("/api/wizard/{id:guid}/suggest", async (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.WizardDrafts.TryGetValue(id, out var d)) return Results.NotFound("wizard draft");
      if (!TryWizardUser(s, req, d, out _, out var deniedSg)) return deniedSg;
      var step = body.TryGetProperty("step", out var st) && st.ValueKind == JsonValueKind.Number ? st.GetInt32() : d.Step;
      var input = body.TryGetProperty("input", out var q) ? (q.GetString() ?? "") : "";
      try
      {
        var gw = new ModelGateway(s);
        var raw = await gw.CompleteAsync(ModelPolicy.SparkFor(s, null), "wizard-guide", GuidePrompt(d, step, input), 2000, 1024, ownerOverride: PeopleOps.IsOwner(req));
        var parsed = ParseGuideJson(raw);
        if (parsed is not null) return Results.Ok(parsed);
      }
      catch (Exception ex) when (ex is ProviderNotConfiguredException or ProviderException or CapExceededException)
      {
        s.Audit.Add(new AuditEvent { Action = "wizard.guide-fallback", Detail = ex.GetType().Name });
      }
      return Results.Ok(LocalGuide(d, step));
    });

    app.MapPost("/api/wizard/{id:guid}/interview", async (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.WizardDrafts.TryGetValue(id, out var dd)) return Results.NotFound("wizard draft");
      if (!TryWizardUser(s, req, dd, out _, out var deniedIv)) return deniedIv;
      var sem = s.DraftLocks.GetOrAdd(id, _ => new SemaphoreSlim(1, 1));
      await sem.WaitAsync();
      try
      {
        if (!s.WizardDrafts.TryGetValue(id, out var d) || d is null) return Results.NotFound("wizard draft");
        if (!TryWizardUser(s, req, d, out _, out var deniedIv2)) return deniedIv2;
        if (!body.TryGetProperty("version", out var vw) || vw.ValueKind != JsonValueKind.Number || !vw.TryGetInt32(out var want) || want != d.Version)
          return Results.Conflict("Stale wizard draft; refresh and re-apply your edit.");
        var answer = body.TryGetProperty("answer", out var av) && av.ValueKind == JsonValueKind.String ? (av.GetString() ?? "") : "";
        var turns = ReadTurns(d);
        var before = new HashSet<int>(Blockers(d).Select(b => b.step));
        var currentQ = ReadPendingQuestion(d) ?? NextQuestion(d);
        string question;
        string analysis;
        var extractOk = true;
        string? extractError = null;
        var applied = new List<string>();
        if (turns.Count == 0 && string.IsNullOrWhiteSpace(answer))
        {
          question = currentQ;
          analysis = "Starting the setup interview from the current draft.";
          var after0 = Blockers(d);
          var checkpoints0 = ReadCheckpoints(d);
          d.Step = after0.Count == 0 ? 4 : after0.Min(b => b.step);
          d.InterviewJson = JsonSerializer.Serialize(new { turns, checkpoints = checkpoints0, pendingQuestion = question, lastAnalysis = new { ok = true, at = DateTime.UtcNow, started = true } });
          NormalizeInterview(d);
          d.Version++;
          d.UpdatedAt = DateTime.UtcNow;
          s.WizardDrafts[d.Id] = d;
          s.WizardDrafts.Flush();
          return Results.Ok(new { question, analysis, applied, extractOk, extractError, pendingQuestion = question, version = d.Version, fields = FieldStates(d), blockers = after0, checkpoints = checkpoints0, turns, done = after0.Count == 0 });
        }
        else
        {
          if (!string.IsNullOrWhiteSpace(answer))
            turns.Add(new InterviewTurn(currentQ, answer.Trim(), DateTime.UtcNow, ""));
          var jobId = Guid.NewGuid().ToString("N");
          var pendingAt = DateTime.UtcNow;
          var pendingCheckpoints = ReadCheckpoints(d);
          d.InterviewJson = JsonSerializer.Serialize(new { turns, checkpoints = pendingCheckpoints, pendingQuestion = currentQ, lastAnalysis = new { ok = false, status = "pending", jobId, at = pendingAt, turn = turns.Count } });
          NormalizeInterview(d);
          d.Version++;
          d.UpdatedAt = DateTime.UtcNow;
          s.WizardDrafts[d.Id] = d;
          s.WizardDrafts.Flush();
          var pendingVersion = d.Version;
          var gw = new ModelGateway(s);
          var gate = PeopleOps.Guard(gw, req);
          InterviewParsed? parsed = null;
          if (gate is not null)
          {
            analysis = "Recorded. The guide is paused by usage controls, so nothing was extracted. Your answer is saved: retry later or use the fast-path form.";
            question = NextQuestion(d);
            extractOk = false;
            extractError = "usage-capped";
          }
          else
          {
            try
            {
              for (var attempt = 0; attempt < 2 && parsed is null; attempt++)
              {
                var iPrompt = attempt == 0 ? InterviewPrompt(d, turns) : InterviewPrompt(d, turns) + " Your previous reply was not valid JSON. Reply with a single JSON object only.";
                var raw = await gw.CompleteAsync(ModelPolicy.SparkFor(s, null), "wizard-interview",
                  iPrompt, 2000, 2048, ownerOverride: PeopleOps.IsOwner(req));
                parsed = ParseInterviewJson(raw);
                if (parsed is null) s.Audit.Add(new AuditEvent { Action = "wizard.interview-unparsed", Detail = raw.Length > 500 ? raw.Substring(0, 500) : raw });
              }
              if (parsed is null)
              {
                analysis = "Recorded.";
                extractOk = false;
                extractError = "unparsed-model-output";
              }
              else analysis = parsed.analysis;
              question = string.IsNullOrWhiteSpace(parsed?.nextQuestion) ? NextQuestion(d) : parsed!.nextQuestion;
            }
            catch (Exception ex) when (ex is ProviderNotConfiguredException or ProviderException or CapExceededException or TaskCanceledException or HttpRequestException or JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
            {
              analysis = "Recorded. The guide model is unavailable, so nothing was extracted. Your answer is saved: retry later or use the fast-path form.";
              question = NextQuestion(d);
              extractOk = false;
              extractError = ex.GetType().Name;
              s.Audit.Add(new AuditEvent { Action = "wizard.interview-fallback", Detail = ex.GetType().Name });
            }
          }
          if (!s.WizardDrafts.TryGetValue(id, out var fresh) || fresh is null) return Results.NotFound("wizard draft");
          // Renewed session/ownership authorization after the model await: a
          // logout or ownership change during generation must not commit.
          if (!TryWizardUser(s, req, fresh, out _, out var deniedIv3)) return deniedIv3;
          string? freshJob = null;
          try
          {
            using var pj = JsonDocument.Parse(string.IsNullOrWhiteSpace(fresh.InterviewJson) ? "{}" : fresh.InterviewJson);
            if (pj.RootElement.TryGetProperty("lastAnalysis", out var la) && la.ValueKind == JsonValueKind.Object && la.TryGetProperty("jobId", out var jj) && jj.ValueKind == JsonValueKind.String)
              freshJob = jj.GetString();
          }
          catch (JsonException) { }
          if (fresh.Version != pendingVersion || !string.Equals(freshJob, jobId, StringComparison.Ordinal))
            return Results.Conflict("Draft changed during interview; retry with the latest version.");
          var pendingUpdates = parsed?.updates ?? new Dictionary<string, string>();
          foreach (var u in pendingUpdates)
            if (ApplyFieldUpdate(fresh, u.Key, u.Value)) applied.Add(u.Key);
          if (turns.Count > 0) turns[^1] = turns[^1] with { analysis = analysis };
          var after = Blockers(fresh);
          var checkpoints = ReadCheckpoints(fresh);
          foreach (var st in before.Except(after.Select(b => b.step)).OrderBy(x => x))
            checkpoints.Add(new InterviewCheckpoint(DateTime.UtcNow, "Step " + st + " ready: " + StepLabel(st)));
          fresh.Step = after.Count == 0 ? 4 : after.Min(b => b.step);
          fresh.InterviewJson = JsonSerializer.Serialize(new { turns, checkpoints, pendingQuestion = question, lastAnalysis = new { ok = extractOk, at = DateTime.UtcNow, error = extractError, jobId } });
          NormalizeInterview(fresh);
          fresh.Version++;
          fresh.UpdatedAt = DateTime.UtcNow;
          s.WizardDrafts[fresh.Id] = fresh;
          s.WizardDrafts.Flush();
          return Results.Ok(new { question, analysis, applied, extractOk, extractError, pendingQuestion = question, version = fresh.Version, fields = FieldStates(fresh), blockers = after, checkpoints, turns, done = after.Count == 0 });
        }
      }
      finally { sem.Release(); }
    });
    app.MapPost("/api/wizard/{id:guid}/create", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.WizardDrafts.TryGetValue(id, out var wd)) return Results.NotFound("wizard draft");
      if (!TryWizardUser(s, req, wd, out var createUser, out var deniedCr)) return deniedCr;
      var sem = s.DraftLocks.GetOrAdd(id, _ => new SemaphoreSlim(1, 1));
      if (!sem.Wait(0)) return Results.Conflict("Draft is busy (interview running); retry.");
      try
      {
        lock (s.SetupLock)
        {
          if (!s.WizardDrafts.TryGetValue(id, out var fresh) || fresh is null) return Results.NotFound("wizard draft");
          if (!TryWizardUser(s, req, fresh, out var createUser2, out var deniedCr2)) return deniedCr2;
          return CreateFromDraft(s, req, id, fresh, createUser2);
        }
      }
      finally { sem.Release(); }
    });
  }

  private static IResult CreateFromDraft(InMemoryStore s, HttpRequest req, Guid id, WizardDraft wd, string ownerKey)
  {
    {
      var d = wd;
      _ = id;
      // Retry-safe: a completed draft replays the original board instead of duplicating it.
      const string createdPrefix = "created:";
      if (d.Status.StartsWith(createdPrefix, StringComparison.Ordinal)
          && Guid.TryParse(d.Status.Substring(createdPrefix.Length), out var priorBoard)
          && s.Boards.TryGetValue(priorBoard, out var prior))
      {
        var priorAdvisors = s.Advisors.Values.Where(a => a.BoardId == priorBoard && !a.Removed)
          .Select(a => new { advisor = a.Id, role = a.BoardRole }).ToList<object>();
        if (PeopleOps.Check(s, req, priorBoard, null, "read") is { } deniedReplay) return deniedReplay;
        return Results.Ok(new
        {
          board = prior, advisors = priorAdvisors, resumed = true,
          portraitReview = "pending: accept a portrait for each advisor before approval",
        });
      }
      // Validate everything BEFORE any write: no partial boards on failure.
      var blockers = Blockers(d);
      if (blockers.Count > 0) return Results.Json(new { blockers }, statusCode: 409);
      var f = ReadFields(d);
      var seats = f.Advisors.Where(seat => !string.IsNullOrWhiteSpace(seat.Role)).Take(11).ToList();
      if (string.IsNullOrWhiteSpace(f.LeadName))
        return Results.Json(new { error = "Lead name is required." }, statusCode: 409);
      var board = new Board { Id = Guid.NewGuid(), Name = f.Name, Mission = f.Mission, Stage = f.Stage, OwnerKey = ownerKey, CreatedAt = DateTime.UtcNow };
      var created = new List<object>();
      var createdAdvisors = new List<Guid>();
      var createdRoster = new List<Guid>();
      var createdImages = new List<Guid>();
      Guid savedLeadId = Guid.Empty;
      try
      {
        return Atomic.Run(() =>
        {
          s.Boards[board.Id] = board;
          var (saved, leadError, _) = LeadSetup.SaveLead(s, board.Id, new LeadProfile
          {
            Name = f.LeadName, RoleLabel = f.LeadRole, Background = f.LeadBackground,
            FamiliarTopics = f.LeadFamiliar, SimplerTopics = f.LeadSimpler, CommPrefs = f.LeadComm,
          });
          if (saved is null) throw new InvalidOperationException(leadError ?? "Lead save failed.");
          savedLeadId = saved.Id;
      // Fictional wizard advisors enter the explicit portrait review lifecycle
      // with a clearly-marked pending placeholder: copy succeeds, but approval
      // still requires an accepted portrait (same trust gate as every advisor).
      foreach (var seat in seats)
      {
        var seatName = string.IsNullOrWhiteSpace(seat.Name) ? seat.Role.Trim() : seat.Name.Trim();
        var entry = new RosterEntry
        {
          Id = Guid.NewGuid(), AccountId = d.AccountId, OwnerKey = ownerKey, Type = AdvisorType.FictionalCharacter,
          Name = seatName, Description = seat.Role.Trim() + " helping with: " + f.Mission,
          ProfileJson = RosterOps.CharacterJson(seatName, seat.Role.Trim(), f.Mission),
          Version = 1, UpdatedAt = DateTime.UtcNow,
        };
        s.Roster[entry.Id] = entry;
        createdRoster.Add(entry.Id);
        var placeholder = new AdvisorImage
        {
          Id = Guid.NewGuid(), RosterEntryId = entry.Id, Kind = "wizard-placeholder",
          Review = "pending", Provenance = "wizard:placeholder-pending-explicit-review",
          ContentType = "image/png", Data = WizardPlaceholderPng,
        };
        s.Images[placeholder.Id] = placeholder;
        createdImages.Add(placeholder.Id);
        var (copy, copyError, _) = RosterOps.TryCopy(s, entry.Id, board.Id, seat.Role.Trim());
        if (copy is null) throw new InvalidOperationException(copyError ?? "Advisor copy failed.");
        createdAdvisors.Add(copy.Id);
        created.Add(new { advisor = copy.Id, role = copy.BoardRole });
      }
          d.Status = createdPrefix + board.Id;
          d.Version++;
          s.WizardDrafts[d.Id] = d;
          s.WizardDrafts.Flush();
          s.Boards.Flush();
          s.Roster.Flush();
          s.Images.Flush();
          s.Advisors.Flush();
          s.LeadProfiles.Flush();
          s.Audit.Add(new AuditEvent { BoardId = board.Id, Action = "wizard.create", Detail = JsonSerializer.Serialize(new { board = board.Id, advisors = created.Count }) });
          return Results.Created("/api/boards/" + board.Id, new
          {
            board, advisors = created,
            portraitReview = "pending: accept a portrait for each advisor before approval",
          });
        });
      }
      catch (Exception ex)
      {
        foreach (var imgId in createdImages) s.Images.TryRemove(imgId, out _);
        foreach (var rid in createdRoster) s.Roster.TryRemove(rid, out _);
        foreach (var aid in createdAdvisors) s.Advisors.TryRemove(aid, out _);
        if (savedLeadId != Guid.Empty) s.LeadProfiles.TryRemove(savedLeadId, out _);
        s.Boards.TryRemove(board.Id, out _);
        s.Audit.Add(new AuditEvent { Action = "wizard.create-rolled-back", Detail = ex.Message });
        return Results.Json(new { error = "Board creation failed and was rolled back." }, statusCode: 500);
      }
    }
  }

  private static readonly byte[] WizardPlaceholderPng = Convert.FromBase64String(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");

  private sealed record WizardFields(string Name, string Mission, string Stage, string Preset, string LeadName, string LeadRole, string LeadBackground, string LeadFamiliar, string LeadSimpler, string LeadComm, List<Seat> Advisors);
  private sealed record Seat(string Role, string Name);
  private sealed record Blocker(string field, int step, string message);

  private static string Str(JsonElement e, string name)
  {
    if (e.ValueKind != JsonValueKind.Object) return "";
    return e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";
  }

  private static WizardFields ReadFields(WizardDraft d)
  {
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(d.FieldsJson) ? "{}" : d.FieldsJson);
      var root = doc.RootElement;
      var hasLead = root.TryGetProperty("lead", out var l) && l.ValueKind == JsonValueKind.Object;
      var advisors = new List<Seat>();
      if (root.TryGetProperty("advisors", out var arr) && arr.ValueKind == JsonValueKind.Array)
        foreach (var a in arr.EnumerateArray())
        {
          if (a.ValueKind != JsonValueKind.Object) continue;
          var role = Str(a, "role");
          if (!string.IsNullOrWhiteSpace(role)) advisors.Add(new Seat(role, Str(a, "name")));
        }
      return new WizardFields(Str(root, "name"), Str(root, "mission"), Str(root, "stage"), d.PresetKey,
        hasLead ? Str(l, "name") : "", hasLead ? Str(l, "roleLabel") : "", hasLead ? Str(l, "background") : "",
        hasLead ? Str(l, "familiarTopics") : "", hasLead ? Str(l, "simplerTopics") : "", hasLead ? Str(l, "commPrefs") : "",
        advisors);
    }
    catch (JsonException) { return new WizardFields("", "", "", d.PresetKey, "", "", "", "", "", "", new()); }
  }

  private static List<Blocker> Blockers(WizardDraft d)
  {
    var f = ReadFields(d);
    var list = new List<Blocker>();
    if (string.IsNullOrWhiteSpace(f.Name)) list.Add(new Blocker("name", 1, "Give the board a name."));
    if (string.IsNullOrWhiteSpace(f.Mission)) list.Add(new Blocker("mission", 1, "Describe what the board is for."));
    if (f.Advisors.Count == 0) list.Add(new Blocker("advisors", 2, "Add at least one advisor."));
    if (f.Advisors.Count > 10) list.Add(new Blocker("advisors", 2, "A board holds at most ten advisors."));
    if (string.IsNullOrWhiteSpace(f.LeadName)) list.Add(new Blocker("lead", 3, "Tell us who leads the board."));
    return list;
  }

  private static object LocalGuide(WizardDraft d, int step)
  {
    var f = ReadFields(d);
    var preset = PresetLibrary.Find(d.PresetKey);
    if (step == 2)
    {
      var roles = (preset is null ? Array.Empty<string>() : preset.Roles)
        .Select(r => new { role = r, why = preset is null ? "" : preset.Agenda }).ToList<object>();
      return new
      {
        suggestion = preset is null || preset.Roles.Length == 0
          ? "Tell me what expertise this decision needs and I will turn it into advisor seats."
          : "Based on the " + preset.Title + " starting point, these seats cover the angles well. Add the ones you want, rename them, or drop any that do not fit.",
        nextQuestion = "Which of these seats do you want, and who or what is missing?",
        fields = new { roles },
      };
    }
    if (step == 3)
    {
      return new
      {
        suggestion = "Advisors work best when they know who they are talking to. A sentence on your background and how blunt they may be goes a long way.",
        nextQuestion = "How should advisors talk to you: blunt, careful, or detailed?",
        fields = new { },
      };
    }
    if (string.IsNullOrWhiteSpace(f.Name))
      return new { suggestion = "A short name keeps the board easy to find later.", nextQuestion = "What should we call this board?", fields = new { } };
    if (string.IsNullOrWhiteSpace(f.Mission))
      return new
      {
        suggestion = "One or two sentences on the decision ahead will steer every advisor on this board.",
        nextQuestion = "What decision should this board help you make?",
        fields = (object)(preset is null || string.IsNullOrWhiteSpace(preset.Question) ? new { } : new { mission = preset.Question }),
      };
    return new
    {
      suggestion = "The basics look good. A line on where things stand helps advisors pitch in at the right level.",
      nextQuestion = "Where do things stand right now?",
      fields = new { },
    };
  }

  private static string GuidePrompt(WizardDraft d, int step, string input)
  {
    var f = ReadFields(d);
    var seats = f.Advisors.Count == 0 ? "none yet" : string.Join("; ", f.Advisors.Select(a => a.Role));
    return "You are the onboarding guide for Sim CEO board creation. Current draft: name=" + f.Name
      + "; mission=" + f.Mission + "; stage=" + f.Stage + "; preset=" + f.Preset
      + "; advisors=" + seats + "; lead=" + f.LeadName
      + ". The owner is on step " + step + " (1 About, 2 Advisors, 3 Lead, 4 Review) and just wrote: " + input
      + ". Reply with JSON only, no other text: {\"suggestion\": \"...\", \"nextQuestion\": \"...\", \"fields\": {...}}."
      + " Keep suggestion under 60 words. Only propose fields the owner has not set."
      + " Advisor roles go in fields.roles as [{\"role\": ..., \"why\": ...}].";
  }

  private static object? ParseGuideJson(string raw)
  {
    try
    {
      var start = raw.IndexOf("{");
      var end = raw.LastIndexOf("}");
      if (start < 0 || end <= start) return null;
      using var doc = JsonDocument.Parse(raw.Substring(start, end - start + 1));
      var root = doc.RootElement;
      var suggestion = Str(root, "suggestion");
      var nextQuestion = Str(root, "nextQuestion");
      if (string.IsNullOrWhiteSpace(suggestion) || string.IsNullOrWhiteSpace(nextQuestion)) return null;
      var fields = root.TryGetProperty("fields", out var fl) && fl.ValueKind == JsonValueKind.Object ? fl.Clone() : JsonDocument.Parse("{}").RootElement.Clone();
      var trimmed = suggestion.Length > 2000 ? suggestion.Substring(0, 2000) : suggestion;
      return new { suggestion = trimmed, nextQuestion, fields };
    }
    catch (JsonException) { return null; }
  }
  private sealed record InterviewTurn(string question, string answer, DateTime at, string analysis);
  private sealed record InterviewCheckpoint(DateTime at, string text);
  private sealed record InterviewParsed(string analysis, string nextQuestion, Dictionary<string, string> updates);
  private static List<InterviewTurn> ReadTurns(WizardDraft d)
  {
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(d.InterviewJson) ? "{}" : d.InterviewJson);
      if (doc.RootElement.TryGetProperty("turns", out var t) && t.ValueKind == JsonValueKind.Array)
        return JsonSerializer.Deserialize<List<InterviewTurn>>(t.GetRawText(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new();
    }
    catch (JsonException) { }
    return new();
  }

  public static void NormalizeInterview(WizardDraft d)
  {
    var root = new JsonObject
    {
      ["turns"] = JsonSerializer.SerializeToNode(ReadTurns(d)),
      ["checkpoints"] = JsonSerializer.SerializeToNode(ReadCheckpoints(d)),
    };
    if (ReadPendingQuestion(d) is { } pq) root["pendingQuestion"] = pq;
    if (ReadRawNode(d, "lastAnalysis") is { } la) root["lastAnalysis"] = la;
    var norm = root.ToJsonString();
    if (!string.Equals(norm, d.InterviewJson, StringComparison.Ordinal)) d.InterviewJson = norm;
  }
  private static JsonNode? ReadRawNode(WizardDraft d, string prop)
  {
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(d.InterviewJson) ? "{}" : d.InterviewJson);
      if (doc.RootElement.TryGetProperty(prop, out var el)) return JsonNode.Parse(el.GetRawText());
    }
    catch (JsonException) { }
    return null;
  }
  private static string? ReadPendingQuestion(WizardDraft d)
  {
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(d.InterviewJson) ? "{}" : d.InterviewJson);
      if (doc.RootElement.TryGetProperty("pendingQuestion", out var q) && q.ValueKind == JsonValueKind.String)
      {
        var s = q.GetString() ?? "";
        if (!string.IsNullOrWhiteSpace(s)) return s;
      }
    }
    catch (JsonException) { }
    return null;
  }
  private static List<InterviewCheckpoint> ReadCheckpoints(WizardDraft d)
  {
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(d.InterviewJson) ? "{}" : d.InterviewJson);
      if (doc.RootElement.TryGetProperty("checkpoints", out var c) && c.ValueKind == JsonValueKind.Array)
        return JsonSerializer.Deserialize<List<InterviewCheckpoint>>(c.GetRawText(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new();
    }
    catch (JsonException) { }
    return new();
  }
  private static string StepLabel(int step) => step switch { 1 => "About the board", 2 => "Advisor seats", 3 => "Board lead", _ => "Review" };
  private static string NextQuestion(WizardDraft d)
  {
    var f = ReadFields(d);
    if (string.IsNullOrWhiteSpace(f.Name)) return "What should we call this board?";
    if (string.IsNullOrWhiteSpace(f.Mission)) return "What decision should this board help you make?";
    if (string.IsNullOrWhiteSpace(f.Stage)) return "Where do things stand right now?";
    if (f.Advisors.Count == 0) return "Which seats do you want on this board, and what expertise is missing?";
    if (string.IsNullOrWhiteSpace(f.LeadName)) return "Who leads this board? Tell me your name.";
    if (string.IsNullOrWhiteSpace(f.LeadComm)) return "How should advisors talk to you: blunt, careful, or detailed?";
    return "The setup looks complete. Review the draft and create the board when ready.";
  }
  private static List<object> FieldStates(WizardDraft d)
  {
    var f = ReadFields(d);
    return new List<object>
    {
      new { field = "name", step = 1, status = string.IsNullOrWhiteSpace(f.Name) ? "missing" : "set" },
      new { field = "mission", step = 1, status = string.IsNullOrWhiteSpace(f.Mission) ? "missing" : "set" },
      new { field = "stage", step = 1, status = string.IsNullOrWhiteSpace(f.Stage) ? "missing" : "set" },
      new { field = "advisors", step = 2, status = f.Advisors.Count == 0 ? "missing" : "set" },
      new { field = "leadName", step = 3, status = string.IsNullOrWhiteSpace(f.LeadName) ? "missing" : "set" },
      new { field = "leadComm", step = 3, status = string.IsNullOrWhiteSpace(f.LeadComm) ? "missing" : "set" },
    };
  }
  private static bool ApplyFieldUpdate(WizardDraft d, string key, string value)
  {
    value = (value ?? "").Trim();
    if (string.IsNullOrWhiteSpace(value)) return false;
    JsonObject root;
    try { root = JsonNode.Parse(string.IsNullOrWhiteSpace(d.FieldsJson) ? "{}" : d.FieldsJson)?.AsObject() ?? new JsonObject(); }
    catch (JsonException) { root = new JsonObject(); }
    var k = (key ?? "").Trim().ToLowerInvariant();
    switch (k)
    {
      case "name": case "boardname": root["name"] = value; break;
      case "mission": case "goal": case "decision": root["mission"] = value; break;
      case "stage": case "situation": root["stage"] = value; break;
      case "advisors": case "seats": case "roles":
      {
        var arr = root["advisors"] as JsonArray ?? new JsonArray();
        var have = new HashSet<string>(arr.OfType<JsonObject>().Select(o => (o["role"]?.GetValue<string>() ?? "").Trim().ToLowerInvariant()));
        var changed = false;
        foreach (var part in value.Split(new[] { ",", ";", "\n" }, StringSplitOptions.RemoveEmptyEntries))
        {
          var role = part.Trim();
          if (role.Length == 0 || role.Length > 80 || have.Contains(role.ToLowerInvariant())) continue;
          arr.Add(new JsonObject { ["role"] = role, ["name"] = "" });
          have.Add(role.ToLowerInvariant());
          changed = true;
        }
        if (!changed) return false;
        root["advisors"] = arr;
        break;
      }
      case "leadname": case "lead": case "ceo": root["lead"] = LeadWith(root, "name", value); break;
      case "leadbackground": case "background": root["lead"] = LeadWith(root, "background", value); break;
      case "leadcomm": case "commprefs": case "voice": root["lead"] = LeadWith(root, "commPrefs", value); break;
      default: return false;
    }
    d.FieldsJson = root.ToJsonString();
    return true;
  }
  private static JsonObject LeadWith(JsonObject root, string prop, string value)
  {
    var l = root["lead"] as JsonObject ?? new JsonObject();
    l[prop] = value;
    return l;
  }
  private static string InterviewPrompt(WizardDraft d, List<InterviewTurn> turns)
  {
    var f = ReadFields(d);
    var seats = f.Advisors.Count == 0 ? "none yet" : string.Join("; ", f.Advisors.Select(a => a.Role));
    var recent = turns.TakeLast(3).Select(t => "Q: " + t.question + " A: " + t.answer);
    return "You guide Sim CEO board setup. Current draft: name=" + f.Name + "; mission=" + f.Mission + "; stage=" + f.Stage
      + "; advisors=" + seats + "; lead=" + f.LeadName + " (" + f.LeadComm + "). Recent turns: " + string.Join(" | ", recent)
      + ". Reply with JSON only, no other text: {\"analysis\": \"...\", \"updates\": {\"<field>\": \"<value>\"}, \"nextQuestion\": \"...\"}."
      + " Analysis under 60 words. Only set fields the owner just provided, using exactly these keys: name, mission, stage, advisors (comma-separated roles), leadName, leadBackground, leadComm."
      + " The next question asks for the single most important missing piece, one question only.";
  }
  private static InterviewParsed? ParseInterviewJson(string raw)
  {
    try
    {
      var start = raw.IndexOf("{");
      var end = raw.LastIndexOf("}");
      if (start < 0 || end <= start) return null;
      using var doc = JsonDocument.Parse(raw.Substring(start, end - start + 1));
      var root = doc.RootElement;
      var analysis = Str(root, "analysis");
      var next = Str(root, "nextQuestion");
      if (string.IsNullOrWhiteSpace(analysis)) return null;
      var updates = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      if (root.TryGetProperty("updates", out var u) && u.ValueKind == JsonValueKind.Object)
        foreach (var p in u.EnumerateObject())
        {
          string v = p.Value.ValueKind == JsonValueKind.String ? (p.Value.GetString() ?? "")
            : p.Value.ValueKind == JsonValueKind.Array ? string.Join(", ", p.Value.EnumerateArray().Select(e => e.ValueKind == JsonValueKind.String ? e.GetString() ?? "" : e.GetRawText()))
            : p.Value.GetRawText();
          if (!string.IsNullOrWhiteSpace(v)) updates[p.Name] = v.Trim();
        }
      var trimmed = analysis.Length > 2000 ? analysis.Substring(0, 2000) : analysis;
      return new InterviewParsed(trimmed, next, updates);
    }
    catch (JsonException) { return null; }
  }
}