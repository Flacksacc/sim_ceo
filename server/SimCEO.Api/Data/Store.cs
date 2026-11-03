using System.Collections.Concurrent;

namespace SimCEO.Api.Data;

public sealed class InMemoryStore
{
  public Table<Domain.Board> Boards { get; } = new();
  public Table<Domain.RosterEntry> Roster { get; } = new();
  public Table<Domain.BoardAdvisor> Advisors { get; } = new();
  public Table<Domain.Meeting> Meetings { get; } = new();
  public MessageTable Messages { get; } = new();
  public Table<Domain.RecordDraft> Drafts { get; } = new();
  public Table<Domain.SourceDoc> Sources { get; } = new(); public Table<Domain.SourceSection> SourceSections { get; } = new(); public Table<Domain.SourceFamilyHead> SourceHeads { get; } = new(); public Table<Domain.SourceEvent> SourceEvents { get; } = new();
  public Table<Domain.WikiResource> WikiResources { get; } = new();
  public Table<Domain.WikiResourceSecret> WikiSecrets { get; } = new();
  public Table<Domain.WizardDraft> WizardDrafts { get; } = new();
  public Table<Domain.VoiceTurn> VoiceTurns { get; } = new();
  public Table<Domain.LeadProfile> LeadProfiles { get; } = new();
  public Table<Domain.JobRow> Jobs { get; } = new();
  public Table<Domain.Note> Notes { get; } = new(); public Table<Domain.SecretaryRequest> SecretaryRequests { get; } = new(); public Table<Domain.NoteHistory> NoteHistories { get; } = new();
  public Table<Domain.Grant> Grants { get; } = new();
  public Table<Domain.Invite> Invites { get; } = new();
  public Table<Domain.Membership> Memberships { get; } = new();
  public Table<Domain.SecurityState> Security { get; } = new();
  public Table<Domain.AdvisorImage> Images { get; } = new();
  public Table<Account> Accounts { get; } = new();
  public ConcurrentDictionary<string, Session> Sessions { get; } = new();
  public ConcurrentDictionary<string, List<DateTime>> AuthFails { get; } = new();
  // One per-store root mutation gate. All logical mutator locks below alias
  // this same gate: a single proved order (RootGate -> backend gate) replaces
  // the old multi-lock discipline, so no path can acquire an application lock
  // after entering the backend. Monitor is re-entrant, so existing nested
  // lock(SetupLock){ lock(MessageLock){...}} shapes keep working unchanged.
  // Never hold the root across an awaited provider/network call.
  public object RootGate { get; } = new();
  public object AuthLock => RootGate;
  public Domain.SpendCap Spend { get; set; } = new();
  public object SpendLock => RootGate;
  public string ModelApiKeyOverride { get; set; } = string.Empty;
  public string ModelChatOverride { get; set; } = string.Empty;
  public object ModelLock => RootGate;
  public DateTime? ModelLastTestAt { get; set; }
  public bool ModelLastTestOk { get; set; }
  public string ModelLastTestError { get; set; } = string.Empty;
  public string ModelLastTestModel { get; set; } = string.Empty;
  public Bag<Domain.AuditEvent> Audit { get; } = new(); // audit stays session-lifetime by design
  public DurableBag<Domain.UsageRow> Usage { get; } = new(); // durable installation history in PG; session-lifetime in memory mode
  public DurableBag<Work.ModelCall> ModelCalls { get; } = new(); // durable ledger in PG; session-lifetime in memory mode
  public object MessageLock => RootGate;
  public object SetupLock => RootGate;
  // Process/runtime index epoch: bumped on every successful restore so
  // outstanding index reservations and in-flight publications fail closed
  // instead of committing against replaced state. Runtime-only by design:
  // reservations do not survive restart, so the epoch need not persist.
  public long SourceEpoch { get; set; } = 0;
  // Global restore epoch: fresh process/runtime identity plus the successful
  // replacement revision. Bumped ONLY by a committed domain restore. Every
  // in-flight domain publisher (discussion Run, briefing, secretary answer,
  // transcription finalize, job execution) captures the identity before its
  // async work and rechecks it inside the commit unit, failing closed on
  // mismatch instead of publishing against replaced state.
  public Guid RestoreEpochId { get; set; } = Guid.NewGuid();
  public long RestoreEpochRev { get; set; } = 0;
  // Outstanding index reservations by source id. Set at reservation time
  // (inside the governance locks+transaction) and verified at completion.
  // Cleared + epoch-bumped on restore; never serialized into backups.
  public ConcurrentDictionary<Guid, Work.ActiveIndexJob> ActiveIndexJobs { get; } = new();
  public HashSet<Guid> RunningRuns { get; } = new();
  // ---- Deep memory capture for staged replacement (memory mode) ----
  // Captures every durable collection plus session/security-adjacent state so
  // an outermost store-bound unit failure restores exact prior state: no
  // partial rows, no phantom audits, no resurrected sessions, counters and
  // epochs unchanged. Rows are deep-cloned (never shallow references).
  // Transient coordination (locks, DraftLocks semaphores) is intentionally
  // excluded: it carries no consistency state and cannot be cloned.
  public sealed class MemoryCapture
  {
    public Dictionary<Guid, Domain.Board> Boards = new();
    public Dictionary<Guid, Domain.RosterEntry> Roster = new();
    public Dictionary<Guid, Domain.BoardAdvisor> Advisors = new();
    public Dictionary<Guid, Domain.Meeting> Meetings = new();
    public Dictionary<Guid, List<Domain.Message>> Messages = new();
    public Dictionary<Guid, Domain.RecordDraft> Drafts = new();
    public Dictionary<Guid, Domain.SourceDoc> Sources = new();
    public Dictionary<Guid, Domain.SourceSection> SourceSections = new();
    public Dictionary<Guid, Domain.SourceFamilyHead> SourceHeads = new();
    public Dictionary<Guid, Domain.SourceEvent> SourceEvents = new();
    public Dictionary<Guid, Domain.WikiResource> WikiResources = new();
    public Dictionary<Guid, Domain.WikiResourceSecret> WikiSecrets = new();
    public Dictionary<Guid, Domain.WizardDraft> WizardDrafts = new();
    public Dictionary<Guid, Domain.VoiceTurn> VoiceTurns = new();
    public Dictionary<Guid, Domain.LeadProfile> LeadProfiles = new();
    public Dictionary<Guid, Domain.JobRow> Jobs = new();
    public Dictionary<Guid, Domain.Note> Notes = new();
    public Dictionary<Guid, Domain.SecretaryRequest> SecretaryRequests = new();
    public Dictionary<Guid, Domain.NoteHistory> NoteHistories = new();
    public Dictionary<Guid, Domain.Grant> Grants = new();
    public Dictionary<Guid, Domain.Invite> Invites = new();
    public Dictionary<Guid, Domain.Membership> Memberships = new();
    public Dictionary<Guid, Domain.SecurityState> Security = new();
    public Dictionary<Guid, Domain.AdvisorImage> Images = new();
    public Dictionary<Guid, Account> Accounts = new();
    public List<Domain.AuditEvent> Audit = new();
    // Installation ledgers (Usage/ModelCalls) and the global spend cap are
    // intentionally EXCLUDED: a failing domain unit must never erase a
    // concurrently finalized paid pair or rewind billing (Ops boundary).
    // Pair atomicity belongs to the ledger writer itself (RecordFull).
    public Dictionary<string, Session> Sessions = new(StringComparer.Ordinal);
    public Dictionary<string, List<DateTime>> AuthFails = new(StringComparer.Ordinal);
    public Dictionary<Guid, Work.ActiveIndexJob> ActiveIndexJobs = new();
    public HashSet<Guid> RunningRuns = new();
    public Guid RestoreEpochId;
    public long RestoreEpochRev;
    public long SourceEpoch;
    public string PgError = "";
    public string ModelApiKeyOverride = "";
    public string ModelChatOverride = "";
    public DateTime? ModelLastTestAt;
    public bool ModelLastTestOk;
    public string ModelLastTestError = "";
    public string ModelLastTestModel = "";
  }

  private static T Deep<T>(T value)
  {
    var json = System.Text.Json.JsonSerializer.Serialize(value);
    return System.Text.Json.JsonSerializer.Deserialize<T>(json)!;
  }

  public MemoryCapture CaptureMemory()
  {
    if (MemFaults.FailCapture?.Invoke() == true) throw new InvalidOperationException("injected memory capture fault");
    var c = new MemoryCapture
    {
      Boards = Boards.CaptureLive(),
      Roster = Roster.CaptureLive(),
      Advisors = Advisors.CaptureLive(),
      Meetings = Meetings.CaptureLive(),
      Messages = Messages.CaptureLive(),
      Drafts = Drafts.CaptureLive(),
      Sources = Sources.CaptureLive(),
      SourceSections = SourceSections.CaptureLive(),
      SourceHeads = SourceHeads.CaptureLive(),
      SourceEvents = SourceEvents.CaptureLive(),
      WikiResources = WikiResources.CaptureLive(),
      WikiSecrets = WikiSecrets.CaptureLive(),
      WizardDrafts = WizardDrafts.CaptureLive(),
      VoiceTurns = VoiceTurns.CaptureLive(),
      LeadProfiles = LeadProfiles.CaptureLive(),
      Jobs = Jobs.CaptureLive(),
      Notes = Notes.CaptureLive(),
      SecretaryRequests = SecretaryRequests.CaptureLive(),
      NoteHistories = NoteHistories.CaptureLive(),
      Grants = Grants.CaptureLive(),
      Invites = Invites.CaptureLive(),
      Memberships = Memberships.CaptureLive(),
      Security = Security.CaptureLive(),
      Images = Images.CaptureLive(),
      Accounts = Accounts.CaptureLive(),
      Audit = Audit.CaptureLive(),
      Sessions = Sessions.ToDictionary(kv => kv.Key, kv => Deep(kv.Value), StringComparer.Ordinal),
      AuthFails = AuthFails.ToDictionary(kv => kv.Key, kv => kv.Value.ToList(), StringComparer.Ordinal),
      ActiveIndexJobs = ActiveIndexJobs.ToDictionary(kv => kv.Key, kv => kv.Value),
      RunningRuns = RunningRuns.ToHashSet(),
      RestoreEpochId = RestoreEpochId,
      RestoreEpochRev = RestoreEpochRev,
      SourceEpoch = SourceEpoch,
      PgError = PgError,
      ModelApiKeyOverride = ModelApiKeyOverride,
      ModelChatOverride = ModelChatOverride,
      ModelLastTestAt = ModelLastTestAt,
      ModelLastTestOk = ModelLastTestOk,
      ModelLastTestError = ModelLastTestError,
      ModelLastTestModel = ModelLastTestModel,
    };
    return c;
  }

  public void RestoreMemory(MemoryCapture c)
  {
    Boards.RestoreLive(c.Boards);
    Roster.RestoreLive(c.Roster);
    Advisors.RestoreLive(c.Advisors);
    Meetings.RestoreLive(c.Meetings);
    Messages.RestoreLive(c.Messages);
    Drafts.RestoreLive(c.Drafts);
    Sources.RestoreLive(c.Sources);
    SourceSections.RestoreLive(c.SourceSections);
    SourceHeads.RestoreLive(c.SourceHeads);
    SourceEvents.RestoreLive(c.SourceEvents);
    WikiResources.RestoreLive(c.WikiResources);
    WikiSecrets.RestoreLive(c.WikiSecrets);
    WizardDrafts.RestoreLive(c.WizardDrafts);
    VoiceTurns.RestoreLive(c.VoiceTurns);
    LeadProfiles.RestoreLive(c.LeadProfiles);
    Jobs.RestoreLive(c.Jobs);
    Notes.RestoreLive(c.Notes);
    SecretaryRequests.RestoreLive(c.SecretaryRequests);
    NoteHistories.RestoreLive(c.NoteHistories);
    Grants.RestoreLive(c.Grants);
    Invites.RestoreLive(c.Invites);
    Memberships.RestoreLive(c.Memberships);
    Security.RestoreLive(c.Security);
    Images.RestoreLive(c.Images);
    Accounts.RestoreLive(c.Accounts);
    Audit.RestoreLive(c.Audit);
    // Two-phase: fallible deep-clones first, infallible swaps after. The table
    // restores above already follow the same rule.
    var freshSessions = new Dictionary<string, Session>(StringComparer.Ordinal);
    foreach (var kv in c.Sessions) freshSessions[kv.Key] = Deep(kv.Value);
    var freshFails = new Dictionary<string, List<DateTime>>(StringComparer.Ordinal);
    foreach (var kv in c.AuthFails) freshFails[kv.Key] = kv.Value.ToList();
    Sessions.Clear();
    foreach (var kv in freshSessions) Sessions[kv.Key] = kv.Value;
    AuthFails.Clear();
    foreach (var kv in freshFails) AuthFails[kv.Key] = kv.Value;
    ActiveIndexJobs.Clear();
    foreach (var kv in c.ActiveIndexJobs) ActiveIndexJobs[kv.Key] = kv.Value;
    RunningRuns.Clear();
    foreach (var g in c.RunningRuns) RunningRuns.Add(g);
    RestoreEpochId = c.RestoreEpochId;
    RestoreEpochRev = c.RestoreEpochRev;
    SourceEpoch = c.SourceEpoch;
    PgError = c.PgError;
    ModelApiKeyOverride = c.ModelApiKeyOverride;
    ModelChatOverride = c.ModelChatOverride;
    ModelLastTestAt = c.ModelLastTestAt;
    ModelLastTestOk = c.ModelLastTestOk;
    ModelLastTestError = c.ModelLastTestError;
    ModelLastTestModel = c.ModelLastTestModel;
  }
  public ConcurrentDictionary<Guid, System.Threading.SemaphoreSlim> DraftLocks { get; } = new();
  public string PgError { get; set; } = "";
}

