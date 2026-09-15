/**
 * What a wake carries: the messages themselves, not a count.
 *
 * Every delivery path (inbox socket, /monitor stream, channel shim) hands
 * the recipient this payload and the daemon marks the rows read at the same
 * time, so the session acts on the mail directly instead of calling
 * read_messages first. Kept free of I/O so the daemon and the channel shim
 * share it and it can be unit-tested.
 */
export interface DeliveredMessage {
  id: string
  sender_alias: string | null
  sender_kind: string
  created_at: string
  content: string
  is_broadcast: boolean
}

export interface InboxDelivery {
  alias: string
  messages: DeliveredMessage[]
}

const LINE_PREFIX = 'inbox '

/** One /monitor stream line: `inbox <json>`; JSON keeps multi-line bodies on one line. */
export function inboxDeliveryLine(delivery: InboxDelivery): string {
  return LINE_PREFIX + JSON.stringify(delivery)
}

export function parseInboxDeliveryLine(line: string): InboxDelivery | null {
  if (!line.startsWith(LINE_PREFIX)) return null
  try {
    const parsed = JSON.parse(line.slice(LINE_PREFIX.length))
    if (typeof parsed?.alias !== 'string' || !Array.isArray(parsed.messages)) return null
    return parsed as InboxDelivery
  } catch {
    return null
  }
}

/**
 * The text the recipient reads: one tag per message, shaped like Claude
 * Code's own cross-session-message tag. `kind` is there because Claude Code
 * wraps every socket wake as "another Claude session" even when the sender
 * is Codex, OpenCode or an external HTTP caller; `at` carries the Taipei
 * date with weekday because a socket-woken session gets no heartbeat.
 * How to reply is the hook's job, not every message's.
 */
export function inboxDeliveryText(delivery: InboxDelivery): string {
  return delivery.messages.map((message) => {
    const attrs = [
      `from="${attr(message.sender_alias ?? 'unknown')}"`,
      `kind="${attr(message.sender_kind)}"`,
      `at="${attr(message.created_at)}"`,
    ]
    if (message.is_broadcast) attrs.push('broadcast="true"')
    return `<switchboard ${attrs.join(' ')}>\n${message.content}\n</switchboard>`
  }).join('\n\n')
}

function attr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
}
