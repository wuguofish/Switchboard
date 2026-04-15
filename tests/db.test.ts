import { test, expect, beforeEach, afterEach } from 'bun:test'
import { unlinkSync, existsSync } from 'fs'
import { openDatabase, createSession, findSessionById, findSessionByAlias, updateLastActivity, insertMessage, fetchUnreadForRecipient, markMessagesRead } from '../db'
import type { Database } from 'bun:sqlite'

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
