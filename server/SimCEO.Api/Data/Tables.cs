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

/// <summary>
/// Code-only memory-capture fault seam for rollback tests. In-process QA may set
/// <see cref="FailCapture"/> to force the next memory capture to fail, proving the
/// unit unwinds cleanly (depth reset, no snapshot, store reusable) instead of
/// poisoning ownership. Never exposed via HTTP routes or environment.
/// </summary>
public static class MemFaults
{
  public static Func<bool>? FailCapture;
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

  // ---- Store-bound synchronous unit (integration root gate) ----
  // One per-store root mutation gate precedes any backend gate: callers hold the
  // root (Setup/Message/Auth/Spend/Model locks all alias it), then enter here;
  // the backend gate (_gate inside Transact) is always innermost. Entering
  // without the root held throws fail-closed. Same-store nesting joins the
  // current outermost unit; entering inside a FOREIGN active backend
  // transaction (a backend-only outer unit) also throws: nesting must be
  // explicit and owned, never accidental.
  // Outermost exit owns: exact deep memory capture/staged replacement (memory
  // mode), the compensation journal for non-EF in-process state (sessions in
  // every mode), and deferred post-COMMIT effects. Nested success is not
  // commit: inner frames only adjust depth. A nested failure marks the whole
  // unit rollback-only; only the outermost exit rolls back (deep restore +
  // LIFO compensations, effects discarded) and only the outermost success
  // releases deferred effects. A nested failure the operation catches is still
  // enforced: any frame exiting successfully while rollback-only is marked
  // rolls back and throws instead of committing.
  private sealed class UnitState
  {
    public int Depth;
    public bool Aborted;
    public List<Action>? Deferred;
    public List<Action>? Compensations;
    public InMemoryStore.MemoryCapture? MemSnap;
  }
  private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<InMemoryStore, UnitState> UnitStates = new();
  private static readonly object UnitGate = new();

  public static void Run(InMemoryStore s, Action op) => Run<object?>(s, () => { op(); return null; });

  public static T Run<T>(InMemoryStore s, Func<T> op)
  {
    // The unit acquires the store root gate itself BEFORE touching the backend,
    // so entry order is root-first by construction (re-entrant when the caller
    // already holds it). Never hold this gate across an awaited provider call:
    // async work stays outside the unit; only capture/validate/commit enter.
    lock (s.RootGate)
    {
      return RunGated(s, op);
    }
  }

  private static T RunGated<T>(InMemoryStore s, Func<T> op)
  {
    UnitState st = UnitStates.GetOrCreateValue(s);
    bool outer;
    lock (UnitGate)
    {
      if (st.Depth > 0) outer = false;
      else if (Pg.Backend?.IsTransacting == true)
        throw new InvalidOperationException("Store-bound Atomic unit entered inside a foreign active backend transaction; hoist it outermost so commit effects and rollback own the whole unit.");
      else { outer = true; st.Depth = 1; st.Aborted = false; }
      if (!outer) st.Depth++;
    }
    if (outer && Pg.Backend is null)
    {
      // Capture fault must unwind cleanly: depth reset, no snapshot, no state.
      try { st.MemSnap = s.CaptureMemory(); }
      catch { lock (UnitGate) { st.Depth = 0; st.Aborted = false; } throw; }
    }
    bool succeeded = false;
    try
    {
      // Rollback-only is enforced INSIDE the backend callback, before the
      // backend can COMMIT: a nested failure caught by the operation must fail
      // this unit instead of committing it. This check runs in every frame, so
      // a middle frame that caught a deeper failure also refuses its own
      // commit and fails upward without touching shared ownership.
      var result = Run(() =>
      {
        var r = op();
        bool abortedNow;
        lock (UnitGate) { abortedNow = st.Aborted; }
        if (abortedNow) throw new InvalidOperationException("Store-bound unit marked rollback-only by a nested failure; refusing commit.");
        return r;
      });
      succeeded = true;
      List<Action>? fx = null;
      bool aborted;
      lock (UnitGate)
      {
        st.Depth--;
        aborted = st.Aborted;
        if (outer && !aborted)
        {
          fx = st.Deferred;
          st.Deferred = null; st.Compensations = null; st.MemSnap = null;
          st.Aborted = false;
        }
      }
      if (aborted)
      {
        // Only the outermost frame may restore/reset/discard: a middle frame
        // must not touch shared ownership while the real outer operation may
        // still be executing (it could catch this and continue). The middle
        // frame fails upward without state surgery; the outermost exit owns
        // the single rollback and the deferred-effect discard.
        if (outer)
        {
          RollbackOuter(s, st);
          throw new InvalidOperationException("Store-bound unit marked rollback-only by a nested failure; rolled back instead of committing.");
        }
        throw new InvalidOperationException("Store-bound nested unit aborted; failing upward without state surgery.");
      }
      // Commit already happened exactly once above; deferred live effects
      // (staged audits, bumps, hub revocations) run only now. Their faults
      // propagate instead of vanishing: the state change is durable.
      if (fx is not null) foreach (var f in fx) f();
      return result;
    }
    catch (Exception ex)
    {
      if (!succeeded)
      {
        bool doRollback = false;
        lock (UnitGate)
        {
          st.Aborted = true;
          if (st.Depth > 0) st.Depth--;
          doRollback = outer;
        }
        if (doRollback) RollbackOuter(s, st, ex);
      }
      throw;
    }
  }

  private static void RollbackOuter(InMemoryStore s, UnitState st, Exception? cause = null)
  {
    List<Action>? cp;
    InMemoryStore.MemoryCapture? snap;
    lock (UnitGate)
    {
      cp = st.Compensations; st.Compensations = null;
      st.Deferred = null;
      snap = st.MemSnap; st.MemSnap = null;
      st.Depth = 0; st.Aborted = false;
    }
    Exception? restoreError = null;
    if (snap is not null && Pg.Backend is null)
    {
      try { s.RestoreMemory(snap); }
      catch (Exception rex) { restoreError = rex; }
    }
    List<Exception>? compErrors = null;
    if (cp is not null) for (var i = cp.Count - 1; i >= 0; i--) { try { cp[i](); } catch (Exception cex) { compErrors ??= new List<Exception>(); compErrors.Add(cex); } }
    if (restoreError is not null || compErrors is not null)
    {
      // No false "restored": a failed rollback or failed compensation is
      // surfaced with every fault (original, restore, compensations).
      var inners = new List<Exception>();
      if (cause is not null) inners.Add(cause);
      if (restoreError is not null) inners.Add(restoreError);
      if (compErrors is not null) inners.AddRange(compErrors);
      throw new AggregateException("Store-bound unit failed and rollback is uncertain; prior state may be partial.", inners);
    }
  }

  // Staged audit: runs only after the outermost store-bound success (all modes).
  // Throws outside an active store-bound unit so audits can never run uncommitted.
  public static void Audit(InMemoryStore s, Domain.AuditEvent e) => DeferOrRun(s, () => s.Audit.Add(e));

  // Post-commit effect: runs only after the outermost store-bound success.
  // Throws outside an active store-bound unit so effects can never run uncommitted.
  public static void Defer(InMemoryStore s, Action effect)
  {
    UnitState st = UnitStates.GetOrCreateValue(s);
    lock (UnitGate)
    {
      if (st.Depth <= 0) throw new InvalidOperationException("Atomic.Defer requires an active store-bound unit; post-commit effects must not run uncommitted.");
      st.Deferred ??= new List<Action>();
      st.Deferred.Add(effect);
    }
  }

  // Post-commit effect that also runs immediately outside any unit (preserves
  // the legacy direct-call behavior for paths that mutate without a unit).
  public static void DeferOrRun(InMemoryStore s, Action effect)
  {
    UnitState st = UnitStates.GetOrCreateValue(s);
    bool inside;
    lock (UnitGate) { inside = st.Depth > 0; }
    if (inside) Defer(s, effect); else effect();
  }

  // Rollback compensation for non-EF in-process state (e.g. session removal):
  // runs LIFO only if the outermost store-bound unit fails. Outside any unit it
  // throws instead of silently never running.
  public static void Compensate(InMemoryStore s, Action rollback)
  {
    UnitState st = UnitStates.GetOrCreateValue(s);
    lock (UnitGate)
    {
      if (st.Depth <= 0) throw new InvalidOperationException("Atomic.Compensate requires an active store-bound unit.");
      st.Compensations ??= new List<Action>();
      st.Compensations.Add(rollback);
    }
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
    var found = b.Find<T>(id);
    if (found is null) { value = default!; return false; }
    value = found;
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

  // Memory-mode staged replacement support: deep-capture and restore the live
  // dictionary. Only meaningful when no PG backend is wired (EF owns rollback
  // otherwise). Rows are deep-cloned through JSON so in-place field edits roll
  // back too, never shallow row references.
  public Dictionary<Guid, T> CaptureLive()
  {
    var snap = new Dictionary<Guid, T>();
    foreach (var kv in _mem) snap[kv.Key] = CloneRow(kv.Value);
    return snap;
  }
  public void RestoreLive(Dictionary<Guid, T> snap)
  {
    // Two-phase: fallible deep-clone first (live untouched on failure), then an
    // infallible swap. No table is ever left half-populated under a success claim.
    var fresh = new Dictionary<Guid, T>(snap.Count);
    foreach (var kv in snap) fresh[kv.Key] = CloneRow(kv.Value);
    _mem.Clear();
    foreach (var kv in fresh) _mem[kv.Key] = kv.Value;
  }
  private static T CloneRow(T row)
  {
    var json = System.Text.Json.JsonSerializer.Serialize(row);
    return System.Text.Json.JsonSerializer.Deserialize<T>(json)!;
  }
}

/// <summary>Append-only stream. Memory-only by design (audit is ephemeral).</summary>
public sealed class Bag<T> : IEnumerable<T>
{
  private readonly ConcurrentBag<T> _bag = new();
  public void Add(T item) => _bag.Add(item);
  // Memory-mode staged replacement for append-only audit: exact rebuild.
  public List<T> CaptureLive() => _bag.Select(CloneItem).ToList();
  public void RestoreLive(List<T> snap)
  {
    var fresh = snap.Select(CloneItem).ToList();
    while (_bag.TryTake(out _)) { }
    foreach (var item in fresh) _bag.Add(item);
  }
  private static T CloneItem(T item)
  {
    var json = System.Text.Json.JsonSerializer.Serialize(item);
    return System.Text.Json.JsonSerializer.Deserialize<T>(json)!;
  }
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
    if (rows.Count == 0) { value = null!; return false; }
    value = new MessageList(b, id, rows);
    return true;
  }

  public void Clear()
  {
    var b = Pg.Backend;
    if (b is null) _mem.Clear();
    else { b.ClearMessages(); if (!b.IsTransacting) b.Save(); }
  }

  // Memory-mode staged replacement: deep-capture/restore per-meeting lists.
  public Dictionary<Guid, List<Domain.Message>> CaptureLive()
  {
    var snap = new Dictionary<Guid, List<Domain.Message>>();
    foreach (var kv in _mem)
      snap[kv.Key] = kv.Value.Select(m => CloneMessage(m)).ToList();
    return snap;
  }
  public void RestoreLive(Dictionary<Guid, List<Domain.Message>> snap)
  {
    var fresh = new Dictionary<Guid, List<Domain.Message>>(snap.Count);
    foreach (var kv in snap)
      fresh[kv.Key] = kv.Value.Select(m => CloneMessage(m)).ToList();
    _mem.Clear();
    foreach (var kv in fresh) _mem[kv.Key] = kv.Value;
  }
  private static Domain.Message CloneMessage(Domain.Message m)
  {
    var json = System.Text.Json.JsonSerializer.Serialize(m);
    return System.Text.Json.JsonSerializer.Deserialize<Domain.Message>(json)!;
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

  // Memory-mode staged replacement: the bag is append-only, so a deep list
  // capture plus drain-and-refill restore is exact.
  public List<T> CaptureLive() =>
    _mem.Select(CloneItem).ToList();
  public void RestoreLive(List<T> snap)
  {
    var fresh = snap.Select(CloneItem).ToList();
    while (_mem.TryTake(out _)) { }
    foreach (var item in fresh) _mem.Add(item);
  }
  private static T CloneItem(T item)
  {
    var json = System.Text.Json.JsonSerializer.Serialize(item);
    return System.Text.Json.JsonSerializer.Deserialize<T>(json)!;
  }

  public IEnumerator<T> GetEnumerator()
  {
    var b = Pg.Backend;
    if (b is null) return _mem.GetEnumerator();
    return b.All<T>().GetEnumerator();
  }

  System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
}
