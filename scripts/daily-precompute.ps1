<#
.SYNOPSIS
  Wrapper around `npm run job:daily` for unattended (Windows Task Scheduler) runs.

.DESCRIPTION
  Ingests the latest market close, refreshes the factor pipeline, and
  precomputes + caches the per-stock regression grid for every HORIZON window
  (see scripts/daily-precompute.ts). Sets the working directory to the repo
  root so Prisma reads DATABASE_URL from the root .env, and tees all output to
  a timestamped file under logs/. Exits with the job's exit code.

.NOTES
  Register via scripts/register-daily-task.ps1. Idempotent — safe to re-run.
#>

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$logDir = Join-Path $repoRoot 'logs'
if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $logDir "daily-precompute-$stamp.log"

"[$(Get-Date -Format o)] starting daily-precompute (cwd=$repoRoot)" | Tee-Object -FilePath $logFile

# Native command stderr must not abort the pipeline; rely on the exit code.
$ErrorActionPreference = 'Continue'
cmd.exe /c "npm run job:daily" 2>&1 | Tee-Object -FilePath $logFile -Append
$exit = $LASTEXITCODE

"[$(Get-Date -Format o)] finished with exit code $exit" | Tee-Object -FilePath $logFile -Append
exit $exit
