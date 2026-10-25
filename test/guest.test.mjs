import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';

const config={
  password:'admin-test-password-12345',adminUsername:'owner',guestUsername:'guest',guestPassword:'guest-test-password-12345',
  key:'d'.repeat(64),ingestToken:'i'.repeat(40),cronToken:'c'.repeat(40),dbPath:':memory:',production:false,origin:''
};

test('guest account is read-only and can only see mock health data',async t=>{
  const now=()=>new Date('2026-10-25T07:20:00Z');
  const app=await createApp(config,{clock:now});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(()=>app.close());
  const base='http://127.0.0.1:'+app.server.address().port;
  async function req(path,{method='GET',body,cookie='',csrf=''}={}){
    const headers={...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json',Origin:base,'X-CSRF-Token':csrf})};
    const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    let value;try{value=await r.json();}catch{value={};}
    return {r,body:value};
  }
  const admin=await req('/api/login',{method:'POST',body:{username:'owner',password:config.password}});
  assert.equal(admin.r.status,200);assert.equal(admin.body.role,'admin');
  const adminCookie=admin.r.headers.get('set-cookie').split(';')[0],adminCsrf=admin.body.csrf;
  const realPayload={data:{name:'step_count',units:'count',data:[{date:'2026-10-25',qty:99999.5,sources:'REAL_PRIVATE_SOURCE'}]}};
  assert.equal((await req('/api/import',{method:'POST',body:realPayload,cookie:adminCookie,csrf:adminCsrf})).r.status,200);
  assert.equal((await req('/api/settings',{method:'POST',body:{lineToken:'private-line-token-fixture-123456',userId:'U'+'a'.repeat(32)},cookie:adminCookie,csrf:adminCsrf})).r.status,200);

  const guest=await req('/api/login',{method:'POST',body:{username:'guest',password:config.guestPassword}});
  assert.equal(guest.r.status,200);assert.equal(guest.body.role,'guest');
  const guestCookie=guest.r.headers.get('set-cookie').split(';')[0],guestCsrf=guest.body.csrf;
  const session=await req('/api/session',{cookie:guestCookie});
  assert.equal(session.body.role,'guest');

  const state=await req('/api/state?from=2026-10-19&to=2026-10-25',{cookie:guestCookie});
  assert.equal(state.r.status,200);assert.equal(state.body.role,'guest');assert.equal(state.body.mock,true);
  assert.equal(state.body.rows.length,63);assert.ok(state.body.rows.every(r=>r.source==='Mock Data'));
  const serialized=JSON.stringify(state.body);
  assert.ok(!serialized.includes('99999.5'));assert.ok(!serialized.includes('REAL_PRIVATE_SOURCE'));
  assert.ok(!serialized.includes('private-line-token-fixture'));assert.ok(!serialized.includes('U'+'a'.repeat(32)));
  assert.deepEqual(state.body.events,[]);assert.equal(state.body.settings.userId,'');assert.equal(state.body.settings.ingestPath,'');

  const preview=await req('/api/report/preview?date=2026-10-25',{cookie:guestCookie});
  assert.equal(preview.r.status,200);assert.equal(preview.body.mock,true);assert.match(preview.body.text,/Guest Demo/);assert.ok(!preview.body.text.includes('99999'));

  const blocked=[
    ['/api/backup',{cookie:guestCookie}],
    ['/api/import',{method:'POST',body:realPayload,cookie:guestCookie,csrf:guestCsrf}],
    ['/api/settings',{method:'POST',body:{displayName:'x'},cookie:guestCookie,csrf:guestCsrf}],
    ['/api/line/verify',{method:'POST',body:{},cookie:guestCookie,csrf:guestCsrf}],
    ['/api/report/send',{method:'POST',body:{date:'2026-10-25',confirm:true},cookie:guestCookie,csrf:guestCsrf}],
    ['/api/jobs/daily',{method:'POST',body:{},cookie:guestCookie,csrf:guestCsrf}]
  ];
  for(const [path,options] of blocked){const x=await req(path,options);assert.equal(x.r.status,403,`${path} should be admin-only`);}

  const adminState=await req('/api/state?from=2026-10-25&to=2026-10-25',{cookie:adminCookie});
  assert.equal(adminState.body.role,'admin');assert.equal(adminState.body.mock,false);assert.equal(adminState.body.rows.find(r=>r.metric==='step_count').value,99999.5);
});

test('existing pre-2.6 sessions table is migrated with an admin role column',async()=>{
  const { localClient }=await import('../src/local-client.mjs');
  const { openStore }=await import('../src/store.mjs');
  const client=localClient(':memory:');
  await client.execute('CREATE TABLE sessions(hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL) STRICT');
  const store=await openStore(config,{client});
  try{const cols=(await client.execute('PRAGMA table_info(sessions)')).rows.map(r=>String(r.name));assert.ok(cols.includes('role'));}
  finally{store.close();}
});
