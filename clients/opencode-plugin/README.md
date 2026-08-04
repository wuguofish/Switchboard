# Switchboard OpenCode Plugins

OpenCode 端分成兩個獨立 plugin target：

- `switchboard.ts`：server target，負責 headless 總機與 30 分鐘活躍窗內的 server-side 分機。
- `switchboard-tui.ts`：TUI target，只負責目前畫面上的 session，提供 direct TUI 門鈴、toast 與桌面通知。

OpenCode v1 不允許同一個 module 同時 export `server` 與 `tui`，所以兩者必須維持獨立檔案。這裡是**版控正本**，部署時用複製，不要 symlink，避免 repo 開發中的半成品直接生效。

## Headless Server Plugin

現役檔案放在 `~/.opencode/plugins/switchboard.ts`：

```bash
cp clients/opencode-plugin/switchboard.ts ~/.opencode/plugins/switchboard.ts
systemctl --user restart opencode-server
```

只有 headless 的 `opencode-server.service` 設定 `SWITCHBOARD_DOORBELL=1`。Plugin 開頭以此旗標守門：

```typescript
if (process.env.SWITCHBOARD_DOORBELL !== "1") return {}
```

- Headless server 是唯一註冊 `小回(codex)` 的總機。
- 一般 TUI 或其他 OpenCode server 行程不設旗，不會碰總機 generation。
- 為什麼：多個行程若共用 stable instance UUID 註冊總機，會互相 bump generation，造成 lifecycle 與訊息投遞錯亂。

## TUI Plugin

TUI plugin 不走 server plugin 的 auto-discovery，必須放進 OpenCode config 目錄並列在 `tui.json`：

```bash
mkdir -p ~/.config/opencode/plugins
cp clients/opencode-plugin/switchboard-tui.ts ~/.config/opencode/plugins/switchboard-tui.ts
```

把以下欄位**合併**進 `~/.config/opencode/tui.json`，保留既有設定：

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["./plugins/switchboard-tui.ts"],
  "attention": {
    "enabled": true,
    "notifications": true
  }
}
```

安裝或修改 TUI plugin 後要完整退出再重開 TUI。它不需要 `SWITCHBOARD_DOORBELL`；如 daemon 不在預設 `http://127.0.0.1:9876`，啟動 TUI 前另設 `SWITCHBOARD_URL`。

### TUI 行為

- 每 750 ms 只在本機比對 `api.route.current`；只有 route/session metadata 改變或 standby retry 才重新註冊，收信 poll 則獨立長駐。
- 每個 TUI 行程產生一顆 process-local `owner_token`，以 ownership CAS 管理目前 session；同 owner 改標題只 renew，不 bump generation。
- 第二個視窗打開同一 session 時，`owner_conflict` 會進 standby 並顯示一次提示；每 5 秒重試，原 owner 正常離開後數秒內接手，crash 則在 5 分鐘 owner lease 過期後接手。
- `stale_generation`／`owner_mismatch` 會立即停止該 session 的喚醒，直到使用者切走再切回才重新競逐；絕不降級成 signal-only prompt。
- 收信順序為 owner-aware poll → read → TUI toast／blurred-only desktop notification → `promptAsync`。Toast 顯示分機名與封數；desktop notification 只顯示封數，兩者都不含信件內文。已讀 batch 會在同一 TUI 行程記憶體內序列化重試，直到 `promptAsync` 成功；行程被強制終止仍不具 durable ack 保證。
- 不會自動切換 route。切去別的 session 或退出 TUI 時，會帶 generation 與 owner token unregister。

## 分工

- **總機**：只有 headless server plugin 負責，常駐接收寄給 `小回(codex)` 的信。
- **Headless 分機 fallback**：server plugin 維持 30 分鐘活躍窗，讓 attach 或近期 server session 可被喚醒。
- **畫面上的 session**：TUI plugin 以 owner token 接手精確的 route lifecycle。Headless 舊 generation 收到 409 時會安靜停止，不再送重複的 signal-only prompt。
- **分機命名**：alias 格式 `小回-<標題slug>-<session ID 末 8 碼>`；短碼真的衝突時改用完整 session ID。標題變更會由目前 owner renew alias。
- **認領**：喚醒 prompt 會指示 session 用 MCP `register(client_kind, client_session_id)` 認領自己的分機，後續回覆沿用同一門牌。

## 手動驗收

目前沒有 OpenCode TUI plugin harness；部署前至少走完以下實機驗收：

1. 確認 Switchboard daemon 與 headless server 已啟動，安裝 TUI plugin 後完整重開 OpenCode。
2. 直接執行 `opencode`（不是 attach），進入一個具名 session；確認 Switchboard 出現對應 `小回-<slug>-<suffix>` 分機且在線。
3. 從另一個 session 寄信到該分機；確認目前 TUI 顯示不含內文的 toast，terminal 失焦時才送 desktop notification，並由原 session 收到完整 prompt；畫面不可被自動切 route。
4. 另開第二個 TUI 並進入同一 session；確認只提示一次「此 session 門鈴由另一視窗持有」，沒有 generation 互踢。關閉 owner 視窗後，standby 視窗應在數秒內取得門鈴。
5. 在兩個不同 session 間切換；確認舊分機 generation-safe unregister、新分機註冊，切換期間沒有把信送進錯的 session。
6. 在 owner poll 中製造 stale generation 或 owner mismatch；確認該 TUI 安靜停止喚醒，沒有 signal-only prompt 或重複 toast。
7. 用 `opencode attach` 連 headless server 再重跑收信；確認 TUI owner 與 headless fallback 不會重複喚醒。

## 已知陷阱

- **手動註冊不等於有門鈴**：session 只用 MCP `register` 建 alias，仍需要 headless 或 TUI plugin 的 poll 才能自動喚醒。
- **server plugin 初始化不能 await 自家 API**：lazy init 可能由 session API 觸發；初始化時 await `client.session.list()` 會形成 server/plugin 互鎖。預熱一律延後非同步執行。
- **存在性檢查走 SDK**：`client.baseUrl` 不是可用的 public property；session 查詢使用 `client.session.list()`。
- **409 不是 endpoint outage**：generation/owner 409 必須停止喚醒；只有連線失敗或其他非 409 錯誤才允許既有 server plugin 走 signal-only fallback。
- **總機 409 是部署異常**：總機理論上只有一個有旗行程；若它真的遇到 stale 409，會停止喚醒並等待 systemd 重啟，而不是反向搶回可能仍活著的新 generation。
- **OpenCode 不理 SIGTERM**：headless 重啟交給 systemd（unit 已設 `KillSignal=SIGKILL`），不要手動 kill 後乾等。

若現役檔案有 hotfix，修完後要同步抄回 repo 再開 PR，避免版控正本漂移。
