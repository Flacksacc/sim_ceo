using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

namespace SimCEO.Api;

// Board-scoped invitations and grants. No login system ships in this slice:
// the caller identifies with an `X-User` header (default "owner").
// "owner" always manages; other users are bound by stored grants.
// When a board has no grants at all, every check passes (single-user default).
// Revoking the last matching grant promptly stops new reads and live updates.
public static class PeopleOps
{
  public static string UserOf(InMemoryStore s, HttpRequest req) =>
    AuthOps.ResolveUser(s, req);

  private static int Rank(string a) => a switch
  {
    "open" or "manage" => 3,
    "contribute" => 2,
    "read" => 1,
    _ => 0,
  };

  public static string AccessFor(InMemoryStore s, Guid boardId, Guid? meetingId, string user)
  {
    if (string.Equals(user, "owner", StringComparison.OrdinalIgnoreCase)) return "manage";
    var boardGrants = s.Grants.Values.Where(g => g.BoardId == boardId).ToList();
    // Adding the first collaborator opts the board into enforcement permanently:
    // revoking the last grant still denies strangers instead of reopening.
    if (boardGrants.Count == 0 && !s.Invites.Values.Any(i => i.BoardId == boardId)) return "open";
    var scoped = boardGrants.Where(g => meetingId == null || g.MeetingId == null || g.MeetingId == meetingId).ToList();
    var best = 0;
    foreach (var g in scoped.Where(g => string.Equals(g.UserKey, user, StringComparison.OrdinalIgnoreCase)))
      best = Math.Max(best, Rank(g.Access));
    return best >= 3 ? "manage" : best == 2 ? "contribute" : best == 1 ? "read" : "none";
  }

  public static bool IsOwner(HttpRequest req)
  {
    if (req.Headers.ContainsKey("Authorization")) return false;
    return !req.Headers.TryGetValue("X-User", out var v) || string.IsNullOrWhiteSpace(v.ToString())
      || string.Equals(v.ToString(), "owner", StringComparison.OrdinalIgnoreCase);
  }

  public static IResult? Guard(ModelGateway gw, HttpRequest req)
  {
    try
    {
      gw.ThrowIfCapped(IsOwner(req));
      gw.EnsureAvailable();
      return null;
    }
    catch (CapExceededException ex)
    {
      return Results.Json(new { error = ex.Message }, statusCode: 402);
    }
    catch (ProviderNotConfiguredException ex)
    {
      return Results.Json(new { error = ex.Message }, statusCode: 503);
    }
  }

  public static IResult ProviderError(ProviderException ex) =>
    Results.Json(new { error = ex.Message }, statusCode: 502);

  public static IResult ModelError(Exception ex) => ex switch
  {
    CapExceededException cex => Results.Json(new { error = cex.Message }, statusCode: 402),
    ProviderException pex => ProviderError(pex),
    _ => Results.Json(new { error = ex.Message }, statusCode: 502),
  };

  public static bool Can(InMemoryStore s, HttpRequest req, Guid boardId, Guid? meetingId, string need)
  {
    var have = AccessFor(s, boardId, meetingId, UserOf(s, req));
    if (have == "open") return true;
    return Rank(have) >= Rank(need);
  }

  public static IResult Denied() =>
    Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403);
}

public static class PeopleEndpoints
{
  private static string AccessForRole(string role) => role switch
  {
    "manager" => "manage",
    "viewer" => "read",
    _ => "contribute",
  };

  public static void MapPeople(this WebApplication app)
  {
    app.MapGet("/api/boards/{bid:guid}/invites", (InMemoryStore s, HttpRequest req, Guid bid) =>
      !PeopleOps.Can(s, req, bid, null, "manage") ? PeopleOps.Denied()
      : Results.Ok(s.Invites.Values.Where(i => i.BoardId == bid).OrderByDescending(i => i.CreatedAt)));

    app.MapPost("/api/boards/{bid:guid}/invites", (InMemoryStore s, HttpRequest req, Guid bid, Invite input) =>
    {
      if (!PeopleOps.Can(s, req, bid, null, "manage")) return PeopleOps.Denied();
      if (string.IsNullOrWhiteSpace(input.Email)) return Results.BadRequest("Email is required.");
      input.Id = Guid.NewGuid();
      input.BoardId = bid;
      input.State = "pending";
      input.CreatedAt = DateTime.UtcNow;
      s.Invites[input.Id] = input;
      s.Audit.Add(new AuditEvent { BoardId = bid, Action = "invite.create", Detail = JsonSerializer.Serialize(new { input.Email, input.Role }) });
      return Results.Created($"/api/invites/{input.Id}", input);
    });

    app.MapPost("/api/invites/{id:guid}/accept", (InMemoryStore s, Guid id, JsonElement body) =>
    {
      if (!s.Invites.TryGetValue(id, out var inv) || inv.State != "pending")
        return Results.Conflict("Invite is not pending.");
      var user = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("userKey", out var u)
        ? (u.GetString() ?? inv.Email) : inv.Email;
      inv.State = "accepted";
      inv.UserKey = user;
      var grant = new Grant
      {
        BoardId = inv.BoardId, UserKey = user,
        Access = AccessForRole(inv.Role), CreatedAt = DateTime.UtcNow,
      };
      s.Grants[grant.Id] = grant;
      s.Audit.Add(new AuditEvent { BoardId = inv.BoardId, Action = "invite.accept", Detail = JsonSerializer.Serialize(new { user }) });
      return Results.Ok(grant);
    });

    app.MapPost("/api/invites/{id:guid}/revoke", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Invites.TryGetValue(id, out var inv)) return Results.NotFound();
      if (!PeopleOps.Can(s, req, inv.BoardId, null, "manage")) return PeopleOps.Denied();
      inv.State = "revoked";
      foreach (var g in s.Grants.Values.Where(g => g.BoardId == inv.BoardId
        && (string.Equals(g.UserKey, inv.Email, StringComparison.OrdinalIgnoreCase)
          || (!string.IsNullOrWhiteSpace(inv.UserKey) && string.Equals(g.UserKey, inv.UserKey, StringComparison.OrdinalIgnoreCase)))).ToList())
        s.Grants.TryRemove(g.Id, out _);
      s.Audit.Add(new AuditEvent { BoardId = inv.BoardId, Action = "invite.revoke", Detail = JsonSerializer.Serialize(new { inv.Email }) });
      return Results.Ok(inv);
    });

    app.MapGet("/api/boards/{bid:guid}/grants", (InMemoryStore s, HttpRequest req, Guid bid) =>
      !PeopleOps.Can(s, req, bid, null, "manage") ? PeopleOps.Denied()
      : Results.Ok(s.Grants.Values.Where(g => g.BoardId == bid).OrderByDescending(g => g.CreatedAt)));

    app.MapPost("/api/boards/{bid:guid}/grants", (InMemoryStore s, HttpRequest req, Guid bid, Grant input) =>
    {
      if (!PeopleOps.Can(s, req, bid, null, "manage")) return PeopleOps.Denied();
      if (string.IsNullOrWhiteSpace(input.UserKey)) return Results.BadRequest("userKey is required.");
      if (input.Access is not ("read" or "contribute" or "manage")) return Results.BadRequest("access must be read, contribute, or manage.");
      foreach (var old in s.Grants.Values.Where(g => g.BoardId == bid
        && g.MeetingId == input.MeetingId
        && string.Equals(g.UserKey, input.UserKey, StringComparison.OrdinalIgnoreCase)).ToList())
        s.Grants.TryRemove(old.Id, out _);
      input.Id = Guid.NewGuid();
      input.BoardId = bid;
      input.CreatedAt = DateTime.UtcNow;
      s.Grants[input.Id] = input;
      s.Audit.Add(new AuditEvent { BoardId = bid, Action = "grant.set", Detail = JsonSerializer.Serialize(new { input.UserKey, input.MeetingId, input.Access }) });
      return Results.Created($"/api/grants/{input.Id}", input);
    });

    app.MapDelete("/api/grants/{id:guid}", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Grants.TryGetValue(id, out var g)) return Results.NotFound();
      if (!PeopleOps.Can(s, req, g.BoardId, g.MeetingId, "manage")) return PeopleOps.Denied();
      s.Grants.TryRemove(id, out _);
      s.Audit.Add(new AuditEvent { BoardId = g.BoardId, Action = "grant.revoke", Detail = JsonSerializer.Serialize(new { g.UserKey, g.MeetingId }) });
      return Results.NoContent();
    });
  }
}
