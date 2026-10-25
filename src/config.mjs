export function configFromEnv(env=process.env){
  const vercel=env.VERCEL==='1',production=vercel||env.NODE_ENV==='production';
  const inferred=env.VERCEL_ENV==='production'?(env.VERCEL_PROJECT_PRODUCTION_URL||env.VERCEL_URL):env.VERCEL_URL;
  const origin=(env.APP_ORIGIN||(inferred?'https://'+inferred:'')).replace(/\/$/,'');
  return {password:env.ADMIN_PASSWORD,adminUsername:env.ADMIN_USERNAME||'admin',guestUsername:env.GUEST_USERNAME||'guest',guestPassword:env.GUEST_PASSWORD||'',key:env.APP_KEY,ingestToken:env.INGEST_TOKEN,cronToken:env.CRON_SECRET,
    dbPath:env.DB_PATH||'./data/health.sqlite',dbUrl:env.TURSO_DATABASE_URL,dbToken:env.TURSO_AUTH_TOKEN,
    lineLoginChannelId:env.LINE_LOGIN_CHANNEL_ID||'',lineLoginChannelSecret:env.LINE_LOGIN_CHANNEL_SECRET||'',lineChannelAccessToken:env.LINE_CHANNEL_ACCESS_TOKEN||'',
    vercel,production,origin};
}
