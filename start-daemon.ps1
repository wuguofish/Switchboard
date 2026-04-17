# start-daemon.ps1 — launches switchboard in the background
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $scriptDir

# Ensure deps installed
if (-not (Test-Path "node_modules")) {
    bun install
}

# Start detached
Start-Process -FilePath "bun" -ArgumentList "main.ts" `
    -WorkingDirectory $scriptDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput "daemon.out.log" `
    -RedirectStandardError "daemon.err.log"

Write-Host "switchboard daemon started"
