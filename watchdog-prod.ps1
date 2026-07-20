# watchdog-prod.ps1 -- ran every 10 minutes by the 'MarketMap Prod Watchdog'
# scheduled task. If nothing is listening on port 3000 and the supervisor task
# is not running, start the supervisor task. Covers the case where the task was
# stopped/killed (the supervisor loop itself already handles in-process crashes,
# and the logon trigger covers reboots).
# Keep this file pure ASCII: PS 5.1 misreads BOM-less UTF-8 as Windows-1252.

$taskName = 'MarketMap Prod Server'
$logFile = 'C:\Dev\MarketMap_New\logs\watchdog.log'

$listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($listener) { exit 0 }

$task = $null
try { $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop } catch {}
if ($task -and $task.State -eq 'Running') { exit 0 }

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Add-Content -Path $logFile -Encoding Ascii -Value "[$stamp] port 3000 down and task not running; starting '$taskName'"
try {
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
} catch {
    Add-Content -Path $logFile -Encoding Ascii -Value "[$stamp] FAILED to start task: $_"
}
