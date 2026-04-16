export interface HookSpecificOutput {
  hookEventName: 'SessionStart'
  additionalContext: string
}

export interface HookOutput {
  hookSpecificOutput: HookSpecificOutput
}

export function buildHookOutput(input: string): HookOutput | null {
  let payload: { session_id?: string }
  try {
    payload = JSON.parse(input)
  } catch {
    return null
  }
  const cc_session_id = payload.session_id
  if (!cc_session_id) return null

  const context = `Switchboard MCP is available.

Your Claude Code session id is: ${cc_session_id}

If you want this session to be reachable from other sessions via a named
alias (so other sessions can send you messages with mcp__switchboard__send
and wake you up on new inbox), call this in your first turn:

  mcp__switchboard__register(role='<your-role-name>', cc_session_id='${cc_session_id}')

Pick a unique role name (e.g. tsunu-main, scratch-refactor, video-editor).
If the role is already taken by another active session, pick a different one
or wait until that session disconnects.

If you don't want to be reachable, you can skip this — the session will
work anonymously, and you can register later with set_alias() if you
change your mind.`

  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  }
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
