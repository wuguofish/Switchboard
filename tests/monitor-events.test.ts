import { describe, expect, test } from 'bun:test'
import { monitorLineToEvent } from '../clients/cc-channel/monitor-events'
import { inboxDeliveryLine } from '../inbox-delivery'

describe('monitorLineToEvent', () => {
  test('inbox line carries the messages themselves', () => {
    const line = inboxDeliveryLine({
      alias: 'pocenter-yu',
      messages: [
        { id: 'm1', sender_alias: 'rctx-yu', sender_kind: 'claude_code', created_at: '2026-09-15T16:00:00.000+08:00', content: 'first\nline two', is_broadcast: false },
        { id: 'm2', sender_alias: '小回(codex)', sender_kind: 'codex', created_at: '2026-09-15T16:01:00.000+08:00', content: 'second', is_broadcast: true },
      ],
    })
    const event = monitorLineToEvent(line)
    expect(event?.meta).toEqual({ kind: 'inbox', count: '2', alias: 'pocenter-yu' })
    expect(event?.content).toContain('2 message(s) for pocenter-yu')
    expect(event?.content).toContain('from rctx-yu (claude_code)')
    expect(event?.content).toContain('first\nline two')
    expect(event?.content).toContain('from 小回(codex) (codex) 2026-09-15T16:01:00.000+08:00 [broadcast]')
    expect(event?.content).not.toContain('read_messages')
  })

  test('malformed inbox line surfaces as unknown instead of crashing', () => {
    expect(monitorLineToEvent('inbox {oops')?.meta).toEqual({ kind: 'unknown' })
  })

  test('alias may contain spaces and CJK', () => {
    const event = monitorLineToEvent('hello line-operator關東煮阿宇')
    expect(event?.meta).toEqual({ kind: 'hello', alias: 'line-operator關東煮阿宇' })
  })

  test('heartbeat keeps the Taipei timestamp verbatim', () => {
    const event = monitorLineToEvent('heartbeat 2026-04-24(五)T13:38:25.000+08:00')
    expect(event?.meta).toEqual({ kind: 'heartbeat', at: '2026-04-24(五)T13:38:25.000+08:00' })
  })

  test('keep-alive whitespace produces no event', () => {
    expect(monitorLineToEvent(' ')).toBeNull()
    expect(monitorLineToEvent('')).toBeNull()
  })

  test('unrecognised lines still surface, marked unknown', () => {
    expect(monitorLineToEvent('something new')?.meta).toEqual({ kind: 'unknown' })
  })
})
