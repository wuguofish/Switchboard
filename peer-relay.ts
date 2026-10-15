/**
 * Cross-machine delivery: a `send` whose target reads `<peer>:<alias>` and
 * matches no local session is handed to the line-gateway on this machine,
 * which signs it and carries it over the tunnel to the peer machine's
 * gateway and Switchboard (line-gateway `peers.ts` has the wire format).
 *
 * Switchboard stays loopback-only and holds no secrets: it only needs the
 * local gateway's origin. A target that resolves locally is never relayed,
 * so an alias containing ':' keeps working as before.
 */

export interface PeerTarget {
  peer: string
  alias: string
}

export const DEFAULT_PEER_RELAY_URL = 'http://127.0.0.1:3456'

const PEER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

export function parsePeerTarget(target: string): PeerTarget | null {
  const colon = target.indexOf(':')
  if (colon <= 0) return null
  const peer = target.slice(0, colon)
  const alias = target.slice(colon + 1).trim()
  if (!PEER_NAME_RE.test(peer) || !alias) return null
  return { peer, alias }
}

export interface RelayResult {
  envelope_id: string
  peer: string
  delivered_notification: boolean
}

export class PeerRelayError extends Error {}

/** Asks the local gateway to deliver one message to a peer machine. */
export async function relayToPeer(
  relayUrl: string,
  input: { target: PeerTarget; from_alias: string; content: string },
  fetchImpl: typeof fetch = fetch,
): Promise<RelayResult> {
  let res: Response
  try {
    res = await fetchImpl(relayUrl.replace(/\/+$/, '') + '/peer/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to_peer: input.target.peer,
        to_alias: input.target.alias,
        from_alias: input.from_alias,
        content: input.content,
      }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    throw new PeerRelayError(`peer relay at ${relayUrl} unreachable: ${err instanceof Error ? err.message : String(err)}`)
  }
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(text) as Record<string, unknown> } catch {}
  if (!res.ok) {
    const detail = typeof body.detail === 'object' && body.detail && 'error' in body.detail
      ? ` (${(body.detail as { error: unknown }).error})`
      : ''
    const known = Array.isArray(body.known_peers) ? `; known peers: ${body.known_peers.join(', ') || 'none'}` : ''
    throw new PeerRelayError(`${typeof body.error === 'string' ? body.error : `peer relay returned HTTP ${res.status}`}${detail}${known}`)
  }
  const remote = (body.remote && typeof body.remote === 'object' ? body.remote : {}) as { switchboard?: { delivered_notification?: unknown } }
  return {
    envelope_id: String(body.envelope_id ?? ''),
    peer: String(body.peer ?? input.target.peer),
    delivered_notification: remote.switchboard?.delivered_notification === true,
  }
}
