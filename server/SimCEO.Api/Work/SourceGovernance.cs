using System.Text;
using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// Phase 6 central source-governance helper. Single eligibility predicate +
// family head + deterministic local indexing. All producers/consumers must
// route through IsEligible; review transitions are explicit and audited.
public static class SourceGovernance
{
  public const int MaxSections = 20;
  public const int MaxSectionChars = 2000;
  public const int MaxTotalChars = 12000;

  public static string NormalizeFileName(string name)
  {
    var t = (name ?? "").Trim();
    var idx = t.LastIndexOfAny(new[] { '/', '\\' });
    if (idx >= 0) t = t.Substring(idx + 1);
    return t.Trim().ToLowerInvariant();
  }

  public static string GetExtension(string fileName)
  {
    var n = (fileName ?? "").Trim();
    var dot = n.LastIndexOf('.');
    if (dot < 0) return "";
    var ext = n.Substring(dot + 1).Trim().ToLowerInvariant();
    var cut = ext.IndexOfAny(new[] { ' ', '?', '#', '/' , '\\' });
    if (cut >= 0) ext = ext.Substring(0, cut);
    return ext;
  }

  public static string FamilyKeyFor(Guid boardId, string scope, Guid? meetingId, string origin, string fileName)
  {
    var norm = NormalizeFileName(fileName);
    var sc = scope == "meeting" ? "meeting" : "board";
    var mid = sc == "meeting" && meetingId.HasValue ? meetingId.Value.ToString("N") : "-";
    var org = string.IsNullOrWhiteSpace(origin) ? "upload" : origin.Trim().ToLowerInvariant();
    return boardId.ToString("N") + "|" + sc + "|" + mid + "|" + org + "|" + norm;
  }

  public static string PolicyModeOf(Board? b)
  {
    var m = (b?.SourcePolicyMode ?? "allowAll").Trim().ToLowerInvariant();
    return m == "wikionly" || m == "wiki-only" || m == "wiki_only" ? "wikiOnly" : "allowAll";
  }

  public static bool IsBlockedByPolicy(Board? board, string fileName)
  {
    if (PolicyModeOf(board) == "wikiOnly") return true; // filled by Origin check below
    var ext = GetExtension(fileName);
    if (string.IsNullOrEmpty(ext)) return false;
    var raw = board?.BlockedTypes ?? "";
    var parts = raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    foreach (var p in parts)
    {
      var q = p.Trim().TrimStart('.').ToLowerInvariant();
      if (q.Length == 0) continue;
      if (string.Equals(q, ext, StringComparison.OrdinalIgnoreCase)) return true;
    }
    return false;
  }

  public static bool PolicyAllows(Board? board, SourceDoc doc)
  {
    var mode = PolicyModeOf(board);
    if (mode == "wikiOnly")
    {
      var org = (doc.Origin ?? "upload").Trim().ToLowerInvariant();
      if (org != "wiki") return false;
      // Wiki resources still honor blocked extensions on file/path label.
      return !IsBlockedByPolicy_ExtensionOnly(board, doc.FileName);
    }
    return !IsBlockedByPolicy_ExtensionOnly(board, doc.FileName);
  }

  private static bool IsBlockedByPolicy_ExtensionOnly(Board? board, string fileName)
  {
    var ext = GetExtension(fileName);
    if (string.IsNullOrEmpty(ext)) return false;
    var raw = board?.BlockedTypes ?? "";
    var parts = raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    foreach (var p in parts)
    {
      var q = p.Trim().TrimStart('.').ToLowerInvariant();
      if (q.Length == 0) continue;
      if (string.Equals(q, ext, StringComparison.OrdinalIgnoreCase)) return true;
    }
    return false;
  }

  public static void EnsureMigrated(InMemoryStore s, SourceDoc d)
  {
    var dirty = false;
    if (string.IsNullOrWhiteSpace(d.ReviewState))
    {
      d.ReviewState = d.Approved ? "approved" : "pending";
      dirty = true;
    }
    else
    {
      var rs = d.ReviewState.Trim().ToLowerInvariant();
      if (rs != "pending" && rs != "approved" && rs != "rejected") { d.ReviewState = d.Approved ? "approved" : "pending"; dirty = true; }
      else if (rs != d.ReviewState) { d.ReviewState = rs; dirty = true; }
    }
    if (string.IsNullOrWhiteSpace(d.Origin)) { d.Origin = "upload"; dirty = true; }
    else { var o = d.Origin.Trim().ToLowerInvariant(); if (o != d.Origin) { d.Origin = o; dirty = true; } }
    if (string.IsNullOrWhiteSpace(d.FamilyKey))
    {
      d.FamilyKey = FamilyKeyFor(d.BoardId, d.Scope, d.MeetingId, d.Origin, d.FileName);
      dirty = true;
    }
    if (string.IsNullOrWhiteSpace(d.IndexState)) { d.IndexState = "queued"; dirty = true; }
    // Keep legacy Approved boolean in sync with canonical ReviewState.
    var shouldApproved = string.Equals(d.ReviewState, "approved", StringComparison.OrdinalIgnoreCase);
    if (d.Approved != shouldApproved) { d.Approved = shouldApproved; dirty = true; }
    if (dirty) { try { s.Sources.Flush(); } catch { } }
  }

  public static void EnsureMigratedAll(InMemoryStore s)
  {
    foreach (var d in s.Sources.Values.ToList()) EnsureMigrated(s, d);
    BackfillHeads(s);
    try { s.SourceHeads.Flush(); } catch { }
  }

  private static void BackfillHeads(InMemoryStore s)
  {
    // Backfill heads from existing approved docs (idempotent, never reapproves).
    foreach (var d in s.Sources.Values.Where(x => string.Equals(x.ReviewState, "approved", StringComparison.OrdinalIgnoreCase)).ToList())
    {
      var head = s.SourceHeads.Values.FirstOrDefault(h => h.BoardId == d.BoardId && h.FamilyKey == d.FamilyKey);
      if (head is null)
      {
        var h = new SourceFamilyHead { BoardId = d.BoardId, FamilyKey = d.FamilyKey, HeadVersion = d.Version, HeadSourceId = d.Id, UpdatedAt = DateTime.UtcNow };
        s.SourceHeads[h.Id] = h;
      }
      else if (d.Version > head.HeadVersion)
      {
        head.HeadVersion = d.Version; head.HeadSourceId = d.Id; head.UpdatedAt = DateTime.UtcNow;
      }
    }
    // Transitional repair: heads created before identity pinning carry an empty
    // HeadSourceId. Pin each to its unique (family, version) row; when a legacy
    // version collision left several rows, pin the single approved one if unique.
    foreach (var head in s.SourceHeads.Values.Where(h => h.HeadSourceId == Guid.Empty).ToList())
    {
      var cands = s.Sources.Values
        .Where(x => x.BoardId == head.BoardId && x.FamilyKey == head.FamilyKey && x.Version == head.HeadVersion).ToList();
      if (cands.Count == 1) { head.HeadSourceId = cands[0].Id; head.UpdatedAt = DateTime.UtcNow; }
      else
      {
        var approved = cands.Where(x => string.Equals(x.ReviewState, "approved", StringComparison.OrdinalIgnoreCase)).ToList();
        if (approved.Count == 1) { head.HeadSourceId = approved[0].Id; head.UpdatedAt = DateTime.UtcNow; }
      }
    }
  }

  // Deliberate legacy-restore migration (P2 #9). Backup snapshots predating
  // phase 6 carry Approved=true with NO ReviewState field; deserialization
  // leaves the "" sentinel, so EnsureMigrated promotes them to "approved".
  // Rows that already carry an explicit ReviewState (including explicit
  // "rejected") are never touched: no implicit reapproval, no resurrection.
  // Completed-without-sections metadata is failed-closed until reindex.
  public static void MigrateRestoredSources(InMemoryStore s)
  {
    foreach (var d in s.Sources.Values.ToList()) EnsureMigrated(s, d);
    foreach (var d in s.Sources.Values.ToList())
    {
      if (string.Equals(d.IndexState, "completed", StringComparison.OrdinalIgnoreCase) && !HasValidSections(s, d))
      {
        d.IndexState = "failed";
        d.IndexError = "sections missing or mismatched after restore; reindex required";
        d.IndexCompletedAt = DateTime.UtcNow;
      }
    }
    try { s.Sources.Flush(); } catch { }
    BackfillHeads(s);
    try { s.SourceHeads.Flush(); } catch { }
  }

  public static bool ScopeReachesMeeting(SourceDoc d, Guid meetingId, InMemoryStore s)
  {
    if (d.Scope == "board") return true;
    return d.MeetingId.HasValue && d.MeetingId.Value == meetingId;
  }

  public static bool MeetingBelongsToBoard(Guid meetingId, Guid boardId, InMemoryStore s)
  {
    if (!s.Meetings.TryGetValue(meetingId, out var m)) return false;
    return m.BoardId == boardId;
  }

  // THE single eligibility predicate. Every creation/import/ingestion/
  // retrieval/recall/briefing/discussion path must call this.
  public static bool IsEligible(InMemoryStore s, SourceDoc d, Guid? forMeetingId = null)
  {
    EnsureMigrated(s, d);
    if (!string.Equals(d.ReviewState, "approved", StringComparison.OrdinalIgnoreCase)) return false;
    if (d.Excluded) return false;
    // Head pinning: only the promoted head version AND identity is current.
    // Older approved versions never reappear once a newer version is promoted,
    // and two rows can never share eligibility at one family head even if a
    // legacy move created a version collision (P1 #2). Empty HeadSourceId is
    // transitional (backfilled by EnsureMigratedAll).
    var head = s.SourceHeads.Values.FirstOrDefault(h => h.BoardId == d.BoardId && h.FamilyKey == d.FamilyKey);
    if (head is not null && head.HeadVersion > 0)
    {
      if (d.Version != head.HeadVersion) return false;
      if (head.HeadSourceId != Guid.Empty && d.Id != head.HeadSourceId) return false;
    }
    // Board must exist for policy; unknown board fails closed.
    if (!s.Boards.TryGetValue(d.BoardId, out var board)) return false;
    if (!PolicyAllows(board, d)) return false;
    // Unknown/dangling wiki resource fails closed (phase7 seam).
    var org = (d.Origin ?? "upload").Trim().ToLowerInvariant();
    if (org == "wiki" && (!d.ResourceId.HasValue || d.ResourceId.Value == Guid.Empty)) return false;
    if (org != "upload" && org != "wiki" && org != "inline") return false;
    // Scope check.
    if (d.Scope == "meeting")
    {
      if (!d.MeetingId.HasValue) return false;
      if (!MeetingBelongsToBoard(d.MeetingId.Value, d.BoardId, s)) return false;
      if (forMeetingId.HasValue && d.MeetingId.Value != forMeetingId.Value) return false;
    }
    else if (d.Scope != "board") return false;
    // Index must be completed with persisted sections; failed/incomplete
    // never supplies evidence.
    if (!string.Equals(d.IndexState, "completed", StringComparison.OrdinalIgnoreCase)) return false;
    // Completed string alone never suffices: require persisted sections that
    // match this exact source/version/hash/generation with nonempty text.
    // Raw extraction/original text must never satisfy eligibility (P2 #13).
    if (!HasValidSections(s, d)) return false;
    // Phase7 seam: wiki docs additionally require a present, enabled, current-healthy resource with current membership.
    if (!WikiEligibility.IsUsable(s, d)) return false;
    return true;
  }

  public static bool HasValidSections(InMemoryStore s, SourceDoc d)
  {
    var secs = s.SourceSections.Values.Where(x => x.SourceId == d.Id).ToList();
    if (secs.Count == 0) return false;
    foreach (var sec in secs)
    {
      if (sec.SourceVersion != d.Version) return false;
      if (!string.Equals(sec.ContentHash ?? "", d.ContentHash ?? "", StringComparison.Ordinal)) return false;
      if (sec.IndexGeneration != d.IndexGeneration) return false;
      if (string.IsNullOrWhiteSpace(sec.Text)) return false;
    }
    return true;
  }

  public static string CanonicalSectionText(InMemoryStore s, SourceDoc d, int maxChars = 600)
  {
    var secs = s.SourceSections.Values.Where(x => x.SourceId == d.Id).OrderBy(x => x.Ordinal).Take(6).ToList();
    if (secs.Count == 0) return "";
    var joined = string.Join("\n\n", secs.Select(x => (string.IsNullOrWhiteSpace(x.Heading) ? "" : "## " + x.Heading + "\n") + x.Text));
    joined = joined.Trim();
    if (joined.Length > maxChars) joined = joined.Substring(0, maxChars) + "…";
    return joined;
  }

  public static bool ExcerptMatchesSections(InMemoryStore s, SourceDoc d, string excerpt)
  {
    if (string.IsNullOrWhiteSpace(excerpt)) return true;
    var corpus = string.Join("\n", s.SourceSections.Values
      .Where(x => x.SourceId == d.Id).OrderBy(x => x.Ordinal).Take(10).Select(x => x.Text ?? ""));
    static string Norm(string v) => string.Join(" ", v.ToLowerInvariant().Split(new[] { (char)32, (char)9, (char)10, (char)13 }, StringSplitOptions.RemoveEmptyEntries));
    return Norm(corpus).Contains(Norm(excerpt), StringComparison.Ordinal);
  }

  // Board-level recall must not leak meeting-only material: when no meeting
  // is supplied, only board-scoped docs are visible.
  public static bool VisibleForRecall(InMemoryStore s, SourceDoc d, Guid boardId, Guid? meetingId)
  {
    if (d.BoardId != boardId) return false;
    if (!meetingId.HasValue && d.Scope == "meeting") return false;
    if (meetingId.HasValue)
    {
      if (!MeetingBelongsToBoard(meetingId.Value, boardId, s)) return false;
      if (d.Scope == "meeting" && (!d.MeetingId.HasValue || d.MeetingId.Value != meetingId.Value)) return false;
    }
    return IsEligible(s, d, meetingId);
  }

  public static SourceDoc? CurrentForFamily(InMemoryStore s, Guid boardId, string familyKey)
  {
    var head = s.SourceHeads.Values.FirstOrDefault(h => h.BoardId == boardId && h.FamilyKey == familyKey);
    if (head is null || head.HeadVersion <= 0) return null;
    var doc = s.Sources.Values.FirstOrDefault(x => x.BoardId == boardId && x.FamilyKey == familyKey && x.Version == head.HeadVersion && (head.HeadSourceId == Guid.Empty || x.Id == head.HeadSourceId));
    if (doc is null) return null;
    // Current requires full eligibility (any meeting scope that could reach it).
    // Board-scoped heads are checked without meeting; meeting heads need parent.
    Guid? meeting = doc.Scope == "meeting" ? doc.MeetingId : null;
    if (doc.Scope == "meeting" && !meeting.HasValue) return null;
    return IsEligible(s, doc, meeting) ? doc : null;
  }

  public static void RecordEvent(InMemoryStore s, SourceDoc d, string action, string detail)
  {
    var e = new SourceEvent { BoardId = d.BoardId, SourceId = d.Id, FamilyKey = d.FamilyKey, Version = d.Version, Action = action, Detail = detail ?? "", CreatedAt = DateTime.UtcNow };
    s.SourceEvents[e.Id] = e;
    try { s.SourceEvents.Flush(); } catch { }
    try { s.Audit.Add(new AuditEvent { BoardId = d.BoardId, Action = "source." + action, Detail = JsonSerializer.Serialize(new { id = d.Id, d.FileName, d.Version, d.ReviewState, d.Excluded, detail }) }); } catch { }
  }

  public static (bool ok, string? error, int status) TryApprove(InMemoryStore s, SourceDoc d)
  {
    EnsureMigrated(s, d);
    var rs = (d.ReviewState ?? "").Trim().ToLowerInvariant();
    // Supersede check precedes the already-approved fast path: re-approving an
    // older approved version after a newer promotion is rejected, never a
    // silent no-op and never a head rollback.
    var head = s.SourceHeads.Values.FirstOrDefault(h => h.BoardId == d.BoardId && h.FamilyKey == d.FamilyKey);
    if (head is not null && d.Version < head.HeadVersion)
      return (false, "Superseded by newer approved version v" + head.HeadVersion + "; approval rejected.", 409);
    if (rs == "approved") return (true, null, 200);
    if (rs == "rejected") return (false, "Rejected versions cannot be approved; upload a new version.", 409);
    var reason = "source.approve " + d.FileName + " v" + d.Version;
    MutateEvidence(s, d.BoardId, reason, () =>
    {
      d.ReviewState = "approved"; d.Approved = true;
      var h = s.SourceHeads.Values.FirstOrDefault(x => x.BoardId == d.BoardId && x.FamilyKey == d.FamilyKey);
      if (h is null)
      {
        h = new SourceFamilyHead { BoardId = d.BoardId, FamilyKey = d.FamilyKey, HeadVersion = d.Version, HeadSourceId = d.Id, UpdatedAt = DateTime.UtcNow };
        s.SourceHeads[h.Id] = h;
      }
      else if (d.Version >= h.HeadVersion)
      {
        h.HeadVersion = d.Version; h.HeadSourceId = d.Id; h.UpdatedAt = DateTime.UtcNow;
      }
      s.Sources.Flush(); s.SourceHeads.Flush();
      RecordEvent(s, d, "approve", "v" + d.Version);
    });
    return (true, null, 200);
  }

  public static (bool ok, string? error, int status) TryReject(InMemoryStore s, SourceDoc d)
  {
    EnsureMigrated(s, d);
    var rs = (d.ReviewState ?? "").Trim().ToLowerInvariant();
    if (rs == "rejected") return (true, null, 200);
    if (rs == "approved") return (false, "Approved versions cannot be rejected; exclude to revoke current evidence.", 409);
    var reason = "source.reject " + d.FileName + " v" + d.Version;
    MutateEvidence(s, d.BoardId, reason, () =>
    {
      d.ReviewState = "rejected"; d.Approved = false;
      s.Sources.Flush();
      RecordEvent(s, d, "reject", "v" + d.Version);
    });
    return (true, null, 200);
  }

  public static void SetExcluded(InMemoryStore s, SourceDoc d, bool excluded)
  {
    EnsureMigrated(s, d);
    var reason = (excluded ? "source.exclude " : "source.restore ") + d.FileName + " v" + d.Version;
    MutateEvidence(s, d.BoardId, reason, () =>
    {
      d.Excluded = excluded;
      s.Sources.Flush();
      RecordEvent(s, d, excluded ? "exclude" : "restore", "v" + d.Version);
    });
  }

  // Central governance mutation boundary (P1 #1): evidence state/head/index
  // mutations AND the affected-meeting generation increment + pause happen
  // atomically under SetupLock then MessageLock — the same lock order the
  // discussion publication commit holds. Source revocation must never
  // flush/commit evidence objects before acquiring these locks: otherwise a
  // publication that already passed its revocation check can commit
  // already-checked drafts after the exclusion lands. No await inside.
  public static void MutateEvidence(InMemoryStore s, Guid boardId, string reason, Action mutation)
  {
    lock (s.SetupLock)
    {
      lock (s.MessageLock)
      {
        Atomic.Run(mutation);
        InvalidateLocked(s, boardId);
      }
    }
    try { s.Audit.Add(new AuditEvent { BoardId = boardId, Action = "source.invalidate", Detail = reason ?? "" }); } catch { }
  }
  // Conditional variant: the callback reports whether it changed evidence.
  // Meetings are paused / generation-bumped and the invalidation audit is
  // written ONLY when the callback actually changed something. Stale or
  // no-op completions (superseded sync attempts, unchanged refreshes,
  // identical reconfigurations) must never pause meetings, bump generation,
  // or write success/failure audits. Non-wiki callers keep MutateEvidence.
  public static bool MutateEvidenceIfChanged(InMemoryStore s, Guid boardId, string reason, Func<bool> mutation)
  {
    bool changed;
    lock (s.SetupLock)
    {
      lock (s.MessageLock)
      {
        changed = Atomic.Run(mutation);
        if (changed) InvalidateLocked(s, boardId);
      }
    }
    if (changed) try { s.Audit.Add(new AuditEvent { BoardId = boardId, Action = "source.invalidate", Detail = reason ?? "" }); } catch { }
    return changed;
  }

  // Meeting invalidation for callers that already hold SetupLock (they run
  // their own Atomic unit): takes MessageLock, pauses/bumps affected
  // meetings, and audits. Same lock order as MutateEvidence.
  public static void InvalidateBoardUnderSetupLock(InMemoryStore s, Guid boardId, string reason)
  {
    lock (s.MessageLock)
    {
      InvalidateLocked(s, boardId);
    }
    try { s.Audit.Add(new AuditEvent { BoardId = boardId, Action = "source.invalidate", Detail = reason ?? "" }); } catch { }
  }

  // Bounded detached index staging for Wiki sync: builds exactly the sections
  // IndexSource would persist for this document, WITHOUT touching the store.
  // Returns false with a safe fixed error when the page is unindexable
  // (failed/unreachable extraction, empty/whitespace text, or no nonempty
  // sections), so the whole sync attempt can fail closed BEFORE publishing
  // any new source row. Mirrors IndexSource's pure text/section logic.
  public static bool TryStageIndexSections(SourceDoc template, out List<SourceSection> sections, out string error)
  {
    sections = new();
    error = "";
    var gen = template.IndexGeneration <= 0 ? 1 : template.IndexGeneration;
    var md = Extraction.MarkdownOf(template.ExtractionJson);
    var extStatus = "";
    try
    {
      using var ej = JsonDocument.Parse(string.IsNullOrWhiteSpace(template.ExtractionJson) ? "{}" : template.ExtractionJson);
      if (ej.RootElement.TryGetProperty("status", out var st) && st.ValueKind == JsonValueKind.String)
        extStatus = (st.GetString() ?? "").Trim().ToLowerInvariant();
    }
    catch (JsonException) { }
    if (string.IsNullOrWhiteSpace(md) && (extStatus == "failed" || extStatus == "unreachable"))
    { error = "extraction failed or unreachable; raw bytes are not indexed without extractor output"; return false; }
    var text = ReadableTextFor(template);
    if (string.IsNullOrWhiteSpace(text))
    { error = string.IsNullOrWhiteSpace(Extraction.MarkdownOf(template.ExtractionJson)) ? "no extractable text; extraction failed or binary without extractor output" : "empty text"; return false; }
    var built = BuildSections(text);
    if (built.Count == 0 || built.Any(b => string.IsNullOrWhiteSpace(b.Text)))
    { error = "no indexable sections built"; return false; }
    var now = DateTime.UtcNow;
    int ord = 1;
    foreach (var b in built)
    {
      sections.Add(new SourceSection
      {
        BoardId = template.BoardId, SourceId = template.Id, FamilyKey = template.FamilyKey ?? "",
        SourceVersion = template.Version, ContentHash = template.ContentHash ?? "",
        Ordinal = ord++, Heading = b.Heading ?? "", Location = b.Location ?? "", Text = b.Text ?? "",
        IndexGeneration = gen, CreatedAt = now,
      });
    }
    return true;
  }

  private static void InvalidateLocked(InMemoryStore s, Guid boardId)
  {
    foreach (var m in s.Meetings.Values.Where(x => x.BoardId == boardId).ToList())
    {
      if (m.State is MeetingState.Active or MeetingState.AwaitingBrief)
      {
        m.State = MeetingState.Paused;
        m.Generation++;
      }
      else
      {
        m.Generation++;
      }
    }
    s.Meetings.Flush();
  }

  // Policy/revocation invalidation: bump generation + pause Active/AwaitingBrief
  // meetings on this board. SetupLock then MessageLock ordering (matches run path).
  // Prefer MutateEvidence when an evidence mutation accompanies the invalidation.
  public static void InvalidateForBoard(InMemoryStore s, Guid boardId, string reason)
  {
    try
    {
      lock (s.SetupLock)
      {
        lock (s.MessageLock)
        {
          InvalidateLocked(s, boardId);
        }
      }
      try { s.Audit.Add(new AuditEvent { BoardId = boardId, Action = "source.invalidate", Detail = reason ?? "" }); } catch { }
    }
    catch { }
  }

  // Eligibility-loss invalidation (retry/reindex path): when a mutation outside
  // the governance lock (extraction await, reindex) turns a previously eligible
  // source ineligible, affected meetings must still be paused + bumped.
  public static bool InvalidateIfEligibilityLost(InMemoryStore s, SourceDoc d, bool wasEligible, string reason)
  {
    if (!wasEligible) return false;
    Guid? meeting = d.Scope == "meeting" ? d.MeetingId : null;
    if (IsEligible(s, d, meeting)) return false;
    InvalidateForBoard(s, d.BoardId, reason);
    return true;
  }

  public static string ReadableTextFor(SourceDoc d)
  {
    var md = Extraction.MarkdownOf(d.ExtractionJson);
    if (!string.IsNullOrWhiteSpace(md)) return md!;
    if (d.Original is null) return "";
    try
    {
      var text = Encoding.UTF8.GetString(d.Original);
      if (string.IsNullOrEmpty(text)) return "";
      var printable = text.Count(c => !char.IsControl(c) || c is '\n' or '\r' or '\t');
      if ((double)printable / Math.Max(1, text.Length) < 0.7) return "";
      return text.Length > MaxTotalChars ? text.Substring(0, MaxTotalChars) : text;
    }
    catch { return ""; }
  }

  public sealed record BuiltSection(string Heading, string Location, string Text);

  public static List<BuiltSection> BuildSections(string fullText)
  {
    var out_ = new List<BuiltSection>();
    if (string.IsNullOrWhiteSpace(fullText)) return out_;
    var text = fullText.Length > MaxTotalChars ? fullText.Substring(0, MaxTotalChars) : fullText;
    var lines = text.Split('\n');
    string curHeading = "";
    var cur = new StringBuilder();
    int loc = 1;
    void Flush()
    {
      var t = cur.ToString().Trim();
      if (t.Length == 0) return;
      var chunk = t;
      int start = 0;
      while (start < chunk.Length && out_.Count < MaxSections)
      {
        var len = Math.Min(MaxSectionChars, chunk.Length - start);
        out_.Add(new BuiltSection(curHeading, "sec-" + loc + "#" + (out_.Count + 1), chunk.Substring(start, len).Trim()));
        start += len;
        loc++;
      }
      cur.Clear();
    }
    foreach (var raw in lines)
    {
      if (out_.Count >= MaxSections) break;
      var line = raw.TrimEnd('\r');
      var trimmed = line.Trim();
      if ((trimmed.StartsWith("# ") || trimmed.StartsWith("## ") || trimmed.StartsWith("### ")) && cur.Length > 0)
      {
        Flush();
        curHeading = trimmed.TrimStart('#', ' ').Trim();
        if (curHeading.Length > 120) curHeading = curHeading.Substring(0, 120);
        cur.AppendLine(line);
      }
      else
      {
        if (trimmed.StartsWith("#")) { curHeading = trimmed.TrimStart('#', ' ').Trim(); if (curHeading.Length > 120) curHeading = curHeading.Substring(0, 120); }
        cur.AppendLine(line);
        if (cur.Length > MaxSectionChars * 2) Flush();
      }
    }
    Flush();
    if (out_.Count == 0 && text.Trim().Length > 0)
      out_.Add(new BuiltSection("", "sec-1#1", text.Trim().Substring(0, Math.Min(MaxSectionChars, text.Trim().Length))));
    return out_.Take(MaxSections).ToList();
  }

  // Atomic index commit: set running, build, then replace sections for this
  // source version + mark completed. Failure marks failed with error and no
  // sections; failed never supplies evidence.
  public static void IndexSource(InMemoryStore s, SourceDoc d, bool isReindex)
  {
    EnsureMigrated(s, d);
    var gen = d.IndexGeneration <= 0 ? 1 : d.IndexGeneration + (isReindex ? 1 : 0);
    if (!isReindex && d.IndexGeneration <= 0) gen = 1;
    d.IndexState = "running"; d.IndexGeneration = gen; d.IndexError = "";
    s.Sources.Flush();
    // Fail closed on explicit extraction failure: raw Original bytes must not
    // stand in for extractor output (no raw fallback, P2 #13). Textual formats
    // always extract locally, so an explicit failed/unreachable status with no
    // markdown means there is no trustworthy text to index.
    var md = Extraction.MarkdownOf(d.ExtractionJson);
    var extStatus = "";
    try
    {
      using var ej = JsonDocument.Parse(string.IsNullOrWhiteSpace(d.ExtractionJson) ? "{}" : d.ExtractionJson);
      if (ej.RootElement.TryGetProperty("status", out var st) && st.ValueKind == JsonValueKind.String)
        extStatus = (st.GetString() ?? "").Trim().ToLowerInvariant();
    }
    catch (JsonException) { }
    if (string.IsNullOrWhiteSpace(md) && (extStatus == "failed" || extStatus == "unreachable"))
    {
      d.IndexState = "failed";
      d.IndexError = "extraction " + extStatus + "; raw bytes are not indexed without extractor output";
      d.IndexCompletedAt = DateTime.UtcNow;
      s.Sources.Flush();
      RecordEvent(s, d, isReindex ? "reindex-failed" : "index-failed", d.IndexError);
      return;
    }
    var text = ReadableTextFor(d);
    if (string.IsNullOrWhiteSpace(text))
    {
      d.IndexState = "failed";
      d.IndexError = string.IsNullOrWhiteSpace(Extraction.MarkdownOf(d.ExtractionJson)) ? "no extractable text; extraction failed or binary without extractor output" : "empty text";
      d.IndexCompletedAt = DateTime.UtcNow;
      s.Sources.Flush();
      RecordEvent(s, d, isReindex ? "reindex-failed" : "index-failed", d.IndexError);
      return;
    }
    var built = BuildSections(text);
    if (built.Count == 0)
    {
      d.IndexState = "failed"; d.IndexError = "no sections built"; d.IndexCompletedAt = DateTime.UtcNow;
      s.Sources.Flush();
      RecordEvent(s, d, isReindex ? "reindex-failed" : "index-failed", d.IndexError);
      return;
    }
    Atomic.Run(() =>
    {
      foreach (var old in s.SourceSections.Values.Where(x => x.SourceId == d.Id).ToList())
        s.SourceSections.TryRemove(old.Id, out _);
      int ord = 1;
      foreach (var b in built)
      {
        var sec = new SourceSection
        {
          BoardId = d.BoardId, SourceId = d.Id, FamilyKey = d.FamilyKey,
          SourceVersion = d.Version, ContentHash = d.ContentHash,
          Ordinal = ord++, Heading = b.Heading, Location = b.Location,
          Text = b.Text, IndexGeneration = gen, CreatedAt = DateTime.UtcNow,
        };
        s.SourceSections[sec.Id] = sec;
      }
      d.IndexState = "completed"; d.IndexError = ""; d.IndexCompletedAt = DateTime.UtcNow;
      s.Sources.Flush(); s.SourceSections.Flush();
    });
    RecordEvent(s, d, isReindex ? "reindex" : "index", "gen" + gen + " sections" + built.Count);
  }

  // External recall hits must never bypass governance: drop hits that claim a
  // source identity but do not resolve to an eligible doc under the SAME
  // board-vs-meeting visibility rule as local recall (board-level recall must
  // not leak meeting-only material, P1 #3). Accepted hits are re-resolved to
  // canonical persisted section text: remote text is untrusted and never
  // returned verbatim. Hindsight-kind hits remain informational only and are
  // never promoted to source EvidenceRefs.
  public static List<ContextCurator.RecallHit> FilterExternalHits(InMemoryStore s, Guid boardId, IEnumerable<ContextCurator.RecallHit> remote, Guid? meetingId)
  {
    var kept = new List<ContextCurator.RecallHit>();
    foreach (var h in remote)
    {
      var kind = (h.Kind ?? "").Trim().ToLowerInvariant();
      var rf = (h.Ref ?? "").Trim();
      if (kind == "source" || kind.StartsWith("source:") || kind == "hindsight:source" || kind.StartsWith("hindsight:source"))
      {
        if (Guid.TryParse(rf.Split(' ').FirstOrDefault() ?? "", out var sid)
          && s.Sources.TryGetValue(sid, out var doc)
          && doc.BoardId == boardId
          && VisibleForRecall(s, doc, boardId, meetingId))
        {
          var canon = CanonicalSectionText(s, doc);
          if (string.IsNullOrWhiteSpace(canon)) continue; // eligible yet sectionless: fail closed
          kept.Add(h with { Ref = doc.FileName + " v" + doc.Version, Text = canon });
        }
        // else: unresolvable/ineligible/external source hit — drop (fail closed).
        continue;
      }
      // Non-source external hits pass through as informational only.
      kept.Add(h);
    }
    return kept;
  }

  public static List<EvidenceRef> ResolveEvidence(InMemoryStore s, IEnumerable<EvidenceRef> refs, Guid boardId, Guid? meetingId)
  {
    var ok = new List<EvidenceRef>();
    foreach (var r in refs)
    {
      if (r is null) continue;
      if (!string.Equals(r.Kind, "source", StringComparison.OrdinalIgnoreCase)) { ok.Add(r); continue; }
      if (!Guid.TryParse(r.Ref, out var sid)) continue;
      if (!s.Sources.TryGetValue(sid, out var doc)) continue;
      if (doc.BoardId != boardId) continue;
      if (!IsEligible(s, doc, meetingId)) continue;
      if (r.Version.HasValue && r.Version.Value != doc.Version) continue; // stale version pin
      // Caller-supplied excerpts are untrusted quotations, not evidence (P2 #10):
      // an eligible identity never authenticates the quoted text. Keep the
      // caller text only when it matches persisted sections; otherwise resolve
      // the canonical excerpt from stored sections.
      var excerpt = r.Excerpt;
      if (!string.IsNullOrWhiteSpace(excerpt) && !ExcerptMatchesSections(s, doc, excerpt!))
        excerpt = null;
      if (string.IsNullOrWhiteSpace(excerpt))
        excerpt = CanonicalSectionText(s, doc);
      ok.Add(new EvidenceRef("source", doc.Id.ToString(), doc.Version, null, doc.FileName, excerpt));
    }
    return ok;
  }
}