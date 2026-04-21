# Switchboard

> 🌐 [正體中文](README.zh-TW.md)

A local-only MCP server that lets multiple Claude Code sessions — running on the same workstation — discover each other and exchange messages. Idle sessions can be auto-woken when a message arrives, so work can hand off between agents without manual tab-switching.

## Why

Claude Code runs each workspace / terminal as its own process, with no built-in way for two sessions to talk. Switchboard fills that gap:

- **Directed messages** (`send`) and **fan-out** (`broadcast`) between named sessions
- **Recall** for messages you wish you hadn't sent
- **Auto-wake, two paths**:
  - A Stop-hook shim long-polls `/poll`, so when a message arrives the next Claude Code turn starts with an `INBOX` reminder.
  - *Or* (recommended for long-lived sessions) Claude Code's `Monitor` tool `curl -N`s `/monitor` as a persistent chunked stream; each inbox line fires an assistant turn directly, sidestepping the known `asyncRewake`-degrades-over-time failure mode.
- **Persistence** — messages live in SQLite and survive daemon restarts

Everything is bound to `127.0.0.1` with no authentication, which makes it safe for intra-machine coordination but never appropriate to expose to a network.

## Architecture

```
   Claude Code session A                Claude Code session B
   ┌──────────────────────┐             ┌──────────────────────┐
   │ MCP client → /mcp    │             │    /mcp ← MCP client │
   │ Monitor  → /monitor  │             │ /monitor ←  Monitor  │
   │ Stop shim → /poll    │             │    /poll ← Stop shim │
   └──────────┬───────────┘             └──────────┬───────────┘
              │                                    │
              └───────► 127.0.0.1:9876 ◄───────────┘
                        ┌────────────────────┐
                        │   Switchboard      │
                        │   daemon (Bun)     │
                        │ /mcp /poll /monitor│
                        │   SQLite WAL       │
                        └────────────────────┘
```

- Daemon: Bun + `WebStandardStreamableHTTPServerTransport`, bound to `127.0.0.1:9876`
- Storage: SQLite in WAL mode; sessions and messages survive restarts
- Transport: Streamable HTTP MCP for tool calls; `/poll` for Stop-hook long-polling; `/monitor` for persistent `Monitor`-tool subscribers

## Requirements

- Windows 10/11 (Linux/macOS not yet tested)
- [Bun](https://bun.com) ≥ 1.3
- Claude Code with MCP support
- PowerShell 5.1+ (ships with Windows)
- `curl.exe` (built into Windows 10+ at `C:\Windows\System32\curl.exe`)

## Install

```powershell
git clone https://github.com/wuguofish/Switchboard.git
cd Switchboard
bun install
```

## Run the daemon

```powershell
# Foreground — logs to stdout / stderr
bun main.ts

# Detached background — logs to daemon.out.log / daemon.err.log
powershell -File start-daemon.ps1
```

Environment variables (all optional):

| Variable | Default | Purpose |
|----------|---------|---------|
| `SWITCHBOARD_PORT` | `9876` | Daemon HTTP port |
| `SWITCHBOARD_DB` | `C:/Users/ATone/.claude/switchboard.db` | SQLite file path |

### Auto-start on login (Windows scheduled task)

```powershell
powershell -File install-task.ps1
```

Registers the scheduled task `Switchboard MCP Daemon`, which runs `start-daemon.ps1` at user logon.

## Wire up Claude Code

1. Add the MCP server to your workspace's `.mcp.json`:

    ```json
    {
      "mcpServers": {
        "switchboard": {
          "type": "http",
          "url": "http://127.0.0.1:9876/mcp"
        }
      }
    }
    ```

2. Merge `client-hooks.example.json` into your workspace's `.claude/settings.local.json`:

    ```json
    {
      "hooks": {
        "SessionStart": [ /* ...from example... */ ],
        "Stop":         [ /* ...from example... */ ]
      }
    }
    ```

    - `SessionStart` injects the cc_session_id into `additionalContext` so Claude can claim an alias on its first turn.
    - `Stop` launches `poller-shim.ps1`, which long-polls the daemon in the background and `exit 2`s (asyncRewake) when a message arrives.

3. In Claude Code, `/hooks` to reload — or restart the session.

### Getting Claude to register

The `SessionStart` hook injects context telling Claude *how* to register, but Claude still needs a nudge to actually do it (and to decide on a role name). Two options:

**Ad hoc** — just say it in your first message:

> Please register with switchboard as `my-role-name`.

Claude will see the injected `cc_session_id` from the hook and call `mcp__switchboard__register(role='my-role-name', cc_session_id=...)`.

**Persistent** — add to your workspace's `CLAUDE.md` (or the user-global one):

```markdown
## Switchboard

On your first turn in this workspace, register with switchboard using the
cc_session_id from the SessionStart additionalContext:

    mcp__switchboard__register(role='<role-name>', cc_session_id='<cc_session_id>')

Pick a role name that describes what this session is doing (e.g. `tools`,
`docs`, `bug-triage`). If the role is taken, try a variant. Skipping
registration leaves the session anonymous and unreachable from other
sessions — fine if you don't want messages.
```

Without `register`, the session stays anonymous; `send` and `broadcast` cannot reach it, and the Stop-hook shim exits immediately on every turn (nothing to poll for).

## MCP tools

Each tool takes JSON arguments; responses are JSON inside a `content[0].text` text block.

| Tool | Arguments | Returns |
|------|-----------|---------|
| `register` | `role?`, `cc_session_id?` | `{session_id, alias, anonymous}` |
| `set_alias` | `alias` | `{old_alias, new_alias}` |
| `send` | `to`, `message` | `{message_id, delivered_notification}` |
| `broadcast` | `message` | `{broadcast_id, recipient_count, notified_count}` |
| `read_messages` | — | `{messages: [...]}` |
| `list_sessions` | — | `[{session_id, alias, online, created_at, last_activity}, ...]` |
| `recall` | `message_id` | `{recalled_count}` |

`to` accepts either an alias or a session UUID. `delivered_notification` is true when the recipient has either a live `/poll` long-poll *or* an active `/monitor` subscription — the in-memory polling set covers both wake paths. It's an honest *"the recipient will notice this without user intervention"* signal, not just *"the bytes hit the socket."*

## HTTP endpoints

- `POST /mcp`, `GET /mcp`, `DELETE /mcp` — MCP Streamable HTTP transport
- `GET /poll?cc_session_id=<uuid>&timeout_s=<1..250>` — long-poll for unread mail. Returns JSON:
  - `{status: "unread", count, alias, message}` — Stop-hook shim exits 2
  - `{status: "timeout"}` — shim re-dials
  - `{status: "no-session"}` — alias is gone; shim exits 0
- `GET /monitor?cc_session_id=<uuid>` — persistent chunked text stream for Claude Code's `Monitor` tool. One line per event:
  - `hello <alias>` — baseline, emitted once on connect when inbox is empty
  - `inbox <N> <alias>` — unread waiting (on connect) or a new `send`/`broadcast` arrived
  - `heartbeat <iso-ts>` — emitted every 240s of silence so Bun's `idleTimeout` doesn't cut the stream

Bun's `idleTimeout` caps individual `/poll` waits at ~250s, so shims loop. `/monitor` stays open for the life of the session; clients should wrap `curl -sN` in a reconnect loop so a daemon restart self-heals.

## Wake paths — which one, when?

Both `/poll` and `/monitor` end at the same place (the `UnreadWaiterRegistry` inside the daemon), so either delivers messages reliably. They differ in transport, lifetime, and failure mode:

|                         | `/poll` + Stop-hook shim               | `/monitor` + Monitor tool                |
|-------------------------|----------------------------------------|------------------------------------------|
| Trigger                 | Every `Stop` hook (one per turn)       | Each new stream line fires a turn        |
| Connection              | Fresh long-poll each turn              | One persistent chunked connection        |
| Reconnect on daemon bounce | Automatic on next turn              | Handled by client wrapper (`while :; do curl -N …; sleep 5; done`) |
| Works when session is idle with no user input | Yes, but relies on `asyncRewake`, which has been observed to degrade in long-lived sessions | Yes; each stdout line is an independent `Monitor` event |
| Anonymous sessions      | Not wakeable (no cc_session_id to match) | Not wakeable (same constraint)         |

The two paths are **complementary, not exclusive** — you can run both at the same time (read paths are idempotent). The recommendation is: keep the Stop-hook shim as a fallback, and add `/monitor` for any session that needs to stay reachable for hours without a turn.

### Subscribing from a Claude Code session

In the session you want to keep reachable, start the `Monitor` tool after `register`:

```
Monitor({
  description: 'switchboard inbox for <my-alias>',
  persistent: true,
  command: 'while :; do curl -sN "http://127.0.0.1:9876/monitor?cc_session_id=<cc_session_id>" || true; sleep 5; done',
})
```

The `while … sleep 5` wrapper auto-reconnects if the daemon restarts or the TCP connection blips. Advanced subscribers can `grep --line-buffered "^inbox "` to suppress `hello`/`heartbeat` noise once the stream is known to be healthy.

Trigger rules worth internalising:
- A direct `send(to=you)` wakes you.
- A `broadcast` that includes you (every non-released session except the sender) wakes you.
- *Your own* `send` / `broadcast` does **not** wake you — the sender is excluded on the server side.
- Other sessions' 1-to-1 traffic never leaks onto your stream.

The `hook-session-start.ts` `SessionStart` hook already teaches new sessions this snippet, so fresh workspaces pick up the wake path without extra setup.

## Phase 2.5: per-session identity

The `SessionStart` hook injects the Claude Code session id into each session, and Claude passes it to `register(role, cc_session_id)`. This:

- Makes registration idempotent per cc_session_id — reconnecting the same Claude Code process reactivates the same row.
- Lets the Stop-hook shim identify "my session" by cc_session_id when long-polling.
- Works without any static configuration file.

Without `cc_session_id`, registration still succeeds (Phase 1 fallback) but every call creates a fresh row.

## Retention & cleanup

- Messages marked read are deleted after 7 days.
- Sessions that look orphaned — no active MCP connection *and* no activity for 5+ minutes — are released on the next retention tick (every minute), freeing their aliases.
- The Stop-hook shim self-terminates when its Claude Code parent dies, so no orphan poller outlives its session. Transient daemon errors (restart, TCP blip, 5xx) back off and retry rather than exiting, so a brief outage does not leave the session unreachable until the next Claude Code turn. The legacy `bun poller.ts` fallback does the same parent-pid check via `process.kill(ppid, 0)`.

## Security

- Binds `127.0.0.1` only — no listener on any public interface.
- **No authentication.** Do not expose this port on a LAN; anyone who can reach `127.0.0.1:9876` can send, read, and recall messages under any alias.
- Content is stored in plaintext; treat `switchboard.db` as private.

## Development

```powershell
bun test                 # full suite
bun test tests/db.test.ts
bun test tests/integration.test.ts
bunx tsc --noEmit        # type check
```

### Project layout

```
main.ts                  # daemon entry
server.ts                # MCP tool handlers + /poll + /monitor + Bun.serve wiring
db.ts                    # SQLite helpers (sessions, messages, retention queries)
schema.sql               # DB schema with Phase 2.5 columns
connections.ts           # in-memory ConnectionRegistry for push callbacks
waiters.ts               # UnreadWaiterRegistry — shared by /poll and /monitor
retention.ts             # periodic expired-message + stale-session cleanup
aliases.ts               # alias collision handling + target resolution
poller.ts                # legacy bun-based Stop-hook poller (fallback)
poller-shim.ps1          # PowerShell Stop-hook shim (default)
hook-session-start.ts    # SessionStart hook that injects cc_session_id
install-task.ps1         # registers the Windows scheduled task
start-daemon.ps1         # launches the daemon detached in the background
tests/                   # bun:test suites
```

## License

[MIT](LICENSE) © 2026 Kueh Tîng-kin (ATone)
