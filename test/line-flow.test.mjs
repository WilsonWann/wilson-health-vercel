import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { createLineAuthFlow } from '../public/line-auth.js';
function setup(t,request,onComplete=async()=>{}){
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:Date.parse('2026-10-26T02:00:00Z')});
  const views=[],data=new Map(),storage={setItem:(k,v)=>data.set(k,v),getItem:k=>data.get(k),removeItem:k=>data.delete(k)};
  const flow=createLineAuthFlow({request,onChange:v=>views.push(v),onComplete,storage,openWindow:()=>null});t.after(()=>flow.cancel());
  return {flow,views,data,storage,get view(){return views.at(-1);}};
}
function started(){return {state:'s',pollToken:'p',authorizeUrl:'https://access.line.me/oauth2/v2.1/authorize?state=s&prompt=login',serverTime:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString()};}
test('transient network failures retry and stop completely after success',async t=>{
  let polls=0,completed=0;const f=setup(t,async path=>path.endsWith('/start')?started():(++polls===1?Promise.reject(new TypeError('offline')):{status:'complete',csrf:'ok'}),async()=>{completed++;});
  await f.flow.start();await flush();assert.equal(f.view.stage,'reconnecting');
  t.mock.timers.tick(1500);await flush();assert.equal(f.view.stage,'complete');assert.equal(completed,1);
  t.mock.timers.tick(20000);await flush();assert.equal(polls,2);assert.equal(completed,1);assert.equal(f.data.size,0);
});
test('slow status requests never overlap and cancellation ignores their late result',async t=>{
  let release,polls=0,completed=0;
  const f=setup(t,async path=>path.endsWith('/start')?started():(polls++,new Promise(r=>{release=r;})),async()=>{completed++;});
  await f.flow.start();t.mock.timers.tick(9000);await flush();assert.equal(polls,1);
  f.flow.cancel();release({status:'complete',csrf:'stale'});await flush();assert.equal(f.view.stage,'idle');assert.equal(completed,0);
});
test('expiry is actionable and does not leave polling alive',async t=>{
  let polls=0;const f=setup(t,async path=>path.endsWith('/start')?started():(polls++,{status:'pending'}));
  await f.flow.start();await flush();t.mock.timers.tick(300001);await flush();assert.equal(f.view.stage,'expired');assert.equal(f.view.hasAttempt,false);
  const count=polls;t.mock.timers.tick(30000);await flush();assert.equal(polls,count);
});
test('server time tolerates device clock skew, and a tab can resume its attempt',async t=>{
  const f=setup(t,async path=>path.endsWith('/start')?{...started(),serverTime:'2026-10-25T02:00:00Z',expiresAt:'2026-10-25T02:05:00Z'}:{status:'pending'});
  await f.flow.start();await flush();assert.equal(f.view.remaining,300);
  const saved=f.data.get('wilson-line-login');f.flow.cancel();f.data.set('wilson-line-login',saved);
  assert.equal(f.flow.resume(),true);await flush();assert.equal(f.view.stage,'waiting');assert.equal(f.view.hasAttempt,true);
});
test('dashboard loading errors can retry without another authorization',async t=>{
  let starts=0,loads=0;const f=setup(t,async path=>path.endsWith('/start')?(starts++,started()):{status:'complete',csrf:'ok'},async()=>{if(++loads===1)throw new Error('DB temporarily unavailable');});
  await f.flow.start();await flush();assert.equal(f.view.stage,'load-error');
  await f.flow.retryComplete();assert.equal(f.view.stage,'complete');assert.equal(starts,1);assert.equal(loads,2);
});
test('a saved URL from before fresh authentication was required is not resumed',async t=>{
  let requests=0;const f=setup(t,async()=>{requests++;return {status:'pending'};});
  f.data.set('wilson-line-login',JSON.stringify({state:'old',pollToken:'old',authorizeUrl:'https://access.line.me/oauth2/v2.1/authorize?state=old',deadline:Date.now()+60000}));
  assert.equal(f.flow.resume(),true);await flush();assert.equal(requests,0);assert.equal(f.view.stage,'expired');assert.match(f.view.message,/設定已更新/);assert.equal(f.data.size,0);
});
