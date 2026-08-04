import type { ConnectionRegistry } from './connections'
import type { SessionRow } from './types'
import type { UnreadWaiterRegistry } from './waiters'

const ONE_MINUTE_MS = 60_000

// A poll may remain open for 250 seconds. Five minutes covers that full wait
// and leaves roughly 50 seconds for a client to reconnect without flickering
// offline.
export const LEASE_TTL_MS = 5 * ONE_MINUTE_MS

export function hasValidLease(
  session: SessionRow,
  nowMs = Date.now(),
): boolean {
  if (!session.last_seen_at) return false
  const lastSeenMs = Date.parse(session.last_seen_at)
  return Number.isFinite(lastSeenMs) && nowMs - lastSeenMs < LEASE_TTL_MS
}

export function isSessionOnline(
  session: SessionRow,
  registry: ConnectionRegistry,
  waiters: UnreadWaiterRegistry,
  nowMs = Date.now(),
): boolean {
  if (session.released_at !== null) return false
  if (registry.isOnline(session.id)) return true
  if (!session.client_session_id) return false
  return (
    waiters.isPolling(
      session.client_kind,
      session.client_session_id,
      session.owner_token === null ? undefined : {
        generation: session.generation,
        ownerToken: session.owner_token,
      },
    ) ||
    hasValidLease(session, nowMs)
  )
}
