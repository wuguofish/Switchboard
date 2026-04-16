import { test, expect, beforeEach, afterEach } from 'bun:test'
import { unlinkSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { openDatabase, createSession, findSessionById, findSessionByAlias, findSessionByCcSessionId, releaseSession, updateLastActivity, insertMessage, fetchUnreadForRecipient, markMessagesRead, insertBroadcast, recallMessage, listAllSessions, deleteExpiredMessages } from '../db'

const TEST_DB = ':memory:'
let db: Database

beforeEach(() => {
  db = openDatabase(TEST_DB)
})

afterEach(() => {
  db.close()
})

test('openDatabase creates schema', () => {
  const tables = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all()
  expect(tables.map(t => t.name)).toEqual(['messages', 'sessions'])
})

test('createSession inserts row', () => {
  const id = createSession(db, { alias: 'line' })
  expect(typeof id).toBe('string')
  expect(id.length).toBeGreaterThan(10)
})

test('findSessionByAlias returns inserted row', () => {
  const id = createSession(db, { alias: 'line' })
  const row = findSessionByAlias(db, 'line')
  expect(row?.id).toBe(id)
  expect(row?.alias).toBe('line')
})

test('findSessionByAlias returns null for missing alias', () => {
  expect(findSessionByAlias(db, 'ghost')).toBeNull()
})

test('createSession with null alias creates anonymous session', () => {
  const id = createSession(db, { alias: null })
  const row = findSessionById(db, id)
  expect(row?.alias).toBeNull()
})

test('updateLastActivity changes last_activity but not created_at', async () => {
  const id = createSession(db, { alias: null })
  const before = findSessionById(db, id)!
  await new Promise(r => setTimeout(r, 10))  // ensure time moves
  updateLastActivity(db, id)
  const after = findSessionById(db, id)!
  expect(after.created_at).toBe(before.created_at)
  expect(after.last_activity > before.last_activity).toBe(true)
})

test('insertMessage + fetchUnread round trip (1-to-1)', () => {
  const alice = createSession(db, { alias: 'alice' })
  const bob = createSession(db, { alias: 'bob' })
  const msgId = insertMessage(db, {
    sender_id: alice,
    recipient_id: bob,
    broadcast_id: null,
    content: 'hi bob'
  })
  expect(typeof msgId).toBe('string')

  const unread = fetchUnreadForRecipient(db, bob)
  expect(unread).toHaveLength(1)
  expect(unread[0].content).toBe('hi bob')
  expect(unread[0].sender_id).toBe(alice)
  expect(unread[0].broadcast_id).toBeNull()
})

test('fetchUnread does not return messages for other recipients', () => {
  const a = createSession(db, { alias: 'a' })
  const b = createSession(db, { alias: 'b' })
  const c = createSession(db, { alias: 'c' })
  insertMessage(db, { sender_id: a, recipient_id: b, broadcast_id: null, content: 'for b' })
  const cMessages = fetchUnreadForRecipient(db, c)
  expect(cMessages).toHaveLength(0)
})

test('markMessagesRead marks only the given IDs', () => {
  const a = createSession(db, { alias: 'a' })
  const b = createSession(db, { alias: 'b' })
  const id1 = insertMessage(db, { sender_id: a, recipient_id: b, broadcast_id: null, content: 'm1' })
  const id2 = insertMessage(db, { sender_id: a, recipient_id: b, broadcast_id: null, content: 'm2' })

  markMessagesRead(db, [id1])

  const unread = fetchUnreadForRecipient(db, b)
  expect(unread.map(m => m.id)).toEqual([id2])
})

test('fetchUnread excludes already-read messages', () => {
  const a = createSession(db, { alias: 'a' })
  const b = createSession(db, { alias: 'b' })
  const id = insertMessage(db, { sender_id: a, recipient_id: b, broadcast_id: null, content: 'x' })
  markMessagesRead(db, [id])
  expect(fetchUnreadForRecipient(db, b)).toHaveLength(0)
})

test('insertBroadcast fans out to all sessions except sender', () => {
  const sender = createSession(db, { alias: 'sender' })
  const r1 = createSession(db, { alias: 'r1' })
  const r2 = createSession(db, { alias: 'r2' })

  const result = insertBroadcast(db, { sender_id: sender, content: 'hello all' })

  expect(result.recipient_count).toBe(2)
  expect(result.broadcast_id).toBeTruthy()

  const r1Msgs = fetchUnreadForRecipient(db, r1)
  const r2Msgs = fetchUnreadForRecipient(db, r2)
  const senderMsgs = fetchUnreadForRecipient(db, sender)

  expect(r1Msgs).toHaveLength(1)
  expect(r2Msgs).toHaveLength(1)
  expect(senderMsgs).toHaveLength(0)
  expect(r1Msgs[0].broadcast_id).toBe(result.broadcast_id)
  expect(r1Msgs[0].broadcast_id).toBe(r2Msgs[0].broadcast_id)
})

test('insertBroadcast with no other sessions returns zero recipient_count', () => {
  const sender = createSession(db, { alias: 'only' })
  const result = insertBroadcast(db, { sender_id: sender, content: 'lonely' })
  expect(result.recipient_count).toBe(0)
})

test('recallMessage deletes 1-to-1 message when caller is sender', () => {
  const a = createSession(db, { alias: 'a' })
  const b = createSession(db, { alias: 'b' })
  const id = insertMessage(db, { sender_id: a, recipient_id: b, broadcast_id: null, content: 'oops' })
  const recalled = recallMessage(db, { message_id: id, caller_id: a })
  expect(recalled).toBe(1)
  expect(fetchUnreadForRecipient(db, b)).toHaveLength(0)
})

test('recallMessage throws when caller is not sender', () => {
  const a = createSession(db, { alias: 'a' })
  const b = createSession(db, { alias: 'b' })
  const id = insertMessage(db, { sender_id: a, recipient_id: b, broadcast_id: null, content: 'x' })
  expect(() => recallMessage(db, { message_id: id, caller_id: b }))
    .toThrow(/not the sender/)
})

test('recallMessage on broadcast deletes all copies', () => {
  const sender = createSession(db, { alias: 's' })
  const r1 = createSession(db, { alias: 'r1' })
  const r2 = createSession(db, { alias: 'r2' })
  const { broadcast_id } = insertBroadcast(db, { sender_id: sender, content: 'group' })
  const oneCopy = fetchUnreadForRecipient(db, r1)[0]

  const recalled = recallMessage(db, { message_id: oneCopy.id, caller_id: sender })

  expect(recalled).toBe(2)  // both copies
  expect(fetchUnreadForRecipient(db, r1)).toHaveLength(0)
  expect(fetchUnreadForRecipient(db, r2)).toHaveLength(0)
})

test('recallMessage on missing message returns 0 (idempotent)', () => {
  const a = createSession(db, { alias: 'a' })
  const recalled = recallMessage(db, { message_id: 'nonexistent-id', caller_id: a })
  expect(recalled).toBe(0)
})

test('listAllSessions returns all registered sessions', () => {
  createSession(db, { alias: 'a' })
  createSession(db, { alias: 'b' })
  createSession(db, { alias: null })  // anonymous
  const all = listAllSessions(db)
  expect(all).toHaveLength(3)
})

test('deleteExpiredMessages removes read messages older than 7 days', () => {
  const a = createSession(db, { alias: 'a' })
  const b = createSession(db, { alias: 'b' })

  // Insert a message and force it read_at = 8 days ago
  const id = insertMessage(db, { sender_id: a, recipient_id: b, broadcast_id: null, content: 'old' })
  const eightDaysAgo = new Date(Date.now() - 8 * 86400_000).toISOString()
  db.query('UPDATE messages SET read_at = ? WHERE id = ?').run(eightDaysAgo, id)

  // Fresh unread message — should survive
  const freshId = insertMessage(db, { sender_id: a, recipient_id: b, broadcast_id: null, content: 'new' })

  const deleted = deleteExpiredMessages(db)
  expect(deleted).toBe(1)

  const remaining = db.query<{ id: string }, []>('SELECT id FROM messages').all()
  expect(remaining.map(r => r.id)).toEqual([freshId])
})

test('deleteExpiredMessages keeps unread messages regardless of age', () => {
  const a = createSession(db, { alias: 'a' })
  const b = createSession(db, { alias: 'b' })
  const id = insertMessage(db, { sender_id: a, recipient_id: b, broadcast_id: null, content: 'old unread' })
  // Force created_at way back (read_at still NULL)
  const longAgo = new Date(Date.now() - 100 * 86400_000).toISOString()
  db.query('UPDATE messages SET created_at = ? WHERE id = ?').run(longAgo, id)

  deleteExpiredMessages(db)
  const remaining = db.query<{ id: string }, []>('SELECT id FROM messages').all()
  expect(remaining).toHaveLength(1)
})

test('openDatabase drops old Phase 1 sessions table if cc_session_id column missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'switchboard-migration-'))
  const dbPath = join(tmp, 'phase1.db')

  const rawDb = new Database(dbPath)
  rawDb.exec(`
    CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        alias TEXT UNIQUE,
        created_at TEXT NOT NULL,
        last_activity TEXT NOT NULL
    );
    CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        broadcast_id TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT
    );
  `)
  rawDb.exec(`INSERT INTO sessions (id, alias, created_at, last_activity) VALUES ('old-id', 'old-alias', '2026-04-16T00:00:00Z', '2026-04-16T00:00:00Z')`)
  rawDb.close()

  const db = openDatabase(dbPath)
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(sessions)`).all()
  const colNames = cols.map((c) => c.name)
  expect(colNames).toContain('cc_session_id')
  expect(colNames).toContain('released_at')
  const rows = db.query('SELECT id FROM sessions').all()
  expect(rows).toHaveLength(0)
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('createSession accepts optional cc_session_id', () => {
  const db = openDatabase(':memory:')
  const id = createSession(db, { alias: 'my-role', cc_session_id: 'cc-abc-123' })
  const row = db
    .query<{ id: string; cc_session_id: string | null }, [string]>(
      `SELECT id, cc_session_id FROM sessions WHERE id = ?`,
    )
    .get(id)
  expect(row?.cc_session_id).toBe('cc-abc-123')
  db.close()
})

test('findSessionByCcSessionId returns active row only', () => {
  const db = openDatabase(':memory:')
  const id1 = createSession(db, { alias: 'role-a', cc_session_id: 'cc-111' })
  expect(findSessionByCcSessionId(db, 'cc-111')?.id).toBe(id1)
  expect(findSessionByCcSessionId(db, 'cc-999')).toBeNull()

  // After release, should not find
  releaseSession(db, id1)
  expect(findSessionByCcSessionId(db, 'cc-111')).toBeNull()
  db.close()
})

test('releaseSession clears alias and sets released_at', () => {
  const db = openDatabase(':memory:')
  const id = createSession(db, { alias: 'release-test', cc_session_id: 'cc-r' })
  releaseSession(db, id)
  const row = db
    .query<{ alias: string | null; released_at: string | null }, [string]>(
      `SELECT alias, released_at FROM sessions WHERE id = ?`,
    )
    .get(id)
  expect(row?.alias).toBeNull()
  expect(row?.released_at).not.toBeNull()
  db.close()
})

test('partial unique index lets new session reclaim alias after release', () => {
  const db = openDatabase(':memory:')
  const id1 = createSession(db, { alias: 'reclaim-me', cc_session_id: 'cc-old' })
  releaseSession(db, id1)
  const id2 = createSession(db, { alias: 'reclaim-me', cc_session_id: 'cc-new' })
  expect(id2).not.toBe(id1)
  const active = findSessionByAlias(db, 'reclaim-me')
  expect(active?.id).toBe(id2)
  db.close()
})

test('partial unique index blocks two active rows with same alias', () => {
  const db = openDatabase(':memory:')
  createSession(db, { alias: 'conflict', cc_session_id: 'cc-1' })
  expect(() => {
    createSession(db, { alias: 'conflict', cc_session_id: 'cc-2' })
  }).toThrow()
  db.close()
})

test('findSessionByAlias ignores released rows', () => {
  const db = openDatabase(':memory:')
  const id = createSession(db, { alias: 'hidden', cc_session_id: 'cc-h' })
  releaseSession(db, id)
  expect(findSessionByAlias(db, 'hidden')).toBeNull()
  db.close()
})
