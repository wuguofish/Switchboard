import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'

export interface BootstrapConfig {
  role: string | undefined  // undefined means opt-out
  switchboardUrl: string
  roleFilePath: string
}

export interface BootstrapResult {
  exitCode: 0 | 1
  message?: string
}

export async function runBootstrap(config: BootstrapConfig): Promise<BootstrapResult> {
  if (!config.role) {
    return { exitCode: 0, message: 'SWITCHBOARD_ROLE not set, skipping bootstrap' }
  }

  // Call switchboard register via MCP client
  let registered_session_id: string
  try {
    const transport = new StreamableHTTPClientTransport(new URL(config.switchboardUrl))
    const client = new Client(
      { name: 'switchboard-bootstrap', version: '0.1.0' },
      { capabilities: {} },
    )
    await client.connect(transport)
    const result = await client.callTool({
      name: 'register',
      arguments: { role: config.role },
    })
    await client.close()

    const parsed = JSON.parse((result.content as any[])[0].text)
    if (!parsed.session_id) {
      return { exitCode: 1, message: 'register returned no session_id' }
    }
    registered_session_id = parsed.session_id
  } catch (err) {
    return {
      exitCode: 1,
      message: `switchboard unreachable or register failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Write role to file (atomic)
  try {
    const dir = dirname(config.roleFilePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = config.roleFilePath + '.tmp'
    writeFileSync(tmp, config.role, 'utf8')
    renameSync(tmp, config.roleFilePath)
  } catch (err) {
    return {
      exitCode: 1,
      message: `failed to write role file: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  return {
    exitCode: 0,
    message: `bootstrap: role "${config.role}" registered as session ${registered_session_id}`,
  }
}

export function loadConfigFromEnv(): BootstrapConfig {
  return {
    role: process.env.SWITCHBOARD_ROLE,
    switchboardUrl: process.env.SWITCHBOARD_URL ?? 'http://127.0.0.1:9876/mcp',
    roleFilePath: process.env.SWITCHBOARD_ROLE_FILE ?? 'D:/tsunu_plan/.claude/switchboard-role.txt',
  }
}

export async function main() {
  const config = loadConfigFromEnv()
  const result = await runBootstrap(config)
  if (result.message) {
    process.stderr.write(result.message + '\n')
  }
  process.exit(result.exitCode)
}

if (import.meta.main) {
  main()
}
