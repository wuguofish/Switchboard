/**
 * Switchboard doorbell for an interactive OpenCode TUI.
 *
 * This is deliberately a TUI-target plugin, separate from switchboard.ts's
 * server target. It owns only the session currently shown by this TUI, so it
 * never registers the headless switchboard identity or historical sessions.
 */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const SWITCHBOARD_URL = (process.env.SWITCHBOARD_URL ?? "http://127.0.0.1:9876").replace(/\/$/, "")
const ROUTE_CHECK_MS = 750
const STANDBY_RETRY_MS = 5_000
const REQUEST_TIMEOUT_MS = 15_000
const POLL_TIMEOUT_S = 240

type SessionTarget = {
  id: string
  alias: string
  directory: string
}

type Peer = SessionTarget & {
  preferredAlias: string
  generation: number
  stopping: boolean
  abort: AbortController
}

type Selection = SessionTarget & {
  blocked: boolean
  retryAt: number
  conflictNotified: boolean
  unavailableNotified: boolean
}

type RegisterResult =
  | { status: "registered"; alias: string; generation: number }
  | { status: "conflict" }
  | { status: "stale" }
  | { status: "unavailable" }

type ReadResult =
  | { status: "messages"; messages: any[] }
  | { status: "stale" }
  | { status: "unavailable" }

type PendingDelivery = {
  messages: any[]
  notified: boolean
  delivery: Promise<"ok" | "unavailable"> | null
}

function sessionSlug(title: string | undefined): string {
  const slug = (title ?? "session")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
  return slug || "session"
}

function sessionAlias(id: string, title: string | undefined, fullId = false): string {
  return `小回-${sessionSlug(title)}-${fullId ? id : id.slice(-8)}`
}

async function responseJson(response: Response): Promise<any> {
  return response.json().catch(() => null)
}

function requestSignal(abort?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return abort ? AbortSignal.any([abort, timeout]) : timeout
}

const tui: TuiPlugin = async (api) => {
  const ownerToken = crypto.randomUUID()
  let disposed = false
  let selection: Selection | null = null
  let peer: Peer | null = null
  let reconciling: Promise<void> | null = null
  const pendingBySession = new Map<string, PendingDelivery>()

  function currentTarget(): SessionTarget | null {
    const route = api.route.current
    if (route.name !== "session") return null
    const sessionID = route.params?.sessionID
    if (typeof sessionID !== "string" || !sessionID) return null
    const info = api.state.session.get(sessionID)
    return {
      id: sessionID,
      alias: sessionAlias(sessionID, info?.title),
      directory: info?.directory ?? api.state.path.directory ?? process.cwd(),
    }
  }

  async function postRegister(target: SessionTarget, alias: string, abort?: AbortSignal): Promise<Response> {
    return fetch(`${SWITCHBOARD_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        alias,
        client_kind: "codex",
        client_session_id: target.id,
        cwd: target.directory,
        owner_token: ownerToken,
      }),
      signal: requestSignal(abort),
    })
  }

  async function registerTarget(target: SessionTarget, abort?: AbortSignal): Promise<RegisterResult> {
    try {
      let alias = target.alias
      let response = await postRegister(target, alias, abort)
      let data = await responseJson(response)

      if (response.status === 409 && data?.code === "owner_conflict") {
        return { status: "conflict" }
      }
      if (response.status === 409 && (
        data?.code === "stale_generation" || data?.code === "owner_mismatch"
      )) {
        return { status: "stale" }
      }

      // A plain 409 is an alias collision. Keep the readable short suffix for
      // the normal case, but retry with the stable full session ID if needed.
      if (response.status === 409) {
        alias = sessionAlias(target.id, api.state.session.get(target.id)?.title, true)
        response = await postRegister(target, alias, abort)
        data = await responseJson(response)
        if (response.status === 409 && data?.code === "owner_conflict") {
          return { status: "conflict" }
        }
        if (response.status === 409 && (
          data?.code === "stale_generation" || data?.code === "owner_mismatch"
        )) {
          return { status: "stale" }
        }
      }

      if (!response.ok || !Number.isSafeInteger(data?.generation)) {
        return { status: "unavailable" }
      }
      return {
        status: "registered",
        alias: typeof data.alias === "string" ? data.alias : alias,
        generation: data.generation,
      }
    } catch {
      return { status: "unavailable" }
    }
  }

  async function unregisterPeer(current: Peer): Promise<void> {
    current.stopping = true
    current.abort.abort()
    await fetch(`${SWITCHBOARD_URL}/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_kind: "codex",
        client_session_id: current.id,
        generation: current.generation,
        owner_token: ownerToken,
      }),
      signal: requestSignal(),
    }).catch(() => {})
  }

  function stopWaking(current: Peer): void {
    current.stopping = true
    current.abort.abort()
    if (peer !== current) return
    peer = null
    if (selection?.id === current.id) selection.blocked = true
  }

  async function readMessages(current: Peer): Promise<ReadResult> {
    try {
      const response = await fetch(`${SWITCHBOARD_URL}/messages/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_kind: "codex",
          client_session_id: current.id,
          generation: current.generation,
          owner_token: ownerToken,
        }),
        signal: requestSignal(current.abort.signal),
      })
      const data = await responseJson(response)
      if (response.status === 409 && (
        data?.code === "stale_generation" || data?.code === "owner_mismatch"
      )) {
        return { status: "stale" }
      }
      if (!response.ok || !Array.isArray(data?.messages)) {
        return { status: "unavailable" }
      }
      return { status: "messages", messages: data.messages }
    } catch {
      return { status: current.stopping ? "stale" : "unavailable" }
    }
  }

  async function wake(current: Peer): Promise<"ok" | "stale" | "unavailable"> {
    let pending = pendingBySession.get(current.id)
    if (!pending) {
      const result = await readMessages(current)
      if (result.status !== "messages") return result.status
      if (result.messages.length === 0) return "ok"
      pending = { messages: result.messages, notified: false, delivery: null }
      // /messages/read has already acknowledged this batch on the daemon. Keep
      // it locally until promptAsync succeeds so a transient OpenCode/TUI error
      // does not turn the acknowledged mail into a lost wake.
      pendingBySession.set(current.id, pending)
    }

    if (pending.delivery) return pending.delivery
    const delivery = (async (): Promise<"ok" | "unavailable"> => {
      const summary = `${current.alias} 收到 ${pending.messages.length} 封新訊息`
      if (!pending.notified) {
        pending.notified = true
        try {
          api.ui.toast({
            title: "Switchboard",
            message: summary,
            variant: "info",
            duration: 5_000,
          })
        } catch {}
        await api.attention.notify({
          title: "Switchboard",
          message: `收到 ${pending.messages.length} 封新訊息`,
          notification: { when: "blurred" },
          sound: false,
        }).catch(() => {})
      }

      const claimHint = `\n\n請先用 switchboard MCP register 認領本分機:` +
        ` client_kind='codex', client_session_id='${current.id}'。` +
        `認領後回覆會使用同一個門牌「${current.alias}」。`
      const text = `Switchboard 站內信（${pending.messages.length} 封,已代你標記已讀）:\n\n` +
        pending.messages.map((message: any) =>
          `— 來自 ${message.sender_alias ?? message.sender_id}` +
          `（${message.created_at}${message.is_broadcast ? ",廣播" : ""}）:\n${message.content}`
        ).join("\n\n") +
        `${claimHint}\n\n請依訊息內容處理;需要回覆時用你的 switchboard MCP send 工具(收件人通常是 main=阿宇)。`

      try {
        const prompted = await api.client.session.promptAsync({
          sessionID: current.id,
          parts: [{ type: "text", text }],
        })
        if (prompted.error) return "unavailable"
        if (pendingBySession.get(current.id) === pending) pendingBySession.delete(current.id)
        return "ok"
      } catch {
        return "unavailable"
      }
    })()
    pending.delivery = delivery
    try {
      return await delivery
    } finally {
      if (pendingBySession.get(current.id) === pending && pending.delivery === delivery) {
        pending.delivery = null
      }
    }
  }

  async function poll(current: Peer): Promise<void> {
    while (!disposed && !current.stopping) {
      try {
        if (pendingBySession.has(current.id)) {
          const outcome = await wake(current)
          if (outcome === "stale") {
            stopWaking(current)
            return
          }
          if (outcome === "unavailable") await waitForRetry(current.abort.signal)
          continue
        }
        const url = new URL(`${SWITCHBOARD_URL}/poll`)
        url.searchParams.set("client_kind", "codex")
        url.searchParams.set("client_session_id", current.id)
        url.searchParams.set("generation", String(current.generation))
        url.searchParams.set("owner_token", ownerToken)
        url.searchParams.set("timeout_s", String(POLL_TIMEOUT_S))
        const response = await fetch(url, {
          signal: AbortSignal.any([
            current.abort.signal,
            AbortSignal.timeout((POLL_TIMEOUT_S + 15) * 1_000),
          ]),
        })
        const data = await responseJson(response)

        if (response.status === 409 && (
          data?.code === "stale_generation" || data?.code === "owner_mismatch"
        )) {
          stopWaking(current)
          return
        }
        if (!response.ok) throw new Error(`poll failed: ${response.status}`)

        if (data?.status === "unread") {
          const outcome = await wake(current)
          if (outcome === "stale") {
            stopWaking(current)
            return
          }
          if (outcome === "unavailable") await waitForRetry(current.abort.signal)
        } else if (data?.status === "no-session") {
          current.stopping = true
          if (peer === current) {
            peer = null
            if (selection?.id === current.id) selection.retryAt = Date.now() + STANDBY_RETRY_MS
          }
          return
        }
      } catch {
        if (disposed || current.stopping) return
        await waitForRetry(current.abort.signal)
      }
    }
  }

  async function waitForRetry(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, STANDBY_RETRY_MS)
      signal.addEventListener("abort", () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }

  async function applyRegistration(target: SessionTarget, existing?: Peer): Promise<void> {
    const abort = existing?.abort ?? new AbortController()
    const result = await registerTarget(target, abort.signal)
    if (!selection || selection.id !== target.id || disposed) {
      if (result.status === "registered") {
        await unregisterPeer({
          ...target,
          preferredAlias: target.alias,
          alias: result.alias,
          generation: result.generation,
          stopping: false,
          abort,
        })
      }
      return
    }

    if (result.status === "registered") {
      selection.conflictNotified = false
      selection.unavailableNotified = false
      if (existing) {
        if (existing.generation !== result.generation) {
          // A legacy owner may have taken the identity between route ticks.
          // Abort the in-flight poll tied to the old generation and start a
          // fresh peer; mutating generation underneath a long-poll would make
          // its eventual 409 look like a loss of the newly reacquired owner.
          existing.stopping = true
          existing.abort.abort()
          const restarted: Peer = {
            ...target,
            preferredAlias: target.alias,
            alias: result.alias,
            generation: result.generation,
            stopping: false,
            abort: new AbortController(),
          }
          peer = restarted
          void poll(restarted)
          return
        }
        existing.alias = result.alias
        existing.preferredAlias = target.alias
        existing.directory = target.directory
        existing.generation = result.generation
        return
      }
      const started: Peer = {
        ...target,
        preferredAlias: target.alias,
        alias: result.alias,
        generation: result.generation,
        stopping: false,
        abort,
      }
      peer = started
      void poll(started)
      return
    }

    if (existing) {
      existing.stopping = true
      existing.abort.abort()
      if (peer === existing) peer = null
    }
    if (result.status === "stale") {
      selection.blocked = true
      return
    }
    selection.retryAt = Date.now() + STANDBY_RETRY_MS
    if (result.status === "conflict" && !selection.conflictNotified) {
      selection.conflictNotified = true
      api.ui.toast({
        title: "Switchboard",
        message: "此 session 門鈴由另一視窗持有",
        variant: "info",
        duration: 5_000,
      })
    } else if (result.status === "unavailable" && !selection.unavailableNotified) {
      selection.unavailableNotified = true
      api.ui.toast({
        title: "Switchboard",
        message: "門鈴暫時無法連線，稍後重試",
        variant: "warning",
        duration: 5_000,
      })
    }
  }

  async function reconcile(): Promise<void> {
    while (!disposed) {
      const target = currentTarget()
      if (selection?.id !== target?.id) {
        const previous = peer
        peer = null
        selection = target ? {
          ...target,
          blocked: false,
          retryAt: 0,
          conflictNotified: false,
          unavailableNotified: false,
        } : null
        if (previous) await unregisterPeer(previous)
        continue
      }
      if (!target || !selection || selection.blocked) return

      selection.alias = target.alias
      selection.directory = target.directory
      if (peer) {
        if (peer.preferredAlias !== target.alias || peer.directory !== target.directory) {
          await applyRegistration(target, peer)
          continue
        }
        return
      }
      if (Date.now() < selection.retryAt) return
      await applyRegistration(target)
      return
    }
  }

  function scheduleReconcile(): void {
    if (reconciling || disposed) return
    reconciling = reconcile().finally(() => {
      reconciling = null
    })
  }

  const routeTimer = setInterval(scheduleReconcile, ROUTE_CHECK_MS)
  ;(routeTimer as any).unref?.()
  scheduleReconcile()

  api.lifecycle.onDispose(async () => {
    disposed = true
    clearInterval(routeTimer)
    await reconciling?.catch(() => {})
    const current = peer
    peer = null
    selection = null
    if (current) await unregisterPeer(current)
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "switchboard.tui-doorbell",
  tui,
}

export default plugin
