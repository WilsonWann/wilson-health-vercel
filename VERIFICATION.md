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
