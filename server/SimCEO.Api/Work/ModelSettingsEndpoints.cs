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
      string storedChat;
      try { storedChat = PolicyStore.ReadChatModel(s); }
      catch (SimCEO.Api.Data.PolicyUnavailableException) { return Results.Json(new { error = "Installation policy store unavailable." }, statusCode: 503); }
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
      if (body.ValueKind != JsonValueKind.Object) return Results.BadRequest("body must be a JSON object.");
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
      try { Atomic.Run(s, () =>
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
      }); }
      catch (SimCEO.Api.Data.PolicyUnavailableException) { return Results.Json(new { error = "Installation policy store unavailable." }, statusCode: 503); }
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
      string keyBefore, chatBefore; (Guid epochId, long epochRev) testPin;
      try
      {
        // Authoritative connection capture INSIDE one root boundary BEFORE the
        // dispatch: the restore pin and the effective key/model describe the
        // same instant. The bound key below dispatches EXACTLY this key, so an
        // A->B-before-header->A sequence cannot claim A tested when B was used.
        // Key material is request-scoped here, never logged or serialized.
        lock (s.RootGate)
        {
          testPin = SimCEO.Api.Work.PublicationGuard.Capture(s);
          var ov = PolicyStore.ReadApiKey(s);
          keyBefore = !string.IsNullOrWhiteSpace(ov) ? ov : Environment.GetEnvironmentVariable("META_API_KEY") ?? string.Empty;
          chatBefore = PolicyStore.ReadChatModel(s);
        }
      }
      catch (SimCEO.Api.Data.PolicyUnavailableException) { return Results.Json(new { error = "Installation policy store unavailable." }, statusCode: 503); }
      var model = !string.IsNullOrWhiteSpace(chatBefore) ? chatBefore : ModelPolicy.SparkStandard;
      var gw = new ModelGateway(s);
      var sw = System.Diagnostics.Stopwatch.StartNew();
      Exception? callEx = null;
      // Bound dispatch: the header carries exactly keyBefore, not a re-resolved key.
      try { await gw.CompleteAsync(model, "model-test", "Reply with exactly: OK", 100, 512, ct, ownerOverride: true, boundKey: keyBefore); }
      catch (Exception cex) { callEx = cex; }
      sw.Stop();
      var callKind = callEx is null ? "ok"
        : callEx is OperationCanceledException ? "cancelled"
        : callEx is ProviderException cpex ? "provider HTTP " + cpex.Status
        : callEx is ProviderNotConfiguredException ? "not configured"
        : callEx is CapExceededException ? "capped"
        : "transport failure";
      IResult? testGuardErr = null;
      IResult? testOutcome = null;
      try
      {
        Atomic.Run(s, () =>
        {
          if (PeopleOps.IsSecure(s))
          {
            if (!AuthOps.TrySession(s, req, out var tsIn)) { testGuardErr = Results.Json(new { error = "Authentication required." }, statusCode: 401); return; }
            var admIn = PeopleOps.AdminEmail(s);
            if (string.IsNullOrWhiteSpace(admIn) || !string.Equals(admIn, tsIn, StringComparison.OrdinalIgnoreCase)) { testGuardErr = Results.Json(new { error = "Only the installation admin can test the model connection." }, statusCode: 403); return; }
          }
          else if (!PeopleOps.IsOwner(req)) { testGuardErr = PeopleOps.Denied(); return; }
          // Restore epoch is checked INSIDE the publication unit: a restore
          // during the test discards the stale result instead of publishing it
          // under the new epoch (actual dispatched attempts keep their billing
          // pair in the usage ledger regardless).
          if (s.RestoreEpochId != testPin.epochId || s.RestoreEpochRev != testPin.epochRev)
          {
            testGuardErr = Results.Conflict("Domain was restored during the test; the stale result was discarded, not published.");
            return;
          }
          string keyNow, chatNow;
          try
          {
            var ov2 = PolicyStore.ReadApiKey(s);
            keyNow = !string.IsNullOrWhiteSpace(ov2) ? ov2 : Environment.GetEnvironmentVariable("META_API_KEY") ?? string.Empty;
            chatNow = PolicyStore.ReadChatModel(s);
          }
          catch (SimCEO.Api.Data.PolicyUnavailableException) { testGuardErr = Results.Json(new { error = "Installation policy store unavailable." }, statusCode: 503); return; }
          if (!string.Equals(keyNow, keyBefore, StringComparison.Ordinal) || !string.Equals(chatNow, chatBefore, StringComparison.Ordinal))
          {
            testGuardErr = Results.Conflict("Model settings changed during the test; the stale result was discarded, not published.");
            return;
          }
          if (callEx is null)
          {
            lock (s.ModelLock)
            {
              s.ModelLastTestAt = DateTime.UtcNow;
              s.ModelLastTestOk = true;
              s.ModelLastTestError = string.Empty;
              s.ModelLastTestModel = model;
            }
            Atomic.Audit(s, new AuditEvent { Action = "model.test", Detail = "ok: " + model });
            testOutcome = Results.Ok(new { ok = true, model, latencyMs = sw.ElapsedMilliseconds });
          }
          else
          {
            var err = "model test failed: " + callKind + "; see usage ledger for billing; no upstream content retained";
            lock (s.ModelLock)
            {
              s.ModelLastTestAt = DateTime.UtcNow;
              s.ModelLastTestOk = false;
              s.ModelLastTestError = err;
              s.ModelLastTestModel = model;
            }
            Atomic.Audit(s, new AuditEvent { Action = "model.test", Detail = "fail: " + model + " (" + callKind + ")" });
            if (callEx is ProviderNotConfiguredException)
              testOutcome = Results.Json(new { ok = false, model, error = err }, statusCode: 503);
            else
              testOutcome = Results.Ok(new { ok = false, model, error = err });
          }
        });
      }
      catch (SimCEO.Api.Data.PolicyUnavailableException) { return Results.Json(new { error = "Installation policy store unavailable." }, statusCode: 503); }
      catch (SimCEO.Api.Data.CommitUnknownException cux) { return Results.Json(new { error = "Model test outcome is unknown (the commit may have succeeded); re-read the status before retrying: " + cux.Message }, statusCode: 500); }
      catch (SimCEO.Api.Data.PostCommitException pcx) { return Results.Json(new { error = "Model test committed, but a post-commit effect failed: " + pcx.Message }, statusCode: 500); }
      catch (AggregateException agx) { return Results.Json(new { error = "Model test failed and rollback is uncertain: " + agx.Message }, statusCode: 500); }
      catch (Exception tex) { return Results.Json(new { error = "Model test status not recorded: " + tex.Message }, statusCode: 500); }
      if (testGuardErr is not null) return testGuardErr;
      return testOutcome!;
    });
  }
}
