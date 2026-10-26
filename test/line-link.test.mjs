import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';

const config={
  password:'admin-link-password-12345',adminUsername:'admin',guestUsername:'guest',guestPassword:'',
  key:'e'.repeat(64),ingestToken:'i'.repeat(40),cronToken:'c'.repeat(40),dbPath:':memory:',production:false,origin:'',
  lineLoginChannelId:'1234567890',lineLoginChannelSecret:'line-login-secret-fixture-123456',
  lineChannelAccessToken:'channel-access-token-fixture-12345'
};

function mockLineFetcher(calls){return async(url,opts={})=>{
  calls.push({url,opts});
  if(url==='https://api.line.me/oauth2/v2.1/token')return new Response(JSON.stringify({access_token:'user-access-token',id_token:'mock-id-token'}),{status:200,headers:{'content-type':'application/json'}});
  if(url==='https://api.line.me/oauth2/v2.1/verify'){
    const body=new URLSearchParams(String(opts.body));
    return new Response(JSON.stringify({sub:'U'+'b'.repeat(32),name:'QR User',nonce:body.get('nonce'),amr:['lineqr']}),{status:200,headers:{'content-type':'application/json'}});
  }
  if(url==='https://api.line.me/friendship/v1/status')return new Response(JSON.stringify({friendFlag:true}),{status:200,headers:{'content-type':'application/json'}});
  if(url==='https://api.line.me/v2/bot/info')return new Response(JSON.stringify({displayName:'Health Bot'}),{status:200,headers:{'content-type':'application/json'}});
  if(url==='https://api.line.me/v2/bot/profile/U'+'b'.repeat(32))return new Response(JSON.stringify({displayName:'QR User'}),{status:200,headers:{'content-type':'application/json'}});
  if(url==='https://api.line.me/v2/bot/message/push')return new Response('{}',{status:200,headers:{'content-type':'application/json'}});
  return new Response('{}',{status:404,headers:{'content-type':'application/json'}});
};}

async function boot(t,overrides={}){
  const calls=[],app=await createApp({...config,...overrides},{fetcher:mockLineFetcher(calls),clock:()=>new Date('2026-10-25T08:00:00Z')});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());
  return {app,calls,base:'http://127.0.0.1:'+app.server.address().port};
}

test('admin can bind a report recipient while LINE QR login creates a normal user session',async t=>{
  const {app,calls,base}=await boot(t);let cookie='',csrf='';
  async function req(path,{method='GET',body,auth=true,cookieOverride}={}){
    const useCookie=cookieOverride!==undefined?cookieOverride:cookie;
    const headers={...(auth&&useCookie?{Cookie:useCookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json',Origin:base,...(auth&&csrf?{'X-CSRF-Token':csrf}:{})})};
    const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
    const type=r.headers.get('content-type')||'';const value=type.includes('json')?await r.json():await r.text();return {r,body:value};
  }
  const login=await req('/api/login',{method:'POST',body:{username:'admin',password:config.password}});cookie=login.r.headers.get('set-cookie').split(';')[0];csrf=login.body.csrf;
  const stateBefore=await req('/api/state?from=2026-10-25&to=2026-10-25');assert.equal(stateBefore.body.settings.lineConfigured,true);assert.equal(stateBefore.body.settings.recipientConfigured,false);assert.equal(stateBefore.body.settings.lineTokenFromEnv,true);

  const start=await req('/api/line/bind/start',{method:'POST',body:{}});assert.equal(start.r.status,200);assert.match(start.body.authorizeUrl,/^https:\/\/access\.line\.me\//);
  const authorize=new URL(start.body.authorizeUrl);assert.equal(authorize.origin,'https://access.line.me');assert.equal(authorize.searchParams.get('client_id'),config.lineLoginChannelId);assert.equal(authorize.searchParams.get('scope'),'openid profile');assert.equal(authorize.searchParams.get('bot_prompt'),'aggressive');assert.equal(authorize.searchParams.get('state'),start.body.state);
  const callback=await req('/api/line/auth/callback?code=auth-code&state='+start.body.state,{auth:false});assert.equal(callback.r.status,200);assert.match(callback.body,/LINE 綁定完成/);assert.match(callback.body,/成功送出一則綁定測試訊息/);
  const status=await req('/api/line/bind/status?state='+start.body.state);assert.equal(status.body.status,'complete');assert.equal(status.body.displayName,'QR User');assert.equal(status.body.friendFlag,true);assert.match(status.body.userId,/^Ubbbbb…bbbb$/);
  const binding=await app.store.accountLineBinding('admin');assert.equal(binding.user_id,'U'+'b'.repeat(32));assert.equal(binding.role,'admin');
  const state=await req('/api/state?from=2026-10-25&to=2026-10-25');assert.equal(state.body.settings.recipientConfigured,true);assert.match(state.body.settings.maskedUserId,/^Ubbbbb…bbbb$/);

  // New browser: LINE QR login authenticates the LINE user as a normal member, never as admin.
  cookie='';csrf='';
  const lineStart=await req('/api/line/login/start',{method:'POST',body:{},auth:false});assert.equal(lineStart.r.status,200);assert.match(lineStart.body.authorizeUrl,/^https:\/\/access\.line\.me\//);
  const loginCallback=await req('/api/line/auth/callback?code=auth-code-2&state='+lineStart.body.state,{auth:false});assert.equal(loginCallback.r.status,200);assert.match(loginCallback.body,/LINE Login 已驗證/);
  const poll=await req('/api/line/login/status',{method:'POST',body:{state:lineStart.body.state,pollToken:lineStart.body.pollToken},auth:false});assert.equal(poll.r.status,200);assert.equal(poll.body.status,'complete');assert.equal(poll.body.role,'user');assert.equal(poll.body.username,'QR User');
  const lineCookie=poll.r.headers.get('set-cookie').split(';')[0];const session=await req('/api/session',{auth:true,cookieOverride:lineCookie});assert.equal(session.body.authenticated,true);assert.equal(session.body.role,'user');assert.ok(session.body.userId);
  assert.ok(calls.some(c=>c.url==='https://api.line.me/oauth2/v2.1/token'));assert.ok(calls.some(c=>c.url==='https://api.line.me/oauth2/v2.1/verify'));assert.ok(calls.some(c=>c.url.includes('/v2/bot/profile/')));assert.ok(calls.some(c=>c.url==='https://api.line.me/v2/bot/message/push'));
});

test('first LINE QR login auto-registers a member and creates a personal ingest token',async t=>{
  const calls=[];
  const fetcher=async(url,opts={})=>{
    calls.push({url,opts});
    if(url==='https://api.line.me/oauth2/v2.1/token')return new Response(JSON.stringify({access_token:'u-access',id_token:'u-id'}),{status:200,headers:{'content-type':'application/json'}});
    if(url==='https://api.line.me/oauth2/v2.1/verify')return new Response(JSON.stringify({sub:'U'+'d'.repeat(32),name:'New Member',amr:['lineqr']}),{status:200,headers:{'content-type':'application/json'}});
    if(url==='https://api.line.me/friendship/v1/status')return new Response(JSON.stringify({friendFlag:true}),{status:200,headers:{'content-type':'application/json'}});
    return new Response('{}',{status:404,headers:{'content-type':'application/json'}});
  };
  const app=await createApp(config,{fetcher,clock:()=>new Date('2026-10-25T08:00:00Z')});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());
  const base='http://127.0.0.1:'+app.server.address().port,headers={'Content-Type':'application/json',Origin:base};
  let r=await fetch(base+'/api/line/login/start',{method:'POST',headers,body:'{}'});const started=await r.json();assert.equal(r.status,200);
  const authUrl=new URL(started.authorizeUrl);assert.equal(authUrl.searchParams.get('initial_amr_display'),'lineqr');assert.equal(authUrl.searchParams.get('switch_amr'),'false');assert.equal(authUrl.searchParams.get('disable_auto_login'),'true');
  r=await fetch(base+'/api/line/auth/callback?code=auth-code&state='+started.state,{redirect:'manual'});assert.equal(r.status,200);assert.match(await r.text(),/後端驗證/);
  r=await fetch(base+'/api/line/login/status',{method:'POST',headers,body:JSON.stringify({state:started.state,pollToken:started.pollToken})});const status=await r.json();assert.equal(status.status,'complete');assert.equal(status.role,'user');assert.equal(status.username,'New Member');
  const cookie=r.headers.get('set-cookie').split(';')[0];
  r=await fetch(base+'/api/session',{headers:{Cookie:cookie}});const session=await r.json();assert.equal(session.role,'user');assert.ok(session.userId);
  r=await fetch(base+'/api/me/sync-config',{headers:{Cookie:cookie}});const sync=await r.json();assert.equal(r.status,200);assert.match(sync.ingestToken,/^[0-9a-f]{64}$/);assert.match(sync.ingestUrl,/\/api\/ingest$/);
  const user=await app.store.userByLineId('U'+'d'.repeat(32));assert.equal(user.display_name,'New Member');
});

test('LINE QR is unavailable without LINE Login channel configuration',async t=>{
  const {base}=await boot(t,{lineLoginChannelId:'',lineLoginChannelSecret:''});
  const r=await fetch(base+'/api/line/login/start',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:'{}'});assert.equal(r.status,409);assert.match((await r.json()).error,/LINE_LOGIN_CHANNEL_ID/);
});


test('LINE binding is rejected until the user is a friend of the linked Official Account',async t=>{
  const calls=[];
  const fetcher=async(url,opts={})=>{
    calls.push({url,opts});
    if(url==='https://api.line.me/oauth2/v2.1/token')return new Response(JSON.stringify({access_token:'user-access-token',id_token:'mock-id-token'}),{status:200,headers:{'content-type':'application/json'}});
    if(url==='https://api.line.me/oauth2/v2.1/verify')return new Response(JSON.stringify({sub:'U'+'c'.repeat(32),name:'Not Friend',amr:['lineqr']}),{status:200,headers:{'content-type':'application/json'}});
    if(url==='https://api.line.me/friendship/v1/status')return new Response(JSON.stringify({friendFlag:false}),{status:200,headers:{'content-type':'application/json'}});
    return new Response('{}',{status:404,headers:{'content-type':'application/json'}});
  };
  const app=await createApp(config,{fetcher,clock:()=>new Date('2026-10-25T08:00:00Z')});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());
  const base='http://127.0.0.1:'+app.server.address().port;
  let r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({username:'admin',password:config.password})});const login=await r.json(),cookie=r.headers.get('set-cookie').split(';')[0];
  r=await fetch(base+'/api/line/bind/start',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Origin:base,'X-CSRF-Token':login.csrf},body:'{}'});const started=await r.json();assert.equal(r.status,200);
  r=await fetch(base+'/api/line/auth/callback?code=auth-code&state='+started.state,{redirect:'manual'});assert.equal(r.status,400);assert.match(await r.text(),/尚未加入官方帳號好友/);
  const binding=await app.store.accountLineBinding('admin');assert.equal(binding,undefined);
  assert.ok(!calls.some(c=>c.url.includes('/v2/bot/profile/')));assert.ok(!calls.some(c=>c.url==='https://api.line.me/v2/bot/message/push'));
});
