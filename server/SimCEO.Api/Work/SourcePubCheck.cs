using SimCEO.Api.Data;
namespace SimCEO.Api.Work;
public static class SourcePubCheck
{
  public static bool ManifestRevoked(InMemoryStore s, CuratorManifest? manifest, System.Guid meetingId)
  {
    if (manifest is null || manifest.SourceIds.Count == 0) return false;
    foreach (var sid in manifest.SourceIds)
    {
      var parts = (sid ?? "").Split(":");
      if (parts.Length == 0) return true;
      System.Guid srcId;
      if (!System.Guid.TryParse(parts[0], out srcId)) return true;
      SimCEO.Api.Domain.SourceDoc? doc = null;
      if (!s.Sources.TryGetValue(srcId, out doc) || doc is null) return true;
      if (!SourceGovernance.IsEligible(s, doc, meetingId)) return true;
    }
    return false;
  }
}