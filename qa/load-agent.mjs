// Реальная цепочка: HTTP -> App -> агент -> искусственная модель -> журнал -> завершение.
// Никаких внешних API или пользовательских данных. Имитируем задержку модели 40 мс.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from '../src/launch.js';
import { loadAgents } from '../src/agent/agents-store.js';
import { fromRoot } from '../src/util/paths.js';
import { startFakeModel } from '../scripts/lib/fake-model.js';
const t = () => performance.now();
const batches = Math.max(1, Math.min(1000, Number(process.env.PRORAB_BATCHES) || 20));
const pctl = (a,q) => a.slice().sort((x,y)=>x-y)[Math.min(a.length-1,Math.ceil(a.length*q)-1)];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prorab-load-'));
const workspace=path.join(dir,'workspace');fs.mkdirSync(workspace);
const fake=await startFakeModel(()=>({content:'Задача выполнена.',delayMs:40}));
const running=await launch({settings:{workspace,maxConcurrentRuns:3},
  providerConfigs:[{id:'fake',type:'openai',title:'Быстрая тестовая модель',enabled:true,baseUrl:`http://127.0.0.1:${fake.port}/v1`,model:'demo'}],
  agents:loadAgents(fromRoot('agents')),dataDir:path.join(dir,'data'),port:0});
const url=`http://127.0.0.1:${running.port}`;
const headers={Cookie:`prorab_token=${running.token}`,'Content-Type':'application/json'};
const problems=[]; const times=[]; const stateTimes=[];
const before=process.memoryUsage().rss;
try {
  for (let batch=0;batch<batches;batch++) {
    const runningIds=[];
    const start=t();
    const resp=await Promise.all([0,1,2].map(async (i)=>{
      const r=await fetch(url+'/api/runs',{method:'POST',headers,body:JSON.stringify({agentId:'code-explainer',task:`Тест ${batch}-${i}`})});
      if(r.status!==201) problems.push('start '+r.status);return r.json();
    }));
    for(const r of resp)if(r.runId)runningIds.push(r.runId);
    let finished=false;
    for(let attempt=0; attempt<60;attempt++) {
      const ts=t(); const r=await fetch(url+'/api/state',{headers});stateTimes.push(t()-ts);
      if(r.status!==200) problems.push('state '+r.status);
      const data=await r.json();
      const subset=data.runs.filter((x)=>runningIds.includes(x.id));
      if(subset.length===3 && subset.every((x)=>x.status==='done')){finished=true;break;}
      await new Promise((resolve)=>setTimeout(resolve,10));
    }
    if(!finished)problems.push('timeout batch '+batch);
    times.push(t()-start);
  }
  // A finished API run must also be durably recorded on disk.
  let completed=0;
  for (let attempt=0; attempt<30; attempt++) {
    completed=fs.readdirSync(path.join(dir,'data','runs')).filter(n=> {
      if (!n.endsWith('.json')) return false;
      try { return JSON.parse(fs.readFileSync(path.join(dir,'data','runs',n),'utf8')).status==='done'; }
      catch { return false; }
    }).length;
    if (completed===batches*3) break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  if(completed!==batches*3) problems.push(`persisted ${completed}/${batches*3}`);
  const json={runs:batches*3,maxConcurrentRuns:3,modelLatencyMs:40,failures:problems,
    batchMs:{p50:Math.round(pctl(times,.5)),p95:Math.round(pctl(times,.95)),max:Math.round(Math.max(...times))},
    stateLatencyMs:{p50:Math.round(pctl(stateTimes,.5)*10)/10,p95:Math.round(pctl(stateTimes,.95)*10)/10},
    rssIncreaseMB:Math.round((process.memoryUsage().rss-before)/1048576*10)/10,
    completed,
    note:'Результаты конкретного прогона в Linux; не Windows и не внешняя ИИ-модель'};
  console.log(JSON.stringify(json,null,2));
  if(problems.length)process.exitCode=1;
} finally {running.app.stopAll();running.server.closeAllConnections?.();await new Promise(resolve=>running.server.close(resolve));await fake.close();}
