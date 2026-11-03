using System.ComponentModel.DataAnnotations;

namespace SimCEO.Api.Domain;

public enum AdvisorType { FictionalCharacter }

public enum MeetingState
{
  AwaitingBrief, Active, Yielded, Paused, WrappingUp, AwaitingRecordDecision, ClosedWithRecord, ClosedWithoutPublication
}

public sealed class Board
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public string Name { get; set; } = "";
  public string Mission { get; set; } = "";
  public string Stage { get; set; } = "";
  public bool Archived { get; set; }
  public bool ActiveConfig { get; set; }
  public string DraftJson { get; set; } = "{}";
  public string ActiveJson { get; set; } = "{}";
  public int LeadProfileVersion { get; set; } = 1;
  public bool RetainAudio { get; set; }
  public string BlockedTypes { get; set; } = ""; public string SourcePolicyMode { get; set; } = "allowAll";
  public string DiscussionPolicy { get; set; } = "balanced";
  public string DataUse { get; set; } = "contributor";
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class LeadProfile
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public Guid BoardId { get; set; }
  public int Version { get; set; } = 1;
  public string Name { get; set; } = "";
  public string RoleLabel { get; set; } = "";
  public string Background { get; set; } = "";
  public string FamiliarTopics { get; set; } = "";
  public string SimplerTopics { get; set; } = "";
  public string CommPrefs { get; set; } = "";
  public string ProvenanceJson { get; set; } = "{}";
  public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class RosterEntry
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public Guid AccountId { get; set; }
  public AdvisorType Type { get; set; }
  public string Name { get; set; } = "";
  public string Description { get; set; } = "";
  public string ProfileJson { get; set; } = "{}";
  public int Version { get; set; } = 1;
  public bool Archived { get; set; }
  public string Tags { get; set; } = "";
  public string OwnerKey { get; set; } = "";
  public string ResearchJson { get; set; } = "{}";
  public DateTime? ResearchedAt { get; set; }
  public bool ResearchRequested { get; set; }
  public int EvidenceCount { get; set; }
  public string ResearchJobId { get; set; } = "";
  public int ResearchBaseVersion { get; set; }
  public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class BoardAdvisor
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public Guid BoardId { get; set; }
  public Guid RosterEntryId { get; set; }
  public int RosterVersion { get; set; } = 1;
  public string BoardRole { get; set; } = "";
  public bool Approved { get; set; }
  public bool Removed { get; set; }
  public string ImageProvenance { get; set; } = "initials";
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class Meeting
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public Guid BoardId { get; set; }
  public string Title { get; set; } = "";
  public MeetingState State { get; set; } = MeetingState.AwaitingBrief;
  public string Brief { get; set; } = "";
  public string ParticipantIdsJson { get; set; } = "[]";
  public long DeliveredRevision { get; set; }
  public long Generation { get; set; }
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class Message
{
  public Guid BoardId { get; set; }
  public Guid MeetingId { get; set; }
  public long Sequence { get; set; }
  public Guid AdvisorId { get; set; } = Guid.Empty;
  public string Sender { get; set; } = "";
  public string? AdvisorName { get; set; }
  public string Content { get; set; } = "";
  public long? ParentSequence { get; set; }
  public string Stance { get; set; } = "";
  public string Status { get; set; } = "";
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class RecordDraft
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public Guid BoardId { get; set; }
  public Guid MeetingId { get; set; }
  public int Version { get; set; } = 1;
  public long Watermark { get; set; }
  public string ItemsJson { get; set; } = "[]";
  public string Hash { get; set; } = "";
  public string ApprovedJson { get; set; } = "[]";
  public string SupersedesJson { get; set; } = "[]";
  public bool Decided { get; set; }
  public string Status { get; set; } = "open";
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class SourceDoc
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public Guid BoardId { get; set; }
  public string FileName { get; set; } = "";
  public string ContentHash { get; set; } = "";
  public int Version { get; set; } = 1;
  public bool Approved { get; set; }
  public bool Excluded { get; set; } public string ReviewState { get; set; } = ""; public string Origin { get; set; } = "upload"; public Guid? ResourceId { get; set; } public string FamilyKey { get; set; } = ""; public string IndexState { get; set; } = "queued"; public int IndexGeneration { get; set; } = 0; public string IndexError { get; set; } = ""; public DateTime? IndexCompletedAt { get; set; }
  public string Scope { get; set; } = "board";
  public Guid? MeetingId { get; set; }
  public string ExtractionJson { get; set; } = "{}";
  public byte[]? Original { get; set; }
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class SourceSection
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public Guid BoardId { get; set; }
  public Guid SourceId { get; set; }
  public string FamilyKey { get; set; } = "";
  public int SourceVersion { get; set; } = 1;
  public string ContentHash { get; set; } = "";
  public int Ordinal { get; set; }
  public string Heading { get; set; } = "";
  public string Location { get; set; } = "";
  public string Text { get; set; } = "";
  public int IndexGeneration { get; set; } = 1;
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
public sealed class SourceFamilyHead
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public Guid BoardId { get; set; }
  public string FamilyKey { get; set; } = "";
  public int HeadVersion { get; set; } = 0;
  public Guid HeadSourceId { get; set; } = Guid.Empty;
  public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
public sealed class SourceEvent
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public Guid BoardId { get; set; }
  public Guid SourceId { get; set; }
  public string FamilyKey { get; set; } = "";
  public int Version { get; set; } = 1;
  public string Action { get; set; } = "";
  public string Detail { get; set; } = "";
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
public sealed class WizardDraft
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public int Version { get; set; } = 1;
  public Guid AccountId { get; set; }
  [MaxLength(50)] public string Status { get; set; } = "draft";
  public int Step { get; set; } = 1;
  public string PresetKey { get; set; } = "";
  public string FieldsJson { get; set; } = "{}";
  public string ProvenanceJson { get; set; } = "[]";
  public string InterviewJson { get; set; } = "{}";
  public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class VoiceTurn
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public Guid BoardId { get; set; }
  public Guid MeetingId { get; set; }
  public string State { get; set; } = "draft";
  public string Transcript { get; set; } = "";
  public bool AudioRetained { get; set; }
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class JobRow
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public string IdempotencyKey { get; set; } = "";
  public string Kind { get; set; } = "";
  public string State { get; set; } = "";
  public string Payload { get; set; } = "";
  public int Attempts { get; set; }
  public string Error { get; set; } = "";
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
  public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class Note
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public Guid BoardId { get; set; }
  public Guid MeetingId { get; set; }
  public string Kind { get; set; } = "";
  public string Title { get; set; } = "";
  public string Body { get; set; } = "";
  public string Scope { get; set; } = "";
  public bool Provisional { get; set; }
  public string EvidenceJson { get; set; } = "[]";
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class Grant
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public Guid BoardId { get; set; }
  public Guid? MeetingId { get; set; }
  public string UserKey { get; set; } = "";
  public string Access { get; set; } = "";
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class Invite
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public Guid BoardId { get; set; }
  public Guid? MeetingId { get; set; }
  public string Email { get; set; } = "";
  public string UserKey { get; set; } = "";
  public string State { get; set; } = "pending";
  public string Role { get; set; } = "";
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class AdvisorImage
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public Guid? RosterEntryId { get; set; }
  public Guid? BoardAdvisorId { get; set; }
  [MaxLength(50)] public string Kind { get; set; } = "upload";
  [MaxLength(500)] public string Provenance { get; set; } = "";
  public string Review { get; set; } = "";
  [MaxLength(100)] public string ContentType { get; set; } = "image/png";
  public byte[]? Data { get; set; }
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class Account
{
  [Key] public Guid Id { get; set; } = Guid.NewGuid();
  public string Email { get; set; } = "";
  public string Salt { get; set; } = "";
  public string Hash { get; set; } = "";
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class Session
{
  public string Token { get; set; } = "";
  public Guid AccountId { get; set; }
  public string Email { get; set; } = "";
  public DateTime ExpiresAt { get; set; } = DateTime.UtcNow;
}

public sealed class SpendCap
{
  public string Mode { get; set; } = "";
  public decimal? MonthlyCapUsd { get; set; }
}

public sealed class AuditEvent
{
  public Guid? BoardId { get; set; }
  public string Action { get; set; } = "";
  public string Detail { get; set; } = "";
  public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class UsageRow
{
  public string Kind { get; set; } = "";
  public string Model { get; set; } = "";
  public int InputTokens { get; set; }
  public decimal? Cost { get; set; }
  public Guid? BoardId { get; set; }
  public Guid? MeetingId { get; set; }
  public DateTime At { get; set; } = DateTime.UtcNow;
  public string Note { get; set; } = "";
}
