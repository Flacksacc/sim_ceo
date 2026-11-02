using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using System.Text.RegularExpressions;

namespace SimCEO.Api.Work;

// Discussion policies from the overview: Focused (3,2; max 5),
// Balanced (4,4,2; max 10), Open (groups of <=4 to a board-lead max of 10).
public static class DiscussionPolicy
{
  public static int[] Groups(string policy) => policy switch
  {
    "focused" => new[] { 3, 2 },
    "balanced" => new[] { 4, 4, 2 },
    "open" => new[] { 4, 4, 4 },
    _ => new[] { 4, 4, 2 },
  };

  public static int MaxReplies(string policy) => policy switch
  {
    "focused" => 5,
    _ => 10,
  };

  // Deterministic round selection: eligible advisors bid, top group sizes win.
  // Bids run against the same delivered snapshot; later groups see prior groups.
  public static List<List<BoardAdvisor>> SelectRounds(
    string policy, IReadOnlyList<BoardAdvisor> eligible,
    Func<BoardAdvisor, double> bidScore)
  {
    var ranked = eligible.OrderByDescending(bidScore).ToList();
    var rounds = new List<List<BoardAdvisor>>();
    var idx = 0;
    foreach (var size in Groups(policy))
    {
      if (idx >= ranked.Count) break;
      if (rounds.SelectMany(r => r).Count() >= MaxReplies(policy)) break;
      var take = Math.Min(size, ranked.Count - idx);
      take = Math.Min(take, MaxReplies(policy) - rounds.SelectMany(r => r).Count());
      rounds.Add(ranked.Skip(idx).Take(take).ToList());
      idx += take;
    }
    return rounds;
  }

  // Explicit alignment/challenge pass: assigned only when material,
  // evidence-supported challenge exists. Never manufactured.
  public static BoardAdvisor? AssignChallenge(
    IReadOnlyList<BoardAdvisor> selected, bool evidenceSupported,
    Func<BoardAdvisor, double> challengeSkill)
  {
    if (!evidenceSupported || selected.Count == 0) return null;
    return selected.OrderByDescending(challengeSkill).First();
  }
}

// Context Curator budgets: 2,000-token bid packet, 8,000-token draft packet,
// measured expansion to 12,000 with logged reason. Never full transcripts.
public static class ContextBudget
{
  public const int BidTokens = 2000;
  public const int DraftTokens = 8000;
  public const int MaxTokens = 12000;

  public static (int tokens, string? expansionReason) DraftPacket(
    int baseTokens, bool needsMore, string? reason)
  {
    if (!needsMore) return (Math.Min(baseTokens, DraftTokens), null);
    if (string.IsNullOrWhiteSpace(reason)) return (DraftTokens, "expansion denied: no reason logged");
    return (Math.Min(baseTokens, MaxTokens), reason);
  }
}

// Reply threading + stance summaries. Stance tags are parsed from model text
// and stored as a summary only: never inferred, never a vote or decision.
public static class MessageTags
{
  private static readonly Regex StanceRx = new(@"\[(stance|tag):\s*([^\]]+)\]", RegexOptions.IgnoreCase | RegexOptions.Compiled);

  public static string CanonicalStance(string? raw)
  {
    var v = (raw ?? "").Trim().ToLowerInvariant();
    if (v.StartsWith("disagree")) return "Disagrees";
    if (v.StartsWith("agree")) return "Agrees";
    if (v.Contains("risk")) return "Raises risk";
    if (v.Contains("alternative") || v.Contains("propos")) return "Proposes alternative";
    if (v.Contains("support")) return "Supports";
    if (v.Contains("prefer")) return "Prefers alternative";
    return "";
  }

  public static (string clean, string stance) SplitStance(string? content)
  {
    var m = StanceRx.Match(content ?? "");
    if (!m.Success) return ((content ?? "").Trim(), "");
    var stance = CanonicalStance(m.Groups[2].Value);
    return (StanceRx.Replace(content ?? "", "").Trim(), stance);
  }
}

// Owner-interruption detector for discussion runs. A run is interrupted only
// by NEW lead-authored messages (Sequence > floor); the run's own advisor
// publishes never count, so multi-round runs no longer self-interrupt.
public static class MeetingTurns
{
  public static long LeadSeqAfter(InMemoryStore s, Guid meetingId, long floor)
  {
    lock (s.MessageLock)
    {
      if (!s.Messages.TryGetValue(meetingId, out var list) || list is null) return floor;
      var top = floor;
      foreach (var x in list)
        if (x.Sequence > top && string.Equals(x.Sender, "lead", StringComparison.OrdinalIgnoreCase))
          top = x.Sequence;
      return top;
    }
  }
}
