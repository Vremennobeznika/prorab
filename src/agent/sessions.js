import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from '../util/files.js';
import { UserError } from '../util/errors.js';

export function createSessions({ dir, workspace }) {
  fs.mkdirSync(dir, { recursive: true });
  const projectsFile = path.join(dir, 'projects.json');
  const initial = { id: 'default', name: 'Мои файлы', path: fs.realpathSync(workspace) };
  const projects = readJson(projectsFile, [initial]);
  if (!Array.isArray(projects)) throw new Error('Повреждён список проектов.');
  const sessions = new Map();
  const file = (id) => path.join(dir, `${id}.session.json`);
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.session.json'))) {
    const session = readJson(path.join(dir, name));
    if (session.version !== 1 || !/^[\w-]+$/.test(session.id) || !Array.isArray(session.turns)) throw new Error(`Повреждена сессия ${name}.`);
    for (const turn of session.turns) {
      if (turn.status === 'running') { turn.status = 'stopped'; turn.answer = 'Приложение было закрыто. Продолжите диалог новым сообщением.'; }
    }
    session.activeRunId = null;
    writeJson(file(session.id), session);
    sessions.set(session.id, session);
  }
  function project(id) {
    const found = projects.find((p) => p.id === id);
    if (!found) throw new UserError('Проект не найден.', 404);
    try {
      if (fs.realpathSync(found.path) !== found.path || !fs.statSync(found.path).isDirectory()) throw new Error();
    } catch { throw new UserError('Папка проекта недоступна или изменилась. Добавьте её заново.', 409); }
    return found;
  }
  function addProject({ name, path: folder } = {}) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new UserError('Укажите полный путь к существующей папке.');
    let canonical;
    try { canonical = fs.realpathSync(folder); if (!fs.statSync(canonical).isDirectory()) throw new Error(); }
    catch { throw new UserError('Папка не найдена или недоступна.'); }
    const existing = projects.find((p) => p.path === canonical);
    if (existing) return existing;
    if (projects.length >= 100) throw new UserError('Достигнут лимит: 100 проектов.');
    const entry = { id: randomUUID(), name: String(name || path.basename(canonical)).slice(0, 100), path: canonical };
    writeJson(projectsFile, [...projects, entry]);
    projects.push(entry);
    return entry;
  }
  function get(id) {
    const session = sessions.get(id);
    if (!session) throw new UserError('Диалог не найден.', 404);
    return session;
  }
  function persist(session) { writeJson(file(session.id), session); }
  function create({ projectId = 'default', agentId, title = 'Новый диалог', localOnly = false, providerId = null } = {}) {
    project(projectId);
    const session = { version: 1, id: randomUUID(), projectId, agentId, localOnly, providerId, title: String(title).slice(0, 100),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activeRunId: null, turns: [], plan: [] };
    persist(session); sessions.set(session.id, session); return session;
  }
  function begin(id, { runId, task, criteria }) {
    const session = structuredClone(get(id));
    if (session.activeRunId) throw new UserError('Дождитесь ответа или остановите текущий шаг.', 409);
    if (session.turns.length >= 200) throw new UserError('В диалоге 200 сообщений. Создайте новый диалог.', 409);
    session.turns.push({ runId, task, criteria, answer: null, status: 'running', messages: [], createdAt: new Date().toISOString() });
    session.activeRunId = runId;
    if (session.turns.length === 1) session.title = task.slice(0, 80);
    session.updatedAt = new Date().toISOString();
    persist(session); sessions.set(id, session);
  }
  function record(id, runId, messages) {
    const session = structuredClone(get(id));
    const turn = session.turns.find((t) => t.runId === runId);
    if (!turn || turn.status !== 'running') throw new Error('Сообщение относится к завершённому шагу.');
    turn.messages = structuredClone(messages); persist(session); sessions.set(id, session);
  }
  function finish(id, runId, status, answer) {
    const session = structuredClone(get(id));
    const turn = session.turns.find((t) => t.runId === runId);
    if (!turn) return;
    turn.status = status; turn.answer = answer; session.activeRunId = null;
    session.updatedAt = new Date().toISOString(); persist(session); sessions.set(id, session);
  }
  function context(id, { includeSummary = false } = {}) {
    const turns = get(id).turns.filter((t) => t.status !== 'running');
    const result = []; let size = 0, kept = 0, summarizedTurns = 0;
    for (const turn of turns.slice(-8).reverse()) {
      let group = structuredClone(turn.messages);
      let summarized = false;
      if (turn.status !== 'done' || JSON.stringify(group).length > 24000) {
        // Never retain an assistant tool call without its result. Summarize the whole turn instead.
        group = [{ role: 'user', content: turn.task }, { role: 'assistant', content:
          `Сохранённый шаг: ${turn.status}. ${turn.answer || 'Ответ не получен.'}\nПодробности действий сокращены. Файлы могли измениться; перечитай их перед продолжением.`.slice(0, 6000) }];
        summarized = true;
      }
      const bytes = JSON.stringify(group).length;
      if (size + bytes > (includeSummary ? 43200 : 48000)) break;
      result.unshift(...group); size += bytes; kept += 1;
      if (summarized) summarizedTurns += 1;
    }
    const omitted = turns.slice(0, turns.length - kept);
    let summary = '';
    if (includeSummary && omitted.length) {
      // Extractive digest: retain original excerpts and run IDs, never promote them to facts.
      const entries = omitted.map((t) => ({ runId: t.runId, status: t.status, task: t.task.slice(0, 160),
        criteria: (t.criteria || '').slice(0, 160), answer: (t.answer || '').slice(0, 280) }));
      const important = entries.filter((e) => /решен|огранич|запомни|предпоч|не менять|не заверш|не провер/i.test(e.task + ' ' + e.answer));
      const chosen = [...new Map([...important.slice(-5), ...entries.slice(-4)].map((e) => [e.runId, e])).values()];
      summary = 'Сводка прежних шагов — выдержки, не проверенные факты. Исходный журнал сохранён.\n' + JSON.stringify(chosen);
      summary = summary.slice(0, 4800);
      result.unshift({ role: 'user', content: summary });
    }
    return { messages: result, omittedTurns: turns.length - kept, summarizedTurns, summary };
  }
  function updatePlan(id, steps) {
    if (!Array.isArray(steps) || steps.length > 12 || steps.some((s) => !s || typeof s.text !== 'string' || !s.text.trim() || s.text.length > 300 || !['pending', 'in_progress', 'done'].includes(s.status))) throw new UserError('План: до 12 пунктов со статусами pending, in_progress, done.');
    const session = structuredClone(get(id)); session.plan = structuredClone(steps); session.updatedAt = new Date().toISOString(); persist(session); sessions.set(id, session); return session.plan;
  }
  function visible(session) { return { ...session, turns: session.turns.map(({ messages, ...turn }) => turn) }; }
  return { addProject, project, create, get, begin, record, finish, context, updatePlan, visible,
    projects: () => structuredClone(projects), list: () => [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ turns, ...s }) => ({ ...s, turnCount: turns.length })) };
}
