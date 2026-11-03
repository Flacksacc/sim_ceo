using System.Collections.Concurrent;
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
      Atomic.Run(() => { s.Advisors[copy.Id] = copy; s.Advisors.Flush(); });
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

  // Lane A: live research jobs distinguish actual running work from persisted
  // orphaned ResearchJobId after restart. Orphans are retryable, never permanent 409.
  private static readonly ConcurrentDictionary<string, bool> LiveResearchJobs = new();

  public static bool IsLiveResearchJob(string jobId) =>
    !string.IsNullOrEmpty(jobId) && LiveResearchJobs.ContainsKey(jobId);

  public static void MarkLiveResearchJob(string jobId)
  {
    if (!string.IsNullOrEmpty(jobId)) LiveResearchJobs[jobId] = true;
  }

  public static void ClearLiveResearchJob(string jobId)
  {
    if (!string.IsNullOrEmpty(jobId)) LiveResearchJobs.TryRemove(jobId, out _);
  }

  public static bool IsPortraitAccepted(AdvisorImage img) =>
    img.Review == "accepted" || img.Review == "grandfathered";

  // Exact selected portrait identity: actual provenance selection first, then
  // linked rows. A full-ID provenance match within the same roster scope wins
  // even when several images link to this advisor (legacy double-link rows).
  // Legacy truncated 8-char prefixes resolve only when they match exactly one
  // same-roster image. An ambiguous or unresolvable explicit selection is
  // rejected (null) rather than rescued by an arbitrary accepted upload.
  // With no explicit provenance a single linked row wins, while conflicting
  // links resolve to null instead of guessing the newest upload.
  public static AdvisorImage? ResolveSelectedImage(InMemoryStore s, BoardAdvisor a)
  {
    if (!string.IsNullOrWhiteSpace(a.ImageProvenance) && a.ImageProvenance != "initials")
    {
      foreach (var part in a.ImageProvenance.Split((char)58))
      {
        var trimmed = part.Trim();
        if (Guid.TryParse(trimmed, out var gid)
            && s.Images.TryGetValue(gid, out var byId)
            && byId.RosterEntryId == a.RosterEntryId)
          return byId;
      }
      foreach (var part in a.ImageProvenance.Split((char)58))
      {
        var trimmed = part.Trim();
        if (trimmed.Length == 8 && trimmed.All(char.IsAsciiHexDigit))
        {
          var matches = s.Images.Values
            .Where(i => i.RosterEntryId == a.RosterEntryId
              && i.Id.ToString("D").StartsWith(trimmed, StringComparison.OrdinalIgnoreCase))
            .ToList();
          if (matches.Count == 1) return matches[0];
          return null; // zero or ambiguous legacy prefix: reject, never guess
        }
      }
      return null; // explicit selection that resolves to nothing: invalid
    }
    var linked = s.Images.Values.Where(i => i.BoardAdvisorId == a.Id).ToList();
    if (linked.Count == 1) return linked[0];
    return null; // none, or conflicting links: never guess newest upload
  }

  public static bool HasExplicitPortraitSelection(BoardAdvisor a) =>
    !string.IsNullOrWhiteSpace(a.ImageProvenance) && a.ImageProvenance != "initials";

  // Exact identity/state for activation hashing: selected image wins; legacy
  // no-selection falls back to a deterministic accepted image; explicit
  // invalid selections stay distinct so they cannot be rescued.
  public static string ReviewedPortraitFingerprint(InMemoryStore s, BoardAdvisor a)
  {
    var sel = ResolveSelectedImage(s, a);
    if (sel is not null)
      return "portrait:" + sel.Id + ":review:" + sel.Review + ":prov:" + sel.Provenance + ":kind:" + sel.Kind;
    if (HasExplicitPortraitSelection(a))
      return "portrait:invalid:" + a.ImageProvenance;
    var legacy = s.Images.Values
      .Where(i => i.RosterEntryId == a.RosterEntryId && IsPortraitAccepted(i))
      .OrderBy(i => i.CreatedAt).ThenBy(i => i.Id)
      .FirstOrDefault();
    if (legacy is not null)
      return "legacy:" + legacy.Id + ":review:" + legacy.Review + ":prov:" + legacy.Provenance + ":kind:" + legacy.Kind;
    return "portrait:none";
  }

  // Shared reviewed-input boundary for discussion/activation: roster identity,
  // version, profile hash, subject, research job/state, archive flag, plus the
  // resolved portrait identity. Capture before the model call and compare at
  // commit to detect edits/sync/review races. Does not itself force Approved.
  public static string ReviewedInputFingerprint(InMemoryStore s, BoardAdvisor a)
  {
    if (!s.Roster.TryGetValue(a.RosterEntryId, out var rent) || rent is null)
      return "missing:" + a.RosterEntryId + ":" + a.RosterVersion + ":portrait:[" + ReviewedPortraitFingerprint(s, a) + "]";
    string profileHash;
    try { profileHash = Hashing.HashOf(rent.ProfileJson ?? "{}"); }
    catch { profileHash = "hash-error"; }
    var subject = rent.Name + " (" + rent.Type + ")";
    var researchedAt = rent.ResearchedAt.HasValue ? rent.ResearchedAt.Value.ToString("o") : "null";
    var portraitFp = ReviewedPortraitFingerprint(s, a);
    return "roster:" + rent.Id + ":v:" + rent.Version + ":profile:" + profileHash + ":subject:" + subject + ":job:" + rent.ResearchJobId + ":base:" + rent.ResearchBaseVersion + ":req:" + rent.ResearchRequested + ":at:" + researchedAt + ":ev:" + rent.EvidenceCount + ":arch:" + rent.Archived + ":portrait:[" + portraitFp + "]";
  }

  // Approval binds to the reviewed portrait/profile: an explicitly accepted
  // portrait (Review == "accepted" or grandfathered) is required for the exact
  // selected image. Legacy/empty reviews are pending, never implicitly accepted.
  // Explicit invitation compatibility is preserved: this gate does not itself
  // force the Approved boolean; lane B enforces approval unless explicitly invited.
  public static string? ApprovalGate(InMemoryStore s, BoardAdvisor a)
  {
    if (a.Removed) return "removed";
    if (!s.Roster.TryGetValue(a.RosterEntryId, out var rent) || rent.Archived) return "archived-entry";
    if (a.RosterVersion != rent.Version) return "stale-version";
    if (rent.ResearchRequested && rent.ResearchedAt is null) return "research-pending";
    if (rent.ResearchRequested && rent.EvidenceCount < 1) return "no-evidence";
    var sel = ResolveSelectedImage(s, a);
    if (sel is not null)
    {
      if (sel.RosterEntryId != a.RosterEntryId) return "portrait-pending";
      if (!IsPortraitAccepted(sel)) return "portrait-pending";
      return null;
    }
    if (HasExplicitPortraitSelection(a)) return "portrait-pending";
    var legacy = s.Images.Values
      .Where(i => i.RosterEntryId == a.RosterEntryId && IsPortraitAccepted(i))
      .OrderBy(i => i.CreatedAt).ThenBy(i => i.Id)
      .FirstOrDefault();
    if (legacy is null) return "portrait-pending";
    return null;
  }

  // Server-controlled owner identity: creator identity is set server-side.
  // Legacy ownerless templates require BOARD-scoped management on linked boards
  // (all linked boards, since the template affects each). Meeting-scoped grants
  // and management on unrelated boards never permit writes. Demo owner preserved.
  // An ownerless template with no linked boards has no appropriate board scope:
  // non-owner writes are denied even with an unrelated management grant.
  public static bool CanWriteRoster(InMemoryStore s, HttpRequest req, RosterEntry entry)
  {
    if (PeopleOps.HasInvalidToken(s, req)) return false;
    if (PeopleOps.IsOwner(req)) return true;
    var user = PeopleOps.UserOf(s, req);
    if (!string.IsNullOrWhiteSpace(entry.OwnerKey))
      return string.Equals(entry.OwnerKey, user, StringComparison.OrdinalIgnoreCase);
    var linked = s.Advisors.Values
      .Where(a => a.RosterEntryId == entry.Id && !a.Removed)
      .Select(a => a.BoardId).Distinct().ToList();
    if (linked.Count > 0)
    {
      foreach (var bid in linked)
      {
        var okBid = s.Grants.Values.Any(g => string.Equals(g.UserKey, user, StringComparison.OrdinalIgnoreCase)
          && g.BoardId == bid
          && (g.Access == "manage" || g.Access == "open")
          && g.MeetingId == null);
        if (!okBid) return false;
      }
      return true;
    }
    return false;
  }

  // Editing profile content invalidates the old dossier: support, timestamps
  // and counts reset and board copies unapprove until research reruns.
  // Preserves ResearchRequested=true so failed/started research still blocks approval.
  public static void InvalidateDossier(InMemoryStore s, RosterEntry entry)
  {
    entry.ResearchJson = "{}";
    entry.ResearchedAt = null;
    entry.EvidenceCount = 0;
    entry.ResearchJobId = "";
    entry.ResearchBaseVersion = entry.Version;
    UnapproveBoardCopies(s, entry.Id);
  }

  public static void UnapproveBoardCopies(InMemoryStore s, Guid rosterId)
  {
    foreach (var a in s.Advisors.Values.Where(a => a.RosterEntryId == rosterId && !a.Removed && a.Approved).ToList())
    {
      a.Approved = false;
      s.Advisors[a.Id] = a;
    }
    s.Advisors.Flush();
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
      if (PeopleOps.BadToken(s, req) is { } badCopy) return badCopy;
      if (!PeopleOps.Can(s, req, boardId, null, "manage")) return PeopleOps.Denied();
      var role = body.TryGetProperty("boardRole", out var r) ? (r.GetString() ?? "") : "";
      var (copy, error, status) = RosterOps.TryCopy(s, id, boardId, role);
      return copy is not null ? Results.Created($"/api/boards/{boardId}/advisors/{copy.Id}", copy)
        : Results.Json(new { error }, statusCode: status);
    });

    app.MapPut("/api/roster/{id:guid}", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badPut) return badPut;
      if (!s.Roster.TryGetValue(id, out var probe) || probe.Archived) return Results.NotFound();
      if (!RosterOps.CanWriteRoster(s, req, probe)) return PeopleOps.Denied();
      string? newName = null;
      var nameProvided = false;
      if (body.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(n.GetString()))
      {
        newName = n.GetString()!.Trim();
        nameProvided = true;
      }
      string? newDesc = null;
      var descProvided = false;
      if (body.TryGetProperty("description", out var d) && d.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(d.GetString()))
      {
        newDesc = d.GetString()!.Trim();
        descProvided = true;
      }
      string? newProfile = null;
      var profileProvided = false;
      if (body.TryGetProperty("profileJson", out var pp) && pp.ValueKind == JsonValueKind.String)
      {
        var pj = pp.GetString() ?? "";
        if (pj.Trim().Length < 20) return Results.BadRequest("Profile must be at least 20 characters.");
        newProfile = pj;
        profileProvided = true;
      }
      string? newTags = null;
      var tagsProvided = false;
      if (body.TryGetProperty("tags", out var tt) && tt.ValueKind == JsonValueKind.String)
      {
        newTags = tt.GetString() ?? "";
        tagsProvided = true;
      }
      lock (s.SetupLock)
      {
        if (!s.Roster.TryGetValue(id, out var entry) || entry.Archived) return Results.NotFound();
        if (!RosterOps.CanWriteRoster(s, req, entry)) return PeopleOps.Denied();
        var profileChanged = false;
        if (nameProvided && newName != entry.Name) profileChanged = true;
        if (descProvided && newDesc != entry.Description) profileChanged = true;
        if (profileProvided && newProfile != entry.ProfileJson) profileChanged = true;
        RosterEntry applied = entry;
        Atomic.Run(() =>
        {
          if (nameProvided) entry.Name = newName!;
          if (descProvided) entry.Description = newDesc!;
          if (profileProvided) entry.ProfileJson = newProfile!;
          if (tagsProvided) entry.Tags = newTags!;
          entry.Version += 1;
          entry.UpdatedAt = DateTime.UtcNow;
          if (profileChanged) RosterOps.InvalidateDossier(s, entry);
          else RosterOps.UnapproveBoardCopies(s, id);
          s.Roster[entry.Id] = entry;
          s.Roster.Flush();
          applied = entry;
        });
        s.Audit.Add(new AuditEvent { Action = "roster.edit", Detail = JsonSerializer.Serialize(new { entry = applied.Id, version = applied.Version }) });
        return Results.Ok(applied);
      }
    });    app.MapPost("/api/roster/{id:guid}/archive", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badArch) return badArch;
      if (!s.Roster.TryGetValue(id, out var probeArch)) return Results.NotFound();
      if (!RosterOps.CanWriteRoster(s, req, probeArch)) return PeopleOps.Denied();
      var archived = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("archived", out var aa)
        ? aa.GetBoolean() : true;
      lock (s.SetupLock)
      {
        if (!s.Roster.TryGetValue(id, out var entry)) return Results.NotFound();
        if (!RosterOps.CanWriteRoster(s, req, entry)) return PeopleOps.Denied();
        RosterEntry saved = entry;
        Atomic.Run(() =>
        {
          entry.Archived = archived;
          entry.UpdatedAt = DateTime.UtcNow;
          RosterOps.UnapproveBoardCopies(s, id);
          s.Roster[entry.Id] = entry;
          s.Roster.Flush();
          saved = entry;
        });
        return Results.Ok(saved);
      }
    });

    app.MapPost("/api/boards/{bid:guid}/advisors/{aid:guid}/sync-roster", (InMemoryStore s, HttpRequest req, Guid bid, Guid aid) =>
    {
      if (!PeopleOps.Can(s, req, bid, null, "manage")) return PeopleOps.Denied();
      if (!s.Advisors.TryGetValue(aid, out var probeSync) || probeSync.BoardId != bid || probeSync.Removed) return Results.NotFound();
      if (!s.Roster.TryGetValue(probeSync.RosterEntryId, out var probeEntry)) return Results.NotFound("roster entry");
      lock (s.SetupLock)
      {
        if (!s.Advisors.TryGetValue(aid, out var a) || a.BoardId != bid || a.Removed) return Results.NotFound();
        if (!s.Roster.TryGetValue(a.RosterEntryId, out var entry)) return Results.NotFound("roster entry");
        var ver = entry.Version;
        Atomic.Run(() =>
        {
          a.RosterVersion = ver;
          a.Approved = false;
          s.Advisors[a.Id] = a;
          s.Advisors.Flush();
        });
        s.Audit.Add(new AuditEvent { BoardId = bid, Action = "roster.sync", Detail = JsonSerializer.Serialize(new { advisor = aid, version = ver, reapproval = true }) });
        return Results.Ok(a);
      }
    });

    app.MapPost("/api/roster/character", (InMemoryStore s, HttpRequest req, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badChar) return badChar;
      var accountId = body.TryGetProperty("accountId", out var ac) && Guid.TryParse(ac.GetString(), out var ag) ? ag : Guid.Empty;
      var role = body.TryGetProperty("role", out var r) ? (r.GetString() ?? "") : "";
      var problem = body.TryGetProperty("problem", out var p) ? (p.GetString() ?? "") : "";
      var name = body.TryGetProperty("name", out var n) ? (n.GetString() ?? "Unnamed character") : "Unnamed character";
      if (string.IsNullOrWhiteSpace(role) || string.IsNullOrWhiteSpace(problem))
        return Results.BadRequest("role and problem are required; the rest is generated as a draft.");
      var entry = new RosterEntry
      {
        Id = Guid.NewGuid(), AccountId = accountId, OwnerKey = PeopleOps.UserOf(s, req), Type = AdvisorType.FictionalCharacter,
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

    app.MapPost("/api/roster/quick", (InMemoryStore s, HttpRequest req, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badQuick) return badQuick;
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
        Id = Guid.NewGuid(), AccountId = accountId, OwnerKey = PeopleOps.UserOf(s, req), Type = AdvisorType.FictionalCharacter,
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
      if (PeopleOps.BadToken(s, req) is { } badAi) return badAi;
      if (PeopleOps.Guard(gw, req) is { } cappedAi) return cappedAi;
      var accountId = body.TryGetProperty("accountId", out var aac) && Guid.TryParse(aac.GetString(), out var aag) ? aag : Guid.Empty;
      var name = body.TryGetProperty("name", out var aan) ? (aan.GetString() ?? "") : "";
      var role = body.TryGetProperty("role", out var aar) ? (aar.GetString() ?? "") : "";
      var focus = body.TryGetProperty("focus", out var aaf) ? (aaf.GetString() ?? "") : "";
      if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(role))
        return Results.BadRequest("name and role are required; focus steers the research.");
      ModelGateway.GroundedResult dossier;
      try
      {
        dossier = await gw.CompleteGroundedAsync(ModelPolicy.SparkFor(s, null), "advisor-research",
        "Research this fictional advisor persona for a business advisory board. Name: " + name + ". Role: " + role + ". Focus: " + focus + ". Return concise factual-style guidance: what such an advisor should know, typical methods, key risks they watch, and limits. One claim per line.",
        ContextBudget.BidTokens, 2048, ownerOverride: PeopleOps.IsOwner(req));
      }
      catch (Exception ex) when (ex is CapExceededException or ProviderException or TaskCanceledException or HttpRequestException or JsonException) { return PeopleOps.ModelError(ex); }
      string profile;
      try
      {
        profile = await gw.CompleteAsync(ModelPolicy.SparkFor(s, null), "advisor-profile",
          "Draft a fictional advisor profile as ONLY a JSON object (no code fences, no commentary) with keys: background, strengths (array of 3), methods (array of 3), evidenceNeeded (array), limits (array of 3), collaboration (string). Persona: " + name + ", " + role + ", focus: " + focus + ". Research notes: " + dossier.Text + ". State that the advisor is fictional with no real employment, degrees, licenses, or endorsements.",
          ContextBudget.BidTokens, 2048, ownerOverride: PeopleOps.IsOwner(req));
      }
      catch (Exception ex) when (ex is CapExceededException or ProviderException or TaskCanceledException or HttpRequestException or JsonException) { return PeopleOps.ModelError(ex); }
      profile = profile.Trim();
      if (profile.StartsWith("```"))
      {
        var pnl = profile.IndexOf("\n");
        var pend = profile.LastIndexOf("```");
        if (pnl >= 0 && pend > pnl) profile = profile.Substring(pnl + 1, pend - pnl - 1).Trim();
      }
      var draftRefs = dossier.Citations.Where(c => !string.IsNullOrWhiteSpace(c.Url)).Take(10)
        .Select(c => new { kind = "source", @ref = c.Url, url = c.Url, title = c.Title, excerpt = c.Excerpt }).ToList();
      var draftClaims = dossier.Text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Take(12)
        .Select(line => new { angle = "dossier", text = line, sources = dossier.Citations.Take(3).Select(c => new { url = c.Url, title = c.Title }).ToList(), refs = draftRefs }).ToList<object>();
      foreach (var c in dossier.Citations.Take(6).Where(c => !string.IsNullOrWhiteSpace(c.Excerpt)))
        draftClaims.Add(new { angle = "dossier [citation]", text = c.Excerpt, sources = new[] { new { url = c.Url, title = c.Title } }.ToList(), refs = new[] { new { kind = "source", @ref = c.Url, url = c.Url, title = c.Title, excerpt = c.Excerpt } }.ToList() });
      var entry = new RosterEntry
      {
        Id = Guid.NewGuid(), AccountId = accountId, OwnerKey = PeopleOps.UserOf(s, req), Type = AdvisorType.FictionalCharacter,
        Name = name.Trim(),
        Description = role.Trim() + " persona for: " + (string.IsNullOrWhiteSpace(focus) ? "general advisory" : focus.Trim()),
        ProfileJson = profile,
        ResearchJson = JsonSerializer.Serialize(new
        {
          subject = name.Trim() + " (" + role.Trim() + ")",
          searched = dossier.SearchCalls,
          supported = dossier.RanSearch && draftClaims.Count > 0 && dossier.Citations.Any(c => !string.IsNullOrWhiteSpace(c.Url) && !string.IsNullOrWhiteSpace(c.Excerpt)),
          claims = draftClaims,
          responseIds = dossier.ResponseId is null ? new List<string>() : new List<string> { dossier.ResponseId },
          version = 1,
          evidenceRefs = draftRefs,
          note = (dossier.RanSearch && dossier.Citations.Any(c => !string.IsNullOrWhiteSpace(c.Excerpt)))
            ? "Snippet-level claims need cross-checking against independent sources before approval."
            : "No completed grounded evidence: treat every claim above as unsupported, not verified research.",
        }),
        ResearchedAt = DateTime.UtcNow,
        ResearchRequested = true,
        EvidenceCount = dossier.Citations.Count(c => !string.IsNullOrWhiteSpace(c.Url) && !string.IsNullOrWhiteSpace(c.Excerpt)),
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
      catch (Exception ex) when (ex is CapExceededException or ProviderException or TaskCanceledException or HttpRequestException or JsonException) { return PeopleOps.ModelError(ex); }
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
      if (PeopleOps.BadToken(s, req) is { } badRes) return badRes;
      if (!s.Roster.TryGetValue(id, out var preRes) || preRes.Archived) return Results.NotFound();
      if (!RosterOps.CanWriteRoster(s, req, preRes)) return PeopleOps.Denied();
      if (PeopleOps.Guard(gw, req) is { } capped) return capped;
      if (body.ValueKind != JsonValueKind.Object)
        return Results.BadRequest("Invalid research request body.");
      string focus;
      if (body.TryGetProperty("focus", out var ffe))
      {
        if (ffe.ValueKind == JsonValueKind.Null || ffe.ValueKind == JsonValueKind.Undefined)
          focus = "";
        else if (ffe.ValueKind != JsonValueKind.String)
          return Results.BadRequest("focus must be a string.");
        else
          focus = ffe.GetString() ?? "";
      }
      else
      {
        focus = "";
      }
      string jobId = "";
      int baseVersion;
      string startSubject;
      lock (s.SetupLock)
      {
        if (!s.Roster.TryGetValue(id, out var entry) || entry.Archived) return Results.NotFound();
        if (!RosterOps.CanWriteRoster(s, req, entry)) return PeopleOps.Denied();
        if (entry.ResearchRequested && entry.ResearchedAt is null && !string.IsNullOrEmpty(entry.ResearchJobId))
        {
          if (RosterOps.IsLiveResearchJob(entry.ResearchJobId))
            return Results.Conflict("Research is already running for this advisor; wait for it to finish.");
        }
        jobId = Guid.NewGuid().ToString("N");
        baseVersion = entry.Version;
        startSubject = entry.Name + " (" + entry.Type + ")";
        Atomic.Run(() =>
        {
          entry.ResearchRequested = true;
          entry.ResearchedAt = null;
          entry.EvidenceCount = 0;
          entry.ResearchJson = "{}";
          entry.ResearchJobId = jobId;
          entry.ResearchBaseVersion = baseVersion;
          entry.UpdatedAt = DateTime.UtcNow;
          RosterOps.UnapproveBoardCopies(s, id);
          s.Roster[entry.Id] = entry;
          s.Roster.Flush();
        });
        RosterOps.MarkLiveResearchJob(jobId);
      }
      try
      {
      var subject = startSubject;
      var focusTag = string.IsNullOrWhiteSpace(focus) ? "" : " Focus: " + focus + ".";
      var angles = new[] { "identity of " + subject + "." + focusTag, "relevant work of " + subject + "." + focusTag, "limitations and criticism of " + subject + "." + focusTag };
      var claims = new List<object>();
      var responseIds = new List<string>();
      var searched = 0;
      var citedUrls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      var citedExcerpts = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      try
      {
        foreach (var angle in angles)
        {
          var g = await gw.CompleteGroundedAsync(ModelPolicy.SparkStandard, "advisor-research",
            "Advisor dossier research. " + angle + ". Return concise factual claims only, one per line.",
            4000, 2048, ownerOverride: PeopleOps.IsOwner(req));
          if (g.ResponseId is not null) responseIds.Add(g.ResponseId);
          if (g.RanSearch) searched++;
          foreach (var cite in g.Citations.Where(c => !string.IsNullOrWhiteSpace(c.Url)))
          {
            citedUrls.Add(cite.Url);
            if (!string.IsNullOrWhiteSpace(cite.Excerpt))
              citedExcerpts[cite.Url] = cite.Excerpt;
          }
          var claimRefs = g.Citations.Take(3).Select(c => new EvidenceRef("source", c.Url, null, c.Url, c.Title, c.Excerpt)).ToList()
            .Select(r => new { kind = r.Kind, @ref = r.Ref, url = r.Url, title = r.Title, excerpt = r.Excerpt }).ToList();
          foreach (var line in g.Text.Split((char)10, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Take(12))
            claims.Add(new { angle, text = line, sources = g.Citations.Take(3).Select(c => new { url = c.Url, title = c.Title }).ToList(), refs = claimRefs });
          foreach (var c in g.Citations.Take(6).Where(c => !string.IsNullOrWhiteSpace(c.Excerpt)))
            claims.Add(new { angle = angle + " [citation]", text = c.Excerpt, sources = new[] { new { url = c.Url, title = c.Title } }.ToList(), refs = new[] { new { kind = "source", @ref = c.Url, url = c.Url, title = c.Title, excerpt = c.Excerpt } }.ToList() });
        }
      }
      catch (Exception ex) when (ex is CapExceededException or ProviderException or TaskCanceledException or HttpRequestException or JsonException)
      {
        lock (s.SetupLock)
        {
          Atomic.Run(() =>
          {
            if (s.Roster.TryGetValue(id, out var failed) && failed.ResearchJobId == jobId)
            {
              failed.ResearchJobId = "";
              failed.ResearchRequested = true;
              failed.ResearchedAt = null;
              failed.EvidenceCount = 0;
              failed.ResearchJson = "{}";
              failed.UpdatedAt = DateTime.UtcNow;
              RosterOps.UnapproveBoardCopies(s, id);
              s.Roster[failed.Id] = failed;
              s.Roster.Flush();
            }
          });
          RosterOps.ClearLiveResearchJob(jobId);
        }
        return PeopleOps.ModelError(ex);
      }
      object dossier;
      lock (s.SetupLock)
      {
        if (!s.Roster.TryGetValue(id, out var cur) || cur.Archived)
        {
          RosterOps.ClearLiveResearchJob(jobId);
          return Results.NotFound();
        }
        if (cur.ResearchJobId != jobId)
        {
          RosterOps.ClearLiveResearchJob(jobId);
          return Results.Conflict("A newer research request superseded this run; use its result.");
        }
        if (cur.Version != baseVersion)
        {
          Atomic.Run(() =>
          {
            if (cur.ResearchJobId == jobId)
            {
              cur.ResearchJobId = "";
              cur.ResearchRequested = true;
              cur.UpdatedAt = DateTime.UtcNow;
              s.Roster[cur.Id] = cur;
              s.Roster.Flush();
            }
          });
          RosterOps.ClearLiveResearchJob(jobId);
          return Results.Conflict("Advisor profile changed during research; rerun research on the new version.");
        }
        var built = new
        {
          subject,
          searched,
          supported = searched > 0 && claims.Count > 0 && citedExcerpts.Count > 0,
          claims,
          responseIds,
          version = baseVersion,
          evidenceRefs = citedUrls.Select(u => new { kind = "source", @ref = u, url = u, excerpt = citedExcerpts.TryGetValue(u, out var exu) ? exu : "" }).ToList(),
          note = (searched == 0 || citedExcerpts.Count == 0)
            ? "No completed grounded evidence: treat every claim above as unsupported, not verified research."
            : "Snippet-level claims need cross-checking against independent sources before approval.",
        };
        Atomic.Run(() =>
        {
          cur.ResearchJson = JsonSerializer.Serialize(built);
          cur.ResearchedAt = DateTime.UtcNow;
          cur.EvidenceCount = citedExcerpts.Count;
          cur.ResearchJobId = "";
          cur.ResearchRequested = true;
          cur.Version += 1;
          cur.UpdatedAt = DateTime.UtcNow;
          RosterOps.UnapproveBoardCopies(s, id);
          s.Roster[cur.Id] = cur;
          s.Roster.Flush();
        });
        dossier = built;
      }
      return Results.Ok(dossier);
      }
      finally
      {
        RosterOps.ClearLiveResearchJob(jobId);
      }
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
      catch (Exception ex) when (ex is ProviderException or TaskCanceledException or HttpRequestException or JsonException) { return PeopleOps.ProviderError(ex is ProviderException pex ? pex : new ProviderException(502, ex.Message)); }
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

    app.MapPost("/api/roster/{id:guid}/image/upload", async (InMemoryStore s, HttpRequest req, Guid id, IFormFile file) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badUp) return badUp;
      if (!s.Roster.TryGetValue(id, out var upEntry) || upEntry.Archived) return Results.NotFound();
      if (!RosterOps.CanWriteRoster(s, req, upEntry)) return PeopleOps.Denied();
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
      RosterOps.UnapproveBoardCopies(s, id);
      return Results.Created($"/api/images/{img.Id}", new { img.Id, img.Kind, img.Provenance });
    }).DisableAntiforgery(); // token-less API: no cookie auth to forge against

    app.MapPost("/api/roster/{id:guid}/image/url", async (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badUrl) return badUrl;
      if (!s.Roster.TryGetValue(id, out var urlEntry) || urlEntry.Archived) return Results.NotFound();
      if (!RosterOps.CanWriteRoster(s, req, urlEntry)) return PeopleOps.Denied();
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
        RosterOps.UnapproveBoardCopies(s, id);
        return Results.Created($"/api/images/{img.Id}", new { img.Id, img.Kind, img.Provenance });
      }
      catch (Exception ex)
      {
        return Results.Json(new { error = $"Fetch failed: {ex.Message}" }, statusCode: 502);
      }
    });

    app.MapPost("/api/roster/{id:guid}/image/generate", async (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badGen) return badGen;
      if (!s.Roster.TryGetValue(id, out var entry)) return Results.NotFound();
      if (!RosterOps.CanWriteRoster(s, req, entry)) return PeopleOps.Denied();
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
      if (created.Count > 0) RosterOps.UnapproveBoardCopies(s, id);
      return Results.Ok(created);
    });

    app.MapGet("/api/roster/{id:guid}/images", (InMemoryStore s, Guid id) =>
      Results.Ok(s.Images.Values.Where(i => i.RosterEntryId == id)
        .Select(i => new { i.Id, i.Kind, i.Provenance, i.ContentType, i.Review, i.CreatedAt }).OrderByDescending(i => i.CreatedAt)));

    app.MapDelete("/api/images/{imgId:guid}", (InMemoryStore s, HttpRequest req, Guid imgId) =>
    {
      if (!s.Images.TryGetValue(imgId, out var img)) return Results.NotFound();
      if (PeopleOps.BadToken(s, req) is { } badDel) return badDel;
      RosterEntry? delEntry = img.RosterEntryId.HasValue && s.Roster.TryGetValue(img.RosterEntryId.Value, out var delRe) ? delRe : null;
      var boardId = Guid.Empty;
      if (img.BoardAdvisorId.HasValue && s.Advisors.TryGetValue(img.BoardAdvisorId.Value, out var adv))
        boardId = adv.BoardId;
      else if (delEntry is not null)
        boardId = s.Advisors.Values.FirstOrDefault(a => a.RosterEntryId == delEntry.Id && !a.Removed)?.BoardId ?? Guid.Empty;
      // Shared-image scope: a roster-linked image mutates every board copy
      // (review state + UnapproveBoardCopies), so roster-linked images require
      // the full roster-write boundary even when the caller manages one linked
      // board. Board-manage suffices only for board-local images with no roster
      // entry. Preserves owner-owned templates (owner passes CanWriteRoster)
      // and legacy ownerless all-linked-manage via that same boundary.
      var delAllowed = delEntry is not null
        ? RosterOps.CanWriteRoster(s, req, delEntry)
        : (boardId != Guid.Empty && PeopleOps.Can(s, req, boardId, null, "manage"));
      if (!delAllowed) return PeopleOps.Denied();
      s.Images.TryRemove(imgId, out _);
      if (img.RosterEntryId.HasValue) RosterOps.UnapproveBoardCopies(s, img.RosterEntryId.Value);
      return Results.NoContent();
    });

    app.MapPost("/api/images/{imgId:guid}/select", (InMemoryStore s, HttpRequest req, Guid imgId, JsonElement body) =>
    {
      if (!s.Images.TryGetValue(imgId, out var probeImg)) return Results.NotFound();
      var advisorId = body.TryGetProperty("boardAdvisorId", out var aa) ? aa.GetGuid() : (Guid?)null;
      if (advisorId is null || !s.Advisors.TryGetValue(advisorId.Value, out var probeAdv)) return Results.BadRequest("boardAdvisorId is required.");
      if (!PeopleOps.Can(s, req, probeAdv.BoardId, null, "manage")) return PeopleOps.Denied();
      if (!probeImg.RosterEntryId.HasValue || probeImg.RosterEntryId.Value != probeAdv.RosterEntryId)
        return Results.BadRequest("Image does not belong to this advisor roster entry.");
      lock (s.SetupLock)
      {
        if (!s.Images.TryGetValue(imgId, out var img)) return Results.NotFound();
        if (!s.Advisors.TryGetValue(advisorId.Value, out var adv)) return Results.BadRequest("boardAdvisorId is required.");
        if (!PeopleOps.Can(s, req, adv.BoardId, null, "manage")) return PeopleOps.Denied();
        if (!img.RosterEntryId.HasValue || img.RosterEntryId.Value != adv.RosterEntryId)
          return Results.BadRequest("Image does not belong to this advisor roster entry.");
        BoardAdvisor savedAdv = adv;
        Atomic.Run(() =>
        {
          foreach (var other in s.Images.Values.Where(i => i.BoardAdvisorId == adv.Id && i.Id != img.Id).ToList())
          {
            other.BoardAdvisorId = null;
            s.Images[other.Id] = other;
          }
          // Per-board selection only: record identity (link + provenance) and
          // require re-approval of this copy, but never mutate the shared
          // global Review. A pending/rejected image stays pending/rejected, so
          // approval remains blocked until an explicit review accept with the
          // full roster-write scope. Only explicit review accept changes Review.
          img.BoardAdvisorId = adv.Id;
          s.Images[img.Id] = img;
          adv.Approved = false;
          adv.ImageProvenance = img.Kind + ":" + img.Id.ToString();
          s.Images.Flush();
          s.Advisors[adv.Id] = adv;
          s.Advisors.Flush();
          savedAdv = adv;
        });
        s.Audit.Add(new AuditEvent { BoardId = savedAdv.BoardId, Action = "image.select", Detail = JsonSerializer.Serialize(new { imgId, advisor = advisorId }) });
        return Results.Ok(savedAdv);
      }
    });

    app.MapPost("/api/images/{imgId:guid}/review", (InMemoryStore s, HttpRequest req, Guid imgId, JsonElement body) =>
    {
      if (!s.Images.TryGetValue(imgId, out var probeRev)) return Results.NotFound();
      if (PeopleOps.BadToken(s, req) is { } badRevProbe) return badRevProbe;
      var decProbe = body.TryGetProperty("decision", out var dvp) ? (dvp.GetString() ?? "") : "";
      if (decProbe != "accept" && decProbe != "retry") return Results.BadRequest("decision must be accept or retry.");
      Guid? rbBoardProbe = null;
      if (probeRev.BoardAdvisorId.HasValue && s.Advisors.TryGetValue(probeRev.BoardAdvisorId.Value, out var rbAdvProbe)) rbBoardProbe = rbAdvProbe.BoardId;
      else if (probeRev.RosterEntryId.HasValue && s.Roster.TryGetValue(probeRev.RosterEntryId.Value, out var rbEntryProbe)) rbBoardProbe = s.Advisors.Values.FirstOrDefault(a => a.RosterEntryId == rbEntryProbe.Id && !a.Removed)?.BoardId;
      RosterEntry? revEntryProbe = probeRev.RosterEntryId.HasValue && s.Roster.TryGetValue(probeRev.RosterEntryId.Value, out var revReProbe) ? revReProbe : null;
      // Shared-review scope: same full roster-write boundary as delete.
      // A roster-linked image rejection unapproves copies on every board, so
      // single-board manage must not suffice. Board-manage fallback covers
      // only board-local images with no roster entry.
      var revAllowedProbe = revEntryProbe is not null
        ? RosterOps.CanWriteRoster(s, req, revEntryProbe)
        : (rbBoardProbe.HasValue && PeopleOps.Can(s, req, rbBoardProbe.Value, null, "manage"));
      if (!revAllowedProbe) return PeopleOps.Denied();
      lock (s.SetupLock)
      {
        if (!s.Images.TryGetValue(imgId, out var imgr)) return Results.NotFound();
        if (PeopleOps.BadToken(s, req) is { } badRev) return badRev;
        var dec = body.TryGetProperty("decision", out var dv) ? (dv.GetString() ?? "") : "";
        if (dec != "accept" && dec != "retry") return Results.BadRequest("decision must be accept or retry.");
        Guid? rbBoard = null;
        if (imgr.BoardAdvisorId.HasValue && s.Advisors.TryGetValue(imgr.BoardAdvisorId.Value, out var rbAdv)) rbBoard = rbAdv.BoardId;
        else if (imgr.RosterEntryId.HasValue && s.Roster.TryGetValue(imgr.RosterEntryId.Value, out var rbEntry)) rbBoard = s.Advisors.Values.FirstOrDefault(a => a.RosterEntryId == rbEntry.Id && !a.Removed)?.BoardId;
        RosterEntry? revEntry = imgr.RosterEntryId.HasValue && s.Roster.TryGetValue(imgr.RosterEntryId.Value, out var revRe) ? revRe : null;
        // Shared-review scope (in-lock recheck): roster-linked images require
        // the full roster-write boundary; board-manage covers only
        // board-local images with no roster entry.
        var revAllowed = revEntry is not null
          ? RosterOps.CanWriteRoster(s, req, revEntry)
          : (rbBoard.HasValue && PeopleOps.Can(s, req, rbBoard.Value, null, "manage"));
        if (!revAllowed) return PeopleOps.Denied();
        AdvisorImage savedImg = imgr;
        Atomic.Run(() =>
        {
          imgr.Review = dec == "accept" ? "accepted" : "rejected";
          s.Images[imgr.Id] = imgr;
          if (revEntry is not null) RosterOps.UnapproveBoardCopies(s, revEntry.Id);
          if (imgr.BoardAdvisorId.HasValue && s.Advisors.TryGetValue(imgr.BoardAdvisorId.Value, out var revAdv))
          {
            revAdv.Approved = false;
            s.Advisors[revAdv.Id] = revAdv;
          }
          s.Advisors.Flush();
          s.Images.Flush();
          savedImg = imgr;
        });
        Guid? rb = null;
        if (savedImg.BoardAdvisorId.HasValue && s.Advisors.TryGetValue(savedImg.BoardAdvisorId.Value, out var rba)) rb = rba.BoardId;
        else if (savedImg.RosterEntryId.HasValue && s.Roster.TryGetValue(savedImg.RosterEntryId.Value, out var rre)) rb = s.Advisors.Values.FirstOrDefault(a => a.RosterEntryId == rre.Id && !a.Removed)?.BoardId;
        s.Audit.Add(new AuditEvent { BoardId = rb, Action = "image.review", Detail = JsonSerializer.Serialize(new { imgId, decision = dec }) });
        return Results.Ok(savedImg);
      }
    });

    app.MapGet("/api/images/{imgId:guid}", (InMemoryStore s, Guid imgId) =>
      !s.Images.TryGetValue(imgId, out var img) || img.Data is null ? Results.NotFound()
      : Results.Bytes(img.Data, img.ContentType));
  }
}
