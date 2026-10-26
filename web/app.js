/* Прораб — страница-пульт.
   Обычный JavaScript без сборки и библиотек. Файл читается сверху вниз:
   1) тексты  2) помощники  3) связь с сервером  4) отрисовка  5) действия человека  6) запуск.

   Всё, что приходит от сервера и от модели, вставляется в страницу как ТЕКСТ, а не как HTML,
   поэтому модель не может «подсунуть» странице свой код. */
(function () {
  'use strict';

  // ───────── 1. Тексты интерфейса: всё по-русски и в одном месте ─────────
  const T = {
    app: { footer: 'Прораб, версия 0.5.1' },
    top: {
      stopAll: 'Остановить',
      stopAllConfirm: 'Остановить все запущенные задачи?',
      theme: 'Сменить тему',
      workspace: 'Рабочая папка агентов: ',
    },
    tabs: { control: 'Проекты', agents: 'Агенты', models: 'Модели', memory: 'Память' },
    sessions: { projects: 'Проекты', dialogues: 'Диалоги' },
    form: {
      agent: 'Агент',
      task: 'Задача',
      taskHint: 'Опишите задачу или продолжите диалог…',
      start: 'Отправить',
      noAgents: 'Агентов нет — создайте папку в agents/',
      emptyTask: 'Опишите задачу: что агент должен сделать.',
    },
    run: { stop: 'Остановить', title: 'Агент «{name}»' },
    runs: { title: 'Запуски', empty: 'Запусков пока нет. Поставьте первую задачу выше.' },
    approval: { title: 'Ждёт вашего решения', agent: 'Агент «{name}» хочет:', allow: 'Разрешить', deny: 'Отклонить' },
    status: { running: '● В работе', waiting: '⏸ Ждёт вас', done: '✓ Готово', failed: '✕ Ошибка', stopped: '■ Остановлен' },
    events: {
      started: '▶ Запуск',
      step: 'Шаг {step} из {of}',
      model: '◆ Модель: {provider}',
      asksTool: '→ просит инструмент: {tool}',
      tool: '⚙ Инструмент: {tool}',
      needDecision: '⏸ Нужно ваше решение: {title}',
      allowed: '✓ Разрешено ({by})',
      denied: '✕ Отклонено ({by})',
      result: '↩ Результат: {tool}',
      answer: '★ Ответ',
      error: '✕ Ошибка',
      finished: '■ Завершено: {status}',
    },
    agents: {
      tools: 'Инструменты',
      models: 'Модели',
      allModels: 'все включённые, по порядку',
      none: 'нет',
      manual: 'Ручной режим: любая запись файла — только с вашего разрешения.',
      auto: 'Авто-режим: файлы меняются без вопросов, но команды — всегда с разрешением.',
      localOnly: 'Только локальные модели',
    },
    tools: {
      list_files: 'список файлов',
      read_file: 'чтение файлов',
      search_files: 'поиск в файлах',
      update_plan: 'план работы',
      delegate_agent: 'проверка специалистом',
      write_file: 'запись файлов',
      replace_in_file: 'правка файлов',
      run_command: 'команды в терминале',
    },
    models: {
      hint: 'Агент идёт по моделям сверху вниз: если одна недоступна или упёрлась в лимит, берётся следующая. Настройки — в файле config/providers.json.',
      model: 'Модель',
      disabled: 'Выключена — включите и сохраните настройки ниже',
      notReady: 'Не готова',
      paused: 'Пауза до',
      ready: 'Настройки заполнены (реальный ответ модели ещё не проверен)',
      today: 'Сегодня: {requests} и {tokens}',
      limit: 'Дневной лимит: {limit}',
      request: ['запрос', 'запроса', 'запросов'],
      token: ['токен', 'токена', 'токенов'],
      privacy: {
        local: 'Локально: данные остаются на этом компьютере',
        'ru-cloud': 'Российское облако: запросы уходят на серверы сервиса',
        'foreign-cloud': 'Зарубежное облако: запросы уходят на серверы за границей',
        unknown: 'Где обрабатываются данные — не указано',
      },
    },
    net: {
      offline: 'Нет связи с Прорабом. Проверьте, что программа запущена. Пробую снова…',
      needLogin: 'Нужен вход: откройте ссылку с токеном из окна, где запущен Прораб.',
    },
  };

  // ───────── 2. Помощники ─────────
  const $ = (selector) => document.querySelector(selector);

  /** Достаёт текст по пути вида «top.stopAll». */
  function lookup(path) {
    const found = path.split('.').reduce((node, key) => (node == null ? node : node[key]), T);
    return found == null ? path : found;
  }

  /** Подставляет значения в шаблон: fill('Агент «{name}»', { name: 'Тест' }). */
  function fill(template, values) {
    return template.replace(/\{(\w+)\}/g, (_, key) => (values[key] == null ? '' : values[key]));
  }

  /** Правильная форма слова для числа: 1 запрос, 2 запроса, 5 запросов. */
  function plural(n, forms) {
    const n10 = n % 10;
    const n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return forms[0];
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return forms[1];
    return forms[2];
  }

  const countWord = (n, forms) => `${n.toLocaleString('ru-RU')} ${plural(n, forms)}`;
  const formatTime = (ms) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const formatDateTime = (iso) => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

  /** Создаёт элемент без innerHTML: h('div', { class: 'card' }, 'текст', другойЭлемент). */
  function h(tag, props, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
      else if (key === 'class') element.className = value;
      else if (value === true) element.setAttribute(key, '');
      else if (value !== false && value != null) element.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return element;
  }

  function readSetting(key) {
    try { return localStorage.getItem(`prorab-${key}`); } catch (e) { return null; }
  }
  function saveSetting(key, value) {
    try { localStorage.setItem(`prorab-${key}`, value); } catch (e) { /* хранилище недоступно — не страшно */ }
  }

  // ───────── 3. Связь с сервером ─────────
  async function api(path, options) {
    const { method = 'GET', body } = options || {};
    const request = { method, credentials: 'same-origin' };
    if (method !== 'GET') {
      request.headers = { 'Content-Type': 'application/json' };
      request.body = JSON.stringify(body || {});
    }
    const response = await fetch(path, request);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Ошибка ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  // ───────── 4. Отрисовка ─────────
  let selectedSessionId = readSetting('session');
  let selectedProjectId = readSetting('project') || 'default';
  let selectedSession = null;
  let sessionLoad = 0;
  let state = null; // последний ответ сервера
  let archivedRun = null;
  let selectedRunId = null; // какой запуск открыт
  let stream = null; // соединение для событий открытого запуска
  const lastRendered = {}; // чтобы не перерисовывать то, что не изменилось (иначе кнопки «мигают»)

  function renderIfChanged(name, data, draw) {
    const key = JSON.stringify(data);
    if (lastRendered[name] === key) return;
    lastRendered[name] = key;
    draw();
  }

  function renderAll() {
    $('#workspace-line').textContent = T.top.workspace + state.workspace;
    renderAgentSelect();
    renderWorkbench();
    renderApprovals();
    renderRuns();
    renderRunView();
    renderAgents();
    renderModels();
    $('#setup-guide').hidden = state.providers.some((p) => p.enabled && p.ready.ok);
  }

  function renderAgentSelect() {
    renderIfChanged('agent-select', state.agents.map((a) => [a.id, a.name]), () => {
      const select = $('#agent-select');
      const previous = select.value || readSetting('agent') || 'file-helper';
      select.replaceChildren(...state.agents.map((a) => h('option', { value: a.id }, a.name)));
      if (state.agents.length === 0) select.append(h('option', { value: '' }, T.form.noAgents));
      else if (state.agents.some((a) => a.id === previous)) select.value = previous;
    });
  }

  function renderApprovals() {
    renderIfChanged('approvals', state.approvals.map((a) => a.id), () => {
      $('#approvals').replaceChildren(
        ...state.approvals.map((approval) => {
          const run = state.runs.find((r) => r.id === approval.runId);
          return h('div', { class: 'card approval' },
            h('h3', null, T.approval.title),
            h('p', { class: 'meta' }, fill(T.approval.agent, { name: run ? run.agentName : '' })),
            h('p', null, h('strong', null, approval.title)),
            approval.details ? h('pre', null, approval.details) : null,
            h('div', { class: 'btn-row' },
              h('button', { class: 'btn', type: 'button', onclick: (e) => decide(approval.id, true, e.currentTarget) }, T.approval.allow),
              h('button', { class: 'btn ghost', type: 'button', onclick: (e) => decide(approval.id, false, e.currentTarget) }, T.approval.deny)));
        }),
      );
    });
  }

  /** Запуск «ждёт вас», если у него есть неотвеченный запрос разрешения. */
  function statusOf(run) {
    return run.status === 'running' && state.approvals.some((a) => a.runId === run.id) ? 'waiting' : run.status;
  }

  function statusBadge(status) {
    const strong = status === 'running' || status === 'waiting';
    return h('span', { class: strong ? 'badge strong' : 'badge' }, T.status[status] || status);
  }

  function renderRuns() {
    renderIfChanged('runs', [state.runs.map((r) => [r.id, statusOf(r)]), selectedRunId], () => {
      const box = $('#runs');
      if (state.runs.length === 0) {
        box.replaceChildren(h('p', { class: 'hint' }, T.runs.empty));
        return;
      }
      box.replaceChildren(
        ...state.runs.map((run) =>
          h('div', {
            class: 'card run-item', role: 'button', tabindex: '0',
            'aria-current': run.id === selectedRunId ? 'true' : 'false',
            onclick: () => openRun(run.id),
            onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRun(run.id); } },
          },
            h('h3', null, run.agentName, ' ', statusBadge(statusOf(run))),
            h('p', { class: 'task' }, clip(run.task, 140)),
            h('p', { class: 'meta' }, formatDateTime(run.startedAt)))),
      );
    });
  }

  function renderRunView() {
    const run = state.runs.find((r) => r.id === selectedRunId) || (archivedRun?.id === selectedRunId ? archivedRun : null);
    $('#run-view').hidden = !run;
    if (!run) return;
    const status = statusOf(run);
    $('#run-title').textContent = fill(T.run.title, { name: run.agentName });
    const badge = $('#run-status');
    badge.textContent = T.status[status] || status;
    badge.className = status === 'running' || status === 'waiting' ? 'badge strong' : 'badge';
    $('#run-stop').hidden = run.status !== 'running';
  }

  function renderAgents() {
    renderIfChanged('agents', state.agents, () => {
      $('#agents-grid').replaceChildren(
        ...state.agents.map((agent) =>
          h('div', { class: 'card' },
            h('h3', null, agent.name),
            h('p', null, agent.description),
            h('p', { class: 'meta' }, `${T.agents.tools}: ${agent.tools.map((t) => T.tools[t] || t).join(', ') || T.agents.none}`),
            h('p', { class: 'meta' }, agent.mode === 'auto' ? T.agents.auto : T.agents.manual),
            h('p', { class: 'meta' }, `${T.agents.models}: ${agent.models.length ? agent.models.join(' → ') : T.agents.allModels}`),
            agent.localOnly ? h('p', null, h('span', { class: 'badge' }, T.agents.localOnly)) : null)),
      );
    });
  }

  const providerDirty = new Set();
  function renderModels() {
    // Forms have stable DOM identities. Polling may update status, never replace a typed key.
    renderIfChanged('models', [state.canConfigure, state.providers.map((p) => p.id)], () => {
      $('#models-grid').replaceChildren(...state.providers.map((p) => {
        const keyInput = p.requiresKey ? h('input', { id: 'provider-key-' + p.id, name: 'apiKey', type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Ключ доступа ' + p.title,
          placeholder: 'Вставьте ключ доступа', oninput: () => providerDirty.add(p.id) }) : null;
        return h('article', { class: 'card provider-card', 'data-provider-id': p.id },
          h('div', { class: 'provider-heading' }, h('h3', null, p.title), h('span', { class: 'meta', 'data-key-status': p.id })),
          h('p', { class: 'meta' }, p.model || ''),
          h('p', { class: 'provider-state', 'data-provider-status': p.id, role: 'status' }),
          state.canConfigure ? h('form', { class: 'provider-form', onsubmit: (e) => saveProvider(e, p.id) },
            h('label', { class: 'check-label' }, h('input', { name: 'enabled', type: 'checkbox', checked: p.enabled, onchange: () => providerDirty.add(p.id) }), 'Использовать модель'),
            keyInput ? h('label', { class: 'key-label' }, 'Ключ доступа', h('div', { class: 'key-controls' }, keyInput,
              h('button', { class: 'btn ghost', type: 'button', onclick: () => pasteKey(p.id) }, 'Вставить'),
              h('button', { class: 'btn ghost', type: 'button', 'aria-pressed': 'false', onclick: (event) => {
                const visible = keyInput.type === 'password'; keyInput.type = visible ? 'text' : 'password';
                event.currentTarget.textContent = visible ? 'Скрыть' : 'Показать'; event.currentTarget.setAttribute('aria-pressed', String(visible));
              } }, 'Показать'))) : null,
            h('p', { class: 'hint' }, p.requiresKey ? 'Сохранённый ключ не показывается повторно. Чтобы заменить его, введите новый.' : 'Ключ для локальной модели не нужен.'),
            h('div', { class: 'provider-save-row' }, h('button', { class: 'btn', type: 'submit' }, 'Сохранить'), h('span', { class: 'provider-feedback', 'data-provider-feedback': p.id, role: 'status' }))) : null,
          p.note ? h('details', { class: 'provider-help' }, h('summary', null, 'Подключение и данные'), h('p', { class: 'hint' }, p.note), h('p', { class: 'hint' }, T.models.privacy[p.privacy] || T.models.privacy.unknown)) : null);
      }));
    });
    for (const p of state.providers) {
      const card = [...$('#models-grid').children].find((node) => node.dataset.providerId === p.id);
      if (!card) continue;
      card.querySelector('[data-provider-status]').textContent = providerStatus(p);
      card.querySelector('[data-key-status]').textContent = !p.requiresKey ? 'Без ключа' : p.credentialSource === 'profile' ? 'Ключ сохранён' : p.credentialSource === 'environment' ? 'Ключ из окружения' : 'Ключ не указан';
      const enabled = card.querySelector('[name="enabled"]');
      if (enabled && !providerDirty.has(p.id)) enabled.checked = p.enabled;
    }
  }

  function insertClipboard(text, input = document.activeElement) {
    if (!input || !(input instanceof HTMLTextAreaElement || (input instanceof HTMLInputElement && ['text', 'password', 'search', 'url', 'tel'].includes(input.type))) || input.readOnly || input.disabled) return false;
    const value = String(text).replace(/\r?\n/g, input.name === 'apiKey' ? '' : '\n');
    input.focus(); input.setRangeText(value, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  window.ProrabInput = { insertClipboard };

  async function pasteKey(providerId) {
    const input = document.getElementById('provider-key-' + providerId);
    input.focus();
    if (window.chrome?.webview) { window.chrome.webview.postMessage('paste-key:' + providerId); return; }
    try { insertClipboard((await navigator.clipboard.readText()).trim(), input); }
    catch { $('#provider-result').textContent = 'Нажмите Ctrl+V в поле ключа или выберите «Вставить» в контекстном меню.'; }
  }

  async function saveProvider(event, providerId) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    const feedback = form.querySelector('[data-provider-feedback]');
    submit.disabled = true; feedback.textContent = 'Сохраняю…';
    const payload = { providerId, enabled: form.elements.enabled.checked };
    if (form.elements.apiKey?.value.trim()) payload.apiKey = form.elements.apiKey.value.trim();
    try {
      await api('/api/settings/provider', { method: 'POST', body: payload });
      if (form.elements.apiKey) { form.elements.apiKey.value = ''; form.elements.apiKey.type = 'password'; const toggle=form.querySelector('[aria-pressed]'); if(toggle){toggle.textContent='Показать';toggle.setAttribute('aria-pressed','false');} }
      providerDirty.delete(providerId);
      feedback.textContent = 'Сохранено';
      $('#provider-result').textContent = 'Настройки сохранены на этом компьютере. Подключение к сервису ещё не проверено.';
      await refresh();
    } catch (err) { feedback.textContent = err.message; }
    finally { submit.disabled = false; }
  }

  function providerStatus(p) {
    if (!p.enabled) return T.models.disabled;
    if (!p.ready.ok) return `${T.models.notReady}: ${p.ready.reason}`;
    if (p.pausedUntil) return `${T.models.paused} ${formatTime(p.pausedUntil)}${p.lastError ? ` — ${p.lastError}` : ''}`;
    return T.models.ready;
  }

  function limitText(p) {
    if (!p.limits) return null;
    const parts = [];
    if (p.limits.requestsPerDay != null) parts.push(countWord(p.limits.requestsPerDay, T.models.request));
    if (p.limits.tokensPerDay != null) parts.push(countWord(p.limits.tokensPerDay, T.models.token));
    return parts.length ? h('p', { class: 'meta' }, fill(T.models.limit, { limit: parts.join(', ') })) : null;
  }

  // ───────── Журнал открытого запуска ─────────
  function describeEvent(event) {
    const E = T.events;
    switch (event.type) {
      case 'run_started': return { title: E.started, body: event.task, kind: '' };
      case 'session_context': return { title: 'Диалог продолжен', body: `За пределами контекста: ${event.omittedTurns || 0}; сокращено шагов: ${event.summarizedTurns || 0}. При необходимости напомните важные детали.`, kind: 'step' };
      case 'plan_updated': return { title: 'План обновлён', body: event.steps.map((s) => `${s.status === 'done' ? '✓' : s.status === 'in_progress' ? '→' : '○'} ${s.text}`).join('\n'), kind: 'step' };
      case 'delegate_started': return { title: `Проверяет: ${event.agent}`, body: event.task, kind: 'tool' };
      case 'delegate_finished': return { title: 'Проверка специалиста: ' + (T.status[event.status] || event.status), kind: 'tool' };
      case 'memory_recalled': return { title: 'Память: подобрано записей — ' + event.sources.length, body: event.sources.map((s) => `${s.kind === 'note' ? 'Заметка' : 'Запуск'}: ${s.id}`).join('\n'), kind: 'step' };
      case 'memory_suggested': return { title: 'Предложения памяти: ' + event.ids.length, body: 'Просмотрите их на вкладке «Память». Пока вы их не приняли, они не используются.', kind: 'step' };
      case 'memory_constraints': return { title: 'Ограничения перед изменением файла', body: event.path + '\n' + event.sources.join(', '), kind: 'step' };
      case 'result_review': return { title: 'Отдельная проверка результата', body: event.text, kind: 'step' };
      case 'review_unavailable': return { title: 'Проверка не выполнена', body: event.message, kind: 'err' };
      case 'memory_learning_unavailable': return { title: 'Предложения памяти недоступны', body: event.message, kind: 'err' };
      case 'memory_unavailable': return { title: 'Память недоступна, задание выполняется без неё', body: event.message, kind: 'err' };
      case 'step': return { title: fill(E.step, event), kind: 'step' };
      case 'model_reply': {
        const tool = event.tool ? `\n${fill(E.asksTool, { tool: event.tool })}` : '';
        return { title: fill(E.model, { provider: event.provider }), body: `${event.text || ''}${tool}`.trim(), kind: '' };
      }
      case 'tool_call': return { title: fill(E.tool, { tool: event.tool }), body: clip(JSON.stringify(event.args, null, 2), 500), kind: 'tool' };
      case 'approval_requested': return { title: fill(E.needDecision, { title: event.title }), body: event.details, kind: '' };
      case 'approval_decided': return { title: fill(event.approved ? E.allowed : E.denied, { by: event.by }), kind: '' };
      case 'tool_result': return { title: fill(E.result, { tool: event.tool }), body: event.preview, kind: 'tool' };
      case 'final_answer': return { title: E.answer, body: event.text, kind: 'final' };
      case 'error': return { title: E.error, body: event.message, kind: 'err' };
      case 'run_finished': return { title: fill(E.finished, { status: T.status[event.status] || event.status }), kind: 'step' };
      default: return { title: event.type, kind: '' };
    }
  }

  function addEvent(event) {
    const info = describeEvent(event);
    const log = $('#log');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.append(h('div', { class: `ev ${info.kind}`.trim() },
      h('div', { class: 'ev-title' }, info.title),
      info.body ? h('pre', null, info.body) : null));
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }

  function closeStream() {
    if (stream) { stream.close(); stream = null; }
  }

  function openRun(id) {
    selectedRunId = id;
    closeStream();
    $('#log').replaceChildren();
    delete lastRendered.runs; // чтобы выделить выбранный запуск в списке
    if (state) { renderRuns(); renderRunView(); }

    stream = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
    stream.onmessage = (message) => {
      const event = JSON.parse(message.data);
      addEvent(event);
      if (event.type === 'run_finished') closeStream();
      scheduleRefresh(); // сразу обновить разрешения, статусы и списки, не дожидаясь очередного опроса
    };
    // При обрыве связи браузер переподключается сам и просит только пропущенные события.
  }

  function renderWorkbench() {
    const currentMeta = state.sessions.find((s) => s.id === selectedSessionId);
    if (selectedSessionId && !currentMeta) { selectedSessionId = null; selectedSession = null; }
    if (currentMeta) selectedProjectId = currentMeta.projectId;
    if (!state.projects.some((p) => p.id === selectedProjectId)) selectedProjectId = state.projects[0]?.id;
    renderIfChanged('project-select', [state.projects, selectedProjectId], () => {
      $('#project-select').replaceChildren(...state.projects.map((p) => h('option', { value: p.id }, p.name)));
      $('#project-select').value = selectedProjectId;
    });
    const project = state.projects.find((p) => p.id === selectedProjectId);
    if (project) $('#workspace-line').textContent = T.top.workspace + project.path;
    renderIfChanged('sessions', [state.sessions, selectedSessionId, selectedProjectId], () => {
      $('#session-list').replaceChildren(...state.sessions.filter((s) => s.projectId === selectedProjectId).map((s) =>
        h('button', { class: 'btn ghost session-button', type: 'button', 'aria-current': s.id === selectedSessionId ? 'true' : 'false', onclick: () => selectSession(s.id) }, s.title)));
    });
    renderIfChanged('model-select', [state.providers.map((p) => [p.id, p.title, p.enabled, p.ready.ok]), currentMeta?.providerId, selectedSessionId], () => {
      const previous = $('#model-select').value;
      $('#model-select').replaceChildren(h('option', { value: '' }, 'Автовыбор из включённых моделей'), ...state.providers.filter((p) => p.enabled).map((p) => h('option', { value: p.id, disabled: !p.ready.ok }, p.title + (p.model ? ' · ' + p.model : ''))));
      $('#model-select').value = currentMeta?.providerId || previous || '';
    });
    $('#model-select').disabled = Boolean(currentMeta);
    $('#agent-select').disabled = Boolean(currentMeta);
    if (currentMeta) $('#agent-select').value = currentMeta.agentId;
    $('#run-form button[type="submit"]').disabled = Boolean(currentMeta?.activeRunId);
    $('#dialogue-title').textContent = currentMeta?.title || 'Новый диалог';
    renderIfChanged('conversation-source', [selectedSessionId, currentMeta?.updatedAt, currentMeta?.activeRunId], () => {
      if (selectedSessionId) loadConversation(selectedSessionId);
      else { $('#conversation').replaceChildren(h('p', { class: 'hint' }, 'Поставьте задачу. История диалога сохранится после закрытия приложения.')); $('#session-plan').hidden = true; }
    });
  }

  async function loadConversation(id) {
    const request = ++sessionLoad;
    try {
      const session = await api(`/api/sessions/${encodeURIComponent(id)}`);
      if (request !== sessionLoad || selectedSessionId !== id) return;
      selectedSession = session;
      $('#conversation').replaceChildren(...session.turns.flatMap((turn) => [
        h('article', { class: 'chat-message user' }, h('h3', null, 'Вы'), h('p', null, turn.task), turn.criteria ? h('p', { class: 'meta' }, 'Критерии: ' + turn.criteria) : null),
        h('article', { class: 'chat-message assistant' }, h('h3', null, 'Прораб'), h('p', null, turn.answer || (turn.status === 'running' ? 'Работаю… Ход действий — в журнале ниже.' : T.status[turn.status] || turn.status))),
      ]));
      $('#session-plan').hidden = !session.plan.length;
      $('#plan-steps').replaceChildren(...session.plan.map((step) => h('li', null, `${step.status === 'done' ? '✓' : step.status === 'in_progress' ? '→' : '○'} ${step.text}`)));
    } catch (err) { showStatus(err.message); }
  }

  async function selectSession(id) {
    selectedSessionId = id; selectedSession = null; saveSetting('session', id);
    delete lastRendered['conversation-source']; renderWorkbench();
    try {
      const session = await api(`/api/sessions/${encodeURIComponent(id)}`);
      if (selectedSessionId !== id) return;
      const latest = session.turns.at(-1);
      if (latest) openRun(latest.runId);
    } catch (err) { showStatus(err.message); }
  }

  function newSession() {
    selectedSessionId = null; selectedSession = null; selectedRunId = null; sessionLoad += 1;
    saveSetting('session', ''); closeStream(); renderWorkbench(); renderRunView(); $('#task').focus();
  }

  async function addProject(event) {
    event.preventDefault();
    try {
      const project = await api('/api/projects', { method: 'POST', body: { path: $('#project-path').value.trim() } });
      await refresh(); selectedProjectId = project.id; saveSetting('project', project.id); $('#project-path').value = ''; $('#project-error').textContent = '';
      newSession();
    } catch (err) { $('#project-error').textContent = err.message; }
  }

  let editingNote = null;
  let memoryRequest = 0;

  function editMemory(note) {
    editingNote = note;
    const scope = $('#memory-scope');
    scope.replaceChildren(h('option', { value: '' }, 'Все проекты'), ...state.projects.map((p) => h('option', { value: p.path }, p.name)));
    scope.value = note ? note.workspacePath || '' : state.projects.find((p) => p.id === selectedProjectId)?.path || '';
    $('#memory-kind').value = note?.kind || 'fact';
    $('#memory-topic').value = note?.topic || '';
    $('#memory-path').value = note?.pathPrefix || '';
    $('#memory-text').value = note?.text || '';
    $('#memory-pinned').checked = note?.pinned ?? true;
    $('#memory-local').checked = note?.localOnly ?? true;
    $('#memory-local').disabled = Boolean(note?.sourceLocalOnly);
    $('#memory-source').textContent = note?.sourceRunId ? 'Источник: запуск ' + note.sourceRunId : '';
    $('#memory-cancel').hidden = !note;
    $('#memory-text').focus();
  }

  async function loadMemory() {
    if (!state) return;
    const request = ++memoryRequest;
    const query = $('#memory-query').value.trim();
    try {
      const [data, history] = await Promise.all([
        api('/api/memory?q=' + encodeURIComponent(query)),
        query ? api('/api/history/search?q=' + encodeURIComponent(query)) : Promise.resolve({ runs: [] }),
      ]);
      if (request !== memoryRequest) return;
      if (!$('#memory-scope').options.length) {
        $('#memory-scope').replaceChildren(h('option', { value: '' }, 'Все проекты'), ...state.projects.map((p) => h('option', { value: p.path }, p.name)));
        $('#memory-scope').value = state.projects.find((p) => p.id === selectedProjectId)?.path || '';
      }
      const pending = data.notes.filter((n) => n.status === 'pending');
      $('#memory-suggestions').replaceChildren(...(pending.length ? pending.map((note) => h('article', { class: 'card memory-note' },
        h('p', null, note.text), h('p', { class: 'meta' }, 'Проект: ' + (state.projects.find((p) => p.path === note.workspacePath)?.name || note.workspacePath || 'Все проекты')),
        h('p', { class: 'hint' }, 'Цитата источника: ' + (note.evidence || 'см. журнал')),
        h('p', { class: 'meta' }, 'Источник: ' + note.sourceRunId),
        note.conflictsWith?.length ? h('p', { class: 'error' }, 'Есть другая запись на эту тему. Можно сохранить обе или явно заменить прежнюю.') : null,
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', type: 'button', onclick: () => resolveMemory(note.id, 'accept') }, 'Принять'),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => editMemory(note) }, 'Изменить перед сохранением'),
          ...(note.conflictsWith || []).map((id) => h('button', { class: 'btn ghost', type: 'button', onclick: () => resolveMemory(note.id, 'accept', id) }, 'Заменить: ' + clip(data.notes.find((n) => n.id === id)?.text || id, 70))),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => resolveMemory(note.id, 'reject') }, 'Отклонить')))) : [h('p', { class: 'hint' }, 'Новых предложений нет.')]));
      const notes = data.notes.filter((n) => n.status !== 'pending' && ($('#memory-retired').checked || !['archived', 'rejected'].includes(n.status)));
      $('#memory-notes').replaceChildren(...(notes.length ? notes.map((note) =>
        h('article', { class: 'card memory-note' },
          h('p', null, note.text),
          h('p', { class: 'meta' }, 'Проект: ' + (state.projects.find((p) => p.path === note.workspacePath)?.name || note.workspacePath || 'Все проекты') + (['archived', 'rejected'].includes(note.status) ? ' · Архив' : '')),
          note.conflictsWith?.length ? h('p', { class: 'error' }, 'Возможное противоречие: другая запись на тему «' + note.topic + '».') : null,
          h('p', { class: 'meta' }, (note.pinned ? 'Во всех заданиях · ' : 'По совпадению слов · ') + (note.localOnly ? 'Только локальные агенты' : 'Можно передавать облачной модели') + ' · ' + formatDateTime(note.updatedAt)),
          note.sourceRunId ? h('p', { class: 'meta' }, 'Источник: ' + note.sourceRunId) : null,
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn ghost', type: 'button', onclick: () => editMemory(note) }, 'Изменить'),
            h('button', { class: 'btn ghost', type: 'button', onclick: () => deleteMemory(note.id) }, 'Удалить'))))
        : [h('p', { class: 'hint' }, query ? 'Подходящих заметок нет.' : 'Заметок пока нет. Добавьте первую выше.')]));
      $('#memory-history').replaceChildren(...(history.runs.length ? history.runs.map((run) =>
        h('article', { class: 'card memory-note' },
          h('h3', null, run.agentName + ' · ' + formatDateTime(run.startedAt)),
          h('p', null, clip(run.task, 600)), h('p', { class: 'meta' }, clip(run.answer, 900)),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn ghost', type: 'button', onclick: () => { archivedRun = run; showTab('control'); openRun(run.id); } }, 'Открыть журнал'),
            run.useMemory ? h('button', { class: 'btn ghost', type: 'button', onclick: () => forgetRun(run.id) }, 'Не использовать в памяти') : null,
            h('button', { class: 'btn', type: 'button', onclick: () => editMemory({ pinned: false, text: `Задание: ${run.task}\nРешение: ${run.answer}`.slice(0, 2000), localOnly: true, sourceRunId: run.id, sourceLocalOnly: run.localOnly !== false }) }, 'Сохранить решение'))))
        : [h('p', { class: 'hint' }, query ? 'Подходящих завершённых заданий нет.' : 'Введите слова для поиска.')]));
    } catch (err) { if (request === memoryRequest) $('#memory-result').textContent = err.message; }
  }

  async function resolveMemory(id, action, replaceId) {
    try {
      await api('/api/memory/resolve', { method: 'POST', body: { id, action, replaceId } });
      $('#memory-result').textContent = action === 'accept' ? 'Предложение принято. Оно доступно только в выбранной области и с указанными ограничениями.' : 'Предложение отклонено и не используется.';
      await loadMemory();
    } catch (err) { $('#memory-result').textContent = err.message; }
  }

  async function saveMemory(event) {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api('/api/memory', { method: 'POST', body: {
        ...(editingNote?.id ? { id: editingNote.id } : {}),
        workspacePath: $('#memory-scope').value || null, kind: $('#memory-kind').value, topic: $('#memory-topic').value.trim(), pathPrefix: $('#memory-path').value.trim(),
        text: $('#memory-text').value, pinned: $('#memory-pinned').checked, localOnly: $('#memory-local').checked,
        sourceRunId: editingNote?.sourceRunId || null,
      } });
      editMemory(null);
      $('#memory-result').textContent = 'Заметка сохранена. Для её использования включите память при запуске задания.';
      await loadMemory();
    } catch (err) { $('#memory-result').textContent = err.message; }
    finally { button.disabled = false; }
  }

  async function forgetRun(id) {
    try {
      await api(`/api/runs/${encodeURIComponent(id)}/forget`, { method: 'POST' });
      $('#memory-result').textContent = 'Задание исключено из памяти следующих запусков. Журнал сохранён; заметки из него удаляются отдельно.';
      await loadMemory();
    } catch (err) { $('#memory-result').textContent = err.message; }
  }

  async function deleteMemory(id) {
    if (!window.confirm('Удалить заметку из памяти? Прошлые задания останутся в журнале.')) return;
    try {
      await api('/api/memory/delete', { method: 'POST', body: { id } });
      if (editingNote?.id === id) editMemory(null);
      $('#memory-result').textContent = 'Заметка удалена. В уже запущенных заданиях переданный контекст сохраняется.';
      await loadMemory();
    } catch (err) { $('#memory-result').textContent = err.message; }
  }

  // ───────── 5. Действия человека ─────────
  async function decide(approvalId, approved, button) {
    for (const b of button.parentElement.querySelectorAll('button')) b.disabled = true;
    try {
      await api(`/api/approvals/${encodeURIComponent(approvalId)}`, { method: 'POST', body: { approved } });
    } catch (err) {
      showStatus(err.message);
    }
    scheduleRefresh();
  }

  async function startRun(event) {
    event.preventDefault();
    const agentId = $('#agent-select').value;
    const task = $('#task').value.trim();
    setFormError('');
    if (!task) return setFormError(T.form.emptyTask);
    try {
      if (!selectedSessionId) {
        const session = await api('/api/sessions', { method: 'POST', body: { agentId, projectId: selectedProjectId, providerId: $('#model-select').value || null } });
        selectedSessionId = session.id; selectedSession = session; saveSetting('session', session.id);
      }
      const { runId } = await api(`/api/sessions/${encodeURIComponent(selectedSessionId)}/messages`, { method: 'POST', body: { task, useMemory: $('#use-memory').checked, learnMemory: $('#use-memory').checked && $('#learn-memory').checked, verifyResult: $('#verify-result').checked, criteria: $('#criteria').value.trim() } });
      saveSetting('agent', agentId);
      saveSetting('use-memory', String($('#use-memory').checked));
      $('#task').value = '';
      $('#criteria').value = '';
      await refresh();
      openRun(runId);
    } catch (err) {
      setFormError(err.message);
    }
  }

  async function stopAll() {
    if (!window.confirm(T.top.stopAllConfirm)) return;
    try { await api('/api/stop-all', { method: 'POST' }); } catch (err) { showStatus(err.message); }
    scheduleRefresh();
  }

  async function stopRun() {
    if (!selectedRunId) return;
    try { await api(`/api/runs/${encodeURIComponent(selectedRunId)}/stop`, { method: 'POST' }); } catch (err) { showStatus(err.message); }
    scheduleRefresh();
  }

  function showTab(name) {
    for (const button of document.querySelectorAll('.tab')) button.setAttribute('aria-selected', String(button.dataset.tab === name));
    for (const key of ['control', 'agents', 'models', 'memory']) $(`#tab-${key}`).hidden = key !== name;
    saveSetting('tab', name);
    if (name === 'memory') loadMemory();
  }

  function syncThemeButton() {
    const button = $('#theme-toggle');
    button.textContent = window.ProrabTheme.current() === 'dark' ? 'Светлая тема' : 'Тёмная тема';
    button.setAttribute('aria-label', T.top.theme);
  }

  function setFormError(text) { $('#form-error').textContent = text; }

  function showStatus(text) {
    const line = $('#status-line');
    line.hidden = !text;
    line.textContent = text;
  }

  // ───────── Обновление данных ─────────
  let refreshing = false;
  let refreshTimer = null;

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      state = await api('/api/state');
      showStatus('');
      renderAll();
    } catch (err) {
      showStatus(err.status === 401 ? T.net.needLogin : T.net.offline);
    } finally {
      refreshing = false;
    }
  }

  /** Несколько событий подряд превращаем в одно обновление. */
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 150);
  }

  // ───────── 6. Запуск ─────────
  function start() {
    for (const element of document.querySelectorAll('[data-t]')) element.textContent = lookup(element.dataset.t);
    for (const element of document.querySelectorAll('[data-t-placeholder]')) {
      element.setAttribute('placeholder', lookup(element.dataset.tPlaceholder));
    }

    $('#new-session').addEventListener('click', newSession);
    $('#project-form').addEventListener('submit', addProject);
    $('#project-select').addEventListener('change', () => { selectedProjectId = $('#project-select').value; saveSetting('project', selectedProjectId); newSession(); });
    if (window.chrome?.webview) {
      $('#choose-folder').hidden = false;
      $('#choose-folder').addEventListener('click', () => window.chrome.webview.postMessage('choose-folder'));
      window.chrome.webview.addEventListener('message', (event) => {
        if (event.data?.type === 'folder') $('#project-path').value = event.data.path;
        if (event.data?.type === 'paste-key') insertClipboard(String(event.data.text || '').trim(), document.getElementById('provider-key-' + event.data.providerId));
        if (event.data?.type === 'clipboard-error') $('#provider-result').textContent = 'Буфер обмена занят. Повторите вставку.';
      });
    }
    $('#memory-form').addEventListener('submit', saveMemory);
    $('#memory-cancel').addEventListener('click', () => editMemory(null));
    $('#memory-retired').addEventListener('change', loadMemory);
    $('#memory-search').addEventListener('submit', (event) => { event.preventDefault(); loadMemory(); });
    $('#use-memory').checked = readSetting('use-memory') === 'true';
    $('#run-form').addEventListener('submit', startRun);
    $('#go-setup').addEventListener('click', () => showTab('models'));
    $('#stop-all').addEventListener('click', stopAll);
    $('#run-stop').addEventListener('click', stopRun);
    $('#theme-toggle').addEventListener('click', () => { window.ProrabTheme.toggle(); syncThemeButton(); });
    for (const button of document.querySelectorAll('.tab')) button.addEventListener('click', () => showTab(button.dataset.tab));

    syncThemeButton();
    showTab(readSetting('tab') || 'control');

    refresh().then(() => {
      if (!$('#tab-memory').hidden) loadMemory();
      // После перезагрузки страницы сразу показываем запуск, который ещё идёт.
      const active = state && state.runs.find((r) => r.status === 'running');
      if (active && !selectedRunId) openRun(active.id);
    });
    setInterval(() => { if (!document.hidden) refresh(); }, 2500);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }

  start();
})();
