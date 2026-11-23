import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from '../src/launch.js';
import { loadAgents } from '../src/agent/agents-store.js';
import { fromRoot } from '../src/util/paths.js';
import { startFakeModel } from '../scripts/lib/fake-model.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prorab-memory-ui-'));
const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
const fake = await startFakeModel((messages) => {
  if (messages[0].content.includes('Выдели до 4')) return { content: JSON.stringify({ notes: [{ text: 'Использовать Node 22', kind: 'decision', topic: 'Node', evidence: 'Использовать Node 22' }] }) };
  if (messages[0].content.includes('Ревью кода')) return { content: 'Независимая оценка: команды не запускались.' };
  return { content: 'Использовать Node 22' };
});
const running = await launch({ settings: { workspace }, agents: loadAgents(fromRoot('agents')),
  providerConfigs: [{ id: 'fake', title: 'Тестовая модель', enabled: true, type: 'openai', baseUrl: `http://127.0.0.1:${fake.port}/v1`, model: 'test' }], dataDir: path.join(dir, 'data'), port: 0 });
const old = running.app.memory.put({ text: 'Использовать Node 20', kind: 'decision', topic: 'Node', workspacePath: workspace });
console.log(JSON.stringify({ base: `http://127.0.0.1:${running.port}`, token: running.token, workspace, oldId: old.id }));
process.on('SIGTERM', () => { running.app.stopAll(); running.server.closeAllConnections(); running.server.close(); fake.close().then(() => process.exit(0)); });
