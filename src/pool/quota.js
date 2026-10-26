// Учёт расхода: сколько запросов и токенов потрачено у каждого провайдера за сегодня.
// Счётчики обнуляются в полночь по UTC (у большинства провайдеров сброс происходит примерно так же).
// Состояние хранится в файле data/quota.json — обычный JSON, его можно открыть и посмотреть.
import { readJson, writeJson } from '../util/files.js';

export function createQuota({ file, now = () => new Date() }) {
  const today = () => now().toISOString().slice(0, 10);
  let state = load();

  function load() {
    const saved = file ? readJson(file, null) : null;
    return saved?.day ? saved : { day: today(), providers: {} };
  }

  function entry(id) {
    if (state.day !== today()) state = { day: today(), providers: {} }; // наступил новый день
    state.providers[id] ??= { requests: 0, promptTokens: 0, completionTokens: 0 };
    return state.providers[id];
  }

  function usage(id) {
    const e = entry(id);
    return { ...e, tokens: e.promptTokens + e.completionTokens };
  }

  return {
    /** Записывает один успешный запрос. */
    record(id, tokens = {}) {
      const e = entry(id);
      e.requests += 1;
      e.promptTokens += tokens.promptTokens ?? 0;
      e.completionTokens += tokens.completionTokens ?? 0;
      if (file) writeJson(file, state);
    },

    usage,

    /** Исчерпан ли дневной лимит провайдера (лимиты задаются в providers.json в поле limits). */
    isExhausted(id, limits) {
      if (!limits) return false;
      const u = usage(id);
      const byRequests = limits.requestsPerDay != null && u.requests >= limits.requestsPerDay;
      const byTokens = limits.tokensPerDay != null && u.tokens >= limits.tokensPerDay;
      return byRequests || byTokens;
    },
  };
}
