import { test, expect, beforeEach, afterEach } from 'bun:test'
import { unlinkSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { openDatabase, createClientSession, createSession, findSessionById, findSessionByAlias, findSessionByClientSessionId, findSessionByCcSessionId, registerClientSession, unregisterClientSession, releaseSession, updateLastActivity, updateLastSeen, insertMessage, fetchUnreadForRecipient, markMessagesRead, insertBroadcast, recallMessage, listAllSessions, deleteExpiredMessages, releaseStaleActiveSessions } from '../db'

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

test('updateLastSeen renews the session lease without changing last_activity', async () => {
  const id = createClientSession(db, {
    alias: 'lease-client',
    client_kind: 'codex',
    client_session_id: 'lease-id',
  })
  const before = findSessionById(db, id)!
  await Bun.sleep(10)

  updateLastSeen(db, id)

  const after = findSessionById(db, id)!
  expect(after.last_seen_at).not.toBeNull()
  expect(Date.parse(after.last_seen_at!)).toBeGreaterThan(Date.parse(before.created_at))
  expect(after.last_activity).toBe(before.last_activity)
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

test('insertBroadcast fans out to the caller-selected recipients', () => {
  const sender = createSession(db, { alias: 'sender' })
  const r1 = createSession(db, { alias: 'r1' })
  const r2 = createSession(db, { alias: 'r2' })
  const excluded = createSession(db, { alias: 'excluded' })

  const result = insertBroadcast(db, {
    sender_id: sender,
    recipient_ids: [r1, r2],
    content: 'hello selected recipients',
  })

  expect(result.recipient_count).toBe(2)
  expect(result.broadcast_id).toBeTruthy()

  const r1Msgs = fetchUnreadForRecipient(db, r1)
  const r2Msgs = fetchUnreadForRecipient(db, r2)
  const excludedMsgs = fetchUnreadForRecipient(db, excluded)
  const senderMsgs = fetchUnreadForRecipient(db, sender)

  expect(r1Msgs).toHaveLength(1)
  expect(r2Msgs).toHaveLength(1)
  expect(excludedMsgs).toHaveLength(0)
  expect(senderMsgs).toHaveLength(0)
  expect(r1Msgs[0].broadcast_id).toBe(result.broadcast_id)
  expect(r1Msgs[0].broadcast_id).toBe(r2Msgs[0].broadcast_id)
})

test('insertBroadcast with an empty recipient list returns zero recipient_count', () => {
  const sender = createSession(db, { alias: 'only' })
  const result = insertBroadcast(db, {
    sender_id: sender,
    recipient_ids: [],
    content: 'lonely',
  })
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
  const { broadcast_id } = insertBroadcast(db, {
    sender_id: sender,
    recipient_ids: [r1, r2],
    content: 'group',
  })
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

test('migration upgrades Phase 2.5 schema without losing data', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'switchboard-migration-'))
  const dbPath = join(tmp, 'phase2-5.db')

  const rawDb = new Database(dbPath)
  rawDb.exec('PRAGMA foreign_keys = ON')
  rawDb.exec(`
    CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        alias TEXT,
        cc_session_id TEXT,
        created_at TEXT NOT NULL,
        last_activity TEXT NOT NULL,
        released_at TEXT
    );
    CREATE UNIQUE INDEX idx_sessions_alias_active
        ON sessions(alias)
        WHERE alias IS NOT NULL AND released_at IS NULL;
    CREATE UNIQUE INDEX idx_sessions_cc_session_id_active
        ON sessions(cc_session_id)
        WHERE cc_session_id IS NOT NULL AND released_at IS NULL;
    CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        broadcast_id TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT,
        FOREIGN KEY (sender_id) REFERENCES sessions(id),
        FOREIGN KEY (recipient_id) REFERENCES sessions(id)
    );
  `)
  rawDb.exec(`
    INSERT INTO sessions
      (id, alias, cc_session_id, created_at, last_activity, released_at)
    VALUES
      ('active-id', 'active-alias', 'shared-client-id', '2026-04-16T00:00:00Z', '2026-04-16T01:00:00Z', NULL),
      ('released-id', NULL, 'released-client-id', '2026-04-15T00:00:00Z', '2026-04-15T01:00:00Z', '2026-04-16T02:00:00Z');
    INSERT INTO messages
      (id, sender_id, recipient_id, broadcast_id, content, created_at, read_at)
    VALUES
      ('message-id', 'released-id', 'active-id', NULL, 'keep me', '2026-04-16T03:00:00Z', NULL);
  `)
  rawDb.close()

  const migrated = openDatabase(dbPath)
  const sessionColumns = migrated
    .query<{ name: string }, []>(`PRAGMA table_info(sessions)`)
    .all()
    .map((column) => column.name)
  expect(sessionColumns).toContain('client_kind')
  expect(sessionColumns).toContain('client_session_id')
  expect(sessionColumns).toContain('cwd')
  expect(sessionColumns).toContain('last_seen_at')
  expect(sessionColumns).toContain('generation')
  expect(sessionColumns).not.toContain('cc_session_id')

  const sessions = migrated.query<{
    id: string
    alias: string | null
    client_kind: string
    client_session_id: string | null
    created_at: string
    last_activity: string
    released_at: string | null
    cwd: string | null
    last_seen_at: string | null
    generation: number
  }, []>(`
    SELECT id, alias, client_kind, client_session_id, created_at,
           last_activity, released_at, cwd, last_seen_at, generation
    FROM sessions
    ORDER BY id
  `).all()
  expect(sessions).toEqual([
    {
      id: 'active-id',
      alias: 'active-alias',
      client_kind: 'claude_code',
      client_session_id: 'shared-client-id',
      created_at: '2026-04-16T00:00:00Z',
      last_activity: '2026-04-16T01:00:00Z',
      released_at: null,
      cwd: null,
      last_seen_at: null,
      generation: 1,
    },
    {
      id: 'released-id',
      alias: null,
      client_kind: 'claude_code',
      client_session_id: 'released-client-id',
      created_at: '2026-04-15T00:00:00Z',
      last_activity: '2026-04-15T01:00:00Z',
      released_at: '2026-04-16T02:00:00Z',
      cwd: null,
      last_seen_at: null,
      generation: 1,
    },
  ])

  const message = migrated.query<{
    id: string
    sender_id: string
    recipient_id: string
    content: string
    reply_to: string | null
  }, []>(`
    SELECT id, sender_id, recipient_id, content, reply_to
    FROM messages
  `).get()
  expect(message).toEqual({
    id: 'message-id',
    sender_id: 'released-id',
    recipient_id: 'active-id',
    content: 'keep me',
    reply_to: null,
  })

  migrated.query(`
    INSERT INTO sessions
      (id, alias, client_kind, client_session_id, created_at, last_activity, released_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run('codex-id', 'codex-alias', 'codex', 'shared-client-id', '2026-04-16T04:00:00Z', '2026-04-16T04:00:00Z')
  expect(() => migrated.query(`
    INSERT INTO sessions
      (id, alias, client_kind, client_session_id, created_at, last_activity, released_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run('duplicate-id', 'duplicate-alias', 'claude_code', 'shared-client-id', '2026-04-16T05:00:00Z', '2026-04-16T05:00:00Z')).toThrow()
  migrated.query(`
    INSERT INTO sessions
      (id, alias, client_kind, client_session_id, created_at, last_activity, released_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run('reused-id', 'reused-alias', 'claude_code', 'released-client-id', '2026-04-16T06:00:00Z', '2026-04-16T06:00:00Z')

  migrated.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('registerClientSession upserts identity and increments generation', () => {
  const first = registerClientSession(db, {
    alias: 'codex-one',
    client_kind: 'codex',
    client_session_id: 'thread-123',
    cwd: '/workspace/one',
  })
  expect(first.generation).toBe(1)

  const second = registerClientSession(db, {
    alias: 'codex-two',
    client_kind: 'codex',
    client_session_id: 'thread-123',
    cwd: '/workspace/two',
  })
  expect(second.id).toBe(first.id)
  expect(second.alias).toBe('codex-two')
  expect(second.cwd).toBe('/workspace/two')
  expect(second.generation).toBe(2)

  releaseSession(db, first.id)
  const third = registerClientSession(db, {
    alias: 'codex-three',
    client_kind: 'codex',
    client_session_id: 'thread-123',
    cwd: '/workspace/three',
  })
  expect(third.id).toBe(first.id)
  expect(third.released_at).toBeNull()
  expect(third.generation).toBe(3)
})

test('registerClientSession prefers the active row over released identity history', () => {
  const releasedId = createClientSession(db, {
    alias: 'old-instance',
    client_kind: 'codex',
    client_session_id: 'identity-with-history',
  })
  releaseSession(db, releasedId)
  const activeId = createClientSession(db, {
    alias: 'current-instance',
    client_kind: 'codex',
    client_session_id: 'identity-with-history',
  })

  const registered = registerClientSession(db, {
    alias: 'renamed-current-instance',
    client_kind: 'codex',
    client_session_id: 'identity-with-history',
    cwd: '/workspace',
  })
  expect(registered.id).toBe(activeId)
  expect(registered.generation).toBe(2)
  expect(findSessionById(db, releasedId)?.released_at).not.toBeNull()
})

test('unregisterClientSession rejects a stale generation without releasing active row', () => {
  const first = registerClientSession(db, {
    alias: 'generation-one',
    client_kind: 'codex',
    client_session_id: 'thread-generation',
    cwd: '/workspace',
  })
  const second = registerClientSession(db, {
    alias: 'generation-two',
    client_kind: 'codex',
    client_session_id: 'thread-generation',
    cwd: '/workspace',
  })

  expect(unregisterClientSession(db, {
    client_kind: 'codex',
    client_session_id: 'thread-generation',
    generation: first.generation,
  })).toBe('generation_mismatch')
  expect(findSessionById(db, second.id)?.released_at).toBeNull()

  expect(unregisterClientSession(db, {
    client_kind: 'codex',
    client_session_id: 'thread-generation',
    generation: second.generation,
  })).toBe('released')
  expect(unregisterClientSession(db, {
    client_kind: 'codex',
    client_session_id: 'thread-generation',
    generation: second.generation,
  })).toBe('already_released')
})

test('client session helpers use client_kind as an identity namespace', () => {
  const claude = createClientSession(db, {
    alias: 'claude-peer',
    client_kind: 'claude_code',
    client_session_id: 'shared-id',
    cwd: '/workspace/claude',
  })
  const codex = createClientSession(db, {
    alias: 'codex-peer',
    client_kind: 'codex',
    client_session_id: 'shared-id',
    cwd: '/workspace/codex',
  })

  expect(findSessionByClientSessionId(db, 'claude_code', 'shared-id')?.id).toBe(claude)
  expect(findSessionByClientSessionId(db, 'codex', 'shared-id')?.id).toBe(codex)
  expect(findSessionByClientSessionId(db, 'external', 'shared-id')).toBeNull()
  expect(findSessionById(db, codex)?.cwd).toBe('/workspace/codex')
})

test('insertMessage stores nullable reply_to', () => {
  const sender = createSession(db, { alias: 'reply-sender' })
  const recipient = createSession(db, { alias: 'reply-recipient' })
  const root = insertMessage(db, {
    sender_id: sender,
    recipient_id: recipient,
    broadcast_id: null,
    content: 'root',
  })
  insertMessage(db, {
    sender_id: sender,
    recipient_id: recipient,
    broadcast_id: null,
    content: 'reply',
    reply_to: root,
  })

  const messages = fetchUnreadForRecipient(db, recipient)
  expect(messages.map((message) => message.reply_to)).toEqual([null, root])
})

test('createSession accepts optional cc_session_id', () => {
  const db = openDatabase(':memory:')
  const id = createSession(db, { alias: 'my-role', cc_session_id: 'cc-abc-123' })
  const row = db
    .query<{ id: string; client_kind: string; client_session_id: string | null }, [string]>(
      `SELECT id, client_kind, client_session_id FROM sessions WHERE id = ?`,
    )
    .get(id)
  expect(row?.client_kind).toBe('claude_code')
  expect(row?.client_session_id).toBe('cc-abc-123')
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

// --- releaseStaleActiveSessions ---

function backdateLastActivity(db: Database, id: string, msAgo: number): void {
  const iso = new Date(Date.now() - msAgo).toISOString()
  db.query('UPDATE sessions SET last_activity = ? WHERE id = ?').run(iso, id)
}

test('releaseStaleActiveSessions releases stale unconnected sessions', () => {
  const stale = createSession(db, { alias: 'stale-role' })
  backdateLastActivity(db, stale, 10 * 60_000) // 10 min ago

  const released = releaseStaleActiveSessions(db, [], 5 * 60_000)
  expect(released).toEqual([stale])

  const row = db
    .query<{ alias: string | null; released_at: string | null }, [string]>(
      'SELECT alias, released_at FROM sessions WHERE id = ?',
    )
    .get(stale)
  expect(row?.alias).toBeNull()
  expect(row?.released_at).not.toBeNull()
})

test('releaseStaleActiveSessions keeps connected sessions even when last_activity is old', () => {
  const connected = createSession(db, { alias: 'idle-but-alive' })
  backdateLastActivity(db, connected, 30 * 60_000) // 30 min ago

  const released = releaseStaleActiveSessions(db, [connected], 5 * 60_000)
  expect(released).toEqual([])

  expect(findSessionByAlias(db, 'idle-but-alive')?.id).toBe(connected)
})

test('releaseStaleActiveSessions keeps sessions with recent activity even when disconnected', () => {
  const recent = createSession(db, { alias: 'just-registered' })
  // last_activity was set to now by createSession; no backdating

  const released = releaseStaleActiveSessions(db, [], 5 * 60_000)
  expect(released).toEqual([])
  expect(findSessionByAlias(db, 'just-registered')?.id).toBe(recent)
})

test('releaseStaleActiveSessions skips already-released sessions', () => {
  const id = createSession(db, { alias: 'already-gone' })
  releaseSession(db, id)
  backdateLastActivity(db, id, 60 * 60_000) // 1 hour ago

  const released = releaseStaleActiveSessions(db, [], 5 * 60_000)
  expect(released).toEqual([])
})

test('releaseStaleActiveSessions releases multiple stale sessions in one call', () => {
  const a = createSession(db, { alias: 'stale-a' })
  const b = createSession(db, { alias: 'stale-b' })
  const c = createSession(db, { alias: 'alive-c' })
  backdateLastActivity(db, a, 10 * 60_000)
  backdateLastActivity(db, b, 20 * 60_000)
  backdateLastActivity(db, c, 30 * 60_000)

  const released = releaseStaleActiveSessions(db, [c], 5 * 60_000)
  expect(released.sort()).toEqual([a, b].sort())
  expect(findSessionByAlias(db, 'alive-c')?.id).toBe(c)
  expect(findSessionByAlias(db, 'stale-a')).toBeNull()
  expect(findSessionByAlias(db, 'stale-b')).toBeNull()
})

test('releaseStaleActiveSessions frees alias for re-use', () => {
  const first = createSession(db, { alias: 'shared-name' })
  backdateLastActivity(db, first, 10 * 60_000)
  releaseStaleActiveSessions(db, [], 5 * 60_000)

  // New session should be able to claim the alias
  const second = createSession(db, { alias: 'shared-name' })
  expect(second).not.toBe(first)
  expect(findSessionByAlias(db, 'shared-name')?.id).toBe(second)
})

test('releaseStaleActiveSessions uses last_seen_at when a lease has been renewed', () => {
  const id = createClientSession(db, {
    alias: 'leased',
    client_kind: 'codex',
    client_session_id: 'leased-id',
  })
  backdateLastActivity(db, id, 48 * 60 * 60_000)
  db.query('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id)

  expect(releaseStaleActiveSessions(db, [], 24 * 60 * 60_000)).toEqual([])
  expect(findSessionByAlias(db, 'leased')?.id).toBe(id)
})
