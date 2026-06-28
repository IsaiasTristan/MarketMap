<#
.SYNOPSIS
  Wrapper around `npm run job:fundamental` for unattended (Windows Task Scheduler) runs.

.DESCRIPTION
  Pulls standardized statements for the shared universe, snapshots them into the
  append-only store, and computes the fundamental signals + ranked discovery
  queue (see scripts/fundamental-weekly.ts). Sets the working directory to the
  repo root so Prisma + FMP_API_KEY load from the root .env, and tees output to a
  timestamped file under logs/. Exits with the job's exit code.

.PARAMETER Backfill
  First run: BACKFILL provenance + ~9yr quarterly history (heavier).

.NOTES
  Register via scripts/register-fundamental-task.ps1. Idempotent — safe to re-run.
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
$logFile = Join-Path $logDir "fundamental-weekly-$stamp.log"

$cmd = if ($Backfill) { 'npm run job:fundamental -- --backfill' } else { 'npm run job:fundamental' }
"[$(Get-Date -Format o)] starting fundamental-weekly (cwd=$repoRoot, backfill=$Backfill)" | Tee-Object -FilePath $logFile

$ErrorActionPreference = 'Continue'
cmd.exe /c $cmd 2>&1 | Tee-Object -FilePath $logFile -Append
$exit = $LASTEXITCODE

"[$(Get-Date -Format o)] finished with exit code $exit" | Tee-Object -FilePath $logFile -Append
exit $exit
