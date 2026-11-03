# SimCEO published-PG required runner (integration QA).
# Binds LAST source commit + fresh unique build (native exit 0) + DLL hash,
# stages published PG, runs focused proofs with NON-SKIP PG gates, cleans up.
# Strict: any failure (including cleanup) exits nonzero. Owned services only:
# API 5121, fake 5221, PG simceo-integration-qa-pg:15441. Never user services.
param([string]$PgConn = "Host=127.0.0.1;Port=15441;Database=simceo;Username=simceo;Password=qa-only")
$ErrorActionPreference = "Stop"
$root = "C:/Users/War/scrach/sim_ceo/.tmp/parity-integration-worktree"
Set-Location $root
$fail = 0
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$pubDir = "$root/.tmp/itg/apipub-$stamp"
$runLog = "$root/.tmp/published-runner-$stamp.log"
Start-Transcript -Path $runLog -Append | Out-Null
Write-Host ("RUNNER-LOG=" + $runLog)
$apiProc = $null; $fakeProc = $null
function Step($n) { Write-Host ""; Write-Host ("=== " + $n + " ===") }
function Fail($n, $d = "") { Write-Host ("  FAIL " + $n + " " + $d); $script:fail++ }
function Ok($n) { Write-Host ("  ok " + $n) }
function New-OwnedProcess($file, $argList, $workdir, $envmap, $outFile, $errFile) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $file
  $psi.Arguments = $argList
  $psi.WorkingDirectory = $workdir
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $psi.CreateNoWindow = $true
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  foreach ($k in $envmap.Keys) { $psi.Environment[$k] = $envmap[$k] }
  $pr = New-Object System.Diagnostics.Process
  $pr.StartInfo = $psi
  $null = New-Item -ItemType Directory -Force (Split-Path $outFile)
  $outW = New-Object System.IO.StreamWriter($outFile, $false)
  $errW = New-Object System.IO.StreamWriter($errFile, $false)
  Register-ObjectEvent -InputObject $pr -EventName OutputDataReceived -Action { param($a, $e) if ($e.Data) { $Event.MessageData.WriteLine($e.Data) } } -MessageData $outW | Out-Null
  Register-ObjectEvent -InputObject $pr -EventName ErrorDataReceived -Action { param($a, $e) if ($e.Data) { $Event.MessageData.WriteLine($e.Data) } } -MessageData $errW | Out-Null
  if (-not $pr.Start()) { throw "process start returned false: $file $argList" }
  $pr.BeginOutputReadLine()
  $pr.BeginErrorReadLine()
  return $pr
}
function Cleanup() {
  $cerr = 0
  foreach ($pr in @($script:apiProc, $script:fakeProc)) {
    if ($pr -ne $null) {
      try {
        if (-not $pr.HasExited) { $pr.Kill(); }
        if (-not $pr.WaitForExit(8000)) { Write-Host "  cleanup-kill-timeout pid="; Write-Host $pr.Id; $cerr++ }
      } catch { $cerr++ }
      try { $pr.Dispose() } catch { }
    }
  }
  $script:apiProc = $null; $script:fakeProc = $null
  Start-Sleep -Seconds 2
  foreach ($port in @(5121, 5221)) {
    try {
      $c = New-Object System.Net.Sockets.TcpClient
      $iar = $c.BeginConnect("127.0.0.1", $port, $null, $null)
      if ($iar.AsyncWaitHandle.WaitOne(800) -and $c.Connected) { Write-Host ("  cleanup-port-still-open " + $port); $cerr++ }
      $c.Close()
    } catch { }
  }
  if ($cerr -gt 0) { Write-Host "CLEANUP FAILED"; $script:fail++ } else { Write-Host "cleanup ok" }
}
try {
  Step "source-bind"
  $head = (git -C $root rev-parse HEAD).Trim()
  $dirty = (git -C $root status --porcelain=v1).Trim()
  Write-Host ("  HEAD=" + $head)
  if ($dirty) { Write-Host "  TREE-DIRTY (building working tree as-is):"; Write-Host $dirty }
  else { Ok "tree-clean" }
  Step "fresh-publish"
  & dotnet publish server/SimCEO.Api/SimCEO.Api.csproj -o $pubDir --nologo -v q
  if ($LASTEXITCODE -ne 0) { throw "publish native exit=$LASTEXITCODE (never test a pre-existing binary after failure)" }
  $dll = Join-Path $pubDir "SimCEO.Api.dll"
  if (!(Test-Path $dll)) { throw "published DLL missing" }
  $hash = (Get-FileHash $dll -Algorithm SHA256).Hash
  Write-Host ("  DLL-SHA256=" + $hash)
  if (!(Test-Path (Join-Path $pubDir "SimCEO.Postgres.dll"))) { throw "Postgres backend not staged in published bundle" }
  Ok "publish-native-exit0"
  Step "stage-services"
  $apiLog = Join-Path $pubDir "api.log"
  $apiErr = Join-Path $pubDir "api.err.log"
  $fakeLog = Join-Path $pubDir "fake.log"
  $fakeErr = Join-Path $pubDir "fake.err.log"
  $apiEnv = @{ "ASPNETCORE_URLS" = "http://127.0.0.1:5121" }
  $apiEnv["META_API_BASE"] = "http://127.0.0.1:5221"
  $apiEnv["META_API_KEY"] = "qa-dummy"
  $apiEnv["USE_POSTGRES"] = "1"
  $apiEnv["CONNECTIONSTRINGS__APP"] = $PgConn
  Write-Host ("  api-cmd=dotnet [" + $dll + "]")
  Write-Host ("  api-env=ASPNETCORE_URLS, META_API_BASE, META_API_KEY, USE_POSTGRES, CONNECTIONSTRINGS__APP")
  $script:apiProc = New-OwnedProcess "dotnet" $dll $root $apiEnv $apiLog $apiErr
  Write-Host ("  api-pid=" + $script:apiProc.Id)
  $fakeEnv = @{}
  $script:fakeProc = New-OwnedProcess "node.exe" "qa/fake-provider.mjs --port 5221" $root $fakeEnv $fakeLog $fakeErr
  Write-Host ("  fake-pid=" + $script:fakeProc.Id)
  $ready = $false
  for ($i = 0; $i -lt 40 -and -not $ready; $i++) {
    Start-Sleep -Milliseconds 500
    try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:5121/ready" -TimeoutSec 3 -UseBasicParsing; if ($r.StatusCode -eq 200) { $ready = $true } } catch { }
  }
  if (-not $ready) { throw "API /ready never 200" }
  Ok "ready-200"
  Step "atomic-probe-memory"
  & dotnet run --project qa/AtomicUnitProbe/AtomicUnitProbe.csproj --no-build 2>&1 | Select-Object -Last 14
  if ($LASTEXITCODE -ne 0) { throw "atomic memory probe failed" }
  Ok "atomic-memory"
  Step "atomic-probe-pg-required"
  $pgOut = & dotnet run --project qa/AtomicUnitProbe/AtomicUnitProbe.csproj --no-build -- --pg $PgConn 2>&1
  $pgOut | Select-Object -Last 8
  if ($LASTEXITCODE -ne 0) { throw "atomic PG probe failed" }
  if ($pgOut -match "SKIPPED") { throw "PG section skipped; non-skip result required" }
  Ok "atomic-pg-nonskip"
  Step "record-probe-pg-required"
  $rpOut = & dotnet run --project qa/RecordAtomicProbe/RecordAtomicProbe.csproj --no-build -- $PgConn 2>&1
  $rpOut | Select-Object -Last 4
  if ($LASTEXITCODE -ne 0) { throw "record probe failed" }
  if ($rpOut -match "SKIP") { throw "record probe skipped PG; non-skip result required" }
  Ok "record-pg-nonskip"
  Step "admin-diag-gate-on-shared-db"
  $anonCode = 0
  try { $ar = Invoke-WebRequest -Uri "http://127.0.0.1:5121/api/admin/diag" -TimeoutSec 10 -UseBasicParsing; $anonCode = $ar.StatusCode } catch { $rpc = $_.Exception.Response; if ($rpc -ne $null) { $anonCode = [int]$rpc.StatusCode } }
  if ($anonCode -ne 401) { throw "shared-db anon diag must be 401, got=" + $anonCode }
  Ok "shared-db-anon-401"
  $regCode = 0
  $reg = $null
  try {
    $reg = Invoke-WebRequest -Uri "http://127.0.0.1:5121/api/auth/register" -Method POST -ContentType "application/json" -Body '{"email":"runner-admin@qa.local","password":"qa-runner-admin-1"}' -TimeoutSec 10 -UseBasicParsing
    $regCode = $reg.StatusCode
  } catch {
    $resp = $_.Exception.Response
    if ($resp -ne $null) { $regCode = [int]$resp.StatusCode }
  }
  if ($regCode -ne 201 -and $regCode -ne 409) { throw "admin register status=" + $regCode }
  if ($regCode -eq 409) {
    $lin = Invoke-WebRequest -Uri "http://127.0.0.1:5121/api/auth/login" -Method POST -ContentType "application/json" -Body '{"email":"runner-admin@qa.local","password":"qa-runner-admin-1"}' -TimeoutSec 10 -UseBasicParsing
    $tok = ($lin.Content | ConvertFrom-Json).token
  } else { $tok = ($reg.Content | ConvertFrom-Json).token }
  $denCode = 0
  try { $dd = Invoke-WebRequest -Uri "http://127.0.0.1:5121/api/admin/diag" -Headers @{ Authorization = "Bearer $tok" } -TimeoutSec 10 -UseBasicParsing; $denCode = $dd.StatusCode } catch { $rp2 = $_.Exception.Response; if ($rp2 -ne $null) { $denCode = [int]$rp2.StatusCode } }
  if ($denCode -ne 403) { throw "shared-db non-admin diag must be 403, got=" + $denCode }
  Ok "shared-db-nonadmin-403"
  Step "admin-diag-positive-on-fresh-tmpdb"
  try {
    $tc0 = New-Object System.Net.Sockets.TcpClient
    $iar0 = $tc0.BeginConnect("127.0.0.1", 5122, $null, $null)
    $null = $iar0.AsyncWaitHandle.WaitOne(800)
    if ($tc0.Connected) { throw "ephemeral tmp api port 5122 already in use; refusing to reuse unverified server" }
    $tc0.Close()
  } catch { if ($_.Exception.Message -match "already in use") { throw } }
  $tmpDb = "simceo_runner_tmp"
  & docker exec simceo-integration-qa-pg psql -U simceo -d postgres -c "DROP DATABASE IF EXISTS `"$tmpDb`";" | Out-Null
  & docker exec simceo-integration-qa-pg psql -U simceo -d postgres -c "CREATE DATABASE `"$tmpDb`";" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "tmp db create failed" }
  $tmpApiLog = Join-Path $pubDir "tmpapi.log"
  $tmpApiErr = Join-Path $pubDir "tmpapi.err.log"
  $tmpEnv = @{ "ASPNETCORE_URLS" = "http://127.0.0.1:5122" }
  $tmpEnv["META_API_BASE"] = "http://127.0.0.1:5221"
  $tmpEnv["META_API_KEY"] = "qa-dummy"
  $tmpEnv["USE_POSTGRES"] = "1"
  $tmpEnv["CONNECTIONSTRINGS__APP"] = "Host=127.0.0.1;Port=15441;Database=$tmpDb;Username=simceo;Password=qa-only"
  $tmpApi = New-OwnedProcess "dotnet" $dll $root $tmpEnv $tmpApiLog $tmpApiErr
  Write-Host ("  tmp-api-pid=" + $tmpApi.Id)
  try {
    $tmpReady = $false
    for ($i = 0; $i -lt 40 -and -not $tmpReady; $i++) {
      Start-Sleep -Milliseconds 500
      try { $rr = Invoke-WebRequest -Uri "http://127.0.0.1:5122/ready" -TimeoutSec 3 -UseBasicParsing; if ($rr.StatusCode -eq 200) { $tmpReady = $true } } catch { }
    }
    if (-not $tmpReady) { throw "tmp API /ready never 200" }
    Ok "tmpapi-ready-200"
    $treg = Invoke-WebRequest -Uri "http://127.0.0.1:5122/api/auth/register" -Method POST -ContentType "application/json" -Body '{"email":"tmp-admin@qa.local","password":"qa-tmp-admin-1"}' -TimeoutSec 10 -UseBasicParsing
    if ($treg.StatusCode -ne 201) { throw "tmp first register must be 201, got=" + $treg.StatusCode }
    $ttok = ($treg.Content | ConvertFrom-Json).token
    $tdg = Invoke-WebRequest -Uri "http://127.0.0.1:5122/api/admin/diag" -Headers @{ Authorization = "Bearer $ttok" } -TimeoutSec 10 -UseBasicParsing
    if ($tdg.StatusCode -ne 200) { throw "tmp admin diag must be 200, got=" + $tdg.StatusCode }
    $dj = $tdg.Content | ConvertFrom-Json
    if ($null -eq $dj.counts -or $null -eq $dj.security) { throw "tmp diag missing counts/security" }
    $raw = $tdg.Content
    foreach ($bad in @("token", "session", "connectionstring", "password", "secret", "apikey", "api_key", "bearer")) {
      if ($raw -match ("(?i)`"" + $bad + "`"\s*:")) { throw "tmp diag leaks field resembling " + $bad }
    }
    Ok "tmp-admin-diag-200-redacted"
    $treg2 = Invoke-WebRequest -Uri "http://127.0.0.1:5122/api/auth/register" -Method POST -ContentType "application/json" -Body '{"email":"tmp-other@qa.local","password":"qa-tmp-other-1"}' -TimeoutSec 10 -UseBasicParsing
    $ttok2 = ($treg2.Content | ConvertFrom-Json).token
    $den2 = 0
    try { $dd2 = Invoke-WebRequest -Uri "http://127.0.0.1:5122/api/admin/diag" -Headers @{ Authorization = "Bearer $ttok2" } -TimeoutSec 10 -UseBasicParsing; $den2 = $dd2.StatusCode } catch { $rp3 = $_.Exception.Response; if ($rp3 -ne $null) { $den2 = [int]$rp3.StatusCode } }
    if ($den2 -ne 403) { throw "tmp non-admin diag must be 403, got=" + $den2 }
    Ok "tmp-nonadmin-403"
  } finally {
    try { if (-not $tmpApi.HasExited) { $tmpApi.Kill() }; $tmpApi.WaitForExit(8000) | Out-Null } catch { }
    try { $tmpApi.Dispose() } catch { }
    Start-Sleep -Seconds 2
    $stillOpen = $false
    try {
      $tc = New-Object System.Net.Sockets.TcpClient
      $iar = $tc.BeginConnect("127.0.0.1", 5122, $null, $null)
      $null = $iar.AsyncWaitHandle.WaitOne(800)
      if ($tc.Connected) { $stillOpen = $true }
      $tc.Close()
    } catch { }
    if ($stillOpen) { throw "tmp api port 5122 still open after kill" }
    & docker exec simceo-integration-qa-pg psql -U simceo -d postgres -c "DROP DATABASE IF EXISTS `"$tmpDb`";" | Out-Null
    Write-Host "  tmpdb dropped, tmp api stopped"
  }
  Write-Host ""
  Write-Host ("PUBLISHED-RUNNER PASS head=" + $head + " dll=" + $hash)
} catch {
  Write-Host ("RUNNER-ERROR " + $_.Exception.Message)
  $fail++
} finally {
  Step "cleanup"
  Cleanup
  try { Stop-Transcript | Out-Null } catch { }
}
Write-Host ("RUNNER-EXIT=" + $fail)
exit $fail
