using SimCEO.Api;
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

  static Dictionary<string, (string Title, string Excerpt)> PoolOf(params (string url, string title, string excerpt)[] items)
  {
    var d = new Dictionary<string, (string Title, string Excerpt)>(StringComparer.OrdinalIgnoreCase);
    foreach (var (u, t, e) in items) d[u] = (t, e);
    return d;
  }

  static int Main()
  {
    // 1: top3 same cites unrelated negative (legacy VERIFIED lines, no EVIDENCE part).
    {
      var pool = PoolOf(
        ("https://theopenreader.org/Encyclopedia:Sherlock_Holmes", "Sherlock Holmes", ""),
        ("https://www.laphamsquarterly.org/node/10081", "Welcome to Baker Street", "Despite the success of the Sherlock Holmes stories, Doyle himself did not rate them highly."),
        ("https://mysterytribune.com/is-sherlock-holmes-real/", "Is Sherlock Holmes Real?", "So, Is Sherlock Holmes Real?"));
      var sid = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      var lines = new List<string>();
      for (int i = 0; i < 12; i++) lines.Add("VERIFIED: Distinct fact number " + i + " about publication and methods.");
      var mapped = ClaimEvidenceMapper.MapAll(lines, pool, sid);
      Ok("top3-same-unrelated-all-unverified", mapped.Count == 12 && mapped.All(v => !v.Verified && v.Refs.Count == 0), "verified=" + mapped.Count(v => v.Verified));
      Ok("top3-same-no-false-grounded", !mapped.Any(v => v.Verified), "any verified is false complete");
    }

    // 2: empty / unfetched / unknown URL / quote-mismatch duplicates unsupported.
    {
      var pool = PoolOf(
        ("https://example.com/a", "A", "Holmes lived at 221B Baker Street with Dr Watson."),
        ("https://example.com/empty", "E", ""),
        ("https://example.com/b", "B", "Unrelated page about baking bread and ovens."));
      var sid = ClaimEvidenceMapper.BuildSidMap(new List<string> { "https://example.com/a", "https://example.com/empty" });
      var lines = new List<string>
      {
        "FACT | Holmes lived at 221B Baker Street || EVIDENCE: S1 :: \"Holmes lived at 221B Baker Street with Dr Watson.\"",
        "FACT | Holmes lived at 221B Baker Street || EVIDENCE: S2 :: \"something that was never fetched\"",
        "FACT | Holmes lived at 221B Baker Street || EVIDENCE: https://unknown.example.com/x :: \"Holmes lived at 221B Baker Street with Dr Watson.\"",
        "FACT | Holmes lived at 221B Baker Street || EVIDENCE: https://example.com/a :: \"Baking bread in stone ovens at dawn.\"",
        "FACT | Holmes lived at 221B Baker Street || EVIDENCE: https://example.com/b :: \"Holmes lived at 221B Baker Street with Dr Watson.\"",
        "FACT | Duplicate good claim || EVIDENCE: S1 :: \"Holmes lived at 221B Baker Street with Dr Watson.\"",
        "FACT | Duplicate good claim || EVIDENCE: S1 :: \"Holmes lived at 221B Baker Street with Dr Watson.\"",
      };
      var mapped = ClaimEvidenceMapper.MapAll(lines, pool, sid);
      Ok("empty-unfetched-unknown-mismatch-first-verified", mapped[0].Verified && mapped[0].Refs.Count == 1 && mapped[0].Refs[0].Url == "https://example.com/a", "v=" + mapped[0].Verified);
      Ok("empty-excerpt-unsupported", !mapped[1].Verified && mapped[1].Refs.Count == 0, "v=" + mapped[1].Verified);
      Ok("unknown-url-unsupported", !mapped[2].Verified, "v=" + mapped[2].Verified);
      Ok("quote-mismatch-unsupported", !mapped[3].Verified, "v=" + mapped[3].Verified);
      Ok("wrong-source-quote-unsupported", !mapped[4].Verified, "v=" + mapped[4].Verified);
      Ok("duplicates-each-validated", mapped[5].Verified && mapped[6].Verified, "v5=" + mapped[5].Verified + " v6=" + mapped[6].Verified);
    }

    // 3: two distinct claims exact correct quotes plus sources.
    {
      var pool = PoolOf(
        ("https://en.wikipedia.org/wiki/Sherlock_Holmes", "Sherlock Holmes - Wikipedia", "Sherlock Holmes Sherlock Holmes character First appearance A Study in Scarlet (1887) Created by Sir Arthur Conan Doyle"),
        ("https://www.gutenberg.org/ebooks/1661", "Adventures", "It is a capital mistake to theorise before one has data."));
      var sid = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      var lines = new List<string>
      {
        "FACT | Holmes first appeared in A Study in Scarlet (1887) || EVIDENCE: https://en.wikipedia.org/wiki/Sherlock_Holmes :: \"First appearance A Study in Scarlet (1887)\"",
        "FACT | Canonical caution is a capital mistake to theorise before data || EVIDENCE: https://www.gutenberg.org/ebooks/1661 :: \"It is a capital mistake to theorise before one has data\"",
      };
      var mapped = ClaimEvidenceMapper.MapAll(lines, pool, sid);
      Ok("two-distinct-both-verified", mapped.Count == 2 && mapped.All(v => v.Verified), "count=" + mapped.Count);
      Ok("two-distinct-urls-preserved", mapped[0].Refs[0].Url.Contains("wikipedia") && mapped[1].Refs[0].Url.Contains("gutenberg"), mapped[0].Refs[0].Url + " / " + mapped[1].Refs[0].Url);
      Ok("two-distinct-quotes-exact", mapped[0].Refs[0].Quote.Contains("A Study in Scarlet") && mapped[1].Refs[0].Quote.Contains("capital mistake"), mapped[0].Refs[0].Quote + " / " + mapped[1].Refs[0].Quote);
      // whitespace-normalized exactness: extra spaces still validate
      var ws = ClaimEvidenceMapper.MapOne("FACT | X || EVIDENCE: https://en.wikipedia.org/wiki/Sherlock_Holmes :: \"First   appearance  A Study in Scarlet (1887)\"", pool, sid);
      Ok("whitespace-normalized-quote", ws.Verified, "ws failed");
    }

    // 4: owner links preserved but seed-only not grounded.
    {
      var owner = new List<string> { "https://en.wikipedia.org/wiki/Sherlock_Holmes", "https://www.gutenberg.org/ebooks/1661" };
      var sid = ClaimEvidenceMapper.BuildSidMap(owner);
      Ok("sid-map-covers-owners", sid.Count == 2 && sid["S1"] == owner[0] && sid["S2"] == owner[1], "sid count=" + sid.Count);
      var pool = PoolOf(
        (owner[0], "Wiki", "Sherlock Holmes character First appearance A Study in Scarlet (1887)"),
        (owner[1], "Gutenberg", "Readers also downloaded Detective Fiction"));
      // seed-only: model returned plain lines with no EVIDENCE part
      var seedLines = new List<string> { "Holmes is a consulting detective.", "He lives at 221B Baker Street." };
      var mapped = ClaimEvidenceMapper.MapAll(seedLines, pool, sid);
      Ok("seed-only-unverified", mapped.All(v => !v.Verified), "seed falsely grounded");
      Ok("seed-only-grounded-false", !mapped.Any(v => v.Verified), "seed complete would be false");
      // JSON format also supported
      var jsonLine = "{\"text\":\"Holmes first appeared in 1887\",\"kind\":\"fact\",\"refs\":[{\"url\":\"" + owner[0] + "\",\"quote\":\"First appearance A Study in Scarlet (1887)\"}]}";
      var jm = ClaimEvidenceMapper.MapOne(jsonLine, pool, sid);
      Ok("json-format-verified", jm.Verified && jm.Refs.Count == 1, "json v=" + jm.Verified);
    }

    // 5: compile prompt carries grounded content + current paras, forbids label directives.
    {
      var grounded = "FACT | Holmes first appeared in A Study in Scarlet (1887) || EVIDENCE: https://en.wikipedia.org/wiki/Sherlock_Holmes :: \"First appearance A Study in Scarlet (1887)\"";
      var current = " Current saved behavior to refine (keep explicit user wording unless evidence contradicts it): [keep this user sentence | second | third].";
      var compiled = CharacterResearch.BuildCompileInput("test focus", "Sherlock Holmes", "Seed description text.", "Owner background text.", current, grounded);
      Ok("compile-nonnull", compiled is not null, "null means budget fail");
      if (compiled is not null)
      {
        Ok("compile-has-grounded", compiled.Contains("A Study in Scarlet"), "missing grounded");
        Ok("compile-has-current", compiled.Contains("keep this user sentence"), "missing current behavior");
        Ok("compile-has-seed", compiled.Contains("Seed description text"), "missing seed");
        Ok("compile-forbids-label-copy", compiled.Contains("do NOT copy uppercase labels") || compiled.Contains("do NOT copy"), "missing label prohibition");
        Ok("compile-limits-honest", compiled.Contains("never invent real-world credentials") || compiled.Contains("never claim real employment"), "missing limits");
        Ok("compile-no-mandatory-verified-directive", !compiled.Contains("Mark grounded facts vs interpretation honestly"), "old directive still present");
        Ok("compile-natural-voice", compiled.Contains("natural") || compiled.Contains("plainly") || compiled.Contains("conditional"), "missing natural voice rule");
      }
      // absurd dossier alone exceeds budget => explicit null (no silent cut)
      var huge = new string('x', 90000);
      var over = CharacterResearch.BuildCompileInput("f", "n", "d", "b", "", huge);
      Ok("compile-budget-fail-closed", over is null, "huge dossier should fail, not truncate");
    }

    // 6: architecture bounds - at most TWO model calls, <=180s deadline.
    {
      var deadline = CharacterBehavior.ResearchDeadline;
      Ok("deadline-bounded-180", deadline.TotalSeconds <= 180 && deadline.TotalSeconds > 0, "deadline=" + deadline.TotalSeconds);
      var src = File.ReadAllText("server/SimCEO.Api/Work/CharacterResearch.cs");
      int groundedCalls = CountOccurrences(src, "CompleteGroundedAsync");
      int compileCalls = CountOccurrences(src, "CompleteAsync");
      // One grounded dossier call + one paragraph compile call; FailTerminal/others use no LLM.
      Ok("two-model-calls-only", groundedCalls == 1 && compileCalls == 1, "grounded=" + groundedCalls + " compile=" + compileCalls);
      Ok("single-fetch-round-no-recursion", !src.Contains("Recursive") && CountOccurrences(src, "HydrateAsync") <= 2, "hydrate count off");
      Ok("no-extra-llm-validation", !src.Contains("CompleteGroundedAsync") || groundedCalls == 1, "extra llm");
    }

    Console.WriteLine(pass + " passed, " + fail + " failed");
    return fail == 0 ? 0 : 1;
  }

  static int CountOccurrences(string hay, string needle)
  {
    int n = 0; int i = 0;
    while ((i = hay.IndexOf(needle, i, StringComparison.Ordinal)) >= 0) { n++; i += needle.Length; }
    return n;
  }
}
