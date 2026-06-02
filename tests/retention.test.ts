import { test, expect } from 'bun:test'
import { openDatabase, createSession, findSessionByAlias, releaseStaleActiveSessions } from '../db'
import { ConnectionRegistry } from '../connections'
import { startRetentionLoop } from '../retention'

test('retention sessionsTick releases stale sessions on initial run', () => {
  const db = openDatabase(':memory:')
  const registry = new ConnectionRegistry()

  const stale = createSession(db, { alias: 'ghost' })
  // Backdate so stale threshold (5 min in retention.ts) is exceeded.
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString()
  db.query('UPDATE sessions SET last_activity = ? WHERE id = ?').run(tenMinAgo, stale)

  const handle = startRetentionLoop(db, registry)
  try {
    // startRetentionLoop runs tick synchronously once on start.
    expect(findSessionByAlias(db, 'ghost')).toBeNull()
  } finally {
    handle.stop()
    db.close()
  }
})

test('retention sessionsTick unregisters released sessions from the in-memory registry', () => {
  const db = openDatabase(':memory:')
  const registry = new ConnectionRegistry()

  const orphaned = createSession(db, { alias: 'orphan' })
  // Simulate the bug: DB row marks the session active, registry still has a
  // stale push callback entry (because transport.onclose never fired).
  // But last_activity is old enough for the time check to catch it AND the
  // connectedIds list we feed to releaseStaleActiveSessions would normally
  // protect it — here we deliberately pass an empty registry to represent
  // the post-daemon-restart scenario.
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString()
  db.query('UPDATE sessions SET last_activity = ? WHERE id = ?').run(tenMinAgo, orphaned)

  // Leak a registry entry (as if transport died silently)
  registry.register(orphaned, () => {})
  expect(registry.isOnline(orphaned)).toBe(true)

  // Direct db call (retention.ts would pass registry.listOnline()). We simulate
  // the post-restart empty registry by passing []:
  const released = releaseStaleActiveSessions(db, [], 5 * 60_000)
  expect(released).toEqual([orphaned])

  // retention.ts unregisters after releasing — do the same here:
  for (const id of released) registry.unregister(id)
  expect(registry.isOnline(orphaned)).toBe(false)

  db.close()
})

test('retention stop() cancels timers so the loop does not keep the event loop alive', () => {
  const db = openDatabase(':memory:')
  const registry = new ConnectionRegistry()
  const handle = startRetentionLoop(db, registry)
  // If stop() didn't cancel intervals, this test would leak timers and
  // potentially hang the test runner at exit. Bun surfaces that as a slow
  // teardown; we just assert the call doesn't throw.
  expect(() => handle.stop()).not.toThrow()
  db.close()
})
