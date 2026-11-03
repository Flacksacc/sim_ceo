using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// One per-resource single-flight bounded sync service powering enable,
// rule-change, manual, and scheduled triggers. Disabled resources never fetch.
// Origin + credential + revision + attempt-generation are captured coherently
// under the configuration boundary BEFORE the list request; the origin is
// re-verified before EVERY fetch and at commit, and stale attempts are
// discarded without touching newer state. Attempt progress (AttemptStatus)
// is SEPARATE from evidence health (LastStatus pending/succeeded/failed/
// disabled): an unchanged in-flight refresh keeps the previous healthy
// snapshot usable, and an unchanged successful resync never pauses meetings.
// Config / scope / disable / delete / failure blocks ALL cached connector
// evidence atomically with meeting generation/pause under common
// SourceGovernance locks. No network await runs inside locks/transactions:
// fetched data is staged outside the lock, then committed as one atomic batch
// only if the revision/generation/authority state is still current and every
// selected page succeeded. Partial failed batches never leave newly eligible
// pages nor retain usable stale cached evidence.
public interface IWikiClock { DateTime UtcNow { get; } }
public sealed class SystemWikiClock : IWikiClock { public DateTime UtcNow => DateTime.UtcNow; }

public sealed record WikiStagedPage(WikiPage Page, string NormalizedPath, string FamilyKey, string ContentHash, int ResponseBytes);

public sealed class WikiSyncService
{
  public const int MaxPages = 100;
  public const int MaxBytesPerPage = 256 * 1024;
  public const int MaxAggregateBytes = 8 * 1024 * 1024;
  public static readonly TimeSpan WholeSyncTimeout = TimeSpan.FromSeconds(60);

  private readonly InMemoryStore _store;
  private readonly WikiCredentialStore _creds;
  private readonly IWikiClock _clock;
  private readonly Func<string, string?, HttpMessageHandler?> _handlerFactory;
  private readonly ConcurrentDictionary<Guid, SemaphoreSlim> _gates = new();

  public WikiSyncService(InMemoryStore store, WikiCredentialStore creds, IWikiClock clock,
    Func<string, string?, HttpMessageHandler?>? handlerFactory = null)
  {
    _store = store; _creds = creds; _clock = clock;
    _handlerFactory = handlerFactory ?? ((_, __) => null);
  }

  private SemaphoreSlim Gate(Guid id) => _gates.GetOrAdd(id, _ => new SemaphoreSlim(1, 1));

  private WikiResource? Snapshot(Guid id)
    => _store.WikiResources.TryGetValue(id, out var r) ? r : null;

  // Immutable coherent snapshot captured under the writers' configuration boundary.
  // Origin + credential + revision + generation + rules + scope are copied while
  // holding SetupLock (the same boundary all writers mutate under), the token is
  // read, and the row is re-verified under that same lock with no awaits inside,
  // so no interleaving can pair one origin with another origin's credential.
  private sealed record WikiCapture(
    long Revision, long Generation, string Origin, Guid BoardId, string Scope, Guid? MeetingId,
    string Token, string Caller,
    List<string> Allow, List<string> Excl, List<string> Tags, string Locale,
    string? CallerToken);

  private enum CommitOutcome { CommittedChanged, CommittedUnchanged, StaleDiscarded, Failed }

  private (WikiCapture? cap, long rev, long gen, string? error, int status) CaptureUnderLock(Guid resourceId, string caller, string? callerToken = null)
  {
    lock (_store.SetupLock)
    {
      if (!_store.WikiResources.TryGetValue(resourceId, out var r)) return (null, 0, 0, "Wiki resource not found.", 404);
      var rev = r.ConfigRevision; var gen = r.AttemptGeneration;
      if (!r.Enabled) return (null, rev, gen, "Resource is disabled; enable it to sync.", 409);
      var origin = r.BaseUrl ?? "";
      string? token;
      try { token = _creds.GetToken(resourceId); }
      catch (Exception ex) { return (null, rev, gen, WikiUrl.SafeError(ex), 502); }
      // Re-verify under the SAME lock: writers mutate only under this boundary.
      if (!_store.WikiResources.TryGetValue(resourceId, out var r2) || !r2.Enabled
        || r2.ConfigRevision != rev || r2.AttemptGeneration != gen
        || !string.Equals(r2.BaseUrl ?? "", origin, StringComparison.Ordinal))
        return (null, rev, gen, "Resource was reconfigured during sync; staged results discarded.", 409);
      if (string.IsNullOrEmpty(token))
        return (null, rev, gen, "Resource credential is missing; reconfigure the credential.", 502);
      // Required configuration is enforced at sync time as well as at enable:
      // an enabled resource with blanked required fields can never fetch (F8).
      if (string.IsNullOrWhiteSpace(r2.Description) || string.IsNullOrWhiteSpace(r2.AllowedUse)
        || WikiRules.ParseList(r2.AllowlistJson).Count == 0)
        return (null, rev, gen, "Resource configuration incomplete; reconfigure description, allowed use, and allowlist, then re-enable.", 502);
      r2.AttemptStatus = "running"; r2.UpdatedAt = _clock.UtcNow;
      try { _store.WikiResources.Flush(); }
      catch (Exception ex)
      {
        try
        {
          if (_store.WikiResources.TryGetValue(resourceId, out var r3) && r3.ConfigRevision == rev && r3.AttemptGeneration == gen)
          { r3.AttemptStatus = "idle"; try { _store.WikiResources.Flush(); } catch { } }
        }
        catch { }
        return (null, rev, gen, WikiUrl.SafeError(ex), 502);
      }
      var scope = (r2.Scope ?? "board").Trim().ToLowerInvariant() == "meeting" ? "meeting" : "board";
      return (new WikiCapture(rev, gen, origin, r2.BoardId, scope, scope == "meeting" ? r2.MeetingId : null,
        token, caller,
        WikiRules.ParseList(r2.AllowlistJson), WikiRules.ParseList(r2.ExclusionsJson),
        WikiRules.ParseList(r2.RequiredTagsJson), r2.Locale ?? "", callerToken), rev, gen, null, 200);
    }
  }

  // Manual trigger with caller identity; scheduled triggers pass isScheduled=true and callerUser="system".
  public async Task<(bool ok, string? error, int status)> SyncAsync(Guid resourceId, string reason, string? callerUser = null, bool isScheduled = false, CancellationToken ct = default, string? callerToken = null)
  {
    var gate = Gate(resourceId);
    if (!gate.Wait(0)) return (false, "A sync is already running for this resource; wait for it to finish.", 409);
    try { return await RunAsync(resourceId, reason, callerUser, isScheduled, ct, callerToken).ConfigureAwait(false); }
    finally { gate.Release(); }
  }

  private async Task<(bool ok, string? error, int status)> RunAsync(Guid resourceId, string reason, string? callerUser, bool isScheduled, CancellationToken ct, string? callerToken = null)
  {
    // Whole-operation deadline starts BEFORE DNS/headers and covers
    // headers+body+parse+staging+commit. Checked again before commit.
    using var wholeCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
    wholeCts.CancelAfter(WholeSyncTimeout);
    var wct = wholeCts.Token;
    // Immutable coherent capture under the writers' boundary (F1): origin +
    // credential + revision + generation + rules + scope are copied while holding
    // SetupLock, with the token read and re-verified under that same lock.
    var (cap, rev0, gen0, capError, capStatus) = CaptureUnderLock(resourceId, (callerUser ?? "").Trim(), callerToken);
    if (cap is null)
    {
      if (capStatus == 502)
      {
        EndAttempt(resourceId, rev0, gen0);
        return await FailAsync(resourceId, rev0, gen0, capError ?? "Wiki sync failed.", reason).ConfigureAwait(false);
      }
      return (false, capError, capStatus);
    }
    var capturedRevision = cap.Revision;
    var capturedGen = cap.Generation;
    var capturedOrigin = cap.Origin;
    var capturedBoard = cap.BoardId;
    var capturedScope = cap.Scope;
    var capturedMeeting = cap.MeetingId;
    var capturedCaller = cap.Caller;
    WikiGraphQlClient client;
    try { client = new WikiGraphQlClient(cap.Origin, cap.Token, _handlerFactory(cap.Origin, reason)); }
    catch (Exception ex)
    {
      EndAttempt(resourceId, capturedRevision, capturedGen);
      return await FailAsync(resourceId, capturedRevision, capturedGen, WikiUrl.SafeError(ex), reason).ConfigureAwait(false);
    }
    // Each attempt owns its transport; disposal is verified by fixture
    // connection accounting (F15). Disposes on every return path and on throw.
    using var ownedClient = client;
    // Origin binding: client must target exactly the captured origin.
    if (!string.Equals(client.Origin.TrimEnd('/'), capturedOrigin.TrimEnd('/'), StringComparison.Ordinal))
    {
      EndAttempt(resourceId, capturedRevision, capturedGen);
      return await FailAsync(resourceId, capturedRevision, capturedGen, "Wiki origin binding mismatch; sync discarded.", reason).ConfigureAwait(false);
    }
    List<WikiListItem> listed;
    try { listed = await client.ListPagesAsync(cap.Tags, cap.Locale ?? "", wct).ConfigureAwait(false); }
    catch (WikiGraphQlException ex)
    {
      EndAttempt(resourceId, capturedRevision, capturedGen);
      return await FailAsync(resourceId, capturedRevision, capturedGen, ex.Message, reason, MapStatus(ex)).ConfigureAwait(false);
    }
    catch (OperationCanceledException)
    {
      EndAttempt(resourceId, capturedRevision, capturedGen);
      return await FailAsync(resourceId, capturedRevision, capturedGen, "Wiki fetch timed out (whole-operation deadline).", reason, 504).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      EndAttempt(resourceId, capturedRevision, capturedGen);
      return await FailAsync(resourceId, capturedRevision, capturedGen, WikiUrl.SafeError(ex), reason).ConfigureAwait(false);
    }
    // Every downloaded byte counts toward the whole-sync bound, including the
    // catalog response itself (F13).
    if (client.TotalResponseBytes > MaxAggregateBytes)
    {
      EndAttempt(resourceId, capturedRevision, capturedGen);
      return await FailAsync(resourceId, capturedRevision, capturedGen, "Wiki sync exceeds the 8 MiB aggregate bound; narrow the allowlist.", reason).ConfigureAwait(false);
    }
    // Ownership recheck after list: still current origin/revision/generation/enabled?
    if (!OwnsAttempt(resourceId, capturedRevision, capturedGen, capturedOrigin))
    {
      EndAttempt(resourceId, capturedRevision, capturedGen);
      return (false, "Resource was reconfigured during sync; staged results discarded.", 409);
    }
    if (listed.Count > MaxPages)
    {
      EndAttempt(resourceId, capturedRevision, capturedGen);
      return await FailAsync(resourceId, capturedRevision, capturedGen, "Wiki returned " + listed.Count + " pages; the bounded connector syncs at most 100. Narrow allowlist/exclusions or required tags and retry.", reason).ConfigureAwait(false);
    }
    // Local rule enforcement on LIST metadata (never trust server filter alone).
    var allow = cap.Allow;
    var excl = cap.Excl;
    var reqTags = cap.Tags;
    var locale = cap.Locale ?? "";
    var selected = new List<WikiListItem>();
    foreach (var item in listed)
    {
      var norm = WikiRules.NormalizePath(item.Path);
      if (norm is null) continue; // ambiguous server path: fail closed for that page (exclude)
      if (!WikiRules.PageAllowed(norm, item.Locale ?? "", item.Tags ?? new(), allow, excl, locale, reqTags)) continue;
      selected.Add(item);
    }
    var staged = new List<WikiStagedPage>();
    var aggregate = 0; // decoded content bytes
    var responseBytes = (int)Math.Min(client.TotalResponseBytes, int.MaxValue);
    foreach (var item in selected)
    {
      if (wct.IsCancellationRequested || ct.IsCancellationRequested)
      {
        EndAttempt(resourceId, capturedRevision, capturedGen);
        return await FailAsync(resourceId, capturedRevision, capturedGen, "Wiki fetch timed out (whole-operation deadline).", reason, 504).ConfigureAwait(false);
      }
      // Re-read enabled/revision/generation/origin BEFORE EACH page-content fetch.
      var cur = Snapshot(resourceId);
      if (cur is null) { EndAttempt(resourceId, capturedRevision, capturedGen); return (false, "Wiki resource was deleted during sync; staged results discarded.", 409); }
      if (!cur.Enabled || cur.ConfigRevision != capturedRevision || cur.AttemptGeneration != capturedGen
        || !string.Equals(cur.BaseUrl ?? "", capturedOrigin, StringComparison.Ordinal))
      { EndAttempt(resourceId, capturedRevision, capturedGen); return (false, "Resource was reconfigured during sync; staged results discarded.", 409); }
      if (!string.Equals(_creds.GetToken(resourceId) ?? "", cap.Token ?? "", StringComparison.Ordinal))
      { EndAttempt(resourceId, capturedRevision, capturedGen); return (false, "Resource credential changed during sync; staged results discarded.", 409); }
      WikiPage page; int singleBytes;
      try { (page, singleBytes) = await client.SinglePageAsync(item.Id, wct).ConfigureAwait(false); }
      catch (WikiGraphQlException ex)
      {
        EndAttempt(resourceId, capturedRevision, capturedGen);
        return await FailAsync(resourceId, capturedRevision, capturedGen, ex.Message, reason, MapStatus(ex)).ConfigureAwait(false);
      }
      catch (OperationCanceledException)
      {
        EndAttempt(resourceId, capturedRevision, capturedGen);
        return await FailAsync(resourceId, capturedRevision, capturedGen, "Wiki fetch timed out (whole-operation deadline).", reason, 504).ConfigureAwait(false);
      }
      catch (Exception ex)
      {
        EndAttempt(resourceId, capturedRevision, capturedGen);
        return await FailAsync(resourceId, capturedRevision, capturedGen, WikiUrl.SafeError(ex), reason).ConfigureAwait(false);
      }
      // Aggregate accounting covers EVERY downloaded response — including pages
      // whose freshly fetched metadata fails the rule recheck below — before any
      // continue, so rejected singles cannot bypass the bound (F13).
      var bytes = Encoding.UTF8.GetByteCount(page.Content ?? "");
      aggregate += bytes;
      responseBytes += singleBytes;
      if (aggregate + responseBytes > MaxAggregateBytes || client.TotalResponseBytes > MaxAggregateBytes)
      {
        EndAttempt(resourceId, capturedRevision, capturedGen);
        return await FailAsync(resourceId, capturedRevision, capturedGen, "Wiki sync exceeds the 8 MiB aggregate bound; narrow the allowlist.", reason).ConfigureAwait(false);
      }
      // Strict identity + rule recheck on FRESHLY fetched single metadata.
      var normFetched = WikiRules.NormalizePath(page.Path);
      if (normFetched is null)
      {
        EndAttempt(resourceId, capturedRevision, capturedGen);
        return await FailAsync(resourceId, capturedRevision, capturedGen, "Wiki returned an ambiguous page path for id " + item.Id + "; sync failed closed.", reason).ConfigureAwait(false);
      }
      if (!WikiRules.PageAllowed(normFetched, page.Locale ?? "", page.Tags ?? new(), WikiRules.ParseList(cur.AllowlistJson), WikiRules.ParseList(cur.ExclusionsJson), cur.Locale ?? "", WikiRules.ParseList(cur.RequiredTagsJson)))
        continue; // freshly fetched single metadata no longer passes: exclude, not commit
      if (bytes > MaxBytesPerPage)
      {
        EndAttempt(resourceId, capturedRevision, capturedGen);
        return await FailAsync(resourceId, capturedRevision, capturedGen, "Wiki page exceeds the 256 KiB per-page bound; narrow the allowlist to smaller pages.", reason).ConfigureAwait(false);
      }
      var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(page.Content ?? ""))).ToLowerInvariant();
      var scope = (cur.Scope ?? "board").Trim().ToLowerInvariant() == "meeting" ? "meeting" : "board";
      Guid? meeting = scope == "meeting" ? cur.MeetingId : null;
      var family = WikiRules.FamilyKeyFor(cur.BoardId, scope, meeting, cur.Id, (page.Locale ?? "").Trim(), normFetched);
      staged.Add(new WikiStagedPage(page with { Path = normFetched }, normFetched, family, hash, singleBytes));
    }
    // Duplicate identity guard: two returned pages must never share one family key.
    var dup = staged.GroupBy(s => s.FamilyKey, StringComparer.Ordinal).FirstOrDefault(g => g.Count() > 1);
    if (dup is not null)
    {
      EndAttempt(resourceId, capturedRevision, capturedGen);
      return await FailAsync(resourceId, capturedRevision, capturedGen, "Wiki returned duplicate page identity; sync failed closed.", reason).ConfigureAwait(false);
    }
    // Immediately before commit: cancellation/deadline + revision/enabled + scope parent.
    if (wct.IsCancellationRequested || ct.IsCancellationRequested)
    {
      EndAttempt(resourceId, capturedRevision, capturedGen);
      return await FailAsync(resourceId, capturedRevision, capturedGen, "Wiki fetch timed out (whole-operation deadline before commit).", reason, 504).ConfigureAwait(false);
    }
    var pre = Snapshot(resourceId);
    if (pre is null) { EndAttempt(resourceId, capturedRevision, capturedGen); return (false, "Wiki resource was deleted during sync; staged results discarded.", 409); }
    if (!pre.Enabled || pre.ConfigRevision != capturedRevision || pre.AttemptGeneration != capturedGen
      || !string.Equals(pre.BaseUrl ?? "", capturedOrigin, StringComparison.Ordinal))
    { EndAttempt(resourceId, capturedRevision, capturedGen); return (false, "Resource was reconfigured during sync; staged results discarded.", 409); }
    if ((pre.Scope ?? "board").Trim().ToLowerInvariant() == "meeting")
    {
      if (!pre.MeetingId.HasValue || !_store.Meetings.TryGetValue(pre.MeetingId.Value, out var mtg) || mtg.BoardId != pre.BoardId)
      {
        EndAttempt(resourceId, capturedRevision, capturedGen);
        return await FailAsync(resourceId, capturedRevision, capturedGen, "Resource meeting scope is invalid; pick a valid meeting.", reason).ConfigureAwait(false);
      }
    }
    // Authority is enforced inside the atomic commit unit (CommitLocked);
    // resource revision is not authorization state (F2).
    CommitOutcome outcome;
    string commitFail = ""; int commitFailStatus = 502;
    try
    {
      outcome = CommitAsync(resourceId, cap, staged, reason, isScheduled, wct, ct, out commitFail, out commitFailStatus);
    }
    catch (Exception ex)
    {
      // Commit/index/storage failure finalizes the still-owned attempt as
      // failed (fail-closed); partial state never reports success (F3).
      EndAttempt(resourceId, capturedRevision, capturedGen);
      return await FailAsync(resourceId, capturedRevision, capturedGen, WikiUrl.SafeError(ex), reason).ConfigureAwait(false);
    }
    if (outcome == CommitOutcome.Failed)
    {
      EndAttempt(resourceId, capturedRevision, capturedGen);
      return await FailAsync(resourceId, capturedRevision, capturedGen, commitFail, reason, commitFailStatus).ConfigureAwait(false);
    }
    EndAttempt(resourceId, capturedRevision, capturedGen);
    if (outcome == CommitOutcome.StaleDiscarded)
      return (false, "Resource was reconfigured during sync; staged results discarded.", 409);
    return (true, null, 200);
  }

  private bool OwnsAttempt(Guid id, long revision, long gen, string origin)
  {
    if (!_store.WikiResources.TryGetValue(id, out var cur)) return false;
    if (!cur.Enabled) return false;
    if (cur.ConfigRevision != revision) return false;
    if (cur.AttemptGeneration != gen) return false;
    if (!string.Equals(cur.BaseUrl ?? "", origin, StringComparison.Ordinal)) return false;
    return true;
  }

  private void EndAttempt(Guid id, long revision, long gen)
  {
    try
    {
      if (_store.WikiResources.TryGetValue(id, out var r) && r.ConfigRevision == revision && r.AttemptGeneration == gen)
      {
        r.AttemptStatus = "idle"; r.UpdatedAt = _clock.UtcNow;
        try { _store.WikiResources.Flush(); } catch { }
      }
    }
    catch { }
  }

  // Upstream Wiki auth/permission failures are CONNECTOR failures (502 with a
  // distinct safe code), never application 401/403 which would log the user
  // out or confuse session/auth errors. Local app auth keeps 401/403.
  private static int MapStatus(WikiGraphQlException ex)
  {
    if (ex.Kind == "timeout") return 504;
    return 502;
  }

  private async Task<(bool ok, string? error, int status)> FailAsync(Guid resourceId, long revision, long gen, string error, string reason, int status = 502)
  {
    await Task.Yield();
    if (!_store.WikiResources.TryGetValue(resourceId, out var r)) return (false, error, status);
    // Fast discard for obviously stale attempts: no audit, no pause, no schedule change (F5).
    if (r.ConfigRevision != revision || r.AttemptGeneration != gen || !r.Enabled)
      return (false, "Resource was reconfigured during sync; staged results discarded.", 409);
    // Ownership is rechecked INSIDE the boundary; the failure is recorded,
    // meetings paused, and the audit written ONLY when actually applied.
    // A stale completion arriving after disable/reconfigure changes nothing.
    var changed = SourceGovernance.MutateEvidenceIfChanged(_store, r.BoardId, "wiki.sync-failed " + r.Id + " " + reason, () =>
    {
      if (!_store.WikiResources.TryGetValue(resourceId, out var cur)) return false;
      if (cur.ConfigRevision != revision || cur.AttemptGeneration != gen || !cur.Enabled) return false;
      cur.LastStatus = "failed"; cur.LastError = error; cur.LastCompletedAt = _clock.UtcNow;
      cur.AttemptStatus = "idle";
      // Manual-only resources are never scheduled: the timestamp stays null on
      // every result, including failure (F14). No one-year placeholder.
      cur.NextSyncAt = cur.ManualOnly ? null : _clock.UtcNow.AddMinutes(Math.Max(5, cur.SyncIntervalMinutes));
      cur.UpdatedAt = _clock.UtcNow;
      _store.WikiResources.Flush();
      return true;
    });
    if (!changed)
      return (false, "Resource was reconfigured during sync; staged results discarded.", 409);
    try { _store.Audit.Add(new AuditEvent { BoardId = r.BoardId, Action = "wiki.sync-failed", Detail = JsonSerializer.Serialize(new { resource = r.Id, revision, error }) }); } catch { }
    return (false, error, status);
  }

  // Single atomic commit gate (F2/F3/F4/F5/F13): every staged page was fully
  // fetched, validated, and index-staged BEFORE this call; nothing new is
  // published until this unit runs. Under SetupLock (+Atomic for PG rollback)
  // it revalidates ownership, authority, deadline, and meeting scope, then
  // inserts docs + sections + health in one unit. Only CommittedChanged pauses
  // meetings (via the caller) and audits; unchanged/stale outcomes change no
  // meeting state, generation, audit, or success log.
  private CommitOutcome CommitAsync(Guid resourceId, WikiCapture cap, List<WikiStagedPage> staged, string reason, bool isScheduled, CancellationToken wct, CancellationToken ct, out string failError, out int failStatus)
  {
    string localFail = ""; int localStatus = 502;
    CommitOutcome outcome = CommitOutcome.StaleDiscarded;
    lock (_store.SetupLock)
    {
      outcome = Atomic.Run(_store, () => CommitLocked(resourceId, cap, staged, reason, isScheduled, wct, ct, out localFail, out localStatus));
      if (outcome == CommitOutcome.CommittedChanged)
        SourceGovernance.InvalidateBoardUnderSetupLock(_store, cap.BoardId, "wiki.sync-success " + resourceId + " " + reason);
    }
    if (outcome == CommitOutcome.CommittedChanged)
      try { Atomic.Audit(_store, new AuditEvent { BoardId = cap.BoardId, Action = "wiki.sync-success", Detail = JsonSerializer.Serialize(new { resource = resourceId, revision = cap.Revision, pages = staged.Count }) }); } catch { }
    failError = localFail; failStatus = localStatus;
    return outcome;
  }

  private static SourceDoc RepairTemplate(SourceDoc existing, WikiStagedPage sp)
  {
    // Rebuild extraction from freshly fetched content while preserving the
    // existing row's version/hash/family/generation, so staged replacement
    // sections satisfy HasValidSections for that exact row.
    return new SourceDoc
    {
      Id = existing.Id, BoardId = existing.BoardId, FileName = existing.FileName,
      ContentHash = existing.ContentHash, Version = existing.Version, Approved = existing.Approved,
      Excluded = existing.Excluded, ReviewState = existing.ReviewState, Origin = existing.Origin,
      ResourceId = existing.ResourceId, FamilyKey = existing.FamilyKey, Scope = existing.Scope,
      MeetingId = existing.MeetingId, IndexState = existing.IndexState, IndexGeneration = existing.IndexGeneration,
      ExtractionJson = Extraction.ToJson(new Extraction.Result("ok", sp.Page.Content, null)),
      Original = Encoding.UTF8.GetBytes(sp.Page.Content ?? ""),
      CreatedAt = existing.CreatedAt,
    };
  }

  private CommitOutcome CommitLocked(Guid resourceId, WikiCapture cap, List<WikiStagedPage> staged, string reason, bool isScheduled, CancellationToken wct, CancellationToken ct, out string failError, out int failStatus)
  {
    failError = ""; failStatus = 502;
    if (!_store.WikiResources.TryGetValue(resourceId, out var cur) || !cur.Enabled
      || cur.ConfigRevision != cap.Revision || cur.AttemptGeneration != cap.Generation
      || !string.Equals(cur.BaseUrl ?? "", cap.Origin, StringComparison.Ordinal))
      return CommitOutcome.StaleDiscarded;
    // Authority is rechecked INSIDE the commit boundary (F2): resource revision
    // is not authorization state. Manual callers must still hold manage rights
    // at this exact point; scheduled system work is distinct.
    if (!isScheduled)
    {
      if (string.IsNullOrWhiteSpace(cap.Caller)
        || !WikiAuth.CanManageByUser(_store, cap.BoardId, cap.Scope, cap.MeetingId, cap.Caller))
      { failError = "Wiki sync authorization revoked before commit; staged results discarded."; failStatus = 403; return CommitOutcome.Failed; }
      // Session liveness at commit: a logout/revocation between trigger and
      // commit refuses publication. The token was captured at the endpoint.
      if (SimCEO.Api.PeopleOps.IsSecure(_store))
      {
        var okSess = false;
        try
        {
          if (!string.IsNullOrWhiteSpace(cap.CallerToken)
            && _store.Sessions.TryGetValue(cap.CallerToken, out var sess)
            && sess.ExpiresAt > System.DateTime.UtcNow
            && string.Equals(sess.Email ?? "", cap.Caller ?? "", System.StringComparison.OrdinalIgnoreCase))
            okSess = true;
        }
        catch { }
        if (!okSess)
        { failError = "Wiki sync session ended before commit; staged results discarded."; failStatus = 403; return CommitOutcome.Failed; }
      }
    }
    // Deadline recheck INSIDE the commit boundary, after waiting for the lock:
    // no write happens after expiry (F13).
    if (wct.IsCancellationRequested || ct.IsCancellationRequested)
    { failError = "Wiki fetch timed out (whole-operation deadline)."; failStatus = 504; return CommitOutcome.Failed; }
    // Required configuration is rechecked at commit: an enabled resource with
    // blanked required fields can never become healthy (F8).
    if (string.IsNullOrWhiteSpace(cur.Description) || string.IsNullOrWhiteSpace(cur.AllowedUse)
      || WikiRules.ParseList(cur.AllowlistJson).Count == 0)
    { failError = "Resource configuration incomplete; reconfigure description, allowed use, and allowlist, then re-enable."; failStatus = 502; return CommitOutcome.Failed; }
    if ((cur.Scope ?? "board").Trim().ToLowerInvariant() == "meeting")
    {
      if (!cur.MeetingId.HasValue || !_store.Meetings.TryGetValue(cur.MeetingId.Value, out var mtg) || mtg.BoardId != cur.BoardId)
      { failError = "Resource meeting scope is invalid; pick a valid meeting."; failStatus = 502; return CommitOutcome.Failed; }
    }
    var now = _clock.UtcNow;
    var memberKeys = staged.Select(s => s.FamilyKey).ToList();
    // Validate + build every new/repaired row and its sections BEFORE any
    // insert: a single unindexable page fails the whole attempt (F3/F4).
    var toInsert = new List<(SourceDoc doc, List<SourceSection> secs)>();
    var repairs = new List<(SourceDoc doc, List<SourceSection> secs)>();
    var scope = (cur.Scope ?? "board").Trim().ToLowerInvariant() == "meeting" ? "meeting" : "board";
    Guid? meeting = scope == "meeting" ? cur.MeetingId : null;
    foreach (var sp in staged)
    {
      var same = _store.Sources.Values.FirstOrDefault(x => x.BoardId == cur.BoardId && x.FamilyKey == sp.FamilyKey && x.ContentHash == sp.ContentHash);
      if (same is not null)
      {
        if (SourceGovernance.HasValidSections(_store, same)) continue;
        // Same page + hash but invalid index: repair under reservation (F4).
        if (!SourceGovernance.TryStageIndexSections(RepairTemplate(same, sp), out var rsecs, out _))
        { failError = "Wiki page indexing failed; sync failed closed."; failStatus = 502; return CommitOutcome.Failed; }
        repairs.Add((same, rsecs));
        continue;
      }
      var maxV = _store.Sources.Values.Where(x => x.BoardId == cur.BoardId && x.FamilyKey == sp.FamilyKey).Select(x => (int?)x.Version).Max() ?? 0;
      var doc = new SourceDoc
      {
        BoardId = cur.BoardId, FileName = sp.NormalizedPath, ContentHash = sp.ContentHash,
        Version = maxV + 1, Approved = false, Excluded = false,
        ReviewState = "pending", Origin = "wiki", ResourceId = cur.Id,
        FamilyKey = sp.FamilyKey, Scope = scope, MeetingId = meeting,
        IndexState = "queued", IndexGeneration = 0,
      };
      doc.Original = Encoding.UTF8.GetBytes(sp.Page.Content ?? "");
      doc.ExtractionJson = Extraction.ToJson(new Extraction.Result("ok", sp.Page.Content, null));
      if (!SourceGovernance.TryStageIndexSections(doc, out var dsecs, out _))
      { failError = "Wiki page indexing failed; sync failed closed."; failStatus = 502; return CommitOutcome.Failed; }
      toInsert.Add((doc, dsecs));
    }
    var prevMembers = new HashSet<string>(WikiRules.ParseList(cur.SuccessPagesJson), StringComparer.Ordinal);
    var stagedSet = new HashSet<string>(memberKeys, StringComparer.Ordinal);
    if (prevMembers.SetEquals(stagedSet)
      && string.Equals(cur.LastStatus ?? "", "succeeded", StringComparison.OrdinalIgnoreCase)
      && cur.LastSuccessRevision == cap.Revision
      && toInsert.Count == 0 && repairs.Count == 0)
    {
      // Genuinely unchanged successful refresh: keep previous health, advance
      // schedule only. No meeting pause/generation change, no audit (F5).
      cur.LastStatus = "succeeded"; cur.LastError = "";
      cur.LastCompletedAt = now; cur.LastSuccessAt = cur.LastSuccessAt ?? now;
      cur.LastSuccessRevision = cap.Revision;
      cur.AttemptStatus = "idle";
      cur.NextSyncAt = cur.ManualOnly ? null : now.AddMinutes(Math.Max(5, cur.SyncIntervalMinutes));
      cur.UpdatedAt = now;
      _store.WikiResources.Flush();
      return CommitOutcome.CommittedUnchanged;
    }
    foreach (var (doc, secs) in repairs)
    {
      foreach (var old in _store.SourceSections.Values.Where(x => x.SourceId == doc.Id).ToList())
        _store.SourceSections.TryRemove(old.Id, out _);
      foreach (var sec in secs) _store.SourceSections[sec.Id] = sec;
      doc.IndexState = "completed"; doc.IndexError = ""; doc.IndexCompletedAt = now;
      SourceGovernance.RecordEvent(_store, doc, "wiki-index-repair", "rev" + cap.Revision);
    }
    foreach (var (doc, secs) in toInsert)
    {
      doc.IndexGeneration = 1;
      _store.Sources[doc.Id] = doc;
      foreach (var sec in secs) _store.SourceSections[sec.Id] = sec;
      doc.IndexState = "completed"; doc.IndexError = ""; doc.IndexCompletedAt = now;
      SourceGovernance.RecordEvent(_store, doc, "wiki-import", "rev" + cap.Revision + " " + doc.FileName);
    }
    cur.LastStatus = "succeeded"; cur.LastError = "";
    cur.LastCompletedAt = now; cur.LastSuccessAt = now;
    cur.LastSuccessRevision = cap.Revision;
    cur.SuccessPagesJson = JsonSerializer.Serialize(memberKeys);
    cur.AttemptStatus = "idle";
    cur.NextSyncAt = cur.ManualOnly ? null : now.AddMinutes(Math.Max(5, cur.SyncIntervalMinutes));
    cur.UpdatedAt = now;
    _store.WikiResources.Flush(); _store.Sources.Flush(); _store.SourceSections.Flush(); _store.SourceEvents.Flush();
    return CommitOutcome.CommittedChanged;
  }

}

// Server schedule: normal hosted service + clock + same SyncAsync. Persisted
// NextSyncAt/attempt/status safe restart, single flight, no overlapping
// duplicate effects. Manual-only resources are never auto-synced.
public sealed class WikiSyncHostedService : BackgroundService
{
  private readonly IServiceProvider _sp;
  private readonly IWikiClock _clock;
  public WikiSyncHostedService(IServiceProvider sp, IWikiClock clock) { _sp = sp; _clock = clock; }

  protected override async Task ExecuteAsync(CancellationToken stoppingToken)
  {
    // On startup, reset orphaned attempt markers to idle (safe restart) WITHOUT
    // inventing evidence health: failed stays failed, succeeded stays usable.
    try
    {
      using var scope0 = _sp.CreateScope();
      var store0 = scope0.ServiceProvider.GetRequiredService<InMemoryStore>();
      foreach (var r in store0.WikiResources.Values.Where(x => x.AttemptStatus == "running").ToList())
      {
        r.AttemptStatus = "idle";
        if (r.LastStatus == "running") r.LastStatus = "pending";
        if (!r.NextSyncAt.HasValue || r.NextSyncAt.Value <= _clock.UtcNow) r.NextSyncAt = r.ManualOnly ? null : _clock.UtcNow.AddMinutes(1);
      }
      try { store0.WikiResources.Flush(); } catch { }
    }
    catch { }
    while (!stoppingToken.IsCancellationRequested)
    {
      try
      {
        using var scope = _sp.CreateScope();
        var store = scope.ServiceProvider.GetRequiredService<InMemoryStore>();
        var sync = scope.ServiceProvider.GetRequiredService<WikiSyncService>();
        var now = _clock.UtcNow;
        var due = store.WikiResources.Values
          .Where(r => r.Enabled && !r.ManualOnly && (r.NextSyncAt ?? DateTime.MinValue) <= now && r.AttemptStatus != "running")
          .OrderBy(r => r.NextSyncAt ?? DateTime.MinValue).Take(4).Select(r => r.Id).ToList();
        foreach (var id in due)
        {
          if (stoppingToken.IsCancellationRequested) break;
          try { await sync.SyncAsync(id, "schedule", "system", true, stoppingToken).ConfigureAwait(false); }
          catch { }
        }
      }
      catch { }
      try { await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken).ConfigureAwait(false); }
      catch { break; }
    }
  }
}


