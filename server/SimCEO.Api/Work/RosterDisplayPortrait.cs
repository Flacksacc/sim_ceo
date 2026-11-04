using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api;

// Read-only meeting display portrait: SAME authoritative resolution as
// RosterOps.ReviewedPortraitFingerprint / RosterOps.ApprovalGate, returning
// the accepted image for display (null renders the initials fallback).
// Explicit valid accepted selection wins; explicit invalid/pending/rejected
// stays null (no rescuing with an arbitrary accepted upload); ambiguous
// legacy 8-char prefix stays null (never guess); no-selection with a single
// accepted linked row wins, single pending linked stays null (no legacy
// rescue, matching ApprovalGate blocking), otherwise deterministic accepted
// legacy (CreatedAt Then Id) identical to the fingerprint/gate order.
// Read-only: no mutation, no approval change, no new permission or keys.
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
      .OrderBy(i => i.CreatedAt).ThenBy(i => i.Id)
      .FirstOrDefault();
  }
}
