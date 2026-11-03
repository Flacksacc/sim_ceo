# ESSENTIALS QA required runner (Muse-owned).
# Single authoritative pipeline: dangerous-port preflight -> source-bind ->
# fresh publish (native exit 0, Api+Postgres DLL SHA) -> owned PG identity/start
# (leave RUNNING, never stop) -> per-leg FRESH DB -> owned hidden API/fake/web
# (retained handles, bounded stdout/stderr EOF + completion, unexpected-exit
# watch, async-spawn failure) -> node leg (outer-finally child handling) ->
# bounded cleanup (drop ONLY own regex-verified DBs, aggregate every error) ->
# ONE final verdict AFTER all cleanup. Any failure (incl. cleanup) exits nonzero.
# Owned ONLY: API 5142, fake 5242, web 5194, PG simceo-integration-qa-pg:15441.
# NEVER user 5080/5173, shared CDP 9333, backend 5140/5240/5193, or foreign containers.
# leg0 is contract-only (no publish, no container start, no DB). leg2/leg7 are
# self-managed (they own their API generations for restarts/outage); the runner
# only creates/drops their exclusive DB and enforces port/identity discipline.
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
$runId = [guid]::NewGuid().ToString("N")
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$artRoot = Join-Path $ProjectRoot (".tmp/ess-qa/" + $stamp + "-" + $runId.Substring(0, 8))
if (Test-Path $artRoot) { Write-Output "FATAL run artifact dir already exists (refusing overwrite): $artRoot"; exit 2 }
New-Item -ItemType Directory -Force $artRoot | Out-Null
$fail = 0
$OWN_API = 5142; $OWN_FAKE = 5242; $OWN_WEB = 5194; $OWN_PG = 15441
$OWN_FULL_ID = "14bcfcf7a243e5bc73385da4d24a33475b6eab0b04b8185e1d1534c13d1a1891"
$OWN_IMAGE = "postgres:16-alpine"
if ($PSVersionTable.PSVersion.Major -lt 7) { Write-Output "FATAL runner requires pwsh 7 (native exit codes unreadable on 5.1)"; exit 2 }
# BEFORE ANY START: reject unsupported/dangerous ports (exact owned set only).
if ($ApiPort -ne $OWN_API -or $FakePort -ne $OWN_FAKE -or $WebPort -ne $OWN_WEB -or $PgPort -ne $OWN_PG) {
  Write-Output ("FATAL unsupported ports (owned set is API={0} FAKE={1} WEB={2} PG={3}): got {4}/{5}/{6}/{7}" -f $OWN_API, $OWN_FAKE, $OWN_WEB, $OWN_PG, $ApiPort, $FakePort, $WebPort, $PgPort)
  Write-Output "FATAL refusing: never user 5080/5173, shared CDP 9333, backend 5140/5240/5193, or foreign agents"
  exit 2
}
$ownedDb = @()
# LIVE provider arming (leg8 ONLY, OFF by default): the real app key AND the
# selected private APP base arrive privately from PRIMARY in the runner child
# ENV AFTER deterministic final builds. Capture both once, then STRIP them
# from this process so no other child can inherit them implicitly; forward
# them ONLY to the leg8 API + leg env (blank base => app ModelGatewayBase
# default https://api.meta.ai/v1; NEVER the fake). Never log the key (base
# is nonsecret), never use the inherited coding-profile key/base.
$liveArmed = ([System.Environment]::GetEnvironmentVariable("ESS_QA_LIVE", "Process") -eq "1")
$liveKey = [System.Environment]::GetEnvironmentVariable("META_API_KEY", "Process")
$liveBase = [System.Environment]::GetEnvironmentVariable("META_API_BASE", "Process")
if ($liveArmed -and [string]::IsNullOrWhiteSpace($liveKey)) { throw "ESS_QA_LIVE=1 but no META_API_KEY in runner env; primary must supply the app key via child env" }
if ($liveArmed -and -not [string]::IsNullOrWhiteSpace($liveBase)) {
  $lbCheck = $liveBase.Trim().TrimEnd('/')
  if ($lbCheck -match '127\.0\.0\.1|localhost|::1|:5242|/fake' -or $lbCheck -notmatch '^https?://') { throw "ESS_QA_LIVE=1 but META_API_BASE is loopback/fake/unsupported [$lbCheck]; refusing to send real key to fake" }
}
if ($liveArmed) {
  $liveBaseLog = if ([string]::IsNullOrWhiteSpace($liveBase)) { "https://api.meta.ai/v1 (app ModelGatewayBase default)" } else { $liveBase.Trim() }
  Write-Output ("  live-base=" + $liveBaseLog)
  [System.Environment]::SetEnvironmentVariable("META_API_KEY", $null, "Process"); [System.Environment]::SetEnvironmentVariable("ESS_QA_LIVE", $null, "Process"); [System.Environment]::SetEnvironmentVariable("META_API_BASE", $null, "Process")
}
$ownedDb = @()
$containerWasRunning = $false
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
$LegFiles = @{ leg0 = "tests/leg0-root-config.mjs"; leg1 = "tests/leg1-core-smoke.mjs"; leg2 = "tests/leg2-old-upgrade.mjs"; leg3 = "tests/leg3-records.mjs"; leg4 = "tests/leg4-secretary.mjs"; leg5 = "tests/leg5-voice.mjs"; leg6 = "tests/leg6-web.mjs"; leg7 = "tests/leg7-backup-outage.mjs"; leg4b = "tests/leg4b-secretary-lostack.mjs"; leg8 = "tests/leg8-live-asr.mjs" }
$SelfManaged = @("leg2", "leg4b", "leg7")
function Start-Owned($file, $argList, $workdir, $envmap, $outFile, $errFile) {
  $backup = @{}
  foreach ($k in $envmap.Keys) { $backup[$k] = [System.Environment]::GetEnvironmentVariable($k, "Process"); [System.Environment]::SetEnvironmentVariable($k, [string]$envmap[$k], "Process") }
  try {
    $psi = @{ FilePath = $file; ArgumentList = $argList; WorkingDirectory = $workdir; WindowStyle = "Hidden"; RedirectStandardOutput = $outFile; RedirectStandardError = $errFile; PassThru = $true }
    $p = Start-Process @psi
    if ($null -eq $p) { throw "process start returned null handle: $file $argList" }
    if (-not ($p -is [System.Diagnostics.Process])) { throw "process start returned non-process handle: $file" }
    return $p
  } finally {
    foreach ($k in $envmap.Keys) { [System.Environment]::SetEnvironmentVariable($k, $backup[$k], "Process") }
  }
}
function Confirm-Exited($proc, $label, $outFile, $errFile) {
  # Verifies a waited child: real handle, exited, native exit readable, both
  # stdio files present (EOF observed via completed files, not a second wait).
  try {
    if ($null -eq $proc) { return @{ ok = $false; msg = $label + ": null handle" } }
    if (-not ($proc -is [System.Diagnostics.Process])) { return @{ ok = $false; msg = $label + ": not a process handle" } }
    try { $proc.Refresh() } catch { }
    $hasExited = $false
    try { $hasExited = $proc.HasExited } catch { return @{ ok = $false; msg = $label + ": HasExited unreadable: " + $_.Exception.Message } }
    if (-not $hasExited) { return @{ ok = $false; msg = $label + ": still running (EOF not observed)" } }
    $code = $null
    try { $code = $proc.ExitCode } catch { return @{ ok = $false; msg = $label + ": native exit unreadable (fail-closed)" } }
    if ($null -eq $code) { return @{ ok = $false; msg = $label + ": native exit null (fail-closed)" } }
    $o = Test-Path $outFile; $e = Test-Path $errFile
    if (-not ($o -and $e)) { return @{ ok = $false; msg = $label + ": stdio files missing out=$o err=$e" } }
    return @{ ok = $true; msg = $label + ": exit=$code"; code = $code }
  } catch { return @{ ok = $false; msg = $label + ": confirm-fatal: " + $_.Exception.Message } }
}
function Stop-Owned($proc, $label, $timeoutSec = 20) {
  # Bounded kill/wait/dispose. Never throws; every anomaly is returned, never swallowed.
  try {
    if ($null -eq $proc) { return @{ ok = $true; msg = $label + ": null (already gone)" } }
    if (-not ($proc -is [System.Diagnostics.Process])) { return @{ ok = $false; msg = $label + ": not a process handle" } }
    try {
      if (-not $proc.HasExited) {
        try { $proc.Kill() } catch { return @{ ok = $false; msg = $label + ": kill failed: " + $_.Exception.Message } }
        $done = $false
        try { $done = $proc.WaitForExit($timeoutSec * 1000) } catch { return @{ ok = $false; msg = $label + ": wait failed: " + $_.Exception.Message } }
        if (-not $done) { return @{ ok = $false; msg = $label + ": kill-timeout ${timeoutSec}s (still alive)" } }
      }
    } catch { return @{ ok = $false; msg = $label + ": stop error: " + $_.Exception.Message } }
    try { $proc.Refresh() } catch { }
    $stillRunning = $false
    try { $stillRunning = -not $proc.HasExited } catch { return @{ ok = $false; msg = $label + ": HasExited unreadable after stop" } }
    if ($stillRunning) { return @{ ok = $false; msg = $label + ": still running after stop" } }
    $code = "unknown"
    try { $code = $proc.ExitCode } catch { }
    try { $proc.Dispose() } catch { return @{ ok = $false; msg = $label + ": dispose error: " + $_.Exception.Message } }
    return @{ ok = $true; msg = $label + ": stopped exit=$code" }
  } catch { return @{ ok = $false; msg = $label + ": stop-fatal: " + $_.Exception.Message } }
}
function ValidDbName($db) { return ($db -match '^essentials_leg[0-9][a-z]?_[a-z0-9_]+$') }
try {
  Step "root-config"
  foreach ($rel in @("SimCEO.sln", "server/SimCEO.Api/SimCEO.Api.csproj", "web/src/App.tsx", "server/SimCEO.Api/Work/Secretary.cs")) {
    if (!(Test-Path (Join-Path $Approot $rel))) { throw "Approot marker missing: $rel (Approot=$Approot)" }
  }
  foreach ($rel in @("qa/essentials/run-essentials.ps1", "qa/fixtures.cjs", "qa/voice-wav.mjs", "SimCEO.sln")) {
    if (!(Test-Path (Join-Path $ProjectRoot $rel))) { throw "ProjectRoot marker missing: $rel (ProjectRoot=$ProjectRoot)" }
  }
  if ($ProjectRoot -eq $Approot) { throw "Approot must differ from ProjectRoot" }
  Ok "roots-validated project=$ProjectRoot approot=$Approot run=$runId"
  "RUN-ID=$runId" | Set-Content (Join-Path $artRoot "run-id.txt")
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
  $legList = @($Legs -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
  $supported = @("leg0", "leg1", "leg2", "leg3", "leg4", "leg4b", "leg5", "leg6", "leg7", "leg8")
  foreach ($l in $legList) { if ($supported -notcontains $l) { throw "unsupported leg '$l' (supported: $($supported -join ',')); nothing is deferred-silently" } }
  $needBackend = @($legList | Where-Object { $_ -ne "leg0" })
  Step "container-identity"
  $ident = DockerInspectIdent
  if ($ident.id -ne $OWN_FULL_ID) { throw "container id mismatch: got $($ident.id) want $OWN_FULL_ID" }
  if ($ident.image -ne $OWN_IMAGE) { throw "container image mismatch: $($ident.image)" }
  if ($ident.ports -notmatch "15441") { throw "container port mismatch: $($ident.ports)" }
  $containerWasRunning = $ident.running
  $ident | ConvertTo-Json | Set-Content (Join-Path $artRoot "container-ident.json")
  Write-Output ("  id=" + $ident.id.Substring(0, 24) + " image=" + $ident.image + " ports=" + $ident.ports + " running=" + $ident.running)
  if ($needBackend.Count -gt 0 -and -not $ident.running) {
    & docker start $PgContainer | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker start failed for owned container" }
    Start-Sleep -Seconds 3
    $re = DockerInspectIdent
    if (-not $re.running) { throw "owned container did not stay running" }
    if ($re.id -ne $OWN_FULL_ID) { throw "container identity changed across start; refusing" }
  }
  Ok "container-identity-verified (leave RUNNING; primary manages lifecycle centrally)"
  $dll = ""
  $apiDllHash = ""
  $pgDllHash = ""
  $pubDir = ""
  if ($needBackend.Count -gt 0) {
    Step "fresh-publish"
    $pubDir = Join-Path $artRoot "apipub"
    & dotnet publish (Join-Path $Approot "server/SimCEO.Api/SimCEO.Api.csproj") -o $pubDir --nologo -v q
    if ($LASTEXITCODE -ne 0) { throw "publish native exit=$LASTEXITCODE (never test a pre-existing binary after failure)" }
    $dll = Join-Path $pubDir "SimCEO.Api.dll"
    $pgdll = Join-Path $pubDir "SimCEO.Postgres.dll"
    if (!(Test-Path $dll)) { throw "published SimCEO.Api.dll missing" }
    if (!(Test-Path $pgdll)) { throw "Postgres backend not staged in published bundle (SimCEO.Postgres.dll missing)" }
    $apiDllHash = (Get-FileHash $dll -Algorithm SHA256).Hash.ToLower()
    $pgDllHash = (Get-FileHash $pgdll -Algorithm SHA256).Hash.ToLower()
    Write-Output ("  API-DLL-SHA256=" + $apiDllHash)
    Write-Output ("  PG-DLL-SHA256=" + $pgDllHash)
    (@{ apiDllSha256 = $apiDllHash; pgDllSha256 = $pgDllHash; apiDll = $dll; pgDll = $pgdll } | ConvertTo-Json) | Set-Content (Join-Path $artRoot "publish.json")
    Ok "publish-native-exit0"
    Step "selftest-gate"
    $stDir = Join-Path $artRoot "selftest"
    New-Item -ItemType Directory -Force $stDir | Out-Null
    $stEnv = @{ USE_POSTGRES = "0"; META_API_BASE = "http://127.0.0.1:$FakePort"; META_API_KEY = "" }
    $stProc = $null
    try {
      $stProc = Start-Owned "dotnet" @($dll, "--selftest") $pubDir $stEnv (Join-Path $stDir "stdout.log") (Join-Path $stDir "stderr.log")
      if (-not $stProc.WaitForExit(300000)) { try { $stProc.Kill() } catch { }; throw "selftest timed out after 300s" }
      $stConf = Confirm-Exited $stProc "selftest" (Join-Path $stDir "stdout.log") (Join-Path $stDir "stderr.log")
      if (-not $stConf.ok) { throw $stConf.msg }
      $stCode = $stConf.code
      Write-Output ("  selftest-native-exit=" + $stCode)
      "SELFTEST-EXIT=$stCode" | Set-Content (Join-Path $stDir "exit.txt")
      if ($stCode -ne 0) { Bad "selftest-gate" ("exit=" + $stCode + " (see selftest/stdout.log; pipeline continues, verdict stays FAIL until server owner fixes)") }
      else { Ok "selftest-gate-pass" }
    } catch { Bad "selftest-gate" $_.Exception.Message } finally {
      if ($null -ne $stProc) { $sr = Stop-Owned $stProc "selftest-cleanup"; if (-not $sr.ok) { Bad "selftest-cleanup-stop" $sr.msg } }
      $stProc = $null
    }
  } else {
    Write-Output "  publish skipped (contract-only legs; NOT acceptance)"
  }
  if ($legList -contains "leg6") {
    Step "web-build"
    $webDir = Join-Path $Approot "web"
    $wbDir = Join-Path $artRoot "webbuild"
    New-Item -ItemType Directory -Force $wbDir | Out-Null
    if (!(Test-Path (Join-Path $webDir "node_modules"))) {
      Write-Output "  node_modules missing; running owned npm ci (build artifact only, no source edit)"
      & npm --prefix $webDir ci --no-audit --no-fund > (Join-Path $wbDir "npm-ci.log") 2>&1
      if ($LASTEXITCODE -ne 0) { throw "npm ci native exit=$LASTEXITCODE" }
    }
    & npm --prefix $webDir run build > (Join-Path $wbDir "npm-build.log") 2>&1
    $wbCode = $LASTEXITCODE
    Write-Output ("  web-build-native-exit=" + $wbCode)
    "WEB-BUILD-EXIT=$wbCode" | Set-Content (Join-Path $wbDir "exit.txt")
    if ($wbCode -ne 0) { throw "production web build failed exit=$wbCode (log: webbuild/npm-build.log); leg6 cannot claim a matching build" }
    $distDir = Join-Path $webDir "dist"
    if (!(Test-Path (Join-Path $distDir "index.html"))) { throw "web dist/index.html missing after build" }
    $distFiles = Get-ChildItem $distDir -Recurse -File | Sort-Object FullName
    $dh = [System.Security.Cryptography.SHA256]::Create()
    foreach ($f in $distFiles) {
      $rel = $f.FullName.Substring($distDir.Length)
      $dh.TransformBlock([System.Text.Encoding]::UTF8.GetBytes($rel), 0, $rel.Length, $null, 0) | Out-Null
      $fb = [System.IO.File]::ReadAllBytes($f.FullName)
      $dh.TransformBlock($fb, 0, $fb.Length, $null, 0) | Out-Null
    }
    $dh.TransformFinalBlock([byte[]]@(), 0, 0) | Out-Null
    $distHash = ([System.BitConverter]::ToString($dh.Hash)).Replace("-", "").ToLower()
    Write-Output ("  dist-files=" + $distFiles.Count + " dist-sha256=" + $distHash)
    (@{ files = $distFiles.Count; sha256 = $distHash; dir = $distDir } | ConvertTo-Json) | Set-Content (Join-Path $wbDir "dist.json")
    Ok "web-build-exit0"
  }
  foreach ($leg in $legList) {
    Step ("leg-" + $leg)
    $legDir = Join-Path $artRoot $leg
    if (Test-Path $legDir) { throw "leg artifact dir already exists (refusing overwrite): $legDir" }
    New-Item -ItemType Directory -Force $legDir | Out-Null
    $legBaseEnv = @{ ESS_QA_PROJECTROOT = $ProjectRoot; ESS_QA_APPROOT = $Approot; ESS_QA_HEAD = $head; ESS_QA_DIRTY_HASH = $dirtyHash; ESS_QA_RUN_ID = $runId; ESS_QA_LEG = $leg; ESS_QA_CONTAINER_IDENT = (Join-Path $artRoot "container-ident.json"); ESS_QA_ARTIFACT_DIR = $legDir; ESS_QA_PUBLISH_DIR = $pubDir; ESS_QA_API_DLL = $dll; ESS_QA_API_DLL_HASH = $apiDllHash; ESS_QA_PG_DLL_HASH = $pgDllHash; QA_API = "http://127.0.0.1:$ApiPort"; QA_FAKE = "http://127.0.0.1:$FakePort"; QA_WEB = "http://127.0.0.1:$WebPort" }
    if ($liveArmed -and $leg -eq "leg8") { $legBaseEnv["ESS_QA_LIVE"] = "1"; $legBaseEnv["META_API_KEY"] = $liveKey; if (-not [string]::IsNullOrWhiteSpace($liveBase)) { $legBaseEnv["META_API_BASE"] = $liveBase.Trim() } }
    if ($leg -eq "leg0") {
      $p0 = $null
      try {
        $p0 = Start-Owned "node.exe" @("qa/essentials/" + $LegFiles[$leg]) $ProjectRoot $legBaseEnv (Join-Path $legDir "stdout.log") (Join-Path $legDir "stderr.log")
        if (-not $p0.WaitForExit($LegTimeoutSec * 1000)) { try { $p0.Kill() } catch { }; throw "leg0 timed out after ${LegTimeoutSec}s" }
        $c0 = Confirm-Exited $p0 "leg0" (Join-Path $legDir "stdout.log") (Join-Path $legDir "stderr.log")
        if (-not $c0.ok) { throw $c0.msg }
        if ($c0.code -ne 0) { Bad $leg ("exit=" + $c0.code) } else { Ok ($leg + "-pass") }
      } catch { Bad $leg $_.Exception.Message } finally {
        if ($null -ne $p0) { $r0 = Stop-Owned $p0 ("leg0-cleanup"); if (-not $r0.ok) { Bad ($leg + "-cleanup-stop") $r0.msg }; $p0 = $null }
      }
      continue
    }
    $db = ("essentials_" + $leg + "_" + $stamp + "_" + $runId.Substring(0, 8)).ToLower() -replace '[^a-z0-9_]', '_'
    if (-not (ValidDbName $db)) { Bad $leg ("generated db name failed validation: " + $db); continue }
    $exists = & docker exec $PgContainer psql -U simceo -d postgres -t -A -c "SELECT 1 FROM pg_database WHERE datname='$db';" 2>&1
    if ($LASTEXITCODE -ne 0) { Bad $leg ("db-exists-check-failed " + $exists); continue }
    if ([string]$exists -match "1") { Bad $leg ("refusing existing DB $db"); continue }
    & docker exec $PgContainer psql -U simceo -d postgres -c "CREATE DATABASE $db;" | Out-Null
    if ($LASTEXITCODE -ne 0) { Bad $leg "create-db-failed"; continue }
    $script:ownedDb += $db
    $pgConn = "Host=127.0.0.1;Port=$PgPort;Database=$db;Username=simceo;Password=qa-only"
    # Per-leg DB identity, bound AFTER $db exists for THIS leg (never stale).
    $legBaseEnv["ESS_QA_DB"] = $db
    $legBaseEnv["ESS_QA_PG_CONN"] = $pgConn
    if ($SelfManaged -contains $leg) {
      Ok ($leg + "-self-managed (runner owns DB only; leg owns its API generations)")
      $legProc = $null
      try {
        $legEnv = $legBaseEnv.Clone()
        $legEnv["ESS_QA_SELF_MANAGED"] = "1"
        $legEnv["ESS_QA_PG_CONN"] = $pgConn
        $legEnv["ESS_QA_DB"] = $db
        $legProc = Start-Owned "node.exe" @("qa/essentials/" + $LegFiles[$leg]) $ProjectRoot $legEnv (Join-Path $legDir "stdout.log") (Join-Path $legDir "stderr.log")
        if (-not $legProc.WaitForExit($LegTimeoutSec * 1000)) { try { $legProc.Kill() } catch { }; throw "leg $leg timed out after ${LegTimeoutSec}s" }
        $clc = Confirm-Exited $legProc $leg (Join-Path $legDir "stdout.log") (Join-Path $legDir "stderr.log")
        if (-not $clc.ok) { throw $clc.msg }
        if ($clc.code -ne 0) { Bad $leg ("exit=" + $clc.code) } else { Ok ($leg + "-pass") }
      } catch { Bad $leg $_.Exception.Message } finally {
        if ($null -ne $legProc) {
          $lr = Stop-Owned $legProc ($leg + "-cleanup")
          if (-not $lr.ok) { Bad ($leg + "-cleanup-stop") $lr.msg } else { Ok ($leg + "-child-eof-observed") }
          $legProc = $null
        }
        if ((PortOpen $ApiPort) -or (PortOpen $FakePort)) { Bad ($leg + "-ports-leaked") "owned port still open after self-managed leg (leg must stop its children)" }
        else { Ok ($leg + "-ports-free") }
      }
      continue
    }
    $apiOut = Join-Path $legDir "api.log"; $apiErr = Join-Path $legDir "api.err.log"
    $fakeOut = Join-Path $legDir "fake.log"; $fakeErr = Join-Path $legDir "fake.err.log"
    $apiProc = $null; $fakeProc = $null; $webProc = $null; $legProc = $null
    try {
      $apiEnv = @{ ASPNETCORE_URLS = "http://127.0.0.1:$ApiPort"; META_API_BASE = "http://127.0.0.1:$FakePort"; META_API_KEY = "qa-dummy"; USE_POSTGRES = "1"; CONNECTIONSTRINGS__APP = $pgConn }
      if ($liveArmed -and $leg -eq "leg8") {
        $apiEnv["META_API_KEY"] = $liveKey
        if ([string]::IsNullOrWhiteSpace($liveBase)) { $apiEnv.Remove("META_API_BASE") }
        else { $apiEnv["META_API_BASE"] = $liveBase.Trim() }
        if ($apiEnv.ContainsKey("META_API_BASE") -and [string]$apiEnv["META_API_BASE"] -match '127\.0\.0\.1|localhost|::1|:5242') { throw "refusing fake/loopback META_API_BASE for live leg8" }
      }
      $apiProc = Start-Owned "dotnet" @($dll) $pubDir $apiEnv $apiOut $apiErr
      Write-Output ("  api-pid=" + $apiProc.Id)
      $fakeProc = Start-Owned "node.exe" @("qa/essentials/helpers/essentials-fake.mjs", "--port", "$FakePort") $ProjectRoot @{} $fakeOut $fakeErr
      Write-Output ("  fake-pid=" + $fakeProc.Id)
      $ready = $false
      for ($i = 0; $i -lt 90 -and -not $ready; $i++) {
        Start-Sleep -Milliseconds 1000
        $apiGone = $false; $fakeGone = $false
        try { $apiGone = $apiProc.HasExited } catch { $apiGone = $true }
        try { $fakeGone = $fakeProc.HasExited } catch { $fakeGone = $true }
        if ($apiGone -or $fakeGone) {
          $aTail = ""; $fTail = ""
          try { $aTail = (Get-Content $apiErr -Tail 5 -ErrorAction SilentlyContinue) -join " " } catch { }
          try { $fTail = (Get-Content $fakeErr -Tail 5 -ErrorAction SilentlyContinue) -join " " } catch { }
          throw "service exited during startup (apiGone=$apiGone fakeGone=$fakeGone) apiErr=[$aTail] fakeErr=[$fTail]"
        }
        try { $rr = Invoke-WebRequest -Uri "http://127.0.0.1:$ApiPort/ready" -TimeoutSec 3 -UseBasicParsing; if ($rr.StatusCode -eq 200) { $ready = $true } } catch { }
      }
      if (-not $ready) { throw "API /ready never 200 (90s)" }
      $fready = $false
      for ($i = 0; $i -lt 20 -and -not $fready; $i++) {
        try { $fr = Invoke-WebRequest -Uri "http://127.0.0.1:$FakePort/__health" -TimeoutSec 3 -UseBasicParsing; if ($fr.StatusCode -eq 200) { $fready = $true } } catch { Start-Sleep -Milliseconds 500 }
      }
      if (-not $fready) { throw "fake /__health never 200" }
      Ok "services-ready"
      if ($leg -eq "leg6") {
        $webHelper = Join-Path $ProjectRoot "qa/essentials/helpers/essentials-web.mjs"
        $distDir = Join-Path $Approot "web/dist"
        $webOut = Join-Path $legDir "web.log"; $webErr = Join-Path $legDir "web.err.log"
        $webProc = Start-Owned "node.exe" @($webHelper, "--dir", $distDir, "--port", "$WebPort", "--api", "http://127.0.0.1:$ApiPort") $ProjectRoot @{} $webOut $webErr
        Write-Output ("  web-pid=" + $webProc.Id)
        $wready = $false
        for ($i = 0; $i -lt 30 -and -not $wready; $i++) {
          $wGone = $false
          try { $wGone = $webProc.HasExited } catch { $wGone = $true }
          if ($wGone) {
            $wTail = ""
            try { $wTail = (Get-Content $webErr -Tail 5 -ErrorAction SilentlyContinue) -join " " } catch { }
            throw "web static server exited during startup err=[$wTail]"
          }
          try { $wr = Invoke-WebRequest -Uri "http://127.0.0.1:$WebPort/api/backend" -TimeoutSec 3 -UseBasicParsing; if ($wr.StatusCode -eq 200) { $wready = $true } } catch { Start-Sleep -Milliseconds 500 }
        }
        if (-not $wready) { throw "web proxy /api/backend never 200 (30s)" }
        Ok "web-ready"
      }
      $legProc = Start-Owned "node.exe" @("qa/essentials/" + $LegFiles[$leg]) $ProjectRoot $legBaseEnv (Join-Path $legDir "stdout.log") (Join-Path $legDir "stderr.log")
      if (-not $legProc.WaitForExit($LegTimeoutSec * 1000)) { try { $legProc.Kill() } catch { }; throw "leg $leg timed out after ${LegTimeoutSec}s" }
      $legConf = Confirm-Exited $legProc $leg (Join-Path $legDir "stdout.log") (Join-Path $legDir "stderr.log")
      if (-not $legConf.ok) { throw $legConf.msg }
      if ($legConf.code -ne 0) { Bad $leg ("exit=" + $legConf.code) } else { Ok ($leg + "-pass") }
      $apiGoneAfter = $false; $fakeGoneAfter = $false
      try { $apiGoneAfter = $apiProc.HasExited } catch { $apiGoneAfter = $true }
      try { $fakeGoneAfter = $fakeProc.HasExited } catch { $fakeGoneAfter = $true }
      if ($apiGoneAfter) { Bad ($leg + "-api-unexpected-exit") "owned API exited before cleanup (see api.err.log tail)" }
      if ($fakeGoneAfter) { Bad ($leg + "-fake-unexpected-exit") "owned fake exited before cleanup" }
      if ($leg -eq "leg6" -and $null -ne $webProc) {
        $wGoneAfter = $false
        try { $wGoneAfter = $webProc.HasExited } catch { $wGoneAfter = $true }
        if ($wGoneAfter) { Bad ($leg + "-web-unexpected-exit") "owned web server exited before cleanup" }
      }
    } catch {
      Bad $leg $_.Exception.Message
    } finally {
      $legStopOk = $true
      if ($null -ne $legProc) {
        $lsc = Confirm-Exited $legProc ($leg + "-child") (Join-Path $legDir "stdout.log") (Join-Path $legDir "stderr.log")
        if (-not $lsc.ok -and $lsc.msg -notmatch "still running") { Bad ($leg + "-child-eof") $lsc.msg; $legStopOk = $false }
        $lsr = Stop-Owned $legProc ($leg + "-child")
        if (-not $lsr.ok) { Bad ($leg + "-child-stop") $lsr.msg; $legStopOk = $false }
        else { Ok ($leg + "-child-eof-observed") }
        $legProc = $null
      }
      $wsr = @{ ok = $true; msg = "n/a" }
      if ($null -ne $webProc) { $wsr = Stop-Owned $webProc ("web-" + $leg); $webProc = $null }
      $asr = Stop-Owned $apiProc ("api-" + $leg)
      $fsr = Stop-Owned $fakeProc ("fake-" + $leg)
      $apiProc = $null; $fakeProc = $null
      if (-not $wsr.ok) { Bad ($leg + "-web-stop") $wsr.msg; $legStopOk = $false }
      if (-not $asr.ok) { Bad ($leg + "-api-stop") $asr.msg; $legStopOk = $false }
      if (-not $fsr.ok) { Bad ($leg + "-fake-stop") $fsr.msg; $legStopOk = $false }
      Start-Sleep -Seconds 2
      if ((PortOpen $ApiPort) -or (PortOpen $FakePort) -or (($leg -eq "leg6") -and (PortOpen $WebPort))) { Bad ($leg + "-ports-leaked") "owned port still open after stop" }
      elseif (-not $legStopOk) { Bad ($leg + "-cleanup-stop") "owned process stop failed (see above)" }
      else { Ok ($leg + "-processes-cleaned") }
    }
  }
} catch {
  Bad "runner" $_.Exception.Message
} finally {
  Step "cleanup"
  try {
    foreach ($db in $script:ownedDb) {
      if (-not (ValidDbName $db)) { Bad "cleanup-refuses-db" $db; continue }
      $re2 = DockerInspectIdent
      if ($re2.id -ne $OWN_FULL_ID) { Bad "cleanup-identity" "container changed; refusing DB ops"; break }
      & docker exec $PgContainer psql -U simceo -d postgres -c "DROP DATABASE IF EXISTS $db;" | Out-Null
      if ($LASTEXITCODE -ne 0) { Bad "drop-db" $db } else { Write-Output ("  dropped " + $db) }
    }
  } catch { Bad "cleanup-dbs" $_.Exception.Message }
  try {
    $re3 = DockerInspectIdent
    Write-Output ("  container left RUNNING=" + $re3.running + " (primary manages lifecycle centrally; never stopped here)")
  } catch { Bad "cleanup-container-verify" $_.Exception.Message }
}
Step "final-verdict"
$verdict = if ($fail -eq 0) { "ESSENTIALS-RUNNER PASS" } else { "ESSENTIALS-RUNNER FAIL" }
$result = @($verdict, "run=$runId", "head=$head", "dirty=$dirtyHash", "apiDll=$apiDllHash", "pgDll=$pgDllHash", "legs=$Legs", "failures=$fail")
$result | Set-Content (Join-Path $artRoot "essentials-result.txt")
Write-Output ""
Write-Output ($verdict + " head=" + $head + " failures=" + $fail)
Write-Output ("RESULT-ARTIFACT=" + (Join-Path $artRoot "essentials-result.txt"))
exit $fail
