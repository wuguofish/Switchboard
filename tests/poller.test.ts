import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDatabase, createSession, insertMessage } from '../db'
import {
  claimLeadership,
  isStillLeader,
  countUnread,
  runPoller,
  loadConfigFromHookStdin,
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
  try {
    db.close()
  } catch {}
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeConfig(overrides: Partial<PollerConfig> = {}): PollerConfig {
  return {
    ccSessionId: 'cc-test-session',
    alias: 'test-role',
    sessionId: 'sw-sess-id',
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

test('claimLeadership writes state file with own pid + cc_session_id', () => {
  const config = makeConfig()
  claimLeadership(config)
  expect(existsSync(stateFile)).toBe(true)
  const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
  expect(parsed.pid).toBe(9999)
  expect(parsed.cc_session_id).toBe('cc-test-session')
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
  expect(isStillLeader(config)).toBe(false)
})

test('countUnread returns 0 when no messages', () => {
  createSession(db, { alias: 'test-role', cc_session_id: 'cc-test-session' })
  db.close()
  const readDb = new Database(dbPath, { readonly: true })
  expect(countUnread(readDb, 'test-role')).toBe(0)
  readDb.close()
})

test('countUnread returns unread count for matching alias', () => {
  const sender = createSession(db, { alias: 'sender', cc_session_id: 'cc-s' })
  const recipient = createSession(db, { alias: 'test-role', cc_session_id: 'cc-r' })
  const bystander = createSession(db, { alias: 'other-role', cc_session_id: 'cc-b' })
  insertMessage(db, {
    sender_id: sender,
    recipient_id: recipient,
    broadcast_id: null,
    content: 'hi1',
  })
  insertMessage(db, {
    sender_id: sender,
    recipient_id: recipient,
    broadcast_id: null,
    content: 'hi2',
  })
  insertMessage(db, {
    sender_id: sender,
    recipient_id: bystander,
    broadcast_id: null,
    content: 'not mine',
  })
  db.close()
  const readDb = new Database(dbPath, { readonly: true })
  expect(countUnread(readDb, 'test-role')).toBe(2)
  expect(countUnread(readDb, 'other-role')).toBe(1)
  expect(countUnread(readDb, 'nonexistent')).toBe(0)
  readDb.close()
})

test('runPoller exits 2 with SWITCHBOARD INBOX message when unread > 0', async () => {
  const sender = createSession(db, { alias: 'sender', cc_session_id: 'cc-s' })
  const recipient = createSession(db, { alias: 'test-role', cc_session_id: 'cc-test-session' })
  insertMessage(db, {
    sender_id: sender,
    recipient_id: recipient,
    broadcast_id: null,
    content: 'wake up',
  })
  db.close()

  const config = makeConfig({ sessionId: recipient })
  const result = await runPoller(config)
  expect(result.exitCode).toBe(2)
  expect(result.message).toContain('SWITCHBOARD INBOX')
  expect(result.message).toContain('1 unread')
  expect(result.message).toContain('test-role')
})

test('runPoller exits 0 when TTL reached with no unread', async () => {
  createSession(db, { alias: 'test-role', cc_session_id: 'cc-test-session' })
  db.close()
  let fakeTime = 0
  const config = makeConfig({
    ttlMs: 100,
    pollIntervalMs: 1,
    now: () => {
      fakeTime += 500
      return fakeTime
    },
  })
  const result = await runPoller(config)
  expect(result.exitCode).toBe(0)
  expect(result.message).toBeUndefined()
})

test('runPoller exits 0 when superseded mid-sleep', async () => {
  createSession(db, { alias: 'test-role', cc_session_id: 'cc-test-session' })
  db.close()
  const config = makeConfig({
    ownPid: 1111,
    ttlMs: 30_000,
    sleep: async (ms) => {
      const otherState = JSON.stringify({
        pid: 2222,
        cc_session_id: 'cc-test-session',
        started_at: new Date().toISOString(),
      })
      writeFileSync(stateFile, otherState, 'utf8')
      return new Promise((r) => setTimeout(r, ms))
    },
  })
  const result = await runPoller(config)
  expect(result.exitCode).toBe(0)
})

test('loadConfigFromHookStdin resolves alias via cc_session_id lookup', () => {
  const id = createSession(db, { alias: 'lookup-role', cc_session_id: 'cc-lookup' })
  db.close()

  const input = JSON.stringify({ session_id: 'cc-lookup' })
  const config = loadConfigFromHookStdin(input, {
    dbPath,
    stateFileDir: tmpDir,
  })
  expect(config).not.toBeNull()
  expect(config?.ccSessionId).toBe('cc-lookup')
  expect(config?.alias).toBe('lookup-role')
  expect(config?.sessionId).toBe(id)
  expect(config?.stateFilePath).toContain('cc-lookup')
})

test('loadConfigFromHookStdin returns null when session has not registered yet', () => {
  db.close()
  const input = JSON.stringify({ session_id: 'cc-never-registered' })
  const config = loadConfigFromHookStdin(input, {
    dbPath,
    stateFileDir: tmpDir,
  })
  expect(config).toBeNull()
})

test('loadConfigFromHookStdin returns null when session row has no alias', () => {
  createSession(db, { alias: null, cc_session_id: 'cc-anon' })
  db.close()
  const input = JSON.stringify({ session_id: 'cc-anon' })
  const config = loadConfigFromHookStdin(input, {
    dbPath,
    stateFileDir: tmpDir,
  })
  expect(config).toBeNull()
})

test('loadConfigFromHookStdin returns null when stdin has no session_id field', () => {
  db.close()
  const config = loadConfigFromHookStdin('{}', {
    dbPath,
    stateFileDir: tmpDir,
  })
  expect(config).toBeNull()
})

test('loadConfigFromHookStdin returns null for released session row', () => {
  const id = createSession(db, { alias: 'will-release', cc_session_id: 'cc-rel' })
  db.query(`UPDATE sessions SET alias = NULL, released_at = ? WHERE id = ?`).run(
    '2026-04-16T00:00:00Z',
    id,
  )
  db.close()

  const input = JSON.stringify({ session_id: 'cc-rel' })
  const config = loadConfigFromHookStdin(input, {
    dbPath,
    stateFileDir: tmpDir,
  })
  expect(config).toBeNull()
})
