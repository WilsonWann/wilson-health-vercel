import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash, timingSafeEqual, scryptSync } from 'node:crypto';
import { InputError,parseHealth,isDate,shiftDate,taipeiDate,taipeiParts,report,rawTotal,BODY_METRIC_NAMES } from './health.mjs';
import { openStore } from './store.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const eq=(a,b)=>typeof a==='string'&&typeof b==='string'&&timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)));
const SESSION_TTL=8*3600*1000;
const LINE_LINK_TTL=5*60*1000;
const textFile=p=>readFileSync(fileURLToPath(new URL('../public/'+p,import.meta.url)));
const STATIC={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};

const USERNAME_RE=/^[A-Za-z0-9._-]{3,50}$/;
function mockRows(from,to,updatedAt){
  const patterns={
    step_count:[6420.4,7811.8,5230.2,9044.7,6888.3,8125.9,7355.6],
    sleep_analysis:[7.42,7.88,6.95,8.14,7.63,7.27,8.02],
    heart_rate:[71.4,72.8,70.6,73.1,69.9,71.7,70.8],
    resting_heart_rate:[60,61,59,62,58,60,59],
    active_energy:[448.2,512.6,391.4,584.7,463.1,531.5,489.8],
    apple_exercise_time:[28,36,19,47,31,42,34],
    height:[168,168,168,168,168,168,168],
    'weight_&_body_mass':[63.5,63.4,63.6,63.3,63.2,63.4,63.2],
    body_mass_index:[22.5,22.5,22.5,22.4,22.4,22.5,22.4]
  };
  const rows=[];let i=0;
  for(let d=from;d<=to&&i<366;d=shiftDate(d,1),i++){
    for(const [metric,values] of Object.entries(patterns))rows.push({date:d,metric,value:values[i%values.length],source:'Mock Data',updated_at:updatedAt});
  }
  return rows;
}
function mockState(from,to,now,config){
  const rows=mockRows(from,to,now.toISOString()),steps=rows.filter(r=>r.metric==='step_count');
  return {role:'guest',mock:true,settings:{displayName:'Guest Demo',autoSend:false,reportTime:'09:00',lineConfigured:false,lineVerified:false,userId:'',ingestPath:'',fixedReportTime:config.vercel?'09:00':null},rows,bodyRows:rows.filter(r=>BODY_METRIC_NAMES.includes(r.metric)),stepsTotal:rawTotal(steps.map(r=>r.value)),stepsDays:steps.length,events:[],today:taipeiDate(now),from,to};
}
export async function createApp(config,{fetcher=fetch,clock=()=>new Date(),client}={}) {
  const adminUsername=String(config.adminUsername||'admin').trim(),guestUsername=String(config.guestUsername||'guest').trim();
  if(!USERNAME_RE.test(adminUsername))throw new Error('ADMIN_USERNAME 需為 3–50 個英數、點、底線或連字號');
  if(!USERNAME_RE.test(guestUsername))throw new Error('GUEST_USERNAME 需為 3–50 個英數、點、底線或連字號');
  if(adminUsername.toLowerCase()===guestUsername.toLowerCase())throw new Error('管理者與 Guest 帳號不得相同');
  if(typeof config.password!=='string'||config.password.length<16)throw new Error('ADMIN_PASSWORD 至少 16 字元');
  if(!/^[a-f0-9]{64}$/i.test(config.key||''))throw new Error('APP_KEY 需為 64 位十六進位字串');
  if(config.lineChannelAccessToken&&(config.lineChannelAccessToken.length<20||/[\s\u0000-\u001f]/.test(config.lineChannelAccessToken)))throw new Error('LINE_CHANNEL_ACCESS_TOKEN 格式錯誤');
  for(const k of ['ingestToken','cronToken'])if(typeof config[k]!=='string'||config[k].length<32)throw new Error(k+' 至少 32 字元');
  if(config.production && !/^https:\/\/[^/]+$/.test(config.origin||''))throw new Error('正式環境需設定 HTTPS APP_ORIGIN');
  const store=await openStore(config,{client});
  const adminSalt=randomBytes(16),guestSalt=randomBytes(16),adminHash=scryptSync(config.password,adminSalt,32),guestHash=scryptSync(config.guestPassword??'',guestSalt,32);
  const maskUserId=id=>/^U[0-9a-f]{32}$/.test(id||'')?`${id.slice(0,6)}…${id.slice(-4)}`:'';
  async function lineContext(){
    const legacy=await store.credentials(),binding=await store.accountLineBinding(adminUsername);
    return {token:(config.lineChannelAccessToken||legacy?.token||'').trim(),userId:binding?.user_id||legacy?.userId||'',displayName:binding?.display_name||''};
  }
  async function credentials(){const c=await lineContext();if(!c.token)throw new InputError('請先在環境變數設定 LINE_CHANNEL_ACCESS_TOKEN',409);return c;}
  async function publicSettings(){
    const s=await store.settings(),c=await lineContext();return {displayName:s.display_name,autoSend:!!s.auto_send,reportTime:s.report_time,lineConfigured:!!c.token,lineVerified:!!s.line_verified,userId:c.userId||'',maskedUserId:maskUserId(c.userId),recipientConfigured:/^U[0-9a-f]{32}$/.test(c.userId||''),lineLoginConfigured:!!(config.lineLoginChannelId&&config.lineLoginChannelSecret),lineTokenFromEnv:!!config.lineChannelAccessToken,ingestPath:'/api/ingest',fixedReportTime:config.vercel?'09:00':null};
  }
  function origin(req){return config.origin || `http://${req.headers.host}`;}
  function checkOrigin(req){if(req.headers.origin && req.headers.origin!==origin(req))throw new InputError('拒絕跨站請求',403);}
  async function session(req){
    const value=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('wh2='))?.slice(4);
    if(!value)return null;
    const s=await store.db.prepare('SELECT * FROM sessions_v2 WHERE hash=? AND expires>?').get(hash(value),clock().getTime());return s||null;
  }
  async function requireSession(req,write=false){
    const s=await session(req);if(!s)throw new InputError('請先登入',401);
    if(write){checkOrigin(req);if(!eq(req.headers['x-csrf-token'],s.csrf))throw new InputError('驗證已過期，請重新登入',403);}return s;
  }
  async function requireAdminSession(req,write=false){const s=await requireSession(req,write);if(s.role!=='admin')throw new InputError('Guest 為唯讀展示模式，無權執行此操作',403);return s;}
  async function issueSession(role){
    const now=clock().getTime(),token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');
    await store.db.prepare('DELETE FROM sessions_v2 WHERE expires<?').run(now);
    await store.db.prepare('INSERT INTO sessions_v2(hash,csrf,expires,role) VALUES(?,?,?,?)').run(hash(token),csrf,now+SESSION_TTL,role);
    return {token,csrf,role,username:role==='guest'?guestUsername:adminUsername};
  }
  const sessionCookie=token=>`wh2=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${config.production?'; Secure':''}`;
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
  function lineLoginReady(){return /^\d{5,30}$/.test(String(config.lineLoginChannelId||''))&&typeof config.lineLoginChannelSecret==='string'&&config.lineLoginChannelSecret.length>=16;}
  function callbackUrl(req){return origin(req)+'/api/line/auth/callback';}
  async function lineForm(url,params){
    let r;try{r=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params),signal:AbortSignal.timeout(12000)});}catch{throw new InputError('LINE Login 連線失敗；請稍後再試',502);}
    let body={};try{body=await r.json();}catch{}
    if(!r.ok)throw new InputError(`LINE Login 驗證失敗（HTTP ${r.status}）`,502);return body;
  }
  async function startLineAuth(req,{purpose,sessionHash=null}={}){
    if(!lineLoginReady())throw new InputError('請先設定 LINE_LOGIN_CHANNEL_ID / LINE_LOGIN_CHANNEL_SECRET',409);
    if(!['login','bind'].includes(purpose))throw new InputError('LINE Login 用途錯誤',400);
    const state=randomBytes(24).toString('hex'),nonce=randomBytes(24).toString('hex'),now=clock(),expires=now.getTime()+LINE_LINK_TTL,redirect=callbackUrl(req);
    // line_auth_challenges_v3 retains poll_hash for backward-compatible schema, but 3.0.2 no longer polls.
    const unusedPollHash=hash(randomBytes(32).toString('hex'));
    await store.createLineAuthChallenge({state,nonce,purpose,sessionHash,pollHash:unusedPollHash,expires,createdAt:now.toISOString()});
    const q=new URLSearchParams({
      response_type:'code',client_id:String(config.lineLoginChannelId),redirect_uri:redirect,state,scope:'openid profile',nonce,
      bot_prompt:'normal',initial_amr_display:'lineqr',switch_amr:'false',disable_auto_login:'true',ui_locales:'zh-TW'
    });
    return {state,authorizeUrl:'https://access.line.me/oauth2/v2.1/authorize?'+q.toString(),expiresAt:new Date(expires).toISOString()};
  }
  async function finishLineAuth(req,url,res){
    const state=url.searchParams.get('state')||'',code=url.searchParams.get('code')||'',oauthError=url.searchParams.get('error');
    const challenge=await store.lineAuthChallenge(state);
    const isBind=challenge?.purpose==='bind';
    const redirectHome=(query,headers={})=>{const location='/?'+new URLSearchParams(query).toString()+(isBind?'#line':'');res.writeHead(302,{Location:location,'Cache-Control':'no-store',...headers});res.end();};
    if(!challenge||challenge.status!=='pending'||challenge.expires<=clock().getTime())return redirectHome({line:'expired'});
    if(oauthError||!code){await store.failLineAuthChallenge(state,'使用者取消或 LINE 未回傳授權碼');return redirectHome({line:'cancelled'});}
    try{
      const redirect=callbackUrl(req);
      const token=await lineForm('https://api.line.me/oauth2/v2.1/token',{grant_type:'authorization_code',code,redirect_uri:redirect,client_id:String(config.lineLoginChannelId),client_secret:config.lineLoginChannelSecret});
      if(!token.id_token||!token.access_token)throw new InputError('LINE Login 沒有回傳必要憑證',502);
      const verified=await lineForm('https://api.line.me/oauth2/v2.1/verify',{id_token:token.id_token,client_id:String(config.lineLoginChannelId),nonce:challenge.nonce});
      const userId=verified.sub||'';if(!/^U[0-9a-f]{32}$/.test(userId))throw new InputError('LINE Login 沒有回傳有效 User ID',502);
      let friendFlag=null;try{const fr=await fetcher('https://api.line.me/friendship/v1/status',{headers:{Authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(12000)});if(fr.ok)friendFlag=!!(await fr.json()).friendFlag;}catch{}
      if(isBind){
        const auth=challenge.session_hash?await store.db.prepare('SELECT * FROM sessions_v2 WHERE hash=? AND expires>?').get(challenge.session_hash,clock().getTime()):null;
        if(!auth||auth.role!=='admin')throw new InputError('原登入工作階段已失效，請重新以管理者帳密登入後再綁定',401);
        await store.bindLineAccount({account:adminUsername,role:'admin',userId,displayName:verified.name||'',linkedAt:clock().toISOString()});
        await store.completeLineAuthChallenge(state,{userId,displayName:verified.name||'',friendFlag,account:adminUsername,role:'admin'});
        await store.event('line_account_bound',`${verified.name||'LINE 使用者'} · ${maskUserId(userId)}${friendFlag===false?' · 尚未確認為官方帳號好友':''}`,clock().toISOString());
        return redirectHome({line:friendFlag===false?'bound-no-friend':'bound'});
      }
      const binding=await store.accountLineBindingByUserId(userId);
      if(!binding){await store.failLineAuthChallenge(state,'此 LINE 帳號尚未綁定帳號');return redirectHome({line:'unbound'});}
      await store.completeLineAuthChallenge(state,{userId,displayName:verified.name||binding.display_name||'',friendFlag,account:binding.account,role:binding.role});
      await store.event('line_login_authorized',`${verified.name||binding.display_name||'LINE 使用者'} · ${binding.account}`,clock().toISOString());
      const issued=await issueSession(binding.role||'admin');
      await store.db.prepare("UPDATE line_auth_challenges_v3 SET status='consumed' WHERE state=?").run(state);
      return redirectHome({line:'login-ok'},{'Set-Cookie':sessionCookie(issued.token)});
    }catch(e){
      await store.failLineAuthChallenge(state,e instanceof Error?e.message:String(e));
      return redirectHome({line:isBind?'bind-failed':'login-failed'});
    }
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
    const c=await credentials(),now=clock();if(!/^U[0-9a-f]{32}$/.test(c.userId||''))throw new InputError('請先使用 LINE QR Code 綁定日報收件人',409);
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
    const recipient=await lineContext();if(!/^U[0-9a-f]{32}$/.test(recipient?.userId||''))return {status:'skipped',reason:'line_recipient_not_linked',date};
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
      if(path==='/healthz'&&method==='GET')return result(res,200,{ok:true,version:'3.0.2-vercel'});
      if(path==='/api/login'&&method==='POST'){
        checkOrigin(req);const now=clock().getTime();
        const ip=config.vercel?(req.headers['x-vercel-forwarded-for']||req.socket.remoteAddress||'unknown'):(req.socket.remoteAddress||'unknown');
        const ipKey=hash(config.key+':'+String(ip).split(',')[0]);
        await store.consumeLoginAttempt(ipKey,now);
        const b=await jsonBody(req),username=typeof b?.username==='string'?b.username.trim():'',password=typeof b?.password==='string'?b.password:'';
        if(username.length>100||password.length>1024)throw new InputError('帳號或密碼格式錯誤',400);
        const adminPass=timingSafeEqual(scryptSync(password,adminSalt,32),adminHash),guestPass=timingSafeEqual(scryptSync(password,guestSalt,32),guestHash);
        const role=username.toLowerCase()===adminUsername.toLowerCase()&&adminPass?'admin':username.toLowerCase()===guestUsername.toLowerCase()&&guestPass?'guest':null;
        if(!role)throw new InputError('帳號或密碼錯誤',401);
        await store.clearLoginAttempts(ipKey);const issued=await issueSession(role);
        return result(res,200,{ok:true,csrf:issued.csrf,role:issued.role,username:issued.username},{'Set-Cookie':sessionCookie(issued.token)});
      }
      if(path==='/api/line/login/start'&&method==='POST'){
        checkOrigin(req);await jsonBody(req);return result(res,200,await startLineAuth(req,{purpose:'login'}));
      }
      if(path==='/api/session'&&method==='GET'){const s=await session(req);return result(res,200,s?{authenticated:true,csrf:s.csrf,role:s.role||'admin',username:(s.role||'admin')==='guest'?guestUsername:adminUsername}:{authenticated:false});}
      if(path==='/api/logout'&&method==='POST'){const s=await requireSession(req,true);await store.db.prepare('DELETE FROM sessions_v2 WHERE hash=?').run(s.hash);return result(res,200,{ok:true},{'Set-Cookie':`wh2=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${config.production?'; Secure':''}`});}
      if((path==='/api/line/auth/callback'||path==='/api/line/link/callback')&&method==='GET')return await finishLineAuth(req,url,res);
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
        const cron=eq(req.headers.authorization,`Bearer ${config.cronToken}`);if(!cron)await requireAdminSession(req,method==='POST');
        if(method==='POST'){await jsonBody(req);return result(res,200,await daily());}
        if(method==='GET')return result(res,200,{runs:await store.db.prepare('SELECT id,status,created_at,attempt_at,error FROM deliveries ORDER BY created_at DESC LIMIT 30').all()});
      }
      if(path.startsWith('/api/')){
        const auth=await requireSession(req,method!=='GET');
        if((path==='/api/line/bind/start'||path==='/api/line/link/start')&&method==='POST'){if((auth.role||'admin')!=='admin')throw new InputError('Guest 為唯讀展示模式，無權綁定 LINE',403);await jsonBody(req);return result(res,200,await startLineAuth(req,{purpose:'bind',sessionHash:auth.hash}));}
        if(path==='/api/state'&&method==='GET'){
          const to=url.searchParams.get('to')||taipeiDate(clock()),from=url.searchParams.get('from')||shiftDate(to,-6);
          if(!isDate(from)||!isDate(to)||from>to||Date.parse(to)-Date.parse(from)>365*86400000)throw new InputError('日期範圍需有效，且一次最多查詢 366 天');
          if((auth.role||'admin')==='guest')return result(res,200,mockState(from,to,clock(),config));
          const rows=await store.samples(from,to),steps=rows.filter(r=>r.metric==='step_count'),bodyRows=await store.metricSamples(BODY_METRIC_NAMES,to);
          return result(res,200,{role:'admin',mock:false,settings:await publicSettings(),rows,bodyRows,stepsTotal:rawTotal(steps.map(r=>r.value)),stepsDays:steps.length,events:await store.events(),today:taipeiDate(clock()),from,to});
        }
        if(path==='/api/report/preview'&&method==='GET'){
          const date=url.searchParams.get('date');if(!isDate(date))throw new InputError('日期格式錯誤');
          if((auth.role||'admin')==='guest'){const rows=mockRows(date,date,clock().toISOString());return result(res,200,{text:report(date,rows,'Guest Demo'),mock:true});}
          return result(res,200,{text:report(date,await rowsForReport(date),(await store.settings()).display_name)});
        }
        if((auth.role||'admin')!=='admin')throw new InputError('Guest 為唯讀展示模式，無權存取私人功能',403);
        if(path==='/api/import'&&method==='POST')return result(res,200,await doImport(await jsonBody(req)));
        if(path==='/api/backup'&&method==='GET')return result(res,200,{version:2,exportedAt:clock().toISOString(),rows:await store.samples()},{'Content-Disposition':'attachment; filename="health-v2-backup.json"'});
        if(path==='/api/settings'&&method==='POST'){
          const b=await jsonBody(req),old=await store.settings();if(!b||typeof b!=='object')throw new InputError('設定格式錯誤');
          const name=b.displayName??old.display_name,time=b.reportTime??old.report_time;let auto=b.autoSend??!!old.auto_send;
          if(typeof name!=='string'||!name.trim()||name.length>50||/[\r\n]/.test(name))throw new InputError('名稱需為 1–50 字元');
          if(typeof time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||typeof auto!=='boolean')throw new InputError('時間或開關格式錯誤');
          if(config.vercel&&time!=='09:00')throw new InputError('Vercel 排程由 vercel.json 設定；目前為台北 09:00');
          // Backward-compatible migration path: API can still accept legacy token/User ID, but the 3.0 UI never exposes these fields.
          if(b.lineToken||Object.hasOwn(b,'userId')){const legacy=await store.credentials();const token=String(b.lineToken||legacy?.token||'').trim(),userId=String(Object.hasOwn(b,'userId')?b.userId:legacy?.userId||'').trim();if(token.length<20||/[\s\u0000-\u001f]/.test(token))throw new InputError('LINE Token 格式錯誤');if(userId&&!/^U[0-9a-f]{32}$/.test(userId))throw new InputError('User ID 格式錯誤');await store.db.prepare('UPDATE settings SET credentials=?,line_verified=? WHERE id=1').run(store.encrypt({token,userId}),b.lineToken?0:old.line_verified);}
          const c=await lineContext(),current=await store.settings();if(auto&&(!current.line_verified||!c.token||!/^U[0-9a-f]{32}$/.test(c.userId||'')))throw new InputError('請先設定並驗證 LINE_CHANNEL_ACCESS_TOKEN，並使用 LINE Login QR Code 綁定收件人');
          await store.db.prepare('UPDATE settings SET display_name=?,report_time=?,auto_send=? WHERE id=1').run(name.trim(),time,auto?1:0);
          await store.event('settings_saved','設定已儲存；沒有發送 LINE',clock().toISOString());return result(res,200,{ok:true,settings:await publicSettings()});
        }
        if(path==='/api/line/verify'&&method==='POST'){await jsonBody(req);return result(res,200,await verifyLine());}
        if(path==='/api/line/test'&&method==='POST'){
          const b=await jsonBody(req);if(b?.confirm!==true)throw new InputError('需要明確確認測試發送');
          const recent=await store.db.prepare("SELECT created_at FROM deliveries WHERE id LIKE 'test:%' ORDER BY created_at DESC LIMIT 1").get();
          if(recent&&clock().getTime()-Date.parse(recent.created_at)<60000)throw new InputError('測試訊息每分鐘最多一則',429);
          return result(res,200,await sendMessage('test:'+randomUUID(),'⌚ Wilson 健康日報 3.0.2\nLINE 連線測試成功。這則訊息不含健康資料。'));
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
