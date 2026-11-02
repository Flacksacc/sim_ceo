using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

namespace SimCEO.Api;

// Advisor Roster: unlimited account templates, board chips derived live from
// board copies, copy-to-board under the 10-seat cap, archive, character
// drafts, isolated auditions (never meeting messages), and explicit images.
public static class RosterOps
{
  public static object BoardsFor(InMemoryStore s, Guid rosterId) =>
    s.Advisors.Values.Where(a => a.RosterEntryId == rosterId && !a.Removed)
      .Select(a => new
      {
        boardId = a.BoardId,
        board = s.Boards.TryGetValue(a.BoardId, out var b) ? b.Name : "?",
        role = a.BoardRole,
        approved = a.Approved,
      }).ToList();

  public static (BoardAdvisor? advisor, string? error, int status) TryCopy(
    InMemoryStore s, Guid rosterId, Guid boardId, string role)
  {
    if (!s.Roster.TryGetValue(rosterId, out var entry) || entry.Archived)
      return (null, "Roster entry not found.", 404);
    if (!s.Boards.ContainsKey(boardId)) return (null, "Board not found.", 404);
    lock (s.SetupLock)
    {
      if (s.Advisors.Values.Any(a => a.BoardId == boardId && a.RosterEntryId == rosterId && !a.Removed))
        return (null, "Advisor already attached to this board.", 409);
      var (dok, dmissing) = RosterOps.Completeness(s, rosterId);
      if (!dok)
        return (null, "Roster entry is incomplete: " + string.Join(", ", dmissing) + ".", 409);
      if (s.Advisors.Values.Count(a => a.BoardId == boardId && !a.Removed) >= 10)
        return (null, "Board already has 10 advisors. Remove an advisor to add another.", 409);
      var copy = new BoardAdvisor
      {
        Id = Guid.NewGuid(), BoardId = boardId, RosterEntryId = rosterId,
        RosterVersion = entry.Version,
        BoardRole = string.IsNullOrWhiteSpace(role) ? entry.Name : role.Trim(),
        CreatedAt = DateTime.UtcNow,
      };
      s.Advisors[copy.Id] = copy;
      s.Audit.Add(new AuditEvent
      {
        BoardId = boardId, Action = "roster.copy",
        Detail = JsonSerializer.Serialize(new { rosterId, version = entry.Version, copy = copy.Id }),
      });
      return (copy, null, 200);
    }
  }

  public static (bool complete, List<string> missing) DataCompleteness(InMemoryStore s, Guid rosterId)
  {
    var missing = new List<string>();
    if (!s.Roster.TryGetValue(rosterId, out var de) || de.Archived)
      return (false, new List<string> { "roster entry not found" });
    if (string.IsNullOrWhiteSpace(de.Name)) missing.Add("name");
    if (string.IsNullOrWhiteSpace(de.Description)) missing.Add("description");
    var dpj = (de.ProfileJson ?? "").Trim();
    if (dpj.Length < 20) missing.Add("profile");
    if (de.ResearchRequested && de.ResearchedAt is null) missing.Add("research in progress");
    return (missing.Count == 0, missing);
  }

  public static (bool complete, List<string> missing) Completeness(InMemoryStore s, Guid rosterId)
  {
    var missing = new List<string>();
    if (!s.Roster.TryGetValue(rosterId, out var entry) || entry.Archived)
      return (false, new List<string> { "roster entry not found" });
    if (string.IsNullOrWhiteSpace(entry.Name)) missing.Add("name");
    if (string.IsNullOrWhiteSpace(entry.Description)) missing.Add("description");
    var pj = (entry.ProfileJson ?? "").Trim();
    if (pj.Length < 20) missing.Add("profile");
    if (entry.ResearchRequested && entry.ResearchedAt is null) missing.Add("research in progress");
    if (!s.Images.Values.Any(i => i.RosterEntryId == rosterId)) missing.Add("portrait");
    return (missing.Count == 0, missing);
  }

  public static string CharacterJson(string name, string role, string problem) =>
    JsonSerializer.Serialize(new
    {
      fictional = true,
      name, role, problem,
      background = $"Fictional {role} created for advisory discussion. No real employment, degrees, licenses, publications, or endorsements are claimed.",
      strengths = new[] { $"{role} methods", "practical tradeoffs", "risk surfacing" },
      canHandle = new[] { problem },
      methods = new[] { "structured comparison", "assumption check", "next-step proposal" },
      evidenceNeeded = new[] { "approved board sources", "board-lead brief" },
      limits = new[] { "defers outside specialty", "abstains without evidence", "never overrides board instructions" },
      challengeTriggers = new[] { "unsupported premise", "missing risk" },
      collaboration = "direct, concise, cites evidence",
      capability = new
      {
        lead = new[] { role },
        contribute = new[] { "options", "risks" },
        defer = new[] { "final decisions", "unrelated specialties" },
      },
    });
}

public static class RosterEndpoints
{
  private static readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(10) };

  public static void MapRoster(this WebApplication app)
  {
    var gw = new ModelGateway(app.Services.GetRequiredService<InMemoryStore>());

    app.MapGet("/api/roster/{id:guid}/boards", (InMemoryStore s, Guid id) =>
      !s.Roster.ContainsKey(id) ? Results.NotFound() : Results.Ok(RosterOps.BoardsFor(s, id)));

    app.MapPost("/api/roster/{id:guid}/copy", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      var boardId = body.TryGetProperty("boardId", out var b) ? b.GetGuid() : Guid.Empty;
      if (!PeopleOps.Can(s, req, boardId, null, "manage")) return PeopleOps.Denied();
      var role = body.TryGetProperty("boardRole", out var r) ? (r.GetString() ?? "") : "";
      var (copy, error, status) = RosterOps.TryCopy(s, id, boardId, role);
      return copy is not null ? Results.Created($"/api/boards/{boardId}/advisors/{copy.Id}", copy)
        : Results.Json(new { error }, statusCode: status);
    });

    app.MapPut("/api/roster/{id:guid}", (InMemoryStore s, Guid id, JsonElement body) =>
    {
      if (!s.Roster.TryGetValue(id, out var entry) || entry.Archived) return Results.NotFound();
      if (body.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(n.GetString()))
        entry.Name = n.GetString()!.Trim();
      if (body.TryGetProperty("description", out var d) && d.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(d.GetString()))
        entry.Description = d.GetString()!.Trim();
      if (body.TryGetProperty("profileJson", out var p) && p.ValueKind == JsonValueKind.String)
      {
        var pj = p.GetString() ?? "";
        if (pj.Trim().Length < 20) return Results.BadRequest("Profile must be at least 20 characters.");
        entry.ProfileJson = pj;
      }
      if (body.TryGetProperty("tags", out var t) && t.ValueKind == JsonValueKind.String)
        entry.Tags = t.GetString() ?? "";
      entry.Version += 1;
      entry.UpdatedAt = DateTime.UtcNow;
      s.Audit.Add(new AuditEvent { Action = "roster.edit", Detail = JsonSerializer.Serialize(new { entry = entry.Id, version = entry.Version }) });
      return Results.Ok(entry);
    });
    app.MapPost("/api/roster/{id:guid}/archive", (InMemoryStore s, Guid id, JsonElement body) =>
    {
      if (!s.Roster.TryGetValue(id, out var entry)) return Results.NotFound();
      var archived = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("archived", out var a)
        ? a.GetBoolean() : true;
      entry.Archived = archived;
      entry.UpdatedAt = DateTime.UtcNow;
      return Results.Ok(entry);
    });

    app.MapPost("/api/boards/{bid:guid}/advisors/{aid:guid}/sync-roster", (InMemoryStore s, HttpRequest req, Guid bid, Guid aid) =>
    {
      if (!PeopleOps.Can(s, req, bid, null, "manage")) return PeopleOps.Denied();
      if (!s.Advisors.TryGetValue(aid, out var a) || a.BoardId != bid || a.Removed) return Results.NotFound();
      if (!s.Roster.TryGetValue(a.RosterEntryId, out var entry)) return Results.NotFound("roster entry");
      a.RosterVersion = entry.Version;
      s.Audit.Add(new AuditEvent { BoardId = bid, Action = "roster.sync", Detail = JsonSerializer.Serialize(new { advisor = aid, version = entry.Version }) });
      return Results.Ok(a);
    });

    app.MapPost("/api/roster/character", (InMemoryStore s, JsonElement body) =>
    {
      var accountId = body.TryGetProperty("accountId", out var ac) && Guid.TryParse(ac.GetString(), out var ag) ? ag : Guid.Empty;
      var role = body.TryGetProperty("role", out var r) ? (r.GetString() ?? "") : "";
      var problem = body.TryGetProperty("problem", out var p) ? (p.GetString() ?? "") : "";
      var name = body.TryGetProperty("name", out var n) ? (n.GetString() ?? "Unnamed character") : "Unnamed character";
      if (string.IsNullOrWhiteSpace(role) || string.IsNullOrWhiteSpace(problem))
        return Results.BadRequest("role and problem are required; the rest is generated as a draft.");
      var entry = new RosterEntry
      {
        Id = Guid.NewGuid(), AccountId = accountId, Type = AdvisorType.FictionalCharacter,
        Name = name,
        Description = body.TryGetProperty("description", out var dd) && !string.IsNullOrWhiteSpace(dd.GetString()) ? dd.GetString()! : role + " helping with: " + problem,
        ProfileJson = body.TryGetProperty("profileJson", out var pj) && pj.GetRawText().Trim().Length >= 20 ? pj.GetRawText() : RosterOps.CharacterJson(name, role, problem),
        Version = 1, UpdatedAt = DateTime.UtcNow,
      };
      if (body.TryGetProperty("tags", out var t)) entry.Tags = t.GetString() ?? "";
      s.Roster[entry.Id] = entry;
      return Results.Created($"/api/roster/{entry.Id}", entry);
    });

    app.MapGet("/api/roster/{id:guid}/completeness", (InMemoryStore s, Guid id) =>
    {
      if (!s.Roster.ContainsKey(id)) return Results.NotFound();
      var (ok, missing) = RosterOps.Completeness(s, id);
      return Results.Ok(new { complete = ok, missing, imageCount = s.Images.Values.Count(i => i.RosterEntryId == id) });
    });

    app.MapPost("/api/roster/quick", (InMemoryStore s, JsonElement body) =>
    {
      var accountId = body.TryGetProperty("accountId", out var qac) && Guid.TryParse(qac.GetString(), out var qag) ? qag : Guid.Empty;
      var name = body.TryGetProperty("name", out var qan) ? (qan.GetString() ?? "") : "";
      var desc = body.TryGetProperty("description", out var qad) ? (qad.GetString() ?? "") : "";
      if (string.IsNullOrWhiteSpace(name)) return Results.BadRequest("Name is required.");
      if (string.IsNullOrWhiteSpace(desc) || desc.Trim().Length < 5) return Results.BadRequest("Description is required (a sentence or more).");
      var profile = JsonSerializer.Serialize(new
      {
        fictional = true,
        name = name.Trim(),
        background = desc.Trim(),
        strengths = new[] { "practical tradeoffs", "risk surfacing", "structured comparison" },
        methods = new[] { "assumption check", "options comparison", "next-step proposal" },
        evidenceNeeded = new[] { "approved board sources", "board-lead brief" },
        limits = new[] { "defers outside specialty", "abstains without evidence", "never overrides board instructions", "never claims real employment, degrees, licenses, endorsements" },
        collaboration = "direct, concise, cites evidence",
      });
      var entry = new RosterEntry
      {
        Id = Guid.NewGuid(), AccountId = accountId, Type = AdvisorType.FictionalCharacter,
        Name = name.Trim(), Description = desc.Trim(), ProfileJson = profile,
        Version = 1, UpdatedAt = DateTime.UtcNow,
      };
      if (body.TryGetProperty("tags", out var qtg)) entry.Tags = qtg.GetString() ?? "";
      s.Roster[entry.Id] = entry;
      s.Audit.Add(new AuditEvent { Action = "roster.quick", Detail = JsonSerializer.Serialize(new { entry = entry.Id, name }) });
      return Results.Created($"/api/roster/{entry.Id}", entry);
    });

    app.MapPost("/api/roster/ai-draft", async (InMemoryStore s, HttpRequest req, JsonElement body) =>
    {
      if (PeopleOps.Guard(gw, req) is { } cappedAi) return cappedAi;
      var accountId = body.TryGetProperty("accountId", out var aac) && Guid.TryParse(aac.GetString(), out var aag) ? aag : Guid.Empty;
      var name = body.TryGetProperty("name", out var aan) ? (aan.GetString() ?? "") : "";
      var role = body.TryGetProperty("role", out var aar) ? (aar.GetString() ?? "") : "";
      var focus = body.TryGetProperty("focus", out var aaf) ? (aaf.GetString() ?? "") : "";
      if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(role))
        return Results.BadRequest("name and role are required; focus steers the research.");
      var dossier = await gw.CompleteGroundedAsync(ModelPolicy.SparkFor(s, null), "advisor-research",
        "Research this fictional advisor persona for a business advisory board. Name: " + name + ". Role: " + role + ". Focus: " + focus + ". Return concise factual-style guidance: what such an advisor should know, typical methods, key risks they watch, and limits. One claim per line.",
        ContextBudget.BidTokens, 2048, ownerOverride: PeopleOps.IsOwner(req));
      string profile;
      try
      {
        profile = await gw.CompleteAsync(ModelPolicy.SparkFor(s, null), "advisor-profile",
          "Draft a fictional advisor profile as ONLY a JSON object (no code fences, no commentary) with keys: background, strengths (array of 3), methods (array of 3), evidenceNeeded (array), limits (array of 3), collaboration (string). Persona: " + name + ", " + role + ", focus: " + focus + ". Research notes: " + dossier.Text + ". State that the advisor is fictional with no real employment, degrees, licenses, or endorsements.",
          ContextBudget.BidTokens, 2048, ownerOverride: PeopleOps.IsOwner(req));
      }
      catch (Exception ex) when (ex is CapExceededException or ProviderException) { return PeopleOps.ModelError(ex); }
      profile = profile.Trim();
      if (profile.StartsWith("```"))
      {
        var pnl = profile.IndexOf("\n");
        var pend = profile.LastIndexOf("```");
        if (pnl >= 0 && pend > pnl) profile = profile.Substring(pnl + 1, pend - pnl - 1).Trim();
      }
      var entry = new RosterEntry
      {
        Id = Guid.NewGuid(), AccountId = accountId, Type = AdvisorType.FictionalCharacter,
        Name = name.Trim(),
        Description = role.Trim() + " persona for: " + (string.IsNullOrWhiteSpace(focus) ? "general advisory" : focus.Trim()),
        ProfileJson = profile,
        ResearchJson = JsonSerializer.Serialize(new { dossier.Text, dossier.Citations, dossier.ResponseId }),
        ResearchedAt = DateTime.UtcNow,
        ResearchRequested = true,
        EvidenceCount = dossier.Citations.Count,
        Version = 1, UpdatedAt = DateTime.UtcNow,
      };
      s.Roster[entry.Id] = entry;
      s.Audit.Add(new AuditEvent { Action = "roster.ai-draft", Detail = JsonSerializer.Serialize(new { entry = entry.Id, name, role, searches = dossier.SearchCalls }) });
      return Results.Created("/api/roster/" + entry.Id, new { entry, researched = dossier.RanSearch, citations = dossier.Citations.Count, note = "Draft created. Add a portrait to complete this advisor." });
    });

    app.MapPost("/api/boards/{bid:guid}/advisors/{aid:guid}/chat", async (InMemoryStore s, HttpRequest req, Guid bid, Guid aid, JsonElement body) =>
    {
      if (!s.Advisors.TryGetValue(aid, out var adv) || adv.BoardId != bid || adv.Removed) return Results.NotFound("advisor");
      if (!s.Boards.TryGetValue(bid, out var board)) return Results.NotFound("board");
      if (!PeopleOps.Can(s, req, bid, null, "read")) return PeopleOps.Denied();
      if (PeopleOps.Guard(gw, req) is { } cappedChat) return cappedChat;
      var message = body.TryGetProperty("message", out var cm) ? (cm.GetString() ?? "") : "";
      if (string.IsNullOrWhiteSpace(message)) return Results.BadRequest("message is required.");
      if (message.Length > 4000) return Results.BadRequest("message exceeds 4000 chars.");
      string profile = "{}";
      string advisorName = adv.BoardRole;
      if (s.Roster.TryGetValue(adv.RosterEntryId, out var rent)) { profile = rent.ProfileJson; advisorName = rent.Name; }
      var historyText = "";
      if (body.TryGetProperty("history", out var ch) && ch.ValueKind == JsonValueKind.Array)
      {
        var turns = new List<string>();
        foreach (var te in ch.EnumerateArray())
        {
          if (te.ValueKind != JsonValueKind.Object) continue;
          var rr = te.TryGetProperty("role", out var rrv) ? (rrv.GetString() ?? "") : "";
          var cc = te.TryGetProperty("content", out var ccv) ? (ccv.GetString() ?? "") : "";
          if (string.IsNullOrWhiteSpace(cc)) continue;
          var ccut = cc.Length > 800 ? cc[..800] : cc;
          turns.Add($"{rr}: {ccut}");
          if (turns.Count >= 10) break;
        }
        if (turns.Count > 0) historyText = "Conversation so far:\n" + string.Join("\n", turns.TakeLast(10)) + "\n";
      }
      string answer;
      try
      {
        var prompt = $"DIRECT ADVISOR CHAT (isolated, not a meeting message). You are {advisorName}, serving as {adv.BoardRole} (fictional advisor). Board: {board.Name} | Mission: {board.Mission} | Stage: {board.Stage}. Profile: {profile}. {historyText}Lead says: {message}\nReply in character, concise, with personality for {adv.BoardRole}; flag missing evidence, stay within specialty, never claim real employment, degrees, licenses, or endorsements.";
        answer = await gw.CompleteAsync(ModelPolicy.SparkFor(s, bid), "advisor-chat",
          prompt, ContextBudget.BidTokens, 2048, ownerOverride: PeopleOps.IsOwner(req), boardId: bid);
      }
      catch (Exception ex) when (ex is CapExceededException or ProviderException) { return PeopleOps.ModelError(ex); }
      return Results.Ok(new
      {
        answer,
        indicators = new
        {
          expertiseUsed = adv.BoardRole,
          assumptions = new[] { "advisor profile + board mission only; no meeting history" },
          sources = new[] { "none: direct chat uses only owner-entered board info" },
          withinLimits = true,
        },
        stored = false,
        note = "Direct advisor chat is isolated; never creates meeting messages, records, or agent memory.",
      });
    });

    app.MapPost("/api/roster/{id:guid}/research", async (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Roster.TryGetValue(id, out var entry) || entry.Archived) return Results.NotFound();
      if (PeopleOps.Guard(gw, req) is { } capped) return capped;
      entry.ResearchRequested = true; entry.ResearchedAt = null; entry.EvidenceCount = 0; entry.UpdatedAt = DateTime.UtcNow;
      var focus = body.TryGetProperty("focus", out var f) ? (f.GetString() ?? "") : "";
      var subject = $"{entry.Name} ({entry.Type})";
      var angles = new[] { $"identity of {subject}", $"relevant work of {subject}", $"limitations and criticism of {subject}" };
      if (!string.IsNullOrWhiteSpace(focus)) angles[1] = $"{focus}: {subject}";
      var claims = new List<object>();
      var responseIds = new List<string>();
      var searched = 0;
      try
      {
        foreach (var angle in angles)
        {
          var g = await gw.CompleteGroundedAsync(ModelPolicy.SparkStandard, "advisor-research",
            $"Advisor dossier research. {angle}. Return concise factual claims only, one per line.",
            4000, 1024, ownerOverride: PeopleOps.IsOwner(req));
          if (g.ResponseId is not null) responseIds.Add(g.ResponseId);
          if (g.RanSearch) searched++;
          foreach (var line in g.Text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Take(12))
            claims.Add(new { angle, text = line, sources = g.Citations.Take(3).Select(c => new { c.Url, c.Title }).ToList() });
          foreach (var c in g.Citations.Take(6).Where(c => !string.IsNullOrWhiteSpace(c.Excerpt)))
            claims.Add(new { angle = angle + " [citation]", text = c.Excerpt, sources = new[] { new { c.Url, c.Title } }.ToList() });
        }
      }
      catch (Exception ex) when (ex is CapExceededException or ProviderException) { return PeopleOps.ModelError(ex); }
      var dossier = new
      {
        subject,
        searched,
        supported = searched > 0,
        claims,
        responseIds,
        note = searched == 0
          ? "No web search ran: treat every claim above as unsupported, not verified research."
          : "Snippet-level claims need cross-checking against independent sources before approval.",
      };
      entry.ResearchJson = JsonSerializer.Serialize(dossier);
      entry.ResearchedAt = DateTime.UtcNow;
      entry.EvidenceCount = claims.Count;
      entry.UpdatedAt = DateTime.UtcNow;
      return Results.Ok(dossier);
    });

    app.MapGet("/api/roster/{id:guid}/research", (InMemoryStore s, Guid id) =>
      !s.Roster.TryGetValue(id, out var entry) ? Results.NotFound()
      : Results.Ok(new { entry.ResearchJson, entry.ResearchedAt }));

    app.MapPost("/api/auditions", async (InMemoryStore s, HttpRequest req, JsonElement body) =>
    {
      if (PeopleOps.Guard(gw, req) is { } cappedAu) return cappedAu;
      var question = body.TryGetProperty("question", out var q) ? (q.GetString() ?? "") : "";
      if (string.IsNullOrWhiteSpace(question)) return Results.BadRequest("question is required.");
      string profile = body.TryGetProperty("profileJson", out var pj) ? pj.GetRawText() : "{}";
      if (body.TryGetProperty("rosterId", out var ri) && ri.GetGuid() is Guid rid
          && s.Roster.TryGetValue(rid, out var entry))
        profile = entry.ProfileJson;
      var boardInfo = body.TryGetProperty("boardInfo", out var bi) ? (bi.GetString() ?? "") : "";
      string answer;
      try
      {
        answer = await gw.CompleteAsync(ModelPolicy.SparkStandard, "audition",
          $"AUDITION (isolated, not a meeting message). Profile: {profile}. Board info: {boardInfo}. Question: {question}",
          ContextBudget.BidTokens, 2048, ownerOverride: PeopleOps.IsOwner(req));
      }
      catch (ProviderException ex) { return PeopleOps.ProviderError(ex); }
      return Results.Ok(new
      {
        answer,
        indicators = new
        {
          expertiseUsed = "draft capability card",
          assumptions = new[] { "draft profile only; no meeting history" },
          sources = new[] { "none: auditions use only owner-entered board info" },
          withinLimits = true,
        },
        stored = false,
        note = "Auditions never create meeting messages, records, or agent memory.",
      });
    });

    app.MapPost("/api/roster/{id:guid}/image/upload", async (InMemoryStore s, Guid id, IFormFile file) =>
    {
      if (!s.Roster.ContainsKey(id)) return Results.NotFound();
      if (file is null || file.Length == 0) return Results.BadRequest("No file.");
      if (file.Length > 5 * 1024 * 1024) return Results.BadRequest("Image exceeds 5 MB.");
      var ct = file.ContentType ?? "";
      if (!ct.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
        return Results.BadRequest("Only image uploads are accepted.");
      using var ms = new MemoryStream();
      await file.CopyToAsync(ms);
      var img = new AdvisorImage
      {
        RosterEntryId = id, Kind = "upload",
        Review = "pending",
        Provenance = $"upload:{file.FileName}", ContentType = ct, Data = ms.ToArray(),
      };
      s.Images[img.Id] = img;
      return Results.Created($"/api/images/{img.Id}", new { img.Id, img.Kind, img.Provenance });
    }).DisableAntiforgery(); // token-less API: no cookie auth to forge against

    app.MapPost("/api/roster/{id:guid}/image/url", async (InMemoryStore s, Guid id, JsonElement body) =>
    {
      if (!s.Roster.ContainsKey(id)) return Results.NotFound();
      var url = body.TryGetProperty("url", out var u) ? (u.GetString() ?? "") : "";
      var source = body.TryGetProperty("source", out var sn) ? (sn.GetString() ?? "") : "";
      if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)
          || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        return Results.BadRequest("A public http(s) image URL is required.");
      try
      {
        using var res = await _http.GetAsync(uri);
        if (!res.IsSuccessStatusCode) return Results.Json(new { error = $"Fetch failed: {(int)res.StatusCode}." }, statusCode: 502);
        var ct = res.Content.Headers.ContentType?.MediaType ?? "";
        if (!ct.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
          return Results.Json(new { error = "URL did not return an image." }, statusCode: 502);
        var bytes = await res.Content.ReadAsByteArrayAsync();
        if (bytes.Length > 5 * 1024 * 1024)
          return Results.Json(new { error = "Image exceeds 5 MB." }, statusCode: 502);
        var img = new AdvisorImage
        {
          RosterEntryId = id, Kind = "url",
        Review = "pending",
          Provenance = $"url:{url} source:{source}", ContentType = ct, Data = bytes,
        };
        s.Images[img.Id] = img;
        return Results.Created($"/api/images/{img.Id}", new { img.Id, img.Kind, img.Provenance });
      }
      catch (Exception ex)
      {
        return Results.Json(new { error = $"Fetch failed: {ex.Message}" }, statusCode: 502);
      }
    });

    app.MapPost("/api/roster/{id:guid}/image/generate", async (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Roster.TryGetValue(id, out var entry)) return Results.NotFound();
      var count = body.TryGetProperty("count", out var c) ? c.GetInt32() : 0;
      if (count is not (1 or 2 or 4))
        return Results.BadRequest("Choose Generate 1, 2, or 4 options with an explicit click.");
      if (PeopleOps.Guard(gw, req) is { } capped) return capped;
      var prompt = body.TryGetProperty("prompt", out var p) && !string.IsNullOrWhiteSpace(p.GetString())
        ? p.GetString()!
        : $"Professional portrait of a fictional advisor: {entry.Name}. {entry.ProfileJson[..Math.Min(500, entry.ProfileJson.Length)]}. Must not resemble any real person.";
      List<byte[]> images;
      try
      {
        images = await gw.GenerateImagesAsync(prompt, count, ownerOverride: PeopleOps.IsOwner(req));
      }
      catch (ProviderException ex) { return PeopleOps.ProviderError(ex); }
      var created = new List<object>();
      foreach (var bytes in images)
      {
        var img = new AdvisorImage
        {
          RosterEntryId = id, Kind = "generated",
        Review = "pending",
          Provenance = $"generated:muse-image prompt:{prompt[..Math.Min(120, prompt.Length)]}",
          ContentType = "image/png", Data = bytes,
        };
        s.Images[img.Id] = img;
        created.Add(new { img.Id, img.Kind, img.Provenance });
      }
      s.Usage.Add(new UsageRow { Kind = "image-generate", Model = ModelPolicy.Image, InputTokens = 0, Note = $"{created.Count} options; unselected previews carry no retention promise" });
      return Results.Ok(created);
    });

    app.MapGet("/api/roster/{id:guid}/images", (InMemoryStore s, Guid id) =>
      Results.Ok(s.Images.Values.Where(i => i.RosterEntryId == id)
        .Select(i => new { i.Id, i.Kind, i.Provenance, i.ContentType, i.Review, i.CreatedAt }).OrderByDescending(i => i.CreatedAt)));

    app.MapDelete("/api/images/{imgId:guid}", (InMemoryStore s, HttpRequest req, Guid imgId) =>
    {
      if (!s.Images.TryGetValue(imgId, out var img)) return Results.NotFound();
      var boardId = Guid.Empty;
      if (img.BoardAdvisorId.HasValue && s.Advisors.TryGetValue(img.BoardAdvisorId.Value, out var adv))
        boardId = adv.BoardId;
      else if (img.RosterEntryId.HasValue && s.Roster.TryGetValue(img.RosterEntryId.Value, out var entry))
        boardId = s.Advisors.Values.FirstOrDefault(a => a.RosterEntryId == entry.Id && !a.Removed)?.BoardId ?? Guid.Empty;
      if (boardId != Guid.Empty && !PeopleOps.Can(s, req, boardId, null, "contribute")) return PeopleOps.Denied();
      s.Images.TryRemove(imgId, out _);
      return Results.NoContent();
    });

    app.MapPost("/api/images/{imgId:guid}/select", (InMemoryStore s, HttpRequest req, Guid imgId, JsonElement body) =>
    {
      if (!s.Images.TryGetValue(imgId, out var img)) return Results.NotFound();
      var advisorId = body.TryGetProperty("boardAdvisorId", out var a) ? a.GetGuid() : (Guid?)null;
      if (advisorId is null || !s.Advisors.TryGetValue(advisorId.Value, out var adv)) return Results.BadRequest("boardAdvisorId is required.");
      if (!PeopleOps.Can(s, req, adv.BoardId, null, "manage")) return PeopleOps.Denied();
      img.BoardAdvisorId = advisorId;
      img.Review = "accepted";
      adv.ImageProvenance = $"{img.Kind}:{imgId.ToString()[..8]}";
      s.Audit.Add(new AuditEvent { BoardId = adv.BoardId, Action = "image.select", Detail = JsonSerializer.Serialize(new { imgId, advisor = advisorId }) });
      return Results.Ok(adv);
    });

    app.MapPost("/api/images/{imgId:guid}/review", (InMemoryStore s, HttpRequest req, Guid imgId, JsonElement body) =>
    {
      if (!s.Images.TryGetValue(imgId, out var imgr)) return Results.NotFound();
      var dec = body.TryGetProperty("decision", out var dv) ? (dv.GetString() ?? "") : "";
      if (dec != "accept" && dec != "retry") return Results.BadRequest("decision must be accept or retry.");
      imgr.Review = dec == "accept" ? "accepted" : "rejected";
      Guid? rb = null;
      if (imgr.BoardAdvisorId.HasValue && s.Advisors.TryGetValue(imgr.BoardAdvisorId.Value, out var rba)) rb = rba.BoardId;
      else if (imgr.RosterEntryId.HasValue && s.Roster.TryGetValue(imgr.RosterEntryId.Value, out var rre)) rb = s.Advisors.Values.FirstOrDefault(a => a.RosterEntryId == rre.Id && !a.Removed)?.BoardId;
      s.Audit.Add(new AuditEvent { BoardId = rb, Action = "image.review", Detail = JsonSerializer.Serialize(new { imgId, decision = dec }) });
      return Results.Ok(imgr);
    });

    app.MapGet("/api/images/{imgId:guid}", (InMemoryStore s, Guid imgId) =>
      !s.Images.TryGetValue(imgId, out var img) || img.Data is null ? Results.NotFound()
      : Results.Bytes(img.Data, img.ContentType));
  }
}
