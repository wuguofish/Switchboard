import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../server'
import type { ServerHandle } from '../server'

let handle: ServerHandle
const TEST_PORT = 19876
const TEST_URL = `http://127.0.0.1:${TEST_PORT}/mcp`

beforeEach(async () => {
  handle = await startServer({ port: TEST_PORT, dbPath: ':memory:' })
})

afterEach(async () => {
  await handle.stop()
})

async function makeClient(name: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(TEST_URL))
  const client = new Client({ name, version: '0.1.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

test('register returns session_id and anonymous flag', async () => {
  const client = await makeClient('test-client-1')
  const result = await client.callTool({
    name: 'register',
    arguments: {}
  })
  const parsed = JSON.parse((result.content as any[])[0].text)
  expect(typeof parsed.session_id).toBe('string')
  expect(parsed.anonymous).toBe(true)
  expect(parsed.alias).toBeNull()
  expect(parsed.hint).toContain('set_alias')
  await client.close()
})

test('register with role returns non-anonymous session', async () => {
  const client = await makeClient('test-client-2')
  const result = await client.callTool({
    name: 'register',
    arguments: { role: 'alpha' }
  })
  const parsed = JSON.parse((result.content as any[])[0].text)
  expect(parsed.alias).toBe('alpha')
  expect(parsed.anonymous).toBe(false)
  expect(parsed.hint).toBeUndefined()
  await client.close()
})

test('set_alias renames session', async () => {
  const client = await makeClient('test-client-3')
  await client.callTool({ name: 'register', arguments: {} })
  const result = await client.callTool({
    name: 'set_alias',
    arguments: { alias: 'beta' }
  })
  const parsed = JSON.parse((result.content as any[])[0].text)
  expect(parsed.new_alias).toBe('beta')
  expect(parsed.old_alias).toBeNull()
  await client.close()
})

test('send 1-to-1: recipient gets message on read_messages', async () => {
  const sender = await makeClient('send-sender')
  const recipient = await makeClient('send-recipient')
  await sender.callTool({ name: 'register', arguments: { role: 'sendA' } })
  await recipient.callTool({ name: 'register', arguments: { role: 'sendB' } })

  const sendResult = await sender.callTool({
    name: 'send',
    arguments: { to: 'sendB', message: 'hello B' },
  })
  const sendParsed = JSON.parse((sendResult.content as any[])[0].text)
  expect(typeof sendParsed.message_id).toBe('string')
  expect(sendParsed.delivered_notification).toBe(true)

  const readResult = await recipient.callTool({ name: 'read_messages', arguments: {} })
  const readParsed = JSON.parse((readResult.content as any[])[0].text)
  expect(readParsed.messages).toHaveLength(1)
  expect(readParsed.messages[0].content).toBe('hello B')
  expect(readParsed.messages[0].sender_alias).toBe('sendA')

  await sender.close()
  await recipient.close()
})

test('send to unknown target throws', async () => {
  const client = await makeClient('unknown-send')
  await client.callTool({ name: 'register', arguments: { role: 'unk' } })
  await expect(
    client.callTool({ name: 'send', arguments: { to: 'ghost', message: 'x' } })
  ).rejects.toThrow()
  await client.close()
})

test('broadcast fans out to all other sessions', async () => {
  const sender = await makeClient('bcast-sender')
  const r1 = await makeClient('bcast-r1')
  const r2 = await makeClient('bcast-r2')
  await sender.callTool({ name: 'register', arguments: { role: 'bsrc' } })
  await r1.callTool({ name: 'register', arguments: { role: 'br1' } })
  await r2.callTool({ name: 'register', arguments: { role: 'br2' } })

  const bResult = await sender.callTool({
    name: 'broadcast',
    arguments: { message: 'everybody' },
  })
  const bParsed = JSON.parse((bResult.content as any[])[0].text)
  expect(bParsed.recipient_count).toBe(2)

  const r1Read = JSON.parse((
    (await r1.callTool({ name: 'read_messages', arguments: {} })).content as any[]
  )[0].text)
  expect(r1Read.messages).toHaveLength(1)
  expect(r1Read.messages[0].is_broadcast).toBe(true)

  await sender.close()
  await r1.close()
  await r2.close()
})

test('read_messages marks as read (second call returns empty)', async () => {
  const a = await makeClient('read-a')
  const b = await makeClient('read-b')
  await a.callTool({ name: 'register', arguments: { role: 'ra' } })
  await b.callTool({ name: 'register', arguments: { role: 'rb' } })
  await a.callTool({ name: 'send', arguments: { to: 'rb', message: 'once' } })

  const first = JSON.parse(((await b.callTool({ name: 'read_messages', arguments: {} })).content as any[])[0].text)
  expect(first.messages).toHaveLength(1)

  const second = JSON.parse(((await b.callTool({ name: 'read_messages', arguments: {} })).content as any[])[0].text)
  expect(second.messages).toHaveLength(0)

  await a.close()
  await b.close()
})

test('list_sessions includes all registered with online flag', async () => {
  const a = await makeClient('ls-a')
  const b = await makeClient('ls-b')
  await a.callTool({ name: 'register', arguments: { role: 'lsA' } })
  await b.callTool({ name: 'register', arguments: { role: 'lsB' } })

  const listResult = JSON.parse(((await a.callTool({ name: 'list_sessions', arguments: {} })).content as any[])[0].text)
  const aliases = listResult.map((s: any) => s.alias).filter(Boolean)
  expect(aliases).toContain('lsA')
  expect(aliases).toContain('lsB')
  const lsA = listResult.find((s: any) => s.alias === 'lsA')
  expect(lsA.online).toBe(true)

  await a.close()
  await b.close()
})

test('recall deletes unread message', async () => {
  const sender = await makeClient('rc-sender')
  const recipient = await makeClient('rc-recip')
  await sender.callTool({ name: 'register', arguments: { role: 'rcs' } })
  await recipient.callTool({ name: 'register', arguments: { role: 'rcr' } })

  const sendResult = JSON.parse(((await sender.callTool({
    name: 'send',
    arguments: { to: 'rcr', message: 'oops' },
  })).content as any[])[0].text)

  const recallResult = JSON.parse(((await sender.callTool({
    name: 'recall',
    arguments: { message_id: sendResult.message_id },
  })).content as any[])[0].text)
  expect(recallResult.recalled_count).toBe(1)

  const readResult = JSON.parse(((await recipient.callTool({
    name: 'read_messages', arguments: {},
  })).content as any[])[0].text)
  expect(readResult.messages).toHaveLength(0)

  await sender.close()
  await recipient.close()
})

test('recall by non-sender throws', async () => {
  const sender = await makeClient('rc2-sender')
  const recipient = await makeClient('rc2-recip')
  await sender.callTool({ name: 'register', arguments: { role: 'rc2s' } })
  await recipient.callTool({ name: 'register', arguments: { role: 'rc2r' } })

  const sendResult = JSON.parse(((await sender.callTool({
    name: 'send',
    arguments: { to: 'rc2r', message: 'you cannot recall this' },
  })).content as any[])[0].text)

  await expect(recipient.callTool({
    name: 'recall',
    arguments: { message_id: sendResult.message_id },
  })).rejects.toThrow()

  await sender.close()
  await recipient.close()
})

test('register with same role twice returns same session_id (idempotent)', async () => {
  const client1 = await makeClient('idempotent-test-1')
  const first = JSON.parse(((await client1.callTool({
    name: 'register',
    arguments: { role: 'idempotent-role' },
  })).content as any[])[0].text)
  expect(first.alias).toBe('idempotent-role')
  expect(first.anonymous).toBe(false)
  expect(typeof first.session_id).toBe('string')
  await client1.close()

  // Second client uses same role — should get same session_id back
  const client2 = await makeClient('idempotent-test-2')
  const second = JSON.parse(((await client2.callTool({
    name: 'register',
    arguments: { role: 'idempotent-role' },
  })).content as any[])[0].text)
  expect(second.session_id).toBe(first.session_id)
  expect(second.alias).toBe('idempotent-role')
  expect(second.anonymous).toBe(false)
  await client2.close()
})

test('register with null role still creates new anonymous session each time', async () => {
  const c1 = await makeClient('anon-1')
  const r1 = JSON.parse(((await c1.callTool({ name: 'register', arguments: {} })).content as any[])[0].text)
  await c1.close()

  const c2 = await makeClient('anon-2')
  const r2 = JSON.parse(((await c2.callTool({ name: 'register', arguments: {} })).content as any[])[0].text)
  await c2.close()

  // Two anonymous calls should get two different session_ids (not idempotent for anon)
  expect(r1.session_id).not.toBe(r2.session_id)
  expect(r1.anonymous).toBe(true)
  expect(r2.anonymous).toBe(true)
})
