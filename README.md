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
| `SWITCHBOARD_DB` | `<homedir>/.claude/switchboard.db` | SQLite file path |
| `SWITCHBOARD_POLLER_STATE_DIR` | `<homedir>/.claude` | Directory for poller state/lock files |

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
| `broadcast` | `message`, `scope?` | `{broadcast_id, recipient_count, notified_count}` |
| `read_messages` | — | `{messages: [...]}` |
| `list_sessions` | — | `[{session_id, alias, online, created_at, last_activity}, ...]` |
| `recall` | `message_id` | `{recalled_count}` |
| `unregister` | — | `{status, released_alias}` — `status` is `released`, `stale_ignored` (a newer generation re-registered this identity; nothing was released), or `already_offline` |

`to` accepts either an alias or a session UUID. `delivered_notification` is true when the message was pushed over a live MCP connection *or* the recipient is online per the lease/polling predicate below. It's an honest *"the recipient will notice this without user intervention"* signal, not just *"the bytes hit the socket."*

`broadcast` accepts an optional `scope` (default `all`, preserving legacy calls):

- `all` — every active session except the sender
- `same_kind` — sessions sharing the sender's `client_kind`, across cwds
- `same_cwd` — sessions sharing the sender's registered `cwd`, across kinds; if either side's cwd is NULL there is no match

Codex-kind recipients are only written to when they are online at insert time — offline Codex peers accumulate **no** broadcast backlog. Claude Code and external recipients keep durable offline mailboxes. `recipient_count` and `notified_count` are both derived from the same filtered recipient set.

## HTTP endpoints

- `POST /mcp`, `GET /mcp`, `DELETE /mcp` — MCP Streamable HTTP transport
- `POST /external/send` — local non-MCP send endpoint for programs such as
  codex-bridge to notify Claude Code when a background job finishes. JSON body:
  `{ "to": "<alias-or-session-id>", "message": "...", "from": "codex" }`.
  `from` is optional and defaults to `codex`. Returns
  `{message_id, delivered_notification}`.
- `POST /register` — HTTP registration for peers that hold no MCP connection
  (e.g. the codex-bridge waker). JSON body:
  `{ "alias": "...", "client_kind": "claude_code"|"codex"|"external", "client_session_id": "<stable-instance-id>", "cwd": "/abs/path" }`.
  Idempotent upsert keyed on `(client_kind, client_session_id)`; re-registering
  reactivates the row and bumps its generation. Returns
  `{session_id, alias, generation}`; 400 on validation errors, 409 on alias
  collision.
  Optional `owner_token` opts into ownership CAS: acquiring an ownerless
  identity or taking over an expired owner lease bumps the generation, a
  same-owner call is a lease renewal that keeps its generation, and a second
  owner is rejected with `409 {code: "owner_conflict"}` while the current
  owner's lease is alive. Token-less registers keep last-register-wins
  semantics and clear any stored owner token.
- `POST /unregister` — graceful peer sign-off. JSON body:
  `{ "client_kind": ..., "client_session_id": ..., "generation": <int> }`.
  The generation must match the current row — a delayed unregister from an
  older instance cannot release a newer one (409). Returns
  `{status: "released" | "already_released"}`, 404 when unknown. With an
  `owner_token`, 409 bodies carry `code: "stale_generation"` or
  `code: "owner_mismatch"` so clients can tell the two apart.
- `POST /messages/read` — authenticated peer inbox read. JSON body:
  `{ "client_kind": ..., "client_session_id": ..., "generation": <int> }`.
  The identity must resolve to an active session and the generation must match.
  Returns `{messages: [...]}` with the same fields and Asia/Taipei timestamps as
  MCP `read_messages`, and marks the returned messages read.
  Validation errors return 400, unknown or released identities return 404, and
  stale generations return 409. With an `owner_token`, 409 bodies carry
  `code: "stale_generation"` or `code: "owner_mismatch"` — clients must treat
  these as "stop waking", never as "endpoint unavailable".
- `GET /poll?client_kind=<kind>&client_session_id=<id>&timeout_s=<1..250>` —
  canonical long-poll for unread mail. Every call also renews the caller's
  lease (`last_seen_at`). The legacy form `?cc_session_id=<uuid>` remains
  supported as an alias for `client_kind=claude_code`. Optional
  `&owner_token=<t>&generation=<g>` (must appear together) makes the poll
  owner-aware: mismatches return the same 409 bodies as `/messages/read`,
  ownership is re-checked after the long wait, and the owner lease
  (`owner_seen_at`) is renewed alongside the poll lease. Returns JSON:
  - `{status: "unread", count, alias, message}` — Stop-hook shim exits 2
  - `{status: "timeout"}` — shim re-dials
  - `{status: "no-session"}` — alias is gone; shim exits 0
- `GET /monitor?cc_session_id=<uuid>` — persistent chunked text stream for Claude Code's `Monitor` tool. One line per event:
  - `hello <alias>` — baseline, emitted once on connect when inbox is empty
  - `inbox <N> <alias>` — unread waiting (on connect) or a new `send`/`broadcast` arrived
  - `heartbeat <iso-ts>` — emitted every ~2 hr of silence as a visible time tick (a silent space byte goes out every 240s to keep Bun's `idleTimeout` from cutting the stream)

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
- A `broadcast` wakes you only when its selected scope includes your session.
- *Your own* `send` / `broadcast` does **not** wake you — the sender is excluded on the server side.
- Other sessions' 1-to-1 traffic never leaks onto your stream.

The `hook-session-start.ts` `SessionStart` hook already teaches new sessions this snippet, so fresh workspaces pick up the wake path without extra setup.

## Phase 2.5: per-session identity

The `SessionStart` hook injects the Claude Code session id into each session, and Claude passes it to `register(role, cc_session_id)`. This:

- Makes registration idempotent per cc_session_id — reconnecting the same Claude Code process reactivates the same row.
- Lets the Stop-hook shim identify "my session" by cc_session_id when long-polling.
- Works without any static configuration file.

Without `cc_session_id`, registration still succeeds (Phase 1 fallback) but every call creates a fresh row.

## Bidirectional peers: identity, generation, lease

Sessions are generalized beyond Claude Code:

- **`client_kind`** namespaces identities: `claude_code`, `codex`, `external`.
  The unique-identity index is `(client_kind, client_session_id)`, so a Codex
  instance id can never collide with a Claude Code session id.
- **Stable identity, not thread identity.** A peer's `client_session_id` is a
  durable instance UUID (for the Codex waker it persists in
  `~/.codex/waker-instance-id`). Conversation thread ids are client-side state
  and never enter the database.
- **Generation guard.** Acquiring an identity bumps the row's generation —
  legacy re-registers, first ownership grabs, and expired-lease takeovers all
  count; the one exception is a same-`owner_token` renewal, which keeps its
  generation. All
  release paths — HTTP `/unregister`, the MCP `unregister` tool, and MCP
  transport cleanup on disconnect — are generation-checked, so a stale
  instance's late sign-off can never evict the live one.
- **Lease-based online.** `online = live MCP connection OR an active
  /poll(/monitor) wait OR a valid lease`. Each `/poll` renews `last_seen_at`;
  the lease TTL is five minutes (one 250 s long-poll plus reconnect slack).
  Graceful exits unregister by generation; crashes simply let the lease
  expire. Message truth remains `read_at` — wakes are best-effort doorbells.

**Peer message reads:** `POST /messages/read` now gives non-MCP peers a
generation/identity-guarded way to fetch and mark their own unread messages.
It shares the MCP `read_messages` read-at semantics, so poll-driven clients can
consume the inbox without touching SQLite or retriggering on already-read mail.

## Retention & cleanup

- Messages marked read are deleted after 7 days.
- Sessions whose lease has been stale for over 24 hours — no MCP connection,
  no polling, no lease renewal — are released by the retention sweep (every
  2 hours), freeing their aliases. A crashed session that never fired
  `transport.onclose` can therefore hold its alias for up to ~26 hours; the
  same identity can always reclaim its row immediately via idempotent
  re-register.
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
server.ts                # MCP tools + peer lifecycle/read + /poll + /monitor + Bun.serve wiring
db.ts                    # SQLite helpers (sessions, messages, generation-aware upsert, retention queries)
schema.sql               # DB schema (client_kind / client_session_id / cwd / last_seen_at / generation / reply_to)
online.ts                # shared online predicate: MCP connection OR polling OR valid lease
connections.ts           # in-memory ConnectionRegistry for push callbacks
waiters.ts               # UnreadWaiterRegistry — kind-qualified, shared by /poll and /monitor
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

[MIT](LICENSE) © 2026 wuguofish
