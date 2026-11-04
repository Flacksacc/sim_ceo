using System.Text;
using System.Text.Json;
using System.IO.Compression;
using System.Xml;
using System.Xml.Linq;
using UglyToad.PdfPig;
using UglyToad.PdfPig.DocumentLayoutAnalysis.TextExtractor;

namespace SimCEO.Api.Work;

// Bounded local extraction for text, selectable PDF and modern Office files.
// Other formats use Docling only when EXTRACTOR_URL is explicitly configured.
// Every outcome is recorded; binary bytes never stand in for readable text.
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
      try { return CheckedText(new UTF8Encoding(false, true).GetString(bytes)); }
      catch (DecoderFallbackException) { return new Result("failed", null, "not valid UTF-8 text"); }
    }
    var extension = Path.GetExtension(fileName).ToLowerInvariant();
    try
    {
      if (extension == ".pdf")
      {
        using var pdf = PdfDocument.Open(bytes);
        if (pdf.NumberOfPages > 500) return new Result("failed", null, "PDF exceeds 500 pages.");
        var text = new StringBuilder();
        foreach (var page in pdf.GetPages())
        {
          ct.ThrowIfCancellationRequested();
          text.AppendLine(ContentOrderTextExtractor.GetText(page));
          if (text.Length > MaxTextChars) return TooLarge();
        }
        return CheckedText(text.ToString());
      }
      if (extension is ".docx" or ".pptx" or ".xlsx") return ExtractOffice(bytes, extension);
    }
    catch (OperationCanceledException) { throw; }
    catch (Exception) { return new Result("failed", null, "The document could not be read. Try exporting it as PDF or text."); }
    // A demo installation does not run Docling. Fail promptly rather than
    // waiting three minutes for an absent service or indexing binary bytes.
    if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("EXTRACTOR_URL")))
      return new Result("failed", null, "Unsupported format. Use TXT, Markdown, CSV, JSON, PDF, DOCX, PPTX or XLSX.");
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

  private const int MaxTextChars = 2_000_000;
  private static Result TooLarge() => new("failed", null, "Extracted document exceeds two million characters.");
  private static Result CheckedText(string text) => text.Length > MaxTextChars ? TooLarge()
    : string.IsNullOrWhiteSpace(text) ? new("failed", null, "No readable text found. Scanned documents need OCR before uploading.")
    : new("ok", text, null);

  private static Result ExtractOffice(byte[] bytes, string extension)
  {
    using var zip = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read);
    if (zip.Entries.Count > 10000) return TooLarge();
    long expanded = 0;
    XDocument Read(ZipArchiveEntry entry)
    {
      expanded += entry.Length;
      if (entry.Length > 20_000_000 || expanded > 40_000_000) throw new InvalidDataException();
      using var stream = entry.Open();
      using var reader = XmlReader.Create(stream, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 20_000_000 });
      return XDocument.Load(reader);
    }
    var text = new StringBuilder();
    var shared = new List<string>();
    if (extension == ".xlsx" && zip.GetEntry("xl/sharedStrings.xml") is { } strings)
      shared = Read(strings).Descendants().Where(x => x.Name.LocalName == "si")
        .Select(x => string.Concat(x.Descendants().Where(t => t.Name.LocalName == "t").Select(t => t.Value))).ToList();
    foreach (var entry in zip.Entries.OrderBy(e => e.FullName, StringComparer.Ordinal))
    {
      var path = entry.FullName;
      if (extension == ".docx" && path != "word/document.xml") continue;
      if (extension == ".pptx" && !(path.StartsWith("ppt/slides/slide", StringComparison.Ordinal) && path.EndsWith(".xml", StringComparison.Ordinal))) continue;
      if (extension == ".xlsx" && !(path.StartsWith("xl/worksheets/sheet", StringComparison.Ordinal) && path.EndsWith(".xml", StringComparison.Ordinal))) continue;
      var xml = Read(entry);
      if (extension == ".xlsx")
      {
        foreach (var row in xml.Descendants().Where(x => x.Name.LocalName == "row"))
        {
          var cells = row.Elements().Where(x => x.Name.LocalName == "c").Select(c => {
            var value = c.Elements().FirstOrDefault(x => x.Name.LocalName == "v")?.Value ?? "";
            if ((string?)c.Attribute("t") == "s" && int.TryParse(value, out var i) && i >= 0 && i < shared.Count) return shared[i];
            if ((string?)c.Attribute("t") == "inlineStr") return string.Concat(c.Descendants().Where(x => x.Name.LocalName == "t").Select(x => x.Value));
            return value;
          });
          text.AppendLine(string.Join("\t", cells));
          if (text.Length > MaxTextChars) return TooLarge();
        }
      }
      else foreach (var paragraph in xml.Descendants().Where(x => x.Name.LocalName == "p"))
      {
        text.AppendLine(string.Concat(paragraph.Descendants().Where(x => x.Name.LocalName == "t").Select(x => x.Value)));
        if (text.Length > MaxTextChars) return TooLarge();
      }
    }
    return CheckedText(text.ToString());
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
