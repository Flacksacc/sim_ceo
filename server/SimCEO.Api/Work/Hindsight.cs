using System.Text.Json;

namespace SimCEO.Api.Work;

// Optional Hindsight recall adapter (HINDSIGHT_URL, compose `hindsight`
// service). When unset or unreachable the board falls back to local
// keyword recall; remote hits are merged by score and tagged so the UI
// can show provenance. The response shape is parsed tolerantly: either
// a bare JSON array or {"results": [...]}, with case-insensitive
// kind/ref/text/score fields.
public static class Hindsight
{
  private static readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(3) };

  public static string Base =>
    Environment.GetEnvironmentVariable("HINDSIGHT_URL") is { Length: > 0 } b
      ? b.Trim().TrimEnd('/') : "";

  public static bool Configured => Base.Length > 0;

  public static async Task<List<ContextCurator.RecallHit>> SearchAsync(
    Guid boardId, string query, int take, CancellationToken ct = default)
  {
    var hits = new List<ContextCurator.RecallHit>();
    if (!Configured) return hits;
    try
    {
      var url = $"{Base}/search?q={Uri.EscapeDataString(query)}&take={Math.Clamp(take, 1, 20)}&boardId={boardId:N}";
      using var res = await _http.GetAsync(url, ct);
      if (!res.IsSuccessStatusCode) return hits;
      using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
      var root = doc.RootElement;
      if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("results", out var rs))
        root = rs;
      if (root.ValueKind != JsonValueKind.Array) return hits;
      foreach (var item in root.EnumerateArray())
      {
        if (item.ValueKind != JsonValueKind.Object) continue;
        string? Get(params string[] names)
        {
          foreach (var n in names)
            foreach (var p in item.EnumerateObject())
              if (string.Equals(p.Name, n, StringComparison.OrdinalIgnoreCase)
                  && p.Value.ValueKind == JsonValueKind.String)
                return p.Value.GetString();
          return null;
        }
        var text = Get("text", "content", "snippet");
        if (string.IsNullOrWhiteSpace(text)) continue;
        var score = 0;
        foreach (var p in item.EnumerateObject())
          if (string.Equals(p.Name, "score", StringComparison.OrdinalIgnoreCase)
              && p.Value.ValueKind == JsonValueKind.Number
              && p.Value.TryGetInt32(out var sc))
            score = sc;
        hits.Add(new ContextCurator.RecallHit(
          "hindsight:" + (Get("kind", "type") ?? "note"),
          Get("ref", "id", "title") ?? "",
          text.Length > 600 ? text[..600] + "…" : text,
          score));
      }
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
    {
      // Fall through to local-only recall.
    }
    return hits;
  }
}
