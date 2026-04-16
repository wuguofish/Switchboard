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

    return {
      ccSessionId,
      alias: row.alias,
      sessionId: row.id,
      dbPath: opts.dbPath,
      stateFilePath,
      pollIntervalMs: 2000,
      ttlMs: 7_200_000,
      ownPid: process.pid,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
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
