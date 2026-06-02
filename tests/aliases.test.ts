import { test, expect, beforeEach, afterEach } from 'bun:test'
import { openDatabase, createSession } from '../db'
import { resolveTarget, setAliasWithCollisionCheck, AliasCollisionError, UnknownTargetError } from '../aliases'
import type { Database } from 'bun:sqlite'

let db: Database

beforeEach(() => { db = openDatabase(':memory:') })
afterEach(() => { db.close() })

test('resolveTarget by alias returns UUID', () => {
  const id = createSession(db, { alias: 'line' })
  expect(resolveTarget(db, 'line')).toBe(id)
})

test('resolveTarget by UUID returns UUID as-is if session exists', () => {
  const id = createSession(db, { alias: null })
  expect(resolveTarget(db, id)).toBe(id)
})

test('resolveTarget throws UnknownTargetError for unknown name', () => {
  expect(() => resolveTarget(db, 'ghost')).toThrow(UnknownTargetError)
})

test('setAliasWithCollisionCheck succeeds when alias is free', () => {
  const id = createSession(db, { alias: null })
  setAliasWithCollisionCheck(db, id, 'video')
  const row = db.query<{ alias: string }, [string]>(
    'SELECT alias FROM sessions WHERE id = ?'
  ).get(id)
  expect(row?.alias).toBe('video')
})

test('setAliasWithCollisionCheck throws when alias is taken by another session', () => {
  createSession(db, { alias: 'video' })
  const other = createSession(db, { alias: null })
  expect(() => setAliasWithCollisionCheck(db, other, 'video'))
    .toThrow(AliasCollisionError)
})

test('setAliasWithCollisionCheck allows renaming to own current alias (no-op)', () => {
  const id = createSession(db, { alias: 'video' })
  setAliasWithCollisionCheck(db, id, 'video')  // should not throw
})
