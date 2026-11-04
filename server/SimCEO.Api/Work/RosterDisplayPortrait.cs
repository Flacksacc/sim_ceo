using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api;

// Explicit same-roster portrait selection wins; otherwise use the latest
// available canonical portrait. Legacy pending pictures need no approval.
// Rejected pictures and invalid/ambiguous explicit selections stay hidden.
// Null renders initials and never blocks the advisor's profile completeness.
public static class RosterDisplayOps
{
  public static AdvisorImage? ResolveDisplayPortrait(InMemoryStore s, BoardAdvisor a)
  {
    var sel = RosterOps.ResolveSelectedImage(s, a);
    if (sel is not null)
    {
      if (sel.RosterEntryId != a.RosterEntryId) return null;
      return RosterOps.IsPortraitAccepted(sel) ? sel : null;
    }
    if (RosterOps.HasExplicitPortraitSelection(a)) return null;
    return s.Images.Values
      .Where(i => i.RosterEntryId == a.RosterEntryId && RosterOps.IsPortraitAccepted(i))
      .OrderByDescending(i => i.CreatedAt).ThenBy(i => i.Id)
      .FirstOrDefault();
  }
}
