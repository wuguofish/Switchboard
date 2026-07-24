import { test, expect } from 'bun:test'
import { UnreadWaiterRegistry } from '../waiters'

test('wait resolves immediately when abort signal is already aborted', async () => {
  const reg = new UnreadWaiterRegistry()
  const ac = new AbortController()
  ac.abort()
  const start = Date.now()
  await reg.wait('sess', 'claude_code', 'cc', 10_000, ac.signal)
  expect(Date.now() - start).toBeLessThan(500)
  expect(reg.isPolling('claude_code', 'cc')).toBe(false)
})

test('wait resolves when abort signal fires mid-wait', async () => {
  const reg = new UnreadWaiterRegistry()
  const ac = new AbortController()
  const promise = reg.wait('sess', 'claude_code', 'cc', 60_000, ac.signal)
  await Bun.sleep(20)
  expect(reg.isPolling('claude_code', 'cc')).toBe(true)
  ac.abort()
  await promise
  expect(reg.isPolling('claude_code', 'cc')).toBe(false)
})

test('wait resolves on timeout when nothing else happens', async () => {
  const reg = new UnreadWaiterRegistry()
  const start = Date.now()
  await reg.wait('sess', 'claude_code', 'cc', 30, undefined)
  expect(Date.now() - start).toBeGreaterThanOrEqual(25)
  expect(reg.isPolling('claude_code', 'cc')).toBe(false)
})

test('notify wakes the waiter before the timeout fires', async () => {
  const reg = new UnreadWaiterRegistry()
  const promise = reg.wait('sess', 'claude_code', 'cc', 60_000)
  setTimeout(() => reg.notify('sess'), 20)
  const start = Date.now()
  await promise
  expect(Date.now() - start).toBeLessThan(500)
})

test('notify only wakes waiters for the matching session id', async () => {
  const reg = new UnreadWaiterRegistry()
  let otherResolved = false
  const other = reg.wait('other-sess', 'claude_code', 'cc-other', 100).then(() => {
    otherResolved = true
  })
  const target = reg.wait('target-sess', 'claude_code', 'cc-target', 60_000)
  reg.notify('target-sess')
  await target
  // other should still be running (until its 100ms timeout)
  expect(otherResolved).toBe(false)
  await other
})

test('notifyMany wakes every listed session', async () => {
  const reg = new UnreadWaiterRegistry()
  const p1 = reg.wait('a', 'claude_code', 'cc-a', 60_000)
  const p2 = reg.wait('b', 'claude_code', 'cc-b', 60_000)
  reg.notifyMany(['a', 'b'])
  await Promise.all([p1, p2])
})

test('concurrent waiters on the same session are all resolved by a single notify', async () => {
  const reg = new UnreadWaiterRegistry()
  const promises = [
    reg.wait('sess', 'claude_code', 'cc1', 60_000),
    reg.wait('sess', 'claude_code', 'cc2', 60_000),
    reg.wait('sess', 'claude_code', 'cc3', 60_000),
  ]
  reg.notify('sess')
  await Promise.all(promises)
  expect(reg.isPolling('claude_code', 'cc1')).toBe(false)
  expect(reg.isPolling('claude_code', 'cc2')).toBe(false)
  expect(reg.isPolling('claude_code', 'cc3')).toBe(false)
})

test('cancelAll resolves pending waiters and clears the polling set', async () => {
  const reg = new UnreadWaiterRegistry()
  const p = reg.wait('sess', 'claude_code', 'cc', 60_000)
  expect(reg.isPolling('claude_code', 'cc')).toBe(true)
  reg.cancelAll()
  await p
  expect(reg.isPolling('claude_code', 'cc')).toBe(false)
})

test('polling identity includes client_kind to avoid cross-kind collisions', async () => {
  const reg = new UnreadWaiterRegistry()
  const claudeAbort = new AbortController()
  const codexAbort = new AbortController()
  const claude = reg.wait('claude-session', 'claude_code', 'shared-id', 60_000, claudeAbort.signal)
  const codex = reg.wait('codex-session', 'codex', 'shared-id', 60_000, codexAbort.signal)

  expect(reg.isPolling('claude_code', 'shared-id')).toBe(true)
  expect(reg.isPolling('codex', 'shared-id')).toBe(true)

  claudeAbort.abort()
  await claude
  expect(reg.isPolling('claude_code', 'shared-id')).toBe(false)
  expect(reg.isPolling('codex', 'shared-id')).toBe(true)

  codexAbort.abort()
  await codex
})

test('one completed wait does not clear another wait for the same client identity', async () => {
  const reg = new UnreadWaiterRegistry()
  const firstAbort = new AbortController()
  const secondAbort = new AbortController()
  const first = reg.wait('session', 'codex', 'same-id', 60_000, firstAbort.signal)
  const second = reg.wait('session', 'codex', 'same-id', 60_000, secondAbort.signal)

  firstAbort.abort()
  await first
  expect(reg.isPolling('codex', 'same-id')).toBe(true)

  secondAbort.abort()
  await second
  expect(reg.isPolling('codex', 'same-id')).toBe(false)
})
