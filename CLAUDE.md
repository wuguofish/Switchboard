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

## Phase 2: Auto-wake（opt-in）

背景 poller + Stop hook auto-wake，讓 idle session 有新訊息時自動喚醒。設計 spec：`docs/superpowers/specs/2026-04-16-switchboard-phase2-auto-wake-design.md`。

### 如何啟用

1. 把 `client-hooks.example.json` 的內容 **merge** 進 workspace 的 `.claude/settings.local.json`（不要整份 overwrite，現有 permissions array 要保留）
2. 把 `SWITCHBOARD_ROLE` 改成這個 session 的唯一 role name
3. `/hooks` reload 設定
4. Session 啟動時 `bootstrap.ts` 自動 register role；每次 turn 結束 Stop hook spawn `poller.ts` 背景監控 inbox
5. Poller 偵測到新訊息就 `exit 2` 喚醒 session → 自動 spawn 新 turn

### 兩個 state file

- `D:\tsunu_plan\.claude\switchboard-role.txt` — bootstrap 寫入、Stop hook 讀取
- `D:\tsunu_plan\.claude\switchboard-poller.state` — poller cooperative watchdog 的 pid state

### Troubleshooting

- **Bootstrap 靜默失敗** → 檢查 switchboard daemon 是否在 `127.0.0.1:9876` 跑；stderr 會寫原因
- **Session 沒被自動喚醒** → 檢查 `switchboard-role.txt` 是否存在、`switchboard-poller.state` 的 pid 是否在更新
- **Orphan poller** → 10 分鐘 TTL 自清；立即清理用 Task Manager 找 `bun` process
- **兩個 session 用同一個 role** → 未定義行為，不要這樣做

### 限制（intentional）

- Anonymous session 無法 auto-wake（必須有 role）
- 一個 role 同時只能綁一個 session
- 第一次 bootstrap 需要 switchboard daemon 已啟動
