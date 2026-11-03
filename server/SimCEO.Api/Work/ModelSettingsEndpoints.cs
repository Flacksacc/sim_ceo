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
    app.MapGet("/api/model/status", (InMemoryStore s, HttpRequest req) =>
    {
      if (PeopleOps.IsSecure(s))
      {
        if (PeopleOps.BadToken(s, req) is { } badMs) return badMs;
        if (!AuthOps.TrySession(s, req, out var ms)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        var admMs = PeopleOps.AdminEmail(s);
        var isAdmMs = !string.IsNullOrWhiteSpace(admMs) && string.Equals(admMs, ms, StringComparison.OrdinalIgnoreCase);
        if (!isAdmMs) return PeopleOps.Denied();
      }
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
      if (PeopleOps.BadToken(s, req) is { } badSet) return badSet;
      if (PeopleOps.IsSecure(s))
      {
        if (!AuthOps.TrySession(s, req, out var ss)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        var admSs = PeopleOps.AdminEmail(s);
        if (string.IsNullOrWhiteSpace(admSs) || !string.Equals(admSs, ss, StringComparison.OrdinalIgnoreCase))
          return Results.Json(new { error = "Only the installation admin can change model settings." }, statusCode: 403);
      }
      else if (!PeopleOps.IsOwner(req))
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
      if (PeopleOps.BadToken(s, req) is { } badTest) return badTest;
      if (PeopleOps.IsSecure(s))
      {
        if (!AuthOps.TrySession(s, req, out var ts)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        var admTs = PeopleOps.AdminEmail(s);
        if (string.IsNullOrWhiteSpace(admTs) || !string.Equals(admTs, ts, StringComparison.OrdinalIgnoreCase))
          return Results.Json(new { error = "Only the installation admin can test the model connection." }, statusCode: 403);
      }
      else if (!PeopleOps.IsOwner(req))
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
        var err = ex.Message.Length > 300 ? ex.Message[..300] : ex.Message;
        lock (s.ModelLock)
        {
          s.ModelLastTestAt = DateTime.UtcNow;
          s.ModelLastTestOk = false;
          s.ModelLastTestError = err;
          s.ModelLastTestModel = model;
        }
        s.Audit.Add(new AuditEvent { Action = "model.test", Detail = "fail: " + model });
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
