# Essentials Evidence QA (Muse second repair)

Probe: qa/essentials-evidence/essentials-evidence.csproj (net10.0, references SimCEO.Api + SimCEO.Postgres).
Runner: `powershell -File qa/essentials-evidence/run-evidence-qa.ps1` (fresh native build,
in-process probe, per-run `artifacts/<stamp>_<id>/` logs, strict nonzero on any failure).
Direct: `dotnet build qa/essentials-evidence/essentials-evidence.csproj -c Release`, then run the
built exe with `PGCS` (default `Host=127.0.0.1;Port=15441;Database=postgres;Username=simceo;Password=qa-only`)
and optional `ESSENTIALS_ARTIFACT_DIR`.

Scope: memory domain helpers plus actual PG on the shared simceo-integration-qa-pg:15441 with NEW
exclusive `essentials_evidence_*` GUID DBs. No drops of old DBs (primary `..._1d7f5f17316d` and all
prior proof DBs verified present before AND after). No container stop/rm, no shared-DB writes,
no foreign DB ops. No ports bound. No user 5080/5173/9333 touches.

PG section is MANDATORY (no SKIP: any PG failure exits nonzero). One validated owned
container/connection identity: every connection string derives from the single validated
PGCS (host 127.0.0.1, port 15441, user simceo); the engine/database identity is verified
behaviorally and prior proof DBs prove the shared QA lineage. Cleanup (seam reset, PG
trigger/function drop, context dispose, owned-DB drop, backend restore, prior-DB re-verify)
runs in an acquisition-safe FINALLY; any cleanup error fails the run.

What it proves (discriminating, not merely containing):
F1 shared STRICT record parser (bare GUID whole-record only; `A:`/`A: `/guid+`:`/spaces composites
rejected, never whole-record fallback) + all three Secretary consumers (canonicalize exact
item/quote scope, packet item lines, availability current/replaced/malformed) + legacy
bare-GUID briefing preserved.
F2 complete staged restore validator: real amend A->B chain validates; 15 corruptions
(numeric/missing-actor/detached-tip history, overlap, A->B->A cycle, missing/cross-scope parent,
undeclared/version-mismatch/cross-version-dup/unapproved/empty-bytes snapshots, outside-approved
history action, unknown status, token/history detachment) each reject with the prewrite control
byte-identical; genuine old v2 PRIMARY backup drafts (blank token/history/snapshots) accepted
with bytes preserved, reads lenient, mutations closed.
F3 snapshot approval/version correspondence: alias requested1/resolved3 available v3,
unrelated999 unavailable, one coherent capture per target, no fabricated availability.
F4 alias readback: EXACTLY ONE available canonical3 card after capture assignment, bytes
unchanged; unversioned v1 one-card kept.
F5 live explicit record-item Current follows the EFFECTIVE referenced owner (A:s1 BUY replaced
by B:s1 CUT is live-unavailable, stored-readable-noncurrent, B:s1 live-current); malformed
composites unavailable; no bare-ref broadening.
F6 consistent typed validation both export modes (numeric detail/status/scope, non-array refs,
numeric kind/ref/id/version, unapproved-item fields, ghost/numeric approved) + resolver cards
(fractional version fails closed with zero cards vs one unavailable card for valid-but-unknown
pins; empty/invalid approved content never available).
F7 per-run artifacts (source SHA, API/PG DLL hashes, PG identity/DB, build/test native exits in
runner.log + probe run.log; never overwritten), single identity, finally cleanup.
F8 real inner-callback fault (code-only seam AFTER staged writes, predecessor inner-catch would
commit partials and fail `threwFin`) with FULL prior field/byte/ID comparison across all
families + reservation map and contrasting raw-SQL observation; healthy retry persisted-complete;
retained PG trigger case correctly labeled as post-callback save/commit-sequence fault with the
same full comparison.
