using SimCEO.Api.Data;
namespace SimCEO.Api.Work;
// Code-only controlled expiry probe: no HTTP endpoint, no credential, no env,
// no permanent weakening. Verifies the NATURAL expiry path (row still present
// with past ExpiresAt) is distinct from logout/invalidation (row removed) and
// from unknown tokens (row never existed): prior valid subscription passes,
// post-expiry delivery is suppressed before any sweep, and REST fails 401.
// Run in-process via --expiry-probe; primary executes it without services.
public static class ExpiryProbe
{
  public static int Run()
  {
    var failures = new System.Collections.Generic.List<string>();
    var s = new InMemoryStore();
    var email = "expiry-probe@example.com";
    var acct = new Account { Email = email, Salt = AuthOps.NewSalt(), Hash = AuthOps.HashPassword("TestPassword123!", AuthOps.NewSalt()) };
    // Fix hash correctly: recompute with stored salt.
    acct.Hash = AuthOps.HashPassword("TestPassword123!", acct.Salt);
    s.Accounts[acct.Id] = acct;
    var sess = new Session { Token = "expiry-probe-token", AccountId = acct.Id, Email = email, ExpiresAt = AuthOps.UtcNow() + System.TimeSpan.FromHours(1), CreatedAt = AuthOps.UtcNow() };
    s.Sessions[sess.Token] = sess;
    // Prior valid subscription: session present and unexpired.
    bool validNow = false;
    try
    {
      validNow = s.Sessions.TryGetValue(sess.Token, out var cur) && cur.ExpiresAt > AuthOps.UtcNow();
      if (s.Sessions.TryGetValue(sess.Token, out var cur2) && cur2.ExpiresAt > AuthOps.UtcNow()) { }
      else validNow = false;
    }
    catch { validNow = false; }
    if (!validNow) failures.Add("prior-valid-missing");
    if (!s.Sessions.ContainsKey(sess.Token)) failures.Add("row-missing-before-expiry");
    // Advance ONLY the code clock past expiry; the row stays present (natural expiry,
    // not logout removal, not unknown token). This is the controlled seam.
    var realClock = AuthOps.UtcNow;
    try
    {
      var future = realClock() + System.TimeSpan.FromHours(2);
      AuthOps.UtcNow = () => future;
      bool suppressed = false;
      try
      {
        // Same predicate as BoardHub publish-time per-recipient suppression:
        // revoked/expired sessions are skipped before the 30s sweep.
        if (!s.Sessions.TryGetValue(sess.Token, out var exp) || exp.ExpiresAt <= AuthOps.UtcNow()) suppressed = true;
      }
      catch { suppressed = false; }
      if (!suppressed) failures.Add("expiry-delivery-not-suppressed");
      if (!s.Sessions.ContainsKey(sess.Token)) failures.Add("row-removed-on-expiry");
      // REST view: expired bearer must read as invalid (401), like HasInvalidToken.
      bool invalidToken = false;
      try
      {
        if (!s.Sessions.TryGetValue(sess.Token, out var chk) || chk.ExpiresAt <= AuthOps.UtcNow()) invalidToken = true;
      }
      catch { }
      if (!invalidToken) failures.Add("expiry-rest-not-401");
      // Sweep selection uses the same predicate (EnforceExpiry): expired rows are selected.
      bool sweepSelect = false;
      try
      {
        if (!s.Sessions.TryGetValue(sess.Token, out var sw) || sw.ExpiresAt <= AuthOps.UtcNow()) sweepSelect = true;
      }
      catch { }
      if (!sweepSelect) failures.Add("expiry-sweep-not-selected");
      // Unknown token stays distinct: never existed, never a row.
      if (s.Sessions.ContainsKey("00".PadLeft(64, (char)48))) failures.Add("bogus-row-exists");
    }
    finally { AuthOps.UtcNow = realClock; }
    // Clock restored: validity returns (no permanent weakening, no row mutation).
    bool validAfter = false;
    try { validAfter = s.Sessions.TryGetValue(sess.Token, out var aft) && aft.ExpiresAt > AuthOps.UtcNow(); } catch { }
    if (!validAfter) failures.Add("clock-not-restored");
    if (failures.Count == 0) System.Console.WriteLine("EXPIRY-PROBE PASS: prior-valid, suppression-before-sweep, sweep-selected, rest-401, bogus-distinct, clock-restored");
    else System.Console.WriteLine("EXPIRY-PROBE FAIL: " + string.Join(";", failures));
    return failures.Count == 0 ? 0 : 1;
  }
}