using System.Text.Json;
using SimCEO.Api.Data;

namespace SimCEO.Api.Work;

// Canonical ownership for legacy roster rows: an explicit non-empty OwnerKey
// always wins. A blank legacy OwnerKey resolves to the single non-empty
// linked-board owner when every linked board agrees (single-user legacy/demo
// context). Ambiguous (several owners), ownerless (blank board owners), or
// unlinked rows resolve to null: no invented ownership, no cross-account
// merge. Read/write callers combine this with the attached-board membership
// rule; neither rule alone leaks entries from boards the caller cannot read.
public static class RosterLegacyAccess
{
  // Single source of truth for legacy ownership: explicit OwnerKey wins, otherwise
  // the strict history-aware rule (removed links count as evidence; unknown, missing,
  // or conflicting owners fail closed). Read visibility uses the same rule, so an
  // entry never shows to one account by ownership while writing as another.
  public static string? EffectiveOwnerKey(InMemoryStore s, Domain.RosterEntry entry)
  {
    var own = (entry.OwnerKey ?? "").Trim();
    if (own.Length > 0) return own;
    return MutationOwnerKey(s, entry.Id);
  }
  // Mutation-grade ownership: historical REMOVED links also count as evidence,
  // and unknown owners (missing board, blank board owner) count as CONFLICT,
  // never as silent consent. A removed Alice link plus an active Bob link is
  // ambiguous (no silent Alice->Bob transfer); a vanished last link keeps its
  // owner (ownership does not vanish with removal). Exactly one distinct real
  // owner and zero unknowns required, else null.
  public static string? MutationOwnerKey(InMemoryStore s, Guid rosterId)
  {
    List<Guid> boards;
    try { boards = s.Advisors.Values.Where(a => a.RosterEntryId == rosterId).Select(a => a.BoardId).Distinct().ToList(); }
    catch { return null; }
    if (boards.Count == 0) return null;
    var owners = new List<string>();
    foreach (var bid in boards)
    {
      if (!s.Boards.TryGetValue(bid, out var b) || b is null) return null;
      var bo = (b.OwnerKey ?? "").Trim();
      if (bo.Length == 0) return null;
      if (!owners.Any(o => string.Equals(o, bo, StringComparison.OrdinalIgnoreCase))) owners.Add(bo);
    }
    return owners.Count == 1 ? owners[0] : null;
  }
  // ONE strict ownership rule for EVERY repair mutation (re-pin, dedupe,
  // missing/empty recovery, relink) on entries without an explicit non-empty
  // canonical owner. Returns null when the mutation may proceed, else the
  // flag reason. An explicit non-empty entry OwnerKey is authoritative:
  // OwnershipClear decides and a known board/entry mismatch fails. Otherwise
  // the history-aware MutationOwnerKey must resolve to exactly one owner:
  // removed links count as evidence, while missing boards, blank board owners
  // and conflicting owners are unknown and fail closed. There is no weaker
  // unknown-owner repair path; fixtures must carry ownership instead.
  public static string? RepairBlockReason(InMemoryStore s, Domain.BoardAdvisor adv, Domain.RosterEntry? rent, Guid rosterId)
  {
    if (rent is not null && !string.IsNullOrWhiteSpace(rent.OwnerKey))
    {
      if (RosterReconcileApply.OwnershipClear(s, adv, rent)) return null;
      return "owner-mismatch";
    }
    if (MutationOwnerKey(s, rosterId) is not null) return null;
    return "owner-mismatch-or-ambiguous";
  }
  // Single read/visibility predicate shared by every roster route (list,
  // count, direct read, chat, write): explicit ownership or the same strict
  // history-aware rule (unanimous removed-link ownership included), plus the
  // attached-board rule applied by callers. Same predicate everywhere.
  public static bool OwnerMatches(InMemoryStore s, Domain.RosterEntry entry, string me)
  {
    if (!string.IsNullOrWhiteSpace(entry.OwnerKey))
      return string.Equals(entry.OwnerKey.Trim(), (me ?? "").Trim(), StringComparison.OrdinalIgnoreCase);
    var strict = MutationOwnerKey(s, entry.Id);
    return strict is not null && string.Equals(strict, (me ?? "").Trim(), StringComparison.OrdinalIgnoreCase);
  }
  // Deterministic per-advisor identity for empty-link recovery: one stable id
  // per (board, advisor) pair, never grouped across advisors, idempotent
  // across runs and scopes.
  public static Guid StableEmptyLinkId(Guid boardId, Guid advisorId)
  {
    var bytes = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("roster-recover-empty:" + boardId.ToString("N") + ":" + advisorId.ToString("N")));
    var g = new byte[16];
    Array.Copy(bytes, g, 16);
    return new Guid(g);
  }

  public static Guid AccountForOwner(InMemoryStore s, string ownerKey)
  {
    try
    {
      var acct = s.Accounts.Values.FirstOrDefault(a => string.Equals(a.Email, ownerKey, StringComparison.OrdinalIgnoreCase));
      if (acct is not null) return acct.Id;
    }
    catch { }
    var bytes = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("roster-recover-account:" + (ownerKey ?? "").Trim().ToLowerInvariant()));
    var g = new byte[16];
    Array.Copy(bytes, g, 16);
    return new Guid(g);
  }

  public static string HonestRecoveryStub(string role, string provenance)
  {
    var r = (role ?? "").Trim();
    if (r.Length == 0) r = "Recovered advisor";
    return JsonSerializer.Serialize(new
    {
      recovered = true,
      role = r,
      provenance,
      note = "Reconstructed from preserved board-advisor links by authorized reconciliation. No credentials, employment, or dossier facts invented; owner must review and complete.",
    });
  }

  // BACKEND-PROFILE compat: blank-OwnerKey write allowance via strict rule.
  // Retained so pre-join callers (profile hotfix selftest) still compile;
  // canonical code uses OwnerMatches/MutationOwnerKey directly.
  public static bool CallerMatchesEffectiveOwner(InMemoryStore s, HttpRequest req, Domain.RosterEntry entry)
  {
    if (!string.IsNullOrWhiteSpace(entry.OwnerKey)) return false;
    Microsoft.AspNetCore.Http.HttpRequest r = req;
    string me = "";
    try { me = SimCEO.Api.PeopleOps.UserOf(s, r); } catch { return false; }
    return OwnerMatches(s, entry, me);
  }
}

