// Сквозная проверка: настоящий сервер + «притворная» модель + HTTP-запросы, как от страницы.
// Здесь проверяется весь путь: задача → ход работы → разрешение → изменённый файл → журнал,
// а заодно — защита сервера (токен, Host, Origin).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { loadAgents } from '../src/agent/agents-store.js';
import { launch } from '../src/launch.js';
import { fromRoot } from '../src/util/paths.js';
import { demoScript } from '../scripts/lib/demo-script.js';
import { startFakeModel } from '../scripts/lib/fake-model.js';

let fake;
let running;
let base;
let headers;
let dataDir;
let file;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prorab-e2e-'));
  const workspace = path.join(dir, 'workspace');
  dataDir = path.join(dir, 'data');
  fs.mkdirSync(workspace);
  file = path.join(workspace, 'привет.txt');
  fs.writeFileSync(file, 'Первая строка.\n');

  fake = await startFakeModel(demoScript);
  running = await launch({
    settings: { workspace },
    providerConfigs: [
      { id: 'demo', title: 'Демо', type: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${fake.port}/v1`, model: 'demo', privacy: 'local' },
    ],
    agents: loadAgents(fromRoot('agents')),
    dataDir,
    port: 0, // любой свободный порт
  });
  base = `http://127.0.0.1:${running.port}`;
  headers = { Cookie: `prorab_token=${running.token}`, 'Content-Type': 'application/json' };
});

after(async () => {
  running.app.stopAll();
  running.server.closeAllConnections?.();
  await new Promise((resolve) => running.server.close(resolve));
  await fake.close();
});

// ───────── Помощники ─────────
const get = (url) => fetch(base + url, { headers });
const post = (url, body = {}) => fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) });
const state = async () => (await get('/api/state')).json();

async function waitFor(check, ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('не дождались нужного состояния');
}

const nextApproval = () => waitFor(async () => (await state()).approvals[0]);
const statusOf = async (runId) => (await state()).runs.find((r) => r.id === runId)?.status;

async function startRun(task = 'допиши строку в привет.txt') {
  const response = await post('/api/runs', { agentId: 'file-helper', task });
  assert.equal(response.status, 201);
  return (await response.json()).runId;
}

/** Читает поток событий (SSE), пока не придёт «запуск завершён». */
async function readEvents(runId) {
  const response = await get(`/api/runs/${runId}/events`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = new Map();
  let buffer = '';
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const match of buffer.matchAll(/^data: (.*)$/gm)) {
      const event = JSON.parse(match[1]);
      events.set(event.n, event);
    }
    if ([...events.values()].some((e) => e.type === 'run_finished')) break;
  }
  await reader.cancel();
  return [...events.values()].sort((a, b) => a.n - b.n);
}

// ───────── Защита сервера ─────────
test('страница открывается по ссылке с токеном и запоминает его в cookie', async () => {
  const noToken = await fetch(`${base}/`);
  assert.equal(noToken.status, 401);
  assert.match(await noToken.text(), /Нужен вход/);

  const wrong = await fetch(`${base}/?token=неверный`, { redirect: 'manual' });
  assert.equal(wrong.status, 401);

  const login = await fetch(`${base}/?token=${running.token}`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  assert.match(login.headers.get('set-cookie'), /prorab_token=.*HttpOnly.*SameSite=Strict/);

  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Прораб/);
});

test('API без токена закрыт', async () => {
  const response = await fetch(`${base}/api/state`);
  assert.equal(response.status, 401);
});

test('отдаются только файлы страницы, остальное — 404', async () => {
  for (const [url, type] of [['/style.css', 'text/css'], ['/app.js', 'text/javascript'], ['/theme.js', 'text/javascript'], ['/fonts/inter-latin.woff2', 'font/woff2']]) {
    const response = await get(url);
    assert.equal(response.status, 200, url);
    assert.match(response.headers.get('content-type'), new RegExp(type), url);
  }
  assert.equal((await get('/package.json')).status, 404);
  assert.equal((await get('/fonts/../../package.json')).status, 404);
  assert.equal((await get('/.env')).status, 404);
});

test('чужой заголовок Host отклоняется (защита от DNS rebinding)', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: running.port, path: '/api/state', headers: { ...headers, Host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('команды с чужого сайта или не в формате JSON отклоняются', async () => {
  const foreign = await fetch(`${base}/api/stop-all`, { method: 'POST', headers: { ...headers, Origin: 'http://evil.example' }, body: '{}' });
  assert.equal(foreign.status, 403);

  const notJson = await fetch(`${base}/api/stop-all`, { method: 'POST', headers: { Cookie: headers.Cookie, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(notJson.status, 415);
});

// ───────── Главный сценарий ─────────
test('задача → разрешение → файл изменён, старая версия сохранена, журнал полный', async () => {
  const runId = await startRun();

  const approval = await nextApproval();
  assert.match(approval.title, /Записать файл «привет.txt»/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'Первая строка.\n'); // до разрешения файл не тронут
  assert.equal(await statusOf(runId), 'running');

  assert.equal((await post(`/api/approvals/${approval.id}`, { approved: true })).status, 200);
  await waitFor(async () => (await statusOf(runId)) === 'done');

  assert.equal(fs.readFileSync(file, 'utf8'), 'Первая строка.\nЭту строку дописал демонстрационный агент.\n');
  assert.equal(fs.readFileSync(path.join(dataDir, 'backups', runId, 'привет.txt'), 'utf8'), 'Первая строка.\n');

  const types = (await readEvents(runId)).map((e) => e.type);
  for (const expected of ['run_started', 'step', 'model_reply', 'tool_call', 'tool_result', 'approval_requested', 'approval_decided', 'final_answer', 'run_finished']) {
    assert.ok(types.includes(expected), `в журнале нет события «${expected}»`);
  }
  assert.equal((await state()).providers[0].usage.requests > 0, true); // пул учёл запросы
});

test('повторное решение по уже закрытому запросу — ошибка 404', async () => {
  const runId = await startRun();
  const approval = await nextApproval();
  await post(`/api/approvals/${approval.id}`, { approved: false });
  await waitFor(async () => (await statusOf(runId)) === 'done');
  assert.equal((await post(`/api/approvals/${approval.id}`, { approved: true })).status, 404);
});

test('после «Отклонить» файл остаётся прежним', async () => {
  const before = fs.readFileSync(file, 'utf8');
  const runId = await startRun();
  const approval = await nextApproval();
  await post(`/api/approvals/${approval.id}`, { approved: false });
  await waitFor(async () => (await statusOf(runId)) === 'done');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('«Стоп всех» останавливает агента, который ждёт разрешения', async () => {
  const before = fs.readFileSync(file, 'utf8');
  const runId = await startRun();
  await nextApproval();
  assert.equal((await post('/api/stop-all')).status, 200);
  await waitFor(async () => (await statusOf(runId)) === 'stopped');
  assert.equal((await state()).approvals.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('понятные ошибки при неверных данных', async () => {
  const unknown = await post('/api/runs', { agentId: 'нет-такого', task: 'x' });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /Такого агента нет/);

  const empty = await post('/api/runs', { agentId: 'file-helper', task: '   ' });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /Опишите задачу/);
});

test('предел одновременных запусков: лишний запуск отклоняется понятным сообщением', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prorab-cap-'));
  const model = await startFakeModel(demoScript);
  const small = await launch({
    settings: { workspace: dir, maxConcurrentRuns: 1 },
    providerConfigs: [{ id: 'd', title: 'Демо', type: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${model.port}/v1`, model: 'd', privacy: 'local' }],
    agents: loadAgents(fromRoot('agents')),
    dataDir: path.join(dir, 'data'),
    port: 0,
  });
  const smallHeaders = { Cookie: `prorab_token=${small.token}`, 'Content-Type': 'application/json' };
  const send = (task) => fetch(`http://127.0.0.1:${small.port}/api/runs`, { method: 'POST', headers: smallHeaders, body: JSON.stringify({ agentId: 'code-explainer', task }) });
  try {
    fs.writeFileSync(path.join(dir, 'привет.txt'), 'x');
    const first = await send('первая'); // демо-модель просит запись → запуск ждёт разрешения и остаётся «в работе»
    assert.equal(first.status, 201);
    const second = await send('вторая');
    assert.equal(second.status, 429);
    assert.match((await second.json()).error, /Уже идёт 1 из 1/);
  } finally {
    small.app.stopAll();
    small.server.closeAllConnections?.();
    await new Promise((resolve) => small.server.close(resolve));
    await model.close();
  }
});
