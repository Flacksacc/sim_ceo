# SimCEO phases 0-3 + Muse lanes authoritative QA runner. Isolated artifacts only.
# Barrier: no full green claim until main plus nav merge and retriever repairs complete.
# Wires every Muse-authored test. Syntax check only until barrier clears.
param([switch]$Pg, [switch]$Browser, [switch]$BrowserOnly)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location $root
$procs = @()
$fail = 0
$vite = $null
$ownPgContainer = $false
function Step($name) { Write-Host ""; Write-Host ("=== " + $name + " ===") }
function Check($name, $cond, $detail = "") {
  if ($cond) { Write-Host ("  ok " + $name) } else { Write-Host ("  FAIL " + $name + " " + $detail); $script:fail++ }
}
function Need-File($rel) {
  $full = Join-Path $root $rel
  $present = Test-Path $full
  Check ("present-" + $rel) $present $full
  return $present
}
function Test-PortFree($port) {
  $c = $null
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect("127.0.0.1", $port, $null, $null)
    $connected = $iar.AsyncWaitHandle.WaitOne(400)
    if ($connected -and $c.Connected) { return $false }
    return $true
  } catch { return $true } finally { try { if ($c) { $c.Close() } } catch {} }
}
function Wait-Http($url, $secs = 60) {
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
    if (Test-PortFree $port) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}
function Start-Hidden($file, $argline, $out, $err, $envmap, $workdir = $null) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $file; $psi.Arguments = $argline
  $psi.WorkingDirectory = ($workdir ? $workdir : $root)
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  foreach ($k in $envmap.Keys) { $psi.Environment[$k] = $envmap[$k] }
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  $null = New-Item -ItemType Directory -Force (Split-Path "$root/$out")
  $outW = New-Object System.IO.StreamWriter("$root/$out", $false)
  $errW = New-Object System.IO.StreamWriter("$root/$err", $false)
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
  try { $entry.p.WaitForExit(10000) } catch {}
  try { $entry.outW.Close(); $entry.errW.Close() } catch {}
}
# Stop-Tree removed: CIM child discovery violates hidden-window/owned-handle policy; owned procs stop via retained Stop-Hidden handles + port-closed gates.
try {
  if ($BrowserOnly -and $Pg) { throw "-BrowserOnly cannot be combined with -Pg; fail closed" }
  if ($BrowserOnly) { $Browser = $true }
  if ($BrowserOnly) {
    Step "mode: browser-only rerun (frontend checks only)"
    Write-Host "  browser-only mode does NOT claim backend acceptance (skips backend HTTP/selftest/probes/publish/PG/lane blocks)"
  }
  Step "preflight: refuse unexpected listeners on QA ports (never reuse unverified server)"
  $preflightOk = $true
  foreach ($port in @(5099, 5100, 5199, 5174)) {
    $free = Test-PortFree $port
    Check ("preflight-port-" + $port + "-free") $free "unexpected listener; refusing to reuse unverified server"
    if (-not $free) { $preflightOk = $false }
  }
  if (-not $preflightOk) { throw "preflight refused: unexpected listener on QA ports 5099/5100/5199/5174" }
  Step "build isolated API + Postgres backend"
  $qaApi = Join-Path $root ".tmp/qa/api/"
  dotnet build server/SimCEO.Api/SimCEO.Api.csproj --nologo -v q "-p:OutputPath=$qaApi" -p:SkipStagePostgres=true
  if ($LASTEXITCODE -ne 0) { throw "api build failed" }
  $qaPg = Join-Path $root ".tmp/qa/pg-stage/"
  dotnet build server/SimCEO.Postgres/SimCEO.Postgres.csproj --nologo -v q -p:SkipStagePostgres=true "-p:OutputPath=$qaPg"
  if ($LASTEXITCODE -ne 0) { throw "postgres build failed" }
  Get-ChildItem .tmp/qa/pg-stage/*.dll -Exclude SimCEO.Api.* | Copy-Item -Destination .tmp/qa/api/ -Force
  Check "isolated-build" (Test-Path .tmp/qa/api/SimCEO.Api.dll)
  Step "fake provider :5199"
  Start-Hidden "node" "qa/fake-provider.mjs --port 5199" ".tmp/qa-fake.log" ".tmp/qa-fake.err.log" @{} | Out-Null
  Check "fake-up" (Wait-Http "http://127.0.0.1:5199/__health" 20)
  Step "disposable API :5099 (in-memory)"
  $apiEnv = @{ ASPNETCORE_URLS = "http://127.0.0.1:5099"; META_API_BASE = "http://127.0.0.1:5199"; META_API_KEY = "qa-dummy" }
  Start-Hidden "dotnet" ".tmp/qa/api/SimCEO.Api.dll" ".tmp/qa-api5099.log" ".tmp/qa-api5099.err.log" $apiEnv | Out-Null
  Check "api5099-up" (Wait-Http "http://127.0.0.1:5099/health" 60)
  $backend = (Invoke-WebRequest -Uri "http://127.0.0.1:5099/api/backend" -UseBasicParsing | ConvertFrom-Json)
  Check "backend-is-memory" ($backend.mode -eq "memory") $backend.mode
  if (-not $BrowserOnly) {
  Step "HTTP suite (memory)"
  $env:QA_API = "http://127.0.0.1:5099"
  node qa/http-qa.mjs --tag mem; Check "http-mem" ($LASTEXITCODE -eq 0)
  Step "HTTP backup round-trip (memory)"
  node qa/http-qa.mjs --mode backup --tag mem-backup; Check "http-backup" ($LASTEXITCODE -eq 0)
  Step "records review (memory)"
  $recPresent = Need-File "qa/records-review-regression.mjs"
  if ($recPresent) {
    $env:QA_API = "http://127.0.0.1:5099"
    node qa/records-review-regression.mjs --tag mem-records; Check "records-mem" ($LASTEXITCODE -eq 0)
  }
  Step "provider envelope: real C-sharp gateway probe x8 (own loopback :5202, dummy key)"
  $provPresent = Need-File "qa/provider-envelope-regression.mjs"
  $provFix = Need-File "qa/provider-envelope-regression.fixtures.json"
  if ($provPresent -and $provFix) {
    node qa/provider-envelope-regression.mjs; Check "provider-envelope-real" ($LASTEXITCODE -eq 0)
  }
  Step "storage failure probe: real begin-failure x7 (isolated artifact, no API lock)"
  $storProj = Need-File "qa/StorageFailureProbe/StorageFailureProbe.csproj"
  $storProg = Need-File "qa/StorageFailureProbe/Program.cs"
  if ($storProj -and $storProg) {
    $storOut = Join-Path $root ".tmp/qa/probe-storage/"
    dotnet build qa/StorageFailureProbe/StorageFailureProbe.csproj --nologo -v q -p:SkipStagePostgres=true "-p:OutputPath=$storOut"
    Check "storage-probe-build" ($LASTEXITCODE -eq 0)
    if ($LASTEXITCODE -eq 0) {
      dotnet (Join-Path $storOut "StorageFailureProbe.dll"); Check "storage-probe-7" ($LASTEXITCODE -eq 0)
    }
  }
  Step "public evidence probe: actual fetcher (isolated artifact, injected fixtures only)"
  $pubProj = Need-File "qa/PublicEvidenceProbe/PublicEvidenceProbe.csproj"
  $pubProg = Need-File "qa/PublicEvidenceProbe/Program.cs"
  if ($pubProj -and $pubProg) {
    $pubOut = Join-Path $root ".tmp/qa/probe-public/"
    dotnet build qa/PublicEvidenceProbe/PublicEvidenceProbe.csproj --nologo -v q -p:SkipStagePostgres=true "-p:OutputPath=$pubOut"
    Check "public-evidence-build" ($LASTEXITCODE -eq 0)
    if ($LASTEXITCODE -eq 0) {
      dotnet (Join-Path $pubOut "PublicEvidenceProbe.dll"); Check "public-evidence-probe" ($LASTEXITCODE -eq 0)
    }
  }
  Step "root-unit focused probe (memory, non-skip)"
  $atomicProj = Need-File "qa/AtomicUnitProbe/AtomicUnitProbe.csproj"
  $atomicProg = Need-File "qa/AtomicUnitProbe/Program.cs"
  if ($atomicProj -and $atomicProg) {
    $atomicOut = Join-Path $root ".tmp/qa/probe-atomic/"
    dotnet build qa/AtomicUnitProbe/AtomicUnitProbe.csproj --nologo -v q -p:SkipStagePostgres=true "-p:OutputPath=$atomicOut"
    Check "atomic-probe-build" ($LASTEXITCODE -eq 0)
    if ($LASTEXITCODE -eq 0) {
      dotnet (Join-Path $atomicOut "AtomicUnitProbe.dll"); Check "atomic-probe-mem" ($LASTEXITCODE -eq 0)
    }
  }
  Step "selftest"
  dotnet .tmp/qa/api/SimCEO.Api.dll --selftest 2>&1 | Select-Object -Last 2
  Check "selftest" ($LASTEXITCODE -eq 0)
  }
  Step "web build"
  Push-Location web; npm run build 2>&1 | Select-Object -Last 4; $wcode = $LASTEXITCODE; Pop-Location
  Check "web-build" ($wcode -eq 0)
  if (-not $BrowserOnly) {
  Step "production publish verification (real PG staging, no SkipStage)"
  $pubDir = Join-Path $root ".tmp/qa/pub-verify/"
  dotnet publish server/SimCEO.Api/SimCEO.Api.csproj --nologo -v q -o $pubDir
  Check "publish-ok" ($LASTEXITCODE -eq 0)
  Check "publish-stages-pg" (Test-Path (Join-Path $pubDir "SimCEO.Postgres.dll"))
  $pubApi = Join-Path $pubDir "SimCEO.Api.dll"
  Check "publish-api-present" (Test-Path $pubApi) $pubApi
  if (-not (Test-Path $pubApi)) { throw "published SimCEO.Api.dll missing; refusing PG launches" }
  $pubApiArg = [char]34 + $pubApi + [char]34
  }
  if ($Pg -and (-not $BrowserOnly)) {
    Step "disposable Postgres simceo-qa-pg :15433"
    $names = docker ps -a --format "{{.Names}}"
    if (-not ($names -contains "simceo-qa-pg")) { docker create --name simceo-qa-pg -e POSTGRES_PASSWORD=qa-only -e POSTGRES_DB=simceo -e POSTGRES_USER=simceo -p 127.0.0.1:15433:5432 postgres:16-alpine | Out-Null }
    docker start simceo-qa-pg | Out-Null
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
      docker exec simceo-qa-pg pg_isready -U simceo -d simceo 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { $ready = $true; break }
      Start-Sleep -Seconds 2
    }
    Check "pg-ready" $ready
    if ($ready) { $ownPgContainer = $true }
    Step "disposable API :5100 (postgres)"
    $pgEnv = @{ ASPNETCORE_URLS = "http://127.0.0.1:5100"; META_API_BASE = "http://127.0.0.1:5199"; META_API_KEY = "qa-dummy"; USE_POSTGRES = "1" }
    $pgEnv["CONNECTIONSTRINGS__APP"] = "Host=127.0.0.1;Port=15433;Database=simceo;Username=simceo;Password=qa-only"
    $api5100 = Start-Hidden "dotnet" $pubApiArg ".tmp/qa-api5100.log" ".tmp/qa-api5100.err.log" $pgEnv
    Check "api5100-up" (Wait-Http "http://127.0.0.1:5100/health" 90)
    $be = (Invoke-WebRequest -Uri "http://127.0.0.1:5100/api/backend" -UseBasicParsing | ConvertFrom-Json)
    Check "backend-is-postgres" ($be.mode -eq "postgres") (($be.mode) + " err=" + ($be.error))
    $env:QA_API = "http://127.0.0.1:5100"
    $env:QA_PERSIST_FILE = "$root/.tmp/qa-persist.json"
    node qa/http-qa.mjs --tag pg; Check "http-pg" ($LASTEXITCODE -eq 0)
    node qa/http-qa.mjs --mode backup --tag pg-backup; Check "http-pg-backup" ($LASTEXITCODE -eq 0)
    Step "identity boundary (PG only, after pg plus backup, before persist-write)"
    $identPresent = Need-File "qa/identity-boundary-regression.mjs"
    if ($identPresent) {
      $env:QA_API = "http://127.0.0.1:5100"
      node qa/identity-boundary-regression.mjs --tag pg-identity; Check "identity-boundary-pg" ($LASTEXITCODE -eq 0)
    }
    Step "ownerless PG seed (pre-restart; verify runs post-restart)"
    $env:QA_API = "http://127.0.0.1:5100"
    node qa/roster-regression.mjs --tag pg-laneA-seed; Check "laneA-roster-pg-seed" ($LASTEXITCODE -eq 0)
    Step "restart persistence"
    node qa/http-qa.mjs --mode persist-write --tag pg-write; Check "persist-write" ($LASTEXITCODE -eq 0)
    Step "rollback interview probe on owned PG (before restart)"
    $env:QA_API = "http://127.0.0.1:5100"
    $rbPresent = Need-File "qa/rollback-interview-probe.mjs"
    if ($rbPresent) {
      node qa/rollback-interview-probe.mjs; Check "rollback-probe-run" ($LASTEXITCODE -eq 0)
    }
    Step "pending restart --write (PG, immediately before owned :5100 restart)"
    $pendPresent = Need-File "qa/pending-restart.mjs"
    if ($pendPresent) {
      $env:QA_API = "http://127.0.0.1:5100"
      node qa/pending-restart.mjs --write; Check "pending-write" ($LASTEXITCODE -eq 0)
      if ($LASTEXITCODE -ne 0) { throw "pending-restart --write failed; refusing owned restart" }
    } else { throw "pending-restart.mjs missing; refusing owned restart" }
    Write-Host "  restarting owned :5100 (old pid check plus port-gone gate)"
    $oldPid = $api5100.Id
    $entry5100 = $procs | Where-Object { $_.p -eq $api5100 } | Select-Object -First 1; Stop-Hidden $entry5100
    Check "api5100-exited" ($api5100.HasExited) ("pid=" + $oldPid)
    Check "api5100-port-closed" (Wait-PortClosed 5100 30) "owned :5100 port still open after kill"
    $api5100b = Start-Hidden "dotnet" $pubApiArg ".tmp/qa-api5100b.log" ".tmp/qa-api5100b.err.log" $pgEnv
    Check "restart-pid-changed" ($api5100b.Id -ne $oldPid) ("old=" + $oldPid + " new=" + $api5100b.Id)
    Check "api5100b-up" (Wait-Http "http://127.0.0.1:5100/health" 90)
    $be2 = (Invoke-WebRequest -Uri "http://127.0.0.1:5100/api/backend" -UseBasicParsing | ConvertFrom-Json)
    Check "backend-still-postgres" ($be2.mode -eq "postgres") (($be2.mode) + " err=" + ($be2.error))
    node qa/http-qa.mjs --mode persist-verify --tag pg-verify; Check "persist-verify" ($LASTEXITCODE -eq 0)
    $env:QA_API = "http://127.0.0.1:5100"
    if ($rbPresent) {
      node qa/rollback-interview-probe.mjs --verify; Check "rollback-probe-verify" ($LASTEXITCODE -eq 0)
    }
    if ($pendPresent) {
      node qa/pending-restart.mjs --verify; Check "pending-verify" ($LASTEXITCODE -eq 0)
    }
    Step "records review PG (HTTP suite)"
    $env:QA_API = "http://127.0.0.1:5100"
    $env:QA_PG_CONTAINER = "simceo-qa-pg"
    $env:QA_API_DLL = Join-Path $pubDir "SimCEO.Api.dll"
    if ($recPresent) {
      node qa/records-review-regression.mjs --tag pg-records; Check "records-pg" ($LASTEXITCODE -eq 0)
    }
    Step "records atomicity probe (code-only backend seam)"
    $probeProj = Need-File "qa/RecordAtomicProbe/RecordAtomicProbe.csproj"
    if ($probeProj) {
      $probeOut = Join-Path $root ".tmp/qa/probe-records/"
      dotnet build qa/RecordAtomicProbe/RecordAtomicProbe.csproj --nologo -v q -p:SkipStagePostgres=true "-p:OutputPath=$probeOut"
      Check "records-probe-build" ($LASTEXITCODE -eq 0)
      if ($LASTEXITCODE -eq 0) {
        dotnet (Join-Path $probeOut "RecordAtomicProbe.dll") "Host=127.0.0.1;Port=15433;Database=simceo;Username=simceo;Password=qa-only"; Check "records-probe" ($LASTEXITCODE -eq 0)
      }
    }
    Step "root-unit focused probe (PG, non-skip)"
    if ($atomicProj) {
      dotnet (Join-Path $atomicOut "AtomicUnitProbe.dll") --pg "Host=127.0.0.1;Port=15433;Database=simceo;Username=simceo;Password=qa-only"; Check "atomic-probe-pg" ($LASTEXITCODE -eq 0)
    } else { Check "atomic-probe-present" $false "AtomicUnitProbe missing; refusing PG claim" }
    Step "records legacy + commit-gate seed (before owned :5100 restart)"
    if ($recPresent) {
      $env:QA_API = "http://127.0.0.1:5100"
      $env:QA_PERSIST_FILE = "$root/.tmp/qa-persist.json"
      node qa/records-review-regression.mjs --tag pg-records-pre --pre-legacy; Check "records-pre-legacy" ($LASTEXITCODE -eq 0)
      if ($LASTEXITCODE -ne 0) { throw "records legacy seed failed; refusing owned restart" }
      node qa/records-review-regression.mjs --tag pg-records-pre --pre-commit; Check "records-pre-commit" ($LASTEXITCODE -eq 0)
      if ($LASTEXITCODE -ne 0) { throw "records commit seed failed; refusing owned restart" }
    } else { throw "records-review-regression.mjs missing; refusing records restart flow" }
    Write-Host "  restarting owned :5100 for records (old pid check plus port-gone gate)"
    $oldRecPid = $api5100b.Id
    $entry5100r = $procs | Where-Object { $_.p -eq $api5100b } | Select-Object -First 1; Stop-Hidden $entry5100r
    Check "records-api5100-exited" ($api5100b.HasExited) ("pid=" + $oldRecPid)
    Check "records-api5100-port-closed" (Wait-PortClosed 5100 30) "owned :5100 port still open after kill"
    $api5100c = Start-Hidden "dotnet" $pubApiArg ".tmp/qa-api5100c.log" ".tmp/qa-api5100c.err.log" $pgEnv
    Check "records-restart-pid-changed" ($api5100c.Id -ne $oldRecPid) ("old=" + $oldRecPid + " new=" + $api5100c.Id)
    Check "records-api5100c-up" (Wait-Http "http://127.0.0.1:5100/health" 90)
    $beRec = (Invoke-WebRequest -Uri "http://127.0.0.1:5100/api/backend" -UseBasicParsing | ConvertFrom-Json)
    Check "records-backend-still-postgres" ($beRec.mode -eq "postgres") (($beRec.mode) + " err=" + ($beRec.error))
    $env:QA_API = "http://127.0.0.1:5100"
    node qa/records-review-regression.mjs --tag pg-records-post1 --post-legacy; Check "records-post1-legacy" ($LASTEXITCODE -eq 0)
    node qa/records-review-regression.mjs --tag pg-records-post1 --post-commit; Check "records-post1-commit" ($LASTEXITCODE -eq 0)
    Write-Host "  restarting owned :5100 again for records double-restart stability"
    $oldRecPid2 = $api5100c.Id
    $entry5100r2 = $procs | Where-Object { $_.p -eq $api5100c } | Select-Object -First 1; Stop-Hidden $entry5100r2
    Check "records-api5100c-exited" ($api5100c.HasExited) ("pid=" + $oldRecPid2)
    Check "records-api5100c-port-closed" (Wait-PortClosed 5100 30) "owned :5100 port still open after kill"
    $api5100d = Start-Hidden "dotnet" $pubApiArg ".tmp/qa-api5100d.log" ".tmp/qa-api5100d.err.log" $pgEnv
    Check "records-restart2-pid-changed" ($api5100d.Id -ne $oldRecPid2) ("old=" + $oldRecPid2 + " new=" + $api5100d.Id)
    Check "records-api5100d-up" (Wait-Http "http://127.0.0.1:5100/health" 90)
    $env:QA_API = "http://127.0.0.1:5100"
    node qa/records-review-regression.mjs --tag pg-records-post2 --post-legacy; Check "records-post2-legacy" ($LASTEXITCODE -eq 0)
    node qa/records-review-regression.mjs --tag pg-records-post2 --post-commit; Check "records-post2-commit" ($LASTEXITCODE -eq 0)
  }
  if ($Browser) {
    Step "browser portable deps first (npm ci --prefix qa, never root scratch)"
    $pkgPresent = Need-File "qa/package.json"
    $lockPresent = Need-File "qa/package-lock.json"
    $depsOk = $false
    if ($pkgPresent -and $lockPresent) {
      npm ci --prefix qa 2>&1 | Select-Object -Last 5
      Check "qa-npm-ci" ($LASTEXITCODE -eq 0)
      if ($LASTEXITCODE -eq 0) { $depsOk = $true }
    }
    Step "browser QA (:5174 via CDP)"
    $webDir = Join-Path $root "web"; $script:vite = Start-Hidden "cmd" "/c npx vite --config vite.qa.config.ts" ".tmp/qa-vite5174.log" ".tmp/qa-vite5174.err.log" @{} $webDir
    Check "vite5174-up" (Wait-Http "http://127.0.0.1:5174/" 90)
    $env:QA_API = "http://127.0.0.1:5099"
    $env:QA_WEB = "http://127.0.0.1:5174"
    $bqPresent = Need-File "qa/browser/qa-browser.mjs"
    if ($bqPresent -and $depsOk) {
      node qa/browser/qa-browser.mjs; Check "browser-qa" ($LASTEXITCODE -eq 0)
    }
    Step "browser profile identity (fixture component proof; needs combined nav app)"
    $profPresent = Need-File "qa/browser/profile-identity.cjs"
    if ($profPresent -and $depsOk) {
      $env:QA_API = "http://127.0.0.1:5099"
      $env:QA_WEB = "http://127.0.0.1:5174"
      node qa/browser/profile-identity.cjs; Check "browser-profile-identity" ($LASTEXITCODE -eq 0)
    }
    Step "browser dossier evidence (rendered DossierView excerpt repair)"
    $dosPresent = Need-File "qa/browser/dossier-evidence.cjs"
    if ($dosPresent -and $depsOk) {
      $env:QA_API = "http://127.0.0.1:5099"
      $env:QA_WEB = "http://127.0.0.1:5174"
      node qa/browser/dossier-evidence.cjs; Check "browser-dossier-evidence" ($LASTEXITCODE -eq 0)
    }
    Step "browser wizard progress (rendered repair proof; needs merge)"
    $wizPresent = Need-File "qa/browser/wizard-progress.cjs"
    if ($wizPresent -and $depsOk) {
      $env:QA_API = "http://127.0.0.1:5099"
      $env:QA_WEB = "http://127.0.0.1:5174"
      node qa/browser/wizard-progress.cjs; Check "browser-wizard-progress" ($LASTEXITCODE -eq 0)
    }
    Step "browser navigation fixture (210 plus delayed record; needs merge)"
    $navPresent = Need-File "qa/navigation.cjs"
    if ($navPresent -and $depsOk) {
      $env:QA_API = "http://127.0.0.1:5099"
      $env:QA_WEB = "http://127.0.0.1:5174"
      node qa/navigation.cjs --base=http://127.0.0.1:5174/; Check "browser-navigation" ($LASTEXITCODE -eq 0)
    }
    Step "browser records review (strict UI proof)"
    $recUiPresent = Need-File "qa/browser/records-review-ui.cjs"
    if ($recUiPresent -and $depsOk) {
      $env:QA_API = "http://127.0.0.1:5099"
      $env:QA_WEB = "http://127.0.0.1:5174"
      $env:QA_SHOTS = "$root/.tmp/records-qa-shots"
      node qa/browser/records-review-ui.cjs; Check "browser-records-review" ($LASTEXITCODE -eq 0)
    }
  }
  if (-not $BrowserOnly) {
  Step "lane regressions on memory (required, QA_API 5099)"
  $env:QA_API = "http://127.0.0.1:5099"
  $laneA = Need-File "qa/roster-regression.mjs"
  $laneB = Need-File "qa/discussion-regression.mjs"
  $laneC = Need-File "qa/import-interview-regression.mjs"
  $laneD = Need-File "qa/core-closure-regression.mjs"
  if ($laneA) { node qa/roster-regression.mjs --tag mem-laneA; Check "laneA-roster-mem" ($LASTEXITCODE -eq 0) }
  if ($laneB) { node qa/discussion-regression.mjs --tag mem-laneB; Check "laneB-discussion-mem" ($LASTEXITCODE -eq 0) }
  if ($laneC) { node qa/import-interview-regression.mjs --tag mem-laneC; Check "laneC-import-interview-mem" ($LASTEXITCODE -eq 0) }
  if ($laneD) { node qa/core-closure-regression.mjs; Check "laneD-core-closure-mem" ($LASTEXITCODE -eq 0) }
  }
  if ($Pg -and (-not $BrowserOnly)) {
    Step "lane regressions on PG (required, QA_API 5100)"
    $env:QA_API = "http://127.0.0.1:5100"
    if ($laneA) { node qa/roster-regression.mjs --tag pg-laneA; Check "laneA-roster-pg" ($LASTEXITCODE -eq 0) }
    if ($laneB) { node qa/discussion-regression.mjs --tag pg-laneB; Check "laneB-discussion-pg" ($LASTEXITCODE -eq 0) }
    if ($laneC) { node qa/import-interview-regression.mjs --tag pg-laneC; Check "laneC-import-interview-pg" ($LASTEXITCODE -eq 0) }
    if ($laneD) { node qa/core-closure-regression.mjs; Check "laneD-core-closure-pg" ($LASTEXITCODE -eq 0) }
  }
} catch {
  Write-Host ("RUNNER ERROR: " + $_)
  $fail++
} finally {
  Step "cleanup"
  if ($vite) { try { $ventry = $procs | Where-Object { $_.p -eq $vite } | Select-Object -First 1; if ($ventry) { Stop-Hidden $ventry } else { try { if (-not $vite.HasExited) { $vite.Kill() } } catch {} } } catch {} Check "vite5174-port-closed" (Wait-PortClosed 5174 30) "owned port still open after kill" }
  foreach ($e in $procs) { Stop-Hidden $e }
  if ($Pg -and $ownPgContainer) { docker rm -f simceo-qa-pg 2>$null | Out-Null; Write-Host "  removed simceo-qa-pg" }
}
Write-Host ""
if ($fail -eq 0) { if ($BrowserOnly) { Write-Host "QA RUNNER PASS (browser-only; backend acceptance NOT claimed)" } else { Write-Host "QA RUNNER PASS" } } else { Write-Host ("QA RUNNER FAIL (" + $fail + ")"); exit 1 }
