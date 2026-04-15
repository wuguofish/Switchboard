import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import type { SessionRow } from './types'
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
