using System.Collections.Concurrent;

namespace SimCEO.Api.Data;

/// <summary>
/// Storage facade. In-memory by default; when the app enables Postgres
/// (USE_POSTGRES=1 with a reachable connection string), tables are backed
/// by EF Core via <see cref="Postgres.IPostgresBackend"/> and the
/// dictionaries below are used only for AuthFails (rate-limit scratch).
/// </summary>
public sealed class InMemoryStore
{
  public Table<Domain.Board> Boards { get; } = new();
  public Table<Domain.RosterEntry> Roster { get; } = new();
  public Table<Domain.BoardAdvisor> Advisors { get; } = new();
  public Table<Domain.Meeting> Meetings { get; } = new();
  public MessageTable Messages { get; } = new();
  public Table<Domain.RecordDraft> Drafts { get; } = new();
  public Table<Domain.SourceDoc> Sources { get; } = new(); public Table<Domain.SourceSection> SourceSections { get; } = new(); public Table<Domain.SourceFamilyHead> SourceHeads { get; } = new(); public Table<Domain.SourceEvent> SourceEvents { get; } = new();
  public Table<Domain.WizardDraft> WizardDrafts { get; } = new();
  public Table<Domain.VoiceTurn> VoiceTurns { get; } = new();
  public Table<Domain.LeadProfile> LeadProfiles { get; } = new();
  public Table<Domain.JobRow> Jobs { get; } = new();
  public Table<Domain.Note> Notes { get; } = new(); public Table<Domain.SecretaryRequest> SecretaryRequests { get; } = new(); public Table<Domain.NoteHistory> NoteHistories { get; } = new();
  public Table<Domain.Grant> Grants { get; } = new();
  public Table<Domain.Invite> Invites { get; } = new();
  public Table<Domain.AdvisorImage> Images { get; } = new();
  public Table<Account> Accounts { get; } = new();
  public ConcurrentDictionary<string, Session> Sessions { get; } = new();
  public ConcurrentDictionary<string, List<DateTime>> AuthFails { get; } = new();
  public object AuthLock { get; } = new();
  public Domain.SpendCap Spend { get; } = new();
  public object SpendLock { get; } = new();
  public string ModelApiKeyOverride { get; set; } = string.Empty;
  public string ModelChatOverride { get; set; } = string.Empty;
  public object ModelLock { get; } = new();
  public DateTime? ModelLastTestAt { get; set; }
  public bool ModelLastTestOk { get; set; }
  public string ModelLastTestError { get; set; } = string.Empty;
  public string ModelLastTestModel { get; set; } = string.Empty;
  public Bag<Domain.AuditEvent> Audit { get; } = new();
  public Bag<Domain.UsageRow> Usage { get; } = new();
  public Bag<Work.ModelCall> ModelCalls { get; } = new();
  public object MessageLock { get; } = new();
  public object SetupLock { get; } = new();
  public HashSet<Guid> RunningRuns { get; } = new();
  public ConcurrentDictionary<Guid, System.Threading.SemaphoreSlim> DraftLocks { get; } = new();
  public string PgError { get; set; } = "";
}
