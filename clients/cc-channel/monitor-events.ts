/**
 * Pure translation of daemon /monitor stream lines into channel notification
 * parameters. Kept free of I/O so it can be unit-tested.
 *
 * Line formats (see server.ts handleMonitor):
 *   hello <alias>
 *   inbox <N> <alias>
 *   heartbeat <Asia/Taipei timestamp>
 */
export type ChannelEvent = {
  content: string
  meta: Record<string, string>
}

export function monitorLineToEvent(line: string): ChannelEvent | null {
  const text = line.trim()
  if (!text) return null

  const inbox = /^inbox (\d+) (.+)$/.exec(text)
  if (inbox) {
    return {
      content: `${inbox[1]} unread message(s) for ${inbox[2]} — call read_messages`,
      meta: { kind: 'inbox', count: inbox[1], alias: inbox[2] },
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
