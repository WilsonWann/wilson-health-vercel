import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
const config={password:'sso-regression-test-password',key:'a'.repeat(64),ingestToken:'i'.repeat(40),cronToken:'c'.repeat(40),dbPath:':memory:',lineLoginChannelId:'1234567890',lineLoginChannelSecret:'fixture-channel-secret-12345'};
async function boot(t,{amr=['lineqr'],tokenError,verifyError}={}){
  const app=await createApp(config,{clock:()=>new Date('2026-10-26T02:00:00Z'),fetcher:async(url,opts={})=>{
    const value=url.endsWith('/token')?(tokenError||{access_token:'private-access-token-fixture',id_token:'private-id-token-fixture'}):url.endsWith('/verify')?(verifyError||{sub:'U'+'a'.repeat(32),name:'Fixture',...(amr===null?{}:{amr}),nonce:new URLSearchParams(opts.body).get('nonce')}):{friendFlag:true};
    return new Response(JSON.stringify(value),{status:(url.endsWith('/token')&&tokenError)||(url.endsWith('/verify')&&verifyError)?400:200,headers:{'content-type':'application/json'}});
  }});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());const base='http://127.0.0.1:'+app.server.address().port;
  async function post(path,data){const r=await fetch(base+path,{method:'POST',headers:{Origin:base,'content-type':'application/json'},body:JSON.stringify(data)});return {r,body:await r.json()};}
  const s=(await post('/api/line/login/start',{})).body;
  return {app,base,s,post,callback:()=>fetch(base+'/api/line/auth/callback?code=private-code-fixture&state='+s.state),poll:()=>post('/api/line/login/status',{state:s.state,pollToken:s.pollToken})};
}
test('QR authorization explicitly requires reauthentication despite a LINE SSO cookie',async t=>{
  const f=await boot(t),q=new URL(f.s.authorizeUrl).searchParams;
  assert.equal(q.get('prompt'),'login');assert.equal(q.get('initial_amr_display'),'lineqr');assert.equal(q.get('switch_amr'),'false');assert.equal(q.get('disable_auto_login'),'true');
  assert.equal((await f.callback()).status,200);assert.equal((await f.poll()).body.status,'complete');
});
for(const [name,amr] of [['remembered SSO',['linesso']],['missing method',undefined],['password',['pwd']]]){
  test(`${name} returns an actionable QR error and creates no app session`,async t=>{
    const f=await boot(t,{amr:amr===undefined?null:amr}),r=await f.callback(),html=await r.text();
    assert.equal(r.status,400);assert.match(html,/LINE_QR_REQUIRED/);assert.match(html,/重新產生 QR Code/);assert.doesNotMatch(html,/系統會自動接續登入/);
    if(name==='remembered SSO')assert.match(html,/已記住帳號的 SSO/);
    const p=await f.poll();assert.equal(p.body.status,'failed');assert.match(p.body.error,/LINE_QR_REQUIRED/);
    assert.equal((await f.app.store.db.prepare('SELECT COUNT(*) AS n FROM sessions_v4').get()).n,0);
    const event=(await f.app.store.events()).find(e=>e.event==='line_auth_failed'),diagnostic=JSON.parse(event.message);
    assert.equal(diagnostic.code,'LINE_QR_REQUIRED');assert.equal(diagnostic.stage,'authentication_method');assert.match(diagnostic.reference,/^[a-f0-9]{8}$/);
    for(const secret of ['private-access-token-fixture','private-id-token-fixture','private-code-fixture',f.s.pollToken,config.lineLoginChannelSecret])assert.ok(!(html+JSON.stringify(p.body)+event.message).includes(secret));
  });
}
test('invalid authorization code is distinguished from ID token verification failure',async t=>{
  const f=await boot(t,{tokenError:{error:'invalid_grant',error_description:'private-authorization-code-and-secret'}}),r=await f.callback(),html=await r.text();
  assert.match(html,/LINE_CODE_INVALID/);assert.match(html,/授權碼已失效或已使用/);assert.doesNotMatch(html,/private-authorization/);
  const diagnostic=JSON.parse((await f.app.store.events()).find(e=>e.event==='line_auth_failed').message);assert.equal(diagnostic.stage,'token_exchange');
});
test('nonce verification errors remain rejected and have a safe diagnostic code',async t=>{
  const f=await boot(t,{verifyError:{error:'invalid_request',error_description:'Invalid IdToken Nonce.'}}),r=await f.callback();
  assert.equal(r.status,400);assert.match(await r.text(),/LINE_NONCE_MISMATCH/);assert.equal((await f.poll()).body.status,'failed');
});
test('database errors are diagnosed without exposing internal exception text',async t=>{
  const f=await boot(t);t.mock.method(f.app.store,'upsertLineUser',async()=>{throw new Error('private-database-url-and-token');});
  const r=await f.callback(),html=await r.text(),p=await f.poll();assert.match(html,/LINE_MEMBER_SETUP_FAILED/);assert.doesNotMatch(html+JSON.stringify(p.body),/private-database/);
});
test('an optional event log failure cannot turn verified login into failure',async t=>{
  const f=await boot(t),original=f.app.store.event.bind(f.app.store);
  t.mock.method(f.app.store,'event',async(...args)=>{if(args[0]==='line_user_login')throw new Error('log unavailable');return original(...args);});
  assert.equal((await f.callback()).status,200);assert.equal((await f.poll()).body.status,'complete');
});
