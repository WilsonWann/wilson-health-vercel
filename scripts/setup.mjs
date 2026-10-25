import { existsSync,writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if(existsSync('.env')){console.error('.env 已存在，未覆蓋。');process.exit(1);}
const password=randomBytes(20).toString('base64url');
const text=['ADMIN_USERNAME=admin',`ADMIN_PASSWORD=${password}`,'GUEST_USERNAME=guest','GUEST_PASSWORD=',`APP_KEY=${randomBytes(32).toString('hex')}`,`INGEST_TOKEN=${randomBytes(32).toString('hex')}`,`CRON_SECRET=${randomBytes(32).toString('hex')}`,'LINE_CHANNEL_ACCESS_TOKEN=','LINE_LOGIN_CHANNEL_ID=','LINE_LOGIN_CHANNEL_SECRET=','DB_PATH=./data/health.sqlite','PORT=3000','HOST=127.0.0.1','NODE_ENV=development','# Vercel 由專案網域自動推斷 APP_ORIGIN；自訂網域時再填寫。','APP_ORIGIN='].join('\n')+'\n';
writeFileSync('.env',text,{mode:0o600,flag:'wx'});
console.log('已建立私人的 .env（不會覆蓋既有檔案）。');
console.log('管理者帳號：admin');
console.log('管理者首次登入密碼：'+password);
console.log('Guest 帳號：guest');
console.log('Guest 首次登入密碼：留白（可自行設定）');
console.log('請保存在密碼管理器，不要將 .env 上傳 GitHub 或聊天室。接著執行 npm start。');
