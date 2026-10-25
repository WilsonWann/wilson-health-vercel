# 驗證紀錄

日期：2026-10-25；執行環境：Node.js 22.16.0（部署設定為 24.x）。

已實際執行：
- npm test：100 tests，100 pass，0 fail。
- npm run build / check：JavaScript 語法檢查通過。
- 原有 56 項本地測試保留並改為非同步 Store 介面。
- 新增 Vercel 路由、已解析的 body、4 MB 程式內限制、遠端資料庫必填、Cron GET 驗證與停用保護、固定排程欄位。
- 2.3.0：`Automation-Aggregation` 改為診斷資訊，不再阻擋匯入；支援部分成功匯入，壞資料以 rejected/warnings 回報，其他有效資料照常寫入。
- 2.6.3：登入改為帳號＋密碼；新增 Guest 後端唯讀角色與獨立 Mock Data；Guest 無法取得私人健康資料、LINE 設定、備份、操作紀錄或執行寫入/發送/排程；既有 sessions schema 自動補 role 欄位。
- 2.5.0：每日指標卡片改為可點擊/鍵盤操作，選取後動態切換趨勢圖與區間摘要；身體測量只繪製實際量測點。
- 2.4.0：新增身高、體重與 BMI；支援身高/體重單位正規化、同日採較晚量測，以及在儀表板與 LINE 日報沿用截至該日最近一次身體量測。
- 兩個獨立 createApp 連到同一本地測試 SQLite：登入狀態、數據可共享，日期發送鎖只允許一次模擬推播。
- 登入限制跨 instance 保存；失敗批次 rollback；重傳不加總。

限制：
- 測試資料庫是實際本機 SQLite，透過與雲端相同的 async execute/batch Store 介面，並非真實 Turso 網路連線。
- LINE 是 fetch 模擬，沒有實際發送訊息。
- 此環境無法解析 npm registry 網址，沒有在此安裝/執行遠端 @libsql/client 0.18.0；Vercel 或使用者須 npm install。沒有捏造 package-lock.json。
- 沒有 Vercel 帳號部署權限，因此未執行真實 vercel build/deploy，未提供已上線網址。
- 沒有執行真實瀏覽器視覺驗收；已以 UI 靜態回歸測試驗證帳號欄位、Guest disabled 樣式、互動卡片與日期下拉箭頭定位。
- 附件不包含 .env、真實健康樣本、資料庫、LINE 憑證或舊網站服務金鑰。

- 2.6.3：移除既有 sessions 的啟動期 ALTER TABLE migration，改用 sessions_v2；新增 startup_error 安全診斷。

- Guest password is optional; empty password login is covered by regression tests.


- 2.6.3: verified passwordless guest submit is not blocked by native HTML required validation.

- 2.7.0：新增 LINE Login QR 收件人綁定回歸測試；驗證 token-only LINE 設定、短效 state/nonce、authorization URL、callback token exchange、ID token verify、friendship status 與收件人 User ID 自動寫回。
- QR/LINE Login 測試使用 fetch mock，沒有連真實 LINE 平台；正式部署仍需設定真實 LINE_LOGIN_CHANNEL_ID / LINE_LOGIN_CHANNEL_SECRET 與 Callback URL。

## 3.0.0 LINE Login QR

- 帳號密碼登入回歸保持通過。
- LINE Login QR start 產生 server-side SVG QR 與短效 state/nonce/poll secret。
- 未綁定 LINE userId 經 callback 驗證後仍不能取得私人 Session。
- admin 帳密登入後可用 QR 綁定 LINE userId；之後相同 LINE userId 可完成 QR 登入並取得 admin Session。
- Messaging API token 由 LINE_CHANNEL_ACCESS_TOKEN 後端變數讀取；前端 HTML/JS 不包含 token 輸入欄位。
- QR encoder vendored in-repo；不向第三方 QR 服務傳送 OAuth URL。
