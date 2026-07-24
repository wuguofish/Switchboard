/**
 * Long-poll waiter registry. Used by the /poll HTTP endpoint so that
 * Stop-hook clients (curl + thin shim) can block on the daemon until a
 * message arrives for a specific switchboard session — replacing the
 * heavyweight standalone `bun poller.ts` subprocess.
 *
 * Two things are tracked:
 *   1. per-session waiter callbacks (notify-on-new-message)
 *   2. kind-qualified client identities currently inside /poll (liveness
 *      signal for online/delivery status)
 */

import type { ClientKind } from './types'

export interface Waiter {
  resolve: () => void
}

export class UnreadWaiterRegistry {
  private waiters = new Map<string, Set<Waiter>>()
  private polling = new Map<string, number>()

  private pollingKey(clientKind: ClientKind, clientSessionId: string): string {
    return `${clientKind}:${clientSessionId}`
  }

  /**
   * Wait until notify(sessionId) is called, the timer fires, or the caller
   * aborts. Resolves regardless of cause — the caller decides what to do
   * next by re-checking unread counts.
   *
   * @param sessionId switchboard session id to wait on
   * @param clientKind client namespace of the caller
   * @param clientSessionId stable client identity of the caller
   * @param timeoutMs fallback timeout
   * @param abortSignal optional AbortSignal to break out early (e.g. when
   *        the HTTP client hangs up)
   */
  async wait(
    sessionId: string,
    clientKind: ClientKind,
    clientSessionId: string,
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const pollingKey = this.pollingKey(clientKind, clientSessionId)
    this.polling.set(pollingKey, (this.polling.get(pollingKey) ?? 0) + 1)
    try {
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(sessionId) ?? new Set<Waiter>()
        const waiter: Waiter = {
          resolve: () => {
            const current = this.waiters.get(sessionId)
            if (current) {
              current.delete(waiter)
              if (current.size === 0) this.waiters.delete(sessionId)
            }
            clearTimeout(timer)
            if (abortSignal && abortHandler) {
              abortSignal.removeEventListener('abort', abortHandler)
            }
            resolve()
          },
        }
        set.add(waiter)
        this.waiters.set(sessionId, set)

        const timer = setTimeout(() => waiter.resolve(), timeoutMs)
        const abortHandler = abortSignal ? () => waiter.resolve() : undefined
        if (abortSignal && abortHandler) {
          if (abortSignal.aborted) {
            waiter.resolve()
          } else {
            abortSignal.addEventListener('abort', abortHandler, { once: true })
          }
        }
      })
    } finally {
      const remaining = (this.polling.get(pollingKey) ?? 1) - 1
      if (remaining > 0) {
        this.polling.set(pollingKey, remaining)
      } else {
        this.polling.delete(pollingKey)
      }
    }
  }

  /** Wake every waiter listening on this session. */
  notify(sessionId: string): void {
    const set = this.waiters.get(sessionId)
    if (!set) return
    for (const w of Array.from(set)) w.resolve()
  }

  /** Wake waiters for any of the provided session ids (used by broadcast). */
  notifyMany(sessionIds: Iterable<string>): void {
    for (const id of sessionIds) this.notify(id)
  }

  /** True if this kind-qualified client identity is currently polling. */
  isPolling(clientKind: ClientKind, clientSessionId: string): boolean {
    return this.polling.has(this.pollingKey(clientKind, clientSessionId))
  }

  /**
   * Release every waiter. Called during daemon shutdown so we do not leak
   * timers and hanging HTTP responses.
   */
  cancelAll(): void {
    for (const set of this.waiters.values()) {
      for (const w of Array.from(set)) w.resolve()
    }
    this.waiters.clear()
    this.polling.clear()
  }
}
