import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TOOLS } from '../src/agent/tools.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prorab-search-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  const put = (name, text) => {
    const file = path.join(workspace, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  };
  return { dir, workspace, put, search: async (args) => JSON.parse(await TOOLS.search_files.run(args, { workspace })) };
}

test('search_files: точный русский текст, путь и номер строки; свежие данные без индекса', async (t) => {
  const { put, search } = setup(t);
  put('docs/отчёт.txt', 'Начало\r\nПродажи: 42\r\n');
  let result = await search({ query: 'ПРОДАЖИ' });
  assert.deepEqual(result.hits, [{ path: 'docs/отчёт.txt', line: 2, text: 'Продажи: 42' }]);
  put('docs/отчёт.txt', 'Текст изменился');
  assert.deepEqual((await search({ query: 'продажи' })).hits, []);
  put('a.txt', 'a.*b');
  assert.equal((await search({ query: '.*' })).hits[0].path, 'a.txt'); // никакого regex
});

test('search_files: скрытые файлы, секреты, зависимости, бинарные данные и ссылки пропущены', async (t) => {
  const { put, search, workspace, dir } = setup(t);
  for (const name of ['.env', '.git/config', 'secret.key', 'credentials.json', 'node_modules/p/index.js', 'data/memory.json']) put(name, 'needle');
  put('binary.bin', Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'needle');
  fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(workspace, 'link.txt'));
  assert.deepEqual((await search({ query: 'needle' })).hits, []);
  await assert.rejects(search({ query: 'needle', path: '..' }), /за пределы/);
  await assert.rejects(search({ query: 'needle', path: '.git' }), /исключены/);
  await assert.rejects(search({ query: ' ' }), /пустым|символов/);
});

test('search_files: лимит результатов объявлен, фрагмент показывает совпадение в длинной строке', async (t) => {
  const { put, search } = setup(t);
  put('long.txt', 'x'.repeat(2000) + ' needle ' + 'z'.repeat(1000));
  assert.match((await search({ query: 'needle' })).hits[0].text, /needle/);
  put('many.txt', 'needle\n'.repeat(100));
  const result = await search({ query: 'needle' });
  assert.equal(result.hits.length, 10);
  assert.equal(result.limited, true);
  assert.match(result.note, /лимит/);
});
