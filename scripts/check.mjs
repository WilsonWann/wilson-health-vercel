import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
for(const dir of ['src','api','scripts','public'])for(const f of readdirSync(dir))if(/\.(m?js)$/.test(f))execFileSync(process.execPath,['--check',`${dir}/${f}`],{stdio:'inherit'});
console.log('Syntax checks passed. No database was accessed and no LINE message was sent.');
