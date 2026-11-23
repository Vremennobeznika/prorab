import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {launch} from '../src/launch.js';
import {loadAgents} from '../src/agent/agents-store.js';
import {fromRoot} from '../src/util/paths.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prorab-perf-'));
const running=await launch({settings:{workspace:path.join(dir,'workspace'),port:0},providerConfigs:[],agents:loadAgents(fromRoot('agents')),dataDir:path.join(dir,'data'),port:0});
const url=`http://127.0.0.1:${running.port}/api/state`;
const measure=async n=>{const t=performance.now(); const batches=await Promise.all(Array.from({length:n},async()=>{const s=performance.now();const r=await fetch(url,{headers:{Cookie:`prorab_token=${running.token}`}});await r.arrayBuffer();return {ms:performance.now()-s,status:r.status}}));const lat=batches.map(x=>x.ms).sort((a,b)=>a-b);return {requests:n,elapsedMs:Math.round(performance.now()-t),p50Ms:Math.round(lat[Math.floor(n*.5)]),p95Ms:Math.round(lat[Math.min(n-1,Math.floor(n*.95))]),maxMs:Math.round(lat.at(-1)),errors:batches.filter(x=>x.status!==200).length};};
try {for(const n of [1,10,50,100,250])console.log(JSON.stringify(await measure(n)));}finally{running.app.stopAll();await new Promise(r=>running.server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
