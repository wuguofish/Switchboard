# Switchboard OpenCode Plugin

讓 OpenCode（headless server）接上 Switchboard 的通訊 plugin：
總機門鈴、per-session 分機、分機名跟隨 session 標題、認領（claim）指引，全在這一個檔案裡。

這裡是**版控正本**；現役檔案在 `~/.opencode/plugins/switchboard.ts`，兩邊要保持一致。

## 部署

```bash
cp clients/opencode-plugin/switchboard.ts ~/.opencode/plugins/switchboard.ts
systemctl --user restart opencode-server
```

用**複製**、不要 symlink——repo 開發中的半成品不該直接生效；改完測過再手動部署。

改了現役檔案（hotfix）之後，記得抄回 repo 開 PR，別讓兩邊漂移：

```bash
cp ~/.opencode/plugins/switchboard.ts clients/opencode-plugin/switchboard.ts
```

## 門鈴旗 `SWITCHBOARD_DOORBELL=1`（重要）

Plugin 開頭有守門：

```typescript
if (process.env.SWITCHBOARD_DOORBELL !== "1") return {}
```

- **只有 headless 的 systemd unit（opencode-server.service）設這個環境變數**——它是唯一的總機。
- TUI 或其他 OpenCode 行程**不設旗**，plugin 直接停用。
- 為什麼：OpenCode 會同時載入 global 與 project 兩份 plugin，多個行程都搶著註冊總機的話，
  generation 會被互相踢著往上灌（實測灌到 10），訊息投遞跟著錯亂。

## 行為摘要

- **總機**：以 alias（預設 `小回(codex)`）常駐 Switchboard，輪詢收信；有新信就喚醒（或建立）常駐 session 處理。
- **分機**：每個活躍 session 掛自己的門鈴，alias 格式 `<總機名>-<標題slug>-<sessionID前8碼>`，30 分鐘活躍窗，過期自動下線。
- **名隨標題**：session 改標題（PATCH `/session/:id` 的 `title`）＝改分機名，plugin 監聽 `session.updated` 自動重新註冊。
- **認領**：喚醒 prompt 內附 claim 指引，session 可用 MCP `register(client_kind, client_session_id)` 認領自己的分機身分（Switchboard PR #5 的統一門牌機制）。
- **節流**：同未讀計數不重複喚醒；poll timeout 與讀信成功後歸零水位，避免新信被舊水位壓住。

## 已知陷阱（實戰記錄）

- **無鈴死信箱**：session 自行用 MCP `register` 註冊的獨立 alias 沒有門鈴，投遞進去沒人醒。只投總機或分機格式的 alias。
- **plugin 初始化不能 await 自家 API**：lazy init 是被 session API 觸發的，init 裡 await `client.session.list()` 會把 POST /session 整個鎖死。要預熱就用 `setTimeout` 延後。
- **存在性檢查走 SDK**：`client.baseUrl` 拿不到值，用它拼 URL 的檢查永遠失敗（症狀：每次總機喚醒都開新常駐 session）。一律用 `client.session.list()`。
- **OpenCode 不理 SIGTERM**：重啟交給 systemd（unit 已設 `KillSignal=SIGKILL`），不要手動 kill 後乾等。
