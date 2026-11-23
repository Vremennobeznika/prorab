import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createMemory, recallContext, searchRecords } from '../src/agent/memory.js';
import { suggestMemories } from '../src/agent/learning.js';
import { createSessions } from '../src/agent/sessions.js';
import { createRuns } from '../src/agent/runs.js';
import { TOOLS } from '../src/agent/tools.js';
import { loadAgents, normalizeAgent } from '../src/agent/agents-store.js';
import { fromRoot } from '../src/util/paths.js';
import { launch } from '../src/launch.js';
import { startFakeModel } from '../scripts/lib/fake-model.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prorab-upgrade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const file = path.join(dir, 'memory.json');
  return { dir, workspace, file, memory: createMemory({ file }), runs: createRuns({ dir: path.join(dir, 'runs') }) };
}
test('legacy notes remain readable without rewriting; project, pending and privacy boundaries precede search', (t) => {
  const { file, workspace, memory, runs } = fixture(t);
  const legacy = { version: 1, notes: [{ id: 'legacy', text: 'Общее предпочтение', pinned: true, localOnly: false, updatedAt: '2026-01-01' }] };
  fs.writeFileSync(file, JSON.stringify(legacy)); const before = fs.readFileSync(file, 'utf8');
  memory.put({ text: 'Секрет проекта', workspacePath: workspace, localOnly: true });
  memory.put({ text: 'Другой проект', workspacePath: path.join(workspace, 'other'), localOnly: false });
  memory.put({ text: 'Непроверенная догадка', workspacePath: workspace, status: 'pending', localOnly: false });
  assert.match(before, /legacy/);
  const cloud = recallContext({ memory, runs, workspacePath: workspace, task: 'проект', agent: { id: 'a', localOnly: false } });
  assert.deepEqual(cloud.map((n) => n.id), ['legacy']);
  const local = recallContext({ memory, runs, workspacePath: workspace, task: 'проект', agent: { id: 'a', localOnly: true } });
  assert.equal(local.length, 2);
  assert.ok(!JSON.stringify(local).includes('Другой проект'));
});
test('suggestions: deduplication, explicit acceptance, conflict replacement and restart', (t) => {
  const { memory, file, workspace } = fixture(t);
  const old = memory.put({ text: 'Использовать Node 20', topic: 'Node', workspacePath: workspace });
  const pending = memory.put({ text: 'Использовать Node 22', topic: 'Node', workspacePath: workspace, status: 'pending' });
  assert.equal(memory.put({ text: ' использовать NODE 22 ', topic: 'Node', workspacePath: workspace, status: 'pending' }).id, pending.id);
  assert.deepEqual(memory.conflicts(pending), [old.id]);
  const other = memory.put({ text: 'Другая область', workspacePath: path.join(workspace, 'other') });
  assert.throws(() => memory.resolve({ id: pending.id, action: 'accept', replaceId: other.id }), /другой области/);
  memory.resolve({ id: pending.id, action: 'accept', replaceId: old.id });
  const reopened = createMemory({ file });
  assert.equal(reopened.list().find((n) => n.id === old.id).status, 'archived');
  assert.equal(reopened.list().find((n) => n.id === pending.id).status, 'accepted');
  assert.throws(() => reopened.resolve({ id: pending.id, action: 'reject' }), /уже обработано/);
  const rejected = memory.put({ text: 'Не использовать', status: 'pending' });
  memory.resolve({ id: rejected.id, action: 'reject' });
  assert.ok(!memory.constraints(workspace, true, 'a').some((n) => n.id === rejected.id));
  assert.throws(() => memory.put({ text: 'x', pathPrefix: '../outside' }), /внутри проекта/);
});
test('local retrieval ranks exact matches and recognizes limited synonyms without a remote model', () => {
  const records = ['Цена подписки', 'Стоимость подписки и подробный длинный дополнительный текст', 'Погода'];
  assert.equal(searchRecords(records, 'цена подписки', (x) => x)[0], records[0]);
  assert.deepEqual(searchRecords(['Картинка моста', 'Прогноз'], 'изображение', (x) => x), ['Картинка моста']);
  assert.deepEqual(searchRecords(records, 'абракадабра', (x) => x), []);
});
test('learning rejects ungrounded candidates and recognizable credentials; honors model/privacy selection', async () => {
  let request;
  const notes = [
    { text: 'Использовать Node 22', kind: 'decision', topic: 'Node', evidence: 'Использовать Node 22' },
    { text: 'Выдуманный факт', kind: 'fact', topic: '', evidence: 'Несуществующая цитата' },
    { text: 'api_key: secret-value', kind: 'fact', topic: '', evidence: 'api_key: secret-value' },
  ];
  const result = await suggestMemories({ pool: { chat: async (r) => { request = r; return { content: JSON.stringify({ notes }) }; } },
    task: 'Использовать Node 22. api_key: secret-value', answer: 'Хорошо', agent: { models: ['chosen'], localOnly: true }, signal: AbortSignal.timeout(1000) });
  assert.equal(result.length, 1); assert.deepEqual(request.chain, ['chosen']); assert.equal(request.localOnly, true);
});
test('old dialog decisions survive in a bounded extractive summary without orphaned tool calls', (t) => {
  const { dir, workspace } = fixture(t); const sessions = createSessions({ dir: path.join(dir, 'sessions'), workspace });
  const session = sessions.create({ agentId: 'a' });
  for (let i = 0; i < 14; i++) {
    sessions.begin(session.id, { runId: 'r' + i, task: i === 0 ? 'Решение: не менять формат JSON' : 'Шаг ' + i });
    sessions.record(session.id, 'r' + i, [{ role: 'user', content: 'Шаг ' + i }, { role: 'assistant', content: 'Ответ ' + i }]);
    sessions.finish(session.id, 'r' + i, 'done', 'Подтверждённый ответ ' + i);
  }
  const result = sessions.context(session.id, { includeSummary: true });
  assert.match(result.summary, /не менять формат JSON/); assert.match(result.summary, /r0/);
  assert.ok(JSON.stringify(result.messages).length < 48000);
  assert.equal(sessions.get(session.id).turns.length, 14);
});
test('symbol retrieval returns declaration locations and sees file changes immediately', async (t) => {
  const { workspace } = fixture(t); const file = path.join(workspace, 'a.js');
  fs.writeFileSync(file, 'function calculate() {}\ncalculate();\n');
  const search = () => TOOLS.search_files.run({ query: 'calculate', mode: 'symbols' }, { workspace });
  assert.deepEqual(JSON.parse(await search()).hits.map((h) => h.line), [1]);
  fs.writeFileSync(file, 'calculate();\n'); assert.deepEqual(JSON.parse(await search()).hits, []);
});
test('HTTP learning is opt-in, scoped, reviewable, protected and never auto-recalled', async (t) => {
  const { dir, workspace } = fixture(t);
  const fake = await startFakeModel((messages) => messages[0].content.includes('Выдели до 4')
    ? { content: JSON.stringify({ notes: [{ text: 'Использовать Node 22', kind: 'decision', topic: 'Node', evidence: 'Использовать Node 22' }] }) }
    : { content: 'Использовать Node 22' });
  const running = await launch({ settings: { workspace }, agents: loadAgents(fromRoot('agents')),
    providerConfigs: [{ id: 'f', enabled: true, type: 'openai', baseUrl: `http://127.0.0.1:${fake.port}/v1`, model: 'f' }], dataDir: path.join(dir, 'data'), port: 0 });
  t.after(async () => { running.app.stopAll(); running.server.closeAllConnections(); await new Promise((r) => running.server.close(r)); await fake.close(); });
  const base = `http://127.0.0.1:${running.port}`;
  const headers = { Cookie: `prorab_token=${running.token}`, 'Content-Type': 'application/json' };
  const post = (url, body) => fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post('/api/runs', { agentId: 'file-helper', task: 'Использовать Node 22', learnMemory: true })).status, 400);
  const id = (await (await post('/api/runs', { agentId: 'file-helper', task: 'Использовать Node 22', useMemory: true, learnMemory: true })).json()).runId;
  for (let i = 0; i < 200 && running.app.runs.get(id).status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(running.app.runs.get(id).status, 'done');
  const note = running.app.memory.list()[0]; assert.equal(note.status, 'pending'); assert.equal(note.workspacePath, workspace);
  assert.equal(note.evidence, 'Использовать Node 22');
  assert.equal((await fetch(base + '/api/memory/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: note.id, action: 'accept' }) })).status, 401);
  assert.equal((await post('/api/memory/resolve', { id: note.id, action: 'accept' })).status, 200);
  const accepted = running.app.memory.list()[0]; assert.equal(accepted.status, 'accepted'); assert.equal(accepted.localOnly, true);
  assert.equal(running.app.runs.events(id).filter((e) => e.type === 'memory_suggested').length, 1);
});
test('project constraints are read before writing and cannot authorize a write; separate reviewer cannot write', async (t) => {
  const { dir, workspace } = fixture(t); let reviewerTools;
  const fake = await startFakeModel((messages, tools) => {
    if (messages[0].content.includes('Ревью кода')) { reviewerTools = tools.map((x) => x.function.name); return { content: 'Прочитано: критерии не проверены командами' }; }
    const results = messages.filter((m) => m.role === 'tool');
    if (results.length < 2) return { toolCall: { name: 'write_file', args: { path: 'docs/a.txt', content: 'Документ' } } };
    return { content: 'Документ записан' };
  });
  const agents = loadAgents(fromRoot('agents'));
  agents.push(normalizeAgent('writer', { name: 'Автор', tools: ['write_file'], mode: 'auto' }, 'Пиши'));
  const running = await launch({ settings: { workspace }, agents,
    providerConfigs: [{ id: 'f', enabled: true, type: 'openai', baseUrl: `http://127.0.0.1:${fake.port}/v1`, model: 'f' }], dataDir: path.join(dir, 'data'), port: 0 });
  t.after(async () => { running.app.stopAll(); running.server.closeAllConnections(); await new Promise((r) => running.server.close(r)); await fake.close(); });
  running.app.memory.put({ text: 'Сохраняй формат текста', kind: 'constraint', pathPrefix: 'docs', workspacePath: workspace, localOnly: false });
  const id = running.app.startRun('writer', 'Запиши документ', { useMemory: true, verifyResult: true });
  for (let i = 0; i < 200 && running.app.runs.get(id).status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(running.app.runs.get(id).status, 'done');
  assert.equal(fs.readFileSync(path.join(workspace, 'docs/a.txt'), 'utf8'), 'Документ');
  assert.equal(running.app.runs.events(id).filter((e) => e.type === 'memory_constraints').length, 1);
  assert.match(running.app.runs.get(id).answer, /Отдельная проверка/);
  assert.ok(reviewerTools.includes('read_file')); assert.ok(!reviewerTools.includes('write_file')); assert.ok(!reviewerTools.includes('run_command'));
});
