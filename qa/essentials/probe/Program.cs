// QA-owned selftest diagnostic probe (Muse-authored, read-only).
// Replicates the frozen --selftest activate block against the ACTUAL
// server code and prints the exact failing conditional (hasLead,
// per-advisor ApprovalGate, canonical hash equality, actErr/actSt).
// No production writes, no fixture changes, no server edits.
using SimCEO.Api;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

var store = new InMemoryStore();
var board = new Board { Id = Guid.NewGuid(), Name = "T1", CreatedAt = DateTime.UtcNow };
store.Boards[board.Id] = board;
var rosterId = Guid.NewGuid();
store.Roster[rosterId] = new RosterEntry { Id = rosterId, AccountId = Guid.NewGuid(), Name = "R" };
for (var i = 0; i < 10; i++)
  store.Advisors[Guid.NewGuid()] = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = board.Id, RosterEntryId = Guid.NewGuid() };
Console.WriteLine("advisor-count=" + store.Advisors.Values.Count(a => a.BoardId == board.Id && !a.Removed));

var (lead1, err1, st1) = LeadSetup.SaveLead(store, board.Id, new LeadProfile { Name = "Ada", RoleLabel = "CEO" });
Console.WriteLine("lead-save-v1 st=" + st1 + " err=" + err1 + " ver=" + lead1?.Version + " boardLeadVer=" + board.LeadProfileVersion);
Console.WriteLine("ref-after-saveV1=" + ReferenceEquals(board, store.Boards[board.Id]));
var (lead2, _, _) = LeadSetup.SaveLead(store, board.Id, new LeadProfile { Version = 1, Name = "Ada Lovelace" });
Console.WriteLine("lead-save-v2 ver=" + lead2?.Version);
foreach (var bl in store.LeadProfiles.Values.Where(l => l.BoardId == board.Id).ToList()) bl.UpdatedAt = DateTime.UtcNow.AddHours(-1);
var (g1, ge1, gs1) = LeadSetup.SaveLead(store, Guid.Empty, new LeadProfile { Name = "G" });
Console.WriteLine("lead-global-v1 st=" + gs1 + " err=" + ge1);
Console.WriteLine("ref-after-global=" + ReferenceEquals(board, store.Boards[board.Id]));
var (noBoard, _, noBoardSt) = LeadSetup.Activate(store, board.Id, null);
Console.WriteLine("activate-null-hash st=" + noBoardSt + " null=" + (noBoard is null));
Console.WriteLine("ref-after-nullactivate=" + ReferenceEquals(board, store.Boards[board.Id]));

var actEntry = new RosterEntry { Id = Guid.NewGuid(), AccountId = Guid.NewGuid(), Name = "Selftest", Description = "selftest advisor entry", ProfileJson = "a sufficiently long selftest profile json", Version = 1, UpdatedAt = DateTime.UtcNow };
store.Roster[actEntry.Id] = actEntry;
store.Images[Guid.NewGuid()] = new AdvisorImage { RosterEntryId = actEntry.Id, Kind = "upload", Review = "accepted", Provenance = "selftest", ContentType = "image/png", Data = new byte[] { 9 } };
var actAdv = store.Advisors.Values.First(a => a.BoardId == board.Id);
actAdv.RosterEntryId = actEntry.Id;
actAdv.RosterVersion = actEntry.Version;
actAdv.BoardRole = "Selftest Role";
actAdv.Approved = true;
board.DraftJson = """{"name":"T1"}""";

var strictLead = LeadSetup.ResolveLeadForStrict(store, board.Id);
Console.WriteLine("strict-lead-board=" + (strictLead is null ? "null" : strictLead.Name + " v" + strictLead.Version));
Console.WriteLine("inherits-global=" + LeadSetup.InheritsGlobalLead(store, board));
var effLead = LeadSetup.ResolveLeadForBoard(store, board);
Console.WriteLine("effective-lead=" + (effLead is null ? "null" : effLead.Name + " board=" + effLead.BoardId));
var gates = store.Advisors.Values.Where(a => a.BoardId == board.Id && !a.Removed).Select(a => new { role = a.BoardRole, approved = a.Approved, gate = RosterOps.ApprovalGate(store, a) }).ToList();
foreach (var g in gates) Console.WriteLine("advisor role=" + g.role + " approved=" + g.approved + " gate=" + (g.gate ?? "null"));
Console.WriteLine("eligible-approved=" + store.Advisors.Values.Count(a => a.BoardId == board.Id && !a.Removed && a.Approved && RosterOps.ApprovalGate(store, a) is null));
var canon = LeadSetup.CanonicalDraftJson(store, board);
var wantHash = Hashing.HashOf(canon);
Console.WriteLine("wantHash=" + wantHash);
Console.WriteLine("canon-bytes=" + canon.Length);
var (activated, actErr, actSt) = LeadSetup.Activate(store, board.Id, wantHash);
Console.WriteLine("activate st=" + actSt + " err=" + actErr + " active=" + board.ActiveConfig + " null=" + (activated is null));
var live = store.Boards[board.Id];
Console.WriteLine("live-active=" + live.ActiveConfig + " ref-eq=" + ReferenceEquals(board, live) + " returned-ref-eq=" + ReferenceEquals(activated, live) + " activejson-len=" + (live.ActiveJson?.Length ?? -1));
var canon2 = LeadSetup.CanonicalDraftJson(store, board);
Console.WriteLine("canon-stable=" + string.Equals(canon, canon2, StringComparison.Ordinal) + " hash2=" + Hashing.HashOf(canon2));
var (rehash, rehashErr, rehashSt) = LeadSetup.Activate(store, board.Id, "deadbeefdeadbeef");
Console.WriteLine("rehash st=" + rehashSt + " err=" + rehashErr + " null=" + (rehash is null));
return (activated is null || actErr is not null || actSt != 200 || !board.ActiveConfig) ? 1 : 0;