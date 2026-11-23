// Собирает приложение, готовит токен и запускает сервер. Этим пользуются и main.js (обычный запуск),
// и демо, и тесты — поэтому вынесено в отдельную функцию.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './app.js';
import { createServer } from './server.js';
import { fromRoot } from './util/paths.js';

export async function launch({ settings, providerConfigs, agents, dataDir = fromRoot('data'), env = process.env, lan = false, port, workspace, providerConfigFile, envFile }) {
  fs.mkdirSync(dataDir, { recursive: true });

  const app = createApp({ settings, providerConfigs, agents, dataDir, env, workspace, providerConfigFile, envFile });
  const token = loadOrCreateToken(dataDir);
  const server = createServer({ app, webDir: fromRoot('web'), token, lan });

  // Без --lan слушаем только этот компьютер; с --lan — всю домашнюю сеть.
  const host = lan ? '0.0.0.0' : '127.0.0.1';
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port ?? settings.port, host, resolve);
  });

  const actualPort = server.address().port;
  return {
    app,
    server,
    token,
    port: actualPort,
    localUrl: `http://127.0.0.1:${actualPort}/?token=${token}`,
    lanUrls: lan ? lanAddresses().map((ip) => `http://${ip}:${actualPort}/?token=${token}`) : [],
  };
}

/** Токен хранится в data/token.txt, поэтому ссылка остаётся прежней после перезапуска (её можно сохранить в закладки). */
function loadOrCreateToken(dataDir) {
  const file = path.join(dataDir, 'token.txt');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 16) return saved;
  } catch {
    // файла ещё нет — создадим
  }
  const token = randomBytes(16).toString('hex');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}
