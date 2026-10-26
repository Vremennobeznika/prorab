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

  return async function run(task) {
    if (active >= max) {
      // Ждём. Место нам передадут напрямую (active при этом не уменьшается),
      // поэтому «влезть без очереди» новичок не сможет.
      await new Promise((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next(); // передаём место следующему в очереди
      else active -= 1; // очереди нет — место освободилось
    }
  };
}
