import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from '../src/launch.js';
import { loadAgents } from '../src/agent/agents-store.js';
import { fromRoot } from '../src/util/paths.js';
import { demoScript } from '../scripts/lib/demo-script.js';
import { startFakeModel } from '../scripts/lib/fake-model.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prorab-qa-browser-'));
const workspace = path.join(dir, 'workspace');
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'привет.txt'), 'Первая строка.\n');
const fake = await startFakeModel(demoScript);
const running = await launch({ settings: { workspace },
  providerConfigs: [{ id: 'demo', title: 'Демо-модель', type: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${fake.port}/v1`, model: 'demo', privacy: 'local' }],
  agents: loadAgents(fromRoot('agents')), dataDir: path.join(dir, 'data'), port: 0,
});
console.log(JSON.stringify({ base: `http://127.0.0.1:${running.port}`, token: running.token, workspace, dir }));
process.on('SIGTERM', () => { running.app.stopAll(); running.server.closeAllConnections?.(); running.server.close(); fake.close().then(() => process.exit(0)); });
