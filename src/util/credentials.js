// Local profile credentials are stored as JSON, so #, quotes and backslashes round-trip.
// API responses expose presence only. Legacy .env values remain readable.
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { UserError } from './errors.js';

export function createCredentials(envFile, inherited) {
  const file = path.join(path.dirname(envFile), 'credentials.json');
  let saved = {};
  let legacy = {};
  try { legacy = parseEnv(fs.readFileSync(envFile, 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') throw new Error('Не удалось прочитать прежние ключи из .env.'); }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== 1 || !data.values || typeof data.values !== 'object' || Array.isArray(data.values)
      || Object.values(data.values).some((v) => typeof v !== 'string')) throw new Error();
    saved = data.values;
  } catch (err) { if (err.code !== 'ENOENT') throw new Error('Не удалось прочитать credentials.json. Существующие ключи не изменены.'); }
  function environment() { return { ...legacy, ...inherited, ...saved }; }
  function put(name, value) {
    const next = { ...saved, [name]: value };
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, values: next }, null, 2), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
      saved = next;
    } catch { throw new UserError('Ключ не сохранён. Проверьте доступ к папке данных и свободное место.', 503); }
    finally { try { fs.unlinkSync(temporary); } catch { /* rename already removed the temporary file */ } }
  }
  function source(name) {
    return saved[name] || legacy[name] ? 'profile' : inherited[name] ? 'environment' : null;
  }
  return { environment, put, source };
}
