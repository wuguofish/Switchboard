/**
 * Socket delivery: wake a Claude Code session by posting to its inbox socket.
 *
 * Claude Code 2.1.224+ binds one Unix domain socket per session and records
 * it in ~/.claude/sessions/<pid>.json together with the session id. Anything
 * written there as a `{"type":"user", ...}` line becomes a turn in that
 * session, subject to its crossSessionInbound setting. This is the wake path
 * for sessions that keep no /monitor or /poll connection open — background
 * sessions in particular, which cannot load a channel and lose a Monitor
 * watch every 30 minutes.
 *
 * Frame format is not published; it was taken from the recipe Claude Code
 * itself logs in --debug mode (2.1.272) and verified against that version.
 */
import { readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const SUPPORTED_PEER_PROTOCOL = 1

export interface InboxSocket {
  socketPath: string
  pid: number
  token: string | null
  peerProtocol: number
  version: string
}

/**
 * Where Claude Code keeps its per-user state. Hosted as a Windows service the
 * daemon runs as LocalSystem, whose homedir() is the system profile, so this
 * has to be overridable the way SWITCHBOARD_DB already is — otherwise every
 * socket wake and every name lookup reads an empty directory and says nothing.
 */
export function claudeDir(): string {
  return process.env.SWITCHBOARD_CLAUDE_DIR ?? join(homedir(), '.claude')
}

export function defaultSessionsDir(): string {
  return join(claudeDir(), 'sessions')
}

/** Locate the inbox socket registered for a Claude Code session id. */
export function findInboxSocket(ccSessionId: string, sessionsDir = defaultSessionsDir()): InboxSocket | null {
  let names: string[]
  try {
    names = readdirSync(sessionsDir)
  } catch {
    return null
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(readFileSync(join(sessionsDir, name), 'utf8'))
    } catch {
      continue
    }
    if (record.sessionId !== ccSessionId) continue
    const socketPath = record.messagingSocketPath
    const pid = record.pid
    if (typeof socketPath !== 'string' || typeof pid !== 'number') return null
    return {
      socketPath,
      pid,
      token: readPeerToken(sessionsDir, pid, names),
      peerProtocol: typeof record.peerProtocol === 'number' ? record.peerProtocol : 0,
      version: typeof record.version === 'string' ? record.version : 'unknown',
    }
  }
  return null
}

function readPeerToken(sessionsDir: string, pid: number, names: string[]): string | null {
  const keyFile = names.find((name) => name.startsWith(`${pid}.`) && name.endsWith('.key'))
  if (!keyFile) return null
  try {
    const token = JSON.parse(readFileSync(join(sessionsDir, keyFile), 'utf8')).peerToken
    return typeof token === 'string' ? token : null
  } catch {
    return null
  }
}

/** The text a woken session reads. It only has to point at read_messages. */
export function inboxWakeText(count: number, alias: string): string {
  return `Switchboard: ${count} unread message(s) for ${alias}. Call mcp__switchboard__read_messages to read them.`
}

/** One JSON line per frame; the auth line goes first when a token is known. */
export function inboxFrames(text: string, token: string | null): string {
  const lines: string[] = []
  if (token) lines.push(JSON.stringify({ type: 'auth', token }))
  lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }))
  return lines.join('\n') + '\n'
}

/** Post the frames and close. Resolves true when the socket accepted the write. */
export async function postInboxFrames(socketPath: string, payload: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(payload)
          socket.flush()
          socket.end()
        },
        close() { finish(true) },
        error() { finish(false) },
        connectError() { finish(false) },
        data() {},
      },
    }).catch(() => finish(false))
  })
}

/**
 * Full path: look the session up, refuse unknown protocol versions, post.
 * Returns a short reason on skip so callers can log why nothing was sent.
 */
export async function wakeInboxSocket(
  ccSessionId: string,
  text: string,
  sessionsDir = defaultSessionsDir(),
): Promise<{ delivered: boolean; reason?: string }> {
  const inbox = findInboxSocket(ccSessionId, sessionsDir)
  if (!inbox) return { delivered: false, reason: 'no inbox socket registered for this session' }
  if (inbox.peerProtocol !== SUPPORTED_PEER_PROTOCOL) {
    return {
      delivered: false,
      reason: `peerProtocol ${inbox.peerProtocol} (Claude Code ${inbox.version}) is not the verified ${SUPPORTED_PEER_PROTOCOL}`,
    }
  }
  const delivered = await postInboxFrames(inbox.socketPath, inboxFrames(text, inbox.token))
  return delivered ? { delivered } : { delivered, reason: `socket ${inbox.socketPath} refused the connection` }
}

/**
 * The receiving session's inbound policy decides whether a socket wake is
 * delivered or held for approval. Read the user-level setting so the daemon
 * can warn at startup instead of failing silently per message.
 */
export function crossSessionInboundSetting(settingsPath = join(claudeDir(), 'settings.json')): string | null {
  try {
    const value = JSON.parse(readFileSync(settingsPath, 'utf8')).crossSessionInbound
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}
