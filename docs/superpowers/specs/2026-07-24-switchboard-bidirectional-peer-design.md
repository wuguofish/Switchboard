# Switchboard 雙邊 Peer 化設計（Codex 完整入網）

- 日期：2026-07-24
- 狀態：**實作完成**（五階段交付＋HTTP peer message-read endpoint）
- 參與：阿童（決策）、阿宇（Claude Code）、小回（Codex）
- 討論紀錄：codex thread `019f926a-2c4e-78d2-be12-147118a942ab`（`codex resume` 可回看完整往返）
- 實作 commits：`87eced6`（schema migration）→ `15abe60`（HTTP register/unregister）→
  `09a4d5e`＋`707d6b7`（lease、/poll 一般化、generation guard 全通路）→
  `657acbd`（broadcast scope）；waker 在 codex-bridge repo `cad6583`
- 已實作 `POST /messages/read`：由
  `client_kind + client_session_id + generation` 驗證 active session 身分，
  回傳與 MCP `read_messages` 相同欄位並共用一致的 read-at 語意。
  Codex waker 可透過既有 full-message adapter 接入，不需直接讀取 SQLite。

## 背景與目標

現況 Codex 只是 `/external/send` 的「外部寄件者」：能寄不能收、沒有正式身分、
不受上下線管理。目標是讓 Codex 與 Claude Code 都成為完整 peer——都有 alias、
可主動互傳、可被廣播、有誠實的 online 狀態——同時保留既有 Claude Code 相容性。

## 核心架構原則：誠實的電話交換機

**Switchboard 只負責註冊、routing、儲存訊息與 `/poll`；喚醒邏輯放 client 端，兩邊對稱。**

- Claude Code 端：既有 poller-shim / Monitor（不變）。
- Codex 端：新增 thin **waker**——long-poll `/poll?client_session_id=...`，
  收到 unread 後自行呼叫 app-server 喚醒 thread。
- daemon **不**內建依 client_kind 切換的 wake adapter，不引入對 codex-rs
  協定／版本的相依。喚醒失敗的重試與分診留在最懂該 client 的一側。

## Schema 變更（一次 migration 做完）

sessions 表：

| 欄位 | 說明 |
|---|---|
| `client_kind TEXT NOT NULL DEFAULT 'claude_code'` | `claude_code` \| `codex` \| `external` |
| `client_session_id`（由 `cc_session_id` RENAME） | 穩定的 client instance 識別。Codex 端＝waker instance UUID，**不是 thread_id**（thread_id 是 waker 內部狀態，會換、不進 DB） |
| `cwd TEXT` | register 時登記，供廣播分眾的「同 cwd」判斷 |
| `last_seen_at TEXT` | lease 續租時戳（見 online 判定） |

messages 表：

| 欄位 | 說明 |
|---|---|
| `reply_to TEXT`（nullable） | peer 對 peer 非同步對話的 threading；加了先不用也不痛 |

索引：唯一索引改為 `(client_kind, client_session_id) WHERE client_session_id IS NOT NULL AND released_at IS NULL`——以 kind 為命名空間，避免異質 id 撞衫。

Migration：既有列 `client_kind` 全填 `'claude_code'`；歷史 external 寄件者列不做啟發式回溯，交給 retention 自然收掉。

不採用的候選：`wake_config`（存 thread_id）——client-side waker 定案後
Switchboard 不需要知道 thread_id，DB 不存會過期的東西。

## Register API

- 既有 MCP `register(role, cc_session_id)` 保留，`cc_session_id` 參數名相容映射到 `client_session_id`。
- 新增 `POST /register`（HTTP，給不持 MCP 連線的 peer）：
  `{alias, client_kind, client_session_id, cwd, wake?}` → 以 `(client_kind, client_session_id)` 冪等 upsert，回 `session_id`＋generation token。
- **Generation token**：每次 re-register 遞增；unregister 須帶 token，
  舊 waker 的延遲 unregister 不能誤殺重新註冊的新 instance。

## Online 判定：lease 制（小回提案，取代 rollout mtime 掃描）

- `online = 有活的 MCP 連線 OR 正在 /poll OR lease 未過期`
- lease 續租搭便車：`/poll` 打進來就更新 `last_seen_at`，不另開 heartbeat 機制。
- lease TTL：幾分鐘等級（建議 2–5 分鐘）。
- 優雅退出：顯式 `unregister`（帶 generation token）。
- crash／斷網：lease 自然過期，**投遞當下**即被排除，不等兩小時 tick。
- 兩小時 heartbeat tick 降級為清理工：lease 過期已久的 session 補蓋 `released_at`。
- **rollout jsonl mtime 不進 online 判定**（假陰性：waker 安靜等工作、長 turn 中不落檔；
  假陽性：阿童本人在 CLI 操作同 thread、跨日 resume 對原路徑 append）——留作 observability。

## 廣播分眾（阿童定案）

`broadcast(scope, ...)` 三種 scope：

1. `all`——全部 active session
2. `same_kind`——同 client_kind、跨 cwd
3. `same_cwd`——同 cwd、跨 client_kind

Codex peer 的投遞規則：**一律只投遞給在線（lease 有效）的**——離線連信箱都不進。
成立前提是上下線紀律：waker 開工才 poll、收工顯式 unregister，
不做成永遠掛著的常駐行程（否則永遠在線，分眾失去意義）。此紀律寫進 waker 規格
與 Codex 端行為守則。

## Codex waker 政策（小回自訂，記錄於此供查）

- 小型通知：開新 thread 附摘要；需要既有上下文才 resume 原 thread（巨型 thread 的 continue 成本隨歷史線性成長）。
- 權限快照失效（config.toml 變更後舊 thread 吃不到）：開新 thread，不重試舊的。
- app-server 同 client turn 序列化：喚醒 turn 排在長 turn 後屬正常，容忍延遲，不因 timeout 重派。
- message id 去重，避免 timeout 後同一訊息執行兩次。
- 長 turn 期間 lease 續租由獨立 loop 維持，不能被 Codex turn 阻塞。

## 其他定案

- `/external/send` 保留為 legacy 相容入口，視為 untrusted sender；正式 peer 的
  sender 身分由註冊 session 決定，不接受自由冒名。
- Codex peer 正式 alias：`小回(codex)`（本機）；家裡機器對應小葵。
- `delivered_notification` 一般化定義：訊息寫入當下，收件者存在活的喚醒通道
  （MCP push 成功或 isPolling 或 lease 有效）。
- 訊息真相永遠是 `read_at`；喚醒只是門鈴，best-effort。

## 風險與備忘

- 上下線紀律是承重牆——waker 行為漂移（忘記 unregister、常駐化）會讓分眾失真；
  lease 是對應的保險絲。
- `same_cwd` 依賴 register 時的 cwd 誠實申報；跨機器同名路徑不衝突（daemon 是 per-machine loopback）。
- 實作順序建議：schema migration（含 reply_to、cwd、last_seen_at）→ POST /register
  → /poll 一般化 → broadcast scope → Codex waker（獨立小專案，可與 codex-bridge 同 repo 或新 repo，阿童決定）。
