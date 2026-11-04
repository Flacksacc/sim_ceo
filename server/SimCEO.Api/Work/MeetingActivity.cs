// MeetingActivity: server-authoritative, per-meeting responding activity for the
// participant-rail UI plus requester-scoped secretary activity. All states are
// derived ONLY from actual run/request transitions (queued after the run
// semaphore is acquired, considering after a bid slot is acquired, responding
// after a draft slot is acquired, complete/failed/abstained at publication,
// terminal run/request outcomes). No global pending flag, no percentages, no
// timer progress, no message contents, no secrets in payloads or events.
//
// Discussion activity is board-visible (authorized read on the meeting).
// Secretary activity is private: snapshot and events reveal an entry ONLY to
// the requesting user key. Meeting-only guests keep their existing read scope
// for discussion and see none of another user's secretary entries.
//
// Operation identity guards every terminal write: Finish* only applies when
// the caller operation/attempt still owns the entry, so a late old finally
// can never clear a newer run. Restart marks in-memory running entries
// interrupted instead of leaving endless busy.
using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Hubs;

namespace SimCEO.Api.Work;

public static class MeetingActivity
{
  public const string DiscussionRunning = "running";
  public const string DiscussionCompleted = "completed";
  public const string DiscussionInterrupted = "interrupted";
  public const string DiscussionFailed = "failed";

  public const string AdvisorQueued = "queued";
  public const string AdvisorConsidering = "considering";
  public const string AdvisorResponding = "responding";
  public const string AdvisorAwaitingSelection = "awaiting-selection";
  public const string AdvisorAwaitingPublication = "awaiting-publication";
  public const string AdvisorComplete = "complete";
  public const string AdvisorFailed = "failed";
  public const string AdvisorAbstained = "abstained";

  public sealed record AdvisorView(Guid AdvisorId, string BoardRole, string State, string? Reason, DateTime UpdatedAt);

  private sealed class DiscussionEntry
  {
    public Guid MeetingId;
    public Guid BoardId;
    public Guid OperationId;
    public Guid RestoreEpoch;
    public long Generation;
    public long LeadSeq;
    public string Status = DiscussionRunning;
    public string Phase = "selecting";
    public string? Error;
    public DateTime UpdatedAt = DateTime.UtcNow;
    public Dictionary<Guid, AdvisorView> Advisors = new();
  }

  private sealed class SecretaryEntry
  {
    public Guid RequestId;
    public Guid MeetingId;
    public Guid BoardId;
    public Guid AttemptId;
    public Guid RestoreEpoch;
    public string RequesterKey = "";
    public string ClientNonce = "";
    public string Status = "pending";
    public string Phase = "";
    public long Generation;
    public DateTime UpdatedAt = DateTime.UtcNow;
  }

  private static readonly ConcurrentDictionary<Guid, DiscussionEntry> Discussions = new();
  private static readonly ConcurrentDictionary<Guid, SecretaryEntry> Secretaries = new();

  private static int AdvisorRank(string s) => s switch
  {
    AdvisorQueued => 0,
    AdvisorConsidering => 1,
    AdvisorAwaitingSelection => 1,
    AdvisorResponding => 2,
    AdvisorAwaitingPublication => 2,
    _ => 3,
  };

  private static bool IsTerminalAdvisor(string s) => AdvisorRank(s) >= 3;

  private static void Prune()
  {
    try
    {
      if (Discussions.Count > 500)
      {
        foreach (var kv in Discussions.OrderBy(kv => kv.Value.UpdatedAt).Take(Discussions.Count - 500).ToList())
        {
          if (kv.Value.Status != DiscussionRunning) Discussions.TryRemove(kv.Key, out _);
        }
      }
      if (Secretaries.Count > 2000)
      {
        foreach (var kv in Secretaries.OrderBy(kv => kv.Value.UpdatedAt).Take(Secretaries.Count - 2000).ToList())
        {
          var st = kv.Value.Status;
          if (st != "pending" && st != "inflight" && st != "answering" && st != "uncertain") Secretaries.TryRemove(kv.Key, out _);
        }
      }
    }
    catch { }
  }
  // Called once, immediately after the run semaphore (RunningRuns.Add) is held
  // and eligible advisors are known. Never called for rejected/empty runs, so
  // no advisor is ever marked from a global pending flag.
  public static void DiscussionStarted(InMemoryStore s, Guid meetingId, Guid boardId,
    Guid operationId, long generation, long leadSeq, IEnumerable<BoardAdvisor> eligible,
    Guid restoreEpoch)
  {
    if (operationId == Guid.Empty) return;
    var entry = new DiscussionEntry
    {
      MeetingId = meetingId, BoardId = boardId, OperationId = operationId,
      RestoreEpoch = restoreEpoch,
      Generation = generation, LeadSeq = leadSeq, Status = DiscussionRunning,
      UpdatedAt = DateTime.UtcNow,
    };
    try
    {
      foreach (var a in eligible)
        entry.Advisors[a.Id] = new AdvisorView(a.Id, a.BoardRole ?? "", AdvisorQueued, null, DateTime.UtcNow);
    }
    catch { }
    Discussions[meetingId] = entry;
    Prune();
  }

  // Per-advisor transition with forward-only guard: a late stale callback can
  // never move a terminal advisor back to considering/responding, and an old
  // operation id can never touch a newer run entry.
  public static void SetAdvisor(Guid meetingId, Guid operationId, Guid advisorId,
    string boardRole, string state, string? reason)
  {
    try
    {
      if (operationId == Guid.Empty) return;
      if (!Discussions.TryGetValue(meetingId, out var e) || e is null) return;
      lock (e)
      {
        if (e.OperationId != operationId) return;
        if (e.Status != DiscussionRunning) return;
        if (e.Advisors.TryGetValue(advisorId, out var cur) && IsTerminalAdvisor(cur.State) && !IsTerminalAdvisor(state))
          return;
        e.Advisors[advisorId] = new AdvisorView(advisorId, string.IsNullOrWhiteSpace(boardRole) ? (cur?.BoardRole ?? "") : boardRole, state, reason, DateTime.UtcNow);
        e.UpdatedAt = DateTime.UtcNow;
      }
    }
    catch { }
  }

  public static void SelectionFinished(Guid meetingId, Guid operationId)
  {
    if (!Discussions.TryGetValue(meetingId, out var e)) return;
    lock (e) if (e.OperationId == operationId && e.Status == DiscussionRunning && e.Phase == "selecting")
    { e.Phase = "responding"; e.UpdatedAt = DateTime.UtcNow; }
  }

  // An explicit second wave may move completed first replies back to queued.
  // All first-wave tasks have finished before this call; old operations cannot reset it.
  public static void ReviewStarted(Guid meetingId, Guid operationId, IReadOnlyList<BoardAdvisor> advisors)
  {
    if (!Discussions.TryGetValue(meetingId, out var e)) return;
    lock (e)
    {
      if (e.OperationId != operationId || e.Status != DiscussionRunning || e.Phase != "responding") return;
      e.Phase = "reviewing";
      foreach (var a in advisors) e.Advisors[a.Id] = new AdvisorView(a.Id, a.BoardRole, AdvisorQueued, null, DateTime.UtcNow);
      e.UpdatedAt = DateTime.UtcNow;
    }
  }

  // After bidding: provider errors fail, declined bids abstain, already-replied
  // advisors abstain with their exact reason, willing but unselected advisors
  // abstain with the durable cap reason. Selected willing advisors waiting for
  // a draft slot are marked awaiting-selection (backstop: per-task updates
  // normally set this at each bid completion).
  public static void SyncSelection(Guid meetingId, Guid operationId,
    IReadOnlyList<(Guid id, string role, double score, string? error)> bids, HashSet<Guid> selectedIds,
    HashSet<Guid>? alreadyRepliedIds = null)
  {
    try
    {
      foreach (var b in bids)
      {
        if (b.error is not null) SetAdvisor(meetingId, operationId, b.id, b.role, AdvisorFailed, "provider-error");
        else if (b.score <= 0) SetAdvisor(meetingId, operationId, b.id, b.role, AdvisorAbstained, "not-selected");
        else if (alreadyRepliedIds is not null && alreadyRepliedIds.Contains(b.id)) SetAdvisor(meetingId, operationId, b.id, b.role, AdvisorAbstained, "already-replied-this-turn");
        else if (!selectedIds.Contains(b.id)) SetAdvisor(meetingId, operationId, b.id, b.role, AdvisorAbstained, "cap-omitted");
        else SetAdvisor(meetingId, operationId, b.id, b.role, AdvisorAwaitingSelection, null);
      }
    }
    catch { }
  }

  // After each draft batch resolves (before commit): provider/packet failures
  // and explicit ABSTAIN are terminal for that advisor; the rest stay
  // responding until the commit unit publishes or yields them.
  public static void SyncDraftOutcome(Guid meetingId, Guid operationId,
    IReadOnlyList<(Guid id, string role, string? text, string? error)> drafts)
  {
    try
    {
      foreach (var d in drafts)
      {
        if (d.error is not null || d.text is null)
          SetAdvisor(meetingId, operationId, d.id, d.role, AdvisorFailed, "provider-error");
        else if (string.IsNullOrWhiteSpace(d.text) || d.text.TrimStart().StartsWith("ABSTAIN", StringComparison.OrdinalIgnoreCase))
          SetAdvisor(meetingId, operationId, d.id, d.role, AdvisorAbstained, "abstained");
      }
    }
    catch { }
  }

  // After each round commit: published advisors complete; newly yielded
  // advisors fail (provider/evidence) or abstain with the recorded reason.
  public static void SyncRoundCommit(Guid meetingId, Guid operationId,
    IReadOnlyList<(Guid id, string role)> round, HashSet<Guid> committedIds,
    IReadOnlyList<(string advisor, string reason)> newYields)
  {
    try
    {
      var yieldMap = new Dictionary<string, string>(StringComparer.Ordinal);
      foreach (var y in newYields)
        if (!string.IsNullOrWhiteSpace(y.advisor) && !yieldMap.ContainsKey(y.advisor))
          yieldMap[y.advisor] = y.reason ?? "yielded";
      foreach (var (aid, role) in round)
      {
        if (committedIds.Contains(aid))
        {
          SetAdvisor(meetingId, operationId, aid, role, AdvisorComplete, null);
          continue;
        }
        if (yieldMap.TryGetValue(role, out var reason))
        {
          if (string.Equals(reason, "provider-error", StringComparison.OrdinalIgnoreCase))
            SetAdvisor(meetingId, operationId, aid, role, AdvisorFailed, reason);
          else
            SetAdvisor(meetingId, operationId, aid, role, AdvisorAbstained, reason);
        }
      }
    }
    catch { }
  }
  // Terminal run transition. Applies ONLY when the caller operation still owns
  // the entry, so a late old finally can never clear a newer run. Advisors
  // left non-terminal are closed honestly: completed runs already synced every
  // advisor; leftovers on interrupted/failed runs abstain/fail with a
  // run-level reason instead of freezing in responding.
  public static bool FinishDiscussion(InMemoryStore s, Guid meetingId, Guid operationId,
    string status, string? error)
  {
    try
    {
      if (operationId == Guid.Empty) return false;
      if (!Discussions.TryGetValue(meetingId, out var e) || e is null) return false;
      lock (e)
      {
        if (e.OperationId != operationId) return false;
        if (e.Status != DiscussionRunning) return false;
        e.Status = status;
        e.Phase = status;
        e.Error = error;
        e.UpdatedAt = DateTime.UtcNow;
        foreach (var kv in e.Advisors.ToList())
        {
          if (IsTerminalAdvisor(kv.Value.State)) continue;
          if (string.Equals(status, DiscussionCompleted, StringComparison.Ordinal))
            e.Advisors[kv.Key] = kv.Value with { State = AdvisorAbstained, Reason = "run-ended", UpdatedAt = DateTime.UtcNow };
          else if (string.Equals(status, DiscussionFailed, StringComparison.Ordinal))
            e.Advisors[kv.Key] = kv.Value with { State = AdvisorFailed, Reason = "run-failed", UpdatedAt = DateTime.UtcNow };
          else
            e.Advisors[kv.Key] = kv.Value with { State = AdvisorAbstained, Reason = "run-interrupted", UpdatedAt = DateTime.UtcNow };
        }
        return true;
      }
    }
    catch { return false; }
  }

  public static bool FinishIfRunning(InMemoryStore s, Guid meetingId, Guid operationId,
    string status, string? error)
  {
    try
    {
      if (operationId == Guid.Empty) return false;
      if (!Discussions.TryGetValue(meetingId, out var e) || e is null) return false;
      lock (e)
      {
        if (e.OperationId != operationId || e.Status != DiscussionRunning) return false;
      }
      return FinishDiscussion(s, meetingId, operationId, status, error);
    }
    catch { return false; }
  }

  // ---- Secretary (private, requester-scoped) ----

  // The requester key, restore epoch, and stage are supplied by the caller:
  // the key is captured INSIDE the authorized atomic reservation (never a
  // post-await fallback), so private activity can never be attributed to a
  // spoofed X-User identity. The stage is set BEFORE the first publish for
  // that attempt (initial/inflight, continuation/answering).
  public static void SecretaryStarted(InMemoryStore s, Guid meetingId, Guid boardId,
    Guid requestId, Guid attemptId, string requesterKey, string clientNonce, long generation,
    Guid restoreEpoch, string status, string phase)
  {
    try
    {
      if (requestId == Guid.Empty || attemptId == Guid.Empty) return;
      Secretaries[requestId] = new SecretaryEntry
      {
        RequestId = requestId, MeetingId = meetingId, BoardId = boardId, AttemptId = attemptId,
        RequesterKey = requesterKey ?? "", ClientNonce = clientNonce ?? "",
        Status = string.IsNullOrWhiteSpace(status) ? "inflight" : status,
        Phase = string.IsNullOrWhiteSpace(phase) ? "initial" : phase,
        Generation = generation, RestoreEpoch = restoreEpoch, UpdatedAt = DateTime.UtcNow,
      };
      Prune();
    }
    catch { }
  }

  // Attempt-guarded mirror update: a late old attempt can never overwrite a
  // newer reservation on the same request.
  public static void SecretaryUpdate(Guid requestId, Guid attemptId, string status, string? phase)
  {
    try
    {
      if (requestId == Guid.Empty || attemptId == Guid.Empty) return;
      if (!Secretaries.TryGetValue(requestId, out var e) || e is null) return;
      lock (e)
      {
        if (e.AttemptId != attemptId) return;
        e.Status = status;
        if (phase is not null) e.Phase = phase;
        e.UpdatedAt = DateTime.UtcNow;
      }
    }
    catch { }
  }

  static bool IsSecretaryTerminal(string? st) => st is "completed" or "failed" or "discarded" or "needs-clarification" or "interrupted" or "uncertain";

  static bool IsLiveSecretary(string? st) => st is "pending" or "inflight" or "answering" or "uncertain";

  // Terminal exit boundary for every secretary attempt: reconciles the mirror
  // from the authoritative durable row. A missing row (restored away) removes
  // the orphan mirror; a superseding attempt adopts the row; a terminal row is
  // adopted; a still-live row for this attempt after exit becomes "uncertain"
  // (recovery state unknown: re-read before retrying) instead of busy forever.
  public static void SyncSecretaryExit(InMemoryStore s, Microsoft.AspNetCore.SignalR.IHubContext<BoardHub> hub, Guid meetingId, Guid requestId, Guid attemptId)
  {
    // Phase 1: authoritative row read under RootGate only. A throwing read
    // (storage outage clearing tracking) is recorded, NOT swallowed: the own
    // mirror is still terminalized below.
    Domain.SecretaryRequest? row = null;
    Guid restoreNow = Guid.Empty;
    bool rowReadOk = false;
    try
    {
      lock (s.RootGate)
      {
        s.SecretaryRequests.TryGetValue(requestId, out row);
        restoreNow = s.RestoreEpochId;
      }
      rowReadOk = true;
    }
    catch { rowReadOk = false; }
    // Phase 2: entry-guarded application only (never nested with RootGate).
    // A stale exit (mirror owned by a newer attempt, e.g. a continuation
    // reserved after this attempt ended) must not touch the newer mirror.
    bool removed = false;
    bool skipped = false;
    if (Secretaries.TryGetValue(requestId, out var e) && e is not null)
    {
      lock (e)
      {
        if (e.AttemptId != attemptId) { skipped = true; }
        else if (!rowReadOk)
        {
          if (IsLiveSecretary(e.Status)) { e.Status = "uncertain"; e.UpdatedAt = DateTime.UtcNow; }
        }
        else if (row is null)
        {
          removed = true;
        }
        else if (row.AttemptId != e.AttemptId && row.AnswerAttemptId != e.AttemptId)
        {
          if (e.RestoreEpoch != restoreNow) { e.Status = "discarded"; e.RestoreEpoch = restoreNow; e.UpdatedAt = DateTime.UtcNow; }
        }
        else if (IsSecretaryTerminal(row.Status))
        {
          e.Status = row.Status!; e.Phase = row.Phase ?? e.Phase; e.Generation = row.Generation;
          e.RestoreEpoch = restoreNow; e.UpdatedAt = DateTime.UtcNow;
        }
        else if (IsLiveSecretary(e.Status))
        {
          e.Status = "uncertain"; e.UpdatedAt = DateTime.UtcNow;
        }
      }
      if (removed)
      {
        if (Secretaries.TryGetValue(requestId, out var cur) && ReferenceEquals(cur, e))
          Secretaries.TryRemove(new KeyValuePair<Guid, SecretaryEntry>(requestId, e));
      }
    }
    if (!removed && !skipped) _ = PublishSecretaryAsync(hub, s, meetingId, requestId);
  }

  // Read-boundary reconcile for one secretary entry. Returns false when the
  // entry was removed (restored-away row): callers must exclude it and must
  // not publish for it. A restored world turns a still-live entry into
  // discarded (publication would discard it); terminal entries are adopted.
  static bool ReconcileSecretaryEntry(InMemoryStore s, SecretaryEntry e)
  {
    try
    {
      Domain.SecretaryRequest? row = null;
      Guid restore = Guid.Empty;
      lock (s.RootGate)
      {
        s.SecretaryRequests.TryGetValue(e.RequestId, out row);
        restore = s.RestoreEpochId;
      }
      if (row is null) { Secretaries.TryRemove(e.RequestId, out _); return false; }
      lock (e)
      {
        if (!IsLiveSecretary(e.Status))
        {
          e.RestoreEpoch = restore;
          return true;
        }
        if (e.RestoreEpoch != restore)
        {
          if (e.AttemptId != row.AttemptId && e.AttemptId != row.AnswerAttemptId)
          { e.Status = row.Status ?? "discarded"; e.Phase = row.Phase ?? e.Phase; e.Generation = row.Generation; }
          else { e.Status = "discarded"; }
          e.RestoreEpoch = restore;
          e.UpdatedAt = DateTime.UtcNow;
        }
      }
      return true;
    }
    catch { return true; }
  }

  static void InterruptDiscussionEntry(DiscussionEntry e, string reason)
  {
    e.Status = DiscussionInterrupted;
    e.Phase = DiscussionInterrupted;
    e.Error = reason;
    e.UpdatedAt = DateTime.UtcNow;
    foreach (var kv in e.Advisors.ToList())
    {
      if (IsTerminalAdvisor(kv.Value.State)) continue;
      e.Advisors[kv.Key] = kv.Value with { State = AdvisorAbstained, Reason = "run-interrupted", UpdatedAt = DateTime.UtcNow };
    }
  }

  // Caller must hold RootGate. Pure table reads, no entry locks: safe inside
  // any RootGate-held phase, never the reverse.
  static bool AdvisorEligibleLocked(InMemoryStore s, Guid boardId, BoardAdvisor? adv, out string reason)
  {
    reason = "not-eligible";
    if (adv is null || adv.BoardId != boardId || adv.Removed) return false;
    try
    {
      var gate = SimCEO.Api.RosterOps.ParticipationGate(s, adv);
      if (gate is not null)
      {
        reason = string.Equals(gate, "stale-version", StringComparison.OrdinalIgnoreCase) ? "stale-profile" : "not-eligible";
        return false;
      }
    }
    catch { return false; }
    return true;
  }

  // Read/event-boundary reconcile for discussion: restore identity, meeting
  // state/generation, and per-advisor eligibility are rechecked on every
  // snapshot and event build, so pause/end, a new owner turn, advisor removal,
  // or a restore promptly invalidates stale responding states instead of
  // waiting for provider calls to finish.
  public static void ReconcileDiscussion(InMemoryStore s, Guid meetingId)
  {
    try
    {
      if (!Discussions.TryGetValue(meetingId, out var e) || e is null) return;
      Meeting? m = null;
      // Phase A: entry snapshot under the entry lock only.
      Guid op; Guid eRestore; long eGen; List<(Guid id, string role)> live;
      lock (e)
      {
        if (e.Status != DiscussionRunning) return;
        op = e.OperationId; eRestore = e.RestoreEpoch; eGen = e.Generation;
        live = e.Advisors.Where(kv => !IsTerminalAdvisor(kv.Value.State)).Select(kv => (kv.Key, kv.Value.BoardRole)).ToList();
      }
      // Phase B: authoritative reads under RootGate only (never nested).
      Guid restoreNow = Guid.Empty;
      List<(Guid id, string role, bool eligible, string reason)> checks = new();
      lock (s.RootGate)
      {
        s.Meetings.TryGetValue(meetingId, out m);
        restoreNow = s.RestoreEpochId;
        if (m is not null)
        {
          foreach (var (aid, role) in live)
          {
            s.Advisors.TryGetValue(aid, out var adv);
            var ok = AdvisorEligibleLocked(s, m.BoardId, adv, out var reason);
            checks.Add((aid, role, ok, reason));
          }
        }
      }
      // Phase C: entry-guarded application only (op-guarded: a newer run wins).
      if (m is null)
      {
        if (Discussions.TryGetValue(meetingId, out var cur) && ReferenceEquals(cur, e))
          Discussions.TryRemove(new KeyValuePair<Guid, DiscussionEntry>(meetingId, e));
        return;
      }
      if (restoreNow != eRestore) { FinishDiscussion(s, meetingId, op, "interrupted", "domain was restored during generation"); return; }
      if (m.State is not (MeetingState.Active or MeetingState.AwaitingBrief)) { FinishDiscussion(s, meetingId, op, "interrupted", "meeting is no longer active"); return; }
      if (m.Generation != eGen) { FinishDiscussion(s, meetingId, op, "interrupted", "new owner turn arrived"); return; }
      foreach (var (aid, role, ok, reason) in checks)
        if (!ok) SetAdvisor(meetingId, op, aid, role, AdvisorAbstained, reason);
    }
    catch { }
  }
  // Restart recovery for the in-memory mirror: running discussions and live
  // secretary attempts become interrupted with a retryable reason instead of
  // endless busy. Durable secretary rows are recovered separately by
  // SecretaryRecovery; this mirror never contradicts them.
  public static int RecoverInterrupted()
  {
    int n = 0;
    try
    {
      foreach (var kv in Discussions.ToList())
      {
        var e = kv.Value;
        lock (e)
        {
          if (e.Status != DiscussionRunning) continue;
          e.Status = DiscussionInterrupted;
          e.Error = "Process restarted during generation; retry.";
          e.UpdatedAt = DateTime.UtcNow;
          foreach (var av in e.Advisors.ToList())
            if (!IsTerminalAdvisor(av.Value.State))
              e.Advisors[av.Key] = av.Value with { State = AdvisorAbstained, Reason = "run-interrupted", UpdatedAt = DateTime.UtcNow };
          n++;
        }
      }
      foreach (var kv in Secretaries.ToList())
      {
        var e = kv.Value;
        lock (e)
        {
          if (e.Status is "pending" or "inflight" or "answering" or "uncertain")
          {
            e.Status = "interrupted";
            e.UpdatedAt = DateTime.UtcNow;
            n++;
          }
        }
      }
    }
    catch { }
    return n;
  }

  // Authorized snapshot for polling fallback. Discussion is visible to every
  // authorized meeting reader; secretary entries are filtered to the caller.
  // No message contents, no percentages, no secrets, no tokens.
  public static object GetSnapshot(InMemoryStore s, Guid meetingId, string callerKey)
  {
    Guid snapBoardId; long snapGeneration; string snapMeetingState;
    lock (s.RootGate)
    {
      if (!s.Meetings.TryGetValue(meetingId, out var snapMeeting) || snapMeeting is null) throw new InvalidOperationException("meeting-not-found");
      snapBoardId = snapMeeting.BoardId; snapGeneration = snapMeeting.Generation; snapMeetingState = snapMeeting.State.ToString();
    }
    ReconcileDiscussion(s, meetingId);
    object? discussion = null;
    if (Discussions.TryGetValue(meetingId, out var d) && d is not null)
    {
      List<object> advisors;
      lock (d)
      {
        advisors = d.Advisors.Values.OrderBy(a => a.BoardRole, StringComparer.Ordinal)
          .Select(a => (object)new
          {
            advisorId = a.AdvisorId,
            boardRole = a.BoardRole,
            state = a.State,
            reason = a.Reason,
            updatedAt = a.UpdatedAt,
          }).ToList();
        discussion = new
        {
          meetingId = d.MeetingId,
          boardId = d.BoardId,
          operationId = d.OperationId,
          generation = d.Generation,
          leadSeq = d.LeadSeq,
          status = d.Status,
          phase = d.Phase,
          error = d.Error,
          meetingState = snapMeetingState,
          updatedAt = d.UpdatedAt,
          advisors,
        };
      }
    }
    var mine = new List<object>();
    foreach (var kv in Secretaries.ToList())
    {
      var e = kv.Value;
      if (e.MeetingId != meetingId) continue;
      if (!ReconcileSecretaryEntry(s, e)) continue;
      string rk;
      lock (e) { rk = e.RequesterKey; }
      if (!string.Equals(rk, callerKey ?? "", StringComparison.OrdinalIgnoreCase)) continue;
      lock (e)
      {
        mine.Add(new
        {
          requestId = e.RequestId,
          meetingId = e.MeetingId,
          clientNonce = e.ClientNonce,
          status = e.Status,
          phase = e.Phase,
          generation = e.Generation,
          updatedAt = e.UpdatedAt,
        });
      }
    }
    mine = mine.OrderByDescending(o => ((dynamic)o).updatedAt).Take(50).ToList();
    return new
    {
      meetingId,
      boardId = snapBoardId,
      generation = snapGeneration,
      meetingState = snapMeetingState,
      discussion,
      secretary = mine,
    };
  }

  // Board-visible discussion event over the existing authenticated hub. Never
  // throws: publication must not fail the run it reports on.
  public static async System.Threading.Tasks.Task PublishDiscussionAsync(
    Microsoft.AspNetCore.SignalR.IHubContext<BoardHub> hub, InMemoryStore s, Guid meetingId)
  {
    try
    {
      string pubMeetingState;
      lock (s.RootGate)
      {
        if (!s.Meetings.TryGetValue(meetingId, out var pubMeeting) || pubMeeting is null) return;
        pubMeetingState = pubMeeting.State.ToString();
      }
      ReconcileDiscussion(s, meetingId);
      if (!Discussions.TryGetValue(meetingId, out var d) || d is null) return;
      object payload;
      lock (d)
      {
        payload = new
        {
          meetingId = d.MeetingId,
          boardId = d.BoardId,
          operationId = d.OperationId,
          generation = d.Generation,
          leadSeq = d.LeadSeq,
          status = d.Status,
          phase = d.Phase,
          error = d.Error,
          meetingState = pubMeetingState,
          updatedAt = d.UpdatedAt,
          advisors = d.Advisors.Values.OrderBy(a => a.BoardRole, StringComparer.Ordinal)
            .Select(a => new
            {
              advisorId = a.AdvisorId,
              boardRole = a.BoardRole,
              state = a.State,
              reason = a.Reason,
              updatedAt = a.UpdatedAt,
            }).ToList(),
        };
      }
      await BoardHub.PublishMeeting(hub, s, meetingId, "meeting-activity", payload, "read");
    }
    catch { }
  }

  // Private secretary event: delivered ONLY to the requesting user key.
  public static async System.Threading.Tasks.Task PublishSecretaryAsync(
    Microsoft.AspNetCore.SignalR.IHubContext<BoardHub> hub, InMemoryStore s,
    Guid meetingId, Guid requestId)
  {
    try
    {
      if (!Secretaries.TryGetValue(requestId, out var e) || e is null) return;
      if (!ReconcileSecretaryEntry(s, e)) return;
      object payload;
      string requester;
      lock (e)
      {
        requester = e.RequesterKey;
        payload = new
        {
          meetingId = e.MeetingId,
          requestId = e.RequestId,
          clientNonce = e.ClientNonce,
          status = e.Status,
          phase = e.Phase,
          generation = e.Generation,
          updatedAt = e.UpdatedAt,
        };
      }
      if (string.IsNullOrWhiteSpace(requester)) return;
      await BoardHub.PublishPrivateMeeting(hub, s, meetingId, requester, "secretary-activity", payload);
    }
    catch { }
  }

  public static void MapMeetingActivity(this WebApplication app)
  {
    app.MapGet("/api/meetings/{id:guid}/activity", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (SimCEO.Api.PeopleOps.BadToken(s, req) is { } bad) return bad;
      try
      {
        if (SimCEO.Api.PeopleOps.IsSecure(s) && !SimCEO.Api.AuthOps.TrySession(s, req, out _))
          return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      }
      catch (InvalidOperationException) { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
      var caller = "";
      try { caller = SimCEO.Api.PeopleOps.UserOf(s, req); } catch { }
      if (!SimCEO.Api.PeopleOps.Can(s, req, m.BoardId, id, "read")) return SimCEO.Api.PeopleOps.Denied();
      try { return Results.Ok(GetSnapshot(s, id, caller)); }
      catch (InvalidOperationException) { return Results.NotFound("meeting"); }
    });
  }
}
