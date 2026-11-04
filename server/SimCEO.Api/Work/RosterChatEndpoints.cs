using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Work;

namespace SimCEO.Api;

// Roster-direct advisor chat: the ONLY direct-chat path. The advisor is
// chosen from My Advisor Roster (selected roster entry); no board advisor,
// board id, or board context is accepted here. Account authorization only
// (RosterEndpoints.CanReadRoster). Stateless like auditions: the client
// keeps history; nothing here writes meeting messages, records, or memory.
//
// Freshness contract (same strength as meeting publication): the prompt is
// built from a coherent pre-await snapshot; after the model await the live
// entry is rechecked (canonical version, archive state, roster access,
// restore identity). A concurrent edit/archive/revocation/restore discards
// the stale reply with 409/403/401 instead of returning old output.
public static class RosterChatEndpoints
{
  public static void MapRosterChat(this WebApplication app)
  {
    var gw = new ModelGateway(app.Services.GetRequiredService<InMemoryStore>());

    app.MapPost("/api/roster/{id:guid}/chat", async (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } bad) return bad;
      if (!s.Roster.TryGetValue(id, out var entry) || entry.Archived) return Results.NotFound();
      if (!RosterEndpoints.CanReadRoster(s, req, entry)) return PeopleOps.Denied();
      if (PeopleOps.Guard(gw, req) is { } capped) return capped;
      var message = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("message", out var cm)
        ? (cm.GetString() ?? "")
        : "";
      if (string.IsNullOrWhiteSpace(message)) return Results.BadRequest("message is required.");
      if (message.Length > 4000) return Results.BadRequest("message exceeds 4000 chars.");
      // Coherent pre-await snapshot under ONE RootGate: canonical profile, description + version,
      // restore pin and authorization are captured at the same authoritative boundary,
      // so no old-profile/new-restore-pin window exists.
      string snapProfile = "{}";
      string snapName = "";
      string snapDesc = "";
      int snapVersion = 0;
      string userContext = "";
      (Guid epochId, long epochRev) restorePin = default;
      lock (s.RootGate)
      {
        if (!s.Roster.TryGetValue(id, out var snapEntry) || snapEntry is null || snapEntry.Archived) return Results.NotFound();
        if (!RosterEndpoints.CanReadRoster(s, req, snapEntry)) return PeopleOps.Denied();
        snapProfile = snapEntry.ProfileJson ?? "{}";
        snapName = snapEntry.Name;
        snapDesc = snapEntry.Description ?? "";
        snapVersion = snapEntry.Version;
        userContext = AdvisorDialogue.UserContext(LeadSetup.ResolveDefaultForCaller(s, req));
        restorePin = PublicationGuard.Capture(s);
      }
      // Same behavior contract as meetings: the CURRENT canonical entry (all 3 paragraphs, version-pinned) drives every turn.
      var behaviorSection = CharacterBehavior.BehaviorSection(snapProfile, snapName, snapVersion, snapVersion, "");
      behaviorSection += CharacterBehavior.SeedContextSection(behaviorSection, snapProfile, snapDesc);
      var historyLines = new List<string>();
      if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("history", out var ch) && ch.ValueKind == JsonValueKind.Array)
      {
        var turns = new List<string>();
        foreach (var te in ch.EnumerateArray().TakeLast(10))
        {
          if (te.ValueKind != JsonValueKind.Object) continue;
          var rr = te.TryGetProperty("role", out var rrv) ? (rrv.GetString() ?? "") : "";
          var cc = te.TryGetProperty("content", out var ccv) ? (ccv.GetString() ?? "") : "";
          if (string.IsNullOrWhiteSpace(cc)) continue;
          var ccut = cc.Length > 800 ? cc[..800] : cc;
          historyLines.Add(rr + ": " + ccut);
          if (historyLines.Count >= 10) break;
        }
      }
      string answer;
      var essentialChat = "ROSTER ADVISOR CHAT (isolated, not a meeting message). " + userContext + AdvisorDialogue.Guidance + "\n" + behaviorSection
        + AdvisorDialogue.Background(snapProfile, snapDesc)
        + "Lead says: " + message + "\nReply in character from the standards above: evidence determines judgment and the character determines delivery; concise; flag missing evidence, stay within specialty, never claim real employment, degrees, licenses, or endorsements.\n";
      var chatPacket = CharacterBehavior.FitEssentialFirst(essentialChat, historyLines.TakeLast(10).ToList(), AdvisorAssessment.PacketBudget("roster-chat", CharacterBehavior.ChatInputTokens));
      if (chatPacket is null)
        return Results.Json(new { error = "Chat prompt over budget." }, statusCode: 413);
      var stream = new AdvisorStreamResponse(req);
      try
      {
        answer = await AdvisorAssessment.CompleteAsync(gw, ModelPolicy.SparkStandard, "roster-chat",
          chatPacket, CharacterBehavior.ChatInputTokens, req.HttpContext.RequestAborted, ownerOverride: PeopleOps.IsOwner(req),
          ensureFresh: () => { if (CheckSnapshot(s, req, id, snapVersion, userContext, restorePin) is { } failure) throw new ChatChangedException(failure); },
          onText: stream.Enabled ? stream.Push : null);
      }
      catch (ChatChangedException changed) { return await stream.Finish(changed.Result); }
      catch (OperationCanceledException) { return await stream.Finish(Results.StatusCode(499)); }
      catch (Exception ex) when (ex is CapExceededException or ProviderException or TaskCanceledException or HttpRequestException or JsonException) { return await stream.Finish(PeopleOps.ModelError(ex)); }
      // Post-await recheck under ONE RootGate THROUGH the immutable final
      // response: authority, restore epoch, archive state, roster access and
      // canonical version are read at one boundary, so a restore/edit between
      // two reads cannot mix an old profile with a new epoch check.
      IResult result;
      lock (s.RootGate)
      {
        if (CheckSnapshot(s, req, id, snapVersion, userContext, restorePin) is { } failure) result = failure;
        else {
        var fresh = s.Roster[id];
        result = Results.Ok(new
        {
          answer,
          rosterId = fresh.Id,
          rosterVersion = fresh.Version,
          indicators = new
          {
            expertiseUsed = snapName,
            assumptions = new[] { "advisor profile and your default profile; no board or meeting history" },
            sources = new[] { "none: roster chat uses only the owner-entered roster profile" },
            withinLimits = true,
          },
          stored = false,
          note = "Roster advisor chat is isolated; never creates meeting messages, records, or agent memory.",
        });
        }
      }
      return await stream.Finish(result);
    });
  }
  private sealed class ChatChangedException(IResult result) : Exception
  {
    public IResult Result { get; } = result;
  }

  private static IResult? CheckSnapshot(InMemoryStore s, HttpRequest req, Guid id, int version,
    string expectedUserContext, (Guid epochId, long epochRev) restorePin)
  {
    lock (s.RootGate)
    {
        if (PeopleOps.BadToken(s, req) is { } bad) return bad;
        if (s.RestoreEpochId != restorePin.epochId || s.RestoreEpochRev != restorePin.epochRev)
          return Results.Conflict("Domain was restored during generation; stale reply discarded, retry.");
        if (!s.Roster.TryGetValue(id, out var fresh) || fresh is null) return Results.NotFound();
        if (fresh.Archived)
          return Results.Conflict("Roster entry was archived during generation; stale reply discarded.");
        if (!RosterEndpoints.CanReadRoster(s, req, fresh)) return PeopleOps.Denied();
        if (fresh.Version != version)
          return Results.Conflict("Advisor was edited during generation; stale reply discarded, retry with the current version.");
        if (expectedUserContext != AdvisorDialogue.UserContext(LeadSetup.ResolveDefaultForCaller(s, req)))
          return Results.Conflict("Your profile changed during generation; retry with your current profile.");
      return null;
    }
  }

}
