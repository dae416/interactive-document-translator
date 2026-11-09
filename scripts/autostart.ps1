# Registers the Windows task that runs scripts\start.ps1, without a window, whenever you sign in.
# The task holds this folder's path: run this again after the folder moves. It restarts the
# server. With an instance name ("autostart.ps1 mill") it registers that other app of this code
# (instances\<name>.env) as its own task, eng-reader-<name>.
param([string]$Instance = '')
$ErrorActionPreference = 'Stop'
if ($Instance -notmatch '^[a-z0-9]*$') { throw "An app's name is lowercase letters and digits (instances\<name>.env)." }
# (before any task is touched: start.ps1 would refuse it at every sign-in, unseen)
if ($Instance -and -not (Test-Path ([IO.Path]::Combine((Split-Path -Parent $PSScriptRoot), 'instances', "$Instance.env")))) {
  throw "No app named '$Instance': there is no instances\$Instance.env."
}
$task = if ($Instance) { "eng-reader-$Instance" } else { 'eng-reader' }
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$start = Join-Path $PSScriptRoot 'start.ps1'
# Not powershell -WindowStyle Hidden: Windows 11 shows that in a Windows Terminal window all the
# same, and closing the window stops the server. conhost --headless has no window at all.
$action = New-ScheduledTaskAction -Execute conhost.exe -Argument ("--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$start`" $Instance").TrimEnd()
$logon = New-ScheduledTaskTrigger -AtLogOn -User $me
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

# A running instance keeps its old definition and folder. ponytail: its server notices within 5 s and
# waits up to 3 s for translations to stop; a slower one makes the new server retry a minute later.
if ((Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue).State -eq 'Running') {
  Stop-ScheduledTask -TaskName $task
  Start-Sleep -Seconds 10
}
Register-ScheduledTask -TaskName $task -Force -Action $action -Trigger $logon -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $task
if ($Instance) { "The $Instance app starts when you sign in." } else { 'The server starts when you sign in.' }
