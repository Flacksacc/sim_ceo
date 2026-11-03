using System.Collections.Concurrent;

namespace SimCEO.Api.Data;

/// <summary>
/// Postgres backend contract. Implemented by SimCEO.Postgres (which
/// references this assembly); wired at startup via <see cref="Pg"/>.
/// When <see cref="Pg.Backend"/> is null the tables below are pure
/// in-memory dictionaries. Operational streams (audit, usage, model
/// calls) and auth sessions are intentionally memory-only.
/// </summary>
/// <summary>
/// Code-only storage-fault seam for rollback tests. In-process QA may set
/// <see cref="FailBeforeCommit"/> to force the next backend commit to fail,
/// proving durable rollback. Never exposed via HTTP routes or environment.
/// </summary>
public static class PgFaults
{
  public static Func<bool>? FailBeforeCommit;
}

public interface IPgBackend
{
  T? Find<T>(Guid id) where T : class;
  List<T> All<T>() where T : class;
  void Upsert<T>(T entity) where T : class;
  bool Remove<T>(Guid id) where T : class;
  void Clear<T>() where T : class;
  void AddMessage(Domain.Message m);
  void AddMessages(IEnumerable<Domain.Message> ms);
  List<Domain.Message> MeetingMessages(Guid meetingId);
  List<Guid> MessageMeetings();
  void RemoveMeetingMessages(Guid meetingId);
  void ClearMessages();
  void Save();
  /// <summary>True while inside a <see cref="Transact(Action)"/> unit; per-write Save calls defer.</summary>
  bool IsTransacting { get; }
  /// <summary>Run op inside one backend gate + DB transaction: single SaveChanges + commit once.</summary>
  void Transact(Action op);
  /// <summary>Run op inside one backend gate + DB transaction and return its result.</summary>
  T Transact<T>(Func<T> op);
}

public static class Pg
{
  public static IPgBackend? Backend { get; set; }
}

/// <summary>
/// Explicit synchronous atomic storage unit. One backend gate + one DB
/// transaction over the supplied mutation: table/message writes inside it
/// defer individual Save calls; final SaveChanges + commit happens once.
/// On exception the transaction rolls back and EF tracking is cleared.
/// Reads inside the unit see staged additions (same-transaction visibility).
/// In-memory mode has no transaction; callers must validate the full graph
/// BEFORE any write so expected failures leave no partial state. Use this
/// unit for wizard creation + created marker, complete snapshot import, and
/// publication group + meeting revision + run outcome. No external async
/// model call may run inside the unit (LLM calls stay outside the lock).
/// Backend-related exceptions never silently become memory-mode success.
/// </summary>
public static class Atomic
{
  public static void Run(Action op)
  {
    var b = Pg.Backend;
    if (b is null) { op(); return; }
    b.Transact(op);
  }

  public static T Run<T>(Func<T> op)
  {
    var b = Pg.Backend;
    return b is null ? op() : b.Transact(op);
  }
}

/// <summary>Dictionary-like table: in-memory, or EF write-through when a backend is wired.</summary>
public sealed class Table<T> where T : class
{
  private static readonly System.Reflection.PropertyInfo IdProp =
    typeof(T).GetProperty("Id") ?? throw new InvalidOperationException($"{typeof(T).Name} has no Id property.");
  private readonly ConcurrentDictionary<Guid, T> _mem = new();

  private static Guid KeyOf(T e) => (Guid)IdProp.GetValue(e)!;

  private static void SaveDeferred(IPgBackend b)
  {
    if (!b.IsTransacting) b.Save();
  }

  public T this[Guid id]
  {
    get => TryGetValue(id, out var v) && v is not null
      ? v : throw new KeyNotFoundException($"{typeof(T).Name} {id} not found.");
    set
    {
      var b = Pg.Backend;
      if (b is null) { _mem[id] = value; return; }
      if (IdProp.CanWrite && KeyOf(value) != id) IdProp.SetValue(value, id);
      b.Upsert(value);
      SaveDeferred(b);
    }
  }

  public bool TryGetValue(Guid id, out T value)
  {
    var b = Pg.Backend;
    if (b is null) return _mem.TryGetValue(id, out value!);
    value = b.Find<T>(id)!;
    return value is not null;
  }

  public bool ContainsKey(Guid id)
  {
    var b = Pg.Backend;
    return b is null ? _mem.ContainsKey(id) : b.Find<T>(id) is not null;
  }

  public ICollection<T> Values
  {
    get
    {
      var b = Pg.Backend;
      return b is null ? _mem.Values : b.All<T>();
    }
  }

  public bool TryRemove(Guid id, out T value)
  {
    var b = Pg.Backend;
    if (b is null) return _mem.TryRemove(id, out value!);
    value = b.Find<T>(id);
    if (value is null) return false;
    b.Remove<T>(id);
    SaveDeferred(b);
    return true;
  }

  public void Clear()
  {
    var b = Pg.Backend;
    if (b is null) _mem.Clear();
    else { b.Clear<T>(); SaveDeferred(b); }
  }

  public void Flush()
  {
    var b = Pg.Backend;
    if (b is not null) SaveDeferred(b);
  }
}

/// <summary>Append-only stream. Memory-only by design (audit is ephemeral).</summary>
public sealed class Bag<T> : IEnumerable<T>
{
  private readonly ConcurrentBag<T> _bag = new();
  public void Add(T item) => _bag.Add(item);
  public IEnumerator<T> GetEnumerator() => _bag.GetEnumerator();
  System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
}

/// <summary>Message list with Postgres write-through on Add.</summary>
public sealed class MessageList : List<Domain.Message>
{
  public static MessageList Detached(Guid meeting, List<Domain.Message> items) => new(null, meeting, items);

  private readonly IPgBackend? _pg;
  private readonly Guid _meeting;
  public MessageList(IPgBackend? pg, Guid meeting, IEnumerable<Domain.Message> seed)
  {
    _pg = pg; _meeting = meeting;
    base.AddRange(seed);
  }
  public new void Add(Domain.Message m)
  {
    base.Add(m);
    if (_pg is null) return;
    m.MeetingId = _meeting;
    _pg.AddMessage(m);
    if (!_pg.IsTransacting) _pg.Save();
  }
  public new void AddRange(IEnumerable<Domain.Message> items)
  {
    var b = _pg;
    if (b is null) { base.AddRange(items); return; }
    foreach (var m in items) { m.MeetingId = _meeting; base.Add(m); b.AddMessage(m); }
    if (!b.IsTransacting) b.Save();
  }

}

/// <summary>Per-meeting message store: in-memory lists, or EF rows when a backend is wired.</summary>
public sealed class MessageTable : IEnumerable<KeyValuePair<Guid, List<Domain.Message>>>
{
  private readonly ConcurrentDictionary<Guid, List<Domain.Message>> _mem = new();

  public MessageList this[Guid id]
  {
    get => GetOrAdd(id, _ => new List<Domain.Message>());
    set
    {
      var b = Pg.Backend;
      if (b is null)
      {
        _mem[id] = value is MessageList ml0 ? ml0 : new MessageList(null, id, value);
        return;
      }
      b.RemoveMeetingMessages(id);
      foreach (var m in value) { m.MeetingId = id; b.AddMessage(m); }
      if (!b.IsTransacting) b.Save();
    }
  }


  public void AddRangeCommitted(Guid id, IEnumerable<Domain.Message> items)
  {
    var b = Pg.Backend;
    var batch = items.ToList();
    foreach (var m in batch) m.MeetingId = id;
    if (b is null)
    {
      GetOrAdd(id, _ => new List<Domain.Message>()).AddRange(batch);
      return;
    }
    var list = GetOrAdd(id, _ => new List<Domain.Message>());
    foreach (var mm in batch) ((List<Domain.Message>)list).Add(mm);
    b.AddMessages(batch);
    if (!b.IsTransacting) b.Save();
  }

  public MessageList GetOrAdd(Guid id, Func<Guid, List<Domain.Message>> factory)
  {
    var b = Pg.Backend;
    if (b is null)
      return (MessageList)_mem.GetOrAdd(id, k => new MessageList(null, k, factory(k)));
    if (TryGetValue(id, out var existing) && existing is not null) return existing;
    return new MessageList(b, id, factory(id));
  }

  public bool TryGetValue(Guid id, out MessageList value)
  {
    var b = Pg.Backend;
    if (b is null)
    {
      if (_mem.TryGetValue(id, out var v) && v is not null)
      {
        if (v is MessageList ml) { value = ml; return true; }
        ml = new MessageList(null, id, v);
        _mem[id] = ml;
        value = ml;
        return true;
      }
      value = null!;
      return false;
    }
    var rows = b.MeetingMessages(id);
    if (rows.Count == 0) { value = null; return false; }
    value = new MessageList(b, id, rows);
    return true;
  }

  public void Clear()
  {
    var b = Pg.Backend;
    if (b is null) _mem.Clear();
    else { b.ClearMessages(); if (!b.IsTransacting) b.Save(); }
  }

  public IEnumerator<KeyValuePair<Guid, List<Domain.Message>>> GetEnumerator()
  {
    var b = Pg.Backend;
    if (b is null)
    {
      foreach (var kv in _mem) yield return kv;
      yield break;
    }
    foreach (var mid in b.MessageMeetings())
      yield return new KeyValuePair<Guid, List<Domain.Message>>(mid, new MessageList(b, mid, b.MeetingMessages(mid)));
  }

  System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
}
/// <summary>Durable append-only ledger for usage/model-call events.
/// Memory mode (no PG backend): session-lifetime in-memory bag, clearly
/// labeled session-lifetime in the UI. PG mode: the database is the
/// exclusive source of truth. New events are published ONLY by committing
/// them to Postgres; nothing is pre-published to memory, no memory cache is
/// merged into database reads, and database read failures propagate instead
/// of silently returning memory/empty rows as durable history.
/// Immutable events: callers add once per actual provider call and never
/// mutate. Same-call ledger/event pairs commit atomically when the caller
/// uses Atomic.Run. Storage failures throw and must never be swallowed as
/// malformed-provider errors and must never trigger a second accounting
/// attempt (see UsageStorageException).</summary>
public sealed class DurableBag<T> : IEnumerable<T> where T : class
{
  private readonly ConcurrentBag<T> _mem = new();

  public void Add(T item)
  {
    var b = Pg.Backend;
    if (b is null) { _mem.Add(item); return; }
    b.Upsert(item);
    if (!b.IsTransacting) b.Save();
  }

  public IEnumerator<T> GetEnumerator()
  {
    var b = Pg.Backend;
    if (b is null) return _mem.GetEnumerator();
    return b.All<T>().GetEnumerator();
  }

  System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
}
