# Essentials-evidence required QA runner (Muse-owned lane).
# Fresh native build + memory/PG/HTTP probe with NON-SKIP PG gates,
# per-run artifact logs (never overwritten), strict nonzero on any failure.
# Owned scope only: single validated PG identity 127.0.0.1:15441/simceo with
# NEW exclusive essentials_evidence_* DBs. Never touches shared QA DBs,
# containers, user ports (5080/5173/9333) or other lanes. No user servers bound
# (the probe launches its own API only on owned 5146/5246 with owned DBs).
param([string]$PgConn = "Host=127.0.0.1;Port=15441;Database=postgres;Username=simceo;Password=qa-only")
$ErrorActionPreference = "Stop"
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location $root
$fail = 0
function Step($n) { Write-Host ""; Write-Host ("=== " + $n + " ===") }
function FailMsg($n, $d = "") { Write-Host ("  FAIL " + $n + " " + $d); $script:fail++ }
Step "source-bind"
$head = (git -C $root rev-parse HEAD).Trim()
$dirty = (git -C $root status --porcelain=v1).Trim()
Write-Host ("  HEAD=" + $head)
if ($dirty) { Write-Host "  TREE-DIRTY (building working tree as-is):"; Write-Host $dirty }
$dbsBefore = @()
Step "container-identity"
try {
  $inspRaw = (& docker inspect simceo-integration-qa-pg 2>&1)
  $inspExit = $LASTEXITCODE
  if ($inspExit -ne 0) { throw ("docker inspect native exit=" + $inspExit + " out=" + (($inspRaw | Out-String).Trim())) }
  $ij = ($inspRaw | Out-String) | ConvertFrom-Json
  $cid = $ij[0].Id
  if ($cid -ne "14bcfcf7a243e5bc73385da4d24a33475b6eab0b04b8185e1d1534c13d1a1891") { throw ("container id mismatch: " + $cid) }
  if ($ij[0].State.Status -ne "running") { throw ("container not running: " + $ij[0].State.Status) }
  if ((($inspRaw | Out-String)) -notmatch "15441") { throw "15441 port binding absent in container identity" }
  Write-Host "  container 14bcfcf7...1891 running with 15441 (native exit 0)"
} catch { FailMsg "container-identity" $_.Exception.Message }
Step "preflight-pg-owned"
try {
  $tc = New-Object System.Net.Sockets.TcpClient
  $iar = $tc.BeginConnect("127.0.0.1", 15441, $null, $null)
  if (-not $iar.AsyncWaitHandle.WaitOne(3000) -or -not $tc.Connected) { throw "shared QA PG 127.0.0.1:15441 unreachable" }
  $tc.Close()
  Write-Host "  pg-15441-reachable"
  $dbsRaw = (& docker exec simceo-integration-qa-pg psql -U simceo -d postgres -tAc "SELECT datname FROM pg_database WHERE datname LIKE 'essentials_evidence\_%' ORDER BY 1;" 2>&1)
  $dbsExit = $LASTEXITCODE
  if ($dbsExit -ne 0) { throw ("prior-db list native exit=" + $dbsExit) }
  $dbsBefore = @($dbsRaw | Where-Object { $_ -match "essentials_evidence_" })
  Write-Host ("  dbs-before: " + ($dbsBefore -join ","))
} catch { FailMsg "preflight-pg" $_.Exception.Message }
Step "fresh-build"
& dotnet build qa/essentials-evidence/essentials-evidence.csproj -c Release --nologo -v q
$buildExit = $LASTEXITCODE
Write-Host ("  build-native-exit=" + $buildExit)
if ($buildExit -ne 0) { FailMsg "build" ("native exit=" + $buildExit) }
Step "run-probe"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$artDir = Join-Path $PSScriptRoot ("artifacts\" + $stamp + "_" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force $artDir | Out-Null
Write-Host ("  ARTIFACT-DIR=" + $artDir)
$exe = Join-Path $PSScriptRoot "bin\Release\net10.0\EssentialsEvidence.exe"
if (!(Test-Path $exe)) { FailMsg "probe-exe-missing" $exe }
$testExit = -1
$pr = $null
try {
  if ($script:fail -eq 0) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.WorkingDirectory = $root
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $psi.CreateNoWindow = $true
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.Environment["PGCS"] = $PgConn
    $psi.Environment["ESSENTIALS_ARTIFACT_DIR"] = $artDir
    $pr = New-Object System.Diagnostics.Process
    $pr.StartInfo = $psi
    $null = $pr.Start()
    $outTask = $pr.StandardOutput.ReadToEndAsync()
    $errTask = $pr.StandardError.ReadToEndAsync()
    $exited = $pr.WaitForExit(600000)
    $drained = $false
    $out = ""; $err = ""
    if ($exited) {
      try {
        if ($outTask.Wait(60000) -and $errTask.Wait(60000)) { $out = $outTask.Result; $err = $errTask.Result; $drained = $true }
      } catch { $drained = $false }
    }
    if (-not $exited -or -not $drained) {
      try { $pr.Kill($true) } catch { }
      try { $pr.WaitForExit(15000) } catch { }
      FailMsg "probe-bounded" ("native timeout or stdout/stderr EOF not reached (exited=" + $exited + " drained=" + $drained + ")")
    }
    try { $testExit = $pr.ExitCode } catch { $testExit = -1 }
    $out | Out-File (Join-Path $artDir "console.txt") -Encoding utf8
    if ($err) { $err | Out-File (Join-Path $artDir "stderr.txt") -Encoding utf8 }
    Write-Host ("  test-native-exit=" + $testExit)
    if ($testExit -ne 0) { FailMsg "probe" ("native exit=" + $testExit) }
  }
} finally {
  try { if ($pr -ne $null) { $pr.Dispose() } } catch { }
}
Step "runner-artifacts"
$apiDll = Join-Path $root "server\SimCEO.Api\bin\Release\net10.0\SimCEO.Api.dll"
$probeDll = Join-Path $PSScriptRoot "bin\Release\net10.0\EssentialsEvidence.dll"
$rlines = @()
$rlines += "RUNNER-LOG essentials-evidence"
$rlines += ("HEAD=" + $head)
$rlines += ("DIRTY=" + (($dirty -replace "`r`n", "|").Trim()))
$rlines += ("build-native-exit=" + $buildExit)
$rlines += ("test-native-exit=" + $testExit)
Add-Type -AssemblyName System.Security | Out-Null
foreach ($dll in @($apiDll, $probeDll)) {
  if (Test-Path $dll) {
    try {
      $fs = [System.IO.File]::OpenRead($dll)
      try { $hh = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($fs)).Replace("-", "") }
      finally { $fs.Dispose() }
      $rlines += ((Split-Path $dll -Leaf) + "-SHA256=" + $hh)
    } catch { $rlines += ((Split-Path $dll -Leaf) + "-HASHERROR=" + $_.Exception.Message) }
  }
  else { $rlines += ((Split-Path $dll -Leaf) + "-MISSING") }
}
$rlines | Out-File (Join-Path $artDir "runner.log") -Encoding utf8
Get-Content (Join-Path $artDir "runner.log") | ForEach-Object { Write-Host ("  " + $_) }
Step "verify-prior-dbs-preserved"
try {
  $dbs2Raw = (& docker exec simceo-integration-qa-pg psql -U simceo -d postgres -tAc "SELECT datname FROM pg_database WHERE datname LIKE 'essentials_evidence\_%' ORDER BY 1;" 2>&1)
  $dbs2Exit = $LASTEXITCODE
  if ($dbs2Exit -ne 0) { throw ("prior-db verify native exit=" + $dbs2Exit) }
  $dbs = @($dbs2Raw | Where-Object { $_ -match "essentials_evidence_" })
  Write-Host ("  essentials dbs now: " + ($dbs -join ","))
  if ($dbs -notcontains "essentials_evidence_1d7f5f17316d") { FailMsg "prior-proof-db" "primary run DB missing after run" }
  $leaked = @($dbs | Where-Object { $dbsBefore -notcontains $_ })
  if ($leaked.Count -gt 0) { FailMsg "owned-db-leak" ("new DBs remain (only this-run DB may exist transiently, none may remain): " + ($leaked -join ",")) }
} catch { FailMsg "verify-dbs" $_.Exception.Message }
if ($script:fail -gt 0) { Write-Host ""; Write-Host ("RUNNER FAILED fail=" + $script:fail); exit 1 }
Write-Host ""; Write-Host "RUNNER COMPLETE"; exit 0