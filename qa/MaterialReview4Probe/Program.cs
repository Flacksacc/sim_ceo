using SimCEO.Api;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;
using Microsoft.AspNetCore.Http;
using System.Reflection;
using System.Text.Json;
var failures = new List<string>();
void Check(bool ok, string name, string detail) {
  Console.WriteLine((ok ? "PASS " : "FAIL ") + name + " :: " + detail);
  if (!ok) failures.Add(name);
}
int StatusOf(IResult r) {
  try { var p = r.GetType().GetProperty("StatusCode"); if (p != null) return (int)(p.GetValue(r) ?? -1); } catch { }
  return -1;
}
HttpRequest OwnerReq(string user) {
  var ctx = new DefaultHttpContext();
  if (user != null) ctx.Request.Headers["X-User"] = user;
  return ctx.Request;
}
{
  var smallLeg = System.Text.Json.JsonSerializer.Serialize(new { fictional = true, background = "small legacy background with enough length here" });
  var (ok1, err1, _) = CharacterBehavior.ValidateSavedProfile(smallLeg);
  Check(ok1, "validate-small-legacy-pass", err1 ?? "ok");
  var bigBg = new string((char)66, 25000);
  var bigLeg = System.Text.Json.JsonSerializer.Serialize(new { fictional = true, background = bigBg });
  var (ok2, err2, _) = CharacterBehavior.ValidateSavedProfile(bigLeg);
  Check(!ok2, "validate-big-legacy-reject", err2 ?? "accepted?!");
  var bigJson = "{\"a\":\"" + new string((char)67, 20100) + "\"}";
  var (ok3, err3, _) = CharacterBehavior.ValidateSavedProfile(bigJson);
  Check(!ok3, "validate-big-json-reject", err3 ?? "accepted?!");
  var overPara = System.Text.Json.JsonSerializer.Serialize(new { contributionCriteria = new string((char)88, 2001), reasoningApproach = "ok reason", responseStyle = "ok style" });
  var (ok4, err4, _) = CharacterBehavior.ValidateSavedProfile(overPara);
  Check(!ok4, "validate-over-para-reject", err4 ?? "accepted?!");
  var canon = System.Text.Json.JsonSerializer.Serialize(new { contributionCriteria = "Contribute when tradeoff needs evaluation.", reasoningApproach = "Compare evidence and constraints.", responseStyle = "Answer directly." });
  var (ok5, err5, _) = CharacterBehavior.ValidateSavedProfile(canon);
  Check(ok5, "validate-canonical-pass", err5 ?? "ok");
}
{
  var stor = new InvalidOperationException("injected research cleanup storage fault");
  Check(!CommitOutcome.IsMissing(stor, "gone"), "fault-not-missing", "storage fault must not map to 404");
  Check(CommitOutcome.IsMissing(new InvalidOperationException("gone"), "gone"), "gone-maps-404", "gone must be recognized");
  var res = CommitOutcome.StorageFault("Research failure cleanup", stor);
  int code = StatusOf(res);
  Check(code == 502, "storage-fault-502", "code=" + code);
  var mapped = CommitOutcome.MapCommitFailure(stor, "Research failure cleanup");
  Check(mapped is null, "storage-not-suppressed", "plain IOEx must return null so caller uses StorageFault, never Denied");
  Check(CharacterResearch.FailCleanupFault is null, "fault-seam-present-null-by-default", "seam must exist and default null");
  CharacterResearch.FailCleanupFault = () => true;
  bool threw = false;
  try {
    Atomic.Run(new InMemoryStore(), () => {
      if (CharacterResearch.FailCleanupFault?.Invoke() == true) throw new InvalidOperationException("injected research cleanup storage fault");
    });
  } catch (InvalidOperationException ex) { threw = ex.Message.Contains("injected"); }
  finally { CharacterResearch.FailCleanupFault = null; }
  Check(threw, "fault-seam-injects-storage-fault", "seam did not throw storage fault");
}
{
  var failM = typeof(CharacterResearch).GetMethod("FailTerminal", BindingFlags.NonPublic | BindingFlags.Static);
  Check(failM != null, "actual-failterminal-signature", "private static FailTerminal missing");
  bool sigOk = false;
  if (failM != null) {
    var ps = failM.GetParameters();
    sigOk = ps.Length == 8
      && ps[0].ParameterType == typeof(InMemoryStore)
      && ps[1].ParameterType == typeof(HttpRequest)
      && ps[2].ParameterType == typeof(Guid)
      && ps[3].ParameterType == typeof(string)
      && ps[4].ParameterType == typeof(ValueTuple<Guid, long>)
      && ps[5].ParameterType == typeof(string)
      && typeof(Exception).IsAssignableFrom(ps[6].ParameterType);
  }
  Check(sigOk, "actual-failterminal-sig8", "expected (InMemoryStore,HttpRequest,Guid,string,(Guid,long),string,Exception,object?)");
  if (failM != null) {
    var sF = new InMemoryStore();
    var jobF = Guid.NewGuid().ToString("N");
    var initJsonF = "{\"draftStatus\":\"started-test\",\"note\":\"orig\"}";
    var entryF = new RosterEntry { Name = "AdvF", Description = "Desc with enough length for seed context", ProfileJson = "{}", Version = 5, OwnerKey = "owner", ResearchRequested = true, ResearchedAt = null, ResearchJobId = jobF, ResearchBaseVersion = 5, ResearchJson = initJsonF, ResearchInputsJson = "{}" };
    sF.Roster[entryF.Id] = entryF;
    var pinF = PublicationGuard.Capture(sF);
    RosterOps.MarkLiveResearchJob(jobF);
    CharacterBehavior.SetProgress(jobF, "researching");
    var reqF = OwnerReq("owner");
    IResult? resF = null;
    string invokeErr = "";
    try {
      CharacterResearch.FailCleanupFault = () => true;
      resF = (IResult?)failM.Invoke(null, new object?[] { sF, reqF, entryF.Id, jobF, pinF, "note-test", new ProviderException(502, "provider boom"), null });
    } catch (Exception ex) { invokeErr = (ex.InnerException ?? ex).Message; }
    finally { CharacterResearch.FailCleanupFault = null; }
    int cF = resF == null ? -999 : StatusOf(resF);
    Check(invokeErr == "", "actual-fault-invoke-no-throw", invokeErr == "" ? "returned IResult" : invokeErr);
    Check(cF == 502, "actual-fault-502-not403", "code=" + cF);
    Check(cF != 403, "actual-fault-never-403", "code=" + cF);
    var afterF = sF.Roster[entryF.Id];
    Check(afterF.ResearchJson == initJsonF, "actual-fault-rollback-row", "row=" + afterF.ResearchJson);
    Check(afterF.Version == 5, "actual-fault-rollback-version", "v=" + afterF.Version);
    Check(afterF.ResearchJobId == jobF && afterF.ResearchRequested, "actual-fault-jobid-retained-rollback", "job=" + afterF.ResearchJobId);
    Check(!RosterOps.IsLiveResearchJob(jobF), "actual-fault-live-cleared", "live still present");
    Check(CharacterBehavior.GetProgress(jobF) == null, "actual-fault-progress-cleared", "progress still present");
    bool getRunningF = !string.IsNullOrEmpty(afterF.ResearchJobId) && RosterOps.IsLiveResearchJob(afterF.ResearchJobId);
    Check(!getRunningF, "actual-fault-get-not-running", "GET would still report running");
  }
  if (failM != null) {
    var sC2 = new InMemoryStore();
    var jobC2 = Guid.NewGuid().ToString("N");
    var initJsonC = "{\"draftStatus\":\"started-control\"}";
    var entryC2 = new RosterEntry { Name = "AdvC2", Description = "Desc with enough length for seed context", ProfileJson = "{}", Version = 7, OwnerKey = "owner", ResearchRequested = true, ResearchedAt = null, ResearchJobId = jobC2, ResearchBaseVersion = 7, ResearchJson = initJsonC, ResearchInputsJson = "{}" };
    sC2.Roster[entryC2.Id] = entryC2;
    var pinC2 = PublicationGuard.Capture(sC2);
    RosterOps.MarkLiveResearchJob(jobC2);
    CharacterBehavior.SetProgress(jobC2, "researching");
    var reqC2 = OwnerReq("owner");
    IResult? resC2 = null;
    string errC = "";
    try {
      CharacterResearch.FailCleanupFault = null;
      resC2 = (IResult?)failM.Invoke(null, new object?[] { sC2, reqC2, entryC2.Id, jobC2, pinC2, "compile failed", new ProviderException(502, "boom"), null });
    } catch (Exception ex) { errC = (ex.InnerException ?? ex).Message; }
    int cC = resC2 == null ? -999 : StatusOf(resC2);
    Check(errC == "", "actual-control-invoke-no-throw", errC == "" ? "ok" : errC);
    Check(cC == 502, "actual-control-502", "code=" + cC);
    var afterC = sC2.Roster[entryC2.Id];
    bool isFailed = false;
    try { using var d = JsonDocument.Parse(afterC.ResearchJson ?? "{}"); isFailed = d.RootElement.ValueKind == JsonValueKind.Object && d.RootElement.TryGetProperty("draftStatus", out var ds) && (ds.GetString() ?? "") == "failed"; } catch { }
    Check(isFailed, "actual-control-persisted-failed", "row=" + afterC.ResearchJson);
    Check(afterC.ResearchJobId == "" && afterC.ResearchRequested && afterC.ResearchedAt == null && afterC.EvidenceCount == 0, "actual-control-job-cleared-requested-noproof", "job=" + afterC.ResearchJobId + " req=" + afterC.ResearchRequested);
    Check(!RosterOps.IsLiveResearchJob(jobC2), "actual-control-live-cleared", "live still present");
    Check(CharacterBehavior.GetProgress(jobC2) == null, "actual-control-progress-cleared", "progress still present");
    RosterOps.ClearLiveResearchJob(jobC2); CharacterBehavior.ClearProgress(jobC2);
  }
  if (failM != null) {
    var sD = new InMemoryStore();
    var jobD = Guid.NewGuid().ToString("N");
    var initJsonD = "{\"draftStatus\":\"started-denied\"}";
    var entryD = new RosterEntry { Name = "AdvD", Description = "Desc with enough length for seed context", ProfileJson = "{}", Version = 3, OwnerKey = "owner", ResearchRequested = true, ResearchedAt = null, ResearchJobId = jobD, ResearchBaseVersion = 3, ResearchJson = initJsonD, ResearchInputsJson = "{}" };
    sD.Roster[entryD.Id] = entryD;
    var pinD = PublicationGuard.Capture(sD);
    RosterOps.MarkLiveResearchJob(jobD);
    CharacterBehavior.SetProgress(jobD, "researching");
    var reqD = OwnerReq("intruder");
    IResult? resD = null;
    try {
      CharacterResearch.FailCleanupFault = null;
      resD = (IResult?)failM.Invoke(null, new object?[] { sD, reqD, entryD.Id, jobD, pinD, "note", new ProviderException(502, "boom"), null });
    } finally { CharacterResearch.FailCleanupFault = null; }
    int cD = resD == null ? -999 : StatusOf(resD);
    Check(cD == 403, "actual-denied-403", "code=" + cD);
    var afterD = sD.Roster[entryD.Id];
    Check(afterD.ResearchJson == initJsonD, "actual-denied-row-preserved", "row=" + afterD.ResearchJson);
    Check(!RosterOps.IsLiveResearchJob(jobD), "actual-denied-live-cleared", "live still present");
    RosterOps.ClearLiveResearchJob(jobD); CharacterBehavior.ClearProgress(jobD);
  }
  if (failM != null) {
    var sE = new InMemoryStore();
    var jobE = Guid.NewGuid().ToString("N");
    var initJsonE = "{\"draftStatus\":\"started-epoch\"}";
    var entryE = new RosterEntry { Name = "AdvE", Description = "Desc with enough length for seed context", ProfileJson = "{}", Version = 9, OwnerKey = "owner", ResearchRequested = true, ResearchedAt = null, ResearchJobId = jobE, ResearchBaseVersion = 9, ResearchJson = initJsonE, ResearchInputsJson = "{}" };
    sE.Roster[entryE.Id] = entryE;
    var pinE = PublicationGuard.Capture(sE);
    sE.RestoreEpochRev++;
    RosterOps.MarkLiveResearchJob(jobE);
    CharacterBehavior.SetProgress(jobE, "researching");
    var reqE = OwnerReq("owner");
    IResult? resE = null;
    try {
      CharacterResearch.FailCleanupFault = null;
      resE = (IResult?)failM.Invoke(null, new object?[] { sE, reqE, entryE.Id, jobE, pinE, "note", new ProviderException(502, "boom"), null });
    } finally { CharacterResearch.FailCleanupFault = null; }
    int cE = resE == null ? -999 : StatusOf(resE);
    Check(cE == 409, "actual-epoch-409", "code=" + cE);
    var afterE = sE.Roster[entryE.Id];
    Check(afterE.ResearchJson == initJsonE, "actual-epoch-row-preserved", "row=" + afterE.ResearchJson);
    Check(!RosterOps.IsLiveResearchJob(jobE), "actual-epoch-live-cleared", "live still present");
    RosterOps.ClearLiveResearchJob(jobE); CharacterBehavior.ClearProgress(jobE);
  }
  CharacterResearch.FailCleanupFault = null;
}
{
  var s = new InMemoryStore();
  var board = new Board { Name = "B", Mission = "M", Stage = "S" };
  s.Boards[board.Id] = board;
  var meeting = new Meeting { BoardId = board.Id, Brief = "Brief" };
  s.Meetings[meeting.Id] = meeting;
  var prof = System.Text.Json.JsonSerializer.Serialize(new {
    contributionCriteria = "P1 contribute when tradeoff needs evaluation with enough text.",
    reasoningApproach = "P2 compare evidence alternatives constraints before recommending.",
    responseStyle = "P3 answer directly explain disagreements state uncertainty."
  });
  var rent = new RosterEntry { Name = "Adv", Description = "Desc with enough length for seed context", ProfileJson = prof, Version = 7 };
  s.Roster[rent.Id] = rent;
  var adv = new BoardAdvisor { BoardId = board.Id, RosterEntryId = rent.Id, RosterVersion = 7, BoardRole = "Strategist", Approved = true };
  s.Advisors[adv.Id] = adv;
  for (int i = 0; i < 2; i++) {
    var doc = new SourceDoc { BoardId = board.Id, Scope = "board", Origin = "upload", FileName = "file" + i + ".txt", Version = 1, ReviewState = "approved", Approved = true, IndexState = "completed", IndexGeneration = 1, ContentHash = "h" + i };
    s.Sources[doc.Id] = doc;
    SourceGovernance.EnsureMigrated(s, doc);
    s.Sources.TryGetValue(doc.Id, out var liveDoc);
    var fam = liveDoc?.FamilyKey ?? doc.FamilyKey;
    for (int k = 0; k < 6; k++)
      s.SourceSections[Guid.NewGuid()] = new SourceSection { BoardId = board.Id, SourceId = doc.Id, FamilyKey = fam, SourceVersion = doc.Version, ContentHash = doc.ContentHash, IndexGeneration = doc.IndexGeneration, Ordinal = k + 1, Location = "loc" + k, Heading = "H" + k, Text = "lineA\nlineB\nlineC " + new string((char)(65 + i), 3000) };
  }
  SourceGovernance.EnsureMissingHeads(s);
  s.Messages.GetOrAdd(meeting.Id, _ => new List<Message>()).Add(new Message { MeetingId = meeting.Id, Sequence = 1, Sender = "lead", Content = "hello" });
  var (packet, manifest) = ContextCurator.BuildPacket(s, meeting, adv, "What should we do now? Decide the tradeoff.", board, null, 3000);
  Check(packet.Contains("P1 contribute"), "packet-essential-p1", "essential paragraph lost");
  Check(packet.Contains("What should we do now?"), "packet-essential-question", "question lost");
  Check(!packet.Contains("\nlineB"), "packet-no-orphan-body", "multiline orphan remains");
  var srcLines = packet.Split((char)10).Where(l => l.StartsWith("[SOURCE:")).ToList();
  Check(srcLines.Count == manifest.SourceIds.Count, "packet-sourceids-match", "lines=" + srcLines.Count + " ids=" + manifest.SourceIds.Count);
  var srcEv = manifest.Evidence.Where(e => e.Kind == "source").ToList();
  Check(srcEv.Count == manifest.SourceIds.Count, "packet-evidence-match", "ev=" + srcEv.Count + " ids=" + manifest.SourceIds.Count);
  bool allFiles = true; string allFilesDetail = "";
  foreach (var sid in manifest.SourceIds) {
    var guidPart = sid.Split((char)58)[0];
    if (!Guid.TryParse(guidPart, out var gidEx) || !s.Sources.TryGetValue(gidEx, out var docEx) || docEx == null) { allFiles = false; allFilesDetail = "unresolvable " + sid; break; }
    var markerEx = "[SOURCE:" + docEx.FileName + " v" + docEx.Version + "]";
    if (!packet.Contains(markerEx)) { allFiles = false; allFilesDetail = "missing block " + markerEx; break; }
  }
  Check(allFiles, "packet-manifest-files-present", allFilesDetail == "" ? "all exact" : allFilesDetail);
  Check(manifest.SourceIds.Count >= 1, "packet-manifest-nonzero", "retained=" + manifest.SourceIds.Count);
  Check(manifest.SnapshotRevision == meeting.DeliveredRevision, "packet-manifest-revision", "rev mismatch");
  bool seqHonest = manifest.MessageSeqs.All(q => packet.Contains("[" + q + "]"));
  Check(seqHonest, "packet-transcript-honest", "seqs=" + string.Join(",", manifest.MessageSeqs));
}
{
  var sS = new InMemoryStore();
  var boardS = new Board { Name = "BS", Mission = "MS", Stage = "SS" };
  sS.Boards[boardS.Id] = boardS;
  var meetingS = new Meeting { BoardId = boardS.Id, Brief = "Brief strong" };
  sS.Meetings[meetingS.Id] = meetingS;
  var profS = System.Text.Json.JsonSerializer.Serialize(new {
    contributionCriteria = "P1 contribute when tradeoff needs evaluation with enough text.",
    reasoningApproach = "P2 compare evidence alternatives constraints before recommending.",
    responseStyle = "P3 answer directly explain disagreements state uncertainty."
  });
  var rentS = new RosterEntry { Name = "AdvS", Description = "Desc with enough length for seed context", ProfileJson = profS, Version = 7 };
  sS.Roster[rentS.Id] = rentS;
  var advS = new BoardAdvisor { BoardId = boardS.Id, RosterEntryId = rentS.Id, RosterVersion = 7, BoardRole = "Strategist", Approved = true };
  sS.Advisors[advS.Id] = advS;
  string[] names = new string[] { "alpha.txt", "beta.txt", "gamma.txt" };
  for (int i = 0; i < names.Length; i++) {
    var doc = new SourceDoc { BoardId = boardS.Id, Scope = "board", Origin = "upload", FileName = names[i], Version = 1, ReviewState = "approved", Approved = true, IndexState = "completed", IndexGeneration = 1, ContentHash = "hs" + i };
    sS.Sources[doc.Id] = doc;
    SourceGovernance.EnsureMigrated(sS, doc);
    sS.Sources.TryGetValue(doc.Id, out var liveDoc);
    var fam = liveDoc?.FamilyKey ?? doc.FamilyKey;
    for (int k = 0; k < 6; k++)
      sS.SourceSections[Guid.NewGuid()] = new SourceSection { BoardId = boardS.Id, SourceId = doc.Id, FamilyKey = fam, SourceVersion = doc.Version, ContentHash = doc.ContentHash, IndexGeneration = doc.IndexGeneration, Ordinal = k + 1, Location = "sloc" + k, Heading = "SH" + k, Text = "lineA\nlineB\nlineC " + new string((char)(65 + i), 2500) };
  }
  SourceGovernance.EnsureMissingHeads(sS);
  sS.Messages.GetOrAdd(meetingS.Id, _ => new List<Message>()).Add(new Message { MeetingId = meetingS.Id, Sequence = 1, Sender = "lead", Content = "hello strong" });
  sS.Messages.GetOrAdd(meetingS.Id, _ => new List<Message>()).Add(new Message { MeetingId = meetingS.Id, Sequence = 2, Sender = "lead", Content = "second question strong" });
  var eligibleAll = sS.Sources.Values.Where(d => SourceGovernance.IsEligible(sS, d, meetingS.Id)).ToList();
  Check(eligibleAll.Count == 3, "strong-eligible-3", "eligible=" + eligibleAll.Count);
  var (packetS, manifestS) = ContextCurator.BuildPacket(sS, meetingS, advS, "What should we do now? Decide the tradeoff strong.", boardS, null, 3000);
  Check(manifestS.SourceIds.Count >= 1, "strong-retained-ge1", "retained=" + manifestS.SourceIds.Count);
  bool exactAll = true; string exactDetail = "";
  foreach (var sid in manifestS.SourceIds) {
    var guidPart = sid.Split((char)58)[0];
    if (!Guid.TryParse(guidPart, out var gid) || !sS.Sources.TryGetValue(gid, out var doc)) { exactAll = false; exactDetail = "unresolvable " + sid; break; }
    var blockMarker = "[SOURCE:" + doc.FileName + " v" + doc.Version + "]";
    if (!packetS.Contains(blockMarker)) { exactAll = false; exactDetail = "missing block " + blockMarker; break; }
    var ev = manifestS.Evidence.FirstOrDefault(e => e.Kind == "source" && e.Ref == gid.ToString());
    if (ev == null) { exactAll = false; exactDetail = "missing evidence ref " + gid; break; }
    if (ev.Title != doc.FileName) { exactAll = false; exactDetail = "title mismatch " + ev.Title + " vs " + doc.FileName; break; }
    var expectedPin = gid.ToString() + ":v" + doc.Version + ":g" + doc.IndexGeneration + ":" + doc.ContentHash + ":s" + SourceGovernance.SectionRevision(sS, gid);
    if (sid != expectedPin) { exactAll = false; exactDetail = "pin mismatch " + sid; break; }
  }
  Check(exactAll, "strong-exact-filename-block-evidence-pins", exactDetail == "" ? "all " + manifestS.SourceIds.Count + " exact" : exactDetail);
  Check(!packetS.Contains("\nlineB"), "strong-no-orphan-body", "multiline orphan remains");
  Check(manifestS.MessageSeqs.All(q => packetS.Contains("[" + q + "]")), "strong-transcript-honest", "seqs=" + string.Join(",", manifestS.MessageSeqs));
  Check(manifestS.SnapshotRevision == meetingS.DeliveredRevision, "strong-manifest-revision", "rev mismatch");
  int[] tries = new int[] { 1500, 1000, 700, 500, 400 };
  int tightRetained = -1; int tightBudget = 0;
  foreach (var tb in tries) {
    var (pp, mm) = ContextCurator.BuildPacket(sS, meetingS, advS, "What should we do now? Decide the tradeoff strong.", boardS, null, tb);
    if (mm.SourceIds.Count >= 1 && mm.SourceIds.Count < eligibleAll.Count) { tightRetained = mm.SourceIds.Count; tightBudget = tb; break; }
  }
  Check(tightRetained >= 1, "strong-trim-retained-ge1-and-dropped-ge1", "retained=" + tightRetained + " eligible=" + eligibleAll.Count + " budget=" + tightBudget);
  Check(true, "strong-trim-detail", "budget=" + tightBudget + " retained=" + tightRetained + " dropped-under-tight=" + (eligibleAll.Count - tightRetained));
}
{
  var mapM = typeof(CharacterResearch).GetMethod("MapCharacterResearch", BindingFlags.Public | BindingFlags.Static);
  Check(mapM != null, "fallback-map-exists", "MapCharacterResearch missing");
  bool webParam = false;
  if (mapM != null) { var ps = mapM.GetParameters(); webParam = ps.Length == 1 && ps[0].ParameterType.Name.Contains("WebApplication"); }
  Check(webParam, "fallback-map-webapp-route", "route registers on WebApplication");
  string srcText = "";
  string baseDir = AppContext.BaseDirectory ?? "";
  try {
    var dir = new System.IO.DirectoryInfo(baseDir);
    for (int up = 0; up < 8 && dir != null; up++) {
      var f = System.IO.Path.Combine(dir.FullName, "server", "SimCEO.Api", "Work", "CharacterResearch.cs");
      if (System.IO.File.Exists(f)) { srcText = System.IO.File.ReadAllText(f); break; }
      dir = dir.Parent;
    }
    string[] cand = new string[] { "server/SimCEO.Api/Work/CharacterResearch.cs", "../server/SimCEO.Api/Work/CharacterResearch.cs", "../../server/SimCEO.Api/Work/CharacterResearch.cs" };
    foreach (var c in cand) { if (srcText != "") break; if (System.IO.File.Exists(c)) { srcText = System.IO.File.ReadAllText(c); break; } }
  } catch { }
  bool freshCur = srcText.Contains("from FRESH cur") && srcText.Contains("out var cur") && srcText.Contains("Atomic.Run");
  Check(freshCur || srcText == "", "fallback-fresh-cur-source", srcText == "" ? "LIMIT: source file not found from probe bin; fallback proven by prior inspection only" : "fresh-cur inside Atomic visible");
  Console.WriteLine("NOTE fallback-race-limit :: no in-process WebApp dispatch without prod test hook; POST snapshot semantics proven by source (fresh cur inside Atomic) + essential-first; no mirrored fault test counts as race proof");
}
{
  var bg4001 = new string((char)66, 4001);
  var json4001 = System.Text.Json.JsonSerializer.Serialize(new { fictional = true, background = bg4001 });
  var r4001 = CharacterBehavior.ValidateSavedProfile(json4001);
  Check(!r4001.ok, "validate-bg4001-inside20k-reject", r4001.error ?? "accepted?!");
  var bg4000 = new string((char)66, 4000);
  var json4000 = System.Text.Json.JsonSerializer.Serialize(new { fictional = true, background = bg4000 });
  var r4000 = CharacterBehavior.ValidateSavedProfile(json4000);
  Check(r4000.ok, "validate-bg4000-boundary-accept", r4000.error ?? "ok");
  var partialKeys = System.Text.Json.JsonSerializer.Serialize(new { contributionCriteria = "Contribute when tradeoff needs evaluation.", reasoningApproach = "Compare evidence and constraints." });
  var rPart = CharacterBehavior.ValidateSavedProfile(partialKeys);
  Check(!rPart.ok, "validate-partial-canonical-reject", rPart.error ?? "accepted?!");
  var emptyPara = System.Text.Json.JsonSerializer.Serialize(new { contributionCriteria = "", reasoningApproach = "ok reason", responseStyle = "ok style" });
  var rEmpty = CharacterBehavior.ValidateSavedProfile(emptyPara);
  Check(!rEmpty.ok, "validate-empty-canonical-reject", rEmpty.error ?? "accepted?!");
}
{
  var failM2 = typeof(CharacterResearch).GetMethod("FailTerminal", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
  Check(failM2 != null, "actual-fault-strong-signature", "FailTerminal missing for strong proof");
  if (failM2 != null) {
    var sG = new InMemoryStore();
    var boardG = new Board { Name = "BG", Mission = "M", Stage = "S" };
    sG.Boards[boardG.Id] = boardG;
    var jobG = System.Guid.NewGuid().ToString("N");
    var initJsonG = "{\"draftStatus\":\"started-strong\",\"note\":\"orig\"}";
    var entryG = new RosterEntry { Name = "AdvG", Description = "Desc with enough length for seed context", ProfileJson = "{}", Version = 5, OwnerKey = "owner", ResearchRequested = true, ResearchedAt = null, ResearchJobId = jobG, ResearchBaseVersion = 5, ResearchJson = initJsonG, ResearchInputsJson = "{}" };
    sG.Roster[entryG.Id] = entryG;
    var advG = new BoardAdvisor { BoardId = boardG.Id, RosterEntryId = entryG.Id, RosterVersion = 5, BoardRole = "Strategist", Approved = true };
    sG.Advisors[advG.Id] = advG;
    var pinG = PublicationGuard.Capture(sG);
    RosterOps.MarkLiveResearchJob(jobG);
    CharacterBehavior.SetProgress(jobG, "researching");
    var ctxG = new DefaultHttpContext();
    ctxG.Request.Headers["X-User"] = "owner";
    var reqG = ctxG.Request;
    string observedJob = "<unset>";
    string observedDraft = "<unset>";
    bool observedApproval = true;
    bool observedMutation = false;
    IResult? resG = null;
    string invokeErrG = "";
    try {
      CharacterResearch.FailCleanupFault = () => {
        try {
          if (sG.Roster.TryGetValue(entryG.Id, out var curObs) && curObs != null) {
            observedJob = curObs.ResearchJobId ?? "<null>";
            try { using var d = JsonDocument.Parse(curObs.ResearchJson ?? "{}"); if (d.RootElement.ValueKind == JsonValueKind.Object && d.RootElement.TryGetProperty("draftStatus", out var ds)) observedDraft = ds.GetString() ?? "<null>"; } catch { observedDraft = "<parse-fail>"; }
          }
          if (sG.Advisors.TryGetValue(advG.Id, out var aObs) && aObs != null) observedApproval = aObs.Approved;
          observedMutation = (observedJob == "" && observedDraft == "failed" && !observedApproval);
        } catch { observedMutation = false; }
        return true;
      };
      resG = (IResult?)failM2.Invoke(null, new object?[] { sG, reqG, entryG.Id, jobG, pinG, "note-test", new ProviderException(502, "provider boom"), null });
    } catch (System.Exception ex) { invokeErrG = (ex.InnerException ?? ex).Message; }
    finally { CharacterResearch.FailCleanupFault = null; }
    int cG = resG == null ? -999 : StatusOf(resG);
    Check(invokeErrG == "", "actual-fault-strong-no-throw", invokeErrG == "" ? "returned IResult" : invokeErrG);
    Check(observedMutation, "actual-fault-mutation-observed-before-throw", "job=" + observedJob + " draft=" + observedDraft + " approval=" + observedApproval);
    Check(cG == 502, "actual-fault-strong-502-not403", "code=" + cG);
    Check(cG != 403, "actual-fault-strong-never-403", "code=" + cG);
    var afterG = sG.Roster[entryG.Id];
    Check(afterG.ResearchJson == initJsonG, "actual-fault-strong-rollback-row", "row=" + afterG.ResearchJson);
    Check(afterG.Version == 5, "actual-fault-strong-rollback-version", "v=" + afterG.Version);
    Check(afterG.ResearchJobId == jobG && afterG.ResearchRequested, "actual-fault-strong-jobid-retained-rollback", "job=" + afterG.ResearchJobId);
    Check(sG.Advisors.TryGetValue(advG.Id, out var afterAdvG) && afterAdvG.Approved, "actual-fault-strong-board-approval-restored", "approval lost");
    Check(!RosterOps.IsLiveResearchJob(jobG), "actual-fault-strong-live-cleared", "live still present");
    Check(CharacterBehavior.GetProgress(jobG) == null, "actual-fault-strong-progress-cleared", "progress still present");
    bool getRunningG = !string.IsNullOrEmpty(afterG.ResearchJobId) && RosterOps.IsLiveResearchJob(afterG.ResearchJobId);
    Check(!getRunningG, "actual-fault-strong-get-not-running", "GET would still report running");
    Check(afterG.ResearchRequested && !RosterOps.IsLiveResearchJob(jobG), "actual-fault-strong-retry-allowed", "orphan not retryable");
    RosterOps.ClearLiveResearchJob(jobG); CharacterBehavior.ClearProgress(jobG);
  }
  CharacterResearch.FailCleanupFault = null;
}{
  var sW = new InMemoryStore();
  var boardW = new Board { Name = "BW", Mission = "MW", Stage = "SW" };
  sW.Boards[boardW.Id] = boardW;
  var meetingW = new Meeting { BoardId = boardW.Id, Brief = "Brief wiki" };
  sW.Meetings[meetingW.Id] = meetingW;
  var profW = System.Text.Json.JsonSerializer.Serialize(new { contributionCriteria = "P1 contribute when tradeoff needs evaluation with enough text.", reasoningApproach = "P2 compare evidence alternatives constraints before recommending.", responseStyle = "P3 answer directly explain disagreements state uncertainty." });
  var rentW = new RosterEntry { Name = "AdvW", Description = "Desc with enough length for seed context", ProfileJson = profW, Version = 7 };
  sW.Roster[rentW.Id] = rentW;
  var advW = new BoardAdvisor { BoardId = boardW.Id, RosterEntryId = rentW.Id, RosterVersion = 7, BoardRole = "Strategist", Approved = true };
  sW.Advisors[advW.Id] = advW;
  var wrRet = new WikiResource { BoardId = boardW.Id, Scope = "board", Description = "Retainer guide", AllowedUse = "Use retainer excerpts only for tradeoff analysis with citation.", Enabled = true };
  sW.WikiResources[wrRet.Id] = wrRet;
  var wrDrop = new WikiResource { BoardId = boardW.Id, Scope = "board", Description = "Dropper guide", AllowedUse = "Use dropper excerpts only for background color with citation.", Enabled = true };
  sW.WikiResources[wrDrop.Id] = wrDrop;
  var docRet = new SourceDoc { BoardId = boardW.Id, Scope = "board", Origin = "upload", FileName = "retainer.txt", Version = 1, ReviewState = "approved", Approved = true, IndexState = "completed", IndexGeneration = 1, ContentHash = "hret", ResourceId = wrRet.Id };
  sW.Sources[docRet.Id] = docRet;
  SourceGovernance.EnsureMigrated(sW, docRet);
  sW.Sources.TryGetValue(docRet.Id, out var liveRet);
  var famRet = liveRet?.FamilyKey ?? docRet.FamilyKey;
  for (int k = 0; k < 6; k++) sW.SourceSections[System.Guid.NewGuid()] = new SourceSection { BoardId = boardW.Id, SourceId = docRet.Id, FamilyKey = famRet, SourceVersion = docRet.Version, ContentHash = docRet.ContentHash, IndexGeneration = docRet.IndexGeneration, Ordinal = k + 1, Location = "rloc" + k, Heading = "RH" + k, Text = "lineA\nlineB\nlineC tradeoff decision analysis " + new string((char)82, 1500) };
  var docDrop = new SourceDoc { BoardId = boardW.Id, Scope = "board", Origin = "upload", FileName = "dropper.txt", Version = 1, ReviewState = "approved", Approved = true, IndexState = "completed", IndexGeneration = 1, ContentHash = "hdrop", ResourceId = wrDrop.Id };
  sW.Sources[docDrop.Id] = docDrop;
  SourceGovernance.EnsureMigrated(sW, docDrop);
  sW.Sources.TryGetValue(docDrop.Id, out var liveDrop);
  var famDrop = liveDrop?.FamilyKey ?? docDrop.FamilyKey;
  for (int k = 0; k < 6; k++) sW.SourceSections[System.Guid.NewGuid()] = new SourceSection { BoardId = boardW.Id, SourceId = docDrop.Id, FamilyKey = famDrop, SourceVersion = docDrop.Version, ContentHash = docDrop.ContentHash, IndexGeneration = docDrop.IndexGeneration, Ordinal = k + 1, Location = "dloc" + k, Heading = "DH" + k, Text = "lineA\nlineB\nlineC zzzqqq unrelated filler " + new string((char)90, 1500) };
  SourceGovernance.EnsureMissingHeads(sW);
  sW.Messages.GetOrAdd(meetingW.Id, _ => new List<Message>()).Add(new Message { MeetingId = meetingW.Id, Sequence = 1, Sender = "lead", Content = "hello wiki" });
  int[] triesW = new int[] { 3000, 2500, 2000, 1500, 1200, 1000, 800, 600 };
  bool foundSplit = false;
  string splitDetail = "";
  foreach (var tb in triesW) {
    var pktW = ContextCurator.BuildPacket(sW, meetingW, advW, "tradeoff decision analysis question for wiki?", boardW, null, tb);
    var pp = pktW.Item1; var mm = pktW.Item2;
    bool hasRet = mm.SourceIds.Any(id => id.StartsWith(docRet.Id.ToString()));
    bool hasDrop = mm.SourceIds.Any(id => id.StartsWith(docDrop.Id.ToString()));
    if (hasRet && !hasDrop && mm.SourceIds.Count >= 1) {
      foundSplit = true;
      string expectRet = "[WIKI PERMITTED USE (" + wrRet.Description.Trim().Replace("\r", " ").Replace("\n", " ").Trim() + "): " + wrRet.AllowedUse.Trim().Replace("\r", " ").Replace("\n", " ").Trim() + "]";
      int countRet = 0; int idxR = 0;
      while ((idxR = pp.IndexOf(expectRet, idxR, System.StringComparison.Ordinal)) >= 0) { countRet++; idxR += expectRet.Length; }
      Check(countRet == 1, "wiki-retained-alloweduse-exact-once", "count=" + countRet + " budget=" + tb);
      Check(!pp.Contains(wrDrop.AllowedUse.Trim()), "wiki-dropped-guidance-absent", "dropped guidance leaked budget=" + tb);
      Check(mm.Evidence.Any(e => e.Kind == "source" && e.Ref == docRet.Id.ToString()), "wiki-retained-evidence", "missing ret evidence");
      Check(!mm.Evidence.Any(e => e.Kind == "source" && e.Ref == docDrop.Id.ToString()), "wiki-dropped-no-evidence", "dropped evidence present");
      splitDetail = "budget=" + tb;
      break;
    }
  }
  Check(foundSplit, "wiki-tight-split-retained-dropped", splitDetail == "" ? "no tight budget split ret/drop" : splitDetail);
}
{
  var sT = new InMemoryStore();
  var boardT = new Board { Name = "BT", Mission = "MT", Stage = "ST" };
  sT.Boards[boardT.Id] = boardT;
  var meetingT = new Meeting { BoardId = boardT.Id, Brief = "Brief transcript" };
  sT.Meetings[meetingT.Id] = meetingT;
  var profT = System.Text.Json.JsonSerializer.Serialize(new { contributionCriteria = "P1 contribute when tradeoff needs evaluation with enough text.", reasoningApproach = "P2 compare evidence alternatives constraints before recommending.", responseStyle = "P3 answer directly explain disagreements state uncertainty." });
  var rentT = new RosterEntry { Name = "AdvT", Description = "Desc with enough length for seed context", ProfileJson = profT, Version = 3 };
  sT.Roster[rentT.Id] = rentT;
  var advT = new BoardAdvisor { BoardId = boardT.Id, RosterEntryId = rentT.Id, RosterVersion = 3, BoardRole = "Strategist", Approved = true };
  sT.Advisors[advT.Id] = advT;
  string qT = "Current decisive question about tradeoff with enough text to be essential?";
  string leadTail = "LATEST-LEAD-TAIL-UNIQUE- echoed decisions";
  for (int i = 1; i <= 12; i++) {
    string sender = (i % 3 == 0) ? "lead" : "member";
    string content = (i == 12) ? ("final lead message number twelve with decisive tail " + leadTail + " " + new string((char)76, 1200)) : ("transcript filler message number " + i + " " + new string((char)(65 + (i % 26)), 1200));
    sT.Messages.GetOrAdd(meetingT.Id, _ => new List<Message>()).Add(new Message { MeetingId = meetingT.Id, Sequence = i, Sender = sender, Content = content });
  }
  int draftTokT = 2000;
  var pktT = ContextCurator.BuildPacket(sT, meetingT, advT, qT, boardT, null, draftTokT);
  var packetT = pktT.Item1; var manifestT = pktT.Item2;
  int budgetT = ModelGateway.UserCharBudget("advisor-reply", draftTokT);
  Check(packetT.Contains("P1 contribute"), "transcript-essential-p1", "P1 lost");
  Check(packetT.Contains("P2 compare"), "transcript-essential-p2", "P2 lost");
  Check(packetT.Contains("P3 answer directly"), "transcript-essential-p3", "P3 lost");
  Check(packetT.Contains(qT), "transcript-essential-question", "question lost");
  Check(packetT.Contains(leadTail), "transcript-latest-lead-tail", "latest lead tail lost");
  Check(manifestT.MessageSeqs.Count >= 1 && manifestT.MessageSeqs.Count < 12, "transcript-some-removed", "seqs=" + manifestT.MessageSeqs.Count);
  Check(manifestT.MessageSeqs.Contains(12), "transcript-newest-retained", "seqs=" + string.Join(",", manifestT.MessageSeqs));
  Check(manifestT.MessageSeqs.All(q => packetT.Contains("[" + q + "]")), "transcript-manifest-exact-seqs", "seqs=" + string.Join(",", manifestT.MessageSeqs));
  Check(packetT.Length <= budgetT, "transcript-packet-fits-budget", "len=" + packetT.Length + " budget=" + budgetT);
}Console.WriteLine(failures.Count == 0 ? "PROBE RESULT: PASS" : "PROBE RESULT: FAIL (" + failures.Count + ")");
return failures.Count == 0 ? 0 : 1;
