using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

/// <summary>Effective installation policy (spending controls + model
/// connection overrides). PG mode: the singleton InstallationPolicy row is
/// the source of truth (survives restarts); the in-memory fields are a
/// write-through cache refreshed on every write. Memory mode: the in-memory
/// fields are the truth. Readers prefer the database whenever a backend is
/// wired so a restarted process observes current policy. All writers run
/// inside the caller-owned store-bound unit so PG commits roll back with
/// the unit and memory rollback restores via MemoryCapture (Spend).</summary>
public static class PolicyStore
{
  public static readonly Guid SingletonId = Guid.Parse("11111111-2222-4333-8444-555555555555");

  public static (decimal? cap, string mode) ReadSpend(InMemoryStore s)
  {
    var b = Pg.Backend;
    if (b is null) return (s.Spend.MonthlyCapUsd, s.Spend.Mode);
    InstallationPolicy? row = null;
    try { row = b.Find<InstallationPolicy>(SingletonId); } catch { row = null; }
    if (row is null) return (s.Spend.MonthlyCapUsd, s.Spend.Mode);
    return (row.MonthlyCapUsd, string.IsNullOrWhiteSpace(row.Mode) ? "warn" : row.Mode);
  }
  public static void WriteSpend(InMemoryStore s, decimal? cap, string mode)
  {
    s.Spend.MonthlyCapUsd = cap;
    s.Spend.Mode = mode;
    var b = Pg.Backend;
    if (b is null) return;
    var row = b.Find<InstallationPolicy>(SingletonId) ?? new InstallationPolicy { Id = SingletonId };
    row.MonthlyCapUsd = cap;
    row.Mode = mode;
    b.Upsert(row);
    if (!b.IsTransacting) b.Save();
  }

  public static string ReadApiKey(InMemoryStore s)
  {
    var b = Pg.Backend;
    if (b is null) return s.ModelApiKeyOverride;
    InstallationPolicy? row = null;
    try { row = b.Find<InstallationPolicy>(SingletonId); } catch { row = null; }
    return row is null ? s.ModelApiKeyOverride : (row.ModelApiKeyOverride ?? "");
  }
  public static string ReadChatModel(InMemoryStore s)
  {
    var b = Pg.Backend;
    if (b is null) return s.ModelChatOverride;
    InstallationPolicy? row = null;
    try { row = b.Find<InstallationPolicy>(SingletonId); } catch { row = null; }
    return row is null ? s.ModelChatOverride : (row.ModelChatOverride ?? "");
  }

  public static void WriteConnection(InMemoryStore s, string apiKey, string chatModel)
  {
    s.ModelApiKeyOverride = apiKey;
    s.ModelChatOverride = chatModel;
    s.ModelLastTestAt = null;
    s.ModelLastTestOk = false;
    s.ModelLastTestError = string.Empty;
    var b = Pg.Backend;
    if (b is null) return;
    var row = b.Find<InstallationPolicy>(SingletonId) ?? new InstallationPolicy { Id = SingletonId };
    row.ModelApiKeyOverride = apiKey;
    row.ModelChatOverride = chatModel;
    b.Upsert(row);
    if (!b.IsTransacting) b.Save();
  }
}
