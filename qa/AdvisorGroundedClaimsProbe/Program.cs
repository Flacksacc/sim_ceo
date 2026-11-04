using SimCEO.Api;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

static class Probe
{
  static int pass = 0;
  static int fail = 0;
  static void Ok(string name, bool cond, string extra = "")
  {
    if (cond) { pass++; Console.WriteLine("PASS " + name); }
    else { fail++; Console.WriteLine("FAIL " + name + (extra == "" ? "" : " :: " + extra)); }
  }

  static Dictionary<string, List<PoolPassage>> Multi(params (string url, string title, string excerpt, bool fetched, string origin)[] items)
  {
    var d = new Dictionary<string, List<PoolPassage>>(StringComparer.Ordinal);
    foreach (var (u, t, e, f, o) in items)
    {
      if (!d.TryGetValue(u, out var list)) { list = new List<PoolPassage>(); d[u] = list; }
      list.Add(new PoolPassage(t, e, f, o));
    }
    return d;
  }

  static int Main()
  {
    var sidEmpty = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    // F1a: provider snippet without fetch carries provenance but not fetch.
    {
      var pool = Multi(("https://qa.example/s1", "QA source one", "QA excerpt one about ports.", false, "provider-search"));
      var vc = ClaimEvidenceMapper.MapOne("FACT | QA port claim || EVIDENCE: https://qa.example/s1 :: \"QA excerpt one about ports.\"", pool, sidEmpty);
      Ok("f1-snippet-provenance-verified", vc.Verified, "v=" + vc.Verified);
      Ok("f1-snippet-not-fetched", vc.Verified && !vc.Refs[0].Fetched && vc.Refs[0].Origin == "provider-search", "fetched=" + (vc.Verified ? vc.Refs[0].Fetched.ToString() : "?"));
      var need = ClaimEvidenceMapper.CollectUnfetchedUrls(new[] { "FACT | QA port claim || EVIDENCE: https://qa.example/s1 :: \"QA excerpt one about ports.\"" }, pool, sidEmpty);
      Ok("f1-snippet-still-needs-fetch", need.Count == 1 && ClaimEvidenceMapper.UrlsMatch(need[0], "https://qa.example/s1"), "need=" + string.Join(",", need));
    }

    // F1b: failed owner fetch followed by provider snippet stays unfetched.
    {
      var pool = Multi(("https://owner.example/doc", "Owner doc", "Provider snippet about harbors.", false, "provider-search"));
      var vc = ClaimEvidenceMapper.MapOne("FACT | Harbor claim || EVIDENCE: https://owner.example/doc :: \"Provider snippet about harbors.\"", pool, sidEmpty);
      Ok("f1-failed-owner-snippet-verified", vc.Verified, "v=" + vc.Verified);
      Ok("f1-failed-owner-snippet-unfetched", vc.Verified && !vc.Refs[0].Fetched, "fetched wrong");
    }

    // F1c: actual successful fetch marks fetched.
    {
      var pool = Multi(("https://owner.example/doc", "Owner doc", "Owner fetched passage about harbors and ports.", true, "owner-fetch"));
      var vc = ClaimEvidenceMapper.MapOne("FACT | Harbor claim || EVIDENCE: https://owner.example/doc :: \"fetched passage about harbors\"", pool, sidEmpty);
      Ok("f1-fetched-verified", vc.Verified, "v=" + vc.Verified);
      Ok("f1-fetched-flag", vc.Verified && vc.Refs[0].Fetched && vc.Refs[0].Origin == "owner-fetch", "origin=" + (vc.Verified ? vc.Refs[0].Origin : "?"));
      var need = ClaimEvidenceMapper.CollectUnfetchedUrls(new[] { "FACT | Harbor claim || EVIDENCE: https://owner.example/doc :: \"fetched passage about harbors\"" }, pool, sidEmpty);
      Ok("f1-fetched-no-refetch", need.Count == 0, "need=" + string.Join(",", need));
    }

    // F1d: two distinct passages from same URL both retained.
    {
      var pool = Multi(
        ("https://qa.example/s1", "QA source one", "First passage about port risk management.", true, "owner-fetch"),
        ("https://qa.example/s1", "QA source one", "Second passage about crew coordination.", false, "provider-search"));
      var lines = new[] {
        "FACT | Port risk claim || EVIDENCE: https://qa.example/s1 :: \"First passage about port risk\"",
        "INTERPRETATION | Crew read || EVIDENCE: https://qa.example/s1 :: \"Second passage about crew coordination\"" };
      var mapped = ClaimEvidenceMapper.MapAll(lines, pool, sidEmpty);
      Ok("f1-multi-both-verified", mapped.Count == 2 && mapped.All(v => v.Verified), "count=" + mapped.Count);
      Ok("f1-multi-origins", mapped[0].Refs[0].Fetched && !mapped[1].Refs[0].Fetched, "f0=" + mapped[0].Refs[0].Fetched + " f1=" + mapped[1].Refs[0].Fetched);
    }

    // F4: strict URI identity.
    {
      Ok("f4-host-case-equal", ClaimEvidenceMapper.UrlsMatch("HTTPS://EXAMPLE.COM/Path", "https://example.com/Path"), "host case should match");
      Ok("f4-path-case-distinct", !ClaimEvidenceMapper.UrlsMatch("https://example.com/Case", "https://example.com/case"), "path case must differ");
      Ok("f4-query-case-distinct", !ClaimEvidenceMapper.UrlsMatch("https://example.com/p?A=1", "https://example.com/p?a=1"), "query case must differ");
      Ok("f4-trailing-slash-distinct", !ClaimEvidenceMapper.UrlsMatch("https://example.com/page", "https://example.com/page/"), "slash must differ");
      var pool = Multi(("https://example.com/Case", "T", "Excerpt about Case sensitive path.", true, "owner-fetch"));
      var good = ClaimEvidenceMapper.MapOne("FACT | X || EVIDENCE: https://example.com/Case :: \"Excerpt about Case sensitive\"", pool, sidEmpty);
      var bad = ClaimEvidenceMapper.MapOne("FACT | X || EVIDENCE: https://example.com/case :: \"Excerpt about Case sensitive\"", pool, sidEmpty);
      Ok("f4-path-map-exact", good.Verified, "exact should verify");
      Ok("f4-path-map-wrong-case", !bad.Verified, "wrong case must not inherit");
      var sid = ClaimEvidenceMapper.BuildSidMap(new List<string> { "https://owner.example/a" });
      Ok("f4-sid-resolve", sid.ContainsKey("S1") && ClaimEvidenceMapper.TryResolveUrl("S1", sid, out var ru) && ru == "https://owner.example/a", "sid fail");
    }

    // F5: discovered-source inventory + strict distinct count.
    {
      Ok("f5-strict-count", CharacterResearch.CountDistinctUrls(new[] { "https://example.com/page", "https://example.com/page/", "https://example.com/page" }) == 2, "distinct count wrong");
      var src = File.ReadAllText("server/SimCEO.Api/Work/CharacterResearch.cs");
      Ok("f5-discovered-added-to-inventory", src.Contains("AddCitedUrl(h.Url)"), "missing AddCitedUrl for hydrated");
      Ok("f5-evidence-honest-fields", src.Contains("origin = PoolOriginFor") && src.Contains("fetched = IsUrlFetched"), "evidenceRefs missing honest fields");
    }

    // F6: fact/interpretation/unverified distinction preserved.
    {
      var pool = Multi(
        ("https://qa.example/s1", "S1", "QA excerpt one about ports.", true, "owner-fetch"),
        ("https://qa.example/s2", "S2", "QA excerpt two about crew.", true, "owner-fetch"));
      var lines = new[] {
        "FACT | QA grounded claim line one about port risk || EVIDENCE: https://qa.example/s1 :: \"QA excerpt one about ports.\"",
        "INTERPRETATION | QA grounded interpretation line two about crew || EVIDENCE: https://qa.example/s2 :: \"QA excerpt two about crew.\"",
        "Just an unsupported note with no evidence." };
      var mapped = ClaimEvidenceMapper.MapAll(lines, pool, sidEmpty);
      Ok("f6-fact-kind", mapped[0].Verified && mapped[0].Kind == "fact", "kind=" + mapped[0].Kind);
      Ok("f6-interp-kind", mapped[1].Verified && mapped[1].Kind == "interpretation", "kind=" + mapped[1].Kind);
      Ok("f6-unverified-kind", !mapped[2].Verified && mapped[2].Kind == "unverified", "kind=" + mapped[2].Kind);
      var researchSrc = File.ReadAllText("server/SimCEO.Api/Work/CharacterResearch.cs");
      Ok("f6-angle-interpretation", researchSrc.Contains("dossier [interpretation]"), "missing interpretation angle");
      var fe = File.ReadAllText("web/src/advisor-creation.tsx");
      Ok("f6-frontend-kind", fe.Contains("claimDisplayKind") && fe.Contains("Interpretation") && fe.Contains("Unsupported"), "frontend missing kind display");
      var app = File.ReadAllText("web/src/App.tsx");
      Ok("f6-dossier-kind", app.Contains("displayKind") && app.Contains("Interpretation") && app.Contains("provenanceCaption"), "dossier view missing kind");
    }

    // F2: ai-draft structured prompt + map BEFORE compile.
    {
      var dp = RosterEndpoints.BuildAiDraftDossierPrompt("QA Name", "Harbor Role", "port focus");
      Ok("f2-dossier-format", dp.Contains("KIND |") && dp.Contains("EVIDENCE:") && dp.Contains("exact supporting quote"), "prompt=" + dp.Substring(0, Math.Min(120, dp.Length)));
      Ok("f2-dossier-no-plain", !dp.Contains("One claim per line.") || dp.Contains("EXACT format"), "still plain guidance");
      var grounded = "FACT | QA grounded claim line one about port risk || EVIDENCE: https://qa.example/s1 :: \"QA excerpt one.\"";
      var pp = RosterEndpoints.BuildAiDraftProfilePrompt("QA Name", "Harbor Role", "port focus", grounded);
      Ok("f2-profile-uses-grounded", pp.Contains("QA grounded claim line one") && pp.Contains("Verified grounded claims"), "profile missing grounded");
      var ppEmpty = RosterEndpoints.BuildAiDraftProfilePrompt("QA Name", "Harbor Role", "port focus", "");
      Ok("f2-profile-empty-honest", ppEmpty.Contains("no verified grounded claims"), "empty should be honest");
      var epSrc = File.ReadAllText("server/SimCEO.Api/Work/RosterEndpoints.cs");
      int iDossier = epSrc.IndexOf("aiDossierPrompt", StringComparison.Ordinal);
      int iMap = epSrc.IndexOf("aiValidated = ", StringComparison.Ordinal);
      int iProfile = epSrc.IndexOf("aiProfilePrompt", StringComparison.Ordinal);
      Ok("f2-order-map-before-compile", iDossier >= 0 && iMap > iDossier && iProfile > iMap, "order wrong");
      Ok("f2-profile-filtered-input", epSrc.Contains("BuildAiDraftProfilePrompt(name, role, focus, groundedDossier)") && !epSrc.Contains("Research notes: \" + dossier.Text"), "profile still uses raw text");
    }

    // F3: unsupported terminal + staging allowed + approval blocked (actual commit path).
    {
      var store = new InMemoryStore();
      var idU = Guid.NewGuid();
      var unsupportedJson = System.Text.Json.JsonSerializer.Serialize(new { draftStatus = "unsupported", note = "unsupported draft" });
      Atomic.Run(store, () => {
        store.Roster[idU] = new RosterEntry { Id = idU, Name = "U", Description = "desc desc desc desc desc", ProfileJson = new string('x', 40), Version = 1, ResearchJson = unsupportedJson, ResearchedAt = null, ResearchRequested = true, EvidenceCount = 0 };
      });
      store.Roster.TryGetValue(idU, out var ue);
      Ok("f3-terminal-unsupported", RosterOps.ResearchTerminalStatus(ue!) == "unsupported", "term=" + RosterOps.ResearchTerminalStatus(ue!));
      Ok("f3-reason-unsupported", RosterOps.ResearchMissingReason(store, ue!).Contains("unsupported"), "reason=" + RosterOps.ResearchMissingReason(store, ue!));
      var (dokU, missU) = RosterOps.DataCompleteness(store, idU);
      Ok("f3-staging-allowed", dokU, "missing=" + string.Join(",", missU));
      var boardId = Guid.NewGuid();
      Atomic.Run(store, () => { store.Boards[boardId] = new Board { Id = boardId, Name = "B" }; });
      var advU = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = boardId, RosterEntryId = idU, RosterVersion = 1 };
      var gateU = RosterOps.ApprovalGate(store, advU);
      Ok("f3-approval-blocked", gateU == "research-unsupported", "gate=" + gateU);
      var epSrc2 = File.ReadAllText("server/SimCEO.Api/Work/RosterEndpoints.cs");
      Ok("f3-persists-draftstatus", epSrc2.Contains("draftStatus = aiSupported") || epSrc2.Contains("draftStatus"), "missing draftStatus persist");
      Ok("f3-response-from-commit", epSrc2.Contains("researched = aiCommittedSupported") || epSrc2.Contains("researched = aiSupported"), "response still RanSearch");
    }

    // F8: delivered prompt budget — max inputs still deliver format + SID bindings.
    {
      var maxBg = new string('b', CharacterBehavior.MaxBackgroundChars);
      var maxFocus = new string('f', CharacterBehavior.MaxFocusChars);
      var maxDesc = new string('d', 4000);
      var longUrls = new List<string>();
      for (int i = 0; i < 5; i++) longUrls.Add("https://example.com/" + new string('u', 1500) + i);
      var fetched = new Dictionary<string, (string Title, string Excerpt)>(StringComparer.OrdinalIgnoreCase);
      fetched[longUrls[0]] = ("T", new string('e', 2000));
      var prompt = CharacterResearch.BuildDossierPrompt("Subject Name (FictionalCharacter)", maxFocus, maxDesc, maxBg, longUrls, fetched);
      var budget = CharacterResearch.DossierPromptBudgetChars();
      Ok("f8-budget-fit", prompt.Length <= budget, "len=" + prompt.Length + " budget=" + budget);
      Ok("f8-format-delivered", prompt.Contains("EXACT format") && prompt.Contains("KIND |") && prompt.Contains("EVIDENCE:") && prompt.Contains("Do not use VERIFIED"), "format truncated");
      bool sidsOk = true;
      for (int i = 0; i < 5; i++) { if (!prompt.Contains("S" + (i + 1)) || !prompt.Contains(longUrls[i].Substring(0, 60))) sidsOk = false; }
      Ok("f8-sid-bindings", sidsOk, "SID bindings lost");
      Ok("f8-ends-with-format", prompt.Contains("Distinguish facts from interpretation"), "tail format missing");
    }

    // Fixtures: structured per-claim quotes retained + lifecycle assertions intact.
    {
      var fake = File.ReadAllText("qa/fake-provider.mjs");
      var ifake = File.ReadAllText("qa/advisor-integrated-fake.mjs");
      Ok("fix-fake-structured", fake.Contains("EVIDENCE:") && fake.Contains("FACT |") && fake.Contains("INTERPRETATION |"), "fake not structured");
      Ok("fix-ifake-structured", ifake.Contains("EVIDENCE:") && ifake.Contains("FACT |") && ifake.Contains("INTERPRETATION |"), "ifake not structured");
      Ok("fix-fake-quotes", fake.Contains("QA excerpt one.") && fake.Contains("QA excerpt two."), "quotes missing");
      var integ = File.ReadAllText("qa/advisor-integrated-qa.mjs");
      var charQa = File.ReadAllText("qa/character-advisor-qa.mjs");
      Ok("fix-assert-updated", integ.Contains("Verified grounded claims") && charQa.Contains("Verified grounded claims"), "assertions still old wording");
    }

    // Architecture preserved: two calls max, 180s bound, no third validator.
    {
      var src = File.ReadAllText("server/SimCEO.Api/Work/CharacterResearch.cs");
      int groundedCalls = 0, compileCalls = 0, j = 0;
      while ((j = src.IndexOf("CompleteGroundedAsync", j, StringComparison.Ordinal)) >= 0) { groundedCalls++; j += 10; }
      j = 0;
      while ((j = src.IndexOf("CompleteAsync", j, StringComparison.Ordinal)) >= 0) { compileCalls++; j += 10; }
      // CompleteGroundedAsync does not contain CompleteAsync as a substring (Grounded intervenes); no subtract.
      Ok("arch-two-calls", groundedCalls == 1 && compileCalls == 1, "g=" + groundedCalls + " c=" + compileCalls);
      Ok("arch-deadline", CharacterBehavior.ResearchDeadline.TotalSeconds <= 180, "deadline=" + CharacterBehavior.ResearchDeadline.TotalSeconds);
      var epSrc3 = File.ReadAllText("server/SimCEO.Api/Work/RosterEndpoints.cs");
      int aiStart = epSrc3.IndexOf("/api/roster/ai-draft", StringComparison.Ordinal);
      int aiEnd = epSrc3.IndexOf("MapPost(\"/api/boards/", aiStart + 1, StringComparison.Ordinal);
      if (aiEnd < 0) aiEnd = epSrc3.Length;
      var aiBlock = aiStart >= 0 ? epSrc3.Substring(aiStart, aiEnd - aiStart) : "";
      int g2 = 0, c2 = 0, k = 0;
      while ((k = aiBlock.IndexOf("CompleteGroundedAsync", k, StringComparison.Ordinal)) >= 0) { g2++; k += 10; }
      k = 0;
      while ((k = aiBlock.IndexOf(".CompleteAsync(", k, StringComparison.Ordinal)) >= 0) { c2++; k += 10; }
      Ok("arch-aidraft-two-calls", g2 == 1 && c2 == 1, "g=" + g2 + " c=" + c2);
    }

    Console.WriteLine(pass + " passed, " + fail + " failed");
    return fail == 0 ? 0 : 1;
  }
}
