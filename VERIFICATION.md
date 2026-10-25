# 驗證紀錄

日期：2026-10-25；執行環境：Node.js 22.16.0（部署設定為 24.x）。

已實際執行：
- npm test：87 tests，87 pass，0 fail。
- npm run build / check：JavaScript 語法檢查通過。
- 原有 56 項本地測試保留並改為非同步 Store 介面。
- 新增 Vercel 路由、已解析的 body、4 MB 程式內限制、遠端資料庫必填、Cron GET 驗證與停用保護、固定排程欄位。
- 2.3.0：`Automation-Aggregation` 改為診斷資訊，不再阻擋匯入；支援部分成功匯入，壞資料以 rejected/warnings 回報，其他有效資料照常寫入。
- 2.4.0：新增身高、體重與 BMI；支援身高/體重單位正規化、同日採較晚量測，以及在儀表板與 LINE 日報沿用截至該日最近一次身體量測。
- 兩個獨立 createApp 連到同一本地測試 SQLite：登入狀態、數據可共享，日期發送鎖只允許一次模擬推播。
- 登入限制跨 instance 保存；失敗批次 rollback；重傳不加總。

限制：
- 測試資料庫是實際本機 SQLite，透過與雲端相同的 async execute/batch Store 介面，並非真實 Turso 網路連線。
- LINE 是 fetch 模擬，沒有實際發送訊息。
- 此環境無法解析 npm registry 網址，沒有在此安裝/執行遠端 @libsql/client 0.18.0；Vercel 或使用者須 npm install。沒有捏造 package-lock.json。
- 沒有 Vercel 帳號部署權限，因此未執行真實 vercel build/deploy，未提供已上線網址。
- 沒有執行瀏覽器視覺驗收，未改動主要版面。
- 附件不包含 .env、真實健康樣本、資料庫、LINE 憑證或舊網站服務金鑰。
