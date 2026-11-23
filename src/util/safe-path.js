// «Забор» вокруг рабочей папки: агент может трогать только файлы внутри неё.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Превращает путь, который попросил агент, в настоящий путь внутри рабочей папки.
 * Бросает ошибку, если путь пытается выйти наружу — через «..», абсолютный путь
 * или символическую ссылку.
 */
export function resolveInside(workspace, userPath = '.') {
  const root = fs.realpathSync(workspace); // настоящий путь папки (без ссылок)
  const target = path.resolve(root, String(userPath));
  assertInside(root, target, userPath);

  // Самое «глубокое» уже существующее место на пути: его настоящий адрес тоже должен быть внутри.
  // Так мы ловим символические ссылки, которые ведут за пределы папки.
  const existing = deepestExisting(target);
  let real;
  try {
    real = fs.realpathSync(existing);
  } catch {
    throw new Error(`Путь «${userPath}» ведёт через битую символическую ссылку — отказано.`);
  }
  assertInside(root, real, userPath);

  if (process.platform === 'win32') {
    for (const part of path.relative(root, target).split(path.sep)) {
      if (isUnsafeWindowsName(part)) throw new Error(`Имя «${part}» в Windows зарезервировано или содержит запрещённые символы — отказано.`);
    }
  }
  return target;
}

/**
 * В Windows у некоторых имён особый смысл: CON, NUL, COM1 и подобные — это устройства, а не файлы;
 * имя с двоеточием — «скрытый поток» NTFS; точка или пробел в конце имени Windows молча отбрасывает.
 * Всё это агенту ни к чему, поэтому такие имена отклоняем.
 */
export function isUnsafeWindowsName(part) {
  if (part === '' || part === '.' || part === '..') return false;
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(part) || part.includes(':') || /[. ]$/.test(part);
}

function assertInside(root, candidate, original) {
  const relative = path.relative(root, candidate);
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (outside) throw new Error(`Путь «${original}» выходит за пределы рабочей папки — отказано.`);
}

function deepestExisting(p) {
  let current = p;
  for (;;) {
    try {
      fs.lstatSync(current); // lstat видит и битые ссылки, в отличие от existsSync
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}
