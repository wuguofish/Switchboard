import { test, expect } from 'bun:test'
import { UnreadWaiterRegistry } from '../waiters'

test('wait resolves immediately when abort signal is already aborted', async () => {
  const reg = new UnreadWaiterRegistry()
  const ac = new AbortController()
  ac.abort()
  const start = Date.now()
  await reg.wait('sess', 'cc', 10_000, ac.signal)
  expect(Date.now() - start).toBeLessThan(500)
  expect(reg.isPolling('cc')).toBe(false)
})

test('wait resolves when abort signal fires mid-wait', async () => {
  const reg = new UnreadWaiterRegistry()
  const ac = new AbortController()
  const promise = reg.wait('sess', 'cc', 60_000, ac.signal)
  await Bun.sleep(20)
  expect(reg.isPolling('cc')).toBe(true)
  ac.abort()
  await promise
  expect(reg.isPolling('cc')).toBe(false)
})

test('wait resolves on timeout when nothing else happens', async () => {
  const reg = new UnreadWaiterRegistry()
  const start = Date.now()
  await reg.wait('sess', 'cc', 30, undefined)
  expect(Date.now() - start).toBeGreaterThanOrEqual(25)
  expect(reg.isPolling('cc')).toBe(false)
})

test('notify wakes the waiter before the timeout fires', async () => {
  const reg = new UnreadWaiterRegistry()
  const promise = reg.wait('sess', 'cc', 60_000)
  setTimeout(() => reg.notify('sess'), 20)
  const start = Date.now()
  await promise
  expect(Date.now() - start).toBeLessThan(500)
})

test('notify only wakes waiters for the matching session id', async () => {
  const reg = new UnreadWaiterRegistry()
  let otherResolved = false
  const other = reg.wait('other-sess', 'cc-other', 100).then(() => {
    otherResolved = true
  })
  const target = reg.wait('target-sess', 'cc-target', 60_000)
  reg.notify('target-sess')
  await target
  // other should still be running (until its 100ms timeout)
  expect(otherResolved).toBe(false)
  await other
})

test('notifyMany wakes every listed session', async () => {
  const reg = new UnreadWaiterRegistry()
  const p1 = reg.wait('a', 'cc-a', 60_000)
  const p2 = reg.wait('b', 'cc-b', 60_000)
  reg.notifyMany(['a', 'b'])
  await Promise.all([p1, p2])
})

test('concurrent waiters on the same session are all resolved by a single notify', async () => {
  const reg = new UnreadWaiterRegistry()
  const promises = [
    reg.wait('sess', 'cc1', 60_000),
    reg.wait('sess', 'cc2', 60_000),
    reg.wait('sess', 'cc3', 60_000),
  ]
  reg.notify('sess')
  await Promise.all(promises)
  expect(reg.isPolling('cc1')).toBe(false)
  expect(reg.isPolling('cc2')).toBe(false)
  expect(reg.isPolling('cc3')).toBe(false)
})

test('cancelAll resolves pending waiters and clears the polling set', async () => {
  const reg = new UnreadWaiterRegistry()
  const p = reg.wait('sess', 'cc', 60_000)
  expect(reg.isPolling('cc')).toBe(true)
  reg.cancelAll()
  await p
  expect(reg.isPolling('cc')).toBe(false)
})
