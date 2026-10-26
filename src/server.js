// Веб-сервер: отдаёт страницу-пульт и принимает команды от неё.
//
// Защита (всё это здесь, в одном файле, чтобы её можно было прочитать целиком):
//   1. По умолчанию слушаем только 127.0.0.1 — с других устройств до сервера не достучаться.
//   2. Нужен токен: без него сервер отвечает «нужен вход». Токен приходит в ссылке и сохраняется в cookie.
//   3. Проверяем заголовок Host: это защищает от атаки «DNS rebinding» (чужой сайт притворяется вашим компьютером).
//   4. Команды (POST) принимаем только с нашей же страницы (Origin) и только в формате JSON — так чужой сайт не сможет
//      отправить команду от вашего имени.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { UserError } from './util/errors.js';

const COOKIE_NAME = 'prorab_token';
const MAX_BODY_BYTES = 100_000;

// Файлы страницы. Отдаём только эти — больше ничего с диска сервер не раздаёт.
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/fonts/manrope.ttf': ['fonts/manrope-variable.ttf', 'font/ttf'],
  '/fonts/inter-latin.woff2': ['fonts/inter-latin-wght-normal.woff2', 'font/woff2'],
  '/fonts/inter-cyrillic.woff2': ['fonts/inter-cyrillic-wght-normal.woff2', 'font/woff2'],
};

export function createServer({ app, webDir, token, lan = false }) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!(err instanceof UserError)) console.error(err);
      if (res.headersSent) return res.end();
      const status = err instanceof UserError ? err.status : 500;
      const message = err instanceof UserError ? err.message : `Внутренняя ошибка: ${err.message}`;
      sendJson(res, status, { error: message });
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    setSecurityHeaders(res);

    if (!hostAllowed(req.headers.host, lan)) throw new UserError('Запрещённый адрес сервера (Host).', 403);

    // Браузер сам просит значок сайта; отвечаем «пусто», чтобы не засорять журнал ошибок.
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    // Вход по ссылке с токеном: запоминаем токен в cookie и убираем его из адресной строки.
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
      if (!sameToken(url.searchParams.get('token'), token)) throw new UserError('Неверный токен.', 401);
      res.writeHead(302, {
        'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
        Location: '/',
      });
      return res.end();
    }

    if (!isAuthorized(req, token)) return sendLoginHint(res, url.pathname.startsWith('/api/'));

    if (req.method === 'GET' && STATIC_FILES[url.pathname]) return sendStatic(res, webDir, STATIC_FILES[url.pathname]);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    throw new UserError('Страница не найдена.', 404);
  }

  async function handleApi(req, res, url) {
    const { pathname } = url;
    const isPost = req.method === 'POST';
    if (isPost) checkCommandRequest(req);

    if (req.method === 'GET' && pathname === '/api/state') return sendJson(res, 200, app.state());

    if (isPost && pathname === '/api/settings/provider') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, app.configureProvider(body));
    }

    if (isPost && pathname === '/api/projects') return sendJson(res, 201, app.sessions.addProject(await readJsonBody(req)));
    if (isPost && pathname === '/api/sessions') {
      const body = await readJsonBody(req);
      const agent = app.state().agents.find((a) => a.id === body.agentId);
      if (!agent) throw new UserError('Агент не найден.');
      if (body.providerId != null && !app.state().providers.some((p) => p.id === body.providerId)) throw new UserError('Модель не найдена.');
      return sendJson(res, 201, app.sessions.visible(app.sessions.create({ ...body, localOnly: agent.localOnly })));
    }
    const sessionMatch = pathname.match(/^\/api\/sessions\/([\w-]+)(\/messages)?$/);
    if (sessionMatch) {
      const session = app.sessions.get(sessionMatch[1]);
      if (req.method === 'GET' && !sessionMatch[2]) return sendJson(res, 200, app.sessions.visible(session));
      if (isPost && sessionMatch[2]) {
        const body = await readJsonBody(req);
        const runId = app.startRun(session.agentId, body.task, { sessionId: session.id, useMemory: body.useMemory ?? false, criteria: body.criteria ?? '', learnMemory: body.learnMemory ?? false, verifyResult: body.verifyResult ?? false });
        return sendJson(res, 201, { runId });
      }
    }

    if (req.method === 'GET' && pathname === '/api/memory') {
      return sendJson(res, 200, { notes: app.memory.listWithConflicts((url.searchParams.get('q') || '').slice(0, 4000)) });
    }
    if (isPost && pathname === '/api/memory') {
      return sendJson(res, 200, app.saveMemory(await readJsonBody(req)));
    }
    if (isPost && pathname === '/api/memory/resolve') return sendJson(res, 200, app.resolveMemory(await readJsonBody(req)));
    if (isPost && pathname === '/api/memory/delete') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, app.memory.remove(body.id));
    }
    if (req.method === 'GET' && pathname === '/api/history/search') {
      return sendJson(res, 200, { runs: app.runs.search((url.searchParams.get('q') || '').slice(0, 4000)) });
    }

    if (isPost && pathname === '/api/runs') {
      const body = await readJsonBody(req);
      const runId = app.startRun(String(body.agentId ?? ''), body.task, { useMemory: body.useMemory ?? false, criteria: body.criteria ?? '', learnMemory: body.learnMemory ?? false, verifyResult: body.verifyResult ?? false });
      return sendJson(res, 201, { runId });
    }

    if (isPost && pathname === '/api/stop-all') {
      app.stopAll();
      return sendJson(res, 200, { ok: true });
    }

    let match;
    if (req.method === 'GET' && (match = pathname.match(/^\/api\/runs\/([\w-]+)$/))) {
      const run = app.runs.get(match[1]);
      if (!run) throw new UserError('Запуск не найден.', 404);
      return sendJson(res, 200, run);
    }
    if (req.method === 'GET' && (match = pathname.match(/^\/api\/runs\/([\w-]+)\/events$/))) {
      return streamEvents(req, res, match[1]);
    }
    if (isPost && (match = pathname.match(/^\/api\/runs\/([\w-]+)\/forget$/))) {
      if (!app.runs.forget(match[1])) throw new UserError('Запуск не найден.', 404);
      return sendJson(res, 200, { ok: true });
    }
    if (isPost && (match = pathname.match(/^\/api\/runs\/([\w-]+)\/stop$/))) {
      if (!app.runs.get(match[1])) throw new UserError('Запуск не найден.', 404);
      app.runs.stop(match[1]);
      return sendJson(res, 200, { ok: true });
    }
    if (isPost && (match = pathname.match(/^\/api\/approvals\/([\w-]+)$/))) {
      const body = await readJsonBody(req);
      if (!app.approvals.decide(match[1], body.approved === true)) throw new UserError('Этот запрос уже закрыт.', 404);
      return sendJson(res, 200, { ok: true });
    }

    throw new UserError('Такой команды нет.', 404);
  }

  /** Поток событий запуска (Server-Sent Events): страница видит ход работы в реальном времени. */
  function streamEvents(req, res, runId) {
    if (!app.runs.get(runId)) throw new UserError('Запуск не найден.', 404);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    const send = (event) => res.write(`id: ${event.n}\ndata: ${JSON.stringify(event)}\n\n`);

    // После обрыва связи браузер сам просит «продолжить с события №…» — повторов не будет.
    const lastSeen = Number(req.headers['last-event-id']) || 0;
    for (const event of app.runs.events(runId, lastSeen)) send(event);
    const unsubscribe = app.runs.subscribe(runId, send);

    const ping = setInterval(() => res.write(': ping\n\n'), 20_000); // чтобы соединение не считали зависшим
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  }

  return server;
}

// ───────── Проверки безопасности ─────────

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  // Страница использует только свои файлы: ни внешних скриптов, ни внешних шрифтов.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  );
}

/** Разрешённые значения заголовка Host: этот компьютер, а в режиме --lan ещё и адреса локальной сети. */
export function hostAllowed(hostHeader, lan) {
  const host = String(hostHeader ?? '').toLowerCase();
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  if (['127.0.0.1', 'localhost', '[::1]'].includes(name)) return true;
  if (!lan) return false;
  return isPrivateIPv4(name) || name === os.hostname().toLowerCase() || name.endsWith('.local');
}

function isPrivateIPv4(name) {
  const m = name.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

function checkCommandRequest(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) throw new UserError('Команда пришла с чужой страницы — отказано.', 403);
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new UserError('Команды принимаются только в формате JSON.', 415);
  }
}

function isAuthorized(req, token) {
  const cookies = String(req.headers.cookie ?? '').split(';');
  for (const part of cookies) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return sameToken(rest.join('='), token);
  }
  return false;
}

/** Сравнение токенов за постоянное время (чтобы нельзя было подобрать по скорости ответа). */
function sameToken(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

// ───────── Ответы ─────────

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendLoginHint(res, asJson) {
  if (asJson) return sendJson(res, 401, { error: 'Нужен вход: откройте ссылку с токеном из окна, где запущен Прораб.' });
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
  // Без атрибутов style: политика безопасности (CSP) их всё равно не пропустит.
  res.end(
    '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<link rel="icon" href="data:,"><title>Прораб: нужен вход</title>' +
      '<h1>Нужен вход</h1><p>Откройте ссылку с токеном — она напечатана в окне, где запущен Прораб ' +
      '(строка «Откройте на этом компьютере: http://…/?token=…»). После этого страница запомнит вас.</p></html>',
  );
}

function sendStatic(res, webDir, [file, type]) {
  const content = fs.readFileSync(path.join(webDir, file));
  res.writeHead(200, { 'Content-Type': type });
  res.end(content);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new UserError('Запрос слишком большой.', 413);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new UserError('Не удалось разобрать JSON в запросе.', 400);
  }
}
