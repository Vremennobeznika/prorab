// Мелкие помощники для работы с файлами и текстом.
import fs from 'node:fs';
import path from 'node:path';

/** Читает JSON-файл. Если файла нет и передан fallback — возвращает его вместо ошибки. */
export function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`Не удалось прочитать файл ${file}: ${err.message}`);
  }
  try {
    // Старый «Блокнот» Windows добавляет в начало файла невидимый знак BOM — убираем его.
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`В файле ${file} ошибка в JSON: ${err.message}`);
  }
}

/** Записывает JSON «целиком или никак»: сначала во временный файл, потом подмена. */
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, file);
}

/** Обрезает длинный текст и честно сообщает, сколько было. */
export function clip(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[обрезано: показано ${max} из ${s.length} символов]`;
}
