/**
 * A Claude Code session's Switchboard alias is its session name: the name
 * ListAgents shows and the user sets with /rename. Claude Code keeps that
 * name in ~/.claude/sessions/<pid>.json next to the session id, so the daemon
 * reads it from there and follows renames instead of asking Claude to pick a
 * role and keep it in sync by hand.
 *
 * A session that nobody has named yet carries the first eight characters of
 * its id as a placeholder; that is not a name and is never mirrored.
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { defaultSessionsDir } from './inbox-socket'

export function isPlaceholderName(name: string | null | undefined, sessionId: string): boolean {
  if (typeof name !== 'string' || name.trim() === '') return true
  return name === sessionId.slice(0, 8)
}

/** Session id → real name, for every registered Claude Code process that has one. */
export function readSessionNames(sessionsDir = defaultSessionsDir()): Map<string, string> {
  const names = new Map<string, string>()
  let files: string[]
  try {
    files = readdirSync(sessionsDir)
  } catch {
    return names
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(readFileSync(join(sessionsDir, file), 'utf8'))
    } catch {
      continue
    }
    const sessionId = record.sessionId
    const name = record.name
    if (typeof sessionId !== 'string' || typeof name !== 'string') continue
    if (isPlaceholderName(name, sessionId)) continue
    names.set(sessionId, name)
  }
  return names
}

export function sessionNameFor(ccSessionId: string, sessionsDir = defaultSessionsDir()): string | null {
  return readSessionNames(sessionsDir).get(ccSessionId) ?? null
}
