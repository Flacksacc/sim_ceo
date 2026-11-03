using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using System.Text.Json;

namespace SimCEO.Api.Work;

// Phase7 seam: wiki SourceDocs are usable only when their connector resource
// is present, board/scoped correctly, enabled, on the current healthy revision,
// and their family key belongs to the current successful sync membership.
// Any failure/disabled/stale state blocks ALL cached connector evidence
// (fail-closed); historical rows remain inspectable but ineligible.
public static class WikiEligibility
{
  public static bool IsUsable(InMemoryStore s, SourceDoc d)
  {
    var org = (d.Origin ?? "").Trim().ToLowerInvariant();
    if (org != "wiki") return true; // non-wiki docs use the standard predicate
    if (!d.ResourceId.HasValue || d.ResourceId.Value == Guid.Empty) return false;
    if (!s.WikiResources.TryGetValue(d.ResourceId.Value, out var r)) return false;
    if (r.BoardId != d.BoardId) return false;
    var scope = (r.Scope ?? "board").Trim().ToLowerInvariant();
    var dscope = (d.Scope ?? "board").Trim().ToLowerInvariant();
    if (scope != dscope) return false;
    if (scope == "meeting")
    {
      if (!r.MeetingId.HasValue || !d.MeetingId.HasValue) return false;
      if (r.MeetingId.Value != d.MeetingId.Value) return false;
    }
    if (!r.Enabled) return false;
    if (!string.Equals(r.LastStatus ?? "", "succeeded", StringComparison.OrdinalIgnoreCase)) return false;
    if (r.ConfigRevision != r.LastSuccessRevision) return false;
    if (r.LastSuccessRevision <= 0) return false;
    // Membership: only the current successful sync's present, rule-allowed
    // pages are usable. Removed pages and rule exclusions drop out here.
    HashSet<string> members;
    try
    {
      var list = JsonSerializer.Deserialize<List<string>>(string.IsNullOrWhiteSpace(r.SuccessPagesJson) ? "[]" : r.SuccessPagesJson);
      members = new HashSet<string>(list ?? new(), StringComparer.Ordinal);
    }
    catch { return false; }
    if (!members.Contains(d.FamilyKey ?? "")) return false;
    return true;
  }
}
