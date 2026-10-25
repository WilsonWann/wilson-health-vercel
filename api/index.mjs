import { createApp } from '../src/app.mjs';
import { configFromEnv } from '../src/config.mjs';
let pending;
export function normalizeRoute(raw){
  const u=new URL(raw,'http://localhost');
  const route=u.searchParams.get('__route');
  if(u.pathname==='/api/index'&&route!==null){
    if(!/^[a-z0-9/-]+$/i.test(route))throw new Error('Invalid route');
    u.pathname='/api/'+route;u.searchParams.delete('__route');
  }
  return u.pathname+u.search;
}
export default async function handler(req,res){
  try{
    req.url=normalizeRoute(req.url);
    if(!pending)pending=createApp(configFromEnv()).catch(e=>{pending=undefined;throw e;});
    const app=await pending;return await app.handler(req,res);
  }catch(e){
    console.error('[startup_error]', e instanceof Error ? e.message : String(e));
    if(!res.headersSent)res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify({error:'服務尚未就緒。請查看 Vercel Logs 的 startup_error。',code:'STARTUP_FAILED'}));
  }
}
