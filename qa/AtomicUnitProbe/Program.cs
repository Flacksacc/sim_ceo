using SimCEO.Api;

using SimCEO.Api.Data;

using SimCEO.Api.Domain;



// Focused store-bound Atomic proofs (issue 9): actual shared APIs, memory + PG.

// PG section is MANDATORY when --pg is supplied: no skip-as-pass.

// Exit nonzero on any failure.

var failures = new List<string>();

void Check(bool ok, string name, string detail)

{

  Console.WriteLine((ok ? "PASS " : "FAIL ") + name + " :: " + detail);

  if (!ok) failures.Add(name);

}

string? pgCs = null;

for (int i = 0; i < args.Length; i++) if (args[i] == "--pg" && i + 1 < args.Length) pgCs = args[i + 1];



// ---------- memory section ----------

InMemoryStore NewMem() => new InMemoryStore();



// 1. nested success: inner joins, deferred runs once post-commit, in order.

{

  var s = NewMem();

  var order = new List<string>();

  Atomic.Run(s, () => {

    Atomic.Run(s, () => { order.Add("inner"); });

    order.Add("outer-op");

    Atomic.Defer(s, () => order.Add("deferred"));

  });

  Check(order.SequenceEqual(new[] { "inner", "outer-op", "deferred" }), "mem-nested-success-order", string.Join(",", order));

}



// 2. nested failure: full rollback (incl. in-place edit), no deferred, no audit.

{

  var s = NewMem();

  var b = new Board { Name = "t" };

  s.Boards[b.Id] = b;

  int auditsBefore = s.Audit.Count();

  bool threw = false;

  try

  {

    Atomic.Run(s, () =>

    {

      s.Boards[b.Id].Name = "changed";

      Atomic.Run(s, () =>

      {

        var d = new RecordDraft { BoardId = b.Id, MeetingId = Guid.NewGuid(), Version = 1 };

        s.Drafts[d.Id] = d;

        Atomic.Audit(s, new AuditEvent { Action = "probe-x" });

        Atomic.Defer(s, () => { throw new Exception("must-not-run"); });

        throw new InvalidOperationException("inner boom");

      });

    });

  }

  catch (InvalidOperationException) { threw = true; }

  bool rolledBack = s.Boards[b.Id].Name == "t" && !s.Drafts.Values.Any() && s.Audit.Count() == auditsBefore;

  Check(threw && rolledBack, "mem-nested-failure-rollback", "threw=" + threw + " name=" + s.Boards[b.Id].Name);

}



// 3. caught inner failure still forces outer rollback (rollback-only).

{

  var s = NewMem();

  var b = new Board { Name = "t" };

  s.Boards[b.Id] = b;

  bool outerThrew = false;

  string outerMsg = "";

  try

  {

    Atomic.Run(s, () =>

    {

      try { Atomic.Run(s, () => { s.Boards[b.Id].Name = "x"; throw new Exception("boom"); }); }

      catch { }

      s.Boards[b.Id].Name = "y";

    });

  }

  catch (Exception ex) { outerThrew = true; outerMsg = ex.GetType().Name; }

  Check(outerThrew && s.Boards[b.Id].Name == "t", "mem-caught-inner-rollback-only", "threw=" + outerThrew + " " + outerMsg + " name=" + s.Boards[b.Id].Name);

}



// 4. store usable after failure (no poisoned depth).

{

  var s = NewMem();

  try { Atomic.Run(s, () => { throw new Exception("x"); }); } catch { }

  var b2 = new Board { Name = "after" };

  Atomic.Run(s, () => { s.Boards[b2.Id] = b2; });

  Check(s.Boards[b2.Id].Name == "after", "mem-usable-after-failure", "ok");

}



// 5. compensations run LIFO; session removal rolls back.

{

  var s = NewMem();

  var tok = "tok-1";

  s.Sessions[tok] = new SimCEO.Api.Session { Token = tok, Email = "e@x", ExpiresAt = DateTime.UtcNow.AddDays(1) };

  var log = new List<string>();

  try

  {

    Atomic.Run(s, () =>

    {

      Atomic.Compensate(s, () => log.Add("first"));

      s.Sessions.TryRemove(tok, out var prior);

      if (prior is not null) Atomic.Compensate(s, () => { s.Sessions[tok] = prior; });

      Atomic.Compensate(s, () => log.Add("second"));

      throw new Exception("fail");

    });

  }

  catch { }

  Check(log.SequenceEqual(new[] { "second", "first" }) && s.Sessions.ContainsKey(tok), "mem-compensate-lifo-session", string.Join(",", log) + " hasSession=" + s.Sessions.ContainsKey(tok));

}



// 6. audit staged: exactly one on success.

{

  var s = NewMem();

  int before = s.Audit.Count();

  Atomic.Run(s, () => { Atomic.Audit(s, new AuditEvent { Action = "probe-ok" }); });

  Check(s.Audit.Count() == before + 1, "mem-audit-on-success", "count=" + s.Audit.Count());

}



// 7. cross-store isolation.

{

  var a = NewMem(); var c = NewMem();

  var ba = new Board { Name = "a" }; a.Boards[ba.Id] = ba;

  var bc = new Board { Name = "c" }; c.Boards[bc.Id] = bc;

  try { Atomic.Run(a, () => { a.Boards[ba.Id].Name = "changed"; throw new Exception("x"); }); } catch { }

  Check(a.Boards[ba.Id].Name == "a" && c.Boards[bc.Id].Name == "c", "mem-cross-store-isolation", "ok");

}



// 8. failing domain unit never erases installation ledger/spend.

{

  var s = NewMem();

  var u = new UsageRow { Kind = "model-test", Model = "m", Status = "succeeded", At = DateTime.UtcNow };

  s.Usage.Add(u);

  s.Spend.MonthlyCapUsd = 42m;

  var b = new Board { Name = "t" }; s.Boards[b.Id] = b;

  try { Atomic.Run(s, () => { s.Boards[b.Id].Name = "changed"; throw new Exception("boom"); }); } catch { }

  bool ok = s.Boards[b.Id].Name == "t" && s.Usage.Count() == 1 && s.Spend.MonthlyCapUsd == 42m;

  Check(ok, "mem-ledger-preserved-on-domain-rollback", "usage=" + s.Usage.Count());

}



// 8b. three-level: inner throws, middle catches+continues, outer catches+continues.
// Rollback-only must still win; ownership must stay coherent for later units.
{
  var s = NewMem();
  var b = new Board { Name = "t" };
  s.Boards[b.Id] = b;
  int auditsBefore = s.Audit.Count();
  var fx = new List<string>();
  string finalEx = "";
  try
  {
    Atomic.Run(s, () =>
    {
      try
      {
        Atomic.Run(s, () =>
        {
          try { Atomic.Run(s, () => { s.Boards[b.Id].Name = "L3"; throw new Exception("L3 boom"); }); }
          catch { s.Boards[b.Id].Name = "L2-after-catch"; }
        });
      }
      catch { s.Boards[b.Id].Name = "L1-after-catch"; }
    });
  }
  catch (Exception ex) { finalEx = ex.GetType().Name + ":" + ex.Message; }
  Atomic.Run(s, () => { Atomic.Defer(s, () => fx.Add("late-deferred")); });
  bool ok = finalEx.Contains("rollback-only") || finalEx.Contains("refusing commit");
  ok = ok && s.Boards[b.Id].Name == "t" && s.Audit.Count() == auditsBefore && fx.Count == 1;
  Check(ok, "mem-three-level-rollback-only", "ex=" + finalEx + " name=" + s.Boards[b.Id].Name + " fx=" + fx.Count);
}

// 8c. failing compensation surfaces AggregateException (no false "restored").
{
  var s = NewMem();
  Exception? caught = null;
  try
  {
    Atomic.Run(s, () =>
    {
      Atomic.Compensate(s, () => { throw new Exception("compensation boom"); });
      throw new Exception("unit boom");
    });
  }
  catch (Exception ex) { caught = ex; }
  bool isAgg = caught is AggregateException agg && agg.InnerExceptions.Count >= 2;
  Check(isAgg, "mem-compensation-failure-surfaced", "type=" + (caught is null ? "none" : caught.GetType().Name));
}

int memFails = failures.Count;

// 8b. parallel ledger finalization vs failing domain unit (threads).
// Thread 1 holds the domain unit (and root gate) open, then fails; thread 2
// finalizes a ledger pair concurrently (serializes on the gate, then commits).
// The pair must survive the domain rollback; no deadlock.
{
  var s = NewMem();
  var b = new Board { Name = "t" };
  s.Boards[b.Id] = b;
  Exception? t1err = null;
  var t1 = new System.Threading.Thread(() =>
  {
    try
    {
      Atomic.Run(s, () =>
      {
        s.Boards[b.Id].Name = "changed";
        System.Threading.Thread.Sleep(400);
        throw new Exception("domain boom");
      });
    }
    catch (Exception ex) { t1err = ex; }
  });
  t1.IsBackground = true;
  t1.Start();
  System.Threading.Thread.Sleep(100);
  var call = new SimCEO.Api.Work.ModelCall { Model = "m", Purpose = "model-test", Status = "succeeded", At = DateTime.UtcNow };
  var row = new UsageRow { Kind = "model-test", Model = "m", Status = "succeeded", At = DateTime.UtcNow };
  var t2done = false;
  var t2 = new System.Threading.Thread(() =>
  {
    Atomic.Run(s, () => { s.ModelCalls.Add(call); s.Usage.Add(row); });
    t2done = true;
  });
  t2.IsBackground = true;
  t2.Start();
  bool joined1 = t1.Join(10000);
  bool joined2 = t2.Join(10000);
  bool ok = joined1 && joined2 && t1err is not null && s.Boards[b.Id].Name == "t" && s.Usage.Count() == 1 && s.ModelCalls.Count() == 1 && t2done;
  Check(ok, "mem-parallel-ledger-vs-failing-domain", "joined=" + joined1 + "," + joined2 + " usage=" + s.Usage.Count());
}



Console.WriteLine("MEMORY SECTION: " + (failures.Count == 0 ? "ALL PASS" : failures.Count + " FAILURES"));



// ---------- PG section (mandatory when --pg supplied) ----------

if (pgCs is null)

{

  Console.WriteLine("PG SECTION: SKIPPED (no --pg supplied; memory-only run)");

}

else

{

  if (!SimCEO.Postgres.PgBoot.TryWire(pgCs, out var werr))

  {

    Check(false, "pg-wire", werr);

  }

  else

  {

    // 9. real commit through the store unit.

    {

      var s = NewMem();

      var b = new Board { Name = "pg-commit" };

      Atomic.Run(s, () => { s.Boards[b.Id] = b; });

      Check(s.Boards.TryGetValue(b.Id, out var rb) && rb is not null && rb.Name == "pg-commit", "pg-real-commit", "ok");

    }

    // 10. injected COMMIT failure rolls back rows + journaled session, no audit.

    {

      var s = NewMem();

      var b = new Board { Name = "pg-seed" };

      Atomic.Run(s, () => { s.Boards[b.Id] = b; });

      var tok = "pg-tok-" + Guid.NewGuid().ToString("N");

      s.Sessions[tok] = new SimCEO.Api.Session { Token = tok, Email = "e@x", ExpiresAt = DateTime.UtcNow.AddDays(1) };

      int auditsBefore = s.Audit.Count();

      bool threw = false;

      SimCEO.Api.Data.PgFaults.FailBeforeCommit = () => true;

      try

      {

        Atomic.Run(s, () =>

        {

          s.Boards[b.Id].Name = "changed";

          var d = new RecordDraft { BoardId = b.Id, MeetingId = Guid.NewGuid(), Version = 1 };

          s.Drafts[d.Id] = d;

          s.Sessions.TryRemove(tok, out var prior);

          if (prior is not null) Atomic.Compensate(s, () => { s.Sessions[tok] = prior; });

          Atomic.Audit(s, new AuditEvent { Action = "probe-pg" });

        });

      }

      catch (InvalidOperationException) { threw = true; }

      finally { SimCEO.Api.Data.PgFaults.FailBeforeCommit = null; }

      bool rolledBack = false;

      try

      {

        rolledBack = s.Boards[b.Id].Name == "pg-seed" && !s.Drafts.Values.Any(x => x.BoardId == b.Id && x.Version == 1 && x.ItemsJson == "[]") && s.Sessions.ContainsKey(tok) && s.Audit.Count() == auditsBefore;

      }

      catch (Exception ex) { Check(false, "pg-commit-fault-verify", ex.GetType().Name + ": " + ex.Message); }

      Check(threw && rolledBack, "pg-commit-fault-rollback", "threw=" + threw);

    }

    // 10b. PG caught-inner failure: op catches, continues, mutates more.
    // The commit must still be refused; rows/audit/deferred exact.
    {
      var s = NewMem();
      var b = new Board { Name = "t" };
      Atomic.Run(s, () => { s.Boards[b.Id] = b; });
      var d0 = new RecordDraft { BoardId = b.Id, MeetingId = Guid.NewGuid(), Version = 1, ItemsJson = "[{\"id\":\"m1\"}]", Hash = "h", ApprovedJson = "[]", DiscardedJson = "[]", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", ReviewToken = "tok", ReviewRevision = 1 };
      Atomic.Run(s, () => { s.Drafts[d0.Id] = d0; });
      int auditsBefore = s.Audit.Count();
      var fx = new List<string>();
      string finalEx = "";
      try
      {
        Atomic.Run(s, () =>
        {
          s.Boards[b.Id].Name = "changed-once";
          try
          {
            Atomic.Run(s, () =>
            {
              s.Boards[b.Id].Name = "changed-twice";
              s.Drafts[d0.Id] = new RecordDraft { Id = d0.Id, BoardId = b.Id, MeetingId = d0.MeetingId, Version = 2, ItemsJson = d0.ItemsJson, Hash = "h2", ApprovedJson = "[]", DiscardedJson = "[]", HistoryJson = "[]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", ReviewToken = "tok2", ReviewRevision = 2 };
              Atomic.Audit(s, new AuditEvent { Action = "probe-inner" });
              Atomic.Defer(s, () => fx.Add("must-not-run"));
              throw new Exception("inner boom");
            });
          }
          catch { s.Boards[b.Id].Name = "changed-after-catch"; }
        });
      }
      catch (Exception ex) { finalEx = ex.GetType().Name + ":" + ex.Message; }
      bool exact = false;
      try
      {
        exact = s.Boards[b.Id].Name == "t"
          && s.Drafts.TryGetValue(d0.Id, out var rd) && rd is not null && rd.Version == 1 && rd.Hash == "h"
          && s.Audit.Count() == auditsBefore && fx.Count == 0;
      }
      catch (Exception ex) { Check(false, "pg-caught-inner-verify", ex.GetType().Name + ": " + ex.Message); }
      Check(finalEx.Contains("refusing commit") && exact, "pg-caught-inner-rollback-only", "ex=" + finalEx);
      Atomic.Run(s, () => { Atomic.Defer(s, () => fx.Add("late-ok")); });
      Check(fx.Count == 1, "pg-unit-usable-after-abort", "fx=" + fx.Count);
    }
    // 11. nested PG failure rolls back outer too.

    {

      var s = NewMem();

      var b = new Board { Name = "pg-nest" };

      bool threw = false;

      try

      {

        Atomic.Run(s, () =>

        {

          s.Boards[b.Id] = b;

          Atomic.Run(s, () => { s.Boards[b.Id].Name = "inner"; throw new Exception("inner"); });

        });

      }

      catch { threw = true; }

      bool gone = !s.Boards.TryGetValue(b.Id, out _);

      Check(threw && gone, "pg-nested-failure-rollback", "threw=" + threw + " gone=" + gone);

    }

    // 11b. PG three-level middle-catches/outer-catches.
    {
      var s = NewMem();
      var b = new Board { Name = "t" };
      Atomic.Run(s, () => { s.Boards[b.Id] = b; });
      int auditsBefore = s.Audit.Count();
      string finalEx = "";
      try
      {
        Atomic.Run(s, () =>
        {
          try
          {
            Atomic.Run(s, () =>
            {
              try { Atomic.Run(s, () => { s.Boards[b.Id].Name = "L3"; throw new Exception("L3 boom"); }); }
              catch { s.Boards[b.Id].Name = "L2-after-catch"; }
            });
          }
          catch { s.Boards[b.Id].Name = "L1-after-catch"; }
        });
      }
      catch (Exception ex) { finalEx = ex.GetType().Name + ":" + ex.Message; }
      bool exact = false;
      try { exact = s.Boards[b.Id].Name == "t" && s.Audit.Count() == auditsBefore; }
      catch (Exception ex) { Check(false, "pg-three-level-verify", ex.GetType().Name); }
      Check((finalEx.Contains("rollback-only") || finalEx.Contains("refusing commit")) && exact, "pg-three-level-rollback-only", "ex=" + finalEx);
      var ok = false;
      Atomic.Run(s, () => { s.Boards[b.Id].Name = "after"; ok = true; });
      Check(ok && s.Boards[b.Id].Name == "after", "pg-unit-usable-after-abort3", "ok=" + ok);
    }
    // 12b. foreign nesting throws instead of joining the wrong transaction.
    {
      var s = NewMem();
      bool threwForeign = false;
      Atomic.Run(() =>
      {
        try { Atomic.Run(s, () => { }); }
        catch (InvalidOperationException) { threwForeign = true; }
      });
      Check(threwForeign, "pg-foreign-nesting-throws", "threw=" + threwForeign);
    }
    // 12. PG ledger pair survives failing domain unit (parallel-ish: pair first, then fail).

    {

      var s = NewMem();

      var call = new SimCEO.Api.Work.ModelCall { Model = "m", Purpose = "model-test", Status = "succeeded", At = DateTime.UtcNow };

      var row = new UsageRow { Kind = "model-test", Model = "m", Status = "succeeded", At = DateTime.UtcNow };

      Atomic.Run(s, () => { s.ModelCalls.Add(call); s.Usage.Add(row); });

      int u0 = s.Usage.Count(); int m0 = s.ModelCalls.Count();

      var b = new Board { Name = "t" }; s.Boards[b.Id] = b;

      try { Atomic.Run(s, () => { s.Boards[b.Id].Name = "changed"; throw new Exception("boom"); }); } catch { }

      bool ok = s.Boards[b.Id].Name == "t" && s.Usage.Count() == u0 && s.ModelCalls.Count() == m0;

      Check(ok, "pg-ledger-preserved-on-domain-rollback", "u=" + s.Usage.Count() + " m=" + s.ModelCalls.Count());

    }

  }

}



Console.WriteLine("PROBE RESULT: " + (failures.Count == 0 ? "PASS" : "FAIL " + failures.Count) + " (memFails=" + memFails + ")");

return failures.Count == 0 ? 0 : 1;