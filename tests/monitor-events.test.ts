import { describe, expect, test } from 'bun:test'
import { monitorLineToEvent } from '../clients/cc-channel/monitor-events'

describe('monitorLineToEvent', () => {
  test('inbox line carries count and alias', () => {
    const event = monitorLineToEvent('inbox 3 pocenter-yu')
    expect(event?.meta).toEqual({ kind: 'inbox', count: '3', alias: 'pocenter-yu' })
    expect(event?.content).toContain('read_messages')
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
