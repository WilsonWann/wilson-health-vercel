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
    return new Response(JSON.stringify({sub:'U'+'b'.repeat(32),name:'QR User',nonce:body.get('nonce')}),{status:200,headers:{'content-type':'application/json'}});
  }
  if(url==='https://api.line.me/friendship/v1/status')return new Response(JSON.stringify({friendFlag:true}),{status:200,headers:{'content-type':'application/json'}});
  if(url==='https://api.line.me/v2/bot/info')return new Response(JSON.stringify({displayName:'Health Bot'}),{status:200,headers:{'content-type':'application/json'}});
  if(url==='https://api.line.me/v2/bot/message/push')return new Response('{}',{status:200,headers:{'content-type':'application/json'}});
  return new Response('{}',{status:404,headers:{'content-type':'application/json'}});
};}

async function boot(t,overrides={}){
  const calls=[],app=await createApp({...config,...overrides},{fetcher:mockLineFetcher(calls),clock:()=>new Date('2026-10-25T08:00:00Z')});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());
  return {app,calls,base:'http://127.0.0.1:'+app.server.address().port};
}

test('admin binds LINE by inline QR and can later log in by LINE QR',async t=>{
  const {app,calls,base}=await boot(t);let cookie='',csrf='';
  async function req(path,{method='GET',body,auth=true,cookieOverride}={}){
    const useCookie=cookieOverride!==undefined?cookieOverride:cookie;
    const headers={...(auth&&useCookie?{Cookie:useCookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json',Origin:base,...(auth&&csrf?{'X-CSRF-Token':csrf}:{})})};
    const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
    const type=r.headers.get('content-type')||'';const value=type.includes('json')?await r.json():await r.text();return {r,body:value};
  }
  const login=await req('/api/login',{method:'POST',body:{username:'admin',password:config.password}});cookie=login.r.headers.get('set-cookie').split(';')[0];csrf=login.body.csrf;
  const stateBefore=await req('/api/state?from=2026-10-25&to=2026-10-25');assert.equal(stateBefore.body.settings.lineConfigured,true);assert.equal(stateBefore.body.settings.recipientConfigured,false);assert.equal(stateBefore.body.settings.lineTokenFromEnv,true);

  const start=await req('/api/line/bind/start',{method:'POST',body:{}});assert.equal(start.r.status,200);assert.match(start.body.qrSvg,/^<svg/);assert.ok(start.body.qrSvg.length>500);
  const authorize=new URL(start.body.authorizeUrl);assert.equal(authorize.origin,'https://access.line.me');assert.equal(authorize.searchParams.get('client_id'),config.lineLoginChannelId);assert.equal(authorize.searchParams.get('scope'),'openid profile');assert.equal(authorize.searchParams.get('bot_prompt'),'normal');assert.equal(authorize.searchParams.get('state'),start.body.state);
  const callback=await req('/api/line/auth/callback?code=auth-code&state='+start.body.state,{auth:false});assert.equal(callback.r.status,200);assert.match(callback.body,/LINE 綁定完成/);
  const status=await req('/api/line/bind/status?state='+start.body.state);assert.equal(status.body.status,'complete');assert.equal(status.body.displayName,'QR User');assert.equal(status.body.friendFlag,true);assert.match(status.body.userId,/^Ubbbbb…bbbb$/);
  const binding=await app.store.accountLineBinding('admin');assert.equal(binding.user_id,'U'+'b'.repeat(32));assert.equal(binding.role,'admin');
  const state=await req('/api/state?from=2026-10-25&to=2026-10-25');assert.equal(state.body.settings.recipientConfigured,true);assert.match(state.body.settings.maskedUserId,/^Ubbbbb…bbbb$/);

  // New browser: QR login is only accepted after that LINE account has been bound.
  cookie='';csrf='';
  const lineStart=await req('/api/line/login/start',{method:'POST',body:{},auth:false});assert.equal(lineStart.r.status,200);assert.match(lineStart.body.qrSvg,/^<svg/);
  const loginCallback=await req('/api/line/auth/callback?code=auth-code-2&state='+lineStart.body.state,{auth:false});assert.equal(loginCallback.r.status,200);assert.match(loginCallback.body,/LINE Login 已授權/);
  const poll=await req('/api/line/login/status',{method:'POST',body:{state:lineStart.body.state,pollToken:lineStart.body.pollToken},auth:false});assert.equal(poll.r.status,200);assert.equal(poll.body.status,'complete');assert.equal(poll.body.role,'admin');assert.equal(poll.body.username,'admin');
  const lineCookie=poll.r.headers.get('set-cookie').split(';')[0];const session=await req('/api/session',{auth:true,cookieOverride:lineCookie});assert.equal(session.body.authenticated,true);assert.equal(session.body.role,'admin');
  assert.ok(calls.some(c=>c.url==='https://api.line.me/oauth2/v2.1/token'));assert.ok(calls.some(c=>c.url==='https://api.line.me/oauth2/v2.1/verify'));
});

test('unbound LINE account cannot directly enter the private dashboard',async t=>{
  const {base}=await boot(t);const headers={'Content-Type':'application/json',Origin:base};
  let r=await fetch(base+'/api/line/login/start',{method:'POST',headers,body:'{}'});const started=await r.json();assert.equal(r.status,200);
  r=await fetch(base+'/api/line/auth/callback?code=auth-code&state='+started.state,{redirect:'manual'});assert.equal(r.status,400);assert.match(await r.text(),/LINE 尚未綁定/);
  r=await fetch(base+'/api/line/login/status',{method:'POST',headers,body:JSON.stringify({state:started.state,pollToken:started.pollToken})});const status=await r.json();assert.equal(status.status,'failed');assert.match(status.error,/尚未綁定/);
});

test('LINE QR is unavailable without LINE Login channel configuration',async t=>{
  const {base}=await boot(t,{lineLoginChannelId:'',lineLoginChannelSecret:''});
  const r=await fetch(base+'/api/line/login/start',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:'{}'});assert.equal(r.status,409);assert.match((await r.json()).error,/LINE_LOGIN_CHANNEL_ID/);
});
