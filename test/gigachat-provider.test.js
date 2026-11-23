// Проверяем адаптер GigaChat на «фальшивом GigaChat»: локальный HTTPS-сервер с тестовым сертификатом,
// который отвечает так, как описано в документации Сбера (авторизация, functions / function_call, роль function).
// Настоящий GigaChat здесь не используется — это проверка нашего кода, а не сервиса.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGigaChatProvider } from '../src/pool/providers/gigachat.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CA_FILE = path.join(fixtures, 'test-ca.pem');

let server;
let port;
let log; // что получил «сервер»: { oauth: [], chat: [] }
let behavior; // что «сервер» ответит на следующий запрос к чату

before(async () => {
  server = https.createServer(
    { key: fs.readFileSync(path.join(fixtures, 'test-server.key')), cert: fs.readFileSync(path.join(fixtures, 'test-server.pem')) },
    async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');

      if (req.url === '/api/v2/oauth') {
        log.oauth.push({ headers: req.headers, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ access_token: `token-${log.oauth.length}`, expires_at: Math.floor(Date.now() / 1000) + 1800 }));
      }
      if (req.url === '/v1/chat/completions') {
        log.chat.push({ headers: req.headers, body: JSON.parse(body) });
        const reply = behavior.shift() ?? { status: 200, json: { choices: [{ message: { role: 'assistant', content: 'ответ' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } } };
        res.writeHead(reply.status, { 'Content-Type': 'application/json', ...(reply.headers ?? {}) });
        return res.end(JSON.stringify(reply.json ?? {}));
      }
      res.writeHead(404);
      res.end();
    },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

function provider(overrides = {}, env = { GIGACHAT_AUTH_KEY: 'dGVzdC1rZXk6c2VjcmV0' }) {
  log = { oauth: [], chat: [] };
  behavior = [];
  return createGigaChatProvider(
    {
      id: 'gigachat',
      baseUrl: `https://localhost:${port}/v1`,
      oauthUrl: `https://localhost:${port}/api/v2/oauth`,
      scope: 'GIGACHAT_API_PERS',
      authKeyEnv: 'GIGACHAT_AUTH_KEY',
      caFile: CA_FILE, // в настоящей работе здесь сертификат Минцифры
      model: 'GigaChat-2-Pro',
      ...overrides,
    },
    env,
  );
}

const tools = [{ name: 'read_file', description: 'Прочитать файл', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];

test('check(): без ключа не готов; при отсутствующем дополнительном сертификате использует системные корни', () => {
  assert.match(provider({}, {}).check().reason, /GIGACHAT_AUTH_KEY/);
  assert.equal(provider({ caFile: 'certs/нет-такого.crt' }).check().ok, true);
  assert.equal(provider().check().ok, true);
});

test('check(): ключ с пробелами внутри, кавычками или кириллицей отвергается заранее, с понятным объяснением', () => {
  assert.match(provider({}, { GIGACHAT_AUTH_KEY: 'ключ из кабинета' }).check().reason, /недопустимые символы/);
  assert.match(provider({}, { GIGACHAT_AUTH_KEY: 'abc def' }).check().reason, /недопустимые символы/);
  assert.equal(provider({}, { GIGACHAT_AUTH_KEY: '  abcdef==\n' }).check().ok, true, 'пробелы по краям (например, перенос строки) просто обрезаются');
});

test('авторизация: Basic-ключ, RqUID и scope в теле; токен используется повторно', async () => {
  const gigachat = provider();
  await gigachat.chat({ messages: [{ role: 'user', content: 'привет' }], tools: [] });
  await gigachat.chat({ messages: [{ role: 'user', content: 'ещё' }], tools: [] });

  assert.equal(log.oauth.length, 1, 'токен нужно получать один раз, а не на каждый запрос');
  const oauth = log.oauth[0];
  assert.equal(oauth.headers.authorization, 'Basic dGVzdC1rZXk6c2VjcmV0');
  assert.match(oauth.headers.rquid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(oauth.body, 'scope=GIGACHAT_API_PERS');
  assert.equal(oauth.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(log.chat[0].headers.authorization, 'Bearer token-1');
});

test('инструменты уходят как functions + function_call: auto; ответ с function_call превращается в вызов инструмента', async () => {
  const gigachat = provider();
  behavior.push({
    status: 200,
    json: {
      choices: [{ message: { role: 'assistant', content: '', function_call: { name: 'read_file', arguments: { path: 'привет.txt' } }, functions_state_id: 'state-123' }, finish_reason: 'function_call' }],
      usage: { prompt_tokens: 50, completion_tokens: 12 },
    },
  });

  const reply = await gigachat.chat({ messages: [{ role: 'system', content: 'система' }, { role: 'user', content: 'прочитай' }], tools });

  const sent = log.chat[0].body;
  assert.equal(sent.model, 'GigaChat-2-Pro');
  assert.equal(sent.function_call, 'auto');
  assert.deepEqual(sent.functions.map((f) => f.name), ['read_file']);
  assert.equal(sent.tools, undefined, 'формат OpenAI tools GigaChat v1 не используется');

  assert.equal(reply.toolCalls.length, 1);
  assert.equal(reply.toolCalls[0].name, 'read_file');
  assert.deepEqual(reply.toolCalls[0].args, { path: 'привет.txt' });
  assert.deepEqual(reply.extra, { functions_state_id: 'state-123' });
  assert.deepEqual(reply.usage, { promptTokens: 50, completionTokens: 12 });
});

test('история диалога: вызов функции, functions_state_id и результат в роли function (JSON в строке)', async () => {
  const gigachat = provider();
  await gigachat.chat({
    messages: [
      { role: 'system', content: 'система' },
      { role: 'user', content: 'прочитай привет.txt' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'привет.txt' } }], extra: { functions_state_id: 'state-123' } },
      { role: 'tool', toolCallId: 'c1', name: 'read_file', content: 'Привет, мир!' },
    ],
    tools,
  });

  const [system, user, assistant, result] = log.chat[0].body.messages;
  assert.deepEqual([system.role, user.role], ['system', 'user']);
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.function_call, { name: 'read_file', arguments: { path: 'привет.txt' } });
  assert.equal(assistant.functions_state_id, 'state-123');
  assert.equal(result.role, 'function');
  assert.equal(result.name, 'read_file');
  assert.deepEqual(JSON.parse(result.content), { result: 'Привет, мир!' }, 'content должен быть JSON-объектом, завёрнутым в строку');
});

test('если токен отозван (401), берём новый и повторяем запрос один раз', async () => {
  const gigachat = provider();
  behavior.push({ status: 401, json: { message: 'токен недействителен' } });
  const reply = await gigachat.chat({ messages: [{ role: 'user', content: 'привет' }], tools: [] });
  assert.equal(reply.content, 'ответ');
  assert.equal(log.oauth.length, 2);
  assert.equal(log.chat[1].headers.authorization, 'Bearer token-2');
});

test('ошибки сервиса превращаются в понятные ProviderError', async () => {
  const gigachat = provider();

  behavior.push({ status: 429, headers: { 'Retry-After': '7' }, json: { message: 'слишком много запросов' } });
  await assert.rejects(gigachat.chat({ messages: [{ role: 'user', content: 'x' }], tools: [] }), (err) => err.kind === 'rate_limit' && err.retryAfterSec === 7);

  behavior.push({ status: 200, json: { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'error' }] } });
  await assert.rejects(gigachat.chat({ messages: [{ role: 'user', content: 'x' }], tools }), (err) => err.kind === 'bad_request' && /аргумент/.test(err.message));

  behavior.push({ status: 503, json: {} });
  await assert.rejects(gigachat.chat({ messages: [{ role: 'user', content: 'x' }], tools: [] }), (err) => err.kind === 'server');
});

test('без сертификата Минцифры (нашего тестового центра) соединение не принимается, проверка не отключается', async () => {
  const gigachat = provider({ caFile: null });
  await assert.rejects(
    gigachat.chat({ messages: [{ role: 'user', content: 'привет' }], tools: [] }),
    (err) => err.kind === 'auth' && /сертификат/i.test(err.message),
  );
  assert.equal(log.oauth.length, 0, 'до сервера дело не дошло — это и есть работающая проверка сертификата');
});
