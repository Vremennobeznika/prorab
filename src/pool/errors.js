// Ошибки при обращении к модели.
//
// Пул смотрит на поле «kind», чтобы решить, что делать дальше:
//   rate_limit  — слишком много запросов (HTTP 429): подождать и пойти дальше по цепочке
//   auth        — ключ не принят или нет доступа: надолго отключить провайдера
//   network     — нет связи;  timeout — не ответил вовремя;  server — сбой на стороне сервиса
//   bad_request — сервис не принял именно этот запрос (например, модель не умеет инструменты):
//                 пробуем следующую модель, но самого провайдера не отключаем
export class ProviderError extends Error {
  constructor(message, { kind = 'unknown', status = 0, retryAfterSec = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

export function kindFromStatus(status) {
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

/** Заголовок Retry-After («через сколько секунд повторить») → число секунд или null. */
export function readRetryAfter(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}
