// Очередь «Разрешить / Отклонить». Когда агент хочет изменить файл или запустить команду,
// он останавливается и ждёт вашего решения — на компьютере или на телефоне.
import { newId } from '../util/ids.js';

const WAIT_LIMIT_MS = 30 * 60_000; // если за 30 минут никто не ответил, считаем это отказом

export function createApprovals({ runs, waitLimitMs = WAIT_LIMIT_MS }) {
  const pending = new Map(); // id → { id, runId, title, details, createdAt, finish }

  /** Ждёт решения. Возвращает true («разрешить») или false («отклонить»). */
  function request(runId, { title, details }, signal) {
    return new Promise((resolve) => {
      const id = newId('ok');

      const finish = (approved, who) => {
        if (!pending.has(id)) return; // решение уже принято
        pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        runs.emit(runId, 'approval_decided', { approvalId: id, approved, by: who });
        resolve(approved);
      };
      const onAbort = () => finish(false, 'остановка запуска');
      const timer = setTimeout(() => finish(false, 'время ожидания вышло'), waitLimitMs);
      timer.unref?.(); // таймер не должен мешать программе закрыться

      pending.set(id, { id, runId, title, details, createdAt: new Date().toISOString(), finish });
      runs.emit(runId, 'approval_requested', { approvalId: id, title, details });

      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Решение человека. Возвращает false, если такого запроса уже нет. */
  function decide(id, approved) {
    const entry = pending.get(id);
    if (!entry) return false;
    entry.finish(approved, 'человек');
    return true;
  }

  /** Все запросы, которые сейчас ждут решения. */
  function list() {
    return [...pending.values()].map(({ finish, ...visible }) => visible);
  }

  return { request, decide, list };
}
