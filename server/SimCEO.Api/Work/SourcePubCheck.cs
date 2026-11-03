using SimCEO.Api.Data;
namespace SimCEO.Api.Work;
// Publication revocation gate. A manifest entry pins source identity AND the
// exact index generation, content hash, and persisted section revision
// captured at draft time ("{id}:v{version}:g{generation}:{hash}:s{secrev}";
// legacy "{id}:v{version}" or 3-part entries still parse). Any drift —
// revocation, exclusion, policy change, scope change, reindex/generation
// bump, hash change, section-text swap, or restore — revokes the manifest so
// the commit yields instead of publishing stale evidence. Every source entry
// must additionally belong to the destination meeting's board. Unknown or
// missing rows fail closed.
public static class SourcePubCheck
{
  public static bool ManifestRevoked(InMemoryStore s, CuratorManifest? manifest, System.Guid meetingId)
  {
    if (manifest is null || manifest.SourceIds.Count == 0) return false;
    if (!s.Meetings.TryGetValue(meetingId, out var mtg) || mtg is null) return true;
    var destBoard = mtg.BoardId;
    foreach (var sid in manifest.SourceIds)
    {
      var parts = (sid ?? "").Split(":");
      if (parts.Length == 0) return true;
      System.Guid srcId;
      if (!System.Guid.TryParse(parts[0], out srcId)) return true;
      SimCEO.Api.Domain.SourceDoc? doc = null;
      if (!s.Sources.TryGetValue(srcId, out doc) || doc is null) return true;
      if (doc.BoardId != destBoard) return true;
      if (!SourceGovernance.IsEligible(s, doc, meetingId)) return true;
      foreach (var p in parts)
      {
        if (p.StartsWith("v") && int.TryParse(p.Substring(1), out var wantV))
        {
          if (doc.Version != wantV) return true;
        }
        else if (p.StartsWith("g") && int.TryParse(p.Substring(1), out var wantG))
        {
          if (doc.IndexGeneration != wantG) return true;
        }
        else if (p.StartsWith("s") && p.Length == 65)
        {
          if (!string.Equals(SourceGovernance.SectionRevision(s, doc.Id), p.Substring(1), System.StringComparison.OrdinalIgnoreCase)) return true;
        }
        else if (p.Length == 64 && p.All(c => Uri.IsHexDigit(c)))
        {
          if (!string.Equals(doc.ContentHash ?? "", p, System.StringComparison.OrdinalIgnoreCase)) return true;
        }
      }
    }
    return false;
  }
}
