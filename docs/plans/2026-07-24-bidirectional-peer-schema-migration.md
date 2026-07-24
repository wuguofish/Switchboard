# Switchboard 雙邊 Peer Schema Migration 實作計畫

> **給執行者：** 使用執行計畫（`execute`）skill 逐步完成此計畫。步驟使用 checkbox（`- [ ]`）格式追蹤進度。

**目標：** 在不破壞既有 Claude Code 行為或資料的前提下，把 sessions 與 messages schema 一次 migration 成支援多種 peer client 的形式。

**方法：** 以 schema introspection 判斷既有資料庫欄位，在單一 SQLite transaction 內 rename／add columns 並替換 active client identity unique index。DB helper 以 `client_kind`、`client_session_id` 為核心，保留 `cc_session_id` wrapper 供既有 MCP、poll 與 monitor 呼叫。

**工具 / 技術：** Bun、TypeScript、`bun:sqlite`、SQLite transactional DDL、`bun:test`

---

### 任務 1：以 migration 測試鎖定資料與 schema 相容性

**檔案：**
- 修改：`tests/db.test.ts`

- [x] **步驟 1：建立現行 Phase 2.5 schema 的檔案型 DB fixture**

在 temporary directory 建立含 `cc_session_id`、active／released sessions、既有 message 與舊 unique index 的 DB，記錄 migration 前資料。

- [x] **步驟 2：寫 schema 與資料保留 assertions**

呼叫 `openDatabase()` 後驗證 `cc_session_id` 已 rename、`client_kind`／`cwd`／`last_seen_at`／`reply_to` 存在、既有 session/message 欄位值未變，且既有 session 的 `client_kind` 為 `claude_code`。

- [x] **步驟 3：寫新 identity index assertions**

驗證相同 kind 的 active duplicate identity 被拒絕、不同 kind 可使用相同 `client_session_id`、released identity 不阻擋重用。

- [x] **步驟 4：跑 migration 專屬測試確認失敗**

執行：`bun test tests/db.test.ts --test-name-pattern migration`

預期：FAIL，原因是目標欄位或 index 尚未存在，且既有資料尚未以新 schema 呈現。

### 任務 2：實作 transactional schema migration

**檔案：**
- 修改：`db.ts`
- 修改：`schema.sql`

- [x] **步驟 1：更新 fresh database schema**

將 sessions identity 改為 `client_kind TEXT NOT NULL DEFAULT 'claude_code'` 與 `client_session_id`，新增 `cwd`、`last_seen_at`；messages 新增 nullable `reply_to`；identity unique index 改為 `(client_kind, client_session_id)` 的 active partial index。

- [x] **步驟 2：在 openDatabase schema bootstrap 前執行 transaction migration**

若 sessions 已存在，於同一 transaction 內 rename `cc_session_id`、補齊新欄位、移除舊 index 並建立新 index；若 messages 已存在則補 `reply_to`。既有 rows 透過 NOT NULL default 回填 `claude_code`，不 drop tables。

- [x] **步驟 3：跑 migration 專屬測試確認通過**

執行：`bun test tests/db.test.ts --test-name-pattern migration`

預期：PASS，0 failures。

### 任務 3：一般化 TypeScript types 與 DB helpers

**檔案：**
- 修改：`types.ts`
- 修改：`db.ts`
- 修改：`server.ts`
- 修改：`tests/db.test.ts`

- [x] **步驟 1：新增 canonical peer identity types 與 helper 測試**

測試 `createClientSession` 可建立不同 kind、cwd 的 session；`findSessionByClientSessionId` 以 kind 分 namespace；message insert/fetch 保留 nullable `reply_to`。

- [x] **步驟 2：跑新增 helper 測試確認失敗**

執行：`bun test tests/db.test.ts --test-name-pattern "client session|reply_to"`

預期：FAIL，原因是 canonical helper 或欄位尚未實作。

- [x] **步驟 3：實作 canonical helpers 與 Claude Code wrappers**

`SessionRow` 改用新欄位；新增 client-kind-aware create/find helpers。既有 `createSession({ cc_session_id })`、`findSessionByCcSessionId` 與 `findAnySessionByCcSessionId` 保留為固定 `claude_code` wrapper，MCP register 參數與 `/poll?cc_session_id=` 不改。

- [x] **步驟 4：更新 server 內部 row 欄位存取**

通知判定改讀 canonical `client_session_id`；不新增 POST `/register`、lease、broadcast scope 或 waker 行為。

- [x] **步驟 5：跑 DB 與 TypeScript 驗證**

執行：`bun test tests/db.test.ts`

預期：PASS，0 failures。

執行：`bunx tsc --noEmit`

預期：exit 0。

### 任務 4：完整驗證與聚焦 commit

**檔案：**
- 檢查：本計畫所列全部修改檔

- [x] **步驟 1：逐項對照 design spec 與 scope**

確認 schema、index、資料保留、wrapper、reply_to 均涵蓋，且 diff 不含 POST `/register`、lease、broadcast scope 或 waker。

- [x] **步驟 2：跑專屬與完整測試**

執行：`bun test tests/db.test.ts --test-name-pattern migration`

預期：PASS，0 failures。

執行：`bun test`

預期：全部測試 PASS，0 failures。

- [x] **步驟 3：檢查 diff 與 working tree**

執行：`git diff --check`、`git diff --stat`、`git status --short`

預期：無 whitespace error，只有本階段相關檔案。

- [x] **步驟 4：建立一顆聚焦 commit**

執行：`git add ...` 後 `git commit -m "feat(db): generalize sessions for peer clients"`

預期：commit 成功；commit 後 `git status --short` 無輸出。不 push。
