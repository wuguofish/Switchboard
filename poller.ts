import { Database } from 'bun:sqlite'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'

export interface PollerConfig {
  role: string
  dbPath: string
  stateFilePath: string
  pollIntervalMs: number
  ttlMs: number
  ownPid: number
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export interface PollerState {
  pid: number
  role: string
  started_at: string
}

export interface PollerResult {
  exitCode: 0 | 2
  message?: string
}

/**
 * Atomically write the state file to claim leadership.
 * Uses write-to-temp then rename for atomicity.
 */
export function claimLeadership(config: PollerConfig): void {
  const state: PollerState = {
    pid: config.ownPid,
    role: config.role,
    started_at: new Date().toISOString(),
  }
  const content = JSON.stringify(state)
  const dir = dirname(config.stateFilePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = config.stateFilePath + '.tmp'
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, config.stateFilePath)
}

/**
 * Check if this poller is still the leader by comparing pid in state file.
 * Returns false if file is missing or holds a different pid.
 */
export function isStillLeader(config: PollerConfig): boolean {
  try {
    const content = readFileSync(config.stateFilePath, 'utf8')
    const state: PollerState = JSON.parse(content)
    return state.pid === config.ownPid
  } catch {
    return false
  }
}

/**
 * Count unread messages addressed to a given role alias.
 * Opens the DB in readonly mode so it can run concurrently with the daemon's WAL writes.
 */
export function countUnread(db: Database, role: string): number {
  const row = db.query<{ count: number }, [string]>(`
    SELECT COUNT(*) as count
    FROM messages m
    JOIN sessions s ON m.recipient_id = s.id
    WHERE s.alias = ? AND m.read_at IS NULL
  `).get(role)
  return row?.count ?? 0
}

/**
 * Main poll loop:
 * 1. Claim leadership (write state file with own PID)
 * 2. Open DB readonly
 * 3. Loop: check TTL, check leadership, check unread, sleep
 * 4. Exit 2 with SWITCHBOARD INBOX message if unread found
 * 5. Exit 0 if TTL exceeded or superseded
 */
export async function runPoller(config: PollerConfig): Promise<PollerResult> {
  claimLeadership(config)
  const db = new Database(config.dbPath, { readonly: true })
  const startTime = config.now()

  try {
    while (true) {
      // TTL safety net: prevent orphan polling forever
      if (config.now() - startTime >= config.ttlMs) {
        return { exitCode: 0 }
      }

      // Cooperative watchdog: exit if another poller claimed leadership
      if (!isStillLeader(config)) {
        return { exitCode: 0 }
      }

      const count = countUnread(db, config.role)
      if (count > 0) {
        return {
          exitCode: 2,
          message: `SWITCHBOARD INBOX: ${count} unread message(s) for role "${config.role}" — call mcp__switchboard__read_messages to retrieve`,
        }
      }

      await config.sleep(config.pollIntervalMs)
    }
  } finally {
    db.close()
  }
}

/**
 * Load poller configuration from environment variables.
 * Exits 0 with stderr message if SWITCHBOARD_ROLE is not set.
 */
export function loadConfigFromEnv(): PollerConfig {
  const role = process.env.SWITCHBOARD_ROLE
  if (!role) {
    process.stderr.write('switchboard poller: SWITCHBOARD_ROLE not set, exiting\n')
    process.exit(0)
  }
  return {
    role,
    dbPath: process.env.SWITCHBOARD_DB ?? 'C:/Users/ATone/.claude/switchboard.db',
    stateFilePath: process.env.SWITCHBOARD_POLLER_STATE ?? 'D:/tsunu_plan/.claude/switchboard-poller.state',
    pollIntervalMs: 2000,
    ttlMs: 600_000,  // 10 minutes
    ownPid: process.pid,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}

/**
 * Entry point when run directly as a script.
 * Loads config from env, runs poller, writes stdout if wakeup needed, exits with code.
 */
export async function main() {
  const config = loadConfigFromEnv()
  const result = await runPoller(config)
  if (result.message) {
    console.log(result.message)
  }
  process.exit(result.exitCode)
}

if (import.meta.main) {
  main()
}
