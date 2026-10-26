// Локальная память: только явно сохранённые пользователем заметки и завершённые задания.
// Поиск лексический, без внешних API и дополнительных моделей.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson } from '../util/files.js';
import { UserError } from '../util/errors.js';

const STOP = new Set('это как для или что все мне мой моя мои про при под над без чтобы нужно надо сделай пожалуйста the and for with this that'.split(' '));
function words(text) {
  return new Set((String(text).toLowerCase().replaceAll('ё', 'е').match(/[\p{L}\p{N}_]+/gu) || [])
    .filter((s) => s.length > 1 && !STOP.has(s)).map((s) => s.length > 6 ? s.slice(0, 6) : s));
}

export function searchRecords(records, query, textOf, limit = 30) {
  const terms = words(query);
  if (!terms.size) return [];
  return records.map((record, order) => {
    const tokens = words(textOf(record));
    const matches = [...terms].filter((term) => tokens.has(term)).length;
    return { record, order, score: matches / terms.size };
  }).filter((hit) => hit.score >= 0.25)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit).map(({ record }) => record);
}

export function createMemory({ file }) {
  function read() {
    try {
      const data = readJson(file, { version: 1, notes: [] });
      if (data.version !== 1 || !Array.isArray(data.notes) || data.notes.some((n) =>
        typeof n.id !== 'string' || typeof n.text !== 'string' || typeof n.localOnly !== 'boolean' || typeof n.pinned !== 'boolean' || typeof n.updatedAt !== 'string')) {
        throw new Error('неизвестный формат');
      }
      return data.notes;
    } catch {
      throw new UserError('Память недоступна: проверьте файл data/memory.json. Существующие данные не перезаписаны.', 503);
    }
  }
  function save(notes) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, notes }, null, 2), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
    } catch {
      throw new UserError('Не удалось сохранить память. Проверьте доступ к папке данных и свободное место.', 503);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* после rename временного файла уже нет */ }
    }
  }
  function list(query = '') {
    const notes = read().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return query.trim() ? searchRecords(notes, query, (n) => n.text) : notes;
  }
  function put({ id, text, localOnly = true, pinned = true, sourceRunId = null, sourceLocalOnly = false } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new UserError('Заметка должна содержать от 1 до 2000 символов.');
    if (typeof pinned !== 'boolean') throw new UserError('Некорректная настройка заметки.');
    if (typeof localOnly !== 'boolean') throw new UserError('Укажите область использования заметки.');
    const notes = read();
    const previous = id === undefined ? null : notes.find((n) => n.id === id);
    if (id !== undefined && !previous) throw new UserError('Заметка не найдена.', 404);
    if (!previous && notes.length >= 500) throw new UserError('В памяти уже 500 заметок. Удалите ненужные.', 409);
    const now = new Date().toISOString();
    const note = { id: previous?.id || randomUUID(), text: text.trim(), localOnly, pinned, sourceLocalOnly: previous?.sourceLocalOnly || sourceLocalOnly,
      sourceRunId: previous?.sourceRunId || sourceRunId, createdAt: previous?.createdAt || now, updatedAt: now };
    save([...notes.filter((n) => n.id !== note.id), note]);
    return note;
  }
  function remove(id) {
    const notes = read();
    if (!notes.some((n) => n.id === id)) throw new UserError('Заметка не найдена.', 404);
    save(notes.filter((n) => n.id !== id));
    return { ok: true };
  }
  return { list, put, remove };
}

export function recallContext({ memory, runs, task, agent, workspacePath }) {
  // localOnly защищает и данные: такие записи нельзя отправить агенту с облачным пулом.
  const available = memory.list().filter((n) => !n.localOnly || agent.localOnly);
  const notes = [...available.filter((n) => n.pinned).slice(0, 5),
    ...searchRecords(available.filter((n) => !n.pinned), task, (n) => n.text, 5)].slice(0, 5);
  const history = runs.search(task, { agentId: agent.id, forContext: true, localOnly: agent.localOnly, workspacePath, limit: 3 });
  const items = [
    ...notes.map((n) => ({ kind: 'note', id: n.id, text: n.text })),
    ...history.map((r) => ({ kind: 'run', id: r.id, text: `Задание: ${r.task.slice(0, 600)}${r.criteria ? '\nКритерии: ' + r.criteria.slice(0, 300) : ''}\nОтвет (может содержать ошибки): ${r.answer.slice(0, 900)}` })),
  ];
  let remaining = 5500;
  const selected = [];
  for (const item of items) {
    const serialized = JSON.stringify(item);
    if (serialized.length > remaining) continue;
    selected.push(item);
    remaining -= serialized.length;
  }
  return selected;
}
