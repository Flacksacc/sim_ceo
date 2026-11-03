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
      var storedKey = PolicyStore.ReadApiKey(s);
      var storedChat = PolicyStore.ReadChatModel(s);
      var key = !string.IsNullOrWhiteSpace(storedKey)
        ? storedKey
        : Environment.GetEnvironmentVariable("META_API_KEY") ?? string.Empty;
      var model = !string.IsNullOrWhiteSpace(storedChat) ? storedChat : ModelPolicy.SparkStandard;
      return Results.Ok(new
      {
        configured = !string.IsNullOrWhiteSpace(key),
        source = !string.IsNullOrWhiteSpace(storedKey) ? "settings" : (!string.IsNullOrWhiteSpace(key) ? "env" : "none"),
        model,
        chatOverride = storedChat,
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
      // Parse + type-validate the FULL payload first: no partial mutation on
      // bad input, and unknown wording fails honestly instead of silently
      // keeping old values.
      string? newKey = null; var keyPresent = false;
      string? newChat = null; var chatPresent = false;
      if (body.TryGetProperty("apiKey", out var k))
      {
        if (k.ValueKind != JsonValueKind.String) return Results.BadRequest("apiKey must be a string.");
        keyPresent = true; newKey = (k.GetString() ?? string.Empty).Trim();
      }
      if (body.TryGetProperty("chatModel", out var cm))
      {
        if (cm.ValueKind != JsonValueKind.String) return Results.BadRequest("chatModel must be a string.");
        chatPresent = true; newChat = (cm.GetString() ?? string.Empty).Trim();
        if (newChat.Length > 0 && !allowed.Contains(newChat)) return Results.BadRequest("Unknown chat model.");
      }
      IResult? setGuardErr = null;
      Atomic.Run(s, () =>
      {
        // Fresh authority INSIDE the mutation unit (not just the outer check).
        if (PeopleOps.IsSecure(s))
        {
          if (!AuthOps.TrySession(s, req, out var ssIn)) { setGuardErr = Results.Json(new { error = "Authentication required." }, statusCode: 401); return; }
          var admIn = PeopleOps.AdminEmail(s);
          if (string.IsNullOrWhiteSpace(admIn) || !string.Equals(admIn, ssIn, StringComparison.OrdinalIgnoreCase)) { setGuardErr = Results.Json(new { error = "Only the installation admin can change model settings." }, statusCode: 403); return; }
        }
        else if (!PeopleOps.IsOwner(req)) { setGuardErr = Results.Json(new { error = "Only the owner can change model settings." }, statusCode: 403); return; }
        var effKey = keyPresent ? newKey! : PolicyStore.ReadApiKey(s);
        var effChat = chatPresent ? newChat! : PolicyStore.ReadChatModel(s);
        PolicyStore.WriteConnection(s, effKey, effChat);
        if (keyPresent) Atomic.Audit(s, new AuditEvent { Action = "model.key-set", Detail = "override " + (string.IsNullOrWhiteSpace(effKey) ? "cleared" : "updated") });
        if (chatPresent) Atomic.Audit(s, new AuditEvent { Action = "model.chat-set", Detail = string.IsNullOrWhiteSpace(effChat) ? "default" : effChat });
      });
      if (setGuardErr is not null) return setGuardErr;
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
      var chatNow = PolicyStore.ReadChatModel(s);
      var model = !string.IsNullOrWhiteSpace(chatNow) ? chatNow : ModelPolicy.SparkStandard;
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
        Atomic.Audit(s, new AuditEvent { Action = "model.test", Detail = "fail: " + model + " (" + kind + ")" });
        // No client secret is ever returned; an unconfigured provider is 503
        // (unavailable), not a silent 200-false.
        if (ex is ProviderNotConfiguredException)
          return Results.Json(new { ok = false, model, error = err }, statusCode: 503);
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
      Atomic.Audit(s, new AuditEvent { Action = "model.test", Detail = "ok: " + model });
      return Results.Ok(new { ok = true, model, latencyMs = sw.ElapsedMilliseconds });
    });
  }
}
