import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import type { ClientKind, SessionRow, MessageRow } from './types'
import { nowUtc } from './time'
import { LEASE_TTL_MS } from './online'

const __dirname = dirname(fileURLToPath(import.meta.url))

function tableExists(db: Database, table: string): boolean {
  return db
    .query<{ name: string }, [string]>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(table) != null
}

function columnNames(db: Database, table: string): Set<string> {
  return new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => column.name),
  )
}

function migrateSchema(db: Database): void {
  if (!tableExists(db, 'sessions')) return

  db.transaction(() => {
    const sessionColumns = columnNames(db, 'sessions')

    if (sessionColumns.has('cc_session_id') && !sessionColumns.has('client_session_id')) {
      db.exec('ALTER TABLE sessions RENAME COLUMN cc_session_id TO client_session_id')
      sessionColumns.delete('cc_session_id')
      sessionColumns.add('client_session_id')
    }
    if (!sessionColumns.has('client_session_id')) {
      db.exec('ALTER TABLE sessions ADD COLUMN client_session_id TEXT')
      sessionColumns.add('client_session_id')
    }
    if (!sessionColumns.has('client_kind')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN client_kind TEXT NOT NULL DEFAULT 'claude_code'`)
    }
    if (!sessionColumns.has('cwd')) {
      db.exec('ALTER TABLE sessions ADD COLUMN cwd TEXT')
    }
    if (!sessionColumns.has('last_seen_at')) {
      db.exec('ALTER TABLE sessions ADD COLUMN last_seen_at TEXT')
    }
    if (!sessionColumns.has('generation')) {
      db.exec('ALTER TABLE sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 1')
    }
    if (!sessionColumns.has('owner_token')) {
      db.exec('ALTER TABLE sessions ADD COLUMN owner_token TEXT')
    }
    if (!sessionColumns.has('owner_seen_at')) {
      db.exec('ALTER TABLE sessions ADD COLUMN owner_seen_at TEXT')
    }
    if (!sessionColumns.has('released_at')) {
      db.exec('ALTER TABLE sessions ADD COLUMN released_at TEXT')
    }

    db.exec('DROP INDEX IF EXISTS idx_sessions_cc_session_id_active')
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_client_identity_active
      ON sessions(client_kind, client_session_id)
      WHERE client_session_id IS NOT NULL AND released_at IS NULL
    `)

    if (tableExists(db, 'messages')) {
      const messageColumns = columnNames(db, 'messages')
      if (!messageColumns.has('reply_to')) {
        db.exec('ALTER TABLE messages ADD COLUMN reply_to TEXT')
      }
    }
  })()
}

export function openDatabase(path: string): Database {
  const db = new Database(path)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  migrateSchema(db)

  const schemaPath = join(__dirname, 'schema.sql')
  const schema = readFileSync(schemaPath, 'utf8')
  db.exec(schema)
  return db
}

export function createSession(
  db: Database,
  opts: { alias: string | null; cc_session_id?: string | null },
): string {
  return createClientSession(db, {
    alias: opts.alias,
    client_kind: 'claude_code',
    client_session_id: opts.cc_session_id,
  })
}

export function createClientSession(
  db: Database,
  opts: {
    alias: string | null
    client_kind: ClientKind
    client_session_id?: string | null
    cwd?: string | null
    owner_token?: string | null
  },
): string {
  const id = randomUUID()
  const now = nowUtc()
  db.query(`
    INSERT INTO sessions (
      id, alias, client_kind, client_session_id, cwd,
      created_at, last_activity, last_seen_at, generation, owner_token, owner_seen_at, released_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, NULL)
  `).run(
    id,
    opts.alias,
    opts.client_kind,
    opts.client_session_id ?? null,
    opts.cwd ?? null,
    now,
    now,
    opts.owner_token ?? null,
    opts.owner_token ? now : null,
  )
  return id
}

export function findSessionById(db: Database, id: string): SessionRow | null {
  const row = db.query<SessionRow, [string]>(
    `SELECT id, alias, client_kind, client_session_id, cwd, created_at,
            last_activity, last_seen_at, generation, owner_token, owner_seen_at, released_at
     FROM sessions
     WHERE id = ?`,
  ).get(id)
  return row ?? null
}

export function findSessionByAlias(db: Database, alias: string): SessionRow | null {
  const row = db.query<SessionRow, [string]>(
    `SELECT id, alias, client_kind, client_session_id, cwd, created_at,
            last_activity, last_seen_at, generation, owner_token, owner_seen_at, released_at
     FROM sessions
     WHERE alias = ? AND released_at IS NULL`,
  ).get(alias)
  return row ?? null
}

export function findSessionByClientSessionId(
  db: Database,
  client_kind: ClientKind,
  client_session_id: string,
): SessionRow | null {
  const row = db.query<SessionRow, [ClientKind, string]>(
    `SELECT id, alias, client_kind, client_session_id, cwd, created_at,
            last_activity, last_seen_at, generation, owner_token, owner_seen_at, released_at
     FROM sessions
     WHERE client_kind = ? AND client_session_id = ? AND released_at IS NULL`,
  ).get(client_kind, client_session_id)
  return row ?? null
}

export function findSessionByCcSessionId(
  db: Database,
  cc_session_id: string,
): SessionRow | null {
  return findSessionByClientSessionId(db, 'claude_code', cc_session_id)
}

/**
 * Like findSessionByCcSessionId but also returns released rows.
 * Used by register to reactivate a row after disconnect.
 */
export function findAnySessionByClientSessionId(
  db: Database,
  client_kind: ClientKind,
  client_session_id: string,
): SessionRow | null {
  const row = db.query<SessionRow, [ClientKind, string]>(
    `SELECT id, alias, client_kind, client_session_id, cwd, created_at,
            last_activity, last_seen_at, generation, owner_token, owner_seen_at, released_at
     FROM sessions
     WHERE client_kind = ? AND client_session_id = ?
     ORDER BY (released_at IS NULL) DESC, generation DESC, created_at DESC
     LIMIT 1`,
  ).get(client_kind, client_session_id)
  return row ?? null
}

export function findAnySessionByCcSessionId(
  db: Database,
  cc_session_id: string,
): SessionRow | null {
  return findAnySessionByClientSessionId(db, 'claude_code', cc_session_id)
}

export interface RegisterClientSessionInput {
  alias: string | null
  client_kind: ClientKind
  client_session_id: string
  cwd?: string | null
  owner_token?: string
  respect_owner?: boolean
}

export class OwnershipConflictError extends Error {
  constructor(readonly currentGeneration: number) {
    super('session ownership is held by an active client')
    this.name = 'OwnershipConflictError'
  }
}

function hasValidOwnerLease(
  session: SessionRow,
  ownerLeaseTtlMs: number,
): boolean {
  if (session.released_at !== null || session.owner_token === null) return false
  if (!session.owner_seen_at) return false
  const lastSeenMs = Date.parse(session.owner_seen_at)
  return Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs < ownerLeaseTtlMs
}

/**
 * Register a durable client identity. Existing active or released rows are
 * reused and receive a fresh generation so delayed lifecycle requests from an
 * older client instance cannot affect the new one.
 */
export function registerClientSession(
  db: Database,
  input: RegisterClientSessionInput,
  options: { ownerLeaseTtlMs?: number } = {},
): SessionRow {
  return db.transaction(() => {
    const existing = findAnySessionByClientSessionId(
      db,
      input.client_kind,
      input.client_session_id,
    )

    if (!existing) {
      if (input.alias !== null) {
        const conflict = findSessionByAlias(db, input.alias)
        if (conflict) {
          throw new Error(`alias already taken: ${input.alias}`)
        }
      }
      const id = createClientSession(db, input)
      return findSessionById(db, id)!
    }

    if (
      input.owner_token === undefined &&
      input.respect_owner === true &&
      hasValidOwnerLease(existing, options.ownerLeaseTtlMs ?? LEASE_TTL_MS)
    ) {
      throw new OwnershipConflictError(existing.generation)
    }

    const targetAlias = input.alias ?? existing.alias
    if (targetAlias !== null) {
      const conflict = findSessionByAlias(db, targetAlias)
      if (conflict && conflict.id !== existing.id) {
        throw new Error(`alias already taken: ${targetAlias}`)
      }
    }

    const now = nowUtc()
    if (input.owner_token !== undefined) {
      const sameOwner = existing.owner_token === input.owner_token
      const ownerLeaseTtlMs = options.ownerLeaseTtlMs ?? LEASE_TTL_MS
      if (!sameOwner && hasValidOwnerLease(existing, ownerLeaseTtlMs)) {
        throw new OwnershipConflictError(existing.generation)
      }

      // A same-owner call is a lease/metadata renewal and deliberately keeps
      // its generation stable. Acquiring an ownerless/released identity or
      // taking over an expired owner creates a new lifecycle generation.
      const bumpGeneration = !sameOwner || existing.released_at !== null
      db.query(`
        UPDATE sessions
        SET alias = ?,
            cwd = CASE WHEN ? THEN ? ELSE cwd END,
            last_activity = ?,
            last_seen_at = CASE WHEN ? THEN NULL ELSE last_seen_at END,
            owner_seen_at = ?,
            generation = generation + ?,
            owner_token = ?,
            released_at = NULL
        WHERE id = ?
      `).run(
        targetAlias,
        input.cwd !== undefined ? 1 : 0,
        input.cwd ?? null,
        now,
        bumpGeneration ? 1 : 0,
        now,
        bumpGeneration ? 1 : 0,
        input.owner_token,
        existing.id,
      )
    } else {
      // Legacy clients intentionally retain last-register-wins semantics.
      // Clearing owner_token prevents an earlier token holder from renewing
      // after an owner-unaware client has started a newer generation.
      db.query(`
        UPDATE sessions
        SET alias = ?,
            cwd = CASE WHEN ? THEN ? ELSE cwd END,
            last_activity = ?,
            last_seen_at = CASE WHEN ? THEN NULL ELSE last_seen_at END,
            generation = generation + 1,
            owner_token = NULL,
            owner_seen_at = NULL,
            released_at = NULL
        WHERE id = ?
      `).run(
        targetAlias,
        input.cwd !== undefined ? 1 : 0,
        input.cwd ?? null,
        now,
        existing.owner_token !== null ? 1 : 0,
        existing.id,
      )
    }
    return findSessionById(db, existing.id)!
  })()
}

export type UnregisterClientSessionResult =
  | 'released'
  | 'already_released'
  | 'not_found'
  | 'generation_mismatch'
  | 'owner_mismatch'

export function unregisterClientSession(
  db: Database,
  input: {
    client_kind: ClientKind
    client_session_id: string
    generation: number
    owner_token?: string
  },
): UnregisterClientSessionResult {
  return db.transaction(() => {
    const existing = findAnySessionByClientSessionId(
      db,
      input.client_kind,
      input.client_session_id,
    )
    if (!existing) return 'not_found'
    if (existing.generation !== input.generation) return 'generation_mismatch'
    if (
      input.owner_token !== undefined &&
      existing.owner_token !== input.owner_token
    ) return 'owner_mismatch'
    if (existing.released_at !== null) return 'already_released'

    const result = db.query(`
      UPDATE sessions
      SET alias = NULL,
          owner_token = CASE WHEN ? IS NULL THEN NULL ELSE owner_token END,
          owner_seen_at = NULL,
          released_at = ?
      WHERE id = ? AND generation = ? AND released_at IS NULL
        AND (? IS NULL OR owner_token = ?)
    `).run(
      input.owner_token ?? null,
      nowUtc(),
      existing.id,
      input.generation,
      input.owner_token ?? null,
      input.owner_token ?? null,
    )
    return Number(result.changes) === 1 ? 'released' : 'generation_mismatch'
  })()
}

export function releaseSession(db: Database, id: string): void {
  db.query(
    `UPDATE sessions SET alias = NULL, owner_token = NULL, owner_seen_at = NULL, released_at = ? WHERE id = ?`,
  ).run(nowUtc(), id)
}

export function releaseSessionIfGeneration(
  db: Database,
  id: string,
  generation: number,
): boolean {
  const result = db.query(
    `UPDATE sessions
     SET alias = NULL, owner_token = NULL, owner_seen_at = NULL, released_at = ?
     WHERE id = ? AND generation = ? AND released_at IS NULL`,
  ).run(nowUtc(), id, generation)
  return Number(result.changes) === 1
}

export function reactivateSession(db: Database, id: string, alias: string | null): void {
  // Clears released_at and restores alias so the row is "active" again.
  // Called when a cc_session_id reconnects to a previously released session.
  db.query(
    `UPDATE sessions SET alias = ?, released_at = NULL WHERE id = ?`,
  ).run(alias, id)
}

export function updateLastActivity(db: Database, id: string): void {
  db.query('UPDATE sessions SET last_activity = ? WHERE id = ?')
    .run(nowUtc(), id)
}

export function updateLastSeen(db: Database, id: string): void {
  db.query('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
    .run(nowUtc(), id)
}

export function updateOwnerSeen(db: Database, id: string): void {
  db.query('UPDATE sessions SET owner_seen_at = ? WHERE id = ?')
    .run(nowUtc(), id)
}

export function setAlias(db: Database, id: string, newAlias: string): void {
  db.query('UPDATE sessions SET alias = ?, released_at = NULL WHERE id = ?').run(newAlias, id)
}

export interface InsertMessageInput {
  sender_id: string
  recipient_id: string
  broadcast_id: string | null
  reply_to?: string | null
  content: string
}

export function insertMessage(db: Database, input: InsertMessageInput): string {
  const id = randomUUID()
  const now = nowUtc()
  db.query(`
    INSERT INTO messages (
      id, sender_id, recipient_id, broadcast_id, reply_to, content, created_at, read_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    id,
    input.sender_id,
    input.recipient_id,
    input.broadcast_id,
    input.reply_to ?? null,
    input.content,
    now,
  )
  return id
}

export function fetchUnreadForRecipient(db: Database, recipient_id: string): MessageRow[] {
  return db.query<MessageRow, [string]>(`
    SELECT id, sender_id, recipient_id, broadcast_id, reply_to, content, created_at, read_at
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
  recipient_ids: string[]
  content: string
}

export interface BroadcastDbResult {
  broadcast_id: string
  recipient_count: number
  recipient_ids: string[]
}

export function insertBroadcast(db: Database, input: BroadcastInput): BroadcastDbResult {
  const broadcast_id = randomUUID()

  const now = nowUtc()
  const stmt = db.query(`
    INSERT INTO messages (
      id, sender_id, recipient_id, broadcast_id, reply_to, content, created_at, read_at
    )
    VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)
  `)
  const insertTx = db.transaction((recipientIds: string[]) => {
    for (const recipientId of recipientIds) {
      stmt.run(randomUUID(), input.sender_id, recipientId, broadcast_id, input.content, now)
    }
  })
  insertTx(input.recipient_ids)

  return {
    broadcast_id,
    recipient_count: input.recipient_ids.length,
    recipient_ids: input.recipient_ids,
  }
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
    `SELECT id, alias, client_kind, client_session_id, cwd, created_at,
            last_activity, last_seen_at, generation, owner_token, owner_seen_at, released_at
     FROM sessions
     ORDER BY created_at ASC`,
  ).all()
}

/** Count unread messages addressed to a specific session id. */
export function countUnreadBySessionId(db: Database, sessionId: string): number {
  const row = db.query<{ count: number }, [string]>(
    'SELECT COUNT(*) as count FROM messages WHERE recipient_id = ? AND read_at IS NULL',
  ).get(sessionId)
  return row?.count ?? 0
}

export function deleteExpiredMessages(db: Database): number {
  const info = db.query(`
    DELETE FROM messages
    WHERE read_at IS NOT NULL
      AND datetime(read_at) < datetime('now', '-7 days')
  `).run()
  return Number(info.changes)
}

/**
 * Release sessions that look orphaned: alive in DB (released_at IS NULL) but
 * either (a) not currently connected to any transport, and (b) no activity
 * within staleThresholdMs. The later of lease renewal and general activity is
 * used, so a fresh re-register is not discarded because of an older lease.
 *
 * @param connectedIds session IDs currently present in ConnectionRegistry
 * @returns IDs of sessions that were released by this call
 */
export function releaseStaleActiveSessions(
  db: Database,
  connectedIds: string[],
  staleThresholdMs: number,
): string[] {
  const cutoff = new Date(Date.now() - staleThresholdMs).toISOString()
  const candidates = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM sessions
       WHERE released_at IS NULL
         AND CASE
           WHEN last_seen_at IS NOT NULL AND last_seen_at > last_activity
             THEN last_seen_at
           ELSE last_activity
         END < ?`,
    )
    .all(cutoff)
  const connected = new Set(connectedIds)
  const staleIds = candidates.map((r) => r.id).filter((id) => !connected.has(id))
  if (staleIds.length === 0) return []

  const now = nowUtc()
  const placeholders = staleIds.map(() => '?').join(',')
  db.query(
    `UPDATE sessions
     SET alias = NULL, owner_token = NULL, owner_seen_at = NULL, released_at = ?
     WHERE id IN (${placeholders}) AND released_at IS NULL`,
  ).run(now, ...staleIds)
  return staleIds
}
