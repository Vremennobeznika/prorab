// Проверяет реальный запуск проекта из защищённого каталога с данными пользователя отдельно.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'prorab-installed-'));
const ready=path.join(data,'ready.json');
const child=spawn(process.execPath,[path.join(root,'src','main.js'),'--port','0','--no-open','--ready-file',ready],
 {cwd:root,env:{...process.env,PRORAB_USER_DIR:data},stdio:['ignore','pipe','pipe']});
let stdErr=''; child.stderr.on('data',(b)=>stdErr+=b);
try {
  let ok=false;
  for(let i=0;i<100;i++) {
    if(fs.existsSync(ready)){ok=true;break;}
    if(child.exitCode!==null)break;
    await new Promise(r=>setTimeout(r,40));
  }
  assert.ok(ok,'готовность не наступила: '+stdErr);
  const info=JSON.parse(fs.readFileSync(ready,'utf8'));
  const response=await fetch(info.url,{redirect:'manual'});
  assert.equal(response.status,302);
  const cookie=response.headers.get('set-cookie')?.split(';')[0];
  const page=await fetch(new URL('/',info.url),{headers:{Cookie:cookie}});
  assert.equal(page.status,200);
  const state=await fetch(new URL('/api/state',info.url),{headers:{Cookie:cookie}});
  assert.equal(state.status,200);
  const json=await state.json();
  assert.equal(json.workspace,path.join(data,'workspace'));
  assert.ok(json.canConfigure);
  assert.ok(fs.existsSync(path.join(data,'config','providers.json')));
  assert.ok(fs.existsSync(path.join(data,'data','token.txt')));
  console.log('PASS: установленный режим, HTTP, данные вне папки приложения, настройки, авторизация');
} finally {
  child.kill('SIGTERM');
  await new Promise(r=>{if(child.exitCode!==null||child.signalCode)r();else child.on('exit',r);});
}
