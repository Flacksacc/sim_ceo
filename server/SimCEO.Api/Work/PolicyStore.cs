using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// Effective installation policy (spending controls + model connection
// overrides). Spending controls are durable: the singleton InstallationPolicy
// row is the source of truth in PG mode (survives restarts); the in-memory
// fields are a write-through cache refreshed only AFTER durable success.
// Memory mode: the in-memory fields are the truth. Readers prefer the
// database whenever a backend is wired so a restarted process observes
// current policy. A storage FAILURE is never a missing row: lookups throw
// PolicyUnavailableException (fail closed, 503) instead of substituting
// defaults or a different environment key. All writers run inside the
// caller-owned store-bound unit so PG commits roll back with the unit and
// the deep memory snapshot restores scalars in every mode.
// SECRET CONTRACT: API key material is NEVER persisted. The key override
// lives memory-only (seeded from the private app environment at startup,
// replaceable at runtime, cleared on restart). Only non-secret settings
// (spend cap/mode, chat model name) are durable.
public static class PolicyStore
{
  public static readonly Guid SingletonId = Guid.Parse("11111111-2222-4333-8444-555555555555");

  public static (decimal? cap, string mode) ReadSpend(InMemoryStore s)
  {
    // Fresh-install truth: no configured policy means warn-only, never an
    // empty/unsupported mode. Blank is a legacy/empty-slot signal, so GET
    // normalizes it to "warn" in memory only (no durable write, no secret
    // or policy mutation). A configured "block" + cap passes through
    // unchanged. Storage failures throw PolicyUnavailableException (503).
    static string NormMode(string? m) => string.IsNullOrWhiteSpace(m) ? "warn" : m!;
    var b = Pg.Backend;
    if (b is null) { lock (s.RootGate) return (s.Spend.MonthlyCapUsd, NormMode(s.Spend.Mode)); }
    // Root-held projection: lookup AND scalar copy happen under the root gate
    // (outer) and the single backend gate (inner), preserving ROOT -> backend
    // order. Scalars are detached: a concurrent writer that later rolls back
    // can never leak uncommitted or torn values into this reader. Never hold
    // the root across a provider await: this path is fully synchronous.
    lock (s.RootGate)
    {
      try
      {
        if (SimCEO.Api.Data.PgFaults.FailPolicyLookup?.Invoke() == true) throw new System.IO.IOException("injected policy lookup fault (PgFaults.FailPolicyLookup)");
        (decimal? cap, string mode)? snap = b.Project<InstallationPolicy, (decimal? cap, string mode)?>(
          SingletonId, row => row is null ? null : (row.MonthlyCapUsd, string.IsNullOrWhiteSpace(row.Mode) ? "warn" : row.Mode));
        if (snap is null) return (s.Spend.MonthlyCapUsd, NormMode(s.Spend.Mode));
        return (snap.Value.cap, NormMode(snap.Value.mode));
      }
      catch (PolicyUnavailableException) { throw; }
      catch (Exception ex) { throw new PolicyUnavailableException("Installation policy store unavailable; failing closed instead of substituting defaults.", ex); }
    }
  }

  public static void WriteSpend(InMemoryStore s, decimal? cap, string mode)
  {
    var b = Pg.Backend;
    if (b is null) { lock (s.RootGate) { s.Spend.MonthlyCapUsd = cap; s.Spend.Mode = mode; } return; }
    decimal? oldCap; string oldMode;
    lock (s.RootGate) { oldCap = s.Spend.MonthlyCapUsd; oldMode = s.Spend.Mode; }
    try { Atomic.Compensate(s, () => { lock (s.RootGate) { s.Spend.MonthlyCapUsd = oldCap; s.Spend.Mode = oldMode; } }); } catch { }
    // Gated mutation under the root gate (ROOT -> backend order): field
    // assignments never race a gated reader copy.
    lock (s.RootGate)
    {
      try { b.Mutate<InstallationPolicy>(SingletonId, () => new InstallationPolicy { Id = SingletonId }, row => { row.MonthlyCapUsd = cap; row.Mode = mode; }); }
      catch (Exception ex) { throw new PolicyUnavailableException("Installation policy store unavailable; spend update refused.", ex); }
      if (!b.IsTransacting) b.Save();
    }
    lock (s.RootGate) { s.Spend.MonthlyCapUsd = cap; s.Spend.Mode = mode; }
  }

  public static string ReadApiKey(InMemoryStore s)
  {
    lock (s.RootGate) return s.ModelApiKeyOverride;
  }

  public static string ReadChatModel(InMemoryStore s)
  {
    var b = Pg.Backend;
    if (b is null) { lock (s.RootGate) return s.ModelChatOverride; }
    // Same root-held projection contract as ReadSpend: no observable
    // uncommitted, torn, or rejected policy. Fully synchronous: the root is
    // never held across a provider await.
    lock (s.RootGate)
    {
      try
      {
        if (SimCEO.Api.Data.PgFaults.FailPolicyLookup?.Invoke() == true) throw new System.IO.IOException("injected policy lookup fault (PgFaults.FailPolicyLookup)");
        string? snap = b.Project<InstallationPolicy, string?>(
          SingletonId, row => row is null ? null : (row.ModelChatOverride ?? ""));
        if (snap is null) return s.ModelChatOverride;
        return snap;
      }
      catch (PolicyUnavailableException) { throw; }
      catch (Exception ex) { throw new PolicyUnavailableException("Installation policy store unavailable; failing closed instead of substituting a different model.", ex); }
    }
  }

  public static void WriteConnection(InMemoryStore s, string apiKey, string chatModel)
  {
    var b = Pg.Backend;
    string oldKey, oldChat; DateTime? oldAt; bool oldOk; string oldErr, oldModel;
    lock (s.RootGate)
    {
      oldKey = s.ModelApiKeyOverride; oldChat = s.ModelChatOverride;
      oldAt = s.ModelLastTestAt; oldOk = s.ModelLastTestOk; oldErr = s.ModelLastTestError; oldModel = s.ModelLastTestModel;
    }
    try
    {
      Atomic.Compensate(s, () =>
      {
        lock (s.RootGate)
        {
          s.ModelApiKeyOverride = oldKey; s.ModelChatOverride = oldChat;
          s.ModelLastTestAt = oldAt; s.ModelLastTestOk = oldOk;
          s.ModelLastTestError = oldErr; s.ModelLastTestModel = oldModel;
        }
      });
    }
    catch { }
    if (b is not null)
    {
      // Gated mutation under the root gate (ROOT -> backend order): the
      // durable chat-model write never races a gated reader copy. Key
      // material stays memory-only by contract (never persisted here).
      lock (s.RootGate)
      {
        try { b.Mutate<InstallationPolicy>(SingletonId, () => new InstallationPolicy { Id = SingletonId }, row => { row.ModelChatOverride = chatModel; }); }
        catch (Exception ex) { throw new PolicyUnavailableException("Installation policy store unavailable; connection update refused.", ex); }
        if (!b.IsTransacting) b.Save();
      }
    }
    lock (s.RootGate)
    {
      s.ModelApiKeyOverride = apiKey;
      s.ModelChatOverride = chatModel;
      s.ModelLastTestAt = null;
      s.ModelLastTestOk = false;
      s.ModelLastTestError = string.Empty;
    }
  }
}
