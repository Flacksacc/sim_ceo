using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// Bounded job worker (Phase 10 Ops): explicit execution for a STRICT set of
// known kinds reusing the actual domain handlers — source reindex via the
// real extraction/index governance pipeline, wiki sync via WikiSyncService.
// No generic task framework, no external queue, no background thread: execution
// is claimed explicitly (one attempt ownership), the async domain work runs
// OUTSIDE every lock, and the result commits in a short unit with fresh
// authority + restore-epoch rechecks. Concurrent execution cannot duplicate
// effects: exactly one claim wins; the other sees running and gets 409.
// Execution never approves sources or mutates billing ledgers.
// Restart reconciliation marks running jobs interrupted (never auto-runs).
public static class JobWorker
{
  public static readonly IReadOnlySet<string> KnownKinds = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "index", "wiki-sync" };

  public sealed record JobTarget(string Kind, Guid TargetId);

  public static bool TryParseTarget(JsonElement body, out JobTarget? target, out string error)
  {
    target = null; error = "";
    var kind = body.TryGetProperty("kind", out var k) && k.ValueKind == JsonValueKind.String ? (k.GetString() ?? "").Trim().ToLowerInvariant() : "";
    if (!KnownKinds.Contains(kind)) { error = "Unknown job kind; supported: index, wiki-sync."; return false; }
    if (!body.TryGetProperty("targetId", out var tv) || tv.ValueKind != JsonValueKind.String || !Guid.TryParse(tv.GetString(), out var tid) || tid == Guid.Empty) { error = "targetId must be a non-empty GUID."; return false; }
    target = new JobTarget(kind, tid);
    return true;
  }

  public static string CanonicalPayload(JobTarget t) =>
    "{\"kind\":\"" + t.Kind + "\",\"targetId\":\"" + t.TargetId.ToString("N") + "\"}";

  public static string Fingerprint(string canonical) =>
    Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("job:v1:" + canonical))).ToLowerInvariant();

  public static JobRow? FindSamePayload(InMemoryStore s, JobTarget t)
  {
    foreach (var j in s.Jobs.Values)
    {
      if (!string.Equals(j.Kind, t.Kind, StringComparison.OrdinalIgnoreCase)) continue;
      try
      {
        using var d = JsonDocument.Parse(string.IsNullOrWhiteSpace(j.Payload) ? "{}" : j.Payload);
        if (d.RootElement.TryGetProperty("targetId", out var tv) && tv.ValueKind == JsonValueKind.String && Guid.TryParse(tv.GetString(), out var g) && g == t.TargetId) return j;
      }
      catch (JsonException) { }
    }
    return null;
  }

  // Restart/interrupted reconciliation: running jobs are uncertain (the
  // process may have died mid-execution), so they become interrupted with
  // their payload intact for explicit retry. Never auto-executes.
  public static int RecoverInterrupted(InMemoryStore s)
  {
    int n = 0;
    Atomic.Run(s, () =>
    {
      foreach (var r in s.Jobs.Values.ToList())
      {
        if (r.State == "running")
        {
          r.State = "interrupted";
          r.Error = "Process restarted during execution; retry explicitly to resume.";
          r.UpdatedAt = DateTime.UtcNow;
          s.Jobs[r.Id] = r;
          n++;
        }
      }
      s.Jobs.Flush();
    });
    return n;
  }
}