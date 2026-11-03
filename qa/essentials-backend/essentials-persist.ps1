param(
  [string]$Action = "status",
  [string]$Project = "simceo-essentials",
  [int]$AppPort = 5080,
  [string]$EnvFile = "",
  [string]$PgPassword = "",
  [string]$MetaKey = "",
  [string]$MetaBase = ""
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
    if ($ids.Count -eq 0) { Write-Host "  no running owned project containers found; nothing to stop." }
    else {
      docker stop @ids | Out-Null
      Write-Host ("  stopped " + $ids.Count + " owned container(s) without secret interpolation.")
    }
  }
  Write-Host "stopped (volumes preserved; old stack untouched)"
} else { throw "unknown -Action $Action (start|status|stop)" }