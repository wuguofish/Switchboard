import { test, expect } from 'bun:test'
import { buildHookOutput } from '../hook-session-start'

test('buildHookOutput embeds cc_session_id into additionalContext', () => {
  const input = JSON.stringify({ session_id: 'cc-xyz-789', source: 'startup' })
  const out = buildHookOutput(input)
  expect(out).not.toBeNull()
  expect(out!.hookSpecificOutput.hookEventName).toBe('SessionStart')
  expect(out!.hookSpecificOutput.additionalContext).toContain('cc-xyz-789')
  expect(out!.hookSpecificOutput.additionalContext).toContain('mcp__switchboard__register')
  expect(out!.hookSpecificOutput.additionalContext).toContain("cc_session_id='cc-xyz-789'")
})

test('buildHookOutput returns null when stdin JSON has no session_id', () => {
  expect(buildHookOutput('{}')).toBeNull()
  expect(buildHookOutput('{"other":"field"}')).toBeNull()
})

test('buildHookOutput returns null on malformed JSON', () => {
  expect(buildHookOutput('not json')).toBeNull()
  expect(buildHookOutput('')).toBeNull()
})

test('buildHookOutput mentions anonymous fallback', () => {
  const input = JSON.stringify({ session_id: 'cc-any' })
  const out = buildHookOutput(input)
  expect(out!.hookSpecificOutput.additionalContext).toMatch(/anonymously|anonymous/i)
})

test('buildHookOutput teaches the Monitor-tool subscription path', () => {
  const input = JSON.stringify({ session_id: 'cc-monitor-teach' })
  const out = buildHookOutput(input)
  const ctx = out!.hookSpecificOutput.additionalContext
  // The instructions must reference the Monitor tool, the /monitor endpoint,
  // the cc_session_id (so Claude can't be tempted to subscribe to someone
  // else's stream), and the three event verbs a subscriber must understand.
  expect(ctx).toContain('Monitor')
  expect(ctx).toContain('/monitor?cc_session_id=cc-monitor-teach')
  expect(ctx).toContain('hello')
  expect(ctx).toContain('inbox')
  expect(ctx).toContain('heartbeat')
  expect(ctx).toContain('read_messages')
})
