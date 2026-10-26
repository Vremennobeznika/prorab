// Проверяем «забор» вокруг рабочей папки: что внутрь можно, а что нельзя.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveInside } from '../src/util/safe-path.js';

function makeWorkspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'prorab-safe-'));
  const workspace = path.join(base, 'ws');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'a');
  fs.writeFileSync(path.join(base, 'secret.txt'), 'секрет'); // лежит снаружи рабочей папки
  return { base, workspace, real: fs.realpathSync(workspace) };
}

test('обычные пути внутри папки разрешены', () => {
  const { workspace, real } = makeWorkspace();
  assert.equal(resolveInside(workspace, 'a.txt'), path.join(real, 'a.txt'));
  assert.equal(resolveInside(workspace, '.'), real);
  assert.equal(resolveInside(workspace, ''), real);
});

test('новый файл в ещё не существующей подпапке допустим', () => {
  const { workspace, real } = makeWorkspace();
  assert.equal(resolveInside(workspace, 'новая/папка/файл.txt'), path.join(real, 'новая', 'папка', 'файл.txt'));
});

test('«..» не выпускает за пределы папки', () => {
  const { workspace } = makeWorkspace();
  assert.throws(() => resolveInside(workspace, '../secret.txt'), /выходит за пределы/);
  assert.throws(() => resolveInside(workspace, 'a/../../secret.txt'), /выходит за пределы/);
});

test('абсолютный путь вне папки запрещён, а внутри — разрешён', () => {
  const { base, workspace, real } = makeWorkspace();
  assert.throws(() => resolveInside(workspace, path.join(base, 'secret.txt')), /выходит за пределы/);
  assert.equal(resolveInside(workspace, path.join(real, 'a.txt')), path.join(real, 'a.txt'));
});

test('символическая ссылка, ведущая наружу, запрещена', (t) => {
  const { base, workspace } = makeWorkspace();
  try {
    fs.symlinkSync(base, path.join(workspace, 'ссылка'), 'dir');
  } catch {
    t.skip('в этой системе нельзя создать символическую ссылку');
    return;
  }
  assert.throws(() => resolveInside(workspace, 'ссылка/secret.txt'), /выходит за пределы/);
});

test('битая символическая ссылка запрещена', (t) => {
  const { base, workspace } = makeWorkspace();
  try {
    fs.symlinkSync(path.join(base, 'нет-такого-файла'), path.join(workspace, 'битая'));
  } catch {
    t.skip('в этой системе нельзя создать символическую ссылку');
    return;
  }
  assert.throws(() => resolveInside(workspace, 'битая'), /битую символическую ссылку/);
});
