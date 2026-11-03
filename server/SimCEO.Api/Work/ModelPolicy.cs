using SimCEO.Api.Data;

namespace SimCEO.Api.Work;

// Model selection and price basis, from https://dev.meta.ai/docs/pricing-rate-limits.
// Contributor mode is ~10-20x cheaper (Spark input $0.10/M vs $1.25/M) BUT grants
// Meta permission to train on your content: prompts, files, context AND responses.
// The product spec prefers Standard for private board content, but the current
// default is Contributor (testing phase: ~10x cheaper; content is training-
// eligible). Any board can opt back to Standard in Settings. Contributor
// variants exist only for Spark 1.3/1.2; Wonder and Voice Transcribe are
// Standard-only.
public static class ModelPolicy
{
  public const string SparkStandard = "muse-spark-1.3";
  public const string SparkContributor = "muse-spark-1.3-contributor";
  public const string Wonder = "muse-wonder-1.0";
  public const string Voice = "muse-voice-transcribe-1.0";
  public const string Image = "muse-image-1.0";

  public sealed record Price(decimal InPerM, decimal OutPerM, decimal CachedPerM);

  public static readonly Price SparkStdPrice = new(1.25m, 4.25m, 0.15m);
  public static readonly Price SparkContributorPrice = new(0.10m, 0.20m, 0.002m);
  public static readonly Price WonderPrice = new(4.00m, 20.00m, 0.20m);
  public const decimal SearchPer1k = 2.50m;
  public const decimal ImagePerImage = 0.01m;
  public const decimal VoicePerHour = 0.18m;

  public static string SparkFor(InMemoryStore store, Guid? boardId)
  {
    // Standard data-use constrains effective model selection even when a global
    // contributor override is configured: a Standard board never trains, so the
    // accepted Standard snapshot governs. Contributor boards honor the override.
    if (boardId.HasValue && store.Boards.TryGetValue(boardId.Value, out var b)
        && string.Equals(LeadSetup.EffectiveDataUse(store, b), "standard", StringComparison.OrdinalIgnoreCase))
      return SparkStandard;
    var chatOverride = PolicyStore.ReadChatModel(store);
    if (!string.IsNullOrWhiteSpace(chatOverride)) return chatOverride;
    if (boardId.HasValue && store.Boards.TryGetValue(boardId.Value, out var b2)
        && string.Equals(LeadSetup.EffectiveDataUse(store, b2), "contributor", StringComparison.OrdinalIgnoreCase))
      return SparkContributor;
    return SparkStandard;
  }

  public static Price PriceFor(string model) => model switch
  {
    SparkContributor => SparkContributorPrice,
    Wonder => WonderPrice,
    _ => SparkStdPrice,
  };
}
