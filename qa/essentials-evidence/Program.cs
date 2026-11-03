using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using SimCEO.Api;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

var failures = new List<string>();
var logLines = new List<string>();
void Emit(string line) { Console.WriteLine(line); logLines.Add(line); }
int passed = 0;
void Pass(string name, string detail) { Emit("PASS " + name + " :: " + detail); passed++; }
void Fail(string name, string detail) { Emit("FAIL " + name + " :: " + detail); failures.Add(name); }
void Expect(bool ok, string name, string detail) { if (ok) Pass(name, detail); else Fail(name, detail); }
Emit("ESSENTIALS-EVIDENCE PROBE START");
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
  var e = new SourceEvent { BoardId = boardId, SourceId = sourceId, FamilyKey = "", Version = toV, Action = "migrate-version", Detail = "v" + fromV + "->v" + toV };
  s.SourceEvents[e.Id] = e; s.SourceEvents.Flush();
}
static int? OrigOf(InMemoryStore s, string refId)
{
  try { if (Guid.TryParse(refId, out var g) && s.Sources.TryGetValue(g, out var dd) && dd is not null) return SourceGovernance.OriginalVersionOf(s, dd); } catch { }
  return null;
}
static string H(string itemsJson) => SimCEO.Api.Work.Hashing.HashOf(itemsJson ?? "[]");
// Bounded process helper (F7): concurrent stdout/stderr drain with a hard timeout,
// retained handle cleanup by the caller, nonzero exits surfaced (never swallowed).
static void DrainLines(System.IO.StreamReader rd, System.Text.StringBuilder sb)
{
  try { string? ln; while ((ln = rd.ReadLine()) != null) { lock (sb) { sb.AppendLine(ln); } } } catch { }
}
static (int exit, string stdout, string stderr, bool timedOut) RunBounded(string file, string args, int timeoutMs)
{
  var psi = new System.Diagnostics.ProcessStartInfo(file, args) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
  using var pr = new System.Diagnostics.Process { StartInfo = psi };
  var outSb = new System.Text.StringBuilder(); var errSb = new System.Text.StringBuilder();
  try
  {
    if (!pr.Start()) return (-1, "", "start-failed", false);
    var oTask = System.Threading.Tasks.Task.Run(() => DrainLines(pr.StandardOutput, outSb));
    var eTask = System.Threading.Tasks.Task.Run(() => DrainLines(pr.StandardError, errSb));
    var exited = pr.WaitForExit(timeoutMs);
    var drained = System.Threading.Tasks.Task.WaitAll(new[] { oTask, eTask }, 15000);
    if (!exited || !drained) { try { pr.Kill(true); } catch { } return (-1, outSb.ToString(), errSb.ToString(), true); }
    return (pr.ExitCode, outSb.ToString(), errSb.ToString(), false);
  }
  catch (Exception ex) { return (-1, "", ex.GetType().Name + ":" + ex.Message, false); }
}
// Staged maps built the Ops way (F3/P1 contract): from the store's own sources+events+heads.
static (Dictionary<string, int> orig, Dictionary<string, int> canon) MapsOf(InMemoryStore s)
  => RecordsOps.BuildSourceVersionMaps(s.Sources.Values, s.SourceEvents.Values);
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
var docA3 = SeedSource(mem, bid1, aliasFile, 3, "approved", Sha("alias-bytes-old")); SeedSections(mem, docA3); SeedMigrateEvent(mem, bid1, docA3.Id, 1, 3);
var headA3 = new SourceFamilyHead { BoardId = bid1, FamilyKey = docA3.FamilyKey, HeadVersion = 3, HeadSourceId = docA3.Id, HighWater = 3 }; mem.SourceHeads[headA3.Id] = headA3; mem.SourceHeads.Flush();
var draftAlias = new RecordDraft { BoardId = bid1, MeetingId = Guid.Empty, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"a1\",\"text\":\"keep\",\"refs\":[{\"kind\":\"source\",\"ref\":\"" + docA3.Id + "\",\"version\":1}]}]", Hash = "h", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-alias-1", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = false, Status = "open" };
var aliasCards = RecordsOps.ResolveEvidenceAuthorized(mem, ownerReq, draftAlias);
Expect(aliasCards.Count == 1 && !aliasCards[0].Missing && aliasCards[0].Version == 3, "f1-alias-v1-resolves-canonical3", aliasCards.Count + " cards");
var amap = RecordsOps.ItemMap(draftAlias.ItemsJson, out var amapErr); Expect(amapErr == "", "f1-alias-itemmap-ok", amapErr);
var builtOk = RecordsOps.TryBuildSnapshots("[]", amap, aliasCards, new[] { "a1" }, 1, out var aliasSnaps, out var aliasErr, refId => OrigOf(mem, refId)); Expect(builtOk, "f1-alias-snapshot-builds", aliasErr);
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
var snBuilt = RecordsOps.TryBuildSnapshots("[]", RecordsOps.ItemMap(draftDos.ItemsJson, out var dmapErr), dosCards, new[] { "d1" }, 1, out var dosSnaps, out var dosErr, refId => OrigOf(mem, refId));
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
var recMeet = new Meeting { BoardId = bid1, Title = "rec-m", State = MeetingState.Active, Generation = 0 }; mem.Meetings[recMeet.Id] = recMeet; mem.Meetings.Flush();
var srcRec = new RecordDraft { BoardId = bid1, MeetingId = recMeet.Id, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"s1\",\"text\":\"source item\"}]", Hash = "h", ApprovedJson = "[\"s1\"]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-src-1", HistoryJson = "[{\"seq\":1,\"revision\":1,\"token\":\"tok-src-1\",\"action\":\"approve\",\"itemId\":\"s1\",\"oldText\":\"\",\"newText\":\"source item\",\"actor\":\"alice\",\"viewedVersion\":1,\"viewedHash\":\"h\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"}]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = true, Status = "approved" }; mem.Drafts[srcRec.Id] = srcRec; mem.Drafts.Flush();
srcRec.Hash = H(srcRec.ItemsJson);
var expRef = SimCEO.Api.Work.EvidenceRef.ForRecordItem(srcRec.Id.ToString(), 1, "s1", "excerpt");
Expect(expRef.Ref == srcRec.Id + ":s1", "f4-explicit-ref-encodes-item", expRef.Ref);
Expect(SimCEO.Api.Work.EvidenceRef.TryParseRecordRef(expRef.Ref, out var expRid, out var expItem, out _), "f1-parser-roundtrip-forrecorditem", expRef.Ref);
Expect(expRid == srcRec.Id && expItem == "s1", "f1-parser-roundtrip-values", expRid + "/" + expItem);
var unvFile = "unv-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".txt";
var unvDoc = SeedSource(mem, bid1, unvFile, 1, "approved", Sha("unv-bytes")); SeedSections(mem, unvDoc);
var unvHead = new SourceFamilyHead { BoardId = bid1, FamilyKey = unvDoc.FamilyKey, HeadVersion = 1, HeadSourceId = unvDoc.Id, HighWater = 1 }; mem.SourceHeads[unvHead.Id] = unvHead; mem.SourceHeads.Flush();
var unvDraft = new RecordDraft { BoardId = bid1, MeetingId = Guid.Empty, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"u1\",\"text\":\"keep\",\"refs\":[{\"kind\":\"source\",\"ref\":\"" + unvDoc.Id + "\"}]}]", Hash = "h", ApprovedJson = "[\"u1\"]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-unv-1", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = true, Status = "approved" };
var unvLive = RecordsOps.ResolveEvidenceAuthorized(mem, ownerReq, unvDraft);
var unvMap = RecordsOps.ItemMap(unvDraft.ItemsJson, out var unvMapErr);
var unvBuilt = RecordsOps.TryBuildSnapshots("[]", unvMap, unvLive, new[] { "u1" }, 1, out var unvSnaps, out var unvErr, refId => OrigOf(mem, refId));
unvDraft.EvidenceSnapshotJson = unvSnaps;
var unvMerge = RecordsOps.MergeEvidenceForRead(mem, ownerReq, unvDraft);
Expect(unvBuilt && unvMerge.Count == 1 && !unvMerge[0].Missing && unvMerge[0].Version == 1, "f4-unversioned-v1-one-card", "count=" + unvMerge.Count);
var badDraft = new RecordDraft { Id = Guid.NewGuid(), BoardId = bid1, MeetingId = recMeet.Id, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":1,\"text\":\"x\"}]", Hash = "h", ApprovedJson = "[\"1\"]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-bad", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = false, Status = "open" };
var valErr = RecordsOps.ValidateRestoreEntries(new[] { badDraft });
Expect(valErr is not null, "f4-restore-validator-rejects-numeric", valErr ?? "null");
var goodVal = RecordsOps.ValidateRestoreEntries(new[] { srcRec });
Expect(goodVal is null, "f4-restore-validator-accepts-healthy", goodVal ?? "null");
// ---- F1 shared strict parser matrix (no mere contains-colon) ----
{
  var g = Guid.NewGuid();
  Expect(SimCEO.Api.Work.EvidenceRef.TryParseRecordRef(g.ToString(), out var r1, out var i1, out _), "f1-parse-bare-guid-whole", g.ToString());
  Expect(r1 == g && i1 == "", "f1-parse-bare-guid-values", r1 + "/" + i1);
  Expect(SimCEO.Api.Work.EvidenceRef.TryParseRecordRef("  " + g + "  ", out _, out _, out _), "f1-parse-bare-guid-trimmed", "padded bare guid");
  Expect(SimCEO.Api.Work.EvidenceRef.TryParseRecordRef(g + ":s1", out var r2, out var i2, out _), "f1-parse-composite-ok", g + ":s1");
  Expect(r2 == g && i2 == "s1", "f1-parse-composite-values", r2 + "/" + i2);
  Expect(SimCEO.Api.Work.EvidenceRef.TryParseRecordRef(g + ":a:b", out _, out var i3, out _), "f1-parse-interior-colon-item", "item=a:b");
  Expect(i3 == "a:b", "f1-parse-interior-colon-value", i3);
  Expect(!SimCEO.Api.Work.EvidenceRef.TryParseRecordRef("A:", out _, out _, out var eA), "f1-parse-reject-A-colon", eA);
  Expect(!SimCEO.Api.Work.EvidenceRef.TryParseRecordRef("A: ", out _, out _, out var eAS), "f1-parse-reject-A-space", eAS);
  Expect(!SimCEO.Api.Work.EvidenceRef.TryParseRecordRef(g + ":", out _, out _, out var eG), "f1-parse-reject-guid-colon", eG);
  Expect(!SimCEO.Api.Work.EvidenceRef.TryParseRecordRef(g + ": ", out _, out _, out var eGS), "f1-parse-reject-guid-space-item", eGS);
  Expect(!SimCEO.Api.Work.EvidenceRef.TryParseRecordRef(g + ": s1", out _, out _, out _), "f1-parse-reject-leading-space-item", "leading space");
  Expect(!SimCEO.Api.Work.EvidenceRef.TryParseRecordRef(g + ":s1 ", out _, out _, out _), "f1-parse-reject-trailing-space-item", "trailing space");
  Expect(!SimCEO.Api.Work.EvidenceRef.TryParseRecordRef(":s1", out _, out _, out _), "f1-parse-reject-empty-record", ":s1");
  Expect(!SimCEO.Api.Work.EvidenceRef.TryParseRecordRef("", out _, out _, out _), "f1-parse-reject-blank", "blank");
  Expect(!SimCEO.Api.Work.EvidenceRef.TryParseRecordRef("notaguid", out _, out _, out _), "f1-parse-reject-nonguid", "notaguid");
  Expect(!SimCEO.Api.Work.EvidenceRef.TryParseRecordRef("notaguid:s1", out _, out _, out _), "f1-parse-reject-nonguid-item", "notaguid:s1");
}
// ---- F1/F5 Secretary three consumers + legacy briefing preservation ----
{
  var secMeet = new Meeting { BoardId = bid1, Title = "sec-m", State = MeetingState.Active, Generation = 0 }; mem.Meetings[secMeet.Id] = secMeet; mem.Meetings.Flush();
  var recA = new RecordDraft { BoardId = bid1, MeetingId = secMeet.Id, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"s1\",\"text\":\"exact quote alpha\"},{\"id\":\"s2\",\"text\":\"second\"}]", Hash = Sha("sec-A-items"), ApprovedJson = "[\"s1\",\"s2\"]", DiscardedJson = "[]", ReviewRevision = 2, ReviewToken = "tok-sec-A", HistoryJson = "[{\"seq\":1,\"revision\":1,\"token\":\"tok-sec-A0\",\"action\":\"create\",\"itemId\":\"\",\"oldText\":\"\",\"newText\":\"\",\"actor\":\"alice\",\"viewedVersion\":1,\"viewedHash\":\"h\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"},{\"seq\":2,\"revision\":2,\"token\":\"tok-sec-A\",\"action\":\"approve\",\"itemId\":\"s1\",\"oldText\":\"\",\"newText\":\"exact quote alpha\",\"actor\":\"alice\",\"viewedVersion\":1,\"viewedHash\":\"h\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"}]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = true, Status = "approved" };
  mem.Drafts[recA.Id] = recA; mem.Drafts.Flush();
  var rawCaller = new List<SimCEO.Api.Work.EvidenceRef>
  {
    new("record", recA.Id + ":s1", 1, null, null, "quote alpha"),
    new("record", recA.Id.ToString(), 1, null, null, null),
    new("record", recA.Id + ":", null, null, null, "bogus"),
    new("record", recA.Id + ":s9", null, null, null, null),
    new("record", recA.Id + ":s1", null, null, null, "WRONG QUOTE"),
  };
  var canon = SecretaryContext.CanonicalizeCaller(mem, bid1, secMeet.Id, rawCaller);
  Expect(canon.Count(c => c.Kind == "record" && c.Ref == recA.Id + ":s1" && c.Version == 1 && c.Excerpt == "quote alpha") == 1, "f1-canon-item-quote-preserved", canon.Count + " refs");
  Expect(canon.Count(c => c.Kind == "record" && c.Ref == recA.Id.ToString()) == 1, "f1-canon-bare-whole-preserved", "bare whole-record kept");
  Expect(!canon.Any(c => c.Ref == recA.Id + ":"), "f1-canon-malformed-dropped", "A: composite dropped, never whole-record");
  Expect(!canon.Any(c => c.Ref == recA.Id + ":s9"), "f1-canon-unapproved-item-dropped", "s9 not approved");
  Expect(!canon.Any(c => c.Excerpt == "WRONG QUOTE"), "f1-canon-wrong-quote-dropped", "excerpt must be exact substring of item");
  var packetRefs = new List<SimCEO.Api.Work.EvidenceRef>();
  var packet = SecretaryContext.BuildPacket(mem, secMeet, "alpha", canon, packetRefs, 20000);
  Expect(packet.Contains("CALLER RECORD v1 [s1]: quote alpha"), "f1-packet-item-scope", "packet carries exact item line");
  Expect(!packet.Contains(recA.Id + ":"), "f1-packet-no-malformed", "no malformed composite line");
  Expect(canon.All(c => packetRefs.Any(q => q.Kind == c.Kind && q.Ref == c.Ref && q.Version == c.Version)), "f1-packet-refs-echo-canon", "every canonical ref echoed in packet");
  var avBare = EvidenceAvailability.Resolve(mem, new SimCEO.Api.Work.EvidenceRef("record", recA.Id.ToString(), 1, null, null, null), bid1, secMeet.Id);
  Expect(avBare.Available && avBare.Reason == "current", "f1-avail-bare-current", avBare.Reason);
  var avItem = EvidenceAvailability.Resolve(mem, new SimCEO.Api.Work.EvidenceRef("record", recA.Id + ":s1", 1, null, null, null), bid1, secMeet.Id);
  Expect(avItem.Available && avItem.Reason == "current", "f1-avail-item-current", avItem.Reason);
  var avBad = EvidenceAvailability.Resolve(mem, new SimCEO.Api.Work.EvidenceRef("record", recA.Id + ":", null, null, null, null), bid1, secMeet.Id);
  Expect(!avBad.Available, "f1-avail-malformed-unavailable", avBad.Reason);
  var avStale = EvidenceAvailability.Resolve(mem, new SimCEO.Api.Work.EvidenceRef("record", recA.Id + ":s1", 99, null, null, null), bid1, secMeet.Id);
  Expect(!avStale.Available && avStale.Reason.Contains("superseded"), "f1-avail-stale-pin", avStale.Reason);
  // ---- F1 explicit approved item in a PARTIALLY-APPROVED record is current ----
  var partMeet = new Meeting { BoardId = bid1, Title = "f1-partial-m", State = MeetingState.Active, Generation = 0 }; mem.Meetings[partMeet.Id] = partMeet; mem.Meetings.Flush();
  var partItems = "[{\"id\":\"s1\",\"text\":\"exact approved alpha\"},{\"id\":\"s2\",\"text\":\"pending beta\"}]";
  var part = new RecordDraft { BoardId = bid1, MeetingId = partMeet.Id, Version = 1, Watermark = 0, ItemsJson = partItems, Hash = "hp", ApprovedJson = "[\"s1\"]", DiscardedJson = "[]", ReviewRevision = 2, ReviewToken = "tok-f1p-1", HistoryJson = "[{\"seq\":1,\"revision\":1,\"token\":\"tok-f1p-0\",\"action\":\"create\",\"itemId\":\"\",\"oldText\":\"\",\"newText\":\"\",\"actor\":\"alice\",\"viewedVersion\":1,\"viewedHash\":\"hp\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"},{\"seq\":2,\"revision\":2,\"token\":\"tok-f1p-1\",\"action\":\"approve\",\"itemId\":\"s1\",\"oldText\":\"\",\"newText\":\"exact approved alpha\",\"actor\":\"alice\",\"viewedVersion\":1,\"viewedHash\":\"hp\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"}]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = false, Status = "partially-approved" };
  part.Hash = H(part.ItemsJson); mem.Drafts[part.Id] = part; mem.Drafts.Flush();
  var avPartItem = EvidenceAvailability.Resolve(mem, new SimCEO.Api.Work.EvidenceRef("record", part.Id + ":s1", 1, null, null, null), bid1, partMeet.Id);
  Expect(avPartItem.Available && avPartItem.Reason == "current", "f1-avail-partial-approved-item-current", avPartItem.Reason);
  var avPartBare = EvidenceAvailability.Resolve(mem, new SimCEO.Api.Work.EvidenceRef("record", part.Id.ToString(), 1, null, null, null), bid1, partMeet.Id);
  Expect(!avPartBare.Available && avPartBare.Reason == "record no longer approved", "f1-avail-partial-bare-gated", avPartBare.Reason);
  var avPartPend = EvidenceAvailability.Resolve(mem, new SimCEO.Api.Work.EvidenceRef("record", part.Id + ":s2", null, null, null, null), bid1, partMeet.Id);
  Expect(!avPartPend.Available, "f1-avail-partial-pending-unavailable", avPartPend.Reason);
  // Note-history route expression: the actual endpoint runs ParseJsonList + Resolve per
  // ref (Secretary.cs note-history); exercise that exact expression with a real note.
  var partNote = new Note { BoardId = bid1, MeetingId = partMeet.Id, Kind = "note", Title = "cite", Body = "body", Scope = "meeting", Provisional = true, EvidenceJson = "[{\"kind\":\"record\",\"ref\":\"" + part.Id + ":s1\",\"version\":1}]", RootId = Guid.Empty, Revision = 1, NoteStatus = "current", CreatedAt = DateTime.UtcNow };
  partNote.RootId = partNote.Id; mem.Notes[partNote.Id] = partNote; mem.Notes.Flush();
  var partAvail = SimCEO.Api.Work.EvidenceRef.ParseJsonList(partNote.EvidenceJson ?? "[]").Select(r => EvidenceAvailability.Resolve(mem, r, partNote.BoardId, partNote.MeetingId)).ToList();
  Expect(partAvail.Count == 1 && partAvail[0].Available && partAvail[0].Reason == "current", "f1-note-history-partial-item-current", partAvail.Count == 1 ? partAvail[0].Reason : "count=" + partAvail.Count);
  // Secretary prep block: the exact CanonicalizeCaller + BuildPacket calls the legacy
  // briefing route runs before its model call (model excluded: no provider keys).
  var partCanon = SecretaryContext.CanonicalizeCaller(mem, bid1, partMeet.Id, new List<SimCEO.Api.Work.EvidenceRef> { new("record", part.Id + ":s1", 1, null, null, "approved alpha") });
  Expect(partCanon.Count(c => c.Kind == "record" && c.Ref == part.Id + ":s1" && c.Excerpt == "approved alpha") == 1, "f1-prep-partial-item-quote", "count=" + partCanon.Count);
  var partRefs = new List<SimCEO.Api.Work.EvidenceRef>();
  var partPacket = SecretaryContext.BuildPacket(mem, partMeet, "alpha", partCanon, partRefs, 20000);
  Expect(partPacket.Contains("CALLER RECORD v1 [s1]: approved alpha"), "f1-prep-partial-item-line", "packet carries exact item line");
  // Inheritance then replacement (F1 availability + F5 ownership, both paths).
  var inhB = new RecordDraft { BoardId = bid1, MeetingId = partMeet.Id, Version = 1, Watermark = 0, ItemsJson = partItems, Hash = "hpb", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f1p-B", HistoryJson = "[{\"seq\":1,\"revision\":1,\"token\":\"tok-f1p-B\",\"action\":\"create\",\"itemId\":\"\",\"oldText\":\"\",\"newText\":\"\",\"actor\":\"alice\",\"viewedVersion\":1,\"viewedHash\":\"hpb\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"}]", SupersedesJson = "[\"" + part.Id + "\"]", EvidenceSnapshotJson = "[]", Decided = false, Status = "open" };
  inhB.Hash = H(inhB.ItemsJson); mem.Drafts[inhB.Id] = inhB; mem.Drafts.Flush();
  var avInh = EvidenceAvailability.Resolve(mem, new SimCEO.Api.Work.EvidenceRef("record", part.Id + ":s1", 1, null, null, null), bid1, partMeet.Id);
  Expect(avInh.Available && avInh.Reason == "current", "f1-avail-inherited-still-current", avInh.Reason);
  var inhRep = new RecordDraft { BoardId = bid1, MeetingId = partMeet.Id, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"s1\",\"text\":\"REPLACED CUT\"},{\"id\":\"s2\",\"text\":\"pending beta\"}]", Hash = "hpr", ApprovedJson = "[\"s1\"]", DiscardedJson = "[]", ReviewRevision = 2, ReviewToken = "tok-f1p-C", HistoryJson = "[{\"seq\":1,\"revision\":1,\"token\":\"tok-f1p-C0\",\"action\":\"create\",\"itemId\":\"\",\"oldText\":\"\",\"newText\":\"\",\"actor\":\"alice\",\"viewedVersion\":1,\"viewedHash\":\"hpr\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"},{\"seq\":2,\"revision\":2,\"token\":\"tok-f1p-C\",\"action\":\"approve\",\"itemId\":\"s1\",\"oldText\":\"\",\"newText\":\"REPLACED CUT\",\"actor\":\"alice\",\"viewedVersion\":1,\"viewedHash\":\"hpr\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"}]", SupersedesJson = "[\"" + part.Id + "\"]", EvidenceSnapshotJson = "[]", Decided = false, Status = "partially-approved" };
  inhRep.Hash = H(inhRep.ItemsJson); mem.Drafts.TryRemove(inhB.Id, out _); mem.Drafts[inhRep.Id] = inhRep; mem.Drafts.Flush();
  var avRepl = EvidenceAvailability.Resolve(mem, new SimCEO.Api.Work.EvidenceRef("record", part.Id + ":s1", 1, null, null, null), bid1, partMeet.Id);
  Expect(!avRepl.Available && avRepl.Reason == "record item replaced", "f1-avail-replaced-after-approve", avRepl.Reason);
}
// ---- F3 unrelated-999 rejection + one coherent capture ----
{
  var snapDocFile = "snap999-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".txt";
  var snapDoc = SeedSource(mem, bid1, snapDocFile, 3, "approved", Sha("snap999-bytes")); SeedSections(mem, snapDoc); SeedMigrateEvent(mem, bid1, snapDoc.Id, 1, 3);
  var draft999 = new RecordDraft { BoardId = bid1, MeetingId = Guid.Empty, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"q1\",\"text\":\"keep\",\"refs\":[{\"kind\":\"source\",\"ref\":\"" + snapDoc.Id + "\",\"version\":999}]}]", Hash = "h", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-999", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = false, Status = "open" };
  var cards999 = RecordsOps.ResolveEvidenceAuthorized(mem, ownerReq, draft999);
  Expect(cards999.Count == 1 && cards999[0].Missing, "f3-999-no-live-card", "stale pin yields no live card");
  var map999 = RecordsOps.ItemMap(draft999.ItemsJson, out var map999Err);
  var ok999 = RecordsOps.TryBuildSnapshots("[]", map999, cards999, new[] { "q1" }, 1, out var snaps999, out var err999, refId => OrigOf(mem, refId));
  Expect(ok999, "f3-999-snapshot-builds", err999);
  var list999 = RecordsOps.GetSnapshots(new RecordDraft { EvidenceSnapshotJson = snaps999 });
  Expect(list999.Count == 1 && !list999[0].Available && list999[0].Version == 999, "f3-999-captures-unavailable", list999.Count + " avail=" + (list999.Count > 0 ? list999[0].Available : true));
  draft999.EvidenceSnapshotJson = snaps999; draft999.ApprovedJson = "[\"q1\"]"; draft999.Decided = true; draft999.Status = "approved"; mem.Drafts[draft999.Id] = draft999; mem.Drafts.Flush();
  var merge999 = RecordsOps.MergeEvidenceForRead(mem, ownerReq, draft999);
  Expect(merge999.Count == 1 && merge999[0].Missing, "f3-999-readback-one-unavailable", "count=" + merge999.Count);
}
// ---- F4 alias readback: EXACTLY ONE available canonical3 card, bytes unchanged ----
{
  draftAlias.EvidenceSnapshotJson = aliasSnaps; draftAlias.ApprovedJson = "[\"a1\"]"; draftAlias.Decided = true; draftAlias.Status = "approved"; mem.Drafts[draftAlias.Id] = draftAlias; mem.Drafts.Flush();
  var rb = RecordsOps.MergeEvidenceForRead(mem, ownerReq, draftAlias);
  Expect(rb.Count == 1, "f4-readback-exactly-one", "count=" + rb.Count);
  Expect(rb.Count == 1 && !rb[0].Missing && rb[0].Version == 3, "f4-readback-one-available-canonical3", rb.Count > 0 ? (rb[0].Missing + "/" + rb[0].Version) : "none");
  Expect(rb.Count == 1 && rb[0].Title == aliasSnapList[0].Title && rb[0].Excerpt == aliasSnapList[0].Excerpt, "f4-readback-bytes-unchanged", "captured bytes preserved");
}
// ---- F5 live explicit record-item Current follows the REFERENCED owner ----
{
  var f5Meet = new Meeting { BoardId = bid1, Title = "f5-m", State = MeetingState.Active, Generation = 0 }; mem.Meetings[f5Meet.Id] = f5Meet; mem.Meetings.Flush();
  var recV1 = new RecordDraft { BoardId = bid1, MeetingId = f5Meet.Id, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"s1\",\"text\":\"BUY\"}]", Hash = "h5a", ApprovedJson = "[\"s1\"]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f5-A", HistoryJson = "[{\"seq\":1,\"revision\":1,\"token\":\"tok-f5-A\",\"action\":\"approve\",\"itemId\":\"s1\",\"oldText\":\"\",\"newText\":\"BUY\",\"actor\":\"alice\",\"viewedVersion\":1,\"viewedHash\":\"h5a\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"}]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = true, Status = "approved" };
  mem.Drafts[recV1.Id] = recV1; mem.Drafts.Flush();
recV1.Hash = H(recV1.ItemsJson);
  var recV2 = new RecordDraft { BoardId = bid1, MeetingId = f5Meet.Id, Version = 2, Watermark = 0, ItemsJson = "[{\"id\":\"s1\",\"text\":\"CUT\"}]", Hash = "h5b", ApprovedJson = "[\"s1\"]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f5-B", HistoryJson = "[{\"seq\":1,\"revision\":1,\"token\":\"tok-f5-B\",\"action\":\"approve\",\"itemId\":\"s1\",\"oldText\":\"\",\"newText\":\"CUT\",\"actor\":\"alice\",\"viewedVersion\":2,\"viewedHash\":\"h5b\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"}]", SupersedesJson = "[\"" + recV1.Id + "\"]", EvidenceSnapshotJson = "[]", Decided = true, Status = "approved" };
  mem.Drafts[recV2.Id] = recV2; mem.Drafts.Flush();
recV2.Hash = H(recV2.ItemsJson);
  Expect(RecordsOps.ValidateRestoreEntries(new[] { recV1, recV2 }) is null, "f5-amend-pair-validates", "A->B healthy");
  var destLive = new RecordDraft { BoardId = bid1, MeetingId = f5Meet.Id, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"d1\",\"text\":\"cite old\",\"refs\":[{\"kind\":\"record\",\"ref\":\"" + recV1.Id + ":s1\",\"version\":1}]}]", Hash = "h5d", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f5-D", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = false, Status = "open" };
  var liveOld = RecordsOps.ResolveEvidenceAuthorized(mem, ownerReq, destLive);
  Expect(liveOld.Count == 1 && liveOld[0].Missing, "f5-live-replaced-not-current", "A:s1 BUY replaced by B:s1 CUT is not live-current");
  var destNew = new RecordDraft { BoardId = bid1, MeetingId = f5Meet.Id, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"d1\",\"text\":\"cite new\",\"refs\":[{\"kind\":\"record\",\"ref\":\"" + recV2.Id + ":s1\",\"version\":2}]}]", Hash = "h5e", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f5-E", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = false, Status = "open" };
  var liveNew = RecordsOps.ResolveEvidenceAuthorized(mem, ownerReq, destNew);
  Expect(liveNew.Count == 1 && !liveNew[0].Missing && liveNew[0].Excerpt == "CUT", "f5-live-current-owner-CUT", liveNew.Count > 0 ? liveNew[0].Excerpt : "none");
  var destStored = new RecordDraft { BoardId = bid1, MeetingId = f5Meet.Id, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"d1\",\"text\":\"cite old\",\"refs\":[{\"kind\":\"record\",\"ref\":\"" + recV1.Id + ":s1\",\"version\":1}]}]", Hash = "h5f", ApprovedJson = "[\"d1\"]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f5-F", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "", Decided = true, Status = "approved" };
  // The stored snapshot below was captured while A:s1 was still the effective owner (same entry shape the
  // capture builder emits, proven in F4): history stays readable after B replaces it, live does not.
  destStored.EvidenceSnapshotJson = "[{\"itemId\":\"d1\",\"kind\":\"record\",\"ref\":\"" + recV1.Id + ":s1\",\"version\":1,\"available\":true,\"title\":\"record v1 [s1]\",\"excerpt\":\"BUY\",\"at\":\"2026-01-01T00:00:00Z\",\"revision\":1}]";
  var mergeOld = RecordsOps.MergeEvidenceForRead(mem, ownerReq, destStored);
  Expect(mergeOld.Count == 1 && !mergeOld[0].Missing && !mergeOld[0].CurrentEligible && mergeOld[0].Excerpt == "BUY", "f5-stored-historical-readable-noncurrent", "count=" + mergeOld.Count);
  foreach (var badRef in new[] { recV2.Id + ":", recV2.Id + ": ", ":s1", "nope:s1", "not-a-guid" })
  {
    var destBad = new RecordDraft { BoardId = bid1, MeetingId = f5Meet.Id, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"d1\",\"text\":\"cite bad\",\"refs\":[{\"kind\":\"record\",\"ref\":\"" + badRef + "\"}]}]", Hash = "h5g", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f5-G", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = false, Status = "open" };
    var liveBad = RecordsOps.ResolveEvidenceAuthorized(mem, ownerReq, destBad);
    Expect(liveBad.Count == 1 && liveBad[0].Missing, "f5-malformed-unavailable", badRef);
  }
  var destBare = new RecordDraft { BoardId = bid1, MeetingId = f5Meet.Id, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"d1\",\"text\":\"cite bare\",\"refs\":[{\"kind\":\"record\",\"ref\":\"" + recV2.Id + "\"}]}]", Hash = "h5h", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f5-H", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = false, Status = "open" };
  var liveBare = RecordsOps.ResolveEvidenceAuthorized(mem, ownerReq, destBare);
  Expect(liveBare.Count == 1 && !liveBare[0].Missing && liveBare[0].Excerpt.Contains("CUT"), "f5-bare-whole-record-preserved", "no bare-ref broadening, no narrowing");
}
// ---- F6 consistent typed validation both export modes + resolver card ----
{
  string EX(string items, string appr, bool det) => RecordsOps.BuildExport(items, appr, det);
  var healthyItems = "[{\"id\":\"g1\",\"text\":\"good\",\"detail\":\"d\",\"status\":\"ok\",\"scope\":\"board\",\"refs\":[{\"kind\":\"note\",\"ref\":\"" + Guid.NewGuid() + "\"}]}]";
  Expect(EX(healthyItems, "[\"g1\"]", false) != "" && EX(healthyItems, "[\"g1\"]", true) != "", "f6-healthy-exports-both-modes", "control non-empty");
  var cases = new (string name, string items)[]
  {
    ("numeric-detail", "[{\"id\":\"g1\",\"text\":\"good\",\"detail\":5}]"),
    ("numeric-status", "[{\"id\":\"g1\",\"text\":\"good\",\"status\":7}]"),
    ("numeric-scope", "[{\"id\":\"g1\",\"text\":\"good\",\"scope\":9}]"),
    ("refs-nonarray", "[{\"id\":\"g1\",\"text\":\"good\",\"refs\":{}}]"),
    ("ref-numeric-kind", "[{\"id\":\"g1\",\"text\":\"good\",\"refs\":[{\"kind\":5,\"ref\":\"x\"}]}]"),
    ("ref-numeric-ref", "[{\"id\":\"g1\",\"text\":\"good\",\"refs\":[{\"kind\":\"note\",\"ref\":5}]}]"),
    ("ref-numeric-id", "[{\"id\":\"g1\",\"text\":\"good\",\"refs\":[{\"kind\":\"note\",\"id\":5}]}]"),
    ("ref-numeric-version", "[{\"id\":\"g1\",\"text\":\"good\",\"refs\":[{\"kind\":\"note\",\"ref\":\"x\",\"version\":\"v\"}]}]"),
    ("unapproved-numeric-detail", "[{\"id\":\"g1\",\"text\":\"good\"},{\"id\":\"u9\",\"text\":\"unapproved\",\"detail\":5}]"),
    ("ghost-approved", "[{\"id\":\"g1\",\"text\":\"good\"}]"),
    ("numeric-approved", "[{\"id\":1,\"text\":\"x\"}]"),
    ("refs-empty-object", "[{\"id\":\"g1\",\"text\":\"good\",\"refs\":[{}]}]"),
    ("ref-unknown-kind", "[{\"id\":\"g1\",\"text\":\"good\",\"refs\":[{\"kind\":\"zzz\",\"ref\":\"x\"}]}]"),
    ("ref-missing-identity", "[{\"id\":\"g1\",\"text\":\"good\",\"refs\":[{\"kind\":\"note\"}]}]"),
  };
  foreach (var (cname, citems) in cases)
  {
    var appr = cname == "ghost-approved" ? "[\"ghost\"]" : (cname == "numeric-approved" ? "[\"1\"]" : "[\"g1\"]");
    var c1 = EX(citems, appr, false); var c2 = EX(citems, appr, true);
    Expect(c1 == "" && c2 == "", "f6-export-fails-both-modes-" + cname, "concise=" + c1.Length + " detailed=" + c2.Length);
  }
  var fracItems = "[{\"id\":\"g1\",\"text\":\"good\",\"refs\":[{\"kind\":\"source\",\"ref\":\"" + docB.Id + "\",\"version\":1.5}]}]";
  var fracDraft = new RecordDraft { BoardId = bid1, MeetingId = recMeet.Id, Version = 1, Watermark = 0, ItemsJson = fracItems, Hash = "h6", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f6", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = false, Status = "open" };
  var fracCards = RecordsOps.ResolveEvidenceAuthorized(mem, ownerReq, fracDraft);
  Expect(fracCards.Count == 0, "f6-fractional-version-no-available-card", "fail-closed whole item, count=" + fracCards.Count);
  var fracTwinItems = "[{\"id\":\"g1\",\"text\":\"good\",\"refs\":[{\"kind\":\"source\",\"ref\":\"" + Guid.NewGuid() + "\",\"version\":1}]}]";
  var fracTwin = new RecordDraft { BoardId = bid1, MeetingId = recMeet.Id, Version = 1, Watermark = 0, ItemsJson = fracTwinItems, Hash = "h6t", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f6t", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = false, Status = "open" };
  var fracTwinCards = RecordsOps.ResolveEvidenceAuthorized(mem, ownerReq, fracTwin);
  Expect(fracTwinCards.Count == 1 && fracTwinCards[0].Missing, "f6-valid-pin-unknown-source-unavailable", "valid pin, unknown source -> 1 unavailable card");
  var ghostDraft = new RecordDraft { BoardId = bid1, MeetingId = recMeet.Id, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"g1\",\"text\":\"good\"}]", Hash = "h6b", ApprovedJson = "[\"ghost\"]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f6b", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = true, Status = "approved" };
  var ghostCards = RecordsOps.ResolveEvidenceAuthorized(mem, ownerReq, ghostDraft);
  Expect(ghostCards.Count == 0, "f6-ghost-no-cards", "ghost approved id yields no card, count=" + ghostCards.Count);
  var ghostMixedItems = "[{\"id\":\"g1\",\"text\":\"good\"}]";
  Expect(EX(ghostMixedItems, "[\"g1\",\"ghost\"]", false) == "" && EX(ghostMixedItems, "[\"g1\",\"ghost\"]", true) == "", "f6-export-fails-both-modes-ghost-mixed", "mixed valid+ghost approvals fail closed");
  var emptyTextItems = "[{\"id\":\"g1\",\"text\":\"\"}]";
  Expect(EX(emptyTextItems, "[\"g1\"]", false) == "" && EX(emptyTextItems, "[\"g1\"]", true) == "", "f6-export-fails-both-modes-empty-approved-text", "empty approved text yields no card");
  var numExcerptItems = "[{\"id\":\"g1\",\"text\":\"good\",\"refs\":[{\"kind\":\"note\",\"ref\":\"x\",\"excerpt\":5}]}]";
  Expect(EX(numExcerptItems, "[\"g1\"]", false) == "" && EX(numExcerptItems, "[\"g1\"]", true) == "", "f6-export-fails-both-modes-numeric-excerpt", "numeric ref metadata fails closed");
  var fracExportItems = "[{\"id\":\"g1\",\"text\":\"good\",\"refs\":[{\"kind\":\"source\",\"ref\":\"" + docB.Id + "\",\"version\":1.5}]}]";
  Expect(EX(fracExportItems, "[\"g1\"]", false) == "" && EX(fracExportItems, "[\"g1\"]", true) == "", "f6-export-fails-both-modes-fractional-version", "fractional version fails closed, never silent-omit");
  // Referring destinations: a destination that actually references each malformed source
  // record resolves unavailable through the real resolver (not an empty-available card).
  var badEmpty = new RecordDraft { BoardId = bid1, MeetingId = recMeet.Id, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"g1\",\"text\":\"\"}]", Hash = "h6e", ApprovedJson = "[\"g1\"]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f6e", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = true, Status = "approved" };
  badEmpty.Hash = H(badEmpty.ItemsJson); mem.Drafts[badEmpty.Id] = badEmpty; mem.Drafts.Flush();
  var badGhostRec = new RecordDraft { BoardId = bid1, MeetingId = recMeet.Id, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"g1\",\"text\":\"good\"}]", Hash = "h6g", ApprovedJson = "[\"ghost\"]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f6g", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = true, Status = "approved" };
  badGhostRec.Hash = H(badGhostRec.ItemsJson); mem.Drafts[badGhostRec.Id] = badGhostRec; mem.Drafts.Flush();
  foreach (var (badRec, badName) in new[] { (badEmpty, "empty-approved-text"), (badGhostRec, "ghost-approved") })
  {
    var refDest = new RecordDraft { BoardId = bid1, MeetingId = recMeet.Id, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"d1\",\"text\":\"cite\",\"refs\":[{\"kind\":\"record\",\"ref\":\"" + badRec.Id + "\"}]}]", Hash = "h6d", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f6d", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = false, Status = "open" };
    var refCards = RecordsOps.ResolveEvidenceAuthorized(mem, ownerReq, refDest);
    Expect(refCards.Count == 1 && refCards[0].Missing, "f6-destination-unavailable-" + badName, "referring destination gets unavailable, count=" + refCards.Count);
  }
}
// ---- F2 COMPLETE staged validator: real amend chain + controlled corruptions ----
{
  var f2Meet = new Meeting { BoardId = bid1, Title = "f2-m", State = MeetingState.Active, Generation = 0 }; mem.Meetings[f2Meet.Id] = f2Meet; mem.Meetings.Flush();
  var itemsA = "[{\"id\":\"s1\",\"text\":\"BUY\"},{\"id\":\"s2\",\"text\":\"KEEP\"}]";
  var draftA = new RecordDraft { BoardId = bid1, MeetingId = f2Meet.Id, Version = 1, Watermark = 0, ItemsJson = itemsA, Hash = "h2a", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f2-A0", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = false, Status = "open" };
  mem.Drafts[draftA.Id] = draftA; mem.Drafts.Flush();
draftA.Hash = H(draftA.ItemsJson);
  var mapA = RecordsOps.ItemMap(draftA.ItemsJson, out var mapAErr);
  Expect(mapAErr == "", "f2-amend-itemmap", mapAErr);
  var histA = "[]";
  Expect(RecordsOps.TryBuildHistoryJson(histA, "approve", "s1", "", "BUY", "alice", 1, "h2a", 0, "tok-f2-A0", 2, "tok-f2-A1", out var histA1, out var herrA1), "f2-amend-history-s1", herrA1);
  Expect(RecordsOps.TryBuildHistoryJson(histA1, "approve", "s2", "", "KEEP", "alice", 1, "h2a", 0, "tok-f2-A0", 2, "tok-f2-A1", out var histA2, out var herrA2), "f2-amend-history-s2", herrA2);
  draftA.HistoryJson = histA2; draftA.ApprovedJson = "[\"s1\",\"s2\"]"; draftA.ReviewRevision = 2; draftA.ReviewToken = "tok-f2-A1";
  var liveA = RecordsOps.ResolveEvidenceAuthorized(mem, ownerReq, draftA);
  Expect(RecordsOps.TryBuildSnapshots("[]", mapA, liveA, new[] { "s1", "s2" }, 2, out var snapsA, out var serrA, refId => OrigOf(mem, refId)), "f2-amend-snapshots", serrA);
  draftA.EvidenceSnapshotJson = snapsA; RecordsOps.RefreshDecided(draftA); mem.Drafts.Flush();
  Expect(draftA.Decided && draftA.Status == "approved", "f2-amend-A-approved", draftA.Status);
  var itemsB = "[{\"id\":\"s1\",\"text\":\"CUT\"},{\"id\":\"s2\",\"text\":\"KEEP\"}]";
  var draftB = new RecordDraft { BoardId = bid1, MeetingId = f2Meet.Id, Version = 2, Watermark = 0, ItemsJson = itemsB, Hash = "h2b", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f2-B0", HistoryJson = "[]", SupersedesJson = "[\"" + draftA.Id + "\"]", EvidenceSnapshotJson = "[]", Decided = false, Status = "open" };
  Expect(RecordsOps.TryBuildHistoryJson("[]", "amend-branch", "", itemsA, itemsB, "alice", 1, "h2a", 0, "tok-f2-A1", 1, "tok-f2-B0", out var histB0, out var herrB0), "f2-amend-branch", herrB0);
  draftB.HistoryJson = histB0;
  Expect(RecordsOps.TryBuildHistoryJson(draftA.HistoryJson, "amend-child", "", itemsA, itemsB, "alice", 1, "h2a", 0, "tok-f2-A1", 3, "tok-f2-A2", out var histA3, out var herrA3), "f2-amend-child", herrA3);
  draftA.HistoryJson = histA3; draftA.ReviewRevision = 3; draftA.ReviewToken = "tok-f2-A2"; mem.Drafts.Flush();
  Expect(RecordsOps.TryBuildHistoryJson(draftB.HistoryJson, "approve", "s1", "", "CUT", "alice", 2, "h2b", 0, "tok-f2-B0", 2, "tok-f2-B1", out var histB1, out var herrB1), "f2-amend-approve-s1", herrB1);
  Expect(RecordsOps.TryBuildHistoryJson(histB1, "approve", "s2", "", "KEEP", "alice", 2, "h2b", 0, "tok-f2-B0", 2, "tok-f2-B1", out var histB2, out var herrB2), "f2-amend-approve-s2", herrB2);
  draftB.HistoryJson = histB2; draftB.ApprovedJson = "[\"s1\",\"s2\"]"; draftB.ReviewRevision = 2; draftB.ReviewToken = "tok-f2-B1";
  var mapB = RecordsOps.ItemMap(draftB.ItemsJson, out _);
  var liveB = RecordsOps.ResolveEvidenceAuthorized(mem, ownerReq, draftB);
  Expect(RecordsOps.TryBuildSnapshots("[]", mapB, liveB, new[] { "s1", "s2" }, 2, out var snapsB, out var serrB, refId => OrigOf(mem, refId)), "f2-amend-snapshots-B", serrB);
draftB.Hash = H(draftB.ItemsJson);
  draftB.EvidenceSnapshotJson = snapsB; RecordsOps.RefreshDecided(draftB); mem.Drafts[draftB.Id] = draftB; mem.Drafts.Flush();
  Expect(RecordsOps.ValidateRestoreEntries(new[] { draftA, draftB }) is null, "f2-healthy-amend-validates", "real amend pair");
  Expect(RecordsOps.BuildExport(draftA.ItemsJson, draftA.ApprovedJson, false).Contains("BUY"), "f2-export-A-concise", "A exports BUY");
  Expect(RecordsOps.BuildExport(draftB.ItemsJson, draftB.ApprovedJson, true).Contains("CUT"), "f2-export-B-detailed", "B exports CUT");
  string SerBatch() => JsonSerializer.Serialize(new[] { draftA, draftB });
  var controlBytes = SerBatch();
  void Corrupt(string cname, Action<RecordDraft, RecordDraft> mut, IDictionary<string, int>? mo = null, IDictionary<string, int>? mc = null)
  {
    var aJson = JsonSerializer.Serialize(draftA); var bJson = JsonSerializer.Serialize(draftB);
    var a2 = JsonSerializer.Deserialize<RecordDraft>(aJson)!; var b2 = JsonSerializer.Deserialize<RecordDraft>(bJson)!;
    mut(a2, b2);
    if (cname != "forged-content-hash") { a2.Hash = H(a2.ItemsJson); b2.Hash = H(b2.ItemsJson); }
    var err = RecordsOps.ValidateRestoreEntries(new[] { a2, b2 }, mo, mc);
    Expect(err is not null, "f2-reject-" + cname, err ?? "null (must reject)");
    Expect(SerBatch() == controlBytes, "f2-control-unchanged-" + cname, "prewrite control byte-exact");
  }
  Corrupt("history-numeric-itemid", (a2, b2) => { b2.HistoryJson = "[{\"seq\":1,\"revision\":2,\"token\":\"tok-f2-B1\",\"action\":\"approve\",\"itemId\":123,\"actor\":\"alice\",\"viewedVersion\":2,\"viewedHash\":\"h2b\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"oldText\":\"\",\"newText\":\"x\"}]"; });
  Corrupt("history-missing-actor", (a2, b2) => { b2.HistoryJson = "[{\"seq\":1,\"revision\":2,\"token\":\"tok-f2-B1\",\"action\":\"approve\",\"itemId\":\"s1\",\"oldText\":\"\",\"newText\":\"x\",\"viewedVersion\":2,\"viewedHash\":\"h2b\",\"viewedWatermark\":0,\"viewedToken\":\"t\"}]"; });
  Corrupt("history-detached-tip", (a2, b2) => { b2.ReviewToken = "tok-forged"; });
  Corrupt("overlap", (a2, b2) => { b2.DiscardedJson = "[\"s1\"]"; });
  Corrupt("cycle-ABA", (a2, b2) => { a2.SupersedesJson = "[\"" + b2.Id + "\"]"; });
  Corrupt("supersedes-missing-parent", (a2, b2) => { b2.SupersedesJson = "[\"" + Guid.NewGuid() + "\"]"; });
  Corrupt("supersedes-cross-scope", (a2, b2) => { b2.MeetingId = Guid.NewGuid(); });
  Corrupt("undeclared-snapshot-ref", (a2, b2) => { b2.EvidenceSnapshotJson = "[{\"itemId\":\"s1\",\"kind\":\"source\",\"ref\":\"" + Guid.NewGuid() + "\",\"version\":1,\"available\":true,\"title\":\"t\",\"excerpt\":\"x\",\"at\":\"2026-01-01T00:00:00Z\",\"revision\":2}]"; });
  Corrupt("snapshot-item-unapproved", (a2, b2) => {
    b2.ApprovedJson = "[\"s1\"]"; b2.Status = "partially-approved"; b2.Decided = false;
    b2.HistoryJson = "[{\"seq\":1,\"revision\":2,\"token\":\"tok-f2-B1\",\"action\":\"approve\",\"itemId\":\"s1\",\"oldText\":\"\",\"newText\":\"CUT\",\"actor\":\"alice\",\"viewedVersion\":2,\"viewedHash\":\"h2b\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"}]";
    b2.EvidenceSnapshotJson = "[{\"itemId\":\"s2\",\"kind\":\"note\",\"ref\":\"" + Guid.NewGuid() + "\",\"version\":null,\"available\":false,\"title\":\"\",\"excerpt\":\"\",\"at\":\"2026-01-01T00:00:00Z\",\"revision\":2}]";
  });
  Corrupt("snapshot-version-mismatch", (a2, b2) => {
    b2.ItemsJson = "[{\"id\":\"s1\",\"text\":\"CUT\",\"refs\":[{\"kind\":\"source\",\"ref\":\"" + docA3.Id + "\",\"version\":1}]},{\"id\":\"s2\",\"text\":\"KEEP\"}]";
    b2.EvidenceSnapshotJson = "[{\"itemId\":\"s1\",\"kind\":\"source\",\"ref\":\"" + docA3.Id + "\",\"version\":2,\"available\":true,\"title\":\"t\",\"excerpt\":\"x\",\"at\":\"2026-01-01T00:00:00Z\",\"revision\":2}]";
  });
  Corrupt("snapshot-cross-version-dup", (a2, b2) => {
    b2.ItemsJson = "[{\"id\":\"s1\",\"text\":\"CUT\",\"refs\":[{\"kind\":\"source\",\"ref\":\"" + docA3.Id + "\",\"version\":1}]},{\"id\":\"s2\",\"text\":\"KEEP\"}]";
    b2.EvidenceSnapshotJson = "[{\"itemId\":\"s1\",\"kind\":\"source\",\"ref\":\"" + docA3.Id + "\",\"version\":1,\"available\":false,\"title\":\"\",\"excerpt\":\"\",\"at\":\"2026-01-01T00:00:00Z\",\"revision\":2},{\"itemId\":\"s1\",\"kind\":\"source\",\"ref\":\"" + docA3.Id + "\",\"version\":3,\"available\":true,\"title\":\"t\",\"excerpt\":\"x\",\"at\":\"2026-01-01T00:00:00Z\",\"revision\":2}]";
  });
  Corrupt("snapshot-available-empty", (a2, b2) => {
    b2.ItemsJson = "[{\"id\":\"s1\",\"text\":\"CUT\",\"refs\":[{\"kind\":\"note\",\"ref\":\"" + Guid.NewGuid() + "\"}]},{\"id\":\"s2\",\"text\":\"KEEP\"}]";
    var rid = JsonDocument.Parse(b2.ItemsJson).RootElement.EnumerateArray().First().GetProperty("refs").EnumerateArray().First().GetProperty("ref").GetString();
    b2.EvidenceSnapshotJson = "[{\"itemId\":\"s1\",\"kind\":\"note\",\"ref\":\"" + rid + "\",\"version\":null,\"available\":true,\"title\":\"\",\"excerpt\":\"\",\"at\":\"2026-01-01T00:00:00Z\",\"revision\":2}]";
  });
  Corrupt("history-approve-outside-approved", (a2, b2) => {
    b2.HistoryJson = "[{\"seq\":1,\"revision\":2,\"token\":\"tok-f2-B1\",\"action\":\"approve\",\"itemId\":\"ghost\",\"oldText\":\"\",\"newText\":\"x\",\"actor\":\"alice\",\"viewedVersion\":2,\"viewedHash\":\"h2b\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"}]";
    b2.ItemsJson = "[{\"id\":\"ghost\",\"text\":\"x\"},{\"id\":\"s1\",\"text\":\"CUT\"},{\"id\":\"s2\",\"text\":\"KEEP\"}]"; b2.Status = "partially-approved"; b2.Decided = false;
  });
  Corrupt("unknown-status", (a2, b2) => { b2.Status = "melted"; });
  Corrupt("token-without-history", (a2, b2) => { b2.HistoryJson = "[]"; });
  Corrupt("history-without-token", (a2, b2) => { b2.ReviewToken = ""; });
  // F2 writer-identity correspondence (status/hash/version/revision monotonicity).
  Corrupt("status-approved-with-pending", (a2, b2) => {
    b2.ItemsJson = "[{\"id\":\"s1\",\"text\":\"CUT\"},{\"id\":\"s2\",\"text\":\"KEEP\"},{\"id\":\"s3\",\"text\":\"NEW\"}]";
  });
  Corrupt("forged-content-hash", (a2, b2) => { b2.Hash = "0000000000000000"; });
  Corrupt("version-zero", (a2, b2) => { b2.Version = 0; });
  Corrupt("history-revision-regress", (a2, b2) => {
    b2.ReviewRevision = 3; b2.ReviewToken = "tok-f2-B1";
    b2.HistoryJson = "[{\"seq\":1,\"revision\":2,\"token\":\"tok-f2-B1\",\"action\":\"approve\",\"itemId\":\"s1\",\"oldText\":\"\",\"newText\":\"CUT\",\"actor\":\"alice\",\"viewedVersion\":2,\"viewedHash\":\"h2b\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"},{\"seq\":2,\"revision\":5,\"token\":\"tok-f2-B1\",\"action\":\"approve\",\"itemId\":\"s2\",\"oldText\":\"\",\"newText\":\"KEEP\",\"actor\":\"alice\",\"viewedVersion\":2,\"viewedHash\":\"h2b\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"},{\"seq\":3,\"revision\":3,\"token\":\"tok-f2-B1\",\"action\":\"approve\",\"itemId\":\"s2\",\"oldText\":\"\",\"newText\":\"KEEP\",\"actor\":\"alice\",\"viewedVersion\":2,\"viewedHash\":\"h2b\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"}]";
  });
  // Modern blank-review forgeries (F2/P1 provenance): a modern new no-ref rev1 row
  // carries an explicit FALSE marker, so wiping its history must NOT inherit legacy
  // acceptance. Bad hash, illegal version, and forged lifecycle under the same blank
  // shape must also reject; only persisted-true provenance with a genuine base accepts.
  RecordDraft ModernBlankForgery(Action<RecordDraft> mut)
  {
    var items = "[{\"id\":\"s1\",\"text\":\"KEEP\"}]";
    var g = new RecordDraft { BoardId = bid1, MeetingId = f2Meet.Id, Version = 1, Watermark = 0,
      ItemsJson = items, Hash = H(items), ApprovedJson = "[]", DiscardedJson = "[]",
      ReviewRevision = 1, ReviewToken = "tok-modern-blank", HistoryJson = "[]", SupersedesJson = "[]",
      EvidenceSnapshotJson = "[]", Decided = false, Status = "open", LegacyReview = false };
    mut(g);
    return g;
  }
  Expect(RecordsOps.ValidateRestoreEntries(new[] { ModernBlankForgery(_ => { }) }) is not null, "f2-reject-modern-blank-history-cleared", "marker-false rev1 no-ref wiped history rejects");
  Expect(RecordsOps.ValidateRestoreEntries(new[] { ModernBlankForgery(g => { g.Hash = "0000000000000000"; }) }) is not null, "f2-reject-modern-blank-bad-hash", "marker-false blank shape with forged hash rejects");
  Expect(RecordsOps.ValidateRestoreEntries(new[] { ModernBlankForgery(g => { g.Version = 0; }) }) is not null, "f2-reject-modern-blank-bad-version", "marker-false blank shape with illegal version rejects");
  Expect(RecordsOps.ValidateRestoreEntries(new[] { ModernBlankForgery(g => { g.Status = "approved"; g.Decided = true; }) }) is not null, "f2-reject-modern-blank-forged-lifecycle", "marker-false blank shape with approved-but-empty lifecycle rejects");
  var genuineOldBlank = ModernBlankForgery(_ => { }); genuineOldBlank.LegacyReview = true;
  Expect(RecordsOps.ValidateRestoreEntries(new[] { genuineOldBlank }) is null, "f2-legacy-provenance-blank-accepted", "marker-true rev1 no-ref genuine base accepts, still readonly");
  Expect(!RecordsOps.StrictStateCheck(mem, genuineOldBlank, out var glStateErr), "f2-legacy-provenance-mutation-closed", glStateErr + " (provenance never approves silently)");
  // F3 alias with the REAL staged alias map present: requested-1/captured-3 accepts only
  // for the actual orig-1/canon-3 pair; requested-1/captured-999 and null captures reject.
  var (stagedOrig, stagedCanon) = MapsOf(mem);
  Expect(stagedOrig.TryGetValue(docA3.Id.ToString(), out var docA3Orig) && docA3Orig == 1, "f3-map-orig-1-from-event", "orig=" + docA3Orig);
  Expect(stagedCanon.TryGetValue(docA3.Id.ToString(), out var docA3Canon) && docA3Canon == 3, "f3-map-canon-3-from-head", "canon=" + docA3Canon);
  RecordDraft AliasDraft(string pinJson, string snapJson)
  {
    return new RecordDraft { BoardId = bid1, MeetingId = f2Meet.Id, Version = 1, Watermark = 0, ItemsJson = "[{\"id\":\"s1\",\"text\":\"CUT\",\"refs\":[{\"kind\":\"source\",\"ref\":\"" + docA3.Id + "\",\"version\":" + pinJson + "}]},{\"id\":\"s2\",\"text\":\"KEEP\"}]", Hash = "hx", ApprovedJson = "[\"s1\",\"s2\"]", DiscardedJson = "[]", ReviewRevision = 2, ReviewToken = "tok-f2-B1", HistoryJson = "[{\"seq\":1,\"revision\":2,\"token\":\"tok-f2-B1\",\"action\":\"approve\",\"itemId\":\"s1\",\"oldText\":\"\",\"newText\":\"CUT\",\"actor\":\"alice\",\"viewedVersion\":2,\"viewedHash\":\"hx\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"},{\"seq\":2,\"revision\":2,\"token\":\"tok-f2-B1\",\"action\":\"approve\",\"itemId\":\"s2\",\"oldText\":\"\",\"newText\":\"KEEP\",\"actor\":\"alice\",\"viewedVersion\":2,\"viewedHash\":\"hx\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"}]", SupersedesJson = "[]", EvidenceSnapshotJson = snapJson, Decided = true, Status = "approved" };
  }
  string AliasSnap(int? ver, bool avail) => "[{\"itemId\":\"s1\",\"kind\":\"source\",\"ref\":\"" + docA3.Id + "\",\"version\":" + (ver.HasValue ? ver.Value.ToString() : "null") + ",\"available\":" + (avail ? "true" : "false") + ",\"title\":\"t\",\"excerpt\":\"x\",\"at\":\"2026-01-01T00:00:00Z\",\"revision\":2}]";
  var aliasGood = AliasDraft("1", AliasSnap(3, true)); aliasGood.Hash = H(aliasGood.ItemsJson);
  Expect(RecordsOps.ValidateRestoreEntries(new[] { aliasGood }, stagedOrig, stagedCanon) is null, "f3-alias-pin1-capture3-accepts", "real orig-1/canon-3 mapping");
  Corrupt("alias-pin1-capture999", (a2, b2) => {
    var g = AliasDraft("1", AliasSnap(999, true)); g.Hash = H(g.ItemsJson);
    b2.ItemsJson = g.ItemsJson; b2.ApprovedJson = g.ApprovedJson; b2.DiscardedJson = g.DiscardedJson; b2.ReviewRevision = g.ReviewRevision; b2.ReviewToken = g.ReviewToken; b2.HistoryJson = g.HistoryJson; b2.EvidenceSnapshotJson = g.EvidenceSnapshotJson; b2.Decided = g.Decided; b2.Status = g.Status;
  }, stagedOrig, stagedCanon);
  Corrupt("alias-pin1-capture-null", (a2, b2) => {
    var g = AliasDraft("1", AliasSnap(null, false)); g.Hash = H(g.ItemsJson);
    b2.ItemsJson = g.ItemsJson; b2.ApprovedJson = g.ApprovedJson; b2.DiscardedJson = g.DiscardedJson; b2.ReviewRevision = g.ReviewRevision; b2.ReviewToken = g.ReviewToken; b2.HistoryJson = g.HistoryJson; b2.EvidenceSnapshotJson = g.EvidenceSnapshotJson; b2.Decided = g.Decided; b2.Status = g.Status;
  }, stagedOrig, stagedCanon);
}
// ---- F2 whole-draft revise parent: writer-shaped superseded/decided/empty restores ----
{
  var f2rMeet = new Meeting { BoardId = bid1, Title = "f2r-m", State = MeetingState.Active, Generation = 0 }; mem.Meetings[f2rMeet.Id] = f2rMeet; mem.Meetings.Flush();
  var rItems = "[{\"id\":\"s1\",\"text\":\"BUY\"},{\"id\":\"s2\",\"text\":\"KEEP\"}]";
  var rParentHist = "[{\"seq\":1,\"revision\":2,\"token\":\"tok-f2-R1\",\"action\":\"revise-child\",\"itemId\":\"\",\"oldText\":\"" + rItems.Replace("\"", "\\\"") + "\",\"newText\":\"" + rItems.Replace("\"", "\\\"") + "\",\"actor\":\"alice\",\"viewedVersion\":1,\"viewedHash\":\"h2r\",\"viewedWatermark\":0,\"viewedToken\":\"tok-f2-R0\",\"at\":\"2026-01-01T00:00:00Z\"}]";
  var rParent = new RecordDraft { BoardId = bid1, MeetingId = f2rMeet.Id, Version = 1, Watermark = 0, ItemsJson = rItems, Hash = "h2r", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 2, ReviewToken = "tok-f2-R1", HistoryJson = rParentHist, SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = true, Status = "superseded" };
  rParent.Hash = H(rParent.ItemsJson);
  var rChildHist = "[{\"seq\":1,\"revision\":1,\"token\":\"tok-f2-R0\",\"action\":\"revise-branch\",\"itemId\":\"\",\"oldText\":\"\",\"newText\":\"\",\"actor\":\"alice\",\"viewedVersion\":1,\"viewedHash\":\"h2r\",\"viewedWatermark\":0,\"viewedToken\":\"tok-f2-R0\",\"at\":\"2026-01-01T00:00:00Z\"}]";
  var rChild = new RecordDraft { BoardId = bid1, MeetingId = f2rMeet.Id, Version = 2, Watermark = 0, ItemsJson = rItems, Hash = "h2r", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f2-R0", HistoryJson = rChildHist, SupersedesJson = "[\"" + rParent.Id + "\"]", EvidenceSnapshotJson = "[]", Decided = false, Status = "open" };
  rChild.Hash = H(rChild.ItemsJson);
  Expect(RecordsOps.ValidateRestoreEntries(new[] { rParent, rChild }) is null, "f2-revise-parent-accepts", "writer superseded/decided/empty + history + lined child");
  var noHistJson = JsonSerializer.Serialize(rParent);
  var noHist = JsonSerializer.Deserialize<RecordDraft>(noHistJson)!; noHist.HistoryJson = "[]";
  Expect(RecordsOps.ValidateRestoreEntries(new[] { noHist, rChild }) is not null, "f2-reject-revise-parent-no-history", "superseded decided-empty without history still rejects");
  Expect(RecordsOps.ValidateRestoreEntries(new[] { rParent }) is not null, "f2-reject-revise-parent-no-child", "superseded decided-empty without a superseding child still rejects");
  var apprJson = JsonSerializer.Serialize(rParent);
  var apprOnly = JsonSerializer.Deserialize<RecordDraft>(apprJson)!; apprOnly.Status = "approved";
  Expect(RecordsOps.ValidateRestoreEntries(new[] { apprOnly, rChild }) is not null, "f2-reject-decided-empty-approved", "ordinary decided-empty rejects before any superseded exception");
  var legJson = JsonSerializer.Serialize(rParent);
  var legParent = JsonSerializer.Deserialize<RecordDraft>(legJson)!; legParent.LegacyReview = true;
  Expect(RecordsOps.ValidateRestoreEntries(new[] { legParent, rChild }) is null, "f2-legacy-copy-parent-accepts", "pending legacy-copy parent restores via the same narrow shape");
}
// ---- F3 head-movement + forged-destination: canonical follows the REFERENCED row ----
{
  // A later source T v4 is approved in docA3's family; S stays the same v3 row.
  // Canonical identity must remain S's own version (3), so the genuine pin-1 /
  // capture-3 snapshot stays restorable, while capture-4 (another row's version) rejects.
  var docT = SeedSource(mem, bid1, aliasFile, 4, "approved", Sha("alias-bytes-T-newhead")); SeedSections(mem, docT);
  headA3.HeadVersion = 4; headA3.HeadSourceId = docT.Id; mem.SourceHeads.Flush();
  var f3Meet = new Meeting { BoardId = bid1, Title = "f3-m", State = MeetingState.Active, Generation = 0 }; mem.Meetings[f3Meet.Id] = f3Meet; mem.Meetings.Flush();
  var (movedOrig, movedCanon) = MapsOf(mem);
  Expect(movedCanon.TryGetValue(docA3.Id.ToString(), out var movedCanonS) && movedCanonS == 3, "f3-canon-follows-row-after-head-move", "canon=" + movedCanonS);
  Expect(movedOrig.TryGetValue(docA3.Id.ToString(), out var movedOrigS) && movedOrigS == 1, "f3-orig-survives-head-move", "orig=" + movedOrigS);
  var movedItems = "[{\"id\":\"s1\",\"text\":\"CUT\",\"refs\":[{\"kind\":\"source\",\"ref\":\"" + docA3.Id + "\",\"version\":1}]},{\"id\":\"s2\",\"text\":\"KEEP\"}]";
  var movedHist = "[{\"seq\":1,\"revision\":2,\"token\":\"tok-f3-M1\",\"action\":\"approve\",\"itemId\":\"s1\",\"oldText\":\"\",\"newText\":\"CUT\",\"actor\":\"alice\",\"viewedVersion\":2,\"viewedHash\":\"hxm\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"},{\"seq\":2,\"revision\":2,\"token\":\"tok-f3-M1\",\"action\":\"approve\",\"itemId\":\"s2\",\"oldText\":\"\",\"newText\":\"KEEP\",\"actor\":\"alice\",\"viewedVersion\":2,\"viewedHash\":\"hxm\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"}]";
  RecordDraft MovedDraft(string snapJson)
  {
    var g = new RecordDraft { BoardId = bid1, MeetingId = f3Meet.Id, Version = 1, Watermark = 0, ItemsJson = movedItems, Hash = "hxm", ApprovedJson = "[\"s1\",\"s2\"]", DiscardedJson = "[]", ReviewRevision = 2, ReviewToken = "tok-f3-M1", HistoryJson = movedHist, SupersedesJson = "[]", EvidenceSnapshotJson = snapJson, Decided = true, Status = "approved" };
    g.Hash = H(g.ItemsJson);
    return g;
  }
  var movedGood = MovedDraft("[{\"itemId\":\"s1\",\"kind\":\"source\",\"ref\":\"" + docA3.Id + "\",\"version\":3,\"available\":true,\"title\":\"t\",\"excerpt\":\"x\",\"at\":\"2026-01-01T00:00:00Z\",\"revision\":2}]");
  Expect(RecordsOps.ValidateRestoreEntries(new[] { movedGood }, movedOrig, movedCanon) is null, "f3-alias-survives-head-move", "pin-1/capture-3 restorable after T v4");
  var movedBad = MovedDraft("[{\"itemId\":\"s1\",\"kind\":\"source\",\"ref\":\"" + docA3.Id + "\",\"version\":4,\"available\":true,\"title\":\"t\",\"excerpt\":\"x\",\"at\":\"2026-01-01T00:00:00Z\",\"revision\":2}]");
  Expect(RecordsOps.ValidateRestoreEntries(new[] { movedBad }, movedOrig, movedCanon) is not null, "f3-alias-rejects-new-head-version", "capture-4 is not S canonical-3");
  // Forged migration destination: v1->v999 pinned on a v3 row is not a genuine
  // chain to the row version, so no alias is established (orig falls back to 3).
  var forgFile = "forg-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".txt";
  var docF = SeedSource(mem, bid1, forgFile, 3, "approved", Sha("forg-bytes")); SeedSections(mem, docF);
  var fev = new SourceEvent { BoardId = bid1, SourceId = docF.Id, FamilyKey = docF.FamilyKey, Version = 3, Action = "migrate-version", Detail = "v1->v999" };
  mem.SourceEvents[fev.Id] = fev; mem.SourceEvents.Flush();
  var headF = new SourceFamilyHead { BoardId = bid1, FamilyKey = docF.FamilyKey, HeadVersion = 3, HeadSourceId = docF.Id, HighWater = 3 }; mem.SourceHeads[headF.Id] = headF; mem.SourceHeads.Flush();
  var (forgOrig, forgCanon) = MapsOf(mem);
  Expect(forgOrig.TryGetValue(docF.Id.ToString(), out var forgOrigF) && forgOrigF == 3, "f3-forged-destination-no-alias", "orig=" + forgOrigF);
  var forgItems = "[{\"id\":\"s1\",\"text\":\"CUT\",\"refs\":[{\"kind\":\"source\",\"ref\":\"" + docF.Id + "\",\"version\":1}]},{\"id\":\"s2\",\"text\":\"KEEP\"}]";
  RecordDraft ForgDraft(string snapJson)
  {
    var g = new RecordDraft { BoardId = bid1, MeetingId = f3Meet.Id, Version = 1, Watermark = 0, ItemsJson = forgItems, Hash = "hxf", ApprovedJson = "[\"s1\",\"s2\"]", DiscardedJson = "[]", ReviewRevision = 2, ReviewToken = "tok-f3-F1", HistoryJson = movedHist.Replace("tok-f3-M1", "tok-f3-F1").Replace("hxm", "hxf"), SupersedesJson = "[]", EvidenceSnapshotJson = snapJson, Decided = true, Status = "approved" };
    g.Hash = H(g.ItemsJson);
    return g;
  }
  var forgPin1 = ForgDraft("[{\"itemId\":\"s1\",\"kind\":\"source\",\"ref\":\"" + docF.Id + "\",\"version\":3,\"available\":true,\"title\":\"t\",\"excerpt\":\"x\",\"at\":\"2026-01-01T00:00:00Z\",\"revision\":2}]");
  Expect(RecordsOps.ValidateRestoreEntries(new[] { forgPin1 }, forgOrig, forgCanon) is not null, "f3-forged-destination-pin1-rejects", "v1->v999 establishes no orig-1");
  var forgItems3 = "[{\"id\":\"s1\",\"text\":\"CUT\",\"refs\":[{\"kind\":\"source\",\"ref\":\"" + docF.Id + "\",\"version\":3}]},{\"id\":\"s2\",\"text\":\"KEEP\"}]";
  var forgPin3 = ForgDraft("[{\"itemId\":\"s1\",\"kind\":\"source\",\"ref\":\"" + docF.Id + "\",\"version\":3,\"available\":true,\"title\":\"t\",\"excerpt\":\"x\",\"at\":\"2026-01-01T00:00:00Z\",\"revision\":2}]");
  forgPin3.ItemsJson = forgItems3; forgPin3.Hash = H(forgItems3);
  Expect(RecordsOps.ValidateRestoreEntries(new[] { forgPin3 }, forgOrig, forgCanon) is null, "f3-forged-destination-row-pin-accepts", "pin-3/capture-3 is the row version");
}
// ---- F2 genuine old v2 PRIMARY backup: legacy rows accepted, bytes preserved, readonly ----
{
  var backupPath = Environment.GetEnvironmentVariable("ESSENTIALS_LEGACY_BACKUP");
  if (string.IsNullOrWhiteSpace(backupPath))
  {
    var probeDir = AppContext.BaseDirectory;
    var root = new System.IO.DirectoryInfo(probeDir);
    for (var i = 0; i < 8 && root is not null; i++)
    {
      var cand = System.IO.Path.Combine(root.FullName, ".tmp", "dev-app-preservation-20261103-141739-UTC-backup.json");
      if (System.IO.File.Exists(cand)) { backupPath = cand; break; }
      cand = System.IO.Path.Combine(root.FullName, "sim_ceo", ".tmp", "dev-app-preservation-20261103-141739-UTC-backup.json");
      if (System.IO.File.Exists(cand)) { backupPath = cand; break; }
      root = root.Parent;
    }
  }
  Expect(!string.IsNullOrWhiteSpace(backupPath) && System.IO.File.Exists(backupPath), "f2-legacy-backup-present", backupPath ?? "not found");
  if (!string.IsNullOrWhiteSpace(backupPath) && System.IO.File.Exists(backupPath))
  {
    var raw = System.IO.File.ReadAllText(backupPath);
    using var outer = JsonDocument.Parse(raw);
    var snapStr = outer.RootElement.GetProperty("snapshot").GetString() ?? "";
    var restored = JsonSerializer.Deserialize<BackupSnapshot>(snapStr, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
    Expect(restored is not null, "f2-legacy-backup-deserializes", "v2 envelope");
    if (restored is not null)
    {
      Expect(restored.version == 2 && restored.boards.Count == 3 && restored.meetings.Count == 2 && restored.drafts.Count == 2, "f2-legacy-backup-shape", "v" + restored.version + " boards=" + restored.boards.Count + " meetings=" + restored.meetings.Count + " drafts=" + restored.drafts.Count);
      RecordsOps.ApplyLegacyMarkerBackfill(restored.drafts, restored.version);
      Expect(restored.drafts.All(x => x.LegacyReview == true), "f2-legacy-marker-backfilled", "pre-marker v2 missing markers become true where shape+base validate");
      var legacyErr = RecordsOps.ValidateRestoreEntries(restored.drafts);
      Expect(legacyErr is null, "f2-legacy-blank-token-accepted", legacyErr ?? "null (genuine pre-review rows accepted via persisted provenance, no fabrication)");
      foreach (var ld in restored.drafts)
      {
        var itemsBefore = ld.ItemsJson; var apprBefore = ld.ApprovedJson;
        var lmap = RecordsOps.ItemMap(ld.ItemsJson, out var lmapErr);
        Expect(lmapErr == "", "f2-legacy-items-readable", lmapErr);
        Expect(RecordsOps.IsReadableItems(ld.ItemsJson), "f2-legacy-readable", "lenient read ok");
        var lexp = RecordsOps.BuildExport(ld.ItemsJson, ld.ApprovedJson, false);
        Expect(ld.ItemsJson == itemsBefore && ld.ApprovedJson == apprBefore, "f2-legacy-bytes-preserved", "no mutation by reads");
        Expect(!RecordsOps.StrictStateCheck(mem, ld, out var lstateErr), "f2-legacy-mutation-closed", lstateErr + " (explicit repair required, not silent)");
        List<EvidenceCard> lcards = new();
        try { lcards = RecordsOps.MergeEvidenceForRead(mem, ownerReq, ld); Pass("f2-legacy-merge-nothrow", "cards=" + lcards.Count); }
        catch (Exception ex) { Fail("f2-legacy-merge-nothrow", ex.GetType().Name + " " + ex.Message); }
        Expect(lcards.All(c => c.Missing), "f2-legacy-no-fabricated-availability", "no-capture rows stay unavailable");
      }
    }
  }
}
// ================= PG SECTION (MANDATORY: no SKIP; any failure exits nonzero) =================
Emit("PG SECTION START");
static Dictionary<string, string> ParseCs(string cs)
{
  var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
  foreach (var part in (cs ?? "").Split(";"))
  {
    var kv = part.Split("=", 2);
    if (kv.Length == 2) d[kv[0].Trim()] = kv[1].Trim();
  }
  return d;
}
static string FullSnap(InMemoryStore s)
{
  var sb = new System.Text.StringBuilder();
  // Complete relevant field snapshot (F8): every persisted scalar that rollback must
  // preserve, including source ResourceId, meeting brief/participants/created, draft
  // board+meeting scope/created, all message fields, and head floor provenance.
  foreach (var d in s.Sources.Values.OrderBy(x => x.Id.ToString())) sb.AppendLine("SRC " + d.Id + "|" + d.BoardId + "|" + d.FileName + "|" + d.Version + "|" + d.ReviewState + "|" + d.Approved + "|" + d.Excluded + "|" + d.Scope + "|" + (d.MeetingId?.ToString() ?? "-") + "|" + d.Origin + "|" + (d.ResourceId?.ToString() ?? "-") + "|" + d.FamilyKey + "|" + d.IndexState + "|" + d.IndexGeneration + "|" + (d.IndexError ?? "") + "|" + (d.IndexCompletedAt?.ToString("o") ?? "-") + "|" + (d.ContentHash ?? "") + "|" + (d.ExtractionJson ?? "") + "|orig=" + (d.Original is null ? "-" : Sha(Convert.ToBase64String(d.Original))) + "|" + d.CreatedAt.ToString("o"));
  foreach (var x in s.SourceSections.Values.OrderBy(x => x.SourceId.ToString()).ThenBy(x => x.Ordinal)) sb.AppendLine("SEC " + x.Id + "|" + x.SourceId + "|" + x.BoardId + "|" + x.FamilyKey + "|" + x.SourceVersion + "|" + (x.ContentHash ?? "") + "|" + x.Ordinal + "|" + (x.Heading ?? "") + "|" + (x.Location ?? "") + "|g" + x.IndexGeneration + "|" + (x.Text ?? "") + "|" + x.CreatedAt.ToString("o"));
  foreach (var h in s.SourceHeads.Values.OrderBy(x => x.BoardId.ToString() + x.FamilyKey)) sb.AppendLine("HEAD " + h.Id + "|" + h.BoardId + "|" + h.FamilyKey + "|" + h.HeadVersion + "|" + h.HeadSourceId + "|hw" + h.HighWater + "|fl" + h.FloorVersion + "|" + h.UpdatedAt.ToString("o"));
  foreach (var e in s.SourceEvents.Values.OrderBy(x => x.CreatedAt).ThenBy(x => x.Id.ToString())) sb.AppendLine("EVT " + e.Id + "|" + e.BoardId + "|" + e.SourceId + "|" + (e.FamilyKey ?? "") + "|v" + e.Version + "|" + (e.Action ?? "") + "|" + (e.Detail ?? "") + "|" + e.CreatedAt.ToString("o"));
  foreach (var m in s.Meetings.Values.OrderBy(x => x.Id.ToString())) sb.AppendLine("MTG " + m.Id + "|" + m.BoardId + "|" + (m.Title ?? "") + "|" + (m.Brief ?? "") + "|" + (m.ParticipantIdsJson ?? "") + "|" + m.State + "|gen" + m.Generation + "|rev" + m.DeliveredRevision + "|" + m.CreatedAt.ToString("o"));
  foreach (var kv in s.Messages.OrderBy(x => x.Key.ToString())) foreach (var m in kv.Value.OrderBy(x => x.Sequence)) sb.AppendLine("MSG " + kv.Key + "#" + m.Sequence + "|board " + m.BoardId + "|" + (m.Sender ?? "") + "|" + (m.AdvisorName ?? "") + "|" + (m.Content ?? "") + "|" + (m.Stance ?? "") + "|" + (m.Status ?? "") + "|" + (m.ParentSequence?.ToString() ?? "-") + "|" + (m.AdvisorId == Guid.Empty ? "-" : m.AdvisorId.ToString()) + "|" + m.CreatedAt.ToString("o"));
  foreach (var d in s.Drafts.Values.OrderBy(x => x.Id.ToString())) sb.AppendLine("DRAFT " + d.Id + "|" + d.BoardId + "|" + d.MeetingId + "|v" + d.Version + "|wm" + d.Watermark + "|" + (d.ItemsJson ?? "") + "|" + (d.Hash ?? "") + "|" + (d.ApprovedJson ?? "") + "|" + (d.DiscardedJson ?? "") + "|rr" + d.ReviewRevision + "|" + (d.ReviewToken ?? "") + "|" + (d.HistoryJson ?? "") + "|" + (d.SupersedesJson ?? "") + "|" + (d.EvidenceSnapshotJson ?? "") + "|" + d.Decided + "|" + (d.Status ?? "") + "|leg" + (!d.LegacyReview.HasValue ? "-" : (d.LegacyReview.Value ? "1" : "0")) + "|" + d.CreatedAt.ToString("o"));
  foreach (var a in s.Audit.OrderBy(x => x.CreatedAt).ThenBy(x => (x.Action ?? "") + (x.Detail ?? ""))) sb.AppendLine("AUD " + a.BoardId + "|" + (a.Action ?? "") + "|" + (a.Detail ?? "") + "|" + a.CreatedAt.ToString("o"));
  foreach (var kv in s.ActiveIndexJobs.OrderBy(x => x.Key.ToString())) sb.AppendLine("JOB " + kv.Key + "|" + kv.Value.JobId + "|e" + kv.Value.Epoch + "|g" + kv.Value.Generation);
  return sb.ToString();
}
static string RawSqlSections(Microsoft.EntityFrameworkCore.DbContext db, Guid sourceId)
{
  var conn = db.Database.GetDbConnection();
  var wasOpen = conn.State == System.Data.ConnectionState.Open;
  if (!wasOpen) conn.Open();
  try
  {
    using var cmd = conn.CreateCommand();
    cmd.CommandText = "SELECT \"Id\",\"BoardId\",\"SourceId\",\"FamilyKey\",\"SourceVersion\",\"ContentHash\",\"Ordinal\",\"Heading\",\"Location\",\"IndexGeneration\",\"Text\",\"CreatedAt\" FROM \"SourceSections\" WHERE \"SourceId\" = @sid ORDER BY \"Ordinal\"";
    var p = cmd.CreateParameter(); p.ParameterName = "@sid"; p.Value = sourceId; cmd.Parameters.Add(p);
    using var rd = cmd.ExecuteReader();
    var sb = new System.Text.StringBuilder();
    while (rd.Read())
    {
      for (var i = 0; i < rd.FieldCount; i++) sb.Append((i > 0 ? "|" : "") + (rd.IsDBNull(i) ? "-" : rd.GetValue(i)?.ToString()));
      sb.AppendLine();
    }
    return sb.ToString();
  }
  finally { if (!wasOpen) conn.Close(); }
}
static string RawSqlSource(Microsoft.EntityFrameworkCore.DbContext db, Guid sourceId)
{
  var conn = db.Database.GetDbConnection();
  var wasOpen = conn.State == System.Data.ConnectionState.Open;
  if (!wasOpen) conn.Open();
  try
  {
    using var cmd = conn.CreateCommand();
    cmd.CommandText = "SELECT \"Id\",\"BoardId\",\"FileName\",\"ContentHash\",\"Version\",\"ReviewState\",\"Approved\",\"Excluded\",\"Scope\",\"IndexState\",\"IndexGeneration\",\"IndexError\",\"ExtractionJson\" FROM \"Sources\" WHERE \"Id\" = @sid";
    var p = cmd.CreateParameter(); p.ParameterName = "@sid"; p.Value = sourceId; cmd.Parameters.Add(p);
    using var rd = cmd.ExecuteReader();
    var sb = new System.Text.StringBuilder();
    while (rd.Read())
    {
      for (var i = 0; i < rd.FieldCount; i++) { var v = rd.IsDBNull(i) ? "-" : rd.GetValue(i)?.ToString(); sb.Append((i > 0 ? "|" : "") + (v is not null && v.Length > 200 ? Sha(v) : v)); }
      sb.AppendLine();
    }
    return sb.ToString();
  }
  finally { if (!wasOpen) conn.Close(); }
}
var pgBase = Environment.GetEnvironmentVariable("PGCS");
if (string.IsNullOrWhiteSpace(pgBase)) pgBase = "Host=127.0.0.1;Port=15441;Database=postgres;Username=simceo;Password=qa-only";
var pgParts = ParseCs(pgBase);
// Single validated if (bb is System.Text.Json.Nodes.JsonObject bo) bo["OwnerKey"] = "-";ED container/connection identity (F7): every connection string in this run derives
// from this one validated identity. A PGCS override pointing anywhere else is TERMINAL (exit before any
// connect/DDL), never a soft failure that still connects. The actual full owned container id is verified
// before any acquisition; every native exit (including docker) is checked.
var pgHost = pgParts.GetValueOrDefault("Host"); var pgPort = pgParts.GetValueOrDefault("Port"); var pgUser = pgParts.GetValueOrDefault("Username"); var pgPwd = pgParts.GetValueOrDefault("Password");
var identErr = "";
if (!string.Equals(pgHost, "127.0.0.1", StringComparison.OrdinalIgnoreCase)) identErr += "host=" + (pgHost ?? "?") + " ";
if (!string.Equals(pgPort, "15441", StringComparison.OrdinalIgnoreCase)) identErr += "port=" + (pgPort ?? "?") + " ";
if (!string.Equals(pgUser, "simceo", StringComparison.OrdinalIgnoreCase)) identErr += "user=" + (pgUser ?? "?") + " ";
if (string.IsNullOrWhiteSpace(pgPwd)) identErr += "password-missing ";
if (identErr != "")
{
  Emit("FAIL f7-pg-identity-terminal :: refused before any connection: " + identErr);
  failures.Add("f7-pg-identity-terminal");
  Emit("FAILURES: " + string.Join(",", failures)); return 1;
}
Pass("f7-pg-identity-terminal", "127.0.0.1:15441/simceo identity accepted before any acquisition");
var (inspExit, inspOut, inspErr, inspTo) = RunBounded("docker", "inspect simceo-integration-qa-pg", 30000);
if (inspExit != 0 || inspTo)
{
  Emit("FAIL f7-container-identity-terminal :: docker inspect exit=" + inspExit + " timedOut=" + inspTo + " err=" + inspErr.Trim());
  failures.Add("f7-container-identity-terminal");
  Emit("FAILURES: " + string.Join(",", failures)); return 1;
}
try
{
  using var inspDoc = JsonDocument.Parse(inspOut);
  var c0 = inspDoc.RootElement.ValueKind == JsonValueKind.Array && inspDoc.RootElement.GetArrayLength() > 0 ? inspDoc.RootElement[0] : default;
  var cid = c0.ValueKind == JsonValueKind.Object && c0.TryGetProperty("Id", out var cidv) ? (cidv.GetString() ?? "") : "";
  var cstate = c0.ValueKind == JsonValueKind.Object && c0.TryGetProperty("State", out var csv) && csv.ValueKind == JsonValueKind.Object && csv.TryGetProperty("Status", out var csvs) ? (csvs.GetString() ?? "") : "";
  if (cid != "14bcfcf7a243e5bc73385da4d24a33475b6eab0b04b8185e1d1534c13d1a1891") throw new InvalidOperationException("container id mismatch: " + cid);
  if (!string.Equals(cstate, "running", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("container not running: " + cstate);
  if (!c0.ToString().Contains("15441")) throw new InvalidOperationException("15441 port binding absent in container identity");
  Pass("f7-container-identity-full", "14bcfcf7...1891 running with 15441");
}
catch (Exception cex)
{
  Emit("FAIL f7-container-identity-terminal :: " + cex.GetType().Name + " " + cex.Message);
  failures.Add("f7-container-identity-terminal");
  Emit("FAILURES: " + string.Join(",", failures)); return 1;
}
var pgDb = "essentials_evidence_" + Guid.NewGuid().ToString("N").Substring(0, 12);
Emit("PG exclusive DB: " + pgDb);
var artifactDir = Environment.GetEnvironmentVariable("ESSENTIALS_ARTIFACT_DIR");
if (string.IsNullOrWhiteSpace(artifactDir))
{
  artifactDir = System.IO.Path.Combine(AppContext.BaseDirectory, "..", "..", "artifacts", DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "_" + Guid.NewGuid().ToString("N").Substring(0, 8));
}
System.IO.Directory.CreateDirectory(artifactDir);
Emit("ARTIFACT DIR: " + artifactDir);
var adminCs = "Host=" + pgParts["Host"] + ";Port=" + pgParts["Port"] + ";Database=postgres;Username=" + pgParts["Username"] + ";Password=" + pgParts["Password"];
var ownedCs = "Host=" + pgParts["Host"] + ";Port=" + pgParts["Port"] + ";Database=" + pgDb + ";Username=" + pgParts["Username"] + ";Password=" + pgParts["Password"];
var pgPrevBackend = SimCEO.Api.Data.Pg.Backend;
var pgFailed = false;
void PgFail(string name, string detail) { Fail(name, detail); pgFailed = true; }
void PgExpect(bool ok, string name, string detail) { if (ok) Pass(name, detail); else { Fail(name, detail); pgFailed = true; } }
System.Data.Common.DbConnection? adminConn = null;
SimCEO.Postgres.PostgresDb? adminDb = null;
SimCEO.Postgres.PostgresDb? pgDbCtx = null;
var triggerCreated = false;
var functionCreated = false;
var ownedDbCreated = false;
List<string> dbsBefore = new();
try
{
  var adminOpt = new Microsoft.EntityFrameworkCore.DbContextOptionsBuilder<SimCEO.Postgres.PostgresDb>().UseNpgsql(adminCs).Options;
  adminDb = new SimCEO.Postgres.PostgresDb(adminOpt);
  PgExpect(adminDb.Database.CanConnect(), "f7-pg-connect", "owned container reachable");
  adminConn = adminDb.Database.GetDbConnection();
  if (adminConn.State != System.Data.ConnectionState.Open) adminConn.Open();
  using (var cmd = adminConn.CreateCommand())
  {
    cmd.CommandText = "SELECT current_database() || '|' || version()";
    var ident = cmd.ExecuteScalar()?.ToString() ?? "";
    PgExpect(ident.StartsWith("postgres|PostgreSQL", StringComparison.OrdinalIgnoreCase), "f7-pg-identity-verified", ident.Substring(0, Math.Min(60, ident.Length)));
  }
  using (var cmd = adminConn.CreateCommand())
  {
    cmd.CommandText = "SELECT datname FROM pg_database WHERE datname LIKE 'essentials_evidence\\_%' ORDER BY 1";
    using var rd = cmd.ExecuteReader();
    while (rd.Read()) dbsBefore.Add(rd.GetString(0));
  }
  PgExpect(dbsBefore.Contains("essentials_evidence_1d7f5f17316d"), "f7-prior-proof-db-preserved-before", "primary run DB present: " + string.Join(",", dbsBefore));
  adminDb.Database.ExecuteSqlRaw("CREATE DATABASE \"" + pgDb + "\"");
  ownedDbCreated = true;
  Emit("PG owned DB created: " + pgDb);
  var pgOpt = new Microsoft.EntityFrameworkCore.DbContextOptionsBuilder<SimCEO.Postgres.PostgresDb>().UseNpgsql(ownedCs).Options;
  pgDbCtx = new SimCEO.Postgres.PostgresDb(pgOpt);
  pgDbCtx.Database.EnsureCreated();
  var pgBackend = new SimCEO.Postgres.PostgresBackend(pgDbCtx);
  SimCEO.Api.Data.Pg.Backend = pgBackend;
  var ps = new InMemoryStore();
  var pbid = SeedBoard(ps, "allowAll", "");
  var pfile = "pg-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".txt";
  var pdocB = SeedSource(ps, pbid, pfile, 3, "approved", Sha("pg-B")); SeedSections(ps, pdocB); SeedMigrateEvent(ps, pbid, pdocB.Id, 1, 3);
  var phead = new SourceFamilyHead { BoardId = pbid, FamilyKey = pdocB.FamilyKey, HeadVersion = 3, HeadSourceId = pdocB.Id, HighWater = 3 }; ps.SourceHeads[phead.Id] = phead; ps.SourceHeads.Flush();
  var pdocC = SeedSource(ps, pbid, pfile, 2, "pending", Sha("pg-C")); SeedSections(ps, pdocC);
  var (pgOk, pgErr, pgSt) = SourceGovernance.TryApproveById(ps, ownerReq, pdocC.Id);
  PgExpect(pgOk, "pg-promote-C-over-B", pgErr + " st " + pgSt);
  var pgHead = ps.SourceHeads.Values.FirstOrDefault(h => h.BoardId == pbid && h.FamilyKey == pdocC.FamilyKey);
  PgExpect(pgHead is not null && pgHead.HeadSourceId == pdocC.Id, "pg-head-persisted", pgHead is null ? "no head" : pgHead.HeadVersion.ToString());
  var fmeet = new Meeting { BoardId = pbid, Title = "fault-m", State = MeetingState.Active, Generation = 0 }; ps.Meetings[fmeet.Id] = fmeet; ps.Meetings.Flush();
  // Seed meeting messages (F8): rollback must preserve complete message state too.
  var fmsgs = new List<Message>();
  for (var fmi = 1; fmi <= 3; fmi++) fmsgs.Add(new Message { BoardId = pbid, MeetingId = fmeet.Id, Sequence = fmi, Sender = "lead", Content = "seed message " + fmi });
  ps.Messages[fmeet.Id] = MessageList.Detached(fmeet.Id, fmsgs);
  var fitems = "[{\"id\":\"s1\",\"text\":\"BUY\"}]";
  var frecA = new RecordDraft { BoardId = pbid, MeetingId = fmeet.Id, Version = 1, Watermark = 0, ItemsJson = fitems, Hash = "hfA", ApprovedJson = "[\"s1\"]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-pg-A", HistoryJson = "[{\"seq\":1,\"revision\":1,\"token\":\"tok-pg-A\",\"action\":\"approve\",\"itemId\":\"s1\",\"oldText\":\"\",\"newText\":\"BUY\",\"actor\":\"alice\",\"viewedVersion\":1,\"viewedHash\":\"hfA\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"}]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = true, Status = "approved" };
  ps.Drafts[frecA.Id] = frecA; ps.Drafts.Flush();
frecA.Hash = H(frecA.ItemsJson);
  SimCEO.Api.Data.Atomic.Audit(ps, new AuditEvent { BoardId = pbid, Action = "seed.audit", Detail = "{\"seed\":1}" });
  // Seed the fault target with a HEALTHY completed index first: rollback below must restore NONEMPTY
  // prior sections/heads/events, not just counts and IndexState.
  var finFile = "fin-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".txt";
  var finDoc = new SourceDoc { BoardId = pbid, FileName = finFile, Origin = "upload", Scope = "board", ContentHash = Sha("fin-bytes"), Version = 1, ReviewState = "pending", IndexState = "queued", IndexGeneration = 0, ExtractionJson = "{}" }; finDoc.FamilyKey = SourceGovernance.FamilyKeyFor(pbid, "board", null, "upload", finFile); finDoc.Original = System.Text.Encoding.UTF8.GetBytes("finish fault body text for pg test. alpha beta gamma delta epsilon zeta eta theta."); ps.Sources[finDoc.Id] = finDoc; ps.Sources.Flush();
  var finBegan = SourceGovernance.TryBeginIndex(ps, ownerReq, finDoc.Id, "contribute", out var finRes, out var finBeginErr);
  PgExpect(finBegan && finRes is not null, "pg-finish-begin-ok", finBeginErr);
  SourceGovernance.StampExtraction(ps, ownerReq, finRes, "{\"status\":\"ok\",\"md_content\":\"# t\\n\\nfinish fault body text for pg test. alpha beta gamma delta epsilon zeta eta theta.\"}", "contribute");
  var fr0 = SourceGovernance.FinishIndex(ps, ownerReq, finRes, false, "contribute");
  PgExpect(fr0.ok, "pg-finish-healthy-gen1", fr0.error + " st " + fr0.status);
  ps.Sources.TryGetValue(finDoc.Id, out var finCur0);
  PgExpect(finCur0 is not null && finCur0.IndexState == "completed" && finCur0.IndexGeneration == 1, "pg-gen1-completed", "gen=" + (finCur0 is null ? -1 : finCur0.IndexGeneration));
  // Re-begin gen2, then inject the QA-only inner-callback fault INSIDE the actual FinishIndex callback.
  var finBegan2 = SourceGovernance.TryBeginIndex(ps, ownerReq, finDoc.Id, "contribute", out var finRes2, out var finBeginErr2);
  PgExpect(finBegan2 && finRes2 is not null, "pg-finish-begin-gen2", finBeginErr2);
  SourceGovernance.StampExtraction(ps, ownerReq, finRes2, "{\"status\":\"ok\",\"md_content\":\"# t\\n\\nfinish fault body text for pg test. alpha beta gamma delta epsilon zeta eta theta.\"}", "contribute");
  // Ground BOTH snapshots in durable DB state: detach EF-tracked instances (which retain sub-microsecond
  // .NET precision) so the pre-fault snapshot reads the same PG-microsecond-rounded truth as the post-rollback
  // snapshot. Comparing tracked-memory precision against DB precision would be a measurement artifact, not state.
  pgDbCtx.ChangeTracker.Clear();
  var gen1SecTuples = ps.SourceSections.Values.Where(x => x.SourceId == finDoc.Id).OrderBy(x => x.Ordinal).Select(x => x.Ordinal + "|" + (x.Heading ?? "") + "|" + (x.Location ?? "") + "|" + (x.Text ?? "") + "|" + x.SourceVersion + "|" + (x.ContentHash ?? "")).ToList();
  var gen1Extraction = finCur0 is not null ? (finCur0.ExtractionJson ?? "") : "";
  var snapBefore = FullSnap(ps);
  var rawSecBefore = RawSqlSections(pgDbCtx, finDoc.Id);
  var rawSrcBefore = RawSqlSource(pgDbCtx, finDoc.Id);
  PgExpect(rawSecBefore.Split("\n", StringSplitOptions.RemoveEmptyEntries).Length >= 1, "pg-prior-sections-nonempty", "meaningful staged baseline");
  SourceGovernance.FinishIndexCallbackFault = () => true;
  var threwFin = false; string finThrowMsg = "";
  try { var fr = SourceGovernance.FinishIndex(ps, ownerReq, finRes2, false, "contribute"); finThrowMsg = "returned ok=" + fr.ok; }
  catch (Exception ex) { threwFin = true; finThrowMsg = ex.GetType().Name + ": " + ex.Message; }
  finally { SourceGovernance.FinishIndexCallbackFault = null; }
  // Predecessor-failing assertion: old inner-catch semantics swallowed this fault and committed partials
  // (no throw). The escape below discriminates the repair; a mirrored predicate could not.
  PgExpect(threwFin, "f8-inner-callback-fault-escapes", finThrowMsg);
  var snapAfter = FullSnap(ps);
  if (snapAfter != snapBefore)
  {
    var la = snapBefore.Split("\n"); var lb = snapAfter.Split("\n");
    var diff = "lines " + la.Length + " vs " + lb.Length + "; ";
    for (var di = 0; di < Math.Max(la.Length, lb.Length); di++)
    {
      var xa = di < la.Length ? la[di] : "<none>"; var xb = di < lb.Length ? lb[di] : "<none>";
      if (xa != xb) { diff += "first-diff@" + di + " BEFORE=[" + xa + "] AFTER=[" + xb + "]"; break; }
    }
    PgExpect(false, "f8-full-state-unchanged", diff);
  }
  else Pass("f8-full-state-unchanged", "all families/bytes/IDs/reservation map, not just counts");
  PgExpect(RawSqlSections(pgDbCtx, finDoc.Id) == rawSecBefore, "f8-raw-sections-unchanged", "contrasting raw PG observation");
  PgExpect(RawSqlSource(pgDbCtx, finDoc.Id) == rawSrcBefore, "f8-raw-source-unchanged", "contrasting raw PG observation");
  ps.Sources.TryGetValue(finDoc.Id, out var finCur1);
  PgExpect(finCur1 is not null && finCur1.IndexState == "running" && finCur1.IndexGeneration == 2, "f8-index-still-running-gen2", "gen=" + (finCur1 is null ? -1 : finCur1.IndexGeneration));
  PgExpect(ps.ActiveIndexJobs.TryGetValue(finDoc.Id, out var resJob) && resJob.JobId == finRes2.JobId && resJob.Generation == 2, "f8-reservation-intact", "no retire on fault");
  // Healthy retry on the SAME reservation: complete verify, persisted.
  var (okRetry, _, _, errRetry, stRetry) = SourceGovernance.FinishIndex(ps, ownerReq, finRes2, false, "contribute");
  PgExpect(okRetry, "f8-healthy-retry", errRetry + " st " + stRetry);
  ps.Sources.TryGetValue(finDoc.Id, out var finCur2);
  PgExpect(finCur2 is not null && finCur2.IndexState == "completed" && finCur2.IndexGeneration == 2, "f8-retry-completed-gen2", "gen=" + (finCur2 is null ? -1 : finCur2.IndexGeneration));
  PgExpect(!ps.ActiveIndexJobs.ContainsKey(finDoc.Id), "f8-reservation-retired", "retire after success");
  var retrySecs = ps.SourceSections.Values.Where(x => x.SourceId == finDoc.Id).OrderBy(x => x.Ordinal).ToList();
  PgExpect(retrySecs.Count >= 1 && retrySecs.All(x => x.SourceVersion == 1 && x.IndexGeneration == 2 && !string.IsNullOrWhiteSpace(x.Text)), "f8-retry-persisted-complete", "gen2 sections persisted, count=" + retrySecs.Count);
  var retryTuples = ps.SourceSections.Values.Where(x => x.SourceId == finDoc.Id && x.IndexGeneration == 2).OrderBy(x => x.Ordinal).Select(x => x.Ordinal + "|" + (x.Heading ?? "") + "|" + (x.Location ?? "") + "|" + (x.Text ?? "") + "|" + x.SourceVersion + "|" + (x.ContentHash ?? "")).ToList();
  PgExpect(retryTuples.Count == gen1SecTuples.Count && retryTuples.SequenceEqual(gen1SecTuples), "f8-retry-exact-contents", "gen2 sections reproduce gen1 expected tuples, count=" + retryTuples.Count);
  var idxEvt = ps.SourceEvents.Values.Where(x => x.SourceId == finDoc.Id && string.Equals(x.Action ?? "", "index", StringComparison.OrdinalIgnoreCase)).OrderByDescending(x => x.CreatedAt).FirstOrDefault();
  PgExpect(idxEvt is not null && (idxEvt.Detail ?? "") == "gen2 sections" + retryTuples.Count, "f8-retry-exact-event", "index event carries exact gen2 detail, got=" + (idxEvt is null ? "none" : (idxEvt.Detail ?? "")));
  PgExpect(finCur2 is not null && (finCur2.ExtractionJson ?? "") == gen1Extraction && gen1Extraction.Contains("finish fault body text"), "f8-retry-extraction-preserved", "retry keeps the exact stamped extraction bytes");
  // Independent reread after tracking clear (F8): the healthy retry's complete contents
  // are reread from durable state, not EF-tracked memory: doc, sections, events, heads,
  // audit entries, and reservation retirement.
  pgDbCtx.ChangeTracker.Clear();
  var rereadDoc = pgDbCtx.Sources.FirstOrDefault(x => x.Id == finDoc.Id);
  PgExpect(rereadDoc is not null && rereadDoc.IndexState == "completed" && rereadDoc.IndexGeneration == 2, "f8-reread-doc-gen2", rereadDoc is null ? "missing" : rereadDoc.IndexState + "/gen" + rereadDoc.IndexGeneration);
  var rereadSecs = pgDbCtx.SourceSections.Where(x => x.SourceId == finDoc.Id).OrderBy(x => x.Ordinal).ToList();
  PgExpect(rereadSecs.Count >= 1 && rereadSecs.All(x => x.SourceVersion == finDoc.Version && x.IndexGeneration == 2 && !string.IsNullOrWhiteSpace(x.Text)), "f8-reread-sections-complete", "count=" + rereadSecs.Count);
  var rereadEvts = pgDbCtx.SourceEvents.Where(x => x.SourceId == finDoc.Id).OrderBy(x => x.CreatedAt).ToList();
  PgExpect(rereadEvts.Any(e => string.Equals(e.Action ?? "", "index", StringComparison.OrdinalIgnoreCase) && (e.Detail ?? "").Contains("gen2")), "f8-reread-finish-event", "events=" + rereadEvts.Count);
  var rereadHeads = pgDbCtx.SourceHeads.Where(x => x.BoardId == pbid).ToList();
  PgExpect(rereadHeads.All(x => x.FloorVersion >= 0 && x.HighWater >= 0), "f8-reread-heads-sane", "heads=" + rereadHeads.Count);
  PgExpect(ps.Audit.Any(a => string.Equals(a.Action ?? "", "source.index", StringComparison.OrdinalIgnoreCase) && a.BoardId == pbid), "f8-reread-audit-finish", "audit retains finish entry after clear");
  PgExpect(!ps.ActiveIndexJobs.ContainsKey(finDoc.Id), "f8-reread-reservation-retired", "no reservation after complete retry");
  // Negative control (throwaway emulation of the predecessor inner catch, QA-only):
  // stage-then-swallow-then-complete MUST persist partials (the old failure mode the
  // repair discriminates: the f8 fault test above proves the repaired unit escapes and
  // rolls back instead). No shipping code is involved: this local emulation lives only
  // in this probe artifact and its throwaway rows never leave the exclusive test DB.
  var negDoc = new SourceDoc { BoardId = pbid, FileName = "neg-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".txt", Origin = "upload", Scope = "board", ContentHash = Sha("neg-bytes"), Version = 1, ReviewState = "pending", IndexState = "queued", IndexGeneration = 0, ExtractionJson = "{}" };
  negDoc.FamilyKey = SourceGovernance.FamilyKeyFor(pbid, "board", null, "upload", negDoc.FileName);
  negDoc.Original = System.Text.Encoding.UTF8.GetBytes("negative control body text. one two three four five six seven eight.");
  ps.Sources[negDoc.Id] = negDoc; ps.Sources.Flush();
  SourceGovernance.FinishIndexCallbackFault = () => true;
  var negThrew = false;
  try
  {
    SimCEO.Api.Data.Atomic.Run(ps, () =>
    {
      var negSec = new SourceSection { BoardId = pbid, SourceId = negDoc.Id, FamilyKey = negDoc.FamilyKey, SourceVersion = 1, ContentHash = negDoc.ContentHash, Ordinal = 1, Heading = "h", Location = "loc", Text = "negative control staged partial", IndexGeneration = 1 };
      ps.SourceSections[negSec.Id] = negSec; ps.SourceSections.Flush();
      try { if (SourceGovernance.FinishIndexCallbackFault?.Invoke() == true) throw new InvalidOperationException("emulated predecessor-swallowed fault"); }
      catch { }
    });
  }
  catch (Exception negEx) { negThrew = true; Emit("neg-unexpected-escape: " + negEx.GetType().Name); }
  finally { SourceGovernance.FinishIndexCallbackFault = null; }
  var negPartial = ps.SourceSections.Values.Any(x => x.SourceId == negDoc.Id && x.Text == "negative control staged partial");
  PgExpect(!negThrew, "f8-negative-control-swallowed", "old catch swallowed, nothing escaped");
  PgExpect(negPartial, "f8-negative-control-partials-committed", "swallow-then-commit persisted the staged partial (old failure mode)");
  try { foreach (var nx in ps.SourceSections.Values.Where(x => x.SourceId == negDoc.Id).ToList()) ps.SourceSections.TryRemove(nx.Id, out _); ps.SourceSections.Flush(); ps.Sources.TryRemove(negDoc.Id, out _); ps.Sources.Flush(); } catch { }
  // RETAINED real PG insert trigger case with CORRECTED classification: PostgresBackend.SaveChanges runs
  // AFTER the FinishIndex callback returns, so this fault fires in the deferred save/commit sequence inside
  // Transact (post-callback, pre-tx.Commit) - it proves commit-sequence rollback, NOT inner-catch discrimination.
  var trigDoc = new SourceDoc { BoardId = pbid, FileName = "trig-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".txt", Origin = "upload", Scope = "board", ContentHash = Sha("trig-bytes"), Version = 1, ReviewState = "pending", IndexState = "queued", IndexGeneration = 0, ExtractionJson = "{}" }; trigDoc.FamilyKey = SourceGovernance.FamilyKeyFor(pbid, "board", null, "upload", trigDoc.FileName); trigDoc.Original = System.Text.Encoding.UTF8.GetBytes("trigger fault body text for commit sequence test. one two three four five six seven."); ps.Sources[trigDoc.Id] = trigDoc; ps.Sources.Flush();
  var trigBegan = SourceGovernance.TryBeginIndex(ps, ownerReq, trigDoc.Id, "contribute", out var trigRes, out var trigBeginErr);
  PgExpect(trigBegan && trigRes is not null, "f8-trigger-begin-ok", trigBeginErr);
  SourceGovernance.StampExtraction(ps, ownerReq, trigRes, "{\"status\":\"ok\",\"md_content\":\"# t\\n\\ntrigger fault body text for commit sequence test. one two three four five six seven.\"}", "contribute");
  pgDbCtx.Database.ExecuteSqlRaw("CREATE OR REPLACE FUNCTION qa_fail_secs() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION " + (char)39 + "qa injected section failure" + (char)39 + "; END; $$ LANGUAGE plpgsql");
  functionCreated = true;
  pgDbCtx.Database.ExecuteSqlRaw("DROP TRIGGER IF EXISTS qa_fail_secs ON \"SourceSections\"");
  pgDbCtx.Database.ExecuteSqlRaw("CREATE TRIGGER qa_fail_secs BEFORE INSERT ON \"SourceSections\" FOR EACH ROW EXECUTE FUNCTION qa_fail_secs()");
  triggerCreated = true;
  pgDbCtx.ChangeTracker.Clear();
  var trigSnapBefore = FullSnap(ps);
  var trigThrew = false; string trigMsg = "";
  try { var tr = SourceGovernance.FinishIndex(ps, ownerReq, trigRes, false, "contribute"); trigMsg = "returned ok=" + tr.ok; }
  catch (Exception ex) { trigThrew = true; trigMsg = ex.GetType().Name + ": " + ex.Message; }
  PgExpect(trigThrew, "f8-trigger-commit-sequence-escapes", trigMsg + " (save/commit-sequence fault, correctly NOT labeled inner-callback)");
  var trigSnapAfter = FullSnap(ps);
  if (trigSnapAfter != trigSnapBefore)
  {
    var la = trigSnapBefore.Split("\n"); var lb = trigSnapAfter.Split("\n");
    var diff = "lines " + la.Length + " vs " + lb.Length + "; ";
    for (var di = 0; di < Math.Max(la.Length, lb.Length); di++)
    {
      var xa = di < la.Length ? la[di] : "<none>"; var xb = di < lb.Length ? lb[di] : "<none>";
      if (xa != xb) { diff += "first-diff@" + di + " BEFORE=[" + xa + "] AFTER=[" + xb + "]"; break; }
    }
    PgExpect(false, "f8-trigger-full-state-unchanged", diff);
  }
  else Pass("f8-trigger-full-state-unchanged", "all families/bytes/IDs/reservation map");
  pgDbCtx.Database.ExecuteSqlRaw("DROP TRIGGER IF EXISTS qa_fail_secs ON \"SourceSections\"");
  triggerCreated = false;
  pgDbCtx.Database.ExecuteSqlRaw("DROP FUNCTION IF EXISTS qa_fail_secs()");
  functionCreated = false;
  var (okTrigRetry, _, _, errTrigRetry, stTrigRetry) = SourceGovernance.FinishIndex(ps, ownerReq, trigRes, false, "contribute");
  PgExpect(okTrigRetry, "f8-trigger-healthy-retry", errTrigRetry + " st " + stTrigRetry);
  // Independent reread of the trigger retry (F8): complete contents reread from durable
  // state after tracking clear. The trigger fault is honestly a SaveChanges/insert
  // failure inside the commit sequence (post-callback, pre-tx.Commit), not a failing COMMIT.
  pgDbCtx.ChangeTracker.Clear();
  var trigReread = pgDbCtx.Sources.FirstOrDefault(x => x.Id == trigDoc.Id);
  PgExpect(trigReread is not null && trigReread.IndexState == "completed", "f8-trigger-reread-completed", trigReread is null ? "missing" : trigReread.IndexState + "/gen" + trigReread.IndexGeneration);
  var trigRereadSecs = pgDbCtx.SourceSections.Where(x => x.SourceId == trigDoc.Id).OrderBy(x => x.Ordinal).ToList();
  PgExpect(trigRereadSecs.Count >= 1 && trigRereadSecs.All(x => !string.IsNullOrWhiteSpace(x.Text)), "f8-trigger-reread-sections-complete", "count=" + trigRereadSecs.Count);
}
catch (Exception ex) { PgFail("pg-fatal", ex.GetType().Name + " " + ex.Message + " " + (ex.StackTrace ?? "").Substring(0, Math.Min(500, (ex.StackTrace ?? "").Length))); }
finally
{
  // Acquisition-safe cleanup in FINALLY (F7): backend restoration + trigger/function + NEW exclusive DB.
  // Any cleanup error fails the run. Shared containers/DBs are never touched.
  var cerrs = new List<string>();
  try { SourceGovernance.FinishIndexCallbackFault = null; } catch (Exception ex) { cerrs.Add("seam-reset: " + ex.Message); }
  try
  {
    if (triggerCreated && pgDbCtx is not null) { pgDbCtx.Database.ExecuteSqlRaw("DROP TRIGGER IF EXISTS qa_fail_secs ON \"SourceSections\""); triggerCreated = false; }
  }
  catch (Exception ex) { cerrs.Add("trigger-drop: " + ex.Message); }
  try
  {
    if (functionCreated && pgDbCtx is not null) { pgDbCtx.Database.ExecuteSqlRaw("DROP FUNCTION IF EXISTS qa_fail_secs()"); functionCreated = false; }
  }
  catch (Exception ex) { cerrs.Add("function-drop: " + ex.Message); }
  try { if (pgDbCtx is not null) pgDbCtx.Dispose(); } catch (Exception ex) { cerrs.Add("pgctx-dispose: " + ex.Message); }
  try { if (adminDb is not null) adminDb.Dispose(); } catch (Exception ex) { cerrs.Add("adminctx-dispose: " + ex.Message); }
  try { if (adminConn is not null) adminConn.Dispose(); } catch (Exception ex) { cerrs.Add("adminconn-dispose: " + ex.Message); }
  try { SimCEO.Api.Data.Pg.Backend = pgPrevBackend; if (!object.ReferenceEquals(SimCEO.Api.Data.Pg.Backend, pgPrevBackend)) cerrs.Add("backend-restore mismatch"); }
  catch (Exception ex) { cerrs.Add("backend-restore: " + ex.Message); }
  try
  {
    if (ownedDbCreated)
    {
      var dropOpt = new Microsoft.EntityFrameworkCore.DbContextOptionsBuilder<SimCEO.Postgres.PostgresDb>().UseNpgsql(adminCs).Options;
      using var dropDb = new SimCEO.Postgres.PostgresDb(dropOpt);
      dropDb.Database.ExecuteSqlRaw("DROP DATABASE \"" + pgDb + "\" WITH (FORCE)");
      using var verifyDb = new SimCEO.Postgres.PostgresDb(dropOpt);
      var vconn = verifyDb.Database.GetDbConnection();
      if (vconn.State != System.Data.ConnectionState.Open) vconn.Open();
      using var vcmd = vconn.CreateCommand();
      vcmd.CommandText = "SELECT count(*) FROM pg_database WHERE datname = '" + pgDb + "'";
      var n = vcmd.ExecuteScalar()?.ToString();
      if (n != "0") cerrs.Add("owned-db-still-present: " + pgDb);
      using var vcmd2 = vconn.CreateCommand();
      vcmd2.CommandText = "SELECT datname FROM pg_database WHERE datname LIKE 'essentials_evidence\\_%' ORDER BY 1";
      using var vrd = vcmd2.ExecuteReader();
      var after = new List<string>();
      while (vrd.Read()) after.Add(vrd.GetString(0));
      if (!after.Contains("essentials_evidence_1d7f5f17316d")) cerrs.Add("prior-proof-db-missing-after: 1d7f5f17316d");
      foreach (var b in dbsBefore) if (!after.Contains(b)) cerrs.Add("prior-db-lost: " + b);
      if (after.Contains(pgDb)) cerrs.Add("owned-db-not-dropped: " + pgDb);
    }
  }
  catch (Exception ex) { cerrs.Add("owned-db-drop: " + ex.Message); }
  if (cerrs.Count > 0) PgFail("f7-cleanup-errors", string.Join("; ", cerrs));
  else Emit("CLEANUP ok owned-db-dropped=" + pgDb);
}
// ================= HTTP SECTION (actual API workflow proof, mandatory) =================
Emit("HTTP SECTION START");
var httpFailed = false;
void HttpFail(string name, string detail) { Fail(name, detail); httpFailed = true; }
void HttpExpect(bool ok, string name, string detail) { if (ok) Pass(name, detail); else { Fail(name, detail); httpFailed = true; } }
void HttpTerminal(string name, string detail) { Fail(name, detail); httpFailed = true; throw new InvalidOperationException("http-terminal:" + name + " " + detail); }
bool HttpOwnsListener(System.Diagnostics.Process? pr, int port, string name)
{
  var alive = false;
  try { alive = pr is not null && !pr.HasExited; } catch { alive = false; }
  var bound = !PortFree(port);
  var ok = alive && bound;
  HttpExpect(ok, name, "child-alive=" + alive + " port-bound=" + bound + " port=" + port);
  return ok;
}
void HttpRequireListener(System.Diagnostics.Process? pr, int port, string name)
{
  if (!HttpOwnsListener(pr, port, name)) HttpTerminal(name + "-terminal", "retained child is not the responding listener; refusing mutation into a foreign app.");
}
static (System.Net.HttpStatusCode status, JsonDocument doc) GetJson(System.Net.Http.HttpClient h, string url)
{
  using var resp = h.GetAsync(url).GetAwaiter().GetResult();
  var txt = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();
  return (resp.StatusCode, JsonDocument.Parse(string.IsNullOrWhiteSpace(txt) ? "{}" : txt));
}
static (System.Net.HttpStatusCode status, JsonDocument doc) PostJson(System.Net.Http.HttpClient h, string url, object body)
{
  var json = JsonSerializer.Serialize(body);
  using var resp = h.PostAsync(url, new StringContent(json, System.Text.Encoding.UTF8, "application/json")).GetAwaiter().GetResult();
  var txt = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();
  return (resp.StatusCode, JsonDocument.Parse(string.IsNullOrWhiteSpace(txt) ? "{}" : txt));
}
static string NormExport(string snapshotJson)
{
  using var nd = JsonDocument.Parse(snapshotJson);
  var nsb = new System.Text.StringBuilder();
  foreach (var prop in nd.RootElement.EnumerateObject())
  {
    if (prop.NameEquals("at")) continue;
    nsb.Append(prop.Name); nsb.Append('='); nsb.Append(prop.Value.GetRawText()); nsb.Append('\n');
  }
  return nsb.ToString();
}
void EmitNormDiff(string wantNorm, string gotSnap, string artifactDir, string baseName, string testName)
{
  try
  {
    var gotNorm = NormExportStable(gotSnap);
    if (gotNorm == wantNorm) return;
    System.IO.File.WriteAllText(System.IO.Path.Combine(artifactDir, baseName + "-want.norm.txt"), wantNorm);
    System.IO.File.WriteAllText(System.IO.Path.Combine(artifactDir, baseName + "-got.norm.txt"), gotNorm);
    var la = wantNorm.Split('\n'); var lb = gotNorm.Split('\n');
    Emit("NORM-DIFF-COUNT want=" + la.Length + " got=" + lb.Length);
    for (var di = 0; di < System.Math.Max(la.Length, lb.Length); di++)
    {
      var xa = di < la.Length ? la[di] : "<none>"; var xb = di < lb.Length ? lb[di] : "<none>";
      if (xa != xb) { Emit("NORM-DIFF first@" + di + " WANT=[" + xa.Substring(0, System.Math.Min(500, xa.Length)) + "] GOT=[" + xb.Substring(0, System.Math.Min(500, xb.Length)) + "]"); break; }
    }
  }
  catch (System.Exception dex) { Emit("NORM-DIFF-ERR " + dex.GetType().Name); }
}
// Stable export comparison (F2/P1): meeting Generation is advanced by the restore
// generation floor by design (max(staged,live)+1, no generation reuse), so identity
// comparison masks it; the floor itself is asserted exactly per meeting.
static string NormExportStable(string snapshotJson)
{
  var snode = System.Text.Json.Nodes.JsonNode.Parse(snapshotJson);
  if (snode is not System.Text.Json.Nodes.JsonObject sobj) return "";
  var ssb = new System.Text.StringBuilder();
  foreach (var kv in sobj)
  {
    if (kv.Key == "at") continue;
    if (kv.Key == "meetings" && kv.Value is System.Text.Json.Nodes.JsonArray marr)
      foreach (var mm in marr) { if (mm is System.Text.Json.Nodes.JsonObject mo) mo["Generation"] = -1; }
    if (kv.Key == "boards" && kv.Value is System.Text.Json.Nodes.JsonArray barr)
      foreach (var bb in barr) { if (bb is System.Text.Json.Nodes.JsonObject bo) bo["OwnerKey"] = "-"; }
    ssb.Append(kv.Key); ssb.Append('='); ssb.Append(kv.Value is null ? "null" : kv.Value.ToJsonString()); ssb.Append('\n');
  }
  return ssb.ToString();
}
// Exact failed-restore comparison (F2/P1): ONLY the root generated export timestamp
// ("at") is excluded. EVERYTHING else is compared byte-identically: meetings INCLUDING
// Generation, boards INCLUDING OwnerKey, all user bytes, ids, costs, and content. No
// normalization and no field deletion in failed-state proof. Success comparisons may
// mask Generation/OwnerKey ONLY together with the CheckGenFloor + CheckBoardOwners
// exact per-meeting/per-board proofs below.
static string NormFailedStable(string snapshotJson)
{
  var snode = System.Text.Json.Nodes.JsonNode.Parse(snapshotJson);
  if (snode is not System.Text.Json.Nodes.JsonObject sobj) return "";
  var ssb = new System.Text.StringBuilder();
  foreach (var kv in sobj)
  {
    if (kv.Key == "at") continue;
    ssb.Append(kv.Key); ssb.Append('='); ssb.Append(kv.Value is null ? "null" : kv.Value.ToJsonString()); ssb.Append('\n');
  }
  return ssb.ToString();
}
void EmitFailedDiff(string wantExact, string gotSnap, string artifactDir, string baseName, string testName)
{
  try
  {
    var gotExact = NormFailedStable(gotSnap);
    if (gotExact == wantExact) return;
    System.IO.File.WriteAllText(System.IO.Path.Combine(artifactDir, baseName + "-want.exact.txt"), wantExact);
    System.IO.File.WriteAllText(System.IO.Path.Combine(artifactDir, baseName + "-got.exact.txt"), gotExact);
    var la = wantExact.Split('\n'); var lb = gotExact.Split('\n');
    Emit("FAILED-DIFF-COUNT want=" + la.Length + " got=" + lb.Length);
    for (var di = 0; di < System.Math.Max(la.Length, lb.Length); di++)
    {
      var xa = di < la.Length ? la[di] : "<none>"; var xb = di < lb.Length ? lb[di] : "<none>";
      if (xa != xb) { Emit("FAILED-DIFF first@" + di + " WANT=[" + xa.Substring(0, System.Math.Min(500, xa.Length)) + "] GOT=[" + xb.Substring(0, System.Math.Min(500, xb.Length)) + "]"); break; }
    }
  }
  catch (System.Exception dex) { Emit("FAILED-DIFF-ERR " + dex.GetType().Name); }
}
void CheckBoardOwners(string sentSnap, string gotSnap, string preSnap, string testName)
{
  try
  {
    using var sd = JsonDocument.Parse(sentSnap);
    using var gd = JsonDocument.Parse(gotSnap);
    var sentIds = new HashSet<string>(StringComparer.Ordinal);
    foreach (var sb in sd.RootElement.GetProperty("boards").EnumerateArray()) sentIds.Add(sb.GetProperty("Id").GetString() ?? "");
    var gotOwners = new Dictionary<string, string>(StringComparer.Ordinal);
    foreach (var gb in gd.RootElement.GetProperty("boards").EnumerateArray())
    {
      var gid = gb.GetProperty("Id").GetString() ?? "";
      var go = gb.TryGetProperty("OwnerKey", out var gov) ? (gov.GetString() ?? "") : "";
      if (!gotOwners.TryAdd(gid, go)) { HttpExpect(false, testName, "duplicate board " + gid); return; }
    }
    var pre = new Dictionary<string, string>(StringComparer.Ordinal);
    if (!string.IsNullOrWhiteSpace(preSnap))
    {
      using var pd = JsonDocument.Parse(preSnap);
      foreach (var pb in pd.RootElement.GetProperty("boards").EnumerateArray()) pre[pb.GetProperty("Id").GetString() ?? ""] = pb.TryGetProperty("OwnerKey", out var pov) ? (pov.GetString() ?? "") : "";
    }
    // Exact actual restore contract (ACL preserved): the restored board set must equal
    // the sent set exactly (no omission, no extras, total counts match). Every restored
    // board keeps its prior live OwnerKey when present, else the non-secure restore default.
    var okB = gotOwners.Count == sentIds.Count && sentIds.All(id => gotOwners.ContainsKey(id));
    var seenB = 0;
    foreach (var kv in gotOwners)
    {
      seenB++;
      var want = pre.TryGetValue(kv.Key, out var pv) ? pv : "owner";
      if (kv.Value != want) { okB = false; Emit("OWNER-MISMATCH " + kv.Key + " got=[" + kv.Value + "] want=[" + want + "]"); }
    }
    HttpExpect(okB && seenB > 0 && seenB == sentIds.Count, testName, "boards=" + seenB + "/" + sentIds.Count);
  }
  catch (Exception bex) { HttpExpect(false, testName, bex.GetType().Name); }
}
void CheckGenFloor(string sentSnap, string gotSnap, long liveMaxBefore, string testName)
{
  try
  {
    using var sd = JsonDocument.Parse(sentSnap); using var gd = JsonDocument.Parse(gotSnap);
    var want = new Dictionary<string, long>(StringComparer.Ordinal);
    foreach (var m in sd.RootElement.GetProperty("meetings").EnumerateArray())
      want[m.GetProperty("Id").GetString() ?? ""] = m.TryGetProperty("Generation", out var gv) && gv.ValueKind == JsonValueKind.Number && gv.TryGetInt64(out var gl) ? gl : 0;
    var okAll = true; var seen = 0;
    foreach (var m in gd.RootElement.GetProperty("meetings").EnumerateArray())
    {
      var id = m.GetProperty("Id").GetString() ?? ""; seen++;
      var got = m.TryGetProperty("Generation", out var gv2) && gv2.ValueKind == JsonValueKind.Number && gv2.TryGetInt64(out var gl2) ? gl2 : -1;
      var expect = want.TryGetValue(id, out var wv) ? System.Math.Max(wv, liveMaxBefore) + 1 : -2;
      if (got != expect) { okAll = false; Emit("if (mm is System.Text.Json.Nodes.JsonObject mo) FLOOR-MISMATCH " + id + " got=" + got + " expect=" + expect); }
    }
    HttpExpect(okAll && seen == want.Count && seen > 0, testName, "meetings=" + seen + " floor=max(staged,live)+1");
  }
  catch (System.Exception gex) { HttpExpect(false, testName, gex.GetType().Name + " " + gex.Message); }
}
static bool PortFree(int port)
{
  try { using var tc = new System.Net.Sockets.TcpClient(); var iar = tc.BeginConnect("127.0.0.1", port, null, null); if (iar.AsyncWaitHandle.WaitOne(2000) && tc.Connected) return false; return true; }
  catch { return true; }
}
System.Diagnostics.Process? apiProc1 = null; System.Diagnostics.Process? apiProc2 = null; System.Diagnostics.Process? apiProc3 = null;
System.Threading.Tasks.Task? apiDrain1a = null; System.Threading.Tasks.Task? apiDrain1b = null;
System.Threading.Tasks.Task? apiDrain2a = null; System.Threading.Tasks.Task? apiDrain2b = null;
System.Threading.Tasks.Task? apiDrain3a = null; System.Threading.Tasks.Task? apiDrain3b = null;
var apiOut1 = new System.Text.StringBuilder(); var apiErr1 = new System.Text.StringBuilder();
var apiOut2 = new System.Text.StringBuilder(); var apiErr2 = new System.Text.StringBuilder();
var apiOut3 = new System.Text.StringBuilder(); var apiErr3 = new System.Text.StringBuilder();
string? httpA = null; string? httpB = null; string? httpUpg = null;
var httpACreated = false; var httpBCreated = false; var httpUpgCreated = false;
var apiDir = System.IO.Path.GetFullPath(System.IO.Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "server", "SimCEO.Api", "bin", "Release", "net10.0"));
var apiDll = System.IO.Path.Combine(apiDir, "SimCEO.Api.dll");
System.Diagnostics.Process StartApi(string db, int port, System.Text.StringBuilder o, System.Text.StringBuilder e, string ring, string csBase)
{
  var cs = csBase.Replace("Database=postgres;", "Database=" + db + ";");
  var psi = new System.Diagnostics.ProcessStartInfo("dotnet", "\"" + apiDll + "\"") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = apiDir };
  psi.Environment["ASPNETCORE_URLS"] = "http://127.0.0.1:" + port;
  psi.Environment["USE_POSTGRES"] = "1";
  psi.Environment["ConnectionStrings__App"] = cs;
  psi.Environment["WIKI_KEYRING_DIR"] = ring;
  psi.Environment["DOTNET_NOLOGO"] = "1";
  var pr = new System.Diagnostics.Process { StartInfo = psi };
  if (!pr.Start()) throw new InvalidOperationException("api start failed on port " + port);
  return pr;
}
bool WaitReady(System.Net.Http.HttpClient h, string baseUrl, int tries)
{
  for (var ti = 0; ti < tries; ti++)
  {
    try
    {
      var (st, dc) = GetJson(h, baseUrl + "/api/backend");
      if (st == System.Net.HttpStatusCode.OK && dc.RootElement.TryGetProperty("mode", out var mv) && (mv.GetString() ?? "") == "postgres") return true;
    }
    catch { }
    System.Threading.Thread.Sleep(2000);
  }
  return false;
}
void KillApi(ref System.Diagnostics.Process? pr, System.Threading.Tasks.Task? d1, System.Threading.Tasks.Task? d2, System.Text.StringBuilder o, System.Text.StringBuilder e, string logPath)
{
  try
  {
    if (pr is not null)
    {
      try { if (!pr.HasExited) pr.Kill(true); } catch { }
      try { pr.WaitForExit(15000); } catch { }
      try { if (d1 is not null) d1.Wait(10000); } catch { }
      try { if (d2 is not null) d2.Wait(10000); } catch { }
      try { pr.Dispose(); } catch { }
      pr = null;
    }
  }
  catch { }
  try
  {
    var txt = "STDOUT(len=" + o.Length + ")\n" + (o.Length > 200000 ? o.ToString().Substring(0, 200000) : o.ToString()) + "\nSTDERR(len=" + e.Length + ")\n" + (e.Length > 50000 ? e.ToString().Substring(0, 50000) : e.ToString());
    System.IO.File.WriteAllText(logPath, txt);
  }
  catch { }
}
var csBaseAdmin = "Host=" + pgParts["Host"] + ";Port=" + pgParts["Port"] + ";Database=postgres;Username=" + pgParts["Username"] + ";Password=" + pgParts["Password"];
var http = new System.Net.Http.HttpClient { Timeout = TimeSpan.FromSeconds(60) };
try
{
  HttpExpect(System.IO.File.Exists(apiDll), "http-api-dll-present", apiDll);
  var repoRoot = System.IO.Path.GetFullPath(System.IO.Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
  var apiProj = System.IO.Path.Combine(repoRoot, "server", "SimCEO.Api", "SimCEO.Api.csproj");
  var (buildExit, buildOut, buildErr, buildTo) = RunBounded("dotnet", "build \"" + apiProj + "\" -c Release --nologo -v q", 600000);
  HttpExpect(!buildTo && buildExit == 0, "http-api-build-native", "exit=" + buildExit + " timedOut=" + buildTo + " tail=" + (buildOut + buildErr).Trim().Replace("\n", " ").Replace("\r", "")); var preFree5146 = PortFree(5146); HttpExpect(preFree5146, "http-preflight-5146-free", "own API port must be free");
  var preFree5246 = PortFree(5246); HttpExpect(preFree5246, "http-preflight-5246-free", "own second API port must be free");
  if (!preFree5146 || !preFree5246) HttpTerminal("http-preflight-terminal", "occupied API port; refusing dependent acquisition/mutation into a foreign app.");
  string ExecSql(string cs, string sql)
  {
    var opt = new Microsoft.EntityFrameworkCore.DbContextOptionsBuilder<SimCEO.Postgres.PostgresDb>().UseNpgsql(cs).Options;
    using var db = new SimCEO.Postgres.PostgresDb(opt);
    return db.Database.ExecuteSqlRaw(sql).ToString() ?? "";
  }
  httpA = "essentials_evidence_httpa_" + Guid.NewGuid().ToString("N").Substring(0, 8);
  httpB = "essentials_evidence_httpb_" + Guid.NewGuid().ToString("N").Substring(0, 8);
  httpUpg = "essentials_evidence_httpupg_" + Guid.NewGuid().ToString("N").Substring(0, 8);
try { ExecSql(csBaseAdmin, "CREATE DATABASE \"" + httpA + "\""); httpACreated = true; } catch (Exception dbExA) { HttpExpect(false, "http-db-create-a", dbExA.GetType().Name + " " + dbExA.Message); }
  try { ExecSql(csBaseAdmin, "CREATE DATABASE \"" + httpB + "\""); httpBCreated = true; } catch (Exception dbExB) { HttpExpect(false, "http-db-create-b", dbExB.GetType().Name + " " + dbExB.Message); }
  try { ExecSql(csBaseAdmin, "CREATE DATABASE \"" + httpUpg + "\""); httpUpgCreated = true; } catch (Exception dbExU) { HttpExpect(false, "http-db-create-upg", dbExU.GetType().Name + " " + dbExU.Message); }
  if (!httpACreated || !httpBCreated || !httpUpgCreated) HttpTerminal("http-db-acquire-terminal", "exclusive DB acquisition failed; refusing dependent boot/mutation and never dropping a colliding name.");
  Emit("HTTP exclusive DBs: " + httpA + " " + httpB + " " + httpUpg);
  // ---- P1b: genuine old backup restores through the actual route, then exports ----
  string? legacyPath = Environment.GetEnvironmentVariable("ESSENTIALS_HTTP_LEGACY_BACKUP");
  if (string.IsNullOrWhiteSpace(legacyPath) || !System.IO.File.Exists(legacyPath))
  {
    var probeDirH = AppContext.BaseDirectory;
    var rootH = new System.IO.DirectoryInfo(probeDirH);
    for (var hi = 0; hi < 8 && rootH is not null; hi++)
    {
      var candH = System.IO.Path.Combine(rootH.FullName, ".tmp", "predecessor-complete-primary-20261103-1021-canonical-backup.json");
      if (System.IO.File.Exists(candH)) { legacyPath = candH; break; }
      candH = System.IO.Path.Combine(rootH.FullName, "sim_ceo", ".tmp", "predecessor-complete-primary-20261103-1021-canonical-backup.json");
      if (System.IO.File.Exists(candH)) { legacyPath = candH; break; }
      rootH = rootH.Parent;
    }
  }
  if (string.IsNullOrWhiteSpace(legacyPath) || !System.IO.File.Exists(legacyPath)) legacyPath = "C:/Users/War/scrach/sim_ceo/.tmp/predecessor-complete-primary-20261103-1021-canonical-backup.json";
  HttpExpect(!string.IsNullOrWhiteSpace(legacyPath) && System.IO.File.Exists(legacyPath), "http-legacy-backup-present", legacyPath ?? "not found");
  var memEnvPath = Environment.GetEnvironmentVariable("ESSENTIALS_LEGACY_BACKUP") ?? "";
  HttpExpect(string.IsNullOrWhiteSpace(memEnvPath) || !string.Equals(memEnvPath, legacyPath, StringComparison.OrdinalIgnoreCase), "http-fixture-separated-from-memory", "http=" + (legacyPath ?? "?") + " memory=" + (string.IsNullOrWhiteSpace(memEnvPath) ? "(unset)" : memEnvPath));
  var legacyRaw = System.IO.File.ReadAllText(legacyPath);
  using var legacyOuter = JsonDocument.Parse(legacyRaw);
  var legacySnap = legacyOuter.RootElement.GetProperty("snapshot").GetString() ?? "";
  var legacyHash = legacyOuter.RootElement.GetProperty("hash").GetString() ?? "";
  using var legacySnapDoc = JsonDocument.Parse(legacySnap);
  var legacyBoardsN = legacySnapDoc.RootElement.TryGetProperty("boards", out var lbv) && lbv.ValueKind == JsonValueKind.Array ? lbv.GetArrayLength() : -1;
  var legacyMeetingsN = legacySnapDoc.RootElement.TryGetProperty("meetings", out var lmv) && lmv.ValueKind == JsonValueKind.Array ? lmv.GetArrayLength() : -1;
  var legacyDraftsN = legacySnapDoc.RootElement.TryGetProperty("drafts", out var ldv) && ldv.ValueKind == JsonValueKind.Array ? ldv.GetArrayLength() : -1;
  var legacySourcesN = legacySnapDoc.RootElement.TryGetProperty("sources", out var lsv) && lsv.ValueKind == JsonValueKind.Array ? lsv.GetArrayLength() : -1;
  var legacySnapVer = legacySnapDoc.RootElement.TryGetProperty("version", out var lvv) && lvv.ValueKind == JsonValueKind.Number ? lvv.GetInt32() : -1;
  var legacyFileHash = Sha(legacyRaw);
  Emit("HTTP legacy fixture path=" + (legacyPath ?? "?") + " sha256=" + legacyFileHash + " version=" + legacySnapVer + " boards=" + legacyBoardsN + " meetings=" + legacyMeetingsN + " drafts=" + legacyDraftsN + " sources=" + legacySourcesN);
  HttpExpect(legacySnapVer == 2 && legacyBoardsN == 79 && legacyMeetingsN == 79 && legacyDraftsN == 75 && legacySourcesN == 138, "http-legacy-source-rich-shape", "v" + legacySnapVer + " boards=" + legacyBoardsN + " meetings=" + legacyMeetingsN + " drafts=" + legacyDraftsN + " sources=" + legacySourcesN + " (memory USER 3/2/2 stays separate)");
  var preCharters = new Dictionary<string, string>(StringComparer.Ordinal);
  foreach (var srow in legacySnapDoc.RootElement.GetProperty("sources").EnumerateArray())
  {
    if ((srow.TryGetProperty("Scope", out var scp) ? (scp.GetString() ?? "") : "") == "meeting" && (srow.TryGetProperty("Version", out var sv) ? (sv.GetInt32()) : 0) == 3)
      preCharters[srow.GetProperty("Id").GetString() ?? ""] = (srow.TryGetProperty("ContentHash", out var chx) ? (chx.GetString() ?? "") : "");
  }
  Emit("HTTP legacy fixture v3charters=" + preCharters.Count + " snapshotHash=" + legacyHash.Substring(0, Math.Min(16, legacyHash.Length)));
  HttpExpect(preCharters.Count == 23, "http-legacy-charter-v3-present", "meeting v3 charters=" + preCharters.Count + " (genuine v3, no heads/events)");
  HttpExpect(preCharters.Count > 0 && legacySourcesN == 138, "http-legacy-source-rich-positive", "source-rich positive fixture required before dependent E0/tamper checks: charters=" + preCharters.Count + " sources=" + legacySourcesN);
  apiProc1 = StartApi(httpA!, 5146, apiOut1, apiErr1, System.IO.Path.Combine(artifactDir, "wikiring1"), csBaseAdmin);
  apiDrain1a = System.Threading.Tasks.Task.Run(() => DrainLines(apiProc1.StandardOutput, apiOut1));
  apiDrain1b = System.Threading.Tasks.Task.Run(() => DrainLines(apiProc1.StandardError, apiErr1));
  var ready1 = WaitReady(http, "http://127.0.0.1:5146", 45); HttpExpect(ready1, "http-api1-ready-postgres", "boot on fresh exclusive DB");
  if (!ready1) HttpTerminal("http-api1-ready-terminal", "readiness failed; refusing restore into an unverified listener.");
  HttpRequireListener(apiProc1, 5146, "http-own-5146-before-legacy");
  var (rsSt, rsDoc) = PostJson(http, "http://127.0.0.1:5146/api/backup/restore", new { snapshot = legacySnap, hash = legacyHash });
  HttpExpect(rsSt == System.Net.HttpStatusCode.OK, "http-legacy-restore-200", "status=" + (int)rsSt + " " + rsDoc.RootElement.GetRawText());
  var (exSt, exDoc) = GetJson(http, "http://127.0.0.1:5146/api/backup");
  HttpExpect(exSt == System.Net.HttpStatusCode.OK, "http-legacy-export-200", "status=" + (int)exSt);
  var e1Snap = exDoc.RootElement.GetProperty("snapshot").GetString() ?? "";
  using var e1Doc = JsonDocument.Parse(e1Snap);
  var postCharters = new Dictionary<string, string>(StringComparer.Ordinal);
  var postFamilies = new HashSet<string>(StringComparer.Ordinal);
  foreach (var srow in e1Doc.RootElement.GetProperty("sources").EnumerateArray())
  {
    var sid = srow.GetProperty("Id").GetString() ?? "";
    if (preCharters.ContainsKey(sid)) postCharters[sid] = (srow.TryGetProperty("ContentHash", out var ch2) ? (ch2.GetString() ?? "") : "");
    postFamilies.Add(srow.GetProperty("FamilyKey").GetString() ?? "");
  }
  HttpExpect(postCharters.Count == preCharters.Count, "http-charter-v3-preserved-count", "charters=" + postCharters.Count);
  var charterBytesOk = postCharters.Count == preCharters.Count && postCharters.All(kv => preCharters.TryGetValue(kv.Key, out var pv) && pv == kv.Value);
  HttpExpect(charterBytesOk, "http-charter-v3-bytes-preserved", "actual v3 bytes/version kept, nothing invented");
  HttpExpect(postFamilies.All(f => !string.IsNullOrWhiteSpace(f)), "http-families-canonicalized", "legacy blank families migrated to canonical keys");
  var e1Heads = e1Doc.RootElement.GetProperty("heads");
  var sparseFloorOk = false;
  foreach (var hh in e1Heads.EnumerateArray())
  {
    if ((hh.TryGetProperty("HeadVersion", out var hv) ? hv.GetInt32() : -1) == 0 && (hh.TryGetProperty("FloorVersion", out var fl) ? fl.GetInt32() : 0) == 3) sparseFloorOk = true;
  }
  HttpExpect(sparseFloorOk, "http-sparse-stub-floor3-exported", "single-v3 legacy family carries persisted floor-3 stub");
  // ---- F2 actual HTTP create->revise->approve/discard->amend->export->restore ----
  string flowMeeting = "";
  foreach (var mm in e1Doc.RootElement.GetProperty("meetings").EnumerateArray()) { flowMeeting = mm.GetProperty("Id").GetString() ?? ""; if (!string.IsNullOrWhiteSpace(flowMeeting)) break; }
  HttpExpect(!string.IsNullOrWhiteSpace(flowMeeting), "http-flow-meeting-found", flowMeeting);
  JsonDocument GuardOf(JsonDocument getDoc) { return getDoc; }
  var (dcSt, dcDoc) = PostJson(http, "http://127.0.0.1:5146/api/meetings/" + flowMeeting + "/record/draft", JsonDocument.Parse("[{\"id\":\"s1\",\"text\":\"BUY\"},{\"id\":\"s2\",\"text\":\"KEEP\"}]").RootElement);
  HttpExpect(dcSt == System.Net.HttpStatusCode.Created, "http-draft-created", "status=" + (int)dcSt + " " + dcDoc.RootElement.GetRawText().Substring(0, Math.Min(300, dcDoc.RootElement.GetRawText().Length)));
  var flowId = dcDoc.RootElement.TryGetProperty("id", out var fidv) ? (fidv.GetString() ?? "") : (dcDoc.RootElement.TryGetProperty("Id", out var fidv2) ? (fidv2.GetString() ?? "") : "");
  (System.Net.HttpStatusCode gst, JsonDocument gdoc) GetDraft(string id) { return GetJson(http, "http://127.0.0.1:5146/api/records/" + id); }
  System.Collections.Generic.Dictionary<string, object?> GuardFor(JsonDocument getDoc)
  {
    var r = getDoc.RootElement;
    string gs(string a, string b) { if (r.TryGetProperty(a, out var xv)) return xv.GetString() ?? ""; if (r.TryGetProperty(b, out var yv)) return yv.GetString() ?? ""; return ""; }
    long gl(string a, string b) { if (r.TryGetProperty(a, out var xv) && xv.ValueKind == JsonValueKind.Number && xv.TryGetInt64(out var l)) return l; if (r.TryGetProperty(b, out var yv) && yv.ValueKind == JsonValueKind.Number && yv.TryGetInt64(out var l2)) return l2; return 0; }
    int gi(string a, string b) { if (r.TryGetProperty(a, out var xv) && xv.ValueKind == JsonValueKind.Number && xv.TryGetInt32(out var l)) return l; if (r.TryGetProperty(b, out var yv) && yv.ValueKind == JsonValueKind.Number && yv.TryGetInt32(out var l2)) return l2; return 0; }
    return new System.Collections.Generic.Dictionary<string, object?> { ["version"] = gi("version", "Version"), ["hash"] = gs("hash", "Hash"), ["reviewToken"] = gs("reviewToken", "ReviewToken"), ["watermark"] = gl("watermark", "Watermark") };
  }
  var (_, g0) = GetDraft(flowId); var g0g = GuardFor(g0);
  var (rvSt, rvDoc) = PostJson(http, "http://127.0.0.1:5146/api/records/" + flowId + "/items/revise", new System.Collections.Generic.Dictionary<string, object?> { ["itemId"] = "s2", ["text"] = "HOLD", ["version"] = g0g["version"], ["hash"] = g0g["hash"], ["reviewToken"] = g0g["reviewToken"], ["watermark"] = g0g["watermark"] });
  HttpExpect(rvSt == System.Net.HttpStatusCode.OK, "http-revise-s2-hold", "status=" + (int)rvSt + " " + rvDoc.RootElement.GetRawText().Substring(0, Math.Min(200, rvDoc.RootElement.GetRawText().Length)));
  var (_, g1) = GetDraft(flowId); var g1g = GuardFor(g1);
  var (apSt, apDoc) = PostJson(http, "http://127.0.0.1:5146/api/records/" + flowId + "/items/approve", new System.Collections.Generic.Dictionary<string, object?> { ["itemId"] = "s1", ["version"] = g1g["version"], ["hash"] = g1g["hash"], ["reviewToken"] = g1g["reviewToken"], ["watermark"] = g1g["watermark"] });
  HttpExpect(apSt == System.Net.HttpStatusCode.OK, "http-approve-s1-partial", "status=" + (int)apSt);
  HttpExpect(apDoc.RootElement.TryGetProperty("status", out var apstv) && (apstv.GetString() ?? "") == "partially-approved", "http-status-partially-approved", apDoc.RootElement.GetRawText());
  var (evSt, evDoc) = GetJson(http, "http://127.0.0.1:5146/api/records/" + flowId + "/evidence");
  var evOk = evSt == System.Net.HttpStatusCode.OK && evDoc.RootElement.ValueKind == JsonValueKind.Array;
  HttpExpect(evOk, "http-evidence-route-200", "evidence route resolves through the real resolver, status=" + (int)evSt);
  var (_, g2) = GetDraft(flowId); var g2g = GuardFor(g2);
  var (diSt, diDoc) = PostJson(http, "http://127.0.0.1:5146/api/records/" + flowId + "/items/discard", new System.Collections.Generic.Dictionary<string, object?> { ["itemId"] = "s2", ["version"] = g2g["version"], ["hash"] = g2g["hash"], ["reviewToken"] = g2g["reviewToken"], ["watermark"] = g2g["watermark"] });
  HttpExpect(diSt == System.Net.HttpStatusCode.OK, "http-discard-s2-approved", "status=" + (int)diSt);
  HttpExpect(diDoc.RootElement.TryGetProperty("status", out var distv) && (distv.GetString() ?? "") == "approved" && diDoc.RootElement.TryGetProperty("decided", out var didv) && didv.ValueKind == JsonValueKind.True, "http-status-approved-decided", diDoc.RootElement.GetRawText());
  var (_, g3) = GetDraft(flowId); var g3g = GuardFor(g3);
  var (amSt, amDoc) = PostJson(http, "http://127.0.0.1:5146/api/records/" + flowId + "/amend", new System.Collections.Generic.Dictionary<string, object?> { ["version"] = g3g["version"], ["hash"] = g3g["hash"], ["reviewToken"] = g3g["reviewToken"], ["watermark"] = g3g["watermark"] });
  HttpExpect(amSt == System.Net.HttpStatusCode.Created, "http-amend-successor", "status=" + (int)amSt + " " + amDoc.RootElement.GetRawText().Substring(0, Math.Min(300, amDoc.RootElement.GetRawText().Length)));
  var succId = amDoc.RootElement.TryGetProperty("id", out var scv) ? (scv.GetString() ?? "") : "";
  HttpExpect(!string.IsNullOrWhiteSpace(succId) && succId != flowId, "http-amend-new-id", succId);
  var (_, gs_) = GetDraft(succId);
  HttpExpect(gs_.RootElement.TryGetProperty("itemsJson", out var sij) && (sij.GetString() ?? "").Contains("HOLD"), "http-amend-inherits-items", "successor inherits revised text");
  string exportText;
  using (var eresp = http.GetAsync("http://127.0.0.1:5146/api/records/" + flowId + "/export?format=detailed").GetAwaiter().GetResult())
  { exportText = eresp.Content.ReadAsStringAsync().GetAwaiter().GetResult(); HttpExpect(eresp.StatusCode == System.Net.HttpStatusCode.OK && exportText.Contains("BUY"), "http-export-A-bytes", "detailed export carries exact amended bytes (HOLD was discarded; inheritance proven separately), status=" + (int)eresp.StatusCode); }
  var (e0St, e0Doc) = GetJson(http, "http://127.0.0.1:5146/api/backup");
  HttpExpect(e0St == System.Net.HttpStatusCode.OK, "http-backup-E0-200", "status=" + (int)e0St);
  var e0Snap = e0Doc.RootElement.GetProperty("snapshot").GetString() ?? "";
  var e0Norm = NormExportStable(e0Snap);
  HttpExpect(e0Norm.Contains("s1") && e0Norm.Contains("BUY") && e0Norm.Contains("HOLD"), "http-E0-carries-flow", "export carries actual amended bytes");
  // ---- F2/P1 round-trip: own export restores with complete preserved data ----
  static string TamperDropFamilyMember(string snapshotJson, out string detail)
  {
    detail = "";
    var node = System.Text.Json.Nodes.JsonNode.Parse(snapshotJson);
    if (node is null) { detail = "unparseable"; return snapshotJson; }
    var srcs = node["sources"] as System.Text.Json.Nodes.JsonArray;
    if (srcs is null) { detail = "no-sources"; return snapshotJson; }
    var groups = new Dictionary<string, List<System.Text.Json.Nodes.JsonObject>>(StringComparer.Ordinal);
    foreach (var s in srcs)
    {
      if (s is not System.Text.Json.Nodes.JsonObject o) continue;
      var k = (o["BoardId"]?.GetValue<string>() ?? "") + "|" + (o["FamilyKey"]?.GetValue<string>() ?? "");
      if (!groups.TryGetValue(k, out var gl)) { gl = new List<System.Text.Json.Nodes.JsonObject>(); groups[k] = gl; }
      gl.Add(o);
    }
    System.Text.Json.Nodes.JsonObject? victim = null;
    foreach (var kv in groups.Values)
    {
      if (kv.Count < 2) continue;
      var ordered = kv.OrderBy(o => o["Version"]?.GetValue<int>() ?? 999).ToList();
      victim = ordered.First();
      break;
    }
    if (victim is null) { detail = "no-dense-family"; return snapshotJson; }
    var vid = victim["Id"]?.GetValue<string>() ?? "";
    detail = "drop-source " + vid + " v" + (victim["Version"]?.GetValue<int>() ?? -1);
    var kept = new System.Text.Json.Nodes.JsonArray();
    foreach (var s in srcs) { if (s is System.Text.Json.Nodes.JsonObject o && (o["Id"]?.GetValue<string>() ?? "") == vid) continue; if (s is null) continue; kept.Add(System.Text.Json.Nodes.JsonNode.Parse(s!.ToJsonString())); }
    node["sources"] = kept;
    var secs = node["sections"] as System.Text.Json.Nodes.JsonArray;
    if (secs is not null) { var ks = new System.Text.Json.Nodes.JsonArray(); foreach (var s in secs) { if (s is System.Text.Json.Nodes.JsonObject o && (o["SourceId"]?.GetValue<string>() ?? "") == vid) continue; ks.Add(System.Text.Json.Nodes.JsonNode.Parse(s!.ToJsonString())); } node["sections"] = ks; }
    var evts = node["events"] as System.Text.Json.Nodes.JsonArray;
    if (evts is not null) { var ke = new System.Text.Json.Nodes.JsonArray(); foreach (var s in evts) { if (s is System.Text.Json.Nodes.JsonObject o && (o["SourceId"]?.GetValue<string>() ?? "") == vid) continue; ke.Add(System.Text.Json.Nodes.JsonNode.Parse(s!.ToJsonString())); } node["events"] = ke; }
    return node.ToJsonString();
  }
  apiProc2 = StartApi(httpB!, 5246, apiOut2, apiErr2, System.IO.Path.Combine(artifactDir, "wikiring2"), csBaseAdmin);
  apiDrain2a = System.Threading.Tasks.Task.Run(() => DrainLines(apiProc2.StandardOutput, apiOut2));
  apiDrain2b = System.Threading.Tasks.Task.Run(() => DrainLines(apiProc2.StandardError, apiErr2));
  var ready2 = WaitReady(http, "http://127.0.0.1:5246", 45); HttpExpect(ready2, "http-api2-ready-postgres", "boot on fresh exclusive DB");
  if (!ready2) HttpTerminal("http-api2-ready-terminal", "readiness failed; refusing restore into an unverified listener.");
  HttpRequireListener(apiProc2, 5246, "http-own-5246-before-e0");
  var (rtSt, rtDoc) = PostJson(http, "http://127.0.0.1:5246/api/backup/restore", new { snapshot = e0Snap, hash = SimCEO.Api.Work.Hashing.FullHash(System.Text.Encoding.UTF8.GetBytes(e0Snap)) });
  HttpExpect(rtSt == System.Net.HttpStatusCode.OK, "http-E0-restore-200", "own export round-trips, status=" + (int)rtSt + " " + rtDoc.RootElement.GetRawText().Substring(0, Math.Min(300, rtDoc.RootElement.GetRawText().Length)));
  var (reSt, reDoc) = GetJson(http, "http://127.0.0.1:5246/api/backup");
  HttpExpect(reSt == System.Net.HttpStatusCode.OK, "http-roundtrip-export-200", "status=" + (int)reSt);
  var reSnap = reDoc.RootElement.GetProperty("snapshot").GetString() ?? "";
  var reNorm = NormExportStable(reSnap); EmitNormDiff(e0Norm, reSnap, artifactDir, "e0-roundtrip", "http-roundtrip-byte-identical"); HttpExpect(reNorm == e0Norm, "http-roundtrip-byte-identical", "export after restore equals sent export (modulo at+generation-floor): exact fields/history/bytes"); CheckGenFloor(e0Snap, reSnap, 0, "http-genfloor-roundtrip"); CheckBoardOwners(e0Snap, reSnap, "", "http-owners-roundtrip");
  // Malicious partial-family removal rejects with zero mutation: full prior graph
  // through the actual route is byte-identical before and after the attempt.
  // Pre-attempt baseline through the actual route: the failed restore must leave this exact graph.
  var (preSt, preDoc) = GetJson(http, "http://127.0.0.1:5246/api/backup");
  var preNorm = preSt == System.Net.HttpStatusCode.OK ? NormExportStable(preDoc.RootElement.GetProperty("snapshot").GetString() ?? "") : "";
  var preSnapText = preSt == System.Net.HttpStatusCode.OK ? preDoc.RootElement.GetProperty("snapshot").GetString() ?? "" : "";
  var preFailExact = preSt == System.Net.HttpStatusCode.OK ? NormFailedStable(preSnapText) : "";
  HttpExpect(preSt == System.Net.HttpStatusCode.OK && preNorm == e0Norm, "http-pre-attempt-baseline", "baseline export matches sent export before tampered attempt");
  var tampered = TamperDropFamilyMember(e0Snap, out var tamperDetail);
  var tamperPosted = false;
  var ngSt = System.Net.HttpStatusCode.ServiceUnavailable; var ngDoc = JsonDocument.Parse("{\"error\":\"tamper construction failed; restore not attempted\"}");
  HttpExpect(tamperDetail.StartsWith("drop-source"), "http-tamper-constructed", tamperDetail);
  if (tamperDetail.StartsWith("drop-source"))
  {
    HttpRequireListener(apiProc2, 5246, "http-own-5246-before-e0-tamper");
    (ngSt, ngDoc) = PostJson(http, "http://127.0.0.1:5246/api/backup/restore", new { snapshot = tampered, hash = SimCEO.Api.Work.Hashing.FullHash(System.Text.Encoding.UTF8.GetBytes(tampered)) });
    tamperPosted = true;
  }
  else
  {
    HttpExpect(false, "http-tampered-restore-422", "construction failed (" + tamperDetail + "); restore not attempted so unchanged valid snapshot is never POSTed");
    HttpExpect(false, "http-tamper-error-shape", "construction failed (" + tamperDetail + "); no restore attempted, no rejection to shape-check");
  }
  if (tamperPosted)
  {
    HttpExpect(ngSt == System.Net.HttpStatusCode.UnprocessableEntity, "http-tampered-restore-422", "status=" + (int)ngSt + " " + ngDoc.RootElement.GetRawText().Substring(0, Math.Min(300, ngDoc.RootElement.GetRawText().Length)));
    HttpExpect(ngDoc.RootElement.GetRawText().Contains("skips version"), "http-tamper-error-shape", "dense-gap rejection names the skipped version");
  }
  var (unSt, unDoc) = GetJson(http, "http://127.0.0.1:5246/api/backup");
  var unSnap = unDoc.RootElement.GetProperty("snapshot").GetString() ?? ""; var unFailExact = NormFailedStable(unSnap); EmitFailedDiff(preFailExact, unSnap, artifactDir, "e0-prior", "http-prior-unchanged-after-422"); HttpExpect(tamperPosted && unSt == System.Net.HttpStatusCode.OK && unFailExact == preFailExact, "http-prior-unchanged-after-422", "rejected restore leaves generations, owners, and every other field byte-identical (only root at excluded)");
  // Modern v4 wiped-history forgery over the actual route: HistoryJson is a STRING
  // (backup serializes draft entities directly), so select a known modern row with an
  // explicit false marker, verify its history STRING is nonempty, then assign the
  // STRING "[]". All other fields (marker, revision, token, items, hash, snapshots)
  // are preserved. Construction is required before POST; restore must 422 with the
  // modern wiped-history reason and zero mutation.
  string wipedSnap = ""; string wipeDetail = "no-draft"; var wipePosted = false;
  try
  {
    var wnode = System.Text.Json.Nodes.JsonNode.Parse(e0Snap);
    var wdrafts = wnode?["drafts"] as System.Text.Json.Nodes.JsonArray;
    if (wdrafts is not null) foreach (var wd in wdrafts)
    {
      if (wd is System.Text.Json.Nodes.JsonObject wdo)
      {
        var wipeMarker = wdo["LegacyReview"]?.GetValue<bool?>();
        var wipeHistStr = wdo["HistoryJson"]?.GetValue<string>();
        if (wipeMarker == false && !string.IsNullOrWhiteSpace(wipeHistStr))
        {
          var wipeHistCount = 0;
          try { using var whdoc = JsonDocument.Parse(wipeHistStr); if (whdoc.RootElement.ValueKind == JsonValueKind.Array) wipeHistCount = whdoc.RootElement.GetArrayLength(); } catch { wipeHistCount = 0; }
          if (wipeHistCount > 0)
          {
            wdo["HistoryJson"] = "[]";
            wipeDetail = "wiped-history " + (wdo["Id"]?.GetValue<string>() ?? "?");
            break;
          }
        }
      }
    }
    wipedSnap = wnode?.ToJsonString() ?? "";
  }
  catch (Exception wex) { wipeDetail = "unparseable:" + wex.GetType().Name; }
  HttpExpect(wipeDetail.StartsWith("wiped-history"), "http-wipe-constructed", wipeDetail);
  HttpExpect(wipeDetail.StartsWith("wiped-history") && !string.IsNullOrWhiteSpace(wipedSnap), "http-wipe-snapshot-built", "construction required before POST");
  var wSt = System.Net.HttpStatusCode.ServiceUnavailable; var wDoc = JsonDocument.Parse("{\"error\":\"wipe construction failed; restore not attempted\"}");
  if (wipeDetail.StartsWith("wiped-history") && !string.IsNullOrWhiteSpace(wipedSnap))
  {
    HttpRequireListener(apiProc2, 5246, "http-own-5246-before-wipe");
    (wSt, wDoc) = PostJson(http, "http://127.0.0.1:5246/api/backup/restore", new { snapshot = wipedSnap, hash = SimCEO.Api.Work.Hashing.FullHash(System.Text.Encoding.UTF8.GetBytes(wipedSnap)) });
    wipePosted = true;
  }
  HttpExpect(wSt == System.Net.HttpStatusCode.UnprocessableEntity, "http-wiped-history-422", "status=" + (int)wSt + " " + wDoc.RootElement.GetRawText().Substring(0, Math.Min(300, wDoc.RootElement.GetRawText().Length)));
  HttpExpect(wDoc.RootElement.GetRawText().Contains("without decision history"), "http-wiped-history-reason", "modern wiped row must fail for the exact history reason");
  var (wipePreSt, wipePreDoc) = GetJson(http, "http://127.0.0.1:5246/api/backup");
  var wipePreSnap = wipePreSt == System.Net.HttpStatusCode.OK ? wipePreDoc.RootElement.GetProperty("snapshot").GetString() ?? "" : "";
  var wipePreFailExact = wipePreSt == System.Net.HttpStatusCode.OK ? NormFailedStable(wipePreSnap) : "";
  HttpExpect(wipePreSt == System.Net.HttpStatusCode.OK, "http-wipe-pre-baseline", "fresh immediate baseline captured before wiped-history POST");
  var (wBackSt, wBackDoc) = GetJson(http, "http://127.0.0.1:5246/api/backup");
  var wBackSnap = "";
  // Fresh immediate baseline: re-read AFTER the wiped POST attempt so any accidental
  // earlier mutation cannot false-credit this check; compare post-state to the
  // immediate pre-wipe graph, and also require it to equal the pre-tamper graph.
  if (wBackSt == System.Net.HttpStatusCode.OK) { wBackSnap = wBackDoc.RootElement.GetProperty("snapshot").GetString() ?? ""; }
  var wBackExact = string.IsNullOrWhiteSpace(wBackSnap) ? "" : NormFailedStable(wBackSnap); EmitFailedDiff(wipePreFailExact, wBackSnap, artifactDir, "e0-wiped-prior", "http-wiped-prior-unchanged"); HttpExpect(wipePosted && wBackSt == System.Net.HttpStatusCode.OK && wBackExact == wipePreFailExact && wBackExact == preFailExact, "http-wiped-prior-unchanged", "wiped modern v4 export rejects with generations, owners, and every other field unchanged");
  // ---- P1a: physical upg clone upgrades, exports, and restores through actual routes ----
  var dumpFile = "/tmp/ess_ev_httpupg_dump.sql";
  var (dumpExit, dumpOut, dumpErr, dumpTo) = RunBounded("docker", "exec simceo-integration-qa-pg pg_dump -U simceo -d essentials_backend_upg -f " + dumpFile, 300000);
  HttpExpect(!dumpTo && dumpExit == 0, "http-upg-dump-native", "read-only pg_dump exit=" + dumpExit + " timedOut=" + dumpTo + " err=" + dumpErr.Trim());
  var (rstExit, rstOut, rstErr, rstTo) = RunBounded("docker", "exec simceo-integration-qa-pg psql -U simceo -d " + httpUpg + " -f " + dumpFile, 300000);
  HttpExpect(!rstTo && rstExit == 0, "http-upg-clone-native", "clone-into-exclusive-DB exit=" + rstExit + " timedOut=" + rstTo + " err=" + rstErr.Trim());
  var (rmExit, rmOut, rmErr, rmTo) = RunBounded("docker", "exec simceo-integration-qa-pg rm -f " + dumpFile, 60000);
  HttpExpect(!rmTo && rmExit == 0, "http-upg-dump-cleaned", "server-side dump removed exit=" + rmExit);
  var csUpg = csBaseAdmin.Replace("Database=postgres;", "Database=" + httpUpg + ";");
  // Clone scrub (P1a note): installation security rows are excluded from the domain proof.
  // Backup/restore ignores Accounts/SecurityStates by design (never resurrects access), so the
  // scrubbed exclusive clone preserves every domain byte while booting owner-anonymously.
  try { ExecSql(csUpg, "DELETE FROM \"AuthAccounts\""); ExecSql(csUpg, "DELETE FROM \"SecurityStates\""); HttpExpect(true, "http-upg-scrub-security", "security rows scrubbed on exclusive clone"); }
  catch (Exception scrubEx) { HttpExpect(false, "http-upg-scrub-security", scrubEx.GetType().Name + " " + scrubEx.Message); }
  KillApi(ref apiProc1, apiDrain1a, apiDrain1b, apiOut1, apiErr1, System.IO.Path.Combine(artifactDir, "api1.log"));
  var reuse5146 = PortFree(5146); HttpExpect(reuse5146, "http-5146-reuse-free", "prior child reaped before upgraded clone reuses 5146");
  if (!reuse5146) HttpTerminal("http-5146-reuse-terminal", "5146 still bound after api1 kill; refusing to boot the clone into ambiguity.");
  apiProc3 = StartApi(httpUpg!, 5146, apiOut3, apiErr3, System.IO.Path.Combine(artifactDir, "wikiring3"), csBaseAdmin);
  apiDrain3a = System.Threading.Tasks.Task.Run(() => DrainLines(apiProc3.StandardOutput, apiOut3));
  apiDrain3b = System.Threading.Tasks.Task.Run(() => DrainLines(apiProc3.StandardError, apiErr3));
  var ready3 = WaitReady(http, "http://127.0.0.1:5146", 60); HttpExpect(ready3, "http-api3-ready-postgres", "upgraded clone boots (schema upgrade + floor/stub backfill)");
  if (!ready3) HttpTerminal("http-api3-ready-terminal", "upgraded-clone readiness failed; refusing restore into an unverified listener.");
  var (ueSt, ueDoc) = GetJson(http, "http://127.0.0.1:5146/api/backup");
  HttpExpect(ueSt == System.Net.HttpStatusCode.OK, "http-upg-export-200", "status=" + (int)ueSt);
  var upgSnap = ueDoc.RootElement.GetProperty("snapshot").GetString() ?? "";
  var upgNorm = NormExportStable(upgSnap);
  HttpExpect(upgNorm.Contains("\"Version\":3") || upgNorm.Contains("\\\"Version\\\":3") || upgNorm.Contains("Version") , "http-upg-has-v3", "upgraded export carries v3 families");
  using var upgDoc = JsonDocument.Parse(upgSnap);
  var upgSparseFloor = false; var upgDenseFloor1 = false;
  var upgFams = new Dictionary<string, List<int>>(StringComparer.Ordinal);
  foreach (var srow in upgDoc.RootElement.GetProperty("sources").EnumerateArray())
  {
    var fk = (srow.TryGetProperty("BoardId", out var ub) ? (ub.GetString() ?? "") : "") + "|" + (srow.TryGetProperty("FamilyKey", out var uf) ? (uf.GetString() ?? "") : "");
    if (!upgFams.TryGetValue(fk, out var gl2)) { gl2 = new List<int>(); upgFams[fk] = gl2; }
    gl2.Add(srow.TryGetProperty("Version", out var uv) ? uv.GetInt32() : 0);
    if ((srow.TryGetProperty("Version", out var uv2) ? uv2.GetInt32() : 0) == 3) { }
  }
  foreach (var hh in upgDoc.RootElement.GetProperty("heads").EnumerateArray())
  {
    var hv = hh.TryGetProperty("HeadVersion", out var hvv) ? hvv.GetInt32() : -1;
    var fl = hh.TryGetProperty("FloorVersion", out var flv) ? flv.GetInt32() : -1;
    if (hv == 0 && fl == 3) upgSparseFloor = true;
    if (hv > 0 && fl == 1) upgDenseFloor1 = true;
  }
  HttpExpect(upgSparseFloor, "http-upg-sparse-floor3", "single-v3 legacy family carries persisted floor-3 stub after upgrade");
  HttpExpect(upgDenseFloor1, "http-upg-dense-floor1", "dense upgraded family carries floor 1");
  long liveMaxUpg = 0;
  string preFlSnap = "";
  { var (preFlSt, preFlDoc) = GetJson(http, "http://127.0.0.1:5146/api/backup");
    preFlSnap = preFlSt == System.Net.HttpStatusCode.OK ? preFlDoc.RootElement.GetProperty("snapshot").GetString() ?? "" : "";
    if (preFlSt == System.Net.HttpStatusCode.OK) {
      using var preFlDoc2 = JsonDocument.Parse(preFlDoc.RootElement.GetProperty("snapshot").GetString() ?? "{}"); foreach (var pm in preFlDoc2.RootElement.GetProperty("meetings").EnumerateArray()) if (pm.TryGetProperty("Generation", out var pgv) && pgv.ValueKind == JsonValueKind.Number && pgv.TryGetInt64(out var pgl) && pgl > liveMaxUpg) liveMaxUpg = pgl; HttpExpect(preFlSt == System.Net.HttpStatusCode.OK, "http-upg-live-max", "liveMaxUpg=" + liveMaxUpg);
    }
  }
  HttpRequireListener(apiProc3, 5146, "http-own-5146-before-upg");
  var (urSt, urDoc) = PostJson(http, "http://127.0.0.1:5146/api/backup/restore", new { snapshot = upgSnap, hash = SimCEO.Api.Work.Hashing.FullHash(System.Text.Encoding.UTF8.GetBytes(upgSnap)) });
  HttpExpect(urSt == System.Net.HttpStatusCode.OK, "http-upg-restore-200", "valid upgraded own-export restores (was honest-422), status=" + (int)urSt + " " + urDoc.RootElement.GetRawText().Substring(0, Math.Min(300, urDoc.RootElement.GetRawText().Length)));
  var (uvSt, uvDoc) = GetJson(http, "http://127.0.0.1:5146/api/backup");
  var uvSnap = uvDoc.RootElement.GetProperty("snapshot").GetString() ?? ""; var uvNorm = NormExportStable(uvSnap); EmitNormDiff(upgNorm, uvSnap, artifactDir, "upg-roundtrip", "http-upg-roundtrip-identical"); HttpExpect(uvSt == System.Net.HttpStatusCode.OK && uvNorm == upgNorm, "http-upg-roundtrip-identical", "upgraded restore preserves complete data byte-identically (modulo at+generation-floor)"); CheckGenFloor(upgSnap, uvSnap, liveMaxUpg, "http-upg-genfloor"); CheckBoardOwners(upgSnap, uvSnap, preFlSnap, "http-owners-upg-roundtrip");
  // Pre-attempt baseline + live generation max for the upg floor assertion.
  var (preUpgSt, preUpgDoc) = GetJson(http, "http://127.0.0.1:5246/api/backup");
  string preUpgFailExact = "";
  if (preUpgSt == System.Net.HttpStatusCode.OK)
  {
    preUpgFailExact = preUpgSt == System.Net.HttpStatusCode.OK ? NormFailedStable(preUpgDoc.RootElement.GetProperty("snapshot").GetString() ?? "") : "";
  }
  HttpExpect(preUpgSt == System.Net.HttpStatusCode.OK, "http-upg-pre-baseline", "liveMaxUpg=" + liveMaxUpg);
  var tamperedUpg = TamperDropFamilyMember(upgSnap, out var tamperUpgDetail);
  HttpExpect(tamperUpgDetail.StartsWith("drop-source"), "http-upg-tamper-constructed", tamperUpgDetail);
  HttpRequireListener(apiProc2, 5246, "http-own-5246-before-upg-tamper");
  var (unSt2, unDoc2) = PostJson(http, "http://127.0.0.1:5246/api/backup/restore", new { snapshot = tamperedUpg, hash = SimCEO.Api.Work.Hashing.FullHash(System.Text.Encoding.UTF8.GetBytes(tamperedUpg)) });
  HttpExpect(unSt2 == System.Net.HttpStatusCode.UnprocessableEntity, "http-upg-tampered-422", "status=" + (int)unSt2 + " " + unDoc2.RootElement.GetRawText().Substring(0, Math.Min(300, unDoc2.RootElement.GetRawText().Length)));
  var (ufSt, ufDoc) = GetJson(http, "http://127.0.0.1:5246/api/backup");
  var ufSnap = ufDoc.RootElement.GetProperty("snapshot").GetString() ?? ""; var ufFailExact = NormFailedStable(ufSnap); EmitFailedDiff(preUpgFailExact, ufSnap, artifactDir, "upg-prior", "http-upg-prior-unchanged"); HttpExpect(ufSt == System.Net.HttpStatusCode.OK && ufFailExact == preUpgFailExact, "http-upg-prior-unchanged", "malicious partial removal rejects with full prior unchanged: generations, owners, and every other field byte-identical");
}
catch (Exception hex) { HttpFail("http-fatal", hex.GetType().Name + " " + hex.Message + " " + (hex.StackTrace ?? "").Substring(0, Math.Min(400, (hex.StackTrace ?? "").Length))); }
finally
{
  var hcerrs = new List<string>();
  try { KillApi(ref apiProc1, apiDrain1a, apiDrain1b, apiOut1, apiErr1, System.IO.Path.Combine(artifactDir, "api1.log")); } catch (Exception ex) { hcerrs.Add("api1-kill: " + ex.Message); }
  try { KillApi(ref apiProc2, apiDrain2a, apiDrain2b, apiOut2, apiErr2, System.IO.Path.Combine(artifactDir, "api2.log")); } catch (Exception ex) { hcerrs.Add("api2-kill: " + ex.Message); }
  try { KillApi(ref apiProc3, apiDrain3a, apiDrain3b, apiOut3, apiErr3, System.IO.Path.Combine(artifactDir, "api3.log")); } catch (Exception ex) { hcerrs.Add("api3-kill: " + ex.Message); }
  try
  {
    var dropOpt = new Microsoft.EntityFrameworkCore.DbContextOptionsBuilder<SimCEO.Postgres.PostgresDb>().UseNpgsql(csBaseAdmin).Options;
    using var dropDb = new SimCEO.Postgres.PostgresDb(dropOpt);
    foreach (var (hdb, created) in new[] { (httpA, httpACreated), (httpB, httpBCreated), (httpUpg, httpUpgCreated) })
    {
      if (string.IsNullOrWhiteSpace(hdb) || !created) continue;
      try { dropDb.Database.ExecuteSqlRaw("DROP DATABASE \"" + hdb + "\" WITH (FORCE)"); } catch (Exception ex) { hcerrs.Add("drop-" + hdb + ": " + ex.Message); }
    }
    using var verifyDb = new SimCEO.Postgres.PostgresDb(dropOpt);
    var vconn = verifyDb.Database.GetDbConnection();
    if (vconn.State != System.Data.ConnectionState.Open) vconn.Open();
    using var vcmd = vconn.CreateCommand();
    vcmd.CommandText = "SELECT datname FROM pg_database WHERE datname LIKE 'essentials_evidence\\_%' ORDER BY 1";
    using var vrd = vcmd.ExecuteReader();
    var hafter = new List<string>();
    while (vrd.Read()) hafter.Add(vrd.GetString(0));
    if (!hafter.Contains("essentials_evidence_1d7f5f17316d")) hcerrs.Add("prior-proof-db-missing-after-http: 1d7f5f17316d");
    if (hafter.Any(x => x.StartsWith("essentials_evidence_httpa_") || x.StartsWith("essentials_evidence_httpb_") || x.StartsWith("essentials_evidence_httpupg_"))) hcerrs.Add("http-owned-db-leak: " + string.Join(",", hafter));
    try { System.IO.File.WriteAllLines(System.IO.Path.Combine(artifactDir, "http-dbs-after.txt"), hafter); } catch { }
  }
  catch (Exception ex) { hcerrs.Add("http-owned-db-drop: " + ex.Message); }
  try { http.Dispose(); } catch (Exception ex) { hcerrs.Add("http-dispose: " + ex.Message); }
  if (hcerrs.Count > 0) HttpFail("http-cleanup-errors", string.Join("; ", hcerrs));
  else Emit("HTTP CLEANUP ok apis-stopped dbs-dropped");
}
Emit("MEMORY+PG DONE passed=" + passed + " failures=" + failures.Count);
try
{
  var srcSha = "";
    // Bounded concurrent drain (F7): the retained child is reaped via RunBounded with
    // an explicit native-exit check, never an unbounded sequential read.
    var (gitExit, gitOut, gitErr, gitTo) = RunBounded("git", "rev-parse HEAD", 15000);
    if (gitExit == 0 && !gitTo) srcSha = gitOut.Trim();
    else Fail("artifact-source-git", "exit=" + gitExit + " timedOut=" + gitTo + " err=" + gitErr.Trim());
  if (string.IsNullOrWhiteSpace(srcSha)) { Fail("artifact-source-sha", "git HEAD unavailable"); }
  var apiHash = "";
  try
  {
    var asm = typeof(SimCEO.Api.Data.Pg).Assembly.Location;
    using var fs = System.IO.File.OpenRead(asm);
    using var sh = System.Security.Cryptography.SHA256.Create();
    apiHash = Convert.ToHexString(sh.ComputeHash(fs));
  }
  catch (Exception ex) { Fail("artifact-api-hash", ex.Message); }
  var pgHash = "";
  try
  {
    var pasm = typeof(SimCEO.Postgres.PostgresDb).Assembly.Location;
    using var pfs = System.IO.File.OpenRead(pasm);
    using var psh = System.Security.Cryptography.SHA256.Create();
    pgHash = Convert.ToHexString(psh.ComputeHash(pfs));
  }
  catch (Exception ex) { Fail("artifact-pg-hash", ex.Message); }
  Emit("SOURCE-SHA=" + srcSha);
  Emit("API-HASH=" + apiHash);
  Emit("PG-HASH=" + pgHash);
  Emit("PG-DB=" + pgDb);
  Emit("PG-IDENTITY=127.0.0.1:15441/simceo (password redacted)");
  System.IO.File.WriteAllLines(System.IO.Path.Combine(artifactDir, "run.log"), logLines);
  Emit("ARTIFACT-WROTE=" + System.IO.Path.Combine(artifactDir, "run.log"));
}
catch (Exception ex) { Fail("artifact-write", ex.GetType().Name + " " + ex.Message); }
if (failures.Count > 0) { Emit("FAILURES: " + string.Join(",", failures)); return 1; }
Emit("ESSENTIALS-EVIDENCE PROBE COMPLETE"); return 0;
