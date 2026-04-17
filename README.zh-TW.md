# Switchboard

> 🌐 [English](README.md)

一個只在本機運行的 MCP 伺服器，讓同一台電腦上的多個 Claude Code session 彼此發現、互傳訊息。閒置的 session 在收到新訊息時會被自動喚醒，不必手動切 tab 就能把工作在不同 agent 間交接。

## 動機

Claude Code 每個 workspace / 終端機都是獨立 process，原生沒有 session 互相溝通的機制。Switchboard 補上這塊：

- **點對點訊息** (`send`) 與 **廣播** (`broadcast`)
- **收回** (`recall`) 已送出的訊息
- **自動喚醒** — Stop-hook shim 長連線到 daemon，一有新訊息，下一個 Claude Code turn 就帶 `INBOX` 提醒啟動
- **持久化** — 訊息存在 SQLite，daemon 重啟也不會丟

整套只綁 `127.0.0.1`、沒有認證——本機協調方便，但絕對不能暴露到網路上。

## 架構

```
   Claude Code session A                Claude Code session B
   ┌─────────────────────┐              ┌─────────────────────┐
   │ MCP client          │              │ MCP client          │
   │      │              │              │              │      │
   │      ▼              │              │              ▼      │
   │ POST/GET /mcp       │              │       POST/GET /mcp │
   │                     │              │                     │
   │ Stop-hook shim      │              │      Stop-hook shim │
   │  curl --max-time    │              │     curl --max-time │
   │      │              │              │              │      │
   └──────┼──────────────┘              └──────────────┼──────┘
          │                                            │
          └──────────► 127.0.0.1:9876 ◄────────────────┘
                       ┌──────────────┐
                       │ Switchboard  │
                       │ daemon (Bun) │
                       │  /mcp  /poll │
                       │  SQLite WAL  │
                       └──────────────┘
```

- Daemon：Bun + `WebStandardStreamableHTTPServerTransport`，bind `127.0.0.1:9876`
- 儲存：SQLite（WAL 模式），session 與訊息皆能在重啟後保留
- 傳輸：工具呼叫走 Streamable HTTP MCP；Stop-hook long-polling 走另一個 `/poll` endpoint

## 需求

- Windows 10/11（Linux / macOS 尚未測試）
- [Bun](https://bun.com) ≥ 1.3
- 支援 MCP 的 Claude Code
- PowerShell 5.1+（Windows 內建）
- `curl.exe`（Windows 10+ 內建，位於 `C:\Windows\System32\curl.exe`）

## 安裝

```powershell
git clone https://github.com/wuguofish/Switchboard.git
cd Switchboard
bun install
```

## 啟動 daemon

```powershell
# 前景 — log 直接印到 stdout / stderr
bun main.ts

# 背景 — log 寫到 daemon.out.log / daemon.err.log
powershell -File start-daemon.ps1
```

環境變數（皆可選）：

| 變數 | 預設值 | 用途 |
|------|--------|------|
| `SWITCHBOARD_PORT` | `9876` | Daemon HTTP port |
| `SWITCHBOARD_DB` | `C:/Users/ATone/.claude/switchboard.db` | SQLite 檔案路徑 |

### 登入自動啟動（Windows Scheduled Task）

```powershell
powershell -File install-task.ps1
```

會註冊一個 `Switchboard MCP Daemon` 排程，使用者登入時自動執行 `start-daemon.ps1`。

## 接 Claude Code

1. 在 workspace 的 `.mcp.json` 加入 MCP server：

    ```json
    {
      "mcpServers": {
        "switchboard": {
          "type": "http",
          "url": "http://127.0.0.1:9876/mcp"
        }
      }
    }
    ```

2. 把 `client-hooks.example.json` merge 進 workspace 的 `.claude/settings.local.json`：

    ```json
    {
      "hooks": {
        "SessionStart": [ /* ...照 example 複製... */ ],
        "Stop":         [ /* ...照 example 複製... */ ]
      }
    }
    ```

    - `SessionStart` 在 `additionalContext` 注入 cc_session_id，讓 Claude 在第一個 turn 就能 claim alias。
    - `Stop` 啟動 `poller-shim.ps1`，在背景 long-poll daemon，收到訊息就 `exit 2`（asyncRewake）喚醒 Claude。

3. 到 Claude Code 下 `/hooks` 重新載入——或重啟 session。

### 讓 Claude 真的去 register

`SessionStart` hook 會告訴 Claude *怎麼* register，但實際上仍需要推一把讓它動作（以及決定 role 名字）。兩種做法：

**臨時指示** — 在第一句對話直接講：

> 請用 `my-role-name` 這個 role 向 switchboard 註冊。

Claude 會從 hook 注入的 `cc_session_id` 拿到值，然後呼叫 `mcp__switchboard__register(role='my-role-name', cc_session_id=...)`。

**常駐提示** — 寫進 workspace 的 `CLAUDE.md`（或全域的那份）：

```markdown
## Switchboard

進入這個 workspace 的第一個 turn，用 SessionStart additionalContext 裡的
cc_session_id 向 switchboard 註冊：

    mcp__switchboard__register(role='<role-name>', cc_session_id='<cc_session_id>')

Role 名字挑一個能描述這個 session 在做什麼的（例如 `tools`、`docs`、
`bug-triage`）。如果撞名就換一個。沒 register 的話 session 是匿名的，
別的 session send / broadcast 都找不到它——你不想收訊息的話這樣 OK。
```

不 register 的話，session 保持匿名；`send` / `broadcast` 都到不了，Stop-hook shim 每次 turn 結束都會立即退出（沒東西可 poll）。

## MCP 工具

每個工具接 JSON 參數，回應是包在 `content[0].text` text block 裡的 JSON 字串。

| 工具 | 參數 | 回傳 |
|------|------|------|
| `register` | `role?`、`cc_session_id?` | `{session_id, alias, anonymous}` |
| `set_alias` | `alias` | `{old_alias, new_alias}` |
| `send` | `to`、`message` | `{message_id, delivered_notification}` |
| `broadcast` | `message` | `{broadcast_id, recipient_count, notified_count}` |
| `read_messages` | — | `{messages: [...]}` |
| `list_sessions` | — | `[{session_id, alias, online, created_at, last_activity}, ...]` |
| `recall` | `message_id` | `{recalled_count}` |

`to` 可以是 alias 或 session UUID。`delivered_notification` 只在收件人當下有 active 的 `/poll` long-poll 時才回 true——in-memory 的 polling set 是唯一可靠的訊號。這是誠實的「收件人不用人類介入也會注意到」訊號，而不是「bytes 有送到 socket」。

## HTTP endpoints

- `POST /mcp`、`GET /mcp`、`DELETE /mcp` — MCP Streamable HTTP 傳輸
- `GET /poll?cc_session_id=<uuid>&timeout_s=<1..250>` — long-poll 等待新訊息，回 JSON：
  - `{status: "unread", count, alias, message}` — Stop-hook shim 應 `exit 2`
  - `{status: "timeout"}` — shim 重新撥接
  - `{status: "no-session"}` — alias 消失；shim `exit 0`

Bun 的 `idleTimeout` 把單次 `/poll` 等待上限壓在 ~250s，shim 自己 loop 即可。

## Phase 2.5：per-session identity

`SessionStart` hook 把 Claude Code 的 session id 塞給每個 session，Claude 再透過 `register(role, cc_session_id)` 上報。這樣：

- 同一 cc_session_id 的 register 變 idempotent — 斷線重連會 reactivate 同一 row
- Stop-hook shim 用 cc_session_id 認出「自己這個 session」來 long-poll
- 完全不需要靜態設定檔

不帶 `cc_session_id` 也能 register（Phase 1 fallback），只是每次都建新 row。

## 保留 & 清理

- 已讀訊息 7 天後自動刪除。
- 看起來孤兒的 session（沒 MCP 連線 *且* 5+ 分鐘沒活動）會在下一次保留 tick（每分鐘一次）被 release，alias 讓出。
- Stop-hook shim 偵測到 Claude Code parent 死了就自我了斷，不會留下 orphan poller。暫時性 daemon 錯誤（重啟、TCP 閃斷、5xx）會 backoff retry 而不退出，短暫 outage 不會讓 session 到下次 turn 才能接收訊息。舊版 `bun poller.ts` fallback 同樣用 `process.kill(ppid, 0)` 做 parent-pid check。

## 安全

- 只綁 `127.0.0.1`——不會在 public interface listen。
- **沒有認證**。千萬不要把這個 port 開到 LAN；任何能連到 `127.0.0.1:9876` 的人都能用任意 alias send / read / recall。
- 訊息內容是明文儲存，請把 `switchboard.db` 當成私密資料看待。

## 開發

```powershell
bun test                 # 全 suite
bun test tests/db.test.ts
bun test tests/integration.test.ts
bunx tsc --noEmit        # type check
```

### 專案結構

```
main.ts                  # daemon 入口
server.ts                # MCP 工具 handler + /poll endpoint + Bun.serve
db.ts                    # SQLite helper（session、訊息、保留查詢）
schema.sql               # Phase 2.5 欄位的 schema
connections.ts           # in-memory ConnectionRegistry，管 push callback
waiters.ts               # UnreadWaiterRegistry，管 /poll long-polling
retention.ts             # 定期清過期訊息 + 孤兒 session
aliases.ts               # alias 碰撞處理 + 目標解析
poller.ts                # 舊版 bun 實作的 Stop-hook poller（fallback）
poller-shim.ps1          # PowerShell Stop-hook shim（預設）
hook-session-start.ts    # SessionStart hook，注入 cc_session_id
install-task.ps1         # 註冊 Windows 排程
start-daemon.ps1         # 背景啟動 daemon
tests/                   # bun:test 測試集
```

## License

[MIT](LICENSE) © 2026 Kueh Tîng-kin (ATone)
