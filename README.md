# Wilson 健康日報 3.0 — Vercel 部署版（程式版本 3.0.2）

這份沿用 2.0 網頁與健康解析邏輯，改為 Vercel Functions + 遠端 Turso/libSQL。
**這是原始碼，不代表已經建立 Vercel 服務。依本次要求，壓縮包內的本機 `.env` 已寫入提供的 Messaging API Channel access token；`.env` 同時被 `.gitignore` 與 `.vercelignore` 排除。其他私人環境變數仍需自行合併/設定。**

## 最短部署流程

1. 解壓縮到獨立目錄。保留舊 2.0 的 `.env` 和 `data/`，不要刪除舊站。
2. 使用 Node.js 24：`nvm use`（沒有 24 時先 `nvm install 24`）。
3. 執行 `npm install`、`npm test`、`npm run build`。`build` 是語法檢查，前端是現成靜態檔案，不會在建置時連資料庫或發 LINE。
4. `npx vercel login`，接著 `npx vercel link`，建立/連結你自己的專案。不要選擇覆蓋其他應用。Framework 使用 **Other**；根目錄是本目錄；Build Command 與 Output Directory 已寫在 vercel.json，不需自訂。
5. 在 Vercel Marketplace 連接 **Turso 的遠端 libSQL 資料庫**（或提供已有的相容遠端 libSQL 連線）。不要使用本機 SQLite、embedded replica、file: 或 /tmp。確認服務方案及資料所在地後才建立。
6. 到 Project Settings → Environment Variables，設定下列變數的 **Production** 值。密碼不提交 Git，不需要傳給 ChatGPT。
7. `npx vercel --prod`。用成功部署後的固定 Production Domain 登入，不使用每次重建會改變的 Preview URL。

### 必要環境變數

| 名稱 | 說明 |
|---|---|
| ADMIN_USERNAME | 管理者登入帳號；未設定時預設 `admin` |
| ADMIN_PASSWORD | 沿用現有 2.0 的管理密碼，至少 16 字元 |
| GUEST_USERNAME | Guest 展示帳號；未設定時預設 `guest` |
| GUEST_PASSWORD | Guest 展示密碼，可留空；留空時以 Guest 帳號＋空密碼登入 |
| APP_KEY | 沿用現有 2.0 的 64 位 hex 金鑰；儲存 LINE 設定後不得隨意更換 |
| INGEST_TOKEN | 沿用/設定至少 32 字元的手機匯入金鑰；不同於 LINE Token |
| CRON_SECRET | 至少 32 字元的獨立排程金鑰 |
| TURSO_DATABASE_URL | 遠端 libSQL 的 `libsql://...` 或 HTTPS URL |
| TURSO_AUTH_TOKEN | 該遠端資料庫的可讀寫 Token，不是 Vercel Token |
| LINE_CHANNEL_ACCESS_TOKEN | Messaging API Channel access token；代表官方帳號發送訊息，只存在後端環境變數 |
| LINE_LOGIN_CHANNEL_ID | LINE Login Channel ID；用於首頁 QR 登入與帳密登入後的 QR 綁定 |
| LINE_LOGIN_CHANNEL_SECRET | LINE Login Channel Secret；只放後端環境變數，不放前端 |

`APP_ORIGIN` 選填；留白時由 Vercel 的 project/preview system variables 推斷。自訂網域時設成 `https://health.example.com`（不含路徑）。如果登入出現跨站錯誤，檢查目前網址是否為 Production Domain，並讓 APP_ORIGIN 與實際開啟的網址一致。

`DB_PATH`、`HOST`、`PORT` 僅供本機開發；不用在 Vercel 設定。也不要把本機的 `NODE_ENV=development` 搬進 Production。
Vercel 不會因你電腦有 `.env` 而自動取得其內容；請在平台自行設定或使用 `vercel env add`。改完環境變數須重新部署才套用。
如果 Turso Marketplace 自動注入的變數帶自訂 prefix，請提供程式使用的上述兩個名稱。

### 部署保護與健康資料

儀表板改為帳號＋密碼登入。管理者可讀寫私人資料；Guest 僅取得伺服器產生的 Mock Data，後端不會把真實健康資料、LINE User ID、憑證、操作紀錄或備份回傳給 Guest。匯入 API 仍使用獨立 Bearer 金鑰。
Vercel 平台的額外登入牆是另一層保護。iPhone 不是已登入 Vercel 的瀏覽器：正式匯入端點必須能抵達程式，或另行配置受控的自動化 bypass。不要停用程式自己的密碼/金鑰驗證。
以手機發送一次測試，應收到 JSON，而不是 Vercel HTML 登入畫面。不要將服務移成無驗證 API。

## iPhone Health Auto Export

REST API 自動化：

```text
URL: https://實際-production-domain.vercel.app/api/ingest
Method: POST
Header: Authorization = Bearer <INGEST_TOKEN>
Header: Content-Type = application/json
Format: JSON
Data: Health Metrics
Summarize: On
Time Grouping: Day
Time Zone: Asia/Taipei
Range: Previous 7 Days
```

請選取 Step Count、Sleep Analysis、Heart Rate、Resting Heart Rate、Active Energy、Apple Exercise Time 等實際需要的項目。
移除 1.0 的 `OAI-Sites-Authorization`。第一次先解鎖 iPhone 手動匯出，確認新站數據再啟用每日自動化。
每批 JSON 的程式內上限為 4 MB；Vercel 平台仍有自己的 request body 上限，過大時應縮短天數或拆分指標。本版只接「每日彙總」或從台北 00:00 起算的今日暫時彙總，不把一般逐筆/小時紀錄誤加成每日總數。
`Automation-Aggregation` header 僅作診斷，不再作為拒絕條件；真正是否可匯入由 JSON 內容判斷。
單一指標或單筆紀錄格式不支援時，其他有效資料仍會寫入，回應中的 `rejected` 與 `warnings` 會說明被略過項目；只有整包完全沒有可用每日資料時才回 422。
缺步數會留下警告；未提供不等於 0；小數保留在資料庫，展示時才取整數。

**iPhone 上傳與 LINE 推播是兩個不同排程。** Vercel 不會讀取手機內的 HealthKit。手機上傳時間仍受 iOS 背景執行、鎖定和權限影響，不能保證某個分鐘收到全部資料。

## LINE Login、綁定與排程

3.0.2 提供兩種登入方式：

1. **LINE 官方 QR Login**：點「使用 LINE QR Code 登入」後，瀏覽器直接前往 LINE 官方授權頁；LINE 官方頁面預設顯示 QR Code。使用者以手機 LINE 掃描並完成驗證後，LINE callback 會回到健康日報並直接建立網站 Session。
2. **帳號／密碼**：保留既有 admin / guest 流程。第一次使用 LINE Login 前，admin 必須先用帳密登入，在「LINE 連線」區完成一次 LINE 官方 QR 綁定。未綁定的 LINE 帳號不能直接登入私人儀表板。

帳密登入後的 LINE 綁定也使用同一個 LINE Login Channel：點「用 LINE QR Code 綁定」→ 前往 LINE 官方 QR Login 頁 → 手機授權 → 後端驗證 ID token 的 `sub`（LINE userId）→ 綁定到 admin 帳號，同時作為日報收件人。

### LINE 3.0.2 前置設定

1. 在 LINE Developers 的**同一個 Provider**下保留 Messaging API Channel，並建立 LINE Login Channel。
2. LINE Login Channel 的 Basic settings → **Linked LINE Official Account**，連結目前的 Wilson 健康日報官方帳號。
3. LINE Login Channel 的 Web app Callback URL 加入：
   `https://你的-production-domain/api/line/auth/callback`
4. LINE Login Channel 的 LINE Login 設定中，若希望 QR Login 強制使用二階段驗證，開啟 **Require two-factor authentication**。
5. Vercel Production Environment Variables 設定：
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `LINE_LOGIN_CHANNEL_ID`
   - `LINE_LOGIN_CHANNEL_SECRET`
6. Redeploy。
7. 第一次先以 admin 帳密登入 → LINE 連線 →「用 LINE QR Code 綁定」→ 完成 LINE 官方 QR Login；之後首頁即可直接用 LINE 官方 QR Login 登入。

LINE Login 使用 OAuth 2.0 authorization code + OpenID Connect。授權 URL 帶：

- `initial_amr_display=lineqr`：預設顯示 QR Login
- `switch_amr=false`：隱藏切換 Email/password 的按鈕
- `disable_auto_login=true`：避免 Auto Login 跳過預期的 QR 流程
- `ui_locales=zh-TW`：繁體中文介面
- `bot_prompt=normal`：若 Login Channel 已連結官方帳號，可在登入流程提供加好友選項

`LINE_CHANNEL_ACCESS_TOKEN` 只決定「哪個官方帳號發訊息」，不出現在 LINE Login QR、不傳到前端；收件人 User ID 由 LINE Login 綁定取得。網站前端不提供 Channel token 或 `U...` User ID 的手動輸入欄位。

只在你點選確認後發送測試/日報；自動發送在新資料庫預設關閉。`vercel.json` 的 cron：`0 1 * * *`，也就是台北每日 09:00。Hobby 每日排程有小時級精度，不能保證 09:00 整。

每日僅處理前一天且已有步數的真實資料。未啟用、未驗證、缺步數或已發送則略過，結果保存在 events。

## 搬移資料：不會自動讀到 1.0 或 Mac 資料庫

部署不會把 Mac 的 data/ 或 .env 上傳；初次遠端資料庫是空的。
可從手機重新匯出歷史日彙總，或把已提供的步數 JSON 在網頁「匯入與診斷」匯入。
如果有 2.0 的私人備份（version:2 + rows）：

1. 保留備份在 Git 以外。
2. 在本機 .env 設定目標 TURSO_DATABASE_URL、TURSO_AUTH_TOKEN 和 APP_KEY。
3. `npm run restore -- /完整路徑/私人備份.json`

restore 只處理健康數值，不搬移舊登入、LINE 設定或發送歷史；更新時間為本次還原時間。
不要直接拿 data/health.sqlite 當成 JSON 匯入。
重傳同日同指標採 upsert，不累加；其他指標不會被清空。跨站發送歷史不共用，遷移驗收前不要同時開啟兩站自動發送。

## 本機開發

有現有 .env 時不需要重新跑 setup。沒有才執行 `npm run setup`；不會覆蓋現有檔案。
不設定 TURSO_DATABASE_URL 時使用 Node 內建 SQLite（僅限本機），Node.js 24 建議、22.16+ 可執行測試；Node 18 不支援。
在 Vercel 沒有遠端資料庫變數會回報未就緒，**不會退回不持久的檔案或 /tmp**。
本機 npm start 不執行背景 LINE 排程，避免本機與雲端重複發送。

## 驗證界線

請閱讀 VERIFICATION.md。本地測試通過不代表真實 Vercel 部署、Turso 網路連線或手機到 LINE 的端到端已驗收。

## 官方文件（2026-10-25 查核）

- Vercel SQLite 限制：https://vercel.com/kb/guide/is-sqlite-supported-in-vercel
- Node Function API：https://vercel.com/docs/functions/runtimes/node-js
- Turso/libSQL client：https://docs.turso.tech/sdk/ts/reference
- Turso Marketplace：https://vercel.com/marketplace/tursocloud
- Environment variables：https://vercel.com/docs/cli/env
- Cron auth：https://vercel.com/docs/cron-jobs/manage-cron-jobs
- Cron precision：https://vercel.com/docs/cron-jobs/usage-and-pricing
- HAE REST API：https://help.healthyapps.dev/en/health-auto-export/automations/rest-api/


## 2.5.0 指標卡片互動

每日概況的 9 張指標卡片現在可點擊，也支援鍵盤焦點。點選後，下方趨勢區會切換到該指標，並依資料性質顯示區間合計、區間平均或最近量測。身高、體重與 BMI 的趨勢只畫實際量測點，不會把沿用值誤當成每天量測。

## 2.4.0 身體測量

儀表板新增身高、體重與 BMI。Health Auto Export 對應指標為 `height`、`weight_&_body_mass`、`body_mass_index`。身高統一顯示 cm、體重統一顯示 kg；若選定日期沒有新量測，會沿用截至該日最近一次身體測量並標示量測日期。


## 2.6.0 帳號與 Guest 展示模式

登入入口為「帳號＋密碼」。管理者帳號由 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 控制；Guest 帳號由 `GUEST_USERNAME` 控制，`GUEST_PASSWORD` 可省略或留空。原本的 ADMIN_PASSWORD、APP_KEY、Turso 與 LINE 設定都可沿用。

Guest 是真正的後端唯讀角色，不只是前端把按鈕反灰：
- `/api/state` 只回傳獨立生成的 Mock Data，不查詢或回傳私人健康資料。
- `/api/report/preview` 只使用 Mock Data。
- 備份、手動匯入、LINE 設定/驗證/發送、排程與私人操作紀錄均禁止 Guest 存取，直接回 403。
- 前端仍將私人區塊反灰 disabled，方便展示網站結構但不顯示隱私內容。
- 2.6.1 起不再修改既有 `sessions` table；改用新的 `sessions_v2` 儲存角色型 session，避免部署時做 ALTER TABLE。升級後舊登入 session 會失效一次，但健康資料與設定不受影響。

若本機首次使用 `npm run setup`，會產生 admin 密碼；Guest 預設密碼留空，正式 Vercel 可自行設定或維持空白。


## 2.6.1 啟動可靠性修正

- 不再在冷啟動執行 `ALTER TABLE sessions`。
- 使用獨立 `sessions_v2` table 儲存 admin / guest session。
- Vercel 啟動失敗會在 Runtime Logs 輸出 `[startup_error] <原因>`；前端只顯示安全的 `STARTUP_FAILED`。


## 2.6.3 login UI compatibility

- Login form disables native HTML constraint validation (`novalidate`).
- Guest can submit an empty password without browser-level blocking.
- Username presence is validated by application code; credentials are still verified server-side.
- Static CSS/JS URLs include the 2.6.3 version query to make deployed version changes obvious and reduce stale-asset confusion.




## 3.0.2 LINE 官方 QR Login

- 不再自行產生 OAuth QR Code，也不再使用桌面 polling。
- 登入與 LINE 綁定都直接導向 LINE 官方授權頁。
- LINE 官方頁面使用 `initial_amr_display=lineqr`、`switch_amr=false`、`disable_auto_login=true`，優先顯示 QR Login。
- 手機完成 LINE 驗證後，callback 直接建立網站 Session（登入）或寫入 LINE 綁定（bind），再導回健康日報。
- 未綁定的 LINE userId 仍不能登入私人儀表板。
