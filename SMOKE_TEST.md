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

## Phase 2.5 auto-wake scenario

### Prereq

1. Switchboard daemon running (`bun main.ts` or scheduled task)
2. Two Claude Code sessions in the same workspace, both with `client-hooks.example.json` merged into `.claude/settings.local.json`
3. Both sessions restarted (or `/hooks` reload'd) after config change
4. `switchboard.db` is fresh (delete old Phase 1/2 file; migration guard will also handle this on startup)

### Verify hook-session-start

On each session startup, the SessionStart hook injects a system reminder containing the cc_session_id. The Claude in each session should see a line like:

```
Your Claude Code session id is: abcdef12-...
```

### Claude-side register

In each session, the Claude calls:

```
mcp__switchboard__register(role='smoke-a', cc_session_id='<cc-id-from-reminder>')
```

(Different role per session — e.g. `smoke-a` and `smoke-b`.)

### Round trip — two sessions in same workspace

1. **Session A** (sender):
   - Call `mcp__switchboard__list_sessions` → verify both `smoke-a` and `smoke-b` are `online: true`
   - Call `mcp__switchboard__send` with `{to: "smoke-b", message: "auto-wake test"}`
   - Finish the turn

2. **Session B** (recipient):
   - **Do NOT send any user prompt**
   - Within ~2-5 seconds, Session B should auto-spawn a new turn
   - New turn should see `SWITCHBOARD INBOX: 1 unread message(s) for role "smoke-b"`
   - Claude should automatically call `mcp__switchboard__read_messages`

3. **Success**: Session B displayed a new turn + read the message without user input on B's side.

### Reclaim after disconnect

1. Session A is registered as `reclaim-test` with cc_session_id `cc-a1`
2. Close Session A
3. Start Session C in the same workspace (new cc_session_id)
4. In Session C, call `register(role='reclaim-test', cc_session_id='<cc-id>')`
5. **Expected**: register succeeds (alias was released on A's disconnect); `list_sessions` shows C as `reclaim-test`

### First-turn race

1. Start Session D with hook config enabled
2. Before Claude in D has a chance to call `register`, send a message from Session A to `nonexistent-role`
3. **Expected**: A's `send` call throws `recipient not found` (role doesn't exist because D hasn't registered yet)

### Multi-session isolation

1. Start Session A, register as `multi-a`
2. Start Session B, register as `multi-b`
3. Check `D:\tsunu_plan\.claude\` — there should be TWO state files: `switchboard-poller-<cc-a>.state` and `switchboard-poller-<cc-b>.state`, each with a different pid
4. Send from A to B → only B wakes
5. Send from B to A → only A wakes

### Orphan cleanup

1. Start a session, register, let poller run
2. Force-close Claude Code without graceful shutdown (kill process)
3. Within 10 minutes (TTL), any running `bun poller.ts` should exit 0 on its own
