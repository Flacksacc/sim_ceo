using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// Reviewable, idempotent reconciliation / migration for legacy board-advisor
// orphans. Builds a dry-run report + backup snapshot WITHOUT writing live
// user data. The primary executes the production migration (see
// docs/roster-integrity-integration.md). Re-running Plan on unchanged state
// yields the identical PlanHash (idempotent); Apply refuses to run twice for
// the same IdempotencyKey unless the plan hash matches.
public static class RosterReconciliation
{
  public const string EngineVersion = "roster-reconcile/1";

  public sealed record OrphanAdvisor(
    Guid AdvisorId, Guid BoardId, string BoardName,
    Guid RosterEntryId, string BoardRole, bool Approved, bool Removed,
    string Reason, string Detail);

  // Mutation is the typed deterministic full-mutation-input snapshot: the ONLY
  // authoritative plan-hash input for the action. Summary/Evidence are human
  // preview strings and are never hashed. Full IDs, actual entry fields, all
  // historical links plus board ownership, exact history row identities, and
  // account/provenance inputs; lists sorted (or in Apply consumption order).
  public sealed record ReconcileAction(
    string Kind, Guid AdvisorId, Guid BoardId, Guid RosterEntryId,
    string Summary, string Evidence, string Mutation);

  public sealed record ReconcileReport(
    string Engine, string PlanHash, string IdempotencyKey,
    DateTime GeneratedAt, List<OrphanAdvisor> Orphans,
    List<ReconcileAction> Actions, List<string> Warnings,
    string BackupJson, bool Applied);

  public static string NormalizeName(string name) =>
    (name ?? "").Trim().ToLowerInvariant();

  public static string ContentHash(string s)
  {
    try { return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s ?? ""))).ToLowerInvariant()[..16]; }
    catch { return "hash-error"; }
  }

  // Ownership evidence: the stable account/owner key that authorizes a merge.
  // NEVER merge across different non-empty owner keys on name match alone.
  public static string OwnershipOf(RosterEntry e) =>
    string.IsNullOrWhiteSpace(e.OwnerKey) ? "ownerless:" + e.AccountId : "owner:" + e.OwnerKey.Trim().ToLowerInvariant();

  // Scan legacy orphans + integrity violations (read-only). Optional scopeBoardId
  // limits the scan to one board; null scans every board.
  public static List<OrphanAdvisor> Scan(InMemoryStore s, Guid? scopeBoardId = null)
  {
    var out_ = new List<OrphanAdvisor>();
    string BoardName(Guid bid) =>
      s.Boards.TryGetValue(bid, out var b) && b is not null ? b.Name : "?";
    foreach (var a in s.Advisors.Values.Where(a => !scopeBoardId.HasValue || a.BoardId == scopeBoardId.Value).OrderBy(a => a.BoardId).ThenBy(a => a.Id))
    {
      if (a.Removed) continue;
      if (a.RosterEntryId == Guid.Empty)
      {
        out_.Add(new OrphanAdvisor(a.Id, a.BoardId, BoardName(a.BoardId),
          a.RosterEntryId, a.BoardRole ?? "", a.Approved, a.Removed,
          "empty-link", "Board advisor has no roster link; identity unknown, never auto-grouped or merged."));
        continue;
      }
      if (!s.Roster.TryGetValue(a.RosterEntryId, out var rent) || rent is null)
      {
        out_.Add(new OrphanAdvisor(a.Id, a.BoardId, BoardName(a.BoardId),
          a.RosterEntryId, a.BoardRole ?? "", a.Approved, a.Removed,
          "missing-roster", "Board advisor links a roster entry that no longer exists."));
        continue;
      }
      if (rent.Archived)
      {
        out_.Add(new OrphanAdvisor(a.Id, a.BoardId, BoardName(a.BoardId),
          a.RosterEntryId, a.BoardRole ?? "", a.Approved, a.Removed,
          "archived-roster", "Linked roster entry is archived; unarchive or relink before use."));
        continue;
      }
      if (a.RosterVersion != rent.Version)
      {
        out_.Add(new OrphanAdvisor(a.Id, a.BoardId, BoardName(a.BoardId),
          a.RosterEntryId, a.BoardRole ?? "", a.Approved, a.Removed,
          "stale-version", "Pinned v" + a.RosterVersion + " vs roster v" + rent.Version + "; re-review required."));
        continue;
      }
    }
    // Duplicate links: same roster entry attached twice on one board (one must be removed).
    foreach (var grp in s.Advisors.Values.Where(a => !a.Removed && a.RosterEntryId != Guid.Empty && (!scopeBoardId.HasValue || a.BoardId == scopeBoardId.Value))
      .GroupBy(a => new { a.BoardId, a.RosterEntryId })
      .Where(g => g.Count() > 1))
    {
      // Survivor ordering matches the apply step exactly: earliest CreatedAt wins,
      // ties broken by Id. The orphan set is every link after the survivor.
      foreach (var a in grp.OrderBy(a => a.CreatedAt).ThenBy(a => a.Id).Skip(1))
        out_.Add(new OrphanAdvisor(a.Id, a.BoardId, BoardName(a.BoardId),
          a.RosterEntryId, a.BoardRole ?? "", a.Approved, a.Removed,
          "duplicate-link", "Same roster entry linked twice on one board; keep one, remove the other."));
    }
    return out_;
  }

  // Backup snapshot (read-only JSON): every affected advisor + roster + image row.
  public static string BuildBackup(InMemoryStore s, IEnumerable<Guid> advisorIds)
  {
    var ids = new HashSet<Guid>(advisorIds);
    var advisors = s.Advisors.Values.Where(a => ids.Contains(a.Id)).OrderBy(a => a.Id).ToList();
    var rosterIds = new HashSet<Guid>(advisors.Select(a => a.RosterEntryId));
    var rosters = s.Roster.Values.Where(r => rosterIds.Contains(r.Id)).OrderBy(r => r.Id).ToList();
    var images = s.Images.Values
      .Where(i => (i.BoardAdvisorId.HasValue && ids.Contains(i.BoardAdvisorId.Value))
        || (i.RosterEntryId.HasValue && rosterIds.Contains(i.RosterEntryId.Value)))
      .OrderBy(i => i.Id).ToList();
    var snapshot = new
    {
      engine = EngineVersion,
      takenAt = DateTime.UtcNow.ToString("o"),
      advisors = advisors.Select(a => new
      {
        a.Id, a.BoardId, a.RosterEntryId, a.RosterVersion,
        a.BoardRole, a.Approved, a.Removed, a.ImageProvenance, a.CreatedAt,
      }),
      roster = rosters.Select(r => new
      {
        r.Id, r.AccountId, r.Type, r.Name, r.Description, r.ProfileJson,
        r.Version, r.Archived, r.Tags, r.OwnerKey, r.ResearchJson,
        r.ResearchedAt, r.ResearchRequested, r.EvidenceCount,
        r.ResearchJobId, r.ResearchBaseVersion, r.UpdatedAt,
      }),
      images = images.Select(i => new
      {
        i.Id, i.RosterEntryId, i.BoardAdvisorId, i.Kind, i.Provenance,
        i.Review, i.ContentType, i.CreatedAt, hasData = i.Data is not null,
      }),
    };
    return JsonSerializer.Serialize(snapshot, new JsonSerializerOptions { WriteIndented = true });
  }

  // Canonical mutation-input serialization: explicit typed structures serialized
  // ONLY via JsonSerializer (leaf escaping handled, sorted keys/arrays, full IDs).
  // No manual delimiters anywhere in hash inputs: names or descriptions containing
  // ";", "=", ":" or "name=" can never collide. Summary/Evidence stay human
  // preview and are never hashed. Only owner/account IDs are bound, never account
  // secrets, passwords, or session objects.
  static string JCanon(SortedDictionary<string, object?> m) =>
    JsonSerializer.Serialize(m, new JsonSerializerOptions { WriteIndented = false });
  static List<object?> JIds(IEnumerable<Guid> ids) =>
    ids.Select(g => g.ToString("N")).OrderBy(x => x, StringComparer.Ordinal).Select(x => (object?)x).ToList();
  static SortedDictionary<string, object?> JEntry(Domain.RosterEntry? r) =>
    r is null ? new SortedDictionary<string, object?> { ["absent"] = true }
    : new SortedDictionary<string, object?> {
      ["account"] = r.AccountId.ToString("N"), ["archived"] = r.Archived, ["description"] = r.Description ?? "",
      ["name"] = r.Name ?? "", ["owner"] = (r.OwnerKey ?? "").Trim(), ["profile"] = r.ProfileJson ?? "",
      ["tags"] = r.Tags ?? "", ["type"] = r.Type.ToString(), ["version"] = r.Version,
    };
  static SortedDictionary<string, object?> JBoard(InMemoryStore s, Guid bid) =>
    s.Boards.TryGetValue(bid, out var bsv) && bsv is not null
      ? new SortedDictionary<string, object?> { ["id"] = bid.ToString("N"), ["name"] = bsv.Name ?? "", ["owner"] = (bsv.OwnerKey ?? "").Trim() }
      : new SortedDictionary<string, object?> { ["id"] = bid.ToString("N"), ["missing"] = true };
  static SortedDictionary<string, object?> JLink(Domain.BoardAdvisor a) =>
    new SortedDictionary<string, object?> {
      ["id"] = a.Id.ToString("N"), ["board"] = a.BoardId.ToString("N"), ["role"] = a.BoardRole ?? "",
      ["removed"] = a.Removed, ["approved"] = a.Approved, ["pinned"] = a.RosterVersion,
    };
  static List<object?> JLinks(IEnumerable<Domain.BoardAdvisor> links) =>
    links.OrderBy(a => a.Id).Select(a => (object?)JLink(a)).ToList();
  static List<object?> JBoards(InMemoryStore s, IEnumerable<Guid> bids) =>
    bids.OrderBy(b => b).Select(b => (object?)JBoard(s, b)).ToList();
  static SortedDictionary<string, object?> JOrphan(OrphanAdvisor o) =>
    new SortedDictionary<string, object?> {
      ["advisor"] = o.AdvisorId.ToString("N"), ["approved"] = o.Approved, ["board"] = o.BoardId.ToString("N"),
      ["reason"] = o.Reason, ["removed"] = o.Removed, ["role"] = o.BoardRole ?? "", ["roster"] = o.RosterEntryId.ToString("N"),
    };
  static string FlagMutation(InMemoryStore s, OrphanAdvisor o, string resolution)
  {
    s.Roster.TryGetValue(o.RosterEntryId, out var fr);
    return JCanon(new SortedDictionary<string, object?> {
      ["action"] = "flag-review", ["advisor"] = o.AdvisorId.ToString("N"), ["board"] = JBoard(s, o.BoardId),
      ["entry"] = JEntry(o.RosterEntryId == Guid.Empty ? null : fr), ["reason"] = o.Reason,
      ["resolution"] = resolution, ["role"] = o.BoardRole ?? "",
    });
  }
  // Dry-run plan (read-only). Rules:
  //  - missing-roster / archived-roster: NEVER invent content; flag for
  //    owner review with the preserved role/history/image evidence.
  //  - stale-version: re-pin + unapprove (review required), never silent.
  //  - duplicate-link: keep earliest, propose removal of later (no delete here).
  //  - Name match alone NEVER merges across people/accounts: actions that
  //    would join two identities require identical ownership + identical
  //    content hash evidence, else FlagAmbiguous.
  public static ReconcileReport Plan(InMemoryStore s, string idempotencyKey, Guid? scopeBoardId = null)
  {
    var key = string.IsNullOrWhiteSpace(idempotencyKey) ? "roster-reconcile:manual" : idempotencyKey.Trim();
    var orphans = Scan(s, scopeBoardId);
    var actions = new List<ReconcileAction>();
    var warnings = new List<string>();
    // Every auto-repairable orphan gets an action describing the EXACT mutation the
    // apply step will perform (same inputs, same ordering, same survivor choice).
    // The plan hash binds ONLY the typed full-mutation snapshot (Mutation) plus
    // typed orphan identities; human Summary/Evidence strings are preview only.
    // Any drift between review and apply (new orphans, changed entry fields or
    // ownership, role edits, moved history rows, target-state changes) changes
    // the hash and the guarded apply refuses with 409. Ownership-blocked classes
    // carry FlagForOwnerReview actions with the blocking reason.
    foreach (var o in orphans)
    {
      switch (o.Reason)
      {
        case "stale-version":
          if (s.Roster.TryGetValue(o.RosterEntryId, out var rent) && rent is not null && !rent.Archived)
          {
            s.Advisors.TryGetValue(o.AdvisorId, out var sav);
            var sblk = sav is null ? "advisor-missing" : SimCEO.Api.Work.RosterLegacyAccess.RepairBlockReason(s, sav, rent, o.RosterEntryId);
            if (sblk is not null)
            {
              actions.Add(new ReconcileAction("FlagForOwnerReview", o.AdvisorId, o.BoardId, o.RosterEntryId,
                "Stale link blocked by ownership (" + sblk + "); owner review required. Nothing auto-applied.",
                o.Detail + " role=[" + o.BoardRole + "]",
                FlagMutation(s, o, sblk)));
              warnings.Add("Advisor " + o.AdvisorId + " on board " + o.BoardId + " has blocked ownership (" + sblk + ").");
            }
            else
            {
              var sadv = sav!;
              var material = rent.ResearchRequested || rent.EvidenceCount > 0;
              var sbo = s.Boards.TryGetValue(o.BoardId, out var sbv) && sbv is not null ? (sbv.OwnerKey ?? "") : "";
              var sallLinks = s.Advisors.Values.Where(a => a.RosterEntryId == o.RosterEntryId).OrderBy(a => a.Id).ToList();
              var smut = JCanon(new SortedDictionary<string, object?> {
                ["action"] = "repin-unapprove", ["advisor"] = sadv.Id.ToString("N"), ["approved"] = sadv.Approved,
                ["board"] = o.BoardId.ToString("N"), ["boardName"] = o.BoardName, ["boardOwner"] = sbo,
                ["entry"] = JEntry(rent), ["evidenceCount"] = rent.EvidenceCount,
                ["fp"] = RosterIntegrity.CanonicalBehaviorFingerprint(s, sadv),
                ["historyBoards"] = JBoards(s, sallLinks.Select(a => a.BoardId).Distinct()),
                ["historyLinks"] = JLinks(sallLinks),
                ["pinnedVersion"] = sadv.RosterVersion, ["researchRequested"] = rent.ResearchRequested,
                ["role"] = sadv.BoardRole ?? "", ["roster"] = o.RosterEntryId.ToString("N"),
              });
              actions.Add(new ReconcileAction("RePinAndUnapprove", o.AdvisorId, o.BoardId, o.RosterEntryId,
                "Re-pin advisor " + o.AdvisorId.ToString("N")[..8] + " from v" + sadv.RosterVersion + " to roster v" + rent.Version + ", set Approved=false, preserve role/history/images/research.",
                "pinned-changed; target-version=" + rent.Version + "; researchRequested=" + rent.ResearchRequested + "; evidence=" + rent.EvidenceCount
                + "; material=" + material + "; fp=" + RosterIntegrity.CanonicalBehaviorFingerprint(s, sadv)
                + "; board=" + o.BoardName + "; boardOwner=" + sbo + "; role=" + (sadv.BoardRole ?? "") + "; approved=" + sadv.Approved,
                smut));
            }
          }
          else
          {
            actions.Add(new ReconcileAction("FlagForOwnerReview", o.AdvisorId, o.BoardId, o.RosterEntryId,
              "Linked roster entry is gone or archived; owner review required. Nothing auto-applied.",
              o.Detail + " role=[" + o.BoardRole + "]",
              FlagMutation(s, o, "entry-gone-or-archived")));
            warnings.Add("Advisor " + o.AdvisorId + " on board " + o.BoardId + " needs owner review (" + o.Reason + ").");
          }
          break;
        case "duplicate-link":
          {
            var dupLinks = s.Advisors.Values.Where(a => !a.Removed && a.BoardId == o.BoardId && a.RosterEntryId == o.RosterEntryId).OrderBy(a => a.CreatedAt).ThenBy(a => a.Id).ToList();
            var survivor = dupLinks.FirstOrDefault();
            s.Roster.TryGetValue(o.RosterEntryId, out var dsrent);
            var dblk = survivor is null ? "no-survivor" : SimCEO.Api.Work.RosterLegacyAccess.RepairBlockReason(s, survivor, dsrent, o.RosterEntryId);
            if (dblk is not null || survivor is null || dupLinks.Count < 2)
            {
              actions.Add(new ReconcileAction("FlagForOwnerReview", o.AdvisorId, o.BoardId, o.RosterEntryId,
                "Duplicate link blocked by ownership (" + (dblk ?? "no-repair-target") + "); owner review required. Nothing auto-applied.",
                o.Detail + " role=[" + o.BoardRole + "]",
                FlagMutation(s, o, dblk ?? "no-repair-target")));
              warnings.Add("Advisor " + o.AdvisorId + " on board " + o.BoardId + " has blocked duplicate ownership (" + (dblk ?? "no-repair-target") + ").");
            }
            else
            {
              var doomed = new HashSet<Guid>(dupLinks.Skip(1).Select(a => a.Id));
              var dmsgs = new List<object?>();
              foreach (var kv in s.Messages) foreach (var m in kv.Value) if (doomed.Contains(m.AdvisorId)) dmsgs.Add(new SortedDictionary<string, object?> { ["advisor"] = m.AdvisorId.ToString("N"), ["meeting"] = kv.Key.ToString("N"), ["sequence"] = m.Sequence });
              dmsgs = dmsgs.OrderBy(x => ((SortedDictionary<string, object?>)x!)["meeting"]).ThenBy(x => ((SortedDictionary<string, object?>)x!)["sequence"]).ToList();
              var dimgs = s.Images.Values.Where(i => i.BoardAdvisorId.HasValue && doomed.Contains(i.BoardAdvisorId.Value)).OrderBy(i => i.Id).Select(i => (object?)new SortedDictionary<string, object?> { ["boardAdvisor"] = i.BoardAdvisorId!.Value.ToString("N"), ["id"] = i.Id.ToString("N"), ["provenance"] = i.Provenance ?? "", ["review"] = i.Review ?? "" }).ToList();
              var dparts = new List<object?>();
              var mtgCount = 0;
              foreach (var mtg in s.Meetings.Values.Where(m => m.BoardId == o.BoardId).OrderBy(m => m.Id))
              {
                List<Guid> dplist = new List<Guid>();
                try
                {
                  using var d = JsonDocument.Parse(string.IsNullOrWhiteSpace(mtg.ParticipantIdsJson) ? "[]" : mtg.ParticipantIdsJson);
                  if (d.RootElement.ValueKind == JsonValueKind.Array)
                    foreach (var e in d.RootElement.EnumerateArray())
                      if (e.ValueKind == JsonValueKind.String && Guid.TryParse(e.GetString(), out var g)) dplist.Add(g);
                }
                catch (JsonException) { }
                if (dplist.Any(doomed.Contains)) { mtgCount++; dparts.Add(new SortedDictionary<string, object?> { ["meeting"] = mtg.Id.ToString("N"), ["participants"] = dplist.Select(p => (object?)p.ToString("N")).ToList() }); }
              }
              var dsurv = survivor!;
              var dbo = s.Boards.TryGetValue(o.BoardId, out var dbv) && dbv is not null ? (dbv.OwnerKey ?? "") : "";
              var msgCount = dmsgs.Count;
              var imgCount = dimgs.Count;
              var droles = (dsurv.BoardRole ?? "") + "|" + string.Join(",", dupLinks.Skip(1).Select(a => a.BoardRole ?? ""));
              var dallLinks = s.Advisors.Values.Where(a => a.RosterEntryId == o.RosterEntryId).OrderBy(a => a.Id).ToList();
              var dmut = JCanon(new SortedDictionary<string, object?> {
                ["action"] = "dedupe", ["advisor"] = o.AdvisorId.ToString("N"), ["board"] = o.BoardId.ToString("N"),
                ["boardName"] = o.BoardName, ["boardOwner"] = dbo, ["entry"] = JEntry(dsrent),
                ["historyBoards"] = JBoards(s, dallLinks.Select(a => a.BoardId).Distinct()),
                ["historyLinks"] = JLinks(dallLinks),
                ["images"] = dimgs, ["messages"] = dmsgs,
                ["order"] = "created-id-then-id", ["participants"] = dparts,
                ["removed"] = dupLinks.Skip(1).Select(a => (object?)JLink(a)).ToList(),
                ["roster"] = o.RosterEntryId.ToString("N"),
                ["survivor"] = new SortedDictionary<string, object?> { ["createdTicks"] = dsurv.CreatedAt.Ticks, ["link"] = JLink(dsurv) },
              });
              actions.Add(new ReconcileAction("RemoveDuplicateLink", o.AdvisorId, o.BoardId, o.RosterEntryId,
                "Keep survivor " + dsurv.Id.ToString("N")[..8] + "; mark advisor " + o.AdvisorId.ToString("N")[..8] + " Removed=true; re-point its history to the survivor; preserve removed role in audit.",
                "survivor=" + dsurv.Id.ToString("N") + "; removed=" + o.AdvisorId.ToString("N") + "; messages=" + msgCount + "; images=" + imgCount + "; participant-lists=" + mtgCount
                + "; board=" + o.BoardName + "; boardOwner=" + dbo + "; roles=" + droles,
                dmut));
            }
          }
          break;
        case "missing-roster":
          {
            var rid = o.RosterEntryId;
            if (s.Roster.TryGetValue(rid, out var existRent) && existRent is not null && existRent.Archived)
            {
              actions.Add(new ReconcileAction("FlagForOwnerReview", o.AdvisorId, o.BoardId, o.RosterEntryId,
                "Linked roster entry is archived; owner must unarchive or relink. Nothing auto-applied; entry is never duplicated.",
                o.Detail + " role=[" + o.BoardRole + "]",
                FlagMutation(s, o, "entry-archived")));
              warnings.Add("Advisor " + o.AdvisorId + " on board " + o.BoardId + " links an archived entry (" + o.Reason + ").");
            }
            else
            {
              var mowner = SimCEO.Api.Work.RosterLegacyAccess.MutationOwnerKey(s, rid);
              var sharers = s.Advisors.Values.Where(a => !a.Removed && a.RosterEntryId == rid).OrderBy(a => a.CreatedAt).ThenBy(a => a.Id).ToList();
              var mfirst = sharers.FirstOrDefault();
              var mname = ((mfirst is null ? "" : (mfirst.BoardRole ?? "")).Trim());
              if (mname.Length == 0) mname = "Recovered advisor";
              if (mowner is null || mfirst is null)
              {
                actions.Add(new ReconcileAction("FlagForOwnerReview", o.AdvisorId, o.BoardId, o.RosterEntryId,
                  "Missing roster target with ambiguous or unknown ownership; owner review required. Never merged across accounts, never invented.",
                  o.Detail + " role=[" + o.BoardRole + "]",
                  FlagMutation(s, o, "owner-unknown-or-ambiguous")));
                warnings.Add("Advisor " + o.AdvisorId + " on board " + o.BoardId + " has ambiguous ownership (" + o.Reason + ").");
              }
              else if (scopeBoardId.HasValue && sharers.Any(a => a.BoardId != scopeBoardId.Value))
              {
                var outside = sharers.Where(a => a.BoardId != scopeBoardId.Value).Select(a => a.BoardId).Distinct().OrderBy(b => b).ToList();
                var gallLinks = s.Advisors.Values.Where(a => a.RosterEntryId == rid).OrderBy(a => a.Id).ToList();
                var gboards = gallLinks.Select(a => a.BoardId).Distinct().OrderBy(b => b).ToList();
                var gsmut = JCanon(new SortedDictionary<string, object?> {
                  ["action"] = "requires-global", ["advisor"] = o.AdvisorId.ToString("N"), ["board"] = o.BoardId.ToString("N"),
                  ["entry"] = rid.ToString("N"),
                  ["historyBoards"] = JBoards(s, gboards),
                  ["historyLinks"] = JLinks(gallLinks),
                  ["inside"] = sharers.Where(a => a.BoardId == scopeBoardId.Value).Select(a => a.Id.ToString("N")).OrderBy(x => x, StringComparer.Ordinal).Select(x => (object?)x).ToList(),
                  ["outside"] = outside.Select(b => (object?)b.ToString("N")).ToList(),
                  ["owner"] = mowner, ["roster"] = rid.ToString("N"),
                });
                actions.Add(new ReconcileAction("RequiresGlobalScope", o.AdvisorId, o.BoardId, o.RosterEntryId,
                  "Shared missing roster " + rid.ToString("N")[..8] + " is also linked from board(s) " + string.Join(",", outside.Select(b => b.ToString("N")[..8])) + " outside this scope; run a global (unscoped) reconcile so every sharing link, image, and approval is repaired together.",
                  "entry=" + rid.ToString("N") + "; owner=" + mowner + "; inside=" + string.Join(",", sharers.Where(a => a.BoardId == scopeBoardId.Value).Select(a => a.Id.ToString("N")[..8])) + "; outside=" + string.Join(",", outside.Select(b => b.ToString("N"))),
                  gsmut));
                warnings.Add("Advisor " + o.AdvisorId + " shares missing roster " + rid + " across scopes; global reconcile required.");
              }
              else
              {
                var macct = SimCEO.Api.Work.RosterLegacyAccess.AccountForOwner(s, mowner);
                var mdesc = "Recovered canonical roster entry for legacy board link " + rid.ToString("N")[..8] + ". Review and complete; run research as needed.";
                var mprof = SimCEO.Api.Work.RosterLegacyAccess.HonestRecoveryStub(mfirst.BoardRole ?? "", "legacy board-advisor link " + rid.ToString("N")[..8]);
                var mroles = string.Join(";", sharers.Select(a => a.Id.ToString("N")[..8] + ":" + (a.BoardRole ?? "")));
                var mimgs = string.Join(",", s.Images.Values.Where(i => i.BoardAdvisorId.HasValue && sharers.Any(a => a.Id == i.BoardAdvisorId.Value) && !i.RosterEntryId.HasValue).OrderBy(i => i.Id).Select(i => i.Id.ToString("N")[..8] + ":" + (i.Provenance ?? "")));
                var mallLinks = s.Advisors.Values.Where(a => a.RosterEntryId == rid).OrderBy(a => a.Id).ToList();
                var mboards = mallLinks.Select(a => a.BoardId).Distinct().OrderBy(b => b).ToList();
                var mmut = JCanon(new SortedDictionary<string, object?> {
                  ["account"] = macct.ToString("N"), ["action"] = "recover-missing", ["advisors"] = JIds(sharers.Select(a => a.Id)),
                  ["boardRoles"] = sharers.Select(a => (object?)new SortedDictionary<string, object?> { ["advisor"] = a.Id.ToString("N"), ["role"] = a.BoardRole ?? "" }).ToList(),
                  ["description"] = mdesc, ["entry"] = rid.ToString("N"),
                  ["historyBoards"] = JBoards(s, mboards),
                  ["historyLinks"] = JLinks(mallLinks),
                  ["images"] = s.Images.Values.Where(i => i.BoardAdvisorId.HasValue && sharers.Any(a => a.Id == i.BoardAdvisorId.Value) && !i.RosterEntryId.HasValue).OrderBy(i => i.Id).Select(i => (object?)new SortedDictionary<string, object?> { ["boardAdvisor"] = i.BoardAdvisorId!.Value.ToString("N"), ["id"] = i.Id.ToString("N"), ["provenance"] = i.Provenance ?? "" }).ToList(),
                  ["name"] = mname, ["owner"] = mowner, ["profile"] = mprof, ["roster"] = rid.ToString("N"),
                  ["tags"] = "recovered", ["type"] = AdvisorType.FictionalCharacter.ToString(), ["version"] = 1,
                });
                actions.Add(new ReconcileAction("RecoverMissingEntry", o.AdvisorId, o.BoardId, o.RosterEntryId,
                  "Create roster " + rid.ToString("N")[..8] + " Owner=" + mowner + " Name=\"" + mname + "\" for " + sharers.Count + " advisor(s) [" + string.Join(",", sharers.Select(a => a.Id.ToString("N")[..8])) + "]; re-pin each to v1 Approved=false; re-link board-local images.",
                  "entry=" + rid.ToString("N") + "; owner=" + mowner + "; account=" + macct.ToString("N") + "; name=\"" + mname + "\"; description=" + mdesc + "; profile=" + mprof + "; boardRoles=" + mroles + "; images=" + mimgs + "; advisors=" + string.Join(",", sharers.OrderBy(a => a.Id).Select(a => a.Id.ToString("N"))) + "; version=1",
                  mmut));
              }
            }
          }
          break;
        case "empty-link":
          {
            var hasBoardOwner = s.Boards.TryGetValue(o.BoardId, out var ebo) && ebo is not null && !string.IsNullOrWhiteSpace(ebo.OwnerKey);
            if (hasBoardOwner && s.Advisors.TryGetValue(o.AdvisorId, out var eadv) && eadv is not null && !eadv.Removed)
            {
              var nid = SimCEO.Api.Work.RosterLegacyAccess.StableEmptyLinkId(eadv.BoardId, eadv.Id);
              var eowner = ((ebo is null ? "" : (ebo.OwnerKey ?? "")).Trim());
              var enm = ((eadv.BoardRole ?? "").Trim());
              if (enm.Length == 0) enm = "Recovered advisor";
              var eimgRows = s.Images.Values.Where(i => i.BoardAdvisorId == eadv.Id && !i.RosterEntryId.HasValue).OrderBy(i => i.Id).ToList();
              var eimg = eimgRows.Count;
              var eacct = SimCEO.Api.Work.RosterLegacyAccess.AccountForOwner(s, eowner);
              var ebName = ebo is null ? "?" : ebo.Name;
              var edesc = "Recovered canonical roster entry for an unlinked board advisor on board " + ebName + ". Review and complete; run research as needed.";
              var eprof = SimCEO.Api.Work.RosterLegacyAccess.HonestRecoveryStub(eadv.BoardRole ?? "", "unlinked board advisor " + eadv.Id.ToString("N")[..8] + " on board " + ebName);
              var ehas = s.Roster.TryGetValue(nid, out var etarget) && etarget is not null;
              string? ublock = null;
              if (ehas)
              {
                var eto = (etarget!.OwnerKey ?? "").Trim();
                if (etarget.Archived) ublock = "target-archived";
                else if (eto.Length > 0 && !string.Equals(eto, eowner, StringComparison.OrdinalIgnoreCase)) ublock = "target-owner-mismatch";
                else if (eto.Length == 0 && !string.Equals(SimCEO.Api.Work.RosterLegacyAccess.MutationOwnerKey(s, nid) ?? "", eowner, StringComparison.OrdinalIgnoreCase)) ublock = "target-owner-unknown";
              }
              if (ublock is not null)
              {
                actions.Add(new ReconcileAction("FlagForOwnerReview", o.AdvisorId, o.BoardId, o.RosterEntryId,
                  "Existing deterministic roster target " + nid.ToString("N")[..8] + " is " + ublock + "; owner must relink explicitly. Never attached to a foreign or archived target.",
                  o.Detail + " role=[" + o.BoardRole + "]",
                  FlagMutation(s, o, ublock)));
                warnings.Add("Advisor " + o.AdvisorId + " on board " + o.BoardId + " has an unusable deterministic target (" + ublock + ").");
              }
              else
              {
                var eallLinks = ehas ? s.Advisors.Values.Where(a => a.RosterEntryId == nid).OrderBy(a => a.Id).ToList() : new List<Domain.BoardAdvisor>();
                var emutDict = new SortedDictionary<string, object?> {
                  ["action"] = ehas ? (object?)"relink-existing" : "recover-empty",
                  ["advisor"] = JLink(eadv), ["board"] = JBoard(s, o.BoardId), ["boardOwner"] = eowner,
                  ["entry"] = nid.ToString("N"),
                  ["historyBoards"] = JBoards(s, eallLinks.Select(a => a.BoardId).Distinct()),
                  ["historyLinks"] = JLinks(eallLinks),
                  ["images"] = eimgRows.Select(i => (object?)new SortedDictionary<string, object?> { ["boardAdvisor"] = i.BoardAdvisorId!.Value.ToString("N"), ["id"] = i.Id.ToString("N"), ["provenance"] = i.Provenance ?? "" }).ToList(),
                  ["roster"] = nid.ToString("N"),
                };
                if (ehas) emutDict["existingEntry"] = JEntry(etarget);
                else
                {
                  emutDict["account"] = eacct.ToString("N"); emutDict["description"] = edesc;
                  emutDict["name"] = enm; emutDict["profile"] = eprof;
                  emutDict["tags"] = "recovered"; emutDict["type"] = AdvisorType.FictionalCharacter.ToString(); emutDict["version"] = 1;
                }
                var emut = JCanon(emutDict);
                actions.Add(new ReconcileAction("RecoverEmptyLink", o.AdvisorId, o.BoardId, o.RosterEntryId,
                  ehas
                    ? "Link advisor " + eadv.Id.ToString("N")[..8] + " to EXISTING roster " + nid.ToString("N")[..8] + " Owner=" + ((etarget!.OwnerKey ?? "").Trim()) + " v" + etarget.Version + "; re-pin Approved=false; re-link " + eimg + " board image(s). No new entry created."
                    : "Create dedicated roster " + nid.ToString("N")[..8] + " Owner=" + eowner + " Name=\"" + enm + "\" for advisor " + eadv.Id.ToString("N")[..8] + "; set link, re-pin v1 Approved=false; re-link " + eimg + " board image(s).",
                  "entry=" + nid.ToString("N") + "; owner=" + eowner + "; account=" + eacct.ToString("N") + "; board=" + ebName + "; name=\"" + enm + "\"; description=" + edesc + "; profile=" + eprof + "; images=" + eimg + ":" + string.Join(",", eimgRows.Select(i => i.Id.ToString("N")[..8] + ":" + (i.Provenance ?? ""))) + "; version=1; exists=" + (ehas ? "1" : "0"),
                  emut));
              }
            }
            else
            {
              actions.Add(new ReconcileAction("FlagForOwnerReview", o.AdvisorId, o.BoardId, o.RosterEntryId,
                "No roster link and no board owner: owner must attach this advisor to an authorized roster entry. Never auto-grouped, never merged, never removed by reconciliation.",
                o.Detail + " role=[" + o.BoardRole + "]",
                FlagMutation(s, o, "no-board-owner")));
              warnings.Add("Advisor " + o.AdvisorId + " on board " + o.BoardId + " has no roster link and no board owner (" + o.Reason + ").");
            }
            break;
          }
        case "archived-roster":
          actions.Add(new ReconcileAction("FlagForOwnerReview", o.AdvisorId, o.BoardId, o.RosterEntryId,
            "Archived target stays archived; linked board shows it read-only and approval stays blocked. Nothing auto-applied; entry is never duplicated.",
            o.Detail + " role=[" + o.BoardRole + "]",
            FlagMutation(s, o, "entry-archived")));
          warnings.Add("Advisor " + o.AdvisorId + " on board " + o.BoardId + " links an archived entry (" + o.Reason + ").");
          break;
      }
    }
    var backup = BuildBackup(s, orphans.Select(o => o.AdvisorId));
    // Authoritative hash input: ONE canonical JSON document (engine + scope + key +
    // sorted typed orphan identities + sorted actions with nested typed mutations).
    // Human Summary/Evidence strings are preview only and never hashed.
    var hashDoc = new SortedDictionary<string, object?> {
      ["engine"] = EngineVersion,
      ["scope"] = scopeBoardId.HasValue ? scopeBoardId.Value.ToString("N") : "all",
      ["key"] = key,
      ["orphans"] = orphans.OrderBy(o => o.AdvisorId).ThenBy(o => o.Reason).Select(o => (object?)JOrphan(o)).ToList(),
      ["actions"] = actions.OrderBy(a => a.AdvisorId).ThenBy(a => a.Kind).Select(a => (object?)new SortedDictionary<string, object?> {
        ["kind"] = a.Kind, ["advisor"] = a.AdvisorId.ToString("N"), ["board"] = a.BoardId.ToString("N"),
        ["roster"] = a.RosterEntryId.ToString("N"),
        ["mutation"] = JsonDocument.Parse(string.IsNullOrWhiteSpace(a.Mutation) ? "{}" : a.Mutation).RootElement.Clone(),
      }).ToList(),
    };
    var hashBase = JCanon(hashDoc);
    var planHash = ContentHash(hashBase);
    return new ReconcileReport(EngineVersion, planHash, key, DateTime.UtcNow,
      orphans, actions, warnings, backup, false);
  }

  // Guarded apply for the PRIMARY's production migration run. Idempotent per
  // IdempotencyKey: the store keeps one marker note per key; a second apply
  // with the same key + same plan hash is a no-op success, a different plan
  // hash is rejected. Only RePinAndUnapprove is auto-applied; destructive or
  // identity-joining steps always stay manual. Backup JSON is recorded in the
  // marker. NOTE: this task performs NO live writes; this method exists so
  // the primary can run the approved migration exactly once.
  public static (bool ok, string message) ApplyPinnedReviewReset(
    InMemoryStore s, ReconcileReport plan, Guid boardId, Guid meetingIdForMarker)
  {
    var markerKind = "roster-reconcile-marker";
    var markerTitle = "reconcile:" + plan.IdempotencyKey + ":" + plan.PlanHash;
    var existing = s.Notes.Values.FirstOrDefault(n =>
      n.BoardId == boardId && n.Kind == markerKind && n.Title == markerTitle);
    if (existing is not null) return (true, "Idempotent replay: plan " + plan.PlanHash + " already applied.");
    var clash = s.Notes.Values.FirstOrDefault(n =>
      n.BoardId == boardId && n.Kind == markerKind && n.Title.StartsWith("reconcile:" + plan.IdempotencyKey + ":"));
    if (clash is not null)
      return (false, "Idempotency key " + plan.IdempotencyKey + " already used for a different plan; refusing to apply.");
    var target = plan.Actions.Where(a => a.Kind == "RePinAndUnapprove").ToList();
    Atomic.Run(s, () =>
    {
      foreach (var a in target)
      {
        if (!s.Advisors.TryGetValue(a.AdvisorId, out var adv) || adv is null || adv.Removed) continue;
        if (!s.Roster.TryGetValue(a.RosterEntryId, out var rent) || rent is null || rent.Archived) continue;
        adv.RosterVersion = rent.Version;
        adv.Approved = false;
        s.Advisors[adv.Id] = adv;
      }
      s.Advisors.Flush();
      var marker = new Note
      {
        BoardId = boardId, MeetingId = meetingIdForMarker, Kind = markerKind,
        Scope = "board", Provisional = false, Title = markerTitle,
        Body = JsonSerializer.Serialize(new
        {
          engine = plan.Engine, planHash = plan.PlanHash,
          applied = target.Select(a => a.AdvisorId).ToList(),
          backupChars = (plan.BackupJson ?? "").Length,
        }),
        RootId = Guid.Empty, Revision = 1, NoteStatus = "current",
      };
      marker.RootId = marker.Id;
      s.Notes[marker.Id] = marker;
      s.Notes.Flush();
    });
    return (true, "Applied " + target.Count + " re-pin(s); duplicates/orphans left for owner review.");
  }
}