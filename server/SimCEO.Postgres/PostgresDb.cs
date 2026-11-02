using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
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
  public DbSet<SourceDoc> Sources => Set<SourceDoc>();
  public DbSet<WizardDraft> WizardDrafts => Set<WizardDraft>();
  public DbSet<VoiceTurn> VoiceTurns => Set<VoiceTurn>();
  public DbSet<LeadProfile> LeadProfiles => Set<LeadProfile>();
  public DbSet<JobRow> Jobs => Set<JobRow>();
  public DbSet<Note> Notes => Set<Note>();
  public DbSet<Grant> Grants => Set<Grant>();
  public DbSet<Invite> Invites => Set<Invite>();
  public DbSet<AdvisorImage> Images => Set<AdvisorImage>();
  public DbSet<Account> AuthAccounts => Set<Account>();

  protected override void OnModelCreating(ModelBuilder b)
  {
    b.Entity<Message>().HasIndex(m => new { m.MeetingId, m.Sequence }).IsUnique();
    b.Entity<SourceDoc>().HasIndex(x => x.BoardId);
    b.Entity<BoardAdvisor>().HasIndex(x => x.BoardId);
    b.Entity<Meeting>().HasIndex(x => x.BoardId);
    b.Entity<Account>().HasIndex(a => a.Email).IsUnique();
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

  public PostgresBackend(PostgresDb db) => _db = db;

  public T? Find<T>(Guid id) where T : class
  {
    lock (_gate) return _db.Set<T>().Find(id);
  }

  public List<T> All<T>() where T : class
  {
    lock (_gate) return _db.Set<T>().ToList();
  }

  public void Upsert<T>(T entity) where T : class
  {
    lock (_gate)
    {
      var keyName = _db.Model.FindEntityType(typeof(T))!.FindPrimaryKey()!.Properties[0].Name;
      var id = _db.Entry(entity).Property(keyName).CurrentValue;
      var existing = _db.Set<T>().Find(id);
      if (existing is null) _db.Set<T>().Add(entity);
      else if (!ReferenceEquals(existing, entity)) _db.Entry(existing).CurrentValues.SetValues(entity);
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

  public List<Message> MeetingMessages(Guid meetingId)
  {
    lock (_gate) return _db.Messages.Where(m => m.MeetingId == meetingId).OrderBy(m => m.Sequence).ToList();
  }

  public List<Guid> MessageMeetings()
  {
    lock (_gate) return _db.Messages.Select(m => m.MeetingId).Distinct().ToList();
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
    lock (_gate) _db.SaveChanges();
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
        error = "Postgres unreachable; running in-memory.";
        return false;
      }
      db.Database.EnsureCreated();
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Messages\" ADD COLUMN IF NOT EXISTS \"ParentSequence\" bigint");
      db.Database.ExecuteSqlRaw("ALTER TABLE \"Messages\" ADD COLUMN IF NOT EXISTS \"Stance\" character varying(30) NOT NULL DEFAULT ''");
      Pg.Backend = new PostgresBackend(db);
      return true;
    }
    catch (Exception ex)
    {
      error = $"Postgres wire-up failed ({ex.GetType().Name}); running in-memory.";
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
