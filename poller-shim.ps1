# poller-shim.ps1 — Stop-hook shim that replaces `bun poller.ts`.
#
# Reads Claude Code's Stop-hook stdin JSON, extracts the session_id, then
# long-polls the switchboard daemon's /poll endpoint. Exits 2 with a
# SWITCHBOARD INBOX message when unread mail is waiting (which triggers
# asyncRewake), exits 0 otherwise.
#
# The daemon caps each /poll wait at ~250s (Bun idle-timeout limit), so
# this shim loops: after every timeout it re-checks that the parent
# Claude Code process is still alive before re-dialing. When the parent
# dies we exit cleanly.
#
# Memory: ~30-50 MB for PowerShell + ~5-10 MB for curl, compared to
# ~150 MB for the Bun-based poller it replaces.

$ErrorActionPreference = 'Stop'

# Daemon endpoint — keep in sync with main.ts SWITCHBOARD_PORT default.
$daemonUrl = if ($env:SWITCHBOARD_URL) { $env:SWITCHBOARD_URL } else { 'http://127.0.0.1:9876' }

# 1. Parse stdin JSON from the Stop hook.
$stdinText = [Console]::In.ReadToEnd()
if (-not $stdinText) { exit 0 }
try {
    $payload = $stdinText | ConvertFrom-Json -ErrorAction Stop
} catch {
    exit 0
}
$ccSessionId = $payload.session_id
if (-not $ccSessionId) { exit 0 }

# 2. Remember the spawning Claude Code pid so we can self-terminate
#    when it exits (analogous to the parent-pid check in poller.ts).
$ownPid = $PID
try {
    $parentPid = (Get-CimInstance Win32_Process -Filter "ProcessId = $ownPid" -ErrorAction Stop).ParentProcessId
} catch {
    $parentPid = 0
}

function Test-ParentAlive {
    if ($parentPid -le 0) { return $true }
    return [bool](Get-Process -Id $parentPid -ErrorAction SilentlyContinue)
}

# 3. Long-poll loop. Each /poll call is capped at ~240s server-side; we
#    re-enter unless the parent is gone or we hit an auth/setup error.
$segmentTimeoutS = 240
$curlMaxTimeS = $segmentTimeoutS + 10

while ($true) {
    if (-not (Test-ParentAlive)) { exit 0 }

    $pollUrl = "$daemonUrl/poll?cc_session_id=$ccSessionId&timeout_s=$segmentTimeoutS"
    # -s silent, -S show errors on stderr, -f fail on 4xx/5xx.
    $raw = & curl.exe -s -S -f --max-time $curlMaxTimeS $pollUrl 2>$null
    $curlExit = $LASTEXITCODE

    if ($curlExit -ne 0) {
        # Daemon unreachable / 404 / parse error — nothing we can do; let
        # Claude Code exit normally (no rewake). The next turn's Stop hook
        # will retry.
        exit 0
    }
    if (-not $raw) { exit 0 }

    try {
        $resp = $raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        exit 0
    }

    switch ($resp.status) {
        'unread' {
            if ($resp.message) { Write-Output $resp.message }
            exit 2
        }
        'no-session' {
            # Session never registered (or got released). No sense polling.
            exit 0
        }
        'timeout' {
            # Normal segment timeout; loop and check parent liveness again.
            continue
        }
        default {
            exit 0
        }
    }
}
