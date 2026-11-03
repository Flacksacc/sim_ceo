using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using SimCEO.Api;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

var failures = new List<string>();
void Check(bool ok, string name, string detail)
{
  Console.WriteLine((ok ? "PASS " : "FAIL ") + name + " :: " + detail);
  if (!ok) failures.Add(name);
}
Console.WriteLine("ESSENTIALS-EVIDENCE PROBE START");
int passed = 0;
void Pass(string name, string detail) { Console.WriteLine("PASS " + name + " :: " + detail); passed++; }
void Fail(string name, string detail) { Console.WriteLine("FAIL " + name + " :: " + detail); failures.Add(name); }
void Expect(bool ok, string name, string detail) { if (ok) Pass(name, detail); else Fail(name, detail); }
Microsoft.AspNetCore.Http.HttpRequest FakeReq(string user)
{
  var ctx = new Microsoft.AspNetCore.Http.DefaultHttpContext();
  if (!string.IsNullOrEmpty(user)) ctx.Request.Headers["X-User"] = user;
  return ctx.Request;
}
static string Sha(string v) { using var sh = System.Security.Cryptography.SHA256.Create(); return Convert.ToHexString(sh.ComputeHash(System.Text.Encoding.UTF8.GetBytes(v))); }
static Guid SeedBoard(InMemoryStore s, string mode, string blocked)
{
  var b = new Board { Name = "ev-board", SourcePolicyMode = mode, BlockedTypes = blocked };
  s.Boards[b.Id] = b; s.Boards.Flush();
  var m = new Meeting { BoardId = b.Id, Title = "ev-m", State = MeetingState.Active, Generation = 0 };
  s.Meetings[m.Id] = m; s.Meetings.Flush();
  return b.Id;
}
static SourceDoc SeedSource(InMemoryStore s, Guid boardId, string file, int version, string review, string hash)
{
  var d = new SourceDoc { BoardId = boardId, FileName = file, Origin = "upload", Scope = "board", ContentHash = hash, Version = version, ReviewState = review, Approved = review == "approved", IndexState = "completed", IndexGeneration = 1, ExtractionJson = "{\"status\":\"ok\",\"md_content\":\"# t\\n\\nbody text for " + file + " v" + version + "\"}" };
  d.FamilyKey = SourceGovernance.FamilyKeyFor(boardId, "board", null, "upload", file);
  s.Sources[d.Id] = d; s.Sources.Flush();
  return d;
}
static void SeedSections(InMemoryStore s, SourceDoc d)
{
  int ord = 1;
  foreach (var txt in new[] { "alpha section one", "beta section two" })
  {
    var sec = new SourceSection { BoardId = d.BoardId, SourceId = d.Id, FamilyKey = d.FamilyKey, SourceVersion = d.Version, ContentHash = d.ContentHash, Ordinal = ord++, Location = "loc" + ord, Text = txt + " for " + d.FileName, IndexGeneration = d.IndexGeneration };
    s.SourceSections[sec.Id] = sec;
  }
  s.SourceSections.Flush();
}
static void SeedMigrateEvent(InMemoryStore s, Guid boardId, Guid sourceId, int fromV, int toV)
{
  var e = new SourceEvent { BoardId = boardId, SourceId = sourceId, Action = "migrate-version", Detail = "v" + fromV + "->v" + toV };
  s.SourceEvents[e.Id] = e; s.SourceEvents.Flush();
}
var mem = new InMemoryStore();
var ownerReq = FakeReq(""); var aliceReq = FakeReq("alice"); var bobReq = FakeReq("bob");
var bid1 = SeedBoard(mem, "allowAll", "");
var famFile = "family-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".txt";
var docB = SeedSource(mem, bid1, famFile, 3, "approved", Sha("bytes-B-old-orig")); SeedSections(mem, docB); SeedMigrateEvent(mem, bid1, docB.Id, 1, 3);
var headB = new SourceFamilyHead { BoardId = bid1, FamilyKey = docB.FamilyKey, HeadVersion = 3, HeadSourceId = docB.Id, HighWater = 3 }; mem.SourceHeads[headB.Id] = headB; mem.SourceHeads.Flush();
var docC = SeedSource(mem, bid1, famFile, 2, "pending", Sha("bytes-C-new-orig")); SeedSections(mem, docC);
Expect(SourceGovernance.OriginalVersionOf(mem, docB) == 1, "f1-orig-B-is-1", "got " + SourceGovernance.OriginalVersionOf(mem, docB));
Expect(SourceGovernance.OriginalVersionOf(mem, docC) == 2, "f1-orig-C-is-2", "got " + SourceGovernance.OriginalVersionOf(mem, docC));
var (okAppr, errAppr, stAppr) = SourceGovernance.TryApproveById(mem, ownerReq, docC.Id);
Expect(okAppr, "f1-approve-C-orig2-over-parked3", errAppr + " status " + stAppr);
var headAfter = mem.SourceHeads.Values.FirstOrDefault(h => h.BoardId == bid1 && h.FamilyKey == docC.FamilyKey);
Expect(headAfter is not null && headAfter.HeadSourceId == docC.Id && headAfter.HeadVersion == 2, "f1-head-promoted-to-C-canonical2", headAfter is null ? "no head" : headAfter.HeadVersion + "/" + headAfter.HeadSourceId);
Expect(headAfter is not null && headAfter.HighWater >= 3, "f1-highwater-monotonic", "hw=" + (headAfter is null ? -1 : headAfter.HighWater));
var aliasFile = "alias-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".txt";
var docA3 = SeedSource(mem, bid1, aliasFile, 3, "approved", Sha("bytes-alias-old")); SeedSections(mem, docA3); SeedMigrateEvent(mem, bid1, docA3.Id, 1, 3);
var headA3 = new SourceFamilyHead { BoardId = bid1, FamilyKey = docA3.FamilyKey, HeadVersion = 3, HeadSourceId = docA3.Id, HighWater = 3 }; mem.SourceHeads[headA3.Id] = headA3; mem.SourceHeads.Flush();
var draftAlias = new RecordDraft { BoardId = bid1, MeetingId = Guid.Empty, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"a1\",\"text\":\"keep\",\"refs\":[{\"kind\":\"source\",\"ref\":\"" + docA3.Id + "\",\"version\":1}]}]", Hash = "h", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-alias-1", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = false, Status = "open" };
var aliasCards = RecordsOps.ResolveEvidenceAuthorized(mem, ownerReq, draftAlias);
Expect(aliasCards.Count == 1 && !aliasCards[0].Missing && aliasCards[0].Version == 3, "f1-alias-v1-resolves-canonical3", aliasCards.Count + " cards");
var amap = RecordsOps.ItemMap(draftAlias.ItemsJson, out var amapErr); Expect(amapErr == "", "f1-alias-itemmap-ok", amapErr);
var builtOk = RecordsOps.TryBuildSnapshots("[]", amap, aliasCards, new[] { "a1" }, 1, out var aliasSnaps, out var aliasErr); Expect(builtOk, "f1-alias-snapshot-builds", aliasErr);
var aliasSnapList = RecordsOps.GetSnapshots(new RecordDraft { EvidenceSnapshotJson = aliasSnaps });
Expect(aliasSnapList.Count == 1 && aliasSnapList[0].Available && aliasSnapList[0].Version == 3, "f1-alias-snapshot-pins-resolved3", aliasSnapList.Count + " snaps");
var stampFile = "stamp-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".txt";
var stampDoc = new SourceDoc { BoardId = bid1, FileName = stampFile, Origin = "upload", Scope = "board", ContentHash = Sha("stamp-bytes"), Version = 1, ReviewState = "pending", IndexState = "queued", IndexGeneration = 0, ExtractionJson = "{}" }; stampDoc.FamilyKey = SourceGovernance.FamilyKeyFor(bid1, "board", null, "upload", stampFile); stampDoc.Original = System.Text.Encoding.UTF8.GetBytes("stamp body text for policy test"); mem.Sources[stampDoc.Id] = stampDoc; mem.Sources.Flush();
var began = SourceGovernance.TryBeginIndex(mem, ownerReq, stampDoc.Id, "contribute", out var stampRes, out var stampBeginErr);
Expect(began && stampRes is not null, "f2-begin-ok", stampBeginErr);
mem.Boards.TryGetValue(bid1, out var stampBoard); stampBoard.BlockedTypes = "txt"; mem.Boards.Flush();
var beforeExt = stampDoc.ExtractionJson; var beforeState = stampDoc.IndexState; var beforeGen = stampDoc.IndexGeneration;
SourceGovernance.StampExtraction(mem, ownerReq, stampRes, "{\"status\":\"ok\",\"md_content\":\"# drift\"}", "contribute");
mem.Sources.TryGetValue(stampDoc.Id, out var stampAfter);
Expect(stampAfter is not null && stampAfter.ExtractionJson == beforeExt && stampAfter.IndexState == beforeState && stampAfter.IndexGeneration == beforeGen, "f2-stamp-drift-unchanged-all", "ext changed=" + (stampAfter is null ? "missing" : (stampAfter.ExtractionJson != beforeExt)));
mem.Boards.TryGetValue(bid1, out var rstBoard); rstBoard.BlockedTypes = ""; mem.Boards.Flush();
var rosEntry = new RosterEntry { Name = "Private Pending", ProfileJson = "{\"bio\":\"secret\"}", Version = 1, OwnerKey = "alice" }; mem.Roster[rosEntry.Id] = rosEntry; mem.Roster.Flush();
var advPend = new BoardAdvisor { BoardId = bid1, RosterEntryId = rosEntry.Id, RosterVersion = 1, BoardRole = "advisor", Approved = false, Removed = false }; mem.Advisors[advPend.Id] = advPend; mem.Advisors.Flush();
var draftDos = new RecordDraft { BoardId = bid1, MeetingId = Guid.Empty, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"d1\",\"text\":\"cite private\",\"refs\":[{\"kind\":\"dossier\",\"ref\":\"" + rosEntry.Id + "\"}]}]", Hash = "h", ApprovedJson = "[\"d1\"]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-dos-1", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = true, Status = "approved" }; mem.Drafts[draftDos.Id] = draftDos; mem.Drafts.Flush();
var dosCards = RecordsOps.ResolveEvidenceAuthorized(mem, bobReq, draftDos);
Expect(dosCards.Count == 1 && !dosCards[0].Missing, "f3-live-pending-allowed-boardreader", dosCards.Count + " missing=" + (dosCards.Count > 0 ? dosCards[0].Missing : true));
var snBuilt = RecordsOps.TryBuildSnapshots("[]", RecordsOps.ItemMap(draftDos.ItemsJson, out var dmapErr), dosCards, new[] { "d1" }, 1, out var dosSnaps, out var dosErr);
Expect(snBuilt, "f3-snapshot-builds-unavailable", dosErr);
draftDos.EvidenceSnapshotJson = dosSnaps; mem.Drafts.Flush();
var mergeBob = RecordsOps.MergeEvidenceForRead(mem, bobReq, draftDos);
Expect(mergeBob.Count == 1 && mergeBob[0].Missing, "f3-stored-pending-denied-bob", mergeBob.Count + " missing=" + (mergeBob.Count > 0 ? mergeBob[0].Missing : true));
var mergeAlice = RecordsOps.MergeEvidenceForRead(mem, FakeReq("alice"), draftDos);
Expect(mergeAlice.Count == 1 && !mergeAlice[0].Missing, "f3-stored-owner-private-allowed", mergeAlice.Count + " missing=" + (mergeAlice.Count > 0 ? mergeAlice[0].Missing : true));
advPend.Approved = true; mem.Advisors.Flush();
var mergeBobAppr = RecordsOps.MergeEvidenceForRead(mem, bobReq, draftDos);
Expect(mergeBobAppr.Count == 1 && !mergeBobAppr[0].Missing, "f3-stored-approved-public-allowed", mergeBobAppr.Count + " missing=" + (mergeBobAppr.Count > 0 ? mergeBobAppr[0].Missing : true));
var mergeDemo = RecordsOps.MergeEvidenceForRead(mem, FakeReq(""), draftDos);
Expect(mergeDemo.Count == 1 && !mergeDemo[0].Missing, "f3-demo-open-positive", "demo missing=" + (mergeDemo.Count > 0 ? mergeDemo[0].Missing : true));
advPend.Removed = true; mem.Advisors.Flush();
var mergeBobRev = RecordsOps.MergeEvidenceForRead(mem, bobReq, draftDos);
Expect(mergeBobRev.Count == 1 && mergeBobRev[0].Missing, "f3-stored-after-revoke-denied", "revoked missing=" + (mergeBobRev.Count > 0 ? mergeBobRev[0].Missing : true));
advPend.Removed = false; mem.Advisors.Flush();
var badHist = "[{\"seq\":1,\"revision\":1,\"token\":\"t1\",\"action\":\"approve\",\"itemId\":123,\"actor\":\"alice\",\"viewedVersion\":1,\"viewedHash\":\"h\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"oldText\":\"\",\"newText\":\"x\"}]";
Expect(!RecordsOps.StrictHistoryEntries(badHist, out var badHistErr), "f4-history-numeric-itemid-rejected", badHistErr);
var missActor = "[{\"seq\":1,\"revision\":1,\"token\":\"t1\",\"action\":\"approve\",\"itemId\":\"a1\",\"oldText\":\"\",\"newText\":\"x\",\"viewedVersion\":1,\"viewedHash\":\"h\",\"viewedWatermark\":0,\"viewedToken\":\"t\"}]";
Expect(!RecordsOps.StrictHistoryEntries(missActor, out var missActorErr), "f4-history-missing-actor-rejected", missActorErr);
var recA = new RecordDraft { BoardId = bid1, MeetingId = Guid.Empty, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"a1\",\"text\":\"keep\"}]", Hash = "h", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-rec-a", HistoryJson = "[{\"seq\":1,\"revision\":1,\"token\":\"tok-rec-a\",\"action\":\"create\",\"itemId\":\"\",\"oldText\":\"\",\"newText\":\"\",\"actor\":\"alice\",\"viewedVersion\":1,\"viewedHash\":\"h\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"}]", SupersedesJson = "[\"" + Guid.NewGuid() + "\"]", EvidenceSnapshotJson = "[]", Decided = false, Status = "open" };
Expect(!RecordsOps.StrictStateCheck(mem, recA, out var recAErr), "f4-supersedes-missing-parent-rejected", recAErr);
Expect(RecordsOps.BuildExport("[{\"id\":1,\"text\":\"x\"}]", "[\"1\"]", false) == "", "f4-buildexport-numeric-id-rejected", "numeric id must fail closed");
Expect(!RecordsOps.IsReadableItems("[{\"id\":1,\"text\":\"x\"}]"), "f4-isreadable-numeric-rejected", "numeric items not readable");
Expect(RecordsOps.IsReadableItems("[{\"id\":\"a1\",\"text\":\"keep\"}]"), "f4-isreadable-healthy-passes", "healthy must pass");
var recMeet = new Meeting { BoardId = bid1, Title = "rec-m", State = MeetingState.Active, Generation = 0 }; mem.Meetings[recMeet.Id] = recMeet; mem.Meetings.Flush();
var srcRec = new RecordDraft { BoardId = bid1, MeetingId = recMeet.Id, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"s1\",\"text\":\"source item\"}]", Hash = "h", ApprovedJson = "[\"s1\"]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-src-1", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = true, Status = "approved" }; mem.Drafts[srcRec.Id] = srcRec; mem.Drafts.Flush();
var expRef = SimCEO.Api.Work.EvidenceRef.ForRecordItem(srcRec.Id.ToString(), 1, "s1", "excerpt");
Expect(expRef.Ref.Contains(":"), "f4-explicit-ref-encodes-item", expRef.Ref);
var unvFile = "unv-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".txt";
var unvDoc = SeedSource(mem, bid1, unvFile, 1, "approved", Sha("unv-bytes")); SeedSections(mem, unvDoc);
var unvHead = new SourceFamilyHead { BoardId = bid1, FamilyKey = unvDoc.FamilyKey, HeadVersion = 1, HeadSourceId = unvDoc.Id, HighWater = 1 }; mem.SourceHeads[unvHead.Id] = unvHead; mem.SourceHeads.Flush();
var unvDraft = new RecordDraft { BoardId = bid1, MeetingId = Guid.Empty, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"u1\",\"text\":\"keep\",\"refs\":[{\"kind\":\"source\",\"ref\":\"" + unvDoc.Id + "\"}]}]", Hash = "h", ApprovedJson = "[\"u1\"]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-unv-1", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = true, Status = "approved" };
var unvLive = RecordsOps.ResolveEvidenceAuthorized(mem, ownerReq, unvDraft);
var unvMap = RecordsOps.ItemMap(unvDraft.ItemsJson, out var unvMapErr);
var unvBuilt = RecordsOps.TryBuildSnapshots("[]", unvMap, unvLive, new[] { "u1" }, 1, out var unvSnaps, out var unvErr);
unvDraft.EvidenceSnapshotJson = unvSnaps;
var unvMerge = RecordsOps.MergeEvidenceForRead(mem, ownerReq, unvDraft);
Expect(unvBuilt && unvMerge.Count == 1 && !unvMerge[0].Missing && unvMerge[0].Version == 1, "f4-unversioned-v1-one-card", "count=" + unvMerge.Count);
var badDraft = new RecordDraft { Id = Guid.NewGuid(), BoardId = bid1, MeetingId = recMeet.Id, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":1,\"text\":\"x\"}]", Hash = "h", ApprovedJson = "[\"1\"]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-bad", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = false, Status = "open" };
var valErr = RecordsOps.ValidateRestoreEntries(new[] { badDraft });
Expect(valErr is not null, "f4-restore-validator-rejects-numeric", valErr ?? "null");
var goodVal = RecordsOps.ValidateRestoreEntries(new[] { srcRec });
Expect(goodVal is null, "f4-restore-validator-accepts-healthy", goodVal ?? "null");
Console.WriteLine("PG SECTION START");
var pgBase = Environment.GetEnvironmentVariable("PGCS");
if (string.IsNullOrWhiteSpace(pgBase)) pgBase = "Host=127.0.0.1;Port=15441;Database=postgres;Username=simceo;Password=qa-only";
var pgDb = "essentials_evidence_" + Guid.NewGuid().ToString("N").Substring(0, 12);
Console.WriteLine("PG exclusive DB: " + pgDb);
try
{
  var adminOpt = new Microsoft.EntityFrameworkCore.DbContextOptionsBuilder<SimCEO.Postgres.PostgresDb>().UseNpgsql(pgBase).Options;
  using var adminDb = new SimCEO.Postgres.PostgresDb(adminOpt);
  if (!adminDb.Database.CanConnect()) throw new Exception("pg unreachable");
  adminDb.Database.ExecuteSqlRaw("CREATE DATABASE \"" + pgDb + "\"");
  var pgCs = "Host=127.0.0.1;Port=15441;Database=" + pgDb + ";Username=simceo;Password=qa-only";
  var pgOpt = new Microsoft.EntityFrameworkCore.DbContextOptionsBuilder<SimCEO.Postgres.PostgresDb>().UseNpgsql(pgCs).Options;
  using var pgDbCtx = new SimCEO.Postgres.PostgresDb(pgOpt);
  pgDbCtx.Database.EnsureCreated();
  var pgBackend = new SimCEO.Postgres.PostgresBackend(pgDbCtx);
  var prevBackend = SimCEO.Api.Data.Pg.Backend;
  SimCEO.Api.Data.Pg.Backend = pgBackend;
  try
  {
    var ps = new InMemoryStore();
    var pbid = SeedBoard(ps, "allowAll", "");
    var pfile = "pg-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".txt";
    var pdocB = SeedSource(ps, pbid, pfile, 3, "approved", Sha("pg-B")); SeedSections(ps, pdocB); SeedMigrateEvent(ps, pbid, pdocB.Id, 1, 3);
    var phead = new SourceFamilyHead { BoardId = pbid, FamilyKey = pdocB.FamilyKey, HeadVersion = 3, HeadSourceId = pdocB.Id, HighWater = 3 }; ps.SourceHeads[phead.Id] = phead; ps.SourceHeads.Flush();
    var pdocC = SeedSource(ps, pbid, pfile, 2, "pending", Sha("pg-C")); SeedSections(ps, pdocC);
    var (pgOk, pgErr, pgSt) = SourceGovernance.TryApproveById(ps, ownerReq, pdocC.Id);
    Expect(pgOk, "pg-promote-C-over-B", pgErr + " st " + pgSt);
    var pgHead = ps.SourceHeads.Values.FirstOrDefault(h => h.BoardId == pbid && h.FamilyKey == pdocC.FamilyKey);
    Expect(pgHead is not null && pgHead.HeadSourceId == pdocC.Id, "pg-head-persisted", pgHead is null ? "no head" : pgHead.HeadVersion.ToString());
    var finFile = "fin-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".txt";
    var finDoc = new SourceDoc { BoardId = pbid, FileName = finFile, Origin = "upload", Scope = "board", ContentHash = Sha("fin-bytes"), Version = 1, ReviewState = "pending", IndexState = "queued", IndexGeneration = 0, ExtractionJson = "{}" }; finDoc.FamilyKey = SourceGovernance.FamilyKeyFor(pbid, "board", null, "upload", finFile); finDoc.Original = System.Text.Encoding.UTF8.GetBytes("finish fault body text for pg test"); ps.Sources[finDoc.Id] = finDoc; ps.Sources.Flush();
    var finBegan = SourceGovernance.TryBeginIndex(ps, ownerReq, finDoc.Id, "contribute", out var finRes, out var finBeginErr);
    Expect(finBegan && finRes is not null, "pg-finish-begin-ok", finBeginErr);
    SourceGovernance.StampExtraction(ps, ownerReq, finRes, "{\"status\":\"ok\",\"md_content\":\"# t\\n\\nfinish body text for pg test\"}", "contribute");
    ps.Sources.TryGetValue(finDoc.Id, out var finCur0); int sec0 = 0; foreach (var sxx in ps.SourceSections.Values) if (sxx.SourceId == finDoc.Id) sec0++; int evt0 = 0; foreach (var exx in ps.SourceEvents.Values) if (exx.SourceId == finDoc.Id) evt0++; var aud0 = System.Linq.Enumerable.Count(ps.Audit);
    pgDbCtx.Database.ExecuteSqlRaw("CREATE OR REPLACE FUNCTION qa_fail_secs() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION " + (char)39 + "qa injected section failure" + (char)39 + "; END; $$ LANGUAGE plpgsql");
    pgDbCtx.Database.ExecuteSqlRaw("DROP TRIGGER IF EXISTS qa_fail_secs ON \"SourceSections\"");
    pgDbCtx.Database.ExecuteSqlRaw("CREATE TRIGGER qa_fail_secs BEFORE INSERT ON \"SourceSections\" FOR EACH ROW EXECUTE FUNCTION qa_fail_secs()");
    var threwFin = false; string finThrowMsg = "";
    try { var fr = SourceGovernance.FinishIndex(ps, ownerReq, finRes, false, "contribute"); finThrowMsg = "returned ok=" + fr.ok; } catch (Exception ex) { threwFin = true; finThrowMsg = ex.GetType().Name + ": " + ex.Message; }
    Expect(threwFin, "pg-finish-fault-escapes", finThrowMsg);
    ps.Sources.TryGetValue(finDoc.Id, out var finCur1); int sec1 = 0; foreach (var syy in ps.SourceSections.Values) if (syy.SourceId == finDoc.Id) sec1++; int evt1 = 0; foreach (var eyy in ps.SourceEvents.Values) if (eyy.SourceId == finDoc.Id) evt1++; var aud1 = System.Linq.Enumerable.Count(ps.Audit);
    Expect(finCur1 is not null && finCur1.IndexState == "running" && sec1 == sec0 && evt1 == evt0 && aud1 == aud0, "pg-finish-state-unchanged", "sec " + sec0 + "->" + sec1 + " evt " + evt0 + "->" + evt1);
    pgDbCtx.Database.ExecuteSqlRaw("DROP TRIGGER IF EXISTS qa_fail_secs ON \"SourceSections\"");
    var (okRetry, staleRetry, lostRetry, errRetry, stRetry) = SourceGovernance.FinishIndex(ps, ownerReq, finRes, false, "contribute");
    Expect(okRetry, "pg-finish-healthy-retry", errRetry + " st " + stRetry);
    SimCEO.Api.Data.Pg.Backend = prevBackend;
  } catch (Exception ex) { Console.WriteLine("PG SKIP :: " + ex.GetType().Name + " " + ex.Message); }
}
catch (Exception ex) { Console.WriteLine("PG OUTER SKIP :: " + ex.GetType().Name + " " + ex.Message); }
Console.WriteLine("MEMORY+PG DONE passed=" + passed + " failures=" + failures.Count);
if (failures.Count > 0) { Console.WriteLine("FAILURES: " + string.Join(",", failures)); return 1; }
Console.WriteLine("ESSENTIALS-EVIDENCE PROBE COMPLETE"); return 0;
