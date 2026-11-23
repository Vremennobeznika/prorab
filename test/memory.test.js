import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createMemory, recallContext, searchRecords } from '../src/agent/memory.js';
import { createRuns } from '../src/agent/runs.js';
import { launch } from '../src/launch.js';
import { normalizeAgent } from '../src/agent/agents-store.js';
import { startFakeModel } from '../scripts/lib/fake-model.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prorab-memory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'memory.json');
  return { dir, file, memory: createMemory({ file }), runs: createRuns({ dir: path.join(dir, 'runs') }) };
}

test('память: создание, изменение и удаление переживают перезапуск, источник сохраняется', (t) => {
  const { file, memory } = fixture(t);
  const note = memory.put({ text: 'Отвечать кратко', sourceRunId: 'run-1', pinned: true });
  assert.equal(createMemory({ file }).list()[0].text, note.text);
  memory.put({ id: note.id, text: 'Отвечать подробно', pinned: false });
  assert.equal(memory.list().length, 1);
  assert.equal(memory.list()[0].sourceRunId, 'run-1');
  assert.equal(memory.list()[0].pinned, false);
  memory.remove(note.id);
  assert.deepEqual(createMemory({ file }).list(), []);
  assert.throws(() => memory.put({ id: note.id, text: 'нет' }), /не найдена/);
  assert.throws(() => memory.put({ text: ' ' }), /2000/);
  assert.throws(() => memory.put({ text: 'а'.repeat(2001) }), /2000/);
});

test('поиск: русский текст, ё/е, отсутствие совпадений и порядок релевантности', () => {
  const records = ['Отчёт продажи', 'Продажи за июнь', 'Погода в Москве'];
  assert.deepEqual(searchRecords(records, 'отчет продажи', (x) => x), records.slice(0, 2));
  assert.deepEqual(searchRecords(records, 'библиотека', (x) => x), []);
  assert.deepEqual(searchRecords(records, 'для что', (x) => x), []);
});

test('история: поиск за пределами 50 карточек, только успешные, отказ от памяти сохраняется', (t) => {
  const { dir, runs } = fixture(t);
  const old = runs.create({ agentId: 'a', task: 'Редкий документ', useMemory: true, localOnly: false });
  runs.finish(old.id, 'done', { answer: 'Старое решение документа' });
  for (let i = 0; i < 55; i++) {
    const run = runs.create({ agentId: 'a', task: `погода ${i}` });
    runs.finish(run.id, 'failed', { answer: 'Редкий документ' });
  }
  assert.equal(runs.search('редкий')[0].id, old.id);
  assert.equal(runs.search('редкий', { forContext: true })[0].id, old.id);
  runs.forget(old.id);
  const restarted = createRuns({ dir: path.join(dir, 'runs') });
  assert.deepEqual(restarted.search('редкий', { forContext: true }), []);
  assert.equal(restarted.search('редкий')[0].id, old.id); // журнал остаётся доступным человеку
});

test('контекст: локальные данные закрыты облачным агентам, чужие агенты и старые запуски исключены', (t) => {
  const { memory, runs } = fixture(t);
  memory.put({ text: 'Локальная тайна', localOnly: true });
  memory.put({ text: 'Общее предпочтение', localOnly: false });
  for (const config of [
    { agentId: 'a', localOnly: true, useMemory: true },
    { agentId: 'b', localOnly: false, useMemory: true },
    { agentId: 'a', localOnly: false, useMemory: false },
  ]) {
    const r = runs.create({ ...config, task: 'Редкий документ' });
    runs.finish(r.id, 'done', { answer: 'Секретное решение' });
  }
  const cloud = recallContext({ memory, runs, task: 'Редкий документ', agent: { id: 'a', localOnly: false } });
  assert.equal(cloud.length, 1);
  assert.equal(cloud[0].text, 'Общее предпочтение');
  const local = recallContext({ memory, runs, task: 'Редкий документ', agent: { id: 'a', localOnly: true } });
  assert.equal(local.length, 3);
});

test('контекст ограничен, неподходящие заметки не подставляются', (t) => {
  const { memory, runs } = fixture(t);
  memory.put({ text: 'Совершенно другая тема', localOnly: false, pinned: false });
  assert.deepEqual(recallContext({ memory, runs, task: 'Бухгалтерия', agent: { id: 'a' } }), []);
  for (let i = 0; i < 8; i++) memory.put({ text: `Предпочтение ${i} ` + 'а'.repeat(1800), localOnly: false });
  const context = recallContext({ memory, runs, task: 'Бухгалтерия', agent: { id: 'a' } });
  assert.ok(context.length > 0 && context.length <= 5);
  assert.ok(JSON.stringify(context).length <= 5600);
});

test('повреждённая память сообщает ошибку и не перезаписывается', (t) => {
  const { file, memory } = fixture(t);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => memory.list(), /Память недоступна/);
  assert.throws(() => memory.put({ text: 'Новая заметка' }), /Память недоступна/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('HTTP → память → реальный запрос к модели; перезапуск, удаление, Origin и локальные источники', async (t) => {
  const { dir, file } = fixture(t);
  const fake = await startFakeModel(() => ({ content: 'Решение: отчёт продаж готов' }));
  const agent = normalizeAgent('helper', { name: 'Помощник', tools: [] }, 'Помогай пользователю');
  const config = { settings: { workspace: path.join(dir, 'workspace') },
    providerConfigs: [{ id: 'fake', type: 'openai', enabled: true, privacy: 'local', baseUrl: `http://127.0.0.1:${fake.port}/v1`, model: 'fake' }],
    agents: [agent], dataDir: dir, port: 0 };
  let running = await launch(config);
  async function close() {
    running.app.stopAll(); running.server.closeAllConnections?.();
    await new Promise((resolve) => running.server.close(resolve));
  }
  t.after(async () => { await close(); await fake.close(); });
  const headers = () => ({ Cookie: `prorab_token=${running.token}`, 'Content-Type': 'application/json' });
  const request = (url, body) => fetch(`http://127.0.0.1:${running.port}${url}`, {
    headers: headers(), ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  async function run(useMemory, criteria = '') {
    const response = await request('/api/runs', { agentId: agent.id, task: 'Подготовь отчёт продаж', useMemory, criteria });
    assert.equal(response.status, 201);
    const { runId } = await response.json();
    for (let i = 0; i < 200; i++) {
      if (running.app.runs.get(runId).status === 'done') return runId;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('задание не завершилось');
  }
  assert.equal((await fetch(`http://127.0.0.1:${running.port}/api/memory`)).status, 401);
  const foreign = await fetch(`http://127.0.0.1:${running.port}/api/memory`, {
    method: 'POST', headers: { ...headers(), Origin: 'http://evil.example' }, body: JSON.stringify({ text: 'чужая заметка' }),
  });
  assert.equal(foreign.status, 403);
  const note = await (await request('/api/memory', { text: 'Используй таблицы', localOnly: false })).json();
  await request('/api/memory', { text: 'СЕКРЕТ-ЛОКАЛЬНЫЙ', localOnly: true });
  assert.equal((await request('/api/runs', { agentId: agent.id, task: 'Отчёт', criteria: 'а'.repeat(2001) })).status, 400);
  const withCriteria = await run(false, 'Таблица содержит месяцы и итоги');
  assert.match(fake.requests.at(-1).messages.at(-1).content, /Критерии готовности.*\nТаблица содержит месяцы и итоги/);
  assert.equal(running.app.runs.get(withCriteria).criteria, 'Таблица содержит месяцы и итоги');
  assert.equal(fake.requests.at(-1).messages.length, 2);
  const first = await run(true);
  let sent = fake.requests.at(-1).messages;
  assert.match(sent[1].content, /Используй таблицы/);
  assert.doesNotMatch(JSON.stringify(sent), /СЕКРЕТ-ЛОКАЛЬНЫЙ/);
  assert.equal(sent[0].role, 'system');
  assert.equal(sent[1].role, 'user'); // память не становится системными инструкциями
  assert.equal(sent.at(-1).content, 'Подготовь отчёт продаж');
  await close(); running = await launch(config);
  await run(true);
  sent = fake.requests.at(-1).messages;
  assert.match(sent[1].content, /Решение: отчёт продаж готов/);
  assert.match(sent[1].content, new RegExp(first));
  assert.equal((await request('/api/memory/delete', { id: note.id })).status, 200);
  await run(true);
  assert.doesNotMatch(fake.requests.at(-1).messages[1].content, /Используй таблицы/);
  assert.equal((await request(`/api/runs/${first}/forget`, {})).status, 200);
  assert.equal(running.app.runs.get(first).useMemory, false);
  assert.equal((await (await request(`/api/runs/${first}`)).json()).id, first);
  const source = running.app.runs.create({ agentId: agent.id, task: 'Локальное', localOnly: true });
  running.app.runs.finish(source.id, 'done', { answer: 'локальное' });
  const localNote = await (await request('/api/memory', { text: 'Из локального запуска', sourceRunId: source.id })).json();
  assert.equal((await request('/api/memory', { id: localNote.id, text: 'Обновлено', localOnly: false })).status, 400);
  fs.writeFileSync(file, '{broken');
  const brokenRun = await run(true);
  assert.ok(running.app.runs.events(brokenRun).some((e) => e.type === 'memory_unavailable'));
  assert.equal(fake.requests.at(-1).messages.length, 2);
});
