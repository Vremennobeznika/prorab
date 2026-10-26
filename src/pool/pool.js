// «Пул» — диспетчер моделей. Агент говорит «ответь мне», а пул решает, какая модель ответит:
//   • идёт по цепочке провайдеров сверху вниз;
//   • пропускает выключенные, без ключа, на паузе и исчерпавшие дневной лимит;
//   • если провайдер ответил ошибкой — ставит его на паузу и пробует следующего;
//   • для задач «только локально» вообще не трогает облачные модели.
import { createLimiter } from '../util/limiter.js';

export class PoolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PoolError';
  }
}

// На сколько секунд отключать провайдера после ошибки (если он сам не сказал, через сколько вернуться)
const DEFAULT_PAUSE_SEC = { rate_limit: 60, server: 30, network: 30, timeout: 30, auth: 600, bad_request: 0, unknown: 30 };

export function createPool({ providers, quota, now = () => Date.now() }) {
  const byId = new Map(providers.map((p) => [p.config.id, p]));
  const health = new Map(); // id → { pausedUntil, lastError }
  const queues = new Map(); // id → очередь «по одному» (только если в настройках задан maxConcurrent)

  for (const p of providers) {
    if (p.config.maxConcurrent) queues.set(p.config.id, createLimiter(p.config.maxConcurrent));
  }

  const stateOf = (id) => {
    if (!health.has(id)) health.set(id, { pausedUntil: 0, lastError: null });
    return health.get(id);
  };

  /** Порядок перебора: цепочка агента или, если она пуста, все провайдеры по порядку из настроек. */
  const orderFor = (chain) => (chain?.length ? chain : providers.map((p) => p.config.id));

  /**
   * Задать вопрос модели.
   *   messages  — история диалога;  tools — описания инструментов;
   *   chain     — какие провайдеры можно использовать (id) и в каком порядке;
   *   localOnly — true: данные не должны покидать компьютер.
   */
  async function chat({ messages, tools, chain, localOnly = false, signal }) {
    const problems = []; // почему кого-то пропустили — покажем человеку, если не ответит никто

    for (const id of orderFor(chain)) {
      const provider = byId.get(id);
      if (!provider) {
        problems.push(`${id}: такого провайдера нет в config/providers.json`);
        continue;
      }
      const { config, impl } = provider;
      const title = config.title ?? config.id;

      if (!config.enabled) { problems.push(`${title}: выключен`); continue; }
      if (localOnly && config.privacy !== 'local') { problems.push(`${title}: облачный, а агенту разрешены только локальные модели`); continue; }

      const ready = impl.check();
      if (!ready.ok) { problems.push(`${title}: ${ready.reason}`); continue; }

      const state = stateOf(id);
      if (state.pausedUntil > now()) {
        problems.push(`${title}: на паузе ещё ${Math.ceil((state.pausedUntil - now()) / 1000)} с (${state.lastError})`);
        continue;
      }
      if (quota.isExhausted(id, config.limits)) { problems.push(`${title}: дневной лимит исчерпан`); continue; }

      try {
        const ask = async () => {
          signal?.throwIfAborted(); // пока стояли в очереди, человека могли попросить остановиться
          return impl.chat({ messages, tools, signal });
        };
        const queue = queues.get(id);
        const reply = await (queue ? queue(ask, signal) : ask());

        quota.record(id, reply.usage);
        state.lastError = null;
        return { ...reply, providerId: id, providerTitle: title };
      } catch (err) {
        if (signal?.aborted) throw err; // остановка человеком — это не ошибка провайдера

        const pause = err.retryAfterSec ?? DEFAULT_PAUSE_SEC[err.kind ?? 'unknown'] ?? 30;
        state.lastError = err.message;
        if (pause > 0) state.pausedUntil = now() + pause * 1000;
        problems.push(`${title}: ${err.message}`);
      }
    }

    throw new PoolError(`Ни одна модель не смогла ответить. ${problems.join(' | ')}`);
  }

  /** Сводка для вкладки «Модели». */
  function status() {
    return providers.map(({ config, impl }) => {
      const state = stateOf(config.id);
      return {
        id: config.id,
        title: config.title ?? config.id,
        model: config.model,
        privacy: config.privacy ?? 'unknown',
        enabled: Boolean(config.enabled),
        ready: impl.check(),
        pausedUntil: state.pausedUntil > now() ? state.pausedUntil : null,
        lastError: state.lastError,
        usage: quota.usage(config.id),
        limits: config.limits ?? null,
        note: config.note ?? '',
      };
    });
  }

  return { chat, status };
}
