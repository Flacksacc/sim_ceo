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
  public DbSet<WizardDraft> WizardDrafts => Set<WizardDraft>();
  public DbSet<VoiceTurn> VoiceTurns => Set<VoiceTurn>();
  public DbSet<LeadProfile> LeadProfiles => Set<LeadProfile>();
  public DbSet<JobRow> Jobs => Set<JobRow>();
  public DbSet<Note> Notes => Set<Note>();
  public DbSet<Grant> Grants => Set<Grant>();
  public DbSet<Invite> Invites => Set<Invite>();
  public DbSet<AdvisorImage> Images => Set<AdvisorImage>();
  public DbSet<SimCEO.Api.Account> AuthAccounts => Set<SimCEO.Api.Account>();

  protected override void OnModelCreating(ModelBuilder b)
  {
    b.Entity<Message>().HasKey(m => new { m.MeetingId, m.Sequence });
    b.Entity<SourceDoc>().HasIndex(x => x.BoardId);
    b.Entity<BoardAdvisor>().HasIndex(x => x.BoardId);
    b.Entity<Meeting>().HasIndex(x => x.BoardId);
    b.Entity<SimCEO.Api.Account>().HasIndex(a => a.Email).IsUnique();
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
      try
      {
        tx = _db.Database.BeginTransaction();
        _tx = tx;
        _depth = 1;
        var result = op();
        _db.SaveChanges();
        tx.Commit();
        return result;
      }
      catch
      {
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
      db.Database.EnsureCreated();
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Messages\" ADD COLUMN IF NOT EXISTS \"ParentSequence\" bigint");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Messages\" ADD COLUMN IF NOT EXISTS \"Stance\" character varying(30) NOT NULL DEFAULT ''");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Messages\" ADD COLUMN IF NOT EXISTS \"AdvisorId\" uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Notes\" ADD COLUMN IF NOT EXISTS \"EvidenceJson\" text NOT NULL DEFAULT '[]'");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"WizardDrafts\" ADD COLUMN IF NOT EXISTS \"Version\" integer NOT NULL DEFAULT 1");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"RosterEntries\" ADD COLUMN IF NOT EXISTS \"ResearchJobId\" text NOT NULL DEFAULT ''");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"RosterEntries\" ADD COLUMN IF NOT EXISTS \"ResearchBaseVersion\" integer NOT NULL DEFAULT 0");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"RosterEntries\" ADD COLUMN IF NOT EXISTS \"OwnerKey\" text NOT NULL DEFAULT ''");
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
      db.Database.ExecuteSqlRaw("CREATE TABLE IF NOT EXISTS \"SourceHeads\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"BoardId\" uuid NOT NULL, \"FamilyKey\" text NOT NULL DEFAULT '', \"HeadVersion\" integer NOT NULL DEFAULT 0, \"HeadSourceId\" uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000', \"UpdatedAt\" timestamp with time zone NOT NULL DEFAULT NOW())");
      db.Database.ExecuteSqlRaw("CREATE TABLE IF NOT EXISTS \"SourceEvents\" (\"Id\" uuid NOT NULL PRIMARY KEY, \"BoardId\" uuid NOT NULL, \"SourceId\" uuid NOT NULL, \"FamilyKey\" text NOT NULL DEFAULT '', \"Version\" integer NOT NULL DEFAULT 1, \"Action\" text NOT NULL DEFAULT '', \"Detail\" text NOT NULL DEFAULT '', \"CreatedAt\" timestamp with time zone NOT NULL DEFAULT NOW())");
      db.Database.ExecuteSqlRaw("CREATE INDEX IF NOT EXISTS \"IX_Sources_FamilyKey\" ON \"Sources\" (\"FamilyKey\")");
      db.Database.ExecuteSqlRaw("CREATE INDEX IF NOT EXISTS \"IX_SourceSections_SourceId\" ON \"SourceSections\" (\"SourceId\")");
      // One-time idempotent legacy migration: pending for new, approved stays, then heads backfill runs at request time.
      db.Database.ExecuteSqlRaw("UPDATE \"Sources\" SET \"ReviewState\" = CASE WHEN \"Approved\" THEN 'approved' ELSE 'pending' END WHERE (\"ReviewState\" = 'pending' OR \"ReviewState\" = '') AND \"Approved\" = TRUE");
      // FamilyKey backfill runs in app code (EnsureMigratedAll) to compute board/scope/origin-aware keys; SQL leaves new rows empty.
      Pg.Backend = new PostgresBackend(db);
      return true;
    }
    catch (Exception ex)
    {
      error = $"Postgres wire-up failed ({ex.GetType().Name}); refusing in-memory fallback for requested PG mode.";
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
