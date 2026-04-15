import { test, expect, beforeAll, afterAll } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../server'
import type { ServerHandle } from '../server'

let handle: ServerHandle
const TEST_PORT = 19876
const TEST_URL = `http://127.0.0.1:${TEST_PORT}/mcp`

beforeAll(async () => {
  handle = await startServer({ port: TEST_PORT, dbPath: ':memory:' })
})

afterAll(async () => {
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
