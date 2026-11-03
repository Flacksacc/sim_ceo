using SimCEO.Api.Data;

namespace SimCEO.Api.Work;

/// <summary>Shared pin + fresh-authority guard for every async essential
/// publisher (discussion run bookkeeping, research, wizard interview,
/// secretary, voice, job commit). The publisher captures the restore
/// identity BEFORE its provider await and rechecks it INSIDE the commit
/// unit: a restore between dispatch and commit discards the stale domain
/// write (409) while the already-dispatched provider call still bills
/// exactly one pair. Fresh authority is rechecked in the same unit so a
/// logout/revocation/expiry during the await fails closed. Session loss
/// surfaces as revoked (401); live-session permission loss as denied (403).</summary>
public static class PublicationGuard
{
  public static (Guid epochId, long epochRev) Capture(InMemoryStore s) =>
    (s.RestoreEpochId, s.RestoreEpochRev);

  public static void Check(InMemoryStore s, (Guid epochId, long epochRev) pin,
    HttpRequest req, Guid boardId, Guid? meetingId, string need)
  {
    if (s.RestoreEpochId != pin.epochId || s.RestoreEpochRev != pin.epochRev)
      throw new InvalidOperationException("restored");
    if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _))
      throw new UnauthorizedAccessException("revoked");
    if (!PeopleOps.Can(s, req, boardId, meetingId, need))
      throw new UnauthorizedAccessException("denied");
  }

  /// <summary>Maps a publication-unit failure to an honest result:
  /// restored (409, stale write discarded), revoked (401, session dead),
  /// denied (403, permission lost), anything else rethrows for the caller
  /// own storage/gone mapping. Returns null when the exception is not a
  /// publication-guard failure.</summary>
  public static IResult? MapGuardFailure(Exception ex)
  {
    if (ex is InvalidOperationException iox && iox.Message == "restored")
      return Results.Conflict("Domain was restored during generation; retry.");
    if (ex is UnauthorizedAccessException uex && uex.Message == "revoked")
      return Results.Json(new { error = "Authentication required." }, statusCode: 401);
    if (ex is UnauthorizedAccessException)
      return Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403);
    return null;
  }
}
