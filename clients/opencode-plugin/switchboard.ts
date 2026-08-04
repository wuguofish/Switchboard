/**
 * Switchboard peer plugin for OpenCode（小回的門鈴）
 *
 * 職責（對應 Switchboard 雙邊 peer 設計的 client-side waker）:
 *   1. server 啟動時向 Switchboard 註冊（client_kind=codex、穩定 instance UUID、generation-aware）
 *   2. long-poll /poll 續租 lease;收到 unread 訊號就喚醒小回的常駐 session
 *   3. session.idle 時透過 /external/send 回報 main（阿宇）
 *   4. server 內近期活躍的 session 各自註冊、收信與喚醒
 *   5. session 閒置逾時或行程結束時帶 generation 優雅 unregister
 *
 * 讀信優先走 generation-guarded HTTP 端點；端點暫時不可用時才降級為
 * 只帶未讀數量的喚醒訊號。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

const SWITCHBOARD_URL = (process.env.SWITCHBOARD_URL ?? "http://127.0.0.1:9876").replace(/\/$/, "")
const ALIAS = process.env.SWITCHBOARD_PEER_ALIAS ?? "小回(codex)"
const INSTANCE_ID_PATH = join(homedir(), ".config", "opencode", "switchboard-instance-id")
const SESSION_ID_PATH = join(homedir(), ".config", "opencode", "switchboard-session-id")
const POLL_TIMEOUT_S = 240
const SESSION_ACTIVE_MS = 30 * 60 * 1000

type SessionInfo = {
  id: string
  title?: string
  directory?: string
  time?: { updated?: number }
}

type SessionPeer = {
  sessionId: string
  alias: string
  generation: number | null
  lastActivityAt: number
  lastWokenCount: number
  wakePending: boolean
  stopping: boolean
  pollAbort: AbortController | null
  idleTimer: ReturnType<typeof setTimeout> | null
}

function responseData<T = any>(result: any): T | null {
  return (result?.data ?? result) as T ?? null
}

function sessionSlug(title: string | undefined): string {
  const slug = (title ?? "session")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
  return slug || "session"
}

function sessionAlias(info: SessionInfo, fullId = false): string {
  const idPart = fullId ? info.id : info.id.slice(-8)
  return `小回-${sessionSlug(info.title)}-${idPart}`
}

function loadOrCreateInstanceId(): string {
  if (existsSync(INSTANCE_ID_PATH)) {
    const id = readFileSync(INSTANCE_ID_PATH, "utf8").trim()
    if (id) return id
  }
  const id = crypto.randomUUID()
  mkdirSync(dirname(INSTANCE_ID_PATH), { recursive: true })
  writeFileSync(INSTANCE_ID_PATH, id)
  return id
}

export const SwitchboardPeer = async ({ client, directory }: any) => {
  // 門鈴只在 headless server（systemd unit 帶 SWITCHBOARD_DOORBELL=1）啟用。
  // TUI 行程也會載入本 plugin,若不擋,會用同一個 instance 身分重複註冊、
  // 搶走總機的 generation（2026-07-29 實測 generation 被灌到 10）。
  if (process.env.SWITCHBOARD_DOORBELL !== "1") {
    return {}
  }
  const instanceId = loadOrCreateInstanceId()
  let generation: number | null = null
  let sessionId: string | null = existsSync(SESSION_ID_PATH)
    ? readFileSync(SESSION_ID_PATH, "utf8").trim() || null
    : null
  let stopping = false
  let wakePending = false // 節流:session 忙碌中不重複塞喚醒 prompt
  // 未讀節流:Switchboard 尚無讀信端點,未讀數不會下降——同一計數只喚醒一次,
  // 否則會陷入 poll→喚醒→idle→poll 的無限迴圈(2026-07-29 實戰血淚)
  let lastWokenCount = 0
  const peers = new Map<string, SessionPeer>()

  const log = (msg: string) =>
    client.app?.log?.({ body: { service: "switchboard-peer", level: "info", message: msg } }).catch(() => {})

  async function register(): Promise<void> {
    const res = await fetch(`${SWITCHBOARD_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        alias: ALIAS,
        client_kind: "codex",
        client_session_id: instanceId,
        cwd: directory ?? process.cwd(),
      }),
    })
    if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`)
    const data = await res.json()
    generation = data.generation
    log(`registered alias=${data.alias} instance=${instanceId} generation=${generation}`)
  }

  async function unregister(): Promise<void> {
    if (generation === null) return
    await fetch(`${SWITCHBOARD_URL}/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_kind: "codex", client_session_id: instanceId, generation }),
    }).catch(() => {})
  }

  async function ensureSession(): Promise<string> {
    if (sessionId) {
      // 存在性檢查改走 SDK 的 session.list（實證可用）。
      // 舊版用 client.baseUrl 拼 URL——該屬性拿不到值,檢查永遠失敗,
      // 每次總機喚醒都誤開新常駐站(2026-07-30 實測:一天生兩間,
      // 且每通電話都是「失憶的新小回」)。list 失敗時傾向沿用舊 id
      // ——重複開站比誤用舊站更糟。
      try {
        const sessions = responseData<SessionInfo[]>(await client.session.list())
        if (!Array.isArray(sessions) || sessions.some((s) => s.id === sessionId)) {
          return sessionId
        }
      } catch {
        return sessionId
      }
    }
    const created = await client.session.create({ body: { title: "小回 switchboard 常駐站" } })
    sessionId = created?.data?.id ?? created?.id
    if (!sessionId) throw new Error("session create failed")
    writeFileSync(SESSION_ID_PATH, sessionId)
    return sessionId
  }

  async function registerPeer(peer: SessionPeer, info: SessionInfo, requestedAlias = peer.alias): Promise<void> {
    let alias = requestedAlias
    let res = await fetch(`${SWITCHBOARD_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        alias,
        client_kind: "codex",
        client_session_id: peer.sessionId,
        cwd: info.directory ?? directory ?? process.cwd(),
      }),
    })
    // The short ID suffix is readable and normally unique. On a real collision,
    // retry with the full stable session ID rather than stealing another alias.
    if (res.status === 409) {
      alias = sessionAlias(info, true)
      res = await fetch(`${SWITCHBOARD_URL}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alias,
          client_kind: "codex",
          client_session_id: peer.sessionId,
          cwd: info.directory ?? directory ?? process.cwd(),
        }),
      })
    }
    if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`)
    const data = await res.json()
    peer.alias = data.alias
    peer.generation = data.generation
    log(`registered session=${peer.sessionId} alias=${peer.alias} generation=${peer.generation}`)
  }

  async function unregisterPeer(peer: SessionPeer): Promise<void> {
    if (peer.generation === null) return
    const generation = peer.generation
    peer.generation = null
    await fetch(`${SWITCHBOARD_URL}/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_kind: "codex",
        client_session_id: peer.sessionId,
        generation,
      }),
    }).catch(() => {})
  }

  async function readPeerMessages(peer: SessionPeer): Promise<any[] | null> {
    if (peer.generation === null) return null
    try {
      const res = await fetch(`${SWITCHBOARD_URL}/messages/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_kind: "codex",
          client_session_id: peer.sessionId,
          generation: peer.generation,
        }),
      })
      if (!res.ok) return null
      const data = await res.json()
      return Array.isArray(data.messages) ? data.messages : null
    } catch {
      return null
    }
  }

  async function wakePeer(peer: SessionPeer, count: number): Promise<void> {
    if (peer.wakePending) {
      log(`wake suppressed session=${peer.sessionId} (busy), unread=${count}`)
      return
    }
    peer.wakePending = true
    const messages = await readPeerMessages(peer)
    if (messages) peer.lastWokenCount = 0
    const claimHint = `\n\n請先用 switchboard MCP register 認領本分機:` +
      ` client_kind='codex', client_session_id='${peer.sessionId}'。` +
      `認領後回覆會使用同一個門牌「${peer.alias}」。`
    const text = messages && messages.length
      ? `Switchboard 站內信（${messages.length} 封,已代你標記已讀）:\n\n` +
        messages.map((m: any) =>
          `— 來自 ${m.sender_alias ?? m.sender_id}（${m.created_at}${m.is_broadcast ? ",廣播" : ""}）:\n${m.content}`
        ).join("\n\n") +
        `${claimHint}\n\n請依訊息內容處理;需要回覆時用你的 switchboard MCP send 工具(收件人通常是 main=阿宇)。`
      : `Switchboard 未讀通知:你（${peer.alias}）有 ${count} 封未讀站內信,但讀信端點暫不可用——` +
        `請如實回報整合限制,不要猜測內容。${claimHint}`
    try {
      await (client.session.promptAsync?.({
        path: { id: peer.sessionId },
        body: { parts: [{ type: "text", text }] },
      }) ?? client.session.prompt({
        path: { id: peer.sessionId },
        body: { parts: [{ type: "text", text }] },
      }))
    } catch (e) {
      peer.wakePending = false
      peer.lastWokenCount = 0
      throw e
    }
    log(`woke session=${peer.sessionId} unread=${count} content=${messages ? "full" : "signal-only"}`)
  }

  async function pollPeer(peer: SessionPeer, info: SessionInfo): Promise<void> {
    while (!peer.stopping && !stopping) {
      try {
        peer.pollAbort = new AbortController()
        const timeout = AbortSignal.timeout((POLL_TIMEOUT_S + 15) * 1000)
        const signal = AbortSignal.any([peer.pollAbort.signal, timeout])
        const url = `${SWITCHBOARD_URL}/poll?client_kind=codex&client_session_id=${peer.sessionId}&timeout_s=${POLL_TIMEOUT_S}`
        const res = await fetch(url, { signal })
        const data = await res.json()
        if (data.status === "unread") {
          const count = data.count ?? 1
          if (count < peer.lastWokenCount) peer.lastWokenCount = count
          if (count > peer.lastWokenCount) {
            peer.lastWokenCount = count
            await wakePeer(peer, count)
          }
        } else if (data.status === "timeout") {
          // An empty-mailbox timeout resets this peer's own high-water mark;
          // otherwise a later first message can be suppressed by an old count.
          peer.lastWokenCount = 0
        } else if (data.status === "no-session") {
          log(`session peer released remotely; re-registering session=${peer.sessionId}`)
          await registerPeer(peer, info)
        }
      } catch (e) {
        if (peer.stopping || stopping) break
        log(`session poll error session=${peer.sessionId}, backing off: ${e}`)
        await new Promise((r) => setTimeout(r, 5000))
      } finally {
        peer.pollAbort = null
      }
    }
  }

  function schedulePeerExpiry(peer: SessionPeer): void {
    if (peer.idleTimer) clearTimeout(peer.idleTimer)
    const remaining = SESSION_ACTIVE_MS - (Date.now() - peer.lastActivityAt)
    peer.idleTimer = setTimeout(() => {
      if (Date.now() - peer.lastActivityAt < SESSION_ACTIVE_MS) {
        schedulePeerExpiry(peer)
        return
      }
      stopPeer(peer.sessionId, "inactive").catch(() => {})
    }, Math.max(remaining, 0))
    ;(peer.idleTimer as any).unref?.()
  }

  async function stopPeer(id: string, reason: string): Promise<void> {
    const peer = peers.get(id)
    if (!peer) return
    peers.delete(id)
    peer.stopping = true
    if (peer.idleTimer) clearTimeout(peer.idleTimer)
    peer.pollAbort?.abort()
    await unregisterPeer(peer)
    log(`unregistered session=${id} reason=${reason}`)
  }

  async function startPeer(info: SessionInfo, activityAt = Date.now()): Promise<void> {
    if (!info.id || info.id === sessionId || info.title === "小回 switchboard 常駐站") return
    const existing = peers.get(info.id)
    if (existing) {
      existing.lastActivityAt = Math.max(existing.lastActivityAt, activityAt)
      schedulePeerExpiry(existing)
      return
    }
    if (Date.now() - activityAt >= SESSION_ACTIVE_MS) return
    const peer: SessionPeer = {
      sessionId: info.id,
      alias: sessionAlias(info),
      generation: null,
      lastActivityAt: activityAt,
      lastWokenCount: 0,
      wakePending: false,
      stopping: false,
      pollAbort: null,
      idleTimer: null,
    }
    peers.set(info.id, peer)
    schedulePeerExpiry(peer)
    try {
      await registerPeer(peer, info)
      if (peer.stopping || stopping) {
        await unregisterPeer(peer)
      } else {
        pollPeer(peer, info)
      }
    } catch (e) {
      if (peers.get(info.id) === peer) peers.delete(info.id)
      if (peer.idleTimer) clearTimeout(peer.idleTimer)
      log(`session register failed session=${info.id}: ${e}`)
    }
  }

  async function seedRecentPeers(): Promise<void> {
    try {
      const result = await client.session.list()
      const sessions = responseData<SessionInfo[]>(result)
      if (!Array.isArray(sessions)) return
      await Promise.all(sessions.map((info) =>
        startPeer(info, info.time?.updated ?? 0)
      ))
    } catch (e) {
      log(`recent session scan failed: ${e}`)
    }
  }

  /** 讀取並標記自己的信件（POST /messages/read,generation-guarded）。端點不存在或驗證失敗時回 null 走降級。 */
  async function readOwnMessages(): Promise<any[] | null> {
    try {
      const res = await fetch(`${SWITCHBOARD_URL}/messages/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_kind: "codex", client_session_id: instanceId, generation }),
      })
      if (!res.ok) return null
      const data = await res.json()
      return Array.isArray(data.messages) ? data.messages : null
    } catch {
      return null
    }
  }

  async function wake(count: number): Promise<void> {
    if (wakePending) {
      log(`wake suppressed (session busy), unread=${count}`)
      return
    }
    wakePending = true
    const sid = await ensureSession()
    const messages = await readOwnMessages()
    if (messages) lastWokenCount = 0 // 信已讀走,水位歸零,下一封新信才叫得醒
    const text = messages && messages.length
      ? `Switchboard 站內信（${messages.length} 封,已代你標記已讀）:\n\n` +
        messages.map((m: any) =>
          `— 來自 ${m.sender_alias ?? m.sender_id}（${m.created_at}${m.is_broadcast ? ",廣播" : ""}）:\n${m.content}`
        ).join("\n\n") +
        `\n\n請依訊息內容處理;需要回覆時用你的 switchboard MCP send 工具(收件人通常是 main=阿宇)。`
      : `Switchboard 未讀通知:你（${ALIAS}）有 ${count} 封未讀站內信,但讀信端點暫不可用——` +
        `請如實回報整合限制,不要猜測內容。`
    await (client.session.promptAsync?.({
      path: { id: sid },
      body: { parts: [{ type: "text", text }] },
    }) ?? client.session.prompt({
      path: { id: sid },
      body: { parts: [{ type: "text", text }] },
    }))
    log(`woke session=${sid} unread=${count} content=${messages ? "full" : "signal-only"}`)
  }

  async function pollLoop(): Promise<void> {
    while (!stopping) {
      try {
        const url = `${SWITCHBOARD_URL}/poll?client_kind=codex&client_session_id=${instanceId}&timeout_s=${POLL_TIMEOUT_S}`
        const res = await fetch(url, { signal: AbortSignal.timeout((POLL_TIMEOUT_S + 15) * 1000) })
        const data = await res.json()
        if (data.status === "unread") {
          const count = data.count ?? 1
          if (count < lastWokenCount) lastWokenCount = count // 計數下降時跟著校正
          if (count > lastWokenCount) {
            lastWokenCount = count
            await wake(count)
          }
        } else if (data.status === "timeout") {
          // timeout = 信箱目前是空的（有未讀不會 timeout）→ 節流歸零,
          // 否則讀信清空後,下一封新信的 count 會被舊水位誤壓(2026-07-29 峰迴路轉事件)
          lastWokenCount = 0
        } else if (data.status === "no-session") {
          log("session released remotely; re-registering")
          await register()
        }
      } catch (e) {
        log(`poll error, backing off: ${e}`)
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  }

  // ---- 啟動 ----
  try {
    await register()
    pollLoop() // 不 await,長駐背景
    // seedRecentPeers 會呼叫 client.session.list() 回打本 server——
    // 若在 plugin 初始化路徑上 await 它,而初始化又是被某個 API 請求觸發的,
    // 就會 server 等 plugin、plugin 等 server 互相鎖死(2026-07-30 實測:
    // POST /session 全數懸掛)。延後到初始化完成之後非同步執行。
    setTimeout(() => { seedRecentPeers().catch((e) => log(`seed failed: ${e}`)) }, 3000)
  } catch (e) {
    log(`switchboard register failed (daemon down?): ${e}`)
  }

  const shutdown = async () => {
    if (stopping) return
    stopping = true
    await Promise.all([...peers.keys()].map((id) => stopPeer(id, "shutdown")))
    await unregister()
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)

  return {
    dispose: shutdown,
    event: async ({ event }: any) => {
      const eventInfo = event.properties?.info as any
      const info = (
        event.type === "session.created" ||
        event.type === "session.updated" ||
        event.type === "session.deleted"
      ) ? eventInfo as SessionInfo : undefined
      // Older SDK message.updated events carry sessionID inside info, while
      // newer SDK events expose it directly on properties; accept both shapes.
      const eventSessionId = event.properties?.sessionID ?? info?.id ?? eventInfo?.sessionID

      if (event.type === "session.deleted" && eventSessionId) {
        await stopPeer(eventSessionId, "deleted")
        return
      }

      // A 30-minute window keeps sessions reachable across ordinary pauses but
      // stops historical tabs from appearing online forever. Only concrete
      // session activity extends the window; merely having the server alive does not.
      if (eventSessionId && (
        event.type === "session.created" ||
        event.type === "session.updated" ||
        event.type === "message.updated" ||
        event.type === "session.status" ||
        event.type === "session.idle"
      )) {
        await startPeer(info ?? { id: eventSessionId }, Date.now())
      }

      if (event.type === "session.updated" && info) {
        const peer = peers.get(info.id)
        const alias = sessionAlias(info)
        const fallbackAlias = sessionAlias(info, true)
        if (peer && alias !== peer.alias && fallbackAlias !== peer.alias) {
          try {
            await registerPeer(peer, info, alias)
          } catch (e) {
            // Keep polling under the previous registration and retry on a later update.
            log(`session alias update failed session=${peer.sessionId} alias=${alias}: ${e}`)
          }
        }
      }

      // 小回的常駐 session 閒置 = 本輪工作收尾 → 回報阿宇,並解除喚醒節流
      if (event.type === "session.idle" && event.properties?.sessionID === sessionId) {
        // 只在「有一輪喚醒待收尾」時通知一次;重複的 idle 事件不再轟炸阿宇
        if (!wakePending) return
        wakePending = false
        await fetch(`${SWITCHBOARD_URL}/external/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: "main",
            from: ALIAS,
            message: "小回（OpenCode 身體）本輪工作已完成/閒置,如需結果請查看對應 session。",
          }),
        }).catch(() => {})
      }

      if (event.type === "session.idle" && eventSessionId) {
        const peer = peers.get(eventSessionId)
        if (!peer?.wakePending) return
        peer.wakePending = false
        await fetch(`${SWITCHBOARD_URL}/external/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: "main",
            from: peer.alias,
            message: `小回分機（OpenCode session ${peer.sessionId}）本輪工作已完成/閒置,如需結果請查看對應 session。`,
          }),
        }).catch(() => {})
      }
    },
  }
}
