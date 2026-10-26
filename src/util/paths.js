// Где лежит проект. Все пути в настройках считаются от этой папки,
// поэтому программа работает одинаково, из какой бы папки её ни запустили.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** fromRoot('config', 'settings.json') → полный путь к файлу внутри проекта */
export const fromRoot = (...parts) => path.join(ROOT, ...parts);
