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

async function makeClient(name: string): Promise<Client & { close(): Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(new URL(TEST_URL))
  const client = new Client({ name, version: '0.1.0' }, { capabilities: {} })
  await client.connect(transport)
  // Override close() to send DELETE so server's transport.onclose fires
  const origClose = client.close.bind(client)
  ;(client as any).close = async () => {
    await transport.terminateSession?.().catch(() => {})
    await origClose()
  }
  return client as Client & { close(): Promise<void> }
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

test('register(role, cc_session_id) returns same session on second call with same cc_session_id', async () => {
  const c1 = await makeClient('cc-idem-1')
  const first = JSON.parse(((await c1.callTool({
    name: 'register',
    arguments: { role: 'cc-role', cc_session_id: 'cc-abc' },
  })).content as any[])[0].text)
  expect(first.alias).toBe('cc-role')
  expect(first.anonymous).toBe(false)
  await c1.close()

  const c2 = await makeClient('cc-idem-2')
  const second = JSON.parse(((await c2.callTool({
    name: 'register',
    arguments: { role: 'cc-role', cc_session_id: 'cc-abc' },
  })).content as any[])[0].text)
  expect(second.session_id).toBe(first.session_id)
  expect(second.alias).toBe('cc-role')
  await c2.close()
})

test('register(role1, cc_a) then register(role2, cc_a) renames the row (same session_id)', async () => {
  const c1 = await makeClient('rename-1')
  const first = JSON.parse(((await c1.callTool({
    name: 'register',
    arguments: { role: 'old-name', cc_session_id: 'cc-rn' },
  })).content as any[])[0].text)
  await c1.close()

  const c2 = await makeClient('rename-2')
  const second = JSON.parse(((await c2.callTool({
    name: 'register',
    arguments: { role: 'new-name', cc_session_id: 'cc-rn' },
  })).content as any[])[0].text)
  expect(second.session_id).toBe(first.session_id)
  expect(second.alias).toBe('new-name')
  await c2.close()
})

test('register with role conflict on different cc_session_id throws collision', async () => {
  const c1 = await makeClient('conflict-1')
  await c1.callTool({
    name: 'register',
    arguments: { role: 'taken-role', cc_session_id: 'cc-owner' },
  })
  // Note: we keep c1 connected so the row stays active

  const c2 = await makeClient('conflict-2')
  await expect(
    c2.callTool({
      name: 'register',
      arguments: { role: 'taken-role', cc_session_id: 'cc-other' },
    }),
  ).rejects.toThrow()

  await c1.close()
  await c2.close()
})

test('register without cc_session_id still creates a new session each time (Phase 1 fallback)', async () => {
  const c1 = await makeClient('fallback-1')
  const r1 = JSON.parse(((await c1.callTool({
    name: 'register',
    arguments: { role: 'fallback-role-unique-1' },
  })).content as any[])[0].text)
  await c1.close()

  const c2 = await makeClient('fallback-2')
  const r2 = JSON.parse(((await c2.callTool({
    name: 'register',
    arguments: { role: 'fallback-role-unique-2' },
  })).content as any[])[0].text)
  expect(r1.session_id).not.toBe(r2.session_id)
  await c2.close()
})

test('alias is released on disconnect, new client can reclaim the name', async () => {
  const c1 = await makeClient('reclaim-c1')
  const first = JSON.parse(((await c1.callTool({
    name: 'register',
    arguments: { role: 'reclaimable', cc_session_id: 'cc-first' },
  })).content as any[])[0].text)
  expect(first.alias).toBe('reclaimable')

  // Disconnect c1 — this should release the alias
  await c1.close()

  // Give server a tick to process the transport onclose
  await new Promise((r) => setTimeout(r, 50))

  // c2 should be able to take the same alias without collision
  const c2 = await makeClient('reclaim-c2')
  const second = JSON.parse(((await c2.callTool({
    name: 'register',
    arguments: { role: 'reclaimable', cc_session_id: 'cc-second' },
  })).content as any[])[0].text)
  expect(second.alias).toBe('reclaimable')
  expect(second.session_id).not.toBe(first.session_id)
  await c2.close()
})

test('released session row stays queryable by id (messages FK preserved)', async () => {
  const sender = await makeClient('fk-sender')
  const senderResp = JSON.parse(((await sender.callTool({
    name: 'register',
    arguments: { role: 'fk-sender-role', cc_session_id: 'cc-fk-s' },
  })).content as any[])[0].text)
  const senderId = senderResp.session_id

  const recipient = await makeClient('fk-recipient')
  await recipient.callTool({
    name: 'register',
    arguments: { role: 'fk-recipient-role', cc_session_id: 'cc-fk-r' },
  })

  await sender.callTool({
    name: 'send',
    arguments: { to: 'fk-recipient-role', message: 'test msg' },
  })

  // Disconnect sender — its row gets released but should still exist in DB
  await sender.close()
  await new Promise((r) => setTimeout(r, 50))

  // Recipient reads messages — sender_alias in the returned message should still resolve
  const readResult = await recipient.callTool({ name: 'read_messages', arguments: {} })
  const readParsed = JSON.parse((readResult.content as any[])[0].text)
  expect(readParsed.messages).toHaveLength(1)
  expect(readParsed.messages[0].sender_id).toBe(senderId)
  await recipient.close()
})
