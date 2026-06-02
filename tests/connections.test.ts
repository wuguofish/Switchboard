import { test, expect, beforeEach } from 'bun:test'
import { ConnectionRegistry } from '../connections'

let registry: ConnectionRegistry

beforeEach(() => {
  registry = new ConnectionRegistry()
})

test('register associates session_id with push callback', () => {
  const pushed: any[] = []
  registry.register('uuid-1', (payload) => { pushed.push(payload) })
  expect(registry.isOnline('uuid-1')).toBe(true)
})

test('isOnline returns false for unregistered session', () => {
  expect(registry.isOnline('uuid-missing')).toBe(false)
})

test('unregister removes session', () => {
  registry.register('uuid-1', () => {})
  registry.unregister('uuid-1')
  expect(registry.isOnline('uuid-1')).toBe(false)
})

test('pushNotification invokes callback for online target', () => {
  const pushed: any[] = []
  registry.register('uuid-1', (payload) => { pushed.push(payload) })
  const ok = registry.pushNotification('uuid-1', { sender_alias: 'alice' })
  expect(ok).toBe(true)
  expect(pushed).toEqual([{ sender_alias: 'alice' }])
})

test('pushNotification returns false for offline target', () => {
  const ok = registry.pushNotification('uuid-missing', { sender_alias: 'alice' })
  expect(ok).toBe(false)
})

test('pushNotification returns false when callback throws (connection broken)', () => {
  registry.register('uuid-1', () => { throw new Error('broken') })
  const ok = registry.pushNotification('uuid-1', { sender_alias: 'alice' })
  expect(ok).toBe(false)
})

test('listOnline returns all registered session_ids', () => {
  registry.register('a', () => {})
  registry.register('b', () => {})
  expect(new Set(registry.listOnline())).toEqual(new Set(['a', 'b']))
})
