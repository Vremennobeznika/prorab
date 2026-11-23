/**
 * «Очередь на N мест». Нужна, когда провайдер разрешает только один запрос за раз
 * (так устроен бесплатный тариф GigaChat): остальные агенты ждут своей очереди.
 *
 *   const run = createLimiter(1);
 *   const answer = await run(() => спросить_модель());
 */
export function createLimiter(max) {
  let active = 0; // сколько задач выполняется прямо сейчас
  const waiting = []; // кто ждёт свободного места

  return async function run(task, signal) {
    signal?.throwIfAborted();
    if (active >= max) {
      // Ждём. Место нам передадут напрямую (active при этом не уменьшается),
      // поэтому «влезть без очереди» новичок не сможет.
      await new Promise((resolve, reject) => {
        const grant = () => { signal?.removeEventListener('abort', cancel); resolve(); };
        const cancel = () => {
          const index = waiting.indexOf(grant);
          if (index < 0) return;
          waiting.splice(index, 1);
          signal?.removeEventListener('abort', cancel);
          reject(signal.reason);
        };
        waiting.push(grant);
        if (signal?.aborted) cancel();
        else signal?.addEventListener('abort', cancel, { once: true });
      });
    } else {
      active += 1;
    }
    try {
      signal?.throwIfAborted();
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next(); // передаём место следующему в очереди
      else active -= 1; // очереди нет — место освободилось
    }
  };
}
