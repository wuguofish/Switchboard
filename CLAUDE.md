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
