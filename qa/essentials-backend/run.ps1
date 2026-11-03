param([string]$Leg = "all")
$ErrorActionPreference = "Stop"
$root = "C:/Users/War/scrach/sim_ceo/.tmp/essentials-runnable-worktree"
$tmp = "C:/Users/War/scrach/sim_ceo/.tmp"
$here = Join-Path $root "qa/essentials-backend"
$pub = Join-Path $here "pub"
$art = Join-Path $here ("art-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Force -Path $art | Out-Null
$runId = [Guid]::NewGuid().ToString("N").Substring(0, 8)
$pgHost = "127.0.0.1"
$pgPort = "15441"
$pgUser = "simceo"
$pgPw = "qa-only"
$pgCtn = "simceo-integration-qa-pg"
$procs = @()
$fail = 0
function Check($name, $cond, $detail = "") {
  if ($cond) { Write-Host ("  ok " + $name + " " + $detail) } else { Write-Host ("  FAIL " + $name + " " + $detail); $script:fail++ }
}
function PortFree($port) {
  try { $c = New-Object System.Net.Sockets.TcpClient; $iar = $c.BeginConnect("127.0.0.1", $port, $null, $null); $ok = $iar.AsyncWaitHandle.WaitOne(400); $conn = $c.Connected; $c.Close(); return -not ($ok -and $conn) } catch { return $true }
}
function Wait-Http($url, $secs = 90) {
  $deadline = (Get-Date).AddSeconds($secs)
  while ((Get-Date) -lt $deadline) {
    try { $r = Invoke-WebRequest -Uri $url -TimeoutSec 3 -UseBasicParsing; if ($r.StatusCode -eq 200) { return $true } } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $false
}
function Wait-PortClosed($port, $secs = 30) {
  $deadline = (Get-Date).AddSeconds($secs)
  while ((Get-Date) -lt $deadline) {
    if (PortFree $port) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}
function Start-Hidden($file, $argline, $out, $err, $envmap, $workdir) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $file; $psi.Arguments = $argline
  $psi.WorkingDirectory = $workdir
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  foreach ($k in $envmap.Keys) { $psi.Environment[$k] = $envmap[$k] }
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  $outW = New-Object System.IO.StreamWriter("$tmp/$out", $false)
  $errW = New-Object System.IO.StreamWriter("$tmp/$err", $false)
  Register-ObjectEvent -InputObject $p -EventName OutputDataReceived -Action { param($a, $e) if ($e.Data) { $Event.MessageData.WriteLine($e.Data) } } -MessageData $outW | Out-Null
  Register-ObjectEvent -InputObject $p -EventName ErrorDataReceived -Action { param($a, $e) if ($e.Data) { $Event.MessageData.WriteLine($e.Data) } } -MessageData $errW | Out-Null
  $p.Start() | Out-Null
  $p.BeginOutputReadLine(); $p.BeginErrorReadLine()
  $script:procs += @{ p = $p; outW = $outW; errW = $errW }
  return $p
}
function Stop-Hidden($entry) {
  if ($null -eq $entry) { return }
  try { if (-not $entry.p.HasExited) { $entry.p.Kill() } } catch {}
  try { $entry.p.WaitForExit(15000) } catch {}
  try { $entry.outW.Close(); $entry.errW.Close() } catch {}
}
function PgSql($db, $sql) { docker exec $pgCtn psql -U $pgUser -d $db -t -A -c $sql }
# Quoted-identifier-safe DDL: native argv mangling strips inner double
# quotes from -c strings, so quoted DDL goes via a file on stdin instead.
function PgSqlQ($db, $sql) {
  $f = Join-Path $tmp ("essddl-" + [Guid]::NewGuid().ToString("N") + ".sql")
  Set-Content -Path $f -Value $sql -NoNewline
  Get-Content -Raw $f | docker exec -i $pgCtn psql -U $pgUser -d $db -t -A -q
  Remove-Item $f -Force
}
try {
foreach ($p in @(5140, 5143, 5144, 5240)) { Check ("preflight-port-free-" + $p) (PortFree $p) "must be free" }
Check "preflight-pg-up" ((docker exec $pgCtn psql -U $pgUser -d postgres -t -A -c "select 1") -eq "1") "shared PG running (inspected only)"
Write-Host "building API publish (per-run fresh artifacts)..."
if (Test-Path $pub) { Remove-Item -Recurse -Force $pub }
& dotnet publish (Join-Path $root "server/SimCEO.Api/SimCEO.Api.csproj") -c Release -o $pub --nologo -v q
if ($LASTEXITCODE -ne 0) { throw "publish failed" }
$dllHash = (Get-FileHash (Join-Path $pub "SimCEO.Api.dll") -Algorithm SHA256).Hash.ToLower()
Write-Host ("published dll sha256=" + $dllHash)
@{ publishedDll = $dllHash; runId = $runId; at = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json | Set-Content (Join-Path $art "publish-identity.json")
$null = Start-Hidden "node" "qa/fake-provider.mjs --port 5240" "ess-be-fake.log" "ess-be-fake.err.log" @{} $root
Start-Sleep -Seconds 2
$apiDll = [char]34 + (Join-Path $pub "SimCEO.Api.dll") + [char]34
if ($Leg -eq "all" -or $Leg -eq "a") {
$dbA = "essentials_backend_" + $runId
PgSql "postgres" ("CREATE DATABASE " + $dbA + ";") | Out-Null
$csA = "Host=$pgHost;Port=$pgPort;Database=$dbA;Username=$pgUser;Password=$pgPw"
$envA = @{ ASPNETCORE_URLS = "http://127.0.0.1:5140"; USE_POSTGRES = "1"; META_API_BASE = "http://127.0.0.1:5240"; META_API_KEY = "qa-dummy" }
$envA["CONNECTIONSTRINGS__APP"] = $csA
$api = Start-Hidden "dotnet" $apiDll "ess-be-5140.log" "ess-be-5140.err.log" $envA $root
$apiEntry = $procs[$procs.Count - 1]
Check "legA-health" (Wait-Http "http://127.0.0.1:5140/health" 120) "fresh PG boot"
Check "legA-ready" (Wait-Http "http://127.0.0.1:5140/ready" 60) "postgres store"
& node (Join-Path $here "smoke.mjs") --api http://127.0.0.1:5140 --suite full --art $art; Check "legA-full" ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"
Write-Host "probe: memory section..."
& dotnet (Join-Path $here "probe/bin/Release/net10.0/EssBackendProbe.dll"); Check "probe-memory" ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"
$dbP = "essentials_backend_probe_" + $runId
PgSql "postgres" ("CREATE DATABASE " + $dbP + ";") | Out-Null
$csP = "Host=$pgHost;Port=$pgPort;Database=$dbP;Username=$pgUser;Password=$pgPw"
Write-Host "probe: PG section..."
& dotnet (Join-Path $here "probe/bin/Release/net10.0/EssBackendProbe.dll") --pg $csP; Check "probe-pg" ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"
PgSql "postgres" ("DROP DATABASE " + $dbP + ";") | Out-Null
$dbU = "essentials_backend_unit_" + $runId
PgSql "postgres" ("CREATE DATABASE " + $dbU + ";") | Out-Null
$csU = "Host=$pgHost;Port=$pgPort;Database=$dbU;Username=$pgUser;Password=$pgPw"
Write-Host "AtomicUnitProbe regression (existing harness, memory + PG, no skips)..."
& dotnet (Join-Path $root "qa/AtomicUnitProbe/bin/Release/net10.0/AtomicUnitProbe.dll"); Check "unitprobe-memory" ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"
& dotnet (Join-Path $root "qa/AtomicUnitProbe/bin/Release/net10.0/AtomicUnitProbe.dll") --pg $csU; Check "unitprobe-pg" ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"
PgSql "postgres" ("DROP DATABASE " + $dbU + ";") | Out-Null
Write-Host "legA: restart stability (export bytes before/after)..."
Stop-Hidden $apiEntry
Check "legA-port-closed" (Wait-PortClosed 5140 30) "after stop"
$api2 = Start-Hidden "dotnet" $apiDll "ess-be-5140b.log" "ess-be-5140b.err.log" $envA $root
$apiEntry2 = $procs[$procs.Count - 1]
Check "legA-restart-ready" (Wait-Http "http://127.0.0.1:5140/ready" 120) "restart 1"
& node (Join-Path $here "smoke.mjs") --api http://127.0.0.1:5140 --suite conc --art $art; Check "legA-restart-conc" ($LASTEXITCODE -eq 0) "post-restart conc"
Stop-Hidden $apiEntry2
Check "legA-port-closed2" (Wait-PortClosed 5140 30) "after stop 2"
$api3 = Start-Hidden "dotnet" $apiDll "ess-be-5140c.log" "ess-be-5140c.err.log" $envA $root
$apiEntry3 = $procs[$procs.Count - 1]
Check "legA-restart2-ready" (Wait-Http "http://127.0.0.1:5140/ready" 120) "restart 2"
& node (Join-Path $here "smoke.mjs") --api http://127.0.0.1:5140 --suite restartcheck --art $art; Check "legA-policy-survives-restarts" ($LASTEXITCODE -eq 0) "PG durable"
Stop-Hidden $apiEntry3
PgSql "postgres" ("DROP DATABASE " + $dbA + ";") | Out-Null
Write-Host "legA fresh DB dropped (per-run artifact cleanup; old proof DBs untouched)"
Write-Host "legA fresh DB dropped (per-run artifact cleanup; old proof DBs untouched)"
}
if ($Leg -eq "all" -or $Leg -eq "m") {
Write-Host "memory leg (USE_POSTGRES=0, owned port 5143)..."
$envM = @{ ASPNETCORE_URLS = "http://127.0.0.1:5143"; USE_POSTGRES = "0"; META_API_BASE = "http://127.0.0.1:5240"; META_API_KEY = "qa-dummy" }
$mem = Start-Hidden "dotnet" $apiDll "ess-be-5143.log" "ess-be-5143.err.log" $envM $root
$memEntry = $procs[$procs.Count - 1]
Check "legM-health" (Wait-Http "http://127.0.0.1:5143/health" 120) "memory boot"
& node (Join-Path $here "smoke.mjs") --api http://127.0.0.1:5143 --suite conc --art $art; Check "legM-conc" ($LASTEXITCODE -eq 0) "memory gateway concurrency"
Stop-Hidden $memEntry
Check "legM-port-closed" (Wait-PortClosed 5143 30) "memory cleanup"
Check "legM-port-closed" (Wait-PortClosed 5143 30) "memory cleanup"
}
if ($Leg -eq "all" -or $Leg -eq "u") {
Write-Host "upgrade leg (existing essentials_backend_upg, read-only + own-export round-trip)..."
$envU = @{ ASPNETCORE_URLS = "http://127.0.0.1:5144"; USE_POSTGRES = "1"; META_API_BASE = "http://127.0.0.1:5240"; META_API_KEY = "qa-dummy" }
$envU["CONNECTIONSTRINGS__APP"] = "Host=$pgHost;Port=$pgPort;Database=essentials_backend_upg;Username=$pgUser;Password=$pgPw"
$upg = Start-Hidden "dotnet" $apiDll "ess-be-5144.log" "ess-be-5144.err.log" $envU $root
$upgEntry = $procs[$procs.Count - 1]
Check "legU-health" (Wait-Http "http://127.0.0.1:5144/health" 180) "old16 boot"
Check "legU-ready" (Wait-Http "http://127.0.0.1:5144/ready" 60) "migrated ready"
& node (Join-Path $here "smoke.mjs") --api http://127.0.0.1:5144 --suite upg --art $art; Check "legU-upg" ($LASTEXITCODE -eq 0) "fixture-admin contract + bytes"
Stop-Hidden $upgEntry
Check "legU-port-closed" (Wait-PortClosed 5144 30) "upgrade API down"
$upg2 = Start-Hidden "dotnet" $apiDll "ess-be-5144b.log" "ess-be-5144b.err.log" $envU $root
$upgEntry2 = $procs[$procs.Count - 1]
Check "legU-restart-ready" (Wait-Http "http://127.0.0.1:5144/ready" 180) "restart 1 on upgraded DB"
& node (Join-Path $here "smoke.mjs") --api http://127.0.0.1:5144 --suite upg --art $art; Check "legU-upg-again" ($LASTEXITCODE -eq 0) "stable after restart"
Stop-Hidden $upgEntry2
Stop-Hidden $upgEntry2
}
if ($Leg -eq "all" -or $Leg -eq "f") {
Write-Host "fault legs (fresh exclusive DB, real PG commit failure + retry, no shipped switch)..."
$dbF = "essentials_backend_fault_" + $runId
PgSql "postgres" ("CREATE DATABASE " + $dbF + ";") | Out-Null
$csF = "Host=$pgHost;Port=$pgPort;Database=$dbF;Username=$pgUser;Password=$pgPw"
$envF = @{ ASPNETCORE_URLS = "http://127.0.0.1:5140"; USE_POSTGRES = "1"; META_API_BASE = "http://127.0.0.1:5240"; META_API_KEY = "qa-dummy" }
$envF["CONNECTIONSTRINGS__APP"] = $csF
$fapi = Start-Hidden "dotnet" $apiDll "ess-be-fault.log" "ess-be-fault.err.log" $envF $root
$fapiEntry = $procs[$procs.Count - 1]
Check "legF-ready" (Wait-Http "http://127.0.0.1:5140/ready" 120) "fault DB boot"
$s0file = Join-Path $art "restorefault-s0.json"
& node (Join-Path $here "smoke.mjs") --api http://127.0.0.1:5140 --suite restorefault --expect setup --s0file $s0file --art $art; Check "legF-restore-setup" ($LASTEXITCODE -eq 0) "state + round-trip"
& node (Join-Path $here "smoke.mjs") --api http://127.0.0.1:5140 --suite spendfault --expect 200 --cap 424242 --mode block --art $art; Check "legF-spend-baseline" ($LASTEXITCODE -eq 0) "policy baseline"
PgSqlQ $dbF 'ALTER TABLE "Notes" DROP COLUMN "Body";' | Out-Null
& node (Join-Path $here "smoke.mjs") --api http://127.0.0.1:5140 --suite restorefault --expect 500 --s0file $s0file --art $art; Check "legF-restore-500-rollback" ($LASTEXITCODE -eq 0) "honest 500 + rows intact"
PgSqlQ $dbF 'ALTER TABLE "Notes" ADD COLUMN "Body" text NOT NULL DEFAULT '''';' | Out-Null
& node (Join-Path $here "smoke.mjs") --api http://127.0.0.1:5140 --suite restorefault --expect 200 --s0file $s0file --art $art; Check "legF-restore-retry-bytes" ($LASTEXITCODE -eq 0) "retry + byte-identical"
PgSqlQ $dbF 'ALTER TABLE "InstallationPolicies" ADD CONSTRAINT "chk_ess_spend_qa" CHECK ("MonthlyCapUsd" < 1000) NOT VALID;' | Out-Null
& node (Join-Path $here "smoke.mjs") --api http://127.0.0.1:5140 --suite spendfault --expect 500 --cap 9999 --mode warn --art $art; Check "legF-spend-500" ($LASTEXITCODE -eq 0) "real PG commit failure honest"
& node (Join-Path $here "smoke.mjs") --api http://127.0.0.1:5140 --suite spendfault --expect 200 --cap 424242 --mode block --checkcap 424242 --checkmode block --art $art; Check "legF-spend-rollback-kept" ($LASTEXITCODE -eq 0) "failed PUT left no trace, retry works"
PgSqlQ $dbF 'ALTER TABLE "InstallationPolicies" DROP CONSTRAINT "chk_ess_spend_qa";' | Out-Null
& node (Join-Path $here "smoke.mjs") --api http://127.0.0.1:5140 --suite spendfault --expect 200 --cap 999 --mode warn --art $art; Check "legF-spend-repair-200" ($LASTEXITCODE -eq 0) "writes work after repair"
Stop-Hidden $fapiEntry
Check "legF-port-closed" (Wait-PortClosed 5140 30) "fault API down"
$fapi2 = Start-Hidden "dotnet" $apiDll "ess-be-fault2.log" "ess-be-fault2.err.log" $envF $root
$fapiEntry2 = $procs[$procs.Count - 1]
Check "legF-reboot-ready" (Wait-Http "http://127.0.0.1:5140/ready" 120) "reboot ready"
& node (Join-Path $here "smoke.mjs") --api http://127.0.0.1:5140 --suite spendfault --expect 200 --cap 999 --mode warn --checkcap 999 --checkmode warn --art $art; Check "legF-spend-durable-restart" ($LASTEXITCODE -eq 0) "policy survives restart"
Stop-Hidden $fapiEntry2
Check "legF-port-closed2" (Wait-PortClosed 5140 30) "fault API down 2"
PgSql "postgres" ("DROP DATABASE " + $dbF + ";") | Out-Null
Write-Host "legF fault DB dropped (per-run artifact cleanup; old proof DBs untouched)"
Write-Host "legF fault DB dropped (per-run artifact cleanup; old proof DBs untouched)"
}
}
finally {
  foreach ($e in $procs) { Stop-Hidden $e }
  Get-EventSubscriber | Unregister-Event
  foreach ($db in @($dbA, $dbP, $dbF)) {
    if ($db) { try { docker exec $pgCtn psql -U $pgUser -d postgres -c ("DROP DATABASE IF EXISTS " + $db + ";") | Out-Null } catch {} }
  }
}
Write-Host ("ESS-BACKEND-RUN fail=" + $fail)
exit $fail
