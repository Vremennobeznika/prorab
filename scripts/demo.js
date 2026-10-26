// Демо без настоящих моделей: npm run demo
// Запускает «притворную» модель и Прораба, чтобы вы могли пощёлкать по интерфейсу:
// поставить задачу, увидеть ход работы и разрешить или отклонить запись файла (в том числе с телефона: --lan).
import fs from 'node:fs';
import path from 'node:path';
import { loadAgents } from '../src/agent/agents-store.js';
import { launch } from '../src/launch.js';
import { openBrowser } from '../src/util/open-browser.js';
import { fromRoot } from '../src/util/paths.js';
import { demoScript } from './lib/demo-script.js';
import { startFakeModel } from './lib/fake-model.js';

const lan = process.argv.includes('--lan');
const portIndex = process.argv.indexOf('--port');
const port = portIndex === -1 ? 7777 : Number(process.argv[portIndex + 1]);

// У демо своя папка данных и своя рабочая папка — настоящие запуски и файлы не затрагиваются.
const dataDir = fromRoot('data', 'demo');
const workspace = path.join(dataDir, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
fs.copyFileSync(fromRoot('workspace', 'привет.txt'), path.join(workspace, 'привет.txt'));

const fake = await startFakeModel(demoScript);
const providerConfigs = [
  {
    id: 'demo',
    title: 'Демо-модель (притворяется ИИ)',
    type: 'openai',
    enabled: true,
    baseUrl: `http://127.0.0.1:${fake.port}/v1`,
    model: 'demo',
    privacy: 'local',
    note: 'Заранее написанный сценарий вместо настоящей модели — только для демонстрации.',
  },
];

try {
  const running = await launch({
    settings: { port, workspace },
    providerConfigs,
    agents: loadAgents(fromRoot('agents')),
    dataDir,
    lan,
    port,
  });

  console.log('\nДЕМО-режим: вместо настоящей модели отвечает заранее написанный сценарий.\n');
  console.log(`Откройте на этом компьютере:\n  ${running.localUrl}\n`);
  for (const url of running.lanUrls) console.log(`На телефоне (та же Wi-Fi сеть):\n  ${url}\n`);
  console.log('Выберите агента «Помощник по файлам», напишите любую задачу и нажмите «Запустить».');
  console.log('Остановить: Ctrl+C\n');
  openBrowser(running.localUrl);

  process.on('SIGINT', async () => {
    running.app.stopAll();
    running.server.close();
    await fake.close();
    process.exit(0);
  });
} catch (err) {
  await fake.close();
  console.error(err.code === 'EADDRINUSE' ? 'Порт занят. Попробуйте: npm run demo -- --port 7778' : `Не удалось запустить демо: ${err.message}`);
  process.exit(1);
}
