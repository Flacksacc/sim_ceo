using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api;

// Built-in account auth (no external provider): PBKDF2-hashed passwords,
// opaque session tokens, explicit expiry. Identity resolution order:
//  1. Authorization: Bearer <session token> (401 when expired/unknown),
//  2. X-User demo header,
//  3. "owner" fallback (single-user dev default).
// Failed-login throttling is in-memory and best-effort; production should
// add a persistent throttle and HTTPS-only cookies.
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

  public static bool TrySession(InMemoryStore s, HttpRequest req, out string email)
  {
    email = "";
    if (!req.Headers.TryGetValue("Authorization", out var auth)
        || !auth.ToString().StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
      return false;
    var token = auth.ToString()["Bearer ".Length..].Trim();
    if (!s.Sessions.TryGetValue(token, out var session) || session.ExpiresAt <= DateTime.UtcNow)
      return false;
    email = session.Email;
    return true;
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
      lock (s.AuthLock)
      {
        if (s.Accounts.Values.Any(a => a.Email == email))
          return Results.Conflict("An account with that email already exists.");
        var salt = AuthOps.NewSalt();
        var acct = new Account { Email = email, Salt = salt, Hash = AuthOps.HashPassword(password, salt) };
        s.Accounts[acct.Id] = acct;
        var (session, _, _) = AuthOps.Login(s, email, password);
        s.Audit.Add(new AuditEvent { Action = "auth.register", Detail = JsonSerializer.Serialize(new { email }) });
        return Results.Created("/api/auth/me", new { email, token = session?.Token, expiresAt = session?.ExpiresAt });
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
      if (req.Headers.TryGetValue("Authorization", out var auth)
          && auth.ToString().StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        s.Sessions.TryRemove(auth.ToString()["Bearer ".Length..].Trim(), out _);
      return Results.Ok(new { loggedOut = true });
    });

    app.MapGet("/api/auth/me", (InMemoryStore s, HttpRequest req) =>
    {
      if (AuthOps.TrySession(s, req, out var email))
        return Results.Ok(new { user = email, authenticated = true });
      var demo = PeopleOps.UserOf(s, req);
      return Results.Ok(new { user = demo, authenticated = false });
    });
  }
}
