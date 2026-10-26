// Локальная память: только явно сохранённые пользователем заметки и завершённые задания.
// Поиск лексический, без внешних API и дополнительных моделей.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson } from '../util/files.js';
import { UserError } from '../util/errors.js';

import { searchRecords } from './retrieval.js';
export { searchRecords } from './retrieval.js';

const KINDS = new Set(['fact', 'preference', 'decision', 'constraint']);
const normalized = (text) => text.trim().toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ');
const active = (n) => !n.status || n.status === 'accepted';
export const inScope = (n, workspacePath) => !n.workspacePath || n.workspacePath === workspacePath;

export function createMemory({ file }) {
  function read() {
    try {
      const data = readJson(file, { version: 1, notes: [] });
      if (data.version !== 1 || !Array.isArray(data.notes) || data.notes.some((n) =>
        typeof n.id !== 'string' || typeof n.text !== 'string' || typeof n.localOnly !== 'boolean' || typeof n.pinned !== 'boolean' || typeof n.updatedAt !== 'string' || (n.status !== undefined && !['accepted', 'pending', 'archived', 'rejected'].includes(n.status)) || (n.kind !== undefined && !KINDS.has(n.kind)) || (n.workspacePath != null && (typeof n.workspacePath !== 'string' || !path.isAbsolute(n.workspacePath))) || (n.topic !== undefined && typeof n.topic !== 'string') || (n.pathPrefix !== undefined && typeof n.pathPrefix !== 'string'))) {
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
  function put({ id, text, localOnly = true, pinned = true, sourceRunId = null, sourceLocalOnly = false, workspacePath = null, kind = 'fact', topic = '', pathPrefix = '', status = 'accepted', evidence = '' } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new UserError('Заметка должна содержать от 1 до 2000 символов.');
    if (typeof pinned !== 'boolean') throw new UserError('Некорректная настройка заметки.');
    if (typeof localOnly !== 'boolean') throw new UserError('Укажите область использования заметки.');
    if (!KINDS.has(kind) || !['accepted', 'pending'].includes(status)) throw new UserError('Некорректный тип заметки.');
    if (workspacePath !== null && (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath))) throw new UserError('Некорректная область проекта.');
    if (typeof evidence !== 'string' || evidence.length > 2000) throw new UserError('Слишком длинная цитата источника.');
    if (typeof topic !== 'string' || topic.length > 100) throw new UserError('Тема: максимум 100 символов.');
    if (typeof pathPrefix !== 'string' || pathPrefix.length > 200 || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(pathPrefix) || path.isAbsolute(pathPrefix)) throw new UserError('Путь ограничения должен быть внутри проекта.');
    const notes = read();
    const previous = id === undefined ? null : notes.find((n) => n.id === id);
    if (id !== undefined && !previous) throw new UserError('Заметка не найдена.', 404);
    const duplicate = !previous && notes.find((n) => n.status !== 'archived' && n.status !== 'rejected' && normalized(n.text) === normalized(text) && (n.workspacePath || null) === workspacePath && n.localOnly === localOnly && (n.pathPrefix || '') === pathPrefix);
    if (duplicate) return duplicate;
    if (!previous && notes.length >= 500) throw new UserError('В памяти уже 500 заметок. Удалите ненужные.', 409);
    const now = new Date().toISOString();
    const note = { id: previous?.id || randomUUID(), text: text.trim(), localOnly, pinned, sourceLocalOnly: previous?.sourceLocalOnly || sourceLocalOnly,
      sourceRunId: previous?.sourceRunId || sourceRunId, workspacePath, kind, evidence, topic: topic.trim(), pathPrefix: pathPrefix ? path.posix.normalize(pathPrefix.replaceAll('\\', '/')).replace(/\/$/, '') : '', status, createdAt: previous?.createdAt || now, updatedAt: now };
    save([...notes.filter((n) => n.id !== note.id), note]);
    return note;
  }
  function resolve({ id, action, replaceId } = {}) {
    const notes = read(); const note = notes.find((n) => n.id === id);
    if (!note) throw new UserError('Заметка не найдена.', 404);
    if (!['accept', 'reject'].includes(action)) throw new UserError('Выберите принятие или отклонение.');
    if (note.status !== 'pending') throw new UserError('Предложение уже обработано.', 409);
    const old = replaceId && notes.find((n) => n.id === replaceId);
    if (replaceId && (action !== 'accept' || !old || old.id === id || !active(old) || (old.workspacePath || null) !== (note.workspacePath || null) || old.localOnly !== note.localOnly)) throw new UserError('Нельзя заменить запись из другой области.');
    const now = new Date().toISOString();
    const result = { ...note, status: action === 'accept' ? 'accepted' : 'rejected', updatedAt: now };
    save(notes.map((n) => n.id === id ? result : old && n.id === old.id ? { ...n, status: 'archived', updatedAt: now } : n));
    return result;
  }
  function conflicts(note, notes = read()) {
    if (!note.topic) return [];
    return notes.filter((n) => n.id !== note.id && active(n) && n.topic && normalized(n.topic) === normalized(note.topic) && (n.workspacePath || null) === (note.workspacePath || null) && n.localOnly === note.localOnly && normalized(n.text) !== normalized(note.text)).map((n) => n.id);
  }
  function listWithConflicts(query = '') {
    const notes = list();
    const found = query.trim() ? searchRecords(notes, query, (n) => n.text) : notes;
    return found.map((n) => ({ ...n, conflictsWith: conflicts(n, notes) }));
  }
  function constraints(workspacePath, localOnly, filePath) {
    const canonical = (value) => { const normalizedPath = path.posix.normalize(String(value).replaceAll('\\', '/')); return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath; };
    const target = canonical(filePath);
    return read().filter((n) => active(n) && n.kind === 'constraint' && inScope(n, workspacePath) && (!n.localOnly || localOnly) && (!n.pathPrefix || target === canonical(n.pathPrefix) || target.startsWith(canonical(n.pathPrefix) + '/')));
  }
  function remove(id) {
    const notes = read();
    if (!notes.some((n) => n.id === id)) throw new UserError('Заметка не найдена.', 404);
    save(notes.filter((n) => n.id !== id));
    return { ok: true };
  }
  return { list, put, remove, resolve, conflicts, constraints, listWithConflicts };
}

export function recallContext({ memory, runs, task, agent, workspacePath }) {
  // localOnly защищает и данные: такие записи нельзя отправить агенту с облачным пулом.
  const available = memory.list().filter((n) => active(n) && inScope(n, workspacePath) && (!n.localOnly || agent.localOnly));
  const notes = [...available.filter((n) => n.pinned).slice(0, 5),
    ...searchRecords(available.filter((n) => !n.pinned), task, (n) => n.text, 5)].slice(0, 5);
  const history = runs.search(task, { agentId: agent.id, forContext: true, localOnly: agent.localOnly, workspacePath, limit: 3 });
  const items = [
    ...notes.map((n) => ({ kind: 'note', id: n.id, text: n.text, type: n.kind || 'fact', sourceRunId: n.sourceRunId, conflictsWith: memory.conflicts(n, available) })),
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
