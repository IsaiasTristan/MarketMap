# run-prod.ps1 - supervised launcher for the MarketMap production web server.
# Runs `npm run start:prod` (next start -p 3000, heap bumped) in a self-restarting
# loop so a crash self-heals within a few seconds. All output (stdout+stderr) is
# appended to logs\prod-server.log with simple size-based rotation.
#
# Normally launched by the "MarketMap Prod Server" Scheduled Task at logon, but can
# be run by hand from a terminal for debugging.

$ErrorActionPreference = 'Continue'
$proj    = 'C:\Dev\MarketMap_New'
$logDir  = Join-Path $proj 'logs'
$logFile = Join-Path $logDir 'prod-server.log'
$maxLogBytes = 20MB

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
Set-Location $proj

function Write-Log([string]$msg) {
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    "[$ts] [run-prod] $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

function Rotate-Log {
    if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt $maxLogBytes)) {
        $bak = "$logFile.1"
        if (Test-Path $bak) { Remove-Item $bak -Force }
        Rename-Item $logFile $bak
    }
}

Write-Log "supervisor started (pid $PID)"
while ($true) {
    Rotate-Log
    Write-Log "starting: npm run start:prod"
    # Redirect the child's stdout+stderr via cmd.exe so the log stays clean bytes
    # (PowerShell 5.1's *>> writes UTF-16 and wraps native stderr as NativeCommandError).
    # $logFile path has no spaces, so it needs no extra quoting for cmd.
    & cmd.exe /c "npm run start:prod 1>> $logFile 2>&1"
    $code = $LASTEXITCODE
    Write-Log "server exited (code $code) - restarting in 5s"
    Start-Sleep -Seconds 5
}
