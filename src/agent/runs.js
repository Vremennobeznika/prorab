// Запуски агентов и их журнал.
//
// Каждый запуск — это две вещи на диске (папка data/runs/):
//   <id>.json   — краткая карточка: кто, что просили, чем закончилось;
//   <id>.jsonl  — журнал событий, по одному событию в строке (удобно читать глазами).
//
// Типы событий:
//   run_started, step, model_reply, tool_call, approval_requested, approval_decided,
//   tool_result, final_answer, error, run_finished
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from '../util/files.js';
import { searchRecords } from './memory.js';
import { newRunId } from '../util/ids.js';

export function createRuns({ dir }) {
  fs.mkdirSync(dir, { recursive: true });

  const metas = new Map(); // все запуски: и сегодняшние, и прошлые
  const live = new Map(); // запуски этого сеанса: события в памяти + подписчики + «стоп-кран»

  const metaFile = (id) => path.join(dir, `${id}.json`);
  const eventsFile = (id) => path.join(dir, `${id}.jsonl`);

  // Если диск переполнен или папка недоступна, агент всё равно должен дорабатывать: журнал в памяти
  // остаётся, а о проблеме мы один раз пишем в окно программы.
  const warned = new Set();
  function persist(what, action) {
    try {
      action();
    } catch (err) {
      if (!warned.has(what)) {
        warned.add(what);
        console.error(`Не удалось записать ${what}: ${err.message}`);
      }
    }
  }

  // При старте подхватываем карточки прошлых запусков, чтобы они были видны на странице.
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const meta = readJson(path.join(dir, name));
      if (!meta?.id) continue;
      if (meta.status === 'running') {
        // Программу закрыли посреди работы — честно помечаем запуск как прерванный.
        meta.status = 'stopped';
        meta.note = 'Прораб был закрыт, пока агент работал.';
        writeJson(metaFile(meta.id), meta);
      }
      metas.set(meta.id, meta);
    } catch {
      // повреждённая карточка не должна мешать запуску программы
    }
  }

  /** Начинает новый запуск. Возвращает id и «сигнал остановки» для агента. */
  function create({ agentId, agentName, task, localOnly = true, useMemory = false, criteria = '', workspacePath = null, sessionId = null, parentRunId = null }) {
    const id = newRunId();
    const controller = new AbortController();
    const meta = {
      id,
      agentId,
      agentName,
      localOnly,
      useMemory,
      criteria,
      workspacePath,
      sessionId,
      parentRunId,
      task,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      answer: null,
      note: null,
    };
    metas.set(id, meta);
    live.set(id, { events: [], listeners: new Set(), controller });
    persist('карточку запуска', () => writeJson(metaFile(id), meta));
    emit(id, 'run_started', { agent: agentName, task });
    return { id, signal: controller.signal };
  }

  /** Записывает событие в журнал и сообщает его всем, кто смотрит запуск прямо сейчас. */
  function emit(id, type, data = {}) {
    const run = live.get(id);
    if (!run) return null;
    const event = { n: run.events.length + 1, time: new Date().toISOString(), type, ...data };
    run.events.push(event);
    persist('журнал событий', () => fs.appendFileSync(eventsFile(id), `${JSON.stringify(event)}\n`));
    for (const listener of run.listeners) listener(event);
    return event;
  }

  /** Завершает запуск: status — 'done', 'failed' или 'stopped'. */
  function finish(id, status, { answer = null, note = null } = {}) {
    const meta = metas.get(id);
    if (!meta || meta.status !== 'running') return;
    meta.status = status;
    meta.finishedAt = new Date().toISOString();
    meta.answer = answer;
    meta.note = note;
    persist('карточку запуска', () => writeJson(metaFile(id), meta));
    emit(id, 'run_finished', { status });
    // Завершённые задачи не держат в RAM весь журнал бесконечно.
    // Если диск недоступен, сохраняем события в памяти как аварийный резерв.
    if (fs.existsSync(eventsFile(id))) live.delete(id);
  }

  /** События запуска, начиная с номера afterN + 1. */
  function events(id, afterN = 0) {
    const run = live.get(id);
    if (run) return run.events.filter((e) => e.n > afterN);
    try {
      return fs
        .readFileSync(eventsFile(id), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((e) => e.n > afterN);
    } catch {
      return [];
    }
  }

  /** Подписка на новые события. Возвращает функцию «отписаться». */
  function subscribe(id, listener) {
    const run = live.get(id);
    if (!run) return () => {};
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  function stop(id) {
    const run = live.get(id);
    if (run && metas.get(id)?.status === 'running') run.controller.abort();
  }

  function stopAll() {
    for (const id of live.keys()) stop(id);
  }

  /** Последние 50 запусков, новые сверху. */
  function list() {
    return [...metas.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50);
  }

  function search(query, { agentId, forContext = false, localOnly = false, workspacePath, limit = 30 } = {}) {
    const records = [...metas.values()].filter((r) => r.status === 'done' && typeof r.answer === 'string'
      && (!agentId || r.agentId === agentId)
      && (workspacePath === undefined || r.workspacePath === workspacePath)
      && (!forContext || (r.useMemory === true && (!r.localOnly || localOnly))))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return searchRecords(records, query, (r) => `${r.task} ${r.criteria || ''} ${r.answer}`, limit);
  }

  function forget(id) {
    const meta = metas.get(id);
    if (!meta) return false;
    const next = { ...meta, useMemory: false };
    // В отличие от журнала, отказ от памяти должен надёжно пережить перезапуск.
    writeJson(metaFile(id), next);
    metas.set(id, next);
    return true;
  }

  const countRunning = () => [...metas.values()].filter((m) => m.status === 'running').length;

  return { create, emit, finish, events, subscribe, stop, stopAll, list, search, forget, countRunning, get: (id) => metas.get(id) };
}
