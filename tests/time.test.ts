import { test, expect } from 'bun:test'
import { nowUtc, toTaipeiISOString } from '../time'

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
