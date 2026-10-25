// Used only by local development/tests. Never used on Vercel.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
export function localClient(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), {recursive:true, mode:0o700});
  const db=new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  if(path!==':memory:') chmodSync(path,0o600);
  function executeSync(input) {
    const {sql,args=[]}=typeof input==='string'?{sql:input}:input;
    const statement=db.prepare(sql), columns=statement.columns().map(c=>c.name);
    if(columns.length) {
      const rows=statement.all(...args);
      const changes=/^\s*(SELECT|PRAGMA)/i.test(sql)?0:Number(db.prepare('SELECT changes() AS n').get().n);
      return {rows:rows.map(r=>({...r})),columns,rowsAffected:changes};
    }
    const r=statement.run(...args);return {rows:[],columns:[],rowsAffected:Number(r.changes)};
  }
  return {
    async execute(input){return executeSync(input);},
    async batch(inputs,mode='write') {
      db.exec(mode==='write'?'BEGIN IMMEDIATE':'BEGIN');
      try {const results=inputs.map(executeSync);db.exec('COMMIT');return results;}
      catch(e){db.exec('ROLLBACK');throw e;}
    },
    close(){db.close();}
  };
}
