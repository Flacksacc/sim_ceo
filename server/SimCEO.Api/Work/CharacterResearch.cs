using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

namespace SimCEO.Api;

// Character research runner (backend owner). Bounded end-to-end by
// CharacterBehavior.ResearchDeadline (<=180s) across URL fetches + model
// calls: one fetch round (existing safe PublicEvidenceFetcher mechanisms,
// never merely passing links to the LLM) + at most TWO model calls
// (1 grounded dossier + 1 paragraph compile). No retries, no recursion.
// User links are FETCHED; model output is compiled into the 3 editable
// paragraphs and stored as a DRAFT inside ResearchJson; nothing is
// auto-approved and the user seed stays until an explicit PUT save.
//
// Research INPUTS (full background + URLs + focus) persist in
// RosterEntry.ResearchInputsJson, separately from replaceable results:
// failure/reload/retry keeps the exact inputs without resubmission.
// Results/terminal markers live in ResearchJson; inputs are never wiped
// by result writes.
//
// Honest terminal states (ResearchJson.draftStatus): "done" (grounded,
// ResearchedAt set), "unsupported" (run finished but with zero grounded
// evidence: ResearchedAt stays null, editable partial draft kept, never
// marked complete), "failed" (provider/timeout/cancel/compile failure,
// entry pending), "saved" (explicit PUT save of the draft), "superseded"
// (a newer run or a profile edit won the race).
// GET /research derives `running` ONLY from live jobs; polling always
// terminates honestly (done/failed/unsupported/interrupted), never
// RUNNING forever. Deadline expiry is 504, client abort is 499.
public static class CharacterResearch
{
  /// <summary>Code-only cleanup-fault seam for QA: when set, FailTerminal throws
  /// an InvalidOperationException storage fault inside its commit unit, proving
  /// honest 502 mapping (never 403) and rollback. Never HTTP/env/header.</summary>
  public static Func<bool>? FailCleanupFault;
  public static void MapCharacterResearch(this WebApplication app)
  {
    var gw = new ModelGateway(app.Services.GetRequiredService<InMemoryStore>());

    app.MapPost("/api/roster/{id:guid}/research", async (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badRes) return badRes;
      if (!s.Roster.TryGetValue(id, out var preRes) || preRes.Archived) return Results.NotFound();
      if (!RosterOps.CanWriteRoster(s, req, preRes)) return PeopleOps.Denied();
      if (PeopleOps.Guard(gw, req) is { } capped) return capped;
      if (body.ValueKind != JsonValueKind.Object)
        return Results.BadRequest("Invalid research request body.");
      string explicitFocus = "";
      bool hasFocus = false;
      if (body.TryGetProperty("focus", out var ffe))
      {
        hasFocus = true;
        if (ffe.ValueKind == JsonValueKind.Null || ffe.ValueKind == JsonValueKind.Undefined) explicitFocus = "";
        else if (ffe.ValueKind != JsonValueKind.String) return Results.BadRequest("focus must be a string.");
        else explicitFocus = ffe.GetString() ?? "";
      }
      if (explicitFocus.Length > CharacterBehavior.MaxFocusChars) return Results.BadRequest("focus must be " + CharacterBehavior.MaxFocusChars + " chars or fewer.");
      string explicitBackground = "";
      bool hasBackground = false;
      if (body.TryGetProperty("background", out var bge))
      {
        hasBackground = true;
        if (bge.ValueKind == JsonValueKind.Null || bge.ValueKind == JsonValueKind.Undefined) explicitBackground = "";
        else if (bge.ValueKind != JsonValueKind.String) return Results.BadRequest("background must be a string.");
        else explicitBackground = (bge.GetString() ?? "").Trim();
      }
      if (explicitBackground.Length > CharacterBehavior.MaxBackgroundChars) return Results.BadRequest("background must be " + CharacterBehavior.MaxBackgroundChars + " chars or fewer.");
      var (urlsOk, urlsError, explicitUrls) = CharacterBehavior.ValidateSourceUrls(body);
      if (!urlsOk) return Results.BadRequest(urlsError);
      bool hasUrls = body.TryGetProperty("sourceUrls", out var urlEl) && urlEl.ValueKind == JsonValueKind.Array;
      // Explicit request inputs are validated above. Effective fallback inputs
      // are resolved from FRESH state inside the authoritative SetupLock/Atomic
      // snapshot below (never from pre-lock preRes), so a concurrent PUT that
      // wins before the snapshot is honored and the version check protects the write.
      // Presence beats emptiness: explicit [] clears stored URLs (never falls through); omitted fields fall back below.
      string background = "";
      string focus = "";
      List<string> reqUrls = new();
      string effectiveInputs = "";
      string jobId = "";
      int baseVersion = 0;
      string startSubject = "";
      string startName = "";
      string startDesc = "";
      string startProfile = "{}";
      (Guid epochId, long epochRev) resPin = (Guid.Empty, 0L);
      lock (s.SetupLock)
      {
        if (!s.Roster.TryGetValue(id, out var entry) || entry.Archived) return Results.NotFound();
        if (!RosterOps.CanWriteRoster(s, req, entry)) return PeopleOps.Denied();
        if (entry.ResearchRequested && entry.ResearchedAt is null && !string.IsNullOrEmpty(entry.ResearchJobId))
        {
          if (RosterOps.IsLiveResearchJob(entry.ResearchJobId))
            return Results.Conflict("Research is already running for this advisor; wait for it to finish.");
        }
        jobId = Guid.NewGuid().ToString("N");
        try
        {
          Atomic.Run(s, () =>
          {
            if (!s.Roster.TryGetValue(id, out var cur) || cur is null || cur.Archived) throw new InvalidOperationException("gone");
            if (!RosterOps.CanWriteRoster(s, req, cur)) throw PeopleOps.AuthFault(s, req);
            if (cur.ResearchRequested && cur.ResearchedAt is null && !string.IsNullOrEmpty(cur.ResearchJobId) && RosterOps.IsLiveResearchJob(cur.ResearchJobId))
              throw new InvalidOperationException("running");
            // Resolve effective inputs from FRESH cur inside the SAME authoritative snapshot: omitted falls back, explicit clears.
            var stored = CharacterBehavior.ParseInputs(cur.ResearchInputsJson);
            var bg = hasBackground ? explicitBackground : (stored.Background ?? "");
            var urls = new List<string>();
            if (hasUrls)
              urls.AddRange(explicitUrls.Take(CharacterBehavior.MaxSourceUrls));
            else if (stored.SourceUrls.Count > 0)
              foreach (var u in stored.SourceUrls.Take(CharacterBehavior.MaxSourceUrls))
                if (!urls.Contains(u)) urls.Add(u);
            var foc = hasFocus ? explicitFocus : (stored.Focus ?? "");
            if ((!hasBackground && string.IsNullOrWhiteSpace(bg)) || (!hasUrls && urls.Count == 0))
            {
              try
              {
                using var seedDoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(cur.ResearchJson) ? "{}" : cur.ResearchJson);
                var seedRoot = seedDoc.RootElement;
                if (seedRoot.ValueKind == JsonValueKind.Object)
                {
                  if (!hasBackground && string.IsNullOrWhiteSpace(bg) && seedRoot.TryGetProperty("pendingBackground", out var pb) && pb.ValueKind == JsonValueKind.String)
                    bg = (pb.GetString() ?? "").Trim();
                  if (!hasUrls && urls.Count == 0 && seedRoot.TryGetProperty("pendingSourceUrls", out var pu) && pu.ValueKind == JsonValueKind.Array)
                    foreach (var e in pu.EnumerateArray())
                    {
                      if (e.ValueKind != JsonValueKind.String) continue;
                      var u = (e.GetString() ?? "").Trim();
                      if (u.Length == 0) continue;
                      if (urls.Count < CharacterBehavior.MaxSourceUrls && !urls.Contains(u)) urls.Add(u);
                    }
                }
              }
              catch (JsonException) { }
            }
            background = bg;
            reqUrls = urls;
            focus = foc;
            effectiveInputs = CharacterBehavior.SerializeInputs(background, reqUrls, focus);
            baseVersion = cur.Version;
            startSubject = cur.Name + " (" + cur.Type + ")";
            startName = cur.Name;
            startDesc = cur.Description;
            startProfile = cur.ProfileJson ?? "{}";
            resPin = PublicationGuard.Capture(s);
            cur.ResearchRequested = true;
            cur.ResearchedAt = null;
            cur.EvidenceCount = 0;
            cur.ResearchJson = "{}";
            cur.ResearchJobId = jobId;
            cur.ResearchBaseVersion = cur.Version;
            cur.ResearchInputsJson = effectiveInputs;
            cur.UpdatedAt = DateTime.UtcNow;
            RosterOps.UnapproveBoardCopies(s, id);
            s.Roster[cur.Id] = cur;
          });
        }
        catch (UnauthorizedAccessException uex) when (uex.Message == "revoked") { return Results.Json(new { error = "Authentication required." }, statusCode: 401); }
        catch (InvalidOperationException iox) when (iox.Message == "security-unavailable") { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
        catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
        catch (InvalidOperationException iox) when (iox.Message == "running") { return Results.Conflict("Research is already running for this advisor; wait for it to finish."); }
        catch (InvalidOperationException iox) when (CommitOutcome.IsMissing(iox, "gone")) { return Results.NotFound(); }
        catch (InvalidOperationException iox) { return CommitOutcome.StorageFault("Research start", iox); }
        catch (Exception ex) { return CommitOutcome.MapCommitFailure(ex, "Research start") ?? Results.Json(new { error = "Research start failed; no state changed: " + ex.Message }, statusCode: 500); }
        RosterOps.MarkLiveResearchJob(jobId);
      }
      var capturedJob = jobId;
      CharacterBehavior.SetProgress(capturedJob, "starting");
      using var deadline = CancellationTokenSource.CreateLinkedTokenSource(req.HttpContext.RequestAborted);
      deadline.CancelAfter(CharacterBehavior.ResearchDeadline);
      var ct = deadline.Token;
      List<object> fetchedSources = new();
      try
      {
        // Step 1 (fetch round): actually fetch user-supplied URLs through the
        // existing safe fetcher (SSRF-pinned, 5s per URL, max 3 per call).
        // Excerpts found here ground the dossier call; missing excerpts are
        // reported honestly per URL (fetched:false), never invented.
        var fetchedExcerpts = new Dictionary<string, (string Title, string Excerpt)>(StringComparer.OrdinalIgnoreCase);
        if (reqUrls.Count > 0)
        {
          CharacterBehavior.SetProgress(capturedJob, "fetching-sources");
          try
          {
            var fetcher = new PublicEvidenceFetcher { MaxSubjectTokens = 24 };
            // Relevance is judged against the full research seed (name, description,
            // background, focus), not the bare name: an owner page about the
            // character's specialty counts as evidence for that character even when
            // it never mentions the fictional name itself. Bounded: salient-token
            // extraction caps the research path at 24 salient terms (bounded).
            var subject = (startName + " " + startDesc + " " + background + " " + focus).Trim();
            if (subject.Length > 2000) subject = subject.Substring(0, 2000);
            foreach (var batch in reqUrls.Chunk(3))
            {
              ct.ThrowIfCancellationRequested();
              var synthetic = batch.Select(u => new ModelGateway.Citation(u, "", "")).ToList();
              var hydrated = await fetcher.HydrateAsync(synthetic, subject, ct).ConfigureAwait(false);
              foreach (var h in hydrated)
              {
                if (!string.IsNullOrWhiteSpace(h.Excerpt))
                {
                  fetchedExcerpts[h.Url] = (h.Title ?? "", h.Excerpt ?? "");
                  fetchedSources.Add(new { url = h.Url, title = h.Title ?? "", excerpt = h.Excerpt ?? "", fetched = true });
                }
                else
                {
                  fetchedSources.Add(new { url = h.Url, title = h.Title ?? "", excerpt = "", fetched = false });
                }
              }
            }
          }
          catch (OperationCanceledException) { throw; }
          catch (Exception) { /* fetch round is best-effort; dossier still runs on what exists */ }
          CharacterBehavior.SetProgress(capturedJob, "researching",
            fetchedSources.ToList());
        }
        else
        {
          CharacterBehavior.SetProgress(capturedJob, "researching");
        }

        // Step 2 (model call 1 of 2): single grounded dossier call.
        var focusTag = string.IsNullOrWhiteSpace(focus) ? "" : " Focus: " + focus.Trim() + ".";
        var bgTag = string.IsNullOrWhiteSpace(background) ? "" : " Owner background: " + background.Trim() + ".";
        var sidMap = ClaimEvidenceMapper.BuildSidMap(reqUrls);
        var fetchTag = "";
        if (reqUrls.Count > 0)
        {
          var parts = new List<string>();
          for (var si = 0; si < reqUrls.Count; si++)
          {
            var u = reqUrls[si];
            var sid = "S" + (si + 1);
            if (fetchedExcerpts.TryGetValue(u, out var fe) && !string.IsNullOrWhiteSpace(fe.Excerpt))
              parts.Add("[" + sid + "] " + u + " :: \"" + fe.Excerpt + "\"");
            else
              parts.Add("[" + sid + "] " + u + " :: (fetch failed; do not cite as verified)");
          }
          fetchTag = " Owner sources (cite by SID or full URL; quotes must be exact whitespace-normalized substrings of the excerpt): "
            + string.Join(" | ", parts.Take(5));
        }
        ModelGateway.GroundedResult dossier;
        try
        {
          dossier = await gw.CompleteGroundedAsync(ModelPolicy.SparkStandard, "advisor-research",
            "Advisor dossier research. Subject: " + startSubject + "." + focusTag + bgTag
              + " Seed description: " + startDesc + "." + fetchTag
              + " Web search is enabled; for web-discovered sources cite the full https URL plus the exact quote from the retrieved passage."
              + " Return ONE claim per line in EXACT format: KIND | claim text || EVIDENCE: <S1|full-url> :: \"<exact supporting quote>\" [ ;; <S1|full-url> :: \"<exact quote>\" ]"
              + " Where KIND is FACT (directly supported by the quoted passage) or INTERPRETATION (inference that still needs a quote showing its basis, or leave EVIDENCE empty when no source supports it)."
              + " Rules: the exact quote must appear verbatim (whitespace-normalized) in that source's retrieved excerpt; do not invent URLs or quotes; do not copy the same source onto unrelated claims; leave EVIDENCE empty when no passage supports the claim. Do not use VERIFIED prefix; use KIND. Distinguish facts from interpretation via KIND only.",
            4000, 2048, ct, ownerOverride: PeopleOps.IsOwner(req));
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex) when (ex is CapExceededException or ProviderException or TaskCanceledException or HttpRequestException or JsonException)
        {
          return FailTerminal(s, req, id, capturedJob, resPin,
            "Advisor research provider call failed; entry left pending, nothing marked complete.", ex);
        }
        var g = dossier;
        var claims = new List<object>();
        var responseIds = new List<string>();
        if (g.ResponseId is not null) responseIds.Add(g.ResponseId);
        var citedUrls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var pool = new Dictionary<string, (string Title, string Excerpt)>(StringComparer.OrdinalIgnoreCase);
        foreach (var u in reqUrls) citedUrls.Add(u);
        foreach (var kv in fetchedExcerpts)
        {
          pool[kv.Key] = (kv.Value.Title ?? "", kv.Value.Excerpt ?? "");
        }
        foreach (var cite in g.Citations.Where(c => !string.IsNullOrWhiteSpace(c.Url)))
        {
          citedUrls.Add(cite.Url);
          if (!string.IsNullOrWhiteSpace(cite.Excerpt))
          {
            if (pool.TryGetValue(cite.Url, out var existing))
            {
              if (string.IsNullOrWhiteSpace(existing.Excerpt))
                pool[cite.Url] = (cite.Title ?? existing.Title ?? "", cite.Excerpt ?? "");
            }
            else pool[cite.Url] = (cite.Title ?? "", cite.Excerpt ?? "");
          }
        }
        var rawLines = g.Text.Split((char)10, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Take(12).ToList();
        try
        {
          var needFetch = ClaimEvidenceMapper.CollectUnfetchedUrls(rawLines, pool, sidMap).Take(3).ToList();
          if (needFetch.Count > 0)
          {
            ct.ThrowIfCancellationRequested();
            var subject = (startName + " " + startDesc + " " + background + " " + focus).Trim();
            if (subject.Length > 2000) subject = subject.Substring(0, 2000);
            var synth = needFetch.Select(u => new ModelGateway.Citation(u, "", "")).ToList();
            var webFetcher = new PublicEvidenceFetcher { MaxSubjectTokens = 24 };
            var hydrated = await webFetcher.HydrateAsync(synth, subject, ct).ConfigureAwait(false);
            foreach (var h in hydrated)
            {
              if (!string.IsNullOrWhiteSpace(h.Excerpt))
                pool[h.Url] = (h.Title ?? "", h.Excerpt ?? "");
            }
          }
        }
        catch (OperationCanceledException) { throw; }
        catch { }
        var validated = ClaimEvidenceMapper.MapAll(rawLines, pool, sidMap);
        var citedExcerpts = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var kv in pool)
          if (!string.IsNullOrWhiteSpace(kv.Value.Excerpt)) citedExcerpts[kv.Key] = kv.Value.Excerpt;
        foreach (var vc in validated)
        {
          if (vc.Verified)
            claims.Add(new { angle = "dossier", text = vc.Text, kind = vc.Kind, verified = true, sources = vc.Refs.Select(r => new { url = r.Url, title = r.Title }).ToList(), refs = vc.Refs.Select(r => new { kind = "source", @ref = r.Url, url = r.Url, title = r.Title, excerpt = r.Quote }).ToList() });
          else
            claims.Add(new { angle = "dossier [unverified]", text = vc.Text, kind = vc.Kind, verified = false, sources = new List<object>(), refs = new List<object>() });
        }
        foreach (var c in g.Citations.Take(6).Where(c => !string.IsNullOrWhiteSpace(c.Excerpt)))
          claims.Add(new { angle = "dossier [citation]", text = c.Excerpt, kind = "citation", verified = false, sources = new[] { new { url = c.Url, title = c.Title } }.ToList(), refs = new[] { new { kind = "source", @ref = c.Url, url = c.Url, title = c.Title, excerpt = c.Excerpt } }.ToList() });

        // Step 3 (model call 2 of 2): compile the 3 editable paragraphs,
        // refining the CURRENT saved behavior (explicit user edits win over
        // regeneration unless evidence contradicts them).
        CharacterBehavior.SetProgress(capturedJob, "compiling",
          fetchedSources.Concat(citedExcerpts.Select(kv => (object)new { url = kv.Key, excerpt = kv.Value })).ToList());
        var currentBehavior = "";
        try
        {
          using var curDoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(startProfile) ? "{}" : startProfile);
          if (curDoc.RootElement.ValueKind == JsonValueKind.Object)
          {
            var cc = curDoc.RootElement.TryGetProperty(CharacterBehavior.KeyContribution, out var cv) && cv.ValueKind == JsonValueKind.String ? (cv.GetString() ?? "") : "";
            var rc = curDoc.RootElement.TryGetProperty(CharacterBehavior.KeyReasoning, out var rv) && rv.ValueKind == JsonValueKind.String ? (rv.GetString() ?? "") : "";
            var sc = curDoc.RootElement.TryGetProperty(CharacterBehavior.KeyResponse, out var sv) && sv.ValueKind == JsonValueKind.String ? (sv.GetString() ?? "") : "";
            if (!string.IsNullOrWhiteSpace(cc) && !string.IsNullOrWhiteSpace(rc) && !string.IsNullOrWhiteSpace(sc))
              currentBehavior = " Current saved behavior to refine (keep explicit user wording unless evidence contradicts it): [" + cc + " | " + rc + " | " + sc + "].";
          }
        }
        catch (JsonException) { }
        var groundedDossier = validated.Count == 0 ? "(no verified grounded claims; compile from the owner seed and explicit limits only; do not invent grounding)"
          : string.Join("\n", validated.Where(v => v.Verified).Select(v => v.Kind.ToUpperInvariant() + " | " + v.Text + " || EVIDENCE: " + string.Join(" ;; ", v.Refs.Select(r => r.Url + " :: \"" + r.Quote + "\""))));
        if (validated.All(v => !v.Verified))
          groundedDossier = "(no verified grounded claims; compile from the owner seed and explicit limits only; do not invent grounding) \n" + groundedDossier;
        var compileInput = BuildCompileInput(focus, startName, startDesc, background, currentBehavior, groundedDossier);
        if (compileInput is null)
        {
          return FailTerminal(s, req, id, capturedJob, resPin,
            "Research dossier exceeds the compile budget on its own; entry left pending, nothing marked complete.",
            new ProviderException(502, "dossier exceeds compile budget"),
            new { subject = startSubject, searched = g.RanSearch ? 1 : 0, claims, responseIds, version = baseVersion });
        }
        string compiled;
        try
        {
          compiled = await gw.CompleteAsync(ModelPolicy.SparkStandard, "advisor-compile",
          compileInput, ContextBudget.BidTokens, 2048, ct, ownerOverride: PeopleOps.IsOwner(req), truncatePrompt: false);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex) when (ex is CapExceededException or ProviderException or TaskCanceledException or HttpRequestException or JsonException)
        {
          return FailTerminal(s, req, id, capturedJob, resPin,
            "Paragraph compile failed after dossier; entry left pending with partial dossier, nothing marked complete.", ex,
            new { subject = startSubject, searched = g.RanSearch ? 1 : 0, claims, responseIds, version = baseVersion });
        }
        if (!CharacterBehavior.TryParseCompiledParagraphs(compiled, out var paragraphs, out var lengthError))
        {
          var why = lengthError ?? "compile output missing required paragraphs";
          return FailTerminal(s, req, id, capturedJob, resPin,
            "Paragraph compile returned unusable output (" + why + "); entry left pending with partial dossier, nothing marked complete.",
            new ProviderException(502, why),
            new { subject = startSubject, searched = g.RanSearch ? 1 : 0, claims, responseIds, version = baseVersion });
        }
        object outcome;
        bool grounded = validated.Any(v => v.Verified && v.Refs.Count > 0);
        lock (s.SetupLock)
        {
          if (!s.Roster.TryGetValue(id, out var cur) || cur.Archived)
          {
            RosterOps.ClearLiveResearchJob(capturedJob);
            CharacterBehavior.ClearProgress(capturedJob);
            return Results.NotFound();
          }
          if (cur.ResearchJobId != capturedJob)
          {
            RosterOps.ClearLiveResearchJob(capturedJob);
            CharacterBehavior.ClearProgress(capturedJob);
            return Results.Conflict("A newer research request superseded this run; use its result.");
          }
          if (cur.Version != baseVersion)
          {
            IResult? staleCleanupErr = null;
            try
            {
              Atomic.Run(s, () =>
              {
                if (!s.Roster.TryGetValue(id, out var stale) || stale is null) return;
                if (stale.ResearchJobId != capturedJob) return;
                if (s.RestoreEpochId != resPin.epochId || s.RestoreEpochRev != resPin.epochRev) throw new InvalidOperationException("res-restored");
                if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) throw new UnauthorizedAccessException("revoked");
                if (!RosterOps.CanWriteRoster(s, req, stale)) throw new UnauthorizedAccessException("denied");
                stale.ResearchJobId = "";
                stale.ResearchRequested = true;
                stale.ResearchJson = JsonSerializer.Serialize(new { draftStatus = "superseded", stageError = "Advisor profile changed during research; rerun research on the new version." });
                stale.UpdatedAt = DateTime.UtcNow;
                s.Roster[stale.Id] = stale;
              });
            }
            catch (InvalidOperationException iox) when (iox.Message == "res-restored") { staleCleanupErr = Results.Conflict("Domain was restored during research; the restored entry was left untouched."); }
            catch (UnauthorizedAccessException uex) when (uex.Message == "revoked") { staleCleanupErr = Results.Json(new { error = "Authentication required." }, statusCode: 401); }
            catch (UnauthorizedAccessException) { staleCleanupErr = PeopleOps.Denied(); }
            catch (Exception fex) { staleCleanupErr = CommitOutcome.MapCommitFailure(fex, "Research cleanup") ?? Results.Json(new { error = "Research cleanup failed; no state changed: " + fex.Message }, statusCode: 500); }
            RosterOps.ClearLiveResearchJob(capturedJob);
            CharacterBehavior.ClearProgress(capturedJob);
            if (staleCleanupErr is not null) return staleCleanupErr;
            return Results.Conflict("Advisor profile changed during research; rerun research on the new version.");
          }
          var evidenceRefs = citedUrls.Select(u => new
          {
            kind = "source",
            @ref = u,
            url = u,
            title = fetchedExcerpts.TryGetValue(u, out var fe) ? fe.Title : g.Citations.Where(c => string.Equals(c.Url, u, StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(c.Title)).Select(c => c.Title).FirstOrDefault() ?? "",
            excerpt = citedExcerpts.TryGetValue(u, out var exu) ? exu : "",
            fetched = citedExcerpts.ContainsKey(u),
            ownerSupplied = reqUrls.Contains(u),
          }).ToList<object>();
          var built = new
          {
            subject = startSubject,
            searched = g.RanSearch ? 1 : 0,
            supported = grounded && claims.Count > 0,
            claims,
            responseIds,
            version = baseVersion,
            evidenceRefs,
            draftProfile = new
            {
              contributionCriteria = paragraphs.ContributionCriteria,
              reasoningApproach = paragraphs.ReasoningApproach,
              responseStyle = paragraphs.ResponseStyle,
            },
            // "done" only with grounded evidence; otherwise "unsupported":
            // the run finished and the draft is editable, but nothing is
            // marked complete and review stays ineligible until grounded.
            draftStatus = grounded ? "done" : "unsupported",
            note = !grounded
              ? "No grounded evidence completed (no search, no citations, or every owner URL failed to fetch). The draft below is editable but UNSUPPORTED: not marked complete, not eligible for approval. Rerun research with better inputs, or proceed without research-gated approval."
              : "Snippet-level claims need cross-checking against independent sources before approval. Draft paragraphs are editable; explicit PUT save required before they take effect.",
          };
          try
          {
            Atomic.Run(s, () =>
            {
              if (!s.Roster.TryGetValue(id, out var fresh) || fresh is null || fresh.Archived) throw new InvalidOperationException("gone");
              if (s.RestoreEpochId != resPin.epochId || s.RestoreEpochRev != resPin.epochRev) throw new InvalidOperationException("res-restored");
              if (fresh.ResearchJobId != capturedJob) throw new InvalidOperationException("superseded");
              if (PeopleOps.BadToken(s, req) is not null) throw new UnauthorizedAccessException("revoked");
              if (!RosterOps.CanWriteRoster(s, req, fresh)) throw new UnauthorizedAccessException("denied");
              fresh.ResearchJson = JsonSerializer.Serialize(built);
              // Ungrounded runs never set completion: ResearchedAt stays null
              // and the evidence count stays zero, so approval correctly
              // requires a grounded run while the draft remains editable.
              fresh.ResearchedAt = grounded ? DateTime.UtcNow : null;
              fresh.EvidenceCount = grounded ? validated.Where(v => v.Verified).SelectMany(v => v.Refs.Select(r => r.Url)).Distinct(StringComparer.OrdinalIgnoreCase).Count() : 0;
              // Grounded research with real evidence completes a recovered placeholder
              // (explicit "recovered" tag removed by the owner's own research run;
              // unsupported dossiers keep the tag and stay blocked).
              if (grounded && !string.IsNullOrWhiteSpace(fresh.Tags))
              {
                var kept = (fresh.Tags ?? "").Split(",").Select(t => t.Trim()).Where(t => t.Length > 0 && !string.Equals(t, "recovered", StringComparison.OrdinalIgnoreCase)).ToList();
                fresh.Tags = string.Join(",", kept);
              }
              fresh.ResearchJobId = "";
              fresh.ResearchRequested = true;
              fresh.Version += 1;
              fresh.UpdatedAt = DateTime.UtcNow;
              RosterOps.UnapproveBoardCopies(s, id);
              s.Roster[fresh.Id] = fresh;
            });
          }
          catch (InvalidOperationException iox) when (iox.Message == "superseded")
          {
            RosterOps.ClearLiveResearchJob(capturedJob);
            CharacterBehavior.ClearProgress(capturedJob);
            return Results.Conflict("A newer research request superseded this run; use its result.");
          }
          catch (InvalidOperationException iox) when (iox.Message == "res-restored")
          {
            RosterOps.ClearLiveResearchJob(capturedJob);
            CharacterBehavior.ClearProgress(capturedJob);
            return Results.Conflict("Domain was restored during research; the restored entry was left untouched; rerun research on the current version.");
          }
          catch (UnauthorizedAccessException uex) when (uex.Message == "revoked") { RosterOps.ClearLiveResearchJob(capturedJob); CharacterBehavior.ClearProgress(capturedJob); return Results.Json(new { error = "Authentication required." }, statusCode: 401); }
          catch (UnauthorizedAccessException) { RosterOps.ClearLiveResearchJob(capturedJob); CharacterBehavior.ClearProgress(capturedJob); return PeopleOps.Denied(); }
          catch (InvalidOperationException iox) when (CommitOutcome.IsMissing(iox, "gone")) { RosterOps.ClearLiveResearchJob(capturedJob); CharacterBehavior.ClearProgress(capturedJob); return Results.NotFound(); }
          catch (InvalidOperationException iox) { RosterOps.ClearLiveResearchJob(capturedJob); CharacterBehavior.ClearProgress(capturedJob); return CommitOutcome.StorageFault("Research completion", iox); }
          catch (Exception ex) { RosterOps.ClearLiveResearchJob(capturedJob); CharacterBehavior.ClearProgress(capturedJob); return CommitOutcome.MapCommitFailure(ex, "Research completion") ?? Results.Json(new { error = "Research completion failed; no state changed: " + ex.Message }, statusCode: 500); }
          outcome = built;
        }
        CharacterBehavior.ClearProgress(capturedJob);
        return Results.Ok(outcome);
      }
      catch (OperationCanceledException)
      {
        var timeout = deadline.IsCancellationRequested && !req.HttpContext.RequestAborted.IsCancellationRequested;
        var cancelNote = timeout
          ? "Research deadline exceeded (" + (int)CharacterBehavior.ResearchDeadline.TotalSeconds + "s bound across fetches and model calls); entry left pending, nothing marked complete."
          : "Research request cancelled; entry left pending, nothing marked complete.";
        lock (s.SetupLock)
        {
          IResult? cancelCleanupErr = null;
          try
          {
            Atomic.Run(s, () =>
            {
              if (!s.Roster.TryGetValue(id, out var cancelled) || cancelled is null) return;
              if (cancelled.ResearchJobId != capturedJob) return;
              if (s.RestoreEpochId != resPin.epochId || s.RestoreEpochRev != resPin.epochRev) throw new InvalidOperationException("res-restored");
              if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) throw new UnauthorizedAccessException("revoked");
              if (!RosterOps.CanWriteRoster(s, req, cancelled)) throw new UnauthorizedAccessException("denied");
              cancelled.ResearchJobId = "";
              cancelled.ResearchRequested = true;
              cancelled.ResearchedAt = null;
              cancelled.EvidenceCount = 0;
              cancelled.ResearchJson = JsonSerializer.Serialize(new { draftStatus = "failed", stageError = cancelNote, note = cancelNote });
              cancelled.UpdatedAt = DateTime.UtcNow;
              RosterOps.UnapproveBoardCopies(s, id);
              s.Roster[cancelled.Id] = cancelled;
              s.Roster.Flush();
            });
          }
          catch (InvalidOperationException iox) when (iox.Message == "res-restored") { cancelCleanupErr = Results.Conflict("Domain was restored during research; the restored entry was left untouched."); }
          catch (UnauthorizedAccessException uex) when (uex.Message == "revoked") { cancelCleanupErr = Results.Json(new { error = "Authentication required." }, statusCode: 401); }
          catch (UnauthorizedAccessException) { cancelCleanupErr = PeopleOps.Denied(); }
          catch (Exception fex) { cancelCleanupErr = CommitOutcome.MapCommitFailure(fex, "Research cancel cleanup") ?? Results.Json(new { error = "Research cancel cleanup failed; no state changed: " + fex.Message }, statusCode: 500); }
          RosterOps.ClearLiveResearchJob(capturedJob);
          CharacterBehavior.ClearProgress(capturedJob);
          if (cancelCleanupErr is not null) return cancelCleanupErr;
        }
        if (timeout)
          return Results.Json(new { error = cancelNote }, statusCode: 504);
        return Results.StatusCode(499);
      }
      finally
      {
        RosterOps.ClearLiveResearchJob(capturedJob);
        CharacterBehavior.ClearProgress(capturedJob);
      }
    });

    app.MapGet("/api/roster/{id:guid}/research", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);      if (!s.Roster.TryGetValue(id, out var entry)) return Results.NotFound();
      if (PeopleOps.IsSecure(s) && !RosterEndpoints.CanReadRoster(s, req, entry)) return PeopleOps.Denied();
      // Real progress: live stage + sources while a run is in flight, stored
      // terminal markers afterwards. `running` derives ONLY from live jobs;
      // polling always terminates (done/failed/unsupported/interrupted).
      // No fake percentages, no completion claims.
      bool live = !string.IsNullOrEmpty(entry.ResearchJobId) && RosterOps.IsLiveResearchJob(entry.ResearchJobId);
      string stage;
      string? stageError = null;
      List<object> sources = new();
      string? draftStatus = null;
      object? draftProfile = null;
      try
      {
        using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(entry.ResearchJson) ? "{}" : entry.ResearchJson);
        var root = doc.RootElement;
        if (root.ValueKind == JsonValueKind.Object)
        {
          if (root.TryGetProperty("draftStatus", out var ds) && ds.ValueKind == JsonValueKind.String)
            draftStatus = ds.GetString();
          if (root.TryGetProperty("stageError", out var se) && se.ValueKind == JsonValueKind.String)
            stageError = se.GetString();
          if (root.TryGetProperty("note", out var nn) && nn.ValueKind == JsonValueKind.String && string.IsNullOrEmpty(stageError))
            stageError = nn.GetString();
          if (root.TryGetProperty("draftProfile", out var dp) && dp.ValueKind == JsonValueKind.Object)
            draftProfile = JsonSerializer.Deserialize<object>(dp.GetRawText());
          if (root.TryGetProperty("evidenceRefs", out var er) && er.ValueKind == JsonValueKind.Array)
            foreach (var e in er.EnumerateArray())
              sources.Add(JsonSerializer.Deserialize<object>(e.GetRawText()) ?? new { });
        }
      }
      catch (JsonException) { }
      if (live)
      {
        var prog = CharacterBehavior.GetProgress(entry.ResearchJobId);
        if (prog is not null)
        {
          stage = prog.Stage;
          stageError = prog.Error ?? stageError;
          if (prog.Sources.Count > 0) sources = prog.Sources;
        }
        else stage = "researching";
      }
      else if (entry.ResearchedAt is not null) stage = "done";
      else if (string.Equals(draftStatus, "failed", StringComparison.OrdinalIgnoreCase)) stage = "failed";
      else if (string.Equals(draftStatus, "unsupported", StringComparison.OrdinalIgnoreCase)) stage = "unsupported";
      else if (string.Equals(draftStatus, "superseded", StringComparison.OrdinalIgnoreCase)) stage = "interrupted";
      else if (entry.ResearchRequested) stage = "interrupted";
      else stage = "not-started";
      var inputs = CharacterBehavior.ParseInputs(entry.ResearchInputsJson);
      return Results.Ok(new { entry.ResearchJson, entry.ResearchedAt, researchRequested = entry.ResearchRequested, evidenceCount = entry.EvidenceCount, version = entry.Version, researchBaseVersion = entry.ResearchBaseVersion, running = live, stage, stageError, sources, draftProfile, draftStatus, inputs = new { background = inputs.Background, sourceUrls = inputs.SourceUrls, focus = inputs.Focus } });
    });
  }

  // Compile prompt assembly: the grounded dossier is REQUIRED content and is
  // never truncated. Template + focus + dossier are reserved first; the seed
  // description/background and current saved behavior (both persisted
  // elsewhere) yield oldest/last first with explicit markers. Only an absurd
  // dossier that alone exceeds the budget fails explicitly.
  // Research status labels and citation metadata belong in the research
  // summary only: operational paragraphs must read as natural character
  // voice (conditional agree/disagree, blunt/formal by circumstance) and
  // express uncertainty plainly, without mandatory VERIFIED/INTERPRETATION/QA
  // labels, bracket markers, URLs, or source IDs in every answer.
  public static string? BuildCompileInput(string focus, string name, string desc, string background, string currentBehavior, string dossier)
  {
    var budget = ModelGateway.UserCharBudget("advisor-compile", ContextBudget.BidTokens);
    var head = "COMPILE-CHARACTER-PARAGRAPHS. Focus: " + focus + ". Compile the researched character \"" + name
      + "\" into EXACTLY this JSON shape (no code fences, no commentary): {\""
      + CharacterBehavior.KeyContribution + "\": \"...\", \""
      + CharacterBehavior.KeyReasoning + "\": \"...\", \""
      + CharacterBehavior.KeyResponse + "\": \"...\"} Each paragraph under " + CharacterBehavior.MaxAcceptedParagraphChars + " chars."
      + " Rules: (1) When to contribute: expertise, useful questions, participation/abstention criteria. "
      + "(2) How to reason: character-based perspective, methods, evidence requirements, when to agree/disagree/challenge, limits. "
      + "(3) How to respond: character-based context-sensitive expression; when blunt, diplomatic, formal, detailed or brief. "
      + "Tone comes from THIS character and circumstance, never a generic fixed tone. "
      + "Research status labels (VERIFIED/INTERPRETATION/FACT/KIND) and citation markers, URLs, source IDs, and QA-persona phrasing belong in the research summary ONLY; "
      + "do NOT copy uppercase labels, bracket markers, URLs, source IDs, or QA wording into operational paragraphs unless the owner seed itself contains that wording. "
      + "Express uncertainty plainly in character voice (conditional language, missing evidence) without mandatory labels in every answer. "
      + "State the fictional identity honestly; never claim real employment, degrees, licenses, endorsements, or real detective authority. "
      + "Compile ONLY from the verified grounded claims below plus the owner seed and explicit limits; ignore unverified notes for behavior.";
    var dossierPart = " Verified grounded claims (only these plus the seed may inform behavior; unverified notes excluded): " + dossier + " Explicit limits: never invent real-world credentials, employment, degrees, licenses, or endorsements; abstain where evidence is missing or the topic is outside the seed.";
    if (head.Length + dossierPart.Length > budget) return null;
    var room = budget - head.Length - dossierPart.Length;
    var seedPart = " Seed description: " + (desc ?? "");
    if (!string.IsNullOrWhiteSpace(background)) seedPart += " Background: " + background;
    seedPart += ".";
    if (seedPart.Length > room)
    {
      var keep = room - 120;
      if (keep < 200) seedPart = "";
      else seedPart = seedPart.Substring(0, keep) + " [...seed trimmed for compile budget; full text preserved in the roster profile...].";
    }
    room = budget - head.Length - dossierPart.Length - seedPart.Length;
    var behPart = currentBehavior ?? "";
    if (behPart.Length > room)
    {
      var keep = room - 120;
      if (keep < 200) behPart = "";
      else behPart = behPart.Substring(0, keep) + " [...saved behavior trimmed for compile budget; full text preserved in the roster profile...].";
      room = budget - head.Length - dossierPart.Length - seedPart.Length - behPart.Length;
      if (room < 0) return null;
    }
    return head + seedPart + behPart + dossierPart;
  }

  // Honest terminal failure: ALWAYS persist a terminal marker (never a bare
  // "{}"), keep the entry pending (ResearchedAt null, no approval), report
  // the provider error without inventing completion. Inputs stay persisted
  // for retry without resubmission.
  private static IResult FailTerminal(InMemoryStore s, HttpRequest req, Guid id, string jobId,
    (Guid epochId, long epochRev) resPin, string note, Exception ex, object? partial = null)
  {
    lock (s.SetupLock)
    {
      try
      {
        Atomic.Run(s, () =>
        {
          if (!s.Roster.TryGetValue(id, out var failed) || failed is null) return;
          if (failed.ResearchJobId != jobId) return;
          if (s.RestoreEpochId != resPin.epochId || s.RestoreEpochRev != resPin.epochRev) throw new InvalidOperationException("res-restored");
          if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) throw new UnauthorizedAccessException("revoked");
          if (!RosterOps.CanWriteRoster(s, req, failed)) throw new UnauthorizedAccessException("denied");
          failed.ResearchJobId = "";
          failed.ResearchRequested = true;
          failed.ResearchedAt = null;
          failed.EvidenceCount = 0;
          failed.ResearchJson = JsonSerializer.Serialize(partial is null
            ? (object)new { draftStatus = "failed", stageError = note, note }
            : (object)new { draftStatus = "failed", stageError = note, note, partial });
          failed.UpdatedAt = DateTime.UtcNow;
          RosterOps.UnapproveBoardCopies(s, id);
          s.Roster[failed.Id] = failed;
          s.Roster.Flush();
          if (FailCleanupFault?.Invoke() == true) throw new InvalidOperationException("injected research cleanup storage fault");
        });
      }
      catch (InvalidOperationException iox) when (iox.Message == "res-restored")
      {
        RosterOps.ClearLiveResearchJob(jobId);
        CharacterBehavior.ClearProgress(jobId);
        return Results.Conflict("Domain was restored during research; the restored entry was left untouched.");
      }
      catch (UnauthorizedAccessException uex) when (uex.Message == "revoked")
      {
        RosterOps.ClearLiveResearchJob(jobId);
        CharacterBehavior.ClearProgress(jobId);
        return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      }
      catch (UnauthorizedAccessException)
      {
        RosterOps.ClearLiveResearchJob(jobId);
        CharacterBehavior.ClearProgress(jobId);
        return PeopleOps.Denied();
      }
      catch (InvalidOperationException iox) when (CommitOutcome.IsMissing(iox, "gone"))
      {
        RosterOps.ClearLiveResearchJob(jobId);
        CharacterBehavior.ClearProgress(jobId);
        return Results.NotFound();
      }
      catch (InvalidOperationException iox)
      {
        RosterOps.ClearLiveResearchJob(jobId);
        CharacterBehavior.ClearProgress(jobId);
        return CommitOutcome.StorageFault("Research failure cleanup", iox);
      }
      catch (Exception fex)
      {
        RosterOps.ClearLiveResearchJob(jobId);
        CharacterBehavior.ClearProgress(jobId);
        return CommitOutcome.MapCommitFailure(fex, "Research failure cleanup") ?? Results.Json(new { error = "Research failure cleanup failed; no state changed: " + fex.Message }, statusCode: 500);
      }
      RosterOps.ClearLiveResearchJob(jobId);
      CharacterBehavior.ClearProgress(jobId);
    }
    return PeopleOps.ModelError(ex);
  }
}
