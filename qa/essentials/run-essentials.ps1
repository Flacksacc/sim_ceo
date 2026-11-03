# ESSENTIALS QA required runner (Muse-owned).
# Single authoritative pipeline: source-bind -> fresh publish -> owned PG ->
# per-leg FRESH DB + owned API/fake -> node leg -> bounded cleanup ->
# ONE final verdict AFTER all cleanup. Any failure (incl. cleanup) exits nonzero.
# Owned: API 5142, fake 5242, web 5194, PG simceo-integration-qa-pg:15441.
# NEVER user 5080/5173/9333, backend 5140/5240/5193, or foreign containers.
param(
  [string]$ProjectRoot = "",
  [string]$Approot = "",
  [string]$Legs = "leg0,leg1,leg3,leg4,leg5",
  [int]$ApiPort = 5142,
  [int]$FakePort = 5242,
  [int]$WebPort = 5194,
  [int]$PgPort = 15441,
  [string]$PgContainer = "simceo-integration-qa-pg",
  [int]$LegTimeoutSec = 480
)
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = (Split-Path -Parent $ScriptDir | Split-Path -Parent) }
if ([string]::IsNullOrWhiteSpace($Approot)) { $Approot = (Join-Path (Split-Path -Parent $ProjectRoot) "essentials-runnable-worktree") }
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$Approot = [System.IO.Path]::GetFullPath($Approot)
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$artRoot = Join-Path $ProjectRoot ".tmp/ess-qa/$stamp"
New-Item -ItemType Directory -Force $artRoot | Out-Null
$fail = 0
if ($PSVersionTable.PSVersion.Major -lt 7) { Write-Output "FATAL runner requires pwsh 7 (native exit codes unreadable on 5.1)"; exit 2 }
$ownedDb = @()
$containerWasRunning = $false
$containerStartedByUs = $false
function Step($n) { Write-Output ""; Write-Output ("=== " + $n + " ===") }
function Ok($n) { Write-Output ("  ok " + $n) }
function Bad($n, $d = "") { Write-Output ("  FAIL " + $n + " " + $d); $script:fail++ }
function PortOpen($port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect("127.0.0.1", $port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(800)
    if ($ok -and $c.Connected) { return $true }
    return $false
  } catch { return $false } finally { try { $c.Close() } catch { } }
}
function DockerInspectIdent() {
  $raw = & docker inspect $PgContainer 2>&1
  if ($LASTEXITCODE -ne 0) { throw "docker inspect failed for owned container ${PgContainer}: $raw" }
  $obj = ($raw | ConvertFrom-Json)[0]
  $id = [string]$obj.Id
  $img = [string]$obj.Config.Image
  $ports = ""
  try {
    $hps = @()
    foreach ($src in @($obj.HostConfig.PortBindings, $obj.NetworkSettings.Ports)) {
      if ($null -eq $src) { continue }
      foreach ($prop in $src.PSObject.Properties) {
        foreach ($b in @($prop.Value)) { if ($b -and $b.HostPort) { $hps += [string]$b.HostPort } }
      }
    }
    $ports = (($hps | Select-Object -Unique) -join ",")
  } catch { $ports = "" }
  $running = [bool]$obj.State.Running
  return @{ id = $id; image = $img; ports = $ports; running = $running }
}
$LegFiles = @{ leg0 = "leg0-root-config.mjs"; leg1 = "leg1-core-smoke.mjs"; leg3 = "leg3-records.mjs"; leg4 = "leg4-secretary.mjs"; leg5 = "leg5-voice.mjs" }
function Start-Owned($file, $argList, $workdir, $envmap, $outFile, $errFile) {
  $backup = @{}
  foreach ($k in $envmap.Keys) { $backup[$k] = [System.Environment]::GetEnvironmentVariable($k, "Process"); [System.Environment]::SetEnvironmentVariable($k, [string]$envmap[$k], "Process") }
  try {
    $psi = @{ FilePath = $file; ArgumentList = $argList; WorkingDirectory = $workdir; WindowStyle = "Hidden"; RedirectStandardOutput = $outFile; RedirectStandardError = $errFile; PassThru = $true }
    $p = Start-Process @psi
    if ($null -eq $p) { throw "process start returned null: $file $args" }
    return $p
  } finally {
    foreach ($k in $envmap.Keys) { [System.Environment]::SetEnvironmentVariable($k, $backup[$k], "Process") }
  }
}
function Stop-Owned($proc, $label, $timeoutSec = 20) {
  if ($null -eq $proc) { return $true }
  try {
    if (-not $proc.HasExited) {
      $proc.Kill()
      if (-not $proc.WaitForExit($timeoutSec * 1000)) { Write-Output ("  cleanup-kill-timeout " + $label); return $false }
    } else { $proc.WaitForExit(5000) | Out-Null }
    try { $proc.Dispose() } catch { }
    return $true
  } catch { Write-Output ("  cleanup-stop-error " + $label + " " + $_.Exception.Message); return $false }
}
try {
  Step "root-config"
  foreach ($rel in @("SimCEO.sln", "server/SimCEO.Api/SimCEO.Api.csproj", "web/src/App.tsx", "server/SimCEO.Api/Work/Secretary.cs")) {
    if (!(Test-Path (Join-Path $Approot $rel))) { throw "Approot marker missing: $rel (Approot=$Approot)" }
  }
  foreach ($rel in @("qa/essentials/run-essentials.ps1", "qa/fixtures.cjs", "qa/voice-wav.mjs", "SimCEO.sln")) {
    if (!(Test-Path (Join-Path $ProjectRoot $rel))) { throw "ProjectRoot marker missing: $rel (ProjectRoot=$ProjectRoot)" }
  }
  if ($ProjectRoot -eq $Approot) { throw "Approot must differ from ProjectRoot" }
  Ok "roots-validated project=$ProjectRoot approot=$Approot"
  Step "source-bind"
  $head = (git -C $Approot rev-parse HEAD).Trim()
  if ($head -notmatch '^[0-9a-f]{40}$') { throw "bad Approot HEAD: $head" }
  $diffFile = Join-Path $artRoot "approot.diff"
  & git -C $Approot diff > $diffFile 2>$null
  $staged = Join-Path $artRoot "approot-staged.diff"
  & git -C $Approot diff --cached > $staged 2>$null
  $comboBytes = [System.Text.Encoding]::UTF8.GetBytes((Get-Content $diffFile -Raw) + "`n---STAGED---`n" + (Get-Content $staged -Raw))
  $dirtyHash = ([System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($comboBytes))).Replace("-", "").ToLower()
  "HEAD=$head" | Set-Content (Join-Path $artRoot "source-bind.txt")
  "DIRTY-DIFF-SHA256=$dirtyHash" | Add-Content (Join-Path $artRoot "source-bind.txt")
  Write-Output ("  HEAD=" + $head)
  Write-Output ("  DIRTY-DIFF-SHA256=" + $dirtyHash)
  Ok "source-bound"
  Step "port-guard"
  foreach ($p in @($ApiPort, $FakePort, $WebPort)) {
    if (PortOpen $p) { throw "owned port $p busy by foreign process; refusing to reuse" }
  }
  Ok "owned-ports-free $ApiPort/$FakePort/$WebPort"
  Step "container-identity"
  $ident = DockerInspectIdent
  if (-not $ident.id.StartsWith("14bcfcf7a243")) { throw "container id mismatch: $($ident.id)" }
  if ($ident.image -ne "postgres:16-alpine") { throw "container image mismatch: $($ident.image)" }
  if ($ident.ports -notmatch "15441") { throw "container port mismatch: $($ident.ports)" }
  $containerWasRunning = $ident.running
  $ident | ConvertTo-Json | Set-Content (Join-Path $artRoot "container-ident.json")
  Write-Output ("  id=" + $ident.id.Substring(0, 24) + " image=" + $ident.image + " ports=" + $ident.ports + " running=" + $ident.running)
  if (-not $ident.running) {
    & docker start $PgContainer | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker start failed for owned container" }
    $containerStartedByUs = $true
    Start-Sleep -Seconds 3
    $re = DockerInspectIdent
    if (-not $re.running) { throw "owned container did not stay running" }
  }
  $ident | ConvertTo-Json | Set-Content (Join-Path $artRoot "container-ident.json")
  Ok "container-identity-verified running=$($ident.running -or $containerStartedByUs)"
  $legList = @($Legs -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
  $supported = @("leg0", "leg1", "leg3", "leg4", "leg5")
  foreach ($l in $legList) { if ($supported -notcontains $l) { throw "unsupported leg '$l' (supported: $($supported -join ',')); deferred leg2/leg6/leg7 are NOT claimed" } }
  $needBackend = @($legList | Where-Object { $_ -ne "leg0" })
  $dll = ""
  $dllHash = ""
  if ($needBackend.Count -gt 0) {
    Step "fresh-publish"
    $pubDir = Join-Path $artRoot "apipub"
    & dotnet publish (Join-Path $Approot "server/SimCEO.Api/SimCEO.Api.csproj") -o $pubDir --nologo -v q
    if ($LASTEXITCODE -ne 0) { throw "publish native exit=$LASTEXITCODE (never test a pre-existing binary after failure)" }
    $dll = Join-Path $pubDir "SimCEO.Api.dll"
    if (!(Test-Path $dll)) { throw "published DLL missing" }
    if (!(Test-Path (Join-Path $pubDir "SimCEO.Postgres.dll"))) { throw "Postgres backend not staged in published bundle" }
    $dllHash = (Get-FileHash $dll -Algorithm SHA256).Hash
    Write-Output ("  DLL-SHA256=" + $dllHash)
    "DLL-SHA256=$dllHash" | Set-Content (Join-Path $artRoot "publish.txt")
    Ok "publish-native-exit0"
  } else {
    Write-Output "  publish skipped (contract-only legs; NOT acceptance)"
  }
  foreach ($leg in $legList) {
    Step ("leg-" + $leg)
    $legDir = Join-Path $artRoot $leg
    New-Item -ItemType Directory -Force $legDir | Out-Null
    if ($leg -eq "leg0") {
      $env0 = @{ ESS_QA_PROJECTROOT = $ProjectRoot; ESS_QA_APPROOT = $Approot; ESS_QA_HEAD = $head; ESS_QA_DIRTY_HASH = $dirtyHash; ESS_QA_CONTAINER_IDENT = (Join-Path $artRoot "container-ident.json"); QA_API = "http://127.0.0.1:$ApiPort"; QA_FAKE = "http://127.0.0.1:$FakePort"; QA_WEB = "http://127.0.0.1:$WebPort" }
      $p0 = Start-Owned "node.exe" @("qa/essentials/tests/leg0-root-config.mjs") $ProjectRoot $env0 (Join-Path $legDir "stdout.log") (Join-Path $legDir "stderr.log")
      if ($null -eq $p0 -or ($p0 -isnot [System.Diagnostics.Process])) { Bad $leg "no-process-handle"; continue }
      if (-not $p0.WaitForExit($LegTimeoutSec * 1000)) { try { $p0.Kill() } catch { }; Bad $leg "timeout"; continue }
      $p0.Refresh()
      $code0 = $p0.ExitCode
      if ($null -eq $code0) { Start-Sleep -Milliseconds 500; $p0.Refresh(); $code0 = $p0.ExitCode }
      if ($null -eq $code0) { Bad $leg "native-exit-unreadable (fail-closed)"; continue }
      try { $p0.Dispose() } catch { }
      if ($code0 -ne 0) { Bad $leg ("exit=" + $code0) } else { Ok ($leg + "-pass") }
      continue
    }
    $db = ("essentials_" + $leg + "_" + $stamp).ToLower() -replace '[^a-z0-9_]', '_'
    $exists = & docker exec $PgContainer psql -U simceo -d postgres -t -A -c "SELECT 1 FROM pg_database WHERE datname='$db';" 2>&1
    if ($LASTEXITCODE -ne 0) { Bad $leg ("db-exists-check-failed " + $exists); continue }
    if ([string]$exists -match "1") { Bad $leg ("refusing existing DB $db"); continue }
    & docker exec $PgContainer psql -U simceo -d postgres -c "CREATE DATABASE \`"$db\`";" | Out-Null
    if ($LASTEXITCODE -ne 0) { Bad $leg "create-db-failed"; continue }
    $script:ownedDb += $db
    $pgConn = "Host=127.0.0.1;Port=$PgPort;Database=$db;Username=simceo;Password=qa-only"
    $apiOut = Join-Path $legDir "api.log"; $apiErr = Join-Path $legDir "api.err.log"
    $fakeOut = Join-Path $legDir "fake.log"; $fakeErr = Join-Path $legDir "fake.err.log"
    $apiProc = $null; $fakeProc = $null
    try {
      $apiEnv = @{ ASPNETCORE_URLS = "http://127.0.0.1:$ApiPort"; META_API_BASE = "http://127.0.0.1:$FakePort"; META_API_KEY = "qa-dummy"; USE_POSTGRES = "1"; CONNECTIONSTRINGS__APP = $pgConn }
      $apiProc = Start-Owned "dotnet" @($dll) $ProjectRoot $apiEnv $apiOut $apiErr
      Write-Output ("  api-pid=" + $apiProc.Id)
      $fakeProc = Start-Owned "node.exe" @("qa/essentials/helpers/essentials-fake.mjs", "--port", "$FakePort") $ProjectRoot @{} $fakeOut $fakeErr
      Write-Output ("  fake-pid=" + $fakeProc.Id)
      $ready = $false
      for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
        Start-Sleep -Milliseconds 1000
        try { $rr = Invoke-WebRequest -Uri "http://127.0.0.1:$ApiPort/ready" -TimeoutSec 3 -UseBasicParsing; if ($rr.StatusCode -eq 200) { $ready = $true } } catch { }
        if ($apiProc.HasExited -or $fakeProc.HasExited) { break }
      }
      if (-not $ready) { throw "API /ready never 200 (apiExited=$($apiProc.HasExited) fakeExited=$($fakeProc.HasExited))" }
      $fready = $false
      for ($i = 0; $i -lt 20 -and -not $fready; $i++) {
        try { $fr = Invoke-WebRequest -Uri "http://127.0.0.1:$FakePort/__health" -TimeoutSec 3 -UseBasicParsing; if ($fr.StatusCode -eq 200) { $fready = $true } } catch { Start-Sleep -Milliseconds 500 }
      }
      if (-not $fready) { throw "fake /__health never 200" }
      Ok "services-ready"
      $legEnv = @{ ESS_QA_PROJECTROOT = $ProjectRoot; ESS_QA_APPROOT = $Approot; ESS_QA_HEAD = $head; ESS_QA_DIRTY_HASH = $dirtyHash; ESS_QA_CONTAINER_IDENT = (Join-Path $artRoot "container-ident.json"); ESS_QA_ARTIFACT_DIR = $legDir; QA_API = "http://127.0.0.1:$ApiPort"; QA_FAKE = "http://127.0.0.1:$FakePort"; QA_WEB = "http://127.0.0.1:$WebPort" }
      $legProc = Start-Owned "node.exe" @("qa/essentials/tests/" + $LegFiles[$leg]) $ProjectRoot $legEnv (Join-Path $legDir "stdout.log") (Join-Path $legDir "stderr.log")
      if (-not $legProc.WaitForExit($LegTimeoutSec * 1000)) { try { $legProc.Kill() } catch { }; throw "leg $leg timed out after ${LegTimeoutSec}s" }
      $legProc.Refresh()
      $lc = $legProc.ExitCode
      if ($null -eq $lc) { throw "leg $leg native exit unreadable (fail-closed)" }
      try { $legProc.Dispose() } catch { }
      if ($lc -ne 0) { Bad $leg ("exit=" + $lc) } else { Ok ($leg + "-pass") }
    } catch {
      Bad $leg $_.Exception.Message
    } finally {
      $okStop = $true
      $okStop = (Stop-Owned $apiProc ("api-" + $leg)) -and $okStop
      $okStop = (Stop-Owned $fakeProc ("fake-" + $leg)) -and $okStop
      Start-Sleep -Seconds 2
      if ((PortOpen $ApiPort) -or (PortOpen $FakePort)) { Bad ($leg + "-ports-leaked") "owned port still open after stop" }
      elseif (-not $okStop) { Bad ($leg + "-cleanup-stop") "owned process stop failed" }
      else { Ok ($leg + "-processes-cleaned") }
      $apiProc = $null; $fakeProc = $null
    }
  }
} catch {
  Bad "runner" $_.Exception.Message
} finally {
  Step "cleanup"
  try {
    foreach ($db in $script:ownedDb) {
      if ($db -notmatch '^essentials_leg[0-9]_[0-9]+$') { Bad "cleanup-refuses-db" $db; continue }
      $re2 = DockerInspectIdent
      if (-not $re2.id.StartsWith("14bcfcf7a243")) { Bad "cleanup-identity" "container changed; refusing DB ops"; break }
      & docker exec $PgContainer psql -U simceo -d postgres -c "DROP DATABASE IF EXISTS \`"$db\`";" | Out-Null
      if ($LASTEXITCODE -ne 0) { Bad "drop-db" $db } else { Write-Output ("  dropped " + $db) }
    }
  } catch { Bad "cleanup-dbs" $_.Exception.Message }
  try {
    if ($containerStartedByUs) {
      & docker stop $PgContainer | Out-Null
      Write-Output "  container stopped (restored prior STOPPED state)"
    } else { Write-Output ("  container left running=" + $containerWasRunning) }
  } catch { Bad "cleanup-container" $_.Exception.Message }
}
Step "final-verdict"
$verdict = if ($fail -eq 0) { "ESSENTIALS-RUNNER PASS" } else { "ESSENTIALS-RUNNER FAIL" }
$result = @($verdict, "head=$head", "dirty=$dirtyHash", "dll=$dllHash", "legs=$Legs", "failures=$fail")
$result | Set-Content (Join-Path $artRoot "essentials-result.txt")
Write-Output ""
Write-Output ($verdict + " head=" + $head + " failures=" + $fail)
Write-Output ("RESULT-ARTIFACT=" + (Join-Path $artRoot "essentials-result.txt"))
exit $fail