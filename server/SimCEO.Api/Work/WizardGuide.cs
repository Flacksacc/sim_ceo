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
  public static void MapWizardGuide(this WebApplication app)
  {
    app.MapGet("/api/wizard/{id:guid}/review", (InMemoryStore s, Guid id) =>
    {
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
      if (!s.WizardDrafts.TryGetValue(id, out var d)) return Results.NotFound("wizard draft");
      var answer = body.TryGetProperty("answer", out var av) && av.ValueKind == JsonValueKind.String ? (av.GetString() ?? "") : "";
      var turns = ReadTurns(d);
      var before = new HashSet<int>(Blockers(d).Select(b => b.step));
      var currentQ = NextQuestion(d);
      string question;
      string analysis;
      var applied = new List<string>();
      if (turns.Count == 0 && string.IsNullOrWhiteSpace(answer))
      {
        question = currentQ;
        analysis = "Starting the setup interview from the current draft.";
      }
      else
      {
        if (!string.IsNullOrWhiteSpace(answer))
          turns.Add(new InterviewTurn(currentQ, answer.Trim(), DateTime.UtcNow, ""));
        d.InterviewJson = JsonSerializer.Serialize(new { turns, checkpoints = ReadCheckpoints(d) });
        d.UpdatedAt = DateTime.UtcNow;
        var gw = new ModelGateway(s);
        var gate = PeopleOps.Guard(gw, req);
        if (gate is not null)
        {
          analysis = "Recorded. The guide is paused by usage controls, so nothing was extracted. Your answer is saved: retry later or use the fast-path form.";
          question = NextQuestion(d);
        }
        else try
        {
          InterviewParsed? parsed = null;
          for (var attempt = 0; attempt < 2 && parsed is null; attempt++)
          {
            var iPrompt = attempt == 0 ? InterviewPrompt(d, turns) : InterviewPrompt(d, turns) + " Your previous reply was not valid JSON. Reply with a single JSON object only.";
            var raw = await gw.CompleteAsync(ModelPolicy.SparkFor(s, null), "wizard-interview",
              iPrompt, 2000, 2048, ownerOverride: PeopleOps.IsOwner(req));
            parsed = ParseInterviewJson(raw);
            if (parsed is null) s.Audit.Add(new AuditEvent { Action = "wizard.interview-unparsed", Detail = raw.Length > 500 ? raw.Substring(0, 500) : raw });
          }
          analysis = parsed?.analysis ?? "Recorded.";
          question = string.IsNullOrWhiteSpace(parsed?.nextQuestion) ? NextQuestion(d) : parsed!.nextQuestion;
          foreach (var u in parsed?.updates ?? new Dictionary<string, string>())
            if (ApplyFieldUpdate(d, u.Key, u.Value)) applied.Add(u.Key);
        }
        catch (Exception ex) when (ex is ProviderNotConfiguredException or ProviderException or CapExceededException)
        {
          analysis = "Recorded. The guide model is unavailable, so nothing was extracted. Your answer is saved: retry later or use the fast-path form.";
          question = NextQuestion(d);
          s.Audit.Add(new AuditEvent { Action = "wizard.interview-fallback", Detail = ex.GetType().Name });
        }
        if (turns.Count > 0) turns[^1] = turns[^1] with { analysis = analysis };
      }
      var after = Blockers(d);
      var checkpoints = ReadCheckpoints(d);
      foreach (var st in before.Except(after.Select(b => b.step)).OrderBy(x => x))
        checkpoints.Add(new InterviewCheckpoint(DateTime.UtcNow, "Step " + st + " ready: " + StepLabel(st)));
      d.Step = after.Count == 0 ? 4 : after.Min(b => b.step);
      d.InterviewJson = JsonSerializer.Serialize(new { turns, checkpoints });
      d.UpdatedAt = DateTime.UtcNow;
      return Results.Ok(new { question, analysis, applied, fields = FieldStates(d), blockers = after, checkpoints, turns, done = after.Count == 0 });
    });
    app.MapPost("/api/wizard/{id:guid}/create", (InMemoryStore s, Guid id) =>
    {
      if (!s.WizardDrafts.TryGetValue(id, out var d)) return Results.NotFound("wizard draft");
      var blockers = Blockers(d);
      if (blockers.Count > 0) return Results.Json(new { blockers }, statusCode: 409);
      var f = ReadFields(d);
      var board = new Board { Id = Guid.NewGuid(), Name = f.Name, Mission = f.Mission, Stage = f.Stage, CreatedAt = DateTime.UtcNow };
      s.Boards[board.Id] = board;
      var (saved, leadError, leadStatus) = LeadSetup.SaveLead(s, Guid.Empty, new LeadProfile
      {
        BoardId = board.Id, Name = f.LeadName, RoleLabel = f.LeadRole, Background = f.LeadBackground,
        FamiliarTopics = f.LeadFamiliar, SimplerTopics = f.LeadSimpler, CommPrefs = f.LeadComm,
      });
      if (saved is null) return Results.Json(new { error = leadError }, statusCode: leadStatus);
      var created = new List<object>();
      foreach (var seat in f.Advisors.Take(10))
      {
        if (string.IsNullOrWhiteSpace(seat.Role)) continue;
        var seatName = string.IsNullOrWhiteSpace(seat.Name) ? seat.Role.Trim() : seat.Name.Trim();
        var entry = new RosterEntry
        {
          Id = Guid.NewGuid(), AccountId = d.AccountId, Type = AdvisorType.FictionalCharacter,
          Name = seatName, Description = seat.Role.Trim() + " helping with: " + f.Mission,
          ProfileJson = RosterOps.CharacterJson(seatName, seat.Role.Trim(), f.Mission),
          Version = 1, UpdatedAt = DateTime.UtcNow,
        };
        s.Roster[entry.Id] = entry;
        var (copy, copyError, copyStatus) = RosterOps.TryCopy(s, entry.Id, board.Id, seat.Role.Trim());
        if (copy is null) return Results.Json(new { error = copyError }, statusCode: copyStatus);
        created.Add(new { advisor = copy.Id, role = copy.BoardRole });
      }
      s.Audit.Add(new AuditEvent { BoardId = board.Id, Action = "wizard.create", Detail = JsonSerializer.Serialize(new { board = board.Id, advisors = created.Count }) });
      return Results.Created("/api/boards/" + board.Id, new { board, advisors = created });
    });
  }

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
    var norm = JsonSerializer.Serialize(new { turns = ReadTurns(d), checkpoints = ReadCheckpoints(d) });
    if (!string.Equals(norm, d.InterviewJson, StringComparison.Ordinal)) d.InterviewJson = norm;
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
