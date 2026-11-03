param([string]$Action = "status")
$ErrorActionPreference = "Stop"
$repo = "C:/Users/War/scrach/sim_ceo"
$compose = Join-Path $repo "qa/essentials-backend/simceo-essentials.compose.yaml"
$envFile = Join-Path $repo ".env"
function Compose([string[]]$rest) {
  & docker compose --project-name simceo-essentials -f $compose --env-file $envFile @rest
}
function PortFree($port) {
  try { $c = New-Object System.Net.Sockets.TcpClient; $iar = $c.BeginConnect("127.0.0.1", $port, $null, $null); $ok = $iar.AsyncWaitHandle.WaitOne(400); $conn = $c.Connected; $c.Close(); return -not ($ok -and $conn) } catch { return $true }
}
function Wait-Http($url, $secs) {
  $deadline = (Get-Date).AddSeconds($secs)
  while ((Get-Date) -lt $deadline) {
    try { $r = Invoke-WebRequest -Uri $url -TimeoutSec 3 -UseBasicParsing; if ($r.StatusCode -eq 200) { return $true } } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $false
}
if ($Action -eq "start") {
  if (-not (Test-Path $envFile)) { throw "MAIN .env missing at $envFile; copy .env.example and fill POSTGRES_PASSWORD + META_API_KEY first." }
  try { $v = docker volume inspect sim_ceo_pgdata 2>$null; if ($v) { Write-Host "preflight: legacy volume sim_ceo_pgdata present (left untouched)" } }
  catch { Write-Host "preflight WARNING: legacy volume sim_ceo_pgdata not found; continuing with new volumes only" }
  if (-not (PortFree 5080)) { throw "port 5080 busy (dev API?); stop it before starting the persistent stack." }
  Compose @("config") | Out-Null
  Write-Host "compose render ok"
  Compose @("up", "-d", "--build", "db")
  Compose @("up", "-d", "app")
  if (-not (Wait-Http "http://localhost:5080/health" 180)) { throw "app liveness failed" }
  if (-not (Wait-Http "http://localhost:5080/ready" 120)) { throw "app readiness failed (store unreachable?)" }
  Write-Host "persistent stack READY: :5080/health + :5080/ready"
} elseif ($Action -eq "status") {
  Compose @("ps")
  try { Invoke-WebRequest -Uri "http://localhost:5080/ready" -TimeoutSec 5 -UseBasicParsing | Select-Object StatusCode, Content } catch { Write-Host "ready unreachable: $($_.Exception.Message)" }
} elseif ($Action -eq "stop") {
  Compose @("stop")
  Write-Host "stopped (volumes preserved; old stack untouched)"
} else { throw "unknown -Action $Action (start|status|stop)" }
