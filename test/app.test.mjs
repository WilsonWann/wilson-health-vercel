import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
const metric=(day='2026-10-24',qty=1234.75)=>({data:{name:'step_count',units:'count',data:[{date:day,qty,sources:''}]}});
test('HTTP, persistence, authentication and LINE integration with mocked LINE',async t=>{
 let now=new Date('2026-10-25T03:00:00Z'), failNext=false;const calls=[];
 const app=await createApp({password:'test-only-password-12345',adminUsername:'admin',guestUsername:'guest',guestPassword:'guest-test-password-12345',key:'a'.repeat(64),ingestToken:'i'.repeat(40),cronToken:'c'.repeat(40),dbPath:':memory:',production:false,origin:''},{clock:()=>now,fetcher:async(url,options)=>{
   calls.push({url,options});if(failNext&&url.endsWith('/push')){failNext=false;throw new Error('simulated timeout');}
   return new Response(JSON.stringify(url.endsWith('/info')?{displayName:'Test Bot'}:{}),{status:200});
 }});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 t.after(()=>app.close());let cookie='',csrf='';
 async function req(path,data,extra={}){const r=await fetch(base+path,{method:data===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),...(data===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf,Origin:base}),...extra},body:data===undefined?undefined:JSON.stringify(data)});let body;try{body=await r.json();}catch{body={};}return {r,body};}
 await t.test('private data is inaccessible without login',async()=>assert.equal((await req('/api/state')).r.status,401));
 await t.test('login returns HttpOnly cookie and CSRF',async()=>{const x=await req('/api/login',{username:'admin',password:'test-only-password-12345'});assert.equal(x.r.status,200);cookie=x.r.headers.get('set-cookie').split(';')[0];csrf=x.body.csrf;assert.match(x.r.headers.get('set-cookie'),/HttpOnly/);assert.match(x.r.headers.get('set-cookie'),/SameSite=Lax/);});
 await t.test('writes without CSRF denied',async()=>assert.equal((await req('/api/import',metric(),{'X-CSRF-Token':''})).r.status,403));
 await t.test('cross-origin writes denied',async()=>assert.equal((await req('/api/import',metric(),{Origin:'https://attacker.example'})).r.status,403));
 await t.test('phone import without bearer denied',async()=>assert.equal((await req('/api/ingest',metric())).r.status,401));
 await t.test('real POST import writes decimals to SQLite',async()=>{const x=await req('/api/import',metric());assert.equal(x.r.status,200);assert.equal(x.body.changed,1);assert.equal((await app.store.samples())[0].value,1234.75);});
 await t.test('repeating import does not add counts',async()=>{const x=await req('/api/import',metric());assert.equal(x.body.changed,0);assert.equal(x.body.unchanged,1);assert.equal((await app.store.samples())[0].value,1234.75);});
 await t.test('other metrics do not overwrite existing steps',async()=>{await req('/api/import',{name:'sleep_analysis',units:'hr',data:[{date:'2026-10-24',totalSleep:7.2}]});assert.equal((await app.store.samples()).find(r=>r.metric==='step_count').value,1234.75);});
 await t.test('new daily summary replaces not accumulates',async()=>{await req('/api/import',metric('2026-10-24',1300.4));assert.equal((await app.store.samples()).find(r=>r.metric==='step_count').value,1300.4);});
 await t.test('invalid row no longer discards valid rows from the same batch',async()=>{const p=metric('2026-10-23',500);p.data.data.push({date:'2026-10-22',qty:null});const x=await req('/api/import',p);assert.equal(x.r.status,200);assert.equal(x.body.changed,1);assert.equal(x.body.rejected,1);assert.match(x.body.warnings.join(),/第 2 筆已略過/);assert.equal((await app.store.samples('2026-10-23','2026-10-23')).length,1);});
 await t.test('automation aggregation header is diagnostic only',async()=>{const hours=await req('/api/ingest',metric('2026-10-23',0),{Authorization:'Bearer '+'i'.repeat(40),'automation-aggregation':'Hours'});assert.equal(hours.r.status,200);assert.equal(hours.body.aggregation,'Hours');const days=await req('/api/ingest',metric('2026-10-23',0),{Authorization:'Bearer '+'i'.repeat(40),'automation-aggregation':'Days'});assert.equal(days.r.status,200);assert.equal(days.body.aggregation,'Days');});
 await t.test('mixed metrics import succeeds with warnings for rejected metric',async()=>{const p={data:{metrics:[metric('2026-10-21',321).data,{name:'sleep_analysis',units:'hr',data:[{date:'2026-10-21',totalSleep:'bad'}]}]}};const x=await req('/api/ingest',p,{Authorization:'Bearer '+'i'.repeat(40),'automation-aggregation':'Anything'});assert.equal(x.r.status,200);assert.equal(x.body.changed,1);assert.equal(x.body.rejected,1);assert.equal(x.body.aggregation,'Anything');assert.match(x.body.warnings.join(),/sleep_analysis/);});
 await t.test('body measurements import and remain available as latest-known values',async()=>{
   const body={data:{metrics:[
     {name:'height',units:'cm',data:[{date:'2026-10-20 08:00:00 +0800',qty:175.2,source:'Apple Health'}]},
     {name:'weight_&_body_mass',units:'kg',data:[{date:'2026-10-20 08:05:00 +0800',qty:88.2,source:'Apple Health'}]},
     {name:'body_mass_index',units:'count',data:[{date:'2026-10-20 08:05:00 +0800',qty:28.7,source:'Apple Health'}]}
   ]}};
   const x=await req('/api/import',body);assert.equal(x.r.status,200);assert.equal(x.body.changed,3);
   const st=await req('/api/state?from=2026-10-24&to=2026-10-25');assert.equal(st.body.bodyRows.length,3);
   const preview=await req('/api/report/preview?date=2026-10-24');assert.match(preview.body.text,/身高：175.2 cm（最近量測 2026-10-20）/);assert.match(preview.body.text,/體重：88.2 kg（最近量測 2026-10-20）/);assert.match(preview.body.text,/BMI：28.7（最近量測 2026-10-20）/);
 });
 await t.test('dashboard default range includes today',async()=>{const x=await req('/api/state');assert.equal(x.body.to,'2026-10-25');});
 await t.test('preview is UTC+8 to seconds and does not send',async()=>{const x=await req('/api/report/preview?date=2026-10-24');assert.match(x.body.text,/2026-10-25 11:00:00（UTC\+8）/);assert.equal(calls.length,0);});
 await t.test('LINE credentials save immediately and are encrypted',async()=>{const x=await req('/api/settings',{lineToken:'test-only-line-token-12345',userId:'U'+'a'.repeat(32),displayName:'Wilson'});assert.equal(x.r.status,200);assert.equal(x.body.settings.lineConfigured,true);assert.equal(x.body.settings.lineVerified,false);assert.ok(!(await app.store.settings()).credentials.includes('test-only-line-token'));});
 await t.test('state never returns access token or encryption key',async()=>{const x=await req('/api/state');assert.ok(!JSON.stringify(x.body).includes('test-only-line-token'));assert.ok(!JSON.stringify(x.body).includes('a'.repeat(64)));});
 await t.test('blank token preserves saved credentials',async()=>{await req('/api/settings',{lineToken:'',userId:'U'+'a'.repeat(32)});assert.equal((await app.store.credentials()).token,'test-only-line-token-12345');});
 await t.test('auto send cannot be enabled before verification',async()=>assert.equal((await req('/api/settings',{autoSend:true})).r.status,422));
 await t.test('verify checks bot info without sending',async()=>{const x=await req('/api/line/verify',{});assert.equal(x.r.status,200);assert.equal(calls.at(-1).url,'https://api.line.me/v2/bot/info');});
 await t.test('test message requires explicit confirmation',async()=>assert.equal((await req('/api/line/test',{})).r.status,422));
 await t.test('test send has unique retry key and contains no health values',async()=>{assert.equal((await req('/api/line/test',{confirm:true})).body.status,'accepted');const c=calls.at(-1);assert.match(c.options.headers['X-Line-Retry-Key'],/^[0-9a-f-]{36}$/);assert.ok(!c.options.body.includes('1300'));});
 await t.test('manual daily delivery deduplicates repeated clicks',async()=>{let x=await req('/api/report/send',{date:'2026-10-24',confirm:true});assert.equal(x.body.status,'accepted');const n=calls.length;x=await req('/api/report/send',{date:'2026-10-24',confirm:true});assert.equal(x.body.reason,'already_sent');assert.equal(calls.length,n);});
 await t.test('daily job respects disabled toggle',async()=>assert.equal((await app.daily()).reason,'disabled'));
 await t.test('daily job never repeats a manually sent day',async()=>{assert.equal((await req('/api/settings',{autoSend:true})).r.status,200);assert.equal((await app.daily()).reason,'already_sent');});
 await t.test('job endpoint accepts only cron token or admin session',async()=>{const old=cookie;cookie='';assert.equal((await req('/api/jobs/daily',{})).r.status,401);assert.equal((await req('/api/jobs/daily',{}, {Authorization:'Bearer '+'c'.repeat(40)})).r.status,200);cookie=old;});
 await t.test('uncertain retry retains original body and key',async()=>{
   failNext=true;let x=await req('/api/report/send',{date:'2026-10-23',confirm:true});assert.equal(x.r.status,502);const first=calls.at(-1);
   await req('/api/import',metric('2026-10-23',999));x=await req('/api/report/send',{date:'2026-10-23',confirm:true});assert.equal(x.body.status,'accepted');const last=calls.at(-1);assert.equal(last.options.body,first.options.body);assert.equal(last.options.headers['X-Line-Retry-Key'],first.options.headers['X-Line-Retry-Key']);
 });
 await t.test('concurrent sends share the date lock',async()=>{await req('/api/import',metric('2026-10-22',300));const count=calls.filter(c=>c.url.endsWith('/push')).length;await Promise.all([req('/api/report/send',{date:'2026-10-22',confirm:true}),req('/api/report/send',{date:'2026-10-22',confirm:true})]);assert.equal(calls.filter(c=>c.url.endsWith('/push')).length,count+1);});
 await t.test('daily job skips missing yesterday steps',async()=>{now=new Date('2026-10-26T03:00:00Z');assert.equal((await app.daily()).reason,'missing_steps');});
 await t.test('daily job waits for Taipei scheduled time',async()=>{now=new Date('2026-10-26T00:00:00Z');assert.equal((await app.daily()).reason,'not_due');});
 await t.test('sessions expire after eight hours',async()=>assert.equal((await req('/api/state')).r.status,401));
});
