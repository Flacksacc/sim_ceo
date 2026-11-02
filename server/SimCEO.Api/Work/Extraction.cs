using System.Text;
using System.Text.Json;

namespace SimCEO.Api.Work;

// Document extraction via Docling Serve (EXTRACTOR_URL, compose `extractor`
// service). Plain text/Markdown uploads are read directly; anything else
// goes to Docling's /v1/convert/file. Every outcome — ok, unsupported,
// failed, unreachable — is recorded on the source so retries and the UI
// report status instead of silence.
public static class Extraction
{
  private static readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(180) };

  public sealed record Result(string Status, string? Markdown, string? Error);

  public static string Base =>
    Environment.GetEnvironmentVariable("EXTRACTOR_URL") is { Length: > 0 } b
      ? b.Trim().TrimEnd('/') : "http://extractor:5001";

  public static bool IsTextual(string fileName)
  {
    var ext = Path.GetExtension(fileName).TrimStart('.').ToLowerInvariant();
    return ext is "txt" or "md" or "markdown" or "csv" or "json";
  }

  public static async Task<Result> ExtractAsync(byte[] bytes, string fileName, CancellationToken ct = default)
  {
    if (IsTextual(fileName))
    {
      try { return new Result("ok", System.Text.Encoding.UTF8.GetString(bytes), null); }
      catch (DecoderFallbackException) { return new Result("failed", null, "not valid UTF-8 text"); }
    }
    try
    {
      using var form = new MultipartFormDataContent();
      var content = new ByteArrayContent(bytes);
      content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/octet-stream");
      form.Add(content, "files", fileName); // docling-serve takes `files: List[UploadFile]`
      form.Add(new StringContent("markdown"), "output_format");
      using var res = await _http.PostAsync($"{Base}/v1/convert/file", form, ct);
      var text = await res.Content.ReadAsStringAsync(ct);
      if (!res.IsSuccessStatusCode)
        return new Result("failed", null, $"extractor {(int)res.StatusCode}: {text[..Math.Min(200, text.Length)]}");
      var md = FindMarkdown(JsonDocument.Parse(text).RootElement);
      return string.IsNullOrWhiteSpace(md)
        ? new Result("failed", null, "extractor returned no markdown")
        : new Result("ok", md, null);
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
    {
      return new Result("unreachable", null, $"extractor unreachable: {ex.Message}");
    }
  }

  private static string? FindMarkdown(JsonElement el)
  {
    if (el.ValueKind == JsonValueKind.Object)
    {
      foreach (var prop in el.EnumerateObject())
      {
        if ((prop.NameEquals("md_content") || prop.NameEquals("markdown") || prop.NameEquals("text"))
            && prop.Value.ValueKind == JsonValueKind.String
            && !string.IsNullOrWhiteSpace(prop.Value.GetString()))
          return prop.Value.GetString();
        var inner = FindMarkdown(prop.Value);
        if (inner is not null) return inner;
      }
    }
    else if (el.ValueKind == JsonValueKind.Array)
    {
      foreach (var item in el.EnumerateArray())
      {
        var inner = FindMarkdown(item);
        if (inner is not null) return inner;
      }
    }
    return null;
  }

  public static string ToJson(Result r) =>
    JsonSerializer.Serialize(new { status = r.Status, markdown = r.Markdown, error = r.Error, at = DateTime.UtcNow });

  public static string? MarkdownOf(string extractionJson)
  {
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(extractionJson) ? "{}" : extractionJson);
      if (doc.RootElement.TryGetProperty("status", out var st) && st.GetString() == "ok"
          && doc.RootElement.TryGetProperty("markdown", out var md))
        return md.GetString();
    }
    catch (JsonException) { }
    return null;
  }
}
