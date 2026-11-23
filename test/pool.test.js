// Проверяем пул: порядок перебора, паузы после ошибок, «только локально», лимиты и очередь.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PoolError, createPool } from '../src/pool/pool.js';
import { ProviderError } from '../src/pool/errors.js';
import { createQuota } from '../src/pool/quota.js';

/** Поддельный провайдер: каждый вызов берёт следующий «сценарий» (ответ или ошибку). */
function fakeProvider(id, steps, config = {}) {
  const calls = [];
  return {
    calls,
    config: { id, title: id, enabled: true, privacy: 'cloud', ...config },
    impl: {
      check: () => ({ ok: true }),
      async chat() {
        calls.push(id);
        const step = steps.shift();
        if (step instanceof Error) throw step;
        return step ?? { content: `ответ от ${id}`, toolCalls: [], extra: null, usage: { promptTokens: 5, completionTokens: 5 } };
      },
    },
  };
}

const ok = (text) => ({ content: text, toolCalls: [], extra: null, usage: { promptTokens: 5, completionTokens: 5 } });
const request = { messages: [{ role: 'user', content: 'привет' }], tools: [] };

test('берёт первого провайдера, если он отвечает', async () => {
  const a = fakeProvider('a', [ok('A')]);
  const b = fakeProvider('b', [ok('B')]);
  const pool = createPool({ providers: [a, b], quota: createQuota({ file: null }) });
  const reply = await pool.chat(request);
  assert.equal(reply.content, 'A');
  assert.equal(reply.providerId, 'a');
  assert.equal(b.calls.length, 0);
});

test('после ошибки 429 переходит ко второму и не трогает первого, пока идёт пауза', async () => {
  let time = 1_000_000;
  const a = fakeProvider('a', [new ProviderError('слишком часто', { kind: 'rate_limit', retryAfterSec: 30 })]);
  const b = fakeProvider('b', [ok('B1'), ok('B2'), ok('B3')]);
  const pool = createPool({ providers: [a, b], quota: createQuota({ file: null }), now: () => time });

  assert.equal((await pool.chat(request)).content, 'B1'); // a упал, ответил b
  time += 10_000;
  assert.equal((await pool.chat(request)).content, 'B2'); // a ещё на паузе — к нему даже не обращаемся
  assert.equal(a.calls.length, 1);
  time += 25_000; // пауза в 30 секунд закончилась
  assert.equal((await pool.chat(request)).providerId, 'a');
});

test('ошибка «модель не приняла запрос» не отключает провайдера', async () => {
  const a = fakeProvider('a', [new ProviderError('нет инструментов', { kind: 'bad_request', status: 400 })]);
  const b = fakeProvider('b', [ok('B')]);
  const pool = createPool({ providers: [a, b], quota: createQuota({ file: null }) });
  assert.equal((await pool.chat(request)).content, 'B');
  assert.equal((await pool.chat(request)).providerId, 'a'); // a снова в деле
});

test('для задач «только локально» облачные провайдеры пропускаются', async () => {
  const cloud = fakeProvider('cloud', [ok('облако')], { privacy: 'ru-cloud' });
  const local = fakeProvider('local', [ok('локально')], { privacy: 'local' });
  const pool = createPool({ providers: [cloud, local], quota: createQuota({ file: null }) });
  const reply = await pool.chat({ ...request, localOnly: true });
  assert.equal(reply.providerId, 'local');
  assert.equal(cloud.calls.length, 0);
});

test('исчерпанный дневной лимит пропускается', async () => {
  const a = fakeProvider('a', [], { limits: { requestsPerDay: 1 } });
  const b = fakeProvider('b', []);
  const pool = createPool({ providers: [a, b], quota: createQuota({ file: null }) });
  assert.equal((await pool.chat(request)).providerId, 'a');
  assert.equal((await pool.chat(request)).providerId, 'b'); // лимит a закончился
});

test('цепочка агента задаёт порядок и ограничивает выбор', async () => {
  const a = fakeProvider('a', []);
  const b = fakeProvider('b', []);
  const pool = createPool({ providers: [a, b], quota: createQuota({ file: null }) });
  assert.equal((await pool.chat({ ...request, chain: ['b', 'a'] })).providerId, 'b');
});

test('если не ответил никто — понятная ошибка с причинами', async () => {
  const a = fakeProvider('a', [], { enabled: false });
  const b = fakeProvider('b', [new ProviderError('нет связи', { kind: 'network' })]);
  const pool = createPool({ providers: [a, b], quota: createQuota({ file: null }) });
  await assert.rejects(pool.chat(request), (err) => err instanceof PoolError && /a: выключен/.test(err.message) && /b: нет связи/.test(err.message));
});

test('maxConcurrent: 1 ставит одновременные запросы в очередь', async () => {
  let running = 0;
  let maxRunning = 0;
  const slow = {
    config: { id: 'slow', enabled: true, privacy: 'cloud', maxConcurrent: 1 },
    impl: {
      check: () => ({ ok: true }),
      async chat() {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        return ok('готово');
      },
    },
  };
  const pool = createPool({ providers: [slow], quota: createQuota({ file: null }) });
  await Promise.all([pool.chat(request), pool.chat(request), pool.chat(request)]);
  assert.equal(maxRunning, 1);
});

test('остановка человеком не считается ошибкой провайдера', async () => {
  const controller = new AbortController();
  const a = fakeProvider('a', []);
  const pool = createPool({ providers: [a], quota: createQuota({ file: null }) });
  controller.abort();
  await assert.rejects(pool.chat({ ...request, signal: controller.signal }), (err) => err.name === 'AbortError');
  assert.equal(pool.status()[0].pausedUntil, null); // провайдера на паузу не ставили
});
