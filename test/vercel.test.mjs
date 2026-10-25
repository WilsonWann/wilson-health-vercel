import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { openStore } from '../src/store.mjs';
import { localClient } from '../src/local-client.mjs';
import { configFromEnv } from '../src/config.mjs';
import { normalizeRoute } from '../api/index.mjs';
const config={password:'fixture-password-not-real',key:'b'.repeat(64),ingestToken:'i'.repeat(40),cronToken:'c'.repeat(40),dbPath:':memory:',production:false,origin:''};
const sample={name:'step_count',units:'count',data:[{date:'2026-10-24',qty:1234.567,sources:''}]};
const now=()=>new Date('2026-10-25T02:00:00Z');
function invoke(app,path,{method='GET',body,headers={}}={}){
 return new Promise(async(resolve,reject)=>{
  const req={url:path,method,headers,socket:{remoteAddress:'127.0.0.1'},...(body===undefined?{}:{body})};
  const res={headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},writeHead(s,h={}){this.status=s;this.headersSent=true;for(const[k,v]of Object.entries(h))this.setHeader(k,v);},end(value){let data;try{data=JSON.parse(value);}catch{data=value;}resolve({status:this.status,headers:this.headers,body:data});}};
  try{await app.handler(req,res);}catch(e){reject(e);}
 });
}
const bearer={Authorization:'unused',authorization:'Bearer '+config.ingestToken,'content-type':'application/json'};
test('Vercel origin is inferred from the stable production domain',()=>{
 const c=configFromEnv({VERCEL:'1',VERCEL_ENV:'production',VERCEL_PROJECT_PRODUCTION_URL:'example.vercel.app',VERCEL_URL:'preview.vercel.app'});
 assert.equal(c.origin,'https://example.vercel.app');assert.equal(c.vercel,true);assert.equal(c.production,true);
});
test('explicit custom APP_ORIGIN overrides inference, strips trailing slash',()=>assert.equal(configFromEnv({APP_ORIGIN:'https://health.example/'}).origin,'https://health.example'));
test('preview deployment uses its own domain',()=>assert.equal(configFromEnv({VERCEL:'1',VERCEL_ENV:'preview',VERCEL_URL:'test.vercel.app',VERCEL_PROJECT_PRODUCTION_URL:'prod.vercel.app'}).origin,'https://test.vercel.app'));
test('route adapter keeps from/to parameters without exposing a second ingest path',()=>assert.equal(normalizeRoute('/api/index?__route=state&from=2026-10-18&to=2026-10-24'),'/api/state?from=2026-10-18&to=2026-10-24'));
test('route adapter also accepts the original route',()=>assert.equal(normalizeRoute('/api/ingest'),'/api/ingest'));
test('invalid rewritten route rejected',()=>assert.throws(()=>normalizeRoute('/api/index?__route=../.env')));
test('Vercel never falls back to local or tmp storage',async()=>await assert.rejects(()=>openStore({...config,vercel:true}),/Vercel 必須設定/));
test('insecure remote database transport rejected before loading driver',async()=>await assert.rejects(()=>openStore({...config,dbUrl:'http://database.example',dbToken:'fixture'}),/HTTPS/));
test('Vercel parsed body, cron authentication, limit and fixed schedule',async t=>{
 const app=await createApp({...config,vercel:true},{clock:now,client:localClient(':memory:')});t.after(()=>app.close());
 await t.test('parsed object can be ingested',async()=>{const r=await invoke(app,'/api/ingest',{method:'POST',body:sample,headers:bearer});assert.equal(r.status,200);assert.equal(r.body.changed,1);});
 await t.test('parsed buffer deduplicates same record',async()=>{const r=await invoke(app,'/api/ingest',{method:'POST',body:Buffer.from(JSON.stringify(sample)),headers:bearer});assert.equal(r.body.changed,0);});
 await t.test('parsed body retains 2MB limit',async()=>assert.equal((await invoke(app,'/api/ingest',{method:'POST',body:{large:'x'.repeat(2*1024*1024)},headers:bearer})).status,413));
 await t.test('cron GET cannot be triggered anonymously',async()=>assert.equal((await invoke(app,'/api/cron')).status,401));
 await t.test('authorized cron GET respects disabled switch and logs run',async()=>{const r=await invoke(app,'/api/cron',{headers:{authorization:'Bearer '+config.cronToken}});assert.equal(r.body.reason,'disabled');assert.ok((await app.store.events()).some(e=>e.event==='cron'));});
 await t.test('fixed report time exposed and other times rejected',async()=>{
   const login=await invoke(app,'/api/login',{method:'POST',body:{password:config.password},headers:{'content-type':'application/json'}});
   const headers={cookie:login.headers['set-cookie'].split(';')[0],'x-csrf-token':login.body.csrf,'content-type':'application/json'};
   assert.equal((await invoke(app,'/api/state',{headers})).body.settings.fixedReportTime,'09:00');
   assert.equal((await invoke(app,'/api/settings',{method:'POST',body:{reportTime:'12:00'},headers})).status,422);
 });
});
test('independent app instances share durable sessions, samples and atomic delivery locks',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'wilson-test-')),dbPath=join(dir,'test.sqlite'),calls=[];
 const fetcher=async(url,opts)=>{calls.push({url,opts});await new Promise(r=>setTimeout(r,20));return new Response('{}',{status:200});};
 const a=await createApp({...config,dbPath},{clock:now,fetcher});
 const b=await createApp({...config,dbPath},{clock:now,fetcher});
 t.after(async()=>{await a.close();await b.close();rmSync(dir,{recursive:true,force:true});});
 const login=await invoke(a,'/api/login',{method:'POST',body:{password:config.password},headers:{'content-type':'application/json'}});
 const headers={cookie:login.headers['set-cookie'].split(';')[0],'x-csrf-token':login.body.csrf,'content-type':'application/json'};
 assert.equal((await invoke(b,'/api/session',{headers})).body.authenticated,true);
 await invoke(a,'/api/ingest',{method:'POST',body:sample,headers:bearer});
 assert.equal((await b.store.samples())[0].value,1234.567);
 await invoke(a,'/api/settings',{method:'POST',body:{lineToken:'fixture-only-line-access-token',userId:'U'+'a'.repeat(32)},headers});
 const outcomes=await Promise.all([a.sendMessage('daily:2026-10-24','fixture only'),b.sendMessage('daily:2026-10-24','fixture only')]);
 assert.equal(calls.length,1);assert.equal(outcomes.filter(o=>o.status==='accepted').length,1);
 assert.ok(outcomes.some(o=>o.reason==='in_progress'));
 assert.equal((await b.sendMessage('daily:2026-10-24','fixture only')).reason,'already_sent');
});
test('login limiter is persisted rather than reset by a cold start',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'wilson-limit-')),dbPath=join(dir,'test.sqlite');
 const a=await createApp({...config,dbPath},{clock:now}),b=await createApp({...config,dbPath},{clock:now});
 t.after(async()=>{await a.close();await b.close();rmSync(dir,{recursive:true,force:true});});
 for(let i=0;i<8;i++)assert.equal((await invoke(i%2?a:b,'/api/login',{method:'POST',body:{password:'incorrect'},headers:{'content-type':'application/json'}})).status,401);
 assert.equal((await invoke(b,'/api/login',{method:'POST',body:{password:config.password},headers:{'content-type':'application/json'}})).status,429);
});
test('batch writes roll back completely if one DB statement fails',async t=>{
 const s=await openStore(config);t.after(()=>s.close());
 await assert.rejects(()=>s.import({records:[{date:'2026-10-24',metric:'step_count',value:123,source:null},{date:'2026-10-23',metric:'step_count',value:null,source:null}],warnings:[]}));
 assert.equal((await s.samples()).length,0);
});
test('Vercel config uses daily UTC cron and excludes all local secrets',()=>{
 const v=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url)));assert.deepEqual(v.crons,[{path:'/api/cron',schedule:'0 1 * * *'}]);
 const ignore=readFileSync(new URL('../.vercelignore',import.meta.url),'utf8');assert.match(ignore,/\.env\n/);assert.match(ignore,/data\n/);assert.match(ignore,/private/);
});
