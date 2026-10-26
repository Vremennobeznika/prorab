// Документация и тексты интерфейса не должны расходиться с кодом:
// каждый путь и команда из README существуют, каждый ключ текста в странице найден в словаре.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('README: все упомянутые пути к файлам и папкам существуют', () => {
  const readme = read('README.md');
  const created = ['data/', '.env', 'certs/russian_trusted_root_ca_pem.crt']; // создаются при работе или пользователем
  const topLevel = ['config/', 'src/', 'web/', 'agents/', 'certs/', 'test/', 'scripts/', 'workspace/', 'package.json', 'README.md', '.env.example', '.gitignore'];

  const missing = [];
  for (const match of readme.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].trim();
    if (!topLevel.some((prefix) => token === prefix.replace(/\/$/, '') || token.startsWith(prefix))) continue;
    if (/[<>…{}*\s]/.test(token) || created.some((c) => token.startsWith(c))) continue;
    if (!fs.existsSync(path.join(root, token))) missing.push(token);
  }
  assert.deepEqual(missing, [], `в README упомянуты несуществующие пути: ${missing.join(', ')}`);
});

test('README: все команды npm описаны в package.json', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  const builtIn = new Set(['install', 'i', 'ci', 'init', 'update', 'audit', 'help', 'exec']); // команды самого npm, не скрипты проекта
  const used = new Set();
  for (const match of read('README.md').matchAll(/npm (?:run )?([a-z][\w-]*)/g)) used.add(match[1]);
  for (const name of used) {
    if (builtIn.has(name)) continue;
    assert.ok(scripts[name], `в README есть «npm ... ${name}», а такого скрипта нет в package.json`);
  }
});

test('страница: каждый ключ текста из index.html и каждое T.x.y из app.js есть в словаре', () => {
  const source = read('web', 'app.js');
  const start = source.indexOf('const T = ') + 'const T = '.length;
  const end = source.indexOf('\n  };', start) + 4;
  const T = new Function(`'use strict'; return (${source.slice(start, end)});`)();

  const has = (dotted) => dotted.split('.').reduce((node, key) => (node == null ? node : node[key]), T) != null;
  const keys = [...read('web', 'index.html').matchAll(/data-t(?:-placeholder)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 10, 'не нашли ключей текста в index.html');
  for (const key of keys) assert.ok(has(key), `в index.html ключ «${key}», а в словаре T его нет`);

  const used = [...source.matchAll(/\bT\.([a-zA-Z]+)\.([a-zA-Z_]+)/g)].map((m) => `${m[1]}.${m[2]}`);
  for (const key of new Set(used)) assert.ok(has(key), `в app.js используется T.${key}, а в словаре его нет`);
});

test('имя продукта везде новое: старое название не осталось ни в коде, ни в документации', () => {
  const stack = [root];
  const left = [];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'data' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (!/\.(woff2|zip|png|ico)$/.test(entry.name) && entry.name !== 'docs.test.js') {
        if (/бригадир|brigadir/i.test(fs.readFileSync(full, 'utf8'))) left.push(path.relative(root, full));
      }
    }
  }
  assert.deepEqual(left, []);
});
