# Switchboard

> 🌐 [English](README.md)

一個只在本機運行的 MCP 伺服器，讓同一台電腦上的多個 Claude Code session 彼此發現、互傳訊息。閒置的 session 在收到新訊息時會被自動喚醒，不必手動切 tab 就能把工作在不同 agent 間交接。

## 動機

Claude Code 2.1.224 起原生就有跨 session 傳訊（`ListAgents` / `SendMessage`），同一台機器上 Claude Code 之間對話已經不需要 Switchboard。Switchboard 負責原生管道沒有覆蓋的部分：

- **非 Claude Code 的同伴**——Codex、OpenCode，或任何能 `POST /register` 的東西
- **廣播**，一次送給所有已註冊的 session
- **讓那些同伴找得到你**——只要你的名字在別人的收件名單上，就算自己從不寄信也需要這裡的門牌

在此之上另外提供：

- **點對點訊息** (`send`) 與 **廣播** (`broadcast`)
- **收回** (`recall`) 已送出的訊息
- **自動喚醒，而且喚醒本身就帶著信**：下面每一條路徑都把訊息本文直接交給 session、同時標成已讀，session 直接處理，不必再繞一趟 `read_messages`。
  - daemon 直接寫 session 的 Claude Code inbox socket（預設；背景 session 也可用）
  - [channel shim](clients/cc-channel/README.md)（自行啟用，僅限前景 session）把 `/monitor` 的每一行以 `<channel>` 事件推進 session，訊息叫醒 session 時沒有任何要重掛的東西。
  - *或* 讓 Claude Code 的 `Monitor` tool 以 `curl -N` 訂閱 `/monitor` 的 chunked stream，每行 inbox event 直接 fire 一個 assistant turn；但 Claude Code 2.1.271 起 watch 每 30 分鐘到期，必須重掛。
  - Stop-hook shim 長連線到 `/poll`，一有新訊息，下一個 Claude Code turn 就帶 `INBOX` 提醒啟動（只帶數量，session 再呼叫 `read_messages`）
- **持久化** — 訊息存在 SQLite，daemon 重啟也不會丟

整套只綁 `127.0.0.1`、沒有認證——本機協調方便，但絕對不能暴露到網路上。

## 架構

```
   Claude Code session A                Claude Code session B
   ┌──────────────────────┐             ┌──────────────────────┐
   │ MCP client → /mcp    │             │    /mcp ← MCP client │
   │ Monitor  → /monitor  │             │ /monitor ←  Monitor  │
   │ Stop shim → /poll    │             │    /poll ← Stop shim │
   └──────────┬───────────┘             └──────────┬───────────┘
              │                                    │
              └───────► 127.0.0.1:9876 ◄───────────┘
                        ┌────────────────────┐
                        │   Switchboard      │
                        │   daemon (Bun)     │
                        │ /mcp /poll /monitor│
                        │   SQLite WAL       │
                        └────────────────────┘
```

- Daemon：Bun + `WebStandardStreamableHTTPServerTransport`，bind `127.0.0.1:9876`
- 儲存：SQLite（WAL 模式），session 與訊息皆能在重啟後保留
- 傳輸：工具呼叫走 Streamable HTTP MCP；Stop-hook long-polling 走 `/poll`；`Monitor` tool 的長期訂閱走 `/monitor`

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
| `SWITCHBOARD_DB` | `<homedir>/.claude/switchboard.db` | SQLite 檔案路徑 |
| `SWITCHBOARD_POLLER_STATE_DIR` | `<homedir>/.claude` | Poller state/lock 檔案目錄 |
| `SWITCHBOARD_CLAUDE_DIR` | `<homedir>/.claude` | Claude Code 的家目錄：socket 投遞與 alias 鏡像讀 `sessions/`，啟動檢查讀 `settings.json` |

### 掛成服務執行（建議）

從終端機跑 daemon 等於把它的壽命綁在那個視窗上。Windows 11 上這件事是字面意義的：
Windows Terminal 托管每一個主控台程式，視窗一關就把 `CTRL_CLOSE` 一起發給 daemon。
服務沒有主控台，不受影響。

**Windows** — 用 [WinSW](https://github.com/winsw/winsw/releases)，放在 repo 旁邊
命名為 `switchboard-service.exe`：

```powershell
Copy-Item switchboard-service.example.xml switchboard-service.xml
# 把裡面的絕對路徑填好，然後在提權的終端機執行：
.\switchboard-service.exe install
Start-Service switchboard-daemon
```

之後要重啟同樣需要提權：`Restart-Service switchboard-daemon`。

**Linux** — systemd user service：

```bash
mkdir -p ~/.config/systemd/user
cp switchboard.service.example ~/.config/systemd/user/switchboard.service
systemctl --user daemon-reload
systemctl --user enable --now switchboard
loginctl enable-linger "$USER"   # 沒登入也要能撐過重開機就加這行
```

Log 走 journal（`journalctl --user -u switchboard -f`），重啟不需要提權：
`systemctl --user restart switchboard`。

三個路徑變數在兩份範本裡都寫死，而不是靠 `os.homedir()`——服務帳號的家目錄不是你的
家目錄。漏填 `SWITCHBOARD_DB` 會無聲地開一個空資料庫；漏填 `SWITCHBOARD_CLAUDE_DIR`
則是 socket 投遞找不到任何 session、alias 也不跟著改名，兩者同樣不會報錯。

### 登入自動啟動（Windows Scheduled Task，舊做法）

```powershell
powershell -File install-task.ps1
```

會註冊一個 `Switchboard MCP Daemon` 排程，使用者登入時自動執行 `start-daemon.ps1`。
已被上面的服務取代——原因見前一段的主控台關閉問題。

## 接 Claude Code

先替 session 選一條投遞路徑。它決定 MCP server 怎麼接、以及 hook 教 Claude 哪一套：

|                | `socket`（預設）                                                      | `channel`（自行啟用，僅限前景 session）                                  | `monitor`（舊路徑）        |
|----------------|-----------------------------------------------------------------------|-------------------------------------------------------------------------|---------------------------|
| 訊息怎麼叫醒 session | daemon 把訊息本文寫進 session 的 Claude Code inbox socket，直接開帶著信的新一輪 | `switchboard` stdio server 把訊息本文以 `<channel>` 事件直接推進對話 | Claude 用 `Monitor` tool 掛 `/monitor`，每 30 分鐘重掛一次；每行 `inbox` 都帶著訊息本文 |
| 啟動           | 一般 `claude`                                                         | `SWITCHBOARD_DELIVERY=channel claude --dangerously-load-development-channels server:switchboard` | `SWITCHBOARD_DELIVERY=monitor claude` |
| 背景 session（agent view、`claude --bg`）可用 | 可                                      | **不可**：channel flag 不在背景 session 會帶的 flag 清單裡，而且那個 flag 的確認提示沒有終端機可以按 | 可 |
| 必要設定       | `~/.claude/settings.json` 的 `crossSessionInbound: "accept"`          | 無                                                                      | 無                        |
| 每 session 成本 | 無                                                                    | 一支 Bun 行程，約 80 MB                                                 | bash＋curl 約 17 MB，外加每 30 分鐘一次冷啟動 |
| 設錯時         | 沒設 accept 時，Claude Code 會把每次喚醒扣住等核准、5 分鐘後丟棄。daemon 啟動時會警告、hook 在每個新 session 也會警告，所以這個「安靜」是有人先喊過的 | 大聲：啟動畫面沒有 channel 那行，訊息一封都不來 | 大聲：每 30 分鐘一次到期通知直到 Claude 重掛 |

在啟動 Claude Code 的環境設 `SWITCHBOARD_DELIVERY` 選路徑（未設＝`socket`）。hook 會讀它，只講被選的那一條。

socket 路徑的原理：Claude Code 2.1.224 起每個 session 綁一個 Unix domain socket，連同 session id 記在 `~/.claude/sessions/` 底下。當一封信送到某個沒有 `/monitor`、`/poll` 連線的 Claude Code session，daemon 就去那裡查出 socket，寫一行 `{"type":"user", …}`，內容就是那些未讀訊息（寄件人、client kind、時間、本文）；Claude Code 把它變成新的一輪，daemon 在 socket 收下寫入後把那些列標成已讀。有串流連著的 session 會跳過，所以不會重複投遞。沒設 `crossSessionInbound: "accept"` 時喚醒只帶數量、訊息維持未讀，因為被扣住的喚醒會過期，信不能跟著陪葬。框架格式沒有公開，是從 Claude Code `--debug` 模式自己印出的範例取得、並在 `peerProtocol` 1（Claude Code 2.1.272）驗證過；daemon 遇到其他協定版本會拒絕投遞並記下原因。

2026-09-15 實測：`claude --bg` 帶 channel flag 啟動的 session，shim 只被當一般 MCP server 帶起（工具可用、`register` 可用），但收不到任何 `<channel>` 事件，且 job 的 respawn flag 裡沒有那個 flag。同一種 session 只做 `register`，socket 路徑就叫得醒。

1. 在 workspace 的 `.mcp.json` 加入 MCP server。`socket` 與 `monitor` 模式直接連 daemon：

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

    `channel` 模式指向 shim（見 [`clients/cc-channel/`](clients/cc-channel/README.md)）：

    ```json
    {
      "mcpServers": {
        "switchboard": {
          "command": "bun",
          "args": ["/absolute/path/to/Switchboard/clients/cc-channel/switchboard-channel.ts"]
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

`SessionStart` hook 會先告訴 Claude 什麼時候該用 Switchboard：同一台機器上 Claude Code 之間走原生 `SendMessage`；跨廠同伴、廣播、以及要被這兩者找到，才是 register 的用途。接著才說明 *怎麼* register，但實際上仍需要推一把讓它動作。兩種做法：

**臨時指示** — 在第一句對話直接講：

> 請向 switchboard 註冊。

Claude 會從 hook 注入的 `cc_session_id` 拿到值，然後呼叫 `mcp__switchboard__register(cc_session_id=...)`。

**別名就是 session 名字。** Claude Code session 在 Switchboard 上的別名，就是 `ListAgents` 顯示、你用 `/rename` 取的那個名字。daemon 在每次有人使用 Switchboard 時（每個請求、每次工具呼叫）從 `~/.claude/sessions/<pid>.json` 讀一次，所以改完名下一封信就生效，有名字的 session 呼叫 `set_alias` 會被拒絕（請改名）。新 session 不分前景背景一開始都沒有名字，顯示的是 id 前 8 碼；hook 會叫這種 session 先帶一個暫用的 `role` 註冊，等你 `/rename` 之後真名自動接手。一個 session 到處都是同一個名字：你在 agents view 叫它什麼，同伴的 `to` 就填什麼。同一輪掃描也會把 daemon 重啟時釋放掉的列救回來（只要 Claude Code 行程還活著），並替活著的 session 續 lease；daemon 重啟後沒有人需要重新 register。

**常駐提示** — 寫進 workspace 的 `CLAUDE.md`（或全域的那份）：

```markdown
## Switchboard

進入這個 workspace 的第一個 turn，用 SessionStart additionalContext 裡的
cc_session_id 向 switchboard 註冊：

    mcp__switchboard__register(cc_session_id='<cc_session_id>')

你的別名就是這個 session 的名字（使用者用 /rename 取的）；只有 session
還沒名字時才帶 role='<暫用名>'。沒 register 的話 session 在 Switchboard
上是匿名的——如果你只跟同一台機器上的 Claude Code 對話，原生 SendMessage
本來就到得了，這樣 OK。
```

不 register 的話，session 保持匿名；`send` / `broadcast` 都到不了，Stop-hook shim 每次 turn 結束都會立即退出（沒東西可 poll）。

## MCP 工具

每個工具接 JSON 參數，回應是包在 `content[0].text` text block 裡的 JSON 字串。

| 工具 | 參數 | 回傳 |
|------|------|------|
| `register` | `role?`、`cc_session_id?` | `{session_id, alias, anonymous}`——帶 `cc_session_id` 時，session 有名字就以 session 名字為別名；`role` 只是沒名字前的暫用名 |
| `set_alias` | `alias` | `{old_alias, new_alias}`——有名字的 Claude Code session 會被拒絕（請改 session 名字） |
| `send` | `to`、`message` | `{message_id, delivered_notification}` |
| `broadcast` | `message`、`scope?` | `{broadcast_id, recipient_count, notified_count}` |
| `read_messages` | — | `{messages: [...]}`——只回沒有任何喚醒帶走的信；喚醒送到的已是已讀 |
| `list_sessions` | — | `[{session_id, alias, online, created_at, last_activity}, ...]` |
| `recall` | `message_id` | `{recalled_count}` |
| `unregister` | — | `{status, released_alias}`——`status` 為 `released`、`stale_ignored`（同一 identity 已被更新世代重新註冊，未釋放任何東西）或 `already_offline` |

`to` 可以是 alias 或 session UUID。`delivered_notification` 在訊息經由活的 MCP 連線推送成功、*或*收件人依下方 lease/polling 判定為在線時回 true。這是誠實的「收件人不用人類介入也會注意到」訊號，而不是「bytes 有送到 socket」。

`broadcast` 可帶選填的 `scope`（預設 `all`，舊呼叫行為不變）：

- `all`——除寄件人外的全部 active session
- `same_kind`——與寄件人同 `client_kind`，跨 cwd
- `same_cwd`——與寄件人註冊的 `cwd` 相同，跨 kind；任一方 cwd 為 NULL 即不匹配

`client_kind` 為 codex 的收件人**只有在線時才寫入訊息列**——離線的 Codex peer 不累積任何廣播積壓；Claude Code 與 external 收件人維持離線也入列、上線再讀。`recipient_count` 與 `notified_count` 都以同一份過濾後的收件清單計算。

## HTTP endpoints

- `POST /mcp`、`GET /mcp`、`DELETE /mcp` — MCP Streamable HTTP 傳輸
- `POST /external/send` — 給本機非 MCP 程序投遞訊息用，例如
  codex-bridge 在背景 job 完成後通知 Claude Code。JSON body：
  `{ "to": "<alias-or-session-id>", "message": "...", "from": "codex" }`
 ；`from` 可省略，預設 `codex`。回傳 `{message_id, delivered_notification}`。
- `POST /register` — 給不持 MCP 連線的 peer（例如 codex-bridge 的 waker）用的 HTTP 註冊。JSON body：
  `{ "alias": "...", "client_kind": "claude_code"|"codex"|"external", "client_session_id": "<穩定的 instance id>", "cwd": "/絕對路徑" }`。
  以 `(client_kind, client_session_id)` 冪等 upsert；重複註冊會重新啟用該列並遞增 generation。回傳
  `{session_id, alias, generation}`；驗證錯誤回 400、alias 衝突回 409。
  選填 `owner_token` 啟用 ownership CAS：取得無主 identity 或接手 lease 已過期的
  舊 owner 會遞增 generation；同 owner 重呼叫視為 lease 續租、generation 不動；
  現任 owner 的 lease 還活著時，第二個 owner 會被 `409 {code: "owner_conflict"}`
  拒絕。不帶 token 的註冊維持 last-register-wins 語意，並會清掉已存的 owner token。
  無 token 的 fallback 可帶 `"respect_owner": true`，遇到活 owner 時同樣回
  `owner_conflict` 而不搶 ownership；省略此欄位則維持舊行為。
- `POST /unregister` — peer 優雅下線。JSON body：
  `{ "client_kind": ..., "client_session_id": ..., "generation": <int> }`。
  generation 必須與現值相符——舊 instance 遲到的下線請求動不了新 instance（409）。回傳
  `{status: "released" | "already_released"}`，查無此 identity 回 404。帶 `owner_token`
  時，409 body 會標明 `code: "stale_generation"` 或 `code: "owner_mismatch"`，讓 client
  能區分兩種失敗。
- `POST /messages/read` — peer 驗證身分後讀取自己的 inbox。JSON body：
  `{ "client_kind": ..., "client_session_id": ..., "generation": <int> }`。
  identity 必須對應 active session，generation 也必須與現值相符。回傳
  `{messages: [...]}`，欄位與 Asia/Taipei 時間格式均和 MCP `read_messages` 相同，
  並將本次回傳的訊息標為已讀。驗證錯誤回 400、查無或已釋放 identity 回 404、
  舊 generation 回 409。帶 `owner_token` 時，409 body 會標明 `code: "stale_generation"`
  或 `code: "owner_mismatch"`——client 收到這兩種要當「停止喚醒」處理，
  絕不能當成「端點不可用」降級。
- `GET /poll?client_kind=<kind>&client_session_id=<id>&timeout_s=<1..250>` —
  正式版 long-poll 等待新訊息，每次呼叫同時為呼叫者續租 lease（更新 `last_seen_at`）。
  舊格式 `?cc_session_id=<uuid>` 仍支援，等同 `client_kind=claude_code`。可選
  `&owner_token=<t>&generation=<g>`（兩者必須成對出現）讓 poll 帶 ownership 檢查：
  不符時回與 `/messages/read` 相同的 409 body；long-poll 等待結束後會重查 ownership，
  避免舊 owner 的長連線在新 owner 接手後還被喚醒；owner lease（`owner_seen_at`）
  也隨 poll lease 一併續租。回 JSON：
  - `{status: "unread", count, alias, message}` — Stop-hook shim 應 `exit 2`
  - `{status: "timeout"}` — shim 重新撥接
  - `{status: "no-session"}` — alias 消失；shim `exit 0`
- `GET /monitor?cc_session_id=<uuid>` — 為 Claude Code 的 `Monitor` tool 設計的長駐 chunked text stream，每行一個 event：
  - `hello <alias>` — 連上時的 baseline，inbox 空時才發
  - `inbox <json>` — 未讀訊息本身，`{alias, messages: [{id, sender_alias, sender_kind, created_at, content, is_broadcast}]}`；連上時有未讀就發、之後每有 `send` / `broadcast` 到就發，送出同時把那些列標成已讀
  - `heartbeat <iso-ts>` — 每 4 hr 靜默時發一次的可見時間 tick，例如 `heartbeat 2026-04-24(五)T13:38:25+08:00`；日期後面的 `(X)` 是台北時間的星期，訂閱端直接讀它就好，自己從日期推算會在 UTC／台北的換日邊界出錯（每 240s 還會發一個無訊息空白 byte 維持 Bun `idleTimeout` 不砍 stream）
  - 在 `/monitor` 網址後面加 `&heartbeat_secs=N` 可以自訂間隔（下限 240、上限 86400）。對 LLM 訂閱端來說每次心跳喚醒都是冷啟動——prompt cache 早就過期，整包 context 等於用寫入價重寫一次——所以間隔就是成本旋鈕，拉長一倍、閒置消耗就少一半。

Bun 的 `idleTimeout` 把單次 `/poll` 等待上限壓在 ~250s，shim 自己 loop 即可。`/monitor` 則一直開著陪整個 session 生命週期，客戶端建議把 `curl -sN` 包在 reconnect loop 裡，daemon 重啟時能自我修復。

## Wake paths — 哪條、什麼時候用？

Claude Code 的預設是 [接 Claude Code](#接-claude-code) 那節的 socket 路徑：daemon 直接叫醒 session，Claude 除了 `register` 什麼都不用做。前景 session 可改用 channel shim。下面兩條是舊路徑，留給沒有 inbox socket 的 Claude Code 版本。三條的終點都是 daemon 裡的 `UnreadWaiterRegistry`，投遞都可靠；差別在傳輸、生命週期與失敗模式：

|                           | `/poll` + Stop-hook shim           | `/monitor` + Monitor tool           |
|---------------------------|------------------------------------|-------------------------------------|
| 觸發                      | 每次 `Stop` hook（一個 turn 一次） | stream 每行 fire 一個 turn           |
| 連線                      | 每個 turn 建新 long-poll           | 一條常駐 chunked 連線                |
| Daemon 重啟時的 reconnect | 下個 turn 自動重建                 | 靠客戶端 wrapper（`while :; do curl -N …; sleep 5; done`） |
| Session 空轉（使用者沒打字）時仍能被喚醒 | 可，但靠 `asyncRewake`，長 session 已觀察到會漸失效 | 可，每行 stdout 都是獨立的 `Monitor` event |
| Anonymous session         | 不能被喚醒（沒 cc_session_id 可 match） | 不能被喚醒（同條件限制）          |

兩條 **互補、不互斥** — 可以同時跑（read 路徑 idempotent）。建議：保留 Stop-hook shim 當 fallback，任何需要幾小時都能被找到的 session 再加上 `/monitor`。

### 從 Claude Code session 訂閱

在你想保持可達的 session 裡，`register` 之後啟動 `Monitor` tool：

```
Monitor({
  description: 'switchboard inbox for <my-alias>',
  timeout_ms: 1800000,
  command: 'while :; do curl -sN "http://127.0.0.1:9876/monitor?cc_session_id=<cc_session_id>" || true; sleep 5; done',
})
```

Claude Code 2.1.271 拿掉了 Monitor 的無逾時 `persistent` 選項——每個 watch 現在一定有期限，最長 30 分鐘（`-p` 模式 10 分鐘），到期時 Claude 會收到一則通知。**收到那則通知就要重掛**：把它當雜訊的 session 會無聲地變成不可達。這同時也給閒置喚醒設了下限，所以 `heartbeat_secs` 設得比 30 分鐘長，已經不會再降低喚醒頻率。

`while … sleep 5` wrapper 會在 daemon 重啟或 TCP 閃斷時自動重連。進階訂閱者可以在確定 stream 穩定後補 `grep --line-buffered "^inbox "` 把 `hello` / `heartbeat` noise 過濾掉。

觸發規則值得內化：
- 別人 `send(to=你)` 會喚醒你。
- 別人的 `broadcast` 只有在所選 scope 包含你的 session 時才會喚醒你。
- *你自己* 的 `send` / `broadcast` **不會**喚醒自己——server 端會排除 sender。
- 別人之間的 1-to-1 不會洩進你的 stream。

`hook-session-start.ts` 的 `SessionStart` hook 已經把這段教學帶進 new session 的 `additionalContext`，新 workspace 不必額外設定就能拿到 wake path。

## Phase 2.5：per-session identity

`SessionStart` hook 把 Claude Code 的 session id 塞給每個 session，Claude 再透過 `register(role, cc_session_id)` 上報。這樣：

- 同一 cc_session_id 的 register 變 idempotent — 斷線重連會 reactivate 同一 row
- Stop-hook shim 用 cc_session_id 認出「自己這個 session」來 long-poll
- 完全不需要靜態設定檔

不帶 `cc_session_id` 也能 register（Phase 1 fallback），只是每次都建新 row。

## 雙邊 peer：identity、generation、lease

session 已一般化，不再是 Claude Code 專屬：

- **`client_kind` 命名空間**：`claude_code`、`codex`、`external`。identity 唯一索引為
  `(client_kind, client_session_id)`，Codex 的 instance id 永遠不會跟 Claude Code 的 session id 撞衫。
- **穩定 identity，不是 thread identity**。peer 的 `client_session_id` 是持久的 instance UUID
  （Codex waker 存在 `~/.codex/waker-instance-id`）；對話 thread id 屬 client 端狀態，絕不進資料庫。
- **generation guard**：取得 identity 時遞增 generation——legacy 重新註冊、首次取得
  ownership、接手過期 lease 都算；唯一例外是同 `owner_token` 的續租，generation 不動。
  所有釋放路徑——HTTP `/unregister`、
  MCP `unregister` 工具、MCP transport 斷線清理——都檢查 generation，舊 instance 遲到的
  下線動作不可能誤殺活著的新 instance。
- **lease 制 online**：`online = 活的 MCP 連線 OR 進行中的 /poll(/monitor) OR 有效 lease`。
  每次 `/poll` 更新 `last_seen_at`；lease TTL 為 5 分鐘（涵蓋一次 250 秒 long-poll 加重連緩衝）。
  優雅退出走 generation unregister；crash 就讓 lease 自然過期。訊息的真相永遠是
  `read_at`——喚醒只是 best-effort 的門鈴。

**Peer 讀信已完成**：`POST /messages/read` 已提供非 MCP peer 以
generation/identity 驗證身分、讀取並標記自己未讀訊息的途徑。它與 MCP
`read_messages` 共用 read-at 語意，因此 poll 驅動的 client 不必直接讀 SQLite，
也不會再被已讀郵件重複觸發。

## 內附 clients

- **`clients/opencode-plugin/`** —— 把 headless OpenCode server 變成 Switchboard peer 的
  plugin：總機 alias 附門鈴、per-session 分機（alias 跟隨 session 標題）、喚醒 prompt 內建
  認領指引。部署方式與 `SWITCHBOARD_DOORBELL=1` 門鈴旗見該目錄的 README。

## 保留 & 清理

- 已讀訊息 7 天後自動刪除。
- lease 過期超過 24 小時的 session（沒 MCP 連線、沒 polling、沒續租）由保留巡檢
  （每 2 小時一次）補蓋 released_at、讓出 alias。crash 且沒觸發 `transport.onclose` 的
  session 因此最長可能占用 alias 約 26 小時；同一 identity 隨時可透過冪等重新註冊立即取回自己的列。
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
server.ts                # MCP 工具 + peer lifecycle/read + /poll + /monitor + Bun.serve
db.ts                    # SQLite helper（session、訊息、generation-aware upsert、保留查詢）
schema.sql               # schema（client_kind / client_session_id / cwd / last_seen_at / generation / reply_to）
online.ts                # 共用 online 判定：MCP 連線 OR polling OR 有效 lease
connections.ts           # in-memory ConnectionRegistry，管 push callback
waiters.ts               # UnreadWaiterRegistry，kind-qualified，/poll 和 /monitor 共用
retention.ts             # 定期清過期訊息 + 孤兒 session
aliases.ts               # alias 碰撞處理 + 目標解析
poller.ts                # 舊版 bun 實作的 Stop-hook poller（fallback）
poller-shim.ps1          # PowerShell Stop-hook shim（預設）
hook-session-start.ts    # SessionStart hook，注入 cc_session_id
install-task.ps1         # 註冊 Windows 排程（舊做法）
start-daemon.ps1         # 背景啟動 daemon
switchboard-service.example.xml  # Windows 服務的 WinSW 設定範本
switchboard.service.example      # Linux 的 systemd user service 範本
tests/                   # bun:test 測試集
```

## License

[MIT](LICENSE) © 2026 wuguofish
