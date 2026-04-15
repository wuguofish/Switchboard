# Switchboard smoke test

## Prereq

1. Daemon running: `bun main.ts` (foreground) or `powershell -File start-daemon.ps1` (detached)
2. `D:\tsunu_plan\.mcp.json` has the `switchboard` entry pointing at `http://127.0.0.1:9876/mcp`
3. `D:\tsunu_plan\.claude\settings.json` has the SessionStart hook

## Two-session round trip

Open **two** Claude Code sessions (two terminal windows) in `D:\tsunu_plan`.

**Session A:**
1. `mcp__switchboard__register` with `{role: "smoke-a"}` → note `session_id`
2. `mcp__switchboard__list_sessions` → should see "smoke-a" online
3. Wait for session B to register

**Session B:**
1. `mcp__switchboard__register` with `{role: "smoke-b"}`
2. `mcp__switchboard__list_sessions` → should see both "smoke-a" and "smoke-b" online

**Session A:**
3. `mcp__switchboard__send` with `{to: "smoke-b", message: "hello from A"}`
4. Response should include `delivered_notification: true`

**Session B:**
3. Should receive a notification (system reminder injected into context)
4. `mcp__switchboard__read_messages` → should get the message
5. Call `read_messages` again → empty (already marked read)

## Recall test

**Session A:**
1. Send a message to `smoke-b`, save the `message_id`
2. Before B reads, call `mcp__switchboard__recall` with that `message_id`

**Session B:**
3. Call `read_messages` → empty (message was recalled)

## Broadcast test

**Session A:**
1. `mcp__switchboard__broadcast` with `{message: "to all"}`

**Session B:**
2. `read_messages` → should include the broadcast with `is_broadcast: true`
