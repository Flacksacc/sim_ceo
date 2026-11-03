# capture-human-state.ps1 (Muse, source-only)
#
# READ-ONLY pre-cutover preservation of the ORIGINAL running old human API
# (default http://127.0.0.1:5080) plus the MAIN repo private .env into a NEW
# explicitly requested ignored MAIN .tmp child dir. Never overwrites an
# existing capture, never mutates anything, never prints bodies/drafts/keys.
#
# What it does (GET-only + local file copy; no POST/PUT/import/restart/stop):
#   1. Validates -SourceOrigin is EXACTLY http://127.0.0.1:5080 or
#      http://localhost:5080 (fail closed on wrong origin/scheme/port).
#   2. Creates ONE new dir MAIN/.tmp/human-state-<UTCstamp>-<guid8> (refuses
#      if it already exists) and requires BOTH the capture dir and the env
#      backup path to be Git-ignored via `git check-ignore` (fail closed).
#   3. Copies MAIN .env byte-for-byte to main.env.backup (never inspects or
#      prints values; manifest records only the file SHA256, not contents).
#   4. GETs the exact old real routes and saves EXACT raw response bytes to
#      private scratch files: /ready, /api/backup, /api/activity/jobs,
#      /api/usage, /api/activity/audit, /api/models/calls, /api/model/status,
#      /api/spending, plus per-meeting /api/meetings/{id}/voice for every
#      meeting id found in the backup snapshot. Bounded timeouts.
#   5. Verifies the /api/backup wrapper: recomputes SHA256 over the UTF8
#      bytes of the EXACT embedded snapshot string using the actual old
#      Hashing.FullHash semantics (lowercase hex of SHA256 over bytes) and
#      credits the backup ONLY on match. Preserves BOTH the exact wrapper
#      raw bytes AND the exact embedded snapshot bytes separately (no
#      deserialize/reserialize normalization of the snapshot).
#   6. Optionally (-IncludeBrowser) runs the EXISTING sibling helper
#      preserve-browser-drafts.mjs with its ORIGINAL allowlisted target IDs
#      only (no custom browser code, no extra targets/origins). Requires
#      native exit 0 for browser-complete; saves the helper console
#      (count-only) and the full private browser file.
#   7. Writes a NONSECRET manifest.json (statuses, SHA256s, counts only;
#      never bodies, names, contents, hints, or credentials) with explicit
#      omissions, caps/truncation risks, and a final verdict. Verdict
#      states snapshot data captured vs incomplete, ALWAYS states authstate
#      NOT exported, and NEVER declares cutover readiness.
#
# What it NEVER does: HTTP mutations, auth headers/tokens/keys (no such CLI
#   args exist), process env capture, Docker/config capture, imports,
#   restarts, stops, SQL, cleanup/deletion of captures, Git commits.
#
# Requires PowerShell 7+ (pwsh). Windows PowerShell 5.1 is NOT supported
# (ConvertFrom-Json -Depth and HttpClient redirect control require PS7).
#
# Usage (primary runs from the MAIN checkout; helper lives in the worktree,
#   finds its sibling browser helper by its own path, operates on MAIN):
#   pwsh -File C:/Users/War/scrach/sim_ceo/.tmp/essentials-runnable-worktree/qa/essentials-backend/capture-human-state.ps1 -MainRoot C:/Users/War/scrach/sim_ceo
#   pwsh -File C:/Users/War/scrach/sim_ceo/.tmp/essentials-runnable-worktree/qa/essentials-backend/capture-human-state.ps1 -MainRoot C:/Users/War/scrach/sim_ceo -IncludeBrowser
#
# Exit codes: 0 = complete capture (hash-verified); 1 = incomplete/failed
#   (partial private evidence is PRESERVED in the capture dir; nothing is
#   deleted). This is a preservation tool only; success is NOT cutover
#   approval and does NOT authorize stopping the old in-memory API.

#Requires -Version 7.0
[CmdletBinding()]
param(
  [string]$MainRoot = 'C:/Users/War/scrach/sim_ceo',
  [string]$OutputDir = '',
  [string]$SourceOrigin = 'http://127.0.0.1:5080',
  [int]$TimeoutSec = 20,
  [switch]$IncludeBrowser,
  [string]$CdpEndpoint = 'http://127.0.0.1:9333'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail-Now([string]$Message) {
  Write-Error $Message
  exit 1
}

function Get-HexSha256([byte[]]$Bytes) {
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $hasher.ComputeHash($Bytes)
  } finally {
    $hasher.Dispose()
  }
  return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
}

# --- Resolve and validate MAIN root ---
$MainRootFull = [System.IO.Path]::GetFullPath($MainRoot)
if (-not (Test-Path -LiteralPath $MainRootFull -PathType Container)) {
  Fail-Now ("MainRoot not found: " + $MainRootFull)
}
$MainEnvPath = Join-Path $MainRootFull '.env'
if (-not (Test-Path -LiteralPath $MainEnvPath -PathType Leaf)) {
  Fail-Now ("MAIN .env not found (refusing to capture without private env backup): " + $MainEnvPath)
}
$MainTmpFull = [System.IO.Path]::GetFullPath((Join-Path $MainRootFull '.tmp'))
if (-not (Test-Path -LiteralPath $MainTmpFull -PathType Container)) {
  Fail-Now ("MAIN .tmp dir not found: " + $MainTmpFull)
}

# --- Validate source origin (fail closed: exact host + http + :5080 only) ---
$OriginNorm = $SourceOrigin.Trim().TrimEnd('/')
if ($OriginNorm -notmatch '^http://(127\.0\.0\.1|localhost):5080$') {
  Fail-Now ("Refusing wrong source origin (must be exactly http://127.0.0.1:5080 or http://localhost:5080): " + $SourceOrigin)
}

if ($TimeoutSec -lt 5 -or $TimeoutSec -gt 120) {
  Fail-Now ("TimeoutSec out of bounds (5-120): " + $TimeoutSec)
}

if ($IncludeBrowser) {
  if ($CdpEndpoint -ne 'http://127.0.0.1:9333') {
    Fail-Now ("Refusing non-allowlisted CDP endpoint (only http://127.0.0.1:9333): " + $CdpEndpoint)
  }
  $BrowserHelperPath = Join-Path $PSScriptRoot 'preserve-browser-drafts.mjs'
  if (-not (Test-Path -LiteralPath $BrowserHelperPath -PathType Leaf)) {
    Fail-Now ("Sibling browser helper not found: " + $BrowserHelperPath)
  }
  try { $null = Get-Command node -ErrorAction Stop } catch { Fail-Now ("node not found on PATH; cannot run browser helper.") }
}

try { $null = Get-Command git -ErrorAction Stop } catch { Fail-Now ("git not found on PATH; cannot verify ignored paths.") }

# --- Determine NEW capture dir (never overwrite) ---
$StampUtc = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$Guid8 = [Guid]::NewGuid().ToString('N').Substring(0, 8)
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $CaptureRootFull = Join-Path $MainTmpFull ('human-state-' + $StampUtc + '-UTC-' + $Guid8)
} else {
  $CaptureRootFull = [System.IO.Path]::GetFullPath($OutputDir)
}
$Prefix = $MainTmpFull.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if ($CaptureRootFull -ne $MainTmpFull -and -not $CaptureRootFull.StartsWith($Prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  Fail-Now ("OutputDir must live inside MAIN .tmp (literal, checked): " + $CaptureRootFull)
}
if (Test-Path -LiteralPath $CaptureRootFull) {
  Fail-Now ("Capture dir already exists; never overwriting an existing capture: " + $CaptureRootFull)
}
$EnvBackupPath = Join-Path $CaptureRootFull 'main.env.backup'

# --- Require ignored paths BEFORE creating anything ---
& git -C $MainRootFull check-ignore -q $CaptureRootFull
if ($LASTEXITCODE -ne 0) { Fail-Now ("Capture dir is NOT Git-ignored; refusing to write private data there: " + $CaptureRootFull) }
& git -C $MainRootFull check-ignore -q $EnvBackupPath
if ($LASTEXITCODE -ne 0) { Fail-Now ("Env backup path is NOT Git-ignored; refusing private env copy: " + $EnvBackupPath) }

$null = New-Item -ItemType Directory -Path $CaptureRootFull -Force
$RawDir = Join-Path $CaptureRootFull 'raw'
$null = New-Item -ItemType Directory -Path $RawDir -Force

# --- Byte-for-byte private .env copy (never inspect/print values) ---
Copy-Item -LiteralPath $MainEnvPath -Destination $EnvBackupPath -Force
$EnvBackupSha = (Get-FileHash -LiteralPath $EnvBackupPath -Algorithm SHA256).Hash.ToLowerInvariant()
$MainEnvSha = (Get-FileHash -LiteralPath $MainEnvPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($EnvBackupSha -ne $MainEnvSha) { Fail-Now ("MAIN .env byte copy hash mismatch; aborting.") }

# --- Read-only HTTP fetch (GET only, no auth headers, bounded timeout) ---
# Automatic redirects are DISABLED so saved bytes always come from the exact
# validated origin (a 3xx is recorded incomplete, never followed).
Add-Type -AssemblyName System.Net.Http
$HttpHandler = New-Object System.Net.Http.HttpClientHandler
$HttpHandler.AllowAutoRedirect = $false
$HttpClient = New-Object System.Net.Http.HttpClient($HttpHandler)
$HttpClient.Timeout = [System.TimeSpan]::FromSeconds($TimeoutSec)
$FetchLog = @()
$AllOk = $true

function Invoke-CaptureGet([string]$Name, [string]$Path) {
  $url = $OriginNorm + $Path
  $dest = Join-Path $RawDir ($Name + '.raw.json')
  $rec = [ordered]@{ name = $Name; path = $Path; file = ('raw/' + $Name + '.raw.json'); status = 0; bytes = 0; sha256 = ''; ok = $false; note = ''; isArray = $false }
  try {
    $resp = $HttpClient.GetAsync($url).GetAwaiter().GetResult()
    $rec['status'] = [int]$resp.StatusCode
    $body = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    [System.IO.File]::WriteAllBytes($dest, $body)
    $rec['bytes'] = $body.Length
    $rec['sha256'] = Get-HexSha256 $body
    $code = [int]$resp.StatusCode
    if ($code -ge 300 -and $code -lt 400) {
      $rec['note'] = 'redirect (3xx) not followed; not counted (never treated as empty)'
      $script:AllOk = $false
      return $rec
    }
    if ($code -ne 200) {
      $rec['note'] = 'non-200; not counted (never treated as empty)'
      $script:AllOk = $false
      return $rec
    }
    $text = [System.Text.Encoding]::UTF8.GetString($body)
    try {
      $parsed = ConvertFrom-Json -InputObject $text -Depth 64
    } catch {
      $rec['note'] = 'non-JSON body; not counted (never treated as empty)'
      $script:AllOk = $false
      return $rec
    }
    # Preserve top-level JSON array identity: ConvertFrom-Json enumerates, so
    # '[]' arrives as $null and a one-item array as a scalar. The raw text
    # decides: array-shaped bodies always yield an array value here.
    if ($text.TrimStart().StartsWith('[')) {
      $rec['isArray'] = $true
      if ($null -eq $parsed) { $parsed = @() }
      elseif ($parsed -isnot [System.Array]) { $parsed = ,$parsed }
    }
    $rec['ok'] = $true
    $rec['parsed'] = $parsed
    return $rec
  } catch {
    $rec['note'] = 'fetch failed: ' + $_.Exception.Message
    $script:AllOk = $false
    return $rec
  }
}

# Array identity comes from the raw body shape (see Invoke-CaptureGet), never
# from the enumerated parse output. Failed/non-array bodies are NOT empty.
function Get-ArrayCount($Parsed, [bool]$IsArray) {
  if (-not $IsArray) { return @{ present = $false; count = 0 } }
  if ($null -eq $Parsed) { return @{ present = $true; count = 0 } }
  if ($Parsed -is [System.Array]) { return @{ present = $true; count = $Parsed.Count } }
  return @{ present = $true; count = @($Parsed).Count }
}
# Returns the native JSON value, $null when the JSON value is null, or
# 'absent' when the property is missing (never conflates null with "").
function Get-NativeField($Obj, [string]$Name) {
  $prop = $Obj.PSObject.Properties[$Name]
  if ($null -eq $prop) { return 'absent' }
  return $prop.Value
}

$ReadyRec   = Invoke-CaptureGet 'ready' '/ready'
$BackupRec  = Invoke-CaptureGet 'backup-wrapper' '/api/backup'
$JobsRec    = Invoke-CaptureGet 'activity-jobs' '/api/activity/jobs'
$UsageRec   = Invoke-CaptureGet 'usage' '/api/usage'
$AuditRec   = Invoke-CaptureGet 'activity-audit' '/api/activity/audit'
$CallsRec   = Invoke-CaptureGet 'models-calls' '/api/models/calls'
$ModelRec   = Invoke-CaptureGet 'model-status' '/api/model/status'
$SpendRec   = Invoke-CaptureGet 'spending' '/api/spending'

$FetchLog += @($ReadyRec, $BackupRec, $JobsRec, $UsageRec, $AuditRec, $CallsRec, $ModelRec, $SpendRec)

# --- Verify /api/backup wrapper with actual old Hashing.FullHash semantics ---
$BackupVerified = $false
$SnapshotSha = ''
$SnapshotBytes = 0
$SnapshotFile = ''
$SnapshotCountsNote = ''
$DomainCounts = [ordered]@{}
$MeetingIds = @()
if ($BackupRec['ok']) {
  try {
    $wrapper = $BackupRec['parsed']
    $snapStr = $wrapper.snapshot
    $wrapHash = [string]$wrapper.hash
    if ([string]::IsNullOrEmpty($snapStr) -or [string]::IsNullOrEmpty($wrapHash)) {
      throw New-Object System.Exception('wrapper missing snapshot/hash')
    }
    $snapBytes = [System.Text.Encoding]::UTF8.GetBytes($snapStr)
    $recomputed = Get-HexSha256 $snapBytes
    if (-not [string]::Equals($recomputed, $wrapHash, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw New-Object System.Exception('snapshot SHA256 (FullHash) mismatch vs wrapper.hash')
    }
    # Preserve EXACT embedded snapshot bytes separately (no re-serialization).
    $SnapshotFile = Join-Path $CaptureRootFull 'backup.snapshot.json'
    $noBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($SnapshotFile, $snapStr, $noBom)
    $SnapshotSha = Get-HexSha256 $snapBytes
    $SnapshotBytes = $snapBytes.Length
    $BackupVerified = $true
  } catch {
    $BackupRec['ok'] = $false
    $BackupRec['note'] = 'wrapper verify failed: ' + $_.Exception.Message
    $AllOk = $false
  }
  # Domain counts are best-effort: a parse/count failure keeps the truthful raw
  # hash verification but marks the capture incomplete with its recorded cause.
  if ($BackupVerified) {
    try {
      # Count-only domain stats (no names/content leave this machine).
      $snap = ConvertFrom-Json -InputObject $snapStr -Depth 64
      foreach ($key in @('boards', 'roster', 'advisors', 'meetings', 'notes', 'drafts', 'sources', 'sections', 'heads', 'events', 'wikiResources', 'deletedWikiResourceIds', 'leads', 'wizardDrafts', 'jobs', 'voiceTurns', 'images', 'secretaryRequests', 'noteHistories', 'grants', 'invites')) {
        $prop = $snap.PSObject.Properties[$key]
        if ($null -eq $prop) { $DomainCounts[$key] = 'absent'; continue }
        $val = $prop.Value
        if ($null -eq $val) { $DomainCounts[$key] = 'null'; continue }
        if ($val -is [System.Array]) { $DomainCounts[$key] = $val.Count } else { $DomainCounts[$key] = 'non-array' }
      }
      $msgsProp = $snap.PSObject.Properties['messages']
      if ($null -eq $msgsProp) {
        $DomainCounts['messages'] = 'absent'
      } elseif ($null -eq $msgsProp.Value) {
        $DomainCounts['messageThreads'] = 'null'
        $DomainCounts['messages'] = 'null'
      } elseif ($msgsProp.Value -is [System.Array]) {
        $DomainCounts['messageThreads'] = 'non-dict'
        $DomainCounts['messages'] = @($msgsProp.Value).Count
      } else {
        # Materialize before counting: member enumeration under StrictMode can
        # otherwise throw or misbehave on empty dicts, hiding meeting ids.
        $mKeys = @($msgsProp.Value.PSObject.Properties)
        $mTotal = 0
        foreach ($mp in $mKeys) { if ($mp.Value -is [System.Array]) { $mTotal += @($mp.Value).Count } }
        $DomainCounts['messageThreads'] = $mKeys.Count
        $DomainCounts['messages'] = $mTotal
      }
      $blobsProp = $snap.PSObject.Properties['blobs']
      if ($null -eq $blobsProp) { $DomainCounts['blobs'] = 'absent' }
      elseif ($null -eq $blobsProp.Value) { $DomainCounts['blobs'] = 'null' }
      else { $DomainCounts['blobs'] = @($blobsProp.Value.PSObject.Properties).Count }
      $meetProp = $snap.PSObject.Properties['meetings']
      if ($null -ne $meetProp -and ($meetProp.Value -is [System.Array])) {
        foreach ($m in $meetProp.Value) {
          $idProp = $m.PSObject.Properties['id']
          if ($null -ne $idProp -and -not [string]::IsNullOrWhiteSpace([string]$idProp.Value)) {
            $MeetingIds += [string]$idProp.Value
          }
        }
      }
    } catch {
      $SnapshotCountsNote = 'snapshot parse/count failed after hash match (hash verification retained): ' + $_.Exception.Message
      $AllOk = $false
    }
  }
} else {
  $AllOk = $false
}

# --- Per-meeting voice (requires meeting ids from verified snapshot only) ---
$VoiceLog = @()
$VoiceNote = ''
if ($BackupVerified -and $MeetingIds.Count -gt 0) {
  $idx = 0
  foreach ($mid in $MeetingIds) {
    $idx++
    $vrec = Invoke-CaptureGet ('voice-' + $idx) ('/api/meetings/' + $mid + '/voice')
    $vrow = [ordered]@{ meetingIndex = $idx; status = $vrec['status']; file = $vrec['file']; bytes = $vrec['bytes']; sha256 = $vrec['sha256']; ok = $false; count = 'n/a'; note = $vrec['note'] }
    if ($vrec['ok']) {
      $c = Get-ArrayCount $vrec['parsed'] ([bool]$vrec['isArray'])
      if ($c['present']) { $vrow['ok'] = $true; $vrow['count'] = $c['count'] }
      else { $vrow['note'] = 'non-array voice body; not counted as empty'; $AllOk = $false }
    } else {
      $AllOk = $false
    }
    $VoiceLog += $vrow
    $FetchLog += @($vrec)
  }
  $VoiceNote = ('voice capture attempted for ' + $MeetingIds.Count + ' verified meeting id(s)')
} elseif ($BackupVerified -and $SnapshotCountsNote -ne '') {
  # Meeting ids are unknown because counting failed; the hash verification
  # above still stands, the skip is reported here, capture is incomplete.
  $VoiceNote = 'meeting ids unknown (snapshot counts failed); voice capture skipped and recorded here'
} elseif ($BackupVerified) {
  # Zero meetings with ids in a verified snapshot: zero voice captures are
  # required, so this completes with 0 voice (never a fake failure, and the
  # skip is reported here rather than silently).
  $VoiceNote = 'verified snapshot holds zero meetings with ids; zero voice captures required (complete with 0 voice)'
} else {
  $VoiceNote = 'snapshot not hash-verified; voice capture skipped'
}

# --- Count-only summaries for ledger routes (200 + JSON array required) ---
function Get-CountSummary($Rec) {
  $c = Get-ArrayCount $Rec['parsed'] ([bool]$Rec['isArray'])
  if ($Rec['ok'] -and $c['present']) { return @{ ok = $true; count = $c['count'] } }
  if ($Rec['ok']) { $Rec['note'] = 'non-array body; not counted as empty' }
  return @{ ok = $false; count = 'n/a' }
}
$JobsSummary = Get-CountSummary $JobsRec
if (-not $JobsSummary['ok']) { $AllOk = $false }
$UsageSummary = Get-CountSummary $UsageRec
if (-not $UsageSummary['ok']) { $AllOk = $false }
$AuditSummary = Get-CountSummary $AuditRec
if (-not $AuditSummary['ok']) { $AllOk = $false }
$CallsSummary = Get-CountSummary $CallsRec
if (-not $CallsSummary['ok']) { $AllOk = $false }

$ReadySummary = [ordered]@{ ok = $false; ready = 'unknown'; store = 'unknown' }
if ($ReadyRec['ok']) {
  try {
    $r = $ReadyRec['parsed']
    $ReadySummary['ready'] = [string]$r.ready
    $ReadySummary['store'] = [string]$r.store
    $ReadySummary['ok'] = $true
  } catch {
    $ReadyRec['note'] = 'unrecognized /ready shape'
    $ReadyRec['ok'] = $false
    $AllOk = $false
  }
} else { $AllOk = $false }

$ModelSummary = [ordered]@{ ok = $false; configured = 'unknown'; source = 'unknown'; model = 'unknown'; chatOverrideEmpty = 'unknown' }
if ($ModelRec['ok']) {
  try {
    $mm = $ModelRec['parsed']
    $ModelSummary['configured'] = [string]$mm.configured
    $ModelSummary['source'] = [string]$mm.source
    $ModelSummary['model'] = [string]$mm.model
    $co = $mm.PSObject.Properties['chatOverride']
    if ($null -eq $co -or [string]::IsNullOrEmpty([string]$co.Value)) { $ModelSummary['chatOverrideEmpty'] = 'true' } else { $ModelSummary['chatOverrideEmpty'] = 'false' }
    $ModelSummary['ok'] = $true
    # NOTE: raw body (incl. keyHint) stays in the private raw file only; never logged.
  } catch {
    $ModelRec['note'] = 'unrecognized /api/model/status shape'
    $ModelRec['ok'] = $false
    $AllOk = $false
  }
} else { $AllOk = $false }

$SpendSummary = [ordered]@{ ok = $false; month = 'unknown'; mode = 'unknown'; monthlyCapUsd = 'unknown'; knownSpendUsd = 'unknown'; unknownCostCalls = 'unknown' }
if ($SpendRec['ok']) {
  try {
    $sp = $SpendRec['parsed']
    # Native JSON types preserved: monthlyCapUsd null stays null (never ""),
    # and an actual mode of "" stays "" (never normalized to 'unknown').
    $SpendSummary['month'] = Get-NativeField $sp 'month'
    $SpendSummary['mode'] = Get-NativeField $sp 'mode'
    $SpendSummary['monthlyCapUsd'] = Get-NativeField $sp 'monthlyCapUsd'
    $SpendSummary['knownSpendUsd'] = Get-NativeField $sp 'knownSpendUsd'
    $SpendSummary['unknownCostCalls'] = Get-NativeField $sp 'unknownCostCalls'
    $SpendSummary['ok'] = $true
  } catch {
    $SpendRec['note'] = 'unrecognized /api/spending shape'
    $SpendRec['ok'] = $false
    $AllOk = $false
  }
} else { $AllOk = $false }

# --- Optional original browser backup via EXISTING helper (allowlisted IDs only) ---
$BrowserInfo = [ordered]@{ attempted = $false; exitCode = 'n/a'; consoleFile = ''; outFile = ''; note = 'not requested' }
if ($IncludeBrowser) {
  $BrowserInfo['attempted'] = $true
  try {
    $BrowserDir = Join-Path $CaptureRootFull 'browser'
    $null = New-Item -ItemType Directory -Path $BrowserDir -Force
    $BrowserOut = Join-Path $BrowserDir ('browser-drafts-' + $StampUtc + '-UTC.json')
    $BrowserConsoleFile = Join-Path $BrowserDir 'browser-console.json'
    & git -C $MainRootFull check-ignore -q $BrowserOut
    if ($LASTEXITCODE -ne 0) { throw New-Object System.Exception('Browser out path is NOT Git-ignored; refusing browser capture: ' + $BrowserOut) }
    # Native stderr merged via 2>&1 surfaces as ErrorRecords; with
    # EAP=Stop that would terminate before the manifest is written, so run
    # the native helper with EAP=Continue and always persist partial
    # evidence plus an INCOMPLETE manifest (never abort without one).
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $consoleText = & node $BrowserHelperPath --out $BrowserOut --cdp $CdpEndpoint 2>&1 | Out-String
      $code = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $prevEap
    }
    $BrowserInfo['exitCode'] = $code
    $noBom2 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($BrowserConsoleFile, $consoleText, $noBom2)
    $BrowserInfo['consoleFile'] = 'browser/browser-console.json'
    if ($code -eq 0 -and (Test-Path -LiteralPath $BrowserOut -PathType Leaf)) {
      $BrowserInfo['outFile'] = 'browser/' + [System.IO.Path]::GetFileName($BrowserOut)
      $BrowserInfo['note'] = 'helper exit 0 with complete app capture per helper fail-closed semantics (SimCEO 127.0.0.1:5174 app target + edge newtab skipped-non-app); no other browsers/origins captured or claimed'
    } else {
      $BrowserInfo['note'] = 'browser helper did NOT complete (nonzero exit or missing out file); partial evidence preserved, no other browsers/origins claimed'
      $AllOk = $false
    }
  } catch {
    $BrowserInfo['note'] = 'browser capture error (partial evidence preserved): ' + $_.Exception.Message
    try {
      $noBomErr = New-Object System.Text.UTF8Encoding $false
      [System.IO.File]::WriteAllText($BrowserConsoleFile, ('browser capture error: ' + $_.Exception.Message), $noBomErr)
      $BrowserInfo['consoleFile'] = 'browser/browser-console.json'
    } catch { }
    $AllOk = $false
  }
}

$HttpClient.Dispose()
$HttpHandler.Dispose()

# --- Nonsecret manifest (statuses/hashes/counts ONLY) ---
# Per-route status/hash/count/error-note rows. Ledger-route ok flags reflect
# array-count success: a 200 non-array body is NOT ok and is never empty.
$RouteRows = @()
foreach ($f in $FetchLog) {
  $row = [ordered]@{ name = $f['name']; path = $f['path']; file = $f['file']; status = $f['status']; bytes = $f['bytes']; sha256 = $f['sha256']; ok = $f['ok']; note = $f['note'] }
  if ($f['name'] -eq 'activity-jobs') { $row['count'] = $JobsSummary['count']; $row['ok'] = ([bool]$f['ok'] -and [bool]$JobsSummary['ok']) }
  elseif ($f['name'] -eq 'usage') { $row['count'] = $UsageSummary['count']; $row['ok'] = ([bool]$f['ok'] -and [bool]$UsageSummary['ok']) }
  elseif ($f['name'] -eq 'activity-audit') { $row['count'] = $AuditSummary['count']; $row['ok'] = ([bool]$f['ok'] -and [bool]$AuditSummary['ok']) }
  elseif ($f['name'] -eq 'models-calls') { $row['count'] = $CallsSummary['count']; $row['ok'] = ([bool]$f['ok'] -and [bool]$CallsSummary['ok']) }
  $RouteRows += $row
}

$Manifest = [ordered]@{
  tool = 'capture-human-state.ps1 (Muse, read-only pre-cutover preservation)'
  generatedAtUtc = [DateTime]::UtcNow.ToString('o')
  mainRoot = $MainRootFull
  captureDir = [System.IO.Path]::GetFileName($CaptureRootFull)
  sourceOrigin = $OriginNorm
  timeoutSec = $TimeoutSec
  gitIgnored = [ordered]@{ captureDir = $true; envBackup = $true }
  envBackup = [ordered]@{ file = 'main.env.backup'; sha256 = $EnvBackupSha; note = 'MAIN .env byte-for-byte copy; hash only, contents never logged; MAIN .env unchanged' }
  ready = $ReadySummary
  backupVerification = [ordered]@{
    wrapperFile = 'raw/backup-wrapper.raw.json'; wrapperSha256 = $BackupRec['sha256']; wrapperBytes = $BackupRec['bytes']
    snapshotFile = 'backup.snapshot.json'; snapshotSha256 = $SnapshotSha; snapshotBytes = $SnapshotBytes
    fullHashMatch = $BackupVerified
    semantics = 'SHA256 over UTF8 bytes of EXACT snapshot string, lowercase hex (old Hashing.FullHash); wrapper raw + snapshot preserved as separate exact bytes, no re-serialization'
  }
  domainCounts = $DomainCounts
  snapshotCountsNote = $SnapshotCountsNote
  routes = $RouteRows
  voice = $VoiceLog
  voiceNote = $VoiceNote
  modelStatus = $ModelSummary
  spending = $SpendSummary
  browser = $BrowserInfo
  omissions = @(
    'authstate NOT exported: domain backup v2 carries grants/invites domain data but NO accounts/sessions/security-states/ACL; capture proves nothing about account/session counts and grants/invites MUST NOT be labeled as permissions or auth proof',
    'audit is capped at 200 by the API; zero auth.register events is inference only, MUST NOT be labeled as exported accounts/sessions or proof of zero',
    '/api/model/status returns configured/source/model/chatOverride only; raw key is NEVER returned by this route (confirmed read-only in old source ModelSettingsEndpoints.cs) and keyHint stays in the private raw file',
    'observed store and caps/truncation risks recorded in ready/routes; jobs take100, usage take500, audit take200, model-calls take200 may truncate',
    'no process environment captured; no Docker/container config captured; no new runtime dependency added'
  )
  verdict = [ordered]@{
    snapshotDataCaptured = $BackupVerified
    authStateExported = $false
    complete = $false
    note = 'Capture success (even when complete) is NOT cutover readiness and does NOT authorize stopping the old in-memory API. The snapshot is valid for domain restore (legacy v2 domain restore passed the 315 probe) but NOT for full auth/policy state. Cutover/start remain BLOCKED on Docker startup approval.'
  }
}
$Manifest['verdict']['complete'] = ($AllOk -and $BackupVerified)
$ManifestJson = ConvertTo-Json -InputObject $Manifest -Depth 10
$noBom3 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $CaptureRootFull 'manifest.json'), $ManifestJson, $noBom3)

# --- Nonsecret final verdict (never bodies/drafts/credentials) ---
Write-Output ("capture-dir: " + $CaptureRootFull)
Write-Output ("backup hash-verified (FullHash): " + $BackupVerified)
Write-Output ("routes ok: ready=" + $ReadyRec['ok'] + " backup=" + $BackupRec['ok'] + " jobs=" + $JobsSummary['ok'] + " usage=" + $UsageSummary['ok'] + " audit=" + $AuditSummary['ok'] + " modelcalls=" + $CallsSummary['ok'] + " modelstatus=" + $ModelSummary['ok'] + " spending=" + $SpendSummary['ok'])
Write-Output ("authstate exported: False (domain snapshot carries no accounts/sessions; never inferred)")
if ($Manifest['verdict']['complete']) {
  Write-Output ("verdict: COMPLETE snapshot-data capture; NOT cutover readiness; old API must stay running")
  exit 0
} else {
  Write-Error ("verdict: INCOMPLETE capture; partial private evidence preserved under capture dir; nothing deleted; old API untouched")
  exit 1
}
