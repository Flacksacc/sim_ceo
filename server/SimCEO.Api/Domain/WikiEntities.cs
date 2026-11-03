using System.ComponentModel.DataAnnotations;

namespace SimCEO.Api.Domain;

// Phase7 read-only Wiki.js 2.x connector resource. Persisted separately from
// SourceDoc rows; SourceDocs with Origin=wiki reference ResourceId and carry a
// wiki family key that never collides with upload/file names.
public sealed class WikiResource
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public Guid BoardId { get; set; }
  // "board" or "meeting". Meeting scope pins exactly one valid meeting.
  public string Scope { get; set; } = "board";
  public Guid? MeetingId { get; set; }
  // Normalized origin, e.g. https://wiki.example.com (no path/query/fragment).
  public string BaseUrl { get; set; } = "";
  public string Description { get; set; } = "";
  // Canonical required allowed-use text (product 162/300-302). Must be set
  // before enable; surfaced as permitted-use guidance with excerpts.
  public string AllowedUse { get; set; } = "";
  // Setup-use is explicitly OFF by default; enforced in wizard/extract path.
  public bool SetupUse { get; set; } = false;
  // Manual-only (refresh off): when true the scheduler never auto-syncs.
  public bool ManualOnly { get; set; } = false;
  // JSON arrays of path patterns (exact or prefix/**). Blank allowlist denies all.
  public string AllowlistJson { get; set; } = "[]";
  public string ExclusionsJson { get; set; } = "[]";
  // JSON array of required tags (all must match). Exact, case-sensitive.
  public string RequiredTagsJson { get; set; } = "[]";
  // Exact locale match; empty means any locale passes.
  public string Locale { get; set; } = "";
  // Explicitly disabled by default; enable is an explicit manager action.
  public bool Enabled { get; set; } = false;
  // Monotonically increasing config revision; bumped on URL/rules/scope/interval/allowedUse/manualOnly change.
  public long ConfigRevision { get; set; } = 1;
  // Lifecycle attempt generation; bumped on enable/disable/reconfigure so
  // stale attempts can never commit after disable+reenable with same revision.
  public long AttemptGeneration { get; set; } = 1;
  // Attempt progress idle|running, kept SEPARATE from evidence health
  // (LastStatus pending|succeeded|failed|disabled). Running never makes
  // previously healthy evidence ineligible by itself.
  public string AttemptStatus { get; set; } = "idle";
  public int SyncIntervalMinutes { get; set; } = 60;
  public DateTime? NextSyncAt { get; set; }
  // Evidence health: pending | succeeded | failed | disabled (never "running").
  public string LastStatus { get; set; } = "disabled";
  public string LastError { get; set; } = "";
  public DateTime? LastCompletedAt { get; set; }
  // Config revision + membership of the last successful sync. Eligibility
  // requires ConfigRevision == LastSuccessRevision and family membership.
  public long LastSuccessRevision { get; set; } = 0;
  public DateTime? LastSuccessAt { get; set; }
  // JSON array of wiki family keys usable from the current successful sync.
  public string SuccessPagesJson { get; set; } = "[]";
  public bool HasCredential { get; set; } = false;
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
  public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

// Server-side credential, stored separately from ordinary DTOs and backups.
// Only the protected payload lives here; public DTOs expose HasCredential only.
public sealed class WikiResourceSecret
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public Guid ResourceId { get; set; }
  public string ProtectedToken { get; set; } = "";
  public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
