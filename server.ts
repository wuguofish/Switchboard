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
import { openDatabase, createSession, findSessionById, findSessionByAlias, findSessionByCcSessionId, findSessionByClientSessionId, findAnySessionByClientSessionId, registerClientSession, unregisterClientSession, updateLastActivity, updateLastSeen, updateOwnerSeen, releaseSessionIfGeneration, insertMessage, insertBroadcast, fetchUnreadForRecipient, markMessagesRead, listAllSessions, recallMessage, countUnreadBySessionId, OwnershipConflictError } from './db'
import { ConnectionRegistry, type PushCallback } from './connections'
import { setAliasWithCollisionCheck, resolveTarget } from './aliases'
import { toTaipeiISOString } from './time'
import { startRetentionLoop } from './retention'
import { UnreadWaiterRegistry } from './waiters'
import type { BroadcastScope, ClientKind, SessionRow } from './types'
import { isSessionOnline } from './online'

export interface ServerHandle {
  stop(): Promise<void>
}

interface SessionEntry {
  transport: WebStandardStreamableHTTPServerTransport
  mcpServer: Server
}

const CLIENT_KINDS: readonly ClientKind[] = ['claude_code', 'codex', 'external']
const BROADCAST_SCOPES: readonly BroadcastScope[] = ['all', 'same_kind', 'same_cwd']

class RequestValidationError extends Error {}

function requireBroadcastScope(value: unknown): BroadcastScope {
  if (value === undefined) return 'all'
  if (
    typeof value !== 'string' ||
    !BROADCAST_SCOPES.includes(value as BroadcastScope)
  ) {
    throw new Error(`scope must be one of: ${BROADCAST_SCOPES.join(', ')}`)
  }
  return value as BroadcastScope
}

function matchesBroadcastScope(
  sender: SessionRow,
  recipient: SessionRow,
  scope: BroadcastScope,
): boolean {
  if (scope === 'all') return true
  if (scope === 'same_kind') {
    return recipient.client_kind === sender.client_kind
  }
  return (
    sender.cwd !== null &&
    recipient.cwd !== null &&
    recipient.cwd === sender.cwd
  )
}

function requireJsonObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new RequestValidationError('request body must be a JSON object')
  }
  return body as Record<string, unknown>
}

function requireNonEmptyString(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RequestValidationError(
      `${field} is required and must be a non-empty string`,
    )
  }
  return value.trim()
}

function requireClientKind(body: Record<string, unknown>): ClientKind {
  const value = body.client_kind
  if (typeof value !== 'string' || !CLIENT_KINDS.includes(value as ClientKind)) {
    throw new RequestValidationError(
      `client_kind must be one of: ${CLIENT_KINDS.join(', ')}`,
    )
  }
  return value as ClientKind
}

function requireGeneration(body: Record<string, unknown>): number {
  const value = body.generation
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RequestValidationError(
      'generation is required and must be a positive integer',
    )
  }
  return value as number
}

function optionalNonEmptyString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RequestValidationError(
      `${field} must be a non-empty string when provided`,
    )
  }
  return value.trim()
}

function ownershipMismatchResponse(
  session: SessionRow,
  generation: number,
  ownerToken: string,
): Response | null {
  if (session.generation !== generation) {
    return Response.json({
      code: 'stale_generation',
      error: `generation mismatch: current generation is ${session.generation}`,
      current_generation: session.generation,
    }, { status: 409 })
  }
  if (session.owner_token !== ownerToken) {
    return Response.json({
      code: 'owner_mismatch',
      error: 'owner token mismatch',
      current_generation: session.generation,
    }, { status: 409 })
  }
  return null
}

export async function startServer(opts: {
  port: number
  dbPath: string
  ownerLeaseTtlMs?: number
}): Promise<ServerHandle> {
  const db: Database = openDatabase(opts.dbPath)
  const registry = new ConnectionRegistry()
  const retention = startRetentionLoop(db, registry)
  const waiters = new UnreadWaiterRegistry()

  const getOrCreateExternalSender = (alias: string): string => {
    const existing = findSessionByAlias(db, alias)
    if (existing) {
      updateLastActivity(db, existing.id)
      return existing.id
    }
    return createSession(db, { alias, cc_session_id: null })
  }

  async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
    let parsed: unknown
    try {
      parsed = await req.json()
    } catch {
      throw new RequestValidationError('invalid JSON body')
    }
    return requireJsonObject(parsed)
  }

  function readUnreadMessages(sessionId: string) {
    const unread = fetchUnreadForRecipient(db, sessionId)
    markMessagesRead(db, unread.map(message => message.id))
    return unread.map(message => {
      const sender = findSessionById(db, message.sender_id)
      return {
        id: message.id,
        sender_id: message.sender_id,
        sender_alias: sender?.alias ?? null,
        reply_to: message.reply_to,
        content: message.content,
        created_at: toTaipeiISOString(message.created_at),
        is_broadcast: message.broadcast_id !== null,
      }
    })
  }

  async function handleRegister(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    try {
      const body = await parseJsonBody(req)
      const alias = requireNonEmptyString(body, 'alias')
      const client_kind = requireClientKind(body)
      const client_session_id = requireNonEmptyString(body, 'client_session_id')
      const cwd = requireNonEmptyString(body, 'cwd')
      const owner_token = optionalNonEmptyString(body, 'owner_token')
      const session = registerClientSession(db, {
        alias,
        client_kind,
        client_session_id,
        cwd,
        owner_token,
      }, { ownerLeaseTtlMs: opts.ownerLeaseTtlMs })
      return Response.json({
        session_id: session.id,
        alias: session.alias,
        generation: session.generation,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof RequestValidationError) {
        return Response.json({ error: message }, { status: 400 })
      }
      if (error instanceof OwnershipConflictError) {
        return Response.json({
          code: 'owner_conflict',
          error: error.message,
          current_generation: error.currentGeneration,
        }, { status: 409 })
      }
      if (message.startsWith('alias already taken:')) {
        return Response.json({ error: message }, { status: 409 })
      }
      return Response.json({ error: 'internal server error' }, { status: 500 })
    }
  }

  async function handleUnregister(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    try {
      const body = await parseJsonBody(req)
      const client_kind = requireClientKind(body)
      const client_session_id = requireNonEmptyString(body, 'client_session_id')
      const generation = requireGeneration(body)
      const owner_token = optionalNonEmptyString(body, 'owner_token')
      const result = unregisterClientSession(db, {
        client_kind,
        client_session_id,
        generation,
        owner_token,
      })

      if (result === 'not_found') {
        return Response.json({ error: 'session not found' }, { status: 404 })
      }
      if (result === 'generation_mismatch') {
        const current = findAnySessionByClientSessionId(
          db,
          client_kind,
          client_session_id,
        )
        const error = `generation mismatch: current generation is ${current?.generation ?? 'unknown'}`
        if (owner_token === undefined) {
          return Response.json({ error }, { status: 409 })
        }
        return Response.json({
          code: 'stale_generation',
          error,
          current_generation: current?.generation ?? null,
        }, { status: 409 })
      }
      if (result === 'owner_mismatch') {
        const current = findAnySessionByClientSessionId(
          db,
          client_kind,
          client_session_id,
        )
        return Response.json({
          code: 'owner_mismatch',
          error: 'owner token mismatch',
          current_generation: current?.generation ?? null,
        }, { status: 409 })
      }
      return Response.json({ status: result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof RequestValidationError) {
        return Response.json({ error: message }, { status: 400 })
      }
      return Response.json({ error: 'internal server error' }, { status: 500 })
    }
  }

  async function handleMessageRead(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    try {
      const body = await parseJsonBody(req)
      const client_kind = requireClientKind(body)
      const client_session_id = requireNonEmptyString(body, 'client_session_id')
      const generation = requireGeneration(body)
      const owner_token = optionalNonEmptyString(body, 'owner_token')
      const session = findSessionByClientSessionId(
        db,
        client_kind,
        client_session_id,
      )

      if (!session) {
        return Response.json({ error: 'session not found' }, { status: 404 })
      }
      if (session.generation !== generation) {
        const error = `generation mismatch: current generation is ${session.generation}`
        if (owner_token === undefined) {
          return Response.json({ error }, { status: 409 })
        }
        return Response.json(
          {
            code: 'stale_generation',
            error,
            current_generation: session.generation,
          },
          { status: 409 },
        )
      }
      if (owner_token !== undefined) {
        const mismatch = ownershipMismatchResponse(session, generation, owner_token)
        if (mismatch) return mismatch
      }
      return Response.json({ messages: readUnreadMessages(session.id) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof RequestValidationError) {
        return Response.json({ error: message }, { status: 400 })
      }
      return Response.json({ error: 'internal server error' }, { status: 500 })
    }
  }

  async function handleExternalSend(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 })
    }

    const to = typeof body.to === 'string' ? body.to.trim() : ''
    const message = typeof body.message === 'string' ? body.message : ''
    const from = typeof body.from === 'string' && body.from.trim()
      ? body.from.trim()
      : 'codex'

    if (!to) return Response.json({ error: 'to is required' }, { status: 400 })
    if (!message) return Response.json({ error: 'message is required' }, { status: 400 })

    try {
      const senderId = getOrCreateExternalSender(from)
      const targetId = resolveTarget(db, to)
      const message_id = insertMessage(db, {
        sender_id: senderId,
        recipient_id: targetId,
        broadcast_id: null,
        content: message,
      })
      const sender = findSessionById(db, senderId)
      const pushed = registry.pushNotification(targetId, {
        sender_alias: sender?.alias ?? null,
        sender_id: senderId,
        is_broadcast: false,
      })
      waiters.notify(targetId)
      const recipient = findSessionById(db, targetId)
      return Response.json({
        message_id,
        delivered_notification:
          pushed || (recipient ? isSessionOnline(recipient, registry, waiters) : false),
      })
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
    }
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
    let currentGeneration: number | null = null
    let currentPushCallback: PushCallback | null = null
    let currentOwnsLifecycle = true

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
        if (currentPushCallback) {
          registry.unregister(currentSwitchboardId, currentPushCallback)
        }
        if (currentOwnsLifecycle && currentGeneration !== null) {
          releaseSessionIfGeneration(db, currentSwitchboardId, currentGeneration)
        }
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
              client_kind: {
                type: 'string',
                enum: CLIENT_KINDS,
                description: 'Optional peer client kind to claim an existing HTTP-registered peer row. Must be supplied with client_session_id.',
              },
              client_session_id: {
                type: 'string',
                description: 'Optional peer client session id to claim an existing HTTP-registered peer row. Must be supplied with client_kind.',
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
          description: 'Broadcast to active sessions selected by scope (except self).',
          inputSchema: {
            type: 'object' as const,
            properties: {
              message: { type: 'string' },
              scope: {
                type: 'string',
                enum: BROADCAST_SCOPES,
                default: 'all',
                description:
                  'all: every active session; same_kind: sender client_kind; ' +
                  'same_cwd: equal non-NULL cwd.',
              },
            },
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
        {
          name: 'unregister',
          description:
            'Actively release this session from the switchboard. ' +
            'Clears the alias and marks the session as offline so other sessions ' +
            'can immediately reclaim the role name. The MCP transport stays alive — ' +
            'you can call register() again later to rejoin.',
          inputSchema: { type: 'object' as const, properties: {} },
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
        const clientKindArg = argsObj.client_kind
        const clientSessionIdArg = argsObj.client_session_id

        let sessionId: string
        let generation: number
        let ownsLifecycle = true

        if (clientKindArg !== undefined || clientSessionIdArg !== undefined) {
          if (cc_session_id) {
            throw new Error('use either cc_session_id or client_kind + client_session_id')
          }
          if (typeof clientKindArg !== 'string' || !CLIENT_KINDS.includes(clientKindArg as ClientKind)) {
            throw new Error(`client_kind must be one of: ${CLIENT_KINDS.join(', ')}`)
          }
          if (typeof clientSessionIdArg !== 'string' || clientSessionIdArg.trim() === '') {
            throw new Error('client_session_id is required and must be a non-empty string')
          }
          const claimed = findSessionByClientSessionId(
            db,
            clientKindArg as ClientKind,
            clientSessionIdArg.trim(),
          )
          if (!claimed) {
            throw new Error('session not found for client identity')
          }
          if (role !== null && role !== claimed.alias) {
            throw new Error(`alias mismatch for claimed session: ${claimed.alias ?? '(anonymous)'}`)
          }
          sessionId = claimed.id
          generation = claimed.generation
          ownsLifecycle = false
          updateLastActivity(db, sessionId)
        } else if (cc_session_id) {
          // Durable Claude Code identities share the same generation-aware
          // upsert semantics as HTTP peers. The MCP response shape remains
          // unchanged for backward compatibility.
          const registered = registerClientSession(db, {
            alias: role,
            client_kind: 'claude_code',
            client_session_id: cc_session_id,
          })
          sessionId = registered.id
          generation = registered.generation
        } else {
          // Phase 1 fallback path: no cc_session_id means every call is a fresh session
          if (role !== null) {
            const conflict = findSessionByAlias(db, role)
            if (conflict) {
              throw new Error(`alias already taken: ${role}`)
            }
          }
          sessionId = createSession(db, { alias: role, cc_session_id: null })
          generation = findSessionById(db, sessionId)!.generation
        }

        currentSwitchboardId = sessionId
        currentGeneration = generation
        currentOwnsLifecycle = ownsLifecycle
        if (transport.sessionId) {
          mcpSessionToSwitchboard.set(transport.sessionId, sessionId)
        }

        const pushCallback: PushCallback = (payload) => {
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
              registry.unregister(sessionId, pushCallback)
            })
        }
        currentPushCallback = pushCallback
        registry.register(sessionId, pushCallback)

        const finalAlias = findSessionById(db, sessionId)?.alias ?? null
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
        const recipient = findSessionById(db, targetId)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              message_id,
              delivered_notification:
                pushed || (recipient ? isSessionOnline(recipient, registry, waiters) : false),
            }),
          }],
        }
      }

      if (name === 'broadcast') {
        if (!currentSwitchboardId) throw new Error('session not registered; call register() first')
        const argsObj = (args as Record<string, unknown>) ?? {}
        const message = argsObj.message as string
        const scope = requireBroadcastScope(argsObj.scope)
        const sender = findSessionById(db, currentSwitchboardId)
        if (!sender) throw new Error('registered sender session not found')
        const recipients = listAllSessions(db).filter((recipient) => (
          recipient.id !== currentSwitchboardId &&
          recipient.released_at === null &&
          matchesBroadcastScope(sender, recipient, scope) &&
          (
            recipient.client_kind !== 'codex' ||
            isSessionOnline(recipient, registry, waiters)
          )
        ))
        const { broadcast_id, recipient_count, recipient_ids } = insertBroadcast(db, {
          sender_id: currentSwitchboardId,
          recipient_ids: recipients.map((recipient) => recipient.id),
          content: message,
        })
        // Wake every long-poll waiter that just got a new message row.
        waiters.notifyMany(recipient_ids)
        let notified_count = 0
        for (const id of recipient_ids) {
          const pushed = registry.pushNotification(id, {
            sender_alias: sender?.alias ?? null,
            sender_id: currentSwitchboardId,
            is_broadcast: true,
          })
          const recipient = findSessionById(db, id)
          if (
            pushed ||
            (recipient ? isSessionOnline(recipient, registry, waiters) : false)
          ) {
            notified_count++
          }
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
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              messages: readUnreadMessages(currentSwitchboardId),
            }),
          }],
        }
      }

      if (name === 'list_sessions') {
        const all = listAllSessions(db)
        const result = all.map(s => ({
          session_id: s.id,
          alias: s.alias,
          online: isSessionOnline(s, registry, waiters),
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

      if (name === 'unregister') {
        if (!currentSwitchboardId) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ status: 'already_offline' }) }],
          }
        }
        // Generation guard: if a newer transport re-registered this identity,
        // a stale transport's explicit unregister must not release the new
        // generation's row — mirror the transport.onclose cleanup semantics.
        if (currentPushCallback) {
          registry.unregister(currentSwitchboardId, currentPushCallback)
        }
        const priorAlias = findSessionById(db, currentSwitchboardId)?.alias ?? null
        const released =
          currentOwnsLifecycle &&
          currentGeneration !== null &&
          releaseSessionIfGeneration(db, currentSwitchboardId, currentGeneration)
        const status = currentOwnsLifecycle
          ? (released ? 'released' : 'stale_ignored')
          : 'unbound'
        currentSwitchboardId = null
        currentGeneration = null
        currentPushCallback = null
        currentOwnsLifecycle = true
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status,
                released_alias: released ? priorAlias : null,
              }),
            },
          ],
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
   * GET /poll?client_kind=K&client_session_id=X&timeout_s=N
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
    const canonicalSessionId = url.searchParams.get('client_session_id')
    const canonicalKind = url.searchParams.get('client_kind')
    if (ccSessionId && (canonicalSessionId || canonicalKind)) {
      return new Response(
        'Use either cc_session_id or client_kind + client_session_id',
        { status: 400 },
      )
    }

    let clientKind: ClientKind
    let clientSessionId: string
    if (ccSessionId) {
      clientKind = 'claude_code'
      clientSessionId = ccSessionId
    } else {
      if (!canonicalSessionId) {
        return new Response('Missing client_session_id', { status: 400 })
      }
      if (!canonicalKind) {
        return new Response('Missing client_kind', { status: 400 })
      }
      if (!CLIENT_KINDS.includes(canonicalKind as ClientKind)) {
        return new Response(
          `Invalid client_kind; expected one of: ${CLIENT_KINDS.join(', ')}`,
          { status: 400 },
        )
      }
      clientKind = canonicalKind as ClientKind
      clientSessionId = canonicalSessionId
    }
    const timeoutRaw = url.searchParams.get('timeout_s') ?? '240'
    const parsed = parseInt(timeoutRaw, 10)
    const timeoutS = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 240, 1), 250)

    const ownerTokenRaw = url.searchParams.get('owner_token')
    const generationRaw = url.searchParams.get('generation')
    if ((ownerTokenRaw === null) !== (generationRaw === null)) {
      return Response.json({
        error: 'owner_token and generation must be provided together',
      }, { status: 400 })
    }
    let ownerToken: string | undefined
    let generation: number | undefined
    if (ownerTokenRaw !== null && generationRaw !== null) {
      ownerToken = ownerTokenRaw.trim()
      generation = Number(generationRaw)
      if (!ownerToken) {
        return Response.json({
          error: 'owner_token must be a non-empty string when provided',
        }, { status: 400 })
      }
      if (!Number.isSafeInteger(generation) || generation < 1) {
        return Response.json({
          error: 'generation must be a positive integer when provided',
        }, { status: 400 })
      }
    }

    let session = findSessionByClientSessionId(db, clientKind, clientSessionId)
    if (!session || !session.alias) {
      return Response.json({ status: 'no-session' })
    }
    if (ownerToken !== undefined && generation !== undefined) {
      const mismatch = ownershipMismatchResponse(session, generation, ownerToken)
      if (mismatch) return mismatch
    }

    // Every valid poll renews the client's lease, including immediate unread
    // responses that never enter the waiter registry.
    updateLastSeen(db, session.id)
    updateLastActivity(db, session.id)
    if (ownerToken !== undefined) updateOwnerSeen(db, session.id)

    const initial = countUnreadBySessionId(db, session.id)
    if (initial > 0) {
      return Response.json({
        status: 'unread',
        count: initial,
        alias: session.alias,
        message: `SWITCHBOARD INBOX: ${initial} unread message(s) for role "${session.alias}" — call mcp__switchboard__read_messages to retrieve`,
      })
    }

    await waiters.wait(
      session.id,
      clientKind,
      clientSessionId,
      timeoutS * 1000,
      req.signal,
      ownerToken !== undefined && generation !== undefined
        ? { ownerToken, generation }
        : undefined,
    )
    // Ownership may have changed while this request was blocked. Re-read the
    // row before exposing mailbox state so an old long-poll cannot wake after
    // a newer owner has taken over the identity.
    session = findSessionByClientSessionId(db, clientKind, clientSessionId)
    if (!session || !session.alias) {
      return Response.json({ status: 'no-session' })
    }
    if (ownerToken !== undefined && generation !== undefined) {
      const mismatch = ownershipMismatchResponse(session, generation, ownerToken)
      if (mismatch) return mismatch
    }
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
   * every HEARTBEAT_LINE_EVERY (~2 hr) we *do* emit a real
   * `heartbeat <iso-ts>` line, so subscribed sessions get an occasional
   * time tick to ground them in real time without being woken every 4 min.
   * Earlier versions emitted the line every 240s, which woke every
   * connected session every four minutes for nothing.
   *
   * Unlike /poll (one-shot long-poll that the shim loops), /monitor is
   * persistent — one HTTP connection for the lifetime of the session. The
   * side effect of calling waiters.wait() here is that the shared online
   * predicate sees this Claude Code identity as polling.
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
        // HEARTBEAT_LINE_EVERY ticks (~2 hr) emit a visible heartbeat
        // line instead, so subscribed sessions get an occasional ground-truth
        // timestamp without being pinged every 4 min.
        const HEARTBEAT_MS = 240_000
        const HEARTBEAT_LINE_EVERY = 30
        let silentTicks = 0
        while (!req.signal.aborted) {
          await waiters.wait(
            sessionId,
            'claude_code',
            ccSessionId,
            HEARTBEAT_MS,
            req.signal,
          )
          if (req.signal.aborted) break
          const count = countUnreadBySessionId(db, sessionId)
          let ok: boolean
          if (count > 0) {
            ok = write(`inbox ${count} ${alias}`)
            silentTicks = 0
          } else if (++silentTicks >= HEARTBEAT_LINE_EVERY) {
            // Asia/Taipei (+08:00) — matches the rest of the API surface
            // (DB stores UTC, human-facing lines / API responses are
            // converted via toTaipeiISOString — see CLAUDE.md "Time").
            ok = write(`heartbeat ${toTaipeiISOString(new Date().toISOString())}`)
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

      if (url.pathname === '/external/send') {
        return handleExternalSend(req)
      }

      if (url.pathname === '/register') {
        return handleRegister(req)
      }

      if (url.pathname === '/unregister') {
        return handleUnregister(req)
      }

      if (url.pathname === '/messages/read') {
        return handleMessageRead(req)
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
