/**
 * One-shot smoke sender — registers a transient switchboard session and
 * sends a direct message to a target alias. Used to validate /monitor
 * end-to-end from outside any live Claude Code session.
 *
 * usage:  bun scratch/smoke-send.ts <target-alias> <message...>
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const [targetAlias, ...messageParts] = process.argv.slice(2)
if (!targetAlias || messageParts.length === 0) {
  console.error('usage: bun scratch/smoke-send.ts <target-alias> <message...>')
  process.exit(2)
}
const message = messageParts.join(' ')

const url = new URL(process.env.SWITCHBOARD_URL ?? 'http://127.0.0.1:9876/mcp')
const transport = new StreamableHTTPClientTransport(url)
const client = new Client({ name: 'smoke-send', version: '0.1.0' }, { capabilities: {} })
await client.connect(transport)

const reg = await client.callTool({
  name: 'register',
  arguments: { role: `smoke-${Date.now().toString(36)}` },
})
console.log('register:', (reg.content as any[])[0].text)

const send = await client.callTool({
  name: 'send',
  arguments: { to: targetAlias, message },
})
console.log('send:', (send.content as any[])[0].text)

await transport.terminateSession?.().catch(() => {})
await client.close()
