import type { Database } from 'bun:sqlite'
import { findSessionById, findSessionByAlias, setAlias } from './db'

export class UnknownTargetError extends Error {
  constructor(target: string) {
    super(`unknown target: ${target} (not a valid alias or session id)`)
  }
}

export class AliasCollisionError extends Error {
  constructor(alias: string) {
    super(`alias already taken: ${alias}`)
  }
}

export function resolveTarget(db: Database, target: string): string {
  // Try alias first
  const byAlias = findSessionByAlias(db, target)
  if (byAlias) return byAlias.id
  // Try as UUID
  const byId = findSessionById(db, target)
  if (byId) return byId.id
  throw new UnknownTargetError(target)
}

export function setAliasWithCollisionCheck(db: Database, session_id: string, newAlias: string): void {
  const existing = findSessionByAlias(db, newAlias)
  if (existing && existing.id !== session_id) {
    throw new AliasCollisionError(newAlias)
  }
  setAlias(db, session_id, newAlias)
}
