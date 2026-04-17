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
