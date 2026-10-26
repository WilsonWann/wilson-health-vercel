# Wilson 健康日報 4.0.3 — 驗證紀錄

## 原因查核

- 公開站台頁面標題為 4.0.2。
- 以原本 4.0.2 程式模擬已記住帳號的 LINE SSO：授權 URL 的 prompt 為空，驗證結果 amr=linesso 時 callback 回 400，狀態為 failed，後端原因「請使用 LINE QR Code 完成登入」，本站 sessions_v4 筆數為 0。
- LINE 官方文件明確記載 disable_auto_login 並不禁用 SSO；prompt=login 才是要求既有 SSO session 重新驗證的參數。此條件能重現使用者的畫面，未取得使用者該次正式環境的完整伺服器記錄。

## 自動測試與瀏覽器驗證

- `npm test`：127 tests passed，0 failed。
- `npm run check`：passed。
- 驗證授權 URL 同時要求 prompt=login、initial_amr_display=lineqr、switch_amr=false、disable_auto_login=true。
- SSO、缺少 amr 與密碼登入結果仍會被 QR 限制拒絕，並提供可操作錯誤；不因此建立本站 session。
- 驗證授權碼、nonce、資料庫錯誤分類，錯誤內容不外洩原始憑證；操作紀錄失敗不再使已驗證登入失敗。
- 原狀態輪詢、session 隔離、回應遺失復原及日報相關回歸測試通過。
- 驗證 /healthz 的 Vercel rewrite 與 /api/healthz 公開版本回應。

Chromium + mock LINE 完整流程：

- 正常登入、短暫斷線、成功回應遺失、彈出視窗被擋、重新整理接續、資料載入重試、手機尺寸取消／Guest、過期重試及 Admin 綁定。
- 模擬 LINE 仍保留帳號 Cookie，意外回傳 linesso 時：callback 顯示 LINE_QR_REQUIRED，提示重新掃碼；主視窗顯示相同原因，且沒有本站登入 session。
- callback 返回按鈕切回原登入視窗；重新產生 QR 後可以完成登入。
- 登出後本站 session 消失，即使 LINE Cookie 仍在，下次授權 URL 也要求 prompt=login。
- 重新部署時遇到舊的有效授權 URL，前端會丟棄舊流程並提示重新產生。
- 瀏覽器測試停用 AbortSignal.any，保留 4.0.2 的瀏覽器相容性驗證。

## 實際環境限制

本次沒有使用真實 LINE 帳號進行新的 QR 掃描，也未部署 Vercel Production。正式環境該次錯誤未直接取得，故不把模擬結果視為正式環境唯一可能原因。新版錯誤代碼與參考編號可用來確認後續錯誤是否發生在相同階段。

以下保留歷史版本驗證紀錄：

---

# Wilson 健康日報 4.0.2 — 驗證紀錄

## 本次驗證

- `npm test`：117 tests passed，0 failed。
- `npm run check`：passed。
- 新增測試涵蓋：斷線自動重試、慢速狀態請求不重疊、取消後忽略舊回應、過期後停止輪詢、裝置時鐘偏差、同分頁恢復流程，以及資料載入失敗後重試。
- 後端驗證：同時輪詢及回應遺失只建立同一 session、短期重取結果加密、錯誤 poll token 拒絕、已登出的 session 不會復活、callback 重複提交不重複交換授權碼，以及有效期檢查。
- 兩個獨立 backend instance 共用 SQLite 相容資料庫，驗證跨 instance 能重取同一登入結果。未使用真實 Turso 遠端連線。

## Chromium 瀏覽器驗證

本機 HTTP server 與 mock LINE OAuth：

1. 正常桌面登入與同源 callback 通知。
2. 狀態查詢斷線，加上成功回應遺失後自動復原。
3. 彈出視窗被擋後，重新開啟同一流程，不增加登入請求。
4. 重新整理後接續同一流程。
5. 登入完成但 Dashboard 載入失敗，可不重新掃碼而重試載入。
6. 390×844 手機尺寸：取消 QR 登入後可使用 Guest，登入選項可操作。
7. 過期流程提供新的 QR Code，移除過期的重新開啟連結。
8. 管理員 LINE 收件人綁定與一般會員登入保持分離。

以上登入情境亦在瀏覽器停用 `AbortSignal.any` 的情況下通過，避免依賴較新瀏覽器的此項 API。這不是 Safari 實機驗證。

4.0.1 錨點回歸：1280×800 與 390×844、admin/user/guest 的可見選單、重複點擊、重新整理、歷史導覽、舊錨點及未登入深連結均通過。

## 驗收限制與部署

- 測試沒有向真正 LINE 服務發送訊息，也沒有使用真實帳號掃描官方 QR Code。
- 尚未驗證 Safari／WebKit、真實 Turso 網路或 Vercel Production。
- 本次未部署線上站台。請完整更新專案後重新部署，以 `/healthz` 的 `4.0.2-vercel` 確認版本。
- LINE 官方 QR Code 的有效時間仍由 LINE 控制，本站倒數只表示本站登入流程剩餘時間。
- 500 人每日／週報 scheduler 仍屬後續工作。

以下保留先前版本的驗證紀錄：

---

# Wilson 健康日報 4.0.1 — 驗證紀錄

## 4.0.1 導覽修正與本次驗證

修正來源：LINE 會員登入時，側欄的 `#import`、`#line` 仍指向 `data-admin-only` 區塊。`applyRole()` 會隱藏目標，但舊側欄沒有同步隱藏，造成網址改變而畫面無法捲動。

本版依角色顯示選單，並新增會員自己的 LINE 狀態區塊。舊會員錨點會導向自己的區塊；登入完成及資料載入後重新處理錨點。

已執行：

- `npm test`：107 tests passed，0 failed。
- `npm run check`：passed。
- Chromium 真實瀏覽器、本機 HTTP server：1280×800 桌面與 390×844 手機尺寸，分別驗證 admin、user、guest。
- 每種角色的所有可見錨點都能定位到可見區塊。
- 驗證重新整理、重複點擊同一錨點、上一頁／下一頁、舊 `#line`／`#import` 網址、`#Line` 大小寫及無效編碼錨點。
- 驗證未登入先開啟 `#import`，登入管理者後才定位至匯入區塊。
- 驗證一般動態效果下的平滑捲動、標題鍵盤焦點，以及減少動態效果模式。
- LINE 會員測試使用 mock LINE OAuth；沒有向真正 LINE 服務發送任何訊息。
- WebKit 未完成驗證：執行環境缺少其系統相依函式庫，不能視為已驗證 Safari。

本次未執行 Vercel production deployment。上線後請確認頁面顯示 4.0.1，且 `/healthz` 回傳 `version: 4.0.1-vercel`。

以下保留 4.0.0 原始交付的驗證紀錄與功能限制：

---

# Wilson 健康日報 4.0.0 — 驗證紀錄

## 已執行的自動測試

- `npm test`: 107 tests passed, 0 failed（最終打包前再次執行）
- `npm run check`: JavaScript / project checks passed（最終打包前再次執行）

## 4.0.0 新增驗收

- LINE authorization URL 指定 `initial_amr_display=lineqr`、`switch_amr=false`、`disable_auto_login=true`。
- LINE member callback 在後端 exchange authorization code 並 verify ID token + nonce。
- 會員登入要求 verified `amr` 包含 `lineqr`；非 QR authentication 被拒絕。
- 第一次 LINE QR Login 自動建立 `role=user` 會員，不再查「是否綁 admin」。
- 會員自動建立自己的 64-char ingest token；DB 以 SHA-256 hash 做 lookup，明文以 APP_KEY 加密保存供本人取回。
- `/api/ingest` 依 token owner 寫入該 user 的 `user_samples_v4`。
- 兩位模擬 LINE 會員取得不同 ingest token：A 上傳 1111.1 步、B 上傳 2222.2 步；A/B 的 `/api/state` 僅能看到自己的值。
- 前端沒有 user selector；會員資料查詢 owner 來自 HttpOnly session，而非 query/body。
- `admin` 仍只由帳號密碼登入；admin LINE recipient binding 不授予 admin LINE Login。
- Guest 仍只能取得 Mock Data 與唯讀 UI。
- `/api/me/sync-config` 只回傳當前會員自己的 ingest endpoint/token。
- 會員可 rotate 自己的 token；舊 token 失效。
- 會員手動 LINE 報告使用自己的 `line_user_id` 與自己的 health rows。
- 舊 admin LINE 收件人首次以會員登入時，可 copy legacy samples 到會員 store，避免 Wilson 現有資料中斷。

## 保留的回歸測試

- 小數步數、重送不累加、部分日資料、Days aggregation 診斷。
- Valid rows partial-ingest；invalid rows 只 warning/rejected。
- Sleep / heart rate / resting heart rate / active energy / exercise time。
- Height / weight / BMI 單位正規化與 latest-known carry-forward。
- LINE admin recipient binding、Messaging API mocked push。
- Guest privacy / 403 enforcement。
- 操作紀錄獨立 `/logs`，每頁 10 筆、admin only。
- Vercel route adapter、4 MB app payload limit、Cron auth。
- Turso-compatible async store、sessions、login limiter、atomic delivery locks。

## 尚未在此執行的真實外部驗收

- 測試使用 mock LINE endpoints，沒有在本次打包環境用真實 LINE 帳號完成 OAuth/Push。
- 本地測試 DB 使用 SQLite-compatible async adapter，不等同真實 Turso network round-trip。
- 沒有替使用者實際執行 Vercel production deployment。
- 500 人的「每人每日/週報批次 scheduler」尚未實作；4.0.0 的會員功能已完成登入、隔離、ingest token 與個人手動發送。

## 秘密值

交付 ZIP 不包含 `.env`、Channel Access Token、LINE Channel Secret、Turso token、真實健康資料或資料庫。
