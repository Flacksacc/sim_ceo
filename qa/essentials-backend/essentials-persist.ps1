param(
  [string]$Action = "status",
  [string]$Project = "simceo-essentials",
  [int]$AppPort = 5080,
  [string]$EnvFile = "",
  [string]$PgPassword = "",
  [string]$MetaKey = "",
  [string]$MetaBase = "",
  [string]$RollbackTag = ""
)
$ErrorActionPreference = "Stop"
# Repo root derived from THIS file's location (qa/essentials-backend/ -> ../..),
# so the helper works in a MAIN checkout and in a runnable worktree alike.
$here = Split-Path -Parent $PSCommandPath
$repo = (Resolve-Path (Join-Path $here "../..")).Path
$compose = Join-Path $here "simceo-essentials.compose.yaml"

function Mask([string]$v) {
  if ([string]::IsNullOrWhiteSpace($v)) { return "<empty>" }
  return "<set>"
}

function Load-AppEnv([string]$path) {
  # Private child environment from the SELECTED existing app .env: file values
  # override inherited process env (docker compose --env-file has LOWER
  # precedence than process env, so an inherited coding-profile META_API_KEY
  # would otherwise shadow the user's app key). Only an allowlist is loaded;
  # nothing is printed except set/empty status (never values or suffixes). The file is never modified.
  if ([string]::IsNullOrWhiteSpace($path)) { return }
  if (-not (Test-Path $path)) { throw "app env file not found: $path" }
  foreach ($line in (Get-Content $path)) {
    $t = $line.Trim()
    if ($t.Length -eq 0 -or $t.StartsWith("#")) { continue }
    $eq = $t.IndexOf("=")
    if ($eq -lt 1) { continue }
    $k = $t.Substring(0, $eq).Trim()
    $v = $t.Substring($eq + 1).Trim().Trim('"').Trim("'")
    if ($k -eq "POSTGRES_PASSWORD" -or $k -eq "META_API_KEY" -or $k -eq "META_API_BASE") {
      [Environment]::SetEnvironmentVariable($k, $v, "Process")
      Write-Host ("  env from file: " + $k + "=" + (Mask $v))
    }
  }
}

$script:sealedEnvFile = ""

function Initialize-PrivateEnv([bool]$requirePassword) {
  # 1. Private child environment FIRST: clear inherited keys so a coding-profile key can never shadow the selected app key.
  foreach ($k in @("POSTGRES_PASSWORD","META_API_KEY","META_API_BASE")) { [Environment]::SetEnvironmentVariable($k, $null, "Process") }
  # Explicit params/file below re-populate only allowlisted fields; missing fields stay empty and fail closed. Never commit, never print values.
  $selected = ""
  if ($EnvFile -ne "") { Load-AppEnv $EnvFile; $selected = $EnvFile }
  elseif (Test-Path (Join-Path $repo ".env")) { Load-AppEnv (Join-Path $repo ".env"); $selected = (Join-Path $repo ".env") }
  if ($PgPassword -ne "") { [Environment]::SetEnvironmentVariable("POSTGRES_PASSWORD", $PgPassword, "Process"); Write-Host ("  env explicit: POSTGRES_PASSWORD=" + (Mask $PgPassword)) }
  if ($MetaKey -ne "") { [Environment]::SetEnvironmentVariable("META_API_KEY", $MetaKey, "Process"); Write-Host ("  env explicit: META_API_KEY=" + (Mask $MetaKey)) }
  if ($MetaBase -ne "") { [Environment]::SetEnvironmentVariable("META_API_BASE", $MetaBase, "Process"); Write-Host ("  env explicit: META_API_BASE=" + (Mask $MetaBase)) }
  [Environment]::SetEnvironmentVariable("APP_HOST_PORT", "$AppPort", "Process")
  if ($requirePassword -and [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable("POSTGRES_PASSWORD"))) { throw "POSTGRES_PASSWORD is not set (private app .env or -PgPassword required)." }
  # Seal optional model keys against implicit discovery: an explicitly empty
  # process value shadows any auto-discovered .env during interpolation (the
  # required POSTGRES_PASSWORD above stays null-when-absent so its :? gate
  # still fails closed when unconfigured).
  foreach ($k in @("META_API_KEY","META_API_BASE")) {
    if ([Environment]::GetEnvironmentVariable($k) -eq $null) { [Environment]::SetEnvironmentVariable($k, "", "Process") }
  }
  # Seal the Compose env-file source: the selected approved file when one was
  # chosen, otherwise a controlled empty explicit file. Every Compose call
  # passes this file, so a missing selected field is NEVER backfilled from
  # another discovered repo .env. Never commit, never print values or paths
  # with secrets (only set/empty status plus the file choice, never content).
  if ($selected -ne "" -and (Test-Path $selected)) { $script:sealedEnvFile = (Resolve-Path $selected).Path }
  else {
    $sealed = Join-Path ([System.IO.Path]::GetTempPath()) ("ess-sealed-" + [Guid]::NewGuid().ToString("N") + ".env")
    Set-Content -Path $sealed -Value "" -NoNewline
    $script:sealedEnvFile = $sealed
  }
  $mk = [Environment]::GetEnvironmentVariable("META_API_KEY")
  Write-Host ("  effective META_API_KEY=" + (Mask $mk) + " (private process env; inherited coding-profile key cannot shadow it)")
  Write-Host ("  compose env source: sealed (" + (Split-Path -Leaf $script:sealedEnvFile) + ")")
}

function Invoke-Compose([string[]]$argv) {
  # Explicit array binding + forwarding (no $args splat loss) with checked exit.
  # The sealed --env-file is ALWAYS passed: missing selected fields stay absent
  # instead of being backfilled from a discovered .env, while process env keeps
  # precedence for every value the helper set above. Never prints values.
  $full = @("--env-file", $script:sealedEnvFile) + $argv
  $display = "docker compose --env-file <sealed> --project-name $Project -f $compose " + ($argv -join " ")
  Write-Host ("  run: " + $display)
  & docker compose --env-file $script:sealedEnvFile --project-name $Project -f $compose @argv
  if ($LASTEXITCODE -ne 0) { throw "compose failed (exit $LASTEXITCODE): $($argv -join ' ')" }
}

function Invoke-ComposeCapture([string[]]$argv) {
  # Sealed capture variant for queries whose output the helper must inspect
  # (container health); same env-source sealing as Invoke-Compose, no secrets.
  return (& docker compose --env-file $script:sealedEnvFile --project-name $Project -f $compose @argv 2>$null)
}

function PortFree([int]$port) {
  try { $c = New-Object System.Net.Sockets.TcpClient; $iar = $c.BeginConnect("127.0.0.1", $port, $null, $null); $ok = $iar.AsyncWaitHandle.WaitOne(400); $conn = $c.Connected; $c.Close(); return -not ($ok -and $conn) } catch { return $true }
}

function Wait-Ready([string]$url, [int]$secs) {
  # Real readiness contract: HTTP 200 AND JSON body {ready:true, store:"postgres"}.
  $deadline = (Get-Date).AddSeconds($secs)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri $url -TimeoutSec 5 -UseBasicParsing
      if ($r.StatusCode -eq 200) {
        $j = $r.Content | ConvertFrom-Json
        if ($j.ready -eq $true -and $j.store -eq "postgres") { return $true }
      }
    } catch {}
    Start-Sleep -Milliseconds 1000
  }
  return $false
}

function Wait-AppHealthy([int]$secs) {
  # Executable container health (image HEALTHCHECK is curl/wget-based; the
  # base image probe is installed at build time and the build fails if the
  # probe cannot be provided).
  $deadline = (Get-Date).AddSeconds($secs)
  while ((Get-Date) -lt $deadline) {
    try {
      $id = (Invoke-ComposeCapture @("ps", "-q", "app") | Select-Object -First 1)
      if ($id) {
        $st = (docker inspect -f '{{.State.Health.Status}}' $id 2>$null).Trim()
        if ($st -eq "healthy") { return $true }
      }
    } catch {}
    Start-Sleep -Milliseconds 2000
  }
  return $false
}

if ($Action -eq "start") {
  # 1. Private child environment + sealed Compose env source (shared helper:
  #    clears inherited keys, loads the selected allowlisted file/params, and
  #    seals interpolation so missing fields stay absent). Never prints values.
  Initialize-PrivateEnv $true
  # 2. Preservation preflight: legacy volume inspected only, never mounted.
  try { $v = docker volume inspect sim_ceo_pgdata 2>$null; if ($v) { Write-Host "preflight: legacy volume sim_ceo_pgdata present (left untouched)" } }
  catch { Write-Host "preflight WARNING: legacy volume sim_ceo_pgdata not found; continuing with new volumes only" }
  if (-not (PortFree $AppPort)) { throw "port $AppPort busy; stop the holder before starting the persistent stack." }
  # 3. Quiet validation: proves the render is valid WITHOUT printing
  #    interpolated secrets (plain `config` would leak them).
  Invoke-Compose -argv @("config", "-q")
  Write-Host "compose render ok (quiet; no secrets printed)"
  # 4. Explicit matching builds: db then app (the old script omitted --build
  #    on app and could reuse a stale versioned image).
  Invoke-Compose -argv @("up", "-d", "--build", "db")
  Invoke-Compose -argv @("up", "-d", "--build", "app")
  # 5. Executable container health + real PG readiness body.
  if (-not (Wait-AppHealthy 180)) { throw "app container health never reached healthy" }
  Write-Host "app container healthy"
  if (-not (Wait-Ready ("http://localhost:" + $AppPort + "/ready") 120)) { throw "app readiness failed (need ready=true store=postgres; storage outage?)" }
  Write-Host ("persistent stack READY: :" + $AppPort + "/health + /ready (postgres store)")
} elseif ($Action -eq "status") {
  # Private config for this action too: -EnvFile/-PgPassword apply here, so a
  # fresh shell configures status exactly like start. Without private config
  # the compose file cannot be interpolated, so owned project containers are
  # listed directly by label (no secrets needed, nothing interpolated).
  Initialize-PrivateEnv $false
  if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable("POSTGRES_PASSWORD"))) {
    Invoke-Compose -argv @("ps")
  } else {
    Write-Host "  compose ps needs private config; listing owned project containers by label (secret-free):"
    docker ps --filter "label=com.docker.compose.project=$Project" --format "table {{.Names}} {{.Status}} {{.Ports}}"
    if ($LASTEXITCODE -ne 0) { throw "label-only status failed (exit $LASTEXITCODE)" }
  }
  try {
    $r = Invoke-WebRequest -Uri ("http://localhost:" + $AppPort + "/ready") -TimeoutSec 5 -UseBasicParsing
    $j = $r.Content | ConvertFrom-Json
    Write-Host ("ready: status=" + $r.StatusCode + " ready=" + $j.ready + " store=" + $j.store)
  } catch { Write-Host ("ready unreachable: " + $_.Exception.Message) }
} elseif ($Action -eq "stop") {
  # Private config for this action too, so stop works from a fresh shell when
  # given the same explicit config. Without private config, stop stays usable
  # via a secret-free path: halt exactly this project's containers by label
  # (volumes preserved; never down -v), no compose interpolation required.
  Initialize-PrivateEnv $false
  if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable("POSTGRES_PASSWORD"))) {
    Invoke-Compose -argv @("stop")
  } else {
    $ids = @(docker ps -q --filter "label=com.docker.compose.project=$Project" 2>$null | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($LASTEXITCODE -ne 0) { throw "label-only stop enumeration failed (exit $LASTEXITCODE)" }
    if ($ids.Count -eq 0) { Write-Host "  no running owned project containers found; nothing to stop." }
    else {
      docker stop @ids | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "label-only stop failed (exit $LASTEXITCODE)" }
      Write-Host ("  stopped " + $ids.Count + " owned container(s) without secret interpolation.")
    }
  }
  Write-Host "stopped (volumes preserved; old stack untouched)"
} elseif ($Action -eq "update") {
  # EXISTING-stack-only refresh (rapid redeploy of the live human stack).
  # Narrow contract: the live $Project app + db MUST already exist and match
  # this request (compose labels, service names, loopback host port); the
  # helper NEVER recreates or removes the db container or any volume (no
  # down, no down -v, no volume create/remove, no db rebuild, no db
  # recreate). Schema/data may still change if the new app image runs
  # migrations on first boot; that is the app image's doing, not the
  # helper's. The old app keeps serving until the swap: preserve a rollback
  # image ref -> build the new app image while the OLD app stays
  # up -> take fresh backups (fail closed) -> recreate ONLY app with
  # --no-deps --no-build under the sealed approved env -> health + /ready.
  # No secrets or response bodies are printed at any step.
  if ([string]::IsNullOrWhiteSpace($EnvFile)) { throw "update requires explicit -EnvFile <approved private app .env>; refusing to auto-discover env for an existing human stack." }
  if (-not (Test-Path $EnvFile)) { throw ("update: approved env file not found: " + $EnvFile) }
  Initialize-PrivateEnv $true
  Invoke-Compose -argv @("config", "-q")
  Write-Host "compose render ok (quiet; no secrets printed)"
  $appIds = @(docker ps -q --filter "label=com.docker.compose.project=$Project" --filter "label=com.docker.compose.service=app" 2>$null | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($LASTEXITCODE -ne 0) { throw ("update: app lookup failed (exit " + $LASTEXITCODE + ")") }
  if ($appIds.Count -ne 1) { throw ("update: need exactly 1 live app container for project " + $Project + " (found " + $appIds.Count + "); refusing (missing or ambiguous holder).") }
  $dbIds = @(docker ps -q --filter "label=com.docker.compose.project=$Project" --filter "label=com.docker.compose.service=db" 2>$null | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($LASTEXITCODE -ne 0) { throw ("update: db lookup failed (exit " + $LASTEXITCODE + ")") }
  if ($dbIds.Count -ne 1) { throw ("update: need exactly 1 live db container for project " + $Project + " (found " + $dbIds.Count + "); refusing.") }
  $appId = $appIds[0].Trim()
  $dbId = $dbIds[0].Trim()
  $appProj = ((docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' $appId 2>$null) | Out-String).Trim()
  if ($appProj -ne $Project) { throw ("update: live app project label mismatch (want " + $Project + "); refusing.") }
  $appSvc = ((docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' $appId 2>$null) | Out-String).Trim()
  if ($appSvc -ne "app") { throw "update: live app service label mismatch; refusing." }
  $dbSvc = ((docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' $dbId 2>$null) | Out-String).Trim()
  if ($dbSvc -ne "db") { throw "update: live db service label mismatch; refusing." }
  $appRunning = ((docker inspect -f '{{.State.Running}}' $appId 2>$null) | Out-String).Trim()
  if ($appRunning -ne "True") { throw "update: live app container is not running; refusing (fresh boot is owned by start)." }
  # Exact loopback mapping: EVERY published host mapping for container port
  # 5080 must be exactly 127.0.0.1:<AppPort>. Membership is not enough; an
  # extra 0.0.0.0 (or any other) mapping fails the update.
  $portMap = ((docker port $appId 5080 2>$null) | Out-String)
  $pmLines = @(($portMap -split "`r?`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
  if ($pmLines.Count -eq 0) { throw ("update: live app publishes no host mapping for container port 5080 (need exactly 127.0.0.1:" + $AppPort + "); refusing.") }
  foreach ($ln in $pmLines) {
    $pmm = [regex]::Match($ln, '^127\.0\.0\.1:(\d+)')
    if (-not $pmm.Success -or $pmm.Groups[1].Value -ne "$AppPort") { throw ("update: live app host mapping must be exactly 127.0.0.1:" + $AppPort + " (saw [" + $ln + "]); refusing.") }
  }
  $dbHealth = ((docker inspect -f '{{.State.Health.Status}}' $dbId 2>$null) | Out-String).Trim()
  if ($dbHealth -ne "healthy") { throw ("update: db health is '" + $dbHealth + "' (need 'healthy'); refusing.") }
  $dbMountsRaw = ((docker inspect -f '{{json .Mounts}}' $dbId 2>$null) | Out-String)
  if ([string]::IsNullOrWhiteSpace($dbMountsRaw)) { throw "update: cannot inspect db mounts; refusing." }
  $appMountsRaw = ((docker inspect -f '{{json .Mounts}}' $appId 2>$null) | Out-String)
  if ([string]::IsNullOrWhiteSpace($appMountsRaw)) { throw "update: cannot inspect app mounts; refusing." }
  # Effective Compose identities (resolved under the sealed env; never
  # printed): top-level volume names plus each service's source/target
  # mapping. Live mounts must match BOTH the resolved Compose volume name
  # and the resolved Compose destination; a merely-existing volume at the
  # right path is not enough (Compose could otherwise attach/create its
  # configured volume during recreation and replace the effective mount).
  $cfgJson = ((Invoke-ComposeCapture @("config", "--format", "json")) -join "`n")
  if ([string]::IsNullOrWhiteSpace($cfgJson)) { throw "update: cannot resolve compose config; refusing." }
  $cfg = ($cfgJson | ConvertFrom-Json)
  if ($null -eq $cfg -or $null -eq $cfg.services -or $null -eq $cfg.services.db -or $null -eq $cfg.services.app -or $null -eq $cfg.volumes) { throw "update: compose config missing services/volumes; refusing." }
  $dbSvcVols = @($cfg.services.db.volumes | Where-Object { $_.type -eq "volume" -and $_.target -eq "/var/lib/postgresql/data" })
  $appSvcVols = @($cfg.services.app.volumes | Where-Object { $_.type -eq "volume" -and $_.target -eq "/app/data" })
  if ($dbSvcVols.Count -ne 1) { throw "update: compose db service must map exactly one volume at /var/lib/postgresql/data; refusing." }
  if ($appSvcVols.Count -ne 1) { throw "update: compose app service must map exactly one volume at /app/data; refusing." }
  $topDb = @($cfg.volumes.PSObject.Properties | Where-Object { $_.Name -eq $dbSvcVols[0].source })
  if ($topDb.Count -ne 1) { throw ("update: compose top-level volume '" + $dbSvcVols[0].source + "' not resolved; refusing.") }
  $expDbName = $topDb[0].Value.name
  if ([string]::IsNullOrWhiteSpace($expDbName)) { throw ("update: compose top-level volume '" + $dbSvcVols[0].source + "' has no resolved name; refusing.") }
  $topApp = @($cfg.volumes.PSObject.Properties | Where-Object { $_.Name -eq $appSvcVols[0].source })
  if ($topApp.Count -ne 1) { throw ("update: compose top-level volume '" + $appSvcVols[0].source + "' not resolved; refusing.") }
  $expAppName = $topApp[0].Value.name
  if ([string]::IsNullOrWhiteSpace($expAppName)) { throw ("update: compose top-level volume '" + $appSvcVols[0].source + "' has no resolved name; refusing.") }
  $dbTarget = $dbSvcVols[0].target
  $appTarget = $appSvcVols[0].target
  # Named-volume identity comes from Mount.Name (Source can be a DockerVM
  # filesystem path, not a volume name).
  $dbLive = @($dbMountsRaw | ConvertFrom-Json | Where-Object { $_.Type -eq "volume" -and $_.Destination -eq $dbTarget -and $_.Name -eq $expDbName })
  $appLive = @($appMountsRaw | ConvertFrom-Json | Where-Object { $_.Type -eq "volume" -and $_.Destination -eq $appTarget -and $_.Name -eq $expAppName })
  if ($dbLive.Count -ne 1) { throw ("update: live db mount does not match compose mapping (need volume '" + $expDbName + "' at '" + $dbTarget + "'); refusing.") }
  if ($appLive.Count -ne 1) { throw ("update: live app mount does not match compose mapping (need volume '" + $expAppName + "' at '" + $appTarget + "'); refusing.") }
  $volNames = @($expDbName, $expAppName) | Sort-Object -Unique
  foreach ($vn in $volNames) {
    & docker volume inspect $vn 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw ("update: live volume missing: " + $vn + "; refusing (volumes are never recreated here).") }
  }
  Write-Host ("update preflight ok: live app+db match project " + $Project + " on 127.0.0.1:" + $AppPort + "; db healthy; volumes preserved (" + ($volNames -join ", ") + ")")
  # Pin the immutable image ID (.Image), not the mutable tag
  # (.Config.Image): a previous build may already have retagged
  # simceo-essentials-app:1.0.0 to a newer image while this container still
  # runs the old one. Verify the rollback tag resolves to the same ID
  # BEFORE any build.
  $curImageId = ((docker inspect -f '{{.Image}}' $appId 2>$null) | Out-String).Trim()
  if ([string]::IsNullOrWhiteSpace($curImageId)) { throw "update: cannot resolve live app image id; refusing." }
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
  $shortId = [Guid]::NewGuid().ToString("N").Substring(0, 8)
  $rollbackTag = ("simceo-essentials-app:rollback-" + $stamp + "-" + $shortId)
  & docker tag $curImageId $rollbackTag | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "update: rollback tag failed; refusing to build." }
  $rollbackId = ((docker inspect -f '{{.Id}}' $rollbackTag 2>$null) | Out-String).Trim()
  if ($rollbackId -ne $curImageId) { throw ("update: rollback tag does not resolve to the live image id; refusing to build. Rollback ref attempted: " + $rollbackTag) }
  Write-Host ("rollback ref preserved: " + $rollbackTag + " (pinned to live image id)")
  Invoke-Compose -argv @("build", "app")
  Write-Host "new app image built (old app still serving; nothing recreated yet)"
  $stillUp = ((docker inspect -f '{{.State.Running}}' $appId 2>$null) | Out-String).Trim()
  if ($stillUp -ne "True") { throw ("update: old app stopped during build; aborting before swap. Rollback ref kept: " + $rollbackTag) }
  $backupDir = Join-Path $repo (".tmp/update-" + $stamp + "-UTC-" + $shortId)
  if (Test-Path $backupDir) { throw ("update: backup dir already exists; never overwriting: " + $backupDir) }
  & git -C $repo check-ignore -q $backupDir
  if ($LASTEXITCODE -ne 0) { throw ("update: backup dir is NOT Git-ignored; refusing private data write: " + $backupDir) }
  $null = New-Item -ItemType Directory -Path $backupDir -Force
  $dumpFile = Join-Path $backupDir "pg-full.dump.sql"
  & git -C $repo check-ignore -q $dumpFile
  if ($LASTEXITCODE -ne 0) { throw ("update: dump path is NOT Git-ignored; refusing: " + $dumpFile) }
  # Local trusted connection needs no password (proven: pg_dump -U simceo
  # works without one), so no credential is placed in process args. The dump
  # is written to a container-side file and copied out byte-for-byte
  # (docker cp) instead of flowing through PowerShell string capture.
  $dumpTmp = "/tmp/ess-update-pgdump.sql"
  & docker exec $dbId sh -c ("pg_dumpall -U simceo -c > " + $dumpTmp) 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { throw ("update: full PG dump failed (exit " + $LASTEXITCODE + "); aborting before swap. Rollback ref kept: " + $rollbackTag + "; partial evidence left under " + $backupDir) }
  & docker cp ($dbId + ":" + $dumpTmp) $dumpFile 2>$null | Out-Null
  $cpCode = $LASTEXITCODE
  & docker exec $dbId rm -f $dumpTmp 2>$null | Out-Null
  if ($cpCode -ne 0) { throw ("update: PG dump copy failed (exit " + $cpCode + "); aborting before swap. Rollback ref kept: " + $rollbackTag + "; partial evidence left under " + $backupDir) }
  $noBom = New-Object System.Text.UTF8Encoding $false
  if (-not (Select-String -LiteralPath $dumpFile -Pattern "PostgreSQL database cluster dump" -Quiet)) { throw ("update: PG dump looks incomplete (marker missing); aborting before swap. Rollback ref kept: " + $rollbackTag + "; partial evidence left under " + $backupDir) }
  $dumpInfo = Get-Item $dumpFile
  if ($dumpInfo.Length -lt 1024) { throw ("update: PG dump too small (" + $dumpInfo.Length + " bytes); aborting before swap. Rollback ref kept: " + $rollbackTag + "; partial evidence left under " + $backupDir) }
  $dumpSha = (Get-FileHash -LiteralPath $dumpFile -Algorithm SHA256).Hash.ToLowerInvariant()
  $appdataDst = Join-Path $backupDir "appdata"
  & docker cp ($appId + ":/app/data") $appdataDst 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { throw ("update: appdata copy failed (exit " + $LASTEXITCODE + "); aborting before swap. Rollback ref kept: " + $rollbackTag + "; PG dump kept at " + $dumpFile) }
  $appdataFiles = @(Get-ChildItem -LiteralPath $appdataDst -Recurse -File -ErrorAction Stop)
  $appdataBytes = ($appdataFiles | Measure-Object -Property Length -Sum).Sum
  if ($null -eq $appdataBytes) { $appdataBytes = 0 }
  $manifest = [ordered]@{
    tool = "essentials-persist.ps1 update (Muse-authored rapid redeploy; existing stack only)"
    atUtc = [DateTime]::UtcNow.ToString("o")
    project = $Project
    appPort = $AppPort
    liveAppImageId = $curImageId
    rollbackTag = $rollbackTag
    liveVolumes = @($volNames)
    dbHealth = $dbHealth
    pgDump = [ordered]@{ file = "pg-full.dump.sql"; bytes = $dumpInfo.Length; sha256 = $dumpSha; note = "full cluster dump incl roles/globals (pg_dumpall -c); read-only against live db; contents never printed" }
    appdata = [ordered]@{ dir = "appdata"; files = $appdataFiles.Count; bytes = $appdataBytes; note = "read-only docker cp from live app container; contents never printed" }
    backupDirLeaf = (Split-Path -Leaf $backupDir)
  }
  [System.IO.File]::WriteAllText((Join-Path $backupDir "manifest.json"), (ConvertTo-Json -InputObject $manifest -Depth 6), $noBom)
  Write-Host ("backups fresh: pg dump " + $dumpInfo.Length + " bytes sha256 " + $dumpSha.Substring(0, 12) + "... + appdata " + $appdataFiles.Count + " files (" + $appdataBytes + " bytes) under " + (Split-Path -Leaf $backupDir))
  # Sealed rollback invocation, prepared BEFORE the swap: it re-enters this
  # helper's rollback action under the same approved env sealing (never a
  # raw compose --env-file in a fresh coding-profile shell, where inherited
  # keys would win over the file).
  $rollbackInvoke = ('powershell -File "' + $PSCommandPath + '" -Action rollback -Project ' + $Project + ' -AppPort ' + $AppPort + ' -EnvFile "' + $EnvFile + '" -RollbackTag "' + $rollbackTag + '"')
  try {
    Invoke-Compose -argv @("up", "-d", "--no-deps", "--no-build", "app")
    Write-Host "app recreated (helper preserved db container and volumes: not recreated or removed)"
    if (-not (Wait-AppHealthy 180)) { throw "app never healthy after swap" }
    Write-Host "app container healthy"
    if (-not (Wait-Ready ("http://localhost:" + $AppPort + "/ready") 120)) { throw "readiness need ready=true store=postgres" }
    Write-Host ("persistent stack UPDATED: :" + $AppPort + "/health + /ready (postgres store); backups under " + (Split-Path -Leaf $backupDir) + "; rollback ref " + $rollbackTag)
  } catch {
    throw ("update FAILED after swap: " + $_.Exception.Message + ". Backups kept at " + $backupDir + ". Sealed rollback (same approved env): " + $rollbackInvoke + ". Helper preserved db container and volumes (not recreated or removed); app-level migrations, if any, are the new image's own doing.")
  }
} elseif ($Action -eq "rollback") {
  # Narrow sealed rollback for a failed update: retag the pinned rollback
  # image to the compose app image tag, then recreate ONLY app through the
  # SAME sealed approved env (Initialize-PrivateEnv + Invoke-Compose), so a
  # fresh coding-profile shell can never inject the wrong key or break db
  # authentication. The db container and volumes are never recreated or
  # removed. Schema/data may still change if the restored image runs
  # migrations; that is the app image's doing, not the helper's.
  if ([string]::IsNullOrWhiteSpace($EnvFile)) { throw "rollback requires explicit -EnvFile <approved private app .env>; refusing to auto-discover env." }
  if (-not (Test-Path $EnvFile)) { throw ("rollback: approved env file not found: " + $EnvFile) }
  if ([string]::IsNullOrWhiteSpace($RollbackTag)) { throw "rollback requires -RollbackTag <pinned rollback image tag from the update run>." }
  Initialize-PrivateEnv $true
  & docker image inspect $RollbackTag 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { throw ("rollback: rollback image not found locally: " + $RollbackTag) }
  $rbCfgJson = ((Invoke-ComposeCapture @("config", "--format", "json")) -join "`n")
  if ([string]::IsNullOrWhiteSpace($rbCfgJson)) { throw "rollback: cannot resolve compose config; refusing." }
  $rbCfg = ($rbCfgJson | ConvertFrom-Json)
  if ($null -eq $rbCfg -or $null -eq $rbCfg.services -or $null -eq $rbCfg.services.app -or [string]::IsNullOrWhiteSpace($rbCfg.services.app.image)) { throw "rollback: compose app image tag not resolved; refusing." }
  $appImageTag = $rbCfg.services.app.image
  $rbId = ((docker inspect -f '{{.Id}}' $RollbackTag 2>$null) | Out-String).Trim()
  if ([string]::IsNullOrWhiteSpace($rbId)) { throw "rollback: cannot resolve rollback image id; refusing." }
  & docker tag $RollbackTag $appImageTag | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "rollback: retag failed; refusing to recreate app." }
  $rtId = ((docker inspect -f '{{.Id}}' $appImageTag 2>$null) | Out-String).Trim()
  if ($rtId -ne $rbId) { throw "rollback: retagged image does not resolve to the rollback image id; refusing to recreate app." }
  Write-Host ("rollback: retagged " + $appImageTag + " to pinned rollback image")
  Invoke-Compose -argv @("up", "-d", "--no-deps", "--no-build", "app")
  if (-not (Wait-AppHealthy 180)) { throw ("rollback FAILED: app never healthy after retag recreate; backups from the update run remain under " + $repo + "/.tmp/update-*/; primary decision required.") }
  Write-Host "app container healthy"
  if (-not (Wait-Ready ("http://localhost:" + $AppPort + "/ready") 120)) { throw ("rollback FAILED: readiness need ready=true store=postgres after retag recreate; backups from the update run remain under " + $repo + "/.tmp/update-*/; primary decision required.") }
  Write-Host ("rollback COMPLETE: :" + $AppPort + "/health + /ready (postgres store) on pinned rollback image")
} else { throw "unknown -Action $Action (start|status|stop|update|rollback)" }