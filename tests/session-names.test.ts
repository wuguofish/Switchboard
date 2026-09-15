import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isPlaceholderName, isProcessAlive, readSessionNames, readSessionRecords, sessionNameFor } from '../session-names'

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sb-names-'))
  writeFileSync(join(dir, '1.json'), JSON.stringify({ pid: 1, sessionId: 'aaaaaaaa-1111', name: 'LINE總機-關東煮阿宇' }))
  writeFileSync(join(dir, '2.json'), JSON.stringify({ pid: 2, sessionId: 'bbbbbbbb-2222', name: 'bbbbbbbb' }))
  writeFileSync(join(dir, '3.json'), JSON.stringify({ pid: 3, sessionId: 'cccccccc-3333' }))
  writeFileSync(join(dir, '4.json'), 'not json')
  writeFileSync(join(dir, '5.key'), JSON.stringify({ peerToken: 'x' }))
  return dir
}

describe('isPlaceholderName', () => {
  test('empty, missing and the 8-character id prefix are placeholders', () => {
    expect(isPlaceholderName(undefined, 'abcdefgh-1')).toBe(true)
    expect(isPlaceholderName('', 'abcdefgh-1')).toBe(true)
    expect(isPlaceholderName('abcdefgh', 'abcdefgh-1')).toBe(true)
  })
  test('anything else is a real name', () => {
    expect(isPlaceholderName('RCTX阿宇', 'abcdefgh-1')).toBe(false)
  })
})

describe('readSessionNames', () => {
  test('maps session id to real names only, ignoring placeholders and junk', () => {
    expect([...readSessionNames(fixtureDir()).entries()]).toEqual([['aaaaaaaa-1111', 'LINE總機-關東煮阿宇']])
  })
  test('missing directory yields an empty map', () => {
    expect(readSessionNames('/nonexistent/sessions').size).toBe(0)
  })
})

describe('readSessionRecords', () => {
  test('keeps every process, with null name for placeholders', () => {
    expect(readSessionRecords(fixtureDir()).map((r) => [r.pid, r.name]).sort((x, y) => (x[0] as number) - (y[0] as number))).toEqual([
      [1, 'LINE總機-關東煮阿宇'], [2, null], [3, null],
    ])
  })
})

describe('isProcessAlive', () => {
  test('this process is alive; an absurd pid is not', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(999_999)).toBe(false)
  })
})

describe('sessionNameFor', () => {
  test('returns the name or null', () => {
    const dir = fixtureDir()
    expect(sessionNameFor('aaaaaaaa-1111', dir)).toBe('LINE總機-關東煮阿宇')
    expect(sessionNameFor('bbbbbbbb-2222', dir)).toBeNull()
    expect(sessionNameFor('nope', dir)).toBeNull()
  })
})
