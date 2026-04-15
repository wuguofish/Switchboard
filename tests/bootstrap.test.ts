import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startServer, type ServerHandle } from '../server'
import { runBootstrap, type BootstrapConfig } from '../bootstrap'

const TEST_PORT = 19878
let handle: ServerHandle
let tmpDir: string

beforeAll(async () => {
  handle = await startServer({ port: TEST_PORT, dbPath: ':memory:' })
})

afterAll(async () => {
  await handle.stop()
})

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'switchboard-bootstrap-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeConfig(overrides: Partial<BootstrapConfig> = {}): BootstrapConfig {
  return {
    role: 'test-role',
    switchboardUrl: `http://127.0.0.1:${TEST_PORT}/mcp`,
    roleFilePath: join(tmpDir, 'switchboard-role.txt'),
    ...overrides,
  }
}

test('runBootstrap with undefined role returns exit 0 and writes nothing', async () => {
  const config = makeConfig({ role: undefined })
  const result = await runBootstrap(config)
  expect(result.exitCode).toBe(0)
  expect(existsSync(config.roleFilePath)).toBe(false)
})

test('runBootstrap registers role with switchboard and writes role.txt', async () => {
  const config = makeConfig({ role: 'bootstrap-test-role' })
  const result = await runBootstrap(config)
  expect(result.exitCode).toBe(0)
  expect(existsSync(config.roleFilePath)).toBe(true)
  expect(readFileSync(config.roleFilePath, 'utf8')).toBe('bootstrap-test-role')
})

test('runBootstrap is idempotent: second call with same role still exits 0', async () => {
  const config = makeConfig({ role: 'bootstrap-idempotent' })
  const first = await runBootstrap(config)
  expect(first.exitCode).toBe(0)
  const second = await runBootstrap(config)
  expect(second.exitCode).toBe(0)
  // Second call relies on register() being idempotent (Task 1)
})

test('runBootstrap exits 1 when switchboard unreachable', async () => {
  const config = makeConfig({
    role: 'unreachable-test',
    switchboardUrl: 'http://127.0.0.1:19999/mcp',
  })
  const result = await runBootstrap(config)
  expect(result.exitCode).toBe(1)
  expect(result.message).toMatch(/unreachable|failed|ECONNREFUSED/i)
})
