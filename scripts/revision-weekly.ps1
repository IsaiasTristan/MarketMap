<#
.SYNOPSIS
  Wrapper around `npm run job:revision` for unattended (Windows Task Scheduler) runs.

.DESCRIPTION
  Pulls the FMP analyst-revision universe, snapshots both revision legs into the
  append-only store, and computes signals + the ranked research queue (see
  scripts/revision-weekly.ts). Sets the working directory to the repo root so
  Prisma + FMP_API_KEY load from the root .env, and tees output to a timestamped
  file under logs/. Exits with the job's exit code.

.PARAMETER Backfill
  Also (re)load Leg B event history (heavier; use on first setup / periodically).

.NOTES
  Register via scripts/register-revision-task.ps1. Idempotent — safe to re-run.
#>
param(
    [switch]$Backfill
)

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$logDir = Join-Path $repoRoot 'logs'
if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $logDir "revision-weekly-$stamp.log"

$cmd = if ($Backfill) { 'npm run job:revision -- --backfill' } else { 'npm run job:revision' }
"[$(Get-Date -Format o)] starting revision-weekly (cwd=$repoRoot, backfill=$Backfill)" | Tee-Object -FilePath $logFile

$ErrorActionPreference = 'Continue'
cmd.exe /c $cmd 2>&1 | Tee-Object -FilePath $logFile -Append
$exit = $LASTEXITCODE

"[$(Get-Date -Format o)] finished with exit code $exit" | Tee-Object -FilePath $logFile -Append
exit $exit
