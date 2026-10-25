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
    return new Response(JSON.stringify({sub:'U'+'b'.repeat(32),name:'QR User',nonce:body.get('nonce'),amr:['lineqr','mfa']}),{status:200,headers:{'content-type':'application/json'}});
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

async function responseBody(r){const type=r.headers.get('content-type')||'';return type.includes('json')?await r.json():await r.text();}

test('admin binds LINE through official LINE QR Login and can later log in by official QR',async t=>{
  const {app,calls,base}=await boot(t);let cookie='',csrf='';
  async function req(path,{method='GET',body,auth=true,cookieOverride}={}){
    const useCookie=cookieOverride!==undefined?cookieOverride:cookie;
    const headers={...(auth&&useCookie?{Cookie:useCookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json',Origin:base,...(auth&&csrf?{'X-CSRF-Token':csrf}:{})})};
    const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
    return {r,body:await responseBody(r)};
  }
  const login=await req('/api/login',{method:'POST',body:{username:'admin',password:config.password}});cookie=login.r.headers.get('set-cookie').split(';')[0];csrf=login.body.csrf;
  const start=await req('/api/line/bind/start',{method:'POST',body:{}});assert.equal(start.r.status,200);assert.equal(start.body.qrSvg,undefined);assert.equal(start.body.pollToken,undefined);
  const authorize=new URL(start.body.authorizeUrl);assert.equal(authorize.origin,'https://access.line.me');assert.equal(authorize.searchParams.get('client_id'),config.lineLoginChannelId);assert.equal(authorize.searchParams.get('scope'),'openid profile');assert.equal(authorize.searchParams.get('bot_prompt'),'normal');assert.equal(authorize.searchParams.get('initial_amr_display'),'lineqr');assert.equal(authorize.searchParams.get('switch_amr'),'false');assert.equal(authorize.searchParams.get('disable_auto_login'),'true');assert.equal(authorize.searchParams.get('ui_locales'),'zh-TW');
  const callback=await req('/api/line/auth/callback?code=auth-code&state='+start.body.state,{auth:false});assert.equal(callback.r.status,302);assert.match(callback.r.headers.get('location'),/^\/?\?line=bound#line$/i);
  const binding=await app.store.accountLineBinding('admin');assert.equal(binding.user_id,'U'+'b'.repeat(32));assert.equal(binding.role,'admin');
  const state=await req('/api/state?from=2026-10-25&to=2026-10-25');assert.equal(state.body.settings.recipientConfigured,true);

  // New desktop browser: official LINE QR login returns to the same callback and directly sets our session cookie.
  cookie='';csrf='';
  const lineStart=await req('/api/line/login/start',{method:'POST',body:{},auth:false});assert.equal(lineStart.r.status,200);assert.equal(lineStart.body.qrSvg,undefined);
  const loginAuthorize=new URL(lineStart.body.authorizeUrl);assert.equal(loginAuthorize.searchParams.get('initial_amr_display'),'lineqr');assert.equal(loginAuthorize.searchParams.get('switch_amr'),'false');
  const loginCallback=await req('/api/line/auth/callback?code=auth-code-2&state='+lineStart.body.state,{auth:false});assert.equal(loginCallback.r.status,302);assert.equal(loginCallback.r.headers.get('location'),'/?line=login-ok');
  const lineCookie=loginCallback.r.headers.get('set-cookie').split(';')[0];
  const session=await req('/api/session',{auth:true,cookieOverride:lineCookie});assert.equal(session.body.authenticated,true);assert.equal(session.body.role,'admin');
  assert.ok(calls.some(c=>c.url==='https://api.line.me/oauth2/v2.1/token'));assert.ok(calls.some(c=>c.url==='https://api.line.me/oauth2/v2.1/verify'));
});

test('unbound LINE account cannot directly enter the private dashboard',async t=>{
  const {base}=await boot(t);const headers={'Content-Type':'application/json',Origin:base};
  let r=await fetch(base+'/api/line/login/start',{method:'POST',headers,body:'{}'});const started=await r.json();assert.equal(r.status,200);
  r=await fetch(base+'/api/line/auth/callback?code=auth-code&state='+started.state,{redirect:'manual'});assert.equal(r.status,302);assert.equal(r.headers.get('location'),'/?line=unbound');assert.equal(r.headers.get('set-cookie'),null);
});

test('LINE QR is unavailable without LINE Login channel configuration',async t=>{
  const {base}=await boot(t,{lineLoginChannelId:'',lineLoginChannelSecret:''});
  const r=await fetch(base+'/api/line/login/start',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:'{}'});assert.equal(r.status,409);assert.match((await r.json()).error,/LINE_LOGIN_CHANNEL_ID/);
});
