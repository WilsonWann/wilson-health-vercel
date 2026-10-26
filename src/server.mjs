import { existsSync } from 'node:fs';
import { createApp } from './app.mjs';
import { configFromEnv } from './config.mjs';
if(existsSync('.env'))process.loadEnvFile('.env');
const config=configFromEnv(),app=await createApp(config);
const port=Number(process.env.PORT||3000);
app.server.listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`Wilson Health 4.0.2 on port ${port}. Local server does not run a background scheduler; Vercel Cron is configured separately.`));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await app.close();process.exit(0);});
