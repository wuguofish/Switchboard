import { Database } from 'bun:sqlite'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import { dirname, join } from 'path'

export interface PollerConfig {
  ccSessionId: string
  alias: string
  sessionId: string
  dbPath: string
  stateFilePath: string
  pollIntervalMs: number
  ttlMs: number
  ownPid: number
  now: () => number
  sleep: (ms: number) => Promise<void>
  /**
   * Returns true while the spawning Claude Code process is still alive.
   * When it dies the poller should exit immediately so it does not become
   * an orphan that squats on the state file and prevents a fresh session
   * (under a reused cc_session_id) from claiming leadership.
   */
  isParentAlive: () => boolean
}

export interface PollerState {
  pid: number
  cc_session_id: string
  started_at: string
}

export interface PollerResult {
  exitCode: 0 | 2
  message?: string
}

export function claimLeadership(config: PollerConfig): void {
  const state: PollerState = {
    pid: config.ownPid,
    cc_session_id: config.ccSessionId,
    started_at: new Date().toISOString(),
  }
  const content = JSON.stringify(state)
  const dir = dirname(config.stateFilePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = config.stateFilePath + '.tmp'
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, config.stateFilePath)
}

export function isStillLeader(config: PollerConfig): boolean {
  try {
    const content = readFileSync(config.stateFilePath, 'utf8')
    const state: PollerState = JSON.parse(content)
    return state.pid === config.ownPid
  } catch {
    return false
  }
}

export function countUnread(db: Database, alias: string): number {
  const row = db.query<{ count: number }, [string]>(`
    SELECT COUNT(*) as count
    FROM messages m
    JOIN sessions s ON m.recipient_id = s.id
    WHERE s.alias = ? AND s.released_at IS NULL AND m.read_at IS NULL
  `).get(alias)
  return row?.count ?? 0
}

export async function runPoller(config: PollerConfig): Promise<PollerResult> {
  claimLeadership(config)
  const db = new Database(config.dbPath, { readonly: true })
  const startTime = config.now()

  try {
    while (true) {
      if (config.now() - startTime >= config.ttlMs) {
        return { exitCode: 0 }
      }

      if (!isStillLeader(config)) {
        return { exitCode: 0 }
      }

      if (!config.isParentAlive()) {
        return { exitCode: 0 }
      }

      const count = countUnread(db, config.alias)
      if (count > 0) {
        return {
          exitCode: 2,
          message: `SWITCHBOARD INBOX: ${count} unread message(s) for role "${config.alias}" — call mcp__switchboard__read_messages to retrieve`,
        }
      }

      await config.sleep(config.pollIntervalMs)
    }
  } finally {
    db.close()
  }
}

/**
 * Test whether a process with the given pid is alive. Works on Windows and
 * POSIX alike: `process.kill(pid, 0)` sends a no-op signal that throws ESRCH
 * (or EPERM) if the target does not exist. Used by loadConfigFromHookStdin
 * to wire up the default isParentAlive hook against the real parent pid.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve whether the recipient has a live poller process that will convert
 * a pushed notification into a rewake (Stop hook asyncRewake). Used by
 * send/broadcast to produce an honest delivered_notification signal:
 * - cc_session_id is required; anonymous / Phase 1 sessions have no poller
 * - state file absence means the session never ran a poller since the last
 *   daemon start
 * - pid from the state file must still be alive (isPidAlive)
 */
export function isPollerAlive(
  ccSessionId: string | null | undefined,
  opts: { stateFileDir: string },
): boolean {
  if (!ccSessionId) return false
  const safeName = ccSessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const statePath = join(
    opts.stateFileDir,
    `switchboard-poller-${safeName}.state`,
  )
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as PollerState
    return isPidAlive(state.pid)
  } catch {
    return false
  }
}

export interface LoadConfigOptions {
  dbPath: string
  stateFileDir: string
}

export function loadConfigFromHookStdin(
  input: string,
  opts: LoadConfigOptions,
): PollerConfig | null {
  let payload: { session_id?: string }
  try {
    payload = JSON.parse(input)
  } catch {
    return null
  }
  const ccSessionId = payload.session_id
  if (!ccSessionId) return null

  const db = new Database(opts.dbPath, { readonly: true })
  try {
    const row = db.query<
      { id: string; alias: string | null },
      [string]
    >(
      `SELECT id, alias FROM sessions
       WHERE cc_session_id = ?
         AND released_at IS NULL
         AND alias IS NOT NULL`,
    ).get(ccSessionId)
    if (!row || !row.alias) return null

    const safeName = ccSessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const stateFilePath = join(
      opts.stateFileDir,
      `switchboard-poller-${safeName}.state`,
    )
    // Capture the parent pid at load time. If the spawning Claude Code dies
    // the kernel reparents us (POSIX) or the pid becomes invalid (Windows),
    // and isPidAlive returns false on the next tick — the poller exits
    // without needing the TTL timer to fire hours later.
    const parentPid = process.ppid

    return {
      ccSessionId,
      alias: row.alias,
      sessionId: row.id,
      dbPath: opts.dbPath,
      stateFilePath,
      pollIntervalMs: 30_000,
      // Parent-pid check is the primary orphan guard. Keep a very long TTL
      // as a belt-and-braces upper bound in case isPidAlive misfires.
      ttlMs: 24 * 60 * 60 * 1000,
      ownPid: process.pid,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      isParentAlive: () => isPidAlive(parentPid),
    }
  } finally {
    db.close()
  }
}

export async function main() {
  const input = await Bun.stdin.text()
  const config = loadConfigFromHookStdin(input, {
    dbPath: process.env.SWITCHBOARD_DB ?? 'C:/Users/ATone/.claude/switchboard.db',
    stateFileDir:
      process.env.SWITCHBOARD_POLLER_STATE_DIR ?? 'D:/tsunu_plan/.claude',
  })
  if (!config) {
    process.exit(0)
  }
  const result = await runPoller(config)
  if (result.message) {
    console.log(result.message)
  }
  process.exit(result.exitCode)
}

if (import.meta.main) {
  main()
}
