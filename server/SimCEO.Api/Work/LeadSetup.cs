using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// Board-lead profile ("Your Profile") and setup draft/activate rules.
// Lead saves are explicit and versioned; a save based on an older version
// is rejected so the owner refreshes instead of silently overwriting.
// Setup activation requires a name, a saved lead profile, and at least one
// approved advisor; only the exact reviewed draft hash activates.
public static class LeadSetup
{
  public static LeadProfile? ResolveLead(InMemoryStore s) =>
    s.LeadProfiles.Values.OrderByDescending(l => l.UpdatedAt).FirstOrDefault();

  public static (LeadProfile? saved, string? error, int status) SaveLead(
    InMemoryStore s, Guid boardId, LeadProfile input)
  {
    Board? board = null;
    if (boardId != Guid.Empty && !s.Boards.TryGetValue(boardId, out board))
      return (null, "board not found", 404);
    if (string.IsNullOrWhiteSpace(input.Name))
      return (null, "Lead name is required.", 400);
    lock (s.SetupLock)
    {
      var currentVersion = s.LeadProfiles.Values
        .Where(l => l.BoardId == boardId)
        .Select(l => (int?)l.Version).Max() ?? 0;
      if (currentVersion != 0 && input.Version != currentVersion)
        return (null, "Stale lead profile; refresh and re-apply your edit.", 409);
      var saved = new LeadProfile
      {
        Id = Guid.NewGuid(),
        BoardId = boardId,
        Version = currentVersion + 1,
        Name = input.Name.Trim(),
        RoleLabel = string.IsNullOrWhiteSpace(input.RoleLabel) ? "Board Lead" : input.RoleLabel.Trim(),
        Background = input.Background,
        FamiliarTopics = input.FamiliarTopics,
        SimplerTopics = input.SimplerTopics,
        CommPrefs = input.CommPrefs,
        UpdatedAt = DateTime.UtcNow,
      };
      s.LeadProfiles[saved.Id] = saved;
    saved.ProvenanceJson = JsonSerializer.Serialize(new Dictionary<string, object> { ["name"] = new { source = "owner", at = saved.UpdatedAt }, ["roleLabel"] = new { source = "owner", at = saved.UpdatedAt }, ["background"] = new { source = "owner", at = saved.UpdatedAt }, ["familiarTopics"] = new { source = "owner", at = saved.UpdatedAt }, ["simplerTopics"] = new { source = "owner", at = saved.UpdatedAt }, ["commPrefs"] = new { source = "owner", at = saved.UpdatedAt } });
      if (board is not null) board.LeadProfileVersion = saved.Version;
      s.Audit.Add(new AuditEvent
      {
        BoardId = boardId, Action = "lead.save",
        Detail = JsonSerializer.Serialize(new { version = saved.Version }),
      });
      return (saved, null, 200);
    }
  }

  public static (Board? board, string? error, int status) Activate(
    InMemoryStore s, Guid boardId, string? expectedHash)
  {
    if (!s.Boards.TryGetValue(boardId, out var board))
      return (null, "board not found", 404);
    lock (s.SetupLock)
    {
      if (string.IsNullOrWhiteSpace(board.Name))
        return (null, "Board name is required before activation.", 409);
      var hasLead = ResolveLead(s) is not null;
      if (!hasLead)
        return (null, "Reviewed board-lead profile is required before activation.", 409);
      var approved = s.Advisors.Values.Count(a => a.BoardId == boardId && !a.Removed && a.Approved);
      if (approved < 1)
        return (null, "At least one approved advisor is required before activation.", 409);
      if (expectedHash is not null &&
          !string.Equals(Hashing.HashOf(board.DraftJson), expectedHash, StringComparison.OrdinalIgnoreCase))
        return (null, "Setup draft changed; refresh review.", 409);
      board.ActiveJson = board.DraftJson;
      board.ActiveConfig = true;
      s.Audit.Add(new AuditEvent
      {
        BoardId = boardId, Action = "setup.activate",
        Detail = JsonSerializer.Serialize(new { leadVersion = board.LeadProfileVersion, approved }),
      });
      return (board, null, 200);
    }
  }
}
