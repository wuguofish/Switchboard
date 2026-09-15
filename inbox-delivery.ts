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
 * The text the recipient reads. The sender line names the client kind because
 * Claude Code wraps every socket wake as "another Claude session" even when
 * the sender is Codex, OpenCode or an external HTTP caller.
 */
export function inboxDeliveryText(delivery: InboxDelivery): string {
  const count = delivery.messages.length
  const header = `Switchboard: ${count} message(s) for ${delivery.alias}, delivered here and marked read.`
  const bodies = delivery.messages.map((message) => {
    const sender = message.sender_alias ?? 'unknown sender'
    const tag = message.is_broadcast ? ' [broadcast]' : ''
    return `--- from ${sender} (${message.sender_kind}) ${message.created_at}${tag} ---\n${message.content}`
  })
  const footer = 'Reply with mcp__switchboard__send (to: the sender alias).'
  return [header, ...bodies, footer].join('\n\n')
}
