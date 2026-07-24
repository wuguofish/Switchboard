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
  // A successful MCP push is now sufficient for delivered_notification,
  // even when this legacy anonymous identity has no poller lease.
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

test('broadcast tool advertises all, same_kind, and same_cwd scopes with all as default', async () => {
  const client = await makeClient('bcast-schema')
  const tools = await client.listTools()
  const broadcast = tools.tools.find((tool) => tool.name === 'broadcast')
  const scope = (broadcast?.inputSchema.properties as any)?.scope

  expect(scope.enum).toEqual(['all', 'same_kind', 'same_cwd'])
  expect(scope.default).toBe('all')

  await client.close()
})

for (const testCase of [
  {
    scope: 'all',
    queuedKind: 'external',
    queuedCwd: '/workspace/other',
    onlineCodexDelivered: true,
    recipientCount: 2,
    notifiedCount: 1,
  },
  {
    scope: 'same_kind',
    queuedKind: 'claude_code',
    queuedCwd: '/workspace/other',
    onlineCodexDelivered: false,
    recipientCount: 1,
    notifiedCount: 0,
  },
  {
    scope: 'same_cwd',
    queuedKind: 'external',
    queuedCwd: '/workspace/shared',
    onlineCodexDelivered: true,
    recipientCount: 2,
    notifiedCount: 1,
  },
] as const) {
  test(`broadcast scope=${testCase.scope} filters recipients and never queues offline codex`, async () => {
    const senderIdentity = `scope-sender-${testCase.scope}`
    await postJson(REGISTER_URL, {
      alias: `scope-sender-${testCase.scope}`,
      client_kind: 'claude_code',
      client_session_id: senderIdentity,
      cwd: '/workspace/shared',
    })
    const sender = await makeClient(`scope-sender-mcp-${testCase.scope}`)
    await sender.callTool({
      name: 'register',
      arguments: {
        role: `scope-sender-${testCase.scope}`,
        cc_session_id: senderIdentity,
      },
    })

    const onlineCodexId = `online-codex-${testCase.scope}`
    const offlineCodexId = `offline-codex-${testCase.scope}`
    await postJson(REGISTER_URL, {
      alias: onlineCodexId,
      client_kind: 'codex',
      client_session_id: onlineCodexId,
      cwd: '/workspace/shared',
    })
    await postJson(REGISTER_URL, {
      alias: offlineCodexId,
      client_kind: 'codex',
      client_session_id: offlineCodexId,
      cwd: '/workspace/shared',
    })
    await postJson(REGISTER_URL, {
      alias: `queued-${testCase.scope}`,
      client_kind: testCase.queuedKind,
      client_session_id: `queued-${testCase.scope}`,
      cwd: testCase.queuedCwd,
    })

    const onlinePoll = fetch(
      `${POLL_URL}?client_kind=codex&client_session_id=${onlineCodexId}&timeout_s=1`,
    )
    await new Promise((resolve) => setTimeout(resolve, 80))

    const result = JSON.parse(((await sender.callTool({
      name: 'broadcast',
      arguments: {
        message: `scope ${testCase.scope}`,
        scope: testCase.scope,
      },
    })).content as any[])[0].text)
    expect(result.recipient_count).toBe(testCase.recipientCount)
    expect(result.notified_count).toBe(testCase.notifiedCount)

    const onlinePollBody = await (await onlinePoll).json()
    expect(onlinePollBody.status).toBe(
      testCase.onlineCodexDelivered ? 'unread' : 'timeout',
    )

    // An offline codex peer must not receive a mailbox row. Polling only after
    // the broadcast makes it online too late and must still return timeout.
    const offlinePoll = await fetch(
      `${POLL_URL}?client_kind=codex&client_session_id=${offlineCodexId}&timeout_s=1`,
    )
    expect((await offlinePoll.json()).status).toBe('timeout')

    // Claude Code and external peers keep the existing durable-mailbox
    // behavior: they were offline at send time but can read the queued row
    // when they poll later.
    const queuedPoll = await fetch(
      `${POLL_URL}?client_kind=${testCase.queuedKind}` +
      `&client_session_id=queued-${testCase.scope}&timeout_s=1`,
    )
    expect((await queuedPoll.json()).status).toBe('unread')

    await sender.close()
  })
}

test('broadcast scope=same_cwd does not match any recipient when sender cwd is NULL', async () => {
  const sender = await makeClient('null-cwd-sender')
  await sender.callTool({
    name: 'register',
    arguments: { role: 'null-cwd-sender', cc_session_id: 'null-cwd-sender' },
  })
  await postJson(REGISTER_URL, {
    alias: 'non-null-cwd-recipient',
    client_kind: 'external',
    client_session_id: 'non-null-cwd-recipient',
    cwd: '/workspace/shared',
  })

  const result = JSON.parse(((await sender.callTool({
    name: 'broadcast',
    arguments: { message: 'NULL cwd never matches', scope: 'same_cwd' },
  })).content as any[])[0].text)
  expect(result.recipient_count).toBe(0)
  expect(result.notified_count).toBe(0)

  await sender.close()
})

test('broadcast scope=same_cwd excludes a NULL recipient cwd when sender cwd is non-NULL', async () => {
  await postJson(REGISTER_URL, {
    alias: 'non-null-cwd-sender',
    client_kind: 'claude_code',
    client_session_id: 'non-null-cwd-sender',
    cwd: '/workspace/shared',
  })
  const sender = await makeClient('non-null-cwd-sender-mcp')
  await sender.callTool({
    name: 'register',
    arguments: {
      role: 'non-null-cwd-sender',
      cc_session_id: 'non-null-cwd-sender',
    },
  })
  await postJson(REGISTER_URL, {
    alias: 'null-cwd-recipient',
    client_kind: 'external',
    client_session_id: 'null-cwd-recipient',
    cwd: null,
  })
  await postJson(REGISTER_URL, {
    alias: 'matching-cwd-recipient',
    client_kind: 'external',
    client_session_id: 'matching-cwd-recipient',
    cwd: '/workspace/shared',
  })

  const result = JSON.parse(((await sender.callTool({
    name: 'broadcast',
    arguments: { message: 'NULL recipient cwd never matches', scope: 'same_cwd' },
  })).content as any[])[0].text)
  expect(result.recipient_count).toBe(1)
  expect(result.notified_count).toBe(0)

  await sender.close()
})

test('broadcast rejects a scope outside the advertised enum', async () => {
  const sender = await makeClient('invalid-scope-sender')
  await sender.callTool({
    name: 'register',
    arguments: { role: 'invalid-scope-sender' },
  })

  await expect(sender.callTool({
    name: 'broadcast',
    arguments: { message: 'invalid scope', scope: 'nearby' },
  })).rejects.toThrow(/scope must be one of/)

  await sender.close()
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

// --- /poll long-polling endpoint ---

const POLL_URL = `http://127.0.0.1:${TEST_PORT}/poll`

test('/poll returns no-session when cc_session_id is unknown', async () => {
  const resp = await fetch(`${POLL_URL}?cc_session_id=cc-never-registered&timeout_s=1`)
  expect(resp.status).toBe(200)
  const body = await resp.json()
  expect(body.status).toBe('no-session')
})

test('/poll resolves client identity by client_kind namespace', async () => {
  await postJson(REGISTER_URL, {
    alias: 'poll-codex-shared',
    client_kind: 'codex',
    client_session_id: 'poll-shared-id',
    cwd: '/workspace/codex',
  })
  const claude = await makeClient('poll-claude-shared')
  await claude.callTool({
    name: 'register',
    arguments: { role: 'poll-claude-shared', cc_session_id: 'poll-shared-id' },
  })

  const codexPoll = fetch(
    `${POLL_URL}?client_kind=codex&client_session_id=poll-shared-id&timeout_s=5`,
  )
  await new Promise((r) => setTimeout(r, 80))

  const sender = await makeClient('poll-kind-sender')
  await sender.callTool({ name: 'register', arguments: { role: 'poll-kind-sender' } })
  await sender.callTool({
    name: 'send',
    arguments: { to: 'poll-codex-shared', message: 'codex only' },
  })

  const body = await (await codexPoll).json()
  expect(body.status).toBe('unread')
  expect(body.alias).toBe('poll-codex-shared')

  await sender.close()
  await claude.close()
})

test('/poll validates canonical client identity parameters', async () => {
  const missingKind = await fetch(`${POLL_URL}?client_session_id=some-id&timeout_s=1`)
  expect(missingKind.status).toBe(400)
  expect(await missingKind.text()).toContain('client_kind')

  const invalidKind = await fetch(
    `${POLL_URL}?client_kind=other&client_session_id=some-id&timeout_s=1`,
  )
  expect(invalidKind.status).toBe(400)

  const ambiguous = await fetch(
    `${POLL_URL}?cc_session_id=some-id&client_kind=codex&client_session_id=some-id&timeout_s=1`,
  )
  expect(ambiguous.status).toBe(400)
})

test('/poll returns unread immediately when messages are already waiting', async () => {
  const sender = await makeClient('poll-sender-imm')
  await sender.callTool({
    name: 'register',
    arguments: { role: 'poll-snd-imm', cc_session_id: 'cc-poll-snd-imm' },
  })
  const recipient = await makeClient('poll-recip-imm')
  await recipient.callTool({
    name: 'register',
    arguments: { role: 'poll-rcp-imm', cc_session_id: 'cc-poll-rcp-imm' },
  })
  await sender.callTool({
    name: 'send',
    arguments: { to: 'poll-rcp-imm', message: 'already here' },
  })

  const resp = await fetch(`${POLL_URL}?cc_session_id=cc-poll-rcp-imm&timeout_s=5`)
  const body = await resp.json()
  expect(body.status).toBe('unread')
  expect(body.count).toBe(1)
  expect(body.alias).toBe('poll-rcp-imm')
  expect(body.message).toContain('SWITCHBOARD INBOX')
  expect(body.message).toContain('poll-rcp-imm')

  await sender.close()
  await recipient.close()
})

test('/poll long-poll resolves when a send arrives mid-wait', async () => {
  const recipient = await makeClient('poll-recip-late')
  await recipient.callTool({
    name: 'register',
    arguments: { role: 'poll-rcp-late', cc_session_id: 'cc-poll-rcp-late' },
  })

  const pollPromise = fetch(`${POLL_URL}?cc_session_id=cc-poll-rcp-late&timeout_s=5`)
  await new Promise((r) => setTimeout(r, 80))

  const sender = await makeClient('poll-sender-late')
  await sender.callTool({
    name: 'register',
    arguments: { role: 'poll-snd-late', cc_session_id: 'cc-poll-snd-late' },
  })
  await sender.callTool({
    name: 'send',
    arguments: { to: 'poll-rcp-late', message: 'wake up' },
  })

  const resp = await pollPromise
  const body = await resp.json()
  expect(body.status).toBe('unread')
  expect(body.count).toBeGreaterThanOrEqual(1)

  await sender.close()
  await recipient.close()
})

test('/poll returns timeout when no message arrives within the window', async () => {
  const recipient = await makeClient('poll-recip-idle')
  await recipient.callTool({
    name: 'register',
    arguments: { role: 'poll-rcp-idle', cc_session_id: 'cc-poll-rcp-idle' },
  })
  const resp = await fetch(`${POLL_URL}?cc_session_id=cc-poll-rcp-idle&timeout_s=1`)
  const body = await resp.json()
  expect(body.status).toBe('timeout')
  await recipient.close()
})

test('send to a recipient currently long-polling reports delivered_notification: true', async () => {
  const recipient = await makeClient('poll-recip-dn')
  await recipient.callTool({
    name: 'register',
    arguments: { role: 'poll-rcp-dn', cc_session_id: 'cc-poll-rcp-dn' },
  })
  const pollPromise = fetch(`${POLL_URL}?cc_session_id=cc-poll-rcp-dn&timeout_s=3`)
  await new Promise((r) => setTimeout(r, 80))

  const sender = await makeClient('poll-sender-dn')
  await sender.callTool({
    name: 'register',
    arguments: { role: 'poll-snd-dn', cc_session_id: 'cc-poll-snd-dn' },
  })
  const sendResult = JSON.parse(((await sender.callTool({
    name: 'send',
    arguments: { to: 'poll-rcp-dn', message: 'live poll' },
  })).content as any[])[0].text)
  expect(sendResult.delivered_notification).toBe(true)

  await pollPromise
  await sender.close()
  await recipient.close()
})

test('/poll renews a lease used by list_sessions and delivered_notification', async () => {
  await postJson(REGISTER_URL, {
    alias: 'leased-codex',
    client_kind: 'codex',
    client_session_id: 'leased-codex-id',
    cwd: '/workspace',
  })

  const observer = await makeClient('lease-observer')
  await observer.callTool({ name: 'register', arguments: { role: 'lease-observer' } })
  const before = JSON.parse(((await observer.callTool({
    name: 'list_sessions',
    arguments: {},
  })).content as any[])[0].text)
  expect(before.find((s: any) => s.alias === 'leased-codex')?.online).toBe(false)

  const poll = fetch(
    `${POLL_URL}?client_kind=codex&client_session_id=leased-codex-id&timeout_s=1`,
  )
  await new Promise((r) => setTimeout(r, 80))
  const during = JSON.parse(((await observer.callTool({
    name: 'list_sessions',
    arguments: {},
  })).content as any[])[0].text)
  expect(during.find((s: any) => s.alias === 'leased-codex')?.online).toBe(true)
  await poll

  const send = JSON.parse(((await observer.callTool({
    name: 'send',
    arguments: { to: 'leased-codex', message: 'lease wake' },
  })).content as any[])[0].text)
  expect(send.delivered_notification).toBe(true)

  const broadcast = JSON.parse(((await observer.callTool({
    name: 'broadcast',
    arguments: { message: 'lease broadcast' },
  })).content as any[])[0].text)
  expect(broadcast.recipient_count).toBe(1)
  expect(broadcast.notified_count).toBe(1)

  await observer.close()
})

test('delivered_notification is false when only a legacy state file exists (no live /poll)', async () => {
  // Regression: canAutoWake used to trust poller.ts's state file, so a stale
  // file whose pid had been reused by another process could report delivery.
  // The shared online predicate intentionally ignores state files.
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-statefile-'))
  const originalStateDir = process.env.SWITCHBOARD_POLLER_STATE_DIR
  try {
    // Stash a state file pointing at our own (live) pid — the old code path
    // would accept this as "alive".
    const ccSessionId = 'cc-legacy-statefile-only'
    const stateFile = path.join(tmpDir, `switchboard-poller-${ccSessionId}.state`)
    fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, cc_session_id: ccSessionId, started_at: new Date().toISOString() }))

    process.env.SWITCHBOARD_POLLER_STATE_DIR = tmpDir
    await postJson(REGISTER_URL, {
      alias: 'legacy-rcp',
      client_kind: 'claude_code',
      client_session_id: ccSessionId,
      cwd: '/workspace',
    })

    const sender = await makeClient('legacy-statefile-sender')
    await sender.callTool({ name: 'register', arguments: { role: 'legacy-snd' } })
    const sendResult = JSON.parse(((await sender.callTool({
      name: 'send',
      arguments: { to: 'legacy-rcp', message: 'legacy mode' },
    })).content as any[])[0].text)
    expect(sendResult.delivered_notification).toBe(false)

    await sender.close()
  } finally {
    if (originalStateDir === undefined) {
      delete process.env.SWITCHBOARD_POLLER_STATE_DIR
    } else {
      process.env.SWITCHBOARD_POLLER_STATE_DIR = originalStateDir
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
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

test('explicit unregister from an older MCP transport does not release a newer generation', async () => {
  const oldClient = await makeClient('stale-unreg-old')
  const oldRegistration = JSON.parse(((await oldClient.callTool({
    name: 'register',
    arguments: { role: 'stale-unreg-old', cc_session_id: 'stale-unreg-shared' },
  })).content as any[])[0].text)

  const newClient = await makeClient('stale-unreg-new')
  const newRegistration = JSON.parse(((await newClient.callTool({
    name: 'register',
    arguments: { role: 'stale-unreg-current', cc_session_id: 'stale-unreg-shared' },
  })).content as any[])[0].text)
  expect(newRegistration.session_id).toBe(oldRegistration.session_id)

  // The stale transport actively unregisters — the guard must ignore it.
  const staleResult = JSON.parse(((await oldClient.callTool({
    name: 'unregister',
    arguments: {},
  })).content as any[])[0].text)
  expect(staleResult.status).toBe('stale_ignored')
  expect(staleResult.released_alias).toBeNull()

  const sessions = JSON.parse(((await newClient.callTool({
    name: 'list_sessions',
    arguments: {},
  })).content as any[])[0].text)
  const current = sessions.find((s: any) => s.session_id === newRegistration.session_id)
  expect(current?.alias).toBe('stale-unreg-current')
  expect(current?.online).toBe(true)

  // The current generation's own unregister still releases normally.
  const currentResult = JSON.parse(((await newClient.callTool({
    name: 'unregister',
    arguments: {},
  })).content as any[])[0].text)
  expect(currentResult.status).toBe('released')
  expect(currentResult.released_alias).toBe('stale-unreg-current')

  await oldClient.close()
  await newClient.close()
})

test('closing an older MCP transport does not release a newer generation', async () => {
  const oldClient = await makeClient('generation-old')
  const oldRegistration = JSON.parse(((await oldClient.callTool({
    name: 'register',
    arguments: { role: 'generation-old', cc_session_id: 'generation-shared' },
  })).content as any[])[0].text)

  const newClient = await makeClient('generation-new')
  const newRegistration = JSON.parse(((await newClient.callTool({
    name: 'register',
    arguments: { role: 'generation-current', cc_session_id: 'generation-shared' },
  })).content as any[])[0].text)
  expect(newRegistration.session_id).toBe(oldRegistration.session_id)

  await oldClient.close()
  await new Promise((r) => setTimeout(r, 50))

  const sessions = JSON.parse(((await newClient.callTool({
    name: 'list_sessions',
    arguments: {},
  })).content as any[])[0].text)
  const current = sessions.find((s: any) => s.session_id === newRegistration.session_id)
  expect(current?.alias).toBe('generation-current')
  expect(current?.online).toBe(true)

  await newClient.close()
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

// --- /monitor chunked-stream endpoint ---

const MONITOR_URL = `http://127.0.0.1:${TEST_PORT}/monitor`

/**
 * Read lines from a chunked text stream until either `predicate` returns a
 * value or `timeoutMs` elapses. Returns the collected lines so assertions
 * can inspect them. Aborts the request on timeout / match so the server
 * tears down its waiter.
 */
async function collectLines(
  url: string,
  predicate: (lines: string[]) => boolean,
  timeoutMs = 3_000,
): Promise<{ lines: string[]; timedOut: boolean }> {
  const controller = new AbortController()
  const lines: string[] = []
  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const resp = await fetch(url, { signal: controller.signal })
    if (!resp.ok) {
      clearTimeout(timer)
      return { lines: [resp.status + ''], timedOut: false }
    }
    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n')
      buffer = parts.pop()!
      for (const p of parts) if (p) lines.push(p)
      if (predicate(lines)) {
        controller.abort()
        break
      }
    }
  } catch (e) {
    // AbortError is expected when we stop early
  } finally {
    clearTimeout(timer)
  }
  return { lines, timedOut }
}

test('/monitor returns no-session for an unknown cc_session_id', async () => {
  const resp = await fetch(`${MONITOR_URL}?cc_session_id=cc-nope`)
  expect(resp.status).toBe(404)
  const body = await resp.json()
  expect(body.status).toBe('no-session')
})

test('/monitor rejects when cc_session_id is missing', async () => {
  const resp = await fetch(MONITOR_URL)
  expect(resp.status).toBe(400)
})

test('/monitor emits "hello <alias>" on connect when inbox is empty', async () => {
  const recipient = await makeClient('mon-hello')
  await recipient.callTool({
    name: 'register',
    arguments: { role: 'mon-hello', cc_session_id: 'cc-mon-hello' },
  })

  const { lines } = await collectLines(
    `${MONITOR_URL}?cc_session_id=cc-mon-hello`,
    (ls) => ls.length >= 1,
  )
  expect(lines[0]).toBe('hello mon-hello')

  await recipient.close()
})

test('/monitor emits "inbox N <alias>" immediately when unread already waiting', async () => {
  const sender = await makeClient('mon-sender-imm')
  await sender.callTool({
    name: 'register',
    arguments: { role: 'mon-snd-imm', cc_session_id: 'cc-mon-snd-imm' },
  })
  const recipient = await makeClient('mon-rcp-imm')
  await recipient.callTool({
    name: 'register',
    arguments: { role: 'mon-rcp-imm', cc_session_id: 'cc-mon-rcp-imm' },
  })
  await sender.callTool({
    name: 'send',
    arguments: { to: 'mon-rcp-imm', message: 'pre-queued' },
  })

  const { lines } = await collectLines(
    `${MONITOR_URL}?cc_session_id=cc-mon-rcp-imm`,
    (ls) => ls.length >= 1,
  )
  expect(lines[0]).toBe('inbox 1 mon-rcp-imm')

  await sender.close()
  await recipient.close()
})

test('/monitor emits a new "inbox" line when a send arrives mid-stream', async () => {
  const recipient = await makeClient('mon-rcp-late')
  await recipient.callTool({
    name: 'register',
    arguments: { role: 'mon-rcp-late', cc_session_id: 'cc-mon-rcp-late' },
  })

  const linesPromise = collectLines(
    `${MONITOR_URL}?cc_session_id=cc-mon-rcp-late`,
    (ls) => ls.some((l) => l.startsWith('inbox ')),
    4_000,
  )

  // Give the stream a moment to emit the initial "hello" before we send.
  await new Promise((r) => setTimeout(r, 100))

  const sender = await makeClient('mon-snd-late')
  await sender.callTool({
    name: 'register',
    arguments: { role: 'mon-snd-late', cc_session_id: 'cc-mon-snd-late' },
  })
  await sender.callTool({
    name: 'send',
    arguments: { to: 'mon-rcp-late', message: 'hi there' },
  })

  const { lines } = await linesPromise
  expect(lines[0]).toBe('hello mon-rcp-late')
  const inboxLine = lines.find((l) => l.startsWith('inbox '))
  expect(inboxLine).toBe('inbox 1 mon-rcp-late')

  await sender.close()
  await recipient.close()
})

test('/monitor fires on broadcast as well as direct send', async () => {
  const recipient = await makeClient('mon-rcp-bcast')
  await recipient.callTool({
    name: 'register',
    arguments: { role: 'mon-rcp-bcast', cc_session_id: 'cc-mon-rcp-bcast' },
  })

  const linesPromise = collectLines(
    `${MONITOR_URL}?cc_session_id=cc-mon-rcp-bcast`,
    (ls) => ls.some((l) => l.startsWith('inbox ')),
    4_000,
  )

  await new Promise((r) => setTimeout(r, 100))

  const sender = await makeClient('mon-snd-bcast')
  await sender.callTool({
    name: 'register',
    arguments: { role: 'mon-snd-bcast', cc_session_id: 'cc-mon-snd-bcast' },
  })
  await sender.callTool({
    name: 'broadcast',
    arguments: { message: 'hi everyone' },
  })

  const { lines } = await linesPromise
  expect(lines.find((l) => l.startsWith('inbox '))).toMatch(/^inbox \d+ mon-rcp-bcast$/)

  await sender.close()
  await recipient.close()
})

test('/monitor abort releases the waiter so cancelAll isn\'t stuck on shutdown', async () => {
  // This test primarily guards against a regression where /monitor leaks
  // waiters — if the AbortSignal wasn't wired through, handle.stop() in
  // afterEach would hang. We just exercise open+close.
  const recipient = await makeClient('mon-abort')
  await recipient.callTool({
    name: 'register',
    arguments: { role: 'mon-abort', cc_session_id: 'cc-mon-abort' },
  })

  const controller = new AbortController()
  const resp = await fetch(`${MONITOR_URL}?cc_session_id=cc-mon-abort`, {
    signal: controller.signal,
  })
  expect(resp.status).toBe(200)

  // read first line then abort
  const reader = resp.body!.getReader()
  const { value } = await reader.read()
  expect(new TextDecoder().decode(value)).toContain('hello mon-abort')
  controller.abort()

  await recipient.close()
})

// --- local external sender endpoint ---

const EXTERNAL_SEND_URL = `http://127.0.0.1:${TEST_PORT}/external/send`
const REGISTER_URL = `http://127.0.0.1:${TEST_PORT}/register`
const UNREGISTER_URL = `http://127.0.0.1:${TEST_PORT}/unregister`

test('/external/send delivers and wakes a registered Claude Code session', async () => {
  const recipient = await makeClient('external-recip')
  await recipient.callTool({
    name: 'register',
    arguments: { role: 'external-rcp', cc_session_id: 'cc-external-rcp' },
  })

  const pollPromise = fetch(`${POLL_URL}?cc_session_id=cc-external-rcp&timeout_s=5`)
  await new Promise((r) => setTimeout(r, 80))

  const sendResp = await fetch(EXTERNAL_SEND_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from: 'codex',
      to: 'external-rcp',
      message: 'Codex job completed. job_id=abc',
    }),
  })
  expect(sendResp.status).toBe(200)
  const sendBody = await sendResp.json()
  expect(typeof sendBody.message_id).toBe('string')
  expect(sendBody.delivered_notification).toBe(true)

  const pollResp = await pollPromise
  const pollBody = await pollResp.json()
  expect(pollBody.status).toBe('unread')

  const readResult = await recipient.callTool({ name: 'read_messages', arguments: {} })
  const readParsed = JSON.parse((readResult.content as any[])[0].text)
  expect(readParsed.messages).toHaveLength(1)
  expect(readParsed.messages[0].content).toContain('job_id=abc')
  expect(readParsed.messages[0].sender_alias).toBe('codex')

  await recipient.close()
})

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('HTTP register upserts active and released peer sessions with increasing generation', async () => {
  const firstResp = await postJson(REGISTER_URL, {
    alias: 'http-codex-one',
    client_kind: 'codex',
    client_session_id: 'codex-thread-1',
    cwd: '/workspace/one',
  })
  expect(firstResp.status).toBe(200)
  const first = await firstResp.json()
  expect(first).toEqual({
    session_id: expect.any(String),
    alias: 'http-codex-one',
    generation: 1,
  })

  const secondResp = await postJson(REGISTER_URL, {
    alias: 'http-codex-two',
    client_kind: 'codex',
    client_session_id: 'codex-thread-1',
    cwd: '/workspace/two',
  })
  expect(secondResp.status).toBe(200)
  const second = await secondResp.json()
  expect(second).toEqual({
    session_id: first.session_id,
    alias: 'http-codex-two',
    generation: 2,
  })

  const releaseResp = await postJson(UNREGISTER_URL, {
    client_kind: 'codex',
    client_session_id: 'codex-thread-1',
    generation: second.generation,
  })
  expect(releaseResp.status).toBe(200)
  expect(await releaseResp.json()).toEqual({ status: 'released' })

  const thirdResp = await postJson(REGISTER_URL, {
    alias: 'http-codex-three',
    client_kind: 'codex',
    client_session_id: 'codex-thread-1',
    cwd: '/workspace/three',
  })
  expect(thirdResp.status).toBe(200)
  const third = await thirdResp.json()
  expect(third).toEqual({
    session_id: first.session_id,
    alias: 'http-codex-three',
    generation: 3,
  })
})

test('HTTP unregister rejects stale generation without killing the current instance', async () => {
  const first = await (await postJson(REGISTER_URL, {
    alias: 'stale-token-one',
    client_kind: 'external',
    client_session_id: 'external-thread-1',
    cwd: '/workspace',
  })).json()
  const current = await (await postJson(REGISTER_URL, {
    alias: 'stale-token-current',
    client_kind: 'external',
    client_session_id: 'external-thread-1',
    cwd: '/workspace',
  })).json()

  const staleResp = await postJson(UNREGISTER_URL, {
    client_kind: 'external',
    client_session_id: 'external-thread-1',
    generation: first.generation,
  })
  expect(staleResp.status).toBe(409)
  expect(await staleResp.json()).toEqual({
    error: 'generation mismatch: current generation is 2',
  })

  const currentResp = await postJson(UNREGISTER_URL, {
    client_kind: 'external',
    client_session_id: 'external-thread-1',
    generation: current.generation,
  })
  expect(currentResp.status).toBe(200)
  expect(await currentResp.json()).toEqual({ status: 'released' })
})

test('HTTP register reports an active alias conflict', async () => {
  await postJson(REGISTER_URL, {
    alias: 'http-taken-alias',
    client_kind: 'codex',
    client_session_id: 'alias-owner',
    cwd: '/workspace',
  })

  const conflictResp = await postJson(REGISTER_URL, {
    alias: 'http-taken-alias',
    client_kind: 'external',
    client_session_id: 'alias-contender',
    cwd: '/workspace',
  })
  expect(conflictResp.status).toBe(409)
  expect(await conflictResp.json()).toEqual({
    error: 'alias already taken: http-taken-alias',
  })
})

test('HTTP register validates JSON, required fields, and client_kind', async () => {
  const invalidJson = await fetch(REGISTER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  })
  expect(invalidJson.status).toBe(400)
  expect(await invalidJson.json()).toEqual({ error: 'invalid JSON body' })

  const invalidCases: Array<{ body: unknown; error: string }> = [
    { body: [], error: 'request body must be a JSON object' },
    {
      body: { client_kind: 'codex', client_session_id: 'thread', cwd: '/workspace' },
      error: 'alias is required and must be a non-empty string',
    },
    {
      body: { alias: 'peer', client_kind: 'other', client_session_id: 'thread', cwd: '/workspace' },
      error: 'client_kind must be one of: claude_code, codex, external',
    },
    {
      body: { alias: 'peer', client_session_id: 'thread', cwd: '/workspace' },
      error: 'client_kind must be one of: claude_code, codex, external',
    },
    {
      body: { alias: 'peer', client_kind: 'codex', client_session_id: '   ', cwd: '/workspace' },
      error: 'client_session_id is required and must be a non-empty string',
    },
    {
      body: { alias: 'peer', client_kind: 'codex', client_session_id: 'thread', cwd: '' },
      error: 'cwd is required and must be a non-empty string',
    },
  ]

  for (const invalidCase of invalidCases) {
    const resp = await postJson(REGISTER_URL, invalidCase.body)
    expect(resp.status).toBe(400)
    expect(await resp.json()).toEqual({ error: invalidCase.error })
  }
})

test('HTTP unregister validates identity and generation fields', async () => {
  const invalidCases: Array<{ body: unknown; error: string }> = [
    {
      body: { client_kind: 'other', client_session_id: 'thread', generation: 1 },
      error: 'client_kind must be one of: claude_code, codex, external',
    },
    {
      body: { client_kind: 'codex', client_session_id: '', generation: 1 },
      error: 'client_session_id is required and must be a non-empty string',
    },
    {
      body: { client_kind: 'codex', client_session_id: 'thread', generation: 0 },
      error: 'generation is required and must be a positive integer',
    },
    {
      body: { client_kind: 'codex', client_session_id: 'thread' },
      error: 'generation is required and must be a positive integer',
    },
    {
      body: { client_kind: 'codex', client_session_id: 'thread', generation: 1.5 },
      error: 'generation is required and must be a positive integer',
    },
  ]

  for (const invalidCase of invalidCases) {
    const resp = await postJson(UNREGISTER_URL, invalidCase.body)
    expect(resp.status).toBe(400)
    expect(await resp.json()).toEqual({ error: invalidCase.error })
  }
})
