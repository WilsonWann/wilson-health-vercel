import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { InputError } from './health.mjs';
const schema=[
  `CREATE TABLE IF NOT EXISTS samples(date TEXT NOT NULL,metric TEXT NOT NULL,value REAL NOT NULL,source TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(date,metric)) STRICT`,
  `CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),display_name TEXT NOT NULL DEFAULT '',auto_send INTEGER NOT NULL DEFAULT 0,report_time TEXT NOT NULL DEFAULT '09:00',line_verified INTEGER NOT NULL DEFAULT 0,credentials TEXT) STRICT`,
  `INSERT OR IGNORE INTO settings(id) VALUES(1)`,
  `UPDATE settings SET display_name='' WHERE id=1 AND display_name='Wilson'`,
  `CREATE TABLE IF NOT EXISTS sessions_v2(hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL,role TEXT NOT NULL) STRICT`,
  `CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,retry_key TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,attempt_at TEXT NOT NULL,error TEXT) STRICT`,
  `CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,event TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL) STRICT`,
  `CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until_ms INTEGER NOT NULL) STRICT`,
  `CREATE TABLE IF NOT EXISTS line_link_challenges(state TEXT PRIMARY KEY,nonce TEXT NOT NULL,session_hash TEXT NOT NULL,status TEXT NOT NULL,user_id TEXT,display_name TEXT,friend_flag INTEGER,expires INTEGER NOT NULL,created_at TEXT NOT NULL,error TEXT) STRICT`,
  `CREATE TABLE IF NOT EXISTS account_line_bindings(account TEXT PRIMARY KEY,role TEXT NOT NULL,user_id TEXT NOT NULL UNIQUE,display_name TEXT,linked_at TEXT NOT NULL) STRICT`,
  `CREATE TABLE IF NOT EXISTS line_auth_challenges_v3(state TEXT PRIMARY KEY,nonce TEXT NOT NULL,purpose TEXT NOT NULL,session_hash TEXT,poll_hash TEXT NOT NULL,status TEXT NOT NULL,user_id TEXT,display_name TEXT,friend_flag INTEGER,account TEXT,role TEXT,expires INTEGER NOT NULL,created_at TEXT NOT NULL,error TEXT) STRICT`,
  `CREATE TABLE IF NOT EXISTS users_v4(id TEXT PRIMARY KEY,line_user_id TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL DEFAULT '',picture_url TEXT NOT NULL DEFAULT '',friend_flag INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL,updated_at TEXT NOT NULL) STRICT`,
  `CREATE TABLE IF NOT EXISTS user_ingest_tokens_v4(user_id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,token_cipher TEXT NOT NULL,created_at TEXT NOT NULL,rotated_at TEXT) STRICT`,
  `CREATE TABLE IF NOT EXISTS user_samples_v4(user_id TEXT NOT NULL,date TEXT NOT NULL,metric TEXT NOT NULL,value REAL NOT NULL,source TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,date,metric)) STRICT`,
  `CREATE TABLE IF NOT EXISTS user_report_settings_v4(user_id TEXT PRIMARY KEY,daily_enabled INTEGER NOT NULL DEFAULT 0,weekly_enabled INTEGER NOT NULL DEFAULT 0,daily_time TEXT NOT NULL DEFAULT '09:00',weekly_day INTEGER NOT NULL DEFAULT 1) STRICT`,
  `CREATE TABLE IF NOT EXISTS sessions_v4(hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL,role TEXT NOT NULL,user_id TEXT,username TEXT) STRICT`,
  `CREATE TABLE IF NOT EXISTS line_auth_challenges_v4(state TEXT PRIMARY KEY,nonce TEXT NOT NULL,purpose TEXT NOT NULL,poll_hash TEXT NOT NULL,status TEXT NOT NULL,expires INTEGER NOT NULL,created_at TEXT NOT NULL,line_user_id TEXT,internal_user_id TEXT,display_name TEXT,friend_flag INTEGER,role TEXT,error TEXT) STRICT`
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
  await client.batch(schema,'write');
  const store=new Store(client,config.key);return store;
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
  async accountLineBinding(account){return this.db.prepare('SELECT * FROM account_line_bindings WHERE account=?').get(account);}
  async accountLineBindingByUserId(userId){return this.db.prepare('SELECT * FROM account_line_bindings WHERE user_id=?').get(userId);}
  async bindLineAccount({account,role,userId,displayName,linkedAt}){
    await this.db.prepare(`INSERT INTO account_line_bindings(account,role,user_id,display_name,linked_at) VALUES(?,?,?,?,?)
      ON CONFLICT(account) DO UPDATE SET role=excluded.role,user_id=excluded.user_id,display_name=excluded.display_name,linked_at=excluded.linked_at`).run(account,role,userId,displayName||'',linkedAt);
  }
  async createLineAuthChallenge({state,nonce,purpose,sessionHash,pollHash,expires,createdAt}){
    await this.db.prepare('DELETE FROM line_auth_challenges_v3 WHERE expires<?').run(Date.parse(createdAt));
    if(sessionHash)await this.db.prepare(`DELETE FROM line_auth_challenges_v3 WHERE session_hash=? AND status='pending'`).run(sessionHash);
    await this.db.prepare(`INSERT INTO line_auth_challenges_v3(state,nonce,purpose,session_hash,poll_hash,status,expires,created_at)
      VALUES(?,?,?,?,?,'pending',?,?)`).run(state,nonce,purpose,sessionHash||null,pollHash,expires,createdAt);
  }
  async lineAuthChallenge(state){return this.db.prepare('SELECT * FROM line_auth_challenges_v3 WHERE state=?').get(state);}
  async completeLineAuthChallenge(state,{userId,displayName,friendFlag,account,role}){
    await this.db.prepare(`UPDATE line_auth_challenges_v3 SET status='complete',user_id=?,display_name=?,friend_flag=?,account=?,role=?,error=NULL WHERE state=?`)
      .run(userId,displayName||'',friendFlag==null?null:friendFlag?1:0,account||null,role||null,state);
  }
  async failLineAuthChallenge(state,message){await this.db.prepare(`UPDATE line_auth_challenges_v3 SET status='failed',error=? WHERE state=?`).run(String(message||'LINE 授權失敗').slice(0,400),state);}

  async createLineLinkChallenge({state,nonce,sessionHash,expires,createdAt}){
    await this.db.prepare(`DELETE FROM line_link_challenges WHERE expires<? OR (session_hash=? AND status='pending')`).run(Date.parse(createdAt),sessionHash);
    await this.db.prepare(`INSERT INTO line_link_challenges(state,nonce,session_hash,status,expires,created_at) VALUES(?,?,?,'pending',?,?)`).run(state,nonce,sessionHash,expires,createdAt);
  }
  async lineLinkChallenge(state){return this.db.prepare('SELECT * FROM line_link_challenges WHERE state=?').get(state);}
  async completeLineLink(state,{userId,displayName,friendFlag}){
    await this.db.prepare(`UPDATE line_link_challenges SET status='complete',user_id=?,display_name=?,friend_flag=?,error=NULL WHERE state=?`).run(userId,displayName||'',friendFlag==null?null:friendFlag?1:0,state);
  }
  async failLineLink(state,message){await this.db.prepare(`UPDATE line_link_challenges SET status='failed',error=? WHERE state=?`).run(String(message||'LINE 綁定失敗').slice(0,400),state);}
  async userById(id){return this.db.prepare('SELECT * FROM users_v4 WHERE id=?').get(id);}
  async userByLineId(lineUserId){return this.db.prepare('SELECT * FROM users_v4 WHERE line_user_id=?').get(lineUserId);}
  async upsertLineUser({lineUserId,displayName='',pictureUrl='',friendFlag=false,now=new Date().toISOString()}){
    let row=await this.userByLineId(lineUserId);
    if(row){
      await this.db.prepare(`UPDATE users_v4 SET display_name=?,picture_url=?,friend_flag=?,updated_at=? WHERE id=?`).run(displayName||row.display_name||'',pictureUrl||row.picture_url||'',friendFlag?1:0,now,row.id);
      row=await this.userById(row.id);
    }else{
      const id=randomUUID();
      await this.db.prepare(`INSERT INTO users_v4(id,line_user_id,display_name,picture_url,friend_flag,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)`).run(id,lineUserId,displayName||'',pictureUrl||'',friendFlag?1:0,now,now);
      await this.db.prepare(`INSERT OR IGNORE INTO user_report_settings_v4(user_id) VALUES(?)`).run(id);
      row=await this.userById(id);
    }
    await this.ensureUserIngestToken(row.id,now);
    return row;
  }
  async userReportSettings(userId){
    await this.db.prepare('INSERT OR IGNORE INTO user_report_settings_v4(user_id) VALUES(?)').run(userId);
    return this.db.prepare('SELECT * FROM user_report_settings_v4 WHERE user_id=?').get(userId);
  }
  async ensureUserIngestToken(userId,now=new Date().toISOString()){
    let row=await this.db.prepare('SELECT * FROM user_ingest_tokens_v4 WHERE user_id=?').get(userId);
    if(row){const decoded=this.decrypt(row.token_cipher);return {token:decoded.token,last4:decoded.token.slice(-4),createdAt:row.created_at,rotatedAt:row.rotated_at||null};}
    const token=randomBytes(32).toString('hex'),tokenHash=createHash('sha256').update(token).digest('hex'),cipher=this.encrypt({token});
    await this.db.prepare('INSERT INTO user_ingest_tokens_v4(user_id,token_hash,token_cipher,created_at) VALUES(?,?,?,?)').run(userId,tokenHash,cipher,now);
    return {token,last4:token.slice(-4),createdAt:now,rotatedAt:null};
  }
  async rotateUserIngestToken(userId,now=new Date().toISOString()){
    const token=randomBytes(32).toString('hex'),tokenHash=createHash('sha256').update(token).digest('hex'),cipher=this.encrypt({token});
    await this.db.prepare(`INSERT INTO user_ingest_tokens_v4(user_id,token_hash,token_cipher,created_at,rotated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,token_cipher=excluded.token_cipher,rotated_at=excluded.rotated_at`).run(userId,tokenHash,cipher,now,now);
    return {token,last4:token.slice(-4),createdAt:now,rotatedAt:now};
  }
  async userByIngestToken(token){
    if(typeof token!=='string'||token.length<32)return null;
    const tokenHash=createHash('sha256').update(token).digest('hex');
    return this.db.prepare(`SELECT u.* FROM user_ingest_tokens_v4 t JOIN users_v4 u ON u.id=t.user_id WHERE t.token_hash=? AND u.status='active'`).get(tokenHash);
  }
  decrypt(value){
    const [iv,tag,body]=String(value||'').split('.').map(v=>Buffer.from(v,'base64'));
    const cipher=createDecipheriv('aes-256-gcm',this.key,iv);cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(body),cipher.final()]).toString('utf8'));
  }
  async importUser(userId,parsed,now=new Date().toISOString()){
    const sql=`INSERT INTO user_samples_v4(user_id,date,metric,value,source,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,date,metric) DO UPDATE SET value=excluded.value,source=excluded.source,updated_at=excluded.updated_at
      WHERE user_samples_v4.value != excluded.value OR user_samples_v4.source IS NOT excluded.source`;
    const results=await this.client.batch(parsed.records.map(r=>({sql,args:[userId,r.date,r.metric,r.value,r.source,now]})),'write');
    const changed=results.reduce((sum,r)=>sum+Number(r.rowsAffected),0);
    return {received:parsed.records.length,changed,unchanged:parsed.records.length-changed,rejected:parsed.rejected||0,warnings:parsed.warnings,aggregation:parsed.aggregation||null};
  }
  async userSamples(userId,from='0000-01-01',to='9999-12-31'){return this.db.prepare('SELECT date,metric,value,source,updated_at FROM user_samples_v4 WHERE user_id=? AND date BETWEEN ? AND ? ORDER BY date,metric').all(userId,from,to);}
  async userMetricSamples(userId,metrics,to='9999-12-31'){
    if(!Array.isArray(metrics)||!metrics.length)return [];
    const marks=metrics.map(()=>'?').join(',');
    return this.db.prepare(`SELECT date,metric,value,source,updated_at FROM user_samples_v4 WHERE user_id=? AND metric IN (${marks}) AND date<=? ORDER BY date,metric`).all(userId,...metrics,to);
  }
  async userLatestMetrics(userId,metrics,to='9999-12-31'){
    const rows=await this.userMetricSamples(userId,metrics,to),latest=new Map();for(const row of rows)latest.set(row.metric,row);return [...latest.values()];
  }
  async copyLegacySamplesToUser(userId,now=new Date().toISOString()){
    const rows=await this.samples();if(!rows.length)return 0;
    const sql=`INSERT OR IGNORE INTO user_samples_v4(user_id,date,metric,value,source,updated_at) VALUES(?,?,?,?,?,?)`;
    const results=await this.client.batch(rows.map(r=>({sql,args:[userId,r.date,r.metric,r.value,r.source,r.updated_at||now]})),'write');
    return results.reduce((sum,r)=>sum+Number(r.rowsAffected),0);
  }
  async createLineUserChallenge({state,nonce,purpose='login',pollHash,expires,createdAt}){
    await this.db.prepare('DELETE FROM line_auth_challenges_v4 WHERE expires<?').run(Date.parse(createdAt));
    await this.db.prepare(`INSERT INTO line_auth_challenges_v4(state,nonce,purpose,poll_hash,status,expires,created_at) VALUES(?,?,?,?,'pending',?,?)`).run(state,nonce,purpose,pollHash,expires,createdAt);
  }
  async lineUserChallenge(state){return this.db.prepare('SELECT * FROM line_auth_challenges_v4 WHERE state=?').get(state);}
  async completeLineUserChallenge(state,{lineUserId,internalUserId,displayName,friendFlag,role='user'}){
    await this.db.prepare(`UPDATE line_auth_challenges_v4 SET status='complete',line_user_id=?,internal_user_id=?,display_name=?,friend_flag=?,role=?,error=NULL WHERE state=?`).run(lineUserId,internalUserId,displayName||'',friendFlag?1:0,role,state);
  }
  async failLineUserChallenge(state,message){await this.db.prepare(`UPDATE line_auth_challenges_v4 SET status='failed',error=? WHERE state=?`).run(String(message||'LINE 登入失敗').slice(0,400),state);}

  async credentials(){
    const value=(await this.settings()).credentials;if(!value)return null;
    return this.decrypt(value);
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
  async eventsPage(page=1,pageSize=10){
    const safePage=Math.max(1,Number(page)||1),safeSize=Math.min(50,Math.max(1,Number(pageSize)||10));
    const count=await this.db.prepare('SELECT COUNT(*) AS total FROM events').get();
    const total=Number(count?.total||0),totalPages=Math.max(1,Math.ceil(total/safeSize)),current=Math.min(safePage,totalPages),offset=(current-1)*safeSize;
    const items=await this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ? OFFSET ?').all(safeSize,offset);
    return {items,page:current,pageSize:safeSize,total,totalPages};
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
