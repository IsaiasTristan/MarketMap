<#
.SYNOPSIS
  One-time setup: register a Windows Scheduled Task that runs the Engine 2
  fundamental-inflection weekly ingestion + scoring job.

.DESCRIPTION
  Creates (or overwrites) a scheduled task that runs scripts/fundamental-weekly.ps1
  once a week (default Saturday 09:00 local — staggered after the revision job).
  Fundamentals only change on filings, so a weekly cadence matches the source.
  Uses -StartWhenAvailable so a missed run (PC off/asleep) fires at the next
  opportunity. The job is idempotent.

.PARAMETER TaskName
  Scheduled task name. Default 'MarketMap Fundamental Weekly'.

.PARAMETER At
  Local start time, HH:mm. Default '09:00'.

.PARAMETER DayOfWeek
  Day of week to run. Default 'Saturday'.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/register-fundamental-task.ps1

.NOTES
  Registering for the current user normally does not require elevation.
#>
param(
    [string]$TaskName = 'MarketMap Fundamental Weekly',
    [string]$At = '09:00',
    [string]$DayOfWeek = 'Saturday'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $repoRoot 'scripts\fundamental-weekly.ps1'
if (-not (Test-Path -LiteralPath $wrapper)) {
    throw "Wrapper script not found: $wrapper"
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`""

$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $DayOfWeek -At ([datetime]$At)

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 4) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Engine 2: weekly FMP fundamentals ingestion + signal scoring + ranked discovery queue.' `
    -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' ($DayOfWeek at $At local)."
Write-Host "Verify : Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host "Run now: Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Remove : Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
