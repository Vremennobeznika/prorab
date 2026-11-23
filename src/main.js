// Запуск: читаем настройки, создаём сервер и открываем интерфейс.
// Параметры командной строки предназначены для разработчиков и Windows-лаунчера.
import { loadAgents } from './agent/agents-store.js';
import { launch } from './launch.js';
import { readJson } from './util/files.js';
import { openBrowser } from './util/open-browser.js';
import { fromRoot } from './util/paths.js';
import { prepareUserData } from './util/user-data.js';
import fs from 'node:fs';
import path from 'node:path';

const options = parseArguments(process.argv.slice(2));

// В установленной версии конфигурация и рабочие файлы принадлежат пользователю,
// а не защищённой от записи папке Program Files. В режиме разработчика поведение прежнее.
const userDir = process.env.PRORAB_USER_DIR ? prepareUserData(process.env.PRORAB_USER_DIR) : null;
const configDir = userDir ? path.join(userDir, 'config') : fromRoot('config');
const envFile = userDir ? path.join(userDir, '.env') : fromRoot('.env');
try {
  process.loadEnvFile(envFile);
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

try {
  const settings = readJson(path.join(configDir, 'settings.json'));
  const providerConfigs = readJson(path.join(configDir, 'providers.json')).providers;
  const agents = loadAgents(fromRoot('agents'));

  const running = await launch({ settings, providerConfigs, agents, lan: options.lan,
    port: options.port, dataDir: userDir ? path.join(userDir, 'data') : undefined,
    workspace: userDir ? path.join(userDir, 'workspace') : undefined,
    providerConfigFile: path.join(configDir, 'providers.json'), envFile });
  if (options.readyFile) {
    // Одноразовый файл для Windows-лаунчера. Никогда не создаётся в каталоге программы.
    const tmp = `${options.readyFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ url: running.localUrl, pid: process.pid }), { mode: 0o600 });
    fs.renameSync(tmp, options.readyFile);
  }

  console.log('\nПрораб запущен.\n');
  console.log(`Откройте на этом компьютере:\n  ${running.localUrl}\n`);
  if (options.lan) {
    console.log('Откройте на телефоне (он должен быть в той же Wi-Fi сети):');
    for (const url of running.lanUrls) console.log(`  ${url}`);
    console.log('\nСсылка содержит токен — это пароль. Никому её не показывайте.\n');
  } else {
    console.log('Доступ с телефона выключен. Чтобы включить, запустите: npm start -- --lan\n');
  }
  console.log(`Рабочая папка агентов: ${running.app.workspace}`);
  console.log('Остановить программу: Ctrl+C\n');

  if (settings.openBrowser !== false && !options.noOpen) openBrowser(running.localUrl);

  process.on('SIGINT', () => {
    console.log('\nОстанавливаю агентов и закрываюсь…');
    running.app.stopAll();
    running.server.close();
    setTimeout(() => process.exit(0), 300).unref();
  });
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    console.error('Этот порт уже занят (возможно, Прораб уже запущен). Попробуйте другой: npm start -- --port 7778');
  } else {
    console.error(`Не удалось запустить: ${err.message}`);
  }
  process.exit(1);
}

function parseArguments(args) {
  const result = { lan: false, noOpen: false, port: undefined, readyFile: null };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--lan') result.lan = true;
    else if (args[i] === '--no-open') result.noOpen = true;
    else if (args[i] === '--port') result.port = Number(args[(i += 1)]);
    else if (args[i] === '--ready-file') result.readyFile = args[(i += 1)];
  }
  if (result.port !== undefined && !(result.port >= 0 && result.port < 65536)) {
    console.error('После --port нужен номер порта, например: --port 7778');
    process.exit(1);
  }
  return result;
}
