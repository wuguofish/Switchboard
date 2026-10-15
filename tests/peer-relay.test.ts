import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer, type ServerHandle } from '../server'
import { parsePeerTarget, relayToPeer, PeerRelayError } from '../peer-relay'

describe('parsePeerTarget', () => {
  test('splits <peer>:<alias> and rejects everything else', () => {
    expect(parsePeerTarget('home:家裡阿宇')).toEqual({ peer: 'home', alias: '家裡阿宇' })
    expect(parsePeerTarget('home: 家裡阿宇 ')).toEqual({ peer: 'home', alias: '家裡阿宇' })
    expect(parsePeerTarget('家裡阿宇')).toBeNull()
    expect(parsePeerTarget(':x')).toBeNull()
    expect(parsePeerTarget('home:')).toBeNull()
    expect(parsePeerTarget('Home Office:x')).toBeNull()
  })
})

describe('relayToPeer', () => {
  test('posts the outbound request and reads delivery from the remote answer', async () => {
    let seen: unknown
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = JSON.parse(init!.body as string)
      return Response.json({ ok: true, envelope_id: 'env-1', peer: 'home', remote: { switchboard: { delivered_notification: true } } })
    }) as typeof fetch
    const result = await relayToPeer('http://gw/', { target: { peer: 'home', alias: '家裡阿宇' }, from_alias: '總機', content: 'hi' }, fetchImpl)
    expect(seen).toEqual({ to_peer: 'home', to_alias: '家裡阿宇', from_alias: '總機', content: 'hi' })
    expect(result).toEqual({ envelope_id: 'env-1', peer: 'home', delivered_notification: true })
  })

  test('turns gateway errors into one readable message', async () => {
    const refused = (async () => Response.json({ error: 'peer home refused the envelope (HTTP 404)', detail: { error: 'switchboard refused the message' } }, { status: 502 })) as unknown as typeof fetch
    await expect(relayToPeer('http://gw', { target: { peer: 'home', alias: 'x' }, from_alias: 'a', content: 'b' }, refused))
      .rejects.toThrow('peer home refused the envelope (HTTP 404) (switchboard refused the message)')

    const unknown = (async () => Response.json({ error: 'unknown peer: cabin', known_peers: ['home'] }, { status: 404 })) as unknown as typeof fetch
    await expect(relayToPeer('http://gw', { target: { peer: 'cabin', alias: 'x' }, from_alias: 'a', content: 'b' }, unknown))
      .rejects.toThrow('unknown peer: cabin; known peers: home')

    const down = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    await expect(relayToPeer('http://gw', { target: { peer: 'home', alias: 'x' }, from_alias: 'a', content: 'b' }, down))
      .rejects.toBeInstanceOf(PeerRelayError)
  })
})

describe('send tool with a <peer>:<alias> target', () => {
  const TEST_PORT = 19877
  let handle: ServerHandle
  let relayCalls: Array<{ url: string; body: unknown }>
  let relayAnswer: () => Response

  beforeEach(async () => {
    relayCalls = []
    relayAnswer = () => Response.json({ ok: true, envelope_id: 'env-7', peer: 'home', remote: { switchboard: { delivered_notification: false } } })
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      relayCalls.push({ url: String(url), body: JSON.parse(init!.body as string) })
      return relayAnswer()
    }) as typeof fetch
    handle = await startServer({
      port: TEST_PORT,
      dbPath: ':memory:',
      sessionsDir: mkdtempSync(join(tmpdir(), 'sb-peer-')),
      peerRelayUrl: 'http://gw',
      fetchImpl,
    })
  })

  afterEach(async () => {
    await handle.stop()
  })

  async function connect(alias: string): Promise<Client> {
    const client = new Client({ name: alias, version: '0.1.0' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${TEST_PORT}/mcp`)))
    await client.callTool({ name: 'register', arguments: { role: alias } })
    return client
  }

  function text(result: Awaited<ReturnType<Client['callTool']>>): string {
    return (result.content as Array<{ text: string }>)[0]!.text
  }

  test('relays through the local gateway when no local session matches', async () => {
    const client = await connect('LINE總機')
    const result = await client.callTool({ name: 'send', arguments: { to: 'home:家裡阿宇', message: '阿童今天很晚' } })
    expect(JSON.parse(text(result))).toEqual({ message_id: 'env-7', delivered_notification: false, via_peer: 'home' })
    expect(relayCalls).toEqual([{ url: 'http://gw/peer/send', body: { to_peer: 'home', to_alias: '家裡阿宇', from_alias: 'LINE總機', content: '阿童今天很晚' } }])
    await client.close()
  })

  test('prefers a local session whose alias contains a colon', async () => {
    const sender = await connect('sender')
    const local = await connect('home:家裡阿宇')
    const result = await sender.callTool({ name: 'send', arguments: { to: 'home:家裡阿宇', message: 'local' } })
    expect(JSON.parse(text(result)).via_peer).toBeUndefined()
    expect(relayCalls).toHaveLength(0)
    await local.close()
    await sender.close()
  })

  test('a remote sender\'s external row does not shadow the peer route', async () => {
    // Mail from the other machine lands through /external/send and leaves an
    // external row named office:LINE總機 behind.
    const sender = await connect('sender')
    const landed = await fetch(`http://127.0.0.1:${TEST_PORT}/external/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'home:家裡阿宇', to: 'sender', message: 'hi' }),
    })
    expect(landed.status).toBe(200)
    const result = await sender.callTool({ name: 'send', arguments: { to: 'home:家裡阿宇', message: 'reply' } })
    expect(JSON.parse(text(result)).via_peer).toBe('home')
    expect(relayCalls).toHaveLength(1)
    await sender.close()
  })

  test('surfaces the gateway error and still rejects plain unknown aliases', async () => {
    const client = await connect('sender')
    relayAnswer = () => Response.json({ error: 'unknown peer: cabin', known_peers: ['home'] }, { status: 404 })
    await expect(client.callTool({ name: 'send', arguments: { to: 'cabin:someone', message: 'x' } }))
      .rejects.toThrow('unknown peer: cabin; known peers: home')

    await expect(client.callTool({ name: 'send', arguments: { to: 'nobody', message: 'x' } }))
      .rejects.toThrow('unknown target')
    expect(relayCalls).toHaveLength(1)
    await client.close()
  })
})

describe('session listing across machines', () => {
  const TEST_PORT = 19878
  let handle: ServerHandle
  let relayCalls: string[]

  beforeEach(async () => {
    relayCalls = []
    const fetchImpl = (async (url: string | URL | Request) => {
      relayCalls.push(String(url))
      return Response.json({ peer: 'home', sessions: [
        { alias: '家裡阿宇', client_kind: 'claude_code', online: true, last_activity: '2026-10-15T13:00:00+08:00' },
        { alias: null, client_kind: 'external', online: true },
      ] })
    }) as unknown as typeof fetch
    handle = await startServer({
      port: TEST_PORT,
      dbPath: ':memory:',
      sessionsDir: mkdtempSync(join(tmpdir(), 'sb-peer-')),
      peerRelayUrl: 'http://gw',
      fetchImpl,
    })
  })

  afterEach(async () => {
    await handle.stop()
  })

  test('GET /sessions lists online sessions with their client kind', async () => {
    const client = new Client({ name: 'x', version: '0.1.0' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${TEST_PORT}/mcp`)))
    await client.callTool({ name: 'register', arguments: { role: 'LINE總機' } })
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/sessions`)
    expect(res.status).toBe(200)
    const body = await res.json() as { sessions: Array<{ alias: string; client_kind: string; online: boolean }> }
    expect(body.sessions).toEqual([expect.objectContaining({ alias: 'LINE總機', client_kind: 'claude_code', online: true })])
    expect((await fetch(`http://127.0.0.1:${TEST_PORT}/sessions`, { method: 'POST' })).status).toBe(405)
    await client.close()
  })

  test('list_sessions with peer asks the gateway and prefixes the aliases', async () => {
    const client = new Client({ name: 'x', version: '0.1.0' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${TEST_PORT}/mcp`)))
    const result = await client.callTool({ name: 'list_sessions', arguments: { peer: 'home' } })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
    expect(relayCalls).toEqual(['http://gw/peer/sessions?peer=home'])
    expect(parsed).toEqual({ peer: 'home', sessions: [
      { alias: 'home:家裡阿宇', client_kind: 'claude_code', online: true, last_activity: '2026-10-15T13:00:00+08:00' },
    ] })
    await client.close()
  })
})
