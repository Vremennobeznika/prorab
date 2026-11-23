// Каталог данных установленного приложения: изменения не теряются при обновлении.
import fs from 'node:fs';
import path from 'node:path';
import { fromRoot } from './paths.js';

export function prepareUserData(dir) {
  const home = path.resolve(dir);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.mkdirSync(path.join(home, 'workspace'), { recursive: true });
  for (const name of ['settings.json', 'providers.json']) {
    const target = path.join(home, 'config', name);
    if (!fs.existsSync(target)) fs.copyFileSync(fromRoot('config', name), target, fs.constants.COPYFILE_EXCL);
  }
  return home;
}
