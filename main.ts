import { startServer } from './server'

const PORT = parseInt(process.env.SWITCHBOARD_PORT ?? '9876')
const DB_PATH = process.env.SWITCHBOARD_DB ?? 'C:/Users/ATone/.claude/switchboard.db'
const POLLER_STATE_DIR = process.env.SWITCHBOARD_POLLER_STATE_DIR

const handle = await startServer({
  port: PORT,
  dbPath: DB_PATH,
  pollerStateDir: POLLER_STATE_DIR,
})

process.stderr.write(`switchboard: listening on http://127.0.0.1:${PORT}/mcp\n`)
process.stderr.write(`switchboard: db at ${DB_PATH}\n`)

const shutdown = async () => {
  process.stderr.write('switchboard: shutting down\n')
  await handle.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
