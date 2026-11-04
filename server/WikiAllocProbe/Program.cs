using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using SimCEO.Api;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

namespace WikiAllocProbe;

// Wiki allocation regression probe (code-only, in-process, memory mode).
// Exercises the ACTUAL production WikiSyncService + SourceGovernance stack with a
// fake Wiki.js GraphQL backend (in-process HttpMessageHandler) and validates with
// the REAL backup validator (SourceGovernance.ValidateRestoreGraph).
// Memory mode only: the PG (EF Transact) path shares the same Atomic unit boundary
// but is NOT executed here (label: PG unproved).
public static class Program
{
  static int _pass = 0, _fail = 0;
  static readonly List<string> _failures = new();

  static void Check(string name, bool cond, string extra = "")
  {
    if (cond) { _pass++; Console.WriteLine("  PASS " + name); }
    else { _fail++; _failures.Add(name + (extra == "" ? "" : " :: " + extra)); Console.WriteLine("  FAIL " + name + (extra == "" ? "" : " :: " + extra)); }
  }

  public static async Task<int> Main()
  {
    Console.WriteLine("wiki-alloc-probe: memory mode only (PG unproved)");
    await T1_PendingSecondVersionRoundtrip();
    await T2_DeletedTrailingVersionNoReuse();
    await T3_NoApprovedStub();
    await T4_MultiPageFailureRollback();
    await T5_TamperedGraphRejected();
    await T6_StartupMigrationRepairsLegacyGraph();
    Console.WriteLine("probe done: pass=" + _pass + " fail=" + _fail);
    foreach (var f in _failures) Console.WriteLine("FAILED: " + f);
    return _fail == 0 ? 0 : 1;
  }

  sealed record FakePage(string Path, string Locale, string Title, string Content, List<string> Tags);

  sealed class FakeWikiServer
  {
    public Dictionary<int, FakePage> Pages { get; } = new();
  }

  sealed class FakeWikiHandler : HttpMessageHandler
  {
    readonly FakeWikiServer _srv;
    public FakeWikiHandler(FakeWikiServer srv) { _srv = srv; }
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
      var body = await req.Content!.ReadAsStringAsync(ct).ConfigureAwait(false);
      using var doc = JsonDocument.Parse(body);
      var q = doc.RootElement.GetProperty("query").GetString() ?? "";
      var vars = doc.RootElement.GetProperty("variables");
      string json;
      if (q.Contains("WikiList"))
      {
        var items = _srv.Pages.OrderBy(kv => kv.Key)
          .Select(kv => new { id = kv.Key, path = kv.Value.Path, locale = kv.Value.Locale, title = kv.Value.Title, tags = kv.Value.Tags })
          .ToList();
        json = JsonSerializer.Serialize(new { data = new { pages = new { list = items } } });
      }
      else
      {
        var id = vars.GetProperty("id").GetInt32();
        if (!_srv.Pages.TryGetValue(id, out var pg))
          return new HttpResponseMessage(HttpStatusCode.NotFound);
        json = JsonSerializer.Serialize(new
        {
          data = new
          {
            pages = new
            {
              single = new
              {
                id,
                path = pg.Path,
                locale = pg.Locale,
                title = pg.Title,
                content = pg.Content,
                contentType = "markdown",
                updatedAt = "2026-01-01T00:00:00Z",
                tags = pg.Tags.Select(t => new { tag = t }).ToArray()
              }
            }
          }
        });
      }
      return new HttpResponseMessage(HttpStatusCode.OK)
      {
        Content = new StringContent(json, Encoding.UTF8, "application/json")
      };
    }
  }

  sealed record Fixture(InMemoryStore Store, WikiSyncService Sync, Guid BoardId, Guid ResourceId, FakeWikiServer Wiki);

  static Fixture Setup(string origin = "https://wiki.example.com")
  {
    var store = new InMemoryStore();
    var board = new Board { Name = "probe" };
    store.Boards[board.Id] = board;
    var res = new WikiResource
    {
      BoardId = board.Id, Scope = "board", BaseUrl = origin,
      Description = "probe handbook", AllowedUse = "probe lookup only",
      AllowlistJson = "[\"/guides/**\"]", ExclusionsJson = "[]",
      RequiredTagsJson = "[]", Locale = "", SyncIntervalMinutes = 60,
      ConfigRevision = 1, AttemptGeneration = 1, Enabled = true, LastStatus = "pending",
    };
    store.WikiResources[res.Id] = res;
    var creds = new WikiCredentialStore(new EphemeralDataProtectionProvider(), store);
    creds.SetToken(res.Id, "probe-token");
    var wiki = new FakeWikiServer();
    var sync = new WikiSyncService(store, creds, new SystemWikiClock(), (_, _) => new FakeWikiHandler(wiki));
    return new Fixture(store, sync, board.Id, res.Id, wiki);
  }

  static void Approve(InMemoryStore store, Guid sourceId, string name)
  {
    var ctx = new DefaultHttpContext();
    ctx.Request.Headers["X-User"] = "owner";
    var (ok, err, status) = SourceGovernance.TryApproveById(store, ctx.Request, sourceId);
    Check(name, ok, ok ? "" : (err + " (" + status + ")"));
  }

  static SourceFamilyHead? HeadOf(InMemoryStore s, Guid bid, string family)
    => s.SourceHeads.Values.FirstOrDefault(h => h.BoardId == bid && h.FamilyKey == family);

  static BackupSnapshot SnapOf(InMemoryStore s) => new BackupSnapshot(4, DateTime.UtcNow,
    s.Boards.Values.OrderBy(x => x.Id).ToList(),
    s.Roster.Values.OrderBy(x => x.Id).ToList(),
    s.Advisors.Values.OrderBy(x => x.Id).ToList(),
    s.Meetings.Values.OrderBy(x => x.Id).ToList(),
    new Dictionary<string, List<Message>>(),
    s.Notes.Values.OrderBy(x => x.Id).ToList(),
    s.Drafts.Values.OrderBy(x => x.Id).ToList(),
    s.Sources.Values.OrderBy(x => x.Id).ToList(),
    s.Sources.Values.OrderBy(x => x.Id).ToDictionary(x => x.Id.ToString(), x => x.Original is null ? "" : Convert.ToBase64String(x.Original)),
    s.LeadProfiles.Values.OrderBy(x => x.Id).ToList(),
    new List<BackupImage>(),
    null,
    s.SourceSections.Values.OrderBy(x => x.Id).ToList(),
    s.SourceHeads.Values.OrderBy(x => x.Id).ToList(),
    s.SourceEvents.Values.OrderBy(x => x.Id).ToList());

  static BackupSnapshot CloneSnap(BackupSnapshot s)
  {
    var json = JsonSerializer.Serialize(s);
    return JsonSerializer.Deserialize<BackupSnapshot>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
  }

  static InMemoryStore RestoreViaWire(BackupSnapshot snap)
  {
    var back = CloneSnap(snap);
    var f = new InMemoryStore();
    foreach (var b in back.boards) f.Boards[b.Id] = b;
    foreach (var x in back.sources) f.Sources[x.Id] = x;
    if (back.sections is not null) foreach (var x in back.sections) f.SourceSections[x.Id] = x;
    if (back.heads is not null) foreach (var x in back.heads) f.SourceHeads[x.Id] = x;
    if (back.events is not null) foreach (var x in back.events) f.SourceEvents[x.Id] = x;
    foreach (var kv in back.blobs)
      if (Guid.TryParse(kv.Key, out var bid2) && f.Sources.TryGetValue(bid2, out var doc) && !string.IsNullOrEmpty(kv.Value))
        doc.Original = Convert.FromBase64String(kv.Value);
    SourceGovernance.MigrateRestoredSources(f);
    return f;
  }

  static async Task<(Fixture fx, string fam)> SeedApprovedPlusPending(string seed, string v2content)
  {
    var fx = Setup();
    fx.Wiki.Pages[1] = new FakePage("/guides/a", "", "A", seed, new());
    var r1 = await fx.Sync.SyncAsync(fx.ResourceId, "seed1", "owner", false);
    if (!r1.ok) throw new Exception("seed sync1: " + r1.error);
    var v1 = fx.Store.Sources.Values.Single();
    Approve(fx.Store, v1.Id, "seed-approve-v1");
    fx.Wiki.Pages[1] = new FakePage("/guides/a", "", "A", v2content, new());
    var r2 = await fx.Sync.SyncAsync(fx.ResourceId, "seed2", "owner", false);
    if (!r2.ok) throw new Exception("seed sync2: " + r2.error);
    return (fx, v1.FamilyKey);
  }

  static async Task T1_PendingSecondVersionRoundtrip()
  {
    Console.WriteLine("T1 pending-second-version roundtrip");
    var (fx, fam) = await SeedApprovedPlusPending("alpha content version one", "alpha content version two");
    var docs = fx.Store.Sources.Values.OrderBy(d => d.Version).ToList();
    Check("t1-two-rows", docs.Count == 2, docs.Count.ToString());
    var v1 = docs[0]; var v2 = docs[1];
    Check("t1-v1-approved", v1.Version == 1 && v1.ReviewState == "approved" && v1.Approved, "v" + v1.Version + "/" + v1.ReviewState);
    Check("t1-v2-pending", v2.Version == 2 && v2.ReviewState == "pending" && !v2.Approved, "v" + v2.Version + "/" + v2.ReviewState);
    var h = HeadOf(fx.Store, fx.BoardId, fam);
    Check("t1-head-immutable", h is not null && h.HeadVersion == 1 && h.HeadSourceId == v1.Id, h is null ? "no head" : "hv" + h.HeadVersion);
    Check("t1-head-water-covers", h is not null && h.HighWater == 2 && h.FloorVersion == 1, h is null ? "no head" : "hw" + h.HighWater + " fl" + h.FloorVersion);
    var snap = SnapOf(fx.Store);
    Check("t1-export-validates", SourceGovernance.ValidateRestoreGraph(snap, out var verr), verr);
    var f = RestoreViaWire(snap);
    Check("t1-restored-validates", SourceGovernance.ValidateRestoreGraph(SnapOf(f), out var verr2), verr2);
    var rd = f.Sources.Values.OrderBy(d => d.Version).ToList();
    Check("t1-restored-versions", rd.Count == 2 && rd[0].Version == 1 && rd[1].Version == 2, rd.Count.ToString());
    Check("t1-restored-reviews", rd[0].ReviewState == "approved" && rd[1].ReviewState == "pending", rd[0].ReviewState + "/" + rd[1].ReviewState);
    var rh = HeadOf(f, fx.BoardId, fam);
    Check("t1-restored-head", rh is not null && rh.HeadVersion == 1 && rh.HighWater == 2, rh is null ? "no head" : "hv" + rh.HeadVersion + " hw" + rh.HighWater);
  }

  static async Task T2_DeletedTrailingVersionNoReuse()
  {
    Console.WriteLine("T2 deleted trailing version no reuse");
    var (fx, fam) = await SeedApprovedPlusPending("t2 content one", "t2 content two");
    var v2 = fx.Store.Sources.Values.Single(d => d.Version == 2);
    // Product has no row-delete endpoint (removal is exclusion); simulate a
    // trailing-row deletion in-process to prove the allocator never recycles.
    foreach (var sec in fx.Store.SourceSections.Values.Where(x => x.SourceId == v2.Id).ToList())
      fx.Store.SourceSections.TryRemove(sec.Id, out _);
    fx.Store.Sources.TryRemove(v2.Id, out _);
    foreach (var e in fx.Store.SourceEvents.Values.Where(x => x.SourceId == v2.Id).ToList())
      fx.Store.SourceEvents.TryRemove(e.Id, out _);
    fx.Wiki.Pages[1] = new FakePage("/guides/a", "", "A", "t2 content three", new());
    var r3 = await fx.Sync.SyncAsync(fx.ResourceId, "t2c", "owner", false);
    Check("t2-sync3-ok", r3.ok, r3.error ?? "");
    var latest = fx.Store.Sources.Values.OrderByDescending(d => d.Version).First();
    Check("t2-no-reuse", latest.Version == 3, "got v" + latest.Version);
    var h = HeadOf(fx.Store, fx.BoardId, fam);
    Check("t2-water-monotonic", h is not null && h.HighWater == 3 && h.HeadVersion == 1 && h.FloorVersion == 1,
      h is null ? "no head" : "hv" + h.HeadVersion + " hw" + h.HighWater + " fl" + h.FloorVersion);
    // A mid-history gap is NOT a state supported flows can create; the strict
    // validator must still reject it (tamper-grade strictness preserved).
    Check("t2-gap-rejected", !SourceGovernance.ValidateRestoreGraph(SnapOf(fx.Store), out var gerr) && gerr.Contains("skips version"), gerr);
  }

  static async Task T3_NoApprovedStub()
  {
    Console.WriteLine("T3 no-approved stub");
    var fx = Setup();
    fx.Wiki.Pages[7] = new FakePage("/guides/solo", "", "S", "solo pending content here", new());
    var r = await fx.Sync.SyncAsync(fx.ResourceId, "t3", "owner", false);
    Check("t3-sync-ok", r.ok, r.error ?? "");
    var doc = fx.Store.Sources.Values.Single();
    Check("t3-v1-pending", doc.Version == 1 && doc.ReviewState == "pending", "v" + doc.Version + "/" + doc.ReviewState);
    var stub = HeadOf(fx.Store, fx.BoardId, doc.FamilyKey);
    Check("t3-stub", stub is not null && stub.HeadVersion == 0 && stub.HeadSourceId == Guid.Empty && stub.HighWater == 1 && stub.FloorVersion == 1,
      stub is null ? "no head" : "hv" + stub.HeadVersion + " hw" + stub.HighWater + " fl" + stub.FloorVersion);
    Guid? meeting = doc.Scope == "meeting" ? doc.MeetingId : null;
    Check("t3-no-headship", !SourceGovernance.IsEligible(fx.Store, doc, meeting), "pending unexpectedly eligible");
    Check("t3-export-validates", SourceGovernance.ValidateRestoreGraph(SnapOf(fx.Store), out var verr), verr);
    var f = RestoreViaWire(SnapOf(fx.Store));
    Check("t3-restored-validates", SourceGovernance.ValidateRestoreGraph(SnapOf(f), out var verr2), verr2);
    var rstub = f.SourceHeads.Values.SingleOrDefault(h => h.BoardId == fx.BoardId);
    Check("t3-restored-stub", rstub is not null && rstub.HeadVersion == 0 && rstub.HighWater == 1 && rstub.FloorVersion == 1,
      rstub is null ? "no head" : "hv" + rstub.HeadVersion + " hw" + rstub.HighWater + " fl" + rstub.FloorVersion);
  }

  static async Task T4_MultiPageFailureRollback()
  {
    Console.WriteLine("T4 multi-page failure rollback");
    var fx = Setup();
    fx.Wiki.Pages[1] = new FakePage("/guides/a", "", "A", "t4 base content here", new());
    var r1 = await fx.Sync.SyncAsync(fx.ResourceId, "t4a", "owner", false);
    Check("t4-seed-ok", r1.ok, r1.error ?? "");
    var v1 = fx.Store.Sources.Values.Single();
    Approve(fx.Store, v1.Id, "t4-approve-v1");
    var fam = v1.FamilyKey;
    // Two NEW pages: first valid, second unindexable (whitespace-only content
    // passes the transport shape but stages zero sections). The whole attempt
    // must fail with zero partials and zero allocation mutation.
    fx.Wiki.Pages[2] = new FakePage("/guides/b", "", "B", "t4 second page content here", new());
    fx.Wiki.Pages[3] = new FakePage("/guides/c", "", "C", "   ", new());
    var r2 = await fx.Sync.SyncAsync(fx.ResourceId, "t4b", "owner", false);
    Check("t4-fails", !r2.ok, "unexpected ok");
    Check("t4-no-partials", fx.Store.Sources.Values.Count == 1, fx.Store.Sources.Values.Count.ToString());
    var h = HeadOf(fx.Store, fx.BoardId, fam);
    Check("t4-water-untouched", h is not null && h.HighWater == 1, h is null ? "no head" : "hw" + h.HighWater);
    var strayHeads = fx.Store.SourceHeads.Values.Where(x => x.FamilyKey != fam).ToList();
    Check("t4-no-stray-heads", strayHeads.Count == 0, strayHeads.Count.ToString());
    var res = fx.Store.WikiResources[fx.ResourceId];
    Check("t4-failed-health", res.LastStatus == "failed", res.LastStatus ?? "");
    // The allocator boundary itself rolls back: reserve-then-throw leaves no water.
    var hwBefore = h!.HighWater;
    try
    {
      Atomic.Run(fx.Store, () =>
      {
        SourceGovernance.ReserveVersion(fx.Store, fx.BoardId, fam);
        throw new InvalidOperationException("injected post-reservation fault");
      });
      Check("t4-atomic-throws", false, "no throw");
    }
    catch (InvalidOperationException) { Check("t4-atomic-throws", true); }
    var hAfter = HeadOf(fx.Store, fx.BoardId, fam);
    Check("t4-atomic-rollback", hAfter is not null && hAfter.HighWater == hwBefore, hAfter is null ? "no head" : "hw" + hAfter.HighWater);
  }

  static async Task T5_TamperedGraphRejected()
  {
    Console.WriteLine("T5 tampered graph rejected");
    var (fx, fam) = await SeedApprovedPlusPending("t5 content one", "t5 content two");
    var good = SnapOf(fx.Store);
    Check("t5-good-validates", SourceGovernance.ValidateRestoreGraph(good, out var gerr), gerr);
    // (a) lowered high-water no longer covers the family: versions recyclable.
    var low = CloneSnap(good);
    var lhead = low.heads!.Single(h => h.FamilyKey == fam);
    lhead.HighWater = 1;
    Check("t5-low-water-rejected", !SourceGovernance.ValidateRestoreGraph(low, out var lerr) && lerr.Contains("high-water"), lerr);
    // (b) member deleted post-export while history still expects it.
    var cut = CloneSnap(good);
    var victim = cut.sources.First(d => d.Version == 1);
    cut.sources.Remove(victim);
    if (cut.sections is not null) cut.sections.RemoveAll(x => x.SourceId == victim.Id);
    if (cut.events is not null) cut.events.RemoveAll(x => x.SourceId == victim.Id);
    Check("t5-cut-member-rejected", !SourceGovernance.ValidateRestoreGraph(cut, out var cerr), cerr);
  }

  static async Task T6_StartupMigrationRepairsLegacyGraph()
  {
    Console.WriteLine("T6 startup migration repairs legacy graph");
    var (fx, fam) = await SeedApprovedPlusPending("t6 content one", "t6 content two");
    var h = HeadOf(fx.Store, fx.BoardId, fam)!;
    // Simulate the pre-fix invalid live graph (hw:1 hv:1 fmax:2): the repair
    // input is crafted in-process; the REPAIR itself is the product migration.
    h.HighWater = 1;
    Check("t6-legacy-invalid", !SourceGovernance.ValidateRestoreGraph(SnapOf(fx.Store), out var lerr), lerr);
    SourceGovernance.MigrateStore(fx.Store);
    var h2 = HeadOf(fx.Store, fx.BoardId, fam)!;
    Check("t6-water-repaired", h2.HighWater == 2, "hw" + h2.HighWater);
    Check("t6-head-untouched", h2.HeadVersion == 1 && h2.FloorVersion == 1, "hv" + h2.HeadVersion + " fl" + h2.FloorVersion);
    var docs = fx.Store.Sources.Values.OrderBy(d => d.Version).ToList();
    Check("t6-rows-untouched", docs.Count == 2 && docs[0].ReviewState == "approved" && docs[1].ReviewState == "pending",
      string.Join(",", docs.Select(d => "v" + d.Version + "/" + d.ReviewState)));
    Check("t6-export-validates", SourceGovernance.ValidateRestoreGraph(SnapOf(fx.Store), out var verr), verr);
  }
}
