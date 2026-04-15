import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDatabase, createSession, insertMessage } from '../db'
import {
  claimLeadership,
  isStillLeader,
  countUnread,
  runPoller,
  type PollerConfig,
} from '../poller'

let db: Database
let tmpDir: string
let dbPath: string
let stateFile: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'switchboard-poller-test-'))
  dbPath = join(tmpDir, 'test.db')
  stateFile = join(tmpDir, 'poller.state')
  db = openDatabase(dbPath)
})

afterEach(() => {
  try { db.close() } catch {}
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeConfig(overrides: Partial<PollerConfig> = {}): PollerConfig {
  return {
    role: 'test-role',
    dbPath,
    stateFilePath: stateFile,
    pollIntervalMs: 10,
    ttlMs: 5_000,
    ownPid: 9999,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...overrides,
  }
}

// ─── Leadership tests ───────────────────────────────────────────────────────

test('claimLeadership writes state file with own pid', () => {
  const config = makeConfig()
  claimLeadership(config)
  expect(existsSync(stateFile)).toBe(true)
  const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
  expect(parsed.pid).toBe(9999)
  expect(parsed.role).toBe('test-role')
  expect(typeof parsed.started_at).toBe('string')
})

test('isStillLeader returns true when state pid matches own pid', () => {
  const config = makeConfig()
  claimLeadership(config)
  expect(isStillLeader(config)).toBe(true)
})

test('isStillLeader returns false when state file holds different pid', () => {
  const config1 = makeConfig({ ownPid: 1111 })
  claimLeadership(config1)
  const config2 = makeConfig({ ownPid: 2222 })
  expect(isStillLeader(config2)).toBe(false)
})

test('isStillLeader returns false when state file missing', () => {
  const config = makeConfig()
  // no claimLeadership
  expect(isStillLeader(config)).toBe(false)
})

// ─── countUnread tests ───────────────────────────────────────────────────────

test('countUnread returns 0 when no messages', () => {
  createSession(db, { alias: 'test-role' })
  db.close()
  // Re-open for direct query
  const readDb = new Database(dbPath, { readonly: true })
  expect(countUnread(readDb, 'test-role')).toBe(0)
  readDb.close()
})

test('countUnread returns unread count for matching alias, ignores other roles', () => {
  const sender = createSession(db, { alias: 'sender' })
  const recipient = createSession(db, { alias: 'test-role' })
  const bystander = createSession(db, { alias: 'other-role' })
  insertMessage(db, { sender_id: sender, recipient_id: recipient, broadcast_id: null, content: 'hi1' })
  insertMessage(db, { sender_id: sender, recipient_id: recipient, broadcast_id: null, content: 'hi2' })
  insertMessage(db, { sender_id: sender, recipient_id: bystander, broadcast_id: null, content: 'not mine' })
  db.close()
  const readDb = new Database(dbPath, { readonly: true })
  expect(countUnread(readDb, 'test-role')).toBe(2)
  expect(countUnread(readDb, 'other-role')).toBe(1)
  expect(countUnread(readDb, 'nonexistent')).toBe(0)
  readDb.close()
})

// ─── runPoller tests ─────────────────────────────────────────────────────────

test('runPoller exits 2 with SWITCHBOARD INBOX message when unread > 0', async () => {
  const sender = createSession(db, { alias: 'sender' })
  const recipient = createSession(db, { alias: 'test-role' })
  insertMessage(db, { sender_id: sender, recipient_id: recipient, broadcast_id: null, content: 'wake up' })
  db.close()

  const config = makeConfig()
  const result = await runPoller(config)
  expect(result.exitCode).toBe(2)
  expect(result.message).toContain('SWITCHBOARD INBOX')
  expect(result.message).toContain('1 unread')
  expect(result.message).toContain('test-role')
})

test('runPoller exits 0 when TTL reached with no unread messages', async () => {
  createSession(db, { alias: 'test-role' })
  db.close()

  // Fast clock: each call to now() advances 500ms, TTL 100ms → exit within 1 iteration
  let fakeTime = 0
  const config = makeConfig({
    ttlMs: 100,
    pollIntervalMs: 1,
    now: () => { fakeTime += 500; return fakeTime },
  })
  const result = await runPoller(config)
  expect(result.exitCode).toBe(0)
  expect(result.message).toBeUndefined()
})

test('runPoller exits 0 when superseded by another poller mid-sleep', async () => {
  createSession(db, { alias: 'test-role' })
  db.close()

  const config = makeConfig({
    ownPid: 1111,
    ttlMs: 30_000,
    sleep: async (ms) => {
      // During the first sleep, another poller "takes over" by writing the state file
      const otherState = JSON.stringify({
        pid: 2222,
        role: 'test-role',
        started_at: new Date().toISOString(),
      })
      writeFileSync(stateFile, otherState, 'utf8')
      return new Promise((r) => setTimeout(r, ms))
    },
  })
  const result = await runPoller(config)
  expect(result.exitCode).toBe(0)
  expect(result.message).toBeUndefined()
})
