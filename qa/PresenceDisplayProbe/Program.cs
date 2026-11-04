using SimCEO.Api;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

// Presence display in-process proof: invokes REAL RosterDisplayOps on an
// owned InMemoryStore. No HTTP, no PG, no services, no network.
// Fails closed: USE_POSTGRES must not be 1 and Pg.Backend must be null.
var failures = new List<string>();
void Check(bool ok, string name, string detail)
{
  Console.WriteLine((ok ? "PASS " : "FAIL ") + name + " :: " + detail);
  if (!ok) failures.Add(name);
}
if (Environment.GetEnvironmentVariable("USE_POSTGRES") == "1")
{
  Console.WriteLine("FAIL pg-guard :: USE_POSTGRES must be 0 for in-process probe");
  return 1;
}
if (Pg.Backend is not null)
{
  Console.WriteLine("FAIL pg-backend-guard :: Pg.Backend must be null (pure in-memory)");
  return 1;
}
InMemoryStore NewStore() => new InMemoryStore();
Guid NewBoard(InMemoryStore s)
{
  var b = new Board { Id = Guid.NewGuid(), Name = "B", CreatedAt = DateTime.UtcNow };
  s.Boards[b.Id] = b;
  return b.Id;
}
Guid NewRoster(InMemoryStore s)
{
  var r = new RosterEntry { Id = Guid.NewGuid(), Name = "R", Description = "roster entry for probe", ProfileJson = "{probe-profile-with-length}", Version = 1, UpdatedAt = DateTime.UtcNow };
  s.Roster[r.Id] = r;
  return r.Id;
}
Guid AddImage(InMemoryStore s, Guid rosterId, Guid? advisorId, string review, DateTime createdAt, Guid? id = null, string kind = "upload")
{
  var gid = id ?? Guid.NewGuid();
  s.Images[gid] = new AdvisorImage { Id = gid, RosterEntryId = rosterId, BoardAdvisorId = advisorId, Kind = kind, Provenance = "probe", Review = review, ContentType = "image/png", Data = new byte[] { 7 }, CreatedAt = createdAt };
  return gid;
}
Guid AddAdvisor(InMemoryStore s, Guid boardId, Guid rosterId, string provenance)
{
  var aid = Guid.NewGuid();
  s.Advisors[aid] = new BoardAdvisor { Id = aid, BoardId = boardId, RosterEntryId = rosterId, RosterVersion = 1, BoardRole = "Seat", CreatedAt = DateTime.UtcNow, ImageProvenance = provenance };
  return aid;
}
var T0 = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
// 1. deterministic legacy: no-selection picks earliest CreatedAt.
{
  var s = NewStore();
  var b = NewBoard(s); var r = NewRoster(s);
  var early = AddImage(s, r, null, "accepted", T0);
  var late = AddImage(s, r, null, "accepted", T0.AddHours(1));
  var a = AddAdvisor(s, b, r, "initials");
  var adv = s.Advisors[a];
  var got = RosterDisplayOps.ResolveDisplayPortrait(s, adv)?.Id;
  Check(got == early, "legacy-earliest-wins", "got=" + got + " want=" + early + " late=" + late);
  var fp = RosterOps.ReviewedPortraitFingerprint(s, adv);
  Check(fp.Contains(early.ToString()), "legacy-fingerprint-parity", fp);
  Check(RosterOps.ApprovalGate(s, adv) is null, "legacy-approval-passes", "gate open");
}
// 1b. deterministic tie-break ThenBy Id with equal CreatedAt.
{
  var s = NewStore();
  var b = NewBoard(s); var r = NewRoster(s);
  var g1 = Guid.Parse("11111111-1111-1111-1111-111111111111");
  var g2 = Guid.Parse("22222222-2222-2222-2222-222222222222");
  AddImage(s, r, null, "accepted", T0, g2);
  AddImage(s, r, null, "accepted", T0, g1);
  var a = AddAdvisor(s, b, r, "initials");
  var got = RosterDisplayOps.ResolveDisplayPortrait(s, s.Advisors[a])?.Id;
  Check(got == g1, "legacy-tiebreak-id", "got=" + got + " want=" + g1);
}
// 2. no-selection with none stays fallback.
{
  var s = NewStore();
  var b = NewBoard(s); var r = NewRoster(s);
  var a = AddAdvisor(s, b, r, "initials");
  Check(RosterDisplayOps.ResolveDisplayPortrait(s, s.Advisors[a]) is null, "none-stays-fallback", "no images");
}
// 3. explicit valid accepted wins.
{
  var s = NewStore();
  var b = NewBoard(s); var r = NewRoster(s);
  var other = AddImage(s, r, null, "accepted", T0);
  var sel = AddImage(s, r, null, "accepted", T0.AddHours(2));
  var a = AddAdvisor(s, b, r, "upload:" + sel.ToString("D"));
  var got = RosterDisplayOps.ResolveDisplayPortrait(s, s.Advisors[a])?.Id;
  Check(got == sel, "explicit-valid-wins", "got=" + got + " want=" + sel + " other=" + other);
  Check(RosterOps.ReviewedPortraitFingerprint(s, s.Advisors[a]).Contains(sel.ToString()), "explicit-fingerprint-parity", "match");
  Check(RosterOps.ApprovalGate(s, s.Advisors[a]) is null, "explicit-approval-passes", "gate open");
}
// 4. explicit invalid with legacy present stays fallback (no rescue).
{
  var s = NewStore();
  var b = NewBoard(s); var r = NewRoster(s);
  var legacy = AddImage(s, r, null, "accepted", T0);
  var a = AddAdvisor(s, b, r, "upload:" + Guid.NewGuid().ToString("D"));
  Check(RosterDisplayOps.ResolveDisplayPortrait(s, s.Advisors[a]) is null, "explicit-invalid-no-rescue", "legacy=" + legacy + " must not rescue");
  Check(RosterOps.ApprovalGate(s, s.Advisors[a]) is not null, "explicit-invalid-gate-blocks", "gate must block");
}
// 5. explicit rejected with legacy present stays fallback.
{
  var s = NewStore();
  var b = NewBoard(s); var r = NewRoster(s);
  var legacy = AddImage(s, r, null, "accepted", T0);
  var bad = AddImage(s, r, null, "rejected", T0.AddHours(3));
  var a = AddAdvisor(s, b, r, "upload:" + bad.ToString("D"));
  Check(RosterDisplayOps.ResolveDisplayPortrait(s, s.Advisors[a]) is null, "explicit-rejected-no-rescue", "legacy=" + legacy + " bad=" + bad);
  Check(RosterOps.ApprovalGate(s, s.Advisors[a]) is not null, "explicit-rejected-gate-blocks", "gate must block");
}
// 6. grandfathered explicit wins; grandfathered legacy counts as accepted.
{
  var s = NewStore();
  var b = NewBoard(s); var r = NewRoster(s);
  var g = AddImage(s, r, null, "grandfathered", T0);
  var a = AddAdvisor(s, b, r, "upload:" + g.ToString("D"));
  Check(RosterDisplayOps.ResolveDisplayPortrait(s, s.Advisors[a])?.Id == g, "grandfathered-explicit-wins", "got grandfathered");
  var s2 = NewStore();
  var b2 = NewBoard(s2); var r2 = NewRoster(s2);
  var gl = AddImage(s2, r2, null, "grandfathered", T0);
  var a2 = AddAdvisor(s2, b2, r2, "initials");
  Check(RosterDisplayOps.ResolveDisplayPortrait(s2, s2.Advisors[a2])?.Id == gl, "grandfathered-legacy-counts", "legacy grandfathered accepted");
}
// 7. ambiguous linked never guesses newest: earliest deterministic wins.
{
  var s = NewStore();
  var b = NewBoard(s); var r = NewRoster(s);
  var a = AddAdvisor(s, b, r, "initials");
  var adv = s.Advisors[a];
  var u = AddImage(s, r, null, "accepted", T0);
  var l1 = AddImage(s, r, a, "accepted", T0.AddHours(1));
  var l2 = AddImage(s, r, a, "accepted", T0.AddHours(2));
  var got = RosterDisplayOps.ResolveDisplayPortrait(s, adv)?.Id;
  Check(got == u, "ambiguous-linked-deterministic", "got=" + got + " want earliest=" + u + " newest=" + l2 + " l1=" + l1);
  Check(got != l2, "ambiguous-linked-not-newest", "must not rescue newest");
}
// 8. ambiguous 8-char prefix stays fallback.
{
  var s = NewStore();
  var b = NewBoard(s); var r = NewRoster(s);
  var p1 = Guid.Parse("12345678-aaaa-bbbb-cccc-111111111111");
  var p2 = Guid.Parse("12345678-bbbb-cccc-dddd-222222222222");
  AddImage(s, r, null, "accepted", T0, p1);
  AddImage(s, r, null, "accepted", T0.AddHours(1), p2);
  var legacy = AddImage(s, r, null, "accepted", T0.AddHours(2));
  var a = AddAdvisor(s, b, r, "upload:12345678");
  Check(RosterDisplayOps.ResolveDisplayPortrait(s, s.Advisors[a]) is null, "ambiguous-prefix-no-guess", "legacy=" + legacy + " must not rescue");
}
// 9. same-roster: explicit guid from another roster stays fallback.
{
  var s = NewStore();
  var b = NewBoard(s); var r1 = NewRoster(s); var r2 = NewRoster(s);
  var foreign = AddImage(s, r2, null, "accepted", T0);
  var legacy = AddImage(s, r1, null, "accepted", T0);
  var a = AddAdvisor(s, b, r1, "upload:" + foreign.ToString("D"));
  Check(RosterDisplayOps.ResolveDisplayPortrait(s, s.Advisors[a]) is null, "cross-roster-no-identity", "foreign=" + foreign + " legacy=" + legacy);
}
// 10. single linked pending stays fallback (no legacy rescue, gate blocks).
{
  var s = NewStore();
  var b = NewBoard(s); var r = NewRoster(s);
  var legacy = AddImage(s, r, null, "accepted", T0);
  var a = AddAdvisor(s, b, r, "initials");
  AddImage(s, r, a, "pending", T0.AddHours(1));
  var adv = s.Advisors[a];
  Check(RosterDisplayOps.ResolveDisplayPortrait(s, adv) is null, "single-linked-pending-no-rescue", "legacy=" + legacy + " must not rescue");
  Check(RosterOps.ApprovalGate(s, adv) is not null, "single-linked-pending-gate-blocks", "gate must block");
}
Console.WriteLine(failures.Count == 0 ? "PROBE RESULT: PASS" : "PROBE RESULT: FAIL (" + failures.Count + ")");
return failures.Count == 0 ? 0 : 1;
