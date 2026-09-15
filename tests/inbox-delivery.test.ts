import { describe, expect, test } from 'bun:test'
import { inboxDeliveryLine, inboxDeliveryText, parseInboxDeliveryLine, type InboxDelivery } from '../inbox-delivery'

const delivery: InboxDelivery = {
  alias: 'worker',
  messages: [
    { id: 'a', sender_alias: 'boss', sender_kind: 'claude_code', created_at: '2026-09-15T16:00:00+08:00', content: 'do the thing\nsecond line', is_broadcast: false },
    { id: 'b', sender_alias: null, sender_kind: 'external', created_at: '2026-09-15T16:02:00+08:00', content: 'ping', is_broadcast: true },
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

  test('one tag per message with sender, client kind and time; body verbatim', () => {
    expect(text).toBe(
      '<switchboard from="boss" kind="claude_code" at="2026-09-15T16:00:00+08:00">\ndo the thing\nsecond line\n</switchboard>'
      + '\n\n'
      + '<switchboard from="unknown" kind="external" at="2026-09-15T16:02:00+08:00" broadcast="true">\nping\n</switchboard>',
    )
  })

  test('quotes in an alias cannot break out of the attribute', () => {
    const quoted = inboxDeliveryText({ alias: 'w', messages: [{ ...delivery.messages[0], sender_alias: 'a"b' }] })
    expect(quoted).toContain('from="a&quot;b"')
  })
})
