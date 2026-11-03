using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

namespace SimCEO.Api;

// Owner-managed Muse model connection. The API key override lives in the
// backend store only: it is seeded from META_API_KEY, can be replaced at
// runtime via PUT, and is never returned to the browser (status exposes a
// masked hint). Changing settings resets the last connection test.
public static class ModelSettingsEndpoints
{
  public static void MapModelSettings(this WebApplication app)
  {
    app.MapGet("/api/model/status", (InMemoryStore s) =>
    {
      var key = !string.IsNullOrWhiteSpace(s.ModelApiKeyOverride)
        ? s.ModelApiKeyOverride
        : Environment.GetEnvironmentVariable("META_API_KEY") ?? string.Empty;
      var model = !string.IsNullOrWhiteSpace(s.ModelChatOverride) ? s.ModelChatOverride : ModelPolicy.SparkStandard;
      return Results.Ok(new
      {
        configured = !string.IsNullOrWhiteSpace(key),
        source = !string.IsNullOrWhiteSpace(s.ModelApiKeyOverride) ? "settings" : (!string.IsNullOrWhiteSpace(key) ? "env" : "none"),
        model,
        chatOverride = s.ModelChatOverride,
        keyHint = string.IsNullOrWhiteSpace(key) ? "" : (key.Length <= 4 ? "set" : string.Concat("...", key.Substring(key.Length - 4))),
        lastTestAt = s.ModelLastTestAt,
        lastTestOk = s.ModelLastTestOk,
        lastTestModel = s.ModelLastTestModel,
        lastTestError = s.ModelLastTestError,
      });
    });

    app.MapPut("/api/model/settings", (InMemoryStore s, HttpRequest req, JsonElement body) =>
    {
      if (!PeopleOps.IsOwner(req))
        return Results.Json(new { error = "Only the owner can change model settings." }, statusCode: 403);
      var allowed = new[] { ModelPolicy.SparkStandard, ModelPolicy.SparkContributor, ModelPolicy.Wonder };
      lock (s.ModelLock)
      {
        if (body.TryGetProperty("apiKey", out var k) && k.ValueKind == JsonValueKind.String)
        {
          s.ModelApiKeyOverride = (k.GetString() ?? string.Empty).Trim();
          s.Audit.Add(new AuditEvent { Action = "model.key-set", Detail = "override " + (string.IsNullOrWhiteSpace(s.ModelApiKeyOverride) ? "cleared" : "updated") });
        }
        if (body.TryGetProperty("chatModel", out var m) && m.ValueKind == JsonValueKind.String)
        {
          var v = (m.GetString() ?? string.Empty).Trim();
          if (v.Length > 0 && !allowed.Contains(v)) return Results.BadRequest("Unknown chat model.");
          s.ModelChatOverride = v;
          s.Audit.Add(new AuditEvent { Action = "model.chat-set", Detail = string.IsNullOrWhiteSpace(v) ? "default" : v });
        }
        s.ModelLastTestAt = null;
        s.ModelLastTestOk = false;
        s.ModelLastTestError = string.Empty;
      }
      return Results.Ok(new { ok = true });
    });

    app.MapPost("/api/model/test", async (InMemoryStore s, HttpRequest req, CancellationToken ct) =>
    {
      if (!PeopleOps.IsOwner(req))
        return Results.Json(new { error = "Only the owner can test the model connection." }, statusCode: 403);
      var gw = new ModelGateway(s);
      var model = !string.IsNullOrWhiteSpace(s.ModelChatOverride) ? s.ModelChatOverride : ModelPolicy.SparkStandard;
      var sw = System.Diagnostics.Stopwatch.StartNew();
      try
      {
        await gw.CompleteAsync(model, "model-test", "Reply with exactly: OK", 100, 512, ct, ownerOverride: true);
      }
      catch (Exception ex)
      {
        sw.Stop();
        var kind = ex is OperationCanceledException ? "cancelled"
          : ex is ProviderException pex ? "provider HTTP " + pex.Status
          : ex is ProviderNotConfiguredException ? "not configured"
          : ex is CapExceededException ? "capped"
          : "transport failure";
        var err = "model test failed: " + kind + "; see usage ledger for billing; no upstream content retained";
        lock (s.ModelLock)
        {
          s.ModelLastTestAt = DateTime.UtcNow;
          s.ModelLastTestOk = false;
          s.ModelLastTestError = err;
          s.ModelLastTestModel = model;
        }
        s.Audit.Add(new AuditEvent { Action = "model.test", Detail = "fail: " + model + " (" + kind + ")" });
        return Results.Ok(new { ok = false, model, error = err });
      }
      sw.Stop();
      lock (s.ModelLock)
      {
        s.ModelLastTestAt = DateTime.UtcNow;
        s.ModelLastTestOk = true;
        s.ModelLastTestError = string.Empty;
        s.ModelLastTestModel = model;
      }
      s.Audit.Add(new AuditEvent { Action = "model.test", Detail = "ok: " + model });
      return Results.Ok(new { ok = true, model, latencyMs = sw.ElapsedMilliseconds });
    });
  }
}
