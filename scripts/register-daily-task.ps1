<#
.SYNOPSIS
  One-time setup: register a Windows Scheduled Task that runs the MarketMap
  daily precompute on weekdays shortly after the US market close.

.DESCRIPTION
  Creates (or overwrites) a scheduled task that runs scripts/daily-precompute.ps1
  Monday-Friday at the given local time (default 17:00 = 5:00pm ET on a machine
  set to Eastern time). Uses -StartWhenAvailable so a missed run (PC off/asleep)
  fires at the next opportunity. The job is idempotent.

.PARAMETER TaskName
  Scheduled task name. Default 'MarketMap Daily Precompute'.

.PARAMETER At
  Local start time, HH:mm. Default '17:00'.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/register-daily-task.ps1

.NOTES
  Registering for the current user normally does not require elevation. If it
  fails with access denied, re-run from an elevated PowerShell.
#>
param(
    [string]$TaskName = 'MarketMap Daily Precompute',
    [string]$At = '17:00'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $repoRoot 'scripts\daily-precompute.ps1'
if (-not (Test-Path -LiteralPath $wrapper)) {
    throw "Wrapper script not found: $wrapper"
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`""

$trigger = New-ScheduledTaskTrigger -Weekly `
    -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday `
    -At ([datetime]$At)

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -MultipleInstances IgnoreNew

# Run as the current user when logged on (inherits network + env, no elevation).
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Ingest latest close, refresh factor pipeline, and precompute the per-stock regression grid for all HORIZON windows (63/252/504/756).' `
    -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' (weekdays at $At local)."
Write-Host "Verify : Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host "Run now: Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Remove : Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
