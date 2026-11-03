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
  var e = new SourceEvent { BoardId = boardId, SourceId = sourceId, Action = "migrate-version", Detail = "v" + fromV + "->v" + toV };
  s.SourceEvents[e.Id] = e; s.SourceEvents.Flush();
}
static int? OrigOf(InMemoryStore s, string refId)
{
  try { if (Guid.TryParse(refId, out var g) && s.Sources.TryGetValue(g, out var dd) && dd is not null) return SourceGovernance.OriginalVersionOf(s, dd); } catch { }
  return null;
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
  var recV2 = new RecordDraft { BoardId = bid1, MeetingId = f5Meet.Id, Version = 2, Watermark = 0, ItemsJson = "[{\"id\":\"s1\",\"text\":\"CUT\"}]", Hash = "h5b", ApprovedJson = "[\"s1\"]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f5-B", HistoryJson = "[{\"seq\":1,\"revision\":1,\"token\":\"tok-f5-B\",\"action\":\"approve\",\"itemId\":\"s1\",\"oldText\":\"\",\"newText\":\"CUT\",\"actor\":\"alice\",\"viewedVersion\":2,\"viewedHash\":\"h5b\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"}]", SupersedesJson = "[\"" + recV1.Id + "\"]", EvidenceSnapshotJson = "[]", Decided = true, Status = "approved" };
  mem.Drafts[recV2.Id] = recV2; mem.Drafts.Flush();
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
}
// ---- F2 COMPLETE staged validator: real amend chain + controlled corruptions ----
{
  var f2Meet = new Meeting { BoardId = bid1, Title = "f2-m", State = MeetingState.Active, Generation = 0 }; mem.Meetings[f2Meet.Id] = f2Meet; mem.Meetings.Flush();
  var itemsA = "[{\"id\":\"s1\",\"text\":\"BUY\"},{\"id\":\"s2\",\"text\":\"KEEP\"}]";
  var draftA = new RecordDraft { BoardId = bid1, MeetingId = f2Meet.Id, Version = 1, Watermark = 0, ItemsJson = itemsA, Hash = "h2a", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-f2-A0", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = false, Status = "open" };
  mem.Drafts[draftA.Id] = draftA; mem.Drafts.Flush();
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
  draftB.EvidenceSnapshotJson = snapsB; RecordsOps.RefreshDecided(draftB); mem.Drafts[draftB.Id] = draftB; mem.Drafts.Flush();
  Expect(RecordsOps.ValidateRestoreEntries(new[] { draftA, draftB }) is null, "f2-healthy-amend-validates", "real amend pair");
  Expect(RecordsOps.BuildExport(draftA.ItemsJson, draftA.ApprovedJson, false).Contains("BUY"), "f2-export-A-concise", "A exports BUY");
  Expect(RecordsOps.BuildExport(draftB.ItemsJson, draftB.ApprovedJson, true).Contains("CUT"), "f2-export-B-detailed", "B exports CUT");
  string SerBatch() => JsonSerializer.Serialize(new[] { draftA, draftB });
  var controlBytes = SerBatch();
  void Corrupt(string cname, Action<RecordDraft, RecordDraft> mut)
  {
    var aJson = JsonSerializer.Serialize(draftA); var bJson = JsonSerializer.Serialize(draftB);
    var a2 = JsonSerializer.Deserialize<RecordDraft>(aJson)!; var b2 = JsonSerializer.Deserialize<RecordDraft>(bJson)!;
    mut(a2, b2);
    var err = RecordsOps.ValidateRestoreEntries(new[] { a2, b2 });
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
    b2.ApprovedJson = "[\"s1\"]";
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
    b2.ItemsJson = "[{\"id\":\"ghost\",\"text\":\"x\"},{\"id\":\"s1\",\"text\":\"CUT\"},{\"id\":\"s2\",\"text\":\"KEEP\"}]";
  });
  Corrupt("unknown-status", (a2, b2) => { b2.Status = "melted"; });
  Corrupt("token-without-history", (a2, b2) => { b2.HistoryJson = "[]"; });
  Corrupt("history-without-token", (a2, b2) => { b2.ReviewToken = ""; });
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
      var legacyErr = RecordsOps.ValidateRestoreEntries(restored.drafts);
      Expect(legacyErr is null, "f2-legacy-blank-token-accepted", legacyErr ?? "null (genuine pre-review rows accepted, no fabrication)");
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
  foreach (var d in s.Sources.Values.OrderBy(x => x.Id.ToString())) sb.AppendLine("SRC " + d.Id + "|" + d.BoardId + "|" + d.FileName + "|" + d.Version + "|" + d.ReviewState + "|" + d.Approved + "|" + d.Excluded + "|" + d.Scope + "|" + (d.MeetingId?.ToString() ?? "-") + "|" + d.Origin + "|" + d.FamilyKey + "|" + d.IndexState + "|" + d.IndexGeneration + "|" + (d.IndexError ?? "") + "|" + (d.IndexCompletedAt?.ToString("o") ?? "-") + "|" + (d.ContentHash ?? "") + "|" + (d.ExtractionJson ?? "") + "|orig=" + (d.Original is null ? "-" : Sha(Convert.ToBase64String(d.Original))) + "|" + d.CreatedAt.ToString("o"));
  foreach (var x in s.SourceSections.Values.OrderBy(x => x.SourceId.ToString()).ThenBy(x => x.Ordinal)) sb.AppendLine("SEC " + x.Id + "|" + x.SourceId + "|" + x.BoardId + "|" + x.FamilyKey + "|" + x.SourceVersion + "|" + (x.ContentHash ?? "") + "|" + x.Ordinal + "|" + (x.Heading ?? "") + "|" + (x.Location ?? "") + "|g" + x.IndexGeneration + "|" + (x.Text ?? "") + "|" + x.CreatedAt.ToString("o"));
  foreach (var h in s.SourceHeads.Values.OrderBy(x => x.BoardId.ToString() + x.FamilyKey)) sb.AppendLine("HEAD " + h.Id + "|" + h.BoardId + "|" + h.FamilyKey + "|" + h.HeadVersion + "|" + h.HeadSourceId + "|hw" + h.HighWater + "|" + h.UpdatedAt.ToString("o"));
  foreach (var e in s.SourceEvents.Values.OrderBy(x => x.CreatedAt).ThenBy(x => x.Id.ToString())) sb.AppendLine("EVT " + e.Id + "|" + e.BoardId + "|" + e.SourceId + "|" + (e.Action ?? "") + "|" + (e.Detail ?? "") + "|" + e.CreatedAt.ToString("o"));
  foreach (var m in s.Meetings.Values.OrderBy(x => x.Id.ToString())) sb.AppendLine("MTG " + m.Id + "|" + m.BoardId + "|" + (m.Title ?? "") + "|" + m.State + "|gen" + m.Generation + "|rev" + m.DeliveredRevision);
  foreach (var kv in s.Messages.OrderBy(x => x.Key.ToString())) foreach (var m in kv.Value.OrderBy(x => x.Sequence)) sb.AppendLine("MSG " + kv + "#" + m.Sequence + "|" + (m.Sender ?? "") + "|" + (m.AdvisorName ?? "") + "|" + (m.Content ?? "") + "|" + (m.Stance ?? ""));
  foreach (var d in s.Drafts.Values.OrderBy(x => x.Id.ToString())) sb.AppendLine("DRAFT " + d.Id + "|v" + d.Version + "|wm" + d.Watermark + "|" + (d.ItemsJson ?? "") + "|" + (d.Hash ?? "") + "|" + (d.ApprovedJson ?? "") + "|" + (d.DiscardedJson ?? "") + "|rr" + d.ReviewRevision + "|" + (d.ReviewToken ?? "") + "|" + (d.HistoryJson ?? "") + "|" + (d.SupersedesJson ?? "") + "|" + (d.EvidenceSnapshotJson ?? "") + "|" + d.Decided + "|" + (d.Status ?? ""));
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
// Single validated OWNED container/connection identity (F7): every connection string in this run derives
// from this one validated identity. A PGCS override pointing anywhere else is refused, never silently split
// into a serverA/tests-serverB pair.
Expect(string.Equals(pgParts.GetValueOrDefault("Host"), "127.0.0.1", StringComparison.OrdinalIgnoreCase), "f7-pg-host-owned", pgParts.GetValueOrDefault("Host") ?? "?");
Expect(string.Equals(pgParts.GetValueOrDefault("Port"), "15441", StringComparison.OrdinalIgnoreCase), "f7-pg-port-owned", pgParts.GetValueOrDefault("Port") ?? "?");
Expect(string.Equals(pgParts.GetValueOrDefault("Username"), "simceo", StringComparison.OrdinalIgnoreCase), "f7-pg-user-owned", pgParts.GetValueOrDefault("Username") ?? "?");
Expect(!string.IsNullOrWhiteSpace(pgParts.GetValueOrDefault("Password")), "f7-pg-password-present", "credential supplied");
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
  var fitems = "[{\"id\":\"s1\",\"text\":\"BUY\"}]";
  var frecA = new RecordDraft { BoardId = pbid, MeetingId = fmeet.Id, Version = 1, Watermark = 0, ItemsJson = fitems, Hash = "hfA", ApprovedJson = "[\"s1\"]", DiscardedJson = "[]", ReviewRevision = 1, ReviewToken = "tok-pg-A", HistoryJson = "[{\"seq\":1,\"revision\":1,\"token\":\"tok-pg-A\",\"action\":\"approve\",\"itemId\":\"s1\",\"oldText\":\"\",\"newText\":\"BUY\",\"actor\":\"alice\",\"viewedVersion\":1,\"viewedHash\":\"hfA\",\"viewedWatermark\":0,\"viewedToken\":\"t\",\"at\":\"2026-01-01T00:00:00Z\"}]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", Decided = true, Status = "approved" };
  ps.Drafts[frecA.Id] = frecA; ps.Drafts.Flush();
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
Emit("MEMORY+PG DONE passed=" + passed + " failures=" + failures.Count);
try
{
  var srcSha = "";
  try
  {
    var psi = new System.Diagnostics.ProcessStartInfo("git", "rev-parse HEAD") { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true };
    using var pr = System.Diagnostics.Process.Start(psi);
    srcSha = pr is null ? "" : (pr.StandardOutput.ReadToEnd() ?? "").Trim();
    pr?.WaitForExit(10000);
  }
  catch { }
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
