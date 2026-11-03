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
  Step "admin-diag"
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
  $dg = Invoke-WebRequest -Uri "http://127.0.0.1:5121/api/admin/diag" -Headers @{ Authorization = "Bearer $tok" } -TimeoutSec 10 -UseBasicParsing
  if ($dg.StatusCode -ne 200) { throw "admin diag status=" + $dg.StatusCode }
  Ok "admin-diag-200"
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
