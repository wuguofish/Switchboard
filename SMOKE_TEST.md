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

## Phase 2 auto-wake scenario

### Prereq

1. Switchboard daemon running (`bun main.ts` or scheduled task)
2. Two Claude Code sessions, each with different `SWITCHBOARD_ROLE` in their workspace `.claude/settings.local.json`:
   - Session A: `SWITCHBOARD_ROLE=smoke-auto-a`
   - Session B: `SWITCHBOARD_ROLE=smoke-auto-b`
3. Both sessions have SessionStart + Stop hooks from `client-hooks.example.json` merged in
4. Both sessions restarted (or `/hooks` reload'd) after env var set

### Verify bootstrap

On session startup, both sessions' bootstrap should have run:

- Check `D:\tsunu_plan\.claude\switchboard-role.txt` exists and contains the role of the most recently started session (both bootstraps write to the same file — this is fine because the content is the same per-workspace; if you run multi-workspace, switch to per-workspace paths)

### Round trip

1. **Session A** (the sender):
   - Call `mcp__switchboard__list_sessions` → verify both `smoke-auto-a` and `smoke-auto-b` are `online: true`
   - Call `mcp__switchboard__send` with `{to: "smoke-auto-b", message: "auto-wake test"}`
   - Finish the turn (stop replying)

2. **Session B** (the recipient):
   - **Do NOT send any user prompt**. Just watch.
   - Within ~2-5 seconds, Session B should auto-spawn a new turn
   - In that new turn, Claude should see a system reminder containing `SWITCHBOARD INBOX: 1 unread message(s) for role "smoke-auto-b"`
   - Claude should automatically call `mcp__switchboard__read_messages` and retrieve the "auto-wake test" message

3. **Success criteria**: Session B displayed a new turn + read the message **without any user interaction on B's side**.

### Recall during auto-wake window

1. Session A sends a message to Session B, finishes turn
2. Session B's poller detects unread (poll interval ≤ 2s), exits 2
3. **Before Session B processes the wake**, Session A calls `mcp__switchboard__recall` on that message_id
4. Session B wakes up, calls `read_messages` → should get 0 messages (recalled in time)

This verifies recall interacts correctly with the auto-wake path.

### Orphan cleanup

1. Start a session with auto-wake enabled
2. Close the Claude Code session (Ctrl+C / quit)
3. Check Task Manager / `ps` for any `bun poller.ts` processes
4. Within 10 minutes (TTL), any running poller should exit 0 cleanly
5. `switchboard-poller.state` may be stale but next session's bootstrap will overwrite it
