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
import { openDatabase, createSession, findSessionById } from './db'
import { ConnectionRegistry } from './connections'
import { setAliasWithCollisionCheck } from './aliases'

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

  // Map: MCP session ID (from Mcp-Session-Id header) → session entry
  const sessionMap = new Map<string, SessionEntry>()

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
      }
      // Unregister from connection registry if registered
      if (currentSwitchboardId) {
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
            'Optionally supply a role name as your alias.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              role: {
                type: 'string',
                description: 'Optional alias / role name for this session.',
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
      ],
    }))

    // --- Call tool ---
    mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params

      if (name === 'register') {
        const role = (args as Record<string, unknown>)?.role as
          | string
          | undefined

        // Create a new switchboard session in the DB
        const newId = createSession(db, { alias: role ?? null })
        currentSwitchboardId = newId

        // Register push callback in connection registry
        registry.register(newId, (payload) => {
          // Push notification to MCP client via server notification
          mcpServer
            .notification({
              method: 'notifications/switchboard/new_message',
              params: payload as Record<string, unknown>,
            })
            .catch(() => {
              // Ignore push errors (client may have disconnected)
            })
        })

        const anonymous = role == null
        const responseBody: Record<string, unknown> = {
          session_id: newId,
          alias: role ?? null,
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

      throw new Error(`unknown tool: ${name}`)
    })

    // Connect server to transport (starts listening for messages)
    mcpServer.connect(transport).catch((err) => {
      process.stderr.write(`switchboard: mcpServer.connect error: ${err}\n`)
    })

    return transport
  }

  // --- Bun HTTP server ---
  const bunServer = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port,

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)

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
