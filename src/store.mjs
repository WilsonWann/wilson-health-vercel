import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { InputError } from './health.mjs';
const schema=[
  `CREATE TABLE IF NOT EXISTS samples(date TEXT NOT NULL,metric TEXT NOT NULL,value REAL NOT NULL,source TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(date,metric)) STRICT`,
  `CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),display_name TEXT NOT NULL DEFAULT 'Wilson',auto_send INTEGER NOT NULL DEFAULT 0,report_time TEXT NOT NULL DEFAULT '09:00',line_verified INTEGER NOT NULL DEFAULT 0,credentials TEXT) STRICT`,
  `INSERT OR IGNORE INTO settings(id) VALUES(1)`,
  `CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL) STRICT`,
  `CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,retry_key TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,attempt_at TEXT NOT NULL,error TEXT) STRICT`,
  `CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,event TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL) STRICT`,
  `CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until_ms INTEGER NOT NULL) STRICT`
];
export async function openStore(config,{client}={}) {
  if(!client) {
    if(config.dbUrl) {
      const u=new URL(config.dbUrl);
      if(!['libsql:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('TURSO_DATABASE_URL 必須為 libsql:// 或 HTTPS 資料庫網址');
      if(!config.dbToken)throw new Error('缺少 TURSO_AUTH_TOKEN');
      const {createClient}=await import('@libsql/client/web');
      // Pure HTTP client: no local file, embedded replica, or ephemeral fallback.
      client=createClient({url:config.dbUrl,authToken:config.dbToken});
    } else {
      if(config.vercel)throw new Error('Vercel 必須設定 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN；不會退回本機檔案');
      const {localClient}=await import('./local-client.mjs');
      client=localClient(config.dbPath||'./data/health.sqlite');
    }
  }
  const store=new Store(client,config.key);await client.batch(schema,'write');return store;
}
export class Store {
  constructor(client,key) {
    this.client=client;this.key=Buffer.from(key,'hex');
    if(this.key.length!==32)throw new Error('APP_KEY 必須為 64 位十六進位字串');
    this.db={prepare:sql=>({
      get:async(...args)=>(await client.execute({sql,args})).rows[0],
      all:async(...args)=>(await client.execute({sql,args})).rows.map(r=>({...r})),
      run:async(...args)=>({changes:(await client.execute({sql,args})).rowsAffected})
    })};
  }
  close(){this.client.close();}
  async settings(){return this.db.prepare('SELECT * FROM settings WHERE id=1').get();}
  async credentials(){
    const value=(await this.settings()).credentials;if(!value)return null;
    const [iv,tag,body]=value.split('.').map(v=>Buffer.from(v,'base64'));
    const cipher=createDecipheriv('aes-256-gcm',this.key,iv);cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(body),cipher.final()]).toString('utf8'));
  }
  encrypt(value){
    const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);
    const body=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);
    return [iv,c.getAuthTag(),body].map(v=>v.toString('base64')).join('.');
  }
  async event(kind,message,at=new Date().toISOString()){
    await this.client.batch([
      {sql:'INSERT INTO events(event,message,created_at) VALUES(?,?,?)',args:[kind,message.slice(0,1200),at]},
      'DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 500)'
    ],'write');
  }
  async import(parsed,now=new Date().toISOString()){
    const sql=`INSERT INTO samples(date,metric,value,source,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(date,metric) DO UPDATE SET value=excluded.value,source=excluded.source,updated_at=excluded.updated_at
      WHERE samples.value != excluded.value OR samples.source IS NOT excluded.source`;
    const results=await this.client.batch(parsed.records.map(r=>({sql,args:[r.date,r.metric,r.value,r.source,now]})),'write');
    const changed=results.reduce((sum,r)=>sum+Number(r.rowsAffected),0);
    const result={received:parsed.records.length,changed,unchanged:parsed.records.length-changed,rejected:parsed.rejected||0,warnings:parsed.warnings,aggregation:parsed.aggregation||null};
    await this.event('import',JSON.stringify(result),now);return result;
  }
  async samples(from='0000-01-01',to='9999-12-31'){return this.db.prepare('SELECT * FROM samples WHERE date BETWEEN ? AND ? ORDER BY date,metric').all(from,to);}
  async metricSamples(metrics,to='9999-12-31'){
    if(!Array.isArray(metrics)||!metrics.length)return [];
    const marks=metrics.map(()=>'?').join(',');
    return this.db.prepare(`SELECT * FROM samples WHERE metric IN (${marks}) AND date<=? ORDER BY date,metric`).all(...metrics,to);
  }
  async latestMetrics(metrics,to='9999-12-31'){
    const rows=await this.metricSamples(metrics,to),latest=new Map();
    for(const row of rows)latest.set(row.metric,row);
    return [...latest.values()];
  }
  async events(){return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 40').all();}
  async consumeLoginAttempt(key,now){
    // Atomic and shared between serverless instances. Count every attempt before password work.
    await this.db.prepare('DELETE FROM login_attempts WHERE until_ms<?').run(now);
    const r=await this.client.execute({sql:`INSERT INTO login_attempts(key,count,until_ms) VALUES(?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=login_attempts.count+1 RETURNING count`,args:[key,now+600000]});
    if(Number(r.rows[0].count)>8)throw new InputError('嘗試過於頻繁，請 10 分鐘後再試',429);
  }
  async clearLoginAttempts(key){await this.db.prepare('DELETE FROM login_attempts WHERE key=?').run(key);}
  async claimDelivery(id,text,userId,now){
    const iso=now.toISOString();
    // A single conditional write obtains the lease across all Vercel instances.
    // Do not implement a transaction using separate pooled HTTP requests.
    const r=await this.client.execute({sql:`INSERT INTO deliveries(id,retry_key,payload,status,created_at,attempt_at)
      VALUES(?,?,?,'pending',?,?) ON CONFLICT(id) DO UPDATE SET status='pending',attempt_at=excluded.attempt_at,error=NULL
      WHERE deliveries.status!='accepted' AND deliveries.created_at>=?
        AND (deliveries.status!='pending' OR deliveries.attempt_at<=?)
        AND json_extract(deliveries.payload,'$.to')=? RETURNING *`,
      args:[id,randomUUID(),JSON.stringify({to:userId,messages:[{type:'text',text}]}),iso,iso,
      new Date(now.getTime()-23*3600000).toISOString(),new Date(now.getTime()-120000).toISOString(),userId]});
    if(r.rows.length)return {row:{...r.rows[0]}};
    const old=await this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id);
    if(old?.status==='accepted')return {status:'skipped',reason:'already_sent'};
    if(old&&now.getTime()-Date.parse(old.created_at)>23*3600000)throw new InputError('發送已超過安全重試期限，請確認 LINE；系統不會自動重發',409);
    if(old&&JSON.parse(old.payload).to!==userId)throw new InputError('收件人已變更，請先確認舊發送狀態；本次未發送',409);
    return {status:'skipped',reason:'in_progress'};
  }
}
