using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.Storage;
using SimCEO.Api;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Postgres;

public sealed class PostgresDb : DbContext
{
  public PostgresDb(DbContextOptions<PostgresDb> options) : base(options) { }

  public DbSet<Board> Boards => Set<Board>();
  public DbSet<RosterEntry> RosterEntries => Set<RosterEntry>();
  public DbSet<BoardAdvisor> BoardAdvisors => Set<BoardAdvisor>();
  public DbSet<Meeting> Meetings => Set<Meeting>();
  public DbSet<Message> Messages => Set<Message>();
  public DbSet<RecordDraft> Drafts => Set<RecordDraft>();
  public DbSet<SourceDoc> Sources => Set<SourceDoc>(); public DbSet<SourceSection> SourceSections => Set<SourceSection>(); public DbSet<SourceFamilyHead> SourceHeads => Set<SourceFamilyHead>(); public DbSet<SourceEvent> SourceEvents => Set<SourceEvent>();
  public DbSet<WikiResource> WikiResources => Set<WikiResource>();
  public DbSet<WikiResourceSecret> WikiSecrets => Set<WikiResourceSecret>();
  public DbSet<WizardDraft> WizardDrafts => Set<WizardDraft>();
  public DbSet<VoiceTurn> VoiceTurns => Set<VoiceTurn>();
  public DbSet<LeadProfile> LeadProfiles => Set<LeadProfile>();
  public DbSet<JobRow> Jobs => Set<JobRow>();
  public DbSet<Note> Notes => Set<Note>();
  public DbSet<SecretaryRequest> SecretaryRequests => Set<SecretaryRequest>();
  public DbSet<NoteHistory> NoteHistories => Set<NoteHistory>();
  public DbSet<Grant> Grants => Set<Grant>();
  public DbSet<Invite> Invites => Set<Invite>();
  public DbSet<AdvisorImage> Images => Set<AdvisorImage>();
  public DbSet<SimCEO.Api.Account> AuthAccounts => Set<SimCEO.Api.Account>();
  public DbSet<Membership> Memberships => Set<Membership>();
  public DbSet<SecurityState> SecurityStates => Set<SecurityState>();
  public DbSet<UsageRow> UsageRows => Set<UsageRow>();
  public DbSet<InstallationPolicy> InstallationPolicies => Set<InstallationPolicy>();
  public DbSet<SimCEO.Api.Work.ModelCall> ModelCalls => Set<SimCEO.Api.Work.ModelCall>();

  protected override void OnModelCreating(ModelBuilder b)
  {
    b.Entity<Message>().HasKey(m => new { m.MeetingId, m.Sequence });
    b.Entity<SourceDoc>().HasIndex(x => x.BoardId);
    // Phase 6 uniqueness: one version identity per family, one head per family.
    // Legacy collisions are resolved by the controlled startup migration BEFORE
    // these constraints are enforced (see PgBoot.EnsureUniqueIndexes), and all
    // writes allocate+insert in one serialized transaction, so these constraints
    // only ever guard against out-of-band writes.
    b.Entity<SourceDoc>().HasIndex(x => new { x.BoardId, x.FamilyKey, x.Version }).IsUnique();
    b.Entity<SourceFamilyHead>().HasIndex(x => new { x.BoardId, x.FamilyKey }).IsUnique();
    b.Entity<BoardAdvisor>().HasIndex(x => x.BoardId);
    b.Entity<Meeting>().HasIndex(x => x.BoardId);
    b.Entity<SimCEO.Api.Account>().HasIndex(a => a.Email).IsUnique();
    b.Entity<UsageRow>().HasIndex(x => x.BoardId);
    b.Entity<UsageRow>().HasIndex(x => x.MeetingId);
    b.Entity<UsageRow>().HasIndex(x => x.At);
    b.Entity<SimCEO.Api.Work.ModelCall>().HasIndex(x => x.BoardId);
    b.Entity<SimCEO.Api.Work.ModelCall>().HasIndex(x => x.MeetingId);
    b.Entity<SimCEO.Api.Work.ModelCall>().HasIndex(x => x.At);
  }
}

public sealed class DesignFactory : IDesignTimeDbContextFactory<PostgresDb>
{
  public PostgresDb CreateDbContext(string[] args)
  {
    var cs = Environment.GetEnvironmentVariable("CONNECTIONSTRINGS__APP")
      ?? "Host=localhost;Port=5432;Database=simceo;Username=simceo;Password=simceo-dev-only";
    var options = new DbContextOptionsBuilder<PostgresDb>().UseNpgsql(cs).Options;
    return new PostgresDb(options);
  }
}

/// <summary>Lock-serialized EF backend (DbContext is not thread-safe; one long-lived context keeps tracking).</summary>
public sealed class PostgresBackend : IPgBackend
{
  private readonly PostgresDb _db;
  private readonly object _gate = new();
  private int _depth;
  private IDbContextTransaction? _tx;

  public PostgresBackend(PostgresDb db) => _db = db;

  public bool IsTransacting { get { lock (_gate) return _depth > 0; } }

  public void Transact(Action op)
  {
    Transact(() => { op(); return true; });
  }

  public T Transact<T>(Func<T> op)
  {
    lock (_gate)
    {
      if (_depth > 0) return op();
      IDbContextTransaction? tx = null;
      var commitAttempted = false;
      try
      {
        tx = _db.Database.BeginTransaction();
        _tx = tx;
        _depth = 1;
        var result = op();
        _db.SaveChanges();
        var failCommit = false;
        try { failCommit = SimCEO.Api.Data.PgFaults.FailBeforeCommit?.Invoke() == true; } catch { failCommit = false; }
        if (failCommit) throw new InvalidOperationException("injected commit fault (PgFaults.FailBeforeCommit)");
        commitAttempted = true;
        tx.Commit();
        var lostAck = false;
        try { lostAck = SimCEO.Api.Data.PgFaults.FailAfterCommitAck?.Invoke() == true; } catch { lostAck = false; }
        if (lostAck) throw new SimCEO.Api.Data.CommitUnknownException("injected lost acknowledgement after successful commit (PgFaults.FailAfterCommitAck)", new TimeoutException("simulated lost commit acknowledgement"));
        return result;
      }
      catch (SimCEO.Api.Data.CommitUnknownException)
      {
        try { tx?.Rollback(); } catch { }
        try { _db.ChangeTracker.Clear(); } catch { }
        throw;
      }
      catch (Exception ex)
      {
        if (commitAttempted && IsTransportFailure(ex))
        {
          try { tx?.Rollback(); } catch { }
          try { _db.ChangeTracker.Clear(); } catch { }
          throw new SimCEO.Api.Data.CommitUnknownException("commit failed with a transport-level error; outcome unknown (commit may have succeeded).", ex);
        }
        try { tx?.Rollback(); } catch { }
        try { _db.ChangeTracker.Clear(); } catch { }
        throw;
      }
      finally
      {
        try { tx?.Dispose(); } catch { }
        _tx = null;
        _depth = 0;
      }
    }
  }

  private static bool IsTransportFailure(Exception ex)
  {
    for (var e = ex; e is not null; e = e.InnerException)
    {
      if (e is TimeoutException || e is System.IO.IOException || e is System.Net.Sockets.SocketException) return true;
      var tn = e.GetType().FullName ?? "";
      if (tn.Contains("Npgsql"))
      {
        try
        {
          var sp = e.GetType().GetProperty("SqlState");
          var sv = sp?.GetValue(e) as string;
          if (string.IsNullOrEmpty(sv)) return true;
        }
        catch { }
      }
    }
    return false;
  }

  public T? Find<T>(Guid id) where T : class
  {
    lock (_gate) return _db.Set<T>().Find(id);
  }

  public List<T> All<T>() where T : class
  {
    lock (_gate)
    {
      var rows = _db.Set<T>().ToList();
      if (_depth == 0) return rows;
      // Union staged additions so reads inside the unit see staged rows.
      var staged = _db.ChangeTracker.Entries<T>()
        .Where(e => e.State == EntityState.Added).Select(e => e.Entity).ToList();
      var removed = new HashSet<object>(_db.ChangeTracker.Entries<T>()
        .Where(e => e.State == EntityState.Deleted).Select(e => (object)e.Entity));
      if (staged.Count == 0 && removed.Count == 0) return rows;
      var merged = rows.Where(r => !removed.Contains(r)).ToList();
      if (staged.Count == 0) return merged;
      var keyProp = typeof(T).GetProperty("Id");
      if (keyProp is not null)
      {
        var keys = new HashSet<object?>(merged.Select(r => keyProp.GetValue(r)));
        foreach (var s in staged)
          if (keys.Add(keyProp.GetValue(s))) merged.Add(s);
      }
      else merged.AddRange(staged);
      return merged;
    }
  }

  public void Upsert<T>(T entity) where T : class
  {
    lock (_gate)
    {
      var keyName = _db.Model.FindEntityType(typeof(T))!.FindPrimaryKey()!.Properties[0].Name;
      var id = _db.Entry(entity).Property(keyName).CurrentValue;
      var existing = _db.Set<T>().Find(id);
      if (existing is null) _db.Set<T>().Add(entity);
      else
      {
        var entry = _db.Entry(existing);
        if (entry.State == EntityState.Deleted)
        {
          if (!ReferenceEquals(existing, entity))
            entry.CurrentValues.SetValues(entity);
          entry.State = EntityState.Modified;
        }
        else if (!ReferenceEquals(existing, entity))
          entry.CurrentValues.SetValues(entity);
      }
    }
  }

  public bool Remove<T>(Guid id) where T : class
  {
    lock (_gate)
    {
      var existing = _db.Set<T>().Find(id);
      if (existing is null) return false;
      _db.Set<T>().Remove(existing);
      return true;
    }
  }

  public void Clear<T>() where T : class
  {
    lock (_gate) _db.Set<T>().RemoveRange(_db.Set<T>());
  }

  public void AddMessage(Message m)
  {
    lock (_gate) _db.Messages.Add(m);
  }

  public void AddMessages(IEnumerable<Message> ms)
  {
    lock (_gate) _db.Messages.AddRange(ms);
  }

  public List<Message> MeetingMessages(Guid meetingId)
  {
    lock (_gate)
    {
      var rows = _db.Messages.Where(m => m.MeetingId == meetingId).OrderBy(m => m.Sequence).ToList();
      if (_depth == 0) return rows;
      var staged = _db.ChangeTracker.Entries<Message>()
        .Where(e => e.State == EntityState.Added && e.Entity.MeetingId == meetingId)
        .Select(e => e.Entity).ToList();
      if (staged.Count == 0) return rows;
      var seqs = new HashSet<long>(rows.Select(r => r.Sequence));
      foreach (var s in staged)
        if (seqs.Add(s.Sequence)) rows.Add(s);
      return rows.OrderBy(m => m.Sequence).ToList();
    }
  }

  public List<Guid> MessageMeetings()
  {
    lock (_gate)
    {
      var ids = _db.Messages.Select(m => m.MeetingId).Distinct().ToList();
      if (_depth > 0)
        foreach (var s in _db.ChangeTracker.Entries<Message>()
          .Where(e => e.State == EntityState.Added).Select(e => e.Entity.MeetingId).Distinct())
          if (!ids.Contains(s)) ids.Add(s);
      return ids;
    }
  }

  public void RemoveMeetingMessages(Guid meetingId)
  {
    lock (_gate) _db.Messages.RemoveRange(_db.Messages.Where(m => m.MeetingId == meetingId));
  }

  public void ClearMessages()
  {
    lock (_gate) _db.Messages.RemoveRange(_db.Messages);
  }

  public void Save()
  {
    lock (_gate)
    {
      if (_depth > 0) return; // deferred: single SaveChanges at Transact commit
      _db.SaveChanges();
    }
  }
}

public static class PgBoot
{
  private static int DdlStep = -1;
  private static void Ddl(Npgsql.NpgsqlConnection conn, string sql, int step)
  {
    DdlStep = step;
    using var cmd = new Npgsql.NpgsqlCommand(sql, conn);
    cmd.ExecuteNonQuery();
  }
  public static bool TryWire(string cs, out string error)
  {
    error = "";
    try
    {
      var options = new DbContextOptionsBuilder<PostgresDb>().UseNpgsql(cs).Options;
      var db = new PostgresDb(options);
      if (!db.Database.CanConnect())
      {
        error = "Postgres unreachable; refusing in-memory fallback for requested PG mode.";
        return false;
      }
      using var conn = new Npgsql.NpgsqlConnection(cs);
      conn.Open();
      // Explicit schema creation: every entity table is created IF NOT EXISTS so BOTH fresh
      // databases and 94d predecessors (which lack Memberships/SecurityStates and newer columns)
      // upgrade deterministically. Additive ALTERs below backfill newer columns.
      Ddl(conn, "CREATE TABLE IF NOT EXISTS \"Boards\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"Name\" text NOT NULL DEFAULT \'\', \"Mission\" text NOT NULL DEFAULT \'\', \"Stage\" text NOT NULL DEFAULT \'\', \"Archived\" boolean NOT NULL DEFAULT false, \"ActiveConfig\" boolean NOT NULL DEFAULT false, \"DraftJson\" text NOT NULL DEFAULT \'{}\' , \"ActiveJson\" text NOT NULL DEFAULT \'{}\' , \"LeadProfileVersion\" integer NOT NULL DEFAULT 1, \"RetainAudio\" boolean NOT NULL DEFAULT false, \"BlockedTypes\" text NOT NULL DEFAULT \'\', \"DiscussionPolicy\" text NOT NULL DEFAULT \'balanced\', \"DataUse\" text NOT NULL DEFAULT \'contributor\', \"OwnerKey\" text NOT NULL DEFAULT \'\', \"AccessEnforced\" boolean NOT NULL DEFAULT false, \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT now())", 1);
      Ddl(conn, "CREATE TABLE IF NOT EXISTS \"RosterEntries\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"AccountId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"Type\" integer NOT NULL DEFAULT 0, \"Name\" text NOT NULL DEFAULT \'\', \"Description\" text NOT NULL DEFAULT \'\', \"ProfileJson\" text NOT NULL DEFAULT \'{}\' , \"Version\" integer NOT NULL DEFAULT 1, \"Archived\" boolean NOT NULL DEFAULT false, \"Tags\" text NOT NULL DEFAULT \'\', \"OwnerKey\" text NOT NULL DEFAULT \'\', \"ResearchJson\" text NOT NULL DEFAULT \'{}\' , \"ResearchedAt\" timestamp with time zone, \"ResearchRequested\" boolean NOT NULL DEFAULT false, \"EvidenceCount\" integer NOT NULL DEFAULT 0, \"ResearchJobId\" text NOT NULL DEFAULT \'\', \"ResearchBaseVersion\" integer NOT NULL DEFAULT 0, \"UpdatedAt\" timestamp with time zone NOT NULL DEFAULT now())", 2);
      Ddl(conn, "CREATE TABLE IF NOT EXISTS \"BoardAdvisors\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"BoardId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"RosterEntryId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"RosterVersion\" integer NOT NULL DEFAULT 1, \"BoardRole\" text NOT NULL DEFAULT \'\', \"Approved\" boolean NOT NULL DEFAULT false, \"Removed\" boolean NOT NULL DEFAULT false, \"ImageProvenance\" text NOT NULL DEFAULT \'initials\', \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT now())", 3);
      Ddl(conn, "CREATE TABLE IF NOT EXISTS \"Meetings\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"BoardId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"Title\" text NOT NULL DEFAULT \'\', \"State\" integer NOT NULL DEFAULT 0, \"Brief\" text NOT NULL DEFAULT \'\', \"ParticipantIdsJson\" text NOT NULL DEFAULT \'[]\', \"DeliveredRevision\" bigint NOT NULL DEFAULT 0, \"Generation\" bigint NOT NULL DEFAULT 0, \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT now())", 4);
      Ddl(conn, "CREATE TABLE IF NOT EXISTS \"Messages\" (\"MeetingId\" uuid NOT NULL, \"Sequence\" bigint NOT NULL, \"BoardId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"AdvisorId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"Sender\" text NOT NULL DEFAULT \'\', \"AdvisorName\" text, \"Content\" text NOT NULL DEFAULT \'\', \"ParentSequence\" bigint, \"Stance\" character varying(30) NOT NULL DEFAULT \'\', \"Status\" text NOT NULL DEFAULT \'\', \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT now(), PRIMARY KEY (\"MeetingId\", \"Sequence\"))", 5);
      Ddl(conn, "CREATE TABLE IF NOT EXISTS \"Drafts\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"BoardId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"MeetingId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"Version\" integer NOT NULL DEFAULT 1, \"Watermark\" bigint NOT NULL DEFAULT 0, \"ItemsJson\" text NOT NULL DEFAULT \'[]\', \"Hash\" text NOT NULL DEFAULT \'\', \"ApprovedJson\" text NOT NULL DEFAULT \'[]\', \"SupersedesJson\" text NOT NULL DEFAULT \'[]\', \"Decided\" boolean NOT NULL DEFAULT false, \"Status\" text NOT NULL DEFAULT \'open\', \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT now())", 6);
      Ddl(conn, "CREATE TABLE IF NOT EXISTS \"Sources\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"BoardId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"FileName\" text NOT NULL DEFAULT \'\', \"ContentHash\" text NOT NULL DEFAULT \'\', \"Version\" integer NOT NULL DEFAULT 1, \"Approved\" boolean NOT NULL DEFAULT false, \"Excluded\" boolean NOT NULL DEFAULT false, \"Scope\" text NOT NULL DEFAULT \'board\', \"MeetingId\" uuid, \"ExtractionJson\" text NOT NULL DEFAULT \'{}\' , \"Original\" bytea, \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT now())", 7);
      Ddl(conn, "CREATE TABLE IF NOT EXISTS \"WizardDrafts\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"Version\" integer NOT NULL DEFAULT 1, \"AccountId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"Status\" character varying(50) NOT NULL DEFAULT \'draft\', \"Step\" integer NOT NULL DEFAULT 1, \"PresetKey\" text NOT NULL DEFAULT \'\', \"FieldsJson\" text NOT NULL DEFAULT \'{}\' , \"ProvenanceJson\" text NOT NULL DEFAULT \'[]\', \"InterviewJson\" text NOT NULL DEFAULT \'{}\' , \"OwnerKey\" text NOT NULL DEFAULT \'\', \"UpdatedAt\" timestamp with time zone NOT NULL DEFAULT now())", 8);
      Ddl(conn, "CREATE TABLE IF NOT EXISTS \"VoiceTurns\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"BoardId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"MeetingId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"CreatorKey\" text NOT NULL DEFAULT \'\', \"State\" text NOT NULL DEFAULT \'draft\', \"Transcript\" text NOT NULL DEFAULT \'\', \"AudioRetained\" boolean NOT NULL DEFAULT false, \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT now())", 9);
      Ddl(conn, "CREATE TABLE IF NOT EXISTS \"LeadProfiles\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"BoardId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"Version\" integer NOT NULL DEFAULT 1, \"Name\" text NOT NULL DEFAULT \'\', \"RoleLabel\" text NOT NULL DEFAULT \'\', \"Background\" text NOT NULL DEFAULT \'\', \"FamiliarTopics\" text NOT NULL DEFAULT \'\', \"SimplerTopics\" text NOT NULL DEFAULT \'\', \"CommPrefs\" text NOT NULL DEFAULT \'\', \"ProvenanceJson\" text NOT NULL DEFAULT \'{}\' , \"UpdatedAt\" timestamp with time zone NOT NULL DEFAULT now())", 10);
      Ddl(conn, "CREATE TABLE IF NOT EXISTS \"Jobs\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"IdempotencyKey\" text NOT NULL DEFAULT \'\', \"Kind\" text NOT NULL DEFAULT \'\', \"State\" text NOT NULL DEFAULT \'\', \"Payload\" text NOT NULL DEFAULT \'\', \"Attempts\" integer NOT NULL DEFAULT 0, \"Error\" text NOT NULL DEFAULT \'\', \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT now(), \"UpdatedAt\" timestamp with time zone NOT NULL DEFAULT now())", 11);
      Ddl(conn, "CREATE TABLE IF NOT EXISTS \"Notes\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"BoardId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"MeetingId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"Kind\" text NOT NULL DEFAULT \'\', \"Title\" text NOT NULL DEFAULT \'\', \"Body\" text NOT NULL DEFAULT \'\', \"Scope\" text NOT NULL DEFAULT \'\', \"Provisional\" boolean NOT NULL DEFAULT false, \"EvidenceJson\" text NOT NULL DEFAULT \'[]\', \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT now())", 12);
      Ddl(conn, "CREATE TABLE IF NOT EXISTS \"Grants\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"BoardId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"MeetingId\" uuid, \"UserKey\" text NOT NULL DEFAULT \'\', \"Access\" text NOT NULL DEFAULT \'\', \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT now())", 13);
      Ddl(conn, "CREATE TABLE IF NOT EXISTS \"Invites\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"BoardId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"MeetingId\" uuid, \"Email\" text NOT NULL DEFAULT \'\', \"UserKey\" text NOT NULL DEFAULT \'\', \"State\" text NOT NULL DEFAULT \'pending\', \"Role\" text NOT NULL DEFAULT \'\', \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT now())", 14);
      Ddl(conn, "CREATE TABLE IF NOT EXISTS \"Images\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"RosterEntryId\" uuid, \"BoardAdvisorId\" uuid, \"Kind\" character varying(50) NOT NULL DEFAULT \'upload\', \"Provenance\" character varying(500) NOT NULL DEFAULT \'\', \"Review\" text NOT NULL DEFAULT \'\', \"ContentType\" character varying(100) NOT NULL DEFAULT \'image/png\', \"Data\" bytea, \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT now())", 15);
      Ddl(conn, "CREATE TABLE IF NOT EXISTS \"AuthAccounts\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"Email\" text NOT NULL DEFAULT \'\', \"Salt\" text NOT NULL DEFAULT \'\', \"Hash\" text NOT NULL DEFAULT \'\', \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT now())", 16);
      Ddl(conn, "CREATE UNIQUE INDEX IF NOT EXISTS \"IX_AuthAccounts_Email\" ON \"AuthAccounts\" (\"Email\")", 17);
      Ddl(conn, "CREATE TABLE IF NOT EXISTS \"Memberships\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"BoardId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"MeetingId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"UserKey\" text NOT NULL DEFAULT \'\', \"Active\" boolean NOT NULL DEFAULT true, \"JoinedAt\" timestamp with time zone NOT NULL DEFAULT now(), \"LeftAt\" timestamp with time zone)", 18);
      Ddl(conn, "CREATE TABLE IF NOT EXISTS \"SecurityStates\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"AuthRequired\" boolean NOT NULL DEFAULT false, \"AdminEmail\" text NOT NULL DEFAULT \'\', \"AdminAccountId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\', \"MigrationDone\" boolean NOT NULL DEFAULT false, \"UpdatedAt\" timestamp with time zone NOT NULL DEFAULT now(), \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT now())", 19);
      Ddl(conn, "CREATE INDEX IF NOT EXISTS \"IX_Sources_BoardId\" ON \"Sources\" (\"BoardId\")", 20);
      Ddl(conn, "CREATE INDEX IF NOT EXISTS \"IX_BoardAdvisors_BoardId\" ON \"BoardAdvisors\" (\"BoardId\")", 21);
      Ddl(conn, "CREATE INDEX IF NOT EXISTS \"IX_Meetings_BoardId\" ON \"Meetings\" (\"BoardId\")", 22);
      Ddl(conn, "ALTER TABLE \"WizardDrafts\" ADD COLUMN IF NOT EXISTS \"OwnerKey\" text NOT NULL DEFAULT \'\'", 23);
      Ddl(conn, "ALTER TABLE \"VoiceTurns\" ADD COLUMN IF NOT EXISTS \"CreatorKey\" text NOT NULL DEFAULT \'\'", 24);
      Ddl(conn, "ALTER TABLE \"SecurityStates\" ADD COLUMN IF NOT EXISTS \"MigrationDone\" boolean NOT NULL DEFAULT false", 25);
      Ddl(conn, "ALTER TABLE \"SecurityStates\" ADD COLUMN IF NOT EXISTS \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT now()", 38);
      Ddl(conn, "ALTER TABLE \"Messages\" ADD COLUMN IF NOT EXISTS \"ParentSequence\" bigint", 26);
      Ddl(conn, "ALTER TABLE \"Messages\" ADD COLUMN IF NOT EXISTS \"Stance\" character varying(30) NOT NULL DEFAULT ''", 27);
      Ddl(conn, "ALTER TABLE \"Messages\" ADD COLUMN IF NOT EXISTS \"AdvisorId\" uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'", 28);
      Ddl(conn, "ALTER TABLE \"Notes\" ADD COLUMN IF NOT EXISTS \"EvidenceJson\" text NOT NULL DEFAULT '[]'", 29);
      Ddl(conn, "ALTER TABLE \"WizardDrafts\" ADD COLUMN IF NOT EXISTS \"Version\" integer NOT NULL DEFAULT 1", 30);
      Ddl(conn, "ALTER TABLE \"RosterEntries\" ADD COLUMN IF NOT EXISTS \"ResearchJobId\" text NOT NULL DEFAULT ''", 31);
      Ddl(conn, "ALTER TABLE \"RosterEntries\" ADD COLUMN IF NOT EXISTS \"ResearchBaseVersion\" integer NOT NULL DEFAULT 0", 32);
      Ddl(conn, "ALTER TABLE \"RosterEntries\" ADD COLUMN IF NOT EXISTS \"OwnerKey\" text NOT NULL DEFAULT ''", 33);
      Ddl(conn, "ALTER TABLE \"Boards\" ADD COLUMN IF NOT EXISTS \"OwnerKey\" text NOT NULL DEFAULT ''", 34);
      Ddl(conn, "ALTER TABLE \"Boards\" ADD COLUMN IF NOT EXISTS \"AccessEnforced\" boolean NOT NULL DEFAULT false", 35);
      Ddl(conn, "ALTER TABLE \"Grants\" ADD COLUMN IF NOT EXISTS \"MeetingId\" uuid", 36);
      Ddl(conn, "ALTER TABLE \"Invites\" ADD COLUMN IF NOT EXISTS \"MeetingId\" uuid", 37);
      db.Database.EnsureCreated();
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Messages\" ADD COLUMN IF NOT EXISTS \"ParentSequence\" bigint");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Messages\" ADD COLUMN IF NOT EXISTS \"Stance\" character varying(30) NOT NULL DEFAULT ''");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Messages\" ADD COLUMN IF NOT EXISTS \"AdvisorId\" uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Notes\" ADD COLUMN IF NOT EXISTS \"EvidenceJson\" text NOT NULL DEFAULT '[]'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Notes\" ADD COLUMN IF NOT EXISTS \"RootId\" uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Notes\" ADD COLUMN IF NOT EXISTS \"Revision\" integer NOT NULL DEFAULT 1");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Notes\" ADD COLUMN IF NOT EXISTS \"PredecessorId\" uuid NULL");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Notes\" ADD COLUMN IF NOT EXISTS \"NoteStatus\" text NOT NULL DEFAULT 'current'");
      db.Database.ExecuteSqlRaw("CREATE TABLE IF NOT EXISTS \"SecretaryRequests\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"BoardId\" uuid NOT NULL, \"MeetingId\" uuid NOT NULL, \"ClientNonce\" text NOT NULL DEFAULT '', \"InputHash\" text NOT NULL DEFAULT '', \"InputText\" text NOT NULL DEFAULT '', \"Status\" text NOT NULL DEFAULT 'pending', \"Question\" text NOT NULL DEFAULT '', \"Answer\" text NOT NULL DEFAULT '', \"NoteId\" uuid NULL, \"Generation\" bigint NOT NULL DEFAULT 0, \"LeadFingerprint\" text NOT NULL DEFAULT '', \"EvidenceFingerprintJson\" text NOT NULL DEFAULT '[]', \"Error\" text NOT NULL DEFAULT '', \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT NOW(), \"UpdatedAt\" timestamp with time zone NOT NULL DEFAULT NOW(), \"CompletedAt\" timestamp with time zone NULL)");
      db.Database.ExecuteSqlRaw("CREATE TABLE IF NOT EXISTS \"NoteHistories\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"NoteId\" uuid NOT NULL, \"RootId\" uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000', \"Revision\" integer NOT NULL DEFAULT 1, \"Title\" text NOT NULL DEFAULT '', \"Body\" text NOT NULL DEFAULT '', \"EvidenceJson\" text NOT NULL DEFAULT '[]', \"Action\" text NOT NULL DEFAULT '', \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT NOW())");
      db.Database.ExecuteSqlRaw("CREATE UNIQUE INDEX IF NOT EXISTS \"IX_SecretaryRequests_MeetingNonce\" ON \"SecretaryRequests\" (\"MeetingId\", \"ClientNonce\")");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"SecretaryRequests\" ADD COLUMN IF NOT EXISTS \"SnapshotJson\" text NOT NULL DEFAULT \'{{}}\'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"SecretaryRequests\" ADD COLUMN IF NOT EXISTS \"DeliveredRefsJson\" text NOT NULL DEFAULT \'[]\'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"SecretaryRequests\" ADD COLUMN IF NOT EXISTS \"DeliveredPromptHash\" text NOT NULL DEFAULT \'\'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"SecretaryRequests\" ADD COLUMN IF NOT EXISTS \"AttemptId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"SecretaryRequests\" ADD COLUMN IF NOT EXISTS \"AnswerAttemptId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"NoteHistories\" ADD COLUMN IF NOT EXISTS \"BoardId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"NoteHistories\" ADD COLUMN IF NOT EXISTS \"MeetingId\" uuid NOT NULL DEFAULT \'00000000-0000-0000-0000-000000000000\'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"SecretaryRequests\" ADD COLUMN IF NOT EXISTS \"Phase\" text NOT NULL DEFAULT \'initial\'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"SecretaryRequests\" ADD COLUMN IF NOT EXISTS \"SubmissionHash\" text NOT NULL DEFAULT \'\'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"SecretaryRequests\" ADD COLUMN IF NOT EXISTS \"CallerRefsJson\" text NOT NULL DEFAULT \'[]\'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"SecretaryRequests\" ADD COLUMN IF NOT EXISTS \"RecentHash\" text NOT NULL DEFAULT \'\'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"SecretaryRequests\" ADD COLUMN IF NOT EXISTS \"EvidenceTextHash\" text NOT NULL DEFAULT \'\'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"SecretaryRequests\" ADD COLUMN IF NOT EXISTS \"DossierHash\" text NOT NULL DEFAULT \'\'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"SecretaryRequests\" ADD COLUMN IF NOT EXISTS \"OmittedJson\" text NOT NULL DEFAULT \'[]\'");
      var orphans = db.Set<SimCEO.Api.Domain.SecretaryRequest>().Where(r => r.Status == "pending" || r.Status == "inflight" || r.Status == "answering").ToList();
      foreach (var o in orphans) { o.Status = "interrupted"; o.Error = "Process restarted during generation; retry with the same nonce and payload."; o.UpdatedAt = DateTime.UtcNow; }
      if (orphans.Count > 0) db.SaveChanges();
      db.Database.ExecuteSqlRaw("UPDATE \"Notes\" SET \"RootId\" = \"Id\" WHERE \"RootId\" = '00000000-0000-0000-0000-000000000000'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"WizardDrafts\" ADD COLUMN IF NOT EXISTS \"Version\" integer NOT NULL DEFAULT 1");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"RosterEntries\" ADD COLUMN IF NOT EXISTS \"ResearchJobId\" text NOT NULL DEFAULT ''");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"RosterEntries\" ADD COLUMN IF NOT EXISTS \"ResearchBaseVersion\" integer NOT NULL DEFAULT 0");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"RosterEntries\" ADD COLUMN IF NOT EXISTS \"OwnerKey\" text NOT NULL DEFAULT ''");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Drafts\" ADD COLUMN IF NOT EXISTS \"DiscardedJson\" text NOT NULL DEFAULT '[]'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Drafts\" ADD COLUMN IF NOT EXISTS \"ReviewRevision\" integer NOT NULL DEFAULT 0");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Drafts\" ADD COLUMN IF NOT EXISTS \"ReviewToken\" text NOT NULL DEFAULT ''");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Drafts\" ADD COLUMN IF NOT EXISTS \"HistoryJson\" text NOT NULL DEFAULT '[]'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Drafts\" ADD COLUMN IF NOT EXISTS \"EvidenceSnapshotJson\" text NOT NULL DEFAULT '[]'");
      // Compatibility-only initialization for RECOGNIZED legacy rows only
      // (blank review token AND pre-review revision): fill blank columns with
      // deterministic/stable values. Never touch Decided or a non-blank
      // Status, so previously finalized or discarded reviews stay terminal
      // with only their original selections. Malformed CURRENT rows (which
      // always carry a token and revision) are preserved untouched so the
      // strict validator fails closed on them instead of being papered over.
      foreach (var d in db.Drafts.ToList())
      {
        var isRecognizedLegacy = string.IsNullOrWhiteSpace(d.ReviewToken) && d.ReviewRevision < 1;
        if (!isRecognizedLegacy) continue;
        if (string.IsNullOrWhiteSpace(d.ReviewToken)) { d.ReviewToken = SimCEO.Api.Work.Hashing.HashOf("legacy-review:" + d.Id.ToString("N") + ":" + d.Version + ":" + (d.Hash ?? "")); }
        if (d.ReviewRevision < 1) { d.ReviewRevision = 1; }
        if (string.IsNullOrWhiteSpace(d.ApprovedJson)) { d.ApprovedJson = "[]"; }
        if (string.IsNullOrWhiteSpace(d.DiscardedJson)) { d.DiscardedJson = "[]"; }
        if (string.IsNullOrWhiteSpace(d.HistoryJson)) { d.HistoryJson = "[]"; }
        if (string.IsNullOrWhiteSpace(d.SupersedesJson)) { d.SupersedesJson = "[]"; }
        if (string.IsNullOrWhiteSpace(d.EvidenceSnapshotJson)) { d.EvidenceSnapshotJson = "[]"; }
        if (string.IsNullOrWhiteSpace(d.Status))
        {
          var legacyApprovals = 0;
          try
          {
            using var doc = System.Text.Json.JsonDocument.Parse(string.IsNullOrWhiteSpace(d.ApprovedJson) ? "[]" : d.ApprovedJson);
            if (doc.RootElement.ValueKind == System.Text.Json.JsonValueKind.Array) legacyApprovals = doc.RootElement.GetArrayLength();
          }
          catch (System.Text.Json.JsonException) { }
          d.Status = (d.Decided && legacyApprovals > 0) ? "approved" : (d.Decided ? "discarded" : "open");
        }
      }
      db.SaveChanges();
 db.Database.ExecuteSqlRaw("ALTER TABLE \"Boards\" ADD COLUMN IF NOT EXISTS \"SourcePolicyMode\" text NOT NULL DEFAULT 'allowAll'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Sources\" ADD COLUMN IF NOT EXISTS \"ReviewState\" text NOT NULL DEFAULT 'pending'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Sources\" ADD COLUMN IF NOT EXISTS \"Origin\" text NOT NULL DEFAULT 'upload'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Sources\" ADD COLUMN IF NOT EXISTS \"ResourceId\" uuid NULL");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Sources\" ADD COLUMN IF NOT EXISTS \"FamilyKey\" text NOT NULL DEFAULT ''");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Sources\" ADD COLUMN IF NOT EXISTS \"IndexState\" text NOT NULL DEFAULT 'queued'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Sources\" ADD COLUMN IF NOT EXISTS \"IndexGeneration\" integer NOT NULL DEFAULT 0");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Sources\" ADD COLUMN IF NOT EXISTS \"IndexError\" text NOT NULL DEFAULT ''");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Sources\" ADD COLUMN IF NOT EXISTS \"IndexCompletedAt\" timestamp with time zone NULL");
      db.Database.ExecuteSqlRaw("CREATE TABLE IF NOT EXISTS \"SourceSections\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"BoardId\" uuid NOT NULL, \"SourceId\" uuid NOT NULL, \"FamilyKey\" text NOT NULL DEFAULT '', \"SourceVersion\" integer NOT NULL DEFAULT 1, \"ContentHash\" text NOT NULL DEFAULT '', \"Ordinal\" integer NOT NULL DEFAULT 1, \"Heading\" text NOT NULL DEFAULT '', \"Location\" text NOT NULL DEFAULT '', \"Text\" text NOT NULL DEFAULT '', \"IndexGeneration\" integer NOT NULL DEFAULT 1, \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT NOW())");
      db.Database.ExecuteSqlRaw("CREATE TABLE IF NOT EXISTS \"SourceHeads\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"BoardId\" uuid NOT NULL, \"FamilyKey\" text NOT NULL DEFAULT '', \"HeadVersion\" integer NOT NULL DEFAULT 0, \"HeadSourceId\" uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000', \"HighWater\" integer NOT NULL DEFAULT 0, \"UpdatedAt\" timestamp with time zone NOT NULL DEFAULT NOW())");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"SourceHeads\" ADD COLUMN IF NOT EXISTS \"HighWater\" integer NOT NULL DEFAULT 0");
      db.Database.ExecuteSqlRaw("CREATE TABLE IF NOT EXISTS \"SourceEvents\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"BoardId\" uuid NOT NULL, \"SourceId\" uuid NOT NULL, \"FamilyKey\" text NOT NULL DEFAULT '', \"Version\" integer NOT NULL DEFAULT 1, \"Action\" text NOT NULL DEFAULT '', \"Detail\" text NOT NULL DEFAULT '', \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT NOW())");
      db.Database.ExecuteSqlRaw("CREATE INDEX IF NOT EXISTS \"IX_Sources_FamilyKey\" ON \"Sources\" (\"FamilyKey\")");
      db.Database.ExecuteSqlRaw("CREATE INDEX IF NOT EXISTS \"IX_SourceSections_SourceId\" ON \"SourceSections\" (\"SourceId\")");
      // Unique identity constraints are NOT created here: they are enforced by
      // EnsureUniqueIndexes AFTER the controlled startup migration has
      // canonicalized families and resolved legacy collisions in app code.
      db.Database.ExecuteSqlRaw("CREATE TABLE IF NOT EXISTS \"WikiResources\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"BoardId\" uuid NOT NULL, \"Scope\" text NOT NULL DEFAULT \'board\', \"MeetingId\" uuid NULL, \"BaseUrl\" text NOT NULL DEFAULT \'\', \"Description\" text NOT NULL DEFAULT \'\', \"AllowlistJson\" text NOT NULL DEFAULT \'[]\', \"ExclusionsJson\" text NOT NULL DEFAULT \'[]\', \"RequiredTagsJson\" text NOT NULL DEFAULT \'[]\', \"Locale\" text NOT NULL DEFAULT \'\', \"Enabled\" boolean NOT NULL DEFAULT FALSE, \"ConfigRevision\" bigint NOT NULL DEFAULT 1, \"SyncIntervalMinutes\" integer NOT NULL DEFAULT 60, \"NextSyncAt\" timestamp with time zone NULL, \"LastStatus\" text NOT NULL DEFAULT \'disabled\', \"LastError\" text NOT NULL DEFAULT \'\', \"LastCompletedAt\" timestamp with time zone NULL, \"LastSuccessRevision\" bigint NOT NULL DEFAULT 0, \"LastSuccessAt\" timestamp with time zone NULL, \"SuccessPagesJson\" text NOT NULL DEFAULT \'[]\', \"HasCredential\" boolean NOT NULL DEFAULT FALSE, \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT NOW(), \"UpdatedAt\" timestamp with time zone NOT NULL DEFAULT NOW())");
      db.Database.ExecuteSqlRaw("CREATE TABLE IF NOT EXISTS \"WikiSecrets\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"ResourceId\" uuid NOT NULL, \"ProtectedToken\" text NOT NULL DEFAULT \'\', \"UpdatedAt\" timestamp with time zone NOT NULL DEFAULT NOW())");
      db.Database.ExecuteSqlRaw("CREATE INDEX IF NOT EXISTS \"IX_WikiResources_BoardId\" ON \"WikiResources\" (\"BoardId\")");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"WikiResources\" ADD COLUMN IF NOT EXISTS \"Scope\" text NOT NULL DEFAULT \'board\'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"WikiResources\" ADD COLUMN IF NOT EXISTS \"SuccessPagesJson\" text NOT NULL DEFAULT \'[]\'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"WikiResources\" ADD COLUMN IF NOT EXISTS \"LastSuccessRevision\" bigint NOT NULL DEFAULT 0");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"WikiResources\" ADD COLUMN IF NOT EXISTS \"AllowedUse\" text NOT NULL DEFAULT ''");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"WikiResources\" ADD COLUMN IF NOT EXISTS \"SetupUse\" boolean NOT NULL DEFAULT FALSE");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"WikiResources\" ADD COLUMN IF NOT EXISTS \"ManualOnly\" boolean NOT NULL DEFAULT FALSE");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"WikiResources\" ADD COLUMN IF NOT EXISTS \"AttemptGeneration\" bigint NOT NULL DEFAULT 1");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"WikiResources\" ADD COLUMN IF NOT EXISTS \"AttemptStatus\" text NOT NULL DEFAULT 'idle'");
      // One-time idempotent legacy migration: pending for new, approved stays, then heads backfill runs at request time.
      db.Database.ExecuteSqlRaw("UPDATE \"Sources\" SET \"ReviewState\" = CASE WHEN \"Approved\" THEN 'approved' ELSE 'pending' END WHERE (\"ReviewState\" = 'pending' OR \"ReviewState\" = '') AND \"Approved\" = TRUE");
      // Canonical family keys and legacy collision resolution run in app code (SourceGovernance.MigrateStore); SQL leaves new rows empty.
      db.Database.ExecuteSqlRaw("CREATE TABLE IF NOT EXISTS \"UsageRows\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"Kind\" text NOT NULL DEFAULT '', \"Model\" text NOT NULL DEFAULT '', \"InputTokens\" integer NOT NULL DEFAULT 0, \"OutputTokens\" integer NOT NULL DEFAULT 0, \"CachedInputTokens\" integer NOT NULL DEFAULT 0, \"SearchCalls\" integer NOT NULL DEFAULT 0, \"LatencyMs\" bigint NOT NULL DEFAULT 0, \"RanSearch\" boolean NOT NULL DEFAULT false, \"Status\" text NOT NULL DEFAULT 'succeeded', \"ProviderCallId\" text NULL, \"CostBasis\" text NULL, \"Cost\" numeric NULL, \"BoardId\" uuid NULL, \"MeetingId\" uuid NULL, \"At\" timestamp with time zone NOT NULL DEFAULT now(), \"Note\" text NOT NULL DEFAULT '')");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"UsageRows\" ADD COLUMN IF NOT EXISTS \"OutputTokens\" integer NOT NULL DEFAULT 0");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"UsageRows\" ADD COLUMN IF NOT EXISTS \"CachedInputTokens\" integer NOT NULL DEFAULT 0");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"UsageRows\" ADD COLUMN IF NOT EXISTS \"SearchCalls\" integer NOT NULL DEFAULT 0");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"UsageRows\" ADD COLUMN IF NOT EXISTS \"LatencyMs\" bigint NOT NULL DEFAULT 0");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"UsageRows\" ADD COLUMN IF NOT EXISTS \"RanSearch\" boolean NOT NULL DEFAULT false");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"UsageRows\" ADD COLUMN IF NOT EXISTS \"Status\" text NOT NULL DEFAULT 'succeeded'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"UsageRows\" ADD COLUMN IF NOT EXISTS \"ProviderCallId\" text NULL");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"UsageRows\" ADD COLUMN IF NOT EXISTS \"CostBasis\" text NULL");
      db.Database.ExecuteSqlRaw("CREATE TABLE IF NOT EXISTS \"ModelCalls\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"Model\" text NOT NULL DEFAULT '', \"Purpose\" text NOT NULL DEFAULT '', \"InputTokens\" integer NOT NULL DEFAULT 0, \"OutputTokens\" integer NOT NULL DEFAULT 0, \"CachedInputTokens\" integer NOT NULL DEFAULT 0, \"LatencyMs\" bigint NOT NULL DEFAULT 0, \"RanSearch\" boolean NOT NULL DEFAULT false, \"SearchCalls\" integer NOT NULL DEFAULT 0, \"ProviderCallId\" text NULL, \"Status\" text NOT NULL DEFAULT 'succeeded', \"Cost\" numeric NULL, \"CostBasis\" text NULL, \"BoardId\" uuid NULL, \"MeetingId\" uuid NULL, \"SearchNote\" text NULL, \"At\" timestamp with time zone NOT NULL DEFAULT now())");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"ModelCalls\" ADD COLUMN IF NOT EXISTS \"CachedInputTokens\" integer NOT NULL DEFAULT 0");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"ModelCalls\" ADD COLUMN IF NOT EXISTS \"SearchCalls\" integer NOT NULL DEFAULT 0");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"ModelCalls\" ADD COLUMN IF NOT EXISTS \"ProviderCallId\" text NULL");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"ModelCalls\" ADD COLUMN IF NOT EXISTS \"Status\" text NOT NULL DEFAULT 'succeeded'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"ModelCalls\" ADD COLUMN IF NOT EXISTS \"Cost\" numeric NULL");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"ModelCalls\" ADD COLUMN IF NOT EXISTS \"CostBasis\" text NULL");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"ModelCalls\" ADD COLUMN IF NOT EXISTS \"BoardId\" uuid NULL");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"ModelCalls\" ADD COLUMN IF NOT EXISTS \"MeetingId\" uuid NULL");
      db.Database.ExecuteSqlRaw("CREATE INDEX IF NOT EXISTS \"IX_UsageRows_BoardId\" ON \"UsageRows\" (\"BoardId\")");
      db.Database.ExecuteSqlRaw("CREATE INDEX IF NOT EXISTS \"IX_UsageRows_MeetingId\" ON \"UsageRows\" (\"MeetingId\")");
      db.Database.ExecuteSqlRaw("CREATE INDEX IF NOT EXISTS \"IX_UsageRows_At\" ON \"UsageRows\" (\"At\")");
      db.Database.ExecuteSqlRaw("CREATE INDEX IF NOT EXISTS \"IX_ModelCalls_BoardId\" ON \"ModelCalls\" (\"BoardId\")");
      db.Database.ExecuteSqlRaw("CREATE INDEX IF NOT EXISTS \"IX_ModelCalls_MeetingId\" ON \"ModelCalls\" (\"MeetingId\")");
      db.Database.ExecuteSqlRaw("CREATE INDEX IF NOT EXISTS \"IX_ModelCalls_At\" ON \"ModelCalls\" (\"At\")");
      db.Database.ExecuteSqlRaw("CREATE TABLE IF NOT EXISTS \"InstallationPolicies\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"MonthlyCapUsd\" numeric NULL, \"Mode\" text NOT NULL DEFAULT 'warn', \"ModelApiKeyOverride\" text NOT NULL DEFAULT '', \"ModelChatOverride\" text NOT NULL DEFAULT '')");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"InstallationPolicies\" ADD COLUMN IF NOT EXISTS \"MonthlyCapUsd\" numeric NULL");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"InstallationPolicies\" ADD COLUMN IF NOT EXISTS \"Mode\" text NOT NULL DEFAULT 'warn'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"InstallationPolicies\" ADD COLUMN IF NOT EXISTS \"ModelApiKeyOverride\" text NOT NULL DEFAULT ''");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"InstallationPolicies\" ADD COLUMN IF NOT EXISTS \"ModelChatOverride\" text NOT NULL DEFAULT ''");
      // Secret hygiene: key material is memory-only by contract; blank any
      // legacy-persisted override so no application key rests in the database.
      db.Database.ExecuteSqlRaw("UPDATE \"InstallationPolicies\" SET \"ModelApiKeyOverride\" = '' WHERE \"ModelApiKeyOverride\" IS NOT NULL AND \"ModelApiKeyOverride\" <> ''");
      Pg.Backend = new PostgresBackend(db);
      return true;
    }
    catch (Exception ex)
    {
      var inner = ex; while (inner.InnerException is not null) inner = inner.InnerException;
      error = $"Postgres wire-up failed step {DdlStep} ({ex.GetType().Name}: {inner.Message}); refusing in-memory fallback for requested PG mode.";
      return false;
    }
  }

  // Unique identity constraints, enforced ONLY after the controlled
  // startup migration has canonicalized families and deterministically
  // resolved legacy collisions. Creating them earlier would fail on
  // reachable legacy shapes (e.g. two pre-family v1 rows that canonicalize
  // to one family). Called by Program after SourceGovernance.MigrateStore.
  public static bool EnsureUniqueIndexes(string cs, out string error)
  {
    error = "";
    try
    {
      var options = new DbContextOptionsBuilder<PostgresDb>().UseNpgsql(cs).Options;
      using var db = new PostgresDb(options);
      db.Database.ExecuteSqlRaw("CREATE UNIQUE INDEX IF NOT EXISTS \"UX_Sources_FamilyVersion\" ON \"Sources\" (\"BoardId\",\"FamilyKey\",\"Version\")");
      db.Database.ExecuteSqlRaw("CREATE UNIQUE INDEX IF NOT EXISTS \"UX_SourceHeads_Family\" ON \"SourceHeads\" (\"BoardId\",\"FamilyKey\")");
      return true;
    }
    catch (Exception ex)
    {
      error = $"Postgres unique-index enforcement failed ({ex.GetType().Name}: {ex.Message}).";
      return false;
    }
  }

  public static bool Wired => Pg.Backend is not null;
}

/// <summary>Legacy shim kept for older call sites; prefer DbSet access via PostgresDb.</summary>
public static class AdvisorStore
{
  public static List<BoardAdvisor> ForBoard(PostgresDb db, Guid boardId) =>
    db.BoardAdvisors.Where(a => a.BoardId == boardId).ToList();
}


