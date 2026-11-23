// Проверяем цикл агента с настоящими инструментами и «притворным» пулом моделей.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApprovals } from '../src/agent/approvals.js';
import { normalizeAgent } from '../src/agent/agents-store.js';
import { needsApproval, runAgent } from '../src/agent/runner.js';
import { createRuns } from '../src/agent/runs.js';
import { TOOLS } from '../src/agent/tools.js';

/** Готовит папки, журнал и очередь разрешений. script — что «ответит модель» по очереди. */
function setup({ script, agentConfig = {} }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'prorab-run-'));
  const workspace = path.join(base, 'ws');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'файл.txt'), 'старый текст');

  const runs = createRuns({ dir: path.join(base, 'runs') });
  const approvals = createApprovals({ runs });
  const seen = []; // что модель получала на каждом шаге
  const pool = {
    async chat({ messages }) {
      seen.push(messages.map((m) => ({ ...m })));
      const next = script.shift();
      assert.ok(next, 'сценарий модели закончился раньше времени');
      return { providerTitle: 'тест', extra: null, toolCalls: [], content: '', ...next };
    },
  };
  const agent = normalizeAgent('тест', { name: 'Тестовый', tools: ['list_files', 'read_file', 'write_file', 'replace_in_file'], ...agentConfig }, 'Инструкция');
  const { id, signal } = runs.create({ agentId: agent.id, agentName: agent.name, task: 'задача' });
  const controller = new AbortController();
  signal.addEventListener('abort', () => controller.abort());
  const start = () =>
    runAgent({ agent, task: 'задача', runId: id, pool, runs, approvals, workspace, backupDir: path.join(base, 'backup'), signal });
  return { base, workspace, runs, approvals, seen, agent, id, start, file: path.join(workspace, 'файл.txt') };
}

const call = (name, args) => ({ toolCalls: [{ id: `c-${name}`, name, args, argsError: null }] });

async function waitFor(check, ms = 2000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('не дождались нужного события');
}

test('чтение файла не требует разрешения; потом модель отвечает', async () => {
  const t = setup({ script: [call('read_file', { path: 'файл.txt' }), { content: 'в файле: старый текст' }] });
  const result = await t.start();
  assert.equal(result.status, 'done');
  assert.equal(result.answer, 'в файле: старый текст');
  // на втором шаге модель получила содержимое файла
  assert.match(t.seen[1].at(-1).content, /старый текст/);
});

test('запись ждёт разрешения; после «Разрешить» файл меняется, а старая версия сохраняется', async () => {
  const t = setup({ script: [call('write_file', { path: 'файл.txt', content: 'новый текст' }), { content: 'готово' }] });
  const running = t.start();

  const pending = await waitFor(() => t.approvals.list()[0]);
  assert.match(pending.title, /Записать файл «файл.txt»/);
  assert.equal(fs.readFileSync(t.file, 'utf8'), 'старый текст'); // пока человек не ответил — ничего не изменилось

  t.approvals.decide(pending.id, true);
  const result = await running;

  assert.equal(result.status, 'done');
  assert.equal(fs.readFileSync(t.file, 'utf8'), 'новый текст');
  assert.equal(fs.readFileSync(path.join(t.base, 'backup', 'файл.txt'), 'utf8'), 'старый текст');
});

test('после «Отклонить» файл не меняется, а модель узнаёт об отказе', async () => {
  const t = setup({ script: [call('write_file', { path: 'файл.txt', content: 'новый текст' }), { content: 'понял, не буду' }] });
  const running = t.start();
  const pending = await waitFor(() => t.approvals.list()[0]);
  t.approvals.decide(pending.id, false);
  await running;

  assert.equal(fs.readFileSync(t.file, 'utf8'), 'старый текст');
  assert.match(t.seen[1].at(-1).content, /Человек отклонил/);
});

test('правка фрагмента: меняет ровно одно вхождение', async () => {
  const t = setup({
    script: [call('replace_in_file', { path: 'файл.txt', old_text: 'старый', new_text: 'новый' }), { content: 'ок' }],
    agentConfig: { mode: 'auto' },
  });
  await t.start();
  assert.equal(fs.readFileSync(t.file, 'utf8'), 'новый текст');
});

test('правка фрагмента: если фрагмент не найден, модель получает понятную ошибку', async () => {
  const t = setup({
    script: [call('replace_in_file', { path: 'файл.txt', old_text: 'нет такого', new_text: 'x' }), { content: 'ок' }],
    agentConfig: { mode: 'auto' },
  });
  await t.start();
  assert.match(t.seen[1].at(-1).content, /не найден/);
  assert.equal(fs.readFileSync(t.file, 'utf8'), 'старый текст');
});

test('режим «auto»: запись без вопросов, но команды всегда с разрешением', () => {
  const manual = { mode: 'manual' };
  const auto = { mode: 'auto' };
  assert.equal(needsApproval(TOOLS.read_file, manual), false);
  assert.equal(needsApproval(TOOLS.write_file, manual), true);
  assert.equal(needsApproval(TOOLS.write_file, auto), false);
  assert.equal(needsApproval(TOOLS.run_command, auto), true);
});

test('агент не может вызвать инструмент, которого нет в его списке', async () => {
  const t = setup({ script: [call('run_command', { command: 'echo привет' }), { content: 'ладно' }] });
  await t.start();
  assert.match(t.seen[1].at(-1).content, /инструмента «run_command» нет/);
  assert.equal(t.approvals.list().length, 0);
});

test('путь за пределами рабочей папки отклоняется, файл снаружи не читается', async () => {
  const t = setup({ script: [call('read_file', { path: '../../etc/passwd' }), { content: 'не вышло' }] });
  await t.start();
  assert.match(t.seen[1].at(-1).content, /выходит за пределы/);
});

test('некорректные аргументы от модели не роняют цикл', async () => {
  const t = setup({
    script: [{ toolCalls: [{ id: 'c1', name: 'read_file', args: {}, argsError: 'аргументы вызова — не корректный JSON' }] }, { content: 'исправлюсь' }],
  });
  const result = await t.start();
  assert.equal(result.status, 'done');
  assert.match(t.seen[1].at(-1).content, /не корректный JSON/);
});

test('если модель просит несколько инструментов, выполняется только первый', async () => {
  const two = {
    toolCalls: [
      { id: 'c1', name: 'list_files', args: {}, argsError: null },
      { id: 'c2', name: 'read_file', args: { path: 'файл.txt' }, argsError: null },
    ],
  };
  const t = setup({ script: [two, { content: 'ок' }] });
  await t.start();
  const assistant = t.seen[1].find((m) => m.role === 'assistant');
  assert.equal(assistant.toolCalls.length, 1);
  assert.equal(assistant.toolCalls[0].name, 'list_files');
});

test('лимит шагов останавливает зациклившегося агента', async () => {
  const script = Array.from({ length: 3 }, () => call('list_files', {}));
  const t = setup({ script, agentConfig: { maxSteps: 3 } });
  const result = await t.start();
  assert.equal(result.status, 'step_limit');
});

test('остановка во время ожидания разрешения: агент прекращает работу, запрос закрывается', async () => {
  const t = setup({ script: [call('write_file', { path: 'файл.txt', content: 'x' }), { content: 'не должно дойти' }] });
  const stopped = t.start().then(() => 'дошёл до конца', (err) => err.name);
  await waitFor(() => t.approvals.list()[0]);
  t.runs.stop(t.id);
  assert.equal(await stopped, 'AbortError');
  assert.equal(t.approvals.list().length, 0);
  assert.equal(fs.readFileSync(t.file, 'utf8'), 'старый текст');
});
