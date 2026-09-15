import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findInboxSocket, inboxFrames, inboxWakeText, postInboxFrames, wakeInboxSocket } from '../inbox-socket'

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sb-sessions-'))
  writeFileSync(join(dir, '4242.json'), JSON.stringify({
    pid: 4242, sessionId: 'cc-4242', version: '2.1.272', peerProtocol: 1,
    messagingSocketPath: '/run/user/1000/cc-socks/4242.sock', name: 'worker',
  }))
  writeFileSync(join(dir, '4242.abcdef.key'), JSON.stringify({ peerToken: 'tok-4242', procStart: '1' }))
  writeFileSync(join(dir, '9999.json'), JSON.stringify({
    pid: 9999, sessionId: 'cc-9999', version: '3.0.0', peerProtocol: 2,
    messagingSocketPath: '/run/user/1000/cc-socks/9999.sock',
  }))
  writeFileSync(join(dir, 'junk.json'), 'not json')
  return dir
}

describe('findInboxSocket', () => {
  test('resolves socket path and peer token by Claude Code session id', () => {
    const inbox = findInboxSocket('cc-4242', fixtureDir())
    expect(inbox).toEqual({
      socketPath: '/run/user/1000/cc-socks/4242.sock', pid: 4242, token: 'tok-4242', peerProtocol: 1, version: '2.1.272',
    })
  })

  test('returns null for unknown sessions and missing directories', () => {
    expect(findInboxSocket('cc-nope', fixtureDir())).toBeNull()
    expect(findInboxSocket('cc-4242', '/nonexistent/sessions')).toBeNull()
  })

  test('token is null when no key file exists', () => {
    expect(findInboxSocket('cc-9999', fixtureDir())?.token).toBeNull()
  })
})

describe('frames', () => {
  test('auth line precedes the user frame when a token is known', () => {
    const lines = inboxFrames('hi', 'tok').trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual([
      { type: 'auth', token: 'tok' },
      { type: 'user', message: { role: 'user', content: 'hi' } },
    ])
  })

  test('no auth line without a token', () => {
    expect(inboxFrames('hi', null)).toBe('{"type":"user","message":{"role":"user","content":"hi"}}\n')
  })

  test('wake text names the alias and the tool to call', () => {
    expect(inboxWakeText(2, 'worker')).toContain('2 unread')
    expect(inboxWakeText(2, 'worker')).toContain('read_messages')
  })
})

describe('delivery', () => {
  test('writes both lines to a listening unix socket', async () => {
    const sockPath = join(mkdtempSync(join(tmpdir(), 'sb-sock-')), 'inbox.sock')
    let received = ''
    const server = Bun.listen({ unix: sockPath, socket: { data(_s, chunk) { received += chunk.toString() } } })
    const ok = await postInboxFrames(sockPath, inboxFrames('ping', 'tok'))
    // The listener's data callback runs after the client has already closed.
    for (let i = 0; i < 50 && received.split('\n').filter(Boolean).length < 2; i++) {
      await Bun.sleep(10)
    }
    server.stop()
    expect(ok).toBe(true)
    expect(received.split('\n').filter(Boolean)).toHaveLength(2)
  })

  test('reports a refused connection instead of throwing', async () => {
    expect(await postInboxFrames('/nonexistent/inbox.sock', 'x\n')).toBe(false)
  })

  test('wakeInboxSocket refuses an unverified peer protocol', async () => {
    const result = await wakeInboxSocket('cc-9999', 'x', fixtureDir())
    expect(result.delivered).toBe(false)
    expect(result.reason).toContain('peerProtocol 2')
  })
})
