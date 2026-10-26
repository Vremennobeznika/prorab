// Инструменты — это «руки» агента. Модель сама ничего не делает: она просит вызвать инструмент,
// а программа решает, можно ли это, и выполняет.
//
// У каждого инструмента есть:
//   risk        — насколько он опасен: 'read' (только чтение), 'write' (меняет файлы), 'command' (запускает команды)
//   description — описание для модели: когда и зачем вызывать
//   parameters  — какие аргументы принимает (схема JSON Schema, её понимают все модели)
//   describe    — человеческое описание действия для окна «Разрешить / Отклонить»
//   run         — что именно делает инструмент
//
// Чтобы добавить новый инструмент, допишите его в TOOLS и добавьте его имя в agent.json нужного агента.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { clip } from '../util/files.js';
import { resolveInside } from '../util/safe-path.js';

const MAX_READ_CHARS = 20_000; // у бесплатных моделей небольшое «окно», длинные файлы режем
const MAX_FILE_BYTES = 1_000_000;
const MAX_COMMAND_OUTPUT = 8_000;
const COMMAND_TIMEOUT_MS = 60_000;

const PATH_PARAM = { type: 'string', description: 'Путь относительно рабочей папки, например: docs/план.txt' };

export const TOOLS = {
  update_plan: {
    risk: 'read',
    description: 'Обновить внутренний план текущего диалога. Не меняет рабочие файлы. Статусы: pending, in_progress, done.',
    parameters: { type: 'object', properties: { steps: { type: 'array', maxItems: 12, items: { type: 'object', properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } }, required: ['text', 'status'] } } }, required: ['steps'] },
    describe: () => ({ title: 'Обновить план диалога', details: '' }),
    async run(a, ctx) { if (!ctx.updatePlan) throw new Error('План доступен в диалоге проекта.'); return JSON.stringify(ctx.updatePlan(a?.steps)); },
  },
  delegate_agent: {
    risk: 'read',
    description: 'Поручить чтение и независимую проверку специалисту: code-reviewer, data-auditor, document-summary. Специалист не может менять файлы или выполнять команды. Максимум два поручения на сообщение.',
    parameters: { type: 'object', properties: { agentId: { type: 'string', enum: ['code-reviewer', 'data-auditor', 'document-summary'] }, task: { type: 'string' } }, required: ['agentId', 'task'] },
    describe: (a) => ({ title: 'Проверка специалистом', details: a?.task || '' }),
    async run(a, ctx) { if (!ctx.delegate) throw new Error('Делегирование недоступно.'); return ctx.delegate(a); },
  },
  list_files: {
    risk: 'read',
    description: 'Показать файлы и папки внутри рабочей папки. Папки в списке заканчиваются на «/».',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Какую папку показать (относительно рабочей). По умолчанию — сама рабочая папка.' } },
    },
    describe: (a) => ({ title: `Показать содержимое папки «${a?.path || '.'}»`, details: '' }),
    async run(a, ctx) {
      const dir = resolveInside(ctx.workspace, a?.path || '.');
      const names = fs.readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      if (names.length === 0) return '(папка пуста)';
      const shown = names.slice(0, 200).join('\n');
      return names.length > 200 ? `${shown}\n…и ещё ${names.length - 200}` : shown;
    },
  },

  read_file: {
    risk: 'read',
    description: 'Прочитать текстовый файл из рабочей папки.',
    parameters: { type: 'object', properties: { path: PATH_PARAM }, required: ['path'] },
    describe: (a) => ({ title: `Прочитать файл «${a?.path ?? ''}»`, details: '' }),
    async run(a, ctx) {
      const file = resolveInside(ctx.workspace, text(a, 'path'));
      if (fs.statSync(file).isDirectory()) throw new Error('Это папка, а не файл. Используйте list_files.');
      return clip(toLf(readText(file)), MAX_READ_CHARS); // модель видит переводы строк одинаково — «\n»
    },
  },

  search_files: {
    risk: 'read',
    description: 'Найти точный текст в локальных файлах. Возвращает пути, номера строк и фрагменты без пересказа. Без регулярных выражений; поиск без учёта регистра. Скрытые файлы, ключи, зависимости и символьные ссылки пропускаются.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'Текст для поиска (1–200 символов), например имя функции.' },
      mode: { type: 'string', enum: ['text', 'symbols'], description: 'symbols: искать только строки объявлений функций, классов и переменных (эвристика, не полный парсер).' },
      path: { type: 'string', description: 'Подпапка рабочей папки. По умолчанию вся рабочая папка.' },
    }, required: ['query'] },
    describe: (a) => ({ title: `Найти «${a?.query ?? ''}» в файлах`, details: a?.path || '.' }),
    async run(a, ctx) {
      const query = text(a, 'query').trim();
      if (!query || query.length > 200) throw new Error('Для поиска нужно от 1 до 200 символов.');
      if (a?.mode !== undefined && !['text', 'symbols'].includes(a.mode)) throw new Error('Неизвестный режим поиска.');
      const start = resolveInside(ctx.workspace, a?.path || '.');
      if (!fs.statSync(start).isDirectory()) throw new Error('Укажите папку для поиска.');
      const ignored = new Set(['node_modules', 'vendor', 'build', 'dist', 'data', 'certs', '__pycache__', 'venv']);
      if (path.relative(fs.realpathSync(ctx.workspace), start).split(path.sep).some((part) => part && (part.startsWith('.') || ignored.has(part))) || fs.lstatSync(start).isSymbolicLink()) throw new Error('Скрытые папки, зависимости и ссылки исключены из поиска.');
      const pending = [{ dir: start, depth: 0 }];
      const hits = [];
      let files = 0, bytes = 0, entries = 0, skipped = 0, limited = false;
      while (pending.length && !limited) {
        ctx.signal?.throwIfAborted();
        const { dir, depth } = pending.pop();
        let children;
        try { children = fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name)); }
        catch { skipped += 1; continue; }
        for (const entry of children) {
          if (++entries > 3000) { limited = true; break; }
          if (entry.name.startsWith('.') || ignored.has(entry.name) || /(?:\.(?:pem|key|crt|p12|pfx)$|^(?:secrets?|credentials?)(?:[._-]|$))/i.test(entry.name) || entry.isSymbolicLink()) continue;
          const candidate = resolveInside(ctx.workspace, path.join(dir, entry.name));
          if (entry.isDirectory()) {
            if (depth < 12) pending.push({ dir: candidate, depth: depth + 1 });
            else limited = true;
            continue;
          }
          if (!entry.isFile()) continue;
          if (files >= 200) { limited = true; break; }
          let contents;
          try {
            const size = fs.statSync(candidate).size;
            if (size > MAX_FILE_BYTES) { skipped += 1; continue; }
            if (bytes + size > 4_000_000) { limited = true; break; }
            bytes += size;
            files += 1;
            contents = toLf(readText(candidate));
          } catch { skipped += 1; continue; }
          const lines = contents.split('\n');
          for (let line = 0; line < lines.length; line++) {
            if (a?.mode === 'symbols' && !/(?:^|\s)(?:function|class|def|fn|struct|interface|type|const|let|var)\s+[\p{L}_$][\p{L}\p{N}_$]*/u.test(lines[line])) continue;
            const position = lines[line].toLowerCase().indexOf(query.toLowerCase());
            if (position < 0) continue;
            const from = Math.max(0, position - 100);
            hits.push({ path: path.relative(ctx.workspace, candidate).split(path.sep).join('/'), line: line + 1,
              text: (from ? '…' : '') + clip(lines[line].slice(from), 400) });
            if (hits.length >= 10) { limited = true; break; }
          }
          if (limited) break;
        }
      }
      return JSON.stringify({ hits, scannedFiles: files, skipped, limited,
        note: limited ? 'Достигнут лимит поиска. Уточните подпапку или запрос.' : (a?.mode === 'symbols' ? 'Поиск строк объявлений по эвристике; это не полный синтаксический анализ.' : 'Точный поиск текста, не поиск по смыслу.') });
    },
  },

  write_file: {
    risk: 'write',
    description: 'Записать текстовый файл целиком: создаёт новый или заменяет существующий. Для небольших правок лучше replace_in_file.',
    parameters: {
      type: 'object',
      properties: { path: PATH_PARAM, content: { type: 'string', description: 'Полное содержимое файла.' } },
      required: ['path', 'content'],
    },
    describe: (a) => ({
      title: `Записать файл «${a?.path ?? ''}» (${String(a?.content ?? '').length} символов)`,
      details: clip(a?.content, 600),
    }),
    async run(a, ctx) {
      const file = resolveInside(ctx.workspace, text(a, 'path'));
      let content = text(a, 'content', { allowEmpty: true });
      if (fs.existsSync(file)) {
        const existing = readText(file); // файл не в UTF-8 или бинарный — понятная ошибка, файл остаётся нетронутым
        content = keepStyle(content, existing); // переводы строк и BOM остаются такими же, как были в файле
        backup(file, ctx); // старая версия сохраняется — всегда можно вернуть
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      return `Файл «${a.path}» записан (${content.length} символов).`;
    },
  },

  replace_in_file: {
    risk: 'write',
    description: 'Заменить фрагмент текста в файле. Фрагмент old_text должен встречаться в файле ровно один раз.',
    parameters: {
      type: 'object',
      properties: {
        path: PATH_PARAM,
        old_text: { type: 'string', description: 'Точный фрагмент, который нужно заменить (с пробелами и переносами строк).' },
        new_text: { type: 'string', description: 'На что заменить.' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
    describe: (a) => ({
      title: `Изменить файл «${a?.path ?? ''}»`,
      details: `Было:\n${clip(a?.old_text, 400)}\n\nСтанет:\n${clip(a?.new_text, 400)}`,
    }),
    async run(a, ctx) {
      const file = resolveInside(ctx.workspace, text(a, 'path'));
      const original = readText(file);
      const ending = lineEnding(original);
      if (ending === 'mixed') throw new Error(MIXED_ENDINGS);
      const content = toLf(original); // ищем и заменяем в «\n»-тексте, а при записи вернём переводы строк как были
      const oldText = toLf(text(a, 'old_text'));
      const newText = toLf(text(a, 'new_text', { allowEmpty: true }));
      const count = content.split(oldText).length - 1;
      if (count === 0) throw new Error('Фрагмент old_text в файле не найден. Прочитайте файл заново и скопируйте фрагмент точно.');
      if (count > 1) throw new Error(`Фрагмент old_text встречается ${count} раз. Укажите более длинный, уникальный фрагмент.`);
      backup(file, ctx);
      // Функция вместо строки: чтобы символы «$» в новом тексте не воспринимались как шаблон замены.
      const replaced = content.replace(oldText, () => newText);
      fs.writeFileSync(file, ending === 'crlf' ? toCrlf(replaced) : replaced, 'utf8');
      return `Изменение внесено в «${a.path}».`;
    },
  },

  run_command: {
    risk: 'command',
    description: 'Выполнить команду в терминале в рабочей папке. Каждый запуск требует разрешения человека. Лимит времени — 60 секунд.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Команда целиком, как её вводят в терминале.' } },
      required: ['command'],
    },
    describe: (a) => ({ title: 'Выполнить команду в терминале', details: String(a?.command ?? '') }),
    run: (a, ctx) => runShell(text(a, 'command'), ctx),
  },
};

/** Описания инструментов в том виде, в котором их получает модель. */
export function toolSchemas(names) {
  return names.map((name) => ({ name, description: TOOLS[name].description, parameters: TOOLS[name].parameters }));
}

/** Переводит системную ошибку в понятную фразу. */
export function friendlyError(err) {
  const known = {
    ENOENT: 'нет такого файла или папки',
    ENOTDIR: 'это не папка',
    EISDIR: 'это папка, а не файл',
    EACCES: 'нет доступа',
    EPERM: 'операция не разрешена',
  };
  return known[err?.code] ?? err?.message ?? String(err);
}

/**
 * Копия окружения без секретов. Команда, которую запускает агент, не должна видеть ключи:
 * её вывод попадает к модели и в журнал на диске. secretNames — имена переменных из providers.json.
 */
export function cleanEnv(env = process.env, secretNames = []) {
  const looksSecret = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !looksSecret.test(name) && !secretNames.includes(name)),
  );
}

/** Какие переводы строк в тексте: 'crlf' (Windows), 'lf' (macOS/Linux), 'mixed' (вперемешку) или 'none'. */
export function lineEnding(content) {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/\n/g) || []).length - crlf; // «голые» LF без CR
  if (crlf > 0 && lf > 0) return 'mixed';
  if (crlf > 0) return 'crlf';
  return lf > 0 ? 'lf' : 'none';
}

// ───────── Внутренние помощники ─────────

const MIXED_ENDINGS = 'В файле перемешаны переводы строк (CRLF и LF) — агент не будет его менять, чтобы не испортить.';
const toLf = (content) => content.replace(/\r\n/g, '\n');
const toCrlf = (content) => toLf(content).replace(/\n/g, '\r\n');

// ignoreBOM: true — не «съедать» знак BOM в начале файла, иначе при записи он пропадёт.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Читает текстовый файл строго как UTF-8. Файл в другой кодировке (например, Windows-1251) или бинарный
 * не читаем: иначе агент «починил» бы его, превратив непонятные символы в мусор, и сохранил поверх.
 */
function readText(file) {
  if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error('Файл больше 1 МБ — слишком большой, агент с такими не работает.');
  const bytes = fs.readFileSync(file);
  if (bytes.includes(0)) throw new Error('Похоже на бинарный файл (или текст в UTF-16) — читать и менять его как текст нельзя.');
  let content;
  try {
    content = strictUtf8.decode(bytes);
  } catch {
    throw new Error('Файл не в кодировке UTF-8 (возможно, Windows-1251). Агент не будет его читать и менять, чтобы не испортить текст.');
  }
  // Управляющие символы (кроме табуляции и переводов строк) в настоящем тексте не встречаются:
  // так выдаёт себя, например, UTF-16 без метки, русские буквы в котором не содержат нулевых байтов.
  if (/[\u0000-\u0008\u000E-\u001F]/.test(content)) {
    throw new Error('Похоже на бинарный файл (или текст в UTF-16) — читать и менять его как текст нельзя.');
  }
  return content;
}

/** Новый текст файла приводится к стилю старого: те же переводы строк и тот же BOM. */
function keepStyle(newContent, existing) {
  const ending = lineEnding(existing);
  if (ending === 'mixed') throw new Error(MIXED_ENDINGS);
  let result = newContent;
  if (ending === 'crlf') result = toCrlf(newContent);
  else if (ending === 'lf') result = toLf(newContent);
  if (existing.startsWith('\uFEFF') && !result.startsWith('\uFEFF')) result = `\uFEFF${result}`;
  return result;
}

/** Достаёт из аргументов строку; если её нет — понятная ошибка (её увидит модель и поправится). */
function text(args, name, { allowEmpty = false } = {}) {
  const value = args?.[name];
  if (typeof value !== 'string' || (!allowEmpty && value === '')) {
    throw new Error(`Не передан параметр «${name}» (нужна строка).`);
  }
  return value;
}

/** Перед изменением файла кладёт его старую версию в data/backups/<запуск>/. */
function backup(file, ctx) {
  const relative = path.relative(fs.realpathSync(ctx.workspace), file);
  const copy = path.join(ctx.backupDir, relative);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(file, copy);
}

function runShell(command, ctx) {
  return new Promise((resolve) => {
    const env = cleanEnv(process.env, ctx.secretEnvNames);
    const child = spawn(command, { cwd: fs.realpathSync(ctx.workspace), shell: true, windowsHide: true, env });
    let output = '';
    const collect = (chunk) => {
      if (output.length < 200_000) output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      output += `\n[остановлено: команда работала дольше ${COMMAND_TIMEOUT_MS / 1000} с]`;
      child.kill();
    }, COMMAND_TIMEOUT_MS);
    const onAbort = () => child.kill();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`Не удалось запустить команду: ${err.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      resolve(`Код завершения: ${code}\n${clip(output, MAX_COMMAND_OUTPUT)}`);
    });
  });
}
