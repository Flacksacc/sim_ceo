using System.Reflection;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

// Essentials backend correction proofs (Muse-authored, narrow): actual
// ModelGateway.RecordFull pair path (never a surrogate table), memory + PG.
// Exit nonzero on any failure. PG section is MANDATORY when --pg is supplied.
var failures = new List<string>();
void Check(bool ok, string name, string detail)
{
  Console.WriteLine((ok ? "PASS " : "FAIL ") + name + " :: " + detail);
  if (!ok) failures.Add(name);
}
string? pgCs = null;
for (int i = 0; i < args.Length; i++) if (args[i] == "--pg" && i + 1 < args.Length) pgCs = args[i + 1];

MethodInfo RecFull() => typeof(ModelGateway).GetMethod("RecordFull", BindingFlags.NonPublic | BindingFlags.Instance)!;
void RecordPair(ModelGateway gw, Guid callId)
{
  RecFull().Invoke(gw, new object?[] { callId, "probe-model", "probe", 10, 1, 5, 12L, false, 0, "succeeded", "pid-" + callId.ToString("N").Substring(0, 8), 0.001m, "probe-basis", "", null, null });
}
(int usage, int calls) LedgerCounts(InMemoryStore s) => (s.Usage.Count(), s.ModelCalls.Count());
bool LedgerHas(InMemoryStore s, Guid id) => s.Usage.Any(u => u.Id == id) && s.ModelCalls.Any(c => c.Id == id);
string NormAt(string json) { using var d = System.Text.Json.JsonDocument.Parse(json); var r = d.RootElement; var at = r.TryGetProperty("At", out var a) ? a.GetString() ?? "" : (r.TryGetProperty("at", out var a2) ? a2.GetString() ?? "" : ""); return string.IsNullOrEmpty(at) ? json : json.Replace(at, "AT"); }
bool SameRow(string a, string b) => NormAt(a) == NormAt(b);
// ---------- memory: concurrent gateway pairs, both complete prior ledgers ----------
{
  var s = new InMemoryStore();
  var gw = new ModelGateway(s);
  var prior = Guid.NewGuid();
  RecordPair(gw, prior);
  var (u0, c0) = LedgerCounts(s);
  var ids = Enumerable.Range(0, 8).Select(_ => Guid.NewGuid()).ToList();
  var errs = new System.Collections.Concurrent.ConcurrentBag<Exception>();
  System.Threading.Tasks.Parallel.ForEach(ids, id => { try { RecordPair(gw, id); } catch (Exception ex) { errs.Add(ex); } });
  var (u1, c1) = LedgerCounts(s);
  Check(errs.IsEmpty, "mem-gateway-concurrent-noerror", "errs=" + errs.Count);
  Check(u1 == u0 + 8 && c1 == c0 + 8, "mem-gateway-both-complete", "u" + u0 + "->" + u1 + " c" + c0 + "->" + c1);
  Check(LedgerHas(s, prior) && ids.All(id => LedgerHas(s, id)), "mem-gateway-prior-plus-all", "prior+8 present");
}
// ---------- memory: failing pair cannot erase a concurrent completed pair ----------
{
  var s = new InMemoryStore();
  var gw = new ModelGateway(s);
  var prior = Guid.NewGuid();
  RecordPair(gw, prior);
  var victim = Guid.NewGuid();
  var completer = Guid.NewGuid();
  var victimInUnit = new ManualResetEventSlim(false);
  var completerStarted = new ManualResetEventSlim(false);
  Exception? victimEx = null;
  var fired = 0;
  ModelGateway.FailNextAppend = () => { if (System.Threading.Interlocked.Exchange(ref fired, 1) == 1) return false; victimInUnit.Set(); completerStarted.Wait(TimeSpan.FromSeconds(10)); return true; };
  var vt = new Thread(() => { try { RecordPair(gw, victim); } catch (Exception ex) { victimEx = ex; } });
  var ct = new Thread(() => { victimInUnit.Wait(TimeSpan.FromSeconds(10)); completerStarted.Set(); try { RecordPair(gw, completer); } catch { } });
  try
  {
    vt.Start(); ct.Start();
    vt.Join(TimeSpan.FromSeconds(20)); ct.Join(TimeSpan.FromSeconds(20));
    var sawStorageFault = victimEx is UsageStorageException || (victimEx is TargetInvocationException tie && tie.InnerException is UsageStorageException);
    Check(sawStorageFault, "mem-gateway-victim-fault", victimEx?.GetType().Name ?? "none");
    Check(LedgerHas(s, prior), "mem-gateway-prior-survives", "prior present");
    Check(LedgerHas(s, completer), "mem-gateway-completer-survives", "completer present");
    Check(!s.Usage.Any(u => u.Id == victim) && !s.ModelCalls.Any(c => c.Id == victim), "mem-gateway-victim-absent", "no partial pair");
  }
  finally { ModelGateway.FailNextAppend = null; }
}
// ---------- memory: foreign-thread audit survives an unrelated unit rollback ----------
{
  var s = new InMemoryStore();
  var entered = new ManualResetEventSlim(false);
  var ot = new Thread(() =>
  {
    try { Atomic.Run(s, () => { entered.Set(); Thread.Sleep(500); throw new InvalidOperationException("boom"); }); }
    catch { }
  });
  var ft = new Thread(() => { entered.Wait(TimeSpan.FromSeconds(10)); Atomic.DeferOrRun(s, () => s.Audit.Add(new AuditEvent { Action = "probe.foreign", Detail = "x" })); });
  ot.Start(); ft.Start();
  ot.Join(TimeSpan.FromSeconds(20)); ft.Join(TimeSpan.FromSeconds(20));
  Check(s.Audit.Any(a => a.Action == "probe.foreign"), "mem-foreign-audit-survives", "audit present after unrelated rollback");
}
// ---------- memory: genuine partial pair (fault BETWEEN appends) rolls back fully ----------
{
  var s = new InMemoryStore();
  var gw = new ModelGateway(s);
  var prior = Guid.NewGuid();
  RecordPair(gw, prior);
  var priorU = System.Text.Json.JsonSerializer.Serialize(s.Usage.First(u => u.Id == prior));
  var priorC = System.Text.Json.JsonSerializer.Serialize(s.ModelCalls.First(c => c.Id == prior));
  var victim = Guid.NewGuid();
  var firedM = 0;
  ModelGateway.FailAfterFirstAppend = () => { if (System.Threading.Interlocked.Exchange(ref firedM, 1) == 1) return false; return true; };
  Exception? vExM = null;
  try { RecordPair(gw, victim); } catch (Exception ex) { vExM = ex; }
  finally { ModelGateway.FailAfterFirstAppend = null; }
  var sawM = vExM is UsageStorageException || (vExM is TargetInvocationException tm && tm.InnerException is UsageStorageException);
  Check(sawM, "mem-gateway-midpair-fault", vExM?.GetType().Name ?? "none");
  Check(!s.Usage.Any(u => u.Id == victim) && !s.ModelCalls.Any(c => c.Id == victim), "mem-gateway-midpair-no-partial", "victim fully absent");
  Check(LedgerHas(s, prior), "mem-gateway-midpair-prior-survives", "prior present");
  var priorUA = System.Text.Json.JsonSerializer.Serialize(s.Usage.First(u => u.Id == prior));
  var priorCA = System.Text.Json.JsonSerializer.Serialize(s.ModelCalls.First(c => c.Id == prior));
  Check(SameRow(priorU, priorUA) && SameRow(priorC, priorCA), "mem-gateway-midpair-prior-fields", "prior fields identical");
}
// ---------- memory: owner-thread immediate effect still runs outside any unit ----------
{
  var s = new InMemoryStore();
  Atomic.DeferOrRun(s, () => s.Audit.Add(new AuditEvent { Action = "probe.direct", Detail = "y" }));
  Check(s.Audit.Any(a => a.Action == "probe.direct"), "mem-direct-effect-runs", "immediate effect ran");
}
// ---------- memory: post-commit effect fault is PostCommit, state committed ----------
{
  var s = new InMemoryStore();
  var b = new Board { Name = "pc" };
  Exception? seen = null;
  try { Atomic.Run(s, () => { s.Boards[b.Id] = b; Atomic.Defer(s, () => throw new InvalidOperationException("fx-boom")); }); }
  catch (Exception ex) { seen = ex; }
  Check(seen is PostCommitException, "mem-postcommit-type", seen?.GetType().Name ?? "none");
  Check(s.Boards.TryGetValue(b.Id, out _), "mem-postcommit-committed", "row present");
}
// ---------- memory: failing policy update rolls back (Spend in capture) ----------
{
  var s = new InMemoryStore();
  PolicyStore.WriteSpend(s, 5m, "warn");
  try { Atomic.Run(s, () => { PolicyStore.WriteSpend(s, 99m, "block"); throw new InvalidOperationException("nope"); }); }
  catch { }
  var (cap, mode) = PolicyStore.ReadSpend(s);
  Check(cap == 5m && mode == "warn", "mem-spend-rollback", "cap=" + cap + " mode=" + mode);
}
Console.WriteLine("MEMORY SECTION: " + (failures.Count == 0 ? "ALL PASS" : failures.Count + " FAILURES"));
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
    {
      var s = new InMemoryStore();
      var gw = new ModelGateway(s);
      var prior = Guid.NewGuid();
      RecordPair(gw, prior);
      var (u0, c0) = LedgerCounts(s);
      var ids = Enumerable.Range(0, 8).Select(_ => Guid.NewGuid()).ToList();
      var errs = new System.Collections.Concurrent.ConcurrentBag<Exception>();
      System.Threading.Tasks.Parallel.ForEach(ids, id => { try { RecordPair(gw, id); } catch (Exception ex) { errs.Add(ex); } });
      var (u1, c1) = LedgerCounts(s);
      Check(errs.IsEmpty, "pg-gateway-concurrent-noerror", "errs=" + errs.Count);
      Check(u1 == u0 + 8 && c1 == c0 + 8, "pg-gateway-both-complete", "u" + u0 + "->" + u1 + " c" + c0 + "->" + c1);
      Check(LedgerHas(s, prior) && ids.All(id => LedgerHas(s, id)), "pg-gateway-prior-plus-all", "prior+8 present");
    }
    {
      var s = new InMemoryStore();
      var gw = new ModelGateway(s);
      var prior = Guid.NewGuid();
      RecordPair(gw, prior);
      var victim = Guid.NewGuid();
      var completer = Guid.NewGuid();
      var victimInUnit = new ManualResetEventSlim(false);
      var completerStarted = new ManualResetEventSlim(false);
      Exception? victimEx = null;
      var firedPg = 0;
      ModelGateway.FailNextAppend = () => { if (System.Threading.Interlocked.Exchange(ref firedPg, 1) == 1) return false; victimInUnit.Set(); completerStarted.Wait(TimeSpan.FromSeconds(15)); return true; };
      var vt = new Thread(() => { try { RecordPair(gw, victim); } catch (Exception ex) { victimEx = ex; } });
      var ct = new Thread(() => { victimInUnit.Wait(TimeSpan.FromSeconds(15)); completerStarted.Set(); try { RecordPair(gw, completer); } catch { } });
      try
      {
        vt.Start(); ct.Start();
        vt.Join(TimeSpan.FromSeconds(30)); ct.Join(TimeSpan.FromSeconds(30));
        var sawStorageFault = victimEx is UsageStorageException || (victimEx is TargetInvocationException tie && tie.InnerException is UsageStorageException);
        Check(sawStorageFault, "pg-gateway-victim-fault", victimEx?.GetType().Name ?? "none");
        Check(LedgerHas(s, prior), "pg-gateway-prior-survives", "prior present");
        Check(LedgerHas(s, completer), "pg-gateway-completer-survives", "completer present");
        Check(!s.Usage.Any(u => u.Id == victim) && !s.ModelCalls.Any(c => c.Id == victim), "pg-gateway-victim-absent", "no partial pair");
      }
      finally { ModelGateway.FailNextAppend = null; }
    }
    {
      {
      var pgm = new InMemoryStore();
      var gw = new ModelGateway(pgm);
      var prior = Guid.NewGuid();
      RecordPair(gw, prior);
      var priorU = System.Text.Json.JsonSerializer.Serialize(pgm.Usage.First(u => u.Id == prior));
      var priorC = System.Text.Json.JsonSerializer.Serialize(pgm.ModelCalls.First(c => c.Id == prior));
      var victim = Guid.NewGuid();
      var firedP = 0;
      ModelGateway.FailAfterFirstAppend = () => { if (System.Threading.Interlocked.Exchange(ref firedP, 1) == 1) return false; return true; };
      Exception? vExP = null;
      try { RecordPair(gw, victim); } catch (Exception ex) { vExP = ex; }
      finally { ModelGateway.FailAfterFirstAppend = null; }
      var sawP = vExP is UsageStorageException || (vExP is TargetInvocationException tp && tp.InnerException is UsageStorageException);
      Check(sawP, "pg-gateway-midpair-fault", vExP?.GetType().Name ?? "none");
      Check(!pgm.Usage.Any(u => u.Id == victim) && !pgm.ModelCalls.Any(c => c.Id == victim), "pg-gateway-midpair-no-partial", "victim fully absent after mid-pair fault");
      Check(LedgerHas(pgm, prior), "pg-gateway-midpair-prior-survives", "prior present");
      var sf0 = new InMemoryStore();
      Check(sf0.Usage.Any(u => u.Id == prior) && sf0.ModelCalls.Any(c => c.Id == prior), "pg-gateway-midpair-prior-durable", "prior durable in fresh store");
      var priorUA = System.Text.Json.JsonSerializer.Serialize(sf0.Usage.First(u => u.Id == prior));
      var priorCA = System.Text.Json.JsonSerializer.Serialize(sf0.ModelCalls.First(c => c.Id == prior));
      Check(SameRow(priorU, priorUA) && SameRow(priorC, priorCA), "pg-gateway-midpair-prior-fields", "prior fields identical across stores (At normalized: PG truncates to microseconds)");
    }
    { // failed FIRST policy write with no singleton present: effective + durable unchanged
      var pgf = new InMemoryStore();
      try { Pg.Backend!.Remove<InstallationPolicy>(PolicyStore.SingletonId); Pg.Backend.Save(); } catch { }
      var (bCap0, bMode0) = PolicyStore.ReadSpend(pgf);
      var firedFb = 0;
      PgFaults.FailBeforeCommit = () => System.Threading.Interlocked.Exchange(ref firedFb, 1) == 0;
      Exception? fbEx = null;
      try { Atomic.Run(pgf, () => { PolicyStore.WriteSpend(pgf, 4242m, "block"); }); }
      catch (Exception ex) { fbEx = ex; }
      finally { PgFaults.FailBeforeCommit = null; }
      var (bCap1, bMode1) = PolicyStore.ReadSpend(pgf);
      var sf = new InMemoryStore();
      var (bCapF, bModeF) = PolicyStore.ReadSpend(sf);
      Check(fbEx is not null, "pg-first-policy-write-fails", fbEx?.GetType().Name ?? "none");
      Check(bCap1 == bCap0 && bMode1 == bMode0, "pg-first-policy-effective-unchanged", "cap=" + (bCap1?.ToString() ?? "null") + " mode=" + bMode1);
      Check(bCapF == bCap0 && bModeF == bMode0, "pg-first-policy-durable-unchanged", "fresh cap=" + (bCapF?.ToString() ?? "null") + " mode=" + bModeF);
    }
    { // policy lookup outage fails closed: no defaults, no different-key fallback
      var pgl = new InMemoryStore();
      PgFaults.FailPolicyLookup = () => true;
      Exception? lkEx = null;
      try { _ = PolicyStore.ReadSpend(pgl); } catch (Exception ex) { lkEx = ex; }
      Exception? lkEx2 = null;
      try { _ = PolicyStore.ReadChatModel(pgl); } catch (Exception ex) { lkEx2 = ex; }
      Exception? capEx = null;
      try { new ModelGateway(pgl).ThrowIfCapped(false); } catch (Exception ex) { capEx = ex; }
      PgFaults.FailPolicyLookup = null;
      Check(lkEx is PolicyUnavailableException, "pg-policy-spend-fails-closed", lkEx?.GetType().Name ?? "none");
      Check(lkEx2 is PolicyUnavailableException, "pg-policy-chat-fails-closed", lkEx2?.GetType().Name ?? "none");
      Check(capEx is PolicyUnavailableException, "pg-policy-cap-fails-closed", capEx?.GetType().Name ?? "none");
    }
    { // genuine DEFERRED constraint: violation surfaces at COMMIT, rolls back honestly
      var pgd = new InMemoryStore();
      Atomic.Run(pgd, () => { PolicyStore.WriteSpend(pgd, 7m, "block"); });
      using (var conn = new Npgsql.NpgsqlConnection(pgCs!)) { conn.Open(); using var cmd = new Npgsql.NpgsqlCommand("ALTER TABLE \"InstallationPolicies\" ADD CONSTRAINT \"chk_probe_deferred\" EXCLUDE USING btree (\"Mode\" WITH =) DEFERRABLE INITIALLY DEFERRED", conn); cmd.ExecuteNonQuery(); }
      Exception? defEx = null;
      try { Atomic.Run(pgd, () => { Pg.Backend!.Upsert(new InstallationPolicy { Id = Guid.NewGuid(), MonthlyCapUsd = 1m, Mode = "block" }); Pg.Backend.Save(); }); }
      catch (Exception ex) { defEx = ex; }
      finally { try { using var conn2 = new Npgsql.NpgsqlConnection(pgCs!); conn2.Open(); using var cmd2 = new Npgsql.NpgsqlCommand("ALTER TABLE \"InstallationPolicies\" DROP CONSTRAINT \"chk_probe_deferred\"", conn2); cmd2.ExecuteNonQuery(); } catch { } }
      var (dCap, dMode) = PolicyStore.ReadSpend(pgd);
      var sdf = new InMemoryStore();
      var (dCapF, dModeF) = PolicyStore.ReadSpend(sdf);
      Check(defEx is not null && defEx is not CommitUnknownException, "pg-deferred-commit-fails-rolledback", defEx?.GetType().Name ?? "none");
      Check(dCap == 7m && dMode == "block", "pg-deferred-effective-unchanged", "cap=" + (dCap?.ToString() ?? "null") + " mode=" + dMode);
      Check(dCapF == 7m && dModeF == "block", "pg-deferred-durable-unchanged", "fresh cap=" + (dCapF?.ToString() ?? "null") + " mode=" + dModeF);
    }
    { // real commit + lost acknowledgement: UNKNOWN outcome, state ADOPTED (not rolled back)
      var pga = new InMemoryStore();
      var firedAck = 0;
      PgFaults.FailAfterCommitAck = () => System.Threading.Interlocked.Exchange(ref firedAck, 1) == 0;
      Exception? ackEx = null;
      try { Atomic.Run(pga, () => { PolicyStore.WriteSpend(pga, 11m, "warn"); }); }
      catch (Exception ex) { ackEx = ex; }
      finally { PgFaults.FailAfterCommitAck = null; }
      var (aCap, aMode) = PolicyStore.ReadSpend(pga);
      var saf = new InMemoryStore();
      var (aCapF, aModeF) = PolicyStore.ReadSpend(saf);
      Check(ackEx is CommitUnknownException, "pg-lostack-unknown", ackEx?.GetType().Name ?? "none");
      Check(aCapF == 11m && aModeF == "warn", "pg-lostack-durable-adopted", "fresh cap=" + (aCapF?.ToString() ?? "null") + " mode=" + aModeF);
      Check(aCap == 11m && aMode == "warn", "pg-lostack-effective-adopted", "cap=" + (aCap?.ToString() ?? "null") + " mode=" + aMode);
    }
      var s = new InMemoryStore();
      Atomic.Run(s, () => { PolicyStore.WriteSpend(s, 7m, "block"); });
      var s2 = new InMemoryStore();
      var (cap2, mode2) = PolicyStore.ReadSpend(s2);
      Check(cap2 == 7m && mode2 == "block", "pg-spend-durable-fresh", "cap=" + cap2 + " mode=" + mode2);
      try { Atomic.Run(s2, () => { PolicyStore.WriteSpend(s2, 1m, "warn"); throw new InvalidOperationException("nope"); }); }
      catch { }
      var s3 = new InMemoryStore();
      var (cap3, mode3) = PolicyStore.ReadSpend(s3);
      Check(cap3 == 7m && mode3 == "block", "pg-spend-rollback-durable", "cap=" + cap3 + " mode=" + mode3);
    }
  }
  Console.WriteLine("PG SECTION: " + (failures.Count == 0 ? "ALL PASS" : failures.Count + " FAILURES"));
}
Console.WriteLine(failures.Count == 0 ? "ESS-PROBE PASS" : "ESS-PROBE FAIL " + failures.Count + " :: " + string.Join(",", failures));
return failures.Count == 0 ? 0 : 1;
