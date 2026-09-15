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

export interface SessionRecord {
  sessionId: string
  pid: number
  /** The session name, or null while the session still carries a placeholder. */
  name: string | null
}

/** Every Claude Code process registered in the sessions directory. */
export function readSessionRecords(sessionsDir = defaultSessionsDir()): SessionRecord[] {
  const records: SessionRecord[] = []
  let files: string[]
  try {
    files = readdirSync(sessionsDir)
  } catch {
    return records
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(readFileSync(join(sessionsDir, file), 'utf8'))
    } catch {
      continue
    }
    const { sessionId, pid, name } = record
    if (typeof sessionId !== 'string' || typeof pid !== 'number') continue
    records.push({
      sessionId,
      pid,
      name: typeof name === 'string' && !isPlaceholderName(name, sessionId) ? name : null,
    })
  }
  return records
}

/** Session id → real name, for every registered Claude Code process that has one. */
export function readSessionNames(sessionsDir = defaultSessionsDir()): Map<string, string> {
  const names = new Map<string, string>()
  for (const record of readSessionRecords(sessionsDir)) {
    if (record.name) names.set(record.sessionId, record.name)
  }
  return names
}

/** A registry file can outlive a crashed Claude Code; check the process too. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function sessionNameFor(ccSessionId: string, sessionsDir = defaultSessionsDir()): string | null {
  return readSessionNames(sessionsDir).get(ccSessionId) ?? null
}
