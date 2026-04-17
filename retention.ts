import type { Database } from 'bun:sqlite'
import { deleteExpiredMessages, releaseStaleActiveSessions } from './db'
import type { ConnectionRegistry } from './connections'

const ONE_HOUR_MS = 60 * 60 * 1000
const ONE_MINUTE_MS = 60 * 1000
const STALE_SESSION_THRESHOLD_MS = 5 * ONE_MINUTE_MS

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

  // Run once immediately, then schedule periodic ticks.
  messagesTick()
  sessionsTick()
  const messagesTimer = setInterval(messagesTick, ONE_HOUR_MS)
  const sessionsTimer = setInterval(sessionsTick, ONE_MINUTE_MS)
  return {
    stop() {
      clearInterval(messagesTimer)
      clearInterval(sessionsTimer)
    },
  }
}
