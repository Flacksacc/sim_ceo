using SimCEO.Api.Data;

namespace SimCEO.Api.Work;

// Canonical ownership for legacy roster rows: an explicit non-empty OwnerKey
// always wins. A blank legacy OwnerKey resolves to the single non-empty
// linked-board owner when every linked board agrees (single-user legacy/demo
// context). Historical (removed) links count, so removing the last live
// member link cannot delete account roster ownership. Ambiguous (several
// owners), ownerless (blank board owners), or
// unlinked rows resolve to null: no invented ownership, no cross-account
// merge. Read/write callers combine this with the attached-board membership
// rule; neither rule alone leaks entries from boards the caller cannot read.
public static class RosterLegacyAccess
{
  public static string? EffectiveOwnerKey(InMemoryStore s, Domain.RosterEntry entry)
  {
    var own = (entry.OwnerKey ?? "").Trim();
    if (own.Length > 0) return own;
    List<Guid> linked;
    try { linked = s.Advisors.Values.Where(a => a.RosterEntryId == entry.Id).Select(a => a.BoardId).Distinct().ToList(); }
    catch { return null; }
    if (linked.Count == 0) return null;
    var owners = new List<string>();
    foreach (var bid in linked)
    {
      if (!s.Boards.TryGetValue(bid, out var b) || b is null) return null;
      var bo = (b.OwnerKey ?? "").Trim();
      if (bo.Length == 0) return null;
      if (!owners.Any(o => string.Equals(o, bo, StringComparison.OrdinalIgnoreCase))) owners.Add(bo);
    }
    return owners.Count == 1 ? owners[0] : null;
  }

  // Legacy blank-owner write allowance: the caller is the unambiguous
  // linked-board owner. Explicit-owner rows are handled by the primary rule;
  // this hook only fires for blank OwnerKey rows (checked by the caller).
  public static bool CallerMatchesEffectiveOwner(InMemoryStore s, HttpRequest req, Domain.RosterEntry entry)
  {
    if (!string.IsNullOrWhiteSpace(entry.OwnerKey)) return false;
    var eff = EffectiveOwnerKey(s, entry);
    if (eff is null) return false;
    var me = SimCEO.Api.PeopleOps.UserOf(s, req);
    return string.Equals(eff, me, StringComparison.OrdinalIgnoreCase);
  }

}
