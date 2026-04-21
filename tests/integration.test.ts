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
  // Phase 1 recipient (registered without cc_session_id) has no poller
  // process, so delivered_notification is false — the message still lands
  // in the DB and shows up on read_messages below, which is the real
  // correctness signal. See poller.isPollerAlive for the semantics.
  expect(sendParsed.delivered_notification).toBe(false)

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

// --- /poll long-polling endpoint ---

const POLL_URL = `http://127.0.0.1:${TEST_PORT}/poll`

test('/poll returns no-session when cc_session_id is unknown', async () => {
  const resp = await fetch(`${POLL_URL}?cc_session_id=cc-never-registered&timeout_s=1`)
  expect(resp.status).toBe(200)
  const body = await resp.json()
  expect(body.status).toBe('no-session')
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

test('delivered_notification is false when only a legacy state file exists (no live /poll)', async () => {
  // Regression: canAutoWake used to also trust poller.ts's state file, so a
  // stale file whose pid had been reused as an unrelated process would make
  // delivered_notification falsely report true. The shim does not write
  // state files, so we now only trust waiters.isPolling. This test guards
  // against re-introducing the fallback.
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-statefile-'))
  try {
    // Stash a state file pointing at our own (live) pid — the old code path
    // would accept this as "alive".
    const ccSessionId = 'cc-legacy-statefile-only'
    const stateFile = path.join(tmpDir, `switchboard-poller-${ccSessionId}.state`)
    fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, cc_session_id: ccSessionId, started_at: new Date().toISOString() }))

    const recipient = await makeClient('legacy-statefile-recip')
    await recipient.callTool({
      name: 'register',
      arguments: { role: 'legacy-rcp', cc_session_id: ccSessionId },
    })

    const sender = await makeClient('legacy-statefile-sender')
    await sender.callTool({ name: 'register', arguments: { role: 'legacy-snd' } })
    const sendResult = JSON.parse(((await sender.callTool({
      name: 'send',
      arguments: { to: 'legacy-rcp', message: 'legacy mode' },
    })).content as any[])[0].text)
    expect(sendResult.delivered_notification).toBe(false)

    await sender.close()
    await recipient.close()
  } finally {
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
