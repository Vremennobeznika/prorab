import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareUserData } from '../src/util/user-data.js';
import { createApp } from '../src/app.js';
import { launch } from '../src/launch.js';
import { loadAgents } from '../src/agent/agents-store.js';
import { fromRoot } from '../src/util/paths.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'prorab-setup-')); }

test('первая установка: конфиг копируется, рабочая папка появляется, личные изменения сохраняются', () => {
  const dir = tmp();
  prepareUserData(dir);
  const conf = path.join(dir, 'config', 'settings.json');
  const original = fs.readFileSync(conf, 'utf8');
  fs.writeFileSync(conf, '{"port":42}');
  prepareUserData(dir);
  assert.equal(fs.readFileSync(conf, 'utf8'), '{"port":42}');
  assert.ok(fs.existsSync(path.join(dir, 'workspace')));
  assert.match(original, /maxConcurrentRuns/);
});

test('в браузере: ключ не выдаётся API и не попадает в providers.json; неправильный запрос отклоняется', async () => {
  const dir = tmp();
  const configs = [
    { id: 'fake', title: 'Тестовая модель', enabled: false, type: 'openai', model: 'fake', baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: 'FAKE_TEST_KEY' },
  ];
  const configFile = path.join(dir, 'providers.json');
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(configFile, JSON.stringify({ providers: configs }));
  const running = await launch({ settings: { workspace: path.join(dir, 'workspace') }, providerConfigs: configs,
    agents: loadAgents(fromRoot('agents')), dataDir: path.join(dir, 'data'), port: 0,
    providerConfigFile: configFile, envFile, env: {} });
  const host = `http://127.0.0.1:${running.port}`;
  const cookie = `prorab_token=${running.token}`;
  const post = (body) => fetch(`${host}/api/settings/provider`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ providerId: 'other', enabled: true })).status, 400);
    assert.equal((await post({ providerId: 'fake', enabled: true })).status, 400);
    assert.equal((await post({ providerId: 'fake', enabled: true, apiKey: 'line\nINJECTION' })).status, 400);
    const response = await post({ providerId: 'fake', enabled: true, apiKey: 'secret_12345' });
    assert.equal(response.status, 200, await response.text());
    const state = await fetch(`${host}/api/state`, { headers: { Cookie: cookie } });
    const json = JSON.stringify(await state.json());
    assert.ok(!json.includes('secret_12345'));
    assert.match(json, /Тестовая модель/);
    assert.ok(!fs.readFileSync(configFile, 'utf8').includes('secret_12345'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8')).values.FAKE_TEST_KEY, 'secret_12345');
    assert.equal(JSON.parse(json).providers[0].credentialSource, 'profile');
    assert.equal((await fetch(`${host}/api/settings/provider`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  } finally {
    running.app.stopAll();
    running.server.closeAllConnections();
    await new Promise((resolve) => running.server.close(resolve));
  }
});

test('без модели задача не принимается и предлагает подключение', () => {
  const dir = tmp();
  const app = createApp({ settings: { workspace: path.join(dir, 'workspace') }, providerConfigs: [], agents: loadAgents(fromRoot('agents')), dataDir: path.join(dir, 'data') });
  assert.throws(() => app.startRun('file-helper', 'прочитай файл'), /Сначала подключите ИИ/);
});
