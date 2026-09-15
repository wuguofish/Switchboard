#!/usr/bin/env bun
/**
 * Switchboard channel shim for Claude Code.
 *
 * Claude Code spawns this per session as a stdio MCP server declared as a
 * channel. It does two things:
 *
 *   1. Proxies the Switchboard MCP tools (register, send, read_messages, ...)
 *      to the daemon's Streamable HTTP endpoint, so the daemon still sees one
 *      MCP connection per Claude Code session and releases it when the
 *      session ends.
 *   2. Subscribes to the daemon's /monitor stream for this session and turns
 *      every line into a `notifications/claude/channel` event. That is the
 *      wake path: no Monitor tool, no 30-minute re-arm.
 *
 * Environment (all optional):
 *   SWITCHBOARD_URL             daemon base URL, default http://127.0.0.1:9876
 *   SWITCHBOARD_HEARTBEAT_SECS  heartbeat interval passed to /monitor
 *   CLAUDE_CODE_SESSION_ID      set by Claude Code; identifies this session
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { monitorLineToEvent } from './monitor-events'

const SWITCHBOARD_URL = (process.env.SWITCHBOARD_URL ?? 'http://127.0.0.1:9876').replace(/\/$/, '')
const HEARTBEAT_SECS = process.env.SWITCHBOARD_HEARTBEAT_SECS
const CC_SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID ?? ''
const RECONNECT_MS = 5_000
const NOT_REGISTERED_RETRY_MS = 30_000
const VERSION = '0.1.0'

const log = (message: string) => process.stderr.write(`switchboard-channel: ${message}\n`)

if (!CC_SESSION_ID) {
  log('CLAUDE_CODE_SESSION_ID is not set; the inbox stream cannot be subscribed until register() is called with cc_session_id')
}

// ---------------------------------------------------------------------------
// Daemon side: one MCP client per shim, connected lazily and re-created on loss.
// ---------------------------------------------------------------------------
let daemon: Client | null = null
let daemonTransport: StreamableHTTPClientTransport | null = null

async function daemonClient(): Promise<Client> {
  if (daemon) return daemon
  const client = new Client({ name: 'switchboard-channel', version: VERSION }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(new URL(`${SWITCHBOARD_URL}/mcp`))
  transport.onclose = () => {
    if (daemon === client) { daemon = null; daemonTransport = null }
  }
  await client.connect(transport)
  daemon = client
  daemonTransport = transport
  return client
}

// ---------------------------------------------------------------------------
// Claude Code side: stdio server that is both a tool proxy and a channel.
// ---------------------------------------------------------------------------
const instructions = `Switchboard events arrive as <channel source="switchboard" kind="..."> tags.
  kind="inbox"      the messages themselves, already marked read: act on
                    them; read_messages is not needed.
  kind="hello"      subscribed to the inbox stream; no action needed.
  kind="heartbeat"  a clock tick with the Taipei time in the "at" attribute;
                    no action needed and do not reply.
The tools here are the Switchboard tools (register, send, broadcast,
read_messages, list_sessions, recall, set_alias, unregister). Call register
in your first turn if this session should be reachable; cc_session_id is
filled in automatically when omitted. No Monitor tool is needed: this channel
is the wake path.`

const mcp = new Server(
  { name: 'switchboard', version: VERSION },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions,
  },
)

/**
 * Run one daemon call; on a transport failure (daemon restarted, MCP session
 * gone) drop the client and retry once on a fresh connection.
 */
async function withDaemon<T>(call: (client: Client) => Promise<T>): Promise<T> {
  try {
    return await call(await daemonClient())
  } catch (error) {
    log(`daemon call failed (${error instanceof Error ? error.message : String(error)}); reconnecting`)
    try { await daemon?.close() } catch {}
    daemon = null
    daemonTransport = null
    return call(await daemonClient())
  }
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => withDaemon((client) => client.listTools()))

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = { ...(request.params.arguments ?? {}) } as Record<string, unknown>
  if (request.params.name === 'register' && !args.cc_session_id && CC_SESSION_ID) {
    args.cc_session_id = CC_SESSION_ID
  }
  const result = await withDaemon((client) => client.callTool({ name: request.params.name, arguments: args }))
  if ((request.params.name === 'register' || request.params.name === 'set_alias') && !result.isError) {
    subscribeSoon()
  }
  return result
})

// ---------------------------------------------------------------------------
// Inbox stream → channel notifications.
// ---------------------------------------------------------------------------
let subscribing = false
let wakeSubscriber: (() => void) | null = null

function subscribeSoon(): void {
  if (wakeSubscriber) wakeSubscriber()
  else if (!subscribing) void subscribeLoop()
}

async function pump(url: string): Promise<'not-registered' | 'closed'> {
  const response = await fetch(url)
  if (response.status === 404) return 'not-registered'
  if (!response.ok || !response.body) throw new Error(`monitor responded ${response.status}`)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return 'closed'
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      const event = monitorLineToEvent(line)
      if (event) {
        await mcp.notification({ method: 'notifications/claude/channel', params: event })
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    wakeSubscriber = () => { wakeSubscriber = null; resolve() }
    setTimeout(() => { if (wakeSubscriber) wakeSubscriber() }, ms)
  })
}

async function subscribeLoop(): Promise<void> {
  if (!CC_SESSION_ID) return
  subscribing = true
  const url = new URL(`${SWITCHBOARD_URL}/monitor`)
  url.searchParams.set('cc_session_id', CC_SESSION_ID)
  if (HEARTBEAT_SECS) url.searchParams.set('heartbeat_secs', HEARTBEAT_SECS)

  for (;;) {
    try {
      const outcome = await pump(url.toString())
      if (outcome === 'not-registered') {
        // Nothing to stream until register() runs; that call wakes us early.
        await sleep(NOT_REGISTERED_RETRY_MS)
        continue
      }
      log('inbox stream closed; reconnecting')
    } catch (error) {
      log(`inbox stream error: ${error instanceof Error ? error.message : String(error)}; retrying`)
    }
    await sleep(RECONNECT_MS)
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport()
await mcp.connect(transport)
log(`stdio connected, daemon=${SWITCHBOARD_URL}, cc=${CC_SESSION_ID || '(unset)'}`)
subscribeSoon()

async function stop(): Promise<void> {
  // close() only aborts the HTTP client; the daemon learns the session ended
  // from the DELETE that terminateSession() sends, and releases the row then.
  try { await daemonTransport?.terminateSession() } catch {}
  try { await daemon?.close() } catch {}
  process.exit(0)
}
process.stdin.on('close', () => { void stop() })
process.on('SIGINT', () => { void stop() })
process.on('SIGTERM', () => { void stop() })
