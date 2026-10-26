// Файловые инструменты на «трудных» файлах: кодировки, Windows-переводы строк, BOM, секреты в окружении.
// Главное правило: агент не должен незаметно испортить файл, а команда — увидеть чужие ключи.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TOOLS, cleanEnv, lineEnding } from '../src/agent/tools.js';
import { isUnsafeWindowsName } from '../src/util/safe-path.js';

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'prorab-tools-'));
  const workspace = path.join(base, 'ws');
  fs.mkdirSync(workspace);
  const ctx = { workspace, backupDir: path.join(base, 'backup'), secretEnvNames: [] };
  const put = (name, content) => fs.writeFileSync(path.join(workspace, name), content);
  const bytes = (name) => fs.readFileSync(path.join(workspace, name));
  return { ctx, put, bytes, workspace };
}

test('read_file: Windows-переводы строк модель видит как обычные «\\n»', async () => {
  const { ctx, put } = setup();
  put('a.txt', 'раз\r\nдва\r\n');
  assert.equal(await TOOLS.read_file.run({ path: 'a.txt' }, ctx), 'раз\nдва\n');
});

test('replace_in_file: в файле с CRLF все переводы строк остаются CRLF', async () => {
  const { ctx, put, bytes } = setup();
  put('a.txt', 'раз\r\nдва\r\nтри\r\n');
  await TOOLS.replace_in_file.run({ path: 'a.txt', old_text: 'раз\nдва', new_text: 'один\nдвое' }, ctx);
  assert.equal(bytes('a.txt').toString('utf8'), 'один\r\nдвое\r\nтри\r\n');
});

test('write_file поверх существующего файла сохраняет его стиль переводов строк', async () => {
  const { ctx, put, bytes } = setup();
  put('win.txt', 'a\r\nb\r\n');
  put('nix.txt', 'a\nb\n');
  await TOOLS.write_file.run({ path: 'win.txt', content: 'x\ny\n' }, ctx);
  await TOOLS.write_file.run({ path: 'nix.txt', content: 'x\r\ny\r\n' }, ctx);
  assert.equal(bytes('win.txt').toString('utf8'), 'x\r\ny\r\n');
  assert.equal(bytes('nix.txt').toString('utf8'), 'x\ny\n');
  await TOOLS.write_file.run({ path: 'new.txt', content: 'новый\nфайл\n' }, ctx); // новый файл — как есть
  assert.equal(bytes('new.txt').toString('utf8'), 'новый\nфайл\n');
});

test('знак BOM в начале файла не теряется ни при правке, ни при перезаписи', async () => {
  const { ctx, put, bytes } = setup();
  put('bom.txt', '\uFEFFпривет, мир');
  await TOOLS.replace_in_file.run({ path: 'bom.txt', old_text: 'мир', new_text: 'Прораб' }, ctx);
  assert.deepEqual([...bytes('bom.txt').subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes('bom.txt').toString('utf8'), '\uFEFFпривет, Прораб');
  await TOOLS.write_file.run({ path: 'bom.txt', content: 'новый текст' }, ctx);
  assert.deepEqual([...bytes('bom.txt').subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('файл в Windows-1251 не читается и не меняется: байты остаются прежними', async () => {
  const { ctx, put, bytes } = setup();
  const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // «Привет» в Windows-1251
  put('старый.txt', cp1251);
  await assert.rejects(TOOLS.read_file.run({ path: 'старый.txt' }, ctx), /не в кодировке UTF-8/);
  await assert.rejects(TOOLS.replace_in_file.run({ path: 'старый.txt', old_text: 'x', new_text: 'y' }, ctx), /не в кодировке UTF-8/);
  await assert.rejects(TOOLS.write_file.run({ path: 'старый.txt', content: 'новое' }, ctx), /не в кодировке UTF-8/);
  assert.deepEqual(bytes('старый.txt'), cp1251);
});

test('бинарные файлы и UTF-16 отклоняются, слишком большие — тоже', async () => {
  const { ctx, put } = setup();
  put('картинка.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  put('utf16.txt', Buffer.from('привет', 'utf16le')); // без метки BOM: нулевых байтов в кириллице нет, но есть управляющие символы
  put('utf16bom.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('привет', 'utf16le')])); // «Юникод» из Блокнота Windows
  put('большой.txt', 'a'.repeat(1_000_001));
  await assert.rejects(TOOLS.read_file.run({ path: 'картинка.bin' }, ctx), /бинарный/);
  await assert.rejects(TOOLS.read_file.run({ path: 'utf16.txt' }, ctx), /бинарный|UTF-16/);
  await assert.rejects(TOOLS.read_file.run({ path: 'utf16bom.txt' }, ctx), /не в кодировке UTF-8/);
  await assert.rejects(TOOLS.read_file.run({ path: 'большой.txt' }, ctx), /больше 1 МБ/);
});

test('файл с перемешанными переводами строк не правится', async () => {
  const { ctx, put, bytes } = setup();
  put('mix.txt', 'a\r\nb\nc\r\n');
  assert.equal(lineEnding('a\r\nb\nc\r\n'), 'mixed');
  await assert.rejects(TOOLS.replace_in_file.run({ path: 'mix.txt', old_text: 'a', new_text: 'z' }, ctx), /перемешаны/);
  await assert.rejects(TOOLS.write_file.run({ path: 'mix.txt', content: 'z' }, ctx), /перемешаны/);
  assert.equal(bytes('mix.txt').toString('utf8'), 'a\r\nb\nc\r\n');
});

test('lineEnding различает стили', () => {
  assert.equal(lineEnding('a\nb'), 'lf');
  assert.equal(lineEnding('a\r\nb'), 'crlf');
  assert.equal(lineEnding('без переводов строк'), 'none');
});

test('cleanEnv убирает секреты, но оставляет обычные переменные', () => {
  const env = { PATH: '/bin', HOME: '/home/x', ZAI_API_KEY: 'k', GITHUB_TOKEN: 't', DB_PASSWORD: 'p', MY_ODD_NAME: 'o', SSH_AUTH_SOCK: '/s' };
  const clean = cleanEnv(env, ['MY_ODD_NAME']);
  assert.deepEqual(Object.keys(clean).sort(), ['HOME', 'PATH', 'SSH_AUTH_SOCK']);
});

test('run_command: команда не видит ключей, но видит обычные переменные', async () => {
  const { ctx } = setup();
  process.env.PRORAB_TEST_KEY = 'super-secret';
  process.env.PRORAB_ODD_NAME = 'odd-secret';
  process.env.PRORAB_TEST_VISIBLE = 'visible';
  ctx.secretEnvNames = ['PRORAB_ODD_NAME'];
  try {
    const out = await TOOLS.run_command.run(
      { command: 'node -p "[process.env.PRORAB_TEST_KEY, process.env.PRORAB_ODD_NAME, process.env.PRORAB_TEST_VISIBLE].join(\',\')"' },
      ctx,
    );
    assert.match(out, /Код завершения: 0/);
    assert.match(out, /,,visible/, `ожидали «пусто,пусто,visible», получили: ${out}`);
    assert.doesNotMatch(out, /secret/);
  } finally {
    delete process.env.PRORAB_TEST_KEY;
    delete process.env.PRORAB_ODD_NAME;
    delete process.env.PRORAB_TEST_VISIBLE;
  }
});

test('Windows: зарезервированные и хитрые имена распознаются как опасные', () => {
  for (const bad of ['con', 'CON.txt', 'nul', 'Aux', 'com1', 'LPT9.log', 'файл.txt.', 'файл ', 'a:b', 'file.txt:stream']) {
    assert.equal(isUnsafeWindowsName(bad), true, bad);
  }
  for (const good of ['файл.txt', '.gitignore', 'console.log', 'connect.js', 'com10', 'README.md', 'привет.txt', 'a.b.c']) {
    assert.equal(isUnsafeWindowsName(good), false, good);
  }
});
