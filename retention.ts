import type { Database } from 'bun:sqlite'
import { deleteExpiredMessages, deleteStaleSessionRows, releaseStaleActiveSessions } from './db'
import type { ConnectionRegistry } from './connections'

const ONE_HOUR_MS = 60 * 60 * 1000
const STALE_SESSION_THRESHOLD_MS = 24 * ONE_HOUR_MS
const SESSION_ROW_RETENTION_DAYS = 30

export interface RetentionHandle {
  stop(): void
}

export function startRetentionLoop(
  db: Database,
  registry: ConnectionRegistry,
): RetentionHandle {
  const messagesTick = () => {
    try {
      const deleted = deleteExpiredMessages(db)
      if (deleted > 0) {
        process.stderr.write(`switchboard: retention deleted ${deleted} messages\n`)
      }
    } catch (err) {
      process.stderr.write(`switchboard: messages retention error: ${err}\n`)
    }
  }

  const sessionsTick = () => {
    try {
      const released = releaseStaleActiveSessions(
        db,
        registry.listOnline(),
        STALE_SESSION_THRESHOLD_MS,
      )
      if (released.length > 0) {
        for (const id of released) registry.unregister(id)
        process.stderr.write(
          `switchboard: retention released ${released.length} stale session(s)\n`,
        )
      }
    } catch (err) {
      process.stderr.write(`switchboard: sessions retention error: ${err}\n`)
    }
  }

  const staleRowsTick = () => {
    try {
      const deleted = deleteStaleSessionRows(db, SESSION_ROW_RETENTION_DAYS)
      if (deleted > 0) {
        process.stderr.write(`switchboard: retention deleted ${deleted} session row(s)
`)
      }
    } catch (err) {
      process.stderr.write(`switchboard: session rows retention error: ${err}
`)
    }
  }

  // Run once immediately, then schedule periodic ticks.
  messagesTick()
  sessionsTick()
  staleRowsTick()
  const messagesTimer = setInterval(messagesTick, ONE_HOUR_MS)
  const staleRowsTimer = setInterval(staleRowsTick, ONE_HOUR_MS)
  const sessionsTimer = setInterval(sessionsTick, 2 * ONE_HOUR_MS)
  return {
    stop() {
      clearInterval(messagesTimer)
      clearInterval(staleRowsTimer)
      clearInterval(sessionsTimer)
    },
  }
}
