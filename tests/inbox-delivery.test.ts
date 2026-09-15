import { describe, expect, test } from 'bun:test'
import { inboxDeliveryLine, inboxDeliveryText, parseInboxDeliveryLine, type InboxDelivery } from '../inbox-delivery'

const delivery: InboxDelivery = {
  alias: 'worker',
  messages: [
    { id: 'a', sender_alias: 'boss', sender_kind: 'claude_code', created_at: '2026-09-15T16:00:00.000+08:00', content: 'do the thing\nsecond line', is_broadcast: false },
    { id: 'b', sender_alias: null, sender_kind: 'external', created_at: '2026-09-15T16:02:00.000+08:00', content: 'ping', is_broadcast: true },
  ],
}

describe('inbox delivery line', () => {
  test('round-trips through one stream line', () => {
    const line = inboxDeliveryLine(delivery)
    expect(line.includes('\n')).toBe(false)
    expect(parseInboxDeliveryLine(line)).toEqual(delivery)
  })

  test('rejects lines that are not inbox JSON', () => {
    expect(parseInboxDeliveryLine('hello worker')).toBeNull()
    expect(parseInboxDeliveryLine('inbox 3 worker')).toBeNull()
    expect(parseInboxDeliveryLine('inbox {"alias":1}')).toBeNull()
  })
})

describe('inbox delivery text', () => {
  const text = inboxDeliveryText(delivery)

  test('header states count, recipient and that the mail is already read', () => {
    expect(text.startsWith('Switchboard: 2 message(s) for worker, delivered here and marked read.')).toBe(true)
  })

  test('each message names sender, client kind and time, keeping the body verbatim', () => {
    expect(text).toContain('--- from boss (claude_code) 2026-09-15T16:00:00.000+08:00 ---\ndo the thing\nsecond line')
    expect(text).toContain('--- from unknown sender (external) 2026-09-15T16:02:00.000+08:00 [broadcast] ---\nping')
  })

  test('tells the recipient how to reply', () => {
    expect(text.trimEnd().endsWith('Reply with mcp__switchboard__send (to: the sender alias).')).toBe(true)
  })
})
