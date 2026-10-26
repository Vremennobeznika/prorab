import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createSessions } from '../src/agent/sessions.js';
import { launch } from '../src/launch.js';
import { normalizeAgent, loadAgents } from '../src/agent/agents-store.js';
import { fromRoot } from '../src/util/paths.js';
import { startFakeModel } from '../scripts/lib/fake-model.js';

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prorab-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  return { root, workspace };
}
test('проекты и диалоги: постоянные папки, план, остановленный шаг после перезапуска', (t) => {
  const { root, workspace } = temp(t);
  const options = { dir: path.join(root, 'sessions'), workspace };
  const store = createSessions(options);
  assert.throws(() => store.addProject({ path: '../outside' }), /полный путь/);
  const other = path.join(root, 'other'); fs.mkdirSync(other);
  const project = store.addProject({ path: other });
  assert.equal(store.addProject({ path: other }).id, project.id);
  const session = store.create({ projectId: project.id, agentId: 'a' });
  store.begin(session.id, { runId: 'r1', task: 'Первая задача' });
  store.record(session.id, 'r1', [{ role: 'user', content: 'Первая задача' }, { role: 'assistant', content: 'Ответ' }]);
  assert.throws(() => store.begin(session.id, { runId: 'r2', task: 'Гонка' }), /Дождитесь/);
  store.finish(session.id, 'r1', 'done', 'Ответ');
  store.updatePlan(session.id, [{ text: 'Проверить файлы', status: 'done' }]);
  store.begin(session.id, { runId: 'r2', task: 'Продолжение' });
  const restarted = createSessions(options);
  assert.equal(restarted.get(session.id).activeRunId, null);
  assert.equal(restarted.get(session.id).turns[1].status, 'stopped');
  assert.equal(restarted.get(session.id).plan[0].status, 'done');
  assert.ok(restarted.context(session.id).messages.some((m) => m.content === 'Ответ'));
  assert.match(restarted.context(session.id).messages.at(-1).content, /stopped/);
  assert.equal(restarted.project(project.id).path, fs.realpathSync(other));
  assert.equal('messages' in restarted.visible(restarted.get(session.id)).turns[0], false);
});

test('контекст обрезается только по границам завершённых шагов; повреждённый диалог не игнорируется', (t) => {
  const { root, workspace } = temp(t);
  const options = { dir: path.join(root, 'sessions'), workspace };
  const store = createSessions(options); const session = store.create({ agentId: 'a' });
  for (let i = 0; i < 10; i++) {
    store.begin(session.id, { runId: String(i), task: 'Задача ' + i });
    store.record(session.id, String(i), [{ role: 'user', content: 'Задача ' + i }, { role: 'assistant', content: 'Ответ ' + i }]);
    store.finish(session.id, String(i), 'done', 'Ответ ' + i);
  }
  const context = store.context(session.id);
  assert.equal(context.omittedTurns, 2); assert.equal(context.messages.length, 16);
  assert.equal(context.messages[0].content, 'Задача 2');
  fs.writeFileSync(path.join(options.dir, session.id + '.session.json'), '{broken');
  assert.throws(() => createSessions(options), /JSON/);
});

test('HTTP: продолжение диалога с полными tool-результатами и проектом переживает перезапуск', async (t) => {
  const { root, workspace } = temp(t);
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'Первый проект');
  const other = path.join(root, 'другой проект'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'a.txt'), 'Второй проект');
  const fake = await startFakeModel((messages) => {
    const last = messages.at(-1);
    if (last.role === 'tool') return { content: 'Запомнил: ' + last.content };
    if (last.content === 'Прочитай файл') return { toolCall: { name: 'read_file', args: { path: 'a.txt' } } };
    return { content: 'Продолжаю: ' + messages.filter((m) => m.role === 'tool').map((m) => m.content).join(', ') };
  });
  const config = { settings: { workspace }, agents: [normalizeAgent('a', { name: 'Тест', tools: ['read_file'] }, 'Отвечай')],
    providerConfigs: [{ id: 'f', type: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${fake.port}/v1`, model: 'default', privacy: 'local' }, { id: 'chosen', type: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${fake.port}/v1`, model: 'explicit', privacy: 'local' }], dataDir: path.join(root, 'data'), port: 0 };
  let server = await launch(config);
  async function close() { server.app.stopAll(); server.server.closeAllConnections?.(); await new Promise((resolve) => server.server.close(resolve)); }
  t.after(async () => { await close(); await fake.close(); });
  const request = (url, body) => fetch(`http://127.0.0.1:${server.port}${url}`, { headers: { Cookie: `prorab_token=${server.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const project = await (await request('/api/projects', { path: other })).json();
  const session = await (await request('/api/sessions', { agentId: 'a', projectId: project.id, providerId: 'chosen' })).json();
  async function send(task) {
    const response = await request(`/api/sessions/${session.id}/messages`, { task }); assert.equal(response.status, 201);
    const { runId } = await response.json();
    for (let i = 0; i < 200; i++) {
      if (server.app.runs.get(runId).status !== 'running') return server.app.runs.get(runId);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('не дождались ответа');
  }
  assert.match((await send('Прочитай файл')).answer, /Второй проект/);
  await close(); server = await launch(config);
  const continued = await send('Что было в файле?');
  assert.match(continued.answer, /Второй проект/);
  assert.doesNotMatch(continued.answer, /Первый проект/);
  assert.equal(fake.requests.at(-1).model, 'explicit');
  const messages = fake.requests.at(-1).messages;
  assert.equal(messages.filter((m) => m.role === 'tool').length, 1);
  assert.equal(messages.filter((m) => m.role === 'assistant' && m.tool_calls).length, 1);
  const visible = await (await request(`/api/sessions/${session.id}`)).json(); assert.equal(visible.turns.length, 2);
});

test('делегирование: отдельный запуск, только чтение и ответ специалиста поступает основному агенту', async (t) => {
  const { root, workspace } = temp(t);
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'Не менять');
  let childTools;
  const fake = await startFakeModel((messages, tools) => {
    const system = messages[0].content;
    if (system.includes('Ревью кода')) {
      childTools = tools.map((tool) => tool.function.name);
      return { content: 'Независимая проверка завершена' };
    }
    const results = messages.filter((m) => m.role === 'tool');
    if (results.length === 0) return { toolCall: { name: 'update_plan', args: { steps: [{ text: 'Проверить проект', status: 'in_progress' }] } } };
    if (results.length === 1) return { toolCall: { name: 'delegate_agent', args: { agentId: 'code-reviewer', task: 'Проверь проект' } } };
    return { content: 'Учтено: ' + results.at(-1).content };
  });
  const server = await launch({ settings: { workspace }, agents: loadAgents(fromRoot('agents')),
    providerConfigs: [{ id: 'f', type: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${fake.port}/v1`, model: 'f' }], dataDir: path.join(root, 'data'), port: 0 });
  t.after(async () => { server.app.stopAll(); server.server.closeAllConnections?.(); await new Promise((resolve) => server.server.close(resolve)); await fake.close(); });
  const session = server.app.sessions.create({ agentId: 'file-helper' });
  const id = server.app.startRun('file-helper', 'Проверь проект', { sessionId: session.id });
  for (let i = 0; i < 200 && server.app.runs.get(id).status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(server.app.runs.get(id).status, 'done');
  assert.match(server.app.runs.get(id).answer, /Независимая проверка завершена/);
  assert.ok(childTools.includes('read_file')); assert.ok(!childTools.includes('write_file')); assert.ok(!childTools.includes('delegate_agent')); assert.ok(!childTools.includes('run_command'));
  assert.equal(server.app.sessions.get(session.id).plan[0].status, 'in_progress');
  assert.equal(server.app.runs.list().filter((r) => r.parentRunId === id).length, 1);
  assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'Не менять');
});

test('остановка диалога снимает блокировку; продолжение помнит задачу без незакрытых tool calls', async (t) => {
  const { root, workspace } = temp(t);
  const fake = await startFakeModel((messages) => {
    if (messages.at(-1).content === 'Создай файл') return { toolCall: { name: 'write_file', args: { path: 'unsafe.txt', content: 'Нет разрешения' } } };
    return { content: 'Продолжаю после остановки' };
  });
  const server = await launch({ settings: { workspace }, agents: loadAgents(fromRoot('agents')),
    providerConfigs: [{ id: 'f', type: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${fake.port}/v1`, model: 'f' }], dataDir: path.join(root, 'data'), port: 0 });
  t.after(async () => { server.app.stopAll(); server.server.closeAllConnections?.(); await new Promise((resolve) => server.server.close(resolve)); await fake.close(); });
  const session = server.app.sessions.create({ agentId: 'file-helper' });
  const first = server.app.startRun('file-helper', 'Создай файл', { sessionId: session.id });
  for (let i = 0; i < 200 && server.app.approvals.list().length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(server.app.approvals.list().length, 1);
  assert.throws(() => server.app.startRun('file-helper', 'Гонка', { sessionId: session.id }), /Дождитесь/);
  server.app.runs.stop(first);
  for (let i = 0; i < 200 && server.app.runs.get(first).status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(server.app.runs.get(first).status, 'stopped');
  assert.equal(server.app.sessions.get(session.id).activeRunId, null);
  const second = server.app.startRun('file-helper', 'Продолжи', { sessionId: session.id });
  for (let i = 0; i < 200 && server.app.runs.get(second).status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const messages = fake.requests.at(-1).messages;
  assert.ok(messages.some((m) => m.role === 'user' && m.content === 'Создай файл'));
  assert.ok(!messages.some((m) => m.tool_calls));
  assert.ok(!fs.existsSync(path.join(workspace, 'unsafe.txt')));
  assert.equal(server.app.runs.get(second).status, 'done');
});
