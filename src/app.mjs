import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash, timingSafeEqual, scryptSync } from 'node:crypto';
import { InputError,parseHealth,isDate,shiftDate,taipeiDate,taipeiParts,report,rawTotal,BODY_METRIC_NAMES } from './health.mjs';
import { openStore } from './store.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const eq=(a,b)=>typeof a==='string'&&typeof b==='string'&&timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)));
const SESSION_TTL=8*3600*1000;
const textFile=p=>readFileSync(fileURLToPath(new URL('../public/'+p,import.meta.url)));
const STATIC={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
export async function createApp(config,{fetcher=fetch,clock=()=>new Date(),client}={}) {
  if(typeof config.password!=='string'||config.password.length<16)throw new Error('ADMIN_PASSWORD 至少 16 字元');
  if(!/^[a-f0-9]{64}$/i.test(config.key||''))throw new Error('APP_KEY 需為 64 位十六進位字串');
  for(const k of ['ingestToken','cronToken'])if(typeof config[k]!=='string'||config[k].length<32)throw new Error(k+' 至少 32 字元');
  if(config.production && !/^https:\/\/[^/]+$/.test(config.origin||''))throw new Error('正式環境需設定 HTTPS APP_ORIGIN');
  const store=await openStore(config,{client});
  const passwordSalt=randomBytes(16); const passwordHash=scryptSync(config.password,passwordSalt,32);
  async function credentials(){const c=await store.credentials();if(!c)throw new InputError('請先儲存 LINE 設定',409);return c;}
  async function publicSettings(){
    const s=await store.settings(),c=await store.credentials();return {displayName:s.display_name,autoSend:!!s.auto_send,reportTime:s.report_time,lineConfigured:!!c,lineVerified:!!s.line_verified,userId:c?.userId||'',ingestPath:'/api/ingest',fixedReportTime:config.vercel?'09:00':null};
  }
  function origin(req){return config.origin || `http://${req.headers.host}`;}
  function checkOrigin(req){if(req.headers.origin && req.headers.origin!==origin(req))throw new InputError('拒絕跨站請求',403);}
  async function session(req){
    const value=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('wh2='))?.slice(4);
    if(!value)return null;
    const s=await store.db.prepare('SELECT * FROM sessions WHERE hash=? AND expires>?').get(hash(value),clock().getTime());return s||null;
  }
  async function requireSession(req,write=false){
    const s=await session(req);if(!s)throw new InputError('請先登入',401);
    if(write){checkOrigin(req);if(!eq(req.headers['x-csrf-token'],s.csrf))throw new InputError('驗證已過期，請重新登入',403);}return s;
  }
  async function jsonBody(req){
    if(!(req.headers['content-type']||'').startsWith('application/json'))throw new InputError('Content-Type 需為 application/json',415);
    // Vercel may already have parsed the request body; don't consume an empty stream twice.
    let supplied;try{supplied=req.body;}catch{throw new InputError('無效 JSON',400);}
    if(supplied!==undefined){
      let raw;try{raw=Buffer.isBuffer(supplied)?supplied.toString('utf8'):typeof supplied==='string'?supplied:JSON.stringify(supplied);}catch{throw new InputError('無效 JSON',400);}
      if(Buffer.byteLength(raw||'')>4*1024*1024)throw new InputError('JSON 超過 4 MB；請縮小匯出範圍或拆分指標',413);
      try{return JSON.parse(raw);}catch{throw new InputError('無效 JSON',400);}
    }
    let size=0;const chunks=[];
    for await(const c of req){size+=c.length;if(size>4*1024*1024)throw new InputError('JSON 超過 4 MB；請縮小匯出範圍或拆分指標',413);chunks.push(c);}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new InputError('無效 JSON',400);}
  }
  function result(res,status,value,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(value));}
  async function doImport(payload,{aggregation}={}){
    try{
      const parsed=parseHealth(payload);
      if(aggregation)parsed.aggregation=String(aggregation).slice(0,80);
      return await store.import(parsed,clock().toISOString());
    }
    catch(e){if(e instanceof InputError)await store.event('import_error',e.message,clock().toISOString());throw e;}
  }
  async function verifyLine(){
    const c=await credentials();let r;
    try { r=await fetcher('https://api.line.me/v2/bot/info',{headers:{Authorization:`Bearer ${c.token}`},signal:AbortSignal.timeout(12000)}); }
    catch {throw new InputError('LINE 連線失敗；請稍後再試',502);}
    if(!r.ok){await store.db.prepare('UPDATE settings SET line_verified=0 WHERE id=1').run();throw new InputError(`LINE 權杖驗證失敗（HTTP ${r.status}）`,502);}
    const info=await r.json();await store.db.prepare('UPDATE settings SET line_verified=1 WHERE id=1').run();
    await store.event('line_verified','權杖驗證通過；尚未驗證收件人是否收到訊息',clock().toISOString());
    return {ok:true,name:info.displayName||'LINE 官方帳號',message:'權杖有效；請按「傳送測試訊息」確認收件人。'};
  }
  async function sendMessage(id,text){
    const c=await credentials(),now=clock();
    const claim=await store.claimDelivery(id,text,c.userId,now);
    if(!claim.row)return claim;
    const row=claim.row;
    try {
      const r=await fetcher('https://api.line.me/v2/bot/message/push',{method:'POST',headers:{Authorization:`Bearer ${c.token}`,'Content-Type':'application/json','X-Line-Retry-Key':row.retry_key},body:row.payload,signal:AbortSignal.timeout(12000)});
      if(!r.ok && !(r.status===409&&r.headers.get('x-line-accepted-request-id')))throw new InputError(`LINE 尚未確認受理（HTTP ${r.status}）；不代表一定沒有送達`,502);
      await store.db.prepare("UPDATE deliveries SET status='accepted',error=NULL WHERE id=?").run(id);
      await store.event('line_accepted',`${id} 已由 LINE API 受理；不等於收件人已讀`,clock().toISOString());return {status:'accepted'};
    }catch(e){
      const message=e instanceof InputError?e.message:'LINE 網路異常；是否送達尚未確認，重試會沿用相同識別碼';
      await store.db.prepare("UPDATE deliveries SET status='failed',error=? WHERE id=?").run(message,id);await store.event('line_error',`${id}：${message}`,clock().toISOString());
      throw new InputError(message,502);
    }
  }
  async function rowsForReport(day){
    const dailyRows=await store.samples(day,day),present=new Set(dailyRows.map(r=>r.metric));
    const latest=await store.latestMetrics(BODY_METRIC_NAMES,day);
    return dailyRows.concat(latest.filter(r=>!present.has(r.metric)).map(r=>({...r,date:day,carried_from:r.date})));
  }
  async function daily(){
    const s=await store.settings(),now=clock(),date=shiftDate(taipeiDate(now),-1);
    if(!s.auto_send)return {status:'skipped',reason:'disabled',date};
    if(taipeiParts(now).slice(11,16)<s.report_time)return {status:'skipped',reason:'not_due',date};
    if(!s.line_verified)return {status:'skipped',reason:'line_not_verified',date};
    const rows=await store.samples(date,date);
    if(!rows.some(r=>r.metric==='step_count'))return {status:'skipped',reason:'missing_steps',date};
    return {...await sendMessage('daily:'+date,report(date,await rowsForReport(date),s.display_name)),date};
  }
  const handler=async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if(config.production)res.setHeader('Strict-Transport-Security','max-age=31536000');
    try {
      const url=new URL(req.url,'http://localhost');const path=url.pathname; const method=req.method;
      if(path==='/healthz'&&method==='GET')return result(res,200,{ok:true,version:'2.5.0-vercel'});
      if(path==='/api/login'&&method==='POST'){
        checkOrigin(req);const now=clock().getTime();
        const ip=config.vercel?(req.headers['x-vercel-forwarded-for']||req.socket.remoteAddress||'unknown'):(req.socket.remoteAddress||'unknown');
        const ipKey=hash(config.key+':'+String(ip).split(',')[0]);
        await store.consumeLoginAttempt(ipKey,now);
        const b=await jsonBody(req);const password=typeof b?.password==='string'?b.password:'';
        if(password.length>1024)throw new InputError('密碼過長',400);
        const ok=timingSafeEqual(scryptSync(password,passwordSalt,32),passwordHash);
        if(!ok)throw new InputError('密碼錯誤',401);
        await store.clearLoginAttempts(ipKey);await store.db.prepare('DELETE FROM sessions WHERE expires<?').run(now);
        const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');
        await store.db.prepare('INSERT INTO sessions(hash,csrf,expires) VALUES(?,?,?)').run(hash(token),csrf,now+SESSION_TTL);
        return result(res,200,{ok:true,csrf},{'Set-Cookie':`wh2=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${config.production?'; Secure':''}`});
      }
      if(path==='/api/session'&&method==='GET'){const s=await session(req);return result(res,200,s?{authenticated:true,csrf:s.csrf}:{authenticated:false});}
      if(path==='/api/logout'&&method==='POST'){const s=await requireSession(req,true);await store.db.prepare('DELETE FROM sessions WHERE hash=?').run(s.hash);return result(res,200,{ok:true},{'Set-Cookie':`wh2=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${config.production?'; Secure':''}`});}
      if(path==='/api/ingest'&&method==='POST'){
        if(!eq(req.headers.authorization,`Bearer ${config.ingestToken}`))throw new InputError('匯入金鑰錯誤',401);
        const aggregation=req.headers['automation-aggregation'];
        let payload;
        try{payload=await jsonBody(req);}catch(e){if(e instanceof InputError)await store.event('ingest_rejected',e.message,clock().toISOString());throw e;}
        return result(res,200,await doImport(payload,{aggregation}));
      }
      if(path==='/api/cron'&&method==='GET'){
        if(!eq(req.headers.authorization,`Bearer ${config.cronToken}`))throw new InputError('排程金鑰錯誤',401);
        const run=await daily();await store.event('cron',JSON.stringify(run),clock().toISOString());return result(res,200,run);
      }
      if(path==='/api/jobs/daily'){
        const cron=eq(req.headers.authorization,`Bearer ${config.cronToken}`);if(!cron)await requireSession(req,method==='POST');
        if(method==='POST'){await jsonBody(req);return result(res,200,await daily());}
        if(method==='GET')return result(res,200,{runs:await store.db.prepare('SELECT id,status,created_at,attempt_at,error FROM deliveries ORDER BY created_at DESC LIMIT 30').all()});
      }
      if(path.startsWith('/api/')){
        await requireSession(req,method!=='GET');
        if(path==='/api/state'&&method==='GET'){
          const to=url.searchParams.get('to')||taipeiDate(clock()),from=url.searchParams.get('from')||shiftDate(to,-6);
          if(!isDate(from)||!isDate(to)||from>to||Date.parse(to)-Date.parse(from)>365*86400000)throw new InputError('日期範圍需有效，且一次最多查詢 366 天');
          const rows=await store.samples(from,to),steps=rows.filter(r=>r.metric==='step_count'),bodyRows=await store.metricSamples(BODY_METRIC_NAMES,to);
          return result(res,200,{settings:await publicSettings(),rows,bodyRows,stepsTotal:rawTotal(steps.map(r=>r.value)),stepsDays:steps.length,events:await store.events(),today:taipeiDate(clock()),from,to});
        }
        if(path==='/api/import'&&method==='POST')return result(res,200,await doImport(await jsonBody(req)));
        if(path==='/api/backup'&&method==='GET')return result(res,200,{version:2,exportedAt:clock().toISOString(),rows:await store.samples()},{'Content-Disposition':'attachment; filename="health-v2-backup.json"'});
        if(path==='/api/report/preview'&&method==='GET'){
          const date=url.searchParams.get('date');return result(res,200,{text:report(date,await rowsForReport(date),(await store.settings()).display_name)});
        }
        if(path==='/api/settings'&&method==='POST'){
          const b=await jsonBody(req),old=await store.settings(),c=await store.credentials();if(!b||typeof b!=='object')throw new InputError('設定格式錯誤');
          const name=b.displayName??old.display_name,time=b.reportTime??old.report_time;let auto=b.autoSend??!!old.auto_send;
          if(typeof name!=='string'||!name.trim()||name.length>50||/[\r\n]/.test(name))throw new InputError('名稱需為 1–50 字元');
          if(typeof time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||typeof auto!=='boolean')throw new InputError('時間或開關格式錯誤');
          if(config.vercel&&time!=='09:00')throw new InputError('Vercel 排程由 vercel.json 設定；目前為台北 09:00');
          let cipher=old.credentials,verified=old.line_verified;
          if(b.lineToken || (b.userId&&b.userId!==c?.userId)){
            const token=(b.lineToken||c?.token||'').trim(),userId=(b.userId||c?.userId||'').trim();
            if(!/^U[0-9a-f]{32}$/.test(userId))throw new InputError('User ID 需為大寫 U 開頭的 33 字元識別碼，不是 @帳號');
            if(token.length<20||token.length>4096||/[\s\u0000-\u001f]/.test(token))throw new InputError('請貼上完整 Channel access token');
            cipher=store.encrypt({token,userId});verified=0;
          }
          if(auto && !verified){if(cipher!==old.credentials)auto=false;else throw new InputError('請先儲存並驗證 LINE，再啟用自動發送');}
          await store.db.prepare('UPDATE settings SET display_name=?,report_time=?,auto_send=?,credentials=?,line_verified=? WHERE id=1').run(name.trim(),time,auto?1:0,cipher,verified);
          await store.event('settings_saved','設定已儲存；沒有發送 LINE',clock().toISOString());return result(res,200,{ok:true,settings:await publicSettings()});
        }
        if(path==='/api/line/verify'&&method==='POST'){await jsonBody(req);return result(res,200,await verifyLine());}
        if(path==='/api/line/test'&&method==='POST'){
          const b=await jsonBody(req);if(b?.confirm!==true)throw new InputError('需要明確確認測試發送');
          const recent=await store.db.prepare("SELECT created_at FROM deliveries WHERE id LIKE 'test:%' ORDER BY created_at DESC LIMIT 1").get();
          if(recent&&clock().getTime()-Date.parse(recent.created_at)<60000)throw new InputError('測試訊息每分鐘最多一則',429);
          return result(res,200,await sendMessage('test:'+randomUUID(),'⌚ Wilson 健康日報 2.0\nLINE 連線測試成功。這則訊息不含健康資料。'));
        }
        if(path==='/api/report/send'&&method==='POST'){
          const b=await jsonBody(req);if(b?.confirm!==true||!isDate(b.date))throw new InputError('需要確認發送及有效日期');
          return result(res,200,await sendMessage('daily:'+b.date,report(b.date,await rowsForReport(b.date),(await store.settings()).display_name)));
        }
        throw new InputError('找不到 API',404);
      }
      if(method==='GET'&&Object.hasOwn(STATIC,path)) {const [file,type]=STATIC[path];res.writeHead(200,{'Content-Type':type});return res.end(textFile(file));}
      throw new InputError('找不到頁面',404);
    }catch(e){if(!res.headersSent)result(res,e instanceof InputError?e.status:500,{error:e instanceof InputError?e.message:'伺服器錯誤；未完成操作'});else res.end();}
  };
  const server=createServer(handler);
  server.requestTimeout=20000;server.headersTimeout=15000;
  return {server,handler,store,daily,sendMessage,verifyLine,close:async()=>{if(server.listening)await new Promise(r=>server.close(r));store.close();}};
}
