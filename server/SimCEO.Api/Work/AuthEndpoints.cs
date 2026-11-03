using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api;

public sealed class Account
{
  public Guid Id { get; set; } = Guid.NewGuid();
  public string Email { get; set; } = "";
  public string Salt { get; set; } = "";
  public string Hash { get; set; } = "";
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class Session
{
  public Guid Id { get; set; } = Guid.NewGuid();
  public string Token { get; set; } = "";
  public Guid AccountId { get; set; }
  public string Email { get; set; } = "";
  public DateTime ExpiresAt { get; set; }
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public static class AuthOps
{
  public const int MinPasswordLength = 12;
  public static readonly TimeSpan SessionLifetime = TimeSpan.FromDays(14);
  private const int MaxFailedLogins = 10;
  private static readonly TimeSpan ThrottleWindow = TimeSpan.FromMinutes(10);

  public static string NewSalt() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16));

  public static string HashPassword(string password, string salt) =>
    Convert.ToHexString(Rfc2898DeriveBytes.Pbkdf2(
      Encoding.UTF8.GetBytes(password), Convert.FromHexString(salt), 100_000,
      HashAlgorithmName.SHA256, 32));

  public static bool ValidEmail(string email) =>
    !string.IsNullOrWhiteSpace(email) && email.Contains('@') && email.Length <= 200;

  public static (Session? session, string? error, int status) Login(
    InMemoryStore s, string email, string password)
  {
    email = (email ?? "").Trim().ToLowerInvariant();
    if (!ValidEmail(email) || string.IsNullOrEmpty(password))
      return (null, "Email and password are required.", 400);
    // Consistent lock order: SetupLock outer, AuthLock inner. Never hold AuthLock into SetupLock.
    lock (s.SetupLock)
    {
      lock (s.AuthLock)
      {
      var fails = s.AuthFails.TryGetValue(email, out var f) ? f : new List<DateTime>();
      fails = fails.Where(t => DateTime.UtcNow - t < ThrottleWindow).ToList();
      s.AuthFails[email] = fails;
      if (fails.Count >= MaxFailedLogins)
        return (null, "Too many failed attempts; try again later.", 429);
      var acct = s.Accounts.Values.FirstOrDefault(a => a.Email == email);
      if (acct is null || !CryptographicOperations.FixedTimeEquals(
          Convert.FromHexString(acct.Hash),
          Convert.FromHexString(HashPassword(password, acct.Salt))))
      {
        fails.Add(DateTime.UtcNow);
        return (null, "Invalid email or password.", 401);
      }
      fails.Clear();
      try { SecurityOps.EnsureMigrated(s); } catch (Exception ex) { throw new InvalidOperationException("Migration commit failed.", ex); }
      var session = new Session
      {
        Token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),
        AccountId = acct.Id, Email = acct.Email,
        ExpiresAt = DateTime.UtcNow + SessionLifetime,
      };
      s.Sessions[session.Token] = session;
      return (session, null, 200);
      }
    }
  }

  public static bool TrySession(InMemoryStore s, HttpRequest req, out string email)
  {
    email = "";
    if (!req.Headers.TryGetValue("Authorization", out var auth)
        || !auth.ToString().StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
      return false;
    var token = auth.ToString()["Bearer ".Length..].Trim();
    try
    {
      if (!s.Sessions.TryGetValue(token, out var session) || session.ExpiresAt <= DateTime.UtcNow)
        return false;
      email = session.Email;
      return true;
    }
    catch { return false; }
  }

  public static string ResolveUser(InMemoryStore s, HttpRequest req)
  {
    if (TrySession(s, req, out var email)) return email;
    return req.Headers.TryGetValue("X-User", out var v) && !string.IsNullOrWhiteSpace(v.ToString())
      ? v.ToString() : "owner";
  }
}

public static class AuthEndpoints
{
  public static void MapAuth(this WebApplication app)
  {
    app.MapPost("/api/auth/register", (InMemoryStore s, JsonElement body) =>
    {
      var email = (body.TryGetProperty("email", out var e) ? e.GetString() ?? "" : "").Trim().ToLowerInvariant();
      var password = body.TryGetProperty("password", out var p) ? p.GetString() ?? "" : "";
      if (!AuthOps.ValidEmail(email)) return Results.BadRequest("A valid email is required.");
      if (password.Length < AuthOps.MinPasswordLength)
        return Results.BadRequest($"Password must be at least {AuthOps.MinPasswordLength} characters.");
      lock (s.SetupLock)
      {
        lock (s.AuthLock)
        {
          if (s.Accounts.Values.Any(a => a.Email == email))
            return Results.Conflict("An account with that email already exists.");
          var salt = AuthOps.NewSalt();
          var acct = new Account { Email = email, Salt = salt, Hash = AuthOps.HashPassword(password, salt) };
          try
          {
            Atomic.Run(() =>
            {
              s.Accounts[acct.Id] = acct;
              SecurityOps.EnsureFirstAdmin(s, email, acct.Id);
              SecurityOps.EnsureMigrated(s);
            });
          }
          catch (Exception ex) { throw new InvalidOperationException("Registration commit failed; no account, session, or partial migration was committed.", ex); }
          var session = new Session
          {
            Token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),
            AccountId = acct.Id, Email = acct.Email,
            ExpiresAt = DateTime.UtcNow + AuthOps.SessionLifetime,
          };
          s.Sessions[session.Token] = session;
          try { if (s.Accounts.Values.Count == 1) SimCEO.Api.Hubs.BoardHub.AbortAnonymous(); } catch { }
          s.Audit.Add(new AuditEvent { Action = "auth.register", Detail = JsonSerializer.Serialize(new { email }) });
          return Results.Created("/api/auth/me", new { email, token = session.Token, expiresAt = session.ExpiresAt });
        }
      }
    });

    app.MapPost("/api/auth/login", (InMemoryStore s, JsonElement body) =>
    {
      var email = body.TryGetProperty("email", out var e) ? e.GetString() ?? "" : "";
      var password = body.TryGetProperty("password", out var p) ? p.GetString() ?? "" : "";
      var (session, error, status) = AuthOps.Login(s, email, password);
      return session is not null
        ? Results.Ok(new { email = session.Email, token = session.Token, expiresAt = session.ExpiresAt })
        : Results.Json(new { error }, statusCode: status);
    });

    app.MapPost("/api/auth/logout", (InMemoryStore s, HttpRequest req) =>
    {
      string tok = "";
      // Session removal shares the publication serialization boundary: it runs
      // under SetupLock so an in-flight run/briefing/transcribe/finalize gate
      // either observes the live session (and commits first) or observes the
      // removal (and refuses). Logout can no longer complete between another
      // request's authority check and its commit.
      lock (s.SetupLock)
      {
        if (req.Headers.TryGetValue("Authorization", out var auth)
          && auth.ToString().StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
          tok = auth.ToString()["Bearer ".Length..].Trim();
          s.Sessions.TryRemove(tok, out _);
        }
      }
      try { if (!string.IsNullOrEmpty(tok)) SimCEO.Api.Hubs.BoardHub.RevokeTokenAndConnections(tok); } catch { }
      return Results.Ok(new { loggedOut = true });
    });

    app.MapGet("/api/auth/me", (InMemoryStore s, HttpRequest req) =>
    {
      if (AuthOps.TrySession(s, req, out var email))
        return Results.Ok(new { user = email, authenticated = true });
      var demo = PeopleOps.UserOf(s, req);
      return Results.Ok(new { user = demo, authenticated = false });
    });

    app.MapGet("/api/auth/status", (InMemoryStore s) =>
    {
      var secure = PeopleOps.IsSecure(s);
      var admin = PeopleOps.AdminEmail(s);
      int accounts = 0;
      try { accounts = s.Accounts.Values.Count; } catch { }
      return Results.Ok(new { authRequired = secure, hasAccounts = accounts > 0, accountCount = accounts, admin = secure ? admin : "" });
    });
  }
}
