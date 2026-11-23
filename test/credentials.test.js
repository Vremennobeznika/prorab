import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { createCredentials } from '../src/util/credentials.js';
import { launch } from '../src/launch.js';
import { loadAgents } from '../src/agent/agents-store.js';
import { fromRoot } from '../src/util/paths.js';

function profile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prorab-key-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('credentials: exact round-trip including #, quotes and backslashes; legacy .env remains usable', (t) => {
  const dir = profile(t); const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'LEGACY_KEY=old\n');
  const key = 'dummy#with"quotes\'and\\slashes';
  const store = createCredentials(envFile, { OTHER_KEY: 'environment' });
  assert.equal(store.environment().LEGACY_KEY, 'old');
  assert.equal(store.source('OTHER_KEY'), 'environment');
  store.put('LEGACY_KEY', key);
  const restarted = createCredentials(envFile, { LEGACY_KEY: 'stale-environment' });
  assert.equal(restarted.environment().LEGACY_KEY, key);
  assert.equal(restarted.source('LEGACY_KEY'), 'profile');
  assert.equal(fs.readFileSync(envFile, 'utf8'), 'LEGACY_KEY=old\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'credentials.json')).mode & 0o777, 0o600);
});
test('credentials: failed write and corrupt file report failure without overwriting existing data', (t) => {
  const dir = profile(t); const envFile = path.join(dir, '.env');
  const store = createCredentials(envFile, {});
  fs.mkdirSync(path.join(dir, 'credentials.json'));
  assert.throws(() => store.put('TEST_KEY', 'dummy'), /не сохранён/);
  assert.equal(store.source('TEST_KEY'), null);
  fs.rmdirSync(path.join(dir, 'credentials.json'));
  fs.writeFileSync(path.join(dir, 'credentials.json'), '{broken');
  assert.throws(() => createCredentials(envFile, {}), /не изменены/);
  assert.equal(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'), '{broken');
});
test('saved key survives application restart, authenticates a model request and never returns through state', async (t) => {
  const dir = profile(t); let authorization;
  const model = http.createServer((req, res) => {
    authorization = req.headers.authorization;
    req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'Подключение работает' } }] })); });
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  const configFile = path.join(dir, 'providers.json');
  const options = { settings: { workspace: path.join(dir, 'workspace') }, agents: loadAgents(fromRoot('agents')), dataDir: path.join(dir, 'data'), env: {},
    providerConfigFile: configFile, envFile: path.join(dir, '.env'), port: 0 };
  const configs = [{ id: 'custom', type: 'openai', enabled: false, apiKeyEnv: 'TEST_MODEL_KEY', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'test' }];
  fs.writeFileSync(configFile, JSON.stringify({ providers: configs }));
  let app = await launch({ ...options, providerConfigs: configs });
  const close = async () => { app.app.stopAll(); app.server.closeAllConnections?.(); await new Promise((resolve) => app.server.close(resolve)); };
  t.after(async () => { await close(); model.closeAllConnections?.(); await new Promise((resolve) => model.close(resolve)); });
  const key = 'dummy-model-key#with-suffix';
  const response = await fetch(`http://127.0.0.1:${app.port}/api/settings/provider`, { method: 'POST', headers: { Cookie: `prorab_token=${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: 'custom', enabled: true, apiKey: key }) });
  assert.equal(response.status, 200);
  await close();
  app = await launch({ ...options, providerConfigs: JSON.parse(fs.readFileSync(configFile)).providers });
  assert.equal(app.app.state().providers[0].credentialSource, 'profile');
  assert.ok(!JSON.stringify(app.app.state()).includes(key));
  const id = app.app.startRun('general-assistant', 'Ответь');
  for (let i = 0; i < 100 && app.app.runs.get(id).status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(app.app.runs.get(id).status, 'done');
  assert.equal(authorization, 'Bearer ' + key);
  assert.ok(!fs.readFileSync(configFile, 'utf8').includes(key));
});
