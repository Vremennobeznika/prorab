// Проверяем OpenAI-совместимый провайдер (Ollama, Z.ai и другие) на «притворной» модели.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createOpenAiProvider } from '../src/pool/providers/openai.js';
import { startFakeModel } from '../scripts/lib/fake-model.js';

let replies = [];
let fake;

before(async () => {
  fake = await startFakeModel(() => replies.shift() ?? { content: 'ответ' });
});
after(() => fake.close());

const make = (overrides = {}, env = {}) =>
  createOpenAiProvider({ id: 'p', baseUrl: `http://127.0.0.1:${fake.port}/v1/`, model: 'тест', ...overrides }, env);
const tools = [{ name: 'read_file', description: 'Прочитать файл', parameters: { type: 'object', properties: {} } }];

test('check(): если нужен ключ и его нет — провайдер «не готов»', () => {
  assert.match(make({ apiKeyEnv: 'MY_KEY' }, {}).check().reason, /MY_KEY/);
  assert.equal(make({ apiKeyEnv: 'MY_KEY' }, { MY_KEY: 'x' }).check().ok, true);
  assert.equal(make().check().ok, true); // локальным моделям ключ не нужен
  assert.match(make({ apiKeyEnv: 'MY_KEY' }, { MY_KEY: 'мой ключ' }).check().reason, /недопустимые символы/);
});

test('обычный ответ и учёт токенов', async () => {
  replies = [{ content: 'привет!' }];
  const reply = await make().chat({ messages: [{ role: 'user', content: 'здравствуй' }], tools: [] });
  assert.equal(reply.content, 'привет!');
  assert.deepEqual(reply.toolCalls, []);
  assert.deepEqual(reply.usage, { promptTokens: 20, completionTokens: 10 });
});

test('вызов инструмента: имя и аргументы разобраны; инструменты уходят в формате OpenAI', async () => {
  replies = [{ toolCall: { name: 'read_file', args: { path: 'a.txt' } } }];
  const before = fake.requests.length;
  const reply = await make().chat({ messages: [{ role: 'user', content: 'x' }], tools });

  assert.equal(reply.toolCalls[0].name, 'read_file');
  assert.deepEqual(reply.toolCalls[0].args, { path: 'a.txt' });
  const sent = fake.requests[before];
  assert.equal(sent.model, 'тест');
  assert.equal(sent.tool_choice, 'auto');
  assert.equal(sent.tools[0].type, 'function');
  assert.equal(sent.tools[0].function.name, 'read_file');
});

test('история: вызов инструмента и его результат переводятся в формат OpenAI', async () => {
  replies = [{ content: 'ок' }];
  const before = fake.requests.length;
  await make().chat({
    messages: [
      { role: 'user', content: 'прочитай' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }] },
      { role: 'tool', toolCallId: 'c1', name: 'read_file', content: 'текст файла' },
    ],
    tools,
  });
  const [, assistant, tool] = fake.requests[before].messages;
  assert.equal(assistant.tool_calls[0].id, 'c1');
  assert.equal(assistant.tool_calls[0].function.arguments, '{"path":"a.txt"}');
  assert.deepEqual(tool, { role: 'tool', tool_call_id: 'c1', content: 'текст файла' });
});

test('ошибки: 429 с Retry-After, сбой сервера, недоступность', async () => {
  replies = [{ status: 429 }];
  await assert.rejects(make().chat({ messages: [], tools: [] }), (err) => err.kind === 'rate_limit' && err.status === 429);

  replies = [{ status: 500 }];
  await assert.rejects(make().chat({ messages: [], tools: [] }), (err) => err.kind === 'server');

  replies = [{ status: 400 }];
  await assert.rejects(make().chat({ messages: [], tools: [] }), (err) => err.kind === 'bad_request');

  const unreachable = createOpenAiProvider({ id: 'x', baseUrl: 'http://127.0.0.1:1/v1', model: 'm' }, {});
  await assert.rejects(unreachable.chat({ messages: [], tools: [] }), (err) => err.kind === 'network' && /нет связи/.test(err.message));
});

test('остановка человеком пробрасывается как остановка, а не как сетевая ошибка', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(make().chat({ messages: [], tools: [], signal: controller.signal }), (err) => err.name === 'AbortError');
});

test('таймаут настраивается: медленная модель даёт ошибку timeout с подсказкой', async () => {
  replies = [{ delayMs: 400, content: 'слишком поздно' }];
  const slow = make({ timeoutSec: 0.05 });
  await assert.rejects(slow.chat({ messages: [], tools: [] }), (err) => err.kind === 'timeout' && /timeoutSec/.test(err.message));
});
