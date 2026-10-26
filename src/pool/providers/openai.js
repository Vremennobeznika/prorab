// Провайдер «OpenAI-совместимый»: так говорят Ollama, LM Studio, Z.ai и многие другие сервисы.
// Один и тот же код работает со всеми — меняются только адрес, имя модели и ключ в config/providers.json.
//
// Внутри программы сообщения хранятся в простом общем формате (см. src/agent/runner.js):
//   { role: 'system' | 'user' | 'assistant' | 'tool', content, toolCalls?, toolCallId?, name? }
// А здесь они переводятся в формат OpenAI и обратно.
import { ProviderError, kindFromStatus, readRetryAfter } from '../errors.js';
import { newId } from '../../util/ids.js';

const DEFAULT_TIMEOUT_SEC = 120; // локальные модели на слабом компьютере бывают медленными — см. поле timeoutSec

export function createOpenAiProvider(config, env = process.env) {
  const apiKey = config.apiKeyEnv ? String(env[config.apiKeyEnv] ?? '').trim() : '';
  const endpoint = `${String(config.baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const timeoutMs = (config.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;

  return {
    /** Готов ли провайдер к работе. В сеть не ходит — только проверяет настройки. */
    check() {
      if (config.apiKeyEnv && !apiKey) {
        return { ok: false, reason: `не задан ключ ${config.apiKeyEnv} (введите его во вкладке «Модели»)` };
      }
      if (apiKey && !/^[\x21-\x7E]+$/.test(apiKey)) {
        return { ok: false, reason: `ключ ${config.apiKeyEnv} содержит недопустимые символы: скопируйте его целиком, без пробелов, кавычек и переносов строк` };
      }
      return { ok: true };
    },

    /** Один вопрос модели. Возвращает { content, toolCalls, extra, usage }. */
    async chat({ messages, tools, signal }) {
      const body = {
        model: config.model,
        messages: messages.map(toWireMessage),
        temperature: config.temperature ?? 0.2,
      };
      if (tools?.length) {
        body.tools = tools.map(toWireTool);
        body.tool_choice = 'auto';
      }

      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: withTimeout(signal, timeoutMs),
        });
      } catch (err) {
        if (signal?.aborted) throw err; // это остановка человеком, а не сбой провайдера
        if (err.name === 'TimeoutError') {
          throw new ProviderError(`нет ответа за ${timeoutMs / 1000} с (можно увеличить timeoutSec в config/providers.json)`, { kind: 'timeout' });
        }
        throw new ProviderError(`нет связи с ${config.baseUrl} (${err.cause?.code ?? err.message})`, { kind: 'network' });
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new ProviderError(`HTTP ${response.status}: ${text.slice(0, 300)}`, {
          kind: kindFromStatus(response.status),
          status: response.status,
          retryAfterSec: readRetryAfter(response.headers.get('retry-after')),
        });
      }

      let data;
      try {
        data = await response.json();
      } catch {
        throw new ProviderError('ответ не похож на JSON', { kind: 'server' });
      }
      const message = data.choices?.[0]?.message;
      if (!message) throw new ProviderError('в ответе нет сообщения модели', { kind: 'server' });

      const toolCalls = (message.tool_calls ?? []).map((call) => {
        const { args, error } = parseArguments(call.function?.arguments);
        return { id: call.id || newId('call'), name: call.function?.name ?? '', args, argsError: error };
      });

      return {
        content: message.content ?? '',
        toolCalls,
        extra: null,
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}

// ───────── Перевод форматов ─────────

function toWireMessage(m) {
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || '',
      tool_calls: m.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      })),
    };
  }
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  return { role: m.role, content: m.content };
}

function toWireTool(tool) {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

/** Аргументы вызова приходят строкой с JSON. Если модель прислала мусор — не падаем, а сообщаем. */
function parseArguments(raw) {
  if (raw && typeof raw === 'object') return { args: raw, error: null };
  if (!raw) return { args: {}, error: null };
  try {
    return { args: JSON.parse(raw), error: null };
  } catch {
    return { args: {}, error: 'аргументы вызова — не корректный JSON' };
  }
}

/** Общий «будильник»: сработает либо по остановке человеком, либо по таймауту. */
function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
