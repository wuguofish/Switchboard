export interface NotificationPayload {
  sender_alias: string | null
  sender_id: string
  message_preview?: string  // optional short preview
  is_broadcast: boolean
}

export type PushCallback = (payload: Partial<NotificationPayload>) => void

export class ConnectionRegistry {
  private connections = new Map<string, PushCallback>()

  register(session_id: string, callback: PushCallback): void {
    this.connections.set(session_id, callback)
  }

  unregister(session_id: string): void {
    this.connections.delete(session_id)
  }

  isOnline(session_id: string): boolean {
    return this.connections.has(session_id)
  }

  pushNotification(session_id: string, payload: Partial<NotificationPayload>): boolean {
    const cb = this.connections.get(session_id)
    if (!cb) return false
    try {
      cb(payload)
      return true
    } catch (err) {
      process.stderr.write(`switchboard: push failed for ${session_id}: ${err}\n`)
      return false
    }
  }

  listOnline(): string[] {
    return Array.from(this.connections.keys())
  }
}
