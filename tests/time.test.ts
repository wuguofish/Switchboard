import { test, expect } from 'bun:test'
import { nowUtc, toTaipeiISOString, taipeiWeekdayZh, toTaipeiHeartbeatString } from '../time'

test('nowUtc returns ISO 8601 UTC with Z suffix', () => {
  const s = nowUtc()
  expect(s).toMatch(/Z$/)
  expect(new Date(s).toISOString()).toBe(s)
})

test('toTaipeiISOString converts UTC to +08:00', () => {
  const utc = '2026-04-15T03:09:16.004Z'
  const taipei = toTaipeiISOString(utc)
  expect(taipei).toBe('2026-04-15T11:09:16.004+08:00')
})

test('toTaipeiISOString handles midnight rollover', () => {
  const utc = '2026-04-14T17:00:00.000Z'  // Taipei = next day 01:00
  expect(toTaipeiISOString(utc)).toBe('2026-04-15T01:00:00.000+08:00')
})

test('taipeiWeekdayZh returns single zh-TW weekday char', () => {
  // 2026-07-04 is a Saturday in Taipei (and UTC).
  expect(taipeiWeekdayZh('2026-07-04T06:00:00.000Z')).toBe('六')
})

test('taipeiWeekdayZh uses the Taipei date, not the UTC date', () => {
  // 2026-07-03T17:00Z is still Friday in UTC but already Saturday 01:00
  // in Taipei — the weekday must follow Taipei.
  expect(taipeiWeekdayZh('2026-07-03T17:00:00.000Z')).toBe('六')
})

test('toTaipeiHeartbeatString inlines weekday after the date', () => {
  const utc = '2026-07-04T06:02:11.152Z'  // Taipei 14:02 Saturday
  expect(toTaipeiHeartbeatString(utc)).toBe('2026-07-04(六)T14:02:11.152+08:00')
})

test('toTaipeiHeartbeatString weekday follows Taipei across midnight rollover', () => {
  const utc = '2026-07-03T17:00:00.000Z'  // Taipei = Sat 2026-07-04 01:00
  expect(toTaipeiHeartbeatString(utc)).toBe('2026-07-04(六)T01:00:00.000+08:00')
})
