# Wilson 健康日報 2.0 — Vercel 部署版（程式版本 2.6.1）

這份沿用 2.0 網頁與健康解析邏輯，改為 Vercel Functions + 遠端 Turso/libSQL。
**這是原始碼，不代表已經建立 Vercel 服務。沒有包含密碼、LINE Token、真實健康 JSON 或資料庫。**

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

## LINE 與排程

登入網頁 → LINE 設定 → 輸入既有 LINE Channel access token 和 U 開頭個人 User ID → 儲存 → 驗證。
只在你點選確認後發送測試/日報；自動發送在新資料庫預設關閉。
LINE 憑證用 APP_KEY 進行 AES-256-GCM 加密，登入 Session、匯入與發送紀錄也保存在遠端資料庫，不依賴某台函式的記憶體。

`vercel.json` 的 cron：`0 1 * * *`，也就是台北每日 09:00；Vercel 呼叫 GET `/api/cron` 並帶 CRON_SECRET。
Hobby 每日排程有小時級精度，不能保證 09:00 整。網頁時間欄在 Vercel 固定 09:00，避免改表單卻沒改平台排程。
要更改時間需同時修改 vercel.json 和程式內 fixedReportTime/驗證規則。

每日僅處理前一天且已有步數的真實資料。未啟用、未驗證、缺步數或已發送則略過，結果保存在 events。
若當次因手機尚未同步而略過，本版不安排第二次自動補發；資料到齊後可在網頁預覽並手動發送。
不使用常駐 `setInterval`，也不依賴 ChatGPT 任務。GET `/api/jobs/daily` 只讀紀錄；GET `/api/cron` 才是平台的受保護排程執行入口。

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
