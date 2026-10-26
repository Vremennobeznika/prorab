// «Склейка»: собирает все части в одно приложение и даёт серверу простые команды —
// запустить агента, остановить всех, показать состояние. Сам сервер про устройство частей не знает.
import fs from 'node:fs';
import path from 'node:path';
import { createApprovals } from './agent/approvals.js';
import { createMemory, recallContext } from './agent/memory.js';
import { createSessions } from './agent/sessions.js';
import { TOOLS } from './agent/tools.js';
import { createRuns } from './agent/runs.js';
import { runAgent } from './agent/runner.js';
import { createPool } from './pool/pool.js';
import { createQuota } from './pool/quota.js';
import { buildProviders } from './pool/registry.js';
import { UserError } from './util/errors.js';
import { ROOT } from './util/paths.js';
import { createCredentials } from './util/credentials.js';
import { writeJson } from './util/files.js';

const MAX_TASK_CHARS = 4000;
const DEFAULT_MAX_CONCURRENT_RUNS = 3; // на слабом компьютере много одновременных агентов только мешают друг другу

export function createApp({ settings, providerConfigs, agents, dataDir, env = process.env, workspace: workspaceOverride, providerConfigFile, envFile }) {
  // Рабочая папка агентов. Относительный путь считается от папки проекта.
  const workspace = workspaceOverride ? path.resolve(workspaceOverride) : path.resolve(ROOT, settings.workspace ?? './workspace');
  fs.mkdirSync(workspace, { recursive: true });

  const sessions = createSessions({ dir: path.join(dataDir, 'sessions'), workspace });
  const quota = createQuota({ file: path.join(dataDir, 'quota.json') });
  const credentials = envFile ? createCredentials(envFile, env) : null;
  let providerEnv = credentials ? credentials.environment() : env;
  let pool = createPool({ providers: buildProviders(providerConfigs, providerEnv), quota });
  const runs = createRuns({ dir: path.join(dataDir, 'runs') });
  const memory = createMemory({ file: path.join(dataDir, 'memory.json') });
  const approvals = createApprovals({ runs });
  const maxRuns = settings.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
  // Имена переменных с ключами из providers.json: команды агента их не увидят (см. cleanEnv в tools.js).
  const secretEnvNames = providerConfigs.flatMap((p) => [p.apiKeyEnv, p.authKeyEnv]).filter(Boolean);

  /** Запускает агента в фоне и сразу возвращает id запуска. */
  // Менять поставщика можно в браузере. Конфигурация сохраняется в профиле пользователя;
  // уже работающие задачи завершаются со своим существующим пулом моделей.
  function configureProvider({ providerId, enabled, apiKey }) {
    if (!providerConfigFile || !envFile) throw new UserError('Настройка из браузера недоступна в тестовом режиме.', 403);
    if (runs.countRunning() !== 0) throw new UserError('Дождитесь окончания задач перед сменой модели.', 409);
    const config = providerConfigs.find((p) => p.id === providerId);
    if (!config) throw new UserError('Неизвестная модель.', 400);
    if (typeof enabled !== 'boolean') throw new UserError('Укажите, включить ли модель.', 400);
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 4096 || /[\r\n]/.test(apiKey))) {
      throw new UserError('Некорректный ключ доступа.', 400);
    }
    const nextEnv = { ...providerEnv, ...credentials.environment() };
    const envName = config.authKeyEnv || config.apiKeyEnv;
    if (apiKey && !envName) throw new UserError('Для этой модели ключ не требуется.', 400);
    if (apiKey?.trim()) nextEnv[envName] = apiKey.trim();
    const nextConfigs = providerConfigs.map((p) => ({ ...p, enabled: p.id === providerId ? enabled : p.enabled }));
    const nextPool = createPool({ providers: buildProviders(nextConfigs, nextEnv), quota });
    if (enabled && envName && !nextPool.status().find((p) => p.id === providerId)?.ready.ok) {
      throw new UserError('Для выбранной модели сначала укажите ключ доступа.', 400);
    }
    // Persist non-secret config first. Memory state changes only after key storage succeeds.
    if (apiKey?.trim()) credentials.put(envName, apiKey.trim());
    writeJson(providerConfigFile, { providers: nextConfigs });
    for (let i = 0; i < nextConfigs.length; i += 1) providerConfigs[i] = nextConfigs[i];
    providerEnv = nextEnv;
    pool = nextPool;
    return { ok: true };
  }

  function startRun(agentId, task, { useMemory = false, criteria = '', sessionId = null } = {}) {
    if (typeof criteria !== 'string' || criteria.length > 2000) throw new UserError('Критерии готовности: максимум 2000 символов.');
    if (typeof useMemory !== 'boolean') throw new UserError('Некорректная настройка памяти.');
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) throw new UserError('Такого агента нет. Выберите агента из списка.');
    const cleanTask = String(task ?? '').trim();
    if (!cleanTask) throw new UserError('Опишите задачу: что агент должен сделать.');
    if (cleanTask.length > MAX_TASK_CHARS) throw new UserError(`Задача слишком длинная (максимум ${MAX_TASK_CHARS} символов).`);

    const session = sessionId === null ? null : sessions.get(sessionId);
    if (session && (session.agentId !== agent.id || (session.localOnly && !agent.localOnly))) throw new UserError('Режим агента в диалоге изменился. Создайте новый диалог.', 409);
    if (session?.activeRunId) throw new UserError('Дождитесь ответа или остановите текущий шаг.', 409);
    const effectiveAgent = session?.providerId ? { ...agent, models: [session.providerId] } : agent;
    const targetWorkspace = session ? sessions.project(session.projectId).path : workspace;
    const context = session ? sessions.context(session.id) : { messages: [], omittedTurns: 0 };

    const running = runs.countRunning();
    if (!pool.status().some((p) => p.enabled && p.ready.ok)) {
      throw new UserError('Сначала подключите ИИ во вкладке «Модели».', 409);
    }
    if (running >= maxRuns) {
      throw new UserError(`Уже идёт ${running} из ${maxRuns} возможных запусков. Дождитесь завершения или остановите лишние.`, 429);
    }

    const { id, signal } = runs.create({ agentId: agent.id, agentName: agent.name, task: cleanTask, localOnly: Boolean(agent.localOnly), useMemory, criteria: criteria.trim(), workspacePath: targetWorkspace, sessionId });
    const backupDir = path.join(dataDir, 'backups', id);
    if (session) {
      try { sessions.begin(session.id, { runId: id, task: cleanTask, criteria: criteria.trim() }); }
      catch (err) { runs.finish(id, 'failed', { note: err.message }); throw err; }
      runs.emit(id, 'session_context', { sessionId, omittedTurns: context.omittedTurns, summarizedTurns: context.summarizedTurns || 0 });
    }

    let recalled = [];
    if (useMemory) {
      try {
        recalled = recallContext({ memory, runs, task: cleanTask, agent, workspacePath: targetWorkspace });
        runs.emit(id, 'memory_recalled', { sources: recalled.map(({ kind, id }) => ({ kind, id })) });
      } catch (err) {
        runs.emit(id, 'memory_unavailable', { message: err.message });
      }
    }

    // Не ждём окончания: агент работает в фоне, а мы отвечаем странице сразу.
    let delegations = 0;
    const turnPool = pool;
    async function delegate({ agentId: specialistId, task: subtask } = {}) {
      signal.throwIfAborted();
      if (++delegations > 2) throw new UserError('Лимит: два поручения на сообщение.');
      if (!['code-reviewer', 'data-auditor', 'document-summary'].includes(specialistId)) throw new UserError('Выберите специалиста только для чтения.');
      if (typeof subtask !== 'string' || !subtask.trim() || subtask.length > 4000) throw new UserError('Поручение: от 1 до 4000 символов.');
      if (runs.countRunning() >= maxRuns) throw new UserError('Все места для агентов заняты.');
      const specialist = agents.find((a) => a.id === specialistId);
      if (!specialist) throw new UserError('Специалист не установлен.');
      const childAgent = { ...specialist, mode: 'manual', localOnly: agent.localOnly || specialist.localOnly,
        maxSteps: Math.min(specialist.maxSteps, 8), tools: specialist.tools.filter((t) => TOOLS[t]?.risk === 'read' && !['delegate_agent', 'update_plan'].includes(t)) };
      const child = runs.create({ agentId: childAgent.id, agentName: childAgent.name, task: subtask, localOnly: childAgent.localOnly, parentRunId: id, sessionId, workspacePath: targetWorkspace });
      const cancel = () => runs.stop(child.id);
      signal.addEventListener('abort', cancel, { once: true });
      runs.emit(id, 'delegate_started', { childRunId: child.id, agent: childAgent.name, task: subtask });
      try {
        const result = await runAgent({ agent: childAgent, task: subtask, runId: child.id, pool: turnPool, runs, approvals,
          workspace: targetWorkspace, backupDir: path.join(dataDir, 'backups', child.id), signal: child.signal, secretEnvNames });
        const status = result.status === 'done' ? 'done' : 'failed';
        runs.finish(child.id, status, { answer: result.answer });
        runs.emit(id, 'delegate_finished', { childRunId: child.id, status });
        return JSON.stringify({ runId: child.id, agent: childAgent.name, status, answer: result.answer });
      } catch (err) {
        runs.finish(child.id, signal.aborted ? 'stopped' : 'failed', { note: err.message }); throw err;
      } finally { signal.removeEventListener('abort', cancel); }
    }
    runAgent({ agent: effectiveAgent, task: cleanTask, runId: id, pool: turnPool, runs, approvals, workspace: targetWorkspace, backupDir, signal, secretEnvNames, recalled, criteria: criteria.trim(),
      history: context.messages, plan: session?.plan || [],
      onMessages: session ? (messages) => sessions.record(session.id, id, messages) : undefined,
      updatePlan: session ? (steps) => { const plan = sessions.updatePlan(session.id, steps); runs.emit(id, 'plan_updated', { steps: plan }); return plan; } : undefined,
      delegate })
      .then((result) => {
        if (session) sessions.finish(session.id, id, result.status === 'done' ? 'done' : 'failed', result.answer);
        runs.finish(id, result.status === 'done' ? 'done' : 'failed', { answer: result.answer });
      })
      .catch((err) => {
        if (session) {
          try { sessions.finish(session.id, id, signal.aborted ? 'stopped' : 'failed', err.message); }
          catch (persistError) { console.error('Не удалось сохранить диалог:', persistError.message); }
        }
        if (signal.aborted) {
          runs.finish(id, 'stopped');
        } else {
          runs.emit(id, 'error', { message: err.message });
          runs.finish(id, 'failed', { note: err.message });
        }
      });

    return id;
  }

  function saveMemory(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UserError('Некорректная заметка.');
    const previous = body.id === undefined ? null : memory.list().find((n) => n.id === body.id);
    const sourceId = previous?.sourceRunId || body.sourceRunId;
    const source = sourceId == null ? null : runs.get(sourceId);
    if (sourceId != null && (!source || source.status !== 'done')) throw new UserError('Завершённый запуск не найден.', 404);
    if ((previous?.sourceLocalOnly || (source && source.localOnly !== false)) && body.localOnly === false) throw new UserError('Заметка из локального запуска должна оставаться локальной.');
    return memory.put({ ...body, sourceRunId: sourceId || null, sourceLocalOnly: Boolean(previous?.sourceLocalOnly || (source && source.localOnly !== false)) });
  }

  /** Всё, что нужно странице для отрисовки. */
  function state() {
    return {
      workspace,
      projects: sessions.projects(),
      sessions: sessions.list(),
      canConfigure: Boolean(providerConfigFile && envFile),
      agents: agents.map(({ instructions, ...visible }) => visible),
      providers: pool.status().map((provider) => {
        const config = providerConfigs.find((p) => p.id === provider.id);
        const name = config.authKeyEnv || config.apiKeyEnv;
        return { ...provider, requiresKey: Boolean(name), credentialSource: name ? credentials?.source(name) || (providerEnv[name] ? 'environment' : null) : null };
      }),
      runs: runs.list(),
      approvals: approvals.list(),
    };
  }

  return { workspace, get pool() { return pool; }, runs, approvals, memory, saveMemory, sessions, configureProvider, startRun, state, stopAll: () => runs.stopAll() };
}
