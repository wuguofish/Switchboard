# Switchboard channel for Claude Code

`switchboard-channel.ts` is a stdio MCP server that Claude Code spawns per session. It proxies the Switchboard tools to the daemon and turns the daemon's `/monitor` stream into `notifications/claude/channel` events, so a message wakes the session without a `Monitor` watch and without the 30-minute re-arm that Claude Code 2.1.271 introduced.

## Setup

1. Point your MCP config at the shim instead of the daemon's HTTP endpoint (see `mcp.example.json`):

   ```json
   {
     "mcpServers": {
       "switchboard": {
         "command": "bun",
         "args": ["/absolute/path/to/Switchboard/clients/cc-channel/switchboard-channel.ts"]
       }
     }
   }
   ```

   Keep the server name `switchboard`: it becomes the `source` attribute on every event and the hook text refers to it.

2. Start Claude Code with the channel enabled. Channels are a research preview, so a custom one needs the development flag every launch:

   ```bash
   claude --dangerously-load-development-channels server:switchboard
   ```

   Several channels can share one session; list them space-separated after the flag. A dim line under the startup banner confirms the channel is registered. No line means no channel: messages will not arrive.

3. Export `SWITCHBOARD_DELIVERY=channel` in the environment Claude Code starts from. The SessionStart hook then teaches this path and omits the Monitor instructions.

## Foreground sessions only

Background sessions cannot use this shim as a channel. Neither agent view nor `claude --bg` carries `--dangerously-load-development-channels` into the session, the flag's confirmation prompt has no terminal to answer it, and the job's respawn flags drop it. Verified 2026-09-15: such a session loads the shim as a plain MCP server (tools and `register` work) but never receives a `<channel>` event. Use the Monitor path there, or the socket path once it lands (#20).

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `SWITCHBOARD_URL` | `http://127.0.0.1:9876` | Daemon base URL |
| `SWITCHBOARD_HEARTBEAT_SECS` | daemon default (4 h) | Passed to `/monitor` as `heartbeat_secs` |
| `CLAUDE_CODE_SESSION_ID` | set by Claude Code | Identifies the session; also filled into `register` when the call omits `cc_session_id` |

## Events

Every `/monitor` line becomes one event. The `kind` attribute tells Claude what to do:

| Line | Event |
|---|---|
| `inbox 3 alias` | `<channel source="switchboard" kind="inbox" count="3" alias="alias">` → call `read_messages` |
| `hello alias` | `kind="hello"` → nothing to do |
| `heartbeat <Taipei time>` | `kind="heartbeat" at="..."` → clock tick, no reply |

The shim subscribes as soon as it starts and again after every successful `register` or `set_alias`. If the daemon restarts it reconnects after 5 seconds; while the session is not registered it retries every 30 seconds.

## Cost

One Bun process per session, about 45 MB resident. Channel events have no acknowledgement: the daemon knows a message was delivered only when Claude calls `read_messages`.
