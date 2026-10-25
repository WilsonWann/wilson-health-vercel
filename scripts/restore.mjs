import { readFileSync,existsSync } from 'node:fs';
import { openStore } from '../src/store.mjs';
import { configFromEnv } from '../src/config.mjs';
import { parseHealth,METRICS } from '../src/health.mjs';
if(existsSync('.env'))process.loadEnvFile('.env');
if(!process.argv[2])throw new Error('用法：node scripts/restore.mjs 私人備份.json；建議先停止服務並備份現有資料庫');
const backup=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(backup.version!==2||!Array.isArray(backup.rows))throw new Error('不是 2.0 的資料備份');
const units={step_count:'count',sleep_analysis:'hr',heart_rate:'bpm',resting_heart_rate:'bpm',active_energy:'kcal',apple_exercise_time:'min'};
const metrics=Object.keys(METRICS).map(name=>({name,units:units[name],data:backup.rows.filter(r=>r.metric===name).map(r=>({date:r.date,source:r.source,...(name==='sleep_analysis'?{totalSleep:r.value}:name==='heart_rate'?{Avg:r.value}:{qty:r.value})}))})).filter(m=>m.data.length);
if(backup.rows.some(r=>!Object.hasOwn(METRICS,r.metric)))throw new Error('備份包含不支援的指標');
const parsed=parseHealth({metrics});
const store=await openStore(configFromEnv());
try{console.log(await store.import(parsed));console.log('僅還原健康數據。LINE、登入、排程設定未變更；更新時間為此次還原時間。');}finally{store.close();}
