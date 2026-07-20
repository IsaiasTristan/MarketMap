# check-prod-status.ps1 -- double-click helper that reports whether the
# MarketMap prod server is running, and offers a one-click restart if not.
# Keep this file pure ASCII: PS 5.1 misreads BOM-less UTF-8 as Windows-1252.

Add-Type -AssemblyName System.Windows.Forms | Out-Null

$taskName = 'MarketMap Prod Server'

function Get-ProdStatus {
    $listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    $task = $null
    try { $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop } catch {}
    $tunnel = Get-Service -Name 'Cloudflared' -ErrorAction SilentlyContinue

    [pscustomobject]@{
        ServerUp    = [bool]$listener
        TaskState   = if ($task) { [string]$task.State } else { 'NOT FOUND' }
        TunnelUp    = ($tunnel -and $tunnel.Status -eq 'Running')
    }
}

$s = Get-ProdStatus

if ($s.ServerUp -and $s.TunnelUp) {
    $msg = "MarketMap is RUNNING.`n`n" +
           "Web server:        UP (port 3000)`n" +
           "Supervisor task:   $($s.TaskState)`n" +
           "Cloudflare tunnel: UP`n`n" +
           "dev.itmarketmap.com should be working."
    [System.Windows.Forms.MessageBox]::Show($msg, 'MarketMap Status',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
    exit 0
}

# Something is down -- build a report and offer a restart.
$serverLine = if ($s.ServerUp) { 'UP (port 3000)' } else { 'DOWN (nothing on port 3000)' }
$tunnelLine = if ($s.TunnelUp) { 'UP' } else { 'DOWN (Cloudflared service not running)' }
$msg = "MarketMap is DOWN.`n`n" +
       "Web server:        $serverLine`n" +
       "Supervisor task:   $($s.TaskState)`n" +
       "Cloudflare tunnel: $tunnelLine`n`n" +
       "Restart it now?"

$answer = [System.Windows.Forms.MessageBox]::Show($msg, 'MarketMap Status',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning)

if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { exit 0 }

if (-not $s.ServerUp) {
    try { Start-ScheduledTask -TaskName $taskName -ErrorAction Stop } catch {}
}
if (-not $s.TunnelUp) {
    try { Start-Service -Name 'Cloudflared' -ErrorAction Stop } catch {}
}

# Give the server up to 60s to come up (next start is usually ready in ~5s).
$ok = $false
for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 5
    $s2 = Get-ProdStatus
    if ($s2.ServerUp -and $s2.TunnelUp) { $ok = $true; break }
}

if ($ok) {
    [System.Windows.Forms.MessageBox]::Show(
        "Restarted successfully. MarketMap is RUNNING again.",
        'MarketMap Status',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
} else {
    [System.Windows.Forms.MessageBox]::Show(
        "Restart attempted but the server is still not up after 60 seconds.`n" +
        "Check C:\Dev\MarketMap_New\logs\prod-server.log for errors.",
        'MarketMap Status',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
}
