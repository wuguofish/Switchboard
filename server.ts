/**
 * server.ts — Switchboard MCP Server bootstrap
 *
 * Uses Bun.serve() + WebStandardStreamableHTTPServerTransport (Bun/Deno/CF Workers variant).
 * Each distinct MCP session gets its own Server + Transport pair, created on the
 * first (initialize) POST request. Subsequent requests for the same Mcp-Session-Id
 * are routed to the existing transport via the sessionMap.
 *
 * Per-session switchboard state (switchboardSessionId) is captured in a closure
 * so tool handlers always know which switchboard session they belong to.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js'
import type { Database } from 'bun:sqlite'
import { openDatabase, createSession, findSessionById, findSessionByAlias, findSessionByCcSessionId, findAnySessionByCcSessionId, updateLastActivity, releaseSession, reactivateSession, insertMessage, insertBroadcast, fetchUnreadForRecipient, markMessagesRead, listAllSessions, recallMessage, countUnreadBySessionId } from './db'
import { ConnectionRegistry } from './connections'
import { setAliasWithCollisionCheck, resolveTarget } from './aliases'
import { toTaipeiISOString } from './time'
import { startRetentionLoop } from './retention'
import { UnreadWaiterRegistry } from './waiters'

export interface ServerHandle {
  stop(): Promise<void>
}

interface SessionEntry {
  transport: WebStandardStreamableHTTPServerTransport
  mcpServer: Server
}

export async function startServer(opts: {
  port: number
  dbPath: string
}): Promise<ServerHandle> {
  const db: Database = openDatabase(opts.dbPath)
  const registry = new ConnectionRegistry()
  const retention = startRetentionLoop(db, registry)
  const waiters = new UnreadWaiterRegistry()

  // "recipient can be auto-woken" — true iff a curl shim is currently
  // long-polling /poll for this cc_session_id. A shim in /poll guarantees
  // the daemon will push the message the moment insertMessage completes.
  //
  // Previously this also fell back to poller.ts's state-file check
  // (legacy bun-based poller). That was removed because: (1) the shim
  // doesn't write state files, so on a stale file the pid may have been
  // reused by an unrelated process, yielding false positives; (2) the
  // in-memory polling set is the truthful signal.
  const canAutoWake = (ccSessionId: string | null | undefined): boolean => {
    if (!ccSessionId) return false
    return waiters.isPolling(ccSessionId)
  }

  // Map: MCP session ID (from Mcp-Session-Id header) → session entry
  const sessionMap = new Map<string, SessionEntry>()

  // Map: MCP session ID → switchboard session ID. Populated in register(),
  // cleared in transport.onclose. Lets the HTTP fetch handler refresh
  // last_activity on any incoming request (including SSE reconnects),
  // which keeps genuinely-connected-but-idle sessions out of the
  // retention loop's stale-cleanup sweep.
  const mcpSessionToSwitchboard = new Map<string, string>()

  /**
   * Creates a new Server + Transport pair for a fresh MCP session.
   * The per-switchboard session ID is captured in a closure.
   */
  function createMcpSession(): WebStandardStreamableHTTPServerTransport {
    // Current switchboard session ID for this MCP session (set by register tool)
    let currentSwitchboardId: string | null = null

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (mcpSessionId) => {
        // Store this entry in the map now that we know the session ID
        sessionMap.set(mcpSessionId, { transport, mcpServer })
      },
    })

    // Wire cleanup when the transport closes
    transport.onclose = () => {
      const mcpSessionId = transport.sessionId
      if (mcpSessionId) {
        sessionMap.delete(mcpSessionId)
        mcpSessionToSwitchboard.delete(mcpSessionId)
      }
      if (currentSwitchboardId) {
        releaseSession(db, currentSwitchboardId)
        registry.unregister(currentSwitchboardId)
      }
    }

    const mcpServer = new Server(
      { name: 'switchboard', version: '0.1.0' },
      { capabilities: { tools: {} } }
    )

    // --- List tools ---
    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'register',
          description:
            'Create a switchboard session for this MCP connection. ' +
            'Optionally supply a role name as your alias. ' +
            'Supply cc_session_id (Claude Code session id, from SessionStart hook ' +
            'additionalContext) to bind this switchboard session to a specific ' +
            'Claude Code session — subsequent register calls with the same ' +
            'cc_session_id update the existing row instead of creating a new one.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              role: {
                type: 'string',
                description: 'Optional alias / role name for this session.',
              },
              cc_session_id: {
                type: 'string',
                description: 'Optional Claude Code session id (from hook additionalContext). When provided, register becomes idempotent: same cc_session_id returns / updates the same switchboard session row.',
              },
            },
            required: [],
          },
        },
        {
          name: 'set_alias',
          description:
            'Rename the current switchboard session. Requires a prior register() call.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              alias: {
                type: 'string',
                description: 'New alias for this session.',
              },
            },
            required: ['alias'],
          },
        },
        {
          name: 'send',
          description: '1-to-1 message. `to` can be alias or session UUID.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              to: { type: 'string' },
              message: { type: 'string' },
            },
            required: ['to', 'message'],
          },
        },
        {
          name: 'broadcast',
          description: 'Send to all currently registered sessions (except self).',
          inputSchema: {
            type: 'object' as const,
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
        },
        {
          name: 'read_messages',
          description: 'Fetch and mark-as-read all unread messages for this session.',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'list_sessions',
          description: 'List all registered sessions with online status.',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'recall',
          description: 'Recall a message you sent. For broadcast, recalls all copies.',
          inputSchema: {
            type: 'object' as const,
            properties: { message_id: { type: 'string' } },
            required: ['message_id'],
          },
        },
      ],
    }))

    // --- Call tool ---
    mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params

      if (name === 'register') {
        const argsObj = (args as Record<string, unknown>) ?? {}
        const role = (argsObj.role as string | undefined) ?? null
        const cc_session_id = (argsObj.cc_session_id as string | undefined) ?? null

        let sessionId: string

        if (cc_session_id) {
          // Phase 2.5 path: idempotent by cc_session_id.
          // Use findAnySessionByCcSessionId to also find released rows so a
          // reconnecting session can reactivate its original row.
          const existing = findAnySessionByCcSessionId(db, cc_session_id)
          if (existing) {
            sessionId = existing.id
            const isReleased = existing.released_at != null
            if (isReleased) {
              // Row was released on disconnect — reactivate it with the requested alias.
              // Check for alias collision against other currently-active rows.
              const targetAlias = role ?? existing.alias
              if (targetAlias !== null) {
                const conflict = findSessionByAlias(db, targetAlias)
                if (conflict && conflict.id !== sessionId) {
                  throw new Error(`alias already taken: ${targetAlias}`)
                }
              }
              reactivateSession(db, sessionId, targetAlias)
            } else if (role !== null && role !== existing.alias) {
              // Active row — treat as a rename; throws AliasCollisionError if taken
              setAliasWithCollisionCheck(db, sessionId, role)
            }
            updateLastActivity(db, sessionId)
          } else {
            // New session: validate role collision before insert
            if (role !== null) {
              const conflict = findSessionByAlias(db, role)
              if (conflict) {
                throw new Error(`alias already taken: ${role}`)
              }
            }
            sessionId = createSession(db, { alias: role, cc_session_id })
          }
        } else {
          // Phase 1 fallback path: no cc_session_id means every call is a fresh session
          if (role !== null) {
            const conflict = findSessionByAlias(db, role)
            if (conflict) {
              throw new Error(`alias already taken: ${role}`)
            }
          }
          sessionId = createSession(db, { alias: role, cc_session_id: null })
        }

        currentSwitchboardId = sessionId
        if (transport.sessionId) {
          mcpSessionToSwitchboard.set(transport.sessionId, sessionId)
        }

        registry.register(sessionId, (payload) => {
          mcpServer
            .notification({
              method: 'notifications/switchboard/new_message',
              params: payload as Record<string, unknown>,
            })
            .catch(() => {
              // Notification rejected — transport is likely dead but onclose
              // may not have fired (TCP reset / SSE break without DELETE).
              // Drop the leaked registry entry so list_sessions stops
              // reporting this session as online; retention will release
              // the DB row on its next tick.
              registry.unregister(sessionId)
            })
        })

        const finalAlias =
          cc_session_id && role === null
            ? findSessionById(db, sessionId)?.alias ?? null
            : role
        const anonymous = finalAlias === null
        const responseBody: Record<string, unknown> = {
          session_id: sessionId,
          alias: finalAlias,
          anonymous,
        }
        if (anonymous) {
          responseBody.hint =
            'You are anonymous. Call set_alias(role) to give yourself a name.'
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(responseBody) }],
        }
      }

      if (name === 'set_alias') {
        if (!currentSwitchboardId) {
          throw new Error('session not registered; call register() first')
        }
        const alias = (args as Record<string, unknown>)?.alias as string
        if (!alias) {
          throw new Error('alias is required')
        }

        // Look up current alias before changing
        const session = findSessionById(db, currentSwitchboardId)
        const oldAlias = session?.alias ?? null

        // Will throw AliasCollisionError if taken by another session
        setAliasWithCollisionCheck(db, currentSwitchboardId, alias)

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ old_alias: oldAlias, new_alias: alias }),
            },
          ],
        }
      }

      if (name === 'send') {
        if (!currentSwitchboardId) throw new Error('session not registered; call register() first')
        const to = (args as Record<string, unknown>)?.to as string
        const message = (args as Record<string, unknown>)?.message as string
        const targetId = resolveTarget(db, to)  // throws UnknownTargetError if not found
        const sender = findSessionById(db, currentSwitchboardId)
        const message_id = insertMessage(db, {
          sender_id: currentSwitchboardId,
          recipient_id: targetId,
          broadcast_id: null,
          content: message,
        })
        const pushed = registry.pushNotification(targetId, {
          sender_alias: sender?.alias ?? null,
          sender_id: currentSwitchboardId,
          is_broadcast: false,
        })
        // Wake any long-poll waiter for this recipient so the curl shim
        // returns immediately with SWITCHBOARD INBOX. Safe to call even if
        // no waiter exists.
        waiters.notify(targetId)
        // delivered_notification promises "the recipient will notice this
        // without user intervention" — that requires a live transport
        // (pushed) and a live auto-wake path (bun poller state file OR an
        // active curl long-poll). Anonymous / Phase 1 recipients with no
        // cc_session_id always get false — the honest answer.
        const recipient = findSessionById(db, targetId)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              message_id,
              delivered_notification: pushed && canAutoWake(recipient?.cc_session_id),
            }),
          }],
        }
      }

      if (name === 'broadcast') {
        if (!currentSwitchboardId) throw new Error('session not registered; call register() first')
        const message = (args as Record<string, unknown>)?.message as string
        const sender = findSessionById(db, currentSwitchboardId)
        const { broadcast_id, recipient_count, recipient_ids } = insertBroadcast(db, {
          sender_id: currentSwitchboardId,
          content: message,
        })
        // Wake every long-poll waiter that just got a new message row.
        waiters.notifyMany(recipient_ids)
        const onlineIds = registry.listOnline().filter(id => id !== currentSwitchboardId)
        let notified_count = 0
        for (const id of onlineIds) {
          const pushed = registry.pushNotification(id, {
            sender_alias: sender?.alias ?? null,
            sender_id: currentSwitchboardId,
            is_broadcast: true,
          })
          const recipient = findSessionById(db, id)
          if (pushed && canAutoWake(recipient?.cc_session_id)) notified_count++
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ broadcast_id, recipient_count, notified_count }),
          }],
        }
      }

      if (name === 'read_messages') {
        if (!currentSwitchboardId) throw new Error('session not registered; call register() first')
        const unread = fetchUnreadForRecipient(db, currentSwitchboardId)
        markMessagesRead(db, unread.map(m => m.id))
        const messages = unread.map(m => {
          const senderRow = findSessionById(db, m.sender_id)
          return {
            id: m.id,
            sender_id: m.sender_id,
            sender_alias: senderRow?.alias ?? null,
            content: m.content,
            created_at: toTaipeiISOString(m.created_at),
            is_broadcast: m.broadcast_id !== null,
          }
        })
        return {
          content: [{ type: 'text', text: JSON.stringify({ messages }) }],
        }
      }

      if (name === 'list_sessions') {
        const all = listAllSessions(db)
        const result = all.map(s => ({
          session_id: s.id,
          alias: s.alias,
          online: registry.isOnline(s.id),
          created_at: toTaipeiISOString(s.created_at),
          last_activity: toTaipeiISOString(s.last_activity),
        }))
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        }
      }

      if (name === 'recall') {
        if (!currentSwitchboardId) throw new Error('session not registered')
        const message_id = (args as Record<string, unknown>)?.message_id as string
        const recalled_count = recallMessage(db, { message_id, caller_id: currentSwitchboardId })
        return {
          content: [{ type: 'text', text: JSON.stringify({ recalled_count }) }],
        }
      }

      throw new Error(`unknown tool: ${name}`)
    })

    // Connect server to transport (starts listening for messages)
    mcpServer.connect(transport).catch((err) => {
      process.stderr.write(`switchboard: mcpServer.connect error: ${err}\n`)
    })

    return transport
  }

  /**
   * GET /poll?cc_session_id=X&timeout_s=N
   *
   * Long-poll endpoint for Stop-hook shim scripts. Replaces bun poller.ts —
   * the shim calls this and blocks on the daemon instead of running its own
   * JS runtime. Returns JSON describing the result:
   *   { status: "unread",    count, alias, message }  -> shim exits 2
   *   { status: "timeout"   }                         -> shim loops or exits 0
   *   { status: "no-session" }                        -> shim exits 0
   *
   * Bun.serve idleTimeout caps per-request wait at ~255s, so shim callers
   * should use timeout_s <= 240 and loop themselves; on timeout they can
   * check their own parent-alive signal before re-dialing.
   */
  async function handlePoll(req: Request, url: URL): Promise<Response> {
    if (req.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 })
    }
    const ccSessionId = url.searchParams.get('cc_session_id')
    if (!ccSessionId) {
      return new Response('Missing cc_session_id', { status: 400 })
    }
    const timeoutRaw = url.searchParams.get('timeout_s') ?? '240'
    const parsed = parseInt(timeoutRaw, 10)
    const timeoutS = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 240, 1), 250)

    const session = findSessionByCcSessionId(db, ccSessionId)
    if (!session || !session.alias) {
      return Response.json({ status: 'no-session' })
    }

    // A live curl long-poll counts as activity for retention purposes.
    updateLastActivity(db, session.id)

    const initial = countUnreadBySessionId(db, session.id)
    if (initial > 0) {
      return Response.json({
        status: 'unread',
        count: initial,
        alias: session.alias,
        message: `SWITCHBOARD INBOX: ${initial} unread message(s) for role "${session.alias}" — call mcp__switchboard__read_messages to retrieve`,
      })
    }

    await waiters.wait(session.id, ccSessionId, timeoutS * 1000, req.signal)
    // Re-check: the waiter may have resolved because of a new message, a
    // timeout, or a client abort. Only the first case yields status=unread.
    const final = countUnreadBySessionId(db, session.id)
    if (final > 0) {
      return Response.json({
        status: 'unread',
        count: final,
        alias: session.alias,
        message: `SWITCHBOARD INBOX: ${final} unread message(s) for role "${session.alias}" — call mcp__switchboard__read_messages to retrieve`,
      })
    }
    return Response.json({ status: 'timeout' })
  }

  /**
   * GET /monitor?cc_session_id=X
   *
   * Live chunked text stream for the Claude Code `Monitor` tool. The client
   * runs `curl -sN http://127.0.0.1:.../monitor?cc_session_id=...` as a
   * background monitor; each stdout line fires an assistant wake. Line grammar:
   *   hello <alias>            -> fired once on connect when inbox is empty
   *   inbox <n> <alias>        -> fired once on connect if already unread, and
   *                               every time a new message arrives for this cc
   *
   * Idle keep-alive: every 240s we write a single space byte (no newline)
   * so the TCP connection stays warm against Bun's 255s idleTimeout, but
   * Monitor — which is line-buffered — does not emit a notification. Once
   * every HEARTBEAT_LINE_EVERY (~32 min) we *do* emit a real
   * `heartbeat <iso-ts>` line, so subscribed sessions get an occasional
   * time tick to ground them in real time without being woken every 4 min.
   * Earlier versions emitted the line every 240s, which woke every
   * connected session every four minutes for nothing.
   *
   * Unlike /poll (one-shot long-poll that the shim loops), /monitor is
   * persistent — one HTTP connection for the lifetime of the session. The
   * side effect of calling waiters.wait() here is that `canAutoWake` sees
   * this cc_session_id as polling, so sender-side `delivered_notification`
   * stays honest.
   */
  async function handleMonitor(req: Request, url: URL): Promise<Response> {
    if (req.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 })
    }
    const ccSessionId = url.searchParams.get('cc_session_id')
    if (!ccSessionId) {
      return new Response('Missing cc_session_id\n', { status: 400 })
    }
    const session = findSessionByCcSessionId(db, ccSessionId)
    if (!session || !session.alias) {
      // Returning 404 with a JSON body keeps shape consistent with /poll's
      // "no-session" result, so clients can treat both endpoints the same.
      return Response.json({ status: 'no-session' }, { status: 404 })
    }

    const sessionId = session.id
    const alias = session.alias
    const encoder = new TextEncoder()

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (line: string): boolean => {
          try {
            controller.enqueue(encoder.encode(line + '\n'))
            return true
          } catch { return false }
        }
        // Single byte, no newline — keeps the socket warm without emitting
        // a Monitor-tool line (subscribers stay asleep).
        const writeKeepalive = (): boolean => {
          try {
            controller.enqueue(encoder.encode(' '))
            return true
          } catch { return false }
        }

        // Opening the stream counts as activity; retention should not sweep us.
        updateLastActivity(db, sessionId)

        // Catch up immediately: if inbox already has unread rows, emit one
        // "inbox N" line so the subscriber wakes right away without going
        // through a separate /poll call.
        const initial = countUnreadBySessionId(db, sessionId)
        if (initial > 0) {
          write(`inbox ${initial} ${alias}`)
        } else {
          write(`hello ${alias}`)
        }

        // Event loop: block on waiter, emit one line on real activity,
        // re-subscribe. On waiter timeout (no new messages within
        // HEARTBEAT_MS) write a silent keep-alive byte so Bun's idleTimeout
        // doesn't cut us and idle subscribers don't wake. Every
        // HEARTBEAT_LINE_EVERY ticks (~32 min) emit a visible heartbeat
        // line instead, so subscribed sessions get an occasional ground-truth
        // timestamp without being pinged every 4 min.
        const HEARTBEAT_MS = 240_000
        const HEARTBEAT_LINE_EVERY = 8
        let silentTicks = 0
        while (!req.signal.aborted) {
          await waiters.wait(sessionId, ccSessionId, HEARTBEAT_MS, req.signal)
          if (req.signal.aborted) break
          const count = countUnreadBySessionId(db, sessionId)
          let ok: boolean
          if (count > 0) {
            ok = write(`inbox ${count} ${alias}`)
            silentTicks = 0
          } else if (++silentTicks >= HEARTBEAT_LINE_EVERY) {
            ok = write(`heartbeat ${new Date().toISOString()}`)
            silentTicks = 0
          } else {
            ok = writeKeepalive()
          }
          if (!ok) break
          updateLastActivity(db, sessionId)
        }
        try { controller.close() } catch {}
      },
      cancel() {
        // client abort — nothing to clean up beyond the waiter (wait()
        // already registered the AbortSignal, so it releases itself).
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-cache, no-store, must-revalidate',
        'x-accel-buffering': 'no',
      },
    })
  }

  // --- Bun HTTP server ---
  const bunServer = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port,
    // MCP Streamable HTTP uses long-lived SSE streams (GET /mcp) that stay open
    // waiting for server-side notifications. Bun's default 10s idle timeout
    // would kill them and make clients reconnect-loop. 255 = max allowed.
    idleTimeout: 255,

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)

      if (url.pathname === '/poll') {
        return handlePoll(req, url)
      }

      if (url.pathname === '/monitor') {
        return handleMonitor(req, url)
      }

      if (url.pathname !== '/mcp') {
        return new Response('Not Found', { status: 404 })
      }

      // Only handle POST, GET, DELETE for /mcp
      if (
        req.method !== 'POST' &&
        req.method !== 'GET' &&
        req.method !== 'DELETE'
      ) {
        return new Response('Method Not Allowed', { status: 405 })
      }

      const mcpSessionId = req.headers.get('mcp-session-id')

      // Liveness signal: any request on an already-registered MCP session
      // (POST for tool calls, GET for SSE reconnects, DELETE for shutdown)
      // counts as activity. Refresh last_activity so retention's stale-cleanup
      // sweep treats truly-connected-but-idle sessions as alive.
      if (mcpSessionId) {
        const switchboardId = mcpSessionToSwitchboard.get(mcpSessionId)
        if (switchboardId) {
          updateLastActivity(db, switchboardId)
        }
      }

      if (req.method === 'POST') {
        // Need to inspect body to decide if this is an initialize request
        let bodyText: string
        let body: unknown
        try {
          bodyText = await req.text()
          body = JSON.parse(bodyText)
        } catch {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32700, message: 'Parse error: Invalid JSON' },
              id: null,
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        }

        // Check if this is an initialize request (no session ID expected)
        const isInit = Array.isArray(body)
          ? body.some(isInitializeRequest)
          : isInitializeRequest(body)

        if (isInit && !mcpSessionId) {
          // New MCP session: create transport + server
          const transport = createMcpSession()

          // Reconstruct a new Request with the body since we consumed it
          const newReq = new Request(req.url, {
            method: req.method,
            headers: req.headers,
            body: bodyText,
          })

          return transport.handleRequest(newReq, { parsedBody: body })
        }

        // Existing session: route to existing transport
        if (mcpSessionId) {
          const entry = sessionMap.get(mcpSessionId)
          if (!entry) {
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32001, message: 'Session not found' },
                id: null,
              }),
              {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
              }
            )
          }

          const newReq = new Request(req.url, {
            method: req.method,
            headers: req.headers,
            body: bodyText,
          })
          return entry.transport.handleRequest(newReq, { parsedBody: body })
        }

        // POST with no session ID and not an init request — reject
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: Mcp-Session-Id header is required',
            },
            id: null,
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      }

      // GET and DELETE require an existing session
      if (mcpSessionId) {
        const entry = sessionMap.get(mcpSessionId)
        if (!entry) {
          return new Response('Session Not Found', { status: 404 })
        }
        return entry.transport.handleRequest(req)
      }

      return new Response('Bad Request: missing Mcp-Session-Id', {
        status: 400,
      })
    },
  })

  return {
    async stop(): Promise<void> {
      // Stop retention loop first (before closing DB)
      retention.stop()

      // Release any /poll long-polls so their handlers return promptly.
      waiters.cancelAll()

      // Close all open transports
      const closePromises: Promise<void>[] = []
      for (const [, entry] of sessionMap) {
        closePromises.push(entry.transport.close())
      }
      await Promise.allSettled(closePromises)
      sessionMap.clear()

      // Stop accepting new connections
      bunServer.stop(true)

      // Close the SQLite DB
      db.close()
    },
  }
}
