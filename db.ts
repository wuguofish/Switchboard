import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import type { SessionRow, MessageRow } from './types'
import { nowUtc } from './time'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function openDatabase(path: string): Database {
  const db = new Database(path)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  const schemaPath = join(__dirname, 'schema.sql')
  const schema = readFileSync(schemaPath, 'utf8')
  db.exec(schema)
  return db
}

export function createSession(db: Database, opts: { alias: string | null }): string {
  const id = randomUUID()
  const now = nowUtc()
  db.query(`
    INSERT INTO sessions (id, alias, created_at, last_activity)
    VALUES (?, ?, ?, ?)
  `).run(id, opts.alias, now, now)
  return id
}

export function findSessionById(db: Database, id: string): SessionRow | null {
  const row = db.query<SessionRow, [string]>(
    'SELECT id, alias, created_at, last_activity FROM sessions WHERE id = ?'
  ).get(id)
  return row ?? null
}

export function findSessionByAlias(db: Database, alias: string): SessionRow | null {
  const row = db.query<SessionRow, [string]>(
    'SELECT id, alias, created_at, last_activity FROM sessions WHERE alias = ?'
  ).get(alias)
  return row ?? null
}

export function updateLastActivity(db: Database, id: string): void {
  db.query('UPDATE sessions SET last_activity = ? WHERE id = ?')
    .run(nowUtc(), id)
}

export function setAlias(db: Database, id: string, newAlias: string): void {
  db.query('UPDATE sessions SET alias = ? WHERE id = ?').run(newAlias, id)
}

export interface InsertMessageInput {
  sender_id: string
  recipient_id: string
  broadcast_id: string | null
  content: string
}

export function insertMessage(db: Database, input: InsertMessageInput): string {
  const id = randomUUID()
  const now = nowUtc()
  db.query(`
    INSERT INTO messages (id, sender_id, recipient_id, broadcast_id, content, created_at, read_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(id, input.sender_id, input.recipient_id, input.broadcast_id, input.content, now)
  return id
}

export function fetchUnreadForRecipient(db: Database, recipient_id: string): MessageRow[] {
  return db.query<MessageRow, [string]>(`
    SELECT id, sender_id, recipient_id, broadcast_id, content, created_at, read_at
    FROM messages
    WHERE recipient_id = ? AND read_at IS NULL
    ORDER BY created_at ASC
  `).all(recipient_id)
}

export function markMessagesRead(db: Database, messageIds: string[]): void {
  if (messageIds.length === 0) return
  const now = nowUtc()
  const placeholders = messageIds.map(() => '?').join(',')
  db.query(
    `UPDATE messages SET read_at = ? WHERE id IN (${placeholders}) AND read_at IS NULL`
  ).run(now, ...messageIds)
}

export interface BroadcastInput {
  sender_id: string
  content: string
}

export interface BroadcastDbResult {
  broadcast_id: string
  recipient_count: number
}

export function insertBroadcast(db: Database, input: BroadcastInput): BroadcastDbResult {
  const broadcast_id = randomUUID()
  const recipients = db.query<{ id: string }, [string]>(
    'SELECT id FROM sessions WHERE id != ?'
  ).all(input.sender_id)

  const now = nowUtc()
  const stmt = db.query(`
    INSERT INTO messages (id, sender_id, recipient_id, broadcast_id, content, created_at, read_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `)
  const insertTx = db.transaction((rows: typeof recipients) => {
    for (const r of rows) {
      stmt.run(randomUUID(), input.sender_id, r.id, broadcast_id, input.content, now)
    }
  })
  insertTx(recipients)

  return { broadcast_id, recipient_count: recipients.length }
}

export interface RecallInput {
  message_id: string
  caller_id: string
}

export function recallMessage(db: Database, input: RecallInput): number {
  const msg = db.query<{ sender_id: string; broadcast_id: string | null }, [string]>(
    'SELECT sender_id, broadcast_id FROM messages WHERE id = ?'
  ).get(input.message_id)

  if (!msg) return 0  // idempotent: message doesn't exist

  if (msg.sender_id !== input.caller_id) {
    throw new Error('caller is not the sender of this message')
  }

  if (msg.broadcast_id) {
    // Delete all copies of this broadcast
    const info = db.query('DELETE FROM messages WHERE broadcast_id = ?').run(msg.broadcast_id)
    return Number(info.changes)
  } else {
    const info = db.query('DELETE FROM messages WHERE id = ?').run(input.message_id)
    return Number(info.changes)
  }
}

export function listAllSessions(db: Database): SessionRow[] {
  return db.query<SessionRow, []>(
    'SELECT id, alias, created_at, last_activity FROM sessions ORDER BY created_at ASC'
  ).all()
}

export function deleteExpiredMessages(db: Database): number {
  const info = db.query(`
    DELETE FROM messages
    WHERE read_at IS NOT NULL
      AND datetime(read_at) < datetime('now', '-7 days')
  `).run()
  return Number(info.changes)
}
