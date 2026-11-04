using System.Text.Json;

namespace SimCEO.Api.Work;

// Optional direct-chat transport. Older clients still receive the same JSON.
public sealed class AdvisorStreamResponse(HttpRequest request)
{
  public bool Enabled { get; } = request.Headers.Accept.ToString().Contains("text/event-stream", StringComparison.OrdinalIgnoreCase);
  private readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
  private bool pushed;

  private async Task Event(string kind, object value)
  {
    var response = request.HttpContext.Response;
    if (!response.HasStarted) {
      response.ContentType = "text/event-stream";
      response.Headers.CacheControl = "no-store";
      response.Headers["X-Accel-Buffering"] = "no";
    }
    await response.WriteAsync($"event: {kind}\ndata: {JsonSerializer.Serialize(value)}\n\n", request.HttpContext.RequestAborted);
    await response.Body.FlushAsync(request.HttpContext.RequestAborted);
  }

  public async Task Push(string text)
  {
    if (!Enabled || pushed && clock.ElapsedMilliseconds < 60) return;
    if (text.Length > 65536) throw new ProviderException(502, "Advisor response exceeded the streaming limit.");
    await Event("delta", new { text }); pushed = true; clock.Restart();
  }

  public async Task<IResult> Finish(IResult result)
  {
    if (!request.HttpContext.Response.HasStarted) return result;
    var status = (result as IStatusCodeHttpResult)?.StatusCode ?? 200;
    try {
      if (status is >= 200 and < 300) await Event("done", (result as IValueHttpResult)?.Value ?? new { });
      else await Event("error", new { status, error = "The advisor response was interrupted. Please retry." });
    }
    catch (Exception ex) when (ex is IOException or OperationCanceledException) { }
    return Results.Empty;
  }
}
