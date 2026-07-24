# Switchboard HTTP Peer Register 實作計畫

> **給執行者：** 使用執行計畫（`execute`）skill 逐步完成此計畫。步驟使用 checkbox（`- [ ]`）格式追蹤進度。

**目標：** 為不持有 MCP 連線的 peer 提供具 runtime validation、冪等 re-register 與 generation 防誤殺語意的 HTTP register／unregister API。

**方法：** 沿用既有 `migrateSchema()` 模式新增 generation 欄位，並把 identity upsert 與 generation-guarded release 收斂為 DB helper。HTTP handler 僅負責解析、驗證、映射明確的 4xx 回應；既有 MCP register 改用相同 upsert helper，但維持原 response 與 transport lifecycle。

**工具 / 技術：** Bun、TypeScript、`bun:sqlite`、Bun HTTP server、`bun:test`

---

### 任務 1：以測試鎖定 generation schema 與 DB 行為

**檔案：**
- 修改：`tests/db.test.ts`

- [x] **步驟 1：擴充 migration 測試**

在既有 Phase 2.5 DB fixture migration 後，驗證 `generation` 欄位存在且歷史 rows 均為 `1`。

- [x] **步驟 2：新增 identity upsert 測試**

驗證相同 `(client_kind, client_session_id)` 首次 register 為 generation 1；再次 register 沿用 session id、更新 alias／cwd、generation 變 2；released row 再 register 仍沿用 id 並遞增。

- [x] **步驟 3：新增 generation-guarded release 測試**

驗證舊 generation 無法 release re-register 後的 active row，目前 generation 可以 release，重送目前 generation 呈現 already released。

- [x] **步驟 4：跑 DB 聚焦測試確認失敗**

執行：`bun test tests/db.test.ts --test-name-pattern "migration|generation|upsert"`

預期：FAIL，原因是 schema／types／helpers 尚未支援 generation。

### 任務 2：以 integration tests 鎖定 HTTP contract

**檔案：**
- 修改：`tests/integration.test.ts`

- [x] **步驟 1：新增 register 冪等與 reactivation 測試**

呼叫 `POST /register`，驗證回傳 `{session_id, alias, generation}`；同 identity 重註冊與 unregister 後重註冊均沿用 session id、遞增 generation 並更新 alias。

- [x] **步驟 2：新增 stale unregister 防誤殺測試**

以舊 generation 呼叫 `POST /unregister`，預期 409 與明確 error；接著用目前 generation 應仍能成功釋放，證明舊請求未誤殺。

- [x] **步驟 3：新增 runtime validation 與 alias conflict 測試**

覆蓋 invalid JSON、非 object body、缺少／空白欄位、未知 `client_kind`、非正整數 generation，均回 400 與具欄位名稱的 error；不同 identity 佔用 active alias 時回 409 與 `alias already taken`。

- [x] **步驟 4：跑 HTTP 聚焦測試確認失敗**

執行：`bun test tests/integration.test.ts --test-name-pattern "HTTP register|HTTP unregister"`

預期：FAIL，原因是 `/register`、`/unregister` 尚未存在。

### 任務 3：實作 generation migration 與 canonical DB helpers

**檔案：**
- 修改：`schema.sql`
- 修改：`types.ts`
- 修改：`db.ts`

- [x] **步驟 1：新增 generation schema 與 migration**

fresh schema 加入 `generation INTEGER NOT NULL DEFAULT 1`；既有 sessions 缺欄位時以相同定義 `ALTER TABLE ... ADD COLUMN`，讓歷史資料回填 1。

- [x] **步驟 2：讓 SessionRow 與所有 session SELECT 包含 generation**

更新 shared type 與 DB row projections，避免 runtime row 與 TypeScript 定義分歧。

- [x] **步驟 3：實作 transaction identity upsert**

新增 helper：新 row generation 1；既有 active／released row沿用 id、更新 alias／可提供的 cwd、清除 released_at、更新 activity 並 `generation + 1`。alias collision 在 transaction 內明確拒絕。

- [x] **步驟 4：實作 generation-guarded release**

以 identity、generation 與 active 條件做 conditional UPDATE，並區分 released、not found、generation mismatch 結果。

- [x] **步驟 5：跑 DB 聚焦測試**

執行：`bun test tests/db.test.ts --test-name-pattern "migration|generation|upsert"`

預期：PASS，0 failures。

### 任務 4：實作 HTTP endpoints 並共用 MCP upsert 語意

**檔案：**
- 修改：`server.ts`

- [x] **步驟 1：建立 JSON body 與欄位 validation helpers**

拒絕 invalid JSON／非 object；alias、client session id、cwd 必須為非空字串；client kind 僅接受 `claude_code|codex|external`；generation 必須為正整數。

- [x] **步驟 2：實作 `POST /register`**

呼叫 canonical DB upsert，成功回 `{session_id, alias, generation}`；alias conflict 回 409；錯誤 method 回 405。

- [x] **步驟 3：實作 `POST /unregister`**

呼叫 guarded release；成功／already released 回 200；identity not found 回 404；generation mismatch 回 409；錯誤 method 回 405。

- [x] **步驟 4：既有 MCP register 改用 canonical upsert**

維持無 `cc_session_id` 每次新建、既有 response shape、registry 與 transport cleanup；有 identity 時讓每次 register 都符合 generation 遞增與 released reactivation 語意。

- [x] **步驟 5：跑 integration 聚焦測試**

執行：`bun test tests/integration.test.ts --test-name-pattern "HTTP register|HTTP unregister|register\\("`

預期：PASS，0 failures。

### 任務 5：完整驗證與聚焦 commit

**檔案：**
- 檢查：本計畫所列全部修改檔

- [x] **步驟 1：跑 TypeScript 與完整測試**

執行：`bunx tsc --noEmit`

預期：exit 0。

執行：`bun test`

預期：全部測試 PASS，0 failures，既有 MCP／poll／monitor／external send 測試不回歸。

- [x] **步驟 2：逐項對照階段 scope**

確認只含 HTTP register/unregister、generation、validation 與必要共用 helper；不含 lease、poll 一般化、broadcast scope 或 waker。

- [x] **步驟 3：檢查 diff 與 working tree**

執行：`git diff --check`、`git diff --stat`、`git status --short`

預期：無 whitespace error，只有本階段相關檔案。

- [x] **步驟 4：建立一顆聚焦 commit**

執行：`git add ...` 後 `git commit -m "feat(server): HTTP register for non-MCP peers"`

預期：commit 成功；commit 後 `git status --short` 無輸出。不 push。
