# CLAUDE.md — switchboard

本地 MCP Server，讓多個 Claude Code session 互傳訊息。對應的 design spec 在 `docs/superpowers/specs/2026-04-15-switchboard-mcp-design.md`。

## 運行

```bash
bun install
bun main.ts            # foreground
# or
powershell -File start-daemon.ps1  # detached background
```

環境變數：
- `SWITCHBOARD_PORT` — 預設 9876
- `SWITCHBOARD_DB` — 預設 `C:/Users/ATone/.claude/switchboard.db`

## 架構要點

- **Transport**：Streamable HTTP MCP，bind 127.0.0.1。Bun 環境用 `WebStandardStreamableHTTPServerTransport`（SDK 為 Bun/Deno/CF Workers 提供的 variant），不走 `node:http`。
- **State**：in-memory connection registry + SQLite（sessions, messages）
- **Time**：DB 內部存 UTC ISO 8601；API response 透過 `toTaipeiISOString` 轉 `Asia/Taipei +08:00`（跟 `claude-line-channel` 一致）
- **Online 判斷**：MCP connection 活著 = online（沒有 heartbeat）
- **Recall**：hard delete；broadcast 的 recall 會 group delete 整組
- **Retention**：已讀訊息 7 天後由 `retention.ts` 背景清掉

## 測試

```bash
bun test              # all
bun test tests/db.test.ts
bun test tests/integration.test.ts
```

## 注意事項

- 這個 daemon 沒有 auth，只 bind loopback，不能暴露到 0.0.0.0
- SessionStart hook（client-side）需要在 Claude Code 啟動時提示 session 呼叫 `register()` 和 `read_messages()`——見 `D:/tsunu_plan/.claude/settings.json` 裡的 hook 設定
- `/rename` Claude Code 指令改的是 transcript metadata，MCP subprocess 看不到；所以 switchboard 用 `register(role)` 明確命名，不依賴 Claude Code 的 session name

## 踩坑紀錄（Implementation notes）

改 `server.ts` 前先看這一段，省掉重踩一次的時間。

### 1. Bun.serve 預設 idleTimeout 會砍掉 MCP SSE 長連線

**症狀**：client 連上後 ~10 秒斷線，Claude Code 端看到 500 Internal server error，daemon stderr 看到 `[Bun.serve]: request timed out after 10 seconds. Pass idleTimeout to configure.`

**原因**：MCP Streamable HTTP 的 GET /mcp 是長存 SSE 串流，等 server 推 notification。Bun.serve 預設把超過 10s 沒活動的 request 砍掉，導致 client reconnect loop，最後爆 500。

**修法**：`Bun.serve({ idleTimeout: 255, ... })`。255 是 Bun 允許的上限（約 4.25 分鐘）。只要 push notification 間隔別超過這個數字就穩。如果未來真的會有長時間沒動靜，改成在 `connections.ts` 加一個 keepalive tick。

### 2. Bun 環境用 WebStandardStreamableHTTPServerTransport，不是 StreamableHTTPServerTransport

**原因**：SDK v1 的 `StreamableHTTPServerTransport`（`@modelcontextprotocol/sdk/server/streamableHttp.js`）是 Node `http.IncomingMessage` / `ServerResponse` 介面寫的，在 Bun 上要轉接。SDK 自己的 docstring 就寫：

> "For web-standard environments (Cloudflare Workers, Deno, Bun), use `WebStandardStreamableHTTPServerTransport` directly."

**正解**：`import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'`。它的 `handleRequest(req, { parsedBody })` 接 Fetch `Request` 回 `Response`，跟 `Bun.serve` 的 `fetch()` handler 無縫對接，不用 node:http。

**順便**：body 要先讀一次判斷是不是 `isInitializeRequest`，讀完後要把 `parsedBody` 當第二參數傳給 `handleRequest`，不然 transport 會 double-read body 報錯。看 `createMcpSession()` 那段就知道怎麼接。

## Phase 2.5: Auto-wake with per-session identity（opt-in）

背景 poller + Stop hook auto-wake，讓 idle session 有新訊息時自動喚醒。身份綁定從 workspace 層級（Phase 2 的 `SWITCHBOARD_ROLE` env var）移到每個 Claude Code session 的 `session_id`，所以同一個 workspace 裡並行的多個 session 各自有獨立身份、獨立 poller。設計 spec：`docs/superpowers/specs/2026-04-16-switchboard-phase2-5-per-session-identity-design.md`。

### 啟用流程

1. 把 `client-hooks.example.json` 的內容 **merge** 進 workspace 的 `.claude/settings.local.json`（保留現有 permissions array，只加 `hooks` 欄位）
2. `/hooks` reload 設定
3. Session 啟動時 `hook-session-start.ts` 從 hook stdin 讀到 cc_session_id，注入成 additionalContext，告訴 session 內的 Claude 它自己的 id
4. Claude 看到 additionalContext 後，自己決定要不要 `register(role, cc_session_id)`，以什麼名字上線（不上線 = 這個 session 匿名存在，不能被其他 session 找到）
5. 每次 turn 結束 Stop hook 把 stdin JSON pipe 給 `poller-shim.ps1`，shim 呼叫 daemon 的 `/poll` long-polling endpoint（~30-50 MB PowerShell vs. 舊版 `bun poller.ts` ~150 MB）
6. Daemon 偵測到新訊息 → `/poll` 回 `status=unread` → shim `exit 2` 喚醒 session → 自動 spawn 新 turn

### Runtime state files

- `D:\tsunu_plan\.claude\switchboard-poller-<cc_session_id>.state` — 舊版 `bun poller.ts` 用的 pid state（留作向後相容）；新版 `poller-shim.ps1` 不寫 state file，改由 daemon 的 in-memory `pollingSessions` 提供 liveness 訊號

### 舊版 `bun poller.ts`（仍可用作 fallback）

舊的 Stop hook command `bun D:/tsunu_plan/mcp-servers/switchboard/poller.ts` 仍然能 work — 會寫 state file，parent-pid alive check 也已就位。但每個 poller 子進程 ~150 MB，並行多個 session 時記憶體壓力大。預設改用 shim，舊版只推薦在 PowerShell 不可用的環境使用。

Phase 2 的 `switchboard-role.txt` 已刪除（靜態 config signal 不再需要）。

### 如何取消上線

- Session disconnect 時 `transport.onclose` 會自動 `releaseSession` → alias 變 NULL，`released_at` 蓋時戳；新 session 可以立即 claim 同一個 role 名字

### Troubleshooting

- **Session 沒被自動喚醒** → 確認 Claude 在第一輪有呼叫 `register(role, cc_session_id)`；DB 裡 `SELECT * FROM sessions WHERE cc_session_id = 'xxx'` 應該看到 active row
- **Role collision** → 另一個 active session 正在用同樣的 role。換名字或等對方 disconnect
- **Orphan poller** → shim 用 parent-pid alive check 自清（Claude Code 死了下 tick 就退出）；舊版 `bun poller.ts` 同樣有 parent-pid check，失靈時 fallback 24 小時 TTL
- **重設** → 直接關掉 session 並刪 `switchboard.db`（Phase 2.5 migration guard 會處理 schema 重建）

### 限制（intentional）

- Anonymous session（沒 alias）無法 auto-wake（poller `loadConfigFromHookStdin` 會返回 null）
- 一個 role 同時只能綁一個 active session；要換手必須先 disconnect
- 第一次 register 需要 switchboard daemon 已啟動

### Phase 1 fallback

`register()` 不給 `cc_session_id` 仍會走 Phase 1 行為（每次 new row），保留給不跑 hook 的 ad-hoc client 用。
