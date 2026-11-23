// Идентификаторы запусков и одобрений. Они попадают в имена файлов и в адреса страниц,
// поэтому состоят только из латинских букв, цифр и дефисов.
import { randomBytes, randomUUID } from 'node:crypto';

/** Идентификатор запуска, например «20261015-153012-a1b2». Сортируется по времени. */
export function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${stamp}-${randomBytes(8).toString('hex')}`;
}

/** Короткий случайный идентификатор с приставкой, например newId('ok') → «ok-3fa91c02». */
export const newId = (prefix) => `${prefix}-${randomBytes(4).toString('hex')}`;

/** Обычный UUID (нужен GigaChat в заголовке RqUID). */
export const uuid = () => randomUUID();
