export interface HookSpecificOutput {
  hookEventName: 'SessionStart'
  additionalContext: string
}

export interface HookOutput {
  hookSpecificOutput: HookSpecificOutput
}

export type Delivery = 'channel' | 'monitor'

// Monitor stays the default: the channel path needs a launch flag that
// background sessions (agent view, `claude --bg`) cannot carry, so a session
// opts into it explicitly with SWITCHBOARD_DELIVERY=channel.
export function resolveDelivery(raw: string | undefined): Delivery {
  return raw === 'channel' ? 'channel' : 'monitor'
}

export function buildHookOutput(input: string, delivery: Delivery = resolveDelivery(process.env.SWITCHBOARD_DELIVERY)): HookOutput | null {
  let payload: { session_id?: string }
  try {
    payload = JSON.parse(input)
  } catch {
    return null
  }
  const cc_session_id = payload.session_id
  if (!cc_session_id) return null

  const wakePath = delivery === 'channel' ? channelWakePath(cc_session_id) : monitorWakePath(cc_session_id)

  const context = `Switchboard MCP is available.

Your Claude Code session id is: ${cc_session_id}

Decide first whether this session needs Switchboard at all. Claude Code
2.1.224+ ships native cross-session messaging: ListAgents shows the other
Claude Code sessions on this machine by name, and SendMessage reaches them
directly, waking an idle one. For Claude Code talking to Claude Code on the
same machine, use that — it needs no registration and no Monitor watch.

Switchboard is for what the native path does not cover:
  - peers that are not Claude Code (Codex, OpenCode, anything on /register)
  - broadcast to every registered session at once
  - being reachable BY those peers or by broadcasts — a session that never
    sends anything itself still needs a Switchboard alias if its name is on
    someone else's delivery list

If any of those apply, register in your first turn:

  mcp__switchboard__register(role='<your-role-name>', cc_session_id='${cc_session_id}')

Pick a unique role name (e.g. main, scratch-refactor, video-editor).
If the role is already taken by another active session, pick a different one
or wait until that session disconnects.

If none apply, skip this — the session works anonymously on Switchboard,
and you can register later with set_alias() if the need appears.

${wakePath}`

  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  }
}

function channelWakePath(cc_session_id: string): string {
  return `Registering and watching go together. In this session the watch is the
Switchboard channel: the stdio server declared as "switchboard" in your MCP
config is spawned by Claude Code and pushes every inbox event straight into
this conversation as a <channel source="switchboard" kind="..."> tag, waking
the session when idle. No Monitor tool, no re-arming.

That only works if Claude Code was started with the channel enabled
(channels are a research preview, so the flag is required):

  claude --dangerously-load-development-channels server:switchboard

Check the startup banner for the line saying messages from server:switchboard
inject into this session. If it is missing, tell the user to restart with the
flag above, or to drop SWITCHBOARD_DELIVERY=channel from the environment so
the Monitor-tool path applies. Do not fall back to a Monitor watch on your
own: two wake paths on one session deliver every message twice.

Events you will see (kind attribute):
  inbox      unread waiting; call mcp__switchboard__read_messages
  hello      subscribed; no action needed
  heartbeat  clock tick with the Taipei time in "at"; no action, no reply`
}

function monitorWakePath(cc_session_id: string): string {
  return `Registering and watching go together. An alias without a watch is a door
with nobody behind it: messages queue up and no one learns they arrived.
So right after register succeeds, subscribe to the inbox stream with the
Monitor tool; each new-message event wakes this session even when idle:

  Monitor({
    description: 'switchboard inbox',
    timeout_ms: 1800000,
    command: 'while :; do curl -sN http://127.0.0.1:9876/monitor?cc_session_id=${cc_session_id} || true; sleep 5; done',
  })

Claude Code 2.1.271 removed Monitor's no-timeout \`persistent\` option: every
watch now has a deadline of at most 30 minutes (10 in \`-p\` runs). When it
expires you get one notice saying so — re-arm with the same call to stay
subscribed. A session that ignores that notice silently stops being reachable,
so treat the expiry notice as work, not noise.

Each line on the stream becomes a notification:
  hello <alias>             -> baseline on connect, no action needed
  inbox <N> <alias>         -> unread waiting; call mcp__switchboard__read_messages
  heartbeat <Asia/Taipei>   -> ~4-hr time tick (e.g. "heartbeat
                               2026-04-24(五)T13:38:25.000+08:00" — the
                               (X) after the date is the Taipei weekday,
                               read it instead of working it out from the
                               date yourself); just a clock signal, no
                               action needed (don't reply "Heartbeat OK")

The 240s TCP keep-alive is a single space byte without a newline, so the
Monitor tool stays silent between heartbeat lines.

The \`while :; do ... sleep 5; done\` wrapper auto-reconnects if the daemon
restarts. Skip subscribing only if you're staying anonymous.

The heartbeat interval defaults to 4 hours and is yours to set — append
\`&heartbeat_secs=N\` to the URL (clamped to 240..86400):

  ...?cc_session_id=\${cc_session_id}&heartbeat_secs=7200   # every 2 hours

Why the default is that long: every heartbeat wake is a cold start, because
the prompt cache has expired by then, so the whole context is rewritten at
cache-write price. Sessions on a fixed cadence (scheduled reminders) should
shorten it; sessions that are purely on standby can lengthen it.

Note since 2.1.271: the 30-minute watch deadline now sets the floor on idle
wakes, so a heartbeat longer than 30 minutes no longer lowers the wake rate —
the re-arm notice arrives first either way. Lengthening the heartbeat past
30 minutes only stops the clock tick, not the cold start.`
}

export async function main() {
  const input = await Bun.stdin.text()
  const out = buildHookOutput(input)
  if (out) {
    console.log(JSON.stringify(out))
  }
  process.exit(0)
}

if (import.meta.main) {
  main()
}
