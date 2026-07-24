import { expect, test } from 'bun:test'
import { ConnectionRegistry } from '../connections'
import { isSessionOnline, LEASE_TTL_MS } from '../online'
import type { SessionRow } from '../types'
import { UnreadWaiterRegistry } from '../waiters'

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'session-id',
    alias: 'peer',
    client_kind: 'codex',
    client_session_id: 'client-id',
    cwd: null,
    created_at: '2026-07-24T00:00:00.000Z',
    last_activity: '2026-07-24T00:00:00.000Z',
    last_seen_at: null,
    generation: 1,
    released_at: null,
    ...overrides,
  }
}

test('session is online while its MCP connection is active', () => {
  const registry = new ConnectionRegistry()
  const waiters = new UnreadWaiterRegistry()
  registry.register('session-id', () => {})

  expect(isSessionOnline(session(), registry, waiters)).toBe(true)
})

test('session is online while its kind-qualified identity is polling', async () => {
  const registry = new ConnectionRegistry()
  const waiters = new UnreadWaiterRegistry()
  const abort = new AbortController()
  const waiting = waiters.wait('session-id', 'codex', 'client-id', 60_000, abort.signal)

  expect(isSessionOnline(session(), registry, waiters)).toBe(true)
  expect(isSessionOnline(session({ client_kind: 'claude_code' }), registry, waiters)).toBe(false)

  abort.abort()
  await waiting
})

test('session is online until its lease TTL expires', () => {
  const registry = new ConnectionRegistry()
  const waiters = new UnreadWaiterRegistry()
  const now = Date.parse('2026-07-24T12:00:00.000Z')

  expect(isSessionOnline(
    session({ last_seen_at: new Date(now - LEASE_TTL_MS + 1).toISOString() }),
    registry,
    waiters,
    now,
  )).toBe(true)
  expect(isSessionOnline(
    session({ last_seen_at: new Date(now - LEASE_TTL_MS).toISOString() }),
    registry,
    waiters,
    now,
  )).toBe(false)
})

test('released and unidentified sessions are offline without a live MCP connection', () => {
  const registry = new ConnectionRegistry()
  const waiters = new UnreadWaiterRegistry()
  const now = Date.parse('2026-07-24T12:00:00.000Z')
  const freshLease = new Date(now - 1_000).toISOString()

  expect(isSessionOnline(session({ released_at: freshLease, last_seen_at: freshLease }), registry, waiters, now)).toBe(false)
  expect(isSessionOnline(session({ client_session_id: null, last_seen_at: freshLease }), registry, waiters, now)).toBe(false)
})
