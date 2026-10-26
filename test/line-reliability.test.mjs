import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const config={password:'line-reliability-test-password',key:'a'.repeat(64),ingestToken:'i'.repeat(40),cronToken:'c'.repeat(40),dbPath:':memory:',production:false,origin:'',lineLoginChannelId:'1234567890',lineLoginChannelSecret:'local-test-channel-secret-12345',lineChannelAccessToken:'local-test-channel-token-12345'};
async function boot(t,{holdToken,dbPath=':memory:'}={}){
  let time=Date.parse('2026-10-26T02:00:00Z'),exchanges=0;
  const app=await createApp({...config,dbPath},{clock:()=>new Date(time),fetcher:async(url,opts={})=>{
    let value;
    if(url.endsWith('/token')){exchanges++;if(holdToken)await holdToken;value={access_token:'fixture-access',id_token:'fixture-id'};}
    else if(url.endsWith('/verify'))value={sub:'U'+'e'.repeat(32),name:'Retry Member',nonce:new URLSearchParams(opts.body).get('nonce'),amr:['lineqr']};
    else if(url.endsWith('/status'))value={friendFlag:true};
    else throw new Error('Unexpected external request');
    return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
  }});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());const base='http://127.0.0.1:'+app.server.address().port;
  async function post(path,data,headers={}){const r=await fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});return {r,body:await r.json()};}
  const start=async()=>(await post('/api/line/login/start',{})).body;
  const poll=(s,headers)=>post('/api/line/login/status',{state:s.state,pollToken:s.pollToken},headers);
  const callback=s=>fetch(base+'/api/line/auth/callback?code=fixture-code&state='+s.state);
  return {app,base,post,start,poll,callback,advance:ms=>{time+=ms;},get exchanges(){return exchanges;}};
}
test('concurrent polls and a lost first response recover exactly one session',async t=>{
  const f=await boot(t),s=await f.start();assert.ok(s.serverTime);
  assert.equal((await f.callback(s)).status,200);
  const polls=await Promise.all(Array.from({length:4},()=>f.poll(s)));
  for(const p of polls){assert.equal(p.r.status,200);assert.equal(p.body.status,'complete');assert.equal(p.r.headers.get('set-cookie'),polls[0].r.headers.get('set-cookie'));assert.equal(p.body.csrf,polls[0].body.csrf);}
  const sessions=await f.app.store.db.prepare("SELECT COUNT(*) AS n FROM sessions_v4 WHERE role='user'").get();assert.equal(sessions.n,1);
  const receipt=await f.app.store.db.prepare('SELECT session_cipher FROM line_login_results_v1 WHERE state=?').get(s.state);
  assert.ok(!receipt.session_cipher.includes(polls[0].body.csrf));assert.ok(!receipt.session_cipher.includes(polls[0].r.headers.get('set-cookie').split(';')[0].slice(4)));
  f.advance(61000);
  assert.equal((await f.poll(s)).body.status,'consumed');
  const withCookie=await f.poll(s,{Cookie:polls[0].r.headers.get('set-cookie').split(';')[0]});assert.equal(withCookie.body.status,'complete');
});
test('recovery never revives a logged-out session and rejects the wrong poll token',async t=>{
  const f=await boot(t),s=await f.start();await f.callback(s);
  const complete=await f.poll(s),cookie=complete.r.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.poll({...s,pollToken:'wrong'})).r.status,403);
  assert.equal((await f.post('/api/logout',{}, {Cookie:cookie,'X-CSRF-Token':complete.body.csrf})).r.status,200);
  const replay=await f.poll(s);assert.equal(replay.body.status,'consumed');assert.equal(replay.r.headers.get('set-cookie'),null);
  assert.equal((await f.app.store.db.prepare('SELECT COUNT(*) AS n FROM sessions_v4').get()).n,0);
});
test('duplicate callbacks cannot exchange the same authorization code concurrently',async t=>{
  let release;const holdToken=new Promise(r=>{release=r;}),f=await boot(t,{holdToken}),s=await f.start();
  const first=f.callback(s);
  for(let i=0;i<50&&f.exchanges===0;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(f.exchanges,1);assert.equal((await f.poll(s)).body.status,'processing');
  const duplicate=await f.callback(s);assert.equal(duplicate.status,200);assert.match(await duplicate.text(),/處理中/);
  release();assert.equal((await first).status,200);
  const repeat=await f.callback(s);assert.equal(repeat.status,200);assert.match(await repeat.text(),/已完成/);assert.equal(f.exchanges,1);
  assert.equal((await f.poll(s)).body.status,'complete');
});
test('expired challenges cannot authenticate even after a successful callback',async t=>{
  const f=await boot(t),s=await f.start();await f.callback(s);f.advance(300001);
  const expired=await f.poll(s);assert.equal(expired.body.status,'expired');assert.equal(expired.r.headers.get('set-cookie'),null);
  assert.equal((await f.callback(s)).status,400);
  assert.equal((await f.app.store.db.prepare('SELECT COUNT(*) AS n FROM sessions_v4').get()).n,0);
});
test('independent backend instances recover the same durable login result',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'wilson-login-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const dbPath=join(dir,'health.sqlite'),first=await boot(t,{dbPath}),second=await boot(t,{dbPath});
  const s=await first.start();assert.equal((await second.callback(s)).status,200);
  const a=await first.poll(s),b=await second.poll(s);
  assert.equal(a.body.status,'complete');assert.equal(b.body.status,'complete');
  assert.equal(a.r.headers.get('set-cookie'),b.r.headers.get('set-cookie'));
  assert.equal((await first.app.store.db.prepare("SELECT COUNT(*) AS n FROM sessions_v4 WHERE role='user'").get()).n,1);
});
