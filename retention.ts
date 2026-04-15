import type { Database } from 'bun:sqlite'
import { deleteExpiredMessages } from './db'

const ONE_HOUR_MS = 60 * 60 * 1000

export interface RetentionHandle {
  stop(): void
}

export function startRetentionLoop(db: Database): RetentionHandle {
  const tick = () => {
    try {
      const deleted = deleteExpiredMessages(db)
      if (deleted > 0) {
        process.stderr.write(`switchboard: retention deleted ${deleted} messages\n`)
      }
    } catch (err) {
      process.stderr.write(`switchboard: retention error: ${err}\n`)
    }
  }
  // Run once immediately, then every hour
  tick()
  const timer = setInterval(tick, ONE_HOUR_MS)
  return {
    stop() { clearInterval(timer) },
  }
}
