// Целостность данных: файлы настроек, расход, журнал запусков — что будет при перезапуске и при сбоях.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRuns } from '../src/agent/runs.js';
import { createQuota } from '../src/pool/quota.js';
import { clip, readJson, writeJson } from '../src/util/files.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'prorab-store-'));

test('readJson: BOM из Блокнота Windows не мешает, ошибка JSON называет файл, fallback при отсутствии файла', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'bom.json'), '\uFEFF{"имя": "Прораб"}', 'utf8');
  assert.deepEqual(readJson(path.join(dir, 'bom.json')), { имя: 'Прораб' });

  fs.writeFileSync(path.join(dir, 'битый.json'), '{"a": ', 'utf8');
  assert.throws(() => readJson(path.join(dir, 'битый.json')), /битый\.json.*ошибка в JSON/);

  assert.deepEqual(readJson(path.join(dir, 'нет.json'), { запасной: true }), { запасной: true });
  assert.throws(() => readJson(path.join(dir, 'нет.json')), /Не удалось прочитать/);
});

test('writeJson: записывает целиком, перезаписывает, не оставляет временных файлов', () => {
  const dir = tempDir();
  const file = path.join(dir, 'вложенная', 'папка', 'данные.json');
  writeJson(file, { версия: 1 });
  writeJson(file, { версия: 2, текст: 'привет' });
  assert.deepEqual(readJson(file), { версия: 2, текст: 'привет' });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['данные.json']);
});

test('clip честно сообщает об обрезке', () => {
  assert.equal(clip('коротко', 100), 'коротко');
  assert.match(clip('x'.repeat(50), 10), /^x{10}\n…\[обрезано: показано 10 из 50 символов\]$/);
});

test('расход переживает перезапуск, а в новые сутки (UTC) обнуляется', () => {
  const file = path.join(tempDir(), 'quota.json');
  let now = new Date('2026-10-23T10:00:00Z');
  const first = createQuota({ file, now: () => now });
  first.record('p', { promptTokens: 30, completionTokens: 12 });
  first.record('p', { promptTokens: 8, completionTokens: 2 });

  const second = createQuota({ file, now: () => now }); // «перезапуск программы»
  assert.deepEqual(second.usage('p'), { requests: 2, promptTokens: 38, completionTokens: 14, tokens: 52 });
  assert.equal(second.isExhausted('p', { requestsPerDay: 2 }), true);
  assert.equal(second.isExhausted('p', { tokensPerDay: 100 }), false);
  assert.equal(second.isExhausted('p', null), false);

  now = new Date('2026-10-24T00:00:01Z'); // наступили новые сутки
  assert.deepEqual(second.usage('p'), { requests: 0, promptTokens: 0, completionTokens: 0, tokens: 0 });
});

test('журнал: после перезапуска виден прошлый запуск, прерванный помечен, битая карточка не мешает', () => {
  const dir = path.join(tempDir(), 'runs');
  const before = createRuns({ dir });
  const finished = before.create({ agentId: 'a', agentName: 'Агент', task: 'первая' });
  before.emit(finished.id, 'final_answer', { text: 'ответ' });
  before.finish(finished.id, 'done', { answer: 'ответ' });
  const interrupted = before.create({ agentId: 'a', agentName: 'Агент', task: 'вторая' }); // «программу закрыли»
  fs.writeFileSync(path.join(dir, 'мусор.json'), '{ это не json', 'utf8');

  const after = createRuns({ dir }); // новый «запуск программы»
  assert.equal(after.get(finished.id).status, 'done');
  assert.equal(after.get(interrupted.id).status, 'stopped');
  assert.match(after.get(interrupted.id).note, /закрыт/);
  assert.equal(after.list().length, 2);
  assert.equal(after.countRunning(), 0);

  const events = after.events(finished.id); // события читаются с диска
  assert.deepEqual(events.map((e) => e.type), ['run_started', 'final_answer', 'run_finished']);
  assert.deepEqual(after.events(finished.id, 2).map((e) => e.type), ['run_finished']); // «начиная с события №3»
});

test('журнал: сбой записи на диск не роняет запуск, подписчики получают события', () => {
  const dir = path.join(tempDir(), 'runs');
  const runs = createRuns({ dir });
  const { id } = runs.create({ agentId: 'a', agentName: 'Агент', task: 'задача' });
  const received = [];
  runs.subscribe(id, (event) => received.push(event.type));

  fs.rmSync(dir, { recursive: true }); // «диск отвалился»: папки журнала больше нет
  const originalError = console.error;
  const complaints = [];
  console.error = (message) => complaints.push(message);
  try {
    assert.doesNotThrow(() => runs.emit(id, 'step', { step: 1 }));
    assert.doesNotThrow(() => runs.emit(id, 'step', { step: 2 }));
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(received, ['step', 'step']);
  assert.equal(complaints.length, 1, 'о проблеме сообщаем один раз, а не на каждое событие');
  assert.match(complaints[0], /Не удалось записать журнал событий/);
});

test('countRunning считает только работающие запуски', () => {
  const runs = createRuns({ dir: path.join(tempDir(), 'runs') });
  const a = runs.create({ agentId: 'a', agentName: 'А', task: '1' });
  runs.create({ agentId: 'a', agentName: 'А', task: '2' });
  assert.equal(runs.countRunning(), 2);
  runs.finish(a.id, 'done');
  assert.equal(runs.countRunning(), 1);
});
