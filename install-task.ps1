# install-task.ps1 — registers start-daemon.ps1 as a Windows scheduled task (at logon)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$daemonScript = Join-Path $scriptDir 'start-daemon.ps1'

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -File `"$daemonScript`""

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName 'Switchboard MCP Daemon' `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Local MCP switchboard daemon for Claude Code session communication' `
    -Force

Write-Host "scheduled task 'Switchboard MCP Daemon' registered; will start at next logon"
