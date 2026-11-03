param([string]$Leg = "all")
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $PSCommandPath
$root = (Resolve-Path (Join-Path $here "../..")).Path
$tmp = (Split-Path -Parent $root)
$runId = [Guid]::NewGuid().ToString("N").Substring(0, 8)
$art = Join-Path $here ("art-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + $runId)
New-Item -ItemType Directory -Force -Path $art | Out-Null
$pub = Join-Path $art "pub"
$pgHost = "127.0.0.1"
$pgPort = "15441"
$pgUser = "simceo"
$pgPw = "qa-only"
$pgCtn = "simceo-integration-qa-pg"
$pgCtnIdFull = "14bcfcf7a243e5bc73385da4d24a33475b6eab0b04b8185e1d53a4c13d1a1891"
$procs = @()
$subs = @()
$fail = 0
$dbA = $null; $dbP = $null; $dbU = $null; $dbF = $null; $dbClone = $null
function Fail([string]$name, [string]$detail) { Write-Host ("  FAIL " + $name + " " + $detail); $script:fail++ }
function Check([string]$name, [bool]$cond, [string]$detail) {
  if ($cond) { Write-Host ("  ok " + $name + " " + $detail) } else { Fail $name $detail }
}
function PortFree([int]$port) {
  try { $c = New-Object System.Net.Sockets.TcpClient; $iar = $c.BeginConnect("127.0.0.1", $port, $null, $null); $ok = $iar.AsyncWaitHandle.WaitOne(400); $conn = $c.Connected; $c.Close(); return -not ($ok -and $conn) } catch { return $true }
}
function PgExec([string]$db, [string]$sql) {
  # Checked native exit: every SQL helper call is an attributed gate step.
  $out = docker exec $pgCtn psql -v ON_ERROR_STOP=1 -U $pgUser -d $db -t -A -c $sql 2>&1
  if ($LASTEXITCODE -ne 0) { throw "psql failed (exit $LASTEXITCODE) db=$db sql=$sql :: $out" }
  return $out
}
function PgExecQ([string]$db, [string]$sql) {
  $f = Join-Path $tmp ("essddl-" + [Guid]::NewGuid().ToString("N") + ".sql")
  Set-Content -Path $f -Value $sql -NoNewline
  try {
    $out = Get-Content -Raw $f | docker exec -i $pgCtn psql -v ON_ERROR_STOP=1 -U $pgUser -d $db -t -A -q 2>&1
    if ($LASTEXITCODE -ne 0) { throw "psql(Q) failed (exit $LASTEXITCODE) db=$db sql=$sql :: $out" }
    return $out
  } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue }
}
function Preflight() {
  # Fail BEFORE acquisition: a busy port, a down PG, or a wrong container
  # identity aborts the run instead of racing foreign processes or writing
  # into someone else's database. Nothing is owned yet, so throw is safe.
  foreach ($p in @(5140, 5143, 5144, 5240)) {
    if (-not (PortFree $p)) { throw "preflight: port $p is busy (foreign holder?); refusing to acquire. Free it or pick another lane." }
  }
  Write-Host "preflight: ports 5140/5143/5144/5240 free"
  $cid = ""
  try { $cid = (docker inspect -f '{{.Id}}' $pgCtn 2>$null | Select-Object -First 1).Trim() } catch {}
  if (-not [string]::Equals(($cid | Out-String).Trim(), $pgCtnIdFull, [StringComparison]::OrdinalIgnoreCase)) { throw "preflight: container $pgCtn identity mismatch (need full 64-hex $pgCtnIdFull); refusing to touch it." }
  $pm = ""
  try { $pm = (docker port $pgCtn 5432 2>$null | Out-String) } catch {}
  if (($pm | Out-String) -notmatch "127\.0\.0\.1:15441") { throw "preflight: container $pgCtn does not publish exact 127.0.0.1:15441; refusing to use it." }
  Write-Host ("preflight: container identity ok id=" + $cid.Substring(0, 12) + " portmap ok")
  $one = PgExec "postgres" "select 1"
  if (($one | Out-String).Trim() -ne "1") { throw "preflight: shared PG select 1 failed; refusing to proceed." }
  $dbid = PgExec "postgres" "select current_database() || '/' || version()"
  Write-Host ("preflight: shared PG up :: " + (($dbid | Out-String).Trim().Substring(0, 60)))
}
function Wait-Http([string]$url, [int]$secs = 90) {
  $deadline = (Get-Date).AddSeconds($secs)
  while ((Get-Date) -lt $deadline) {
    try { $r = Invoke-WebRequest -Uri $url -TimeoutSec 3 -UseBasicParsing; if ($r.StatusCode -eq 200) { return $true } } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $false
}
function Wait-PortClosed([int]$port, [int]$secs = 30) {
  $deadline = (Get-Date).AddSeconds($secs)
  while ((Get-Date) -lt $deadline) {
    if (PortFree $port) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}
function Start-Hidden([string]$file, [string]$argline, [string]$out, [string]$err, $envmap, [string]$workdir) {
  # Ownership is registered IMMEDIATELY (before Start) so any later exception
  # still cleans the process up; only THIS runner's subscriptions are tracked.
  # Stdout/stderr drain concurrently from first start via async events; EOF is
  # signaled by null Data (bounded wait in Stop-Hidden, no sleep-as-proof).
  $before = @(Get-EventSubscriber | Select-Object -ExpandProperty SubscriptionId)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $file; $psi.Arguments = $argline
  $psi.WorkingDirectory = $workdir
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = $true; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  foreach ($k in $envmap.Keys) { $psi.Environment[$k] = $envmap[$k] }
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  $outW = New-Object System.IO.StreamWriter("$tmp/$out", $false)
  $errW = New-Object System.IO.StreamWriter("$tmp/$err", $false)
  $outDone = New-Object System.Threading.ManualResetEventSlim($false)
  $errDone = New-Object System.Threading.ManualResetEventSlim($false)
  $entry = @{ p = $p; outW = $outW; errW = $errW; tag = "$file $argline"; outDone = $outDone; errDone = $errDone }
  $script:procs += $entry
  try {
    if (-not $p.Start()) { throw "process failed to start: $file $argline" }
    Register-ObjectEvent -InputObject $p -EventName OutputDataReceived -Action { param($a, $e) if ($null -eq $e.Data) { try { $Event.MessageData.Done.Set() } catch {} } else { try { $Event.MessageData.W.WriteLine($e.Data) } catch {} } } -MessageData @{ W = $outW; Done = $outDone } | Out-Null
    Register-ObjectEvent -InputObject $p -EventName ErrorDataReceived -Action { param($a, $e) if ($null -eq $e.Data) { try { $Event.MessageData.Done.Set() } catch {} } else { try { $Event.MessageData.W.WriteLine($e.Data) } catch {} } } -MessageData @{ W = $errW; Done = $errDone } | Out-Null
    $p.BeginOutputReadLine(); $p.BeginErrorReadLine()
  } catch {
    try { if (-not $p.HasExited) { $p.Kill() } } catch {}
    throw
  }
  $after = @(Get-EventSubscriber | Select-Object -ExpandProperty SubscriptionId)
  foreach ($id in $after) { if ($before -notcontains $id) { $script:subs += $id } }
  return $entry
}
function Stop-Hidden($entry) {
  # Bounded stop + PROVED EOF drain: kill escalation, then bounded wait for
  # BOTH async stream EOFs (null-Data signals from Start-Hidden) before
  # closing writers. No sleep-as-proof. Reports (never swallows) escapes.
  if ($null -eq $entry) { return $true }
  $ok = $true
  try {
    if (-not $entry.p.HasExited) {
      try { $entry.p.Kill() } catch { $ok = $false }
      if (-not $entry.p.WaitForExit(10000)) {
        try { $entry.p.Kill($true) } catch {}
        if (-not $entry.p.WaitForExit(5000)) { $ok = $false }
      }
    } else { $entry.p.WaitForExit(5000) | Out-Null }
    try { if (-not $entry.outDone.Wait(10000)) { $ok = $false } } catch { $ok = $false }
    try { if (-not $entry.errDone.Wait(10000)) { $ok = $false } } catch { $ok = $false }
    try { $entry.p.CancelOutputRead() } catch {}
    try { $entry.p.CancelErrorRead() } catch {}
  } catch { $ok = $false }
  try { $entry.outW.Flush() } catch {}
  try { $entry.errW.Flush() } catch {}
  try { $entry.outW.Close() } catch { $ok = $false }
  try { $entry.errW.Close() } catch { $ok = $false }
  if (-not $ok) { Fail ("cleanup-stop:" + $entry.tag) "process escaped bounded stop/drain" }
  return $ok
}
function Invoke-Bounded([string]$file, [string[]]$argList, [string]$workdir, $envmap, [int]$secs, [string]$tag, [string]$logf) {
  # Bounded direct invocation: any hang becomes a bounded failure, never a
  # stuck runner. BOTH streams drain CONCURRENTLY from first start via
  # ReadToEndAsync (no WaitForExit-before-ReadToEnd deadlock when pipes fill).
  # Uses ArgumentList (PowerShell 7 native contract) so conn strings and
  # spaced paths survive without manual quoting. Checked bounded exit AND
  # bounded EOF; first handle is always cleaned up. Polls are <=10s.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $file
  foreach ($a in $argList) { $psi.ArgumentList.Add($a) | Out-Null }
  $psi.WorkingDirectory = $workdir
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = $true; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  if ($envmap) { foreach ($k in $envmap.Keys) { $psi.Environment[$k] = $envmap[$k] } }
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  try {
    if (-not $p.Start()) { Fail $tag "spawn failed (Start returned false)"; return 127 }
  } catch {
    Fail $tag ("spawn failed :: " + $_.Exception.Message)
    try { $p.Dispose() } catch {}
    return 127
  }
  try {
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($secs * 1000)) {
      try { $p.Kill($true) } catch {}
      $p.WaitForExit(5000) | Out-Null
      Fail $tag ("timed out after " + $secs + "s; killed")
      return 124
    }
    if (-not $outTask.Wait(10000) -or -not $errTask.Wait(10000)) {
      Fail $tag "bounded EOF drain failed (streams did not close within 10s)"
      try { $p.Kill($true) } catch {}
      return 124
    }
    $so = $outTask.Result
    $se = $errTask.Result
    if ($logf -ne "") { Set-Content -Path (Join-Path $art $logf) -Value ($so + "`n--- STDERR ---`n" + $se) }
    return $p.ExitCode
  } finally {
    try { $p.Dispose() } catch {}
  }
}
try {
Preflight
Write-Host "building API publish (per-run fresh artifacts)..."
if (Test-Path $pub) { Remove-Item -Recurse -Force $pub }
$bc = Invoke-Bounded "dotnet" @("publish", (Join-Path $root "server/SimCEO.Api/SimCEO.Api.csproj"), "-c", "Release", "-o", $pub, "--nologo", "-v", "q") $root $null 600 "build-api-publish" "build-api.log"
Check "build-api-publish" ($bc -eq 0) ("exit=" + $bc)
if ($bc -ne 0) { throw "API publish failed; refusing to test a stale binary." }
Write-Host "building probe harnesses (owned; identity-checked, never blind binaries)..."
$bp = Invoke-Bounded "dotnet" @("build", (Join-Path $here "probe/EssBackendProbe.csproj"), "-c", "Release", "--nologo", "-v", "q") $root $null 300 "build-probe" "build-probe.log"
Check "build-probe" ($bp -eq 0) ("exit=" + $bp)
$bu = Invoke-Bounded "dotnet" @("build", (Join-Path $root "qa/AtomicUnitProbe/AtomicUnitProbe.csproj"), "-c", "Release", "--nologo", "-v", "q") $root $null 300 "build-unitprobe" "build-unitprobe.log"
Check "build-unitprobe" ($bu -eq 0) ("exit=" + $bu)
if ($bp -ne 0 -or $bu -ne 0) { throw "probe build failed; refusing to run unchecked binaries." }
$dllHash = (Get-FileHash (Join-Path $pub "SimCEO.Api.dll") -Algorithm SHA256).Hash.ToLower()
$probeHash = (Get-FileHash (Join-Path $here "probe/bin/Release/net10.0/EssBackendProbe.dll") -Algorithm SHA256).Hash.ToLower()
$unitHash = (Get-FileHash (Join-Path $root "qa/AtomicUnitProbe/bin/Release/net10.0/AtomicUnitProbe.dll") -Algorithm SHA256).Hash.ToLower()
Write-Host ("published dll sha256=" + $dllHash)
@{ publishedDll = $dllHash; probeDll = $probeHash; unitProbeDll = $unitHash; runId = $runId; at = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json | Set-Content (Join-Path $art "publish-identity.json")
$null = Start-Hidden "node" "qa/fake-provider.mjs --port 5240" "ess-be-fake.log" "ess-be-fake.err.log" @{} $root
Start-Sleep -Seconds 2
$apiDll = [char]34 + (Join-Path $pub "SimCEO.Api.dll") + [char]34
if ($Leg -eq "all" -or $Leg -eq "a") {
$dbA = "essentials_backend_" + $runId
PgExec "postgres" ("CREATE DATABASE " + $dbA + ";") | Out-Null
$csA = "Host=$pgHost;Port=$pgPort;Database=$dbA;Username=$pgUser;Password=$pgPw"
$envA = @{ ASPNETCORE_URLS = "http://127.0.0.1:5140"; USE_POSTGRES = "1"; META_API_BASE = "http://127.0.0.1:5240"; META_API_KEY = "qa-dummy" }
$envA["CONNECTIONSTRINGS__APP"] = $csA
$apiEntry = Start-Hidden "dotnet" $apiDll "ess-be-5140.log" "ess-be-5140.err.log" $envA $root
Check "legA-health" (Wait-Http "http://127.0.0.1:5140/health" 120) "fresh PG boot"
Check "legA-ready" (Wait-Http "http://127.0.0.1:5140/ready" 60) "postgres store"
$ec = Invoke-Bounded "node" @((Join-Path $here "smoke.mjs"), "--api", "http://127.0.0.1:5140", "--suite", "full", "--art", $art) $root $null 240 "legA-full" "smoke-full.log"
Check "legA-full" ($ec -eq 0) ("exit=" + $ec)
Write-Host "probe: memory section..."
$pm = Invoke-Bounded "dotnet" @((Join-Path $here "probe/bin/Release/net10.0/EssBackendProbe.dll")) $root $null 300 "probe-memory" "probe-memory.log"
Check "probe-memory" ($pm -eq 0) ("exit=" + $pm)
$dbP = "essentials_backend_probe_" + $runId
PgExec "postgres" ("CREATE DATABASE " + $dbP + ";") | Out-Null
$csP = "Host=$pgHost;Port=$pgPort;Database=$dbP;Username=$pgUser;Password=$pgPw"
Write-Host "probe: PG section..."
$pp = Invoke-Bounded "dotnet" @((Join-Path $here "probe/bin/Release/net10.0/EssBackendProbe.dll"), "--pg", $csP) $root $null 300 "probe-pg" "probe-pg.log"
Check "probe-pg" ($pp -eq 0) ("exit=" + $pp)
PgExec "postgres" ("DROP DATABASE " + $dbP + ";") | Out-Null
$dbP = $null
$dbU = "essentials_backend_unit_" + $runId
PgExec "postgres" ("CREATE DATABASE " + $dbU + ";") | Out-Null
$csU = "Host=$pgHost;Port=$pgPort;Database=$dbU;Username=$pgUser;Password=$pgPw"
Write-Host "AtomicUnitProbe regression (existing harness, memory + PG, no skips)..."
$um = Invoke-Bounded "dotnet" @((Join-Path $root "qa/AtomicUnitProbe/bin/Release/net10.0/AtomicUnitProbe.dll")) $root $null 300 "unitprobe-memory" "unitprobe-memory.log"
Check "unitprobe-memory" ($um -eq 0) ("exit=" + $um)
$up = Invoke-Bounded "dotnet" @((Join-Path $root "qa/AtomicUnitProbe/bin/Release/net10.0/AtomicUnitProbe.dll"), "--pg", $csU) $root $null 300 "unitprobe-pg" "unitprobe-pg.log"
Check "unitprobe-pg" ($up -eq 0) ("exit=" + $up)
PgExec "postgres" ("DROP DATABASE " + $dbU + ";") | Out-Null
$dbU = $null
Write-Host "legA: restart stability (export bytes before/after)..."
Stop-Hidden $apiEntry | Out-Null
Check "legA-port-closed" (Wait-PortClosed 5140 30) "after stop"
$apiEntry2 = Start-Hidden "dotnet" $apiDll "ess-be-5140b.log" "ess-be-5140b.err.log" $envA $root
Check "legA-restart-ready" (Wait-Http "http://127.0.0.1:5140/ready" 120) "restart 1"
$ec2 = Invoke-Bounded "node" @((Join-Path $here "smoke.mjs"), "--api", "http://127.0.0.1:5140", "--suite", "conc", "--art", $art) $root $null 240 "legA-restart-conc" "smoke-conc.log"
Check "legA-restart-conc" ($ec2 -eq 0) "post-restart conc"
Stop-Hidden $apiEntry2 | Out-Null
Check "legA-port-closed2" (Wait-PortClosed 5140 30) "after stop 2"
$apiEntry3 = Start-Hidden "dotnet" $apiDll "ess-be-5140c.log" "ess-be-5140c.err.log" $envA $root
Check "legA-restart2-ready" (Wait-Http "http://127.0.0.1:5140/ready" 120) "restart 2"
$ec3 = Invoke-Bounded "node" @((Join-Path $here "smoke.mjs"), "--api", "http://127.0.0.1:5140", "--suite", "restartcheck", "--art", $art) $root $null 240 "legA-policy-survives-restarts" "smoke-restartcheck.log"
Check "legA-policy-survives-restarts" ($ec3 -eq 0) "PG durable"
Stop-Hidden $apiEntry3 | Out-Null
PgExec "postgres" ("DROP DATABASE " + $dbA + ";") | Out-Null
$dbA = $null
Write-Host "legA fresh DB dropped (per-run artifact cleanup; old proof DBs untouched)"
}
if ($Leg -eq "all" -or $Leg -eq "m") {
Write-Host "memory leg (USE_POSTGRES=0, owned port 5143)..."
$envM = @{ ASPNETCORE_URLS = "http://127.0.0.1:5143"; USE_POSTGRES = "0"; META_API_BASE = "http://127.0.0.1:5240"; META_API_KEY = "qa-dummy" }
$memEntry = Start-Hidden "dotnet" $apiDll "ess-be-5143.log" "ess-be-5143.err.log" $envM $root
Check "legM-health" (Wait-Http "http://127.0.0.1:5143/health" 120) "memory boot"
$em = Invoke-Bounded "node" @((Join-Path $here "smoke.mjs"), "--api", "http://127.0.0.1:5143", "--suite", "conc", "--art", $art) $root $null 240 "legM-conc" "smoke-mem.log"
Check "legM-conc" ($em -eq 0) "memory gateway concurrency"
Stop-Hidden $memEntry | Out-Null
Check "legM-port-closed" (Wait-PortClosed 5143 30) "memory cleanup"
}
if ($Leg -eq "all" -or $Leg -eq "u") {
Write-Host "upgrade leg (exclusive TEMPLATE clone of essentials_backend_upg; the preserved DB is never written)..."
$dbClone = "essentials_backend_upg_" + $runId
$cloned = $true
try { PgExec "postgres" ("CREATE DATABASE " + $dbClone + " TEMPLATE essentials_backend_upg;") | Out-Null }
catch { Fail "legU-clone" ("exclusive clone failed; refusing to write into the preserved DB :: " + $_.Exception.Message); $cloned = $false; $dbClone = $null }
if ($cloned) {
$envU = @{ ASPNETCORE_URLS = "http://127.0.0.1:5144"; USE_POSTGRES = "1"; META_API_BASE = "http://127.0.0.1:5240"; META_API_KEY = "qa-dummy" }
$envU["CONNECTIONSTRINGS__APP"] = "Host=$pgHost;Port=$pgPort;Database=$dbClone;Username=$pgUser;Password=$pgPw"
$upgEntry = Start-Hidden "dotnet" $apiDll "ess-be-5144.log" "ess-be-5144.err.log" $envU $root
Check "legU-health" (Wait-Http "http://127.0.0.1:5144/health" 180) "old16 boot"
Check "legU-ready" (Wait-Http "http://127.0.0.1:5144/ready" 60) "migrated ready"
$eu = Invoke-Bounded "node" @((Join-Path $here "smoke.mjs"), "--api", "http://127.0.0.1:5144", "--suite", "upg", "--art", $art) $root $null 240 "legU-upg" "smoke-upg.log"
Check "legU-upg" ($eu -eq 0) "fixture-admin contract + bytes"
Stop-Hidden $upgEntry | Out-Null
Check "legU-port-closed" (Wait-PortClosed 5144 30) "upgrade API down"
$upgEntry2 = Start-Hidden "dotnet" $apiDll "ess-be-5144b.log" "ess-be-5144b.err.log" $envU $root
Check "legU-restart-ready" (Wait-Http "http://127.0.0.1:5144/ready" 180) "restart 1 on upgraded DB"
$eu2 = Invoke-Bounded "node" @((Join-Path $here "smoke.mjs"), "--api", "http://127.0.0.1:5144", "--suite", "upg", "--art", $art) $root $null 240 "legU-upg-again" "smoke-upg2.log"
Check "legU-upg-again" ($eu2 -eq 0) "stable after restart 1"
Stop-Hidden $upgEntry2 | Out-Null
Check "legU-port-closed2" (Wait-PortClosed 5144 30) "upgrade API down 2"
$upgEntry3 = Start-Hidden "dotnet" $apiDll "ess-be-5144c.log" "ess-be-5144c.err.log" $envU $root
Check "legU-restart2-ready" (Wait-Http "http://127.0.0.1:5144/ready" 180) "restart 2 on upgraded DB"
$eu3 = Invoke-Bounded "node" @((Join-Path $here "smoke.mjs"), "--api", "http://127.0.0.1:5144", "--suite", "upg", "--art", $art) $root $null 240 "legU-upg-stable" "smoke-upg3.log"
Check "legU-upg-stable" ($eu3 -eq 0) "stable after restart 2 (two actual restarts)"
Stop-Hidden $upgEntry3 | Out-Null
Check "legU-port-closed3" (Wait-PortClosed 5144 30) "upgrade API down 3"
PgExec "postgres" ("DROP DATABASE " + $dbClone + ";") | Out-Null
$dbClone = $null
Write-Host "legU clone dropped (per-run artifact cleanup; preserved essentials_backend_upg untouched)"
} else { Write-Host "legU SKIPPED (clone unavailable; preserved DB untouched)" }
}
if ($Leg -eq "all" -or $Leg -eq "f") {
Write-Host "fault legs (fresh exclusive DB; honest WRITE-STAGE faults at SaveChanges/DDL + retry; deferred-COMMIT and lost-ack proofs live in-process in EssBackendProbe)..."
$dbF = "essentials_backend_fault_" + $runId
PgExec "postgres" ("CREATE DATABASE " + $dbF + ";") | Out-Null
$csF = "Host=$pgHost;Port=$pgPort;Database=$dbF;Username=$pgUser;Password=$pgPw"
$envF = @{ ASPNETCORE_URLS = "http://127.0.0.1:5140"; USE_POSTGRES = "1"; META_API_BASE = "http://127.0.0.1:5240"; META_API_KEY = "qa-dummy" }
$envF["CONNECTIONSTRINGS__APP"] = $csF
$fapiEntry = Start-Hidden "dotnet" $apiDll "ess-be-fault.log" "ess-be-fault.err.log" $envF $root
Check "legF-ready" (Wait-Http "http://127.0.0.1:5140/ready" 120) "fault DB boot"
$s0file = Join-Path $art "restorefault-s0.json"
$ef0 = Invoke-Bounded "node" @((Join-Path $here "smoke.mjs"), "--api", "http://127.0.0.1:5140", "--suite", "restorefault", "--expect", "setup", "--s0file", $s0file, "--art", $art) $root $null 240 "legF-restore-setup" "smoke-fsetup.log"
Check "legF-restore-setup" ($ef0 -eq 0) "state + round-trip"
$ef1 = Invoke-Bounded "node" @((Join-Path $here "smoke.mjs"), "--api", "http://127.0.0.1:5140", "--suite", "spendfault", "--expect", "200", "--cap", "424242", "--mode", "block", "--art", $art) $root $null 240 "legF-spend-baseline" "smoke-fbase.log"
Check "legF-spend-baseline" ($ef1 -eq 0) "policy baseline"
PgExecQ $dbF 'ALTER TABLE "Notes" DROP COLUMN "Body";' | Out-Null
$ef2 = Invoke-Bounded "node" @((Join-Path $here "smoke.mjs"), "--api", "http://127.0.0.1:5140", "--suite", "restorefault", "--expect", "500", "--s0file", $s0file, "--art", $art) $root $null 240 "legF-restore-500-rollback" "smoke-f500.log"
Check "legF-restore-500-rollback" ($ef2 -eq 0) "honest 500 (write-stage 42703) + rows intact"
PgExecQ $dbF 'ALTER TABLE "Notes" ADD COLUMN "Body" text NOT NULL DEFAULT '''';' | Out-Null
$ef3 = Invoke-Bounded "node" @((Join-Path $here "smoke.mjs"), "--api", "http://127.0.0.1:5140", "--suite", "restorefault", "--expect", "200", "--s0file", $s0file, "--art", $art) $root $null 240 "legF-restore-retry-bytes" "smoke-fretry.log"
Check "legF-restore-retry-bytes" ($ef3 -eq 0) "retry + byte-identical"
PgExecQ $dbF 'ALTER TABLE "InstallationPolicies" ADD CONSTRAINT "chk_ess_spend_qa" CHECK ("MonthlyCapUsd" < 1000) NOT VALID;' | Out-Null
$ef4 = Invoke-Bounded "node" @((Join-Path $here "smoke.mjs"), "--api", "http://127.0.0.1:5140", "--suite", "spendfault", "--expect", "500", "--cap", "9999", "--mode", "warn", "--art", $art) $root $null 240 "legF-spend-500" "smoke-fspend500.log"
Check "legF-spend-500" ($ef4 -eq 0) "write-stage immediate-CHECK failure honest 500 (NOT deferred COMMIT proof)"
$ef5 = Invoke-Bounded "node" @((Join-Path $here "smoke.mjs"), "--api", "http://127.0.0.1:5140", "--suite", "spendfault", "--expect", "200", "--cap", "424242", "--mode", "block", "--checkcap", "424242", "--checkmode", "block", "--art", $art) $root $null 240 "legF-spend-rollback-kept" "smoke-fkept.log"
Check "legF-spend-rollback-kept" ($ef5 -eq 0) "failed PUT left no trace, retry works"
PgExecQ $dbF 'ALTER TABLE "InstallationPolicies" DROP CONSTRAINT "chk_ess_spend_qa";' | Out-Null
$ef6 = Invoke-Bounded "node" @((Join-Path $here "smoke.mjs"), "--api", "http://127.0.0.1:5140", "--suite", "spendfault", "--expect", "200", "--cap", "999", "--mode", "warn", "--art", $art) $root $null 240 "legF-spend-repair-200" "smoke-frepair.log"
Check "legF-spend-repair-200" ($ef6 -eq 0) "writes work after repair"
Stop-Hidden $fapiEntry | Out-Null
Check "legF-port-closed" (Wait-PortClosed 5140 30) "fault API down"
$fapiEntry2 = Start-Hidden "dotnet" $apiDll "ess-be-fault2.log" "ess-be-fault2.err.log" $envF $root
Check "legF-reboot-ready" (Wait-Http "http://127.0.0.1:5140/ready" 120) "reboot ready"
$ef7 = Invoke-Bounded "node" @((Join-Path $here "smoke.mjs"), "--api", "http://127.0.0.1:5140", "--suite", "spendfault", "--expect", "200", "--cap", "999", "--mode", "warn", "--checkcap", "999", "--checkmode", "warn", "--art", $art) $root $null 240 "legF-spend-durable-restart" "smoke-fdurable.log"
Check "legF-spend-durable-restart" ($ef7 -eq 0) "policy survives restart"
Stop-Hidden $fapiEntry2 | Out-Null
Check "legF-port-closed2" (Wait-PortClosed 5140 30) "fault API down 2"
PgExec "postgres" ("DROP DATABASE " + $dbF + ";") | Out-Null
$dbF = $null
Write-Host "legF fault DB dropped (per-run artifact cleanup; old proof DBs untouched)"
}
}
finally {
  foreach ($e in $procs) { Stop-Hidden $e | Out-Null }
  foreach ($sid in $subs) { try { Unregister-Event -SubscriptionId $sid -ErrorAction SilentlyContinue } catch {} }
  foreach ($db in @($dbA, $dbP, $dbU, $dbF, $dbClone)) {
    if ($db) { try { PgExec "postgres" ("DROP DATABASE IF EXISTS " + $db + ";") | Out-Null } catch { Fail ("cleanup-drop:" + $db) $_.Exception.Message } }
  }
}
Write-Host ("ESS-BACKEND-RUN fail=" + $fail)
exit $fail
