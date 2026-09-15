/**
 * Pure translation of daemon /monitor stream lines into channel notification
 * parameters. Kept free of I/O so it can be unit-tested.
 *
 * Line formats (see server.ts handleMonitor):
 *   hello <alias>
 *   inbox <json>             the messages themselves, see inbox-delivery.ts
 *   heartbeat <Asia/Taipei timestamp>
 */
import { inboxDeliveryText, parseInboxDeliveryLine } from '../../inbox-delivery'

export type ChannelEvent = {
  content: string
  meta: Record<string, string>
}

export function monitorLineToEvent(line: string): ChannelEvent | null {
  const text = line.trim()
  if (!text) return null

  const delivery = parseInboxDeliveryLine(text)
  if (delivery) {
    return {
      content: inboxDeliveryText(delivery),
      meta: { kind: 'inbox', count: String(delivery.messages.length), alias: delivery.alias },
    }
  }

  const hello = /^hello (.+)$/.exec(text)
  if (hello) {
    return {
      content: `subscribed as ${hello[1]} — no action needed`,
      meta: { kind: 'hello', alias: hello[1] },
    }
  }

  const heartbeat = /^heartbeat (.+)$/.exec(text)
  if (heartbeat) {
    return {
      content: `heartbeat ${heartbeat[1]} — clock signal only, no action needed`,
      meta: { kind: 'heartbeat', at: heartbeat[1] },
    }
  }

  return { content: text, meta: { kind: 'unknown' } }
}
