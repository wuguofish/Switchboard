import { homedir } from 'os'
import { startServer } from './server'
import { crossSessionInboundSetting } from './inbox-socket'

const PORT = parseInt(process.env.SWITCHBOARD_PORT ?? '9876')
const DB_PATH =
  process.env.SWITCHBOARD_DB ??
  `${homedir().replaceAll('\\', '/')}/.claude/switchboard.db`

const handle = await startServer({
  port: PORT,
  dbPath: DB_PATH,
})

process.stderr.write(`switchboard: listening on http://127.0.0.1:${PORT}/mcp\n`)
process.stderr.write(`switchboard: db at ${DB_PATH}\n`)

const inbound = crossSessionInboundSetting()
if (inbound === 'accept') {
  process.stderr.write('switchboard: socket wake enabled (crossSessionInbound: accept)\n')
} else {
  process.stderr.write(
    `switchboard: WARNING socket wakes will be held for approval and expire unread: ` +
    `crossSessionInbound is ${inbound ?? 'unset'} in ~/.claude/settings.json; set it to "accept"\n`,
  )
}

const shutdown = async () => {
  process.stderr.write('switchboard: shutting down\n')
  await handle.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
