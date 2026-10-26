import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';

const config={
  password:'admin-member-password-12345',adminUsername:'admin',guestUsername:'guest',guestPassword:'',
  key:'f'.repeat(64),ingestToken:'i'.repeat(40),cronToken:'c'.repeat(40),dbPath:':memory:',production:false,origin:'',
  lineLoginChannelId:'1234567890',lineLoginChannelSecret:'line-login-secret-fixture-123456',lineChannelAccessToken:'channel-token-fixture-123456789'
};

function fetcher(){return async(url,opts={})=>{
  if(url==='https://api.line.me/oauth2/v2.1/token'){
    const b=new URLSearchParams(String(opts.body)),code=b.get('code')||'';
    return new Response(JSON.stringify({access_token:'access-'+code,id_token:'id-'+code}),{status:200,headers:{'content-type':'application/json'}});
  }
  if(url==='https://api.line.me/oauth2/v2.1/verify'){
    const b=new URLSearchParams(String(opts.body)),id=b.get('id_token')||'';
    const a=id.endsWith('code-a');
    return new Response(JSON.stringify({sub:'U'+(a?'a':'b').repeat(32),name:a?'Alice':'Bob',amr:['lineqr'],nonce:b.get('nonce')}),{status:200,headers:{'content-type':'application/json'}});
  }
  if(url==='https://api.line.me/friendship/v1/status')return new Response(JSON.stringify({friendFlag:true}),{status:200,headers:{'content-type':'application/json'}});
  if(url==='https://api.line.me/v2/bot/message/push')return new Response('{}',{status:200,headers:{'content-type':'application/json'}});
  return new Response('{}',{status:404,headers:{'content-type':'application/json'}});
};}

async function lineLogin(base,code){
  const headers={'Content-Type':'application/json',Origin:base};
  let r=await fetch(base+'/api/line/login/start',{method:'POST',headers,body:'{}'});const start=await r.json();assert.equal(r.status,200);
  r=await fetch(base+`/api/line/auth/callback?code=${code}&state=${start.state}`,{redirect:'manual'});assert.equal(r.status,200);
  r=await fetch(base+'/api/line/login/status',{method:'POST',headers,body:JSON.stringify({state:start.state,pollToken:start.pollToken})});const poll=await r.json();assert.equal(poll.status,'complete');assert.equal(poll.role,'user');
  return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:poll.csrf,name:poll.username};
}

function steps(date,qty){return {data:{name:'step_count',units:'count',data:[{date,qty,sources:'test'}]}};}

test('LINE members are backend-identified and health data is isolated by user-specific ingest token',async t=>{
  const app=await createApp(config,{fetcher:fetcher(),clock:()=>new Date('2026-10-26T02:00:00Z')});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());
  const base='http://127.0.0.1:'+app.server.address().port;
  const alice=await lineLogin(base,'code-a'),bob=await lineLogin(base,'code-b');assert.equal(alice.name,'Alice');assert.equal(bob.name,'Bob');

  async function get(path,cookie){const r=await fetch(base+path,{headers:{Cookie:cookie}});return {r,body:await r.json()};}
  const aSync=await get('/api/me/sync-config',alice.cookie),bSync=await get('/api/me/sync-config',bob.cookie);
  assert.match(aSync.body.ingestToken,/^[0-9a-f]{64}$/);assert.match(bSync.body.ingestToken,/^[0-9a-f]{64}$/);assert.notEqual(aSync.body.ingestToken,bSync.body.ingestToken);

  let r=await fetch(base+'/api/ingest',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+aSync.body.ingestToken},body:JSON.stringify(steps('2026-10-25',1111.1))});assert.equal(r.status,200);
  r=await fetch(base+'/api/ingest',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bSync.body.ingestToken},body:JSON.stringify(steps('2026-10-25',2222.2))});assert.equal(r.status,200);

  const aState=await get('/api/state?from=2026-10-25&to=2026-10-25',alice.cookie),bState=await get('/api/state?from=2026-10-25&to=2026-10-25',bob.cookie);
  assert.equal(aState.body.role,'user');assert.equal(bState.body.role,'user');assert.equal(aState.body.user.displayName,'Alice');assert.equal(bState.body.user.displayName,'Bob');
  assert.equal(aState.body.rows.find(x=>x.metric==='step_count').value,1111.1);assert.equal(bState.body.rows.find(x=>x.metric==='step_count').value,2222.2);
  assert.ok(!JSON.stringify(aState.body).includes('2222.2'));assert.ok(!JSON.stringify(bState.body).includes('1111.1'));

  const aliceUser=await app.store.userByLineId('U'+'a'.repeat(32)),bobUser=await app.store.userByLineId('U'+'b'.repeat(32));assert.notEqual(aliceUser.id,bobUser.id);
});

test('LINE member login rejects a non-QR authentication method',async t=>{
  const badFetcher=async(url,opts={})=>{
    if(url==='https://api.line.me/oauth2/v2.1/token')return new Response(JSON.stringify({access_token:'access',id_token:'id'}),{status:200,headers:{'content-type':'application/json'}});
    if(url==='https://api.line.me/oauth2/v2.1/verify')return new Response(JSON.stringify({sub:'U'+'c'.repeat(32),name:'Email User',amr:['pwd']}),{status:200,headers:{'content-type':'application/json'}});
    return new Response(JSON.stringify({friendFlag:true}),{status:200,headers:{'content-type':'application/json'}});
  };
  const app=await createApp(config,{fetcher:badFetcher,clock:()=>new Date('2026-10-26T02:00:00Z')});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());const base='http://127.0.0.1:'+app.server.address().port;
  let r=await fetch(base+'/api/line/login/start',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:'{}'});const start=await r.json();
  r=await fetch(base+`/api/line/auth/callback?code=x&state=${start.state}`,{redirect:'manual'});assert.equal(r.status,400);assert.match(await r.text(),/LINE Login 失敗/);
  r=await fetch(base+'/api/line/login/status',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({state:start.state,pollToken:start.pollToken})});const status=await r.json();assert.equal(status.status,'failed');assert.match(status.error,/QR Code/);
});
