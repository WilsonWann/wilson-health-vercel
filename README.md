# Wilson 健康日報 4.0.3

Vercel + Turso 的多人健康資料儀表板。一般會員以 **LINE 官方 QR Login** 登入；身分只由後端驗證 LINE ID token 後的 `sub` 決定。前端不能指定或切換成其他會員。管理者與 Guest 仍使用帳號密碼。

## 4.0.3 修正 LINE SSO 與 QR 驗證衝突

4.0.2 以 `disable_auto_login=true`、`initial_amr_display=lineqr` 顯示登入頁，但未指定 `prompt=login`。LINE 仍可能顯示記住帳號的「Continue as」SSO 頁面。按下 Log in 後，後端的 QR 限制會拒絕 `amr=linesso`，而舊 callback 頁只顯示通用失敗訊息。

本版保留一般會員必須以 QR 登入的要求：

- 授權 URL 加上 `prompt=login`，要求既有 LINE SSO session 重新驗證。
- 前端不再接續缺少此參數的舊授權 URL，提示重新產生 QR Code。
- SSO、授權碼失效、頻道設定、nonce 驗證及資料處理失敗提供不同錯誤代碼與參考編號。
- `/logs` 與 Vercel Logs 的 `line_auth_failed` 記錄包含階段、代碼、參考編號與已驗證登入方法，不記錄 token、授權碼、nonce、state 或原始外部錯誤內容。
- callback 失敗頁不再顯示「系統會自動接續登入」；返回按鈕會切回原登入視窗。
- optional 操作紀錄寫入失敗不再把已完成的身分驗證改成失敗。
- 補上 Vercel 的 `/healthz` 路由，亦可用 `/api/healthz` 查詢 `4.0.3-vercel`。

健康日報登出會清除本站 session；LINE 的 SSO Cookie 由 `access.line.me` 管理，可能繼續保留。本版要求重新驗證，不依賴清除 LINE 的全站 Cookie。

參考 LINE 官方文件：

- [授權參數、prompt=login 與 SSO Cookie](https://developers.line.biz/en/docs/line-login/integrate-line-login/)
- [ID token 的 lineqr / linesso 等 amr 值](https://developers.line.biz/en/docs/line-login/verify-id-token/)

完整更新本 ZIP 並重新部署後，請從登入頁重新產生 QR Code，確認版本及實際登入結果。舊版 URL 不應重用。本次測試使用模擬 LINE 服務，未連線讀取正式環境的特定失敗記錄。

## 4.0.2 LINE 登入穩定性與流程

- 登入以 LINE 為主要入口，管理員／展示模式收在獨立選項中。
- 掃碼狀態、登入倒數、重新開啟視窗、重新產生 QR Code 與其他登入方式集中在同一區。
- 每次只送出一個狀態請求；12 秒請求逾時、暫時斷線或 5xx 會重試，回到視窗或恢復連線時立即確認狀態。
- 重新整理後可從同一分頁的 sessionStorage 接續尚未到期的流程；取消或完成會清除。瀏覽器不允許儲存時仍可登入，但無法跨重新整理接續。
- 倒數顯示的是本站登入流程的有效時間，並非 LINE 官方 QR Code 保證有效時間。QR Code 到期時可手動重新產生；不在掃描過程中自動替換。
- 後端 callback 防止同一授權碼被重複交換。登入結果在 60 秒內可安全重取同一 session，避免回應遺失後卡在 consumed。
- 新增 `line_login_results_v1` 表，短期重取資料以 APP_KEY 加密；取回仍須原 poll token，不會恢復已登出的 session。
- 身分已確認但 Dashboard 暫時無法載入時，可直接重試載入；管理員的 LINE 綁定也使用相同的重試流程。
- 回呼頁透過同源通知加速原視窗的狀態確認；最終身分仍由後端判定，通知本身不授權。
- 請完整部署 ZIP 內容（包含新增的 public JS 模組與後端），保留現有 APP_KEY、其他環境變數及 Turso。資料表於啟動時自動建立，不需清除原資料。

LINE 官方 QR Login 的有效期與手機授權仍由 LINE 控制。本次使用 mock LINE 服務驗證流程，實際帳號 OAuth 及 Production 部署需在你的環境驗收。

## 4.0.1 導覽修正

- 修正一般會員仍看得到 `#import`、`#line` 管理員區塊連結的問題；原本目標被隱藏，所以網址改變卻不會捲動。
- 管理者：健康總覽、匯入與診斷、LINE 連線、操作紀錄。
- LINE 會員：健康總覽、我的同步設定、自己的 LINE 連線狀態。
- Guest：健康總覽；不顯示私人管理或會員功能的連結。
- 登入並完成資料載入後才處理網址錨點，支援重新整理、上一頁／下一頁、重複點擊同一項。
- 舊會員網址 `#line` 會定位至 `#userLine`，`#import` 會定位至 `#userSync`；大小寫會正規化。無權限或無效錨點會返回健康總覽。
- 導覽會定位到區塊開頭並移動鍵盤焦點，且遵循系統的減少動態效果偏好。

將本 ZIP **完整內容**更新至原 Vercel 專案並重新部署，保留原環境變數與 Turso 資料庫。靜態資源版本參數已更新，部署後可用 `/healthz` 確認 `4.0.3-vercel`。

## 4.0.0 核心模型

```text
一般會員
LINE 官方 QR Login
  → LINE callback
  → 後端 exchange authorization code
  → 後端 verify ID token + nonce
  → 可信任 line_user_id = verified.sub
  → 建立/找到 internal user
  → 建立 role=user session
  → 只查自己的 health data

管理者
admin + ADMIN_PASSWORD → role=admin

Guest
guest + optional empty password → role=guest → Mock Data only
```

會員登入授權 URL 強制使用：

- `prompt=login`
- `initial_amr_display=lineqr`
- `switch_amr=false`
- `disable_auto_login=true`

會員 callback 另外要求 LINE 驗證結果的 `amr` 包含 `lineqr`。QR 與二階段安全驗證由 LINE 官方頁面處理，不自行模仿 LINE 桌面版的私有協定。

## 會員資料隔離

每位 LINE 會員有獨立：

- `users_v4` 會員資料
- `user_ingest_tokens_v4` 個人 Health Auto Export token
- `user_samples_v4` 健康資料
- `sessions_v4` 登入 session

`/api/state` 只根據 HttpOnly session 中的 `user_id` 查資料，不接受前端傳入「要看誰」。

`/api/ingest` 會把 Bearer token hash 後找 owner，再只寫入該 owner 的 `user_samples_v4`。兩位會員不能用 query/body 指定對方的 user id。

## 第一次 LINE Login

1. 使用者按「使用 LINE QR 登入」。
2. 網頁開啟 LINE 官方 Login 頁面，預設只顯示 QR Login。
3. 手機 LINE 掃描並完成 LINE 的驗證。
4. 後端驗證 authorization code、ID token、nonce、`amr=lineqr`。
5. 以 `verified.sub` 建立或找到會員。
6. 系統自動建立個人 ingest token。
7. 桌面取得自己的 `role=user` session，進入自己的 Dashboard。

如果使用者是既有 admin LINE 收件人，第一次以會員身分登入時，系統會把既有 legacy admin 健康樣本複製到該會員帳號，避免 Wilson 現有資料消失；後續會員資料與 admin legacy store 分開。

## iPhone / Health Auto Export

會員登入後，在「我的 iPhone 同步設定」取得：

```text
POST https://<production-domain>/api/ingest
Content-Type: application/json
Authorization: Bearer <個人 ingest token>
```

建議 Health Auto Export：

```text
JSON
Summarize = ON
Time Grouping = Days
Time Zone = Asia/Taipei
```

使用者可自行 rotate ingest token；舊 token 立即失效。

原本全域 `INGEST_TOKEN` 仍保留給 legacy/admin 資料相容，不應發給一般會員。

## LINE 日報

`LINE_CHANNEL_ACCESS_TOKEN` 是整個官方帳號共用的一組 server-side credential。

一般會員手動發送報告時，後端會：

```text
session.user_id
→ users_v4.line_user_id
→ 只取 user_samples_v4 該 user 的資料
→ Messaging API push 給該 line_user_id
```

目前 **多人每日/週報批次排程尚未完成**。現有 Vercel Cron 仍是 legacy/admin 日報排程。4.0.0 已完成會員身分、個人資料隔離、個人 ingest token 與會員手動 LINE 報告；500 人版的 per-user daily/weekly scheduler 是下一階段。

## Admin 的 LINE 綁定

Admin 的「LINE 綁定」仍只用於選擇 **admin 日報收件人**，不會讓 LINE 帳號獲得 admin 權限。

一般會員的 LINE QR Login 與 admin 權限完全分離：

```text
LINE Login → role=user
admin 帳密 → role=admin
```

## LINE Provider 設定

Messaging API Channel 與 LINE Login Channel 應位於同一個 LINE Provider，並連結同一個 LINE 官方帳號。

LINE Login callback：

```text
https://<production-domain>/api/line/auth/callback
```

Vercel 必要環境變數：

```text
ADMIN_PASSWORD
APP_KEY
INGEST_TOKEN
CRON_SECRET
TURSO_DATABASE_URL
TURSO_AUTH_TOKEN
LINE_CHANNEL_ACCESS_TOKEN
LINE_LOGIN_CHANNEL_ID
LINE_LOGIN_CHANNEL_SECRET
```

可選：

```text
ADMIN_USERNAME   # default: admin
GUEST_USERNAME   # default: guest
GUEST_PASSWORD   # may be blank
APP_ORIGIN       # Vercel normally infers this
```

不要把 `.env` 提交 Git。`.gitignore` / `.vercelignore` 已排除 `.env*`（`.env.example` 除外）。

## 部署

```bash
nvm use
npm install
npm test
npm run check
npx vercel --prod
```

部署後：

```text
GET /healthz
```

應回傳 `version: 4.0.3-vercel`。

## 權限摘要

| 功能 | admin | user (LINE) | guest |
|---|---:|---:|---:|
| 管理 legacy/private dashboard | ✓ | - | - |
| 看自己的健康資料 | - | ✓ | Mock only |
| 個人 ingest token | - | ✓ | - |
| 手動發自己的 LINE 報告 | - | ✓ | - |
| LINE admin 收件人綁定 | ✓ | - | - |
| 操作紀錄 `/logs` | ✓ | - | - |
| 備份／管理設定 | ✓ | - | - |

## 既有功能

- Decimal step count 與每日彙總
- Partial-day data from Taipei 00:00
- 部分成功匯入與 warnings
- 身高、體重、BMI latest-known value
- 互動式 metric cards / trends
- Guest Mock Data
- Admin operation logs `/logs`, 10 筆/頁
- LINE Messaging API
- Vercel + Turso

本工具不是醫療診斷服務。
