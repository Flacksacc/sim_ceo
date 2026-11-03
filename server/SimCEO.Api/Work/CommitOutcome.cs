using SimCEO.Api.Data;

namespace SimCEO.Api.Work;

/// <summary>Honest HTTP mapping for store-bound commit outcomes (finding 4).
/// CommitUnknownException MUST be checked before its PostCommitException base:
/// an unknown outcome MAY have committed, a post-commit effect failure means the
/// state IS committed, and an uncertain rollback is neither. Callers must never
/// report "no state changed", "prior restored", or "committed" for an unknown
/// outcome. InvalidOperationException maps to 404 ONLY for explicit
/// missing-domain conditions; any other InvalidOperationException (including a
/// storage fault or a foreign-unit error) is a 502 storage failure, never 404.</summary>
public static class CommitOutcome
{
  /// <summary>Maps commit-outcome categories to honest results; returns null for
  /// any other exception so the caller's own mapping still applies. CommitUnknown
  /// is tested before PostCommitException (it derives from it).</summary>
  public static IResult? MapCommitFailure(Exception ex, string action)
  {
    if (ex is CommitUnknownException cux)
      return Results.Json(new { error = action + " outcome is unknown (the commit may have succeeded); re-read the state before retrying: " + cux.Message }, statusCode: 500);
    if (ex is PostCommitException pce)
      return Results.Json(new { error = action + " committed, but a post-commit effect failed: " + pce.Message }, statusCode: 500);
    if (ex is AggregateException agx)
      return Results.Json(new { error = action + " failed and rollback is uncertain; prior state may be partial: " + agx.Message }, statusCode: 500);
    return null;
  }

  /// <summary>True only for explicit missing-domain conditions. Pass the exact
  /// message the unit throws when its row is gone; anything else is a storage
  /// fault, never 404.</summary>
  public static bool IsMissing(InvalidOperationException ex, params string[] missingMessages)
  {
    var m = ex.Message ?? "";
    foreach (var mm in missingMessages)
      if (string.Equals(m, mm, StringComparison.Ordinal)) return true;
    return false;
  }

  public static IResult StorageFault(string action, InvalidOperationException ex) =>
    Results.Json(new { error = action + " failed (storage fault; safe to retry): " + ex.Message }, statusCode: 502);
}