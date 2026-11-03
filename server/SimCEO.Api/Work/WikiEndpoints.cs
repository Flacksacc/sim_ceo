using System.Text.Json;
using System.Text.Json.Nodes;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

namespace SimCEO.Api;

// Phase7 Wiki.js 2.x read-only connector endpoints. Manager-only configure /
// enable / disable / sync / delete at the actual destination; meeting-only
// grants cannot manage board resources. Public DTOs expose HasCredential only;
// the token never appears in responses, logs, or backups. URI change clears
// the credential and disables the resource until reconfiguration.
public static class WikiEndpoints
{
  private static object ShapeResource(InMemoryStore s, WikiResource r)
  {
    SourceGovernance.EnsureMigratedAll(s);
    var docs = s.Sources.Values.Count(x => x.BoardId == r.BoardId && x.ResourceId == r.Id);
    int eligible = 0;
    foreach (var d in s.Sources.Values.Where(x => x.BoardId == r.BoardId && x.ResourceId == r.Id).ToList())
      try { if (SourceGovernance.IsEligible(s, d, d.Scope == "meeting" ? d.MeetingId : null)) eligible++; } catch { }
    List<string> allow, excl, tags;
    try { allow = WikiRules.ParseList(r.AllowlistJson); excl = WikiRules.ParseList(r.ExclusionsJson); tags = WikiRules.ParseList(r.RequiredTagsJson); }
    catch { allow = new(); excl = new(); tags = new(); }
    List<string> members;
    try { members = JsonSerializer.Deserialize<List<string>>(string.IsNullOrWhiteSpace(r.SuccessPagesJson) ? "[]" : r.SuccessPagesJson) ?? new(); }
    catch { members = new(); }
    return new
    {
      r.Id, r.BoardId, scope = r.Scope, meetingId = r.MeetingId, baseUrl = r.BaseUrl, r.Description,
      allowedUse = r.AllowedUse ?? "", setupUse = r.SetupUse, manualOnly = r.ManualOnly,
      allowlist = allow, exclusions = excl, requiredTags = tags, locale = r.Locale,
      r.Enabled, configRevision = r.ConfigRevision, attemptGeneration = r.AttemptGeneration, attemptStatus = r.AttemptStatus ?? "idle",
      syncIntervalMinutes = r.SyncIntervalMinutes,
      nextSyncAt = r.NextSyncAt, status = r.LastStatus, lastError = r.LastError,
      lastCompletedAt = r.LastCompletedAt, lastSuccessRevision = r.LastSuccessRevision,
      lastSuccessAt = r.LastSuccessAt, usablePages = eligible,
      importedPages = docs, sourceDocs = docs, eligibleDocs = eligible, hasCredential = r.HasCredential,
      protocol = "wikijs-2.x-graphql-readonly",
      r.CreatedAt, r.UpdatedAt,
    };
  }

  private sealed record ValidatedInput(bool Ok, string? Error, int Status, Guid BoardId, string Scope, Guid? MeetingId,
    string Origin, List<string> Allow, List<string> Excl, List<string> Tags, string Locale, int Interval,
    string Description, string AllowedUse, bool SetupUse, bool ManualOnly);

  private static ValidatedInput ValidateInput(InMemoryStore s, JsonElement body, WikiResource? existing)
  {
    List<string> Empty() => new();
    var boardId = existing?.BoardId ?? Guid.Empty;
    if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("boardId", out var b) && b.ValueKind == JsonValueKind.String && Guid.TryParse(b.GetString(), out var bg)) boardId = bg;
    if (boardId == Guid.Empty) return new(false, "boardId is required.", 400, boardId, "board", null, "", Empty(), Empty(), Empty(), "", 60, "", "", false, false);
    if (!s.Boards.TryGetValue(boardId, out _)) return new(false, "Board not found.", 404, boardId, "board", null, "", Empty(), Empty(), Empty(), "", 60, "", "", false, false);
    // Scope: distinguish omitted (keep existing/default board) from explicit board/meeting.
    string scope;
    JsonElement scEl = default; bool scopeExplicit = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("scope", out scEl) && scEl.ValueKind == JsonValueKind.String;
    if (scopeExplicit)
    {
      var sv = (scEl.GetString() ?? "").Trim().ToLowerInvariant();
      if (sv != "board" && sv != "meeting") return new(false, "scope must be board or meeting.", 400, boardId, "board", null, "", Empty(), Empty(), Empty(), "", 60, "", "", false, false);
      scope = sv;
    }
    else if (existing is not null) scope = existing.Scope == "meeting" ? "meeting" : "board";
    else scope = "board";
    Guid? meeting = scope == "meeting" ? existing?.MeetingId : null;
    JsonElement mi = default; bool meetingExplicit = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("meetingId", out mi);
    if (meetingExplicit)
    {
      if (mi.ValueKind == JsonValueKind.String && Guid.TryParse(mi.GetString(), out var mg)) meeting = mg;
      else if (mi.ValueKind == JsonValueKind.Null) meeting = null;
      else return new(false, "meetingId must be a GUID string or null.", 400, boardId, scope, meeting, "", Empty(), Empty(), Empty(), "", 60, "", "", false, false);
    }
    else if (scope == "board") meeting = null;
    if (scope == "meeting")
    {
      if (!meeting.HasValue) return new(false, "meetingId is required for meeting scope; pick a meeting instead of defaulting to board.", 400, boardId, scope, meeting, "", Empty(), Empty(), Empty(), "", 60, "", "", false, false);
      if (!s.Meetings.TryGetValue(meeting.Value, out var mtg) || mtg.BoardId != boardId)
        return new(false, "Meeting does not belong to this board.", 409, boardId, scope, meeting, "", Empty(), Empty(), Empty(), "", 60, "", "", false, false);
    }
    else meeting = null;
    var rawUrl = existing?.BaseUrl ?? "";
    if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("baseUrl", out var u) && u.ValueKind == JsonValueKind.String) rawUrl = u.GetString() ?? "";
    else if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("baseUrl", out var u2) && u2.ValueKind != JsonValueKind.String && u2.ValueKind != JsonValueKind.Undefined)
      return new(false, "baseUrl must be a string.", 400, boardId, scope, meeting, "", Empty(), Empty(), Empty(), "", 60, "", "", false, false);
    var (origin, urlErr) = WikiUrl.NormalizeBaseUrl(rawUrl);
    if (origin is null) return new(false, urlErr, 400, boardId, scope, meeting, "", Empty(), Empty(), Empty(), "", 60, "", "", false, false);
    var allow = existing is not null ? WikiRules.ParseList(existing.AllowlistJson) : new List<string>();
    var excl = existing is not null ? WikiRules.ParseList(existing.ExclusionsJson) : new List<string>();
    var tags = existing is not null ? WikiRules.ParseList(existing.RequiredTagsJson) : new List<string>();
    if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("allowlist", out var al))
    {
      if (!WikiRules.TryParseStrictList(al, out var parsedAllow, out var allowErr))
        return new(false, "allowlist " + allowErr, 400, boardId, scope, meeting, origin, allow, excl, tags, "", 60, "", "", false, false);
      allow = parsedAllow;
    }
    if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("exclusions", out var ex))
    {
      if (!WikiRules.TryParseStrictList(ex, out var parsedExcl, out var exclErr))
        return new(false, "exclusions " + exclErr, 400, boardId, scope, meeting, origin, allow, excl, tags, "", 60, "", "", false, false);
      excl = parsedExcl;
    }
    if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("requiredTags", out var rt))
    {
      if (!WikiRules.TryParseStrictList(rt, out var parsedTags, out var tagsErr))
        return new(false, "requiredTags " + tagsErr, 400, boardId, scope, meeting, origin, allow, excl, tags, "", 60, "", "", false, false);
      tags = parsedTags;
    }
    var (rulesOk, rulesErr) = WikiRules.ValidateRuleLists(allow, excl, tags);
    if (!rulesOk) return new(false, rulesErr, 400, boardId, scope, meeting, origin, allow, excl, tags, "", 60, "", "", false, false);
    var locale = existing?.Locale ?? "";
    if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("locale", out var lo))
    {
      if (lo.ValueKind != JsonValueKind.String) return new(false, "locale must be a string.", 400, boardId, scope, meeting, origin, allow, excl, tags, "", 60, "", "", false, false);
      locale = (lo.GetString() ?? "").Trim();
    }
    if (locale.Length > 32) return new(false, "locale is too long.", 400, boardId, scope, meeting, origin, allow, excl, tags, locale, 60, "", "", false, false);
    var interval = existing?.SyncIntervalMinutes ?? 60;
    if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("syncIntervalMinutes", out var iv))
    {
      // Preserve JSON types strictly: only numbers accepted (strings rejected).
      if (iv.ValueKind != JsonValueKind.Number || !iv.TryGetInt32(out var ivi))
        return new(false, "syncIntervalMinutes must be a number (5-1440).", 400, boardId, scope, meeting, origin, allow, excl, tags, locale, 60, "", "", false, false);
      interval = ivi;
    }
    interval = Math.Clamp(interval, 5, 1440);
    var desc = existing?.Description ?? "";
    if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("description", out var dd))
    {
      if (dd.ValueKind != JsonValueKind.String) return new(false, "description must be a string.", 400, boardId, scope, meeting, origin, allow, excl, tags, locale, interval, "", "", false, false);
      desc = (dd.GetString() ?? "").Trim();
    }
    if (desc.Length > 500) return new(false, "description is too long.", 400, boardId, scope, meeting, origin, allow, excl, tags, locale, interval, desc, "", false, false);
    var allowedUse = existing?.AllowedUse ?? "";
    if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("allowedUse", out var au))
    {
      if (au.ValueKind != JsonValueKind.String) return new(false, "allowedUse must be a string.", 400, boardId, scope, meeting, origin, allow, excl, tags, locale, interval, desc, "", false, false);
      allowedUse = (au.GetString() ?? "").Trim();
    }
    if (allowedUse.Length > 2000) return new(false, "allowedUse is too long.", 400, boardId, scope, meeting, origin, allow, excl, tags, locale, interval, desc, allowedUse, false, false);
    var setupUse = existing?.SetupUse ?? false;
    if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("setupUse", out var su))
    {
      if (su.ValueKind != JsonValueKind.True && su.ValueKind != JsonValueKind.False) return new(false, "setupUse must be a boolean.", 400, boardId, scope, meeting, origin, allow, excl, tags, locale, interval, desc, allowedUse, false, false);
      setupUse = su.ValueKind == JsonValueKind.True;
    }
    var manualOnly = existing?.ManualOnly ?? false;
    if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("manualOnly", out var mo))
    {
      if (mo.ValueKind == JsonValueKind.True) manualOnly = true;
      else if (mo.ValueKind == JsonValueKind.False) manualOnly = false;
      else if (mo.ValueKind == JsonValueKind.String && bool.TryParse(mo.GetString(), out var mb)) manualOnly = mb;
      else return new(false, "manualOnly must be a boolean.", 400, boardId, scope, meeting, origin, allow, excl, tags, locale, interval, desc, allowedUse, setupUse, false);
    }
    // Explicit refresh-off alias: refresh:"off"/"manual" sets manualOnly.
    if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("refresh", out var rf) && rf.ValueKind == JsonValueKind.String)
    {
      var rv = (rf.GetString() ?? "").Trim().ToLowerInvariant();
      if (rv is "off" or "manual" or "manual-only") manualOnly = true;
      else if (rv is "auto" or "on") manualOnly = false;
      else return new(false, "refresh must be off/manual or auto/on.", 400, boardId, scope, meeting, origin, allow, excl, tags, locale, interval, desc, allowedUse, setupUse, manualOnly);
    }
    return new(true, null, 200, boardId, scope, meeting, origin, allow, excl, tags, locale, interval, desc, allowedUse, setupUse, manualOnly);
  }

  public static void MapWiki(this WebApplication app)
  {
    app.MapPost("/api/boards/{bid:guid}/wiki-resources", (InMemoryStore s, WikiCredentialStore creds, HttpRequest req, Guid bid, JsonElement body) =>
    {
      // Validation, authority, and insertion all happen under the writers'
      // boundary so concurrent writers cannot interleave (F1/F2).
      lock (s.SetupLock)
      {
        if (PeopleOps.BadToken(s, req) is { } badC) return badC;
        var v = ValidateInput(s, WithBoard(body, bid), null);
        if (!v.Ok) return Results.Json(new { error = v.Error }, statusCode: v.Status);
        if (!WikiAuth.CanManageResource(s, req, bid, v.Scope, v.MeetingId)) return PeopleOps.Denied();
        string? token = null;
        if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("token", out var tk))
        {
          if (tk.ValueKind == JsonValueKind.String) token = (tk.GetString() ?? "").Trim();
          else if (tk.ValueKind == JsonValueKind.Null) token = null;
          else return Results.BadRequest("Token must be a string.");
        }
        if (token is not null && token.Length > 2000) return Results.BadRequest("Token is too long.");
        if (token is not null && token.Length > 0 && token.Length < 4) return Results.BadRequest("Token is malformed.");
        var r = new WikiResource
        {
          BoardId = bid, Scope = v.Scope, MeetingId = v.MeetingId, BaseUrl = v.Origin,
          Description = v.Description, AllowedUse = v.AllowedUse, SetupUse = v.SetupUse, ManualOnly = v.ManualOnly,
          AllowlistJson = WikiRules.ToJson(v.Allow), ExclusionsJson = WikiRules.ToJson(v.Excl),
          RequiredTagsJson = WikiRules.ToJson(v.Tags), Locale = v.Locale,
          Enabled = false, ConfigRevision = 1, AttemptGeneration = 1, AttemptStatus = "idle",
          SyncIntervalMinutes = v.Interval,
          NextSyncAt = null, LastStatus = "disabled", LastError = "", HasCredential = false,
        };
        Atomic.Run(() =>
        {
          s.WikiResources[r.Id] = r;
          if (!string.IsNullOrEmpty(token)) { creds.SetToken(r.Id, token); r.HasCredential = true; }
          s.WikiResources.Flush();
        });
        try { s.Audit.Add(new AuditEvent { BoardId = bid, Action = "wiki.create", Detail = JsonSerializer.Serialize(new { resource = r.Id, scope = r.Scope }) }); } catch { }
        return Results.Created("/api/wiki-resources/" + r.Id, ShapeResource(s, r));
      }
    });

    app.MapGet("/api/boards/{bid:guid}/wiki-resources", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (!s.Boards.TryGetValue(bid, out _)) return Results.NotFound("board");
      if (PeopleOps.HasInvalidToken(s, req)) return PeopleOps.Denied();
      var user = PeopleOps.UserOf(s, req);
      var list = s.WikiResources.Values.Where(r => r.BoardId == bid).OrderBy(r => r.CreatedAt)
        .Where(r => WikiAuth.CanReadByUser(s, bid, r.Scope, r.MeetingId, user))
        .ToList();
      return Results.Ok(list.Select(r => ShapeResource(s, r)));
    });

    app.MapGet("/api/wiki-resources/{id:guid}", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.WikiResources.TryGetValue(id, out var r)) return Results.NotFound();
      if (!WikiAuth.CanReadResource(s, req, r.BoardId, r.Scope, r.MeetingId)) return PeopleOps.Denied();
      return Results.Ok(ShapeResource(s, r));
    });

    app.MapPatch("/api/wiki-resources/{id:guid}", (InMemoryStore s, WikiCredentialStore creds, HttpRequest req, Guid id, JsonElement body) =>
    {
      // Fresh validation, authority, and mutation all happen under the
      // writers' boundary: ValidateInput runs against the freshly re-read
      // row (only supplied fields override it), both current and target
      // authority are checked inside, and the mutation reports whether it
      // changed anything so identical PATCHes never pause/audit (F2/F5).
      lock (s.SetupLock)
      {
        if (!s.WikiResources.TryGetValue(id, out var fresh0)) return Results.NotFound();
        if (PeopleOps.BadToken(s, req) is { } bad0) return bad0;
        var curScope0 = fresh0.Scope == "meeting" ? "meeting" : "board";
        if (!WikiAuth.CanManageResource(s, req, fresh0.BoardId, curScope0, fresh0.MeetingId)) return PeopleOps.Denied();
        var v = ValidateInput(s, body, fresh0);
        if (!v.Ok) return Results.Json(new { error = v.Error }, statusCode: v.Status);
        if (v.BoardId != fresh0.BoardId) return Results.BadRequest("Wiki resources cannot move across boards.");
        if (!WikiAuth.CanManageResource(s, req, fresh0.BoardId, v.Scope, v.MeetingId)) return PeopleOps.Denied();
        string? token = null; bool tokenPresent = false; bool clearCred = false;
        if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("token", out var tk))
        {
          if (tk.ValueKind == JsonValueKind.String) { token = (tk.GetString() ?? ""); tokenPresent = true; }
          else if (tk.ValueKind == JsonValueKind.Null) { tokenPresent = true; token = ""; }
          else return Results.BadRequest("Token must be a string.");
        }
        if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("clearCredential", out var cc) && cc.ValueKind == JsonValueKind.True) clearCred = true;
        if (tokenPresent && token is not null && token.Length > 2000) return Results.BadRequest("Token is too long.");
        if (tokenPresent && !string.IsNullOrEmpty(token) && token.Trim().Length < 4) return Results.BadRequest("Token is malformed.");
        var changed = SourceGovernance.MutateEvidenceIfChanged(s, fresh0.BoardId, "wiki.reconfigure " + id, () =>
        {
          if (!s.WikiResources.TryGetValue(id, out var cur)) return false;
          var urlChanged = !string.Equals(v.Origin, cur.BaseUrl, StringComparison.Ordinal);
          var rulesChanged = WikiRules.ToJson(v.Allow) != cur.AllowlistJson || WikiRules.ToJson(v.Excl) != cur.ExclusionsJson
            || WikiRules.ToJson(v.Tags) != cur.RequiredTagsJson || !string.Equals(v.Locale ?? "", cur.Locale ?? "", StringComparison.Ordinal)
            || v.Scope != (cur.Scope == "meeting" ? "meeting" : "board") || v.MeetingId != cur.MeetingId || v.Interval != cur.SyncIntervalMinutes
            || !string.Equals(v.Description ?? "", cur.Description ?? "", StringComparison.Ordinal)
            || !string.Equals(v.AllowedUse ?? "", cur.AllowedUse ?? "", StringComparison.Ordinal)
            || v.SetupUse != cur.SetupUse || v.ManualOnly != cur.ManualOnly;
          cur.BaseUrl = v.Origin; cur.Scope = v.Scope; cur.MeetingId = v.MeetingId;
          cur.Description = v.Description; cur.AllowedUse = v.AllowedUse; cur.SetupUse = v.SetupUse; cur.ManualOnly = v.ManualOnly;
          cur.AllowlistJson = WikiRules.ToJson(v.Allow);
          cur.ExclusionsJson = WikiRules.ToJson(v.Excl); cur.RequiredTagsJson = WikiRules.ToJson(v.Tags);
          cur.Locale = v.Locale; cur.SyncIntervalMinutes = v.Interval;
          if (urlChanged) { creds.ClearToken(cur.Id); cur.HasCredential = false; cur.Enabled = false; cur.LastStatus = "disabled"; cur.LastError = "Base URL changed; reconfigure the credential and re-enable."; }
          if (clearCred) { creds.ClearToken(cur.Id); cur.HasCredential = false; }
          if (tokenPresent && !string.IsNullOrEmpty(token)) { creds.SetToken(cur.Id, token!); cur.HasCredential = true; }
          // An enabled resource must keep complete required configuration:
          // blanking description/use/allowlist/credential forces disabled +
          // blocked health with invalidation and no autosync (F8).
          var complete = !string.IsNullOrWhiteSpace(cur.Description) && !string.IsNullOrWhiteSpace(cur.AllowedUse)
            && WikiRules.ParseList(cur.AllowlistJson).Count > 0 && creds.HasToken(cur.Id);
          var forceDisabled = false;
          if (cur.Enabled && !complete)
          {
            cur.Enabled = false; cur.LastStatus = "disabled";
            cur.LastError = "Required configuration was removed; reconfigure description, allowed use, allowlist, and credential, then re-enable.";
            cur.AttemptGeneration++; cur.AttemptStatus = "idle"; cur.NextSyncAt = null;
            forceDisabled = true;
          }
          var bump = urlChanged || rulesChanged || tokenPresent || clearCred || forceDisabled;
          if (bump)
          {
            cur.ConfigRevision++;
            cur.AttemptGeneration++;
            cur.AttemptStatus = "idle";
            if (cur.Enabled) { cur.LastStatus = "pending"; cur.LastError = ""; cur.NextSyncAt = cur.ManualOnly ? null : DateTime.UtcNow; }
          }
          if (cur.ManualOnly && cur.Enabled) cur.NextSyncAt = null;
          cur.UpdatedAt = DateTime.UtcNow;
          s.WikiResources.Flush();
          return bump;
        });
        if (!s.WikiResources.TryGetValue(id, out var after)) return Results.NotFound();
        if (changed) try { s.Audit.Add(new AuditEvent { BoardId = after.BoardId, Action = "wiki.reconfigure", Detail = JsonSerializer.Serialize(new { resource = after.Id, rev = after.ConfigRevision }) }); } catch { }
        return Results.Ok(ShapeResource(s, after));
      }
    });

    app.MapPost("/api/wiki-resources/{id:guid}/enable", (InMemoryStore s, WikiCredentialStore creds, HttpRequest req, Guid id) =>
    {
      // Authority and required-configuration checks run under the writers'
      // boundary against the fresh row (F2).
      lock (s.SetupLock)
      {
        if (!s.WikiResources.TryGetValue(id, out var fresh)) return Results.NotFound();
        if (PeopleOps.BadToken(s, req) is { } bad) return bad;
        if (!WikiAuth.CanManageResource(s, req, fresh.BoardId, fresh.Scope == "meeting" ? "meeting" : "board", fresh.MeetingId)) return PeopleOps.Denied();
        if (!creds.HasToken(id)) return Results.Json(new { error = "Configure a credential before enabling." }, statusCode: 409);
        if (string.IsNullOrWhiteSpace(fresh.Description)) return Results.Json(new { error = "Set a description before enabling." }, statusCode: 409);
        if (string.IsNullOrWhiteSpace(fresh.AllowedUse)) return Results.Json(new { error = "Set allowed use before enabling." }, statusCode: 409);
        if (WikiRules.ParseList(fresh.AllowlistJson).Count == 0) return Results.Json(new { error = "Set a non-empty path allowlist before enabling; blank allowlist denies all." }, statusCode: 409);
        SourceGovernance.MutateEvidenceIfChanged(s, fresh.BoardId, "wiki.enable " + id, () =>
        {
          if (!s.WikiResources.TryGetValue(id, out var cur)) return false;
          cur.Enabled = true; cur.LastStatus = "pending"; cur.LastError = "";
          cur.AttemptGeneration++; cur.AttemptStatus = "idle";
          cur.NextSyncAt = cur.ManualOnly ? null : DateTime.UtcNow; cur.UpdatedAt = DateTime.UtcNow;
          s.WikiResources.Flush();
          return true;
        });
        if (!s.WikiResources.TryGetValue(id, out var after)) return Results.NotFound();
        return Results.Ok(ShapeResource(s, after));
      }
    });

    app.MapPost("/api/wiki-resources/{id:guid}/disable", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      // Authority is checked under the writers' boundary against the fresh row (F2).
      lock (s.SetupLock)
      {
        if (!s.WikiResources.TryGetValue(id, out var fresh)) return Results.NotFound();
        if (PeopleOps.BadToken(s, req) is { } bad) return bad;
        if (!WikiAuth.CanManageResource(s, req, fresh.BoardId, fresh.Scope == "meeting" ? "meeting" : "board", fresh.MeetingId)) return PeopleOps.Denied();
        SourceGovernance.MutateEvidenceIfChanged(s, fresh.BoardId, "wiki.disable " + id, () =>
        {
          if (!s.WikiResources.TryGetValue(id, out var cur)) return false;
          cur.Enabled = false; cur.LastStatus = "disabled"; cur.LastError = "Disabled by manager; cached connector evidence is unavailable until re-enabled and successfully synced.";
          cur.AttemptGeneration++; cur.AttemptStatus = "idle";
          cur.NextSyncAt = null; cur.UpdatedAt = DateTime.UtcNow;
          s.WikiResources.Flush();
          return true;
        });
        if (!s.WikiResources.TryGetValue(id, out var after)) return Results.NotFound();
        return Results.Ok(ShapeResource(s, after));
      }
    });

    app.MapPost("/api/wiki-resources/{id:guid}/sync", async (InMemoryStore s, WikiCredentialStore creds, WikiSyncService sync, HttpRequest req, Guid id) =>
    {
      if (!s.WikiResources.TryGetValue(id, out var r)) return Results.NotFound();
      if (PeopleOps.BadToken(s, req) is { } bad) return bad;
      if (!WikiAuth.CanManageResource(s, req, r.BoardId, r.Scope == "meeting" ? "meeting" : "board", r.MeetingId)) return PeopleOps.Denied();
      if (!r.Enabled) return Results.Json(new { error = "Resource is disabled; enable it first." }, statusCode: 409);
      var caller = PeopleOps.UserOf(s, req);
      var (ok, error, status) = await sync.SyncAsync(id, "manual", caller, false);
      if (!s.WikiResources.TryGetValue(id, out var cur)) return Results.NotFound();
      var shaped = ShapeResource(s, cur);
      if (!ok) return Results.Json(new { error, resource = shaped }, statusCode: status);
      return Results.Ok(shaped);
    });

    app.MapDelete("/api/wiki-resources/{id:guid}", (InMemoryStore s, WikiCredentialStore creds, HttpRequest req, Guid id) =>
    {
      // Authority is checked under the writers' boundary against the fresh row (F2).
      lock (s.SetupLock)
      {
        if (!s.WikiResources.TryGetValue(id, out var fresh)) return Results.NotFound();
        if (PeopleOps.BadToken(s, req) is { } bad) return bad;
        if (!WikiAuth.CanManageResource(s, req, fresh.BoardId, fresh.Scope == "meeting" ? "meeting" : "board", fresh.MeetingId)) return PeopleOps.Denied();
        var bid = fresh.BoardId;
        SourceGovernance.MutateEvidenceIfChanged(s, bid, "wiki.delete " + id, () =>
        {
          s.WikiResources.TryRemove(id, out _);
          creds.ClearToken(id);
          s.WikiResources.Flush();
          return true;
        });
        try { s.Audit.Add(new AuditEvent { BoardId = bid, Action = "wiki.delete", Detail = JsonSerializer.Serialize(new { resource = id }) }); } catch { }
        return Results.Ok(new { deleted = id });
      }
    });
  }

  private static JsonElement WithBoard(JsonElement body, Guid bid)
  {
    // Merge explicit boardId for shared validation while PRESERVING JSON
    // types (numbers stay numbers; omitted-vs-explicit scope stays distinct).
    try
    {
      JsonNode? node = JsonNode.Parse(body.GetRawText());
      var obj = node as JsonObject ?? new JsonObject();
      obj["boardId"] = bid.ToString();
      using var d2 = JsonDocument.Parse(obj.ToJsonString());
      return d2.RootElement.Clone();
    }
    catch { return body; }
  }
}

