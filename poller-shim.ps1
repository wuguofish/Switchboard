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

# Diagnostic log — temporary, to track shim lifecycle (spawn / exit reason).
# Remove once reliability is confirmed. Kept deliberately append-only and
# short per-line so a flurry of spawns stays readable.
$logPath = 'D:/tsunu_plan/.claude/switchboard-shim.log'
function Log-Shim([string]$msg) {
    try {
        $stamp = (Get-Date).ToString('o')
        Add-Content -LiteralPath $logPath -Value "$stamp pid=$PID $msg"
    } catch {}
}

Log-Shim "spawn"

# 1. Parse stdin JSON from the Stop hook.
$stdinText = [Console]::In.ReadToEnd()
if (-not $stdinText) { Log-Shim "exit 0: empty stdin"; exit 0 }
try {
    $payload = $stdinText | ConvertFrom-Json -ErrorAction Stop
} catch {
    Log-Shim "exit 0: bad stdin json"
    exit 0
}
$ccSessionId = $payload.session_id
if (-not $ccSessionId) { Log-Shim "exit 0: no session_id"; exit 0 }

# 2. Find Claude Code's own pid by walking up the parent chain.
#    The immediate parent is powershell → bash (inner) → bash (outer) →
#    claude.exe. We must watch claude.exe, NOT the immediate bash parent:
#    bash blocks on its powershell child (wait(2)), so it stays alive until
#    this shim exits — which makes "is my parent bash alive?" a tautology
#    and defeats orphan detection. Claude Code itself is the process whose
#    death actually means "this session is gone."
function Find-ClaudePid {
    $cur = $PID
    for ($i = 0; $i -lt 12 -and $cur -gt 0; $i++) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId = $cur" -ErrorAction SilentlyContinue
        if (-not $p) { return 0 }
        if ($p.Name -eq 'claude.exe' -or $p.Name -eq 'node.exe') {
            return [int]$p.ProcessId
        }
        $cur = [int]$p.ParentProcessId
    }
    return 0
}

$claudePid = Find-ClaudePid
Log-Shim "claude_pid=$claudePid cc=$ccSessionId stop_hook_active=$($payload.stop_hook_active)"

# 2b. Supersede any older shim for the same cc_session_id. Every Stop hook
#     fires a fresh shim; without this the old long-poll keeps running
#     alongside the new one and shims pile up (one per turn × every session
#     on this workspace). A tiny lock file in the state dir records the
#     current shim pid — the new shim reads it, kills the old one if still
#     alive, then writes its own pid.
$lockPath = "D:/tsunu_plan/.claude/switchboard-shim-$ccSessionId.lock"
if (Test-Path -LiteralPath $lockPath) {
    try {
        $oldPid = [int](Get-Content -LiteralPath $lockPath -ErrorAction Stop | Select-Object -First 1).Trim()
        if ($oldPid -gt 0 -and $oldPid -ne $PID -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
            Log-Shim "superseding old shim pid=$oldPid"
            Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}
try {
    Set-Content -LiteralPath $lockPath -Value $PID -Encoding ascii -ErrorAction SilentlyContinue
} catch {}

function Test-ParentAlive {
    if ($claudePid -le 0) {
        # Couldn't locate claude.exe in our ancestry. Be conservative and
        # keep running, but rely on the session-released signal from the
        # daemon ('no-session') to eventually terminate us.
        return $true
    }
    return [bool](Get-Process -Id $claudePid -ErrorAction SilentlyContinue)
}

# 3. Long-poll loop. Each /poll call is capped at ~240s server-side; we
#    re-enter unless the parent is gone or we hit an unrecoverable setup error.
#
# Transient errors (daemon restarting, TCP blip, 5xx) must NOT drop us out
# of the loop — if we exit 0 here, the session stays unreachable until the
# next turn ends. The original shim did that and caused pixai-class overnight
# wake-up failures. We retry with backoff instead; only unrecoverable
# conditions (parent gone, session released) actually exit.
$segmentTimeoutS = 240
$curlMaxTimeS = $segmentTimeoutS + 10
$retrySleepS = 3
$maxBackoffS = 30
$curFail = 0

while ($true) {
    if (-not (Test-ParentAlive)) { Log-Shim "exit 0: claude_pid $claudePid gone"; exit 0 }

    $pollUrl = "$daemonUrl/poll?cc_session_id=$ccSessionId&timeout_s=$segmentTimeoutS"
    # -s silent, -S show errors on stderr, -f fail on 4xx/5xx.
    $raw = & curl.exe -s -S -f --max-time $curlMaxTimeS $pollUrl 2>$null
    $curlExit = $LASTEXITCODE

    if ($curlExit -ne 0 -or -not $raw) {
        # Transient failure: daemon restarting, connection refused, 5xx,
        # bad response. Back off and retry as long as parent is alive.
        $curFail++
        $sleep = [Math]::Min($retrySleepS * $curFail, $maxBackoffS)
        Log-Shim "retry: curl_exit=$curlExit empty_body=$([bool](-not $raw)) sleep=${sleep}s"
        Start-Sleep -Seconds $sleep
        continue
    }

    try {
        $resp = $raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        $curFail++
        $sleep = [Math]::Min($retrySleepS * $curFail, $maxBackoffS)
        Log-Shim "retry: bad_response sleep=${sleep}s"
        Start-Sleep -Seconds $sleep
        continue
    }

    $curFail = 0

    switch ($resp.status) {
        'unread' {
            Log-Shim "exit 2: unread $($resp.count)"
            if ($resp.message) { Write-Output $resp.message }
            exit 2
        }
        'no-session' {
            # Session never registered or was explicitly released.
            # Unlike transient errors this is terminal — nothing to poll for.
            Log-Shim "exit 0: no-session"
            exit 0
        }
        'timeout' {
            # Normal segment timeout; loop and check parent liveness again.
            Log-Shim "timeout segment"
            continue
        }
        default {
            # Unknown status; treat as transient and retry.
            $curFail++
            $sleep = [Math]::Min($retrySleepS * $curFail, $maxBackoffS)
            Log-Shim "retry: unknown status=$($resp.status) sleep=${sleep}s"
            Start-Sleep -Seconds $sleep
            continue
        }
    }
}
