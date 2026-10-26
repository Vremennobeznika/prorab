// Провайдер GigaChat (Сбер). Отличается от OpenAI-совместимых тремя вещами:
//   1. Авторизация в два шага: «ключ авторизации» меняется на токен, который живёт 30 минут.
//   2. Нужен корневой сертификат НУЦ Минцифры. Мы доверяем ему ТОЛЬКО для запросов к GigaChat
//      и не отключаем проверку сертификатов нигде.
//   3. Инструменты в GigaChat называются «функциями»: functions / function_call,
//      а результат возвращается в сообщении с ролью «function».
//
// Формат проверен по документации GigaChat API от 17.07.2026:
//   https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/gigachat-api
//   https://developers.sber.ru/docs/ru/gigachat/guides/functions/generating-arguments-for-custom-functions
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { ProviderError, kindFromStatus, readRetryAfter } from '../errors.js';
import { newId, uuid } from '../../util/ids.js';
import { ROOT } from '../../util/paths.js';

const DEFAULT_TIMEOUT_SEC = 120;
const TOKEN_LIFETIME_MS = 25 * 60_000; // токен живёт 30 минут; обновляем с запасом
const PACKAGED_CA = path.join(ROOT, 'certs', 'russian_trusted_root_ca_pem.crt');
const GIGACHAT_HOSTS = new Set(['api.giga.chat', 'gigachat.devices.sberbank.ru', 'ngw.devices.sberbank.ru']);

export function createGigaChatProvider(config, env = process.env) {
  const authKeyEnv = config.authKeyEnv ?? 'GIGACHAT_AUTH_KEY';
  const authKey = String(env[authKeyEnv] ?? '').trim();
  const caPath = config.caFile ? path.resolve(ROOT, config.caFile) : null;
  const baseUrl = String(config.baseUrl).replace(/\/+$/, '');
  const timeoutMs = (config.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;

  let token = null; // { value, refreshAtMs }
  let trusted = null; // список доверенных сертификатов (читаем файл один раз)

  function trustedCerts(hostname) {
    if (!trusted) {
      // Node 22.16+: доверенные центры из Windows + системный/встроенный набор Node.
      // Если пользователь добавил сертификат вручную, учитываем и его.
      trusted = typeof tls.getCACertificates === 'function'
        ? [...tls.getCACertificates('bundled'), ...tls.getCACertificates('system'), ...tls.getCACertificates('extra')]
        : [...tls.rootCertificates];
      if (caPath && fs.existsSync(caPath)) trusted.push(fs.readFileSync(caPath, 'utf8'));
    }
    // Old profiles retain their settings after an update. The packaged fallback works
    // even if caFile was removed/changed; it is trusted only for official GigaChat hosts.
    if (GIGACHAT_HOSTS.has(hostname) && caPath !== PACKAGED_CA && fs.existsSync(PACKAGED_CA)) {
      return [...trusted, fs.readFileSync(PACKAGED_CA, 'utf8')];
    }
    return trusted;
  }

  async function getToken(signal) {
    if (token && Date.now() < token.refreshAtMs) return token.value;

    const body = `scope=${encodeURIComponent(config.scope ?? 'GIGACHAT_API_PERS')}`;
    const res = await request(config.oauthUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'application/json',
        RqUID: uuid(),
        Authorization: `Basic ${authKey}`,
      },
      body,
      signal,
    });
    if (res.status !== 200) {
      throw new ProviderError(`не удалось получить токен (HTTP ${res.status}): проверьте ключ авторизации`, {
        kind: res.status >= 500 ? 'server' : 'auth',
        status: res.status,
      });
    }
    const data = parseJson(res.text);
    if (!data?.access_token) throw new ProviderError('в ответе нет токена доступа', { kind: 'auth' });

    // Время окончания в документации показано в секундах, в старых примерах — в миллисекундах.
    // Поэтому не полагаемся на него полностью: в любом случае обновляем токен раньше срока.
    const expiresAt = Number(data.expires_at) > 1e12 ? Number(data.expires_at) : Number(data.expires_at) * 1000;
    const refreshAtMs = Math.min(expiresAt - 60_000 || Infinity, Date.now() + TOKEN_LIFETIME_MS);
    token = { value: data.access_token, refreshAtMs };
    return token.value;
  }

  /** Один HTTPS-запрос с нашим набором сертификатов. */
  function request(urlString, { method = 'GET', headers = {}, body = null, signal }) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlString);
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method,
          headers,
          ca: trustedCerts(url.hostname),
          rejectUnauthorized: true,
          signal,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(Object.assign(new Error('таймаут'), { name: 'TimeoutError' })));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    }).catch((err) => {
      if (signal?.aborted) throw err; // остановка человеком
      throw explainNetworkError(err, timeoutMs);
    });
  }

  async function authorizedRequest(url, options) {
    let res = await request(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${await getToken(options.signal)}` } });
    if (res.status === 401) {
      // Токен мог устареть раньше срока — берём новый и повторяем один раз.
      token = null;
      res = await request(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${await getToken(options.signal)}` } });
    }
    return res;
  }

  return {
    check() {
      if (!authKey) return { ok: false, reason: `не задан ключ ${authKeyEnv} (введите его во вкладке «Модели»)` };
      if (!/^[\x21-\x7E]+$/.test(authKey)) {
        return { ok: false, reason: `ключ ${authKeyEnv} содержит недопустимые символы: скопируйте «Ключ авторизации» из кабинета Studio целиком, без пробелов, кавычек и переносов строк` };
      }
      return { ok: true };
    },

    async chat({ messages, tools, signal }) {
      const payload = {
        model: config.model,
        messages: toWireMessages(messages),
        temperature: config.temperature ?? 0.2,
      };
      if (tools?.length) {
        payload.functions = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
        payload.function_call = 'auto';
      }
      const body = JSON.stringify(payload);

      const res = await authorizedRequest(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Accept: 'application/json' },
        body,
        signal,
      });
      if (res.status !== 200) {
        throw new ProviderError(`HTTP ${res.status}: ${res.text.slice(0, 300)}`, {
          kind: kindFromStatus(res.status),
          status: res.status,
          retryAfterSec: readRetryAfter(res.headers['retry-after']),
        });
      }

      const data = parseJson(res.text);
      const choice = data?.choices?.[0];
      if (!choice?.message) throw new ProviderError('в ответе нет сообщения модели', { kind: 'server' });
      // По документации finish_reason «error» означает: модель выдала невалидные аргументы функции.
      if (choice.finish_reason === 'error') {
        throw new ProviderError('модель прислала некорректные аргументы функции', { kind: 'bad_request' });
      }

      const call = choice.message.function_call;
      const toolCalls = call
        ? [{ id: newId('call'), name: call.name, args: normalizeArguments(call.arguments), argsError: null }]
        : [];

      return {
        content: choice.message.content ?? '',
        toolCalls,
        // GigaChat просит возвращать этот идентификатор в истории диалога вместе с вызовом функции
        extra: choice.message.functions_state_id ? { functions_state_id: choice.message.functions_state_id } : null,
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
        },
      };
    },

    /** Список имён моделей, доступных вашему ключу (для npm run gigachat-models). */
    async listModels(signal) {
      const res = await authorizedRequest(`${baseUrl}/models`, { method: 'GET', headers: { Accept: 'application/json' }, signal });
      if (res.status !== 200) throw new ProviderError(`HTTP ${res.status}: ${res.text.slice(0, 300)}`, { kind: kindFromStatus(res.status), status: res.status });
      return (parseJson(res.text)?.data ?? []).map((m) => m.id);
    },
  };
}

// ───────── Перевод форматов ─────────

function toWireMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      // GigaChat понимает один вызов функции за сообщение — runner как раз так и работает.
      const call = m.toolCalls[0];
      const wire = { role: 'assistant', content: m.content || '', function_call: { name: call.name, arguments: call.args ?? {} } };
      if (m.extra?.functions_state_id) wire.functions_state_id = m.extra.functions_state_id;
      return wire;
    }
    if (m.role === 'tool') {
      // Результат функции должен быть JSON-объектом, завёрнутым в строку.
      return { role: 'function', name: m.name, content: JSON.stringify({ result: m.content }) };
    }
    return { role: m.role, content: m.content };
  });
}

function normalizeArguments(args) {
  if (args && typeof args === 'object') return args;
  try {
    return JSON.parse(args || '{}');
  } catch {
    return {};
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('ответ не похож на JSON', { kind: 'server' });
  }
}

/** Превращает сетевую ошибку в понятное объяснение. */
function explainNetworkError(err, timeoutMs) {
  const certProblems = ['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_UNTRUSTED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID'];
  if (certProblems.includes(err.code)) {
    return new ProviderError(
      'Не удалось проверить защищённое соединение с GigaChat. Обновите Прораб до версии 0.4.2 или новее: сертификаты входят в установщик. Если ошибка остаётся, проверьте дату и время Windows и HTTPS-проверку антивируса или прокси. Ключ менять не нужно.',
      { kind: 'auth' },
    );
  }
  if (err.name === 'TimeoutError') return new ProviderError(`нет ответа за ${timeoutMs / 1000} с`, { kind: 'timeout' });
  return new ProviderError(`нет связи с GigaChat (${err.code ?? err.message})`, { kind: 'network' });
}
